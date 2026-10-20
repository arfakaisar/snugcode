// Engine Claude Agent SDK: model Claude dan endpoint format Anthropic / OpenAI Chat (lewat penerjemah
// di loopback proxy). Satu proses `claude` per sesi, dipakai ulang antar prompt (streaming input).
// Izin (canUseTool), checkpoint (hook PreToolUse), dan event tetap milik Session (sessions.js).
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR } from './config.js';
import { resolveModelEffort, lightModel, parseModelId, nativeEffortModel } from '../shared/models.js';
import { splitRef, isClaudeId } from '../shared/providers.js';
import { knownRefs } from './providers.js';
import { subagents } from './agents.js';
import { findNativeBinary, missingBinaryMessage } from './nativebin.js';
import { snugcodePrompt, projectInstructions } from './prompt.js';
import { PLANS_DIR, isSensitivePath } from './permissions.js';
import { sandboxMode, sandboxSupport, sandboxOptions, excludeSandboxStubs } from './sandbox.js';
import { toolchainEnv } from './toolchain.js';
import { devToolsServer, DEV_START } from './devtools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tool bawaan yang ditawarkan ke model (tool MCP snugcode ikut otomatis). Tanpa daftar ini
// Claude Code mengirim ±27 tool (Cron*, ScheduleWakeup, SendMessage, Workflow, EnterWorktree, …)
// yang tidak dipakai di snugcode: ±40 KB skema (≈10k token) di SETIAP request model.
// Grep/Glob wajib disebut: build native menggantinya dengan Bash grep/find (output tak dibatasi).
export const AGENT_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'AskUserQuestion', 'ExitPlanMode', 'WebFetch', 'WebSearch'];
// Tool yang bisa mengubah file: baru boleh jalan setelah checkpoint prompt tersimpan (hook PreToolUse),
// termasuk yang lolos tanpa canUseTool lewat aturan "Selalu" (mis. Bash(npm test *)).
const MUTATING_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit|' + DEV_START;

// Setiap langkah agen = satu request model (1–10 detik lewat router), jadi jumlah langkah yang
// menentukan kecepatan. Model non-Claude (Gemini) membaca file 40–120 baris per langkah dan
// mencari nama file dulu lalu mencari ulang isinya: 4–9× lebih banyak request untuk tugas yang
// sama. Hook ini melebarkan Read potongan menjadi satu file utuh (bila muat sekali baca) dan
// Grep tanpa output_mode menjadi baris yang cocok + nomor baris. Izin tetap lewat canUseTool.
const WIDEN_MATCHER = 'Read|Grep';
const WIDEN_MAX_BYTES = 64 * 1024; // ±16k token: jauh di bawah batas token Read Claude Code
const WIDEN_MAX_LINES = 2000; // batas baris bawaan Read tanpa limit
const GREP_HEAD_LIMIT = 100;
const NO_WIDEN_EXT = /\.(pdf|ipynb|png|jpe?g|gif|webp|bmp|ico|svg)$/i;
// Model Claude: cc/…, claude-… tanpa provider, atau claude-… lewat provider lain (ag/claude-sonnet-4-6).
export const isClaudeModel = (id) => {
  const p = parseModelId(id || '');
  return (p.conn === 'router' && nativeEffortModel(p.provider, p.base)) || isClaudeId(p.base);
};

/** Input tool yang dilebarkan, atau null bila dibiarkan apa adanya. */
export function widenToolInput(tool, input, cwd) {
  if (!input || typeof input !== 'object') return null;
  if (tool === 'Read') {
    if (input.offset == null && input.limit == null) return null;
    if (typeof input.file_path !== 'string' || NO_WIDEN_EXT.test(input.file_path)) return null;
    const file = path.resolve(cwd, input.file_path);
    if (isSensitivePath(file)) return null;
    let buf;
    try {
      if (fs.statSync(file).size > WIDEN_MAX_BYTES) return null;
      buf = fs.readFileSync(file);
    } catch {
      return null;
    }
    if (buf.includes(0)) return null; // biner
    let lines = 1;
    for (const b of buf) if (b === 10 && ++lines > WIDEN_MAX_LINES) return null;
    const { offset, limit, ...rest } = input;
    return rest;
  }
  if (tool === 'Grep' && !input.output_mode) {
    return { ...input, output_mode: 'content', '-n': true, head_limit: input.head_limit ?? GREP_HEAD_LIMIT };
  }
  return null;
}

