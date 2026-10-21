// snugcode — terminal UI (like `claude`), connected to the local daemon.
// The same session can be continued on the phone and in the terminal.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { loadSecrets, HOME, IPC_PATH } from './config.js';
import * as M from '../shared/models.js';
import { ENGINE_LABEL } from '../shared/providers.js';
import { EventCursor, doneParts, todoItems, toolActivity } from '../shared/events.js';
import { PAL, c, bold, dim, under, strike, userBg, gradient, cw, width, cols, rowsN, hardWrap, wrapWords, pad, trunc, renderMd } from './term.js';

const out = process.stdout;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');

// ---------- daemon client (named pipe / unix socket) ----------
class Client extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.id = 0;
    this.pending = new Map();
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.err ? p.reject(new Error(m.err)) : p.resolve(m.r);
        } else if (m.ev) this.emit(m.ev, m);
      }
    });
    sock.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Lost connection to the daemon'));
      this.pending.clear();
      this.emit('closed');
    });
    sock.on('error', () => {});
  }
  call(m, p = {}) {
    const id = ++this.id;
    this.sock.write(JSON.stringify({ id, m, p }) + '\n');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

function tryConnect(token) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(IPC_PATH);
    const fail = (e) => (sock.destroy(), reject(e));
    sock.once('error', fail);
    sock.once('connect', () => {
      const cl = new Client(sock);
      const t = setTimeout(() => fail(new Error('daemon not answering')), 4000);
      cl.once('ready', (m) => (clearTimeout(t), sock.off('error', fail), resolve({ client: cl, info: m.info })));
      cl.once('denied', () => (clearTimeout(t), fail(new Error('local token rejected by the daemon'))));
      sock.write(JSON.stringify({ t: 'hello', token }) + '\n');
    });
  });
}

function runningPid() {
  try {
    const pid = +fs.readFileSync(path.join(HOME, 'daemon.pid'), 'utf8');
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

// Stop the daemon cleanly over the local channel (sessions' dev servers & tunnels die too),
// falling back to process.kill for old daemons. Waits until the process has really exited.
export async function stopDaemon(pid = runningPid()) {
  if (!pid) return false;
  let graceful = false;
  try {
    const { client } = await tryConnect(loadSecrets().localToken);
    graceful = await client.call('shutdown');
  } catch {}
  if (!graceful)
    try {
      process.kill(pid);
    } catch {}
  for (let i = 0; i < 60 && runningPid() === pid; i++) await new Promise((r) => setTimeout(r, 100));
  if (runningPid() === pid)
    try {
      process.kill(pid);
    } catch {}
  return true;
}

// Connect to the daemon; start it (or replace an old version without a local channel) if needed.
async function connectDaemon(onStatus) {
  const token = () => loadSecrets().localToken;
  try {
    return await tryConnect(token());
  } catch {}
  const old = runningPid();
  if (old) {
    onStatus('updating the daemon…');
    await stopDaemon(old);
  } else onStatus('starting the daemon…');
  const p = spawn(process.execPath, [CLI, 'start', '--log'], { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      return await tryConnect(token());
    } catch {}
  }
  throw new Error('The daemon could not be started. Check the log: ' + path.join(HOME, 'daemon.log'));
}

// ---------- clipboard & browser (for the GitHub login code) ----------
export function copyClipboard(text) {
  const tries = process.platform === 'win32' ? [['clip']] : process.platform === 'darwin' ? [['pbcopy']] : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '-b']];
  for (const [cmd, ...a] of tries) {
    try {
      execFileSync(cmd, a, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } catch {}
  }
  return false;
}
export function openUrl(url) {
  const p =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
}
// An easy-to-read & copy login code box.
function ghCodeBox(p, copied, { title = 'GitHub login', done = 'press Authorize — done, no restart needed' } = {}) {
  const W = Math.min(cols() - 1, 64);
  const row = (l = '') => c.line('│ ') + pad(trunc(l, W - 4), W - 4) + c.line(' │');
  const code = [...p.code].join(' ');
  const center = (s) => ' '.repeat(Math.max(0, Math.floor((W - 4 - width(s)) / 2))) + s;
  return [
    '',
    c.line('╭─ ') + bold(title) + c.line(' ' + '─'.repeat(Math.max(0, W - 5 - title.length)) + '╮'),
    row(),
    row(center(bold(gradient(code, PAL.green, PAL.cyan)))),
    row(),
    row(`1. open ${under(c.blue(p.uri))}`),
    row(`2. enter the code above${copied ? dim(' (copied to clipboard)') : ''}`),
    row('3. ' + done),
    row(),
    c.line('╰' + '─'.repeat(W - 2) + '╯'),
  ];
}

// `snugcode login` while the daemon runs: sign in through the daemon (no restart).
export async function loginViaDaemon({ openBrowser = true } = {}) {
  const { client } = await tryConnect(loadSecrets().localToken);
  try {
    const st = await client.call('githubLogin');
    if (!st.pending) throw new Error('Failed to start GitHub login');
    const copied = copyClipboard(st.pending.code);
    console.log(ghCodeBox(st.pending, copied).join('\n'));
    if (openBrowser) openUrl(st.pending.uri);
    console.log(dim('  waiting for authorization… (Ctrl+C to cancel)'));
    const res = await new Promise((resolve, reject) => {
      client.on('github', (m) => {
        if (m.state === 'ok' && !m.pending) resolve(m);
        else if (m.pending?.error) reject(new Error(m.pending.error));
      });
      client.on('closed', () => reject(new Error('Lost connection to the daemon')));
    });
    console.log(c.green(`✓ GitHub connected: @${res.login}`) + dim(' — used right away by the daemon, phone, and terminal.'));
  } finally {
    client.sock.end();
  }
}

// One RPC to the running daemon (CLI commands like `snugcode connect`).
export async function daemonCall(method, params = {}) {
  const { client } = await tryConnect(loadSecrets().localToken);
  try {
    return await client.call(method, params);
  } finally {
    client.sock.end();
  }
}

// ChatGPT login through the daemon (official Codex), the code shows in the terminal; can be completed from the phone.
export async function chatgptLoginViaDaemon({ openBrowser = true } = {}) {
  const { client } = await tryConnect(loadSecrets().localToken);
  try {
    console.log(dim('  preparing Codex & requesting a login code… (first time ~1–2 min)'));
    const r = await client.call('chatgptLogin');
    const copied = copyClipboard(r.code);
    console.log(ghCodeBox({ code: r.code, uri: r.url }, copied, { title: 'ChatGPT login', done: 'sign in with your ChatGPT account — done' }).join('\n'));
    if (openBrowser) openUrl(r.url);
    console.log(dim('  waiting for ChatGPT login… (Ctrl+C to cancel)'));
    const res = await new Promise((resolve, reject) => {
      client.on('chatgpt', (m) => (m.ok ? resolve(m) : reject(new Error(m.err || 'ChatGPT login failed'))));
      client.on('closed', () => reject(new Error('Lost connection to the daemon')));
    });
    console.log(c.green('✓ ChatGPT connected') + dim(' — GPT models run in the Codex harness.'));
    return res;
  } finally {
    client.sock.end();
  }
}

// ---------- display utilities ----------
// The snugcode mascot at work: blinks while "typing" (fixed width of 8 columns).
const SPIN = ['(ᵔᴗᵔ)   ', '(ᵔᴗᵔ).  ', '(ᵔᴗᵔ).. ', '(ᵔᴗᵔ)...', '(-ᴗ-)...', '(ᵔᴗᵔ)   '];
const LOGO = '(˘ᵕ˘)ᶻ';
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
};
const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd';
};
const tildify = (p) => {
  const home = os.homedir();
  return p.toLowerCase().startsWith(home.toLowerCase()) ? '~' + p.slice(home.length).replace(/\\/g, '/') : p;
};
function modelLabel(id) {
  if (!id) return '—';
  const p = M.parseModelId(id);
  return p.base + (p.effort ? ' · ' + (M.EFFORT_LABEL[p.effort] || p.effort) : '');
}

const PLAN_REVISE = 'The user wants to revise the plan. Stop now and wait for their revision instructions.';

const COMMANDS = [
  ['/help', 'help & keyboard shortcuts'],
  ['/model', 'change this session\'s model & effort'],
  ['/default', 'default model for new sessions'],
  ['/sessions', 'switch sessions (including sessions from the phone)'],
  ['/computer', 'computer mode session (control the whole PC)'],
  ['/new', 'new session from a GitHub repo'],
  ['/run', 'run a dev server in the background [command]'],
  ['/ps', 'list background processes'],
  ['/logs', 'process logs [name]'],
  ['/stop', 'stop a process [name]'],
  ['/preview', 'preview link for a phone/other laptop [name]'],
  ['/plan', 'plan mode: the agent drafts a plan first'],
  ['/rewind', 'restore files to before the last prompt'],
  ['/git', 'git status'],
  ['/diff', 'show the diff'],
  ['/commit', 'commit all changes [message]'],
  ['/push', 'push the branch to GitHub'],
  ['/pr', 'create a Pull Request [title]'],
  ['/auto', 'toggle auto-approve'],
  ['/edits', 'review every file edit before it\'s applied (on/off)'],
  ['/autonomy', 'agent autonomy: ask | balanced | routine | full'],
  ['/login', 'sign in to GitHub again (push, PR, repos)'],
  ['/update', 'check & install remote updates'],
  ['/clean', 'scan & clean up orphaned worktrees / repos'],
  ['/restart', 'restart the daemon on the PC'],
  ['/clear', 'clear the screen'],
  ['/delete', 'delete this session'],
  ['/exit', 'exit (the session keeps running on the PC)'],
];

