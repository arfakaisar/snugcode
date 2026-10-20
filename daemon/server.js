// Daemon: tersambung ke relay (koneksi keluar saja), menangani pairing PIN,
// kanal terenkripsi per HP, kanal lokal untuk terminal (TUI), dan RPC.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import * as C from '../shared/crypto.js';
import { loadSecrets, saveSecrets, saveConfig, IPC_PATH, isCloud, scrubSecretEnv, pinAttempt, resetPinLock } from './config.js';
import { SessionManager } from './sessions.js';
import { lightModel } from '../shared/models.js';
import { splitRef } from '../shared/providers.js';
import { migrateLegacy, mirrorLegacy, putConnection, allConnections, getConn, connSummary, listConnModels, listAllModels, knownRefs, forgetModels, resolveRoute } from './providers.js';
import { chatgptModels } from './codex.js';
import { TOKEN_INVALID } from './github.js';
import { GithubAuth } from './ghauth.js';
import { getInstallInfo, checkUpdate } from './updater.js';
import { startKeepAwake } from './keepawake.js';
import { sendPush } from './webpush.js';
import { idleMinutes, stopRunner, tickUsage, usageSummary } from './runner.js';
import { Terminals } from './pty.js';
import { RPC, defaultModel } from './rpc.js';

// Dipakai cli.js & test (dulu didefinisikan di sini).
export { defaultModel };

