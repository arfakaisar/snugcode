// snugcode relay — Cloudflare Worker + Durable Objects.
//
// Relay hanya meneruskan pesan antara HP dan PC. Isi percakapan dienkripsi
// end-to-end (lihat shared/crypto.js), jadi relay tidak bisa membacanya.
//
//   Hub (1 DO per akun GitHub)   : daftar PC milik akun + soket WebSocket.
//   Pending (1 DO per kode login) : menghubungkan login GitHub di browser
//                                   dengan daemon yang sedang menunggu.
import { DurableObject } from 'cloudflare:workers';

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
  if (!env.TOKEN_SECRET) throw new Error('TOKEN_SECRET belum di-set');
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

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function page(title, body) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<body style="background:#0b0e14;color:#c9d1d9;font:15px/1.6 ui-monospace,monospace;padding:32px 16px;max-width:560px;margin:auto">` +
      `<h2 style="color:#7ee787">${esc(title)}</h2>${body}</body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

// Frame biner PC <-> relay: [panjang cid 1B][cid ASCII][payload terenkripsi]. HP hanya
// melihat payload. Relay tidak mem-parse isi (lihat shared/crypto.js: sealBin/frameWithCid).
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

// extra: { kind: 'cloud', provider: 'codespace' | 'container' } untuk runner cloud (tanpa PC).
async function registerMachine(env, user, name, extra = {}) {
  const mid = randomId(9);
  await hub(env, user.id).fetch('https://hub/register', { method: 'POST', body: JSON.stringify({ mid, name, ...extra }) });
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
  if (!t.access_token) throw new Error(t.error_description || 'GitHub menolak login');
  const ur = await fetch('https://api.github.com/user', {
    headers: { authorization: 'Bearer ' + t.access_token, 'user-agent': 'snugcode-relay', accept: 'application/vnd.github+json' },
  });
  if (!ur.ok) throw new Error('Gagal membaca profil GitHub');
  const u = await ur.json();
  return { id: String(u.id), login: u.login, token: t.access_token };
}

const MAX_CLOUD = 3;
// Runner cloud: repo yang di-fork pengguna untuk Codespaces (berisi .devcontainer snugcode).
const runnerRepo = (env) => env.RUNNER_REPO || 'arfakaisar/snugcode';