// ---------- app ----------
class App {
  constructor(client, info, opts) {
    this.cl = client;
    this.info = info;
    this.opts = opts;
    this.session = null;
    this.input = '';
    this.cursor = 0;
    this.evCursor = new EventCursor(); // seq of the last session event already shown
    /** @type {Set<string> | null} */
    this.procPorts = null; // processes whose port was already announced
    this.mode = 'chat'; // chat | shell
    this.history = [];
    this.histIdx = -1;
    this.sugIdx = 0;
    this.overlay = null; // { type: 'perm'|'select'|'confirm', ... }
    this.running = false;
    this.runStart = 0;
    this.activity = '';
    this.perms = [];
    this.queue = []; // pending items not yet printed (order preserved)
    this.tools = new Map();
    this.liveRows = 0;
    this.liveCursorRow = 0;
    this.flash = null;
    this.exitArmed = 0;
    this.lastOutput = null;
    this.git = null;
    this.frame = 0;
    this.pasting = false;
  }

  // ---- live area at the bottom ----
  clearLive() {
    let s = '';
    if (this.liveRows) {
      if (this.liveCursorRow > 0) s += `\x1b[${this.liveCursorRow}A`;
      s += '\r\x1b[J';
    }
    this.liveRows = 0;
    this.liveCursorRow = 0;
    return s;
  }
  // Print to the scrollback above the live area.
  /** @param {string | string[]} [text] */
  print(text = '') {
    const lines = Array.isArray(text) ? text : String(text).split('\n');
    out.write('\x1b[?25l' + this.clearLive() + lines.join('\n') + '\n');
    this.scheduleRender();
  }
  scheduleRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    setImmediate(() => {
      this.renderPending = false;
      this.render();
    });
  }
  render() {
    if (this.closed) return;
    const W = cols();
    const lines = [];
    let cursor = null;

    // Preview of items still in progress (streaming text, tools waiting for results).
    const pre = [];
    for (const it of this.queue) pre.push(...it.preview(W));
    const maxPre = Math.max(3, rowsN() - 12);
    if (pre.length > maxPre) lines.push(dim(`  … ${pre.length - maxPre} lines above`), ...pre.slice(-maxPre));
    else lines.push(...pre);

    for (const q of this.queued || []) lines.push(trunc(dim('  ⏳ queued: ') + c.soft(q.replace(/\n/g, ' ↵ ')), W - 1));
    if (this.running || this.busyText) {
      const g = SPIN[this.frame % SPIN.length];
      const act = this.perms.length ? 'Waiting for your permission' : this.busyText || this.activity || 'Thinking';
      const meta = this.running ? `(${fmtDur(Date.now() - this.runStart)} · ${bold('esc')} to stop)` : '';
      lines.push('');
      lines.push(...hardWrap(`${gradient(g, PAL.peach, PAL.clay)} ${c.clay(trunc(act, W - 34))}${c.clay('…')} ${dim(meta)}`, W - 1));
    }
    lines.push('');

    if (this.overlay) {
      const o = this.renderOverlay(W);
      lines.push(...o.lines);
      if (o.cursor) cursor = { row: lines.length - o.lines.length + o.cursor.row, col: o.cursor.col };
    } else {
      const box = this.renderInput(W);
      cursor = { row: lines.length + box.cursor.row, col: box.cursor.col };
      lines.push(...box.lines);
      lines.push(...this.renderStatus(W));
      lines.push(...this.renderSuggestions(W));
    }

    let s = '\x1b[?25l' + this.clearLive() + lines.join('\n');
    this.liveRows = lines.length;
    this.liveCursorRow = lines.length - 1;
    if (cursor) {
      const up = lines.length - 1 - cursor.row;
      if (up > 0) s += `\x1b[${up}A`;
      s += '\r' + (cursor.col ? `\x1b[${cursor.col}C` : '') + '\x1b[?25h';
      this.liveCursorRow = cursor.row;
    }
    out.write(s);
  }

  renderInput(W) {
    const shell = this.mode === 'shell';
    const bc = shell ? c.pink : this.input.startsWith('/') ? c.cyan : c.line;
    const prompt = shell ? c.pink(bold('! ')) : c.green(bold('❯ '));
    // Every line is at most W-1 columns: a terminal-wide line triggers auto-wrap
    // in some terminals and breaks line/cursor position math.
    const textW = W - 7;
    // Wrap the input text + map the cursor position.
    const rows = [[]];
    let cur = null;
    const chars = [...this.input];
    let col = 0;
    for (let i = 0; i <= chars.length; i++) {
      if (i === this.cursor) cur = { row: rows.length - 1, col };
      if (i === chars.length) break;
      const ch = chars[i];
      if (ch === '\n') {
        rows.push([]);
        col = 0;
        continue;
      }
      const w = cw(ch);
      if (col + w > textW) {
        rows.push([]);
        col = 0;
        if (i === this.cursor) cur = { row: rows.length - 1, col: 0 };
      }
      rows[rows.length - 1].push(ch);
      col += w;
    }
    if (cur && cur.col >= textW) cur = { row: cur.row + 1, col: 0 };
    while (cur && cur.row >= rows.length) rows.push([]);
    const maxRows = Math.max(3, Math.floor(rowsN() / 2));
    let first = 0;
    if (rows.length > maxRows) first = Math.min(Math.max(0, cur.row - maxRows + 1), rows.length - maxRows);
    const view = rows.slice(first, first + maxRows);
    const lines = [bc('╭' + '─'.repeat(W - 3) + '╮')];
    view.forEach((r, i) => {
      const text = r.join('');
      const lead = i === 0 && first === 0 ? prompt : '  ';
      let body = text;
      if (!this.input && i === 0) body = dim(shell ? 'shell command in the session folder…' : 'Ask for something…  (/ commands · ! shell · \\ + enter new line)');
      lines.push(bc('│') + ' ' + lead + pad(trunc(body, textW), textW) + ' ' + bc('│'));
    });
    lines.push(bc('╰' + '─'.repeat(W - 3) + '╯'));
    return { lines, cursor: { row: 1 + (cur.row - first), col: 4 + cur.col } };
  }

  renderStatus(W) {
    const s = this.session;
    const parts = [];
    if (s) {
      parts.push(c.purple('◆ ') + c.soft(modelLabel(s.model)));
      if (s.computer) {
        parts.push(c.cyan('💻 computer ') + c.soft(tildify(s.cwd || '')));
      } else {
        const g = this.git;
        parts.push(c.blue('git ') + c.soft(g?.branch || s.branch) + (g && g.files ? c.yellow(` +${g.files}`) : '') + (g && g.ahead ? c.green(` ↑${g.ahead}`) : ''));
        if (s.local) parts.push(dim(tildify(s.cwd || '')));
        else parts.push(dim(s.repo));
      }
      if (s.auto) parts.push(c.red('⚡ auto-approve'));
      if (['invalid', 'missing'].includes(this.info.githubState)) parts.push(c.red('GitHub: needs /login'));
    }
    let left = '  ' + parts.join(dim('  ·  '));
    let right;
    if (this.flash && Date.now() < this.flash.until) right = this.flash.bad ? c.red(this.flash.text) : c.green(this.flash.text);
    else if (this.exitArmed && Date.now() - this.exitArmed < 2000) right = c.yellow('Ctrl+C again to exit');
    else if (this.mode === 'shell') right = dim('shell mode · backspace to go back');
    else right = dim('? help');
    const room = W - 2 - width(right);
    if (width(left) > room - 2) left = trunc(left, Math.max(10, room - 2));
    return [pad(left, room) + right];
  }

  suggestions() {
    if (this.overlay || this.mode !== 'chat' || !this.input.startsWith('/') || /\s/.test(this.input)) return [];
    const q = this.input.toLowerCase();
    return COMMANDS.filter(([cmd]) => cmd.startsWith(q));
  }
  renderSuggestions(W) {
    const sug = this.suggestions();
    if (!sug.length) return [];
    this.sugIdx = Math.min(this.sugIdx, sug.length - 1);
    return sug.slice(0, 9).map(([cmd, desc], i) => {
      const on = i === this.sugIdx;
      return trunc(`  ${on ? c.cyan('❯ ' + bold(cmd.padEnd(11))) : '  ' + c.soft(cmd.padEnd(11))} ${dim(desc)}`, W - 1);
    });
  }

  renderOverlay(W) {
    const o = this.overlay;
    const bw = Math.min(W - 1, 92);
    const inner = bw - 4;
    const box = (title, body, foot, col = c.line) => {
      const t = title ? ` ${title} ` : '';
      const f = foot ? ` ${foot} ` : '';
      const lines = [col('╭─') + t + col('─'.repeat(Math.max(0, bw - 3 - width(t))) + '╮')];
      for (const b of body) for (const part of hardWrap(b, inner)) lines.push(col('│') + ' ' + pad(part, inner) + ' ' + col('│'));
      lines.push(col('╰─') + dim(f) + col('─'.repeat(Math.max(0, bw - 3 - width(f))) + '╯'));
      return lines;
    };
    if (o.type === 'perm' && o.perm.ask) {
      const q = o.perm.ask[o.qi];
      const body = [c.fg(q.question), ''];
      q.options.forEach((op, i) => {
        const mark = q.multiSelect ? (o.sel[o.qi].has(op.label) ? c.cyan('[x] ') : '[ ] ') : '';
        const line = `${i + 1}. ${mark}${op.label}`;
        body.push(i === o.idx ? c.cyan('❯ ') + bold(line) : '  ' + c.soft(line));
        if (op.description) body.push('     ' + dim(op.description));
      });
      const other = q.options.length;
      body.push(o.idx === other ? c.cyan('❯ ') + bold(`${other + 1}. Other answer: `) + c.fg(o.text[o.qi]) + c.cyan('▏') : c.soft(`  ${other + 1}. Other answer${o.text[o.qi] ? ': ' + o.text[o.qi] : ''}`));
      const count = o.perm.ask.length > 1 ? dim(` (${o.qi + 1}/${o.perm.ask.length})`) : '';
      return { lines: box(bold(c.cyan('The agent has a question')) + (q.header ? ' ' + c.soft(q.header) : '') + count, body, q.multiSelect ? '↑↓ · space select · enter next · esc skip' : '↑↓ · enter · 1-5 · esc skip', c.cyan) };
    }
    if (o.type === 'perm' && o.perm.plan) {
      const body = String(o.perm.summary || o.perm.s || '').split('\n').slice(0, Math.max(6, rowsN() - 14)).map((l) => c.fg(l));
      body.push('', ...['Approve & do it', 'Revise (then type your revision instructions)'].map((t, i) => (i === o.idx ? c.cyan(`❯ ${i + 1}. ${t}`) : c.soft(`  ${i + 1}. ${t}`))));
      return { lines: box(bold(c.cyan('Plan ready — approve?')), body, '↑↓ · enter · 1-2', c.cyan) };
    }
    if (o.type === 'perm') {
      const p = o.perm;
      const opts = p.push ? ['Yes, allow the push', 'No (esc)'] : ['Yes', `Yes, and don't ask again for ${p.always || p.tool} in this session`, 'No (esc)'];
      const body = [];
      if (p.title) body.push(c.soft(p.title), '');
      // Risk level (shared/risk.js): dangerous requests look different from routine ones.
      if (p.risk) body.push(({ high: c.red('▲ high risk'), medium: c.yellow('● medium risk'), low: c.green('○ low risk') })[p.risk.level] + (p.risk.why ? dim(' — ' + p.risk.why) : ''), '');
      for (const l of String(p.summary || p.s || '').split('\n').slice(0, 12)) body.push(c.fg(l));
      if (p.x) {
        const diff = [];
        for (const ed of p.x.edits || [p.x]) {
          if (ed.old) for (const l of ed.old.split('\n')) diff.push(c.red('- ' + l));
          if (ed.new) for (const l of ed.new.split('\n')) diff.push(c.green('+ ' + l));
        }
        body.push('', ...diff.slice(0, 16));
        if (diff.length > 16) body.push(dim(`… ${diff.length - 16} more lines`));
      }
      if (p.undo) body.push('', dim(p.undo === 'file' ? '↺ can be undone with /rewind' : '↺ file changes can be /rewind-ed; effects outside the folder (network, global packages) can\'t'));
      body.push('');
      opts.forEach((t, i) => body.push(i === o.idx ? c.cyan(`❯ ${i + 1}. ${t}`) : c.soft(`  ${i + 1}. ${t}`)));
      if (this.perms.length > 1) body.push('', dim(`+${this.perms.length - 1} more request(s)`));
      return { lines: box(bold(p.push ? c.red('The agent wants to PUSH to GitHub') : c.yellow(`Allow ${p.tool}?`)), body, '↑↓ select · enter · 1-3', p.push ? c.red : c.yellow) };
    }
    if (o.type === 'confirm') {
      const body = [o.text, '', o.idx === 0 ? c.cyan('❯ Yes') + '   ' + c.soft('No') : c.soft('  Yes') + '   ' + c.cyan('❯ No')];
      return { lines: box(bold(o.title), body, '←→ · enter · y/n') };
    }
    if (o.type === 'select') {
      const items = o.filtered();
      const vis = Math.max(3, Math.min(10, rowsN() - 10));
      o.idx = Math.max(0, Math.min(o.idx, items.length - 1));
      const top = Math.max(0, Math.min(o.idx - Math.floor(vis / 2), items.length - vis));
      const body = [];
      if (o.filter !== undefined) body.push(c.cyan('⌕ ') + (o.filter ? c.fg(o.filter) : dim(o.placeholder || 'type to filter…')));
      if (o.loading) body.push(dim('  loading…'));
      else if (!items.length) body.push(dim('  (empty)'));
      for (let i = top; i < Math.min(items.length, top + vis); i++) {
        const it = items[i];
        const on = i === o.idx;
        body.push((on ? c.cyan('❯ ') : '  ') + (on ? bold(c.fg(it.label)) : c.soft(it.label)) + (it.tag ? ' ' + it.tag : ''));
        if (it.sub) body.push('    ' + dim(it.sub));
        if (on && it.extra) body.push(...it.extra());
      }
      if (items.length > vis) body.push(dim(`  ${o.idx + 1}/${items.length}`));
      if (o.note) body.push('', o.note);
      return { lines: box(bold(o.title), body, o.foot || '↑↓ select · enter · esc cancel'), cursor: null };
    }
    return { lines: [] };
  }

  setFlash(text, bad = false, ms = 3000) {
    this.flash = { text, bad, until: Date.now() + ms };
    this.scheduleRender();
    setTimeout(() => this.scheduleRender(), ms + 50);
  }

  // ---- rendering event -> scrollback ----
  userBlock(text, shell) {
    const W = cols();
    const lead = shell ? c.pink(bold(' ! ')) : c.green(bold(' ❯ '));
    const lines = wrapWords(text, W - 4, '', '');
    return ['', ...lines.map((l, i) => userBg(pad((i ? '   ' : lead) + c.fg(l) + ' ', W - 1)))];
  }

  closeText() {
    const last = this.queue[this.queue.length - 1];
    if (last && last.kind === 'text' && !last.done) last.done = true;
  }
  flushQueue() {
    while (this.queue.length && this.queue[0].done) this.print(this.queue.shift().final(cols()));
    this.scheduleRender();
  }

  textItem() {
    const it = {
      kind: 'text',
      src: '',
      done: false,
      final: (W) => ['', ...renderMd(it.src, W - 1, c.fg('● '), '  ')],
      preview: (W) => {
        const lines = renderMd(it.src, W - 1, c.fg('● '), '  ');
        return lines.slice(-8);
      },
    };
    return it;
  }

  toolTitle(e) {
    const first = String(e.s || '').split('\n')[0];
    return bold(e.name) + (first && e.name !== 'TodoWrite' ? c.soft('(' + trunc(first, cols() - e.name.length - 12) + ')') : '');
  }

  toolItem(e) {
    const it = {
      kind: 'tool',
      e,
      done: false,
      result: null,
      // Blinking dot while the tool runs.
      preview: (W) => [trunc(`${Math.floor(this.frame / 4) % 2 ? c.gray('●') : c.fg('●')} ${this.toolTitle(e)}`, W - 1)],
      final: (W) => this.toolFinal(it, W),
    };
    return it;
  }

  toolFinal(it, W) {
    const { e, result } = it;
    const ok = !result || result.ok;
    const head = `${ok ? c.green('●') : c.red('●')} ${this.toolTitle(e)}`;
    const L = ['', trunc(head, W - 1)];
    const branch = (lines, first = true) => lines.map((l, i) => (i === 0 && first ? c.line('  ⎿  ') : '     ') + l);
    const outText = String(result?.d || '').replace(/\s+$/, '');
    const n = outText ? outText.split('\n').length : 0;
    if (e.name === 'TodoWrite') {
      L.push(...branch(todoItems(e).map((i) => (i.st === 'done' ? c.green('☒ ') + dim(strike(i.t)) : i.st === 'doing' ? c.yellow('◐ ') + bold(i.t) : c.soft('☐ ') + i.t))));
      return L;
    }
    if (e.x && ok) {
      let add = 0;
      let del = 0;
      const diff = [];
      for (const ed of e.x.edits || [e.x]) {
        if (ed.old) for (const l of ed.old.split('\n')) (del++, diff.push(c.red('- ' + l)));
        if (ed.new) for (const l of ed.new.split('\n')) (add++, diff.push(c.green('+ ' + l)));
      }
      const sum = e.name === 'Write' ? `Wrote ${add} lines` : `Changed: ${c.green('+' + add)} ${c.red('−' + del)}`;
      const show = diff.slice(0, 14).map((l) => trunc(l, W - 8));
      if (diff.length > 14) show.push(dim(`… +${diff.length - 14} lines`));
      L.push(...branch([sum, ...show]));
      return L;
    }
    if (!result) return [...L, ...branch([dim('(stopped)')])];
    if (!ok) {
      const ls = outText.split('\n').slice(0, 6).map((l) => c.red(trunc(l, W - 8)));
      if (n > 6) ls.push(dim(`… +${n - 6} lines (ctrl+o to see all)`));
      return [...L, ...branch(ls.length ? ls : [c.red('failed')])];
    }
    if (e.name === 'Read') return [...L, ...branch([dim(`read ${n} lines`)])];
    if (e.name === 'Glob' || e.name === 'Grep' || e.name === 'LS') return [...L, ...branch([dim(n ? `${n} results` : 'no results')])];
    if (e.name === 'Task' || e.name === 'Agent') return [...L, ...branch([dim('subagent finished')])];
    if (!outText) return [...L, ...branch([dim('(no output)')])];
    const ls = outText.split('\n').slice(0, 5).map((l) => c.soft(trunc(l, W - 8)));
    if (n > 5) ls.push(dim(`… +${n - 5} lines (ctrl+o to see all)`));
    return [...L, ...branch(ls)];
  }

  shItem(cmd) {
    const it = {
      kind: 'sh',
      cmd,
      buf: '',
      done: false,
      code: null,
      preview: (W) => {
        const ls = it.buf.replace(/\s+$/, '').split('\n').slice(-6);
        return [c.pink('● ') + bold('$ ' + trunc(cmd, W - 8)), ...(it.buf ? ls.map((l, i) => (i === 0 ? c.line('  ⎿  ') : '     ') + c.soft(trunc(l, W - 8))) : [])];
      },
      final: (W) => {
        const all = it.buf.replace(/\s+$/, '').split('\n');
        const ls = (it.buf ? all.slice(0, 12) : []).map((l) => c.soft(trunc(l, W - 8)));
        if (all.length > 12) ls.push(dim(`… +${all.length - 12} lines (ctrl+o to see all)`));
        ls.push(it.code === 0 ? dim('exit 0') : c.red(`exit ${it.code}`));
        return ['', (it.code === 0 ? c.green('● ') : c.red('● ')) + bold('$ ' + cmd), ...ls.map((l, i) => (i === 0 ? c.line('  ⎿  ') : '     ') + l)];
      },
    };
    return it;
  }

  onEvent(e, replay = false) {
    switch (e.k) {
      case 'user':
        this.lastUserSeq = e;
        this.closeText();
        this.queue.push({ kind: 'user', done: true, final: () => this.userBlock(e.d, false), preview: () => [] });
        this.activity = 'Berpikir';
        break;
      case 'thinking':
        this.activity = `Thinking (${e.words} words)`;
        break;
      case 'toolStart':
        this.activity = `Menyiapkan ${e.name}`;
        break;
      case 'text': {
        let last = this.queue[this.queue.length - 1];
        if (!last || last.kind !== 'text' || last.done) this.queue.push((last = this.textItem()));
        last.src += e.d;
        this.activity = 'Writing';
        break;
      }
      case 'tool': {
        this.closeText();
        const it = this.toolItem(e);
        this.tools.set(e.id, it);
        this.queue.push(it);
        this.activity = toolActivity(e);
        if (e.name === 'TodoWrite') it.done = true;
        break;
      }
      case 'result': {
        const it = this.tools.get(e.id);
        if (it && it.kind === 'tool') {
          it.result = e;
          it.done = true;
          if (e.d) this.lastOutput = { title: `${it.e.name}(${String(it.e.s || '').split('\n')[0]})`, text: e.d };
        }
        this.activity = 'Berpikir';
        break;
      }
      case 'perm':
        if (!replay) this.addPerm(e);
        break;
      case 'permAnswer':
        this.perms = this.perms.filter((p) => p.pid !== e.pid);
        if (this.overlay?.type === 'perm' && this.overlay.perm.pid === e.pid) this.overlay = null;
        this.showNextPerm();
        this.closeText();
        this.queue.push({ kind: 'note', done: true, final: () => [dim(`  ${e.allow ? c.green('✓') : c.red('✗')} ${e.allow ? 'allowed' : 'denied'} · ${e.tool}`)], preview: () => [] });
        break;
      case 'retry':
        this.closeText();
        this.queue.push({ kind: 'note', done: true, final: () => [c.yellow(`  ↻ model error ${e.status ?? ''} — retrying${e.attempt ? ` (${e.attempt}/${e.max})` : ''}`)], preview: () => [] });
        break;
      case 'done': {
        for (const it of this.queue) it.done = true;
        const t = e.ok
          ? `${c.green('✻')} ${dim(['Done', ...doneParts(e)].join(' · '))}`
          : `${c.red('✻')} ${c.red('Stopped: ' + (e.err || 'error'))}`;
        this.queue.push({ kind: 'note', done: true, final: () => ['', t], preview: () => [] });
        this.activity = '';
        if (!replay) this.refreshGit();
        break;
      }
      case 'sh':
        this.closeText();
        this.queue.push(this.userBlockItem('$ ' + e.d), (this.shCur = this.shItem(e.d)));
        this.activity = '$ ' + e.d;
        break;
      case 'out':
        if (this.shCur) this.shCur.buf += e.d;
        break;
      case 'shDone':
        if (this.shCur) {
          this.shCur.code = e.code;
          this.shCur.done = true;
          this.lastOutput = { title: '$ ' + this.shCur.cmd, text: this.shCur.buf };
          this.shCur = null;
        }
        if (!replay) this.refreshGit();
        break;
      case 'note':
        this.closeText();
        this.queue.push({ kind: 'note', done: true, final: () => ['', c.cyan('◆ ') + c.cyan(e.d)], preview: () => [] });
        break;
      case 'error':
        this.closeText();
        this.queue.push({ kind: 'note', done: true, final: () => ['', c.red('✗ ' + e.d)], preview: () => [] });
        break;
      case 'status':
        this.setRunning(e.s === 'running');
        break;
      case 'mode':
        if (this.session) this.session.plan = e.plan;
        break;
      case 'proc':
        if (e.port && !this.procPorts?.has(e.name + e.port)) {
          (this.procPorts ??= new Set()).add(e.name + e.port);
          this.setFlash(`▶ ${e.name} ready at http://localhost:${e.port} — /preview for your phone`);
        } else if (e.status === 'exited' && !e.killed && e.code) this.setFlash(`✗ ${e.name} stopped (exit ${e.code}) — /logs ${e.name}`, true, 5000);
        break;
      case 'shot':
        this.closeText();
        this.queue.push({ kind: 'note', done: true, final: () => [dim(`  ◐ screenshot ${e.url} (see it on your phone)`)], preview: () => [] });
        break;
    }
    if (!replay) this.flushQueue();
  }
  userBlockItem(text) {
    return { kind: 'user', done: true, final: () => this.userBlock(text.replace(/^\$ /, ''), true), preview: () => [] };
  }

  setRunning(on) {
    if (on && !this.running) this.runStart = Date.now();
    this.running = on;
    clearInterval(this.ticker);
    if (on) this.ticker = setInterval(() => (this.frame++, this.render()), 120);
    else {
      for (const it of this.queue) it.done = true;
      this.flushQueue();
      const next = this.queued?.shift();
      if (next) setTimeout(() => this.sendNow(next), 50);
    }
    this.scheduleRender();
  }

  addPerm(p) {
    if (this.perms.some((x) => x.pid === p.pid)) return;
    this.perms.push(p);
    out.write('\x07'); // bell: get attention
    this.showNextPerm();
  }
  showNextPerm() {
    if (this.overlay && this.overlay.type !== 'perm') return;
    const p = this.perms[0];
    if (this.overlay?.perm === p) return this.scheduleRender(); // don't reset an answer being filled in
    this.overlay = p ? { type: 'perm', perm: p, idx: 0, qi: 0, sel: (p.ask || []).map(() => new Set()), text: (p.ask || []).map(() => '') } : null;
    this.scheduleRender();
  }

  async refreshGit() {
    if (!this.session) return;
    try {
      const st = await this.cl.call('status', { id: this.session.id });
      if (st.notRepo) {
        this.git = null;
      } else {
        this.git = { branch: st.branch, files: st.files?.length || 0, ahead: st.ahead };
      }
      this.scheduleRender();
    } catch {}
  }

  // ---- session ----
  async attach(s, { quiet = false } = {}) {
    if (this.session) await this.cl.call('detach').catch(() => {});
    this.session = s;
    this.queue = [];
    this.tools.clear();
    this.perms = [];
    this.overlay = null;
    this.git = null;
    const res = await this.cl.call('attach', { id: s.id, since: 0 });
    this.session = res.session;
    const all = res.events;
    const keep = all.slice(-80);
    if (!quiet) {
      this.printHeader();
      if (all.length > keep.length || res.truncated) this.print(dim(`  … ${all.length - keep.length + (res.truncated ? 1 : 0)}+ earlier events not shown`));
    }
    this.evCursor = new EventCursor();
    for (const e of all) this.evCursor.accept(e);
    for (const e of keep) this.onEvent(e, true);
    for (const it of this.queue) it.done = true;
    this.flushQueue();
    for (const p of res.perms) this.addPerm({ ...p, s: p.summary });
    this.setRunning(res.session.status === 'running');
    this.refreshGit();
  }

  printHeader() {
    const W = Math.min(cols() - 1, 72);
    const s = this.session;
    const inner = W - 4;
    const row = (l = '') => c.line('│ ') + pad(trunc(l, inner), inner) + c.line(' │');
    const kv = (k, v) => row(`  ${dim(k.padEnd(7))} ${v}`);
    const lines = [
      c.line('╭' + '─'.repeat(W - 2) + '╮'),
      row(`${gradient(LOGO + ' snugcode', PAL.peach, PAL.clay)}  ${dim('— coding agent · ' + (ENGINE_LABEL[this.info?.engine] || 'Claude Agent SDK'))}`),
      row(),
      row(`  ${dim('/help')} help  ${dim('/model')} model & effort  ${dim('!')} shell`),
      row(),
    ];
    if (s) {
      if (s.computer) {
        lines.push(kv('mode', c.cyan('💻 Computer (control the whole PC)')));
        lines.push(kv('folder', c.fg(tildify(s.cwd))));
      } else {
        if (s.local) lines.push(kv('folder', c.fg(tildify(s.cwd))));
        lines.push(kv('repo', c.fg(s.repo) + dim(' · ') + c.blue(s.branch)));
      }
      lines.push(kv('model', c.purple('◆ ') + c.fg(modelLabel(s.model))));
    }
    lines.push(kv('PC', c.fg(this.info.name) + dim(this.info.github ? ` · @${this.info.github}` : '') + dim(' · continue on your phone anytime')));
    lines.push(c.line('╰' + '─'.repeat(W - 2) + '╯'));
    if (s?.title) lines.push('', dim('  session: ') + c.soft(trunc(s.title, W - 10)));
    this.print(lines);
  }

  // ---- input ----
  insert(text) {
    const chars = [...this.input];
    chars.splice(this.cursor, 0, ...text);
    this.input = chars.join('');
    this.cursor += [...text].length;
    this.sugIdx = 0;
  }
  async submit() {
    const raw = this.input;
    const text = raw.trim();
    if (!text) return;
    this.history.unshift(raw);
    this.histIdx = -1;
    this.input = '';
    this.cursor = 0;
    if (this.mode === 'chat' && text.startsWith('/')) return this.command(text);
    if (!this.session) return this.setFlash('No session yet — /new or /sessions', true);
    const toSend = this.mode === 'shell' ? '!' + text : text;
    this.mode = 'chat';
    // The agent is still working: queue it, sent automatically when it finishes (like Claude Code).
    if (this.running) {
      this.queued = [...(this.queued || []), toSend];
      return this.scheduleRender();
    }
    return this.sendNow(toSend);
  }
  async sendNow(toSend) {
    try {
      await this.cl.call('send', { id: this.session.id, text: toSend });
    } catch (e) {
      this.setFlash(e.message, true);
    }
  }

  onKey(str, key = {}) {
    if (key.name === 'paste-start') return (this.pasting = true);
    if (key.name === 'paste-end') return ((this.pasting = false), this.scheduleRender());
    if (this.overlay) return this.overlayKey(str, key);
    const ctrl = key.ctrl;
    const name = key.name;
    const sug = this.suggestions();

    if (ctrl && name === 'c') {
      if (this.input) {
        this.input = '';
        this.cursor = 0;
      } else if (this.queued?.length) this.queued = [];
      else if (this.running) this.interrupt();
      else if (this.exitArmed && Date.now() - this.exitArmed < 2000) return this.exit();
      else this.exitArmed = Date.now();
      setTimeout(() => this.scheduleRender(), 2100);
      return this.scheduleRender();
    }
    if (ctrl && name === 'd') return this.input ? null : this.exit();
    if (ctrl && name === 'o') return this.showLastOutput();
    if (ctrl && name === 'l') {
      out.write('\x1b[2J\x1b[3J\x1b[H');
      this.liveRows = 0;
      this.liveCursorRow = 0;
      this.printHeader();
      return;
    }
    if (name === 'escape') {
      if (this.running) this.interrupt();
      else if (this.ghWaiting) {
        // Stop waiting on screen; the code stays valid until it expires.
        this.ghWaiting = false;
        this.busyText = null;
      } else if (sug.length) this.input = '';
      else if (this.mode === 'shell' && !this.input) this.mode = 'chat';
      this.cursor = Math.min(this.cursor, [...this.input].length);
      return this.scheduleRender();
    }
    if (name === 'return' || name === 'enter') {
      if (this.pasting || key.meta || key.shift) this.insert('\n');
      else if (sug.length && this.input !== sug[this.sugIdx][0]) {
        this.input = sug[this.sugIdx][0];
        this.cursor = [...this.input].length;
        return this.submit().then(() => this.scheduleRender());
      } else if (this.input.endsWith('\\') && this.cursor === [...this.input].length) {
        this.input = this.input.slice(0, -1);
        this.cursor--;
        this.insert('\n');
      } else return this.submit().then(() => this.scheduleRender());
      return this.scheduleRender();
    }
    if (name === 'tab') {
      if (sug.length) {
        this.input = sug[this.sugIdx][0] + ' ';
        this.cursor = [...this.input].length;
      }
      return this.scheduleRender();
    }
    const chars = [...this.input];
    if (name === 'backspace') {
      if (this.cursor > 0) {
        chars.splice(this.cursor - 1, 1);
        this.input = chars.join('');
        this.cursor--;
      } else if (this.mode === 'shell' && !this.input) this.mode = 'chat';
    } else if (name === 'delete') {
      chars.splice(this.cursor, 1);
      this.input = chars.join('');
    } else if (name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (name === 'right') this.cursor = Math.min(chars.length, this.cursor + 1);
    else if (name === 'home' || (ctrl && name === 'a')) this.cursor = 0;
    else if (name === 'end' || (ctrl && name === 'e')) this.cursor = chars.length;
    else if (ctrl && name === 'u') {
      this.input = chars.slice(this.cursor).join('');
      this.cursor = 0;
    } else if (ctrl && name === 'k') this.input = chars.slice(0, this.cursor).join('');
    else if (ctrl && name === 'w') {
      let i = this.cursor;
      while (i > 0 && /\s/.test(chars[i - 1])) i--;
      while (i > 0 && !/\s/.test(chars[i - 1])) i--;
      chars.splice(i, this.cursor - i);
      this.input = chars.join('');
      this.cursor = i;
    } else if (name === 'up' || name === 'down') {
      if (sug.length) this.sugIdx = (this.sugIdx + (name === 'up' ? -1 : 1) + Math.min(sug.length, 9)) % Math.min(sug.length, 9);
      else if (this.history.length && (!this.input.includes('\n') || this.histIdx >= 0)) {
        this.histIdx = Math.max(-1, Math.min(this.history.length - 1, this.histIdx + (name === 'up' ? 1 : -1)));
        this.input = this.histIdx < 0 ? '' : this.history[this.histIdx];
        this.cursor = [...this.input].length;
      }
    } else if (str && !ctrl && !key.meta && str >= ' ' || (str && this.pasting)) {
      const text = str.replace(/\r\n?/g, '\n');
      if (text === '!' && !this.input && this.mode === 'chat' && !this.pasting) this.mode = 'shell';
      else if (text === '?' && !this.input && this.mode === 'chat' && !this.pasting) this.help();
      else this.insert(text);
    }
    this.scheduleRender();
  }

  async interrupt() {
    if (!this.session || !this.running) return;
    this.setFlash('stopping…');
    await this.cl.call('interrupt', { id: this.session.id }).catch((e) => this.setFlash(e.message, true));
  }

  showLastOutput() {
    if (!this.lastOutput) return this.setFlash('No tool output yet', true);
    const W = cols();
    this.print(['', c.soft('── ' + trunc(this.lastOutput.title, W - 8) + ' ' + '─'.repeat(Math.max(0, W - width(this.lastOutput.title) - 8))), ...this.lastOutput.text.replace(/\s+$/, '').split('\n').map((l) => c.soft(l)), c.soft('─'.repeat(W - 1))]);
  }

  // ---- overlay ----
  overlayKey(str, key) {
    const o = this.overlay;
    const name = key.name;
    if (key.ctrl && name === 'c') {
      if (o.type === 'perm') return o.perm.ask || o.perm.plan ? this.sendPerm(o.perm, 'deny') : this.answerPerm(o.perm.push ? 1 : 2);
      return this.closeOverlay(null);
    }
    if (o.type === 'perm' && o.perm.ask) return this.askKey(o, str, key);
    if (o.type === 'perm' && o.perm.plan) {
      if (name === 'up' || name === 'down' || name === 'tab') return (o.idx = 1 - o.idx), this.scheduleRender();
      if (str === '1' || str === '2') o.idx = +str - 1;
      else if (name === 'escape') o.idx = 1;
      else if (name !== 'return') return;
      return o.idx === 0 ? this.sendPerm(o.perm, 'allow') : this.sendPerm(o.perm, 'deny', { message: PLAN_REVISE });
    }
    if (o.type === 'perm') {
      const n = o.perm.push ? 2 : 3;
      if (name === 'up') o.idx = (o.idx + n - 1) % n;
      else if (name === 'down' || name === 'tab') o.idx = (o.idx + 1) % n;
      else if (name === 'return') return this.answerPerm(o.idx);
      else if (name === 'escape') return this.answerPerm(n - 1);
      else if (/^[1-3]$/.test(str || '') && +str <= n) return this.answerPerm(+str - 1);
      return this.scheduleRender();
    }
    if (o.type === 'confirm') {
      if (name === 'left' || name === 'right' || name === 'tab') o.idx = 1 - o.idx;
      else if (str === 'y' || str === 'Y') return this.closeOverlay(true);
      else if (str === 'n' || str === 'N' || name === 'escape') return this.closeOverlay(false);
      else if (name === 'return') return this.closeOverlay(o.idx === 0);
      return this.scheduleRender();
    }
    if (o.type === 'select') {
      const items = o.filtered();
      if (name === 'escape') return this.closeOverlay(null);
      if (name === 'up') o.idx = Math.max(0, o.idx - 1);
      else if (name === 'down') o.idx = Math.min(items.length - 1, o.idx + 1);
      else if ((name === 'left' || name === 'right') && o.onArrow) o.onArrow(items[o.idx], name === 'left' ? -1 : 1);
      else if (name === 'return') return items[o.idx] ? this.closeOverlay(items[o.idx]) : null;
      else if (o.filter !== undefined && name === 'backspace') o.filter = o.filter.slice(0, -1);
      else if (o.filter !== undefined && str && str >= ' ' && !key.ctrl && !key.meta) {
        o.filter += str;
        o.idx = 0;
      }
      o.onChange?.();
      return this.scheduleRender();
    }
  }
  overlayPrompt(o) {
    return new Promise((resolve) => {
      // The same object (not a copy): async loading fills items into this overlay.
      o.resolve = resolve;
      this.overlay = o;
      this.scheduleRender();
    });
  }
  closeOverlay(value) {
    const o = this.overlay;
    // The last search text is used by the "use the typed name" option.
    if (o?.filter !== undefined) this.overlayFilterLast = o.filter;
    this.overlay = null;
    o?.resolve?.(value);
    this.showNextPerm();
    this.scheduleRender();
  }
  confirm(title, text) {
    return this.overlayPrompt({ type: 'confirm', title, text, idx: 0 });
  }
  /** @param {{ title: string, items?: any[], filterable?: boolean, placeholder?: string, foot?: string, note?: string, idx?: number, onArrow?: (it: any, d: number) => void, load?: (o: any) => Promise<any[]> }} opts */
  select({ title, items, filterable = true, placeholder, foot, note, idx = 0, onArrow, load }) {
    const o = {
      type: 'select',
      title,
      items: items || [],
      idx,
      foot,
      note,
      placeholder,
      onArrow,
      filter: filterable ? '' : undefined,
      loading: !!load,
      filtered() {
        const f = (this.filter || '').toLowerCase();
        return f ? this.items.filter((it) => (it.label + ' ' + (it.sub || '') + ' ' + (it.key || '')).toLowerCase().includes(f) || it.always) : this.items;
      },
    };
    const p = this.overlayPrompt(o);
    if (load)
      load(o).then(
        (its) => {
          o.items = its;
          o.loading = false;
          this.scheduleRender();
        },
        (e) => {
          o.loading = false;
          o.note = c.red(e.message);
          this.scheduleRender();
        },
      );
    return p;
  }
  async answerPerm(idx) {
    const o = this.overlay;
    if (o?.type !== 'perm') return;
    const p = o.perm;
    return this.sendPerm(p, p.push ? ['allow', 'deny'][idx] : ['allow', 'always', 'deny'][idx]);
  }
  async sendPerm(p, decision, extra = {}) {
    this.overlay = null;
    this.perms = this.perms.filter((x) => x.pid !== p.pid);
    this.scheduleRender();
    try {
      await this.cl.call('perm', { id: this.session.id, pid: p.pid, decision, ...extra });
    } catch (e) {
      this.setFlash(e.message, true);
    }
    this.showNextPerm();
  }
  // AskUserQuestion: one question per screen; the last option = a typed free-form answer.
  askKey(o, str, key) {
    const qs = o.perm.ask;
    const q = qs[o.qi];
    const n = q.options.length + 1;
    const typing = o.idx === n - 1;
    const pick = (i) => {
      const label = q.options[i].label;
      if (!q.multiSelect) o.sel[o.qi] = new Set([label]);
      else o.sel[o.qi].has(label) ? o.sel[o.qi].delete(label) : o.sel[o.qi].add(label);
    };
    const next = () => {
      if (!o.sel[o.qi].size && !o.text[o.qi].trim()) return this.setFlash('Pick an answer first', true);
      if (o.qi < qs.length - 1) return (o.qi++, (o.idx = 0), this.scheduleRender());
      const answers = Object.fromEntries(qs.map((x, i) => [x.question, [...o.sel[i], o.text[i].trim()].filter(Boolean).join(', ')]));
      return this.sendPerm(o.perm, 'allow', { answers });
    };
    if (key.name === 'escape') return this.sendPerm(o.perm, 'deny', { message: 'The user skipped the question; decide yourself with the most reasonable choice.' });
    if (key.name === 'up') o.idx = (o.idx + n - 1) % n;
    else if (key.name === 'down' || key.name === 'tab') o.idx = (o.idx + 1) % n;
    else if (key.name === 'return') {
      if (!typing && !q.multiSelect) pick(o.idx);
      return next();
    } else if (typing && key.name === 'backspace') o.text[o.qi] = o.text[o.qi].slice(0, -1);
    else if (typing && str && str >= ' ' && !key.ctrl && !key.meta) o.text[o.qi] += str;
    else if (!typing && str === ' ' && q.multiSelect) pick(o.idx);
    else if (/^[1-9]$/.test(str || '') && +str <= n) {
      o.idx = +str - 1;
      if (o.idx < n - 1 && !q.multiSelect) return (pick(o.idx), next());
    }
    return this.scheduleRender();
  }

  // ---- commands ----
  help() {
    const W = cols();
    const keys = [
      ['enter', 'send'],
      ['\\ + enter / alt+enter', 'new line'],
      ['!', 'shell mode (direct commands)'],
      ['esc', 'stop the agent'],
      ['↑ ↓', 'input history'],
      ['tab', 'complete / commands'],
      ['ctrl+o', 'full output of the last tool'],
      ['ctrl+l', 'clear the screen'],
      ['ctrl+c ×2', 'exit'],
    ];
    this.print([
      '',
      bold(gradient('snugcode', PAL.peach, PAL.clay)) + dim('  — commands'),
      ...COMMANDS.map(([cmd, d]) => `  ${c.cyan(cmd.padEnd(11))} ${c.soft(d)}`),
      '',
      bold('Pintasan'),
      ...keys.map(([k, d]) => `  ${c.yellow(k.padEnd(22))} ${c.soft(d)}`),
      '',
      dim(trunc('Sessions here are the same as on your phone — start in the terminal, continue on the phone (or the other way round).', W - 2)),
    ]);
  }

  async command(text) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    const s = this.session;
    const need = () => {
      if (!s) throw new Error('No session yet — /new or /sessions');
      return s;
    };
    try {
      switch (cmd) {
        case '/help':
        case '/?':
          return this.help();
        case '/exit':
        case '/quit':
          return this.exit();
        case '/clear':
          out.write('\x1b[2J\x1b[3J\x1b[H');
          this.liveRows = 0;
          this.liveCursorRow = 0;
          return this.printHeader();
        case '/model':
          return this.pickModel('session');
        case '/default':
          return this.pickModel('default');
        case '/sessions':
          return this.pickSession();
        case '/computer':
        case '/pc':
          return this.newComputerSession();
        case '/new':
          return this.newSession(arg);
        case '/login':
          return this.loginGithub();
        case '/auto': {
          need();
          const on = !s.auto;
          if (on && !(await this.confirm('Auto-approve', 'The agent may run any shell command without asking (except git push). Continue?'))) return;
          this.session = await this.cl.call('auto', { id: s.id, on });
          return this.setFlash(on ? '⚡ auto-approve ON' : 'auto-approve off', on);
        }
        case '/otonomi':
        case '/autonomy': {
          need();
          const names = { ask: 'ask', tanya: 'ask', balanced: 'balanced', seimbang: 'balanced', routine: 'trusted', rutin: 'trusted', trusted: 'trusted', full: 'auto', penuh: 'auto', auto: 'auto' };
          const level = names[String(arg || '').trim().toLowerCase()];
          if (!level) return this.setFlash('usage: /autonomy ask | balanced | routine | full  (now: ' + (s.autonomy || '-') + ')');
          if (level === 'auto' && !(await this.confirm('Full autonomy', 'The agent may run any shell command without asking (except git push & PRs). Continue?'))) return;
          this.session = await this.cl.call('autonomy', { id: s.id, level });
          return this.setFlash({ ask: 'autonomy: ask for every edit & command', balanced: 'autonomy: balanced (edits apply directly, commands ask)', trusted: 'autonomy: test/lint/build automatic, other commands ask', auto: '⚡ full autonomy' }[level], level === 'auto');
        }
        case '/edits': {
          need();
          const on = !s.askEdits;
          this.session = await this.cl.call('edits', { id: s.id, on });
          return this.setFlash(on ? 'edit review ON: every Write/Edit asks for permission' : 'edit review off: edits in the worktree apply directly (can /rewind)');
        }
        case '/run': {
          need();
          const r = await this.cl.call('runDev', { id: s.id, cmd: arg || undefined });
          return this.print(['', c.green('▶ ') + bold(r.dev) + (r.setup ? dim(`  (after ${r.setup})`) : '') + dim('  — /ps · /logs · /preview · /stop')]);
        }
        case '/ps': {
          need();
          const ps = (await this.cl.call('project', { id: s.id })).procs;
          if (!ps.length) return this.setFlash('No processes yet — /run');
          return this.print(['', ...ps.map((p) => `  ${p.status === 'running' ? c.green('●') : c.gray('○')} ${bold(p.name)} ${dim(p.status === 'running' ? (p.port ? 'port ' + p.port : 'waiting for port') : 'exit ' + p.code)}  ${c.soft(p.cmd)}`)]);
        }
        case '/logs':
        case '/stop':
        case '/preview': {
          need();
          const ps = (await this.cl.call('project', { id: s.id })).procs;
          const name = arg || ps.find((p) => p.status === 'running')?.name || ps[0]?.name;
          if (!name) return this.setFlash('No processes yet — /run', true);
          if (cmd === '/stop') {
            await this.cl.call('procStop', { id: s.id, name });
            return this.setFlash('■ ' + name + ' stopped');
          }
          if (cmd === '/logs') {
            const t = await this.cl.call('procLogs', { id: s.id, name });
            const ls = t.replace(/\s+$/, '').split('\n');
            return this.print(['', bold('log ' + name), ...ls.slice(-40).map((l) => c.soft(trunc(l, cols() - 2)))]);
          }
          this.busyText = 'Membuka tunnel preview';
          this.scheduleRender();
          const pv = await this.cl.call('preview', { id: s.id, name }).finally(() => (this.busyText = null));
          const copied = copyClipboard(pv.link);
          return this.print(['', c.green('◆ ') + bold('Preview ' + name) + dim(` (port ${pv.port})`), `  ${under(c.blue(pv.link))}`, dim(`  the link contains a secret token${copied ? ' · copied' : ''} — open it on your phone/another laptop; closes when the process stops`)]);
        }
        case '/plan': {
          need();
          this.session = await this.cl.call('plan', { id: s.id, on: !s.plan });
          return this.setFlash(this.session.plan ? '☰ plan mode ON — the agent drafts a plan first' : 'plan mode off', this.session.plan);
        }
        case '/rewind': {
          need();
          if (s.computer) return this.setFlash('Checkpoints and rewind are only available for git repository sessions', true);
          const last = this.lastUserSeq;
          if (!last) return this.setFlash('No prompts in this session yet', true);
          if (!(await this.confirm('Rewind', `Restore every file to before the prompt "${trunc(last.d || 'image', 50)}"?`))) return;
          const n = await this.cl.call('rewind', { id: s.id, seq: last.seq });
          return this.setFlash(`↺ ${n} file(s) restored`);
        }
        case '/git': {
          need();
          const st = await this.cl.call('status', { id: s.id });
          if (st.notRepo) return this.setFlash('This session\'s working folder is not a git repository', true);
          this.git = { branch: st.branch, files: st.files.length, ahead: st.ahead };
          const L = ['', bold('git') + ' ' + c.blue(st.branch) + dim(st.hasUpstream ? `  ↑${st.ahead} ↓${st.behind}` : st.ahead ? `  ${st.ahead} commit(s) not on GitHub` : '  not on GitHub yet')];
          if (!st.files.length) L.push(dim('  no changes'));
          for (const f of st.files) L.push(`  ${f.st.includes('?') || f.st.includes('A') ? c.green('A') : f.st.includes('D') ? c.red('D') : c.yellow('M')}  ${f.path}`);
          if (st.log.length) L.push('', ...st.log.slice(0, 5).map((l) => `  ${c.yellow(l.slice(0, 7))} ${c.soft(l.slice(8))}`));
          return this.print(L);
        }
        case '/diff': {
          need();
          const { diff, truncated, notRepo } = await this.cl.call('diff', { id: s.id });
          if (notRepo) return this.setFlash('This session\'s working folder is not a git repository', true);
          if (!diff.trim()) return this.setFlash('No changes');
          const L = [''];
          for (const l of diff.split('\n')) {
            if (l.startsWith('diff --git')) L.push('', bold(c.blue('▸ ' + l.replace(/^diff --git a\/(.+?) b\/.*$/, '$1'))));
            else if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) continue;
            else if (l.startsWith('@@')) L.push(c.purple(l));
            else if (l.startsWith('+')) L.push(c.green(l));
            else if (l.startsWith('-')) L.push(c.red(l));
            else L.push(c.soft(l));
          }
          if (truncated) L.push(dim('… diff truncated'));
          return this.print(L);
        }
        case '/commit': {
          need();
          if (!arg) {
            this.input = 'Look at the current changes, write a clear commit message, then commit. Don\'t push.';
            this.cursor = [...this.input].length;
            return this.submit();
          }
          const r = await this.cl.call('commit', { id: s.id, message: arg });
          this.print(['', c.green('● ') + bold('commit ') + c.soft(r)]);
          return this.refreshGit();
        }
        case '/push': {
          need();
          const st = await this.cl.call('status', { id: s.id });
          if (!(await this.confirm('Push', `Push branch ${st.branch} to GitHub?`))) return;
          this.busyText = 'Pushing to GitHub';
          this.scheduleRender();
          const b = await this.cl.call('push', { id: s.id }).finally(() => (this.busyText = null));
          this.setFlash('⇡ pushed to origin/' + b);
          return this.refreshGit();
        }
        case '/pr': {
          need();
          this.busyText = 'Creating Pull Request';
          this.scheduleRender();
          const st = await this.cl.call('status', { id: s.id });
          const pr = await this.cl.call('pr', { id: s.id, title: arg || s.title || st.branch, body: '' }).finally(() => (this.busyText = null));
          return this.print(['', c.green('● ') + bold(`PR #${pr.number}`) + ' ' + under(c.blue(pr.url))]);
        }
        case '/delete': {
          need();
          const confirmMsg = s.computer
            ? 'Delete this computer session\'s history? Your files & system are not touched.'
            : s.local
            ? 'Delete this session\'s history? Your folders & files are not touched.'
            : 'Delete the session and its worktree? Unpushed changes will be lost.';
          if (!(await this.confirm('Delete session', confirmMsg))) return;
          await this.cl.call('delete', { id: s.id });
          this.session = null;
          this.setFlash('Session deleted');
          return this.pickSession();
        }
        case '/update': {
          this.busyText = 'Checking for updates…';
          this.scheduleRender();
          try {
            const st = await this.cl.call('updateStatus');
            this.busyText = null;
            if (!st.updateAvailable && arg !== '--force') {
              return this.setFlash(`✓ snugcode is up to date (${st.currentCommit})`);
            }
            this.print([
              '',
              bold(c.yellow('⬆ Update available: ')) + c.yellow(st.latestCommit) + (st.latestMessage ? c.soft(' — ' + st.latestMessage) : ''),
              dim(`  Current commit: ${st.currentCommit}`),
            ]);
            if (!(await this.confirm('Update snugcode', 'Install the update and restart the daemon now?'))) return;
            this.busyText = 'Installing the update…';
            this.scheduleRender();
            const res = await this.cl.call('update');
            this.busyText = null;
            this.print(['', c.green('✓ ') + bold(res.message || 'Update finished, the daemon is restarting.')]);
          } catch (e) {
            this.busyText = null;
            return this.setFlash('Update failed: ' + e.message, true);
          }
          return;
        }
        case '/clean': {
          this.busyText = 'Memindai…';
          this.scheduleRender();
          try {
            const r = await this.cl.call('cleanup');
            this.busyText = null;
            const wtCount = r.removedWorktrees?.length || 0;
            const repoCount = r.removedRepos?.length || 0;
            if (wtCount === 0 && repoCount === 0) {
              return this.setFlash('✓ PC workspace is already clean');
            }
            return this.setFlash(`✓ Dibersihkan: ${wtCount} worktree, ${repoCount} repo`);
          } catch (e) {
            this.busyText = null;
            return this.setFlash('Clean failed: ' + e.message, true);
          }
        }
        case '/restart': {
          if (!(await this.confirm('Restart daemon', 'Restart the snugcode daemon now?'))) return;
          try {
            await this.cl.call('restart');
            this.print(['', c.green('● ') + bold('The daemon is restarting…')]);
          } catch (e) {
            this.setFlash(e.message, true);
          }
          return;
        }
        default:
          return this.setFlash(`Unknown command: ${cmd} — /help`, true);
      }
    } catch (e) {
      this.busyText = null;
      this.setFlash(e.message, true, 5000);
    }
  }

  // ---- login GitHub ----
  async loginGithub() {
    const st = await this.cl.call('githubLogin');
    if (!st.pending) return this.setFlash('Failed to start GitHub login', true);
    const copied = copyClipboard(st.pending.code);
    this.print(ghCodeBox(st.pending, copied));
    openUrl(st.pending.uri);
    this.ghWaiting = true;
    this.busyText = 'Waiting for GitHub authorization (esc to cancel)';
    this.scheduleRender();
  }
  onGithub(st) {
    const was = this.info.githubState;
    this.info.githubState = st.state;
    if (st.login) this.info.github = st.login;
    if (this.ghWaiting && st.state === 'ok' && !st.pending) {
      this.ghWaiting = false;
      this.busyText = null;
      this.print(['', c.green('● ') + bold('GitHub connected') + c.soft(` @${st.login}`) + dim(' — push, PRs, and the repo list work again')]);
    } else if (this.ghWaiting && st.pending?.error) {
      this.ghWaiting = false;
      this.busyText = null;
      this.print(['', c.red('✗ GitHub login failed: ' + st.pending.error) + dim(' — try /login again')]);
    } else if (st.state === 'invalid' && was !== 'invalid') this.printGhWarning();
    this.scheduleRender();
  }
  printGhWarning() {
    const title = this.info.githubState === 'missing' ? 'GitHub is not signed in on this PC' : 'The GitHub login on this PC is no longer valid';
    this.print(['', c.red('● ') + bold(c.red(title)) + dim(' — push, PRs, and the repo list are unavailable.'), `  ${c.line('⎿')}  type ${c.cyan('/login')} to sign in again (the code shows here, or use your phone)`]);
  }

  async pickSession() {
    const list = await this.cl.call('sessions');
    const here = gitTop(process.cwd());
    const items = list.map((x) => ({
      value: x,
      label: x.title || (x.computer ? 'Computer session' : '(no prompt yet)'),
      key: x.repo,
      sub: x.computer
        ? `Computer · ${tildify(x.cwd || '')} · ${modelLabel(x.model)} · ${ago(x.updatedAt)}`
        : `${x.repo} · ${x.branch} · ${modelLabel(x.model)} · ${ago(x.updatedAt)}${x.local ? ' · local' : ''}`,
      tag: x.status === 'running' ? c.yellow('● running') : x.id === this.session?.id ? c.green('● current') : '',
    }));
    if (here) items.unshift({ value: { here }, label: c.green('+ ') + 'Session in this folder', sub: tildify(here), always: true });
    items.push({ value: { computer: true }, label: c.green('+ ') + 'Computer session (control the PC like Claude Code)…', sub: 'full access to the system & directories', always: true });
    items.push({ value: { create: true }, label: c.green('+ ') + 'New session from a GitHub repo…', always: true });
    const pick = await this.select({ title: 'Sessions', items, placeholder: 'search sessions…' });
    if (!pick) return;
    const v = pick.value;
    if (v.computer) return this.newComputerSession();
    if (v.create) return this.newSession();
    if (v.here) return this.attach(await this.cl.call('create', { local: v.here }));
    return this.attach(v);
  }

  async newComputerSession(cwd = process.cwd()) {
    this.busyText = 'Preparing the computer session';
    this.scheduleRender();
    try {
      const s = await this.cl.call('create', { computer: true, cwd });
      this.busyText = null;
      await this.attach(s);
    } catch (e) {
      this.busyText = null;
      this.setFlash(e.message, true, 6000);
    }
  }

  async newSession(q) {
    const pick = await this.select({
      title: 'Repo GitHub',
      placeholder: 'search repos or type owner/name…',
      load: async (o) => {
        if (q) o.filter = q;
        const repos = await this.cl.call('repos').catch((e) => {
          o.note = c.yellow(e.message + ' — type owner/name for a public repo.');
          return [];
        });
        return [
          ...repos.map((r) => ({ value: r.full, label: r.full, sub: [r.private ? 'private' : '', r.desc || ''].filter(Boolean).join(' · '), tag: r.private ? c.gray('🔒') : '' })),
          { value: '__typed', label: c.green('+ ') + 'use the typed name (owner/name)', always: true },
        ];
      },
    });
    if (!pick) return;
    let repo = pick.value;
    if (repo === '__typed') {
      repo = (this.overlayFilterLast || '').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return this.setFlash('Type owner/name in the search box first', true);
    }
    this.busyText = `Menyiapkan ${repo} (clone/fetch)`;
    this.scheduleRender();
    try {
      const s = await this.cl.call('create', { repo });
      this.busyText = null;
      await this.attach(s);
    } catch (e) {
      this.busyText = null;
      this.setFlash(e.message, true, 6000);
    }
  }

  async pickModel(target) {
    const cur = target === 'session' ? this.session?.model : this.info.model;
    if (target === 'session' && !this.session) return this.setFlash('No session yet', true);
    const effort = new Map();
    const slider = (g) => {
      const e = effort.get(g.key);
      const levels = [...(g.auto ? [null] : []), ...g.levels.map((l) => l.effort)];
      const idx = Math.max(0, levels.indexOf(e));
      const seg = levels.map((lv, i) => (i === idx ? c.yellow(bold('●')) : c.line('━━━'))).join(c.line('━'));
      return [`    ${dim('effort')}  ${c.green('fast')} ${seg} ${c.yellow('deep')}   ${bold(c.yellow(e === null ? 'auto' : M.EFFORT_LABEL[e] || e))}  ${dim('← →')}`];
    };
    const pick = await this.select({
      title: target === 'session' ? 'This session\'s model' : 'Default model (new sessions)',
      placeholder: 'search models…',
      foot: '↑↓ model · ←→ effort · enter use · esc cancel',
      load: async (o) => {
        const groups = M.groupModels(await this.cl.call('modelsInfo'));
        const items = groups.map((g) => {
          effort.set(g.key, M.defaultChoice(g, cur));
          const inUse = g.variants.some((v) => v.id === cur);
          return {
            value: g,
            key: g.key,
            label: g.name,
            sub: [g.conn && g.conn !== 'router' ? g.label || M.PROVIDER_LABEL[g.provider] || g.provider : M.PROVIDER_LABEL[g.provider] || g.provider, g.engine === 'codex' ? 'Codex' : g.engine === 'gemini' ? 'Gemini CLI' : '', g.ctx ? M.ctxLabel(g.ctx) + ' context' : '', g.slider ? `${g.levels.length + (g.auto ? 1 : 0)} effort levels` : g.fixed ? 'effort ' + (M.EFFORT_LABEL[g.fixed] || g.fixed) : ''].filter(Boolean).join(' · '),
            tag: inUse ? c.green('● in use') : '',
            extra: g.slider ? () => slider(g) : null,
          };
        });
        o.idx = Math.max(0, items.findIndex((it) => it.value.variants.some((v) => v.id === cur)));
        return items;
      },
      onArrow: (it, d) => {
        if (!it?.value.slider) return;
        const g = it.value;
        const levels = [...(g.auto ? [null] : []), ...g.levels.map((l) => l.effort)];
        const i = levels.indexOf(effort.get(g.key));
        effort.set(g.key, levels[Math.max(0, Math.min(levels.length - 1, i + d))]);
      },
    });
    if (!pick) return;
    const id = M.resolveId(pick.value, effort.get(pick.value.key));
    if (id === cur) return this.setFlash('Model unchanged');
    this.busyText = `Menguji ${modelLabel(id)}`;
    this.scheduleRender();
    const r = await this.cl.call('probeModel', { model: id }).catch((e) => ({ ok: false, err: e.message }));
    this.busyText = null;
    if (!r.ok && !(await this.confirm('Model problem', `${modelLabel(id)}: ${r.err}\nUse it anyway?`))) return;
    if (target === 'session') {
      this.session = await this.cl.call('setSessionModel', { id: this.session.id, model: id });
    } else {
      this.info = await this.cl.call('setModel', { model: id });
    }
    this.setFlash(`${r.ok ? '✓' : '!'} ${modelLabel(id)}${r.ok ? ` · ready ${(r.ms / 1000).toFixed(1)}s` : ''}`, !r.ok);
  }

  exit() {
    this.closed = true;
    clearInterval(this.ticker);
    out.write(this.clearLive() + '\x1b[?2004l\x1b[?25h');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    const s = this.session;
    out.write(`\n${gradient(LOGO + 'ᶻ', PAL.peach, PAL.clay)} ${dim('see you.')}${s ? dim(' The session stays on the PC — continue on your phone or run ') + c.soft('snugcode') + dim(' again.') : ''}\n`);
    this.cl.sock.end();
    process.exit(0);
  }
}

