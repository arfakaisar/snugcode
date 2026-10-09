// pocketcode PWA — UI terminal untuk mengendalikan agen di PC dari HP.
import * as C from '../shared/crypto.js';
import * as M from '../shared/models.js';
import { md as mdRender, stableCut } from './md.js';
import { Conn, store, token } from './conn.js';

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
// replaceChildren/append bawaan mengubah null menjadi teks "null"; banyak tampilan
// memakai pola `kondisi ? elemen : null`, jadi nilai kosong diabaikan di sini.
for (const method of ['replaceChildren', 'append']) {
  const orig = Element.prototype[method];
  Element.prototype[method] = function (...kids) {
    return orig.apply(this, kids.flat().filter((k) => k != null && k !== false));
  };
}
let conn = null;
let current = null; // { m, info, session, renderer, ... }
let me = null;
const coarse = matchMedia('(pointer: coarse)').matches;
const haptic = (ms = 12) => navigator.vibrate?.(ms);
function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt';
  if (s < 86400) return Math.floor(s / 3600) + ' jam';
  return Math.floor(s / 86400) + ' hari';
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = h('textarea', { style: 'position:fixed;opacity:0;font-size:16px' });
    t.value = text;
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

// ---------- ikon (SVG statis) ----------
const P = {
  back: '<path d="m15 18-6-6 6-6"/>',
  dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9a6 6 0 0 1-6 6H8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  arrowdown: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  push: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>',
  pr: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4"/><path d="m13 4-2 2 2 2"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  diff: '<path d="M12 3v14M5 10h14"/><path d="M5 21h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  unlink: '<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 4 8M8 12h4M2 2l20 20"/>',
  term: '<path d="m5 8 4 4-4 4M12 16h7"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M12 20v-9M3 13h5M16 13h5M4 7l4 2M20 7l-4 2M4 19l4-2M20 19l-4-2M9 4l1.5 2M15 4l-1.5 2"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7 15h10"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
  github: '<path fill="currentColor" stroke="none" d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0C17.3 4.8 18.3 5 18.3 5c.7 1.6.3 2.8.1 3.1.8.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5z"/>',
};
function ic(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  return t.content.firstChild;
}

// ---------- viewport: shell mengikuti area yang benar-benar terlihat ----------
// iOS tidak mengecilkan layout saat keyboard muncul; tanpa ini composer
// tertutup keyboard dan halaman ikut bergeser.
const vv = window.visualViewport;
let kbOpen = false;
function syncViewport() {
  const hgt = vv ? vv.height : window.innerHeight;
  const top = vv ? Math.max(0, vv.offsetTop) : 0;
  const root = document.documentElement.style;
  root.setProperty('--app-h', hgt + 'px');
  root.setProperty('--app-top', top + 'px');
  const open = vv ? window.innerHeight - vv.height > 140 || (document.activeElement?.matches?.('input,textarea') && screen.height - hgt > 260) : false;
  if (open !== kbOpen) {
    kbOpen = open;
    document.documentElement.classList.toggle('kb', open);
  }
  document.documentElement.classList.toggle('short', hgt < 520);
  if (window.scrollY) window.scrollTo(0, 0);
  current?.renderer?.keepBottom();
}
vv?.addEventListener('resize', syncViewport);
vv?.addEventListener('scroll', syncViewport);
window.addEventListener('resize', syncViewport);
window.addEventListener('orientationchange', () => setTimeout(syncViewport, 250));
document.addEventListener('focusin', () => setTimeout(syncViewport, 60));
document.addEventListener('focusout', () => setTimeout(syncViewport, 120));
syncViewport();

// ---------- toast ----------
function toast(msg, bad = false, ms = 3200) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, h('span', { class: 'ic' }, bad ? '✕' : '✓'), h('span', {}, msg));
  const kill = () => {
    if (el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  el.onclick = kill;
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(kill, ms);
  if (bad) haptic(30);
}

// ---------- header / layar / sheet ----------
const ui = {
  set(title, { sub = '', back, actions = [], dot = 'none' } = {}) {
    $('#titleText').textContent = title;
    $('#subText').textContent = sub;
    const b = $('#back');
    b.hidden = !back;
    b.replaceChildren(ic('back'));
    b.onclick = back || null;
    $('#actions').replaceChildren(...actions.map((a) => h('button', { class: 'iconbtn', 'aria-label': a.label, title: a.label, onclick: a.onclick }, ic(a.icon))));
    this.dot(dot);
  },
  sub(text) {
    $('#subText').textContent = text;
  },
  dot(state) {
    $('#dot').className = state || '';
  },
  view(...kids) {
    const v = $('#view');
    v.replaceChildren(...kids);
    kids[0]?.classList?.add('screen-enter');
    return v;
  },
  sheet(...kids) {
    const s = $('#sheet');
    clearTimeout(this.closeT);
    s.classList.remove('closing');
    $('#sheetBody').replaceChildren(...kids);
    $('#sheetBody').scrollTop = 0;
    if (s.hidden) {
      s.hidden = false;
      $('#sheetPanel').style.transform = '';
    }
  },
  closeSheet() {
    const s = $('#sheet');
    if (s.hidden || s.classList.contains('closing')) return;
    document.activeElement?.blur?.();
    s.classList.add('closing');
    this.closeT = setTimeout(() => {
      s.hidden = true;
      s.classList.remove('closing');
      $('#sheetBody').replaceChildren();
    }, 210);
  },
  head(title, { sub, back, close = true } = {}) {
    return h('div', { class: 'sheethead' },
      back ? h('button', { class: 'iconbtn small', 'aria-label': 'Kembali', onclick: back }, ic('back')) : null,
      h('h2', {}, title, sub ? h('span', { class: 'sub' }, sub) : null),
      close ? h('button', { class: 'iconbtn small', 'aria-label': 'Tutup', onclick: () => ui.closeSheet() }, ic('x')) : null,
    );
  },
};
$('#sheetBackdrop').addEventListener('click', () => ui.closeSheet());
document.addEventListener('keydown', (e) => e.key === 'Escape' && ui.closeSheet());
// Geser handle sheet ke bawah untuk menutup.
(() => {
  const grab = $('#sheetGrab');
  const panel = $('#sheetPanel');
  let y0 = null;
  let dy = 0;
  grab.addEventListener('pointerdown', (e) => {
    y0 = e.clientY;
    dy = 0;
    grab.setPointerCapture(e.pointerId);
    panel.style.transition = 'none';
  });
  grab.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    panel.style.transition = 'transform .2s ease';
    if (dy > 90) ui.closeSheet();
    else panel.style.transform = '';
    setTimeout(() => (panel.style.transition = ''), 220);
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
})();

const loading = (text) => h('div', { class: 'loading' }, h('span', { class: 'spinner' }), text);
const skeletons = (n = 3) => h('div', {}, ...Array.from({ length: n }, () => h('div', { class: 'skeleton' })));
const scrollCol = (...kids) => h('div', { class: 'scroll' }, h('div', { class: 'col' }, ...kids));
function menuItem({ icon, t1, t2, onclick, danger, chev = true }) {
  return h('button', { class: 'menuitem' + (danger ? ' danger' : ''), onclick },
    h('span', { class: 'mi' }, ic(icon)),
    h('span', { class: 'grow' }, h('div', { class: 't1' }, t1), t2 ? h('div', { class: 't2' }, t2) : null),
    chev ? ic('right', 'chev') : null,
  );
}
function busyButton(btn, label) {
  const prev = [...btn.childNodes];
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'spinner' }), label);
  return () => {
    btn.disabled = false;
    btn.replaceChildren(...prev);
  };
}

// ---------- Markdown (aman: semua teks di-escape) ----------
let copyIconHtml = null;
const md = (src) => mdRender(src, { copyIcon: (copyIconHtml ??= ic('copy').outerHTML) });

// ---------- API relay ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { authorization: 'Bearer ' + token(), ...(opts.headers || {}) } });
  if (r.status === 401) {
    store.set('token', null);
    showLogin();
    throw new Error('Sesi login habis');
  }
  return r.json();
}

// ---------- Layar: login ----------
function showLogin() {
  ui.set('pocketcode', { dot: 'none' });
  $('#bar').hidden = true;
  const boot = h('div', { class: 'boot', 'aria-hidden': 'true' });
  ui.view(
    h('div', { class: 'hero' },
      h('div', { class: 'logo' }, h('span', { class: 'grad-text' }, 'pocketcode'), h('span', { class: 'caret' })),
      boot,
      h('p', { class: 'lead' }, 'Coding agent di PC-mu — analisis repo, edit, commit, dan push langsung dari HP.'),
      h('a', { class: 'btn primary', href: '/auth/login?kind=user', onclick: () => haptic() }, ic('github'), 'Login dengan GitHub'),
      h('div', { class: 'fine' }, 'Pakai akun GitHub yang sama dengan saat setup di PC.'),
    ),
  );
  const lines = [
    ['p', '$ ', 'pocketcode connect'],
    ['ok', '✓ ', 'relay terenkripsi end-to-end'],
    ['ok', '✓ ', 'Claude Code harness · 9router'],
    ['ok', '✓ ', 'repo tetap di PC, bukan di HP'],
    ['c', '❯ ', 'siap menerima perintah'],
  ];
  let li = 0;
  let ci = 0;
  const cur = h('span', { class: 'cur' });
  const tick = () => {
    if (!boot.isConnected || li >= lines.length) return boot.append(cur);
    const [cls, pre, text] = lines[li];
    let row = boot.children[li];
    if (!row) boot.append((row = h('div', { class: 'bl' }, h('span', { class: cls }, pre), h('span', {}))));
    row.lastChild.textContent = text.slice(0, ++ci);
    if (ci >= text.length) {
      li++;
      ci = 0;
      setTimeout(tick, 260);
    } else setTimeout(tick, 18 + Math.random() * 30);
  };
  setTimeout(tick, 300);
}

// ---------- Layar: daftar PC ----------
// Posisi terakhir (PC + sesi) disimpan agar saat PWA dibuka ulang — mis. iOS
// mematikannya di latar belakang — pengguna langsung kembali ke sesi yang sama.
const goMachines = () => {
  clearInterval(current?.updateTimer);
  store.set('last', null);
  showMachines();
};

async function showMachines({ resume = false } = {}) {
  conn?.close();
  conn = null;
  current = null;
  $('#bar').hidden = false;
  ui.set('PC saya', {
    sub: me ? '@' + me.login : '',
    actions: [
      { icon: 'refresh', label: 'Muat ulang', onclick: () => showMachines() },
      { icon: 'dots', label: 'Menu', onclick: accountMenu },
    ],
  });
  const list = h('div', {}, skeletons(2));
  ui.view(scrollCol(list));
  if (!me) api('/api/me').then((r) => ((me = r), r.login && ui.sub('@' + r.login))).catch(() => {});
  let machines;
  try {
    ({ machines } = await api('/api/machines'));
  } catch (e) {
    return list.replaceChildren(h('div', { class: 'err' }, e.message));
  }
  const install = 'npm i -g github:arfakaisar/pocketcode && pocketcode setup';
  const howto = h('div', { class: 'copyline' }, h('code', {}, install), h('button', { class: 'copybtn', onclick: async (e) => (await copyText(install)) && (e.currentTarget.classList.add('done'), toast('Perintah disalin')) }, ic('copy'), 'salin'));
  if (!machines.length)
    return list.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'big' }, '⌁'), h('b', {}, 'Belum ada PC tertaut'), 'Di komputer, jalankan:', howto));
  const last = resume ? store.get('last') : null;
  const lastM = last && machines.find((m) => m.id === last.mid);
  if (lastM) return openMachine(lastM, { sid: last.sid });
  list.replaceChildren(
    h('div', { class: 'label' }, 'Komputer', h('span', { class: 'count' }, machines.length)),
    ...machines.map((m, i) =>
      h('button', { class: 'card', style: `animation-delay:${i * 40}ms`, onclick: () => (haptic(), openMachine(m)) },
        h('span', { class: 'avatar' + (m.online ? '' : ' off') }, ic('monitor')),
        h('span', { class: 'grow' }, h('div', { class: 'name' }, m.name), h('div', { class: 'sub' }, m.online ? 'siap dipakai' : 'terakhir online ' + (ago(m.lastSeen) || '-') + (m.lastSeen ? ' lalu' : ''))),
        h('span', { class: 'statuspill' + (m.online ? ' on' : '') }, m.online ? 'online' : 'offline'),
      ),
    ),
    h('div', { class: 'label' }, 'Tambah PC'),
    h('div', { class: 'muted small' }, 'Pasang di komputer lain (Node.js 22+ dan git):'),
    howto,
  );
}

// ---------- Notifikasi & Web Push ----------
// Kunci VAPID dibuat di HP lalu dibagikan ke tiap PC lewat kanal E2EE: satu langganan push
// per HP bisa dipakai semua PC-nya, dan layanan push tidak bisa membaca isi notifikasi.
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const pushOn = () => !!store.get('vapid') && window.Notification?.permission === 'granted';

