// Preview dev servers from a phone/another laptop via a Cloudflare quick tunnel (no account).
// The tunnel doesn't point at the dev server directly but at a local gate that requires a
// secret token; the token is only sent to the phone over the E2EE channel, so a leaked tunnel URL
// is useless. The gate also rewrites Host/Origin to localhost so dev servers
// (Vite allowedHosts, Next allowedDevOrigins) accept the request, including HMR WebSockets.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

// Pinned version + SHA-256 from the official release notes (daemon/cloudflared-version.json): the downloaded binary
// runs on the PC, so it's never "latest" without verification. To update: version + hash from the GitHub release.
const PIN = JSON.parse(fs.readFileSync(new URL('./cloudflared-version.json', import.meta.url), 'utf8'));

async function download(dest) {
  const asset = releaseAsset();
  const want = PIN.sha256[asset];
  if (!want) throw new Error(`cloudflared for ${asset} isn't supported yet; install cloudflared yourself (PATH) or set cloudflaredExecutable in config.json.`);
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${PIN.version}/${asset}`);
  if (!res.ok) throw new Error(`Failed to download cloudflared (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`The downloaded cloudflared doesn't match the official checksum (${asset}); download aborted.`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = path.join(BIN_DIR, asset + '.part');
  fs.writeFileSync(tmp, buf);
  if (asset.endsWith('.tgz')) {
    execFileSync('tar', ['-xzf', tmp, '-C', BIN_DIR]);
    fs.rmSync(tmp, { force: true });
  } else fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

let installing = null;
// cloudflared: config.json → ~/.snugcode/bin → PATH → download once from the GitHub release.
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

// `target` can be changed (gate.retarget) without a new tunnel: the URL & cookie stay the same.
export function startGate(target, token) {
  const want = Buffer.from(token);
  const valid = (t) => typeof t === 'string' && t.length === token.length && timingSafeEqual(Buffer.from(t), want);
  const cookie = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)pc_gate=([^;]+)/)?.[1];
  let local = `localhost:${target}`;
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
    res.end(page('Invalid preview link', 'Open the preview with the Preview button in the snugcode app.'));
  };

  /** @type {http.Server & { retarget?: (port: number) => void }} */
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
    const up = http.request(/** @type {http.RequestOptions} */ ({ host: 'localhost', port: target, method: req.method, path: req.url, headers: forwardHeaders(req), agent, autoSelectFamily: true }), (upRes) => {
      const h = { ...upRes.headers };
      if (h.location) h.location = h.location.replace(LOCAL_ORIGIN_RE, '') || '/';
      res.writeHead(upRes.statusCode, h);
      upRes.pipe(res);
    });
    up.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', refresh: '3' });
      res.end(page('Dev server not ready yet', `Nothing is answering on port ${target}. This page reloads automatically.`));
    });
    res.on('close', () => res.writableFinished || up.destroy());
    req.pipe(up);
  });

  // WebSocket (Vite/Next/webpack HMR): check the cookie, then pipe the raw socket.
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

  server.retarget = (port) => {
    target = port;
    local = `localhost:${port}`;
    // Keep-alive / old HMR connections still point at the previous dev server.
    server.closeIdleConnections?.();
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// A new trycloudflare subdomain needs a few seconds until its DNS and edge are ready (530 before
// that). Don't hand out the link until our own gate answers through the tunnel: the phone's resolver
// would cache "not found" for minutes. Public resolvers are used directly to avoid
// the PC's OS negative cache.
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

// Open a tunnel to `port`. Result: { url, link (with token), close() }.
/** @param {number} port @param {{ cfg?: object, onExit?: () => void }} [opts] */
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
    child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (gate.address()).port}`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const url = await new Promise((resolve, reject) => {
      let log = '';
      let found = null;
      const timer = setTimeout(() => reject(new Error('cloudflared gave no URL within 45 seconds')), 45000);
      // The URL appears before the tunnel is ready; wait for the first registered connection so the link opens right away.
      child.stderr.on('data', (d) => {
        log = (log + d).slice(-8000);
        found ??= log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
        if (found && /Registered tunnel connection/.test(log)) (clearTimeout(timer), resolve(found));
      });
      child.once('error', (e) => (clearTimeout(timer), reject(e)));
      child.once('exit', (code) => (clearTimeout(timer), reject(new Error('cloudflared stopped: ' + (log.match(/(?:ERR|error).*$/im)?.[0] || 'exit ' + code)))));
    });
    await waitReady(url);
    child.once('exit', () => (gate.close(), onExit?.()));
    const t = {
      url,
      link: `${url}/?${TOKEN_PARAM}=${token}`,
      port,
      close,
      retarget(p) {
        gate.retarget(p);
        t.port = p;
      },
    };
    return t;
  } catch (e) {
    close();
    throw e;
  }
}
