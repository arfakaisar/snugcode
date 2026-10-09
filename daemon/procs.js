// Proses jangka panjang per sesi (dev server, watcher, install): berjalan terpisah
// dari agen tanpa batas waktu, log disimpan di ring buffer, port terdeteksi otomatis.
import { spawn } from 'node:child_process';
import net from 'node:net';

const LOG_MAX = 256 * 1024;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// "Local: http://localhost:5173/" (Vite), "- Local: http://localhost:3000" (Next), dst.
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/i;
const isWin = process.platform === 'win32';

// Shell untuk `!perintah` dan proses latar belakang: PowerShell di Windows, $SHELL di macOS/Linux.
// ExecutionPolicy default Windows memblokir npm.ps1/npx.ps1 ("running scripts is disabled");
// Bypass hanya berlaku untuk proses ini, setelan sistem tidak berubah.
export function shellSpawn(cmd, opts) {
  return spawn(isWin ? 'powershell.exe' : process.env.SHELL || 'bash', isWin ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd] : ['-lc', cmd], { windowsHide: true, ...opts });
}

export const stripAnsi = (s) => s.replace(ANSI_RE, '');

// Hentikan proses beserta anak-anaknya (npm → node → vite).
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
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// localhost: dev server bisa listen di ::1 saja (Node 17+), jadi jangan paksa IPv4.
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
    if (!p) throw new Error(`Proses "${name}" tidak ada`);
    return p;
  }

  async start(cmd, name = procName(cmd)) {
    cmd = String(cmd || '').trim();
    if (!cmd) throw new Error('Perintah kosong');
    if (this.procs.get(name)?.status === 'running') throw new Error(`Proses "${name}" masih berjalan. Stop dulu.`);
    // PORT: dipakai Next/Express/CRA/Remix dkk. Vite mengabaikannya, tapi port-nya terbaca dari log.
    // "{port}" di perintah diganti port yang sama (lintas shell, tanpa sintaks env var).
    const port = await freePort();
    const child = shellSpawn(cmd.replaceAll('{port}', port), {
      cwd: this.cwd,
      detached: !isWin,
      env: { ...process.env, PORT: String(port), BROWSER: 'none', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    let exited;
    const p = { name, cmd, child, status: 'running', code: null, port: null, hintPort: port, startedAt: Date.now(), endedAt: null, log: '', buf: '', waiters: [], done: new Promise((r) => (exited = r)) };
    this.procs.set(name, p);
    const flush = () => {
      p.timer = null;
      if (p.buf) this.onOut(name, p.buf);
      p.buf = '';
    };
    const onData = (d) => {
      const text = stripAnsi(d.toString());
      p.log = (p.log + text).slice(-LOG_MAX);
      // Banjir output (npm install, build): kirim bagian terbarunya saja ke klien.
      p.buf = (p.buf + text).slice(-32 * 1024);
      if (!p.timer) p.timer = setTimeout(flush, 150);
      if (!p.port) {
        const m = text.match(URL_RE);
        if (m) this.setPort(p, +m[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => onData(Buffer.from(`\n[pocketcode] ${e.message}\n`)));
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
    // Server yang tidak mencetak URL: cek port dari env PORT setelah sempat start.
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

  // Tunggu sampai port terdeteksi (atau proses berhenti / waktu habis).
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

  // Proses yang masih jalan dihentikan; yang sudah berhenti dihapus dari daftar.
  stop(name) {
    const p = this.get(name);
    clearInterval(p.probe);
    if (p.status !== 'running') return this.procs.delete(name);
    p.killed = true;
    killTree(p.child);
  }

  // Tunggu (maks. 3 detik) sampai semua proses benar-benar mati, agar file worktree tidak terkunci.
  stopAll() {
    const running = [...this.procs.values()].filter((p) => p.status === 'running');
    for (const p of running) this.stop(p.name);
    return Promise.race([Promise.all(running.map((p) => p.done)), new Promise((r) => setTimeout(r, 3000))]);
  }

  running() {
    return [...this.procs.values()].filter((p) => p.status === 'running').length;
  }
}
