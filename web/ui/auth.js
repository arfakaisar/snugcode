// API relay, layar login GitHub, dan daftar PC.
import { token, store } from '../conn.js';
import { app } from './state.js';
import { $, ago, coarse, copyText, greeting, h, haptic, ic, menuItem, onLongPress, pullToRefresh, scrollCol, skeletons, mascot, toast, ui } from './dom.js';
import { openMachine } from './machine.js';
import { accountMenu } from './push.js';
import { cloudSetupSheet, ghcs, isCodespace, removeRunner } from './cloud.js';

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
    ['cloud', 'Tanpa PC pun bisa', 'runner cloud di GitHub Codespaces milikmu'],
    ['branch', 'Aman untuk repo-mu', 'satu worktree & branch per sesi'],
  ];
  ui.view(
    h('div', { class: 'scroll' },
      h('div', { class: 'hero login' },
        h('div', { class: 'brand' }, mascot('draw xl tap'), h('span', { class: 'wordmark' }, 'snugcode')),
        h('h1', { class: 'serif display' }, 'Coding dari saku,', h('br'), h('span', { class: 'accent-text' }, 'tenaga dari PC atau cloud.')),
        h('p', { class: 'lead' }, 'Agen Claude Code berjalan di komputermu atau di cloud — analisis repo, edit, commit, dan push langsung dari HP.'),
        h('div', { class: 'feats' }, ...feats.map(([icon, t1, t2], i) => h('div', { class: 'feat', style: `--i:${i}` }, h('span', { class: 'fi' }, ic(icon)), h('span', {}, h('b', {}, t1), h('span', {}, t2))))),
        h('a', { class: 'btn primary big', href: '/auth/login?kind=user', onclick: () => haptic() }, ic('github'), 'Login dengan GitHub'),
        h('div', { class: 'fine' }, 'Punya PC? Pakai akun GitHub yang sama dengan saat setup di PC. Tanpa PC? Pilih runner cloud setelah login.'),
      ),
    ),
  );
}

