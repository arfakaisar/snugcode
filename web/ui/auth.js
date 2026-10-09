// API relay, layar login GitHub, dan daftar PC.
import { token, store } from '../conn.js';
import { app } from './state.js';
import { $, ago, coarse, copyText, greeting, h, haptic, ic, pullToRefresh, scrollCol, skeletons, mascot, toast, ui } from './dom.js';
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
  ui.set('snugcode', { dot: 'none' });
  $('#bar').hidden = true;
  const feats = [
    ['shield', 'Terenkripsi end-to-end', 'relay tidak bisa membaca apa pun'],
    ['key', 'Kredensial tetap di PC', 'API key & token GitHub tidak pernah ke HP'],
    ['branch', 'Aman untuk repo-mu', 'satu worktree & branch per sesi'],
  ];
  ui.view(
    h('div', { class: 'scroll' },
      h('div', { class: 'hero login' },
        h('div', { class: 'brand' }, mascot('draw xl tap'), h('span', { class: 'wordmark' }, 'snugcode')),
        h('h1', { class: 'serif display' }, 'Coding dari saku,', h('br'), h('span', { class: 'accent-text' }, 'tenaga dari PC-mu.')),
        h('p', { class: 'lead' }, 'Agen Claude Code berjalan di komputermu — analisis repo, edit, commit, dan push langsung dari HP.'),
        h('div', { class: 'feats' }, ...feats.map(([icon, t1, t2], i) => h('div', { class: 'feat', style: `--i:${i}` }, h('span', { class: 'fi' }, ic(icon)), h('span', {}, h('b', {}, t1), h('span', {}, t2))))),
        h('a', { class: 'btn primary big', href: '/auth/login?kind=user', onclick: () => haptic() }, ic('github'), 'Login dengan GitHub'),
        h('div', { class: 'fine' }, 'Pakai akun GitHub yang sama dengan saat setup di PC.'),
      ),
    ),
  );
}

// ---------- Layar: daftar PC ----------
// Posisi terakhir (PC + sesi) disimpan agar saat PWA dibuka ulang — mis. iOS
// mematikannya di latar belakang — pengguna langsung kembali ke sesi yang sama.
export const goMachines = () => {
  clearInterval(app.current?.updateTimer);
  store.set('last', null);
  ui.dir = -1;
  showMachines();
};

const avatarBtn = () => {
  const login = app.me?.login;
  return h('button', { class: 'iconbtn me', 'aria-label': 'Akun', title: 'Akun', onclick: accountMenu }, login ? h('span', { class: 'meav' }, login[0].toUpperCase()) : ic('gear'));
};

export async function showMachines({ resume = false } = {}) {
  app.conn?.close();
  app.conn = null;
  app.current = null;
  $('#bar').hidden = false;
  const setHeader = () =>
    ui.set('PC saya', { actions: [...(coarse ? [] : [{ icon: 'refresh', label: 'Muat ulang', onclick: () => showMachines() }]), avatarBtn()] });
  setHeader();
  const hello = h('div', { class: 'greet' }, mascot('draw tap'), h('h1', { class: 'serif' }, greeting() + (app.me?.login ? ', ' + app.me.login : '')));
  const list = h('div', {}, skeletons(2));
  const sc = scrollCol(hello, h('p', { class: 'muted greet-sub' }, 'Pilih komputer untuk mulai bekerja.'), list);
  ui.view(sc);
  pullToRefresh(sc, () => showMachines());
  if (!app.me)
    api('/api/me').then((r) => {
      app.me = r;
      if (!r.login || app.current) return;
      setHeader();
      hello.lastChild.textContent = greeting() + ', ' + r.login;
    }).catch(() => {});
  let machines;
  try {
    ({ machines } = await api('/api/machines'));
  } catch (e) {
    return list.replaceChildren(h('div', { class: 'err' }, e.message));
  }
  const install = 'npm i -g github:arfakaisar/snugcode && snugcode setup';
  const howto = h('div', { class: 'copyline' }, h('code', {}, install), h('button', { class: 'copybtn', onclick: async (e) => (await copyText(install)) && (e.currentTarget.classList.add('done'), toast('Perintah disalin')) }, ic('copy'), 'salin'));
  if (!machines.length)
    return list.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'emptyart' }, ic('monitor')), h('b', {}, 'Belum ada PC tertaut'), 'Di komputer, jalankan:', howto));
  const last = resume ? store.get('last') : null;
  const lastM = last && machines.find((m) => m.id === last.mid);
  if (lastM) return openMachine(lastM, { sid: last.sid });
  const online = machines.filter((m) => m.online).length;
  list.replaceChildren(
    h('div', { class: 'label' }, 'Komputer', h('span', { class: 'count' }, machines.length), online ? h('span', { class: 'tag on' }, online + ' online') : null),
    h('div', { class: 'list' },
      ...machines.map((m, i) =>
        h('button', { class: 'card pc' + (m.online ? ' online' : ''), style: `--i:${i}`, onclick: () => (haptic(), openMachine(m)) },
          h('span', { class: 'avatar' + (m.online ? '' : ' off') }, ic('monitor'), h('i', { class: 'live' })),
          h('span', { class: 'grow' }, h('div', { class: 'name' }, m.name), h('div', { class: 'sub' }, m.online ? 'online · siap dipakai' : 'offline · terakhir ' + (ago(m.lastSeen) || '-') + (m.lastSeen ? ' lalu' : ''))),
          ic('right', 'chev'),
        ),
      ),
    ),
    h('details', { class: 'addpc' },
      h('summary', {}, ic('plus'), 'Tambah PC lain'),
      h('div', { class: 'muted small' }, 'Pasang di komputer lain (Node.js 22+ dan git):'),
      howto,
    ),
  );
}
