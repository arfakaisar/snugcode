// pocketcode — UI terminal (seperti `claude`), tersambung ke daemon lokal.
// Sesi yang sama bisa dilanjutkan di HP dan di terminal.
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

const out = process.stdout;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');

// ---------- warna ----------
const NO_COLOR = !!process.env.NO_COLOR;
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || '') || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode' || process.platform === 'win32';
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const to256 = ([r, g, b]) => 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
const fgc = (rgb) => (TRUECOLOR ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[38;5;${to256(rgb)}m`);
const bgc = (rgb) => (TRUECOLOR ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[48;5;${to256(rgb)}m`);
const paint = (open, close) => (s) => (NO_COLOR ? String(s) : open + s + close);
const color = (hex) => paint(fgc(hexRgb(hex)), '\x1b[39m');
const PAL = { green: '#5ee6a0', cyan: '#59d6e6', blue: '#7cb7ff', purple: '#c7a2ff', yellow: '#f2c14e', red: '#ff6b6b', pink: '#ff8fc7', gray: '#6f7a8a', fg: '#dbe2ea', soft: '#aab4c2', line: '#3a4352' };
const c = Object.fromEntries(Object.entries(PAL).map(([k, v]) => [k, color(v)]));
const bold = paint('\x1b[1m', '\x1b[22m');
const dim = paint('\x1b[2m', '\x1b[22m');
const italic = paint('\x1b[3m', '\x1b[23m');
const under = paint('\x1b[4m', '\x1b[24m');
const strike = paint('\x1b[9m', '\x1b[29m');
const userBg = paint(bgc(hexRgb('#1b222d')), '\x1b[49m');
function gradient(text, from = PAL.green, to = PAL.cyan) {
  if (NO_COLOR) return text;
  const a = hexRgb(from);
  const b = hexRgb(to);
  const chars = [...text];
  return chars.map((ch, i) => {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0;
    return fgc(a.map((v, k) => Math.round(v + (b[k] - v) * t))) + ch;
  }).join('') + '\x1b[39m';
}

// ---------- lebar tampilan & pembungkus baris (sadar ANSI) ----------
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const strip = (s) => String(s).replace(ANSI_RE, '');
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u;
const cw = (ch) => (WIDE.test(ch) ? 2 : 1);
const width = (s) => [...strip(s)].reduce((n, ch) => n + cw(ch), 0);
const cols = () => Math.max(40, out.columns || 80);
const rowsN = () => Math.max(12, out.rows || 24);

// Potong per baris tampilan; warna dibuka ulang di baris lanjutan.
function hardWrap(line, w) {
  const res = [];
  let cur = '';
  let curW = 0;
  let active = '';
  const re = /\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu;
  for (const m of String(line).matchAll(re)) {
    const tok = m[0];
    if (tok.length > 1 && tok[0] === '\x1b') {
      cur += tok;
      active = /\x1b\[0?m/.test(tok) ? '' : active + tok;
      continue;
    }
    const tw = cw(tok);
    if (curW + tw > w) {
      res.push(cur + (active ? '\x1b[0m' : ''));
      cur = active;
      curW = 0;
    }
    cur += tok;
    curW += tw;
  }
  res.push(cur);
  return res;
}
// Bungkus per kata dengan indentasi gantung (untuk prosa).
function wrapWords(text, w, first = '', rest = first) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = first && !lines.length ? first : lines.length ? rest : first;
    let curW = width(cur);
    const prefixW = curW;
    let empty = true;
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const ww = width(word);
      if (/^\s+$/.test(word)) {
        if (!empty && curW + ww <= w) {
          cur += word;
          curW += ww;
        }
        continue;
      }
      if (!empty && curW + ww > w) {
        lines.push(cur.trimEnd());
        cur = rest;
        curW = width(rest);
      }
      if (width(rest) + ww > w) {
        for (const piece of hardWrap(word, w - width(rest))) {
          if (curW + width(piece) > w && !empty) {
            lines.push(cur);
            cur = rest;
            curW = width(rest);
          }
          cur += piece;
          curW += width(piece);
          empty = false;
        }
        continue;
      }
      cur += word;
      curW += ww;
      empty = false;
    }
    lines.push(empty && curW === prefixW ? cur.trimEnd() : cur);
  }
  return lines;
}
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
const trunc = (s, w) => {
  s = String(s);
  if (width(s) <= w) return s;
  let o = '';
  let n = 0;
  for (const ch of strip(s)) {
    if (n + cw(ch) > w - 1) break;
    o += ch;
    n += cw(ch);
  }
  return o + '…';
};

