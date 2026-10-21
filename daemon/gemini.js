// Gemini CLI engine: Google's official harness for Gemini models, run as an ACP agent
// (Agent Client Protocol: line-delimited JSON-RPC 2.0 over stdio, `gemini --acp`). ACP events are mapped to
// snugcode's event model, and every command/edit goes through the same snugcode permission policy as the other engines.
//
// Installed once into ~/.snugcode/tools/gemini (version pinned in gemini-version.json). GEMINI_CLI_HOME =
// ~/.snugcode/gemini/<repo|computer>: settings & history separate from the user's own Gemini CLI, with
// snugcode's instructions as a global GEMINI.md.
//
// Keamanan:
// - Keys are never given to Gemini CLI: GOOGLE_GEMINI_BASE_URL points at the loopback proxy, and
//   GEMINI_API_KEY holds a local token the proxy swaps for the real key (see proxy.js, the `gemini` route).
// - Folder trust is on (Gemini CLI default): the repo's `.gemini/settings.json` (MCP servers, hooks,
//   discoveryCommand) isn't loaded because the working folder is never marked trusted. As a result Gemini CLI
//   also doesn't load stdio MCP servers (so no snugcode dev tools) or project instructions; project instructions
//   (GEMINI.md / AGENTS.md / CLAUDE.md at the working folder root) are injected by snugcode into the session's first prompt.
// - File reads/writes inside the working folder go through the client (fs/read_text_file, fs/write_text_file): the
//   snugcode data folder is denied here, edits wait for a checkpoint. Gemini CLI has no lightweight OS sandbox on Linux,
//   so under auto-approve shell commands still ask (agent.unsandboxedAuto).
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';
import { geminiPrompt } from './prompt.js';
import { isSensitivePath } from './permissions.js';

export const GEMINI_SPEC = process.env.SNUGCODE_GEMINI || JSON.parse(fs.readFileSync(new URL('./gemini-version.json', import.meta.url), 'utf8')).spec;
const TOOLS_DIR = path.join(HOME, 'tools', 'gemini');
const VERSION = '0.1.0';

// ---------- binary ----------
// [command, ...args] to run gemini; null if not installed yet.
export function geminiCommand(cfg = {}) {
  const exe = cfg.geminiExecutable || process.env.SNUGCODE_GEMINI_BIN;
  if (exe) return fs.existsSync(exe) ? (/\.m?js$/.test(exe) ? [process.execPath, exe] : [exe]) : null;
  const js = path.join(TOOLS_DIR, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
  return fs.existsSync(js) ? [process.execPath, js] : null;
}

let installing = null;
/** @param {any} [cfg] @returns {Promise<string[]>} */
export function installGemini(cfg = {}) {
  const have = geminiCommand(cfg);
  if (have) return Promise.resolve(have);
  if (installing) return installing;
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  if (!fs.existsSync(path.join(TOOLS_DIR, 'package.json'))) fs.writeFileSync(path.join(TOOLS_DIR, 'package.json'), '{"private":true}\n');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  installing = new Promise((resolve, reject) => {
    execFile(npm, ['install', '--no-audit', '--no-fund', '--omit=dev', GEMINI_SPEC], { cwd: TOOLS_DIR, timeout: 10 * 60_000, shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      installing = null;
      const cmd = geminiCommand(cfg);
      if (cmd) return resolve(cmd);
      reject(new Error('Failed to install Gemini CLI: ' + String(err?.message || stderr || 'binary not found').split('\n').slice(-3).join(' ').slice(0, 300)));
    });
  });
  return installing;
}

// ---------- configuration ----------
// snugcode's own Gemini CLI home folder; different instructions for repo sessions and Computer Mode.
export function geminiHome({ computer = false } = {}) {
  const home = path.join(HOME, 'gemini', computer ? 'computer' : 'repo');
  const dir = path.join(home, '.gemini');
  fs.mkdirSync(dir, { recursive: true });
  const settings = {
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    security: { auth: { selectedType: 'gateway' }, folderTrust: { enabled: true } },
    // Plan mode is only set by the user (like EnterPlanMode in the Claude engine).
    tools: { exclude: ['enter_plan_mode'] },
  };
  writeIfChanged(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  writeIfChanged(path.join(dir, 'GEMINI.md'), geminiPrompt({ computer }) + '\n');
  return home;
}

function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return;
  } catch {}
  fs.writeFileSync(file, text);
}

