// snugcode agent PWA — control the agent on your PC from your phone.
// Entry point: boot, service worker, and reconnect when the app becomes visible again.
// Screens live in web/ui/*.js; shared state in web/ui/state.js.
import { store, token } from './conn.js';
import { app } from './ui/state.js';
import { renewToken, showLogin, showMachines } from './ui/auth.js';
import { applyTheme, toast, ui } from './ui/dom.js';
import { showSession } from './ui/session.js';
import { acceptGhToken } from './ui/cloud.js';

// ---------- address move ----------
// The old address (pocketcode-relay…) still serves PCs & the API, but its PWA offers to move to the main
// address. localStorage (login, PC pairing, theme) travels in the URL fragment — never sent to the
// server — so no new sign-in or PIN is needed. Push keys (vapid) don't travel: push subscriptions are
// tied to the address, so notifications are allowed again there.
const pack = (obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))));
const unpack = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));
function importMoved() {
  const m = location.hash.match(/import=([^&]+)/);
  if (!m) return false;
  // Only for an unused address: a link made by someone else can't overwrite an existing login.
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
  if (!(await ui.confirm({ title: 'snugcode has moved', text: `New address: ${host}. Your login, PC pairing, and theme come along — no sign-in or PIN needed. Then add it to your home screen from the new address and delete the old app.`, ok: 'Move now', icon: 'globe' }))) return;
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('pc.') && k !== 'pc.vapid') data[k] = localStorage.getItem(k);
  }
  location.href = h.publicUrl + '/agent/#import=' + encodeURIComponent(pack(data));
}

// ---------- start ----------
function boot() {
  importMoved(); // before theme & token are read: the data may come from the old address
  applyTheme();
  const m = location.hash.match(/login=([^&]+)/);
  if (m) store.set('token', decodeURIComponent(m[1]));
  // Back from the GitHub Codespaces grant (cloud runner): #gh=<token>&ghlogin=<login>
  const g = acceptGhToken(location.hash);
  // Opened from a push notification: #open=<mid>:<sid>
  const o = location.hash.match(/open=([\w-]+)(?::([\w-]+))?/);
  if (o) store.set('last', { mid: o[1], sid: o[2] });
  // Allow/Deny notification buttons: answered once that permission card shows up again after connecting.
  const pm = location.hash.match(/perm=([0-9a-f]{6,32}):(allow|deny)/);
  if (o && pm) app.permFromPush = { pid: pm[1], decision: pm[2] === 'allow' ? 'allow' : 'deny' };
  if (m || o || g) history.replaceState(null, '', location.pathname);
  if (!token()) return showLogin();
  renewToken();
  showMachines({ resume: true }).catch((e) => toast(e.message, true));
}
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // Service worker at the root (see web/sw.js), not under /agent/.
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // New version active (a new service worker took over): reload so the new UI is used right away.
  // If the user is typing, offer it via a toast so the draft isn't lost.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  const reload = () => !reloading && ((reloading = true), location.reload());
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    const typing = [...document.querySelectorAll('textarea, input:not([type=file])')].some((el) => /** @type {HTMLInputElement} */ (el).value.trim());
    if (!typing) return reload();
    const t = toast('A new version of snugcode is ready — tap to reload', false, 15000);
    t.addEventListener('click', reload);
  });
  // Notification tapped while the app is still alive in the background.
  navigator.serviceWorker.addEventListener('message', async (ev) => {
    const o = ev.data?.open;
    if (!o?.mid) return;
    if (ev.data.perm?.pid) app.permFromPush = { pid: String(ev.data.perm.pid), decision: ev.data.perm.decision === 'allow' ? 'allow' : 'deny' };
    // The permission card is already showing (app open in that session): answer now.
    if (app.permFromPush && app.current?.renderer?.permQueue.some((p) => p.pid === app.permFromPush.pid)) app.current.renderer.answerFromPush();
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
  // A PWA resumed from the background doesn't reload the page: check for updates here.
  if (on) navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  // When the app is reopened: reconnect if dropped, or probe a socket that looks open (may be half-dead).
  if (on) app.conn?.wake();
  // The PC sends Web Push only while the app isn't being viewed.
  if (app.conn?.channel) app.conn.call('visible', { on }).catch(() => {});
});
// Network is back (Wi-Fi ↔ cellular switch): don't wait for the next heartbeat.
window.addEventListener('online', () => app.conn?.wake());
boot();
setTimeout(offerMove, 1200);