// Notifikasi dari halaman sendiri hanya dipakai bila Web Push belum aktif (agar tidak dobel).
function localNotify(title, body) {
  if (document.visibilityState !== 'visible' && !pushOn() && window.Notification?.permission === 'granted') new Notification(title, { body });
}

async function pushSubscription(create) {
  const reg = 'serviceWorker' in navigator && (await navigator.serviceWorker.getRegistration());
  if (!reg?.pushManager || window.Notification?.permission !== 'granted') return null;
  let vapid = store.get('vapid');
  let sub = await reg.pushManager.getSubscription();
  if (!vapid) {
    if (!create) return null;
    await sub?.unsubscribe(); // dibuat dengan kunci lain yang sudah hilang
    sub = null;
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const { kty, crv, d, x, y } = await crypto.subtle.exportKey('jwk', k.privateKey);
    store.set('vapid', (vapid = { kty, crv, d, x, y }));
  }
  if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from([4, ...unb64u(vapid.x), ...unb64u(vapid.y)]) });
  return sub ? { sub: sub.toJSON(), vapid } : null;
}

async function syncPush(create) {
  const p = await pushSubscription(create).catch(() => null);
  if (p && conn?.channel) await conn.call('pushSub', p).catch(() => {});
  return p;
}

async function enableNotifications() {
  if (!window.Notification) return toast('Browser ini tidak mendukung notifikasi', true);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notifikasi: ' + perm, true);
  const p = await syncPush(true);
  if (p) toast('Notifikasi aktif — tetap muncul walau aplikasi ditutup');
  else toast(/iPhone|iPad/.test(navigator.userAgent) ? 'Tambahkan ke Home Screen dulu agar notifikasi tetap jalan saat aplikasi ditutup' : 'Notifikasi aktif saat aplikasi terbuka', false, 5000);
}

function accountMenu() {
  ui.sheet(
    ui.head('Akun', { sub: me ? '@' + me.login : '' }),
    h('div', { class: 'group' },
      menuItem({ icon: 'bell', t1: 'Izinkan notifikasi', t2: 'Kabar saat agen selesai / butuh izin', onclick: enableNotifications }),
      menuItem({ icon: 'logout', t1: 'Keluar', danger: true, chev: false, onclick: () => (store.set('token', null), (me = null), ui.closeSheet(), showLogin()) }),
    ),
  );
}

// ---------- Koneksi ke satu PC ----------
function openMachine(m, { sid } = {}) {
  conn?.close();
  conn = new Conn(m);
  current = { m, resumeSid: sid };
  store.set('last', { mid: m.id, sid });
  const msg = h('div', { class: 'muted' });
  const showStatus = (title, text, busy = true) =>
    ui.view(h('div', { class: 'hero' }, h('div', { class: 'lockicon' }, busy ? h('span', { class: 'spinner', style: 'width:26px;height:26px' }) : ic('monitor')), h('h1', {}, title), msg, text ? h('p', { class: 'dim small' }, text) : null));
  ui.set(m.name, { sub: 'menghubungkan…', back: goMachines, dot: 'busy' });
  msg.textContent = 'Membuka kanal terenkripsi ke PC…';
  showStatus('Menghubungkan');
  conn.on('state', (s) => {
    if (s === 'offline') {
      ui.dot('off');
      ui.sub('offline');
      if (!current.ready) {
        msg.textContent = 'PC sedang offline.';
        showStatus('Menunggu PC', 'Pastikan pocketcode berjalan di PC (pocketcode autostart on) dan PC tidak tertidur. Halaman ini tersambung otomatis begitu PC online.', true);
      } else toast('PC offline — menunggu tersambung lagi…', true);
    } else if (s === 'online' || s === 'reconnecting') {
      ui.dot('busy');
      if (current.ready) ui.sub('menyambung ulang…');
    } else if (s === 'needpin') showPin(m);
    else if (s === 'revoked') (toast('HP ini dicabut aksesnya dari PC.', true), showPin(m));
    else if (s === 'removed') (toast('PC ini sudah dihapus dari akun.', true), goMachines());
    else if (s === 'authfail') toast('Verifikasi PC gagal.', true);
  });
  conn.on('ready', (info) => {
    ui.dot('on');
    const first = !current.ready;
    current.ready = true;
    current.info = info;
    clearInterval(current.updateTimer);
    current.updateTimer = setInterval(() => checkUpdateStatus(true), 90000);
    checkUpdateStatus(false);
    syncPush(false);
    if (document.visibilityState !== 'visible') conn.call('visible', { on: false }).catch(() => {});
    if (first) showSessions();
    else if (current.session) (reattach(), ui.sub(sessionSub(current.session)));
    else showSessionsMeta();
  });
  conn.on('events', (msg) => current?.onEvents?.(msg));
  conn.on('github', (msg) => onGithubStatus(msg));
  conn.on('update', (st) => onUpdateStatus(st, true));
  conn.on('notice', (msg) => {
    if (current?.session?.id === msg.sid && document.visibilityState === 'visible') return;
    toast(`${msg.title}: ${msg.msg}`);
    localNotify('pocketcode', `${msg.title}: ${msg.msg}`);
  });
  conn.connect();
}

function showPin(m) {
  ui.set(m.name, { sub: 'pasangkan HP ini', back: goMachines, dot: 'busy' });
  const err = h('div', { class: 'err', role: 'alert' });
  const input = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '12', placeholder: '••••••', 'aria-label': 'PIN', enterkeyhint: 'go' });
  const eye = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Tampilkan PIN' }, ic('eye'));
  eye.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.replaceChildren(ic(show ? 'eyeoff' : 'eye'));
    input.focus();
  };
  const wrap = h('div', { class: 'pinwrap' }, input, eye);
  const btn = h('button', { class: 'btn primary', style: 'margin-top:14px' }, 'Pasangkan');
  const go = async () => {
    const pin = input.value.trim();
    if (!C.PIN_RE.test(pin)) {
      err.textContent = 'PIN 6–12 huruf/angka.';
      wrap.classList.remove('shake');
      void wrap.offsetWidth;
      wrap.classList.add('shake');
      return;
    }
    const done = busyButton(btn, 'Memverifikasi…');
    err.textContent = '';
    const r = await conn.pair(pin);
    done();
    if (r.ok) return haptic(20);
    input.value = '';
    wrap.classList.remove('shake');
    void wrap.offsetWidth;
    wrap.classList.add('shake');
    haptic(60);
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
    h('div', { class: 'scroll' },
      h('div', { class: 'hero' },
        h('div', { class: 'lockicon' }, ic('lock')),
        h('h1', {}, 'Pasangkan HP ini'),
        h('div', { class: 'muted' }, `Masukkan PIN yang kamu buat saat setup di `, h('b', {}, m.name), '.'),
        h('div', { class: 'dim small', style: 'margin-top:6px' }, 'Cukup sekali per HP. PIN diverifikasi langsung oleh PC — tidak pernah dikirim ke server.'),
        wrap, err, btn,
      ),
    ),
  );
  setTimeout(() => input.focus(), 120);
}

// ---------- Layar: daftar sesi ----------
function sessionSub(s) {
  return `${s.repo} · ${s.branch}`;
}

async function showSessions() {
  current.session = null;
  current.onEvents = null;
  current.renderer = null;
  clearInterval(current.workTimer);
  ui.set(current.m.name, { back: goMachines, dot: 'on', actions: [{ icon: 'dots', label: 'Pengaturan PC', onclick: showMachineMenu }] });
  showSessionsMeta();
  setTimeout(renderUpdateBanner);
  setTimeout(renderGhBanner);
  checkUpdateStatus(false);
  const list = h('div', {}, skeletons(3));
  ui.view(
    h('div', { class: 'session' },
      scrollCol(h('div', { id: 'updateBanner' }), h('div', { id: 'ghBanner' }), list, h('div', { style: 'height:80px' })),
      h('button', { class: 'fab', onclick: () => (haptic(), showNewSession()) }, ic('plus'), 'Sesi baru'),
    ),
  );
  try {
    const sessions = await conn.call('sessions');
    const resume = current.resumeSid && sessions.find((x) => x.id === current.resumeSid);
    current.resumeSid = null;
    if (resume) return showSession(resume);
    store.set('last', { mid: current.m.id });
    if (!sessions.length)
      return list.replaceChildren(
        h('div', { class: 'empty' }, h('div', { class: 'big' }, '❯_'), h('b', {}, 'Belum ada sesi'), 'Ketuk ', h('span', { class: 'kbd' }, '+ Sesi baru'), ' untuk memilih repo GitHub dan mulai bekerja.'),
      );
    const running = sessions.filter((s) => s.status === 'running').length;
    list.replaceChildren(
      h('div', { class: 'label' }, 'Sesi', h('span', { class: 'count' }, sessions.length), running ? h('span', { class: 'tag run' }, running + ' berjalan') : null),
      ...sessions.map((s, i) => sessionCard(s, i)),
    );
  } catch (e) {
    list.replaceChildren(h('div', { class: 'err' }, e.message));
  }
}

function sessionCard(s, i) {
  const name = s.repo.split('/')[1] || s.repo;
  return h('button', { class: 'card', style: `animation-delay:${Math.min(i, 8) * 35}ms;align-items:flex-start`, onclick: () => (haptic(), showSession(s)) },
    h('span', { class: 'avatar' + (i % 2 ? ' alt' : '') }, name[0].toUpperCase()),
    h('span', { class: 'grow' },
      h('div', { class: 'row', style: 'display:flex;gap:8px;align-items:baseline' }, h('div', { class: 'name', style: 'flex:1' }, s.title || '(belum ada prompt)'), h('span', { class: 'dim small', style: 'flex:none' }, ago(s.updatedAt))),
      h('div', { class: 'sub' }, s.repo),
      h('div', { class: 'tags' },
        s.status === 'running' ? h('span', { class: 'tag run' }, 'berjalan') : null,
        s.local ? h('span', { class: 'tag' }, ic('term'), 'terminal') : null,
        h('span', { class: 'tag' }, ic('branch'), s.branch),
        s.model ? h('span', { class: 'tag' }, ic('cpu'), M.modelLabel(s.model)) : null,
        s.auto ? h('span', { class: 'tag warn' }, ic('bolt'), 'auto') : null,
      ),
    ),
  );
}

function showSessionsMeta() {
  const info = current?.info;
  if (!info || current.session) return;
  const up = current?.updateStatus?.updateAvailable ? ' · ⬆ update tersedia' : '';
  ui.sub(`◆ ${M.modelLabel(info.model)}${up}${info.github ? ' · @' + info.github : ' · GitHub belum login'}`);
}

// ---------- Pembaruan PC Otomatis (dari HP) ----------
function renderUpdateBanner() {
  const el = document.getElementById('updateBanner');
  if (!el) return;
  const st = current?.updateStatus;
  if (!st?.updateAvailable) return el.replaceChildren();

  const sha = st.latestCommit ? st.latestCommit.slice(0, 7) : 'terbaru';
  const behind = st.commitsBehind > 1 ? `${st.commitsBehind} commit tertinggal` : 'Pembaruan baru tersedia';
  const msg = st.latestMessage ? `"${st.latestMessage}"` : behind;

  const upBtn = h(
    'button',
    {
      class: 'btn-up-now',
      onclick: async (e) => {
        e.stopPropagation();
        const done = busyButton(e.currentTarget, 'Memperbarui…');
        try {
          haptic(20);
          const res = await conn.call('update');
          haptic(25);
          toast(res.message || 'Pembaruan berhasil! PC sedang me-restart…', false, 7000);
          current.updateStatus = null;
          renderUpdateBanner();
          showSessionsMeta();
        } catch (err) {
          done();
          toast('Pembaruan gagal: ' + err.message, true, 6000);
        }
      },
    },
    'Perbarui PC',
  );

  el.replaceChildren(
    h(
      'button',
      {
        class: 'card update-banner',
        onclick: () => updateMachineSheet(),
      },
      h('span', { class: 'avatar up-avatar' }, ic('spark')),
      h(
        'span',
        { class: 'grow' },
        h('div', { class: 'name' }, `Pembaruan PC Tersedia (${sha})`),
        h('div', { class: 'sub', style: 'white-space:normal' }, `${msg} · Ketuk untuk rincian`),
      ),
      upBtn,
    ),
  );
}

function onUpdateStatus(st, notify = false) {
  if (!current) return;
  const was = current.updateStatus?.updateAvailable;
  current.updateStatus = st;
  renderUpdateBanner();
  showSessionsMeta();
  if (st.updateAvailable && !was && notify) {
    haptic(15);
    toast(`Pembaruan pocketcode tersedia (${st.latestCommit})! Ketuk banner untuk perbarui.`, false, 6000);
  }
}

async function checkUpdateStatus(notify = false) {
  if (!conn || !current?.ready) return;
  try {
    const st = await conn.call('updateStatus');
    onUpdateStatus(st, notify);
  } catch {}
}