function gitTop(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// ---------- main ----------
export async function runTui({ prompt = '', pick = false, computer = false } = {}) {
  if (!process.stdin.isTTY || !out.isTTY) {
    console.error('snugcode needs an interactive terminal. To run just the daemon: snugcode start');
    process.exit(1);
  }
  out.write(dim('  connecting to the daemon…') + '\r');
  let conn;
  try {
    conn = await connectDaemon((m) => out.write('\x1b[2K' + dim('  ' + m) + '\r'));
  } catch (e) {
    out.write('\x1b[2K');
    console.error(c.red('✗ ' + e.message));
    process.exit(1);
  }
  out.write('\x1b[2K\r');
  const app = new App(conn.client, conn.info, { prompt });

  // Short Esc timeout: the 500ms default makes "Esc then type B" read as Alt+B.
  readline.emitKeypressEvents(process.stdin, /** @type {any} */ ({ escapeCodeTimeout: 50 }));
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.write('\x1b[?2004h'); // bracketed paste
  process.stdin.on('keypress', (str, key) => {
    try {
      app.onKey(str, key || {});
    } catch (e) {
      app.setFlash(e.message, true);
    }
  });
  out.on('resize', () => app.scheduleRender());
  const cleanup = () => {
    out.write('\x1b[?2004l\x1b[?25h');
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => app.exit());
  // Unexpected errors are shown as messages instead of killing the UI.
  const soft = (e) => app.setFlash(String(e?.message || e), true, 6000);
  process.on('unhandledRejection', soft);
  process.on('uncaughtException', soft);

  app.cl.on('events', (m) => {
    if (m.sid !== app.session?.id) return;
    for (const e of m.es) if (app.evCursor.accept(e)) app.onEvent(e);
  });
  app.cl.on('github', (m) => app.onGithub(m));
  app.cl.on('notice', (m) => {
    if (m.sid !== app.session?.id) app.setFlash(`${m.title}: ${m.msg}`);
  });
  app.cl.on('closed', () => {
    if (app.closed) return;
    app.closed = true;
    out.write(app.clearLive() + '\x1b[?2004l\x1b[?25h');
    process.stdin.setRawMode(false);
    console.error(c.red('\n✗ Lost connection to the daemon.') + dim(' Run snugcode again.'));
    process.exit(1);
  });

  // A git repo folder -> local session (continue the existing one), otherwise pick a session or computer.
  const top = gitTop(process.cwd());
  try {
    if (computer) {
      await app.newComputerSession(process.cwd());
    } else if (top && !pick) {
      await app.attach(await app.cl.call('create', { local: top }));
    } else {
      app.printHeader();
      app.render();
      const list = await app.cl.call('sessions');
      if (list.length || top) await app.pickSession();
      else {
        const pickStart = await app.select({
          title: 'Start a session',
          items: [
            { value: 'computer', label: c.green('+ ') + 'Computer session (control the PC like Claude Code)', sub: tildify(process.cwd()) + ' · access to the whole PC', always: true },
            { value: 'repo', label: c.cyan('+ ') + 'Session from a GitHub repo…', sub: 'cloned into an isolated worktree', always: true },
          ],
        });
        if (pickStart?.value === 'computer') await app.newComputerSession(process.cwd());
        else if (pickStart?.value === 'repo') await app.newSession();
      }
    }
  } catch (e) {
    app.setFlash(e.message, true, 8000);
  }
  // The GitHub status is re-checked at startup so warnings show right away.
  app.cl.call('githubStatus', { check: true }).then((st) => {
    if (!st) return;
    app.info.githubState = st.state;
    if (['invalid', 'missing'].includes(st.state)) app.printGhWarning();
  }, () => {});
  app.render();
  if (prompt && app.session) {
    app.input = prompt;
    await app.submit();
  }
}