async function authUser(env, request) {
  const h = request.headers.get('authorization') || '';
  const p = await verifyToken(env, h.replace(/^Bearer\s+/i, ''));
  return p && p.kind === 'user' ? p : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const devAuth = env.DEV_AUTH === '1';
    const legacy = !!env.PUBLIC_URL && String(env.LEGACY_HOSTS || '').split(',').map((s) => s.trim()).includes(url.host);
    // Login selalu di alamat utama: callback OAuth App GitHub hanya boleh satu host.
    if (legacy && path === '/auth/login') return Response.redirect(env.PUBLIC_URL + path + url.search, 302);

    // ---------- Login GitHub (web flow) ----------
    if (path === '/auth/login') {
      // gh: token GitHub ber-scope `codespace` untuk PWA (membuat & menyalakan runner Codespaces).
      const k = url.searchParams.get('kind');
      const kind = k === 'machine' || k === 'gh' ? k : 'user';
      if (kind === 'gh' && devAuth && !env.GITHUB_CLIENT_ID) return page('Mode dev', '<p>Runner Codespaces butuh OAuth App GitHub (GITHUB_CLIENT_ID).</p>');
      const pc = url.searchParams.get('pc') || '';
      if (devAuth && !env.GITHUB_CLIENT_ID) {
        return page('Mode dev', `<p>GITHUB_CLIENT_ID belum di-set. Login dev:</p><form action="/auth/dev/login"><input type="hidden" name="kind" value="${esc(kind)}"><input type="hidden" name="pc" value="${esc(pc)}"><input name="login" placeholder="username" style="font:inherit;padding:6px"> <button>Masuk</button></form>`);
      }
      const state = await signToken(env, { kind, pc, n: randomId(), exp: Date.now() + 10 * 60 * 1000 });
      const gh = new URL('https://github.com/login/oauth/authorize');
      gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
      gh.searchParams.set('redirect_uri', url.origin + '/auth/callback');
      gh.searchParams.set('state', state);
      gh.searchParams.set('scope', kind === 'gh' ? 'codespace' : '');
      gh.searchParams.set('allow_signup', 'false');
      return Response.redirect(gh.toString(), 302);
    }

    if (path === '/auth/callback' || (devAuth && path === '/auth/dev/login')) {
      let kind, pc, user;
      try {
        if (path === '/auth/callback') {
          const st = await verifyToken(env, url.searchParams.get('state'));
          if (!st) return page('Login kedaluwarsa', '<p>Silakan ulangi dari awal.</p>');
          ({ kind, pc } = st);
          user = await githubUser(env, url.searchParams.get('code'), url.origin + '/auth/callback');
        } else {
          kind = url.searchParams.get('kind');
          if (kind === 'gh') return page('Mode dev', '<p>Runner Codespaces butuh login GitHub asli.</p>');
          pc = url.searchParams.get('pc') || '';
          const login = (url.searchParams.get('login') || '').trim();
          if (!login) return page('Login dev', '<p>Username kosong.</p>');
          user = { id: 'dev:' + login, login };
        }
      } catch (e) {
        return page('Login gagal', `<p>${esc(e.message)}</p>`);
      }
      if (kind === 'gh') {
        // Token tidak disimpan relay: diteruskan ke PWA lewat fragmen URL (tidak pernah dikirim ke server).
        // Login tetap diperiksa PWA terhadap akun relay-nya sebelum dipakai.
        return Response.redirect(url.origin + '/#gh=' + encodeURIComponent(user.token) + '&ghlogin=' + encodeURIComponent(user.login), 302);
      }
      if (kind === 'machine') {
        const r = await pending(env, pc).fetch('https://p/claim', { method: 'POST', body: JSON.stringify({ user }) });
        if (!r.ok) return page('Kode tidak valid', '<p>Kode login PC tidak ditemukan atau kedaluwarsa. Jalankan ulang <code>snugcode setup</code>.</p>');
        const { name } = await r.json();
        const result = await registerMachine(env, user, name);
        await pending(env, pc).fetch('https://p/result', { method: 'POST', body: JSON.stringify(result) });
        return page('PC terhubung ✓', `<p>PC <b>${esc(name)}</b> sekarang terhubung ke akun <b>@${esc(user.login)}</b>.</p><p>Kembali ke terminal untuk menyelesaikan setup. Tab ini boleh ditutup.</p>`);
      }
      const token = await signToken(env, { kind: 'user', sub: user.id, login: user.login, exp: Date.now() + USER_TTL });
      return Response.redirect(url.origin + '/#login=' + encodeURIComponent(token), 302);
    }

    // ---------- Login daemon (kode menunggu) ----------
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

    // ---------- API untuk PWA ----------
    if (path === '/api/me') {
      const u = await authUser(env, request);
      return u ? json({ login: u.login }) : json({ error: 'unauthorized' }, 401);
    }
    if (path === '/api/machines') {
      const u = await authUser(env, request);
      if (!u) return json({ error: 'unauthorized' }, 401);
      const r = await hub(env, u.sub).fetch('https://hub/machines');
      return new Response(r.body, r);
    }
    // Runner cloud: daftarkan mesin tanpa login browser dari mesin itu sendiri. Token mesin dikembalikan
    // ke PWA, yang menyimpannya sebagai Codespaces secret (terenkripsi di HP) untuk runner.
    if (path === '/api/machines/provision' && request.method === 'POST') {
      const u = await authUser(env, request);
      if (!u) return json({ error: 'unauthorized' }, 401);
      const body = await request.json().catch(() => ({}));
      const provider = body.provider === 'container' ? 'container' : 'codespace';
      const name = String(body.name || 'Cloud').trim().slice(0, 60) || 'Cloud';
      const { machines } = await (await hub(env, u.sub).fetch('https://hub/machines')).json();
      if (machines.filter((m) => m.kind === 'cloud').length >= MAX_CLOUD) return json({ error: `Maksimal ${MAX_CLOUD} runner cloud per akun. Hapus yang lama dulu.` }, 409);
      return json(await registerMachine(env, { id: u.sub, login: u.login }, name, { kind: 'cloud', provider }));
    }
    // Runner cloud yang sedang menyiapkan diri (codespace: pasang paket, menyalakan daemon) melaporkan
    // tahapnya dengan token mesinnya sendiri; PWA menampilkannya selama runner belum tersambung.
    if (path === '/api/runner/status' && request.method === 'POST') {
      const h = request.headers.get('authorization') || '';
      const p = await verifyToken(env, h.replace(/^Bearer\s+/i, ''));
      if (!p || p.kind !== 'machine') return json({ error: 'unauthorized' }, 401);
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
      const p = await verifyToken(env, url.searchParams.get('token'));
      if (path === '/ws/machine') {
        if (!p || p.kind !== 'machine') return json({ error: 'unauthorized' }, 401);
        return hub(env, p.sub).fetch(new Request('https://hub/ws?role=m&mid=' + encodeURIComponent(p.mid), request));
      }
      if (!p || p.kind !== 'user') return json({ error: 'unauthorized' }, 401);
      const mid = url.searchParams.get('mid') || '';
      return hub(env, p.sub).fetch(new Request('https://hub/ws?role=p&mid=' + encodeURIComponent(mid), request));
    }

    if (path === '/api/health') return json({ ok: true, devAuth, runnerRepo: runnerRepo(env), ...(legacy ? { legacy: true, publicUrl: env.PUBLIC_URL } : {}) });
    return env.ASSETS.fetch(request);
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
    if (path === '/claim') {
      if (rec.claimed) return json({ error: 'sudah dipakai' }, 409);
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
    // Keepalive tanpa membangunkan DO (hemat kuota).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async machines() {
    return (await this.ctx.storage.get('machines')) || {};
  }

  online(mid) {
    return this.ctx.getWebSockets('m:' + mid).length > 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const machines = await this.machines();

    if (url.pathname === '/register') {
      const { mid, name, kind, provider } = await request.json();
      machines[mid] = { name, createdAt: Date.now(), lastSeen: null, ...(kind === 'cloud' ? { kind, provider } : {}) };
      await this.ctx.storage.put('machines', machines);
      return json({ ok: true });
    }
    if (url.pathname === '/machines') {
      const list = Object.entries(machines).map(([id, m]) => ({ id, name: m.name, online: this.online(id), lastSeen: m.lastSeen, kind: m.kind || 'pc', provider: m.provider || null, createdAt: m.createdAt, boot: m.boot || null }));
      return json({ machines: list });
    }
    if (url.pathname === '/boot') {
      const { mid, boot } = await request.json();
      if (!machines[mid]) return json({ error: 'PC tidak terdaftar' }, 404);
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
      if (!machines[mid]) return json({ error: 'PC tidak terdaftar' }, 404);
      const [client, server] = Object.values(new WebSocketPair());
      if (role === 'm') {
        for (const old of this.ctx.getWebSockets('m:' + mid)) old.close(4000, 'replaced');
        this.ctx.acceptWebSocket(server, ['m:' + mid]);
        server.serializeAttachment({ role: 'm', mid });
        // Relay ini meneruskan frame biner (daemon lama mengabaikan pesan ini).
        server.send(JSON.stringify({ t: 'hello', bin: 1 }));
        // Beritahu PC tentang HP yang sudah menunggu, dan HP bahwa PC online.
        for (const p of this.ctx.getWebSockets('p:' + mid)) {
          const { cid } = p.deserializeAttachment();
          server.send(JSON.stringify({ t: 'open', cid }));
          p.send(JSON.stringify({ t: 'status', online: true, bin: 1 }));
        }
      } else {
        const cid = randomId(9);
        this.ctx.acceptWebSocket(server, ['p:' + mid, 'c:' + cid]);
        server.serializeAttachment({ role: 'p', mid, cid });
        const online = this.online(mid);
        server.send(JSON.stringify({ t: 'status', online, name: machines[mid].name, bin: 1 }));
        if (online) for (const m of this.ctx.getWebSockets('m:' + mid)) m.send(JSON.stringify({ t: 'open', cid }));
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: 'not found' }, 404);
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment();
    if (typeof message !== 'string') {
      if (att.role === 'p') {
        const frame = withCid(att.cid, message);
        for (const m of this.ctx.getWebSockets('m:' + att.mid)) m.send(frame);
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
      for (const m of this.ctx.getWebSockets('m:' + att.mid)) m.send(JSON.stringify({ t: 'd', cid: att.cid, d: message }));
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
    if (this.ctx.getWebSockets('m:' + att.mid).some((s) => s !== ws)) return;
    const machines = await this.machines();
    if (machines[att.mid]) {
      machines[att.mid].lastSeen = Date.now();
      await this.ctx.storage.put('machines', machines);
    }
    for (const p of this.ctx.getWebSockets('p:' + att.mid)) p.send(JSON.stringify({ t: 'status', online: false }));
  }
}
