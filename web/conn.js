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
  }
  get dev() {
    return store.get('dev.' + this.m.id);
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    clearTimeout(this.reconnectTimer);
    const ws = new WebSocket(`${proto}//${location.host}/ws/phone?token=${encodeURIComponent(token())}&mid=${encodeURIComponent(this.m.id)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.channel = null;
    this.bin = false;
    ws.onmessage = (ev) => this.ws === ws && (typeof ev.data === 'string' ? this.onFrame(ev.data) : this.onBinary(ev.data));
    ws.onopen = () => {
      this.backoff = 1000;
      clearInterval(this.ping);
      this.ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25000);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      clearInterval(this.ping);
      this.channel = null;
      for (const p of this.pending.values()) p.reject(new Error('Koneksi terputus'));
      this.pending.clear();
      this.emit('state', 'reconnecting');
      if (this.closedByUser) return;
      if (ev.code === 4001 && ev.reason === 'revoked') {
        store.set('dev.' + this.m.id, null);
        return this.emit('state', 'revoked');
      }
      if (ev.code === 4003) return this.emit('state', 'removed');
      this.reconnectTimer = setTimeout(() => !this.closedByUser && this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
  }
  close() {
    this.closedByUser = true;
    clearInterval(this.ping);
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
    const f = JSON.parse(raw);
    switch (f.t) {
      case 'status':
        if (f.bin) this.relayBin = true;
        this.online = f.online;
        this.emit('state', f.online ? 'online' : 'offline');
        if (f.online) this.startAuth();
        return;
      case 'auth2': {
        const r = C.authFinishPhone(C.hexToBytes(this.dev.secret), this.authState, f);
        if (!r) return this.emit('state', 'authfail');
        this.channel = r.channel;
        this.bin = !!f.bin;
        this.sendRaw({ t: 'auth3', ...r.msg });
        return;
      }
      case 'auth_err':
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
        return this.pairDone?.({ ok: false, reason: f.reason });
      case 'e':
        return this.onMessage(this.channel.open(f));
    }
  }
  startAuth() {
    const dev = this.dev;
    if (!dev) return this.emit('state', 'needpin');
    const a = C.authStartPhone();
    this.authState = a.state;
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
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

