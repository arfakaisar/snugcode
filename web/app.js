// pocketcode PWA — UI terminal untuk mengendalikan agen di PC dari HP.
import * as C from '../shared/crypto.js';

// ---------- util ----------
const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
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
function toast(msg, bad = false, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = bad ? 'bad' : '';
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}
function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return Math.floor(s / 86400) + ' hari lalu';
}
function deviceName() {
  const ua = navigator.userAgent;
  const m = ua.match(/\(([^)]+)\)/);
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? (m?.[1].split(';').map((s) => s.trim()).find((s) => /^(SM-|Pixel|Redmi|M\d|V\d|CPH|RMX|2\d{3})/.test(s)) || 'Android') : 'Browser';
  return os + ' · ' + new Date().toLocaleDateString('id-ID');
}

// Markdown ringan untuk output agen (aman: semua di-escape dulu).
function md(src) {
  const parts = src.split(/```/);
  return parts
    .map((p, i) => {
      if (i % 2) {
        const body = p.replace(/^[\w+-]*\n/, '');
        return `<pre><code>${esc(body)}</code></pre>`;
      }
      return esc(p)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/^(#{1,4}) (.+)$/gm, '<span class="h">$2</span>')
        .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    })
    .join('');
}

// ---------- header / navigasi ----------
const ui = {
  set(title, { back, menu, dot } = {}) {
    $('#titleText').textContent = title;
    $('#back').hidden = !back;
    $('#back').onclick = back || null;
    $('#menu').hidden = !menu;
    $('#menu').onclick = menu || null;
    this.dot(dot);
  },
  dot(state) {
    $('#dot').className = state || '';
  },
  view(...kids) {
    const v = $('#view');
    v.replaceChildren(...kids);
    return v;
  },
  sheet(...kids) {
    $('#sheetBody').replaceChildren(...kids);
    $('#sheet').hidden = false;
  },
  closeSheet() {
    $('#sheet').hidden = true;
  },
};
$('#sheet').addEventListener('click', (e) => e.target.id === 'sheet' && ui.closeSheet());

// ---------- API relay ----------
const token = () => store.get('token');
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { authorization: 'Bearer ' + token(), ...(opts.headers || {}) } });
  if (r.status === 401) {
    store.set('token', null);
    showLogin();
    throw new Error('Sesi login habis');
  }
  return r.json();
}

// ---------- Koneksi terenkripsi ke PC ----------
class Conn {
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
    this.ws = ws;
    this.channel = null;
    ws.onmessage = (ev) => this.ws === ws && this.onFrame(ev.data);
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
  onFrame(raw) {
    if (raw === 'pong') return;
    const f = JSON.parse(raw);
    switch (f.t) {
      case 'status':
        this.online = f.online;
        this.emit('state', f.online ? 'online' : 'offline');
        if (f.online) this.startAuth();
        return;
      case 'auth2': {
        const r = C.authFinishPhone(C.hexToBytes(this.dev.secret), this.authState, f);
        if (!r) return this.emit('state', 'authfail');
        this.channel = r.channel;
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
      case 'e': {
        const msg = this.channel.open(f);
        if (msg.ev === 'ready') return this.emit('ready', msg.info);
        if (msg.ev) return this.emit(msg.ev, msg);
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.err ? p.reject(new Error(msg.err)) : p.resolve(msg.r);
      }
    }
  }
  startAuth() {
    const dev = this.dev;
    if (!dev) return this.emit('state', 'needpin');
    const a = C.authStartPhone();
    this.authState = a.state;
    this.sendRaw({ t: 'auth1', deviceId: dev.deviceId, ...a.msg });
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
    this.ws.send(JSON.stringify(this.channel.seal({ id, m, p })));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

let conn = null;
let current = null; // { info }

// ---------- Layar: login ----------
const LOGO = ` ┌─┐┌─┐┌─┐┬┌─┌─┐┌┬┐┌─┐┌─┐┌┬┐┌─┐
 ├─┘│ ││  ├┴┐├┤  │ │  │ │ ││├┤
 ┴  └─┘└─┘┴ ┴└─┘ ┴ └─┘└─┘─┴┘└─┘`;

function showLogin() {
  ui.set('pocketcode');
  ui.view(
    h('div', { class: 'pad center' },
      h('div', { class: 'ascii' }, LOGO),
      h('p', {}, 'Coding agent di PC-mu, dikendalikan dari HP.'),
      h('p', { class: 'dim' }, 'Masuk dengan akun GitHub yang sama dengan yang dipakai saat setup di PC.'),
      h('a', { class: 'btn primary', href: '/auth/login?kind=user' }, 'Login dengan GitHub'),
    ),
  );
}

// ---------- Layar: daftar PC ----------
async function showMachines() {
  conn?.close();
  conn = null;
  ui.set('PC saya', { menu: () => ui.sheet(h('h2', {}, 'Akun'), h('button', { class: 'btn danger', onclick: () => (store.set('token', null), ui.closeSheet(), showLogin()) }, 'Keluar')) });
  const list = h('div', {}, h('p', { class: 'dim spin' }, 'Memuat '));
  ui.view(h('div', { class: 'pad' }, list, h('p', { class: 'dim' }, 'Belum ada PC? Di komputer jalankan: ', h('code', {}, 'npx pocketcode setup'))));
  const { machines } = await api('/api/machines');
  if (!machines.length) return list.replaceChildren(h('p', {}, 'Belum ada PC yang tertaut ke akun ini.'));
  list.replaceChildren(
    ...machines.map((m) =>
      h('button', { class: 'item btn', onclick: () => openMachine(m) },
        h('span', { class: 'grow' }, h('div', { class: 'name' }, m.name), h('div', { class: 'sub' }, m.online ? 'online' : 'offline · terakhir ' + (ago(m.lastSeen) || '-'))),
        h('span', { class: 'pill' + (m.online ? ' on' : '') }, m.online ? '● online' : 'offline'),
      ),
    ),
  );
}

// ---------- Koneksi ke satu PC ----------
function openMachine(m) {
  conn?.close();
  conn = new Conn(m);
  current = { m };
  const status = h('p', { class: 'dim spin' }, 'Menghubungkan ');
  ui.set(m.name, { back: showMachines });
  ui.view(h('div', { class: 'pad center' }, status));
  conn.on('state', (s) => {
    if (s === 'offline') {
      ui.dot('off');
      if (!current.ready) status.textContent = 'PC sedang offline. Pastikan `pocketcode start` berjalan dan PC tidak tertidur. Menunggu…';
      else toast('PC offline — menunggu tersambung lagi…', true);
    } else if (s === 'online') ui.dot('busy');
    else if (s === 'reconnecting') ui.dot('busy');
    else if (s === 'needpin') showPin(m);
    else if (s === 'revoked') (toast('HP ini dicabut aksesnya dari PC.', true), showPin(m));
    else if (s === 'removed') (toast('PC ini sudah dihapus dari akun.', true), showMachines());
    else if (s === 'authfail') toast('Verifikasi PC gagal.', true);
  });
  conn.on('ready', (info) => {
    ui.dot('on');
    const first = !current.ready;
    current.ready = true;
    current.info = info;
    if (first) showSessions();
    else if (current.session) reattach();
  });
  conn.on('events', (msg) => current.onEvents?.(msg));
  conn.on('notice', (msg) => {
    if (current.session?.id === msg.sid && document.visibilityState === 'visible') return;
    toast(`${msg.title}: ${msg.msg}`);
    if (document.visibilityState !== 'visible' && window.Notification?.permission === 'granted') new Notification('pocketcode', { body: `${msg.title}: ${msg.msg}` });
  });
  conn.connect();
}

function showPin(m) {
  ui.dot('busy');
  const err = h('div', { class: 'err' });
  const input = h('input', { class: 'field pin', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '12', placeholder: 'PIN' });
  const btn = h('button', { class: 'btn primary' }, 'Pasangkan');
  const go = async () => {
    const pin = input.value.trim();
    if (!C.PIN_RE.test(pin)) return (err.textContent = 'PIN 6–12 huruf/angka.');
    btn.disabled = true;
    btn.textContent = 'Memverifikasi…';
    err.textContent = '';
    const r = await conn.pair(pin);
    btn.disabled = false;
    btn.textContent = 'Pasangkan';
    if (r.ok) return;
    input.value = '';
    err.textContent =
      r.reason === 'pin' ? `PIN salah.${r.left != null ? ` Sisa ${r.left} percobaan.` : ''}`
      : r.reason === 'locked' ? 'Pairing terkunci karena terlalu banyak PIN salah. Jalankan `pocketcode pin` di PC.'
      : r.reason === 'slow' ? 'Terlalu cepat, tunggu beberapa detik.'
      : r.reason === 'nopin' ? 'PC belum punya PIN. Jalankan `pocketcode setup`.'
      : 'Gagal: ' + r.reason;
  };
  btn.onclick = go;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') go();
  };
  ui.view(
    h('div', { class: 'pad center' },
      h('h1', {}, 'Pasangkan HP'),
      h('p', { class: 'dim' }, `Masukkan PIN yang kamu buat saat setup di "${m.name}". Cukup sekali per HP — PIN tidak pernah dikirim ke server.`),
      input, err, btn,
    ),
  );
  setTimeout(() => input.focus(), 50);
}

// ---------- Layar: daftar sesi ----------
async function showSessions() {
  current.session = null;
  current.onEvents = null;
  const info = current.info;
  ui.set(current.m.name, {
    back: showMachines,
    dot: 'on',
    menu: () => showMachineMenu(),
  });
  const list = h('div', {}, h('p', { class: 'dim spin' }, 'Memuat '));
  ui.view(
    h('div', { class: 'pad' },
      h('div', { class: 'meta' }, `model: ${info.model}${info.github ? ' · github: @' + info.github : ' · GitHub belum login'}`),
      h('button', { class: 'btn primary', onclick: showNewSession }, '+ Sesi baru'),
      h('h2', {}, 'Sesi'),
      list,
    ),
  );
  try {
    const sessions = await conn.call('sessions');
    if (!sessions.length) return list.replaceChildren(h('p', { class: 'dim' }, 'Belum ada sesi. Buat sesi baru untuk memilih repo.'));
    list.replaceChildren(
      ...sessions.map((s) =>
        h('button', { class: 'item btn', onclick: () => showSession(s) },
          h('span', { class: 'grow' }, h('div', { class: 'name' }, s.title || '(belum ada prompt)'), h('div', { class: 'sub' }, `${s.repo} · ${s.branch} · ${ago(s.updatedAt)}`)),
          s.status === 'running' ? h('span', { class: 'pill run' }, 'jalan') : null,
        ),
      ),
    );
  } catch (e) {
    list.replaceChildren(h('p', { class: 'err' }, e.message));
  }
}

async function showMachineMenu() {
  const info = current.info;
  const sel = h('select', { class: 'field' }, h('option', {}, info.model));
  const small = h('select', { class: 'field' }, h('option', {}, info.smallModel || info.model));
  ui.sheet(
    h('h2', {}, 'Model default'),
    sel,
    h('h2', {}, 'Model kecil (tugas ringan)'),
    small,
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        current.info = await conn.call('setModel', { model: sel.value, smallModel: small.value });
        ui.closeSheet();
        toast('Model disimpan');
        showSessions();
      },
    }, 'Simpan'),
    h('h2', {}, 'Notifikasi'),
    h('button', { class: 'btn', onclick: () => Notification?.requestPermission().then((p) => toast('Notifikasi: ' + p)) }, 'Izinkan notifikasi'),
    h('h2', {}, 'Perangkat ini'),
    h('button', { class: 'btn danger', onclick: () => (store.set('dev.' + current.m.id, null), ui.closeSheet(), openMachine(current.m)) }, 'Lupakan pairing HP ini'),
  );
  try {
    const models = await conn.call('models');
    for (const [s, v] of [[sel, info.model], [small, info.smallModel || info.model]]) s.replaceChildren(...models.map((m) => h('option', { selected: m === v }, m)));
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- Layar: sesi baru ----------
function showNewSession() {
  ui.set('Sesi baru', { back: showSessions, dot: 'on' });
  const q = h('input', { class: 'field', placeholder: 'Cari repo… atau ketik owner/nama', autocapitalize: 'off', autocomplete: 'off' });
  const results = h('div', {}, h('p', { class: 'dim spin' }, 'Memuat repo '));
  ui.view(h('div', { class: 'pad' }, q, results));
  let timer;
  const load = async () => {
    try {
      const repos = await conn.call('repos', { q: q.value.trim() || undefined });
      const typed = /^[\w.-]+\/[\w.-]+$/.test(q.value.trim()) && !repos.some((r) => r.full === q.value.trim()) ? [{ full: q.value.trim(), desc: 'pakai nama ini' }] : [];
      results.replaceChildren(
        ...[...typed, ...repos].map((r) =>
          h('button', { class: 'item btn', onclick: () => pickBranch(r) },
            h('span', { class: 'grow' }, h('div', { class: 'name' }, r.full), h('div', { class: 'sub' }, r.desc || (r.pushed ? 'push ' + ago(Date.parse(r.pushed)) : ''))),
            r.private ? h('span', { class: 'pill' }, 'private') : null,
          ),
        ),
      );
      if (!typed.length && !repos.length) results.replaceChildren(h('p', { class: 'dim' }, 'Tidak ada repo.'));
    } catch (e) {
      results.replaceChildren(h('p', { class: 'err' }, e.message), h('p', { class: 'dim' }, 'Kamu tetap bisa mengetik owner/nama untuk repo publik.'));
    }
  };
  q.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 350);
  };
  load();
}

async function pickBranch(repo) {
  const branches = h('select', { class: 'field' }, h('option', { value: '' }, '(branch default)'));
  const mode = { v: 'new' };
  const newName = h('input', { class: 'field', placeholder: 'pocket/<otomatis>', autocapitalize: 'off' });
  const err = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn primary' }, 'Mulai sesi');
  const modeNew = h('button', { class: 'btn', onclick: () => setMode('new') }, '');
  const modeExisting = h('button', { class: 'btn', onclick: () => setMode('existing') }, '');
  const setMode = (v) => {
    mode.v = v;
    modeNew.textContent = (v === 'new' ? '◉ ' : '○ ') + 'Branch baru dari base';
    modeExisting.textContent = (v === 'existing' ? '◉ ' : '○ ') + 'Lanjutkan branch yang ada';
    newName.hidden = v !== 'new';
  };
  setMode('new');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Menyiapkan repo (clone/fetch)…';
    err.textContent = '';
    try {
      const params = mode.v === 'new' ? { repo: repo.full, base: branches.value || undefined, branch: newName.value.trim() || undefined } : { repo: repo.full, branch: branches.value || repo.branch };
      const s = await conn.call('create', params);
      ui.closeSheet();
      showSession(s);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Mulai sesi';
    }
  };
  ui.sheet(h('h2', {}, repo.full), modeNew, modeExisting, h('h2', {}, 'Branch base / yang dilanjutkan'), branches, h('h2', {}, ''), newName, err, btn);
  try {
    const list = await conn.call('branches', { repo: repo.full });
    branches.replaceChildren(...list.map((b) => h('option', { value: b, selected: b === repo.branch }, b)));
  } catch {}
}

// ---------- Layar: sesi (terminal) ----------
function showSession(s) {
  current.session = s;
  current.lastSeq = 0;
  const term = h('div', { id: 'term' });
  const working = h('div', { id: 'working' });
  const input = h('textarea', { id: 'input', rows: 1, placeholder: 'Minta sesuatu… (awali ! untuk perintah shell)', autocapitalize: 'sentences' });
  const send = h('button', { id: 'send' }, '↵');
  const autoChip = h('button', {}, '');
  const chips = h('div', { id: 'chips' },
    h('button', { onclick: () => showGit() }, '⎇ git'),
    autoChip,
    h('button', { onclick: () => (input.value = '!git status', input.focus()) }, '! shell'),
    h('button', { onclick: () => quick('Jelaskan struktur repo ini dan cara menjalankannya, singkat.') }, '? jelaskan repo'),
    h('button', { onclick: () => quick('Review perubahan yang belum di-commit (git diff), cari bug, lalu ringkas.') }, '✓ review diff'),
  );
  ui.set(s.title || s.repo, { back: () => (conn.call('detach').catch(() => {}), showSessions()), dot: 'on', menu: () => sessionMenu() });
  ui.view(term, working, h('div', { id: 'composer' }, chips, h('div', { id: 'inputRow' }, input, send)));

  const r = new Renderer(term);
  current.renderer = r;
  const setRunning = (on) => {
    current.running = on;
    send.textContent = on ? '■' : '↵';
    send.className = on ? 'stop' : '';
    working.replaceChildren(on ? h('span', { class: 'spin' }, ' bekerja… ') : '');
    ui.dot(on ? 'busy' : 'on');
  };
  const setAuto = (on) => {
    current.session.auto = on;
    autoChip.textContent = on ? '⚡ auto-izin: ON' : '⚡ auto-izin: off';
    autoChip.className = on ? 'warn' : '';
  };
  autoChip.onclick = async () => {
    const on = !current.session.auto;
    if (on && !confirm('Auto-izin: agen boleh menjalankan perintah shell apa pun tanpa bertanya (kecuali git push). Lanjut?')) return;
    setAuto((await conn.call('auto', { id: s.id, on })).auto);
  };
  setAuto(!!s.auto);
  current.onEvents = (msg) => {
    if (msg.sid !== s.id) return;
    for (const e of msg.es) {
      if (e.k === 'status') setRunning(e.s === 'running');
      else r.add(e);
      if (e.seq) current.lastSeq = Math.max(current.lastSeq, e.seq);
    }
  };
  current.setRunning = setRunning;

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
  };
  input.oninput = autosize;
  const submit = async () => {
    if (current.running) {
      await conn.call('interrupt', { id: s.id }).catch((e) => toast(e.message, true));
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    try {
      await conn.call('send', { id: s.id, text });
    } catch (e) {
      toast(e.message, true);
      input.value = text;
    }
  };
  const quick = (t) => {
    input.value = t;
    submit();
  };
  send.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), submit());
  };
  reattach(true);
}

async function reattach(fresh) {
  const s = current.session;
  try {
    const res = await conn.call('attach', { id: s.id, since: fresh ? 0 : current.lastSeq });
    const r = current.renderer;
    if (fresh && res.truncated) r.line('meta', '… riwayat lama tidak ditampilkan');
    for (const e of res.events) {
      r.add(e);
      current.lastSeq = Math.max(current.lastSeq, e.seq);
    }
    for (const p of res.perms) r.add({ k: 'perm', ...p });
    current.setRunning(res.session.status === 'running');
    if (fresh && !res.events.length) r.line('meta', `${s.repo} · branch ${s.branch} · model ${s.model}\nKetik permintaan di bawah. Awali dengan ! untuk menjalankan perintah shell langsung.`);
    r.scroll(true);
  } catch (e) {
    toast(e.message, true);
  }
}

async function sessionMenu() {
  const s = current.session;
  ui.sheet(
    h('h2', {}, 'Sesi'),
    h('div', { class: 'meta' }, `${s.repo}\nbranch: ${s.branch} (base ${s.base})\nmodel: ${s.model}`),
    h('button', { class: 'btn', onclick: () => (ui.closeSheet(), showGit()) }, '⎇ Git: status, diff, commit, push, PR'),
    h('button', {
      class: 'btn danger',
      onclick: async () => {
        if (!confirm('Hapus sesi ini beserta worktree-nya di PC? Perubahan yang belum di-push akan hilang.')) return;
        await conn.call('delete', { id: s.id }).catch((e) => toast(e.message, true));
        ui.closeSheet();
        showSessions();
      },
    }, 'Hapus sesi'),
  );
}

// ---------- Git ----------
async function showGit() {
  const s = current.session;
  const body = h('div', {}, h('p', { class: 'dim spin' }, 'Memuat status '));
  ui.sheet(h('h2', {}, 'Git · ' + s.repo), body);
  let st;
  try {
    st = await conn.call('status', { id: s.id });
  } catch (e) {
    return body.replaceChildren(h('p', { class: 'err' }, e.message));
  }
  const msg = h('input', { class: 'field', placeholder: 'Pesan commit' });
  const err = h('div', { class: 'err' });
  const act = (label, fn, cls = 'btn') =>
    h('button', {
      class: cls,
      onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        err.textContent = '';
        try {
          await fn();
        } catch (x) {
          err.textContent = x.message;
        }
        b.disabled = false;
      },
    }, label);
  body.replaceChildren(
    h('div', { class: 'meta' }, `branch ${st.branch} · ${st.hasUpstream ? `↑${st.ahead} ↓${st.behind}` : `${st.ahead} commit belum di-push (belum ada di GitHub)`}`),
    h('h2', {}, `Perubahan (${st.files.length})`),
    st.files.length ? h('div', { class: 'files' }, ...st.files.map((f) => h('div', { class: 'f' }, h('span', { class: 'st' }, f.st), h('span', {}, f.path)))) : h('p', { class: 'dim' }, 'Tidak ada perubahan.'),
    st.files.length ? act('Lihat diff', showDiff) : null,
    st.files.length ? h('div', {}, h('h2', {}, 'Commit'), msg, act('Commit semua', async () => {
      if (!msg.value.trim()) throw new Error('Isi pesan commit.');
      const c = await conn.call('commit', { id: s.id, message: msg.value });
      toast('✓ ' + c);
      showGit();
    })) : null,
    h('h2', {}, 'Kirim ke GitHub'),
    act(`⇡ Push ke origin/${st.branch}`, async () => {
      if (!confirm(`Push branch ${st.branch} ke GitHub?`)) return;
      await conn.call('push', { id: s.id });
      toast('✓ Push berhasil');
      showGit();
    }, 'btn primary'),
    act('Buat Pull Request', () => showPR(st)),
    err,
    h('h2', {}, 'Commit terakhir'),
    h('div', { class: 'meta', style: 'white-space:pre-wrap' }, st.log.join('\n')),
  );
}

function showPR(st) {
  const s = current.session;
  const title = h('input', { class: 'field', value: s.title || '', placeholder: 'Judul PR' });
  const desc = h('textarea', { class: 'field', rows: 5, placeholder: 'Deskripsi (opsional)' });
  const err = h('div', { class: 'err' });
  ui.sheet(
    h('h2', {}, `PR: ${st.branch} → ${s.base}`),
    title, h('div', { style: 'height:8px' }), desc, err,
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          const pr = await conn.call('pr', { id: s.id, title: title.value || st.branch, body: desc.value });
          ui.sheet(h('h2', {}, 'PR dibuat'), h('a', { class: 'btn primary', href: pr.url, target: '_blank' }, `Buka PR #${pr.number}`));
        } catch (e) {
          err.textContent = e.message + (/No commits|not all refs/.test(e.message) ? ' — push dulu.' : '');
        }
      },
    }, 'Buat PR'),
  );
}

