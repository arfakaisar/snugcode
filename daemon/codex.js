// Codex engine: OpenAI's official harness (`codex app-server`, JSON-RPC over stdio) for GPT models,
// either via ChatGPT login (allowed by OpenAI for third-party apps) or an API key / router
// that serves the Responses API. Codex events are mapped to snugcode's event model (shared/events.js), and
// every command/file change goes through the same snugcode permission policy as the Claude engine.
//
// Codex is installed once into ~/.snugcode/tools/codex (pinned version: the app-server protocol is still
// experimental). CODEX_HOME = ~/.snugcode/codex (ChatGPT login, thread history).
//
// Security: API keys are never given to Codex. For API-key connections, Codex uses a custom
// provider pointing at the loopback proxy with a local token (see proxy.js). Agent commands
// run in Codex's sandbox (bubblewrap/Seatbelt) with a profile that denies reading the snugcode
// data folder (secrets.json, ChatGPT login, .env templates, history); network is allowed.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';

// Version pinned in codex-version.json (also read by CI); can be overridden with SNUGCODE_CODEX.
export const CODEX_SPEC = process.env.SNUGCODE_CODEX || JSON.parse(fs.readFileSync(new URL('./codex-version.json', import.meta.url), 'utf8')).spec;
export const CODEX_HOME = path.join(HOME, 'codex');
const TOOLS_DIR = path.join(HOME, 'tools', 'codex');
const VERSION = '0.1.0';

// ---------- binary ----------
// [command, ...args] to run codex; null if not installed yet.
export function codexCommand(cfg = {}) {
  if (cfg.codexExecutable) return fs.existsSync(cfg.codexExecutable) ? [cfg.codexExecutable] : null;
  const js = path.join(TOOLS_DIR, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return fs.existsSync(js) ? [process.execPath, js] : null;
}

let installing = null;
// Install Codex (once). onProgress(text) for display on the phone/terminal.
/** @param {any} [cfg] @param {{ onProgress?: (msg: string) => void }} [opts] @returns {Promise<string[]>} */
export function installCodex(cfg = {}, { onProgress = () => {} } = {}) {
  const have = codexCommand(cfg);
  if (have) return Promise.resolve(have);
  if (installing) return installing;
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  if (!fs.existsSync(path.join(TOOLS_DIR, 'package.json'))) fs.writeFileSync(path.join(TOOLS_DIR, 'package.json'), '{"private":true}\n');
  onProgress('Installing Codex (once, ~1–2 min)…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  installing = new Promise((resolve, reject) => {
    execFile(npm, ['install', '--no-audit', '--no-fund', '--include=optional', CODEX_SPEC], { cwd: TOOLS_DIR, timeout: 10 * 60_000, shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      installing = null;
      const cmd = codexCommand(cfg);
      if (cmd) return resolve(cmd);
      reject(new Error('Failed to install Codex: ' + String(err?.message || stderr || 'binary not found').split('\n').slice(-3).join(' ').slice(0, 300)));
    });
  });
  return installing;
}

