// pocketcode PWA — UI terminal untuk mengendalikan agen di PC dari HP.
// Titik masuk: boot, service worker, dan sambung ulang saat aplikasi kembali terlihat.
// Layar-layar ada di web/ui/*.js; state bersama di web/ui/state.js.
import { store, token } from './conn.js';
import { app } from './ui/state.js';
import { showLogin, showMachines } from './ui/auth.js';
import { applyTheme, toast } from './ui/dom.js';
import { showSession } from './ui/session.js';

// ---------- start ----------
function boot() {
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
  // Saat aplikasi dibuka lagi, sambung ulang segera bila koneksi putus.
  if (on && app.conn && app.conn.ws?.readyState > 1 && !app.conn.closedByUser) app.conn.connect();
  // PC mengirim Web Push hanya saat aplikasi tidak sedang dilihat.
  if (app.conn?.channel) app.conn.call('visible', { on }).catch(() => {});
});
boot();
