// Local dev relay for tests & contributors: `npm run dev:relay` (http://127.0.0.1:8787, PWA at /agent/).
//
// It speaks the same wire protocol as the hosted relay at snugcode.dev, so the daemon, the PWA (web/conn.js), and
// the e2e tests run against it unchanged. It is deliberately small: one process, in memory (state is lost on
// exit), loopback only, and dev sign-in by username (no GitHub OAuth). It is not the hosted relay and is not meant
// to be deployed.
//
//   node test/dev-relay.mjs [--port 8787]      (or PORT=8787; SNUGCODE_WEB_OUT = the built PWA, default dist/web)
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { securityHeaders, PAGE_HEADERS } from '../shared/headers.js';

const root = path.resolve(import.meta.dirname, '..');
const arg = process.argv.indexOf('--port');
const PORT = +(arg > 0 ? process.argv[arg + 1] : process.env.PORT) || 8787;
const WEB = path.resolve(process.env.SNUGCODE_WEB_OUT || path.join(root, 'dist', 'web'));
const SECRET = crypto.randomBytes(32);
const USER_TTL = 30 * 24 * 3600 * 1000;
const MAX_MACHINES = 20;
const MAX_CLOUD = 3;
const WS_PROTO = 'snugcode';

// ---------- tokens (same shape as the hosted relay: base64url(JSON).base64url(HMAC)) ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + b64u(crypto.createHmac('sha256', SECRET).update(body).digest());
}
function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp && p.exp < Date.now() ? null : p;
  } catch {
    return null;
  }
}
const randomId = (n = 9) => crypto.randomBytes(n).toString('base64url');
const randomCode = () => Array.from(crypto.randomBytes(8), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

// ---------- state ----------
/** @type {Map<string, { machines: Map<string, any>, revokedBefore: number }>} */
const accounts = new Map();
/** @type {Map<string, { name: string, at: number, claimed?: boolean, result?: object }>} */
const pending = new Map();
/** mid -> { m: machine socket | null, phones: Map<cid, socket> } */
const links = new Map();
const account = (sub) => accounts.get(sub) || accounts.set(sub, { machines: new Map(), revokedBefore: 0 }).get(sub);
const link = (mid) => links.get(mid) || links.set(mid, { m: null, phones: new Map() }).get(mid);
const userFrom = (token) => {
  const p = verify(token);
  return p && p.kind === 'user' && p.sub && (+p.iat || 0) >= account(p.sub).revokedBefore ? p : null;
};
function registerMachine(user, name, extra = {}) {
  const acc = account(user.id);
  if (acc.machines.size >= MAX_MACHINES) throw new Error(`At most ${MAX_MACHINES} machines per account. Remove old machines from the app first.`);
  const mid = randomId();
  acc.machines.set(mid, { name, createdAt: Date.now(), lastSeen: null, ...extra });
  return { token: sign({ kind: 'machine', sub: user.id, login: user.login, mid }), mid, login: user.login };
}

// ---------- HTTP ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const send = (res, status, body, headers) => (res.writeHead(status, headers), res.end(body));
const json = (res, data, status = 200) => send(res, status, JSON.stringify(data), { 'content-type': 'application/json', 'cache-control': 'no-store' });
const page = (res, title, body, status = 200) =>
  send(res, status, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:15px/1.6 ui-monospace,monospace;padding:32px 16px;max-width:560px;margin:auto"><h2>${esc(title)}</h2>${body}</body>`, { 'content-type': 'text/html; charset=utf-8', ...PAGE_HEADERS });
const redirect = (res, to) => send(res, 302, '', { location: to });
const nextPath = (v) => (v === '/' || v === '/agent/' ? v : '/agent/');
const readBody = (req) => new Promise((r) => {
  let s = '';
  req.on('data', (d) => (s += d)).on('end', () => r(s));
});
const readJson = async (req) => {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    return {};
  }
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.sh': 'text/plain', '.ps1': 'text/plain' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') return redirect(res, '/agent/');
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(WEB, p);
  if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return fs.existsSync(WEB) ? send(res, 404, 'not found') : send(res, 404, 'PWA not built: run `npm run build:web` first');
  }
  send(res, 200, fs.readFileSync(file), { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...securityHeaders([url.host]) });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = (k) => url.searchParams.get(k) || '';
  const p = url.pathname;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  // ---------- dev sign-in (instead of GitHub OAuth) ----------
  if (p === '/auth/login') {
    const kind = q('kind') === 'machine' ? 'machine' : 'user';
    if (kind === 'machine' && !pending.has(q('pc'))) return page(res, 'Invalid code', '<p>The PC login code was not found or has expired.</p>', 404);
    if (q('kind') === 'gh') return page(res, 'Dev relay', '<p>Codespaces runners need the hosted relay (a real GitHub login).</p>');
    return page(res, 'Dev sign-in', `<form action="/auth/dev/login"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="pc" value="${esc(q('pc'))}"><input type="hidden" name="next" value="${esc(nextPath(q('next')))}"><input name="login" placeholder="username"> <button>Sign in</button></form>`);
  }
  if (p === '/auth/dev/login') {
    const login = q('login').trim();
    if (!login) return page(res, 'Dev sign-in', '<p>Empty username.</p>');
    const user = { id: 'dev:' + login, login };
    if (q('kind') === 'machine') {
      const rec = pending.get(q('pc'));
      if (!rec || rec.claimed) return page(res, 'Invalid code', '<p>The PC login code was not found or was already used.</p>', 404);
      const t = sign({ kind: 'link', pc: q('pc'), sub: user.id, login, exp: Date.now() + 10 * 60 * 1000 });
      return page(res, 'Connect this PC?', `<p>PC <b>${esc(rec.name)}</b> → <b>@${esc(login)}</b></p><form method="post" action="/auth/machine/confirm"><input type="hidden" name="t" value="${esc(t)}"><button>Yes, connect this PC</button></form>`);
    }
    const token = sign({ kind: 'user', sub: user.id, login, iat: Date.now(), exp: Date.now() + USER_TTL });
    return redirect(res, nextPath(q('next')) + '#login=' + encodeURIComponent(token));
  }

  // ---------- daemon linking ----------
  if (p === '/auth/machine/start' && req.method === 'POST') {
    const { name } = await readJson(req);
    const code = randomCode();
    pending.set(code, { name: String(name || 'PC').slice(0, 60), at: Date.now() });
    return json(res, { code, url: url.origin + '/auth/login?kind=machine&pc=' + code });
  }
  if (p === '/auth/machine/poll') {
    const rec = pending.get(q('code'));
    if (!rec || Date.now() - rec.at > 15 * 60 * 1000) return json(res, { status: 'expired' }, 404);
    if (!rec.result) return json(res, { status: 'pending' });
    pending.delete(q('code'));
    return json(res, { status: 'ok', ...rec.result });
  }
  if (p === '/auth/machine/confirm' && req.method === 'POST') {
    const t = verify(new URLSearchParams(await readBody(req)).get('t'));
    const rec = t?.kind === 'link' && pending.get(t.pc);
    if (!rec || rec.claimed) return page(res, 'Confirmation expired', '<p>Run <code>snugcode setup</code> again.</p>', 400);
    rec.claimed = true;
    try {
      rec.result = registerMachine({ id: t.sub, login: t.login }, rec.name);
    } catch (e) {
      return page(res, 'PC could not be added', `<p>${esc(e.message)}</p>`, 409);
    }
    return page(res, 'PC connected ✓', `<p>PC <b>${esc(rec.name)}</b> is now connected to <b>@${esc(t.login)}</b>.</p>`);
  }

  // ---------- API for the PWA ----------
  if (p === '/api/health') return json(res, { ok: true, devAuth: true, wsProto: 1, runnerRepo: 'arfakaisar/snugcode' });
  if (p === '/api/runner/status' && req.method === 'POST') {
    const m = verify(bearer);
    const machine = m?.kind === 'machine' && account(m.sub).machines.get(m.mid);
    if (!machine) return json(res, { error: 'unauthorized' }, 401);
    const b = await readJson(req);
    machine.boot = { stage: String(b.stage || '').slice(0, 20), step: String(b.step || '').slice(0, 20), msg: String(b.msg || '').slice(0, 400), at: Date.now() };
    return json(res, { ok: true });
  }
  // A daemon swaps its machine token for a freshly signed one (signing-key rotation, see the hosted relay).
  if (p === '/api/machine/renew' && req.method === 'POST') {
    const m = verify(bearer);
    if (!(m?.kind === 'machine' && account(m.sub).machines.get(m.mid))) return json(res, { error: 'unauthorized' }, 401);
    return json(res, { token: sign({ kind: 'machine', sub: m.sub, login: m.login, mid: m.mid, iat: Date.now() }) });
  }
  if (p.startsWith('/api/')) {
    const u = userFrom(bearer);
    if (!u) return json(res, { error: 'unauthorized' }, 401);
    const acc = account(u.sub);
    if (p === '/api/me') return json(res, { login: u.login });
    if (p === '/api/renew' && req.method === 'POST') return json(res, { token: sign({ kind: 'user', sub: u.sub, login: u.login, iat: Date.now(), exp: Date.now() + USER_TTL }) });
    if (p === '/api/machines') {
      const machines = [...acc.machines].map(([id, m]) => ({ id, name: m.name, online: !!links.get(id)?.m, lastSeen: m.lastSeen, kind: m.kind || 'pc', provider: m.provider || null, createdAt: m.createdAt, boot: m.boot || null }));
      return json(res, { machines });
    }
    if (p === '/api/machines/provision' && req.method === 'POST') {
      const b = await readJson(req);
      if ([...acc.machines.values()].filter((m) => m.kind === 'cloud').length >= MAX_CLOUD) return json(res, { error: `At most ${MAX_CLOUD} cloud runners per account. Remove an old one first.` }, 409);
      const name = String(b.name || 'Cloud').trim().slice(0, 60) || 'Cloud';
      try {
        return json(res, registerMachine({ id: u.sub, login: u.login }, name, { kind: 'cloud', provider: b.provider === 'container' ? 'container' : 'codespace' }));
      } catch (e) {
        return json(res, { error: e.message }, 409);
      }
    }
    if (p === '/api/logout-all' && req.method === 'POST') {
      acc.revokedBefore = Date.now();
      for (const mid of acc.machines.keys()) for (const ws of links.get(mid)?.phones.values() || []) ws.close(4005, 'logged-out');
      return json(res, { ok: true });
    }
    if (p.startsWith('/api/machines/') && req.method === 'DELETE') {
      const mid = p.split('/').pop();
      acc.machines.delete(mid);
      const l = links.get(mid);
      l?.m?.close(4003, 'removed');
      for (const ws of l?.phones.values() || []) ws.close(4003, 'removed');
      return json(res, { ok: true });
    }
    return json(res, { error: 'not found' }, 404);
  }
  serveStatic(req, res, url);
});