async function showDiff() {
  const box = h('div', { class: 'diff' }, h('span', { class: 'dim spin' }, 'Memuat diff '));
  ui.sheet(h('h2', {}, 'Diff'), box, h('button', { class: 'btn', onclick: showGit }, '‹ Kembali'));
  const { diff, truncated } = await conn.call('diff', { id: current.session.id });
  box.replaceChildren(...diffLines(diff), truncated ? h('div', { class: 'dim' }, '… diff dipotong') : '');
}

function diffLines(diff) {
  return diff.split('\n').map((l) => {
    if (l.startsWith('diff --git')) return h('span', { class: 'dh' }, '▸ ' + l.replace(/^diff --git a\/(.+?) b\/.*$/, '$1'));
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) return '';
    if (l.startsWith('@@')) return h('span', { class: 'dc' }, l);
    if (l.startsWith('+')) return h('span', { class: 'add' }, l);
    if (l.startsWith('-')) return h('span', { class: 'del' }, l);
    return h('span', { style: 'display:block' }, l || ' ');
  });
}

// ---------- Renderer event agen ----------
class Renderer {
  constructor(el) {
    this.el = el;
    this.tools = new Map();
    this.perms = new Map();
    this.textEl = null;
    this.textSrc = '';
    this.outEl = null;
    el.addEventListener('scroll', () => (this.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80));
    this.stick = true;
  }
  scroll(force) {
    if (force || this.stick) requestAnimationFrame(() => (this.el.scrollTop = this.el.scrollHeight));
  }
  append(node) {
    this.el.append(node);
    this.scroll();
    return node;
  }
  line(cls, text) {
    this.textEl = null;
    this.outEl = null;
    return this.append(h('div', { class: 'ln ' + cls }, text));
  }
  add(e) {
    switch (e.k) {
      case 'user':
        return this.line('u', e.d);
      case 'text':
        if (!this.textEl) {
          this.textSrc = '';
          this.textEl = this.append(h('div', { class: 'ln txt' }));
        }
        this.textSrc += e.d;
        this.textEl.innerHTML = md(this.textSrc);
        return this.scroll();
      case 'tool':
        return this.tool(e);
      case 'result': {
        const t = this.tools.get(e.id);
        if (!t) return;
        t.el.classList.remove('pending');
        if (!e.ok) t.el.classList.add('fail');
        if (e.d && t.name !== 'TodoWrite' && t.name !== 'Edit' && t.name !== 'Write' && t.name !== 'MultiEdit') {
          const out = h('div', { class: 'out' + (e.ok ? '' : ' fail') }, e.d.trim() || '(kosong)');
          out.onclick = () => out.classList.toggle('open');
          t.el.append(out);
        } else if (!e.ok) t.el.append(h('div', { class: 'out fail' }, e.d));
        return this.scroll();
      }
      case 'perm':
        return this.perm(e);
      case 'permAnswer': {
        const p = this.perms.get(e.pid);
        if (p) return p(e.allow);
        return this.line('meta', `${e.allow ? '✓ diizinkan' : '✗ ditolak'}: ${e.tool} ${e.s ? '· ' + e.s.slice(0, 80) : ''}`);
      }
      case 'retry':
        return this.line('meta', `↻ 9router error ${e.status ?? ''}, mencoba lagi (${e.attempt}/${e.max})…`);
      case 'done':
        return this.line(e.ok ? 'meta' : 'e', e.ok ? `✓ selesai · ${e.turns} langkah · ${(e.ms / 1000).toFixed(1)}s${e.usage ? ` · ${e.usage.in}→${e.usage.out} token` : ''}` : `✗ berhenti: ${e.err || 'error'}`);
      case 'sh':
        return this.line('sh', e.d);
      case 'out':
        if (!this.outEl) this.outEl = this.append(h('div', { class: 'ln o' }));
        this.outEl.textContent += e.d;
        return this.scroll();
      case 'shDone':
        return this.line('meta', `exit ${e.code}`);
      case 'note':
        return this.line('note', e.d);
      case 'error':
        return this.line('e', '✗ ' + e.d);
    }
  }
  tool(e) {
    this.textEl = null;
    this.outEl = null;
    const el = h('div', { class: 'ln tool pending' }, h('div', { class: 'head' }, h('span', { class: 'tn' }, e.name), h('span', { class: 'ts' }, e.s ? ` ${e.name === 'TodoWrite' ? '' : e.s.split('\n')[0].slice(0, 200)}` : '')));
    if (e.name === 'TodoWrite' && e.s) el.append(h('div', { class: 'meta', style: 'padding-left:16px;white-space:pre-wrap' }, e.s));
    if (e.x) {
      const mini = h('div', { class: 'mini' });
      const edits = e.x.edits || [e.x];
      for (const ed of edits) {
        if (ed.old) for (const l of ed.old.split('\n')) mini.append(h('span', { class: 'del' }, '- ' + l));
        if (ed.new) for (const l of ed.new.split('\n')) mini.append(h('span', { class: 'add' }, '+ ' + l));
      }
      mini.onclick = () => mini.classList.toggle('open');
      el.append(mini);
    }
    this.tools.set(e.id, { el, name: e.name });
    this.append(el);
  }
  perm(e) {
    if (this.perms.has(e.pid)) return;
    this.textEl = null;
    const status = h('div', { class: 'meta' });
    const buttons = h('div', { class: 'row' });
    const card = h('div', { class: 'perm' + (e.push ? ' push' : '') },
      h('div', { class: 'q' }, e.push ? '⚠ Agen ingin PUSH ke GitHub' : `? Izinkan ${e.tool}?`),
      e.title ? h('div', { class: 'meta' }, e.title) : null,
      h('pre', {}, e.s || ''),
      buttons, status,
    );
    const answer = async (decision) => {
      buttons.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await conn.call('perm', { id: current.session.id, pid: e.pid, decision });
      } catch (x) {
        toast(x.message, true);
        buttons.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    };
    buttons.append(
      h('button', { class: 'btn primary', onclick: () => answer('allow') }, 'Izinkan'),
      e.push ? null : h('button', { class: 'btn', onclick: () => answer('always') }, 'Selalu'),
      h('button', { class: 'btn danger', onclick: () => answer('deny') }, 'Tolak'),
    );
    this.perms.set(e.pid, (allow) => {
      card.classList.add('done');
      buttons.remove();
      status.textContent = allow ? '✓ diizinkan' : '✗ ditolak';
    });
    this.append(card);
    this.scroll(true);
    if (navigator.vibrate) navigator.vibrate(60);
  }
}

// ---------- start ----------
function boot() {
  const m = location.hash.match(/login=([^&]+)/);
  if (m) {
    store.set('token', decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname);
  }
  if (!token()) return showLogin();
  showMachines().catch((e) => toast(e.message, true));
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => {
  // Saat aplikasi dibuka lagi, sambung ulang segera bila koneksi putus.
  if (document.visibilityState === 'visible' && conn && conn.ws?.readyState > 1 && !conn.closedByUser) conn.connect();
});
boot();