// ---------- Login GitHub PC (dari HP) ----------
// Token GitHub di PC bisa dicabut. Daemon memulai device flow dan kodenya
// tampil di sini, jadi login ulang bisa dilakukan dari mana saja.
const ghBad = () => ['invalid', 'missing'].includes(current?.info?.githubState);

function renderGhBanner() {
  const el = document.getElementById('ghBanner');
  if (!el) return;
  if (!ghBad()) return el.replaceChildren();
  el.replaceChildren(
    h('button', { class: 'card ghwarn', onclick: () => githubLoginSheet() },
      h('span', { class: 'avatar off' }, ic('github')),
      h('span', { class: 'grow' },
        h('div', { class: 'name' }, current.info.githubState === 'missing' ? 'GitHub belum login di PC ini' : 'Login GitHub di PC ini tidak berlaku'),
        h('div', { class: 'sub', style: 'white-space:normal' }, 'Push, PR, dan daftar repo tidak bisa dipakai. Ketuk untuk login ulang dari HP.'),
      ),
      ic('right', 'chev'),
    ),
  );
}

function onGithubStatus(st) {
  if (!current?.info) return;
  const was = current.info.githubState;
  current.info.githubState = st.state;
  if (st.login) current.info.github = st.login;
  renderGhBanner();
  showSessionsMeta();
  current.ghSheet?.(st);
  if (st.state === 'invalid' && was !== 'invalid' && !current.ghSheet) toast('Login GitHub di PC tidak berlaku — ketuk banner untuk login ulang', true, 5000);
}