// ---------- WebSocket: machine <-> phones, frames forwarded as they are ----------
const wss = new WebSocketServer({ noServer: true, handleProtocols: (protos) => (protos.has(WS_PROTO) ? WS_PROTO : false) });
const frameWithCid = (cid, payload) => Buffer.concat([Buffer.from([cid.length]), Buffer.from(cid), payload]);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
  const token = protos.find((s) => s.startsWith('t.'))?.slice(2) || url.searchParams.get('token');
  const reject = (code, msg) => (socket.end(`HTTP/1.1 ${code} ${msg}\r\n\r\n`), undefined);
  let role, sub, mid;
  if (url.pathname === '/ws/machine') {
    const m = verify(token);
    if (m?.kind !== 'machine') return reject(401, 'Unauthorized');
    [role, sub, mid] = ['m', m.sub, m.mid];
  } else if (url.pathname === '/ws/phone') {
    const u = userFrom(token);
    if (!u) return reject(401, 'Unauthorized');
    [role, sub, mid] = ['p', u.sub, url.searchParams.get('mid') || ''];
  } else return reject(404, 'Not Found');
  const machine = account(sub).machines.get(mid);
  if (!machine) return reject(404, 'Not Found');
  wss.handleUpgrade(req, socket, head, (ws) => (role === 'm' ? onMachine(ws, mid, machine) : onPhone(ws, mid, machine)));
});

