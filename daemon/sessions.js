// Agent sessions: run the agent harness that best fits the session's model — the Claude Agent SDK
// (Claude models & Anthropic/OpenAI format endpoints) or Codex (GPT models: ChatGPT login / Responses
// API) — turn its messages into compact events for the phone, and store their history. Permissions,
// checkpoints, and snugcode dev tools are the same for both engines.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SESSIONS_DIR, CLAUDE_DIR, WORKSPACES, SESSION_INDEX, writeJson, readSessionIndex } from './config.js';
import { prepareWorktree, removeWorktree, inspectLocalRepo, currentBranch, repoDirName } from './github.js';
import { startProxy } from './proxy.js';
import { resolveRoute, authHeaders, geminiRoot, knownRefs, allConnections, getConn } from './providers.js';
import { todosFromInput, todoText } from '../shared/events.js';
import { permRisk, autonomyOf, autonomyFlags, AUTONOMY } from '../shared/risk.js';
import { PLANS_DIR, isInside, isSensitivePath, isProtectedRepoPath, SECRET_CMD_RE, toolPaths, isLocalUrl, isRemoteWrite, escapesSandbox, neverAlways, suggestedRules, ruleText, ruleMatches } from './permissions.js';
import { AGENT_TOOLS, widenToolInput, isClaudeModel, startClaudeAgent } from './engine-claude.js';
import { startCodexAgent, decideCodex } from './engine-codex.js';
import { startGeminiAgent, decideGemini } from './engine-gemini.js';
import { cleanupWorkspaces, safeRm } from './cleaner.js';
import { ProcManager } from './procs.js';
import { shellSpawn, toolchainEnv } from './toolchain.js';
import { openTunnel } from './tunnel.js';
import { snapshot, rewind } from './checkpoint.js';
import { restoreEnv, detectProject } from './project.js';
import { SAFE_DEV_TOOLS, DEV_START, SCREENSHOT } from './devtools.js';
import { closeBrowser } from './browser.js';

const OUT_LIMIT = 4000;

export { isSensitivePath, toolPaths, isRemoteWrite, suggestedRules, ruleMatches, AGENT_TOOLS, widenToolInput };

// The claude process stays alive between prompts (streaming input): the next prompt is processed
// right away without re-spawning + resuming the transcript. It's killed after idling this long, and
// at most MAX_IDLE_AGENTS idle processes are kept alive at once (saves RAM).
const AGENT_IDLE_MS = 5 * 60 * 1000;
const MAX_IDLE_AGENTS = 3;
// History of sessions nobody has open is released from memory after this long.
const HISTORY_IDLE_MS = 30 * 60 * 1000;
// When loading history from .jsonl, only its tail is read (older parts stay in the file).
const LOAD_TAIL_BYTES = 8 * 1024 * 1024;

// Tools that never need permission in this session. Read tools (Read/Glob/Grep/LS) only pass without
// asking when their target is inside the worktree; WebFetch isn't included because it could be used
// to send file contents out (prompt injection from a README/issue).
const SAFE_TOOLS = new Set(['TodoWrite', 'Task', 'Agent', 'WebSearch', 'ToolSearch', 'BashOutput', ...SAFE_DEV_TOOLS]);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_TOOLS = new Set([...READ_TOOLS, ...EDIT_TOOLS]);

// Images from the phone (camera/gallery/paste), already compressed phone-side to fit one relay frame (~1MB).
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
function checkImages(images) {
  if (!Array.isArray(images) || !images.length) return [];
  if (images.length > 4) throw new Error('At most 4 images per message');
  if (images.some((i) => !IMAGE_TYPES.has(i?.mime) || typeof i.data !== 'string')) throw new Error('Unsupported image format');
  if (images.reduce((n, i) => n + i.data.length, 0) > 700_000) throw new Error('Images too large');
  return images.map((i) => ({ mime: i.mime, data: i.data }));
}

// History events kept in memory per session; older ones remain in the .jsonl file.
const MEM_EVENTS = 3000;

