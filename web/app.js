// snugcode PWA — UI terminal untuk mengendalikan agen di PC dari HP.
// Titik masuk: boot, service worker, dan sambung ulang saat aplikasi kembali terlihat.
// Layar-layar ada di web/ui/*.js; state bersama di web/ui/state.js.
import { store, token } from './conn.js';
import { app } from './ui/state.js';
import { showLogin, showMachines } from './ui/auth.js';
import { applyTheme, toast, ui } from './ui/dom.js';
import { showSession } from './ui/session.js';

// ---------- pindah alamat ----------
// Alamat lama (pocketcode-relay…) tetap melayani PC & API, tapi PWA-nya menawarkan pindah ke alamat
// utama. Isi localStorage (login, pairing PC, tema) dibawa lewat fragmen URL — tidak pernah dikirim ke
// server — jadi di alamat baru tidak perlu login & PIN lagi. Kunci push (vapid) tidak dibawa: langganan
// push terikat ke alamat, jadi notifikasi diizinkan ulang di sana.
const pack = (obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))));
const unpack = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));
function importMoved() {
  const m = location.hash.match(/import=([^&]+)/);
  if (!m) return false;
  // Hanya untuk alamat yang belum dipakai: link buatan orang lain tidak bisa menimpa login yang ada.
  if (!token())
    try {
      for (const [k, v] of Object.entries(unpack(decodeURIComponent(m[1])))) if (k.startsWith('pc.') && k !== 'pc.vapid' && typeof v === 'string') localStorage.setItem(k, v);
    } catch {}
  history.replaceState(null, '', location.pathname);
  return true;
}
async function offerMove() {
  const h = await fetch('/api/health').then((r) => r.json()).catch(() => null);
  if (!h?.legacy || !h.publicUrl) return;
  const host = new URL(h.publicUrl).host;
  if (!(await ui.confirm({ title: 'snugcode pindah alamat', text: `Alamat baru: ${host}. Login, pairing PC, dan tema ikut dipindahkan — tanpa login atau PIN lagi. Setelah itu tambahkan ke layar utama dari alamat baru, lalu hapus aplikasi yang lama.`, ok: 'Pindah sekarang', icon: 'globe' }))) return;
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('pc.') && k !== 'pc.vapid') data[k] = localStorage.getItem(k);
  }
  location.href = h.publicUrl + '/#import=' + encodeURIComponent(pack(data));
}

// ---------- start ----------
function boot() {
  importMoved(); // sebelum tema & token dibaca: datanya bisa datang dari alamat lama
  applyTheme();
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
  // Versi baru aktif (service worker baru mengambil alih): muat ulang agar tampilan baru langsung
  // dipakai. Bila pengguna sedang mengetik, tawarkan lewat toast agar draf tidak hilang.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  const reload = () => !reloading && ((reloading = true), location.reload());
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    const typing = [...document.querySelectorAll('textarea, input:not([type=file])')].some((el) => /** @type {HTMLInputElement} */ (el).value.trim());
    if (!typing) return reload();
    const t = toast('Versi baru snugcode siap — ketuk untuk memuat ulang', false, 15000);
    t.addEventListener('click', reload);
  });
  // Notifikasi diketuk saat aplikasi masih hidup di latar belakang.
  navigator.serviceWorker.addEventListener('message', async (ev) => {
    const o = ev.data?.open;
    if (!o?.mid) return;
    if (app.current?.m.id !== o.mid || !app.current.ready) {
      store.set('last', { mid: o.mid, sid: o.sid });
      return showMachines({ resume: true });
    }
    const s = o.sid && (await app.conn.call('sessions').catch(() => [])).find((x) => x.id === o.sid);
    if (s && app.current.session?.id !== s.id) showSession(s);
  });
}
document.addEventListener('visibilitychange', () => {
  const on = document.visibilityState === 'visible';
  // PWA yang dilanjutkan dari latar belakang tidak memuat ulang halaman: cek pembaruan di sini.
  if (on) navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  // Saat aplikasi dibuka lagi, sambung ulang segera bila koneksi putus.
  if (on && app.conn && app.conn.ws?.readyState > 1 && !app.conn.closedByUser) app.conn.connect();
  // PC mengirim Web Push hanya saat aplikasi tidak sedang dilihat.
  if (app.conn?.channel) app.conn.call('visible', { on }).catch(() => {});
});
boot();
setTimeout(offerMove, 1200);
