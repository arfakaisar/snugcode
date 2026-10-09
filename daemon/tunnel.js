// Preview dev server dari HP/laptop lain lewat Cloudflare quick tunnel (tanpa akun).
// Tunnel tidak diarahkan langsung ke dev server, tapi ke gerbang lokal yang mewajibkan
// token rahasia; token hanya dikirim ke HP lewat kanal E2EE, jadi URL tunnel yang bocor
// tidak bisa dipakai. Gerbang juga menulis ulang Host/Origin ke localhost agar dev server
// (Vite allowedHosts, Next allowedDevOrigins) menerima request, termasuk WebSocket HMR.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HOME } from './config.js';

const BIN_DIR = path.join(HOME, 'bin');
const EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const COOKIE = 'pc_gate';
export const TOKEN_PARAM = 'pc_t';
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i;
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

function releaseAsset() {
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch] || 'amd64';
  if (process.platform === 'win32') return `cloudflared-windows-${arch === '386' ? '386' : 'amd64'}.exe`;
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  return `cloudflared-linux-${arch}`;
}

function onPath() {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

async function download(dest) {
  const asset = releaseAsset();
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`);
  if (!res.ok) throw new Error(`Gagal mengunduh cloudflared (${res.status})`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = path.join(BIN_DIR, asset + '.part');
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  if (asset.endsWith('.tgz')) {
    execFileSync('tar', ['-xzf', tmp, '-C', BIN_DIR]);
    fs.rmSync(tmp, { force: true });
  } else fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

let installing = null;
// cloudflared: config.json → ~/.pocketcode/bin → PATH → unduh sekali dari rilis GitHub.
export function cloudflaredPath(cfg = {}) {
  if (cfg.cloudflaredExecutable) return Promise.resolve(cfg.cloudflaredExecutable);
  const local = path.join(BIN_DIR, EXE);
  if (fs.existsSync(local)) return Promise.resolve(local);
  const sys = onPath();
  if (sys) return Promise.resolve(sys);
  return (installing ??= download(local).finally(() => (installing = null)));
}

const page = (title, text) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="background:#07090d;color:#dbe2ea;font:15px/1.6 ui-monospace,monospace;padding:32px 18px;max-width:560px;margin:auto"><h2 style="color:#5ee6a0">${title}</h2><p>${text}</p>`;

export function startGate(target, token) {
  const want = Buffer.from(token);
  const valid = (t) => typeof t === 'string' && t.length === token.length && timingSafeEqual(Buffer.from(t), want);
  const cookie = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)pc_gate=([^;]+)/)?.[1];
  const local = `localhost:${target}`;
  const forwardHeaders = (req) => {
    const h = { ...req.headers, host: local };
    if (h.origin) h.origin = 'http://' + local;
    if (h.referer) h.referer = h.referer.replace(/^https?:\/\/[^/]+/, 'http://' + local);
    delete h['x-forwarded-host'];
    const rest = h.cookie?.split(/;\s*/).filter((c) => !c.startsWith(COOKIE + '=')).join('; ');
    if (rest) h.cookie = rest;
    else delete h.cookie;
    return h;
  };
  const deny = (res) => {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page('Link preview tidak valid', 'Buka preview lewat tombol Preview di aplikasi pocketcode.'));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const t = url.searchParams.get(TOKEN_PARAM);
    if (t !== null) {
      if (!valid(t)) return deny(res);
      url.searchParams.delete(TOKEN_PARAM);
      res.writeHead(302, { location: url.pathname + url.search, 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`, 'cache-control': 'no-store' });
      return res.end();
    }
    if (!valid(cookie(req))) return deny(res);
    const up = http.request({ host: 'localhost', port: target, method: req.method, path: req.url, headers: forwardHeaders(req), agent, autoSelectFamily: true }, (upRes) => {
      const h = { ...upRes.headers };
      if (h.location) h.location = h.location.replace(LOCAL_ORIGIN_RE, '') || '/';
      res.writeHead(upRes.statusCode, h);
      upRes.pipe(res);
    });
    up.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', refresh: '3' });
      res.end(page('Dev server belum siap', `Tidak ada yang menjawab di port ${target}. Halaman ini memuat ulang otomatis.`));
    });
    res.on('close', () => res.writableFinished || up.destroy());
    req.pipe(up);
  });

  // WebSocket (HMR Vite/Next/webpack): cek cookie, lalu salurkan socket mentah.
  server.on('upgrade', (req, sock, head) => {
    if (!valid(cookie(req))) return sock.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
    const up = net.connect({ host: 'localhost', port: target, autoSelectFamily: true }, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(forwardHeaders(req))) for (const x of [].concat(v)) raw += `${k}: ${x}\r\n`;
      up.write(raw + '\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock).pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Subdomain trycloudflare baru butuh beberapa detik sampai DNS dan edge-nya siap (sebelum itu
// 530). Jangan berikan link sebelum gerbang kita sendiri menjawab lewat tunnel: resolver HP akan
// menyimpan cache "tidak ditemukan" beberapa menit. Resolver publik dipakai langsung agar tidak
// terkena cache negatif OS di PC.
async function waitReady(url, ms = 30000) {
  const host = new URL(url).hostname;
  const r = new dns.Resolver({ timeout: 2000, tries: 1 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  const status = (ip) =>
    new Promise((ok) => {
      const q = https.get({ host: ip, servername: host, headers: { host }, path: '/', timeout: 5000 }, (res) => (res.resume(), ok(res.statusCode)));
      q.on('timeout', () => q.destroy());
      q.on('error', () => ok(0));
    });
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((ok) => setTimeout(ok, 700))) {
    const ip = await r.resolve4(host).then((a) => a[0], () => null);
    if (ip && (await status(ip)) === 401) return;
  }
}

// Buka tunnel ke `port`. Hasil: { url, link (dengan token), close() }.
export async function openTunnel(port, { cfg, onExit } = {}) {
  const token = randomBytes(24).toString('base64url');
  const gate = await startGate(port, token);
  let child;
  const close = () => {
    child?.kill();
    gate.closeAllConnections?.();
    gate.close();
  };
  try {
    const exe = await cloudflaredPath(cfg);
    child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${gate.address().port}`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const url = await new Promise((resolve, reject) => {
      let log = '';
      let found = null;
      const timer = setTimeout(() => reject(new Error('cloudflared tidak memberi URL dalam 45 detik')), 45000);
      // URL muncul sebelum tunnel siap; tunggu koneksi pertama terdaftar agar link langsung bisa dibuka.
      child.stderr.on('data', (d) => {
        log = (log + d).slice(-8000);
        found ??= log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
        if (found && /Registered tunnel connection/.test(log)) (clearTimeout(timer), resolve(found));
      });
      child.once('error', (e) => (clearTimeout(timer), reject(e)));
      child.once('exit', (code) => (clearTimeout(timer), reject(new Error('cloudflared berhenti: ' + (log.match(/(?:ERR|error).*$/im)?.[0] || 'exit ' + code)))));
    });
    await waitReady(url);
    child.once('exit', () => (gate.close(), onExit?.()));
    return { url, link: `${url}/?${TOKEN_PARAM}=${token}`, port, close };
  } catch (e) {
    close();
    throw e;
  }
}