// ---------- markdown -> ANSI ----------
function inlineMd(s) {
  return s
    .replace(/`([^`\n]+)`/g, (_, x) => c.purple(x))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, x) => bold(x))
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, (_, a, x) => a + italic(x))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => under(c.blue(t)) + dim(` (${u})`));
}
function renderMd(src, w, first = '', rest = '  ') {
  const L = src.replace(/\s+$/, '').split('\n');
  const outL = [];
  let lead = first;
  const take = () => {
    const l = lead;
    lead = rest;
    return l;
  };
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const fence = l.match(/^\s*```\s*([\w+#.-]*)/);
    if (fence) {
      const code = [];
      i++;
      while (i < L.length && !/^\s*```/.test(L[i])) code.push(L[i++]);
      if (fence[1]) outL.push(take() + dim(fence[1]));
      for (const cl of code) for (const part of hardWrap(cl.replace(/\t/g, '  '), w - width(rest) - 2)) outL.push((outL.length ? rest : take()) + c.line('│ ') + c.soft(part));
      continue;
    }
    if (!l.trim()) {
      if (outL.length && outL[outL.length - 1] !== '') outL.push('');
      continue;
    }
    const h = l.match(/^#{1,6}\s+(.*)/);
    if (h) {
      outL.push(take() + bold(c.blue(inlineMd(h[1]))));
      continue;
    }
    const li = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
    if (li) {
      const depth = Math.min(3, Math.floor(li[1].length / 2));
      const bullet = /\d/.test(li[2]) ? li[2] : '•';
      const ind = '  '.repeat(depth);
      const p = (outL.length ? rest : take()) + ind + c.green(bullet) + ' ';
      outL.push(...wrapWords(inlineMd(li[3]), w, p, rest + ind + ' '.repeat(width(bullet) + 1)));
      continue;
    }
    if (/^>\s?/.test(l)) {
      outL.push(...wrapWords(inlineMd(l.replace(/^>\s?/, '')), w, (outL.length ? rest : take()) + c.line('▎ '), rest + c.line('▎ ')));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      outL.push((outL.length ? rest : take()) + c.soft(trunc(l, w - width(rest))));
      continue;
    }
    outL.push(...wrapWords(inlineMd(l), w, outL.length ? rest : take(), rest));
  }
  return outL;
}

// ---------- klien daemon (named pipe / unix socket) ----------
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
      for (const p of this.pending.values()) p.reject(new Error('Koneksi ke daemon terputus'));
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
      const t = setTimeout(() => fail(new Error('daemon tidak menjawab')), 4000);
      cl.once('ready', (m) => (clearTimeout(t), sock.off('error', fail), resolve({ client: cl, info: m.info })));
      cl.once('denied', () => (clearTimeout(t), fail(new Error('token lokal ditolak daemon'))));
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

// Sambung ke daemon; nyalakan (atau ganti versi lama tanpa kanal lokal) bila perlu.
async function connectDaemon(onStatus) {
  const token = () => loadSecrets().localToken;
  try {
    return await tryConnect(token());
  } catch {}
  const old = runningPid();
  if (old) {
    onStatus('memperbarui daemon…');
    try {
      process.kill(old);
    } catch {}
    for (let i = 0; i < 30 && runningPid(); i++) await new Promise((r) => setTimeout(r, 100));
  } else onStatus('menyalakan daemon…');
  const p = spawn(process.execPath, [CLI, 'start', '--log'], { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      return await tryConnect(token());
    } catch {}
  }
  throw new Error('Daemon tidak bisa dinyalakan. Cek log: ' + path.join(HOME, 'daemon.log'));
}

// ---------- clipboard & browser (untuk kode login GitHub) ----------
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
// Kotak kode login yang mudah dibaca & disalin.
function ghCodeBox(p, copied) {
  const W = Math.min(cols() - 1, 64);
  const row = (l = '') => c.line('│ ') + pad(trunc(l, W - 4), W - 4) + c.line(' │');
  const code = [...p.code].join(' ');
  const center = (s) => ' '.repeat(Math.max(0, Math.floor((W - 4 - width(s)) / 2))) + s;
  return [
    '',
    c.line('╭─ ') + bold('Login GitHub') + c.line(' ' + '─'.repeat(Math.max(0, W - 17)) + '╮'),
    row(),
    row(center(bold(gradient(code, PAL.green, PAL.cyan)))),
    row(),
    row(`1. buka ${under(c.blue(p.uri))}`),
    row(`2. masukkan kode di atas${copied ? dim(' (sudah disalin ke clipboard)') : ''}`),
    row('3. tekan Authorize — selesai, tidak perlu restart'),
    row(),
    c.line('╰' + '─'.repeat(W - 2) + '╯'),
  ];
}

// `pocketcode login` saat daemon berjalan: login lewat daemon (tanpa restart).
export async function loginViaDaemon({ openBrowser = true } = {}) {
  const { client } = await tryConnect(loadSecrets().localToken);
  try {
    const st = await client.call('githubLogin');
    if (!st.pending) throw new Error('Gagal memulai login GitHub');
    const copied = copyClipboard(st.pending.code);
    console.log(ghCodeBox(st.pending, copied).join('\n'));
    if (openBrowser) openUrl(st.pending.uri);
    console.log(dim('  menunggu otorisasi… (Ctrl+C untuk batal)'));
    const res = await new Promise((resolve, reject) => {
      client.on('github', (m) => {
        if (m.state === 'ok' && !m.pending) resolve(m);
        else if (m.pending?.error) reject(new Error(m.pending.error));
      });
      client.on('closed', () => reject(new Error('Koneksi ke daemon terputus')));
    });
    console.log(c.green(`✓ GitHub tersambung: @${res.login}`) + dim(' — langsung dipakai daemon, HP, dan terminal.'));
  } finally {
    client.sock.end();
  }
}

// ---------- utilitas tampilan ----------
const SPIN = ['✶', '✸', '✹', '✺', '✹', '✸'];
const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
};
const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  return s < 60 ? 'baru saja' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'j' : Math.floor(s / 86400) + 'h';
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
const ACTIVITY = { Bash: 'Menjalankan', Read: 'Membaca', Edit: 'Mengedit', MultiEdit: 'Mengedit', Write: 'Menulis', Grep: 'Mencari', Glob: 'Mencari', LS: 'Melihat', WebFetch: 'Membuka', WebSearch: 'Mencari di web', Task: 'Subagen', Agent: 'Subagen', TodoWrite: 'Merencanakan' };

const COMMANDS = [
  ['/help', 'bantuan & pintasan keyboard'],
  ['/model', 'ganti model & effort sesi ini'],
  ['/default', 'model default untuk sesi baru'],
  ['/sessions', 'pindah sesi (juga sesi dari HP)'],
  ['/new', 'sesi baru dari repo GitHub'],
  ['/git', 'status git'],
  ['/diff', 'tampilkan diff'],
  ['/commit', 'commit semua perubahan [pesan]'],
  ['/push', 'push branch ke GitHub'],
  ['/pr', 'buat Pull Request [judul]'],
  ['/auto', 'nyalakan/matikan auto-izin'],
  ['/login', 'login ulang GitHub (push, PR, repo)'],
  ['/clear', 'bersihkan layar'],
  ['/delete', 'hapus sesi ini'],
  ['/exit', 'keluar (sesi tetap jalan di PC)'],
];

// ---------- aplikasi ----------
class App {
  constructor(client, info, opts) {
    this.cl = client;
    this.info = info;
    this.opts = opts;
    this.session = null;
    this.input = '';
    this.cursor = 0;
    this.mode = 'chat'; // chat | shell
    this.history = [];
    this.histIdx = -1;
    this.sugIdx = 0;
    this.overlay = null; // { type: 'perm'|'select'|'confirm', ... }
    this.running = false;
    this.runStart = 0;
    this.activity = '';
    this.perms = [];
    this.queue = []; // item tertunda yang belum dicetak (urutan terjaga)
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

  // ---- area hidup di bawah ----
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
  // Cetak ke scrollback di atas area hidup.
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

    // Pratinjau item yang masih berjalan (teks streaming, tool menunggu hasil).
    const pre = [];
    for (const it of this.queue) pre.push(...it.preview(W));
    const maxPre = Math.max(3, rowsN() - 12);
    if (pre.length > maxPre) lines.push(dim(`  … ${pre.length - maxPre} baris di atas`), ...pre.slice(-maxPre));
    else lines.push(...pre);

    for (const q of this.queued || []) lines.push(trunc(dim('  ⏳ antre: ') + c.soft(q.replace(/\n/g, ' ↵ ')), W - 1));
    if (this.running || this.busyText) {
      const g = SPIN[this.frame % SPIN.length];
      const act = this.perms.length ? 'Menunggu izinmu' : this.busyText || this.activity || 'Berpikir';
      const meta = this.running ? `(${fmtDur(Date.now() - this.runStart)} · ${bold('esc')} untuk hentikan)` : '';
      lines.push('');
      lines.push(...hardWrap(`${gradient(g, PAL.yellow, PAL.green)} ${c.yellow(trunc(act, W - 30))}${c.yellow('…')} ${dim(meta)}`, W - 1));
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
    // Setiap baris maksimal W-1 kolom: baris selebar terminal memicu auto-wrap
    // di sebagian terminal dan merusak perhitungan posisi baris/kursor.
    const textW = W - 7;
    // Bungkus teks input + petakan posisi kursor.
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
      if (!this.input && i === 0) body = dim(shell ? 'perintah shell di folder sesi…' : 'Minta sesuatu…  (/ perintah · ! shell · \\ + enter baris baru)');
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
      const g = this.git;
      parts.push(c.blue('git ') + c.soft(g?.branch || s.branch) + (g && g.files ? c.yellow(` +${g.files}`) : '') + (g && g.ahead ? c.green(` ↑${g.ahead}`) : ''));
      if (s.auto) parts.push(c.red('⚡ auto-izin'));
      if (['invalid', 'missing'].includes(this.info.githubState)) parts.push(c.red('GitHub: perlu /login'));
      if (s.local) parts.push(dim(tildify(s.cwd || '')));
      else parts.push(dim(s.repo));
    }
    let left = '  ' + parts.join(dim('  ·  '));
    let right;
    if (this.flash && Date.now() < this.flash.until) right = this.flash.bad ? c.red(this.flash.text) : c.green(this.flash.text);
    else if (this.exitArmed && Date.now() - this.exitArmed < 2000) right = c.yellow('Ctrl+C lagi untuk keluar');
    else if (this.mode === 'shell') right = dim('mode shell · backspace untuk kembali');
    else right = dim('? bantuan');
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
    if (o.type === 'perm') {
      const p = o.perm;
      const opts = p.push ? ['Ya, izinkan push', 'Tidak (esc)'] : ['Ya', `Ya, dan jangan tanya lagi untuk ${p.tool} di sesi ini`, 'Tidak (esc)'];
      const body = [];
      if (p.title) body.push(c.soft(p.title), '');
      for (const l of String(p.summary || p.s || '').split('\n').slice(0, 12)) body.push(c.fg(l));
      body.push('');
      opts.forEach((t, i) => body.push(i === o.idx ? c.cyan(`❯ ${i + 1}. ${t}`) : c.soft(`  ${i + 1}. ${t}`)));
      if (this.perms.length > 1) body.push('', dim(`+${this.perms.length - 1} permintaan lagi`));
      return { lines: box(bold(p.push ? c.red('Agen ingin PUSH ke GitHub') : c.yellow(`Izinkan ${p.tool}?`)), body, '↑↓ pilih · enter · 1-3', p.push ? c.red : c.yellow) };
    }
    if (o.type === 'confirm') {
      const body = [o.text, '', o.idx === 0 ? c.cyan('❯ Ya') + '   ' + c.soft('Tidak') : c.soft('  Ya') + '   ' + c.cyan('❯ Tidak')];
      return { lines: box(bold(o.title), body, '←→ · enter · y/n') };
    }
    if (o.type === 'select') {
      const items = o.filtered();
      const vis = Math.max(3, Math.min(10, rowsN() - 10));
      o.idx = Math.max(0, Math.min(o.idx, items.length - 1));
      const top = Math.max(0, Math.min(o.idx - Math.floor(vis / 2), items.length - vis));
      const body = [];
      if (o.filter !== undefined) body.push(c.cyan('⌕ ') + (o.filter ? c.fg(o.filter) : dim(o.placeholder || 'ketik untuk menyaring…')));
      if (o.loading) body.push(dim('  memuat…'));
      else if (!items.length) body.push(dim('  (kosong)'));
      for (let i = top; i < Math.min(items.length, top + vis); i++) {
        const it = items[i];
        const on = i === o.idx;
        body.push((on ? c.cyan('❯ ') : '  ') + (on ? bold(c.fg(it.label)) : c.soft(it.label)) + (it.tag ? ' ' + it.tag : ''));
        if (it.sub) body.push('    ' + dim(it.sub));
        if (on && it.extra) body.push(...it.extra());
      }
      if (items.length > vis) body.push(dim(`  ${o.idx + 1}/${items.length}`));
      if (o.note) body.push('', o.note);
      return { lines: box(bold(o.title), body, o.foot || '↑↓ pilih · enter · esc batal'), cursor: null };
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
      // Titik berkedip selama tool berjalan.
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
      const items = String(e.s || '').split('\n').filter(Boolean);
      L.push(...branch(items.map((l) => (l[0] === '☑' ? c.green('☒ ') + dim(strike(l.slice(2))) : l[0] === '◐' ? c.yellow('◐ ') + bold(l.slice(2)) : c.soft('☐ ') + l.slice(2)))));
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
      const sum = e.name === 'Write' ? `Menulis ${add} baris` : `Diubah: ${c.green('+' + add)} ${c.red('−' + del)}`;
      const show = diff.slice(0, 14).map((l) => trunc(l, W - 8));
      if (diff.length > 14) show.push(dim(`… +${diff.length - 14} baris`));
      L.push(...branch([sum, ...show]));
      return L;
    }
    if (!result) return [...L, ...branch([dim('(dihentikan)')])];
    if (!ok) {
      const ls = outText.split('\n').slice(0, 6).map((l) => c.red(trunc(l, W - 8)));
      if (n > 6) ls.push(dim(`… +${n - 6} baris (ctrl+o lihat semua)`));
      return [...L, ...branch(ls.length ? ls : [c.red('gagal')])];
    }
    if (e.name === 'Read') return [...L, ...branch([dim(`${n} baris dibaca`)])];
    if (e.name === 'Glob' || e.name === 'Grep' || e.name === 'LS') return [...L, ...branch([dim(n ? `${n} hasil` : 'tidak ada hasil')])];
    if (e.name === 'Task' || e.name === 'Agent') return [...L, ...branch([dim('subagen selesai')])];
    if (!outText) return [...L, ...branch([dim('(tanpa output)')])];
    const ls = outText.split('\n').slice(0, 5).map((l) => c.soft(trunc(l, W - 8)));
    if (n > 5) ls.push(dim(`… +${n - 5} baris (ctrl+o lihat semua)`));
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
        if (all.length > 12) ls.push(dim(`… +${all.length - 12} baris (ctrl+o lihat semua)`));
        ls.push(it.code === 0 ? dim('exit 0') : c.red(`exit ${it.code}`));
        return ['', (it.code === 0 ? c.green('● ') : c.red('● ')) + bold('$ ' + cmd), ...ls.map((l, i) => (i === 0 ? c.line('  ⎿  ') : '     ') + l)];
      },
    };
    return it;
  }

  onEvent(e, replay = false) {
    switch (e.k) {
      case 'user':
        this.closeText();
        this.queue.push({ kind: 'user', done: true, final: () => this.userBlock(e.d, false), preview: () => [] });
        this.activity = 'Berpikir';
        break;
      case 'text': {
        let last = this.queue[this.queue.length - 1];
        if (!last || last.kind !== 'text' || last.done) this.queue.push((last = this.textItem()));
        last.src += e.d;
        this.activity = 'Menulis';
        break;
      }
      case 'tool': {
        this.closeText();
        const it = this.toolItem(e);
        this.tools.set(e.id, it);
        this.queue.push(it);
        const first = String(e.s || '').split('\n')[0];
        this.activity = `${ACTIVITY[e.name] || e.name} ${e.name === 'TodoWrite' ? '' : first}`.trim();
        if (e.name === 'TodoWrite') {
          it.done = true;
          const doing = String(e.s || '').split('\n').find((l) => l[0] === '◐');
          if (doing) this.activity = doing.slice(2);
        }
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
        this.queue.push({ kind: 'note', done: true, final: () => [dim(`  ${e.allow ? c.green('✓') : c.red('✗')} ${e.allow ? 'diizinkan' : 'ditolak'} · ${e.tool}`)], preview: () => [] });
        break;
      case 'retry':
        this.closeText();
        this.queue.push({ kind: 'note', done: true, final: () => [c.yellow(`  ↻ 9router error ${e.status ?? ''} — mencoba lagi (${e.attempt}/${e.max})`)], preview: () => [] });
        break;
      case 'done': {
        for (const it of this.queue) it.done = true;
        const t = e.ok
          ? `${c.green('✻')} ${dim(`Selesai · ${e.turns} langkah · ${fmtDur(e.ms)}${e.usage ? ` · ${fmtTok(e.usage.in)}↑ ${fmtTok(e.usage.out)}↓ token` : ''}`)}`
          : `${c.red('✻')} ${c.red('Berhenti: ' + (e.err || 'error'))}`;
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
    out.write('\x07'); // bel: menarik perhatian
    this.showNextPerm();
  }
  showNextPerm() {
    if (this.overlay && this.overlay.type !== 'perm') return;
    const p = this.perms[0];
    this.overlay = p ? { type: 'perm', perm: p, idx: 0 } : null;
    this.scheduleRender();
  }

  async refreshGit() {
    if (!this.session) return;
    try {
      const st = await this.cl.call('status', { id: this.session.id });
      this.git = { branch: st.branch, files: st.files.length, ahead: st.ahead };
      this.scheduleRender();
    } catch {}
  }

  // ---- sesi ----
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
      if (all.length > keep.length || res.truncated) this.print(dim(`  … ${all.length - keep.length + (res.truncated ? 1 : 0)}+ event sebelumnya tidak ditampilkan`));
    }
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
      row(`${gradient('❯_ pocketcode')}  ${dim('— Claude Code harness · 9router')}`),
      row(),
      row(`  ${dim('/help')} bantuan  ${dim('/model')} model & effort  ${dim('!')} shell`),
      row(),
    ];
    if (s) {
      if (s.local) lines.push(kv('folder', c.fg(tildify(s.cwd))));
      lines.push(kv('repo', c.fg(s.repo) + dim(' · ') + c.blue(s.branch)));
      lines.push(kv('model', c.purple('◆ ') + c.fg(modelLabel(s.model))));
    }
    lines.push(kv('PC', c.fg(this.info.name) + dim(this.info.github ? ` · @${this.info.github}` : '') + dim(' · bisa dilanjutkan di HP')));
    lines.push(c.line('╰' + '─'.repeat(W - 2) + '╯'));
    if (s?.title) lines.push('', dim('  sesi: ') + c.soft(trunc(s.title, W - 10)));
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
    if (!this.session) return this.setFlash('Belum ada sesi — /new atau /sessions', true);
    const toSend = this.mode === 'shell' ? '!' + text : text;
    this.mode = 'chat';
    // Agen masih bekerja: antrekan, kirim otomatis begitu selesai (seperti Claude Code).
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
        // Berhenti menunggu di layar; kode tetap berlaku sampai kedaluwarsa.
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
    this.setFlash('menghentikan…');
    await this.cl.call('interrupt', { id: this.session.id }).catch((e) => this.setFlash(e.message, true));
  }

  showLastOutput() {
    if (!this.lastOutput) return this.setFlash('Belum ada output tool', true);
    const W = cols();
    this.print(['', c.soft('── ' + trunc(this.lastOutput.title, W - 8) + ' ' + '─'.repeat(Math.max(0, W - width(this.lastOutput.title) - 8))), ...this.lastOutput.text.replace(/\s+$/, '').split('\n').map((l) => c.soft(l)), c.soft('─'.repeat(W - 1))]);
  }

  // ---- overlay ----
  overlayKey(str, key) {
    const o = this.overlay;
    const name = key.name;
    if (key.ctrl && name === 'c') {
      if (o.type === 'perm') return this.answerPerm(o.perm.push ? 1 : 2);
      return this.closeOverlay(null);
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
      // Objek yang sama (bukan salinan): pemuatan async mengisi item ke overlay ini.
      o.resolve = resolve;
      this.overlay = o;
      this.scheduleRender();
    });
  }
  closeOverlay(value) {
    const o = this.overlay;
    // Teks pencarian terakhir dipakai opsi "pakai nama yang diketik".
    if (o?.filter !== undefined) this.overlayFilterLast = o.filter;
    this.overlay = null;
    o?.resolve?.(value);
    this.showNextPerm();
    this.scheduleRender();
  }
  confirm(title, text) {
    return this.overlayPrompt({ type: 'confirm', title, text, idx: 0 });
  }
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
    const decision = p.push ? ['allow', 'deny'][idx] : ['allow', 'always', 'deny'][idx];
    this.overlay = null;
    this.perms = this.perms.filter((x) => x.pid !== p.pid);
    this.scheduleRender();
    try {
      await this.cl.call('perm', { id: this.session.id, pid: p.pid, decision });
    } catch (e) {
      this.setFlash(e.message, true);
    }
    this.showNextPerm();
  }

  // ---- perintah ----
  help() {
    const W = cols();
    const keys = [
      ['enter', 'kirim'],
      ['\\ + enter / alt+enter', 'baris baru'],
      ['!', 'mode shell (perintah langsung)'],
      ['esc', 'hentikan agen'],
      ['↑ ↓', 'riwayat input'],
      ['tab', 'lengkapi perintah /'],
      ['ctrl+o', 'output lengkap tool terakhir'],
      ['ctrl+l', 'bersihkan layar'],
      ['ctrl+c ×2', 'keluar'],
    ];
    this.print([
      '',
      bold(gradient('pocketcode')) + dim('  — perintah'),
      ...COMMANDS.map(([cmd, d]) => `  ${c.cyan(cmd.padEnd(11))} ${c.soft(d)}`),
      '',
      bold('Pintasan'),
      ...keys.map(([k, d]) => `  ${c.yellow(k.padEnd(22))} ${c.soft(d)}`),
      '',
      dim(trunc('Sesi di sini sama dengan di HP — mulai di terminal, lanjutkan di HP (atau sebaliknya).', W - 2)),
    ]);
  }

  async command(text) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    const s = this.session;
    const need = () => {
      if (!s) throw new Error('Belum ada sesi — /new atau /sessions');
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
        case '/new':
          return this.newSession(arg);
        case '/login':
          return this.loginGithub();
        case '/auto': {
          need();
          const on = !s.auto;
          if (on && !(await this.confirm('Auto-izin', 'Agen boleh menjalankan perintah shell apa pun tanpa bertanya (kecuali git push). Lanjut?'))) return;
          this.session = await this.cl.call('auto', { id: s.id, on });
          return this.setFlash(on ? '⚡ auto-izin ON' : 'auto-izin off', on);
        }
        case '/git': {
          need();
          const st = await this.cl.call('status', { id: s.id });
          this.git = { branch: st.branch, files: st.files.length, ahead: st.ahead };
          const L = ['', bold('git') + ' ' + c.blue(st.branch) + dim(st.hasUpstream ? `  ↑${st.ahead} ↓${st.behind}` : st.ahead ? `  ${st.ahead} commit belum di GitHub` : '  belum ada di GitHub')];
          if (!st.files.length) L.push(dim('  tidak ada perubahan'));
          for (const f of st.files) L.push(`  ${f.st.includes('?') || f.st.includes('A') ? c.green('A') : f.st.includes('D') ? c.red('D') : c.yellow('M')}  ${f.path}`);
          if (st.log.length) L.push('', ...st.log.slice(0, 5).map((l) => `  ${c.yellow(l.slice(0, 7))} ${c.soft(l.slice(8))}`));
          return this.print(L);
        }
        case '/diff': {
          need();
          const { diff, truncated } = await this.cl.call('diff', { id: s.id });
          if (!diff.trim()) return this.setFlash('Tidak ada perubahan');
          const L = [''];
          for (const l of diff.split('\n')) {
            if (l.startsWith('diff --git')) L.push('', bold(c.blue('▸ ' + l.replace(/^diff --git a\/(.+?) b\/.*$/, '$1'))));
            else if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) continue;
            else if (l.startsWith('@@')) L.push(c.purple(l));
            else if (l.startsWith('+')) L.push(c.green(l));
            else if (l.startsWith('-')) L.push(c.red(l));
            else L.push(c.soft(l));
          }
          if (truncated) L.push(dim('… diff dipotong'));
          return this.print(L);
        }
        case '/commit': {
          need();
          if (!arg) {
            this.input = 'Lihat perubahan yang ada, tulis pesan commit yang jelas, lalu commit. Jangan push.';
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
          if (!(await this.confirm('Push', `Push branch ${st.branch} ke GitHub?`))) return;
          this.busyText = 'Push ke GitHub';
          this.scheduleRender();
          const b = await this.cl.call('push', { id: s.id }).finally(() => (this.busyText = null));
          this.setFlash('⇡ push ke origin/' + b);
          return this.refreshGit();
        }
        case '/pr': {
          need();
          this.busyText = 'Membuat Pull Request';
          this.scheduleRender();
          const st = await this.cl.call('status', { id: s.id });
          const pr = await this.cl.call('pr', { id: s.id, title: arg || s.title || st.branch, body: '' }).finally(() => (this.busyText = null));
          return this.print(['', c.green('● ') + bold(`PR #${pr.number}`) + ' ' + under(c.blue(pr.url))]);
        }
        case '/delete': {
          need();
          if (!(await this.confirm('Hapus sesi', s.local ? 'Hapus riwayat sesi ini? Folder & file kamu tidak disentuh.' : 'Hapus sesi beserta worktree-nya? Perubahan yang belum di-push hilang.'))) return;
          await this.cl.call('delete', { id: s.id });
          this.session = null;
          this.setFlash('Sesi dihapus');
          return this.pickSession();
        }
        default:
          return this.setFlash(`Perintah tidak dikenal: ${cmd} — /help`, true);
      }
    } catch (e) {
      this.busyText = null;
      this.setFlash(e.message, true, 5000);
    }
  }

  // ---- login GitHub ----
  async loginGithub() {
    const st = await this.cl.call('githubLogin');
    if (!st.pending) return this.setFlash('Gagal memulai login GitHub', true);
    const copied = copyClipboard(st.pending.code);
    this.print(ghCodeBox(st.pending, copied));
    openUrl(st.pending.uri);
    this.ghWaiting = true;
    this.busyText = 'Menunggu otorisasi GitHub (esc batal)';
    this.scheduleRender();
  }
  onGithub(st) {
    const was = this.info.githubState;
    this.info.githubState = st.state;
    if (st.login) this.info.github = st.login;
    if (this.ghWaiting && st.state === 'ok' && !st.pending) {
      this.ghWaiting = false;
      this.busyText = null;
      this.print(['', c.green('● ') + bold('GitHub tersambung') + c.soft(` @${st.login}`) + dim(' — push, PR, dan daftar repo bisa dipakai lagi')]);
    } else if (this.ghWaiting && st.pending?.error) {
      this.ghWaiting = false;
      this.busyText = null;
      this.print(['', c.red('✗ Login GitHub gagal: ' + st.pending.error) + dim(' — coba /login lagi')]);
    } else if (st.state === 'invalid' && was !== 'invalid') this.printGhWarning();
    this.scheduleRender();
  }
  printGhWarning() {
    const title = this.info.githubState === 'missing' ? 'GitHub belum login di PC ini' : 'Login GitHub di PC ini tidak berlaku';
    this.print(['', c.red('● ') + bold(c.red(title)) + dim(' — push, PR, dan daftar repo tidak bisa dipakai.'), `  ${c.line('⎿')}  ketik ${c.cyan('/login')} untuk login ulang (kode tampil di sini, bisa juga dari HP)`]);
  }

  async pickSession() {
    const list = await this.cl.call('sessions');
    const here = gitTop(process.cwd());
    const items = list.map((x) => ({
      value: x,
      label: x.title || '(belum ada prompt)',
      key: x.repo,
      sub: `${x.repo} · ${x.branch} · ${modelLabel(x.model)} · ${ago(x.updatedAt)}${x.local ? ' · lokal' : ''}`,
      tag: x.status === 'running' ? c.yellow('● berjalan') : x.id === this.session?.id ? c.green('● sekarang') : '',
    }));
    if (here) items.unshift({ value: { here }, label: c.green('+ ') + 'Sesi di folder ini', sub: tildify(here), always: true });
    items.push({ value: { create: true }, label: c.green('+ ') + 'Sesi baru dari repo GitHub…', always: true });
    const pick = await this.select({ title: 'Sesi', items, placeholder: 'cari sesi…' });
    if (!pick) return;
    const v = pick.value;
    if (v.create) return this.newSession();
    if (v.here) return this.attach(await this.cl.call('create', { local: v.here }));
    return this.attach(v);
  }

  async newSession(q) {
    const pick = await this.select({
      title: 'Repo GitHub',
      placeholder: 'cari repo atau ketik owner/nama…',
      load: async (o) => {
        if (q) o.filter = q;
        const repos = await this.cl.call('repos').catch((e) => {
          o.note = c.yellow(e.message + ' — ketik owner/nama untuk repo publik.');
          return [];
        });
        return [
          ...repos.map((r) => ({ value: r.full, label: r.full, sub: [r.private ? 'private' : '', r.desc || ''].filter(Boolean).join(' · '), tag: r.private ? c.gray('🔒') : '' })),
          { value: '__typed', label: c.green('+ ') + 'pakai nama yang diketik (owner/nama)', always: true },
        ];
      },
    });
    if (!pick) return;
    let repo = pick.value;
    if (repo === '__typed') {
      repo = (this.overlayFilterLast || '').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return this.setFlash('Ketik owner/nama di kotak pencarian dulu', true);
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
    if (target === 'session' && !this.session) return this.setFlash('Belum ada sesi', true);
    const effort = new Map();
    const slider = (g) => {
      const e = effort.get(g.key);
      const levels = [...(g.auto ? [null] : []), ...g.levels.map((l) => l.effort)];
      const idx = Math.max(0, levels.indexOf(e));
      const seg = levels.map((lv, i) => (i === idx ? c.yellow(bold('●')) : c.line('━━━'))).join(c.line('━'));
      return [`    ${dim('effort')}  ${c.green('cepat')} ${seg} ${c.yellow('dalam')}   ${bold(c.yellow(e === null ? 'auto' : M.EFFORT_LABEL[e] || e))}  ${dim('← →')}`];
    };
    const pick = await this.select({
      title: target === 'session' ? 'Model sesi ini' : 'Model default (sesi baru)',
      placeholder: 'cari model…',
      foot: '↑↓ model · ←→ effort · enter pakai · esc batal',
      load: async (o) => {
        const groups = M.groupModels(await this.cl.call('modelsInfo'));
        const items = groups.map((g) => {
          effort.set(g.key, M.defaultChoice(g, cur));
          const inUse = g.variants.some((v) => v.id === cur);
          return {
            value: g,
            key: g.key,
            label: g.name,
            sub: [M.PROVIDER_LABEL[g.provider] || g.provider, g.ctx ? M.ctxLabel(g.ctx) + ' konteks' : '', g.slider ? `${g.levels.length + (g.auto ? 1 : 0)} tingkat effort` : g.fixed ? 'effort ' + (M.EFFORT_LABEL[g.fixed] || g.fixed) : ''].filter(Boolean).join(' · '),
            tag: inUse ? c.green('● dipakai') : '',
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
    if (id === cur) return this.setFlash('Model tidak berubah');
    this.busyText = `Menguji ${modelLabel(id)}`;
    this.scheduleRender();
    const r = await this.cl.call('probeModel', { model: id }).catch((e) => ({ ok: false, err: e.message }));
    this.busyText = null;
    if (!r.ok && !(await this.confirm('Model bermasalah', `${modelLabel(id)}: ${r.err}\nTetap pakai?`))) return;
    if (target === 'session') {
      this.session = await this.cl.call('setSessionModel', { id: this.session.id, model: id });
    } else {
      this.info = await this.cl.call('setModel', { model: id });
    }
    this.setFlash(`${r.ok ? '✓' : '!'} ${modelLabel(id)}${r.ok ? ` · siap ${(r.ms / 1000).toFixed(1)}s` : ''}`, !r.ok);
  }

  exit() {
    this.closed = true;
    clearInterval(this.ticker);
    out.write(this.clearLive() + '\x1b[?2004l\x1b[?25h');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    const s = this.session;
    out.write(`\n${gradient('❯_')} ${dim('sampai jumpa.')}${s ? dim(' Sesi tetap ada di PC — lanjutkan di HP atau jalankan ') + c.soft('pocketcode') + dim(' lagi.') : ''}\n`);
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
export async function runTui({ prompt = '', pick = false } = {}) {
  if (!process.stdin.isTTY || !out.isTTY) {
    console.error('pocketcode perlu terminal interaktif. Untuk menjalankan daemon saja: pocketcode start');
    process.exit(1);
  }
  out.write(dim('  menghubungkan ke daemon…') + '\r');
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

  // Timeout Esc pendek: default 500ms membuat "Esc lalu ketik B" terbaca sebagai Alt+B.
  readline.emitKeypressEvents(process.stdin, { escapeCodeTimeout: 50 });
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
  // Error tak terduga ditampilkan sebagai pesan, bukan mematikan UI.
  const soft = (e) => app.setFlash(String(e?.message || e), true, 6000);
  process.on('unhandledRejection', soft);
  process.on('uncaughtException', soft);

  app.cl.on('events', (m) => {
    if (m.sid !== app.session?.id) return;
    for (const e of m.es) app.onEvent(e);
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
    console.error(c.red('\n✗ Koneksi ke daemon terputus.') + dim(' Jalankan pocketcode lagi.'));
    process.exit(1);
  });

  // Folder repo git -> sesi lokal (lanjutkan yang sudah ada), selain itu pilih sesi.
  const top = gitTop(process.cwd());
  try {
    if (top && !pick) await app.attach(await app.cl.call('create', { local: top }));
    else {
      app.printHeader();
      app.render();
      const list = await app.cl.call('sessions');
      if (list.length || top) await app.pickSession();
      else {
        app.print(dim('  Folder ini bukan repo git. Pilih repo GitHub untuk mulai:'));
        await app.newSession();
      }
    }
  } catch (e) {
    app.setFlash(e.message, true, 8000);
  }
  // Status GitHub dicek ulang di awal agar peringatan langsung terlihat.
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