// Versi protokol daemon <-> klien. 2 = kanal biner + daftar `caps` di info.
const PROTO = 2;
// Heartbeat ke relay: ping tiap PING_MS; tanpa pesan apa pun selama DEAD_MS koneksi dianggap mati.
export const PING_MS = 25_000;
export const DEAD_MS = 70_000;
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export class Daemon {
  constructor(config, { log = console.log } = {}) {
    this.config = config;
    this.secrets = loadSecrets();
    this.log = log;
    // Router lama (config.routerUrl + secrets.routerKey) menjadi koneksi `router`.
    if (migrateLegacy(config, this.secrets)) saveSecrets(this.secrets);
    this.updaterMeta = getInstallInfo(config);
    // Token GitHub di env (mis. GITHUB_TOKEN dari Codespaces) & env bootstrap runner tidak boleh
    // terwariskan ke agen, Bash-nya, dev server, atau `!perintah`.
    scrubSecretEnv();
    // Runner cloud tidak punya "PC yang tertidur".
    this.keepAwake = isCloud(config) ? null : startKeepAwake({ log: (m) => this.log(m) });
    this.conns = new Map();
    this.sessions = new SessionManager({ config, secrets: this.secrets, log: (m) => (process.env.SNUGCODE_DEBUG || process.env.POCKETCODE_DEBUG) && log(m), notify: (s, msg, o) => this.notify(s, msg, o) });
    this.backoff = 1000;
    this.stopped = false;
    this.lastPairAttempt = 0;
    this.locals = new Set();
    this.github = new GithubAuth(this);
    this.terms = new Terminals({ log: (m) => this.log(m) });
    // Kabari semua HP & terminal yang tersambung saat status login GitHub berubah.
    this.github.on('change', (st) => {
      for (const c of [...this.conns.values(), ...this.locals]) if (c.ready) c.push({ ev: 'github', ...st });
    });
  }

  saveSecrets() {
    saveSecrets(this.secrets);
  }

  // ---------- koneksi model ----------
  models({ fresh = false } = {}) {
    return listAllModels(this.secrets, { fresh, codexModels: (c) => chatgptModels(this.config, c.id) });
  }

  connList() {
    const sec = this.secrets;
    return Object.values(allConnections(sec)).map((c) => {
      const refs = knownRefs(sec, c.id);
      return { ...connSummary(c), models: refs ? refs.length : null };
    });
  }

  // Simpan koneksi hasil deteksi. Satu koneksi per provider katalog (menimpa yang lama); router &
  // endpoint kustom bisa banyak (router, router2, …). Koneksi `router` = model tanpa awalan.
  /** @param {any} conn @param {{ replace?: string, models?: { id: string, isDefault?: boolean }[] }} [opts] */
  saveConnection(conn, { replace, models } = {}) {
    const sec = this.secrets;
    const id = putConnection(sec, conn, { replace });
    mirrorLegacy(this.config, sec);
    forgetModels(id);
    this.sessions.resetRouter(id);
    // Model default: tetap bila masih bisa dipakai; selain itu pilih dari koneksi baru (di latar belakang).
    let ok = true;
    try {
      resolveRoute(sec, this.config.model);
    } catch {
      ok = false;
    }
    // Daftar model hasil deteksi sudah ada: model default langsung dipilih (jawaban RPC memuatnya).
    if ((!ok || !this.config.model) && models?.length) {
      this.config.model = models.find((m) => m.isDefault)?.id || defaultModel(models.map((m) => m.id));
      ok = true;
    }
    this.saveSecrets();
    saveConfig(this.config);
    if (!ok || !this.config.model) this.pickDefaultModel(id);
    return id;
  }

  async pickDefaultModel(connId) {
    try {
      const c = getConn(this.secrets, connId);
      if (!c) return;
      const list = await listConnModels(c, { fresh: true, codexModels: (x) => chatgptModels(this.config, x.id) });
      const def = list.find((m) => m.isDefault)?.id || defaultModel(list.map((m) => m.id));
      if (!def) return;
      this.config.model = def;
      saveConfig(this.config);
      this.broadcast({ ev: 'info', info: { model: def } });
    } catch (e) {
      this.log('! gagal memilih model default: ' + e.message);
    }
  }

  removeConnection(id) {
    const sec = this.secrets;
    if (!sec.connections?.[id]) throw new Error('Koneksi tidak ditemukan');
    delete sec.connections[id];
    mirrorLegacy(this.config, sec);
    forgetModels(id);
    this.sessions.resetRouter(id);
    if (splitRef(this.config.model || '').conn === id) {
      this.config.model = '';
      const next = Object.keys(sec.connections)[0];
      if (next) this.pickDefaultModel(next);
    }
    this.saveSecrets();
    saveConfig(this.config);
  }

  start() {
    this.connect().catch((e) => this.log('! gagal menghubungi relay: ' + e.message));
    this.listenLocal();
    this.github.startChecks();
    this.startUpdateChecks();
    if (isCloud(this.config)) this.startIdleWatch();
  }

  // ---------- Runner cloud: berhenti sendiri saat menganggur ----------
  // Menganggur = tidak ada agen/perintah/dev server/tunnel yang berjalan dan tidak ada HP yang sedang
  // membuka aplikasi (atau terminal tersambung). Kuota Codespaces / biaya container tidak terbuang.
  startIdleWatch() {
    this.lastActive = Date.now();
    clearInterval(this.idleTimer);
    if (this.config.runner?.provider === 'codespace') tickUsage();
    this.idleTimer = setInterval(() => {
      if (this.config.runner?.provider === 'codespace') tickUsage();
      this.checkIdle();
    }, 60_000);
    this.idleTimer.unref?.();
  }

  isActive() {
    return this.sessions.busy() || this.terms.active() || this.locals.size > 0 || [...this.conns.values()].some((c) => c.ready && c.visible);
  }

  async checkIdle(now = Date.now()) {
    const mins = idleMinutes(this.config);
    if (this.isActive() || !(mins > 0)) return (this.lastActive = now), null;
    if (now - this.lastActive < mins * 60_000 || this.idleStopping) return null;
    this.idleStopping = true;
    try {
      // Dikirim sebelum berhenti: setelah codespace/container mati tidak ada lagi yang bisa mengabari HP.
      await this.pushAll({ title: `snugcode · ${this.config.machineName || 'Runner'}`, body: `Runner dihentikan setelah ${mins} menit menganggur (hemat kuota). Buka aplikasi untuk menyalakannya lagi.`, tag: 'runner-idle:' + this.config.machineId });
      const how = await stopRunner(this.config, this.secrets);
      if (how) this.log(`◆ Runner menganggur ${mins} menit: dihentikan (${how === 'exit' ? 'daemon keluar' : 'Codespaces'}). Buka aplikasi untuk menyalakannya lagi.`);
      if (how === 'exit') setTimeout(() => Promise.resolve(this.stop()).finally(() => process.exit(0)), 50);
      return how;
    } catch (e) {
      this.log('! gagal menghentikan runner: ' + e.message);
      this.saveSecrets();
      return null;
    } finally {
      this.lastActive = now; // gagal / tanpa cara berhenti: coba lagi satu periode kemudian
      this.idleStopping = false;
    }
  }

  // Menunggu (singkat) dev server & tunnel milik sesi benar-benar mati.
  stop() {
    this.stopped = true;
    this.keepAwake?.stop();
    clearInterval(this.ping);
    clearInterval(this.updateTimer);
    clearInterval(this.idleTimer);
    this.ws?.close();
    this.ipc?.close();
    this.terms?.closeAll();
    return this.sessions?.close();
  }

  broadcast(obj) {
    for (const c of [...this.conns.values(), ...this.locals]) if (c.ready) c.push(obj);
  }

  startUpdateChecks() {
    setTimeout(() => this.checkAndBroadcastUpdate(), 5000);
    this.updateTimer = setInterval(() => this.checkAndBroadcastUpdate(), 10 * 60 * 1000);
    this.updateTimer.unref?.();
  }

  async checkAndBroadcastUpdate() {
    if (this.stopped) return;
    try {
      const st = await checkUpdate(this.config, this.secrets);
      if (st.updateAvailable) {
        this.lastUpdateStatus = st;
        this.broadcast({ ev: 'update', ...st });
      }
    } catch {}
  }

  // Kanal lokal untuk `snugcode` di terminal. Hanya bisa diakses user yang sama
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

  // Relay baru menerima token lewat subprotocol (tidak tercatat di log URL); relay lama hanya `?token=`.
  async relaySupportsProto() {
    if (this.wsProto !== undefined) return this.wsProto;
    try {
      const r = await fetch(this.config.relayUrl.replace(/\/+$/, '') + '/api/health', { signal: AbortSignal.timeout(5000) });
      this.wsProto = !!(await r.json()).wsProto;
    } catch {
      return false; // dicoba lagi saat sambung ulang berikutnya
    }
    return this.wsProto;
  }

  async connect() {
    const base = this.config.relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws/machine';
    const proto = await this.relaySupportsProto();
    if (this.stopped) return;
    const ws = proto ? new WebSocket(base, ['snugcode', 't.' + this.secrets.machineToken]) : new WebSocket(base + '?token=' + encodeURIComponent(this.secrets.machineToken));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.relayBin = false; // relay lama hanya meneruskan frame teks; relay baru mengirim hello { bin }
    ws.onopen = () => {
      this.backoff = 1000;
      this.lastRx = Date.now();
      this.log(`✓ Terhubung ke relay sebagai "${this.config.machineName}". Buka aplikasi di HP untuk mulai.`);
      clearInterval(this.ping);
      // Heartbeat: relay menjawab setiap `ping`. Tanpa jawaban selama DEAD_MS (Wi-Fi ganti, PC bangun dari
      // tidur, NAT membuang koneksi), soket dianggap mati walau belum `close`, lalu disambung ulang.
      this.ping = setInterval(() => {
        if (ws.readyState !== 1) return;
        if (Date.now() - this.lastRx > DEAD_MS) return this.dropRelay(ws, 'tidak ada jawaban relay');
        ws.send('ping');
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastRx = Date.now();
      if (ev.data === 'pong') return;
      if (typeof ev.data !== 'string') {
        const { cid, payload } = C.splitCid(ev.data);
        return this.conns.get(cid)?.onBinary(payload);
      }
      let f;
      try {
        f = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (f.t === 'hello') this.relayBin = !!f.bin;
      else if (f.t === 'open') this.conns.set(f.cid, new PhoneConn(this, f.cid));
      else if (f.t === 'close') this.conns.get(f.cid)?.closed();
      else if (f.t === 'd') {
        let conn = this.conns.get(f.cid);
        if (!conn) this.conns.set(f.cid, (conn = new PhoneConn(this, f.cid)));
        conn.onMessage(f.d);
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // soket lama yang sudah diganti dropRelay
      clearInterval(this.ping);
      for (const c of this.conns.values()) c.closed();
      this.conns.clear();
      if (this.stopped) return;
      if (ev.code === 4003) {
        this.log('✗ PC ini sudah dihapus dari akun. Jalankan `snugcode setup` lagi.');
        return;
      }
      if (ev.code === 4000) this.log('! Ada daemon lain dengan PC yang sama yang mengambil alih koneksi.');
      const wait = ev.code === 4000 ? 60000 : this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30000);
      setTimeout(() => this.connect().catch((e) => this.log('! gagal menghubungi relay: ' + e.message)), wait);
    };
    ws.onerror = () => {};
  }

  // Soket setengah mati: lepaskan (close-nya bisa tertahan lama) dan sambung ulang sekarang.
  dropRelay(ws, why) {
    this.log(`! Koneksi relay macet (${why}): menyambung ulang…`);
    clearInterval(this.ping);
    this.ws = null;
    for (const c of this.conns.values()) c.closed();
    this.conns.clear();
    try {
      ws.close();
    } catch {}
    if (!this.stopped) this.connect().catch((e) => this.log('! gagal menghubungi relay: ' + e.message));
  }

  sendRaw(cid, obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'd', cid, d: JSON.stringify(obj) }));
  }
  sendBin(cid, bytes) {
    if (this.ws?.readyState === 1) this.ws.send(C.frameWithCid(cid, bytes));
  }
  kick(cid, reason) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'x', cid, reason }));
  }

  // Web Push ke semua HP terpasang (bukan tentang satu sesi), ditunggu paling lama `ms`.
  pushAll(payload, ms = 5000) {
    const sends = Object.values(this.secrets.devices || {})
      .filter((dev) => dev.push)
      .map((dev) => sendPush(dev.push, { mid: this.config.machineId, ...payload }).catch((e) => this.log('! push gagal: ' + e.message)));
    return Promise.race([Promise.allSettled(sends), new Promise((r) => setTimeout(r, ms).unref?.())]);
  }

  // perm: kartu izin (tag notifikasi terpisah; pid + risk → tombol Izinkan/Tolak di notifikasi).
  // minor: kabar sampingan (mis. dev server berhenti) yang dilewati HP dengan mode "penting saja".
  /** @param {any} session @param {string} msg @param {{ perm?: boolean, pid?: string, risk?: string, minor?: boolean }} [o] */
  notify(session, msg, { perm = false, pid, risk, minor = false } = {}) {
    const title = session.meta.title || session.meta.repo;
    for (const c of [...this.conns.values(), ...this.locals]) if (c.ready) c.push({ ev: 'notice', sid: session.id, msg, title });
    // HP yang sedang membuka sesi ini sudah melihatnya langsung; sisanya dapat Web Push.
    const watching = new Set([...this.conns.values()].filter((c) => c.ready && c.visible && c.sub?.session === session).map((c) => c.deviceId));
    for (const [id, dev] of Object.entries(this.secrets.devices)) {
      if (!dev.push || watching.has(id) || (minor && dev.pushLevel === 'important')) continue;
      sendPush(dev.push, { title: `snugcode · ${title}`, body: msg, tag: session.id + (perm ? ':perm' : ''), sid: session.id, mid: this.config.machineId, ...(pid && risk !== 'high' ? { pid, risk } : {}) })
        .then((alive) => {
          if (alive) return;
          delete dev.push;
          this.saveSecrets();
        })
        .catch((e) => this.log('! push gagal: ' + e.message));
    }
  }
}