/** @param {NodeJS.ProcessEnv} base @param {{ home: string, baseUrl: string, token: string }} o */
export function geminiEnv(base, { home, baseUrl, token }) {
  const env = { ...base, GEMINI_CLI_HOME: home, GOOGLE_GEMINI_BASE_URL: baseUrl, GEMINI_API_KEY: token, GEMINI_CLI_NO_RELAUNCH: 'true' };
  // The user's Google credentials in env must not be used (or read by agent commands).
  for (const k of Object.keys(env)) if (/^(GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA|GEMINI_SANDBOX|ANTHROPIC_|OPENAI_API_KEY)/.test(k)) delete env[k];
  return env;
}

// snugcode's effort is part of the Gemini model ID (gemini-x-flash-low); Gemini CLI uses the real ID.
export const geminiModelId = (id) => String(id || '').replace(/-(minimal|low|medium|high)$/, '');

// Project instructions at the working folder root. Gemini CLI doesn't load them in untrusted folders,
// so they're injected into the first prompt of a new session (resumed sessions already have them in history).
const RULE_FILES = ['GEMINI.md', 'AGENTS.md', 'CLAUDE.md'];
export function projectInstructions(cwd, max = 24_000) {
  const parts = [];
  for (const f of RULE_FILES) {
    let t;
    try {
      t = fs.readFileSync(path.join(cwd, f), 'utf8').trim();
    } catch {
      continue;
    }
    if (t) parts.push(`<project_instructions file="${f}">\n${t.slice(0, max)}\n</project_instructions>`);
  }
  return parts.length ? 'Project instructions from the repository (follow them):\n' + parts.join('\n') : '';
}

