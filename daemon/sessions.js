// Sesi agen: menjalankan Claude Code (Agent SDK) dengan model dari 9router,
// mengubah pesan SDK menjadi event ringkas untuk HP, dan menyimpan riwayatnya.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SESSIONS_DIR, CLAUDE_DIR, anthropicBaseUrl } from './config.js';
import { prepareWorktree, removeWorktree, inspectLocalRepo, currentBranch } from './github.js';
import { startRouterProxy } from './proxy.js';
import { resolveModelEffort } from '../shared/models.js';

const INDEX = path.join(SESSIONS_DIR, 'index.json');
const OUT_LIMIT = 4000;

// Tool yang tidak pernah butuh izin di sesi ini.
const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'Task', 'Agent', 'WebSearch', 'WebFetch', 'NotebookRead', 'ToolSearch']);

const MOBILE_NOTE = `
You are being driven through the "pocketcode" app, from a phone or from the pocketcode terminal UI (the same session can be continued on either).
- The user may read your output on a small screen: keep messages concise, prefer short paragraphs and lists.
- The repository is on the user's computer. Do NOT run \`git push\` yourself; the user pushes from the app (/push in the terminal). Committing is fine when asked.
- Work inside the current working directory.`;

const isGitPush = (tool, input) => tool === 'Bash' && /\bgit\s+push\b/.test(input?.command || '');

