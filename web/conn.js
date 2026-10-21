// Encrypted phone <-> PC connection via the relay: PIN pairing, device auth, E2EE channel
// (legacy text frames or binary v2), and id-based RPC. No DOM, just WebSocket + localStorage.
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
  return os + ' · ' + new Date().toLocaleDateString('en-US');
}

// Heartbeat: the relay answers `ping`. With no message at all for DEAD_MS (Wi-Fi ↔ cellular, phone asleep)
// the socket is treated as half-dead even without `close`, and reconnected.
const PING_MS = 20000;
const DEAD_MS = 50000;
// Connect timeout: a socket can hang in CONNECTING indefinitely (phone just woke up, cellular network
// swallowing packets) and the browser only gives up after minutes. Without a relay `status` within this
// time the socket is dropped and retried (longer each attempt, for genuinely slow networks).
const CONNECT_MS = 10000;
const CONNECT_MAX_MS = 30000;
// Relay answered but the PC doesn't reply to auth (PC↔relay socket half-dead): try a new channel.
const AUTH_MS = 20000;
// RPC timeout: without it buttons & spinners could wait forever on a stuck connection.
const RPC_MS = 30000;
const RPC_SLOW_MS = 180000;
const RPC_SLOW = new Set(['create', 'update', 'rollback', 'connAdd', 'configure', 'chatgptLogin', 'probeModel', 'modelsAll', 'modelsInfo', 'models', 'repos', 'branches', 'attach', 'preview', 'screenshot', 'runDev', 'cleanup', 'push', 'pr', 'commit', 'revert', 'diff', 'status', 'delete', 'send', 'termOpen', 'procStart']);

// ---------- Encrypted connection to the PC ----------
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
    // Login token via subprotocol, not the URL (stays out of logs); the relay answers with subprotocol `snugcode`.
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
      // "Sign out everywhere": the relay revoked the login token, so sign in again.
      if (ev.code === 4005) {
        store.set('token', null);
        return location.reload();
      }
      this.reconnectTimer = setTimeout(() => !this.closedByUser && this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
  }
  // Connection lost: all pending RPCs fail with a clear message, the UI shows "reconnecting".
  lost() {
    clearInterval(this.ping);
    clearTimeout(this.probeT);
    clearTimeout(this.connectT);
    clearTimeout(this.authT);
    this.channel = null;
    for (const p of this.pending.values()) p.reject(new Error('Connection lost'));
    this.pending.clear();
    this.emit('state', 'reconnecting');
  }
  // Half-dead socket: drop it without waiting for `close` (can take tens of seconds) and reconnect.
  drop() {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
    this.lost();
    if (!this.closedByUser) this.connect();
  }
  // App reopened / network back: a closed socket reconnects without the backoff delay, a socket still
  // CONNECTING from before the network recovered is replaced, and one that looks open is probed with a
  // ping (the relay answers within milliseconds; no answer in 4 seconds → reconnect).
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
  // "Try now" button: drop the attempt in progress and reconnect immediately.
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
  // Binary channel (new relay & daemon): large messages are chunked, no base64 & nested JSON.
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
    if (!this.channel) return Promise.reject(new Error('Not connected to the PC yet'));
    const id = ++this.rpcId;
    if (this.bin) for (const f of this.channel.sealBin({ id, m, p })) this.ws.send(f);
    else this.ws.send(JSON.stringify(this.channel.seal({ id, m, p })));
    const ms = RPC_SLOW.has(m) ? RPC_SLOW_MS : RPC_MS;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`The PC didn’t answer within ${ms / 1000} seconds. Check the connection and try again.`));
        this.wake(); // maybe the connection is stuck
      }, ms);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
    });
  }
}