// ---------- JSON-RPC ----------
export class CodexRpc extends EventEmitter {
  /** @param {string[]} cmd @param {string[]} args @param {{ env: NodeJS.ProcessEnv, cwd?: string, log?: (m: string) => void }} opts */
  constructor(cmd, args, { env, cwd, log = () => {} }) {
    super();
    this.log = log;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    fs.mkdirSync(env.CODEX_HOME || CODEX_HOME, { recursive: true });
    this.proc = spawn(cmd[0], [...cmd.slice(1), 'app-server', ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    this.proc.stderr.on('data', (d) => log('[codex] ' + String(d).trim().slice(0, 500)));
    this.exited = new Promise((r) => this.proc.on('exit', (code) => r(code)));
    this.proc.on('exit', (code) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`Codex stopped (exit ${code})`));
      this.pending.clear();
      this.emit('exit', code);
    });
    this.proc.on('error', (e) => this.emit('error', e));
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
      return m.error ? p.reject(new Error(m.error.message || 'Codex error')) : p.resolve(m.result);
    }
    if (m.method && m.id != null) return this.emit('request', m);
    if (m.method) this.emit('notification', m);
  }

  send(obj) {
    if (!this.closed) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  call(method, params, { timeout = 60_000 } = {}) {
    if (this.closed) return Promise.reject(new Error('Codex is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => this.pending.delete(id) && reject(new Error(`Codex didn't answer ${method}`)), timeout);
      t.unref?.();
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.send({ id, method, params });
    });
  }

  respond(id, result) {
    this.send({ id, result });
  }

  async init() {
    await this.call('initialize', { clientInfo: { name: 'snugcode', title: 'snugcode', version: VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } }, { timeout: 30_000 });
    this.send({ method: 'initialized' });
    return this;
  }

  close() {
    if (this.closed) return;
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {}
  }
}

// ---------- configuration ----------
const toml = (v) => JSON.stringify(v); // TOML string = JSON string for plain text
const inlineTable = (o) =>
  '{' +
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : toml(k)}=${typeof v === 'object' && !Array.isArray(v) ? inlineTable(v) : Array.isArray(v) ? '[' + v.map(toml).join(',') + ']' : toml(v)}`)
    .join(',') +
  '}';

// snugcode data folders agent commands may not read (Codex's sandbox denies them at the OS level).
export function deniedPaths() {
  return ['secrets.json', 'secrets.key', 'config.json', 'codex', 'claude', 'env', 'sessions', 'daemon.log'].map((p) => path.join(HOME, p));
}

// Codex's OS sandbox (bubblewrap/Landlock on Linux, Seatbelt on macOS, restricted token on Windows) may be unavailable,
// e.g. in containers without user namespaces, or may not enforce snugcode's deny rules on every platform. Tested once
// per daemon process with snugcode's real permission profile: the command must run AND must fail to read a canary file
// in a denied folder. Anything else counts as "no sandbox" (every command then asks, see codexArgs).
let sandboxProbe = null;
/** @param {string[]} cmd */
export function sandboxWorks(cmd) {
  // CODEX_HOME must exist: without it Codex fails before testing the sandbox (formerly read as "unavailable").
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  sandboxProbe ??= new Promise((resolve) => {
    let canary;
    try {
      canary = path.join(HOME, 'sessions', '.sandbox-canary');
      fs.mkdirSync(path.dirname(canary), { recursive: true });
      fs.writeFileSync(canary, 'x');
    } catch {
      return resolve(false);
    }
    const script = `try{require('fs').readFileSync(${JSON.stringify(canary)});console.log('snug-read-leak')}catch{console.log('snug-sandbox-ok')}`;
    const profile = codexArgs({ sandbox: true }).slice(0, 4);
    execFile(cmd[0], [...cmd.slice(1), 'sandbox', ...profile, '--', process.execPath, '-e', script], { env: codexEnv(), timeout: 30_000, windowsHide: true }, (err, out, errOut) => {
      const text = String(out);
      const ok = !err && text.includes('snug-sandbox-ok') && !text.includes('snug-read-leak');
      if (!ok) console.error('! Codex sandbox unavailable' + (text.includes('snug-read-leak') ? ': it does not deny the snugcode data folder on this platform' : ': ' + String(errOut || err?.message || '').split('\n').filter((l) => /error|denied|permission|namespace/i.test(l)).slice(0, 2).join(' ').slice(0, 300)));
      resolve(ok);
    });
  });
  return sandboxProbe;
}

/**
 * Arguments for `codex app-server`.
 * @param {{ provider?: { baseUrl: string, envKey: string } | null, computer?: boolean, plan?: boolean, sandbox?: boolean, mcp?: { command: string, args: string[], env: Record<string, string> } | null }} o
 */
export function codexArgs({ provider, computer = false, plan = false, sandbox = true, mcp } = {}) {
  const fsRules = Object.fromEntries(deniedPaths().map((p) => [p, 'deny']));
  // Computer Mode: write anywhere (like Claude-engine Computer sessions), the data folder stays closed.
  if (computer && !plan) fsRules['/'] = 'write';
  // Plan mode: read-only (Codex has no ExitPlanMode; the plan shows up as the answer).
  const base = plan ? ':read-only' : ':workspace';
  const args = sandbox
    ? ['-c', 'default_permissions="snugcode"', '-c', `permissions.snugcode=${inlineTable({ extends: base, filesystem: fsRules, network: { enabled: true } })}`]
    : // No OS sandbox: every command still goes through snugcode permissions (approvalPolicy untrusted).
      ['-c', `default_permissions="${plan ? ':read-only' : ':danger-full-access'}"`];
  args.push(
    // snugcode manages updates; Codex's new-version notices aren't relevant to phone users.
    '-c', 'check_for_update_on_startup=false',
  );
  if (provider) {
    args.push('-c', 'model_provider="snugcode"');
    args.push('-c', `model_providers.snugcode=${inlineTable({ name: 'snugcode', base_url: provider.baseUrl, env_key: provider.envKey, wire_api: 'responses', requires_openai_auth: false })}`);
  }
  if (mcp) args.push('-c', `mcp_servers.snugcode=${inlineTable({ command: mcp.command, args: mcp.args, env: mcp.env })}`);
  return args;
}

export function codexEnv(base = process.env, extra = {}) {
  const env = { ...base, CODEX_HOME, ...extra };
  for (const k of Object.keys(env)) if (/^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|ANTHROPIC_)/.test(k)) delete env[k];
  return env;
}

// ---------- ChatGPT account ----------
/** @template T @param {any} cfg @param {(rpc: CodexRpc) => Promise<T>} fn @param {{ log?: (m: string) => void }} [opts] @returns {Promise<T>} */
async function withClient(cfg, fn, { log } = {}) {
  const cmd = await installCodex(cfg);
  const rpc = await new CodexRpc(cmd, codexArgs(), { env: codexEnv(), log }).init();
  try {
    return await fn(rpc);
  } finally {
    rpc.close();
  }
}

export async function chatgptAccount(cfg) {
  if (!codexCommand(cfg)) return null;
  return withClient(cfg, async (rpc) => (await rpc.call('account/read', { refreshToken: false })).account);
}

// ChatGPT login with a device code (can be completed from the phone). Returns the code right away;
// onDone({ ok, account, err }) is called when the user finishes (or fails / 15 minutes).
/** @type {CodexRpc | null} */
let activeLogin = null;
/** @param {any} cfg @param {{ onDone?: (r: { ok: boolean, account: any, err: string | null }) => void, log?: (m: string) => void }} [opts] */
export async function chatgptLoginStart(cfg, { onDone, log } = {}) {
  activeLogin?.close();
  const cmd = await installCodex(cfg);
  const rpc = await new CodexRpc(cmd, codexArgs(), { env: codexEnv(), log }).init();
  activeLogin = rpc;
  let r;
  try {
    r = await rpc.call('account/login/start', { type: 'chatgptDeviceCode' });
  } catch (e) {
    rpc.close();
    throw e;
  }
  const finish = async (ok, err) => {
    clearTimeout(timer);
    let account = null;
    if (ok) account = await rpc.call('account/read', { refreshToken: false }).then((x) => x.account, () => null);
    rpc.close();
    if (activeLogin === rpc) activeLogin = null;
    onDone?.({ ok: ok && account?.type === 'chatgpt', account, err: ok && account?.type !== 'chatgpt' ? 'Login finished but the ChatGPT account could not be read' : err });
  };
  const timer = setTimeout(() => finish(false, 'The login code expired'), 15 * 60_000);
  timer.unref?.();
  rpc.on('notification', (m) => {
    if (m.method === 'account/login/completed' && (!m.params.loginId || m.params.loginId === r.loginId)) finish(!!m.params.success, m.params.error || null);
  });
  rpc.on('exit', () => clearTimeout(timer));
  return { url: r.verificationUrl, code: r.userCode, loginId: r.loginId };
}

export async function chatgptLogout(cfg) {
  if (!codexCommand(cfg)) return false;
  await withClient(cfg, (rpc) => rpc.call('account/logout', {}).catch(() => {}));
  return true;
}

// ChatGPT/Codex model list -> snugcode model list format (see providers.normalizeModels).
export async function chatgptModels(cfg, connId = 'chatgpt') {
  const data = await withClient(cfg, async (rpc) => {
    const out = [];
    let cursor = null;
    for (let i = 0; i < 5; i++) {
      const r = await rpc.call('model/list', { cursor, limit: 100 });
      out.push(...(r.data || []));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  });
  return data
    .filter((m) => !m.hidden)
    .map((m) => ({ id: `${connId}:${m.model || m.id}`, efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).filter((e) => ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(e)), label: 'ChatGPT', engine: 'codex', vision: (m.inputModalities || []).includes('image'), isDefault: !!m.isDefault }));
}

// ---------- agent session ----------
// Codex commands are wrapped in a shell ("/bin/bash -lc '…'"); use the inner command for permission patterns & display.
export function unwrapCommand(cmd) {
  const s = String(cmd || '');
  const m = s.match(/^(?:\/\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return m ? (m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2]) : s;
}

// Read-only actions (cat/ls/rg/grep …) per Codex's parser: equivalent to the read-only commands Claude Code
// allows without asking. The sandbox still denies the snugcode data folder.
export const readOnlyActions = (actions) => Array.isArray(actions) && actions.length > 0 && actions.every((a) => ['read', 'listFiles', 'search'].includes(a?.type));

const PLAN_STATE = { completed: 'done', inProgress: 'doing', in_progress: 'doing' };

/**
 * One app-server process per session (like one claude process per session), reused across prompts.
 * `host` = Session: emitEvent, pushText, pushThinking, flushText, clearThinking, live, endTurn,
 * decideCodex(kind, params) -> Promise<decision>, idle, meta.
 */
export class CodexAgent {
  constructor(host, { cmd, args, env, route, instructions, log }) {
    this.kind = /** @type {const} */ ('codex');
    this.key = '';
    this.host = host;
    this.route = route;
    this.instructions = instructions;
    this.log = log;
    this.dead = false;
    this.idle = null;
    this.lastUsed = Date.now();
    this.threadId = null;
    this.turnId = null;
    this.items = new Map();
    this.streamed = new Set();
    this.rpc = new CodexRpc(cmd, args, { env, cwd: host.meta.cwd, log });
    this.loop = this.rpc.exited.then(() => {
      this.dead = true;
      clearTimeout(this.idle);
      if (this.host.agent === this) this.host.agent = null;
      if (this.host.turn?.agent === this) {
        this.host.emitEvent({ k: 'error', d: 'Codex stopped in the middle of a prompt.' });
        this.host.endTurn();
      }
    });
    this.rpc.on('notification', (m) => this.onNotification(m));
    this.rpc.on('request', (m) => this.onRequest(m));
  }

  async start() {
    await this.rpc.init();
    const meta = this.host.meta;
    const common = { model: this.route.model, cwd: meta.cwd, approvalPolicy: 'untrusted', developerInstructions: this.instructions };
    let r = null;
    if (meta.codexThreadId) r = await this.rpc.call('thread/resume', { threadId: meta.codexThreadId, ...common, excludeTurns: true }).catch((e) => (this.log('! resuming Codex thread failed, starting a new thread: ' + e.message), null));
    if (!r) r = await this.rpc.call('thread/start', common);
    this.threadId = r.thread.id;
    if (meta.codexThreadId !== this.threadId) {
      meta.codexThreadId = this.threadId;
      this.host.mgr.saveIndex();
    }
    return this;
  }

  // content: text + images (data URIs from the phone). model/effort apply from this prompt on.
  async push({ text, images = [] }) {
    clearTimeout(this.idle);
    this.idle = null;
    this.lastUsed = Date.now();
    this.turnStart = Date.now();
    this.usageAtStart = this.usageTotal || null;
    this.toolCount = 0;
    const input = [...images.map((i) => ({ type: 'image', url: `data:${i.mime};base64,${i.data}` })), ...(text ? [{ type: 'text', text, text_elements: [] }] : [])];
    const r = await this.rpc.call('turn/start', {
      threadId: this.threadId,
      input,
      model: this.route.model,
      effort: this.route.effort || null,
      approvalPolicy: 'untrusted',
    });
    this.turnId = r.turn?.id || null;
  }

  setRoute(route) {
    this.route = route;
  }


  async interrupt() {
    if (this.threadId && this.turnId) await this.rpc.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, { timeout: 10_000 }).catch(() => {});
  }

  close() {
    this.dead = true;
    clearTimeout(this.idle);
    this.rpc.close();
  }

  // ---------- notifications -> snugcode events ----------
  onNotification({ method, params: p }) {
    const h = this.host;
    if (p?.threadId && this.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn?.id || this.turnId;
        break;
      case 'item/agentMessage/delta':
        h.clearThinking();
        this.streamed.add(p.itemId);
        h.pushText(p.delta);
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        h.pushThinking(p.delta);
        break;
      case 'item/started':
        this.onItemStarted(p.item);
        break;
      case 'item/completed':
        this.onItemCompleted(p.item);
        break;
      case 'turn/plan/updated':
        h.emitEvent({ k: 'tool', id: 'plan-' + (this.turnId || ''), name: 'TodoWrite', s: '', todos: (p.plan || []).map((s) => ({ st: PLAN_STATE[s.status] || 'todo', t: String(s.step || '') })) });
        break;
      case 'thread/tokenUsage/updated':
        this.usageTotal = p.tokenUsage?.total || this.usageTotal;
        this.ctxMax = p.tokenUsage?.modelContextWindow || this.ctxMax;
        this.lastIn = p.tokenUsage?.last?.inputTokens || this.lastIn;
        break;
      case 'error':
        if (p.willRetry) h.emitEvent({ k: 'retry', attempt: undefined, max: undefined, status: p.error?.codexErrorInfo ? JSON.stringify(p.error.codexErrorInfo).slice(0, 40) : undefined });
        else h.emitEvent({ k: 'error', d: String(p.error?.message || 'Codex error') + (p.error?.additionalDetails ? ' — ' + p.error.additionalDetails : '') });
        break;
      case 'turn/completed':
        this.onTurnCompleted(p.turn);
        break;
    }
  }

  onItemStarted(it) {
    if (!it) return;
    const h = this.host;
    this.items.set(it.id, it);
    const tool = (name, s, x) => {
      h.clearThinking();
      h.flushText();
      this.toolCount++;
      h.emitEvent({ k: 'tool', id: it.id, name, s, x });
    };
    if (it.type === 'commandExecution') tool('Bash', unwrapCommand(it.command));
    else if (it.type === 'fileChange') tool('Edit', (it.changes || []).map((c) => rel(c.path, h.meta.cwd)).join(', '), diffDetail(it.changes));
    else if (it.type === 'mcpToolCall') tool(it.server === 'snugcode' ? it.tool : `${it.server}:${it.tool}`, summarizeArgs(it.arguments));
    else if (it.type === 'webSearch') tool('WebSearch', it.query || it.action?.query || '');
    else if (it.type === 'collabAgentToolCall' || it.type === 'subAgentActivity') tool('Agent', it.prompt || it.description || '');
  }

  onItemCompleted(it) {
    if (!it) return;
    const h = this.host;
    const prev = this.items.get(it.id);
    this.items.delete(it.id);
    if (it.type === 'agentMessage') {
      if (!this.streamed.has(it.id) && it.text) h.emitEvent({ k: 'text', d: it.text });
      h.flushText();
      return;
    }
    if (!prev) return;
    if (it.type === 'commandExecution') {
      const out = it.aggregatedOutput || '';
      h.emitEvent({ k: 'result', id: it.id, ok: it.status === 'completed' && (it.exitCode ?? 0) === 0, d: cutText(it.status === 'declined' ? 'denied' : out || `(exit ${it.exitCode ?? '?'})`) });
    } else if (it.type === 'fileChange') h.emitEvent({ k: 'result', id: it.id, ok: it.status === 'completed', d: it.status === 'completed' ? `${(it.changes || []).length} file(s) changed` : String(it.status) });
    else if (it.type === 'mcpToolCall') h.emitEvent({ k: 'result', id: it.id, ok: it.status === 'completed' && !it.error, d: cutText(it.error?.message || textFromMcp(it.result)) });
    else if (it.type === 'webSearch') h.emitEvent({ k: 'result', id: it.id, ok: true, d: '' });
  }

  onTurnCompleted(turn) {
    const h = this.host;
    h.flushText();
    const status = turn?.status;
    const ok = status === 'completed';
    const t = this.usageTotal;
    const s0 = this.usageAtStart;
    const d = (k) => (t?.[k] || 0) - (s0?.[k] || 0);
    const usage = t ? { in: d('inputTokens'), out: d('outputTokens'), cr: d('cachedInputTokens'), cw: d('cacheWriteInputTokens') } : undefined;
    h.emitEvent({
      k: 'done',
      ok,
      turns: this.toolCount,
      ms: turn?.durationMs ?? Date.now() - (this.turnStart || Date.now()),
      usage,
      ctx: this.ctxMax && this.lastIn ? Math.round((this.lastIn / this.ctxMax) * 100) : undefined,
      err: ok ? undefined : status === 'interrupted' ? 'interrupted' : cutText(turn?.error?.message || status || 'failed', 600),
    });
    const last = [...(turn?.items || [])].reverse().find((i) => i.type === 'agentMessage')?.text || '';
    h.mgr.notify(h, ok ? `✓ done · ${last.replace(/\s+/g, ' ').slice(0, 140)}` : `✗ stopped · ${String(turn?.error?.message || status).slice(0, 140)}`);
    this.streamed.clear();
    this.turnId = null;
    if (h.turn?.agent === this) h.endTurn();
    if (!this.dead) h.idleAgent(this);
  }

  // ---------- requests from Codex (permissions, questions) ----------
  async onRequest(m) {
    const { id, method, params: p } = m;
    const answer = (result) => this.rpc.respond(id, result);
    try {
      if (method === 'item/commandExecution/requestApproval') {
        const command = unwrapCommand(p.command || p.commandActions?.map((a) => a.command).join(' && ') || '');
        return answer({ decision: await this.host.decideCodex('command', { command, actions: p.commandActions, reason: p.reason, amendment: p.proposedExecpolicyAmendment }) });
      }
      if (method === 'item/fileChange/requestApproval') {
        const it = this.items.get(p.itemId);
        return answer({ decision: await this.host.decideCodex('file', { changes: it?.changes || [], reason: p.reason, grantRoot: p.grantRoot }) });
      }
      if (method === 'item/tool/requestUserInput') {
        const answers = await this.host.decideCodex('question', { questions: p.questions || [] });
        return answer({ answers });
      }
      if (method === 'item/permissions/requestApproval') {
        const ok = await this.host.decideCodex('permissions', { reason: p.reason, permissions: p.permissions });
        return answer(ok ? { permissions: { ...(p.permissions?.network ? { network: p.permissions.network } : {}), ...(p.permissions?.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}) }, scope: 'turn' } : { permissions: {}, scope: 'turn' });
      }
      // snugcode MCP tools enforce their own permissions (see mcp-bridge.js).
      if (method === 'mcpServer/elicitation/request') return answer({ action: p.serverName === 'snugcode' ? 'accept' : 'decline', content: null, _meta: null });
      // Old protocol version.
      if (method === 'execCommandApproval') return answer({ decision: (await this.host.decideCodex('command', { command: unwrapCommand([].concat(p.command || []).join(' ')) })) === 'decline' ? 'denied' : 'approved' });
      if (method === 'applyPatchApproval') return answer({ decision: (await this.host.decideCodex('file', { changes: Object.keys(p.fileChanges || {}).map((f) => ({ path: f })) })) === 'decline' ? 'denied' : 'approved' });
      this.rpc.send({ id, error: { code: -32601, message: 'snugcode does not support ' + method } });
    } catch (e) {
      this.rpc.send({ id, error: { code: -32000, message: String(e?.message || e) } });
    }
  }
}

function rel(p, cwd) {
  const r = path.relative(cwd, String(p || ''));
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : String(p || '');
}

const cutText = (s, n = 4000) => {
  s = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} characters cut)` : s;
};

function diffDetail(changes) {
  const diff = (changes || []).map((c) => c.diff || '').join('\n').slice(0, 3000);
  return diff ? { new: diff } : undefined;
}

function summarizeArgs(a) {
  if (!a || typeof a !== 'object') return String(a ?? '');
  return String(a.command || a.url || a.path || a.name || a.query || JSON.stringify(a)).slice(0, 400);
}

function textFromMcp(r) {
  const c = r?.content;
  if (Array.isArray(c)) return c.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n');
  return typeof r === 'string' ? r : JSON.stringify(r ?? '');
}
