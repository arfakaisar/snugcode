// Koneksi terenkripsi HP <-> PC lewat relay: pairing PIN, autentikasi perangkat, kanal E2EE
// (frame teks lama atau biner v2), dan RPC berbasis id. Tanpa DOM, hanya WebSocket + localStorage.
import * as C from '../shared/crypto.js';

export const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem('pc.' + k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      v == null ? localStorage.removeItem('pc.' + k) : localStorage.setItem('pc.' + k, JSON.stringify(v));
    } catch {}
  },
};

export const token = () => store.get('token');

function deviceName() {
  const ua = navigator.userAgent;
  const m = ua.match(/\(([^)]+)\)/);
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? (m?.[1].split(';').map((s) => s.trim()).find((s) => /^(SM-|Pixel|Redmi|M\d|V\d|CPH|RMX|2\d{3})/.test(s)) || 'Android') : 'Browser';
  return os + ' · ' + new Date().toLocaleDateString('id-ID');
}

// Heartbeat: relay menjawab `ping`. Tanpa pesan apa pun selama DEAD_MS (Wi-Fi ↔ seluler, HP tidur),
// soket dianggap setengah mati walau belum `close`, lalu disambung ulang.
const PING_MS = 20000;
const DEAD_MS = 50000;
// Batas waktu menyambung: soket bisa tertahan di CONNECTING tanpa batas (HP baru bangun, jaringan seluler
// yang menelan paket) dan browser baru menyerah setelah beberapa menit. Tanpa `status` dari relay dalam
// waktu ini, soket dilepas dan dicoba lagi (makin lama tiap percobaan, untuk jaringan yang memang lambat).
const CONNECT_MS = 10000;
const CONNECT_MAX_MS = 30000;
// Relay sudah menjawab tapi PC tidak membalas auth (soket PC ke relay setengah mati): coba kanal baru.
const AUTH_MS = 20000;
// Batas waktu RPC: tanpa ini tombol & spinner bisa menunggu selamanya saat koneksi macet.
const RPC_MS = 30000;
const RPC_SLOW_MS = 180000;
const RPC_SLOW = new Set(['create', 'update', 'rollback', 'connAdd', 'configure', 'chatgptLogin', 'probeModel', 'modelsAll', 'modelsInfo', 'models', 'repos', 'branches', 'attach', 'preview', 'screenshot', 'runDev', 'cleanup', 'push', 'pr', 'commit', 'revert', 'diff', 'status', 'delete', 'send', 'termOpen', 'procStart']);