function cut(s, n = OUT_LIMIT) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} karakter dipotong)` : s;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

// Ringkasan input tool supaya muat di layar HP (path dibuat relatif ke worktree).
export function toolSummary(name, input = {}, cwd) {
  const s = toolSummaryRaw(name, input);
  if (!cwd || typeof s !== 'string') return s;
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const base = norm(cwd).replace(/\/+$/, '') + '/';
  const rel = (p) => (norm(p).startsWith(base) ? p.slice(base.length).replace(/\\/g, '/') || '.' : norm(p) === base.slice(0, -1) ? '.' : p);
  return s.replace(/[A-Za-z]:[\\/][^\s'"]*|\/[^\s'"]+/g, rel);
}

function toolSummaryRaw(name, input = {}) {
  switch (name) {
    case 'Bash':
      return input.command;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return input.file_path || input.notebook_path;
    case 'Glob':
      return input.pattern;
    case 'Grep':
      return `${input.pattern}${input.path ? '  in ' + input.path : ''}`;
    case 'WebFetch':
      return input.url;
    case 'WebSearch':
      return input.query;
    case 'Task':
    case 'Agent':
      return input.description || input.prompt;
    case 'TodoWrite':
      return (input.todos || []).map((t) => `${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} ${t.content}`).join('\n');
    default:
      return cut(input, 400);
  }
}

// Untuk Edit/Write: kirim cuplikan perubahan agar bisa ditampilkan sebagai diff mini.
function toolDetail(name, input = {}) {
  if (name === 'Edit') return { old: cut(input.old_string || '', 3000), new: cut(input.new_string || '', 3000) };
  if (name === 'MultiEdit') return { edits: (input.edits || []).slice(0, 10).map((e) => ({ old: cut(e.old_string, 1500), new: cut(e.new_string, 1500) })) };
  if (name === 'Write') return { new: cut(input.content || '', 3000) };
  return undefined;
}

export class Session extends EventEmitter {
  constructor(meta, manager) {
    super();
    this.meta = meta;
    this.mgr = manager;
    this.events = [];
    this.seq = 0;
    this.status = 'idle';
    this.query = null;
    this.perms = new Map(); // pid -> { resolve, tool, input }
    this.alwaysAllow = new Set();
    this.textBuf = '';
    this.textTimer = null;
    this.logFile = path.join(SESSIONS_DIR, meta.id + '.jsonl');
    this.load();
  }

  get id() {
    return this.meta.id;
  }

  load() {
    if (!fs.existsSync(this.logFile)) return;
    for (const line of fs.readFileSync(this.logFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        this.events.push(e);
        this.seq = e.seq;
      } catch {}
    }
  }

  summary() {
    const m = this.meta;
    // Di sesi lokal pengguna bisa pindah branch dari terminal; baca yang aktif sekarang.
    const branch = (m.local && currentBranch(m.cwd)) || m.branch;
    return { id: m.id, repo: m.repo, branch, base: m.base, title: m.title, model: m.model, status: this.status, updatedAt: m.updatedAt, auto: !!m.auto, local: !!m.local, cwd: m.cwd };
  }

  emitEvent(e, { persist = true } = {}) {
    if (e.k !== 'text') this.flushText();
    e.seq = ++this.seq;
    e.ts = Date.now();
    this.events.push(e);
    if (persist) fs.appendFileSync(this.logFile, JSON.stringify(e) + '\n');
    this.emit('event', e);
  }

  // Delta teks dikumpulkan ~80ms agar tidak mengirim satu pesan per token.
  pushText(t) {
    this.textBuf += t;
    if (!this.textTimer) this.textTimer = setTimeout(() => this.flushText(), 80);
  }
  flushText() {
    if (this.textTimer) clearTimeout(this.textTimer);
    this.textTimer = null;
    if (!this.textBuf) return;
    const d = this.textBuf;
    this.textBuf = '';
    this.emitEvent({ k: 'text', d });
  }

  setStatus(s) {
    this.status = s;
    this.meta.updatedAt = Date.now();
    this.mgr.saveIndex();
    this.emitEvent({ k: 'status', s }, { persist: false });
  }

  since(seq) {
    return this.events.filter((e) => e.seq > seq);
  }

  pendingPerms() {
    return [...this.perms.entries()].map(([pid, p]) => ({ pid, tool: p.tool, summary: toolSummary(p.tool, p.input, this.meta.cwd), title: p.title, push: isGitPush(p.tool, p.input) }));
  }

  async send(text) {
    if (this.status === 'running') throw new Error('Agen masih berjalan. Hentikan dulu (Stop) atau tunggu selesai.');
    if (text.startsWith('!')) return this.shell(text.slice(1).trim());
    if (!this.meta.title) this.meta.title = text.slice(0, 80);
    this.emitEvent({ k: 'user', d: text });
    this.run(text).catch((err) => {
      this.emitEvent({ k: 'error', d: String(err?.message || err) });
      this.setStatus('idle');
    });
  }

  async run(prompt) {
    const cfg = this.mgr.config;
    const sec = this.mgr.secrets;
    this.setStatus('running');
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH)/.test(k)) delete env[k];

    const { actualModel, effort } = resolveModelEffort(this.meta.model);
    const actualSmallModel = cfg.smallModel ? resolveModelEffort(cfg.smallModel).actualModel : actualModel;
    const baseUrl = (await this.mgr.proxy?.ready()) || anthropicBaseUrl(cfg.routerUrl);

    Object.assign(env, {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: sec.routerKey,
      ANTHROPIC_DEFAULT_OPUS_MODEL: actualModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: actualModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: actualSmallModel,
      CLAUDE_CODE_SUBAGENT_MODEL: actualModel,
      CLAUDE_CONFIG_DIR: CLAUDE_DIR,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'pocketcode/0.1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    });
    if (effort) env.CLAUDE_CODE_EFFORT_LEVEL = effort;

    const streamed = new Set();
    let currentMsgId = null;
    const q = query({
      prompt,
      options: {
        cwd: this.meta.cwd,
        env,
        model: actualModel,
        ...(effort ? { effort } : {}),
        resume: this.meta.claudeSessionId || undefined,
        includePartialMessages: true,
        permissionMode: 'acceptEdits',
        settingSources: ['project'],
        disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: MOBILE_NOTE },
        canUseTool: (tool, input, opts) => this.askPermission(tool, input, opts),
        stderr: (d) => this.mgr.log('[claude] ' + d.trim()),
      },
    });
    this.query = q;
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') {
          if (this.meta.claudeSessionId !== m.session_id) {
            this.meta.claudeSessionId = m.session_id;
            this.mgr.saveIndex();
          }
        } else if (m.type === 'system' && m.subtype === 'api_retry') {
          this.emitEvent({ k: 'retry', attempt: m.attempt, max: m.max_retries, status: m.error_status });
        } else if (m.type === 'stream_event') {
          const ev = m.event;
          if (ev.type === 'message_start') currentMsgId = ev.message?.id;
          else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            streamed.add(currentMsgId);
            this.pushText(ev.delta.text);
          } else if (ev.type === 'content_block_stop') this.flushText();
        } else if (m.type === 'assistant') {
          if (m.parent_tool_use_id) continue; // isi subagent tidak ditampilkan rinci
          for (const b of m.message.content || []) {
            if (b.type === 'text' && !streamed.has(m.message.id) && b.text) this.emitEvent({ k: 'text', d: b.text });
            if (b.type === 'tool_use') this.emitEvent({ k: 'tool', id: b.id, name: b.name, s: toolSummary(b.name, b.input, this.meta.cwd), x: toolDetail(b.name, b.input) });
          }
        } else if (m.type === 'user' && !m.parent_tool_use_id) {
          const content = m.message?.content;
          if (Array.isArray(content))
            for (const b of content) {
              if (b.type === 'tool_result') this.emitEvent({ k: 'result', id: b.tool_use_id, ok: !b.is_error, d: cut(toolResultText(b.content)) });
            }
        } else if (m.type === 'result') {
          this.flushText();
          this.emitEvent({
            k: 'done',
            ok: m.subtype === 'success' && !m.is_error,
            turns: m.num_turns,
            ms: m.duration_ms,
            usage: m.usage ? { in: m.usage.input_tokens, out: m.usage.output_tokens } : undefined,
            err: m.subtype !== 'success' ? m.subtype : m.is_error ? cut(m.result || '', 600) : undefined,
          });
        }
      }
    } finally {
      this.flushText();
      this.query = null;
      for (const p of this.perms.values()) p.resolve({ behavior: 'deny', message: 'Sesi dihentikan' });
      this.perms.clear();
      this.setStatus('idle');
    }
  }

  askPermission(tool, input, opts) {
    const isPush = isGitPush(tool, input);
    if (!isPush && (SAFE_TOOLS.has(tool) || this.meta.auto || this.alwaysAllow.has(tool))) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const pid = randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      this.perms.set(pid, { resolve, tool, input, title: opts?.title });
      this.emitEvent({ k: 'perm', pid, tool, s: toolSummary(tool, input, this.meta.cwd), title: opts?.title, push: isPush }, { persist: false });
      this.mgr.notify(this, `Butuh izin: ${tool}`);
      opts?.signal?.addEventListener('abort', () => {
        if (this.perms.delete(pid)) resolve({ behavior: 'deny', message: 'dibatalkan' });
      });
    });
  }

  answerPermission(pid, decision) {
    const p = this.perms.get(pid);
    if (!p) return false;
    this.perms.delete(pid);
    if (decision === 'always') this.alwaysAllow.add(p.tool);
    const allow = decision === 'allow' || decision === 'always';
    this.emitEvent({ k: 'permAnswer', pid, allow, tool: p.tool, s: toolSummary(p.tool, p.input, this.meta.cwd) });
    p.resolve(allow ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: 'Pengguna menolak aksi ini dari HP.' });
    return true;
  }

  async interrupt() {
    if (this.shellProc) this.shellProc.kill();
    if (this.query) await this.query.interrupt().catch(() => {});
  }

  // "!perintah" -> jalankan langsung di worktree (seperti ! di Claude Code).
  shell(cmd) {
    if (!cmd) return;
    this.emitEvent({ k: 'sh', d: cmd });
    this.setStatus('running');
    const isWin = process.platform === 'win32';
    const p = spawn(isWin ? 'powershell.exe' : process.env.SHELL || 'bash', isWin ? ['-NoProfile', '-Command', cmd] : ['-lc', cmd], {
      cwd: this.meta.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    this.shellProc = p;
    let buf = '';
    let total = 0;
    const flush = () => {
      if (buf) this.emitEvent({ k: 'out', d: buf });
      buf = '';
    };
    const timer = setInterval(flush, 150);
    const onData = (d) => {
      total += d.length;
      if (total < 512 * 1024) buf += d.toString();
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const kill = setTimeout(() => p.kill(), 10 * 60 * 1000);
    p.on('close', (code) => {
      clearInterval(timer);
      clearTimeout(kill);
      flush();
      this.shellProc = null;
      this.emitEvent({ k: 'shDone', code });
      this.setStatus('idle');
    });
    p.on('error', (e) => this.emitEvent({ k: 'error', d: e.message }));
  }
}

export class SessionManager {
  constructor({ config, secrets, log, notify }) {
    this.config = config;
    this.secrets = secrets;
    this.log = log;
    this.notify = notify || (() => {});
    this.sessions = new Map();
    try {
      this.proxy = startRouterProxy(config.routerUrl, secrets.routerKey);
    } catch (e) {
      this.log?.('! gagal memulai loopback proxy: ' + e.message);
    }
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    let index = [];
    try {
      index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    } catch {}
    for (const meta of index) if (fs.existsSync(meta.cwd)) this.sessions.set(meta.id, new Session(meta, this));
  }

  close() {
    this.proxy?.close();
  }

  saveIndex() {
    const data = [...this.sessions.values()].map((s) => s.meta);
    fs.writeFileSync(INDEX, JSON.stringify(data, null, 2));
  }

  list() {
    return [...this.sessions.values()].map((s) => s.summary()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Sesi tidak ditemukan');
    return s;
  }

  async create({ repo, base, branch, model, local }) {
    if (local) {
      // Folder lokal dari terminal: pakai ulang sesi yang sudah ada untuk folder yang sama.
      const info = await inspectLocalRepo(local);
      const existing = [...this.sessions.values()].find((s) => s.meta.local && path.resolve(s.meta.cwd).toLowerCase() === info.cwd.toLowerCase());
      if (existing) return existing;
      const id = randomBytes(4).toString('hex');
      const meta = { id, repo: info.repo, cwd: info.cwd, branch: info.branch, base: info.base, local: true, model: model || this.config.model, title: '', createdAt: Date.now(), updatedAt: Date.now(), auto: false };
      const s = new Session(meta, this);
      this.sessions.set(id, s);
      this.saveIndex();
      return s;
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Format repo harus owner/nama');
    const id = randomBytes(4).toString('hex');
    branch = (branch || '').trim() || 'pocket/' + id;
    const wt = await prepareWorktree(this.secrets.githubToken, repo, { base: base || undefined, branch, sessionId: id });
    const meta = { id, repo, ...wt, model: model || this.config.model, title: '', createdAt: Date.now(), updatedAt: Date.now(), auto: false };
    const s = new Session(meta, this);
    this.sessions.set(id, s);
    this.saveIndex();
    return s;
  }

  async remove(id) {
    const s = this.get(id);
    await s.interrupt();
    this.sessions.delete(id);
    this.saveIndex();
    fs.rmSync(s.logFile, { force: true });
    // Folder lokal milik pengguna tidak pernah dihapus; hanya riwayat sesinya.
    if (!s.meta.local) await removeWorktree(s.meta.cwd);
  }
}