// RPC bersama untuk HP (lewat relay) dan terminal (lokal).
class RpcConn {
  constructor(daemon) {
    this.d = daemon;
    /** @type {import('./sessions.js').Session | null} sesi milik jembatan MCP (hanya tool dev) */
    this.bridge = null;
    this.ready = false;
    this.sub = null; // { session, listener }
    this.queue = [];
    this.queueSid = null;
    this.visible = true; // HP mengabarkan saat PWA ke latar belakang (untuk Web Push)
  }

  /** Kirim pesan ke klien (diimplementasikan LocalConn/PhoneConn). @param {object} msg */
  push(msg) {
    throw new Error('not implemented');
  }

  // Koneksi sudah putus: sisa antrean event tidak perlu dikirim.
  closed() {
    this.queue = [];
    this.unsubscribe();
    this.d.terms.detachConn(this);
  }

  async handleRpc({ id, m, p }) {
    try {
      if (this.bridge && m !== 'devTools' && m !== 'devTool') throw new Error('Tidak diizinkan untuk jembatan MCP');
      const fn = Object.hasOwn(RPC, m) ? RPC[m] : null;
      if (!fn) throw new Error('Metode tidak dikenal: ' + m);
      const r = await fn(this, p && typeof p === 'object' ? p : {});
      this.push({ id, r: r ?? null });
    } catch (e) {
      if (e?.message === TOKEN_INVALID) this.d.github.markInvalid();
      this.push({ id, err: String(e?.message || e) });
    }
  }