// Path binary Claude untuk query(): `claudeExecutable` di config.json (fallback manual)
// atau binary dari paket platform SDK. Gagal lebih awal dengan pesan yang jelas.
function claudeExecutable(cfg) {
  if (cfg.claudeExecutable) {
    if (!fs.existsSync(cfg.claudeExecutable)) throw new Error(`claudeExecutable di config.json tidak ditemukan: ${cfg.claudeExecutable}`);
    return cfg.claudeExecutable;
  }
  if (!findNativeBinary(import.meta.url)) throw new Error(missingBinaryMessage(ROOT));
  return undefined;
}

// Antrean pesan user untuk query() dalam mode streaming input: satu proses claude per sesi
// menerima prompt demi prompt lewat iterator ini.
function inputQueue() {
  const items = [];
  let wake = null;
  let done = false;
  const poke = () => {
    wake?.();
    wake = null;
  };
  return {
    push(m) {
      items.push(m);
      poke();
    },
    end() {
      done = true;
      poke();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (done) return;
        await new Promise((r) => (wake = r));
      }
    },
  };
}

export async function startClaudeAgent(s, route) {
  const cfg = s.mgr.config;
  const sec = s.mgr.secrets;
  const claudeExe = claudeExecutable(cfg);
  const actualModel = route.model;
  const effort = /** @type {import('@anthropic-ai/claude-agent-sdk').EffortLevel | null} */ (route.effort);
  // Subagen & tugas utilitas: model ringan dari koneksi yang sama (Haiku / Flash, lihat lightModel).
  const light = lightModel(s.meta.model, knownRefs(sec, route.conn.id));
  const lightId = splitRef(resolveModelEffort(light.id).actualModel).id;
  const proxy = s.mgr.proxy;
  const baseUrl = proxy ? await proxy.ready().catch(() => null) : null;
  if (!baseUrl) throw new Error('Loopback proxy snugcode tidak berjalan. Restart daemon (`snugcode restart`).');
  // Proses claude hanya memegang token lokal untuk koneksi ini; key asli disuntikkan oleh proxy.
  const authToken = s.mgr.tokenFor(route.conn, route.wire);
  // Sandbox OS untuk Bash saat perintah lolos tanpa dilihat pengguna (auto-izin), atau selalu bila diatur.
  const mode = sandboxMode(cfg);
  const support = mode === 'off' ? { ok: false } : await sandboxSupport();
  const sandboxed = support.ok && (mode === 'always' || !!s.meta.auto);
  if (s.meta.auto && mode !== 'off' && !support.ok && !s.mgr.warnedClaudeSandbox) {
    s.mgr.warnedClaudeSandbox = true;
    s.emitEvent({ k: 'note', d: `◆ Sandbox OS tidak tersedia (${support.reason}): perintah auto-izin berjalan tanpa sandbox, jadi kredensial di folder data snugcode tidak terlindungi di tingkat OS.` });
  }
  const key = ['claude', claudeExe, lightId, baseUrl, authToken, sandboxed].join('|');
  if (sandboxed && !s.meta.local && !s.meta.computer) excludeSandboxStubs(s.meta.cwd);
  const cur = s.agent;
  if (cur && !cur.dead && cur.key === key) {
    clearTimeout(cur.idle);
    cur.idle = null;
    try {
      if (cur.model !== actualModel) await cur.q.setModel(actualModel);
      cur.model = actualModel;
      // null = effort bawaan model ("auto").
      if (cur.effort !== effort) await cur.q.applyFlagSettings({ effortLevel: effort });
      cur.effort = effort;
      return cur;
    } catch (e) {
      s.mgr.log('! ganti model di proses berjalan gagal, proses dibuat ulang: ' + e.message);
    }
  }
  s.closeAgent();

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_EFFORT_LEVEL|CLAUDE_CODE_SUBAGENT_MODEL|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)/.test(k)) delete env[k];
  Object.assign(env, {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_DEFAULT_OPUS_MODEL: actualModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: actualModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: lightId,
    // _FORCE: tanpa ini subagen bawaan (Explore, …) tetap memakai model utama.
    CLAUDE_CODE_SUBAGENT_MODEL: lightId,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CONFIG_DIR: CLAUDE_DIR,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Proses panjang lewat dev_start; Bash/Agent latar belakang hanya menambah skema & giliran liar.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    // Output Bash (npm install/test, build) yang masuk konteks dibatasi; bawaan Claude Code 30k karakter.
    BASH_MAX_OUTPUT_LENGTH: process.env.BASH_MAX_OUTPUT_LENGTH || '15000',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'snugcode/0.1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  });
  // pnpm/yarn tetap ada untuk Bash agen walau tidak terpasang global (bila shim sudah disiapkan).
  Object.assign(env, await toolchainEnv('', env));

  const input = inputQueue();
  const q = query({
    prompt: input,
    options: {
      cwd: s.meta.cwd,
      env,
      ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
      model: actualModel,
      ...(effort ? { effort } : {}),
      resume: s.meta.claudeSessionId || undefined,
      includePartialMessages: true,
      // 'default': Write/Edit ikut lewat canUseTool (checkpoint, mode tinjau edit, folder data);
      // auto-izin & "Selalu" tetap meloloskannya tanpa bertanya.
      // Mode rencana diatur dari HP/terminal saja, jadi agen tidak boleh masuk sendiri.
      permissionMode: s.meta.plan ? 'plan' : 'default',
      // Setelan proyek (.claude/settings.json) TIDAK dimuat: isinya (hook, aturan izin, env,
      // apiKeyHelper) bisa ditulis siapa pun yang punya repo. CLAUDE.md dimuat sendiri (projectInstructions).
      settingSources: [],
      ...(sandboxed ? { sandbox: sandboxOptions({ cwd: s.meta.cwd, computer: !!s.meta.computer }) } : {}),
      settings: { plansDirectory: PLANS_DIR, ...(s.allowRules.size ? { permissions: { allow: [...s.allowRules] } } : {}) },
      tools: AGENT_TOOLS,
      disallowedTools: ['EnterPlanMode'],
      agents: subagents(),
      mcpServers: { snugcode: devToolsServer(s) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: snugcodePrompt({ computer: !!s.meta.computer, project: projectInstructions(s.meta.cwd) }) },
      canUseTool: (tool, toolInput, opts) => s.askPermission(tool, toolInput, opts),
      hooks: {
        PreToolUse: [
          { matcher: MUTATING_MATCHER, hooks: [(h) => s.beforeTool(h)] },
          { matcher: WIDEN_MATCHER, hooks: [async (h) => s.widenTool(h)] },
        ],
      },
      stderr: (d) => s.mgr.log('[claude] ' + d.trim()),
    },
  });
  const agent = {
    kind: 'claude',
    key,
    q,
    // Auto-izin dinyalakan saat proses ini berjalan tanpa sandbox: Bash tetap bertanya sampai prompt berikutnya.
    unsandboxedAuto: support.ok && !sandboxed,
    input,
    model: actualModel,
    effort,
    streamed: new Set(),
    currentMsgId: null,
    dead: false,
    idle: null,
    lastUsed: Date.now(),
    loop: /** @type {Promise<void> | null} */ (null),
    // Gambar dikirim sebagai blok konten pesan user.
    push({ text, images = [] }) {
      const content = images.length ? [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), ...(text ? [{ type: 'text', text }] : [])] : text;
      input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    },
    interrupt: () => q.interrupt(),
    setPlan: (on) => q.setPermissionMode(on ? 'plan' : 'default').catch(() => {}),
    close() {
      input.end();
      try {
        q.close();
      } catch {}
    },
  };
  s.agent = agent;
  agent.loop = s.consume(agent);
  return agent;
}