// ---------- Koneksi terenkripsi ke PC ----------
export class Conn {
  constructor(machine) {
    this.m = machine;
    this.rpcId = 0;
    this.pending = new Map();
    this.channel = null;
    this.closedByUser = false;
    this.backoff = 1000;
    this.handlers = {};
    this.online = false;
    this.attempts = 0;
  }
  get dev() {
    return store.get('dev.' + this.m.id);
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectT);
    // Token login lewat subprotocol, bukan URL (tidak tercatat di log); relay menjawab subprotocol `snugcode`.
    const ws = new WebSocket(`${proto}//${location.host}/ws/phone?mid=${encodeURIComponent(this.m.id)}`, ['snugcode', 't.' + token()]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.channel = null;
    this.bin = false;
    this.greeted = false;
    this.startedAt = Date.now();
    this.emit('attempt', ++this.attempts);
    const limit = Math.min(CONNECT_MS + (this.attempts - 1) * 5000, CONNECT_MAX_MS);
    this.connectT = setTimeout(() => this.ws === ws && !this.greeted && this.drop(), limit);
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastRx = Date.now();
      typeof ev.data === 'string' ? this.onFrame(ev.data) : this.onBinary(ev.data);
    };
    ws.onopen = () => {
      this.backoff = 1000;
      this.lastRx = Date.now();
      clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (ws.readyState !== 1) return;
        if (Date.now() - this.lastRx > DEAD_MS) return this.drop();
        ws.send('ping');
      }, PING_MS);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.lost();
      if (this.closedByUser) return;
      if (ev.code === 4001 && ev.reason === 'revoked') {
        store.set('dev.' + this.m.id, null);
        return this.emit('state', 'revoked');
      }
      if (ev.code === 4003) return this.emit('state', 'removed');
      // "Keluar dari semua perangkat": token login dicabut relay, jadi login ulang.
      if (ev.code === 4005) {
        store.set('token', null);
        return location.reload();
      }
      this.reconnectTimer = setTimeout(() => !this.closedByUser && this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
  }
  // Koneksi hilang: semua RPC yang menunggu gagal dengan pesan jelas, UI menampilkan "menyambung ulang".
  lost() {
    clearInterval(this.ping);
    clearTimeout(this.probeT);
    clearTimeout(this.connectT);
    clearTimeout(this.authT);
    this.channel = null;
    for (const p of this.pending.values()) p.reject(new Error('Koneksi terputus'));
    this.pending.clear();
    this.emit('state', 'reconnecting');
  }
  // Soket setengah mati: lepaskan tanpa menunggu `close` (bisa tertahan puluhan detik) dan sambung ulang.
  drop() {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
    this.lost();
    if (!this.closedByUser) this.connect();
  }
  // Aplikasi dibuka lagi / jaringan kembali: soket yang tertutup disambung ulang tanpa menunggu jeda
  // backoff, soket yang masih CONNECTING dari sebelum jaringan pulih diganti baru, dan yang tampak
  // terbuka diuji dengan ping (relay menjawab dalam hitungan milidetik; tanpa jawaban 4 detik → sambung ulang).
  wake() {
    if (this.closedByUser) return;
    this.backoff = 1000;
    if (!this.ws || this.ws.readyState > 1) return this.connect();
    if (this.ws.readyState === 0) return Date.now() - this.startedAt > 3000 && this.drop();
    if (!this.greeted) return;
    const since = Date.now();
    clearTimeout(this.probeT);
    this.ws.send('ping');
    this.probeT = setTimeout(() => this.lastRx < since && this.drop(), 4000);
  }
  // Tombol "Coba sekarang": lepaskan percobaan yang sedang berjalan dan sambung ulang segera.
  retry() {
    if (this.closedByUser) return;
    this.backoff = 1000;
    this.drop();
  }
  close() {
    this.closedByUser = true;
    clearInterval(this.ping);
    clearTimeout(this.connectT);
    clearTimeout(this.authT);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
  on(ev, fn) {
    this.handlers[ev] = fn;
  }
  emit(ev, ...a) {
    this.handlers[ev]?.(...a);
  }
  sendRaw(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
  // Kanal biner (relay & daemon baru): pesan besar dipecah, tanpa base64 & JSON berlapis.
  onBinary(buf) {
    if (!this.channel) return;
    const msg = this.channel.openBin(buf);
    if (msg) this.onMessage(msg);
  }
  onMessage(msg) {
    if (msg.ev === 'ready') return this.emit('ready', msg.info);
    if (msg.ev) return this.emit(msg.ev, msg);
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    msg.err ? p.reject(new Error(msg.err)) : p.resolve(msg.r);
  }
  onFrame(raw) {
    if (raw === 'pong') return;
    let f;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    switch (f.t) {
      case 'status':
        clearTimeout(this.connectT);
        clearTimeout(this.authT);
        this.greeted = true;
        this.attempts = 0;
        if (f.bin) this.relayBin = true;
        this.online = f.online;
        this.emit('state', f.online ? 'online' : 'offline');
        if (f.online) this.startAuth();
        return;
      case 'auth2': {
        clearTimeout(this.authT);
        const r = C.authFinishPhone(C.hexToBytes(this.dev.secret), this.authState, f);
        if (!r) return this.emit('state', 'authfail');
        this.channel = r.channel;
        this.bin = !!f.bin;
        this.sendRaw({ t: 'auth3', ...r.msg });
        return;
      }
      case 'auth_err':
        clearTimeout(this.authT);
        store.set('dev.' + this.m.id, null);
        return this.emit('state', 'needpin');
      case 'pair2': {
        const r = C.pairFinishPhone(this.pairState, f);
        if (!r) return this.pairDone?.({ ok: false, reason: 'pin', left: f.left });
        this.pairSecret = r.deviceSecret;
        this.sendRaw({ t: 'pair3', ...r.msg });
        return;
      }
      case 'pair_ok':
        store.set('dev.' + this.m.id, { deviceId: f.deviceId, secret: C.bytesToHex(this.pairSecret) });
        this.pairDone?.({ ok: true });
        this.startAuth();
        return;
      case 'pair_err':
        return this.pairDone?.({ ok: false, reason: f.reason, until: f.until });
      case 'e':
        return this.onMessage(this.channel.open(f));
    }
  }
  startAuth() {
    const dev = this.dev;
    if (!dev) return this.emit('state', 'needpin');
    const a = C.authStartPhone();
    this.authState = a.state;
    const ws = this.ws;
    clearTimeout(this.authT);
    this.authT = setTimeout(() => this.ws === ws && !this.channel && this.drop(), AUTH_MS);
    this.sendRaw({ t: 'auth1', deviceId: dev.deviceId, ...a.msg, ...(this.relayBin ? { bin: 1 } : {}) });
  }
  async pair(pin) {
    const prs = await C.pinToPrs(pin, this.m.id);
    const p = C.pairStartPhone(prs);
    this.pairState = p.state;
    return new Promise((resolve) => {
      this.pairDone = (r) => {
        this.pairDone = null;
        resolve(r);
      };
      this.sendRaw({ t: 'pair1', ...p.msg, name: deviceName() });
    });
  }
  call(m, p = {}) {
    if (!this.channel) return Promise.reject(new Error('Belum terhubung ke PC'));
    const id = ++this.rpcId;
    if (this.bin) for (const f of this.channel.sealBin({ id, m, p })) this.ws.send(f);
    else this.ws.send(JSON.stringify(this.channel.seal({ id, m, p })));
    const ms = RPC_SLOW.has(m) ? RPC_SLOW_MS : RPC_MS;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`PC tidak menjawab dalam ${ms / 1000} detik. Periksa koneksi lalu coba lagi.`));
        this.wake(); // mungkin koneksinya yang macet
      }, ms);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
    });
  }
}