async function githubLoginSheet() {
  const body = h('div', {}, loading('Meminta kode login ke GitHub…'));
  ui.sheet(ui.head('Login GitHub', { sub: 'untuk ' + current.m.name }), body);
  let timer;
  const close = () => {
    clearInterval(timer);
    current.ghSheet = null;
  };
  const render = (st) => {
    clearInterval(timer);
    if (st.state === 'ok' && !st.pending) {
      haptic(25);
      body.replaceChildren(
        h('div', { class: 'empty' }, h('div', { class: 'big', style: 'color:var(--green)' }, '✓'), h('b', {}, 'GitHub tersambung'), `@${st.login} — push, PR, dan daftar repo bisa dipakai lagi.`),
        h('button', { class: 'btn primary', onclick: () => (close(), ui.closeSheet()) }, 'Selesai'),
      );
      return;
    }
    const p = st.pending;
    if (!p) return;
    const left = h('span', {});
    const tick = () => {
      const s = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      left.textContent = s ? `kode berlaku ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'kode kedaluwarsa';
    };
    tick();
    timer = setInterval(tick, 1000);
    const copyBtn = h('button', { class: 'copybtn', onclick: async (e) => (await copyText(p.code)) && (e.currentTarget.classList.add('done'), toast('Kode disalin')) }, ic('copy'), 'salin');
    body.replaceChildren(
      h('div', { class: 'muted small' }, 'Masukkan kode ini di halaman GitHub, lalu tekan Authorize:'),
      h('div', { class: 'ghcode' }, h('span', {}, p.code), copyBtn),
      p.error
        ? h('div', { class: 'err' }, p.error)
        : h('div', { class: 'loading', style: 'justify-content:center' }, h('span', { class: 'spinner' }), h('span', {}, 'menunggu otorisasi · ', left)),
      h('a', { class: 'btn primary', href: p.uri, target: '_blank', rel: 'noopener', onclick: () => copyText(p.code) }, ic('github'), 'Salin kode & buka GitHub'),
      h('div', { class: 'dim small', style: 'margin-top:12px;text-align:center' }, p.uri.replace(/^https:\/\//, '')),
      p.error ? h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => githubLoginSheet() }, ic('refresh'), 'Minta kode baru') : null,
    );
  };
  current.ghSheet = render;
  try {
    render(await conn.call('githubLogin'));
  } catch (e) {
    close();
    body.replaceChildren(h('div', { class: 'err' }, /Metode tidak dikenal/.test(e.message) ? 'Perbarui pocketcode di PC untuk login GitHub dari HP (jalankan `pocketcode login` di PC).' : e.message));
  }
}

function modelItem(t1, id, onclick) {
  return menuItem({ icon: 'cpu', t1, t2: M.modelLabel(id) || '(belum dipilih)', onclick });
}

function showMachineMenu() {
  const info = current.info;
  const pick = (title, field) =>
    pickModel({
      title,
      current: info[field] || info.model,
      onBack: showMachineMenu,
      onPick: async (id) => {
        current.info = await conn.call('setModel', { [field]: id });
        toast(title + ': ' + M.modelLabel(id));
        showMachineMenu();
        showSessionsMeta();
      },
    });
  ui.sheet(
    ui.head(current.m.name, { sub: info.github ? 'GitHub @' + info.github : 'GitHub belum login' }),
    h('div', { class: 'label', style: 'margin-top:4px' }, 'Model'),
    h('div', { class: 'group' },
      modelItem('Default untuk sesi baru', info.model, () => pick('Model default', 'model')),
      modelItem('Model kecil (tugas ringan)', info.smallModel || info.model, () => pick('Model kecil', 'smallModel')),
    ),
    h('div', { class: 'label' }, 'GitHub'),
    h('div', { class: 'group' },
      menuItem({ icon: 'github', t1: ghBad() ? 'Login GitHub (perlu)' : 'Login ulang GitHub', t2: info.github && !ghBad() ? '@' + info.github + ' · tersambung' : 'push, PR, dan daftar repo', onclick: () => githubLoginSheet() }),
    ),
    h('div', { class: 'label' }, 'Sistem & Pembaruan'),
    h('div', { class: 'group' },
      menuItem({
        icon: 'spark',
        t1: 'Perbarui pocketcode di PC',
        t2: info.commit ? `Versi: ${info.commit}${info.version ? ' (' + info.version + ')' : ''}` : 'Periksa & pasang pembaruan jarak jauh',
        onclick: () => updateMachineSheet(),
      }),
      menuItem({
        icon: 'trash',
        t1: 'Bersihkan folder tak terpakai',
        t2: 'Hapus worktree & repo yatim di PC',
        onclick: async () => {
          try {
            toast('Memindai folder…');
            const r = await conn.call('cleanup');
            const wtCount = r.removedWorktrees?.length || 0;
            const repoCount = r.removedRepos?.length || 0;
            if (wtCount === 0 && repoCount === 0) {
              toast('Workspace PC sudah bersih.');
            } else {
              toast(`Dibersihkan: ${wtCount} worktree, ${repoCount} repo`);
            }
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
      menuItem({
        icon: 'refresh',
        t1: 'Restart daemon PC',
        t2: info.preventSleep ? 'Cegah PC sleep: aktif' : 'Mulai ulang koneksi daemon',
        onclick: async () => {
          if (!confirm('Restart daemon pocketcode di PC sekarang? Sesi akan otomatis tersambung lagi setelah beberapa detik.')) return;
          try {
            const r = await conn.call('restart');
            toast(r.message || 'Daemon me-restart…');
            ui.closeSheet();
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ),
    h('div', { class: 'label' }, 'Perangkat'),
    h('div', { class: 'group' },
      menuItem({ icon: 'bell', t1: 'Izinkan notifikasi', t2: 'Kabar saat agen selesai / butuh izin', onclick: enableNotifications }),
      menuItem({ icon: 'unlink', t1: 'Lupakan pairing HP ini', t2: 'Perlu PIN lagi untuk tersambung', danger: true, chev: false, onclick: () => (store.set('dev.' + current.m.id, null), ui.closeSheet(), openMachine(current.m)) }),
    ),
  );
}

async function updateMachineSheet() {
  const body = h('div', {}, loading('Memeriksa pembaruan di PC…'));
  ui.sheet(ui.head('Pembaruan PC', { sub: current.m.name }), body);
  try {
    const st = await conn.call('updateStatus');
    const hasUpdate = st.updateAvailable;
    const currentTxt = st.currentCommit ? `Commit saat ini: ${st.currentCommit}` : '';
    const latestTxt = st.latestCommit ? `Versi terbaru: ${st.latestCommit}` : '';
    const msgTxt = st.latestMessage ? `"${st.latestMessage}"` : '';

    const btn = h(
      'button',
      {
        class: 'btn primary',
        style: 'margin-top:14px',
        onclick: async (e) => {
          const done = busyButton(e.currentTarget, 'Memperbarui di PC…');
          try {
            const res = await conn.call('update');
            haptic(25);
            toast(res.message || 'Pembaruan berhasil! PC sedang me-restart…', false, 6000);
            ui.closeSheet();
          } catch (err) {
            done();
            toast('Pembaruan gagal: ' + err.message, true, 6000);
          }
        },
      },
      hasUpdate ? 'Perbarui Sekarang' : 'Paksa Perbarui Ulang',
    );

    body.replaceChildren(
      h(
        'div',
        { class: 'empty', style: 'padding:16px 0' },
        h('div', { class: 'big', style: hasUpdate ? 'color:var(--yellow)' : 'color:var(--green)' }, hasUpdate ? '⬆' : '✓'),
        h('b', {}, hasUpdate ? 'Pembaruan Tersedia!' : 'pocketcode Sudah Versi Terbaru'),
        hasUpdate && msgTxt ? h('div', { style: 'color:var(--fg);margin-top:4px;font-size:14px;word-break:break-word' }, msgTxt) : null,
        h('div', { class: 'dim small', style: 'margin-top:8px' }, `${currentTxt} · ${latestTxt}`),
      ),
      btn,
    );
  } catch (e) {
    if (isOldDaemon(e)) {
      const isWin = current?.info?.platform === 'win32';
      // Windows: claude.exe milik daemon yang masih jalan mengunci file → npm diam-diam
      // melewati binary. Jalankan sebagai proses terpisah (lepas dari sesi ini) yang
      // menghentikan daemon dulu, baru memasang, lalu menyalakan daemon lagi.
      const upCmd = isWin
        ? `Start-Process cmd -WindowStyle Hidden -ArgumentList '/c pocketcode stop & ping -n 4 127.0.0.1 >nul & npm i -g github:arfakaisar/pocketcode --include=optional > "%USERPROFILE%\\.pocketcode\\update.log" 2>&1 & pocketcode restart'`
        : 'npm i -g github:arfakaisar/pocketcode --include=optional && pocketcode restart';
      body.replaceChildren(
        h(
          'div',
          { class: 'empty', style: 'padding:16px 0' },
          h('div', { class: 'big', style: 'color:var(--yellow)' }, '⬆'),
          h('b', {}, 'Daemon PC Perlu Pembaruan Awal'),
          h('div', { class: 'dim small', style: 'margin-top:8px;line-height:1.5' },
            'Daemon di PC masih versi lama sebelum ada fitur pembaruan otomatis jarak jauh. Klik tombol di bawah untuk memasang pembaruan ke PC lewat sesi aktif:'
          ),
          h(
            'button',
            {
              class: 'btn primary',
              style: 'margin-top:14px',
              onclick: async (btnEv) => {
                const done = busyButton(btnEv.currentTarget, 'Mengirim perintah update…');
                try {
                  const list = await conn.call('sessions');
                  let target = list[0];
                  if (!target) {
                    target = await conn.call('create', { local: true });
                  }
                  await conn.call('send', { id: target.id, text: '!' + upCmd });
                  toast('Perintah update dikirim ke PC. Daemon akan me-restart…', false, 7000);
                  ui.closeSheet();
                } catch (err) {
                  done();
                  toast('Gagal: ' + err.message, true);
                }
              },
            },
            'Perbarui PC Sekarang (via Sesi)',
          ),
          h('div', { class: 'dim small', style: 'margin-top:14px;font-size:12px' },
            'Atau ketik langsung di chat sesi:',
          ),
          h('pre', { style: 'margin-top:4px;padding:8px;background:var(--bg2);border-radius:6px;user-select:all;font-size:12px;word-break:break-all' },
            '!' + upCmd
          ),
        ),
      );
      return;
    }
    body.replaceChildren(
      h('div', { class: 'err' }, 'Gagal memeriksa pembaruan: ' + e.message),
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => updateMachineSheet() }, 'Coba Lagi'),
    );
  }
}

// ---------- Pemilih model + slider effort ----------
const modelCache = { list: null, at: 0, probes: new Map() };
const isOldDaemon = (e) => /Metode tidak dikenal/.test(e?.message || '');

async function loadModels(fresh = false) {
  if (!fresh && modelCache.list && Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache.list;
  let list;
  try {
    list = await conn.call('modelsInfo', { fresh });
  } catch (e) {
    if (!isOldDaemon(e)) throw e;
    list = await conn.call('models'); // daemon versi lama: hanya ID
  }
  modelCache.list = list;
  modelCache.at = Date.now();
  return list;
}

function probeModel(id, retest = false) {
  if (retest) modelCache.probes.delete(id);
  if (!modelCache.probes.has(id)) {
    const p = conn.call('probeModel', { model: id }).catch((e) => ({ ok: null, err: isOldDaemon(e) ? 'Perbarui pocketcode di PC untuk menguji model.' : e.message }));
    modelCache.probes.set(id, p);
    // Kegagalan koneksi tidak disimpan; hasil dari model disimpan 5 menit.
    p.then((r) => (r.ok === null ? modelCache.probes.delete(id) : setTimeout(() => modelCache.probes.delete(id), 5 * 60 * 1000)));
  }
  return modelCache.probes.get(id);
}

// Sheet pemilih model. onPick(id) dipanggil saat "Pakai" ditekan.
async function pickModel({ title, current: cur, onPick, onBack }) {
  const q = h('input', { class: 'field', type: 'search', placeholder: 'Cari model…', autocapitalize: 'off', autocomplete: 'off', enterkeyhint: 'search' });
  const list = h('div', { class: 'mlist' }, loading('Memuat model…'));
  const probeLine = h('div', { class: 'probe' });
  const useBtn = h('button', { class: 'btn primary' }, 'Pakai');
  ui.sheet(ui.head(title, { back: onBack, sub: cur ? 'sekarang: ' + M.modelLabel(cur) : '' }), h('div', { class: 'search' }, ic('search'), q), list, h('div', { class: 'sheetfoot' }, probeLine, useBtn));

  let groups;
  try {
    groups = M.groupModels(await loadModels());
  } catch (e) {
    return list.replaceChildren(h('div', { class: 'err' }, e.message));
  }
  if (!groups.length) return list.replaceChildren(h('div', { class: 'err' }, 'Tidak ada model dengan tool calling di 9router.'));
  // Daftar model 9router bisa berubah kapan saja (model mati dihapus).
  const exact = cur ? M.findGroup(groups, cur) : null;
  const p = cur ? M.parseModelId(cur) : null;
  const sameGroup = !exact && p ? groups.find((g) => g.key === (p.provider ? p.provider + '/' : '') + p.base) : null;
  if (cur && !exact)
    list.before(h('div', { class: 'err', style: 'display:flex;gap:8px' }, ic('alert'), sameGroup ? `Varian ${cur} sudah tidak ada di 9router. Pilih tingkat effort lain.` : `${cur} sudah tidak ada di 9router. Pilih model lain.`));
  const g0 = exact || sameGroup || groups[0];
  const sel = { group: g0, effort: M.defaultChoice(g0, cur) };
  let probeTimer;
  let probeFor = null;

  const resolved = () => M.resolveId(sel.group, sel.effort);
  const update = () => {
    const id = resolved();
    useBtn.replaceChildren(id === cur ? '✓ Sedang dipakai' : 'Pakai ' + M.modelLabel(id));
    useBtn.disabled = id === cur;
    useBtn.className = 'btn primary';
    probeLine.replaceChildren(h('span', { class: 'spinner' }), h('span', { class: 'dim' }, 'menguji ' + M.modelLabel(id) + '…'));
    clearTimeout(probeTimer);
    probeFor = id;
    probeTimer = setTimeout(async () => {
      const r = await probeModel(id);
      if (probeFor !== id) return;
      const retest = h('button', { class: 'linkbtn', onclick: () => (probeModel(id, true), update()) }, 'uji ulang');
      if (r.ok) probeLine.replaceChildren(h('span', { class: 'ok' }, `✓ siap · ${(r.ms / 1000).toFixed(1)}s`), retest);
      else if (r.ok === null) probeLine.replaceChildren(h('span', { class: 'dim' }, r.err), retest);
      else {
        probeLine.replaceChildren(h('span', { class: 'e' }, '✗ ' + r.err), retest);
        if (id !== cur) {
          useBtn.replaceChildren('Tetap pakai ' + M.modelLabel(id));
          useBtn.className = 'btn warn';
        }
      }
    }, 450);
  };

  const effortPanel = (g) => {
    if (!g.slider) return null;
    const val = h('b', {}, '');
    const panel = h('div', { class: 'effort', onclick: (e) => e.stopPropagation() });
    const head = h('div', { class: 'row' }, h('span', { class: 'dim' }, 'effort'), val, h('span', { style: 'flex:1' }));
    let slider = null;
    let autoChip = null;
    let only = null;
    const ticks = [];
    if (g.auto) {
      autoChip = h('button', { class: 'effchip' }, 'auto');
      autoChip.onclick = () => {
        sel.effort = sel.effort === null ? g.levels[Math.floor((g.levels.length - 1) / 2)]?.effort ?? null : null;
        sync();
      };
      head.append(autoChip);
    }
    panel.append(head);
    if (g.levels.length >= 2) {
      slider = h('input', { type: 'range', min: '0', max: String(g.levels.length - 1), step: '1', 'aria-label': 'Tingkat effort' });
      slider.oninput = () => {
        sel.effort = g.levels[+slider.value].effort;
        haptic(6);
        sync();
      };
      for (const l of g.levels) ticks.push(h('button', { onclick: () => ((sel.effort = l.effort), sync()) }, M.EFFORT_LABEL[l.effort] || l.effort));
      panel.append(slider, h('div', { class: 'ticks' }, ...ticks));
    } else if (g.levels.length === 1) {
      only = h('button', { class: 'effchip', style: 'margin-left:6px' }, M.EFFORT_LABEL[g.levels[0].effort]);
      only.onclick = () => ((sel.effort = g.levels[0].effort), sync());
      head.append(only);
    }
    panel.append(h('div', { class: 'hint' }, '← cepat & hemat   ·   berpikir lebih dalam →'));
    const sync = () => {
      val.textContent = sel.effort === null ? 'auto' : M.EFFORT_LABEL[sel.effort] || sel.effort;
      if (slider) {
        const i = g.levels.findIndex((l) => l.effort === sel.effort);
        slider.disabled = sel.effort === null;
        if (i >= 0) slider.value = String(i);
        ticks.forEach((t, j) => t.classList.toggle('on', j === i));
      }
      autoChip?.classList.toggle('on', sel.effort === null);
      only?.classList.toggle('on', sel.effort !== null);
      update();
    };
    sync();
    return panel;
  };

  const render = () => {
    const term = q.value.trim().toLowerCase();
    const shown = groups.filter((g) => !term || g.key.toLowerCase().includes(term));
    const out = [];
    let lastProvider = null;
    for (const g of shown) {
      if (g.provider !== lastProvider) {
        lastProvider = g.provider;
        out.push(h('div', { class: 'mprov' }, (M.PROVIDER_LABEL[g.provider] || g.provider || 'lainnya') + (g.provider ? ` · ${g.provider}/` : '')));
      }
      const isSel = g === sel.group;
      const inUse = g.variants.some((v) => v.id === cur);
      const badges = [g.ctx ? M.ctxLabel(g.ctx) + ' konteks' : null, g.slider ? `${g.levels.length + (g.auto ? 1 : 0)} tingkat effort` : g.fixed ? 'effort ' + (M.EFFORT_LABEL[g.fixed] || g.fixed) : null, g.vision ? 'gambar' : null].filter(Boolean);
      out.push(
        h('div', { class: 'model' + (isSel ? ' sel' : ''), role: 'button', tabindex: '0', onclick: () => {
          if (sel.group === g) return;
          haptic(8);
          sel.group = g;
          sel.effort = M.defaultChoice(g, cur);
          render();
          update();
        } },
          h('div', { class: 'row' }, h('span', { class: 'mname' }, g.name), inUse ? h('span', { class: 'tag on' }, 'dipakai') : null),
          h('div', { class: 'sub' }, badges.join(' · ')),
          isSel ? effortPanel(g) : null,
        ),
      );
    }
    list.replaceChildren(...(out.length ? out : [h('div', { class: 'empty' }, 'Tidak ada model yang cocok.')]));
  };
  q.oninput = render;
  useBtn.onclick = async () => {
    const done = busyButton(useBtn, 'Menyimpan…');
    try {
      await onPick(resolved());
      haptic(15);
    } catch (e) {
      toast(e.message, true);
      done();
    }
  };
  render();
  update();
  requestAnimationFrame(() => list.querySelector('.model.sel')?.scrollIntoView({ block: 'center' }));
}

// ---------- Layar: sesi baru ----------
function showNewSession() {
  ui.set('Sesi baru', { sub: 'pilih repo GitHub', back: showSessions, dot: 'on' });
  const q = h('input', { class: 'field', type: 'search', placeholder: 'Cari repo atau ketik owner/nama', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const results = h('div', {}, skeletons(4));
  ui.view(scrollCol(h('div', { class: 'search' }, ic('search'), q), results));
  let timer;
  let seq = 0;
  const row = (r, i = 0) =>
    h('button', { class: 'card', style: `animation-delay:${Math.min(i, 8) * 30}ms`, onclick: () => (haptic(), pickBranch(r)) },
      h('span', { class: 'avatar' + (i % 2 ? ' alt' : '') }, (r.full.split('/')[1] || '?')[0].toUpperCase()),
      h('span', { class: 'grow' },
        h('div', { class: 'name' }, r.full.split('/')[1] || r.full),
        h('div', { class: 'sub' }, r.desc || r.full),
        h('div', { class: 'tags' }, h('span', { class: 'tag' }, r.full.split('/')[0]), r.private ? h('span', { class: 'tag' }, ic('lock'), 'private') : null, r.pushed ? h('span', { class: 'tag' }, 'push ' + ago(Date.parse(r.pushed)) + ' lalu') : null),
      ),
      ic('right', 'chev'),
    );
  const load = async () => {
    const my = ++seq;
    const term = q.value.trim();
    const typed = /^[\w.-]+\/[\w.-]+$/.test(term) ? { full: term, desc: 'pakai nama ini' } : null;
    try {
      const repos = await conn.call('repos', { q: term || undefined });
      if (my !== seq) return;
      const list = [...(typed && !repos.some((r) => r.full === term) ? [typed] : []), ...repos];
      results.replaceChildren(
        h('div', { class: 'label' }, term ? 'Hasil' : 'Terakhir di-push', h('span', { class: 'count' }, list.length)),
        ...(list.length ? list.map(row) : [h('div', { class: 'empty' }, 'Tidak ada repo.')]),
      );
    } catch (e) {
      if (my !== seq) return;
      // Tanpa login GitHub tetap bisa membuka repo publik dengan mengetik owner/nama.
      results.replaceChildren(...(typed ? [row(typed)] : []), h('div', { class: 'err' }, e.message), h('div', { class: 'dim small' }, 'Kamu tetap bisa mengetik owner/nama untuk repo publik.'));
    }
  };
  q.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 300);
  };
  load();
}

async function pickBranch(repo) {
  const branches = h('select', { class: 'field', 'aria-label': 'Branch' }, h('option', { value: '' }, '(branch default)'));
  const mode = { v: 'new' };
  const newName = h('input', { class: 'field', placeholder: 'nama branch baru (opsional)', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const err = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn primary' }, ic('term'), 'Mulai sesi');
  const segNew = h('button', { onclick: () => setMode('new') }, 'Branch baru');
  const segOld = h('button', { onclick: () => setMode('existing') }, 'Lanjutkan branch');
  const branchLabel = h('div', { class: 'label', style: 'margin-top:16px' });
  const hint = h('div', { class: 'dim small', style: 'margin-top:8px' });
  const setMode = (v) => {
    mode.v = v;
    segNew.classList.toggle('on', v === 'new');
    segOld.classList.toggle('on', v === 'existing');
    newName.hidden = v !== 'new';
    branchLabel.textContent = v === 'new' ? 'Dibuat dari' : 'Branch yang dilanjutkan';
    hint.textContent = v === 'new' ? 'Kosongkan nama untuk branch otomatis pocket/<id>.' : 'Perubahan baru akan ditambahkan ke branch ini.';
  };
  setMode('new');
  let model = current.info.model;
  const modelSlot = h('div', { class: 'group' });
  const nodes = [];
  const reshow = () => ui.sheet(...nodes);
  const renderModel = () =>
    modelSlot.replaceChildren(
      modelItem('Model untuk sesi ini', model, () => pickModel({ title: 'Model sesi', current: model, onBack: reshow, onPick: (id) => ((model = id), renderModel(), reshow()) })),
    );
  renderModel();
  btn.onclick = async () => {
    const done = busyButton(btn, 'Menyiapkan repo…');
    err.textContent = '';
    try {
      const params = mode.v === 'new' ? { repo: repo.full, base: branches.value || undefined, branch: newName.value.trim() || undefined } : { repo: repo.full, branch: branches.value || repo.branch };
      params.model = model;
      const s = await conn.call('create', params);
      haptic(20);
      ui.closeSheet();
      showSession(s);
    } catch (e) {
      err.textContent = e.message;
      done();
    }
  };
  nodes.push(
    ui.head(repo.full.split('/')[1] || repo.full, { sub: repo.full }),
    h('div', { class: 'seg' }, segNew, segOld),
    branchLabel, branches, newName, hint,
    h('div', { class: 'label' }, 'Model'), modelSlot,
    err,
    h('div', { class: 'sheetfoot' }, btn),
  );
  reshow();
  try {
    const list = await conn.call('branches', { repo: repo.full });
    branches.replaceChildren(...list.map((b) => h('option', { value: b, selected: b === repo.branch }, b)));
  } catch {}
}

// ---------- Layar: sesi (terminal) ----------
const QUICK = [
  { icon: 'book', t1: 'Jelaskan repo ini', t2: 'struktur, cara menjalankan, bagian penting', text: 'Jelaskan struktur repo ini, cara menjalankannya, dan bagian terpentingnya. Singkat.' },
  { icon: 'diff', t1: 'Review perubahan', t2: 'cek git diff, cari bug, ringkas', text: 'Review perubahan yang belum di-commit (git diff): cari bug atau risiko, lalu ringkas.' },
  { icon: 'flask', t1: 'Jalankan & perbaiki test', t2: 'temukan perintah test, jalankan, perbaiki yang gagal', text: 'Temukan cara menjalankan test di repo ini, jalankan, lalu perbaiki yang gagal.' },
  { icon: 'bug', t1: 'Perbaiki error terakhir', t2: 'lanjutkan dari output sebelumnya', text: 'Perbaiki error terakhir yang muncul di sesi ini, lalu verifikasi.' },
  { icon: 'commit', t1: 'Commit perubahan', t2: 'tulis pesan commit yang jelas lalu commit', text: 'Lihat perubahan yang ada, tulis pesan commit yang jelas, lalu commit. Jangan push.' },
];
const QUICK_SH = ['git status', 'git log --oneline -n 8', 'git diff --stat', 'ls'];

function showSession(s) {
  current.session = s;
  current.lastSeq = 0;
  store.set('last', { mid: current.m.id, sid: s.id });
  const col = h('div', { class: 'col' });
  const term = h('div', { id: 'term' }, col);
  const working = h('div', { id: 'working', hidden: true }, h('span', { class: 'orb' }), h('span', { class: 'wl' }, 'bekerja'), h('span', { class: 't' }, '0s'));
  const toBottom = h('button', { id: 'tobottom', hidden: true, 'aria-label': 'Ke pesan terbaru' }, ic('arrowdown'));
  const dock = h('div', { id: 'dock' });
  const input = h('textarea', { id: 'input', rows: 1, placeholder: 'Minta sesuatu ke agen…', autocapitalize: 'sentences', enterkeyhint: coarse ? 'enter' : 'send', 'aria-label': 'Pesan' });
  const send = h('button', { id: 'send', class: 'idle', 'aria-label': 'Kirim' }, ic('send'));
  const modeBtn = h('button', { class: 'modebtn', 'aria-label': 'Ganti mode agen / shell' }, '❯');
  const modelChip = h('button', { class: 'chip model', 'aria-label': 'Ganti model' });
  const runChip = h('button', { class: 'chip', 'aria-label': 'Jalankan & preview' }, ic('play'), 'run');
  const gitChip = h('button', { class: 'chip', 'aria-label': 'Git' }, ic('branch'), 'git');
  const autoChip = h('button', { class: 'chip', 'aria-label': 'Auto-izin' });
  const planChip = h('button', { class: 'chip', 'aria-label': 'Mode rencana' }, ic('list'), 'rencana');
  const quickChip = h('button', { class: 'chip', 'aria-label': 'Aksi cepat' }, ic('spark'), 'aksi cepat');
  const attachBtn = h('button', { class: 'modebtn attach', 'aria-label': 'Lampirkan gambar' }, ic('image'));
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const thumbs = h('div', { id: 'thumbs', hidden: true });
  ui.set(s.title || s.repo.split('/')[1], { sub: sessionSub(s), back: () => (conn.call('detach').catch(() => {}), showSessions()), dot: 'on', actions: [{ icon: 'dots', label: 'Menu sesi', onclick: () => sessionMenu() }] });
  ui.view(
    h('div', { class: 'session' },
      h('div', { style: 'flex:1;min-height:0;position:relative;display:flex;flex-direction:column' }, term, working, toBottom),
      dock,
      h('div', { id: 'composer' }, h('div', { class: 'inner' }, h('div', { id: 'chips' }, modelChip, runChip, gitChip, autoChip, planChip, quickChip), thumbs, h('div', { id: 'inputRow' }, modeBtn, attachBtn, fileIn, input, send))),
    ),
  );

  const r = new Renderer(term, col, dock);
  current.renderer = r;
  current.procs = new Map();
  current.preview = null;

  // --- run & preview: badge jumlah proses berjalan ---
  current.syncRun = () => {
    const n = [...current.procs.values()].filter((p) => p.status === 'running').length;
    runChip.className = 'chip' + (current.preview ? ' on' : '');
    runChip.replaceChildren(ic(current.preview ? 'globe' : 'play'), current.preview ? 'preview' : 'run', n ? h('span', { class: 'badge' }, n) : '');
    current.runSheet?.();
  };
  runChip.onclick = () => showRun();

  // --- mode rencana: agen hanya membaca & menyusun rencana, lalu meminta persetujuan ---
  current.setPlan = (on) => {
    current.session.plan = on;
    planChip.className = 'chip' + (on ? ' on' : '');
    input.placeholder = on ? 'Rencanakan apa?' : shellMode ? 'Perintah shell di worktree…' : 'Minta sesuatu ke agen…';
  };
  planChip.onclick = async () => {
    haptic();
    try {
      current.setPlan((await conn.call('plan', { id: s.id, on: !current.session.plan })).plan);
      toast(current.session.plan ? 'Mode rencana: agen menyusun rencana dulu, tanpa mengubah file' : 'Mode rencana mati');
    } catch (e) {
      toast(isOldDaemon(e) ? 'Perbarui pocketcode di PC untuk mode rencana.' : e.message, true);
    }
  };

  // --- lampiran gambar (kamera, galeri, atau tempel dari clipboard) ---
  let images = [];
  const renderThumbs = () => {
    thumbs.hidden = !images.length;
    thumbs.replaceChildren(...images.map((im, i) => h('button', { class: 'thumb', 'aria-label': 'Hapus gambar', onclick: () => ((images = images.filter((_, j) => j !== i)), renderThumbs(), syncSend()) }, h('img', { src: `data:${im.mime};base64,${im.data}`, alt: '' }), ic('x'))));
  };
  const addImages = async (files) => {
    for (const f of [...files].filter((f) => f.type.startsWith('image/'))) {
      if (images.length >= 4) return toast('Maksimal 4 gambar', true);
      try {
        images.push(await compressImage(f));
      } catch {
        toast('Gambar tidak bisa dibaca', true);
      }
    }
    renderThumbs();
    syncSend();
  };
  attachBtn.onclick = () => fileIn.click();
  fileIn.onchange = () => (addImages(fileIn.files), (fileIn.value = ''));
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) (e.preventDefault(), addImages(files));
  });
  r.onUnread = (n) => {
    toBottom.hidden = n === 0 && r.stick;
    toBottom.replaceChildren(ic('arrowdown'), n ? h('span', { class: 'n' }, n) : '');
  };
  toBottom.onclick = () => r.scroll(true);

  // --- model chip ---
  const setModelChip = () => {
    const p = M.parseModelId(current.session.model || '');
    modelChip.replaceChildren(ic('cpu'), h('span', { class: 'ml' }, p.base), p.effort ? h('span', { class: 'eff' }, M.EFFORT_LABEL[p.effort] || p.effort) : '');
  };
  setModelChip();
  modelChip.onclick = () => {
    if (current.running) return toast('Tunggu agen selesai (atau Stop) sebelum ganti model.', true);
    pickModel({
      title: 'Model sesi ini',
      current: current.session.model,
      onPick: async (id) => {
        let sum;
        try {
          sum = await conn.call('setSessionModel', { id: s.id, model: id });
        } catch (e) {
          throw isOldDaemon(e) ? new Error('Perbarui pocketcode di PC untuk ganti model di tengah sesi.') : e;
        }
        current.session.model = sum.model;
        setModelChip();
        ui.closeSheet();
        toast('Model: ' + M.modelLabel(id));
      },
    });
  };

  // --- git chip + badge jumlah perubahan ---
  gitChip.onclick = () => showGit();
  let gitT;
  current.refreshGit = () => {
    clearTimeout(gitT);
    gitT = setTimeout(async () => {
      try {
        const st = await conn.call('status', { id: s.id });
        const n = st.files.length;
        gitChip.replaceChildren(ic('branch'), 'git', n ? h('span', { class: 'badge' }, n) : '', !n && st.ahead ? h('span', { class: 'badge' }, '↑' + st.ahead) : '');
      } catch {}
    }, 700);
  };

  // --- auto-izin ---
  const setAuto = (on) => {
    current.session.auto = on;
    autoChip.replaceChildren(ic('bolt'), on ? 'auto-izin ON' : 'auto-izin');
    autoChip.className = 'chip' + (on ? ' danger' : '');
  };
  autoChip.onclick = async () => {
    const on = !current.session.auto;
    if (on && !confirm('Auto-izin: agen boleh menjalankan perintah shell apa pun tanpa bertanya (kecuali git push). Lanjut?')) return;
    setAuto((await conn.call('auto', { id: s.id, on })).auto);
    haptic();
  };
  setAuto(!!s.auto);

  // --- mode agen / shell ---
  let shellMode = false;
  const setMode = (sh) => {
    shellMode = sh;
    modeBtn.textContent = sh ? '$' : '❯';
    modeBtn.classList.toggle('shell', sh);
    input.classList.toggle('shell', sh);
    input.autocapitalize = sh ? 'off' : 'sentences';
    current.setPlan(!!current.session.plan);
  };
  modeBtn.onclick = () => (setMode(!shellMode), haptic(), input.focus());
  setMode(false);

  quickChip.onclick = () =>
    ui.sheet(
      ui.head('Aksi cepat', { sub: 'kirim langsung ke agen' }),
      h('div', { class: 'group' }, ...QUICK.map((qk) => menuItem({ icon: qk.icon, t1: qk.t1, t2: qk.t2, onclick: () => (ui.closeSheet(), quick(qk.text)) }))),
      h('div', { class: 'label' }, 'Shell'),
      h('div', { class: 'group' }, ...QUICK_SH.map((c) => menuItem({ icon: 'term', t1: '$ ' + c, chev: false, onclick: () => (ui.closeSheet(), quick('!' + c)) }))),
    );

  // --- status berjalan + indikator kerja ---
  const setRunning = (on) => {
    const was = current.running;
    current.running = on;
    send.replaceChildren(ic(on ? 'stop' : 'send'));
    send.setAttribute('aria-label', on ? 'Hentikan' : 'Kirim');
    syncSend();
    ui.dot(on ? 'busy' : 'on');
    clearInterval(current.workTimer);
    working.hidden = !on;
    if (on) {
      const t0 = current.runStart && was ? current.runStart : Date.now();
      current.runStart = t0;
      const tick = () => {
        const sec = Math.round((Date.now() - t0) / 1000);
        working.querySelector('.t').textContent = sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
        working.querySelector('.wl').textContent = r.permQueue.length ? 'menunggu izinmu ↓' : r.activity || 'berpikir…';
      };
      tick();
      current.workTimer = setInterval(tick, 1000);
    } else if (was) {
      current.runStart = null;
      current.refreshGit();
    }
  };
  const syncSend = () => {
    const has = input.value.trim().length > 0 || images.length > 0;
    send.className = current.running ? 'stop' : has ? '' : 'idle';
  };
  current.setRunning = setRunning;
  current.onEvents = (msg) => {
    if (msg.sid !== s.id) return;
    for (const e of msg.es) {
      // Event yang sudah diterima (mis. lewat attach setelah reconnect) tidak digambar dua kali.
      if (e.seq && e.seq <= current.lastSeq) continue;
      if (e.k === 'status') setRunning(e.s === 'running');
      else if (e.k === 'proc') onProc(e);
      else if (e.k === 'procOut') current.procOut?.(e);
      else if (e.k === 'preview') (current.preview = e.url ? e : null), current.syncRun();
      else if (e.k === 'mode') current.setPlan(e.plan);
      else r.add(e);
      if (e.seq) current.lastSeq = Math.max(current.lastSeq, e.seq);
      if (e.k === 'done') (haptic(e.ok ? 15 : 50), e.ok || toast('Agen berhenti: ' + (e.err || 'error'), true));
    }
  };

  // --- input ---
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, window.innerHeight * 0.38) + 'px';
  };
  input.oninput = () => {
    autosize();
    syncSend();
    input.classList.toggle('shell', shellMode || input.value.startsWith('!'));
  };
  const submit = async () => {
    if (current.running) {
      haptic(20);
      await conn.call('interrupt', { id: s.id }).catch((e) => toast(e.message, true));
      return;
    }
    let text = input.value.trim();
    const imgs = images;
    if (!text && !imgs.length) return input.focus();
    if (shellMode && !imgs.length && !text.startsWith('!')) text = '!' + text;
    input.value = '';
    images = [];
    renderThumbs();
    autosize();
    syncSend();
    haptic(10);
    r.scroll(true);
    try {
      await conn.call('send', { id: s.id, text, ...(imgs.length ? { images: imgs } : {}) });
    } catch (e) {
      toast(e.message, true);
      input.value = text;
      images = imgs;
      renderThumbs();
      syncSend();
    }
  };
  const quick = (t) => {
    input.value = t;
    submit();
  };
  send.onclick = submit;
  input.onkeydown = (e) => {
    // HP: Enter = baris baru (kirim pakai tombol). Keyboard fisik: Enter kirim, Shift+Enter baris baru.
    if (e.key === 'Enter' && !e.isComposing && ((!coarse && !e.shiftKey) || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };
  input.addEventListener('focus', () => setTimeout(() => r.keepBottom(), 300));
  reattach(true);
}

async function reattach(fresh) {
  const s = current.session;
  const r = current.renderer;
  try {
    const res = await conn.call('attach', { id: s.id, since: fresh ? 0 : current.lastSeq });
    if (fresh && res.truncated) r.line('meta', '… riwayat lama tidak ditampilkan');
    r.batch(() => {
      for (const e of res.events) {
        r.add(e, true);
        current.lastSeq = Math.max(current.lastSeq, e.seq);
      }
    });
    for (const p of res.perms) r.add({ k: 'perm', ...p });
    current.setRunning(res.session.status === 'running');
    current.setPlan(!!res.session.plan);
    current.procs = new Map((res.procs || []).map((p) => [p.name, p]));
    current.preview = res.preview || null;
    current.syncRun();
    if (fresh && !res.events.length) r.welcome(s);
    r.scroll(true);
    current.refreshGit?.();
  } catch (e) {
    toast(e.message, true);
  }
}

// Kecilkan gambar (sisi terpanjang 1568px, JPEG) agar hemat token dan 4 gambar tetap muat satu
// frame relay (1 MiB; payload terenkripsi membesar ±4/3 karena base64).
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k);
  cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  for (const q of [0.8, 0.65, 0.5, 0.35]) {
    const data = cv.toDataURL('image/jpeg', q).split(',')[1];
    if (data.length < 170_000) return { mime: 'image/jpeg', data };
  }
  throw new Error('terlalu besar');
}

// ---------- Run & Preview ----------
function onProc(p) {
  const was = current.procs.get(p.name);
  current.procs.set(p.name, { ...was, ...p });
  if (was?.status === 'running' && p.status === 'exited' && !p.killed) toast(`${p.name} berhenti (exit ${p.code})`, p.code !== 0);
  if (!was?.port && p.port) toast(`${p.name} siap di port ${p.port}`);
  current.syncRun();
}

function showRun() {
  const s = current.session;
  const body = h('div', {});
  const cmdIn = h('input', { class: 'field', placeholder: 'mis. npm run dev (kosongkan = otomatis)', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go' });
  let detected = null;
  const act = (b, fn) => async () => {
    const done = busyButton(b, 'Memproses…');
    try {
      await fn();
    } catch (e) {
      toast(isOldDaemon(e) ? 'Perbarui pocketcode di PC untuk fitur Run & Preview.' : e.message, true);
    }
    if (b.isConnected) done();
  };
  const startBtn = h('button', { class: 'btn primary' }, ic('play'), 'Jalankan');
  startBtn.onclick = act(startBtn, async () => {
    const r = await conn.call('runDev', { id: s.id, cmd: cmdIn.value.trim() || undefined });
    haptic(15);
    toast(r.setup ? `Memasang dependency (${r.setup}), lalu ${r.dev}` : `Menjalankan ${r.dev}`);
    cmdIn.value = '';
  });
  cmdIn.onkeydown = (e) => e.key === 'Enter' && startBtn.click();

  const procCard = (p) => {
    const run = p.status === 'running';
    const pv = current.preview?.name === p.name ? current.preview : null;
    const btns = h('div', { class: 'btnrow' });
    if (run && p.port) {
      // Tab baru dibuka dari ketukan langsung pada link: popup setelah await diblokir iOS.
      const prev = pv
        ? h('a', { class: 'btn primary', href: pv.link, target: '_blank', rel: 'noopener', onclick: () => haptic() }, ic('globe'), 'Buka preview')
        : h('button', { class: 'btn primary' }, ic('globe'), 'Preview di HP');
      if (!pv)
        prev.onclick = act(prev, async () => {
          toast('Membuka tunnel aman… (±10 detik)');
          current.preview = await conn.call('preview', { id: s.id, name: p.name });
          current.syncRun();
          haptic(20);
          toast('Preview siap — ketuk "Buka preview"');
        });
      const shot = h('button', { class: 'btn' }, ic('camera'), 'Screenshot');
      shot.onclick = act(shot, async () => showShot(await conn.call('screenshot', { id: s.id, name: p.name, width: Math.round(innerWidth), height: Math.round(innerHeight) })));
      btns.append(prev, shot);
    }
    const logBtn = h('button', { class: 'btn' }, ic('term'), 'Log');
    logBtn.onclick = () => showLogs(p.name);
    const stop = h('button', { class: 'btn danger' }, run ? 'Stop' : 'Hapus');
    stop.onclick = act(stop, async () => {
      await conn.call('procStop', { id: s.id, name: p.name });
      if (!run) current.procs.delete(p.name), current.syncRun();
    });
    btns.append(logBtn, stop);
    const closePv = pv && h('button', { class: 'linkbtn' }, 'tutup');
    if (closePv) closePv.onclick = act(closePv, () => conn.call('previewClose', { id: s.id }));
    return h('div', { class: 'proc' + (run ? ' on' : '') },
      h('div', { class: 'ph' }, h('span', { class: 'pdot' }), h('b', {}, p.name), h('span', { class: 'dim small grow' }, run ? (p.port ? `port ${p.port}` : 'menunggu port…') : `berhenti · exit ${p.code ?? '-'}`)),
      h('code', { class: 'pcmd' }, p.cmd),
      pv ? h('div', { class: 'purl' }, ic('lock'), h('span', {}, pv.url.replace(/^https:\/\//, '')), closePv) : null,
      btns,
    );
  };

  const render = () => {
    const ps = [...current.procs.values()].sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.startedAt - a.startedAt);
    body.replaceChildren(
      ps.length ? h('div', {}, ...ps.map(procCard)) : h('div', { class: 'dim small' }, 'Belum ada proses. Dev server berjalan di PC, lalu bisa dibuka di HP lewat tunnel terenkripsi khusus untukmu.'),
      h('div', { class: 'label' }, 'Jalankan'),
      cmdIn,
      detected ? h('div', { class: 'dim small', style: 'margin:8px 2px 0' }, detected.dev ? `Otomatis: ${detected.setup ? detected.setup + ' → ' : ''}${detected.dev}` : 'Perintah dev tidak terdeteksi — isi manual.') : null,
      h('div', { style: 'margin-top:10px' }, startBtn),
      h('div', { class: 'fine', style: 'margin-top:14px' }, 'Preview memakai Cloudflare Tunnel dengan token rahasia yang hanya dikirim ke perangkatmu: tanpa token, link ditolak. Tunnel tertutup otomatis saat proses berhenti.'),
    );
  };
  current.runSheet = () => body.isConnected ? render() : (current.runSheet = null);
  ui.sheet(ui.head('Run & Preview', { sub: s.repo }), body);
  render();
  conn.call('project', { id: s.id }).then((r) => {
    detected = r;
    for (const p of r.procs) current.procs.set(p.name, p);
    current.preview = r.preview;
    current.syncRun();
  }, () => {});
}

function showLogs(name) {
  const s = current.session;
  const pre = h('pre', { class: 'shout logview' }, 'memuat…');
  const stick = () => pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const append = (d) => {
    const end = stick();
    pre.textContent = (pre.textContent + d).slice(-200_000);
    if (end) pre.scrollTop = pre.scrollHeight;
  };
  current.procOut = (e) => (pre.isConnected ? e.name === name && append(e.d) : (current.procOut = null));
  ui.sheet(ui.head('Log ' + name, { back: showRun }), pre);
  conn.call('procLogs', { id: s.id, name }).then((t) => ((pre.textContent = t || '(belum ada output)'), (pre.scrollTop = pre.scrollHeight)), (e) => (pre.textContent = e.message));
}

function showShot(r) {
  const errs = r.logs.filter((l) => /error|exception/.test(l.level));
  const s = current.session;
  ui.sheet(
    ui.head('Screenshot', { sub: r.title || '', back: showRun }),
    h('img', { class: 'shot', src: `data:${r.mime};base64,${r.data}`, alt: 'screenshot' }),
    r.logs.length ? h('div', {}, h('div', { class: 'label' }, 'Console', errs.length ? h('span', { class: 'tag warn' }, errs.length + ' error') : null), h('pre', { class: 'shout' }, r.logs.map((l) => `[${l.level}] ${l.text}`).join('\n'))) : h('div', { class: 'dim small' }, 'Console bersih.'),
    errs.length
      ? h('div', { class: 'sheetfoot' }, h('button', { class: 'btn primary', onclick: async () => {
          ui.closeSheet();
          await conn.call('send', { id: s.id, text: `Halaman preview menampilkan error berikut di console browser. Perbaiki, lalu verifikasi dengan preview_screenshot:\n\n${errs.map((l) => l.text).join('\n').slice(0, 6000)}` }).catch((e) => toast(e.message, true));
        } }, ic('bug'), 'Suruh agen perbaiki'))
      : null,
  );
}

function sessionMenu() {
  const s = current.session;
  ui.sheet(
    ui.head(s.title || 'Sesi', { sub: s.repo }),
    h('div', { class: 'tags', style: 'margin:0 0 12px' }, h('span', { class: 'tag' }, ic('branch'), s.branch), h('span', { class: 'tag' }, 'base ' + s.base), h('span', { class: 'tag' }, ic('cpu'), M.modelLabel(s.model))),
    h('div', { class: 'group' },
      menuItem({ icon: 'branch', t1: 'Git', t2: 'status, diff, commit, push, PR', onclick: () => showGit() }),
      menuItem({ icon: 'play', t1: 'Run & Preview', t2: 'dev server, log, preview di HP', onclick: () => showRun() }),
      menuItem({ icon: 'cpu', t1: 'Ganti model / effort', t2: M.modelLabel(s.model), onclick: () => (ui.closeSheet(), $('.chip.model')?.click()) }),
      s.local ? null : menuItem({
        icon: 'save', t1: 'Simpan .env sebagai template', t2: 'dipulihkan otomatis di sesi baru repo ini',
        onclick: async () => {
          try {
            const f = await conn.call('envSave', { id: s.id });
            toast(f.length ? 'Disimpan: ' + f.join(', ') : 'Tidak ada file .env di worktree', !f.length);
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ),
    h('div', { class: 'group' },
      menuItem({
        icon: 'trash', t1: 'Hapus sesi', t2: 'worktree di PC ikut dihapus', danger: true, chev: false,
        onclick: async () => {
          if (!confirm('Hapus sesi ini beserta worktree-nya di PC? Perubahan yang belum di-push akan hilang.')) return;
          await conn.call('delete', { id: s.id }).catch((e) => toast(e.message, true));
          ui.closeSheet();
          showSessions();
        },
      }),
    ),
  );
}

// ---------- Git ----------
async function showGit() {
  const s = current.session;
  const body = h('div', {}, loading('Memuat status git…'));
  ui.sheet(ui.head('Git', { sub: s.repo }), body);
  let st;
  try {
    st = await conn.call('status', { id: s.id });
  } catch (e) {
    return body.replaceChildren(h('div', { class: 'err' }, e.message));
  }
  current.refreshGit?.();
  const msg = h('input', { class: 'field', placeholder: 'Pesan commit', autocapitalize: 'sentences', enterkeyhint: 'done' });
  const err = h('div', { class: 'err' });
  const act = (content, fn, cls = 'btn') => {
    const b = h('button', { class: cls }, ...content);
    b.onclick = async () => {
      const done = busyButton(b, 'Memproses…');
      err.textContent = '';
      try {
        await fn();
      } catch (x) {
        err.textContent = x.message;
        haptic(50);
      }
      if (b.isConnected) done();
    };
    return b;
  };
  const stCls = (code) => (code.includes('?') || code.includes('A') ? 'A' : code.includes('D') ? 'D' : code.includes('R') ? 'R' : 'M');
  const stTxt = (code) => (code.includes('?') ? 'A' : code.trim()[0] || 'M');
  body.replaceChildren(
    h('div', { class: 'gitstat' },
      h('span', { class: 'tag' }, ic('branch'), st.branch),
      st.hasUpstream ? h('span', { class: 'tag' + (st.ahead ? ' run' : '') }, `↑${st.ahead} ↓${st.behind}`) : h('span', { class: 'tag' + (st.ahead ? ' run' : '') }, st.ahead ? `${st.ahead} commit belum di GitHub` : 'belum ada di GitHub'),
    ),
    h('div', { class: 'label' }, 'Perubahan', h('span', { class: 'count' }, st.files.length)),
    st.files.length
      ? h('div', { class: 'files' }, ...st.files.map((f) => h('div', { class: 'f' }, h('span', { class: 'st ' + stCls(f.st) }, stTxt(f.st)), h('span', { class: 'p' }, '‎' + f.path))))
      : h('div', { class: 'dim small' }, 'Tidak ada perubahan yang belum di-commit.'),
    st.files.length ? h('div', { style: 'margin-top:10px' }, act([ic('diff'), 'Lihat diff'], showDiff)) : null,
    st.files.length
      ? h('div', {}, h('div', { class: 'label' }, 'Commit'), msg, h('div', { style: 'margin-top:10px' }, act([ic('commit'), 'Commit semua'], async () => {
          if (!msg.value.trim()) throw new Error('Isi pesan commit.');
          const c = await conn.call('commit', { id: s.id, message: msg.value });
          toast('Commit ' + c);
          haptic(15);
          showGit();
        })))
      : null,
    h('div', { class: 'label' }, 'Kirim ke GitHub'),
    act([ic('push'), `Push ke origin/${st.branch}`], async () => {
      if (!confirm(`Push branch ${st.branch} ke GitHub?`)) return;
      await conn.call('push', { id: s.id });
      toast('Push berhasil');
      haptic(20);
      showGit();
    }, 'btn primary'),
    h('div', { style: 'height:10px' }),
    act([ic('pr'), 'Buat Pull Request'], () => showPR(st)),
    err,
    st.log.length ? h('div', {}, h('div', { class: 'label' }, 'Commit terakhir'), h('div', { class: 'log' }, ...st.log.map((l) => h('div', {}, h('span', { class: 'h' }, l.slice(0, 7)), l.slice(8))))) : null,
  );
}

function showPR(st) {
  const s = current.session;
  const title = h('input', { class: 'field', value: s.title || '', placeholder: 'Judul PR', autocapitalize: 'sentences' });
  const desc = h('textarea', { class: 'field', rows: 5, placeholder: 'Deskripsi (opsional)', autocapitalize: 'sentences' });
  const err = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn primary' }, ic('pr'), 'Buat PR');
  btn.onclick = async () => {
    const done = busyButton(btn, 'Membuat PR…');
    try {
      const pr = await conn.call('pr', { id: s.id, title: title.value || st.branch, body: desc.value });
      haptic(20);
      ui.sheet(ui.head('PR dibuat', { sub: `#${pr.number}` }), h('div', { class: 'empty' }, h('div', { class: 'big', style: 'color:var(--green)' }, '✓'), h('b', {}, `Pull Request #${pr.number}`)), h('a', { class: 'btn primary', href: pr.url, target: '_blank', rel: 'noopener' }, ic('github'), 'Buka di GitHub'));
    } catch (e) {
      done();
      err.textContent = e.message + (/No commits|not all refs/.test(e.message) ? ' — push dulu.' : '');
    }
  };
  ui.sheet(ui.head('Pull Request', { sub: `${st.branch} → ${s.base}`, back: showGit }), title, h('div', { style: 'height:10px' }), desc, err, h('div', { class: 'sheetfoot' }, btn));
}

