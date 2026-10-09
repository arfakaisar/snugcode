// API relay, layar login GitHub, dan daftar PC.
import { token, store } from '../conn.js';
import { app } from './state.js';
import { $, ago, copyText, h, haptic, ic, scrollCol, skeletons, toast, ui } from './dom.js';
import { openMachine } from './machine.js';
import { accountMenu } from './push.js';

// ---------- API relay ----------
export async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { authorization: 'Bearer ' + token(), ...(opts.headers || {}) } });
  if (r.status === 401) {
    store.set('token', null);
    showLogin();
    throw new Error('Sesi login habis');
  }
  return r.json();
}

// ---------- Layar: login ----------
export function showLogin() {
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
export const goMachines = () => {
  clearInterval(app.current?.updateTimer);
  store.set('last', null);
  showMachines();
};

export async function showMachines({ resume = false } = {}) {
  app.conn?.close();
  app.conn = null;
  app.current = null;
  $('#bar').hidden = false;
  ui.set('PC saya', {
    sub: app.me ? '@' + app.me.login : '',
    actions: [
      { icon: 'refresh', label: 'Muat ulang', onclick: () => showMachines() },
      { icon: 'dots', label: 'Menu', onclick: accountMenu },
    ],
  });
  const list = h('div', {}, skeletons(2));
  ui.view(scrollCol(list));
  if (!app.me) api('/api/me').then((r) => ((app.me = r), r.login && ui.sub('@' + r.login))).catch(() => {});
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
