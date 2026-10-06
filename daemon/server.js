// Daemon: tersambung ke relay (koneksi keluar saja), menangani pairing PIN,
// kanal terenkripsi per HP, kanal lokal untuk terminal (TUI), dan RPC.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import * as C from '../shared/crypto.js';
import { loadSecrets, saveSecrets, saveConfig, IPC_PATH } from './config.js';
import { SessionManager } from './sessions.js';
import { listModels, probeModel } from './router.js';
import { listRepos, gitStatus, gitDiff, gitCommit, gitPush, createPR, gh } from './github.js';

const MAX_PIN_FAILS = 5;

export class Daemon {
  constructor(config, { log = console.log } = {}) {
    this.config = config;
    this.secrets = loadSecrets();
    this.log = log;
    this.conns = new Map();
    this.sessions = new SessionManager({ config, secrets: this.secrets, log: (m) => process.env.POCKETCODE_DEBUG && log(m), notify: (s, msg) => this.notify(s, msg) });
    this.backoff = 1000;
    this.stopped = false;
    this.lastPairAttempt = 0;
    this.locals = new Set();
  }

  saveSecrets() {
    saveSecrets(this.secrets);
  }

  start() {
    this.connect();
    this.listenLocal();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.ping);
    this.ws?.close();
    this.ipc?.close();
  }

  // Kanal lokal untuk `pocketcode` di terminal. Hanya bisa diakses user yang sama
  // (izin file/pipe) dan tetap wajib token lokal dari secrets.json.
  listenLocal() {
    if (!this.secrets.localToken) {
      this.secrets.localToken = randomBytes(24).toString('hex');
      this.saveSecrets();
    }
    if (process.platform !== 'win32') fs.rmSync(IPC_PATH, { force: true });
    this.ipc = net.createServer((sock) => {
      const c = new LocalConn(this, sock);
      this.locals.add(c);
    });
    this.ipc.on('error', (e) => this.log('! kanal lokal gagal: ' + e.message));
    this.ipc.listen(IPC_PATH, () => {
      if (process.platform !== 'win32') fs.chmodSync(IPC_PATH, 0o600);
    });
  }

  connect() {
    const url = this.config.relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws/machine?token=' + encodeURIComponent(this.secrets.machineToken);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.log(`✓ Terhubung ke relay sebagai "${this.config.machineName}". Buka aplikasi di HP untuk mulai.`);
      clearInterval(this.ping);
      this.ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25000);
    };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') return;
      let f;
      try {
        f = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (f.t === 'open') this.conns.set(f.cid, new PhoneConn(this, f.cid));
      else if (f.t === 'close') this.conns.get(f.cid)?.closed();
      else if (f.t === 'd') {
        let conn = this.conns.get(f.cid);
        if (!conn) this.conns.set(f.cid, (conn = new PhoneConn(this, f.cid)));
        conn.onMessage(f.d);
      }
    };
    ws.onclose = (ev) => {
      clearInterval(this.ping);
      for (const c of this.conns.values()) c.closed();
      this.conns.clear();
      if (this.stopped) return;
      if (ev.code === 4003) {
        this.log('✗ PC ini sudah dihapus dari akun. Jalankan `pocketcode setup` lagi.');
        return;
      }
      if (ev.code === 4000) this.log('! Ada daemon lain dengan PC yang sama yang mengambil alih koneksi.');
      const wait = ev.code === 4000 ? 60000 : this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30000);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => {};
  }

  sendRaw(cid, obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'd', cid, d: JSON.stringify(obj) }));
  }
  kick(cid, reason) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'x', cid, reason }));
  }

  notify(session, msg) {
    for (const c of [...this.conns.values(), ...this.locals]) if (c.ready) c.push({ ev: 'notice', sid: session.id, msg, title: session.meta.title || session.meta.repo });
  }
}

// RPC bersama untuk HP (lewat relay) dan terminal (lokal).
class RpcConn {
  constructor(daemon) {
    this.d = daemon;
    this.ready = false;
    this.sub = null; // { session, listener }
    this.queue = [];
  }

  push() {
    throw new Error('not implemented');
  }

  closed() {
    this.unsubscribe();
  }

  async handleRpc({ id, m, p = {} }) {
    try {
      const r = await this.call(m, p);
      this.push({ id, r: r ?? null });
    } catch (e) {
      this.push({ id, err: String(e?.message || e) });
    }
  }

  info() {
    const c = this.d.config;
    return { name: c.machineName, model: c.model, smallModel: c.smallModel, router: c.routerUrl, github: c.githubLogin || null, platform: process.platform };
  }