async function showDiff() {
  const box = h('div', {}, loading('Memuat diff…'));
  ui.sheet(ui.head('Diff', { sub: current.session.repo, back: showGit }), box);
  const { diff, truncated } = await conn.call('diff', { id: current.session.id });
  const files = [];
  let cur = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) {
      cur = { path: l.replace(/^diff --git a\/(.+?) b\/.*$/, '$1'), lines: [], add: 0, del: 0 };
      files.push(cur);
    } else if (!cur || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) continue;
    else {
      cur.lines.push(l);
      if (l.startsWith('+')) cur.add++;
      else if (l.startsWith('-')) cur.del++;
    }
  }
  if (!files.length) return box.replaceChildren(h('div', { class: 'empty' }, 'Tidak ada perubahan.'));
  box.replaceChildren(
    h('div', { class: 'dim small' }, `${files.length} file · `, h('span', { class: 'dstat' }, h('span', { class: 'a' }, '+' + files.reduce((a, f) => a + f.add, 0)), ' ', h('span', { class: 'd' }, '−' + files.reduce((a, f) => a + f.del, 0)))),
    ...files.map((f, i) => {
      const el = h('div', { class: 'difffile' + (i > 4 ? ' collapsed' : '') });
      const head = h('button', { class: 'dfh' }, h('span', { class: 'p' }, f.path), h('span', { class: 'dstat' }, h('span', { class: 'a' }, '+' + f.add), ' ', h('span', { class: 'd' }, '−' + f.del)), ic('down'));
      head.onclick = () => el.classList.toggle('collapsed');
      el.append(head, h('div', { class: 'dfb' }, ...diffLines(f.lines)));
      return el;
    }),
    truncated ? h('div', { class: 'dim small' }, '… diff dipotong (terlalu besar)') : '',
  );
}