function onMachine(ws, mid, machine) {
  const l = link(mid);
  l.m?.close(4000, 'replaced');
  l.m = ws;
  ws.send(JSON.stringify({ t: 'hello', bin: 1 }));
  for (const [cid, p] of l.phones) {
    ws.send(JSON.stringify({ t: 'open', cid }));
    p.send(JSON.stringify({ t: 'status', online: true, bin: 1 }));
  }
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const b = Buffer.from(/** @type {Buffer} */ (data));
      const cid = b.subarray(1, 1 + b[0]).toString();
      const target = l.phones.get(cid);
      return target ? target.send(b.subarray(1 + b[0])) : ws.send(JSON.stringify({ t: 'close', cid }));
    }
    const text = data.toString();
    if (text === 'ping') return ws.send('pong');
    let f;
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    const target = l.phones.get(f.cid);
    if (!target) return f.t === 'd' && ws.send(JSON.stringify({ t: 'close', cid: f.cid }));
    if (f.t === 'd') target.send(f.d);
    else if (f.t === 'x') target.close(4001, String(f.reason || 'closed').slice(0, 100));
  });
  ws.on('close', () => {
    if (l.m !== ws) return;
    l.m = null;
    machine.lastSeen = Date.now();
    for (const p of l.phones.values()) p.send(JSON.stringify({ t: 'status', online: false }));
  });
}

function onPhone(ws, mid, machine) {
  const l = link(mid);
  const cid = randomId();
  l.phones.set(cid, ws);
  ws.send(JSON.stringify({ t: 'status', online: !!l.m, name: machine.name, bin: 1 }));
  l.m?.send(JSON.stringify({ t: 'open', cid }));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return l.m?.send(frameWithCid(cid, Buffer.from(/** @type {Buffer} */ (data))));
    const text = data.toString();
    if (text === 'ping') return ws.send('pong');
    l.m?.send(JSON.stringify({ t: 'd', cid, d: text }));
  });
  ws.on('close', () => {
    l.phones.delete(cid);
    l.m?.send(JSON.stringify({ t: 'close', cid }));
  });
}

// Loopback only: this relay has no real sign-in.
server.listen(PORT, '127.0.0.1', () => console.log(`dev relay at http://127.0.0.1:${PORT} (PWA at /agent/ from ${path.relative(root, WEB) || WEB})`));
