// Local notifications & Web Push (VAPID key made on the phone, sent to the PC over E2EE).
import { store } from '../conn.js';
import { app } from './state.js';
import { api, showLogin } from './auth.js';
import { TEXT_SCALES, applyTextScale, applyTheme, h, haptic, ic, menuItem, toast, ui } from './dom.js';

// ---------- Notifications & Web Push ----------
// The VAPID key is made on the phone and shared with each PC over the E2EE channel: one push subscription
// per phone serves all its PCs, and the push service can't read notification content.
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const pushOn = () => !!store.get('vapid') && window.Notification?.permission === 'granted';

// In-page notifications are only used when Web Push isn't active (to avoid duplicates).
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
    await sub?.unsubscribe(); // made with another key that's gone
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
  if (p && app.conn?.channel) await app.conn.call('pushSub', { ...p, level: store.get('pushLevel') || 'all' }).catch(() => {});
  return p;
}

export async function enableNotifications() {
  if (!window.Notification) return toast('This browser doesn’t support notifications', true);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notifications: ' + perm, true);
  const p = await syncPush(true);
  if (p) toast('Notifications on — they show up even when the app is closed');
  else toast(/iPhone|iPad/.test(navigator.userAgent) ? 'Add to Home Screen first so notifications keep working when the app is closed' : 'Notifications on while the app is open', false, 5000);
}

// Theme picker (System / Light / Dark) as a segmented control with a sliding knob.
export function themePicker() {
  const opts = [['system', 'auto', 'System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']];
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

function textScalePicker() {
  const cur = Number(store.get('textScale')) || 1;
  const seg = h('div', { class: 'seg' });
  seg.append(...TEXT_SCALES.map(([z, label]) => h('button', {
    class: z === cur ? 'on' : '',
    'aria-label': label,
    title: label,
    'aria-pressed': String(z === cur),
    onclick: (e) => {
      haptic(8);
      store.set('textScale', z === 1 ? null : z);
      applyTextScale(z);
      for (const b of seg.children) b.classList.toggle('on', b === e.currentTarget), b.setAttribute('aria-pressed', String(b === e.currentTarget));
    },
  }, h('span', { style: `font: 600 ${Math.round(15 * z)}px/1 var(--serif)` }, 'A'))));
  return seg;
}

async function logoutAll() {
  if (!(await ui.confirm({ title: 'Sign out everywhere?', text: 'Every phone & browser (including this one) will need to sign in with GitHub again. Machines and PIN pairings stay as they are.', ok: 'Sign out everywhere', danger: true, icon: 'logout', stay: true }))) return;
  try {
    await api('/api/logout-all', { method: 'POST' });
  } catch (e) {
    return toast(e.message);
  }
  store.set('token', null);
  app.me = null;
  ui.closeSheet();
  showLogin();
}

// How often this phone gets pinged: every update, or only permissions, questions & completions (less
// notification fatigue). Stored per phone and sent to the connected PC (other PCs on their next connect).
function pushLevelPicker() {
  const cur = store.get('pushLevel') || 'all';
  const set = (level) => {
    store.set('pushLevel', level);
    syncPush(false);
    toast(level === 'important' ? 'Notifications: only permissions, questions & completions' : 'Notifications: every update');
    ui.closeSheet();
  };
  return h('div', { class: 'menuitem', style: 'cursor:default' },
    h('span', { class: 'mi' }, ic('bell')),
    h('span', { class: 'grow' }, h('div', { class: 't1' }, 'What to notify'),
      h('div', { class: 'seg small' }, ...[['all', 'Everything'], ['important', 'Important only']].map(([k, label]) => h('button', { class: k === cur ? 'on' : '', onclick: () => set(k) }, label)))),
  );
}

export function accountMenu() {
  const login = app.me?.login;
  ui.sheet(
    ui.head('Account & appearance'),
    login ? h('div', { class: 'profile' }, h('span', { class: 'meav big' }, login[0].toUpperCase()), h('div', {}, h('b', {}, '@' + login), h('div', { class: 'dim small' }, 'signed in with GitHub'))) : null,
    h('div', { class: 'label' }, 'Theme'),
    themePicker(),
    h('div', { class: 'label' }, 'Text size'),
    textScalePicker(),
    h('div', { class: 'label' }, 'This device'),
    h('div', { class: 'group' },
      menuItem({ icon: 'bell', t1: 'Allow notifications', t2: 'Updates when the agent finishes / needs permission', onclick: enableNotifications }),
      pushLevelPicker(),
      menuItem({ icon: 'logout', t1: 'Sign out', danger: true, chev: false, onclick: () => (store.set('token', null), (app.me = null), ui.closeSheet(), showLogin()) }),
      // Logins on other phones/browsers (e.g. a lost phone) are revoked at the relay. PC pairing is unchanged.
      menuItem({ icon: 'logout', t1: 'Sign out everywhere', t2: 'Revoke the login on every phone & browser', danger: true, chev: false, onclick: logoutAll }),
    ),
  );
}