  info() {
    const c = this.d.config;
    const sec = this.d.secrets;
    let engine = null;
    try {
      engine = resolveRoute(sec, c.model).engine;
    } catch {}
    return {
      name: c.machineName,
      model: c.model,
      engine,
      // Model ringan subagen untuk model default (tiap sesi menghitungnya dari model sesinya).
      lightModel: c.model ? lightModel(c.model, knownRefs(sec, splitRef(c.model).conn)).id : null,
      router: getConn(sec, 'router')?.openai || c.routerUrl,
      connections: this.d.connList(),
      github: c.githubLogin || null,
      githubState: this.d.github.state,
      platform: process.platform,
      // PWA memakai ini untuk mengenali daemon lama (sebelum ganti nama) dan menawarkan migrasi.
      brand: 'snugcode',
      version: this.d.updaterMeta?.version || PKG_VERSION,
      commit: this.d.updaterMeta?.commit || 'main',
      preventSleep: this.d.keepAwake?.active?.() ?? false,
      // 'pc' | 'cloud' (Codespaces / container). PWA menyembunyikan fitur khusus PC & menampilkan setelan runner.
      runtime: c.runtime || 'pc',
      machineId: c.machineId,
      // Ada koneksi model (dulu: key 9router). Nama lama dipertahankan untuk aplikasi versi lama.
      routerConfigured: Object.keys(sec.connections || {}).length > 0,
      runner: isCloud(c) ? { ...(c.runner || {}), idleStopMinutes: idleMinutes(c), autoStop: !!this.d.secrets.runnerToken || !!c.runner?.idleExit, ...(c.runner?.provider === 'codespace' ? { usage: usageSummary() } : {}) } : null,
      // Fitur protokol yang didukung daemon ini: klien memeriksa ini, bukan menebak dari pesan error.
      proto: PROTO,
      caps: Object.keys(RPC),
    };
  }