function diffLines(lines) {
  return lines.map((l) => {
    if (l.startsWith('@@')) return h('span', { class: 'hunk' }, l);
    if (l.startsWith('+')) return h('span', { class: 'add' }, l);
    if (l.startsWith('-')) return h('span', { class: 'del' }, l);
    return h('span', { class: 'ctx' }, l || ' ');
  });
}

// ---------- Renderer event agen ----------
const TOOL_KIND = { Bash: ['bash', '$'], dev_start: ['bash', '▶'], dev_stop: ['bash', '■'], dev_logs: ['read', '≡'], dev_list: ['read', '≡'], preview_screenshot: ['web', '◐'], Read: ['read', '◱'], NotebookRead: ['read', '◱'], Edit: ['edit', '✎'], MultiEdit: ['edit', '✎'], NotebookEdit: ['edit', '✎'], Write: ['write', '+'], Grep: ['search', '⌕'], Glob: ['search', '⌕'], LS: ['search', '⌕'], WebFetch: ['web', '⊕'], WebSearch: ['web', '⊕'], Task: ['agent', '◈'], Agent: ['agent', '◈'], AskUserQuestion: ['agent', '?'], ExitPlanMode: ['agent', '☰'] };
const ACTIVITY = { Bash: 'menjalankan', dev_start: 'menyalakan', dev_logs: 'membaca log', preview_screenshot: 'melihat halaman', Read: 'membaca', Edit: 'mengedit', MultiEdit: 'mengedit', Write: 'menulis', Grep: 'mencari', Glob: 'mencari', WebFetch: 'membuka', WebSearch: 'mencari web', Task: 'subagen', Agent: 'subagen', AskUserQuestion: 'bertanya', ExitPlanMode: 'menyusun rencana' };