function cut(s, n = OUT_LIMIT) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} characters cut)` : s;
}

// "mcp__snugcode__dev_start" -> "dev_start" (other MCP tools: "server:tool").
const shortName = (n) => (n.startsWith('mcp__') ? n.replace(/^mcp__snugcode__/, '').replace(/^mcp__([^_]+(?:_[^_]+)*?)__/, '$1:') : n);

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

// Tool input summary that fits a phone screen (paths made relative to the worktree).
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
    case DEV_START:
      return input.command;
    case 'mcp__snugcode__preview_screenshot':
      return input.url || input.path || '/';
    case 'mcp__snugcode__dev_stop':
    case 'mcp__snugcode__dev_logs':
      return input.name;
    case 'mcp__snugcode__dev_list':
      return '';
    case 'AskUserQuestion':
      return (input.questions || []).map((q) => q.question).join('\n');
    case 'ExitPlanMode':
      return input.plan;
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
      return todoText(todosFromInput(input.todos));
    default:
      return cut(input, 400);
  }
}

// For Edit/Write: send a snippet of the change so it can be shown as a mini diff.
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
    this._history = null; // loaded from .jsonl when first needed
    this.trimmed = false;
    this._lastSeq = 0;
    this.status = 'idle';
    this.agent = null; // the live claude process (see ensureAgent)
    this.turn = null; // the prompt in progress: { resolve, agent }
    this.cpReady = null; // the running prompt checkpoint; file-changing tools wait for it
    this.perms = new Map(); // pid -> { resolve, tool, input }
    // "Always allow" is stored in meta so it still applies after a daemon restart.
    this.alwaysAllow = new Set(meta.alwaysAllow || []);
    // Permission rules per command pattern ("Bash(npm test *)"), passed to Claude Code.
    this.allowRules = new Set(meta.allowRules || []);
    this.textBuf = '';
    this.textTimer = null;
    this.logFile = path.join(SESSIONS_DIR, meta.id + '.jsonl');
    this.logStream = null;
    this.procs = new ProcManager({ cwd: meta.cwd, onChange: (p) => this.onProc(p), onOut: (name, d) => this.live({ k: 'procOut', name, d }) });
    this.tunnel = null;
  }

  // Transient events (process logs, screenshots, preview status): straight to clients, not into history,
  // so they don't push the conversation out of memory or bloat the .jsonl file.
  live(e) {
    this.emit('event', e);
  }

  onProc(p) {
    this.live({ k: 'proc', ...p });
    if (p.status !== 'exited') return;
    if (this.tunnel?.name === p.name) this.closeTunnel();
    if (!p.killed && p.code !== 0) this.mgr.notify(this, `✗ ${p.name} stopped (exit ${p.code})`, { minor: true });
  }

  // Prepare dependencies if needed (the "setup" process), then run the dev server.
  async runDev(cmd) {
    const det = detectProject(this.meta.cwd);
    const dev = String(cmd || '').trim() || det.dev;
    if (!dev) throw new Error('No dev command detected. Enter the command, e.g. "npm run dev", or add .snugcode.json { "dev": "..." }.');
    if (!cmd && det.setup && this.procs.procs.get('setup')?.status !== 'running') {
      await this.procs.start(det.setup, 'setup');
      this.procs.get('setup').done.then((code) => code === 0 && this.procs.start(dev).catch((e) => this.emitEvent({ k: 'error', d: e.message })));
      return { setup: det.setup, dev };
    }
    await this.procs.start(dev);
    return { dev };
  }

  async preview(name) {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const port = await this.procs.waitPort(name, 60000);
      if (!port) throw new Error(`Port for "${name}" not detected yet. Check the process log.`);
      const t = this.tunnel;
      if (t?.port === port && t.name === name) return this.previewInfo();
      if (t) {
        // An existing tunnel just gets pointed at the new port: the phone's URL & cookie stay valid,
        // without waiting for cloudflared + DNS of a new subdomain (5–15 seconds).
        t.retarget(port);
        t.name = name;
      } else {
        const nt = await openTunnel(port, { cfg: this.mgr.config, onExit: () => this.tunnel === nt && this.closeTunnel() });
        nt.name = name;
        this.tunnel = nt;
      }
      this.live({ k: 'preview', ...this.previewInfo() });
      return this.previewInfo();
    })().finally(() => (this.opening = null));
    return this.opening;
  }

  previewInfo() {
    const t = this.tunnel;
    return t ? { name: t.name, port: t.port, url: t.url, link: t.link } : null;
  }

  closeTunnel() {
    if (!this.tunnel) return;
    this.tunnel.close();
    this.tunnel = null;
    this.live({ k: 'preview' });
  }

  get id() {
    return this.meta.id;
  }

  get events() {
    if (!this._history) this.load();
    return this._history;
  }

  get seq() {
    if (!this._history) this.load();
    return this._lastSeq;
  }

  // Only the end of the file is read: long histories don't need to be loaded entirely.
  load() {
    this._history = [];
    this.trimmed = false;
    let text;
    try {
      const fd = fs.openSync(this.logFile, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - LOAD_TAIL_BYTES);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
        if (start > 0) {
          text = text.slice(text.indexOf('\n') + 1);
          this.trimmed = true;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        this._history.push(e);
        this._lastSeq = e.seq;
      } catch {}
    }
    this.trim();
  }

  trim() {
    if (this._history.length <= MEM_EVENTS) return;
    this._history.splice(0, this._history.length - MEM_EVENTS);
    this.trimmed = true;
  }

  // Release history from memory (reloaded from the file when needed again).
  unload() {
    if (!this._history || this.logStream?.writableLength) return false;
    this._history = null;
    this.closeLog();
    return true;
  }

  appendLog(e) {
    if (!this.logStream) {
      this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
      this.logStream.on('error', (err) => {
        this.mgr.log('! failed to write session history: ' + err.message);
        this.logStream = null;
      });
    }
    this.logStream.write(JSON.stringify(e) + '\n');
  }

  closeLog() {
    const s = this.logStream;
    this.logStream = null;
    return s ? new Promise((r) => s.end(r)) : Promise.resolve();
  }

  summary() {
    const m = this.meta;
    // In local sessions the user may switch branches from the terminal; read the current one.
    const branch = (m.local && currentBranch(m.cwd)) || m.branch || '-';
    let engine = null;
    try {
      engine = resolveRoute(this.mgr.secrets, m.model).engine;
    } catch {}
    return { id: m.id, repo: m.repo, branch, base: m.base, title: m.title, model: m.model, engine, status: this.status, updatedAt: m.updatedAt, auto: !!m.auto, autoLow: !!m.autoLow, autonomy: autonomyOf(m), spent: m.spentUsd || 0, budget: m.budgetUsd || 0, plan: !!m.plan, askEdits: !!m.askEdits, local: !!m.local, computer: !!m.computer, cwd: m.cwd };
  }

  emitEvent(e, { persist = true } = {}) {
    if (e.k !== 'text') this.flushText();
    if (e.k === 'done') this.account(e);
    const events = this.events;
    e.seq = ++this._lastSeq;
    e.ts = Date.now();
    events.push(e);
    if (events.length > MEM_EVENTS + 500) this.trim();
    if (persist) this.appendLog(e);
    this.emit('event', e);
    return e;
  }

  // Cost: the Agent SDK reports a running total per process (not per turn), and a process resuming a
  // transcript starts from the stored total. Turned into this turn's cost (`cost`) + the session total (`spent`),
  // then compared with the session budget (meta.budgetUsd). Engines without costs (Codex/Gemini) are skipped.
  account(e) {
    if (typeof e.cost !== 'number' || !(e.cost >= 0)) return;
    const m = this.meta;
    const agent = this.agent;
    const prev = agent && agent.lastCost != null ? agent.lastCost : m.costSeen ?? null;
    const delta = prev != null && e.cost >= prev ? e.cost - prev : e.cost;
    if (agent) agent.lastCost = e.cost;
    m.costSeen = e.cost;
    m.spentUsd = Math.round(((m.spentUsd || 0) + delta) * 1e6) / 1e6;
    e.cost = delta || undefined;
    e.spent = m.spentUsd;
    if (m.budgetUsd > 0) {
      const ratio = m.spentUsd / m.budgetUsd;
      if (ratio >= 1) this.mgr.notify(this, `Session budget of $${m.budgetUsd} reached ($${m.spentUsd.toFixed(2)}). The next prompt is held until the budget is raised.`);
      else if (ratio >= 0.8 && !m.budgetWarned) {
        m.budgetWarned = true;
        this.mgr.notify(this, `Session cost is at ${Math.round(ratio * 100)}% of the $${m.budgetUsd} budget.`);
      }
    }
    this.mgr.saveIndex();
  }

  // Session budget in USD (0 = no limit). Checked before every prompt.
  setBudget(usd) {
    const v = Math.max(0, Math.min(10_000, Number(usd) || 0));
    this.meta.budgetUsd = v || undefined;
    this.meta.budgetWarned = v > 0 && (this.meta.spentUsd || 0) >= v * 0.8;
    this.mgr.saveIndex();
  }

  // Text deltas are collected for ~80ms so we don't send one message per token.
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

  pushThinking(t) {
    if (!t) return;
    const words = t.trim().split(/\s+/).filter(Boolean).length || 1;
    this.thinkingWords = (this.thinkingWords || 0) + words;
    if (!this.thinkingTimer) {
      this.thinkingTimer = setTimeout(() => {
        this.thinkingTimer = null;
        if (this.thinkingWords) this.emitEvent({ k: 'thinking', words: this.thinkingWords }, { persist: false });
      }, 200);
    }
  }

  clearThinking() {
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = null;
    this.thinkingWords = 0;
  }

  setStatus(s) {
    this.status = s;
    this.meta.updatedAt = Date.now();
    this.mgr.saveIndex();
    this.emitEvent({ k: 'status', s }, { persist: false });
  }

  since(seq) {
    const ev = this.events;
    // Events are ordered by seq: find the boundary from the end (usually only a few new events).
    let i = ev.length;
    while (i > 0 && ev[i - 1].seq > seq) i--;
    return ev.slice(i);
  }

  // true if some events after `seq` have already been dropped from memory.
  missingSince(seq) {
    return this.trimmed && (this.events[0]?.seq ?? 0) > seq + 1;
  }

  // Risk context of a single permission request (see shared/risk.js).
  permCtx(tool, input) {
    const cwd = this.meta.cwd;
    const paths = FILE_TOOLS.has(tool) ? toolPaths(tool, input, cwd) : [];
    const write = FILE_TOOLS.has(tool) && !READ_TOOLS.has(tool);
    return {
      push: isRemoteWrite(tool, input),
      secret: (tool === 'Bash' || tool === DEV_START) && SECRET_CMD_RE.test(input?.command || ''),
      escapes: escapesSandbox(tool, input),
      protectedEdit: write && paths.some((p) => isProtectedRepoPath(p, cwd)),
      outside: paths.length > 0 && !paths.every((p) => isInside(p, cwd)),
      computer: !!this.meta.computer,
    };
  }

  permEvent(pid, p) {
    const { tool, input } = p;
    const rules = suggestedRules(tool, p.suggestions);
    const ctx = this.permCtx(tool, input);
    const risk = permRisk(tool, input, ctx);
    // Scope of the "Always" button for display; absent for actions that can never be "Always".
    const always = neverAlways(tool, input) ? undefined : rules.length ? rules.map((r) => r.ruleContent).join(', ') : shortName(tool);
    // A visible safety net: file changes in a repo session's worktree can be undone (per-prompt checkpoint).
    const undo = !this.meta.computer && !ctx.push && !ctx.outside && (EDIT_TOOLS.has(tool) || tool === 'Bash' || tool === DEV_START) ? (EDIT_TOOLS.has(tool) ? 'file' : 'cmd') : undefined;
    return { pid, tool: shortName(tool), s: toolSummary(tool, input, this.meta.cwd), title: p.title, push: ctx.push, plan: tool === 'ExitPlanMode' || undefined, ask: tool === 'AskUserQuestion' ? input.questions : undefined, x: toolDetail(tool, input), always, risk: risk || undefined, undo };
  }

  pendingPerms() {
    return [...this.perms.entries()].map(([pid, p]) => {
      const e = this.permEvent(pid, p);
      return { ...e, summary: e.s };
    });
  }

  async send(text, images) {
    if (this.status === 'running') throw new Error('The agent is still running. Stop it first or wait for it to finish.');
    images = checkImages(images);
    if (text.startsWith('!') && !images.length) return this.shell(text.slice(1).trim());
    if (!text && !images.length) return;
    if (this.meta.budgetUsd > 0 && (this.meta.spentUsd || 0) >= this.meta.budgetUsd)
      throw new Error(`This session's budget ($${this.meta.budgetUsd}) has been reached ($${this.meta.spentUsd.toFixed(2)}). Raise it in the session menu to continue.`);
    // A model without a connection (new runner, connection removed): a clear message before the prompt is recorded.
    resolveRoute(this.mgr.secrets, this.meta.model);
    if (!this.meta.title) this.meta.title = (text || 'image').slice(0, 80);
    const u = this.emitEvent({ k: 'user', d: text, img: images.length || undefined });
    this.run(text, images, u.seq).catch((err) => {
      this.emitEvent({ k: 'error', d: String(err?.message || err) });
      this.endTurn(true);
    });
  }

  // The user changed files directly (editor / reverting a hunk on the phone): recorded in history, and the agent is
  // told on the next prompt so it doesn't edit based on stale contents.
  userChanged(what, note) {
    const line = `[snugcode] The user ${what} outside of this conversation. Re-read affected files before editing them.`;
    this.meta.note = this.meta.note ? this.meta.note + '\n' + line : line;
    this.mgr.saveIndex();
    this.emitEvent({ k: 'note', d: note });
  }

  // Restore every worktree file to its state before prompt `seq` ran.
  async rewindTo(seq) {
    if (this.meta.computer) throw new Error('Checkpoints and rewind are only available for git repository sessions.');
    if (this.status === 'running') throw new Error('Stop the agent before restoring files.');
    const cp = this.events.find((e) => e.k === 'cp' && e.of === seq);
    const u = this.events.find((e) => e.seq === seq);
    if (!cp || !u) throw new Error('There is no checkpoint for this prompt (it\'s too old).');
    const n = await rewind(this.meta.cwd, cp.tree);
    const title = String(u.d || 'image').slice(0, 80);
    // The agent doesn't know files changed outside of it; tell it on the next prompt.
    this.meta.note = `[snugcode] The user restored all files to their state before the prompt "${title}". Every change made after that point is gone. Re-read files before editing them.`;
    this.mgr.saveIndex();
    this.emitEvent({ k: 'note', d: `↺ ${n} file(s) restored to before "${title}"` });
    return n;
  }

  // Review every file edit (Write/Edit) before it's applied. Off (default): edits inside the worktree
  // apply directly, since every prompt has a checkpoint and can be rewound.
  setAskEdits(on) {
    this.meta.askEdits = !!on;
    this.mgr.saveIndex();
  }

  // Autonomy preset (shared/risk.js): one choice replacing the auto-approve + edit review combination.
  setAutonomy(level) {
    if (!AUTONOMY.includes(level)) throw new Error('Unknown autonomy level');
    Object.assign(this.meta, autonomyFlags(level));
    this.mgr.saveIndex();
  }

  setPlan(on) {
    this.meta.plan = !!on;
    this.mgr.saveIndex();
    this.agent?.setPlan?.(on);
    this.live({ k: 'mode', plan: !!on });
  }

  // The claude process for this session: reused across prompts. Model/effort changes are applied
  // directly to the live process (setModel / applyFlagSettings); a new process (resuming the
  // conversation via `resume`) only when the binary, URL, token, or light model changes.
  // Concurrent calls (pre-warm when the session opens + a prompt) share one process.
  async ensureAgent() {
    while (this._ensuring) await this._ensuring.catch(() => {});
    const p = (this._ensuring = this.startAgent());
    try {
      return await p;
    } finally {
      if (this._ensuring === p) this._ensuring = null;
    }
  }

  // Engine per model (engine-claude.js / engine-codex.js / engine-gemini.js); permissions, checkpoints & events stay with the session.
  async startAgent() {
    const route = resolveRoute(this.mgr.secrets, this.meta.model);
    if (route.engine === 'codex') return startCodexAgent(this, route);
    if (route.engine !== 'gemini') return startClaudeAgent(this, route);
    try {
      return await startGeminiAgent(this, route);
    } catch (e) {
      // Gemini CLI can't be installed/run (e.g. npm offline): the same model via the Claude Agent SDK.
      if (!route.conn.formats?.openai && !route.conn.openai) throw e;
      this.mgr.log('! ' + e.message);
      if (!this.warnedGemini) this.emitEvent({ k: 'note', d: `◆ ${e.message.slice(0, 200)} This model runs through the Claude Agent SDK instead.` });
      this.warnedGemini = true;
      return startClaudeAgent(this, { ...route, engine: 'claude', wire: 'openai' });
    }
  }

  // Permission decision for Codex requests (called by CodexAgent), see engine-codex.js.
  decideCodex(kind, p) {
    return decideCodex(this, kind, p);
  }

  // Permission decision for Gemini CLI tool calls (called by GeminiAgent), see engine-gemini.js.
  decideGemini(tc) {
    return decideGemini(this, tc);
  }

  // PreToolUse hook for tools that can change files. Also runs for tools passing via
  // "Always" rules (e.g. Bash(git *)) without going through canUseTool, so two guarantees are kept here:
  // the prompt checkpoint is saved, and pushes / commands touching credentials still ask.
  async beforeTool(h) {
    await this.cpReady;
    const input = /** @type {any} */ (h)?.tool_input;
    if (h && 'tool_name' in h && neverAlways(h.tool_name, input)) return { hookSpecificOutput: { hookEventName: /** @type {const} */ ('PreToolUse'), permissionDecision: /** @type {const} */ ('ask'), permissionDecisionReason: 'snugcode: always needs the user\'s approval' } };
    return {};
  }

  // PreToolUse hook for Read/Grep (see widenToolInput). Claude models already read & search
  // efficiently (and in parallel), so only other models are widened. The model is read on the spot:
  // switching models in a running process doesn't create a new process.
  widenTool(h) {
    if (!h || !('tool_name' in h) || isClaudeModel(this.meta.model)) return {};
    const updatedInput = widenToolInput(h.tool_name, /** @type {any} */ (h.tool_input), this.meta.cwd);
    return updatedInput ? { hookSpecificOutput: { hookEventName: /** @type {const} */ ('PreToolUse'), updatedInput } } : {};
  }

  // Session opened (phone/terminal): prepare the claude process in the background, so the first prompt doesn't
  // wait for spawn + transcript resume. Closed again if it stays idle (AGENT_IDLE_MS).
  warm() {
    if (this.agent || this._ensuring || this.status !== 'idle') return;
    this.ensureAgent().then(
      (a) => {
        if (this.turn || a.dead || a.idle) return;
        this.idleAgent(a);
      },
      () => {},
    );
  }

  idleAgent(agent) {
    clearTimeout(agent.idle);
    agent.lastUsed = Date.now();
    agent.idle = setTimeout(() => this.closeAgent(agent), AGENT_IDLE_MS);
    agent.idle.unref?.();
    this.mgr.trimAgents();
  }

  async consume(agent) {
    try {
      for await (const m of agent.q) {
        if (agent.dead) break;
        this.onAgentMessage(agent, m);
      }
    } catch (err) {
      if (!agent.dead && this.turn?.agent === agent) this.emitEvent({ k: 'error', d: String(err?.message || err) });
    } finally {
      agent.dead = true;
      clearTimeout(agent.idle);
      if (this.agent === agent) this.agent = null;
      // Process died mid-prompt (crash / closed): that prompt is finished, the session goes back to idle.
      // Prompts belonging to another process (e.g. a new one after switching models) aren't touched.
      if (this.turn?.agent === agent) this.endTurn();
    }
  }

  onAgentMessage(agent, m) {
    // The agent may start a turn on its own (e.g. a background task completion notification).
    if (!this.turn && (m.type === 'assistant' || m.type === 'stream_event') && !m.parent_tool_use_id) {
      this.turn = { resolve() {}, agent };
      this.setStatus('running');
    }
    if (m.type === 'system' && m.subtype === 'init') {
      if (this.meta.claudeSessionId !== m.session_id) {
        this.meta.claudeSessionId = m.session_id;
        this.mgr.saveIndex();
      }
    } else if (m.type === 'system' && m.subtype === 'api_retry') {
      this.emitEvent({ k: 'retry', attempt: m.attempt, max: m.max_retries, status: m.error_status });
    } else if (m.type === 'stream_event') {
      const ev = m.event;
      if (ev.type === 'message_start') {
        agent.currentMsgId = ev.message?.id;
        // Context usage = input tokens of the last request (including cache), for the context indicator.
        const u = ev.message?.usage;
        if (u && !m.parent_tool_use_id) this.lastCtx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        this.clearThinking();
        this.flushText();
        this.emitEvent({ k: 'toolStart', name: shortName(ev.content_block.name) }, { persist: false });
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
        this.pushThinking(ev.delta.thinking);
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        this.clearThinking();
        agent.streamed.add(agent.currentMsgId);
        this.pushText(ev.delta.text);
      } else if (ev.type === 'content_block_stop') {
        this.clearThinking();
        this.flushText();
      }
    } else if (m.type === 'assistant') {
      if (m.parent_tool_use_id) return; // subagent internals aren't shown in detail
      for (const b of m.message.content || []) {
        if (b.type === 'text' && !agent.streamed.has(m.message.id) && b.text) this.emitEvent({ k: 'text', d: b.text });
        if (b.type === 'tool_use') this.emitEvent({ k: 'tool', id: b.id, name: shortName(b.name), s: toolSummary(b.name, b.input, this.meta.cwd), x: toolDetail(b.name, b.input), todos: b.name === 'TodoWrite' ? todosFromInput(b.input?.todos) : undefined });
      }
    } else if (m.type === 'user' && !m.parent_tool_use_id) {
      const content = m.message?.content;
      if (Array.isArray(content))
        for (const b of content) {
          if (b.type === 'tool_result') this.emitEvent({ k: 'result', id: b.tool_use_id, ok: !b.is_error, d: cut(toolResultText(b.content)) });
        }
    } else if (m.type === 'result') {
      this.flushText();
      const u = m.usage;
      // modelUsage also includes small models (subagents/utility); take the main model's.
      const ctxMax = m.modelUsage?.[agent.model]?.contextWindow;
      const ok = m.subtype === 'success' && !m.is_error;
      this.emitEvent({
        k: 'done',
        ok,
        turns: m.num_turns,
        ms: m.duration_ms,
        // cr/cw: input tokens read from / written to the prompt cache (cr ≈ 0 constantly = the router doesn't cache).
        usage: u ? { in: u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 } : undefined,
        cost: m.total_cost_usd || undefined,
        ctx: ctxMax && this.lastCtx ? Math.round((this.lastCtx / ctxMax) * 100) : undefined,
        err: m.subtype !== 'success' ? m.subtype : m.is_error ? cut(m.result || '', 600) : undefined,
      });
      this.mgr.notify(this, ok ? `✓ done · ${String(m.result || '').replace(/\s+/g, ' ').slice(0, 140)}` : `✗ stopped · ${String(m.result || m.subtype).slice(0, 140)}`);
      agent.streamed.clear();
      if (this.turn?.agent === agent) this.endTurn();
      if (!agent.dead) this.idleAgent(agent);
    }
  }

  // End the running prompt: pending permissions are denied, the status goes back to idle.
  endTurn(force = false) {
    this.clearThinking();
    this.flushText();
    for (const p of this.perms.values()) p.resolve({ behavior: 'deny', message: 'Session stopped' });
    this.perms.clear();
    const t = this.turn;
    this.turn = null;
    if (t || (force && this.status === 'running')) this.setStatus('idle');
    t?.resolve();
  }

  closeAgent(agent = this.agent) {
    if (!agent) return;
    agent.dead = true;
    clearTimeout(agent.idle);
    agent.close();
    if (this.agent === agent) this.agent = null;
    if (this.turn?.agent === agent) this.endTurn();
  }

  async run(prompt, images = [], userSeq) {
    this.setStatus('running');
    this.turn = { resolve() {} };
    // The checkpoint runs in parallel with the agent's start-up; file-changing tools wait for
    // this checkpoint to finish (askPermission), so rewind still gets the state before the prompt.
    if (userSeq && !this.meta.computer)
      this.cpReady = snapshot(this.meta.cwd).then(
        (tree) => tree && this.emitEvent({ k: 'cp', of: userSeq, tree }),
        (e) => this.mgr.log('! checkpoint failed: ' + e.message),
      );
    if (this.meta.note) {
      prompt = this.meta.note + '\n\n' + prompt;
      delete this.meta.note;
      this.mgr.saveIndex();
    }
    const agent = await this.ensureAgent();
    const done = new Promise((resolve) => (this.turn = { resolve, agent }));
    // Codex/Gemini CLI have no "wait before tool" hook: the checkpoint must finish before the turn starts.
    if ((agent.kind === 'codex' || agent.kind === 'gemini') && this.cpReady) await this.cpReady;
    await agent.push({ text: prompt, images });
    return done;
  }

  // Multiple-choice questions (AskUserQuestion) and plan approval (ExitPlanMode) always
  // wait for the user, even with auto-approve on.
  /** @returns {Promise<import('@anthropic-ai/claude-agent-sdk').PermissionResult>} */
  async askPermission(tool, input, opts) {
    const cwd = this.meta.cwd;
    const allow = { behavior: /** @type {const} */ ('allow'), updatedInput: input };
    const paths = FILE_TOOLS.has(tool) ? toolPaths(tool, input, cwd) : [];
    const write = FILE_TOOLS.has(tool) && !READ_TOOLS.has(tool);
    if (paths.some((p) => isSensitivePath(p, { write }))) return { behavior: 'deny', message: 'The snugcode data folder holds credentials and may not be accessed by the agent.' };
    const isPush = isRemoteWrite(tool, input);
    const secretCmd = (tool === 'Bash' || tool === DEV_START) && SECRET_CMD_RE.test(input?.command || '');
    const shotUrl = tool === SCREENSHOT ? input?.url : null;
    const shotFile = shotUrl && !/^https?:/i.test(shotUrl);
    // Tool config in the repo (.claude/, .codex/, .mcp.json, .git/) and commands outside the sandbox always ask.
    const protectedEdit = write && paths.some((p) => isProtectedRepoPath(p, cwd));
    const needsUser = isPush || secretCmd || shotFile || protectedEdit || escapesSandbox(tool, input) || tool === 'AskUserQuestion' || tool === 'ExitPlanMode';
    // Plan mode: the agent writes its plan draft to Claude's plans folder (not the worktree).
    const planFile = this.meta.plan && ['Write', 'Edit'].includes(tool) && path.resolve(String(input?.file_path || '')).startsWith(PLANS_DIR + path.sep);
    const readInside = READ_TOOLS.has(tool) && (this.meta.computer || paths.every((p) => isInside(p, cwd) || isInside(p, CLAUDE_DIR)));
    const safe = (SAFE_TOOLS.has(tool) && !(shotUrl && !isLocalUrl(shotUrl))) || readInside;
    // Edits inside the worktree apply directly (can be rewound), except in edit review / plan mode.
    const editInside = EDIT_TOOLS.has(tool) && paths.length > 0 && (this.meta.computer || paths.every((p) => isInside(p, cwd))) && !this.meta.askEdits && !this.meta.plan;
    // File-changing tools only run once this prompt's checkpoint is saved.
    if (!safe && this.cpReady) await this.cpReady;
    // Auto-approve for Bash only if this agent process really runs with a sandbox (or sandboxing isn't supported).
    const auto = this.meta.auto && !(tool === 'Bash' && this.agent?.unsandboxedAuto);
    if (!needsUser && (planFile || safe || editInside || auto || this.alwaysAllow.has(tool))) return allow;
    // The "Routine commands automatic" preset: test/lint/build without command chains pass without asking.
    if (!needsUser && this.meta.autoLow && !this.meta.plan && (tool === 'Bash' || tool === DEV_START) && permRisk(tool, input, this.permCtx(tool, input))?.level === 'low') return allow;
    return this.requestUser(tool, input, opts);
  }

  // Ask the user (permission card on the phone/terminal + notification) and wait for the answer.
  /** @returns {Promise<import('@anthropic-ai/claude-agent-sdk').PermissionResult>} */
  requestUser(tool, input, opts) {
    const pid = randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      const p = { resolve, tool, input, title: opts?.title, suggestions: opts?.suggestions };
      this.perms.set(pid, p);
      this.live({ k: 'perm', ...this.permEvent(pid, p) });
      // The notification has enough to decide from the lock screen; low/medium risk can be answered right
      // from the notification buttons (sw.js), high risk always opens the app.
      const e = this.permEvent(pid, p);
      const what = tool === 'AskUserQuestion' ? 'The agent has a question' : tool === 'ExitPlanMode' ? 'Plan ready for review' : `Needs permission for ${e.tool}: ${String(e.s || '').split('\n')[0].slice(0, 120)}`;
      this.mgr.notify(this, what, { perm: true, pid: e.risk && e.risk.level !== 'high' && !e.push ? pid : undefined, risk: e.risk?.level });
      opts?.signal?.addEventListener('abort', () => {
        if (this.perms.delete(pid)) resolve({ behavior: 'deny', message: 'cancelled' });
      });
    });
  }

  // decision: 'allow' | 'always' | 'deny'. `answers` (AskUserQuestion: question → answer)
  // and `message` (deny reason / plan revision) are optional.
  /** @param {string} pid @param {'allow' | 'always' | 'deny'} decision @param {{ answers?: Record<string, string>, message?: string }} [extra] */
  answerPermission(pid, decision, { answers, message } = {}) {
    const p = this.perms.get(pid);
    if (!p) return false;
    this.perms.delete(pid);
    let updatedPermissions;
    if (decision === 'always' && !neverAlways(p.tool, p.input)) {
      const rules = suggestedRules(p.tool, p.suggestions);
      if (rules.length) {
        // Applies right away in the running process (session) and in later processes (settings).
        updatedPermissions = [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }];
        for (const r of rules) this.allowRules.add(ruleText(r));
        this.meta.allowRules = [...this.allowRules];
      } else {
        this.alwaysAllow.add(p.tool);
        this.meta.alwaysAllow = [...this.alwaysAllow];
      }
      this.mgr.saveIndex();
    }
    const allow = decision === 'allow' || decision === 'always';
    let s = toolSummary(p.tool, p.input, this.meta.cwd);
    let input = p.input;
    if (p.tool === 'AskUserQuestion' && allow) {
      input = { ...p.input, answers: Object.fromEntries(Object.entries(answers || {}).map(([k, v]) => [String(k), String(v).slice(0, 2000)])) };
      s = Object.values(input.answers).join(' · ');
    }
    if (p.tool === 'ExitPlanMode') {
      s = allow ? 'plan approved' : 'plan revised';
      if (allow) this.setPlan(false);
    }
    this.emitEvent({ k: 'permAnswer', pid, allow, tool: shortName(p.tool), s });
    const why = String(message || '').trim().slice(0, 4000);
    p.resolve(allow ? { behavior: 'allow', updatedInput: input, ...(updatedPermissions ? { updatedPermissions } : {}) } : { behavior: 'deny', message: why || 'The user denied this action from the phone.' });
    return true;
  }

  async interrupt() {
    if (this.shellProc) this.shellProc.kill();
    const agent = this.agent;
    const turn = this.turn;
    if (!agent || turn?.agent !== agent) return;
    await Promise.resolve(agent.interrupt()).catch(() => {});
    // Normally the agent replies with `result`; if not within 8 seconds, kill its process.
    setTimeout(() => this.turn === turn && this.closeAgent(agent), 8000).unref?.();
  }

  // Fully kill the claude(.exe) process, dev servers, and tunnels, e.g. before updating/deleting a session.
  async close() {
    if (this.shellProc) this.shellProc.kill();
    // Wait (max 3 seconds) until the claude process really exits: on Windows a still-running claude.exe
    // locks the binary (update) and worktree files (session deletion).
    const exited = this.agent?.loop;
    this.closeAgent();
    this.closeTunnel();
    await Promise.all([this.procs.stopAll(), this.closeLog(), exited && Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])]);
  }

  // "!command" -> run directly in the worktree (like ! in Claude Code).
  async shell(cmd) {
    if (!cmd) return;
    this.emitEvent({ k: 'sh', d: cmd });
    this.setStatus('running');
    let env;
    try {
      env = await toolchainEnv(cmd, { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
    } catch (e) {
      this.emitEvent({ k: 'error', d: e.message });
      this.emitEvent({ k: 'shDone', code: 1 });
      return this.setStatus('idle');
    }
    const p = shellSpawn(cmd, { cwd: this.meta.cwd, env });
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

// Rebuild the session list from worktrees on disk if index.json is corrupted: without this, sessions (and
// unpushed work) vanish from the app, and the cleaner would treat them as orphans.
function recoverIndex(defaultModel) {
  const out = [];
  let repos = [];
  try {
    repos = fs.readdirSync(WORKSPACES);
  } catch {
    return out;
  }
  for (const dir of repos) {
    const repoDir = path.join(WORKSPACES, dir);
    let base = '';
    try {
      base = fs.readFileSync(path.join(repoDir, '_base', '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'utf8').trim().replace(/^ref: refs\/remotes\/origin\//, '');
    } catch {}
    let subs = [];
    try {
      subs = fs.readdirSync(repoDir).filter((s) => /^s-[\w-]+$/.test(s));
    } catch {}
    for (const sub of subs) {
      const cwd = path.join(repoDir, sub);
      const id = sub.slice(2);
      let st;
      try {
        st = fs.statSync(cwd);
      } catch {
        continue;
      }
      let title = '';
      try {
        const first = fs.readFileSync(path.join(SESSIONS_DIR, id + '.jsonl'), 'utf8').split('\n').find((l) => l.includes('"k":"user"'));
        if (first) title = String(JSON.parse(first).d || '').slice(0, 80);
      } catch {}
      const branch = currentBranch(cwd) || 'snug/' + id;
      out.push({ id, repo: dir.replace('__', '/'), cwd, branch, base: base || 'main', model: defaultModel, title, createdAt: st.birthtimeMs || st.mtimeMs, updatedAt: st.mtimeMs, auto: false });
    }
  }
  return out;
}

export class SessionManager {
  constructor({ config, secrets, log, notify }) {
    this.config = config;
    this.secrets = secrets;
    this.log = log || (() => {});
    this.notify = notify || (() => {});
    this.sessions = new Map();
    this.busyRepos = new Map(); // repo folder (lowercase) -> number of sessions being created
    try {
      this.proxy = startProxy({ log: (m) => this.log(m) });
    } catch (e) {
      this.log('! failed to start the loopback proxy: ' + e.message);
    }
    this.routeTokens = new Map(); // `${connection}|${format}` -> local proxy token
    this.bridges = new Map(); // MCP bridge token (Codex engine) -> session
    // The model list is fetched in the background: subagent light-model selection reads it from the cache.
    for (const id of Object.keys(allConnections(secrets))) knownRefs(secrets, id);
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const idx = readSessionIndex({ quarantine: true });
    let index = idx.list;
    if (!idx.ok) {
      index = recoverIndex(config.model);
      console.error(`! sessions/index.json is corrupted (kept as index.json.broken-*); ${index.length} session(s) recovered from worktrees.`);
    }
    for (const meta of index) if (meta?.id && meta.cwd && fs.existsSync(meta.cwd)) this.sessions.set(meta.id, new Session(meta, this));
    if (!idx.ok) this.saveIndex();
    // Scan and clean up orphaned folders automatically in the background
    setTimeout(() => this.cleanupOrphans().catch(() => {}), 1500).unref?.();
    this.cleanupTimer = setInterval(() => {
      this.cleanupOrphans().catch(() => {});
      this.unloadIdle();
    }, 30 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  // Sessions' dev servers & tunnels must not be left behind when the daemon stops (on Windows
  // child processes don't die with their parent).
  close() {
    this.proxy?.close();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    return Promise.all([...this.sessions.values()].map((s) => s.close()).concat(closeBrowser()));
  }

  // History of sessions not opened for a while is released from memory.
  unloadIdle(now = Date.now()) {
    for (const s of this.sessions.values()) {
      if (s.status === 'idle' && !s.agent && !s.listenerCount('event') && now - (s.meta.updatedAt || 0) > HISTORY_IDLE_MS) s.unload();
    }
  }

  // Cap the number of idle claude processes: the least recently used are closed first.
  trimAgents() {
    const idle = [...this.sessions.values()].filter((s) => s.agent && !s.turn).sort((a, b) => b.agent.lastUsed - a.agent.lastUsed);
    for (const s of idle.slice(MAX_IDLE_AGENTS)) s.closeAgent();
  }

  async cleanupOrphans(opts) {
    if (this.cleaning) return { removedWorktrees: [], removedRepos: [], removedLogs: [] };
    this.cleaning = true;
    try {
      return await cleanupWorkspaces(this.sessions, { ...opts, busy: (dir) => this.busyRepos.has(dir.toLowerCase()) });
    } finally {
      this.cleaning = false;
    }
  }

  // On Windows a still-running claude.exe locks its file so npm fails to
  // overwrite it (and silently skips the binary package). Close every session first.
  async stopAll({ wait = 1500 } = {}) {
    const active = [...this.sessions.values()].filter((s) => s.agent || s.shellProc || s.procs.running() || s.tunnel);
    for (const s of active) if (s.turn || s.shellProc || s.procs.running()) s.emitEvent({ k: 'note', d: '◆ stopped to install an update' });
    await Promise.all(active.map((s) => s.close()));
    if (active.length) await new Promise((r) => setTimeout(r, wait));
    return active.length;
  }

  // Local proxy token for one connection + format. The address & key are read from secrets on every
  // request, so a key changed from the phone applies immediately without recreating agent processes.
  tokenFor(conn, wire) {
    const k = `${conn.id}|${wire}`;
    let t = this.routeTokens.get(k);
    if (t) return t;
    if (!this.proxy) throw new Error('The snugcode loopback proxy is not running.');
    const id = conn.id;
    const cur = () => getConn(this.secrets, id) || conn;
    t = this.proxy.register({
      wire: /** @type {any} */ (wire),
      base: () => (wire === 'gemini' ? geminiRoot(cur()) : wire === 'anthropic' ? cur().anthropic : cur().openai) || '',
      auth: () => authHeaders(cur(), wire === 'anthropic' || wire === 'gemini' ? wire : 'openai'),
      router: !!(conn.router || conn.kind === 'router'),
      kind: conn.kind,
    });
    this.routeTokens.set(k, t);
    return t;
  }

  // Connection changed/removed from the phone: its old token is revoked, agent processes using it are recreated
  // on the next prompt (their key includes the token).
  resetRouter(connId = 'router') {
    for (const [k, t] of this.routeTokens) {
      if (!k.startsWith(connId + '|')) continue;
      this.proxy?.unregister(t);
      this.routeTokens.delete(k);
    }
    if (getConn(this.secrets, connId)) knownRefs(this.secrets, connId);
  }

  // MCP bridge token: can only call dev tools for one session (see server.js LocalConn).
  bridgeToken(session) {
    for (const [t, s] of this.bridges) if (s === session) return t;
    const t = 'bridge-' + randomBytes(24).toString('hex');
    this.bridges.set(t, session);
    return t;
  }
  bridgeSession(token) {
    return typeof token === 'string' ? this.bridges.get(token) || null : null;
  }

  // Is any work running (agent, `!command`, dev server, or preview tunnel)?
  busy() {
    return [...this.sessions.values()].some((s) => s.status === 'running' || s.shellProc || s.procs.running() || s.tunnel);
  }

  // Atomic: a failed write (e.g. full disk) leaves the old index intact and doesn't break the agent flow.
  saveIndex() {
    try {
      writeJson(SESSION_INDEX, [...this.sessions.values()].map((s) => s.meta), 0o644);
    } catch (e) {
      console.error('! failed to save the session list: ' + e.message);
    }
  }

  list() {
    return [...this.sessions.values()].map((s) => s.summary()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Session not found');
    return s;
  }

  async create({ repo, base, branch, model, local, computer, cwd, type }) {
    if (computer || repo === '__computer__' || type === 'computer') {
      const id = randomBytes(4).toString('hex');
      const targetCwd = path.resolve(cwd || os.homedir());
      const meta = {
        id,
        repo: 'Computer',
        cwd: targetCwd,
        branch: os.hostname() || 'pc',
        base: '-',
        computer: true,
        model: model || this.config.model,
        title: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        auto: false,
      };
      const s = new Session(meta, this);
      this.sessions.set(id, s);
      this.saveIndex();
      return s;
    }
    if (local) {
      // Local folder from the terminal: reuse the existing session for the same folder.
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
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('The repo must be in owner/name format');
    const id = randomBytes(4).toString('hex');
    branch = (branch || '').trim() || 'snug/' + id;
    // While the clone/worktree is being prepared, the cleaner must not touch this repo.
    const busyKey = repoDirName(repo).toLowerCase();
    this.busyRepos.set(busyKey, (this.busyRepos.get(busyKey) || 0) + 1);
    let s;
    try {
      const wt = await prepareWorktree(this.secrets.githubToken, repo, { base: base || undefined, branch, sessionId: id });
      const meta = { id, repo, ...wt, model: model || this.config.model, title: '', createdAt: Date.now(), updatedAt: Date.now(), auto: false };
      s = new Session(meta, this);
      this.sessions.set(id, s);
      this.saveIndex();
    } finally {
      const n = this.busyRepos.get(busyKey) - 1;
      if (n > 0) this.busyRepos.set(busyKey, n);
      else this.busyRepos.delete(busyKey);
    }
    // The repo's .env template (saved from an earlier session) so the dev server can run right away.
    const env = restoreEnv(repo, s.meta.cwd);
    if (env.length) s.emitEvent({ k: 'note', d: `◆ env restored: ${env.join(', ')}` });
    return s;
  }

  async remove(id) {
    const s = this.get(id);
    await s.close();
    for (const [t, x] of this.bridges) if (x === s) this.bridges.delete(t);
    await new Promise((r) => setTimeout(r, 150)); // claude.exe releases the worktree files
    this.sessions.delete(id);
    this.saveIndex();
    try {
      safeRm(s.logFile);
    } catch {}
    // The user's own local folders are never deleted; only their session history.
    if (!s.meta.local && !s.meta.computer) {
      await removeWorktree(s.meta.cwd).catch(() => {});
    }
    // Clean up orphan worktrees / logs (repo base clones are kept for a few days for the next session)
    await this.cleanupOrphans({ minAgeMs: 0 }).catch(() => {});
  }
}
