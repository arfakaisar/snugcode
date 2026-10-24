// Interactive terminal (PTY) from the phone: a real shell in the session folder, over the same E2EE channel as
// RPC. Terminals stay alive while the phone is disconnected (like a light tmux): reconnecting replays the
// last 256 KB of output. The PTY package (`@lydell/node-pty`, prebuilt binary) is optional; without it this
// feature gives a clear message.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { toolchainEnv } from './toolchain.js';

const require = createRequire(import.meta.url);
const MAX_PER_SESSION = 4;
const SCROLLBACK = 256 * 1024;
const MAX_QUEUE = 512 * 1024;
// Output is batched: 16 ms keeps typing echo instant. During output floods (npm install, build logs) terminals
// watched only through the relay are batched every 50 ms instead: ~3× fewer relay messages, same bytes.
const FLUSH_MS = 16;
const FLOOD_MS = 50;
const FLOOD_BYTES = 8 * 1024;

/** @type {any} */
let ptyMod;
let ptyErr = '';
export function loadPty() {
  if (ptyMod || ptyErr) return ptyMod || null;
  try {
    ptyMod = require('@lydell/node-pty');
  } catch (e) {
    ptyErr = String(e?.message || e).split('\n')[0];
  }
  return ptyMod || null;
}

export function defaultShell() {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo', '-ExecutionPolicy', 'Bypass'] };
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

const clampSize = (v, def, max) => Math.max(2, Math.min(max, Math.round(+v) || def));

export class Terminals {
  constructor({ log = () => {} } = {}) {
    /** @type {Map<string, any>} */
    this.map = new Map();
    this.log = log;
    this.lastIo = 0;
  }

  /** @param {{ id: string, meta: { cwd: string } }} session @param {{ cols?: number, rows?: number }} [size] */
  async open(session, { cols, rows } = {}) {
    const pty = loadPty();
    if (!pty) throw new Error('Terminal unavailable on this machine: the @lydell/node-pty package is not installed (' + ptyErr + '). Run `snugcode update` or reinstall snugcode.');
    if (this.list(session.id).length >= MAX_PER_SESSION) throw new Error(`At most ${MAX_PER_SESSION} terminals per session. Close one first.`);
    const { file, args } = defaultShell();
    const env = await toolchainEnv('', { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', SNUGCODE_TERMINAL: '1' });
    const size = { cols: clampSize(cols, 80, 500), rows: clampSize(rows, 24, 200) };
    const p = pty.spawn(file, args, { name: 'xterm-256color', cwd: session.meta.cwd, env, ...size });
    const n = this.list(session.id).length + 1;
    const t = { tid: randomBytes(6).toString('hex'), sid: session.id, title: `Terminal ${n}`, p, buf: '', subs: new Map(), exited: null, ...size, at: Date.now() };
    this.map.set(t.tid, t);
    p.onData((d) => this.output(t, d));
    p.onExit(({ exitCode }) => {
      t.exited = exitCode ?? 0;
      this.flush(t);
      for (const c of t.subs.keys()) c.push({ ev: 'term', tid: t.tid, exit: t.exited });
      this.map.delete(t.tid);
    });
    return t;
  }

  output(t, d) {
    this.lastIo = Date.now();
    t.buf += d;
    if (t.buf.length > SCROLLBACK) {
      // Cut at a line start so replay doesn't begin in the middle of an escape sequence.
      const cut = t.buf.indexOf('\n', t.buf.length - SCROLLBACK);
      t.buf = t.buf.slice(cut < 0 ? t.buf.length - SCROLLBACK : cut + 1);
    }
    for (const [c, q] of t.subs) {
      const next = q + d;
      t.subs.set(c, next.length > MAX_QUEUE ? next.slice(-MAX_QUEUE) : next);
    }
    t.flushT ??= setTimeout(() => this.flush(t), t.flood && ![...t.subs.keys()].some((c) => c.local) ? FLOOD_MS : FLUSH_MS);
  }

  flush(t) {
    clearTimeout(t.flushT);
    t.flushT = null;
    let max = 0;
    for (const q of t.subs.values()) max = Math.max(max, q.length);
    t.flood = max >= FLOOD_BYTES;
    for (const [c, q] of t.subs) {
      if (!q) continue;
      t.subs.set(c, '');
      c.push({ ev: 'term', tid: t.tid, d: q });
    }
  }

  get(tid) {
    const t = this.map.get(String(tid));
    if (!t) throw new Error('Terminal already closed');
    return t;
  }

  list(sid) {
    return [...this.map.values()].filter((t) => t.sid === sid);
  }

  summary(t) {
    return { tid: t.tid, title: t.title, cols: t.cols, rows: t.rows, at: t.at };
  }

  // Subscribe to output; returns the scrollback to replay (the client resets its screen first).
  attach(tid, conn) {
    const t = this.get(tid);
    this.flush(t);
    t.subs.set(conn, '');
    return { ...this.summary(t), buf: t.buf };
  }

  detach(tid, conn) {
    this.map.get(String(tid))?.subs.delete(conn);
  }

  detachConn(conn) {
    for (const t of this.map.values()) t.subs.delete(conn);
  }

  write(tid, d) {
    const t = this.get(tid);
    this.lastIo = Date.now();
    t.p.write(d);
  }

  resize(tid, cols, rows) {
    const t = this.get(tid);
    t.cols = clampSize(cols, t.cols, 500);
    t.rows = clampSize(rows, t.rows, 200);
    t.p.resize(t.cols, t.rows);
  }

  close(tid) {
    const t = this.map.get(String(tid));
    if (!t) return;
    try {
      t.p.kill();
    } catch {}
    this.map.delete(t.tid);
  }

  closeSession(sid) {
    for (const t of this.list(sid)) this.close(t.tid);
  }

  closeAll() {
    for (const tid of [...this.map.keys()]) this.close(tid);
  }

  // Something happened in a terminal recently (the cloud runner isn't stopped for being idle).
  active(ms = 2 * 60_000) {
    return this.map.size > 0 && Date.now() - this.lastIo < ms;
  }
}