const DOM_MAX = 2500;
const DOM_TRIM = 500;

class Renderer {
  constructor(term, col, dock) {
    this.term = term;
    this.el = col;
    this.dock = dock;
    this.tools = new Map();
    this.users = new Map(); // seq prompt -> tombol rewind
    this.permQueue = [];
    this.textEl = null;
    this.textSrc = '';
    this.outEl = null;
    this.lastTodo = null;
    this.stick = true;
    this.unread = 0;
    this.activity = '';
    this.quiet = false;
    this.onUnread = () => {};
    term.addEventListener('scroll', () => {
      const near = term.scrollHeight - term.scrollTop - term.clientHeight < 90;
      if (near !== this.stick || (near && this.unread)) {
        this.stick = near;
        if (near) this.unread = 0;
        this.onUnread(this.unread);
      }
    }, { passive: true });
    // Tombol salin pada blok kode.
    term.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-copy]');
      if (!b) return;
      const code = b.closest('.code')?.querySelector('code')?.textContent || '';
      if (await copyText(code)) {
        b.classList.add('done');
        b.lastChild.textContent = 'tersalin';
        haptic(10);
        setTimeout(() => (b.classList.remove('done'), (b.lastChild.textContent = 'salin')), 1500);
      }
    });
  }
  batch(fn) {
    this.quiet = true;
    try {
      fn();
    } finally {
      this.quiet = false;
    }
  }
  keepBottom() {
    if (this.stick) this.term.scrollTop = this.term.scrollHeight;
  }
  scroll(force) {
    if (force) {
      this.stick = true;
      this.unread = 0;
      this.onUnread(0);
    }
    if (this.stick) requestAnimationFrame(() => (this.term.scrollTop = this.term.scrollHeight));
  }
  append(node, animate = true) {
    if (animate && !this.quiet) node.classList.add('ev');
    this.el.append(node);
    // Sesi sangat panjang: buang node terlama agar HP tetap ringan (hanya saat pengguna di bawah,
    // supaya posisi baca tidak melompat).
    if (this.el.childElementCount > DOM_MAX && this.stick && !this.quiet) {
      for (let i = 0; i < DOM_TRIM; i++) this.el.firstElementChild?.remove();
      this.el.prepend(h('div', { class: 'meta' }, '… riwayat lama disembunyikan (buka ulang sesi untuk melihat lebih banyak)'));
    }
    if (!this.stick && !this.quiet) {
      this.unread++;
      this.onUnread(this.unread);
    }
    this.scroll();
    return node;
  }
  line(cls, text) {
    this.textEl = null;
    this.outEl = null;
    return this.append(h('div', { class: 'ln ' + cls }, text));
  }
  welcome(s) {
    this.append(
      h('div', { class: 'welcome' },
        h('b', {}, s.repo), ` · branch `, h('b', {}, s.branch),
        h('div', { class: 'tips' },
          h('div', {}, '❯  tulis permintaan, misal "jelaskan repo ini"'),
          h('div', {}, '$  ketuk tombol mode untuk perintah shell langsung'),
          h('div', {}, '✦  aksi cepat · ◆ model & effort · git di chip bawah'),
        ),
      ),
    );
  }
  add(e, replay = false) {
    switch (e.k) {
      case 'user': {
        this.textEl = null;
        this.outEl = null;
        this.activity = 'berpikir…';
        const undo = h('button', { class: 'rw', 'aria-label': 'Kembalikan file ke sebelum prompt ini', hidden: true, onclick: () => rewindTo(e) }, ic('undo'));
        this.users.set(e.seq, undo);
        return this.append(h('div', { class: 'ln u' }, h('span', { class: 'pr' }, '❯'), h('span', { class: 'grow' }, e.d, e.img ? h('span', { class: 'tag', style: 'margin-left:8px' }, ic('image'), e.img) : null), undo));
      }
      case 'cp': {
        // Checkpoint tersedia: tampilkan tombol rewind pada prompt terkait.
        const b = this.users.get(e.of);
        if (b) b.hidden = false;
        return;
      }
      case 'shot':
        this.textEl = null;
        return this.append(h('figure', { class: 'shotmsg' }, h('img', { src: `data:${e.mime};base64,${e.data}`, alt: 'screenshot', loading: 'lazy', onclick: (ev) => ev.currentTarget.classList.toggle('big') }), h('figcaption', {}, e.url)));
      case 'text':
        if (!this.textEl) {
          this.textSrc = '';
          this.textDone = 0;
          this.textEl = this.append(h('div', { class: 'ln txt' }, h('div'), h('div')));
        }
        this.textSrc += e.d;
        this.activity = 'menulis…';
        if (!this.mdPending) {
          this.mdPending = true;
          const el = this.textEl;
          const flush = () => {
            this.mdPending = false;
            if (el === this.textEl) this.renderText();
            this.scroll();
          };
          this.quiet ? flush() : requestAnimationFrame(flush);
        }
        return;
      case 'thinking':
        this.activity = `berpikir… (${e.words} kata)`;
        return;
      case 'toolStart':
        this.activity = `menyiapkan ${e.name}…`;
        return;
      case 'tool':
        return e.name === 'TodoWrite' ? this.todo(e) : this.tool(e);
      case 'result':
        return this.result(e);
      case 'perm':
        return this.perm(e);
      case 'permAnswer':
        return this.permAnswer(e);
      case 'retry':
        return this.line('note', `↻ 9router error ${e.status ?? ''} — mencoba lagi (${e.attempt}/${e.max})…`);
      case 'done': {
        this.activity = '';
        const extra = `${e.usage ? ` · ${fmtTok(e.usage.in)}→${fmtTok(e.usage.out)} tok` : ''}${e.ctx != null ? ` · konteks ${e.ctx}%` : ''}${e.cost ? ` · $${e.cost.toFixed(e.cost < 1 ? 3 : 2)}` : ''}`;
        const txt = e.ok ? `selesai · ${e.turns} langkah · ${(e.ms / 1000).toFixed(1)}s${extra}` : `berhenti · ${e.err || 'error'}`;
        if (e.ctx >= 80 && !this.quiet) toast(`Konteks ${e.ctx}% penuh — kirim /compact agar agen tetap fokus`, false, 6000);
        this.textEl = null;
        return this.append(h('div', { class: 'donel' + (e.ok ? '' : ' bad') }, (e.ok ? '✓ ' : '✗ ') + txt));
      }
      case 'sh':
        this.activity = '$ ' + e.d;
        this.textEl = null;
        this.append(h('div', { class: 'ln u shell' }, h('span', { class: 'pr' }, '$'), e.d));
        this.outEl = null;
        return;
      case 'out':
        if (!this.outEl) this.outEl = this.append(h('pre', { class: 'shout' }));
        this.outEl.append(e.d);
        this.outEl.scrollTop = this.outEl.scrollHeight;
        return this.scroll();
      case 'shDone':
        this.outEl = null;
        return this.append(h('div', { class: 'meta', style: 'margin-bottom:8px' }, e.code === 0 ? '✓ exit 0' : `✗ exit ${e.code}`));
      case 'note':
        return this.append(h('div', { class: 'note' }, h('span', {}, '◆'), h('span', {}, e.d)));
      case 'error':
        return this.line('e', '✗ ' + e.d);
    }
  }
  // Markdown dirender bertahap: blok yang sudah selesai (dipisah baris kosong di luar blok kode)
  // dibekukan, hanya blok terakhir yang dirender ulang per frame. Dulu seluruh teks dirender
  // ulang setiap delta (O(n²) untuk jawaban panjang dan saat memutar ulang riwayat).
  renderText() {
    const src = this.textSrc;
    const [done, tail] = this.textEl.children;
    const cut = stableCut(src, this.textDone);
    if (cut > this.textDone) {
      done.insertAdjacentHTML('beforeend', md(src.slice(this.textDone, cut)));
      this.textDone = cut;
    }
    tail.innerHTML = md(src.slice(this.textDone));
  }
  tool(e) {
    this.textEl = null;
    this.outEl = null;
    const [kind, glyph] = TOOL_KIND[e.name] || ['other', '•'];
    const first = String(e.s || '').split('\n')[0];
    this.activity = `${ACTIVITY[e.name] || e.name} ${first}`.trim().slice(0, 80);
    const stat = h('span', { class: 'tstat' }, h('span', { class: 'spinner', style: 'width:14px;height:14px' }));
    const body = h('div', { class: 'tb' });
    const el = h('div', { class: `tool t-${kind}` },
      h('button', { class: 'th', 'aria-expanded': 'false' }, h('span', { class: 'ti' }, glyph), h('span', { class: 'tn' }, e.name), h('span', { class: 'ts' }, first), stat),
      body,
    );
    el.firstChild.onclick = () => {
      el.classList.toggle('open');
      el.firstChild.setAttribute('aria-expanded', el.classList.contains('open'));
      if (el.classList.contains('open') && !body.childNodes.length) body.append(h('pre', { class: 'tout' }, e.s || '(tanpa detail)'));
    };
    let add = 0;
    let del = 0;
    if (e.x) {
      const d = miniDiff(e.x);
      ({ add, del } = d);
      body.append(h('pre', { class: 'tout', style: 'max-height:none;padding-bottom:0' }, e.s || ''), d.el);
    }
    this.tools.set(e.id, { el, stat, body, name: e.name, add, del });
    this.append(el);
  }
  result(e) {
    const t = this.tools.get(e.id);
    if (!t) return;
    this.activity = 'berpikir…';
    if (t.todo) return;
    const out = String(e.d || '').trim();
    const n = out ? out.split('\n').length : 0;
    t.stat.replaceChildren(
      t.add || t.del ? h('span', { class: 'dstat' }, h('span', { class: 'a' }, '+' + t.add), ' ', h('span', { class: 'd' }, '−' + t.del)) : n > 1 ? `${n} baris` : '',
      ic(e.ok ? 'check' : 'x', e.ok ? 'ok-i' : 'bad-i'),
      ic('down', 'chev'),
    );
    if (!e.ok) t.el.classList.add('fail');
    if (!t.add && !t.del) {
      t.body.replaceChildren(h('pre', { class: 'tout' + (e.ok ? '' : ' fail') }, out || '(tanpa output)'));
    } else if (!e.ok) t.body.append(h('pre', { class: 'tout fail' }, out));
    if (!e.ok && !this.quiet) t.el.classList.add('open');
  }
  todo(e) {
    this.textEl = null;
    this.outEl = null;
    const items = String(e.s || '').split('\n').filter(Boolean).map((l) => ({ st: l[0] === '☑' ? 'done' : l[0] === '◐' ? 'doing' : 'todo', t: l.slice(2) }));
    const done = items.filter((i) => i.st === 'done').length;
    const doing = items.find((i) => i.st === 'doing');
    if (doing) this.activity = '◐ ' + doing.t;
    this.lastTodo?.classList.add('stale');
    const card = h('div', { class: 'todo' },
      h('div', { class: 'tt' }, h('span', {}, 'Rencana'), h('span', { class: 'bar' }, h('i', { style: `width:${items.length ? (done / items.length) * 100 : 0}%` })), h('span', {}, `${done}/${items.length}`)),
      ...items.map((i) => h('div', { class: 'it ' + i.st }, h('span', { class: 'ck' }, i.st === 'done' ? '✓' : i.st === 'doing' ? '◐' : '○'), h('span', {}, i.t))),
    );
    this.lastTodo = card;
    this.tools.set(e.id, { todo: true });
    this.append(card);
  }
  // Permintaan izin ditampilkan di dok di atas composer (tidak perlu scroll).
  perm(e) {
    if (this.permQueue.some((p) => p.pid === e.pid)) return;
    this.permQueue.push(e);
    this.renderDock();
    if (!this.quiet) {
      haptic([40, 60, 40]);
      localNotify('pocketcode — butuh izin', `${e.tool}: ${String(e.s || '').slice(0, 120)}`);
    }
  }
  permAnswer(e) {
    this.permQueue = this.permQueue.filter((p) => p.pid !== e.pid);
    this.renderDock();
    this.append(h('div', { class: 'meta', style: 'margin:6px 0' }, `${e.allow ? '✓ diizinkan' : '✗ ditolak'} · ${e.tool}${e.s ? ' · ' + String(e.s).split('\n')[0].slice(0, 70) : ''}`));
  }
  renderDock() {
    const e = this.permQueue[0];
    if (!e) return this.dock.replaceChildren();
    const buttons = h('div', { class: 'btnrow' });
    const answer = async (decision, extra = {}) => {
      this.dock.querySelectorAll('button').forEach((b) => (b.disabled = true));
      haptic(12);
      try {
        await conn.call('perm', { id: current.session.id, pid: e.pid, decision, ...extra });
      } catch (x) {
        toast(x.message, true);
        this.dock.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    };
    const more = this.permQueue.length > 1 ? h('div', { class: 'more' }, `+${this.permQueue.length - 1} permintaan lagi`) : null;
    if (e.ask) return this.dock.replaceChildren(askPanel(e, answer, more));
    if (e.plan) return this.dock.replaceChildren(planPanel(e, answer, more));
    buttons.append(
      h('button', { class: 'btn danger', onclick: () => answer('deny') }, 'Tolak'),
      e.push ? null : h('button', { class: 'btn', onclick: () => answer('always') }, 'Selalu'),
      h('button', { class: 'btn primary', onclick: () => answer('allow') }, 'Izinkan'),
    );
    this.dock.replaceChildren(
      h('div', { class: 'perm' + (e.push ? ' push' : '') },
        h('div', { class: 'q' }, ic('alert'), e.push ? 'Agen ingin PUSH ke GitHub' : `Izinkan ${e.tool}?`),
        e.title ? h('div', { class: 'pt' }, e.title) : null,
        h('pre', {}, e.summary || e.s || ''),
        e.x ? miniDiff(e.x).el : null,
        buttons,
        more,
      ),
    );
    requestAnimationFrame(() => this.keepBottom());
  }
}

