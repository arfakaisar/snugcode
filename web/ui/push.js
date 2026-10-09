// Notifikasi lokal & Web Push (kunci VAPID dibuat di HP, dikirim ke PC lewat E2EE).
import { store } from '../conn.js';
import { app } from './state.js';
import { showLogin } from './auth.js';
import { applyTheme, h, haptic, ic, menuItem, toast, ui } from './dom.js';

// ---------- Notifikasi & Web Push ----------
// Kunci VAPID dibuat di HP lalu dibagikan ke tiap PC lewat kanal E2EE: satu langganan push
// per HP bisa dipakai semua PC-nya, dan layanan push tidak bisa membaca isi notifikasi.
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const pushOn = () => !!store.get('vapid') && window.Notification?.permission === 'granted';

// Notifikasi dari halaman sendiri hanya dipakai bila Web Push belum aktif (agar tidak dobel).
export function localNotify(title, body) {
  if (document.visibilityState !== 'visible' && !pushOn() && window.Notification?.permission === 'granted') new Notification(title, { body });
}

export async function pushSubscription(create) {
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

export async function syncPush(create) {
  const p = await pushSubscription(create).catch(() => null);
  if (p && app.conn?.channel) await app.conn.call('pushSub', p).catch(() => {});
  return p;
}

export async function enableNotifications() {
  if (!window.Notification) return toast('Browser ini tidak mendukung notifikasi', true);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notifikasi: ' + perm, true);
  const p = await syncPush(true);
  if (p) toast('Notifikasi aktif — tetap muncul walau aplikasi ditutup');
  else toast(/iPhone|iPad/.test(navigator.userAgent) ? 'Tambahkan ke Home Screen dulu agar notifikasi tetap jalan saat aplikasi ditutup' : 'Notifikasi aktif saat aplikasi terbuka', false, 5000);
}

// Pemilih tema (Sistem / Terang / Gelap) berbentuk segmented control dengan penanda yang bergeser.
export function themePicker() {
  const opts = [['system', 'auto', 'Sistem'], ['light', 'sun', 'Terang'], ['dark', 'moon', 'Gelap']];
  const cur = () => store.get('theme') || 'system';
  const seg = h('div', { class: 'seg slide', style: `--n:${opts.length}` });
  const sync = () => {
    const i = opts.findIndex(([k]) => k === cur());
    seg.style.setProperty('--at', String(i));
    [...seg.querySelectorAll('button')].forEach((b, j) => b.classList.toggle('on', j === i));
  };
  seg.append(h('i', { class: 'knob' }), ...opts.map(([k, icon, label]) => h('button', { onclick: () => (haptic(8), store.set('theme', k), applyTheme(k), sync()) }, ic(icon), label)));
  sync();
  return seg;
}

export function accountMenu() {
  const login = app.me?.login;
  ui.sheet(
    ui.head('Akun & tampilan'),
    login ? h('div', { class: 'profile' }, h('span', { class: 'meav big' }, login[0].toUpperCase()), h('div', {}, h('b', {}, '@' + login), h('div', { class: 'dim small' }, 'login lewat GitHub'))) : null,
    h('div', { class: 'label' }, 'Tema'),
    themePicker(),
    h('div', { class: 'label' }, 'Perangkat ini'),
    h('div', { class: 'group' },
      menuItem({ icon: 'bell', t1: 'Izinkan notifikasi', t2: 'Kabar saat agen selesai / butuh izin', onclick: enableNotifications }),
      menuItem({ icon: 'logout', t1: 'Keluar', danger: true, chev: false, onclick: () => (store.set('token', null), (app.me = null), ui.closeSheet(), showLogin()) }),
    ),
  );
}
