// snugcode relay — Cloudflare Worker + Durable Objects.
//
// The relay only forwards messages between phones and PCs. Conversations are encrypted
// end-to-end (see shared/crypto.js), so the relay can't read them.
//
//   Hub (1 DO per GitHub account)   : the account's PC list + WebSocket sockets.
//   Pending (1 DO per login code)   : connects a GitHub login in the browser
//                                     with the daemon that's waiting.
import { DurableObject } from 'cloudflare:workers';
import { securityHeaders, PAGE_HEADERS } from './headers.js';

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function randomId(bytes = 12) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(r, (b) => alphabet[b % alphabet.length]).join('');
}

async function hmacKey(env) {
  if (!env.TOKEN_SECRET) throw new Error('TOKEN_SECRET is not set');
  return crypto.subtle.importKey('raw', enc.encode(env.TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signToken(env, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)));
  return body + '.' + b64url(sig);
}
async function verifyToken(env, token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), unb64url(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64url(body)));
    if (p.exp && p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

// Where to go after a user login: the landing page (`/`) or snugcode agent (`/agent/`, default). Only paths from this list,
// so login links can't be used to redirect the token elsewhere (open redirect).
const NEXT = ['/', '/agent/'];
const nextPath = (v) => (NEXT.includes(v) ? v : '/agent/');

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<body style="background:#0b0e14;color:#c9d1d9;font:15px/1.6 ui-monospace,monospace;padding:32px 16px;max-width:560px;margin:auto">` +
      `<h2 style="color:#7ee787">${esc(title)}</h2>${body}</body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', ...PAGE_HEADERS } },
  );
}