  unsubscribe() {
    if (this.sub) this.sub.session.off('event', this.sub.listener);
    this.sub = null;
  }

  async call(m, p) {
    const d = this.d;
    const sec = d.secrets;
    const S = d.sessions;
    switch (m) {
      case 'info':
        return this.info();
      case 'models': // versi lama: daftar ID saja
        return (await listModels(d.config, sec.routerKey)).map((m) => m.id);
      case 'modelsInfo':
        return listModels(d.config, sec.routerKey, { fresh: !!p.fresh });
      case 'probeModel':
        if (typeof p.model !== 'string' || !p.model) throw new Error('model kosong');
        return probeModel(d.config, sec.routerKey, p.model);
      case 'setModel':
        if (p.model) d.config.model = p.model;
        if (p.smallModel) d.config.smallModel = p.smallModel;
        saveConfig(d.config);
        return this.info();
      case 'setSessionModel': {
        const s = S.get(p.id);
        if (s.status === 'running') throw new Error('Tunggu agen selesai (atau Stop) sebelum ganti model.');
        if (typeof p.model !== 'string' || !p.model) throw new Error('model kosong');
        if (s.meta.model !== p.model) {
          s.emitEvent({ k: 'note', d: `◆ model: ${s.meta.model} → ${p.model}` });
          s.meta.model = p.model;
          S.saveIndex();
        }
        return s.summary();
      }
      case 'repos':
        if (!sec.githubToken) throw new Error('PC ini belum login GitHub. Jalankan `pocketcode setup` di PC.');
        return listRepos(sec.githubToken, p.q);
      case 'branches': {
        if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo || '')) throw new Error('repo tidak valid');
        const list = await gh(sec.githubToken, 'GET', `/repos/${p.repo}/branches?per_page=100`);
        return list.map((b) => b.name);
      }
      case 'sessions':
        return S.list();
      case 'create': {
        const s = await S.create(p);
        return s.summary();
      }
      case 'attach': {
        const s = S.get(p.id);
        this.unsubscribe();
        const listener = (e) => this.queueEvent(s.id, e);
        s.on('event', listener);
        this.sub = { session: s, listener };
        // Frame relay dibatasi ~1MB: kirim riwayat terbaru saja bila terlalu besar.
        const all = s.since(p.since || 0);
        const events = [];
        let size = 0;
        for (let i = all.length - 1; i >= 0 && size < 500_000; i--) {
          size += JSON.stringify(all[i]).length;
          events.unshift(all[i]);
        }
        return { session: s.summary(), events, truncated: events.length < all.length, perms: s.pendingPerms() };
      }
      case 'detach':
        this.unsubscribe();
        return true;
      case 'send':
        await S.get(p.id).send(String(p.text || ''));
        return true;
      case 'interrupt':
        await S.get(p.id).interrupt();
        return true;
      case 'perm':
        return S.get(p.id).answerPermission(p.pid, p.decision);
      case 'auto': {
        const s = S.get(p.id);
        s.meta.auto = !!p.on;
        S.saveIndex();
        return s.summary();
      }
      case 'delete':
        await S.remove(p.id);
        return true;
      case 'status':
        return gitStatus(S.get(p.id).meta.cwd);
      case 'diff':
        return gitDiff(S.get(p.id).meta.cwd);
      case 'commit': {
        if (!p.message?.trim()) throw new Error('Pesan commit kosong');
        const identity = d.config.githubLogin ? { login: d.config.githubLogin, id: d.config.githubId } : null;
        return gitCommit(S.get(p.id).meta.cwd, p.message.trim(), identity);
      }
      case 'push': {
        if (!sec.githubToken) throw new Error('PC ini belum login GitHub.');
        const s = S.get(p.id);
        const branch = await gitPush(s.meta.cwd, sec.githubToken);
        s.emitEvent({ k: 'note', d: `⇡ push ke origin/${branch}` });
        return branch;
      }
      case 'pr': {
        const s = S.get(p.id);
        // Sesi lokal bisa pindah branch dari terminal: pakai branch yang sedang aktif.
        const head = (await gitStatus(s.meta.cwd)).branch;
        const pr = await createPR(sec.githubToken, s.meta.repo, { head, base: p.base || s.meta.base, title: p.title, body: p.body || '' });
        s.emitEvent({ k: 'note', d: `PR #${pr.number} dibuat: ${pr.url}` });
        return pr;
      }
      default:
        throw new Error('Metode tidak dikenal: ' + m);
    }
  }

  // Event digabung tiap ~60ms jadi satu frame.
  queueEvent(sid, e) {
    this.queue.push(e);
    if (!this.flushTimer)
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const es = this.queue.splice(0);
        this.push({ ev: 'events', sid, es });
      }, 60);
  }
}