  subscribe(s) {
    this.unsubscribe();
    const listener = (e) => this.queueEvent(s.id, e);
    s.on('event', listener);
    this.sub = { session: s, listener };
  }

  unsubscribe() {
    if (this.sub) this.sub.session.off('event', this.sub.listener);
    this.sub = null;
    this.flushEvents();
  }

  // Event digabung tiap ~60ms jadi satu frame. Antrean hanya berisi event dari satu sesi:
  // pindah sesi mengirim sisa antrean lama lebih dulu (dulu event sesi baru bisa berlabel sesi lama).
  queueEvent(sid, e) {
    if (this.queueSid !== sid) this.flushEvents();
    this.queueSid = sid;
    this.queue.push(e);
    this.flushTimer ??= setTimeout(() => this.flushEvents(), 60);
  }

  flushEvents() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.queue.length) return;
    const es = this.queue.splice(0);
    this.push({ ev: 'events', sid: this.queueSid, es });
  }
}

// Terminal di PC yang sama: JSON per baris lewat named pipe / unix socket.
class LocalConn extends RpcConn {
  constructor(daemon, sock) {
    super(daemon);
    this.local = true;
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
      // Jembatan MCP engine Codex: token per sesi, hanya untuk tool dev sesi itu.
      if (m.t === 'hello' && m.bridge) {
        const s = this.d.sessions.bridgeSession(m.bridge);
        if (!s) {
          this.push({ ev: 'denied' });
          return this.sock.end();
        }
        this.ready = true;
        this.bridge = s;
        return this.push({ ev: 'ready' });
      }
      const want = Buffer.from(String(this.d.secrets.localToken));
      const got = Buffer.from(String(m.token || ''));
      if (m.t !== 'hello' || got.length !== want.length || !timingSafeEqual(got, want)) {
        this.push({ ev: 'denied' });
        return this.sock.end();
      }
      this.ready = true;
      this.push({ ev: 'ready', info: this.info(), pid: process.pid });
      if (this.d.lastUpdateStatus?.updateAvailable) this.push({ ev: 'update', ...this.d.lastUpdateStatus });
      return;
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

  // Kanal biner bila HP & relay sama-sama mendukungnya (disepakati saat auth); selain itu frame teks.
  push(msg) {
    if (!this.channel) return;
    if (this.bin) for (const f of this.channel.sealBin(msg)) this.d.sendBin(this.cid, f);
    else this.send(this.channel.seal(msg));
  }

  get big() {
    return !!this.bin;
  }

  onBinary(payload) {
    if (!this.channel) return;
    try {
      const msg = this.channel.openBin(payload);
      if (msg) this.onRpc(msg);
    } catch (e) {
      this.d.log('! pesan ditolak: ' + e.message);
      this.d.kick(this.cid, 'protocol');
    }
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
    if (Date.now() - this.d.lastPairAttempt < 3000 && !(s.pinLockUntil > Date.now())) return this.send({ t: 'pair_err', reason: 'slow' });
    // Dihitung sebelum hasilnya diketahui: penebak cukup melihat pair2 untuk menguji satu tebakan.
    const att = pinAttempt(s);
    if ('until' in att) return this.send({ t: 'pair_err', reason: 'locked', until: att.until });
    this.d.lastPairAttempt = Date.now();
    this.d.saveSecrets();
    const r = C.pairRespondMachine(C.hexToBytes(s.prs), m);
    this.pairState = { ...r.state, name: String(m.name || 'HP').slice(0, 60) };
    this.send({ t: 'pair2', ...r.msg, left: att.left });
  }

  pair3(m) {
    if (!this.pairState) return;
    const secret = C.pairVerifyMachine(this.pairState, m);
    const name = this.pairState.name;
    this.pairState = null;
    if (!secret) return this.send({ t: 'pair_err', reason: 'pin' });
    const s = this.d.secrets;
    resetPinLock(s);
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
    this.authState = { ...r.state, deviceId: m.deviceId, bin: !!m.bin && this.d.relayBin };
    this.send({ t: 'auth2', ...r.msg, ...(this.authState.bin ? { bin: 1 } : {}) });
  }

  auth3(m) {
    if (!this.authState) return;
    const ch = C.authVerifyMachine(this.authState, m);
    const { deviceId, bin } = this.authState;
    this.authState = null;
    if (!ch) return this.send({ t: 'auth_err', reason: 'bad_mac' });
    this.channel = ch;
    this.bin = bin;
    this.ready = true;
    this.deviceId = deviceId;
    const dev = this.d.secrets.devices[deviceId];
    dev.lastSeen = Date.now();
    this.d.saveSecrets();
    this.push({ ev: 'ready', info: this.info() });
    if (this.d.lastUpdateStatus?.updateAvailable) this.push({ ev: 'update', ...this.d.lastUpdateStatus });
  }

  // Revoke berlaku langsung.
  onRpc(msg) {
    if (!this.d.secrets.devices[this.deviceId]) return this.d.kick(this.cid, 'revoked');
    return this.handleRpc(msg);
  }
}