// Assets (landing page at `/`, snugcode agent at `/agent/`) via env.ASSETS: security headers are added (assets served directly by the alias worker use _headers).
async function asset(env, request) {
  const res = await env.ASSETS.fetch(request);
  const headers = new Headers(res.headers);
  const hosts = [new URL(request.url).host, env.PUBLIC_URL ? new URL(env.PUBLIC_URL).host : '', ...String(env.LEGACY_HOSTS || '').split(',').map((s) => s.trim())];
  for (const [k, v] of Object.entries(securityHeaders(hosts))) if (!headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Binary PC <-> relay frame: [cid length 1B][cid ASCII][encrypted payload]. The phone only
// sees the payload. The relay doesn't parse the contents (see shared/crypto.js: sealBin/frameWithCid).
function withCid(cid, payload) {
  const id = enc.encode(cid);
  const p = new Uint8Array(payload);
  const out = new Uint8Array(1 + id.length + p.length);
  out[0] = id.length;
  out.set(id, 1);
  out.set(p, 1 + id.length);
  return out.buffer;
}
const dec = new TextDecoder();

const hub = (env, sub) => env.HUB.get(env.HUB.idFromName('u:' + sub));
const pending = (env, code) => env.PENDING.get(env.PENDING.idFromName('p:' + code));
const USER_TTL = 30 * 24 * 3600 * 1000;
// Machine limit per account (PCs + cloud runners): keeps the Hub from growing without bound.
const MAX_MACHINES = 20;
// Machines that die suddenly (codespace stopped, PC unplugged, network gone) don't get to
// close their socket, and Cloudflare may hold that socket indefinitely: the machine looks online forever. The daemon
// sends a `ping` every 25 seconds (answered automatically without waking the DO), so a socket that hasn't pinged for
// this long is considered dead. Can be lowered via the MACHINE_STALE_MS var (tests).
const STALE_MS = 80_000;
// While a phone is connected, machine sockets are checked periodically (alarm) so waiting phones are notified.
const SWEEP_MS = 30_000;

// extra: { kind: 'cloud', provider: 'codespace' | 'container' } for cloud runners (no PC).
async function registerMachine(env, user, name, extra = {}) {
  const mid = randomId(9);
  const r = await hub(env, user.id).fetch('https://hub/register', { method: 'POST', body: JSON.stringify({ mid, name, ...extra }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Failed to register the machine');
  const token = await signToken(env, { kind: 'machine', sub: user.id, login: user.login, mid });
  return { token, mid, login: user.login };
}

/** @returns {Promise<{ id: string, login: string, token: string }>} */
async function githubUser(env, code, redirectUri) {
  const tr = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  const t = await tr.json();
  if (!t.access_token) throw new Error(t.error_description || 'GitHub rejected the login');
  const ur = await fetch('https://api.github.com/user', {
    headers: { authorization: 'Bearer ' + t.access_token, 'user-agent': 'snugcode-relay', accept: 'application/vnd.github+json' },
  });
  if (!ur.ok) throw new Error('Failed to read the GitHub profile');
  const u = await ur.json();
  return { id: String(u.id), login: u.login, token: t.access_token };
}

const MAX_CLOUD = 3;
// Cloud runner: the repo users fork for Codespaces (contains snugcode's .devcontainer).
const runnerRepo = (env) => env.RUNNER_REPO || 'arfakaisar/snugcode';

// A valid user token = correct signature, kind 'user', has an account (sub), and not revoked via
// "Sign out of all devices" (iat before that account's revokedBefore). Old tokens without iat count as 0.
async function userFromToken(env, token) {
  const p = await verifyToken(env, token);
  if (!p || p.kind !== 'user' || !p.sub) return null;
  const r = await hub(env, p.sub).fetch('https://hub/valid?iat=' + (+p.iat || 0));
  return r.ok ? p : null;
}
const authUser = (env, request) => userFromToken(env, (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));

// Per-IP rate limit for endpoints that create state (optional `LIMITER` binding, see wrangler.jsonc).
async function limited(env, request, scope) {
  if (!env.LIMITER) return false;
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const { success } = await env.LIMITER.limit({ key: scope + ':' + ip });
  return !success;
}

// WebSocket token: via the subprotocol `snugcode, t.<token>` (not recorded in URL logs), or `?token=`
// for old clients. The 101 response must select the `snugcode` subprotocol (see Hub /ws).
const WS_PROTO = 'snugcode';
function wsToken(request, url) {
  const protos = (request.headers.get('sec-websocket-protocol') || '').split(',').map((s) => s.trim());
  const t = protos.find((s) => s.startsWith('t.'));
  return t ? t.slice(2) : url.searchParams.get('token');
}

// After the GitHub login: an explicit confirmation (POST + signed token) before the PC is linked to the account.
async function linkPage(env, pc, user) {
  const r = await pending(env, pc).fetch('https://p/peek');
  if (!r.ok) return page('Invalid code', '<p>The PC login code was not found or has expired. Run <code>snugcode setup</code> again.</p>', 404);
  const { name } = await r.json();
  const t = await signToken(env, { kind: 'link', pc, sub: user.id, login: user.login, exp: Date.now() + 10 * 60 * 1000 });
  return page(
    'Connect this PC?',
    `<p>PC <b>${esc(name)}</b> (code <code>${esc(pc)}</code>) wants to be linked to the GitHub account <b>@${esc(user.login)}</b>.</p>` +
      `<p>Only continue if this code matches the one shown in your own PC's terminal. If someone else sent you this link, close this page.</p>` +
      `<form method="post" action="/auth/machine/confirm"><input type="hidden" name="t" value="${esc(t)}">` +
      `<button style="font:inherit;background:#7ee787;color:#0b0e14;padding:10px 16px;border:0;border-radius:8px;font-weight:600;cursor:pointer">Yes, connect this PC</button></form>`,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const devAuth = env.DEV_AUTH === '1';
    const legacy = !!env.PUBLIC_URL && String(env.LEGACY_HOSTS || '').split(',').map((s) => s.trim()).includes(url.host);
    // Login always happens on the main address: a GitHub OAuth App callback may only have one host.
    if (legacy && path === '/auth/login') return Response.redirect(env.PUBLIC_URL + path + url.search, 302);

    if (!devAuth && ['/auth/login', '/auth/machine/start', '/auth/machine/confirm', '/api/machines/provision'].includes(path) && (await limited(env, request, path))) {
      return path.startsWith('/api/') || request.method === 'POST' ? json({ error: 'Too many requests. Try again in a moment.' }, 429) : page('Too many requests', '<p>Try again in a minute.</p>', 429);
    }

    // ---------- Login GitHub (web flow) ----------
    if (path === '/auth/login') {
      // gh: a `codespace`-scoped GitHub token for the PWA (creating & starting Codespaces runners).
      const k = url.searchParams.get('kind');
      const kind = k === 'machine' || k === 'gh' ? k : 'user';
      if (kind === 'gh' && devAuth && !env.GITHUB_CLIENT_ID) return page('Dev mode', '<p>Codespaces runners need a GitHub OAuth App (GITHUB_CLIENT_ID).</p>');
      const pc = url.searchParams.get('pc') || '';
      const next = nextPath(url.searchParams.get('next'));
      // The PC code must still be waiting. The link confirmation is shown AFTER the GitHub login (see linkPage):
      // a confirmation before login could be skipped just by adding a parameter to the link.
      if (kind === 'machine') {
        const r = await pending(env, pc).fetch('https://p/peek');
        if (!r.ok) return page('Invalid code', '<p>The PC login code was not found or has expired. Run <code>snugcode setup</code> again.</p>', 404);
      }
      if (devAuth && !env.GITHUB_CLIENT_ID) {
        return page('Dev mode', `<p>GITHUB_CLIENT_ID is not set. Dev login:</p><form action="/auth/dev/login"><input type="hidden" name="kind" value="${esc(kind)}"><input type="hidden" name="pc" value="${esc(pc)}"><input type="hidden" name="next" value="${esc(next)}"><input name="login" placeholder="username" style="font:inherit;padding:6px"> <button>Sign in</button></form>`);
      }
      // A separate 'state' kind: the state token is visible in the URL and must never pass as a user token.
      const state = await signToken(env, { kind: 'state', for: kind, pc, next, n: randomId(), exp: Date.now() + 10 * 60 * 1000 });
      const gh = new URL('https://github.com/login/oauth/authorize');
      gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
      gh.searchParams.set('redirect_uri', url.origin + '/auth/callback');
      gh.searchParams.set('state', state);
      gh.searchParams.set('scope', kind === 'gh' ? 'codespace' : '');
      // The "Sign up" button on the landing page: people without a GitHub account can create one mid-login.
      gh.searchParams.set('allow_signup', url.searchParams.get('signup') === '1' ? 'true' : 'false');
      return Response.redirect(gh.toString(), 302);
    }

    if (path === '/auth/callback' || (devAuth && path === '/auth/dev/login')) {
      let kind, pc, next, user;
      try {
        if (path === '/auth/callback') {
          const st = await verifyToken(env, url.searchParams.get('state'));
          if (!st || st.kind !== 'state') return page('Login expired', '<p>Please start over.</p>');
          ({ for: kind, pc, next } = st);
          user = await githubUser(env, url.searchParams.get('code'), url.origin + '/auth/callback');
        } else {
          kind = url.searchParams.get('kind');
          if (kind === 'gh') return page('Dev mode', '<p>Codespaces runners need a real GitHub login.</p>');
          pc = url.searchParams.get('pc') || '';
          next = url.searchParams.get('next');
          const login = (url.searchParams.get('login') || '').trim();
          if (!login) return page('Dev login', '<p>Empty username.</p>');
          user = { id: 'dev:' + login, login };
        }
      } catch (e) {
        return page('Login failed', `<p>${esc(e.message)}</p>`);
      }
      if (kind === 'gh') {
        // The token isn't stored by the relay: it's handed to the PWA via the URL fragment (never sent to the server).
        // The PWA still checks the login against its relay account before using it.
        return Response.redirect(url.origin + '/agent/#gh=' + encodeURIComponent(user.token) + '&ghlogin=' + encodeURIComponent(user.login), 302);
      }
      if (kind === 'machine') return linkPage(env, pc, user);
      const token = await signToken(env, { kind: 'user', sub: user.id, login: user.login, iat: Date.now(), exp: Date.now() + USER_TTL });
      return Response.redirect(url.origin + nextPath(next) + '#login=' + encodeURIComponent(token), 302);
    }

    // ---------- Daemon login (waiting code) ----------
    if (path === '/auth/machine/start' && request.method === 'POST') {
      const { name } = await request.json().catch(() => ({}));
      const code = randomCode();
      await pending(env, code).fetch('https://p/init', { method: 'POST', body: JSON.stringify({ name: String(name || 'PC').slice(0, 60) }) });
      return json({ code, url: url.origin + '/auth/login?kind=machine&pc=' + code });
    }
    if (path === '/auth/machine/poll') {
      const code = url.searchParams.get('code') || '';
      const r = await pending(env, code).fetch('https://p/poll');
      return new Response(r.body, r);
    }

    // PC link confirmation (POST from linkPage). The signed `link` token only exists on the page of the
    // user who just signed in, so links/forms from other sites can't link a PC to their account.
    if (path === '/auth/machine/confirm' && request.method === 'POST') {
      const form = await request.formData().catch(() => null);
      const t = await verifyToken(env, String(form?.get('t') || ''));
      if (!t || t.kind !== 'link' || !t.pc || !t.sub) return page('Confirmation expired', '<p>Start again from the link in your PC terminal (<code>snugcode setup</code>).</p>', 400);
      const r = await pending(env, t.pc).fetch('https://p/claim', { method: 'POST' });
      if (!r.ok) return page('Invalid code', '<p>The PC login code was not found, was already used, or has expired. Run <code>snugcode setup</code> again.</p>');
      const { name } = await r.json();
      const user = { id: t.sub, login: t.login };
      let result;
      try {
        result = await registerMachine(env, user, name);
      } catch (e) {
        return page('PC could not be added', `<p>${esc(e.message)}</p>`, 409);
      }
      await pending(env, t.pc).fetch('https://p/result', { method: 'POST', body: JSON.stringify(result) });
      return page('PC connected ✓', `<p>PC <b>${esc(name)}</b> is now connected to the account <b>@${esc(user.login)}</b>.</p><p>Go back to the terminal to finish setup. You can close this tab.</p>`);
    }

    // ---------- API for the PWA ----------
    if (path === '/api/me') {
      const u = await authUser(env, request);
      return u ? json({ login: u.login }) : json({ error: 'unauthorized' }, 401);
    }
    // Extend a login that's still active (the PWA calls this when opened): without it the phone would have to sign in
    // again every 30 days even when used daily. Revoked tokens (logout-all) can't be extended.
    if (path === '/api/renew' && request.method === 'POST') {
      const u = await authUser(env, request);
      if (!u) return json({ error: 'unauthorized' }, 401);
      return json({ token: await signToken(env, { kind: 'user', sub: u.sub, login: u.login, iat: Date.now(), exp: Date.now() + USER_TTL }) });
    }
    if (path === '/api/machines') {
      const u = await authUser(env, request);
      if (!u) return json({ error: 'unauthorized' }, 401);
      const r = await hub(env, u.sub).fetch('https://hub/machines');
      return new Response(r.body, r);
    }
    // Cloud runner: register a machine without a browser login from the machine itself. The machine token is returned
    // to the PWA, which stores it as a Codespaces secret (encrypted on the phone) for the runner.
    if (path === '/api/machines/provision' && request.method === 'POST') {
      const u = await authUser(env, request);
      if (!u) return json({ error: 'unauthorized' }, 401);
      const body = await request.json().catch(() => ({}));
      const provider = body.provider === 'container' ? 'container' : 'codespace';
      const name = String(body.name || 'Cloud').trim().slice(0, 60) || 'Cloud';
      const { machines } = await (await hub(env, u.sub).fetch('https://hub/machines')).json();
      if (machines.filter((m) => m.kind === 'cloud').length >= MAX_CLOUD) return json({ error: `At most ${MAX_CLOUD} cloud runners per account. Remove an old one first.` }, 409);
      try {
        return json(await registerMachine(env, { id: u.sub, login: u.login }, name, { kind: 'cloud', provider }));
      } catch (e) {
        return json({ error: e.message }, 409);
      }
    }
    // Revoke every login token of this account (every phone/browser must sign in again). PC pairings don't change.
    if (path === '/api/logout-all' && request.method === 'POST') {
      const u = await authUser(env, request);
      if (!u) return json({ error: 'unauthorized' }, 401);
      const r = await hub(env, u.sub).fetch('https://hub/revoke', { method: 'POST' });
      return new Response(r.body, r);
    }
    // A cloud runner that's setting itself up (codespace: installing packages, starting the daemon) reports
    // its stage with its own machine token; the PWA shows it while the runner isn't connected yet.
    if (path === '/api/runner/status' && request.method === 'POST') {
      const h = request.headers.get('authorization') || '';
      const p = await verifyToken(env, h.replace(/^Bearer\s+/i, ''));
      if (!p || p.kind !== 'machine' || !p.sub || !p.mid) return json({ error: 'unauthorized' }, 401);
      const body = await request.json().catch(() => ({}));
      const boot = { stage: String(body.stage || '').slice(0, 20), step: String(body.step || '').slice(0, 20), msg: String(body.msg || '').slice(0, 400), at: Date.now() };
      const r = await hub(env, p.sub).fetch('https://hub/boot', { method: 'POST', body: JSON.stringify({ mid: p.mid, boot }) });
      return new Response(r.body, r);
    }
    if (path.startsWith('/api/machines/') && request.method === 'DELETE') {
      const u = await authUser(env, request);
      if (!u) return json({ error: 'unauthorized' }, 401);
      const mid = path.split('/').pop();
      await hub(env, u.sub).fetch('https://hub/remove', { method: 'POST', body: JSON.stringify({ mid }) });
      return json({ ok: true });
    }

    // ---------- WebSocket ----------
    if (path === '/ws/machine' || path === '/ws/phone') {
      if (request.headers.get('upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
      if (path === '/ws/machine') {
        const p = await verifyToken(env, wsToken(request, url));
        if (!p || p.kind !== 'machine' || !p.sub || !p.mid) return json({ error: 'unauthorized' }, 401);
        return hub(env, p.sub).fetch(new Request('https://hub/ws?role=m&mid=' + encodeURIComponent(p.mid), request));
      }
      const p = await userFromToken(env, wsToken(request, url));
      if (!p) return json({ error: 'unauthorized' }, 401);
      const mid = url.searchParams.get('mid') || '';
      return hub(env, p.sub).fetch(new Request('https://hub/ws?role=p&mid=' + encodeURIComponent(mid), request));
    }

    if (path === '/api/health') return json({ ok: true, devAuth, wsProto: 1, runnerRepo: runnerRepo(env), ...(legacy ? { legacy: true, publicUrl: env.PUBLIC_URL } : {}) });
    return asset(env, request);
  },
};

export class Pending extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const st = this.ctx.storage;
    /** @type {{ name: string, at: number, claimed?: boolean, result?: object } | undefined} */
    const rec = await st.get('rec');
    const expired = !rec || Date.now() - rec.at > 15 * 60 * 1000;
    if (path === '/init') {
      const { name } = await request.json();
      await st.put('rec', { name, at: Date.now() });
      await st.setAlarm(Date.now() + 20 * 60 * 1000);
      return json({ ok: true });
    }
    if (expired) return json({ status: 'expired' }, 404);
    if (path === '/peek') return rec.claimed ? json({ error: 'already used' }, 409) : json({ name: rec.name });
    if (path === '/claim') {
      if (rec.claimed) return json({ error: 'already used' }, 409);
      await st.put('rec', { ...rec, claimed: true });
      return json({ name: rec.name });
    }
    if (path === '/result') {
      await st.put('rec', { ...rec, result: await request.json() });
      return json({ ok: true });
    }
    if (path === '/poll') {
      if (!rec.result) return json({ status: 'pending' });
      await st.deleteAll();
      return json({ status: 'ok', ...rec.result });
    }
    return json({ error: 'not found' }, 404);
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keepalive without waking the DO (saves quota).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async machines() {
    return (await this.ctx.storage.get('machines')) || {};
  }

  get staleMs() {
    return +(/** @type {any} */ (this.env).MACHINE_STALE_MS) || STALE_MS;
  }

  // Machine sockets that are still alive (last ping is recent). Dead sockets are closed; if a machine ends up
  // with no live socket at all, it's recorded as offline and waiting phones are notified.
  async live(mid, now = Date.now()) {
    const alive = [];
    let last = 0;
    for (const ws of this.ctx.getWebSockets('m:' + mid)) {
      if (ws.readyState !== 1) continue; // not OPEN: already closed, just waiting for close
      const t = Math.max(this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0, ws.deserializeAttachment()?.at || 0);
      if (now - t <= this.staleMs) {
        alive.push(ws);
        continue;
      }
      last = Math.max(last, t);
      ws.serializeAttachment({ ...ws.deserializeAttachment(), stale: 1 });
      try {
        ws.close(4006, 'stale');
      } catch {}
    }
    if (last && !alive.length) await this.offline(mid, last);
    return alive;
  }

  async online(mid) {
    return (await this.live(mid)).length > 0;
  }

  async offline(mid, at = Date.now()) {
    const machines = await this.machines();
    if (machines[mid]) {
      machines[mid].lastSeen = at;
      await this.ctx.storage.put('machines', machines);
    }
    for (const p of this.ctx.getWebSockets('p:' + mid)) p.send(JSON.stringify({ t: 'status', online: false }));
  }

  async scheduleSweep() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + Math.min(SWEEP_MS, this.staleMs));
  }

  async alarm() {
    const mids = new Set(this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment()).filter((a) => a?.role === 'p').map((a) => a.mid));
    for (const mid of mids) await this.live(mid);
    if (mids.size) await this.scheduleSweep();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const machines = await this.machines();

    if (url.pathname === '/register') {
      const { mid, name, kind, provider } = await request.json();
      if (Object.keys(machines).length >= MAX_MACHINES) return json({ error: `At most ${MAX_MACHINES} machines per account. Remove old machines from the app first.` }, 409);
      machines[mid] = { name, createdAt: Date.now(), lastSeen: null, ...(kind === 'cloud' ? { kind, provider } : {}) };
      await this.ctx.storage.put('machines', machines);
      return json({ ok: true });
    }
    if (url.pathname === '/valid') {
      const before = Number(await this.ctx.storage.get('revokedBefore')) || 0;
      return (+url.searchParams.get('iat') || 0) >= before ? json({ ok: true }) : json({ error: 'revoked' }, 401);
    }
    if (url.pathname === '/revoke') {
      await this.ctx.storage.put('revokedBefore', Date.now());
      // Phones currently connected are asked to sign in again right away.
      for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment()?.role === 'p') ws.close(4005, 'logged-out');
      return json({ ok: true });
    }
    if (url.pathname === '/machines') {
      const online = {};
      for (const id of Object.keys(machines)) online[id] = await this.online(id);
      // live() may record lastSeen of a machine just found dead: read again.
      const now = await this.machines();
      const list = Object.entries(now).map(([id, m]) => ({ id, name: m.name, online: !!online[id], lastSeen: m.lastSeen, kind: m.kind || 'pc', provider: m.provider || null, createdAt: m.createdAt, boot: m.boot || null }));
      return json({ machines: list });
    }
    if (url.pathname === '/boot') {
      const { mid, boot } = await request.json();
      if (!machines[mid]) return json({ error: 'PC not registered' }, 404);
      machines[mid].boot = boot;
      await this.ctx.storage.put('machines', machines);
      return json({ ok: true });
    }
    if (url.pathname === '/remove') {
      const { mid } = await request.json();
      delete machines[mid];
      await this.ctx.storage.put('machines', machines);
      for (const ws of [...this.ctx.getWebSockets('m:' + mid), ...this.ctx.getWebSockets('p:' + mid)]) ws.close(4003, 'removed');
      return json({ ok: true });
    }
    if (url.pathname === '/ws') {
      const role = url.searchParams.get('role');
      const mid = url.searchParams.get('mid');
      if (!machines[mid]) return json({ error: 'PC not registered' }, 404);
      const [client, server] = Object.values(new WebSocketPair());
      if (role === 'm') {
        for (const old of this.ctx.getWebSockets('m:' + mid)) old.close(4000, 'replaced');
        this.ctx.acceptWebSocket(server, ['m:' + mid]);
        server.serializeAttachment({ role: 'm', mid, at: Date.now() });
        // This relay forwards binary frames (old daemons ignore this message).
        server.send(JSON.stringify({ t: 'hello', bin: 1 }));
        // Tell the PC about phones already waiting, and the phones that the PC is online.
        for (const p of this.ctx.getWebSockets('p:' + mid)) {
          const { cid } = p.deserializeAttachment();
          server.send(JSON.stringify({ t: 'open', cid }));
          p.send(JSON.stringify({ t: 'status', online: true, bin: 1 }));
        }
      } else {
        const cid = randomId(9);
        this.ctx.acceptWebSocket(server, ['p:' + mid, 'c:' + cid]);
        server.serializeAttachment({ role: 'p', mid, cid });
        const live = await this.live(mid);
        server.send(JSON.stringify({ t: 'status', online: live.length > 0, name: machines[mid].name, bin: 1 }));
        for (const m of live) m.send(JSON.stringify({ t: 'open', cid }));
        await this.scheduleSweep();
      }
      const proto = (request.headers.get('sec-websocket-protocol') || '').split(',').some((x) => x.trim() === WS_PROTO);
      return new Response(null, { status: 101, webSocket: client, ...(proto ? { headers: { 'sec-websocket-protocol': WS_PROTO } } : {}) });
    }
    return json({ error: 'not found' }, 404);
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment();
    if (typeof message !== 'string') {
      if (att.role === 'p') {
        const frame = withCid(att.cid, message);
        for (const m of await this.live(att.mid)) m.send(frame);
        return;
      }
      const b = new Uint8Array(message);
      const cid = dec.decode(b.subarray(1, 1 + b[0]));
      const target = this.ctx.getWebSockets('c:' + cid)[0];
      if (target) target.send(b.slice(1 + b[0]).buffer);
      else ws.send(JSON.stringify({ t: 'close', cid }));
      return;
    }
    if (att.role === 'p') {
      for (const m of await this.live(att.mid)) m.send(JSON.stringify({ t: 'd', cid: att.cid, d: message }));
      return;
    }
    let f;
    try {
      f = JSON.parse(message);
    } catch {
      return;
    }
    const target = this.ctx.getWebSockets('c:' + f.cid)[0];
    if (!target) {
      if (f.t === 'd') ws.send(JSON.stringify({ t: 'close', cid: f.cid }));
      return;
    }
    if (f.t === 'd') target.send(f.d);
    else if (f.t === 'x') target.close(4001, String(f.reason || 'closed').slice(0, 100));
  }

  async webSocketClose(ws) {
    await this.gone(ws);
  }
  async webSocketError(ws) {
    await this.gone(ws);
  }

  async gone(ws) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    if (att.role === 'p') {
      for (const m of this.ctx.getWebSockets('m:' + att.mid)) m.send(JSON.stringify({ t: 'close', cid: att.cid }));
      return;
    }
    // Sockets closed by live() for being dead: their offline status was already recorded there.
    if (att.stale) return;
    if ((await this.live(att.mid)).some((s) => s !== ws)) return;
    await this.offline(att.mid);
  }
}
