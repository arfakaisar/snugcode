// Daemon: connects to the relay (outbound only), handles PIN pairing,
// an encrypted channel per phone, a local channel for the terminal (TUI), and RPC.
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

// Used by cli.js & tests (formerly defined here).
export { defaultModel };

// Daemon <-> client protocol version. 2 = binary channel + a `caps` list in info.
const PROTO = 2;
// Relay heartbeat: ping every PING_MS; with no message at all for DEAD_MS the connection is considered dead.
export const PING_MS = 25_000;
export const DEAD_MS = 70_000;
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export class Daemon {
  constructor(config, { log = console.log } = {}) {
    this.config = config;
    this.secrets = loadSecrets();
    this.log = log;
    // The legacy router (config.routerUrl + secrets.routerKey) becomes the `router` connection.
    if (migrateLegacy(config, this.secrets)) saveSecrets(this.secrets);
    this.updaterMeta = getInstallInfo(config);
    // GitHub tokens in env (e.g. GITHUB_TOKEN from Codespaces) & the runner's bootstrap env must not be
    // inherited by the agent, its Bash, dev servers, or `!commands`.
    scrubSecretEnv();
    // Cloud runners have no "sleeping PC".
    this.keepAwake = isCloud(config) ? null : startKeepAwake({ log: (m) => this.log(m) });
    this.conns = new Map();
    this.sessions = new SessionManager({ config, secrets: this.secrets, log: (m) => (process.env.SNUGCODE_DEBUG || process.env.POCKETCODE_DEBUG) && log(m), notify: (s, msg, o) => this.notify(s, msg, o) });
    this.backoff = 1000;
    this.stopped = false;
    this.lastPairAttempt = 0;
    this.locals = new Set();
    this.github = new GithubAuth(this);
    this.terms = new Terminals({ log: (m) => this.log(m) });
    // Notify every connected phone & terminal when the GitHub login status changes.
    this.github.on('change', (st) => {
      for (const c of [...this.conns.values(), ...this.locals]) if (c.ready) c.push({ ev: 'github', ...st });
    });
  }

  saveSecrets() {
    saveSecrets(this.secrets);
  }

  // ---------- model connections ----------
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

  // Save a detected connection. One connection per catalog provider (replacing the old one); routers &
  // custom endpoints can be many (router, router2, …). The `router` connection = models without a prefix.
  /** @param {any} conn @param {{ replace?: string, models?: { id: string, isDefault?: boolean }[] }} [opts] */
  saveConnection(conn, { replace, models } = {}) {
    const sec = this.secrets;
    const id = putConnection(sec, conn, { replace });
    mirrorLegacy(this.config, sec);
    forgetModels(id);
    this.sessions.resetRouter(id);
    // Default model: kept if still usable; otherwise pick one from the new connection (in the background).
    let ok = true;
    try {
      resolveRoute(sec, this.config.model);
    } catch {
      ok = false;
    }
    // The detected model list is already there: the default model is picked right away (the RPC reply includes it).
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
      this.log('! failed to pick a default model: ' + e.message);
    }
  }

  removeConnection(id) {
    const sec = this.secrets;
    if (!sec.connections?.[id]) throw new Error('Connection not found');
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
    this.connect().catch((e) => this.log('! failed to reach the relay: ' + e.message));
    this.listenLocal();
    this.github.startChecks();
    this.startUpdateChecks();
    if (isCloud(this.config)) this.startIdleWatch();
  }

  // ---------- Cloud runner: stops itself when idle ----------
  // Idle = no agent/command/dev server/tunnel running and no phone currently
  // has the app open (or a terminal connected). Codespaces quota / container costs aren't wasted.
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
      // Sent before stopping: once the codespace/container is down nothing can notify the phone anymore.
      await this.pushAll({ title: `snugcode · ${this.config.machineName || 'Runner'}`, body: `Runner stopped after ${mins} idle minutes (saving quota). Open the app to start it again.`, tag: 'runner-idle:' + this.config.machineId });
      const how = await stopRunner(this.config, this.secrets);
      if (how) this.log(`◆ Runner idle for ${mins} minutes: stopped (${how === 'exit' ? 'daemon exited' : 'Codespaces'}). Open the app to start it again.`);
      if (how === 'exit') setTimeout(() => Promise.resolve(this.stop()).finally(() => process.exit(0)), 50);
      return how;
    } catch (e) {
      this.log('! failed to stop the runner: ' + e.message);
      this.saveSecrets();
      return null;
    } finally {
      this.lastActive = now; // failed / no way to stop: try again one period later
      this.idleStopping = false;
    }
  }

  // Wait (briefly) until the sessions' dev servers & tunnels are really dead.
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

  // Local channel for `snugcode` in the terminal. Only accessible to the same user
  // (file/pipe permissions) and still requires the local token from secrets.json.
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
    this.ipc.on('error', (e) => this.log('! local channel failed: ' + e.message));
    this.ipc.listen(IPC_PATH, () => {
      if (process.platform !== 'win32') fs.chmodSync(IPC_PATH, 0o600);
    });
  }

  // Relays accept the token via subprotocol (not recorded in URL logs). Only a relay that answers its health check
  // without `wsProto` (a very old self-hosted one) gets `?token=`: an unreachable health check must never downgrade
  // to putting the machine token in the URL.
  async relaySupportsProto() {
    if (this.wsProto !== undefined) return this.wsProto;
    try {
      const r = await fetch(this.config.relayUrl.replace(/\/+$/, '') + '/api/health', { signal: AbortSignal.timeout(5000) });
      this.wsProto = !!(await r.json()).wsProto;
    } catch {
      return true; // checked again on the next reconnect
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
    this.relayBin = false; // old relays only forward text frames; newer relays send hello { bin }
    ws.onopen = () => {
      this.backoff = 1000;
      this.lastRx = Date.now();
      this.log(`✓ Connected to the relay as "${this.config.machineName}". Open the app on your phone to start.`);
      clearInterval(this.ping);
      // Heartbeat: the relay answers every `ping`. With no answer for DEAD_MS (Wi-Fi change, PC waking from
      // sleep, NAT dropping the connection), the socket is considered dead even without `close`, and reconnected.
      this.ping = setInterval(() => {
        if (ws.readyState !== 1) return;
        if (Date.now() - this.lastRx > DEAD_MS) return this.dropRelay(ws, 'no answer from the relay');
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
      if (this.ws !== ws) return; // an old socket already replaced by dropRelay
      clearInterval(this.ping);
      for (const c of this.conns.values()) c.closed();
      this.conns.clear();
      if (this.stopped) return;
      if (ev.code === 4003) {
        this.log('✗ This PC was removed from the account. Run `snugcode setup` again.');
        return;
      }
      if (ev.code === 4000) this.log('! Another daemon with the same PC took over the connection.');
      const wait = ev.code === 4000 ? 60000 : this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30000);
      setTimeout(() => this.connect().catch((e) => this.log('! failed to reach the relay: ' + e.message)), wait);
    };
    ws.onerror = () => {};
  }

  // Half-dead socket: let it go (its close may hang for a long time) and reconnect now.
  dropRelay(ws, why) {
    this.log(`! Relay connection stuck (${why}): reconnecting…`);
    clearInterval(this.ping);
    this.ws = null;
    for (const c of this.conns.values()) c.closed();
    this.conns.clear();
    try {
      ws.close();
    } catch {}
    if (!this.stopped) this.connect().catch((e) => this.log('! failed to reach the relay: ' + e.message));
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

  // Web Push to every installed phone (not about a single session), waited for at most `ms`.
  pushAll(payload, ms = 5000) {
    const sends = Object.values(this.secrets.devices || {})
      .filter((dev) => dev.push)
      .map((dev) => sendPush(dev.push, { mid: this.config.machineId, ...payload }).catch((e) => this.log('! push failed: ' + e.message)));
    return Promise.race([Promise.allSettled(sends), new Promise((r) => setTimeout(r, ms).unref?.())]);
  }

  // perm: permission card (separate notification tag; pid + risk → Allow/Deny buttons in the notification).
  // minor: side news (e.g. a dev server stopped) skipped by phones in "important only" mode.
  /** @param {any} session @param {string} msg @param {{ perm?: boolean, pid?: string, risk?: string, minor?: boolean }} [o] */
  notify(session, msg, { perm = false, pid, risk, minor = false } = {}) {
    const title = session.meta.title || session.meta.repo;
    for (const c of [...this.conns.values(), ...this.locals]) if (c.ready) c.push({ ev: 'notice', sid: session.id, msg, title });
    // Phones currently viewing this session already see it live; the rest get Web Push.
    const watching = new Set([...this.conns.values()].filter((c) => c.ready && c.visible && c.sub?.session === session).map((c) => c.deviceId));
    for (const [id, dev] of Object.entries(this.secrets.devices)) {
      if (!dev.push || watching.has(id) || (minor && dev.pushLevel === 'important')) continue;
      sendPush(dev.push, { title: `snugcode · ${title}`, body: msg, tag: session.id + (perm ? ':perm' : ''), sid: session.id, mid: this.config.machineId, ...(pid && risk !== 'high' ? { pid, risk } : {}) })
        .then((alive) => {
          if (alive) return;
          delete dev.push;
          this.saveSecrets();
        })
        .catch((e) => this.log('! push failed: ' + e.message));
    }
  }
}

// Shared RPC for phones (via the relay) and terminals (local).
class RpcConn {
  constructor(daemon) {
    this.d = daemon;
    /** @type {import('./sessions.js').Session | null} the MCP bridge's session (dev tools only) */
    this.bridge = null;
    this.ready = false;
    this.sub = null; // { session, listener }
    this.queue = [];
    this.queueSid = null;
    this.visible = true; // the phone reports when the PWA goes to the background (for Web Push)
  }

  /** Send a message to the client (implemented by LocalConn/PhoneConn). @param {object} msg */
  push(msg) {
    throw new Error('not implemented');
  }

  // The connection is gone: the remaining event queue doesn't need sending.
  closed() {
    this.queue = [];
    this.unsubscribe();
    this.d.terms.detachConn(this);
  }

  async handleRpc({ id, m, p }) {
    try {
      if (this.bridge && m !== 'devTools' && m !== 'devTool') throw new Error('Not allowed for the MCP bridge');
      const fn = Object.hasOwn(RPC, m) ? RPC[m] : null;
      if (!fn) throw new Error('Unknown method: ' + m);
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
      // The subagent light model for the default model (each session computes it from its own model).
      lightModel: c.model ? lightModel(c.model, knownRefs(sec, splitRef(c.model).conn)).id : null,
      router: getConn(sec, 'router')?.openai || c.routerUrl,
      connections: this.d.connList(),
      github: c.githubLogin || null,
      githubState: this.d.github.state,
      platform: process.platform,
      // The PWA uses this to recognize old daemons (before the rename) and offer migration.
      brand: 'snugcode',
      version: this.d.updaterMeta?.version || PKG_VERSION,
      commit: this.d.updaterMeta?.commit || 'main',
      preventSleep: this.d.keepAwake?.active?.() ?? false,
      // 'pc' | 'cloud' (Codespaces / container). The PWA hides PC-only features & shows runner settings.
      runtime: c.runtime || 'pc',
      machineId: c.machineId,
      // A model connection exists (formerly: a 9router key). Old name kept for old app versions.
      routerConfigured: Object.keys(sec.connections || {}).length > 0,
      runner: isCloud(c) ? { ...(c.runner || {}), idleStopMinutes: idleMinutes(c), autoStop: !!this.d.secrets.runnerToken || !!c.runner?.idleExit, ...(c.runner?.provider === 'codespace' ? { usage: usageSummary() } : {}) } : null,
      // Protocol features this daemon supports: clients check this instead of guessing from error messages.
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

  // Events are batched every ~60ms into one frame. The queue only holds events from one session:
  // switching sessions sends the old queue first (formerly new-session events could carry the old session's label).
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

// Terminal on the same PC: line-delimited JSON over a named pipe / unix socket.
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
      // Codex engine MCP bridge: a per-session token, only for that session's dev tools.
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

  // Binary channel if both the phone & relay support it (agreed during auth); otherwise text frames.
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
      this.d.log('! message rejected: ' + e.message);
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
      this.d.log('! message rejected: ' + e.message);
      this.d.kick(this.cid, 'protocol');
    }
  }

  // ---------- Pairing PIN ----------
  pair1(m) {
    const s = this.d.secrets;
    if (!s.prs) return this.send({ t: 'pair_err', reason: 'nopin' });
    if (Date.now() - this.d.lastPairAttempt < 3000 && !(s.pinLockUntil > Date.now())) return this.send({ t: 'pair_err', reason: 'slow' });
    // Counted before the result is known: a guesser only needs to see pair2 to test one guess.
    const att = pinAttempt(s);
    if ('until' in att) return this.send({ t: 'pair_err', reason: 'locked', until: att.until });
    this.d.lastPairAttempt = Date.now();
    this.d.saveSecrets();
    const r = C.pairRespondMachine(C.hexToBytes(s.prs), m);
    this.pairState = { ...r.state, name: String(m.name || 'Phone').slice(0, 60) };
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
    this.d.log(`✓ New device paired: ${name} (${deviceId})`);
    this.send({ t: 'pair_ok', deviceId });
  }

  // ---------- Paired device authentication ----------
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

  // Revoke applies immediately.
  onRpc(msg) {
    if (!this.d.secrets.devices[this.deviceId]) return this.d.kick(this.cid, 'revoked');
    return this.handleRpc(msg);
  }
}