// ---------- JSON-RPC (ACP) ----------
export class AcpRpc extends EventEmitter {
  /** @param {string[]} cmd @param {{ env: NodeJS.ProcessEnv, cwd?: string, log?: (m: string) => void }} opts */
  constructor(cmd, { env, cwd, log = () => {} }) {
    super();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.proc = spawn(cmd[0], [...cmd.slice(1), '--acp'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.onLine(line);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => log('[gemini] ' + String(d).trim().slice(0, 500)));
    this.exited = new Promise((r) => this.proc.on('exit', (code) => r(code)));
    this.proc.on('exit', (code) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`Gemini CLI stopped (exit ${code})`));
      this.pending.clear();
    });
    this.proc.on('error', (e) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
    this.proc.stdin.on('error', () => {});
  }

  onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id != null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      return m.error ? p.reject(new Error(m.error.data?.details || m.error.message || 'Gemini CLI error')) : p.resolve(m.result);
    }
    if (m.method && m.id != null) return this.emit('request', m);
    if (m.method) this.emit('notification', m);
  }

  send(obj) {
    if (!this.closed) this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  }

  /** @param {string} method @param {any} params @param {{ timeout?: number }} [o] */
  call(method, params, { timeout = 60_000 } = {}) {
    if (this.closed) return Promise.reject(new Error('Gemini CLI is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = timeout ? setTimeout(() => this.pending.delete(id) && reject(new Error(`Gemini CLI didn't answer ${method}`)), timeout) : null;
      t?.unref?.();
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.send({ id, method, params });
    });
  }

  respond(id, result) {
    this.send({ id, result });
  }

  fail(id, message, code = -32000) {
    this.send({ id, error: { code, message } });
  }

  notify(method, params) {
    this.send({ method, params });
  }

  close() {
    if (this.closed) return;
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {}
  }
}

// ---------- agent session ----------
const TOOL_NAME = { execute: 'Bash', edit: 'Edit', read: 'Read', search: 'Grep', fetch: 'WebFetch', delete: 'Edit', move: 'Edit', switch_mode: 'ExitPlanMode' };
const PLAN_STATE = { completed: 'done', in_progress: 'doing' };
const cutText = (s, n = 4000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} characters cut)` : s);

function rel(p, cwd) {
  const r = path.relative(cwd, String(p || ''));
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : String(p || '');
}

// ACP tool call content (text, diff) → compact text.
function contentText(content) {
  return (content || [])
    .map((c) => (c.type === 'content' ? (c.content?.type === 'text' ? c.content.text : `[${c.content?.type}]`) : c.type === 'diff' ? `${c.path}` : c.type === 'terminal' ? '[terminal]' : ''))
    .filter(Boolean)
    .join('\n');
}

// ACP diff {path, oldText, newText} → -/+ line snippet for permission cards & tool details.
export function diffOf(content, cwd) {
  return (content || [])
    .filter((c) => c.type === 'diff')
    .map((c) => {
      const old = c.oldText == null ? [] : String(c.oldText).split('\n');
      const neu = String(c.newText ?? '').split('\n');
      let a = 0;
      while (a < old.length && a < neu.length && old[a] === neu[a]) a++;
      let b = 0;
      while (b < old.length - a && b < neu.length - a && old[old.length - 1 - b] === neu[neu.length - 1 - b]) b++;
      const body = [...old.slice(a, old.length - b).map((l) => '-' + l), ...neu.slice(a, neu.length - b).map((l) => '+' + l)];
      return { path: c.path, rel: rel(c.path, cwd), diff: `@@ ${rel(c.path, cwd)} @@\n` + body.slice(0, 400).join('\n') };
    });
}

/**
 * One `gemini --acp` process per session, reused across prompts. `host` = Session (see CodexAgent).
 */
export class GeminiAgent {
  /** @param {any} host @param {{ cmd: string[], env: NodeJS.ProcessEnv, route: any, log: (m: string) => void }} o */
  constructor(host, { cmd, env, route, log }) {
    this.kind = /** @type {const} */ ('gemini');
    this.key = '';
    this.host = host;
    this.route = route;
    this.log = log;
    this.dead = false;
    this.idle = null;
    this.lastUsed = Date.now();
    // Gemini CLI has no lightweight OS sandbox: auto-approve doesn't let shell commands through (sessions.askPermission).
    this.unsandboxedAuto = true;
    this.sessionId = null;
    this.model = null;
    this.mode = 'default';
    this.loading = false;
    this.calls = new Map();
    this.rpc = new AcpRpc(cmd, { env, cwd: host.meta.cwd, log });
    this.rpc.exited.then(() => {
      this.dead = true;
      clearTimeout(this.idle);
      if (this.host.agent === this) this.host.agent = null;
      if (this.host.turn?.agent === this) {
        this.host.emitEvent({ k: 'error', d: 'Gemini CLI stopped in the middle of a prompt.' });
        this.host.endTurn();
      }
    });
    this.rpc.on('notification', (m) => this.onNotification(m));
    this.rpc.on('request', (m) => this.onRequest(m));
  }

  async start() {
    const meta = this.host.meta;
    const init = await this.rpc.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: 'snugcode', title: 'snugcode', version: VERSION } }, { timeout: 60_000 });
    if (!(init?.authMethods || []).some((a) => a.id === 'gateway')) throw new Error('This Gemini CLI version does not support custom endpoints (gateway)');
    await this.rpc.call('authenticate', { methodId: 'gateway' });
    const params = { cwd: meta.cwd, mcpServers: [] };
    let r = null;
    if (meta.geminiSessionId && init.agentCapabilities?.loadSession) {
      // session/load replays history as session/update: ignored (the phone already has the history).
      this.loading = true;
      r = await this.rpc
        .call('session/load', { sessionId: meta.geminiSessionId, ...params }, { timeout: 120_000 })
        .then((x) => ({ ...x, sessionId: meta.geminiSessionId }))
        .catch((e) => (this.log('! resuming the Gemini session failed, starting a new one: ' + e.message), null));
      this.loading = false;
    }
    if (!r) {
      r = await this.rpc.call('session/new', params, { timeout: 120_000 });
      this.fresh = true;
    }
    this.sessionId = r.sessionId;
    this.model = r.models?.currentModelId || null;
    this.mode = r.modes?.currentModeId || 'default';
    if (meta.geminiSessionId !== this.sessionId) {
      meta.geminiSessionId = this.sessionId;
      this.host.mgr.saveIndex();
    }
    return this;
  }

  setRoute(route) {
    this.route = route;
  }

  // User plan mode ↔ Gemini CLI's `plan` mode (read-only).
  async syncMode() {
    const want = this.host.meta.plan ? 'plan' : 'default';
    if (want === this.mode) return;
    await this.rpc.call('session/set_mode', { sessionId: this.sessionId, modeId: want });
    this.mode = want;
  }

  setPlan() {
    if (!this.dead && this.sessionId) this.syncMode().catch((e) => this.log('! set_mode Gemini: ' + e.message));
  }

  async push({ text, images = [] }) {
    clearTimeout(this.idle);
    this.idle = null;
    this.lastUsed = Date.now();
    this.turnStart = Date.now();
    this.toolCount = 0;
    this.lastText = '';
    const model = geminiModelId(this.route.model);
    if (model && model !== this.model) {
      await this.rpc.call('session/set_model', { sessionId: this.sessionId, modelId: model });
      this.model = model;
    }
    await this.syncMode();
    if (this.fresh) {
      this.fresh = false;
      const rules = projectInstructions(this.host.meta.cwd);
      if (rules) text = rules + '\n\n' + (text || '');
    }
    const prompt = [...images.map((i) => ({ type: 'image', mimeType: i.mime, data: i.data })), ...(text ? [{ type: 'text', text }] : [])];
    // Not awaited: the prompt finishes via the session/prompt reply (can take hours).
    this.rpc.call('session/prompt', { sessionId: this.sessionId, prompt }, { timeout: 0 }).then(
      (r) => this.onTurnDone(r),
      (e) => this.onTurnDone({ stopReason: 'error', error: e }),
    );
  }

  async interrupt() {
    if (this.sessionId) this.rpc.notify('session/cancel', { sessionId: this.sessionId });
  }

  close() {
    this.dead = true;
    clearTimeout(this.idle);
    this.rpc.close();
  }

  // ---------- session/update -> event snugcode ----------
  onNotification({ method, params: p }) {
    if (method !== 'session/update' || this.loading || (p?.sessionId && p.sessionId !== this.sessionId)) return;
    const h = this.host;
    const u = p.update || {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type !== 'text') break;
        h.clearThinking();
        h.pushText(u.content.text);
        this.lastText += u.content.text;
        break;
      case 'agent_thought_chunk':
        if (u.content?.type === 'text') h.pushThinking(u.content.text);
        break;
      case 'tool_call':
        this.onToolCall(u);
        break;
      case 'tool_call_update':
        if (!this.calls.has(u.toolCallId)) this.onToolCall(u);
        if (u.status === 'completed' || u.status === 'failed') this.onToolDone(u);
        break;
      case 'plan':
        h.emitEvent({ k: 'tool', id: 'plan-' + this.turnStart, name: 'TodoWrite', s: '', todos: (u.entries || []).map((e) => ({ st: PLAN_STATE[e.status] || 'todo', t: String(e.content || '') })) });
        break;
      case 'current_mode_update':
        if (u.currentModeId) this.mode = u.currentModeId;
        break;
      case 'usage_update':
        if (u.size > 0) this.ctx = Math.round(((u.used || 0) / u.size) * 100);
        break;
    }
  }

  onToolCall(u) {
    const h = this.host;
    const call = { kind: u.kind || 'other', title: String(u.title || ''), locations: u.locations || [] };
    this.calls.set(u.toolCallId, call);
    h.clearThinking();
    h.flushText();
    this.toolCount++;
    const cwd = h.meta.cwd;
    const diffs = diffOf(u.content, cwd);
    const where = call.locations.map((l) => rel(l.path, cwd)).join(', ');
    const name = TOOL_NAME[call.kind] || String(u.toolCallId || '').split('__')[0] || call.title.split(/[\s(]/)[0] || 'Tool';
    h.emitEvent({ k: 'tool', id: u.toolCallId, name, s: (call.kind === 'edit' || call.kind === 'read') && where ? where : call.title, x: diffs.length ? { new: diffs.map((d) => d.diff).join('\n').slice(0, 3000) } : undefined });
  }

  onToolDone(u) {
    const call = this.calls.get(u.toolCallId);
    this.calls.delete(u.toolCallId);
    if (!call) return;
    const out = contentText(u.content);
    this.host.emitEvent({ k: 'result', id: u.toolCallId, ok: u.status === 'completed', d: cutText(out || (u.status === 'completed' ? '' : 'failed')) });
  }

  onTurnDone(r) {
    const h = this.host;
    // Process died mid-prompt: the exit handler already ended the turn (a single error message).
    if (this.dead && r.stopReason === 'error') return;
    h.flushText();
    for (const [id] of this.calls) h.emitEvent({ k: 'result', id, ok: false, d: 'stopped' });
    this.calls.clear();
    const ok = r.stopReason === 'end_turn';
    const u = r.usage;
    const err = ok ? undefined : r.stopReason === 'cancelled' ? 'interrupted' : r.stopReason === 'error' ? cutText(String(r.error?.message || 'Gemini CLI error'), 600) : r.stopReason === 'max_tokens' ? 'token limit reached' : String(r.stopReason || 'failed');
    if (r.stopReason === 'error') h.emitEvent({ k: 'error', d: err });
    h.emitEvent({
      k: 'done',
      ok,
      turns: this.toolCount,
      ms: Date.now() - (this.turnStart || Date.now()),
      usage: u ? { in: u.inputTokens || 0, out: u.outputTokens || 0, cr: u.cachedReadTokens || 0, cw: u.cachedWriteTokens || 0 } : undefined,
      ctx: this.ctx,
      err,
    });
    h.mgr.notify(h, ok ? `✓ done · ${this.lastText.replace(/\s+/g, ' ').slice(0, 140)}` : `✗ stopped · ${String(err).slice(0, 140)}`);
    if (h.turn?.agent === this) h.endTurn();
    if (!this.dead) h.idleAgent(this);
  }

  // ---------- requests from Gemini CLI: permissions & files ----------
  async onRequest({ id, method, params: p }) {
    try {
      if (method === 'session/request_permission') return this.rpc.respond(id, { outcome: await this.permission(p) });
      if (method === 'fs/read_text_file') return this.rpc.respond(id, { content: this.readText(p) });
      if (method === 'fs/write_text_file') return this.rpc.respond(id, await this.writeText(p));
      this.rpc.fail(id, 'snugcode does not support ' + method, -32601);
    } catch (e) {
      this.rpc.fail(id, String(e?.message || e));
    }
  }

  async permission(p) {
    const opts = p.options || [];
    const pick = (kind) => opts.find((o) => o.kind === kind)?.optionId;
    const tc = p.toolCall || {};
    const allowed = await this.host.decideGemini(tc);
    const optionId = allowed ? pick('allow_once') || pick('allow_always') : pick('reject_once') || pick('reject_always');
    return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
  }

  readText({ path: p, line, limit }) {
    const abs = path.resolve(this.host.meta.cwd, String(p || ''));
    if (isSensitivePath(abs)) throw new Error('The snugcode data folder holds credentials and may not be accessed by the agent.');
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      // Gemini CLI doesn't recognize ENOENT errors over ACP (a plain error object, not an Error with `code`), so
      // write_file to a new file failed. A missing file = empty content; read_file checks existence
      // itself before reading.
      if (e?.code === 'ENOENT') return '';
      throw e;
    }
    if (line || limit) {
      const lines = text.split('\n');
      const from = Math.max(0, (line || 1) - 1);
      text = lines.slice(from, limit ? from + limit : undefined).join('\n');
    }
    return text;
  }

  async writeText({ path: p, content }) {
    const abs = path.resolve(this.host.meta.cwd, String(p || ''));
    if (isSensitivePath(abs, { write: true })) throw new Error('The snugcode data folder holds credentials and may not be accessed by the agent.');
    if (this.host.cpReady) await this.host.cpReady;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(content ?? ''));
    return null;
  }
}