// ---------- Opsi per mesin: buka / hapus dari akun ----------
// Bisa dipakai walau mesin offline atau runner macet (tidak perlu tersambung ke mesinnya).
export function machineActions(m) {
  const cloud = m.kind === 'cloud';
  const what = cloud ? 'runner' : 'PC';
  const remove = async () => {
    const text = cloud
      ? isCodespace(m)
        ? ghcs()
          ? 'Codespace runner beserta semua sesi, worktree, dan commit yang belum di-push dihapus permanen.'
          : 'Runner dihapus dari akun. HP ini belum terhubung ke Codespaces, jadi codespace-nya perlu dihapus manual di github.com/codespaces.'
        : 'Runner dihapus dari akun dan langsung terputus. Hentikan juga container-nya di server (docker rm -f snugcode).'
      : 'PC ini dihapus dari akun dan langsung terputus. File & repo di PC tidak disentuh. Untuk menautkannya lagi, jalankan `snugcode setup` di PC.';
    if (!(await ui.confirm({ title: `Hapus ${m.name}?`, text, ok: `Hapus ${what}`, danger: true, icon: 'trash', stay: true }))) return;
    ui.sheet(ui.head('Menghapus…', { sub: m.name, close: false }), h('div', { class: 'loading' }, mascot('think'), h('span', { class: 'shimmer' }, cloud ? 'Menghapus runner…' : 'Menghapus PC dari akun…')));
    try {
      if (cloud) await removeRunner(m);
      else {
        const r = await api('/api/machines/' + m.id, { method: 'DELETE' });
        if (r?.error) throw new Error(r.error);
        store.set('dev.' + m.id, null);
        toast('PC dihapus dari akun');
      }
      if (store.get('last')?.mid === m.id) store.set('last', null);
      ui.closeSheet();
      showMachines();
    } catch (e) {
      ui.closeSheet();
      toast('Gagal menghapus: ' + e.message, true, 6000);
    }
  };
  ui.sheet(
    ui.head(m.name, { sub: (cloud ? (isCodespace(m) ? 'Runner Codespaces' : 'Runner server') : 'PC') + (m.online ? ' · online' : ' · offline') }),
    h('div', { class: 'group' },
      menuItem({ icon: cloud ? 'cloud' : 'monitor', t1: 'Buka', t2: m.online ? 'sesi & pengaturan' : cloud ? 'nyalakan & buka' : 'menunggu PC online', onclick: () => (ui.closeSheet(), openMachine(m)) }),
      menuItem({ icon: 'trash', t1: `Hapus ${what}`, t2: cloud ? (isCodespace(m) ? 'codespace & mesinnya di akun' : 'dari akun snugcode') : 'dari akun snugcode', danger: true, chev: false, onclick: remove }),
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
    ui.set('Mesin saya', { actions: [...(coarse ? [] : [{ icon: 'refresh', label: 'Muat ulang', onclick: () => showMachines() }]), avatarBtn()] });
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
  const cloudBtn = (label) => h('button', { class: 'btn primary', style: 'margin-top:12px', onclick: () => (haptic(), cloudSetupSheet()) }, ic('cloud'), label);
  // Kembali dari izin Codespaces: lanjutkan wizard runner.
  const next = store.get('cloudNext');
  if (next) store.set('cloudNext', null);
  if (next === 'create') setTimeout(cloudSetupSheet, 300);
  if (!machines.length)
    return list.replaceChildren(
      h('div', { class: 'empty' },
        h('div', { class: 'emptyart' }, ic('cloud')),
        h('b', {}, 'Belum ada mesin'),
        'Tanpa PC: agen berjalan di GitHub Codespaces milikmu, gratis dalam kuota bulanan GitHub.',
        cloudBtn('Pakai cloud — tanpa PC'),
      ),
      h('details', { class: 'addpc' }, h('summary', {}, ic('monitor'), 'Pakai PC sendiri'), h('div', { class: 'muted small' }, 'Di komputer (Node.js 22+ dan git), jalankan:'), howto),
    );
  const last = resume ? store.get('last') : null;
  const lastM = last && machines.find((m) => m.id === last.mid);
  if (lastM) return openMachine(lastM, { sid: last.sid });
  const online = machines.filter((m) => m.online).length;
  list.replaceChildren(
    h('div', { class: 'label' }, 'Komputer', h('span', { class: 'count' }, machines.length), online ? h('span', { class: 'tag on' }, online + ' online') : null),
    h('div', { class: 'list' },
      ...machines.map((m, i) => {
        const card = h('button', { class: 'card pc' + (m.online ? ' online' : ''), style: `--i:${i}`, onclick: () => (haptic(), openMachine(m)) },
          h('span', { class: 'avatar' + (m.online ? '' : ' off') }, ic(m.kind === 'cloud' ? 'cloud' : 'monitor'), h('i', { class: 'live' })),
          h('span', { class: 'grow' }, h('div', { class: 'name' }, m.name), h('div', { class: 'sub' }, m.online ? (m.kind === 'cloud' ? 'online · runner cloud' : 'online · siap dipakai') : m.kind === 'cloud' ? 'tidur · ketuk untuk menyalakan' : 'offline · terakhir ' + (ago(m.lastSeen) || '-') + (m.lastSeen ? ' lalu' : ''))),
        );
        onLongPress(card, () => machineActions(m));
        return h('div', { class: 'cardrow', style: `--i:${i}` }, card, h('button', { class: 'iconbtn more', 'aria-label': 'Opsi ' + m.name, title: 'Opsi', onclick: () => (haptic(6), machineActions(m)) }, ic('dots')));
      }),
    ),
    h('details', { class: 'addpc' },
      h('summary', {}, ic('plus'), 'Tambah PC lain'),
      h('div', { class: 'muted small' }, 'Pasang di komputer lain (Node.js 22+ dan git):'),
      howto,
      machines.some(isCodespace) ? null : h('div', { class: 'muted small', style: 'margin-top:14px' }, 'Atau tanpa PC:'),
      machines.some(isCodespace) ? null : cloudBtn('Buat runner cloud'),
    ),
  );
}
