// Daemon: tersambung ke relay (koneksi keluar saja), menangani pairing PIN,
// kanal terenkripsi per HP, kanal lokal untuk terminal (TUI), dan RPC.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import * as C from '../shared/crypto.js';
import { loadSecrets, saveSecrets, saveConfig, IPC_PATH, isCloud, scrubSecretEnv, pinAttempt, resetPinLock } from './config.js';
import { SessionManager } from './sessions.js';
import { lightModel } from '../shared/models.js';
import { splitRef, joinRef } from '../shared/providers.js';
import { migrateLegacy, mirrorLegacy, putConnection, allConnections, getConn, connSummary, detectConnection, listConnModels, listAllModels, knownRefs, forgetModels, resolveRoute, probeRoute } from './providers.js';
import { chatgptLoginStart, chatgptLogout, chatgptModels } from './codex.js';
import { devToolList, callDevTool } from './devtools.js';
import { mergeText } from '../shared/events.js';
import { listRepos, gitStatus, gitDiff, gitCommit, gitPush, createPR, gh, currentBranch, TOKEN_INVALID } from './github.js';
import { GithubAuth } from './ghauth.js';
import { getInstallInfo, checkUpdate, performUpdate, performRollback, restartDaemon } from './updater.js';
import { startKeepAwake } from './keepawake.js';
import { detectProject, saveEnv } from './project.js';
import { capture } from './browser.js';
import { checkPush, sendPush } from './webpush.js';
import { idleMinutes, stopRunner } from './runner.js';

