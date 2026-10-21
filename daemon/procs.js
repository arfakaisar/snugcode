// Long-running processes per session (dev server, watcher, install): run separately
// from the agent with no time limit, logs kept in a ring buffer, ports detected automatically.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { shellSpawn, toolchainEnv } from './toolchain.js';

const LOG_MAX = 256 * 1024;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// "Local: http://localhost:5173/" (Vite), "- Local: http://localhost:3000" (Next), dst.
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/i;
const isWin = process.platform === 'win32';

export const stripAnsi = (s) => s.replace(ANSI_RE, '');

// Stop a process and its children (npm → node → vite).
function killTree(p) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  if (isWin) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => p.kill());
  else {
    try {
      process.kill(-p.pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-p.pid, 'SIGKILL');
        } catch {}
      }, 3000).unref();
    } catch {
      p.kill();
    }
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

// localhost: dev servers may listen on ::1 only (Node 17+), so don't force IPv4.
export function portOpen(port, timeout = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ host: 'localhost', port, autoSelectFamily: true });
    const done = (ok) => (s.destroy(), resolve(ok));
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export function procName(cmd) {
  const m = cmd.match(/\b(?:run|run-script)\s+([\w:.-]+)/) || cmd.match(/^\s*(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|bun\s+(?:x\s+)?)?([\w:.-]+)/);
  return (m?.[1] || 'proc').slice(0, 32);
}

// Per-process log as a ring buffer of chunks: appending output doesn't re-copy 256KB
// of old log on every chunk (formerly `log = (log + text).slice(-LOG_MAX)` while npm install flooded).
class LogBuffer {
  constructor(max = LOG_MAX) {
    this.max = max;
    this.chunks = [];
    this.size = 0;
  }
  push(text) {
    if (!text) return;
    this.chunks.push(text);
    this.size += text.length;
    while (this.size - this.chunks[0].length >= this.max) this.size -= this.chunks.shift().length;
  }
  tail(n = this.max) {
    const s = this.chunks.join('');
    if (this.chunks.length > 1) {
      this.chunks = [s];
    }
    return s.slice(-Math.min(n, this.max));
  }
}

export class ProcManager {
  constructor({ cwd, onChange, onOut }) {
    this.cwd = cwd;
    this.onChange = onChange;
    this.onOut = onOut;
    this.procs = new Map();
  }

  summary(p) {
    return { name: p.name, cmd: p.cmd, status: p.status, code: p.code, killed: !!p.killed, port: p.port, startedAt: p.startedAt, endedAt: p.endedAt };
  }

  list() {
    return [...this.procs.values()].map((p) => this.summary(p));
  }

  get(name) {
    const p = this.procs.get(name);
    if (!p) throw new Error(`No process named "${name}"`);
    return p;
  }

  async start(cmd, name = procName(cmd)) {
    cmd = String(cmd || '').trim();
    if (!cmd) throw new Error('Empty command');
    const busy = () => {
      if (this.procs.get(name)?.status === 'running') throw new Error(`Process "${name}" is still running. Stop it first.`);
    };
    busy();
    // PORT: used by Next/Express/CRA/Remix etc. Vite ignores it, but its port is read from the log.
    // "{port}" in the command is replaced by the same port (works across shells, no env var syntax).
    const port = await freePort();
    const env = await toolchainEnv(cmd, { ...process.env, PORT: String(port), BROWSER: 'none', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
    busy(); // another start with the same name may slip in while waiting above
    const child = shellSpawn(cmd.replaceAll('{port}', port), { cwd: this.cwd, detached: !isWin, env });
    let exited;
    const out = new LogBuffer();
    const p = {
      name, cmd, child, status: 'running', code: null, port: null, hintPort: port, startedAt: Date.now(), endedAt: null, buf: '', waiters: [], done: new Promise((r) => (exited = r)),
      get log() {
        return out.tail();
      },
    };
    this.procs.set(name, p);
    const flush = () => {
      p.timer = null;
      if (p.buf) this.onOut(name, p.buf);
      p.buf = '';
    };
    const onData = (d) => {
      const text = stripAnsi(d.toString());
      out.push(text);
      // Output flood (npm install, build): only send the latest part to clients.
      p.buf = (p.buf + text).slice(-32 * 1024);
      if (!p.timer) p.timer = setTimeout(flush, 150);
      if (!p.port) {
        const m = text.match(URL_RE);
        if (m) this.setPort(p, +m[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => onData(Buffer.from(`\n[snugcode] ${e.message}\n`)));
    child.on('close', (code) => {
      clearTimeout(p.timer);
      flush();
      p.status = 'exited';
      p.code = code;
      p.endedAt = Date.now();
      for (const w of p.waiters.splice(0)) w(null);
      exited(code);
      this.onChange(this.summary(p));
    });
    this.onChange(this.summary(p));
    // Servers that don't print a URL: check the port from env PORT once it has had time to start.
    p.probe = setInterval(async () => {
      if (p.port || p.status !== 'running') return clearInterval(p.probe);
      if (await portOpen(p.hintPort)) this.setPort(p, p.hintPort);
    }, 2000);
    p.probe.unref?.();
    return this.summary(p);
  }

  setPort(p, port) {
    p.port = port;
    clearInterval(p.probe);
    for (const w of p.waiters.splice(0)) w(port);
    this.onChange(this.summary(p));
  }

  // Wait until a port is detected (or the process stops / time runs out).
  waitPort(name, ms = 30000) {
    const p = this.get(name);
    if (p.port || p.status !== 'running') return Promise.resolve(p.port);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        p.waiters = p.waiters.filter((w) => w !== done);
        resolve(null);
      }, ms);
      const done = (port) => (clearTimeout(t), resolve(port));
      p.waiters.push(done);
    });
  }

  logs(name, tail = LOG_MAX) {
    return this.get(name).log.slice(-tail);
  }

  // Running processes are stopped; stopped ones are removed from the list.
  stop(name) {
    const p = this.get(name);
    clearInterval(p.probe);
    if (p.status !== 'running') return this.procs.delete(name);
    p.killed = true;
    killTree(p.child);
  }

  // Wait (max 3 seconds) until every process is really dead, so worktree files aren't locked.
  stopAll() {
    const running = [...this.procs.values()].filter((p) => p.status === 'running');
    for (const p of running) this.stop(p.name);
    return Promise.race([Promise.all(running.map((p) => p.done)), new Promise((r) => setTimeout(r, 3000))]);
  }

  running() {
    return [...this.procs.values()].filter((p) => p.status === 'running').length;
  }
}