// Terminal di PC yang sama: JSON per baris lewat named pipe / unix socket.
class LocalConn extends RpcConn {
  constructor(daemon, sock) {
    super(daemon);
    this.sock = sock;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => this.closed());
  }

  closed() {
    super.closed();
    this.d.locals.delete(this);
  }

  push(msg) {
    if (!this.sock.destroyed) this.sock.write(JSON.stringify(msg) + '\n');
  }

  onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!this.ready) {
      const want = Buffer.from(String(this.d.secrets.localToken));
      const got = Buffer.from(String(m.token || ''));
      if (m.t !== 'hello' || got.length !== want.length || !timingSafeEqual(got, want)) {
        this.push({ ev: 'denied' });
        return this.sock.end();
      }
      this.ready = true;
      return this.push({ ev: 'ready', info: this.info(), pid: process.pid });
    }
    this.handleRpc(m);
  }
}

class PhoneConn extends RpcConn {
  constructor(daemon, cid) {
    super(daemon);
    this.cid = cid;
    this.channel = null;
  }

  closed() {
    super.closed();
    this.d.conns.delete(this.cid);
  }

  send(obj) {
    this.d.sendRaw(this.cid, obj);
  }

  push(msg) {
    if (this.channel) this.send(this.channel.seal(msg));
  }

  onMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (m.t === 'e' && this.channel) return this.onRpc(this.channel.open(m));
      if (m.t === 'pair1') return this.pair1(m);
      if (m.t === 'pair3') return this.pair3(m);
      if (m.t === 'auth1') return this.auth1(m);
      if (m.t === 'auth3') return this.auth3(m);
    } catch (e) {
      this.d.log('! pesan ditolak: ' + e.message);
      this.d.kick(this.cid, 'protocol');
    }
  }

  // ---------- Pairing PIN ----------
  pair1(m) {
    const s = this.d.secrets;
    if (!s.prs) return this.send({ t: 'pair_err', reason: 'nopin' });
    if (s.pinFails >= MAX_PIN_FAILS) return this.send({ t: 'pair_err', reason: 'locked' });
    if (Date.now() - this.d.lastPairAttempt < 3000) return this.send({ t: 'pair_err', reason: 'slow' });
    this.d.lastPairAttempt = Date.now();
    s.pinFails++;
    this.d.saveSecrets();
    const r = C.pairRespondMachine(C.hexToBytes(s.prs), m);
    this.pairState = { ...r.state, name: String(m.name || 'HP').slice(0, 60) };
    this.send({ t: 'pair2', ...r.msg, left: MAX_PIN_FAILS - s.pinFails });
  }

  pair3(m) {
    if (!this.pairState) return;
    const secret = C.pairVerifyMachine(this.pairState, m);
    const name = this.pairState.name;
    this.pairState = null;
    if (!secret) return this.send({ t: 'pair_err', reason: 'pin' });
    const s = this.d.secrets;
    s.pinFails = 0;
    const deviceId = randomBytes(8).toString('hex');
    s.devices[deviceId] = { name, secret: C.bytesToHex(secret), pairedAt: Date.now(), lastSeen: Date.now() };
    this.d.saveSecrets();
    this.d.log(`✓ Perangkat baru dipasangkan: ${name} (${deviceId})`);
    this.send({ t: 'pair_ok', deviceId });
  }

  // ---------- Autentikasi perangkat terpasang ----------
  auth1(m) {
    const dev = this.d.secrets.devices[m.deviceId];
    if (!dev) return this.send({ t: 'auth_err', reason: 'unknown_device' });
    const r = C.authRespondMachine(C.hexToBytes(dev.secret), m);
    this.authState = { ...r.state, deviceId: m.deviceId };
    this.send({ t: 'auth2', ...r.msg });
  }

  auth3(m) {
    if (!this.authState) return;
    const ch = C.authVerifyMachine(this.authState, m);
    const deviceId = this.authState.deviceId;
    this.authState = null;
    if (!ch) return this.send({ t: 'auth_err', reason: 'bad_mac' });
    this.channel = ch;
    this.ready = true;
    this.deviceId = deviceId;
    const dev = this.d.secrets.devices[deviceId];
    dev.lastSeen = Date.now();
    this.d.saveSecrets();
    this.push({ ev: 'ready', info: this.info() });
  }

  // Revoke berlaku langsung.
  onRpc(msg) {
    if (!this.d.secrets.devices[this.deviceId]) return this.d.kick(this.cid, 'revoked');
    return this.handleRpc(msg);
  }
}