// Versi protokol daemon <-> klien. 2 = kanal biner + daftar `caps` di info.
const PROTO = 2;

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
    this.connect();
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
    this.idleTimer = setInterval(() => this.checkIdle(), 60_000);
    this.idleTimer.unref?.();
  }

  isActive() {
    return this.sessions.busy() || this.locals.size > 0 || [...this.conns.values()].some((c) => c.ready && c.visible);
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

  connect() {
    const url = this.config.relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws/machine?token=' + encodeURIComponent(this.secrets.machineToken);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.relayBin = false; // relay lama hanya meneruskan frame teks; relay baru mengirim hello { bin }
    ws.onopen = () => {
      this.backoff = 1000;
      this.log(`✓ Terhubung ke relay sebagai "${this.config.machineName}". Buka aplikasi di HP untuk mulai.`);
      clearInterval(this.ping);
      this.ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25000);
    };
    ws.onmessage = (ev) => {
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
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => {};
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

  notify(session, msg, { perm = false } = {}) {
    const title = session.meta.title || session.meta.repo;
    for (const c of [...this.conns.values(), ...this.locals]) if (c.ready) c.push({ ev: 'notice', sid: session.id, msg, title });
    // HP yang sedang membuka sesi ini sudah melihatnya langsung; sisanya dapat Web Push.
    const watching = new Set([...this.conns.values()].filter((c) => c.ready && c.visible && c.sub?.session === session).map((c) => c.deviceId));
    for (const [id, dev] of Object.entries(this.secrets.devices)) {
      if (!dev.push || watching.has(id)) continue;
      sendPush(dev.push, { title: `snugcode · ${title}`, body: msg, tag: session.id + (perm ? ':perm' : ''), sid: session.id, mid: this.config.machineId })
        .then((alive) => {
          if (alive) return;
          delete dev.push;
          this.saveSecrets();
        })
        .catch((e) => this.log('! push gagal: ' + e.message));
    }
  }
}

// ---------- RPC ----------
// Validasi input RPC: pesan dari HP/terminal tidak pernah dipercaya bentuknya.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
function need(v, name, { type = 'string', max = 100_000 } = {}) {
  if (type === 'string' && (typeof v !== 'string' || !v || v.length > max)) throw new Error(`${name} tidak valid`);
  if (type === 'number' && !Number.isFinite(+v)) throw new Error(`${name} tidak valid`);
  return type === 'number' ? +v : v;
}
const opt = (v, name, o) => (v == null || v === '' ? undefined : need(v, name, o));

// Model default saat koneksi baru dipasang dari HP: Claude Sonnet/Opus bila ada, lalu Claude lain,
// lalu model GPT Codex, Gemini Pro, lalu yang pertama.
export function defaultModel(ids) {
  const pref = [/^cc\/claude-sonnet/, /^cc\/claude-opus/, /^(cc\/|[a-z]+:)?claude-sonnet/, /^(cc\/|[a-z]+:)?claude-opus/, /^(cc\/)?claude-/, /claude/, /gpt-[\d.]+-codex(?!-mini)/, /gpt-[\d.]+$/, /gemini.*pro/, /gemini/];
  for (const re of pref) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return ids[0];
}

// Tabel metode RPC: (conn, params) -> hasil. `conn.d` = Daemon, `conn.big` = kanal biner (tanpa batas 1MB relay).
const RPC = {
  info: (c) => c.info(),
  updateStatus: (c) => checkUpdate(c.d.config, c.d.secrets),
  async update(c) {
    // claude.exe yang masih jalan mengunci file-nya → npm gagal memasang binary baru.
    await c.d.sessions.stopAll();
    const res = await performUpdate(c.d.config, c.d.secrets);
    restartDaemon(c.d, { delay: 1200 });
    return { ok: true, message: 'Update berhasil dipasang. PC sedang me-restart daemon...', commit: res.commit };
  },
  // Versi baru bermasalah: pasang lagi versi sebelum pembaruan terakhir.
  async rollback(c) {
    await c.d.sessions.stopAll();
    const res = await performRollback(c.d.config);
    restartDaemon(c.d, { delay: 1200 });
    return { ok: true, message: `Kembali ke ${res.commit}. PC sedang me-restart daemon...`, commit: res.commit };
  },
  restart(c) {
    restartDaemon(c.d, { delay: 1000 });
    return { ok: true, message: 'Daemon sedang me-restart...' };
  },
  // `snugcode stop/restart` dari PC: berhenti dengan rapi agar dev server & tunnel ikut mati
  // (di Windows, process.kill tidak menjalankan handler apa pun).
  shutdown(c) {
    if (!c.local) throw new Error('Hanya dari terminal PC');
    setTimeout(() => Promise.resolve(c.d.stop()).finally(() => process.exit(0)), 50);
    return true;
  },
  githubStatus: (c, p) => (p.check ? c.d.github.check() : c.d.github.status()),
  githubLogin: (c) => c.d.github.begin(),
  models: async (c) => (await c.d.models()).models.map((m) => m.id), // versi lama: daftar ID saja
  modelsInfo: async (c, p) => (await c.d.models({ fresh: !!p.fresh })).models,
  // Model semua koneksi + koneksi yang gagal dihubungi (ditampilkan di pemilih model).
  modelsAll: (c, p) => c.d.models({ fresh: !!p.fresh }),
  async probeModel(c, p) {
    const route = resolveRoute(c.d.secrets, need(p.model, 'model', { max: 300 }));
    // ChatGPT: kesehatan model dijamin Codex; menguji lewat app-server terlalu mahal untuk tiap pilihan.
    if (route.wire === 'chatgpt') return { ok: true, ms: 0, text: 'ChatGPT' };
    return probeRoute(route);
  },
  setModel(c, p) {
    // Model ringan (subagen) tidak lagi bisa dipilih: otomatis dari koneksi yang sama (Haiku / Flash).
    if (p.model) {
      const model = need(p.model, 'model', { max: 300 });
      resolveRoute(c.d.secrets, model); // koneksi model ini harus ada
      c.d.config.model = model;
    }
    saveConfig(c.d.config);
    return c.info();
  },
  // ---------- koneksi model (API key official, router, endpoint kustom, login ChatGPT) ----------
  // Key dikirim lewat kanal E2EE, divalidasi ke endpoint-nya dulu, dan tidak pernah dikembalikan ke klien.
  connections: (c) => c.d.connList(),
  async connAdd(c, p) {
    const key = opt(p.key, 'API key', { max: 2000 })?.trim();
    const url = opt(p.url, 'URL', { max: 400 })?.trim();
    const kind = opt(p.kind, 'jenis', { max: 32 });
    const det = await detectConnection({ key, url, kind });
    const { models, ...conn } = det;
    const id = c.d.saveConnection(conn, { replace: opt(p.replace, 'id', { max: 40 }), models });
    return { conn: c.d.connList().find((x) => x.id === id), models: models.length, info: c.info() };
  },
  connRemove(c, p) {
    c.d.removeConnection(need(p.id, 'id', { max: 40 }));
    return c.info();
  },
  // Login ChatGPT (langganan Plus/Pro) lewat Codex resmi, dengan kode perangkat yang bisa diselesaikan dari HP.
  async chatgptLogin(c) {
    const d = c.d;
    const r = await chatgptLoginStart(d.config, {
      log: (m) => d.log(m),
      onDone: ({ ok, account, err }) => {
        if (ok) {
          d.saveConnection({ kind: 'chatgpt', label: 'ChatGPT', formats: {}, account: { email: account?.email || null, plan: account?.planType || null } }, { replace: 'chatgpt' });
          d.log(`✓ ChatGPT tersambung${account?.email ? ' sebagai ' + account.email : ''}`);
        }
        d.broadcast({ ev: 'chatgpt', ok, err: ok ? null : err || 'Login ChatGPT gagal', info: null });
        d.broadcast({ ev: 'connections', list: d.connList() });
      },
    });
    return r;
  },
  async chatgptLogout(c) {
    await chatgptLogout(c.d.config).catch(() => {});
    if (getConn(c.d.secrets, 'chatgpt')) c.d.removeConnection('chatgpt');
    return c.info();
  },
  // ---------- jembatan MCP engine Codex (hanya koneksi jembatan satu sesi) ----------
  devTools(c) {
    if (!c.bridge) throw new Error('Hanya untuk jembatan MCP');
    return devToolList();
  },
  devTool(c, p) {
    if (!c.bridge) throw new Error('Hanya untuk jembatan MCP');
    return callDevTool(c.bridge, need(p.name, 'tool', { max: 64 }), p.args && typeof p.args === 'object' ? p.args : {});
  },
  // ---------- setelan dari HP (dulu hanya `snugcode setup` / `pin` / `devices` / `revoke`) ----------
  // Bentuk lama (aplikasi versi lama): satu router = koneksi `router`.
  async configure(c, p) {
    const cur = getConn(c.d.secrets, 'router');
    const url = p.routerUrl != null && p.routerUrl !== '' ? need(p.routerUrl, 'URL router', { max: 300 }).trim().replace(/\/+$/, '') : cur?.openai || c.d.config.routerUrl;
    if (!/^https?:\/\/[^\s/]+/i.test(url || '')) throw new Error('URL router harus diawali http:// atau https://');
    const key = p.routerKey ? need(p.routerKey, 'key 9router', { max: 1000 }).trim() : cur?.key;
    if (!key) throw new Error('Key 9router kosong');
    // Divalidasi dulu: key/URL yang salah tidak menimpa konfigurasi yang sedang berjalan.
    const { models, ...conn } = await detectConnection({ key, url, kind: 'router' });
    c.d.saveConnection(conn, { replace: 'router', models });
    return c.info();
  },
  devices: (c) =>
    Object.entries(c.d.secrets.devices).map(([id, d]) => ({
      id,
      name: d.name,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      push: !!d.push,
      current: id === c.deviceId,
      online: [...c.d.conns.values()].some((x) => x.ready && x.deviceId === id),
    })),
  revoke(c, p) {
    const devs = c.d.secrets.devices;
    const ids = p.id === 'all' ? Object.keys(devs) : [need(p.id, 'id', { max: 64 })];
    for (const id of ids) {
      if (!devs[id]) throw new Error('Perangkat tidak ditemukan');
      delete devs[id];
    }
    c.d.saveSecrets();
    // Diputus setelah balasan terkirim (perangkat yang mencabut dirinya sendiri tetap menerima jawaban).
    setTimeout(() => {
      for (const x of c.d.conns.values()) if (ids.includes(x.deviceId)) c.d.kick(x.cid, 'revoked');
    }, 300);
    return true;
  },
  async setPin(c, p) {
    const pin = need(p.pin, 'PIN', { max: 12 });
    if (!C.PIN_RE.test(pin)) throw new Error('PIN harus 6–12 huruf/angka.');
    const s = c.d.secrets;
    s.prs = C.bytesToHex(await C.pinToPrs(pin, c.d.config.machineId));
    resetPinLock(s);
    c.d.saveSecrets();
    return true;
  },
  // Runner cloud: token Codespaces milik HP (scope `codespace`) agar runner bisa menghentikan dirinya
  // sendiri saat menganggur, dan batas menit menganggur. Disimpan di secrets.json (tertutup bagi agen).
  runnerConfig(c, p) {
    const cfg = c.d.config;
    if (!isCloud(cfg)) throw new Error('Hanya untuk runner cloud');
    if (p.token !== undefined) {
      if (p.token) c.d.secrets.runnerToken = need(p.token, 'token', { max: 400 });
      else delete c.d.secrets.runnerToken;
      c.d.saveSecrets();
    }
    if (p.idleStopMinutes != null) {
      cfg.idleStopMinutes = Math.max(0, Math.min(24 * 60, need(p.idleStopMinutes, 'menit', { type: 'number' })));
      saveConfig(cfg);
    }
    return c.info().runner;
  },
  setSessionModel(c, p) {
    const s = c.d.sessions.get(p.id);
    if (s.status === 'running') throw new Error('Tunggu agen selesai (atau Stop) sebelum ganti model.');
    const model = need(p.model, 'model', { max: 200 });
    if (s.meta.model !== model) {
      s.emitEvent({ k: 'note', d: `◆ model: ${s.meta.model} → ${model}` });
      s.meta.model = model;
      c.d.sessions.saveIndex();
    }
    return s.summary();
  },
  repos(c, p) {
    if (!c.d.secrets.githubToken) throw new Error('PC ini belum login GitHub. Login dari Pengaturan PC → GitHub di aplikasi, atau jalankan `snugcode login` di PC.');
    return listRepos(c.d.secrets.githubToken, opt(p.q, 'q', { max: 200 }), c.d.config.githubLogin);
  },
  async branches(c, p) {
    if (!REPO_RE.test(p.repo || '')) throw new Error('repo tidak valid');
    const list = await gh(c.d.secrets.githubToken, 'GET', `/repos/${p.repo}/branches?per_page=100`);
    return list.map((b) => b.name);
  },
  sessions: (c) => c.d.sessions.list(),
  create: async (c, p) => (await c.d.sessions.create(p)).summary(),
  attach(c, p) {
    const s = c.d.sessions.get(p.id);
    c.subscribe(s);
    // Frame relay teks dibatasi ~1MB: kirim riwayat terbaru saja bila terlalu besar.
    // Kanal biner memecah pesan besar, jadi batasnya jauh lebih longgar.
    const since = +p.since || 0;
    const all = mergeText(s.since(since));
    const limit = c.big ? 4_000_000 : 500_000;
    let i = all.length;
    for (let size = 0; i > 0 && size < limit; i--) size += JSON.stringify(all[i - 1]).length;
    const events = i ? all.slice(i) : all;
    s.warm();
    return { session: s.summary(), events, truncated: events.length < all.length || s.missingSince(since), perms: s.pendingPerms(), procs: s.procs.list(), preview: s.previewInfo() };
  },
  detach(c) {
    c.unsubscribe();
    return true;
  },
  async send(c, p) {
    await c.d.sessions.get(p.id).send(String(p.text || ''), p.images);
    return true;
  },
  async interrupt(c, p) {
    await c.d.sessions.get(p.id).interrupt();
    return true;
  },
  perm: (c, p) => c.d.sessions.get(p.id).answerPermission(p.pid, p.decision, { answers: p.answers, message: p.message }),
  plan(c, p) {
    const s = c.d.sessions.get(p.id);
    s.setPlan(p.on);
    return s.summary();
  },
  rewind: (c, p) => c.d.sessions.get(p.id).rewindTo(need(p.seq, 'seq', { type: 'number' })),
  // ---------- proses latar belakang & preview ----------
  project(c, p) {
    const s = c.d.sessions.get(p.id);
    return { ...detectProject(s.meta.cwd), procs: s.procs.list(), preview: s.previewInfo() };
  },
  runDev: (c, p) => c.d.sessions.get(p.id).runDev(opt(p.cmd, 'cmd')),
  procStart: (c, p) => c.d.sessions.get(p.id).procs.start(need(p.cmd, 'cmd'), opt(p.name, 'name', { max: 64 })),
  procStop(c, p) {
    c.d.sessions.get(p.id).procs.stop(p.name);
    return true;
  },
  procLogs: (c, p) => c.d.sessions.get(p.id).procs.logs(p.name, 64 * 1024),
  preview: (c, p) => c.d.sessions.get(p.id).preview(p.name),
  previewClose(c, p) {
    c.d.sessions.get(p.id).closeTunnel();
    return true;
  },
  async screenshot(c, p) {
    const s = c.d.sessions.get(p.id);
    const port = s.procs.list().find((x) => x.name === p.name)?.port;
    if (!port) throw new Error('Port dev server belum terdeteksi');
    const clamp = (v, def) => Math.min(1600, Math.max(240, +v || def));
    const r = await capture(`http://localhost:${port}${String(p.path || '/').replace(/^(?!\/)/, '/')}`, { width: clamp(p.width, 390), height: clamp(p.height, 844), cfg: c.d.config });
    if (r.data.length > (c.big ? 6_000_000 : 450_000)) throw new Error('Screenshot terlalu besar untuk dikirim; perkecil viewport.');
    return { data: r.data, mime: r.mime, title: r.title, logs: r.logs };
  },
  envSave(c, p) {
    const s = c.d.sessions.get(p.id);
    if (s.meta.local || s.meta.computer) throw new Error('Fitur template .env hanya untuk sesi repository git.');
    return saveEnv(s.meta.repo, s.meta.cwd);
  },
  // ---------- Web Push (HP) ----------
  pushSub(c, p) {
    const dev = c.d.secrets.devices[c.deviceId];
    if (!dev) throw new Error('Hanya untuk HP yang dipasangkan');
    if (p.sub) dev.push = checkPush(p);
    else delete dev.push;
    c.d.saveSecrets();
    return true;
  },
  visible(c, p) {
    c.visible = !!p.on;
    return true;
  },
  edits(c, p) {
    const s = c.d.sessions.get(p.id);
    s.setAskEdits(p.on);
    return s.summary();
  },
  auto(c, p) {
    const s = c.d.sessions.get(p.id);
    s.meta.auto = !!p.on;
    c.d.sessions.saveIndex();
    return s.summary();
  },
  async delete(c, p) {
    await c.d.sessions.remove(p.id);
    return true;
  },
  // Dipicu pengguna: clone dasar repo yang tidak dipakai sesi mana pun ikut dihapus sekarang.
  cleanup: (c) => c.d.sessions.cleanupOrphans({ minAgeMs: 0, repoTtlMs: 0 }),
  status: async (c, p) => {
    const s = c.d.sessions.get(p.id);
    if (s.meta.computer) {
      try {
        return await gitStatus(s.meta.cwd);
      } catch {
        return { branch: '-', files: [], ahead: 0, behind: 0, log: [], hasUpstream: false, notRepo: true };
      }
    }
    return gitStatus(s.meta.cwd);
  },
  diff: async (c, p) => {
    const s = c.d.sessions.get(p.id);
    if (s.meta.computer) {
      try {
        return await gitDiff(s.meta.cwd, { limit: c.big ? 2 * 1024 * 1024 : 400 * 1024 });
      } catch {
        return { diff: '', truncated: false, notRepo: true };
      }
    }
    return gitDiff(s.meta.cwd, { limit: c.big ? 2 * 1024 * 1024 : 400 * 1024 });
  },
  commit(c, p) {
    if (!p.message?.trim()) throw new Error('Pesan commit kosong');
    const cfg = c.d.config;
    const identity = cfg.githubLogin ? { login: cfg.githubLogin, id: cfg.githubId } : null;
    return gitCommit(c.d.sessions.get(p.id).meta.cwd, String(p.message).trim(), identity);
  },
  async push(c, p) {
    if (!c.d.secrets.githubToken) throw new Error('PC ini belum login GitHub.');
    const s = c.d.sessions.get(p.id);
    const branch = await gitPush(s.meta.cwd, c.d.secrets.githubToken);
    s.emitEvent({ k: 'note', d: `⇡ push ke origin/${branch}` });
    return branch;
  },
  async pr(c, p) {
    const s = c.d.sessions.get(p.id);
    // Sesi lokal bisa pindah branch dari terminal: pakai branch yang sedang aktif (dibaca tanpa git).
    const head = currentBranch(s.meta.cwd) || (await gitStatus(s.meta.cwd)).branch;
    const pr = await createPR(c.d.secrets.githubToken, s.meta.repo, { head, base: p.base || s.meta.base, title: p.title, body: p.body || '' });
    s.emitEvent({ k: 'note', d: `PR #${pr.number} dibuat: ${pr.url}` });
    return pr;
  },
};

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
      version: this.d.updaterMeta?.version || '0.1.0',
      commit: this.d.updaterMeta?.commit || 'main',
      preventSleep: this.d.keepAwake?.active?.() ?? false,
      // 'pc' | 'cloud' (Codespaces / container). PWA menyembunyikan fitur khusus PC & menampilkan setelan runner.
      runtime: c.runtime || 'pc',
      machineId: c.machineId,
      // Ada koneksi model (dulu: key 9router). Nama lama dipertahankan untuk aplikasi versi lama.
      routerConfigured: Object.keys(sec.connections || {}).length > 0,
      runner: isCloud(c) ? { ...(c.runner || {}), idleStopMinutes: idleMinutes(c), autoStop: !!this.d.secrets.runnerToken || !!c.runner?.idleExit } : null,
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