// Pertanyaan pilihan dari agen (AskUserQuestion): 1–4 pertanyaan, opsi tap + jawaban bebas.
function askPanel(e, answer, more) {
  const picks = e.ask.map(() => new Set());
  const others = e.ask.map(() => h('input', { class: 'field', placeholder: 'Jawaban lain (opsional)', autocapitalize: 'sentences' }));
  const ok = h('button', { class: 'btn primary' }, 'Kirim jawaban');
  const sync = () => (ok.disabled = !e.ask.every((_, i) => picks[i].size || others[i].value.trim()));
  const qs = e.ask.map((q, i) =>
    h('div', { class: 'askq' },
      h('div', { class: 'qt' }, q.header ? h('span', { class: 'tag' }, q.header) : null, q.question),
      h('div', { class: 'opts' }, ...q.options.map((o) => {
        const b = h('button', { class: 'opt' }, h('b', {}, o.label), o.description ? h('span', {}, o.description) : null);
        b.onclick = () => {
          haptic(8);
          if (!q.multiSelect) picks[i].clear(), b.parentNode.querySelectorAll('.opt').forEach((x) => x.classList.remove('on'));
          picks[i].has(o.label) ? picks[i].delete(o.label) : picks[i].add(o.label);
          b.classList.toggle('on', picks[i].has(o.label));
          sync();
        };
        return b;
      })),
      others[i],
    ),
  );
  others.forEach((o) => (o.oninput = sync));
  sync();
  ok.onclick = () => answer('allow', { answers: Object.fromEntries(e.ask.map((q, i) => [q.question, [...picks[i], others[i].value.trim()].filter(Boolean).join(', ')])) });
  return h('div', { class: 'perm ask' },
    h('div', { class: 'q' }, ic('spark'), 'Agen bertanya'),
    ...qs,
    h('div', { class: 'btnrow' }, h('button', { class: 'btn danger', onclick: () => answer('deny', { message: 'Pengguna melewati pertanyaan; putuskan sendiri dengan pilihan paling masuk akal.' }) }, 'Lewati'), ok),
    more,
  );
}

// Rencana dari mode rencana (ExitPlanMode): setujui lalu agen mulai mengerjakan, atau minta revisi.
function planPanel(e, answer, more) {
  const note = h('textarea', { class: 'field', rows: 2, placeholder: 'Catatan revisi (opsional)', autocapitalize: 'sentences' });
  return h('div', { class: 'perm ask' },
    h('div', { class: 'q' }, ic('list'), 'Rencana siap — setujui?'),
    h('div', { class: 'plan txt', html: md(String(e.summary || e.s || '')) }),
    note,
    h('div', { class: 'btnrow' },
      h('button', { class: 'btn', onclick: () => answer('deny', { message: note.value.trim() ? 'Revisi rencananya: ' + note.value.trim() : 'Pengguna ingin merevisi rencana. Berhenti sekarang dan tunggu arahan revisinya.' }) }, 'Revisi'),
      h('button', { class: 'btn primary', onclick: () => answer('allow') }, 'Setujui & kerjakan'),
    ),
    more,
  );
}

async function rewindTo(e) {
  const label = String(e.d || 'gambar').slice(0, 60);
  if (!confirm(`Kembalikan SEMUA file worktree ke kondisi sebelum prompt:\n\n"${label}"\n\nPerubahan setelahnya (oleh agen maupun manual) akan hilang.`)) return;
  try {
    const n = await conn.call('rewind', { id: current.session.id, seq: e.seq });
    haptic(20);
    toast(n ? `${n} file dikembalikan` : 'Tidak ada file yang berubah');
    current.refreshGit?.();
  } catch (x) {
    toast(x.message, true);
  }
}
// Cuplikan perubahan Edit/MultiEdit/Write ({ old?, new? } atau { edits: [...] }).
function miniDiff(x) {
  const el = h('div', { class: 'diffmini' });
  let add = 0;
  let del = 0;
  for (const ed of x.edits || [x]) {
    if (ed.old) for (const l of ed.old.split('\n')) (del++, el.append(h('span', { class: 'del' }, '- ' + l)));
    if (ed.new) for (const l of ed.new.split('\n')) (add++, el.append(h('span', { class: 'add' }, '+ ' + l)));
  }
  return { el, add, del };
}
const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));

// ---------- start ----------
function boot() {
  const m = location.hash.match(/login=([^&]+)/);
  if (m) store.set('token', decodeURIComponent(m[1]));
  // Dibuka dari notifikasi push: #open=<mid>:<sid>
  const o = location.hash.match(/open=([\w-]+)(?::([\w-]+))?/);
  if (o) store.set('last', { mid: o[1], sid: o[2] });
  if (m || o) history.replaceState(null, '', location.pathname);
  if (!token()) return showLogin();
  showMachines({ resume: true }).catch((e) => toast(e.message, true));
}
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Notifikasi diketuk saat aplikasi masih hidup di latar belakang.
  navigator.serviceWorker.addEventListener('message', async (ev) => {
    const o = ev.data?.open;
    if (!o?.mid) return;
    if (current?.m.id !== o.mid || !current.ready) {
      store.set('last', { mid: o.mid, sid: o.sid });
      return showMachines({ resume: true });
    }
    const s = o.sid && (await conn.call('sessions').catch(() => [])).find((x) => x.id === o.sid);
    if (s && current.session?.id !== s.id) showSession(s);
  });
}
document.addEventListener('visibilitychange', () => {
  const on = document.visibilityState === 'visible';
  // Saat aplikasi dibuka lagi, sambung ulang segera bila koneksi putus.
  if (on && conn && conn.ws?.readyState > 1 && !conn.closedByUser) conn.connect();
  // PC mengirim Web Push hanya saat aplikasi tidak sedang dilihat.
  if (conn?.channel) conn.call('visible', { on }).catch(() => {});
});
boot();
