// Runner cloud (tanpa PC) dari HP: hubungkan GitHub Codespaces, buat runner, nyalakan/hentikan, hapus.
// Runner tampil di daftar sebagai "PC" biasa; protokol, enkripsi, dan layar sesi tidak berubah.
import { store } from '../conn.js';
import { Codespaces, SECRET_NAMES, randomPin, stateText } from '../codespaces.js';
import { app } from './state.js';
import { api } from './auth.js';
import { busyButton, h, haptic, ic, loading, mascot, toast, ui } from './dom.js';

/** @returns {{ token: string, login: string } | null} */
export const ghcs = () => store.get('ghcs');
export const cloudPin = (mid) => store.get('cloudpin.' + mid);
export const isCodespace = (m) => m?.kind === 'cloud' && m.provider === 'codespace';
const client = () => (ghcs() ? new Codespaces(ghcs().token) : null);

let health = null;
async function runnerRepo() {
  health ??= await fetch('/api/health').then((r) => r.json()).catch(() => ({}));
  return health.runnerRepo || 'arfakaisar/snugcode';
}

// Izin GitHub Codespaces (scope `codespace`) lewat relay; token kembali di fragmen URL (#gh=…).
// `next`: apa yang dilanjutkan setelah kembali ('create' = buka wizard runner).
export function connectCodespaces(next = 'create') {
  store.set('cloudNext', next);
  location.href = '/auth/login?kind=gh';
}

// Dipanggil saat boot (app.js) dengan isi fragmen URL.
export function acceptGhToken(hash) {
  const m = hash.match(/[#&]gh=([^&]+)/);
  if (!m) return false;
  const login = decodeURIComponent(hash.match(/[#&]ghlogin=([^&]+)/)?.[1] || '');
  store.set('ghcs', { token: decodeURIComponent(m[1]), login });
  return true;
}

// Token Codespaces harus milik akun yang sama dengan login snugcode.
async function checkAccount(cs) {
  const u = await cs.user();
  const me = app.me?.login || (await api('/api/me').catch(() => ({}))).login;
  if (me && u.login.toLowerCase() !== me.toLowerCase()) {
    store.set('ghcs', null);
    throw new Error(`Izin Codespaces diberikan untuk @${u.login}, padahal kamu login sebagai @${me}. Hubungkan lagi dengan akun yang sama.`);
  }
  return u;
}

async function cloudMachines() {
  const { machines } = await api('/api/machines');
  return machines.filter(isCodespace);
}

const step = (text) => {
  const el = h('li', { class: 'run' }, h('span', { class: 'si' }, h('span', { class: 'spinner' })), h('span', { class: 'grow' }, text), h('span', { class: 'dim small' }));
  return {
    el,
    note: (t) => (el.lastChild.textContent = t),
    done: (t) => (el.className = 'ok', el.firstChild.replaceChildren(ic('check')), t != null && (el.lastChild.textContent = t)),
    fail: () => (el.className = 'bad', el.firstChild.replaceChildren(ic('x'))),
  };
};

// ---------- Wizard: buat runner ----------
export async function cloudSetupSheet() {
  store.set('cloudNext', null);
  const body = h('div', {}, loading('Memeriksa…'));
  ui.sheet(ui.head('Runner cloud', { sub: 'snugcode tanpa PC' }), body);
  const intro = h('div', { class: 'empty', style: 'padding:6px 0 10px' },
    h('div', { class: 'emptyart up' }, ic('cloud')),
    h('b', {}, 'Agen berjalan di GitHub Codespaces'),
    'Mesin Linux pribadi di akun GitHub-mu: git, Node, Python, dan Chromium untuk preview. HP tetap hanya remote, dan agen terus bekerja walau HP dikunci.',
  );
  const fine = h('div', { class: 'fine' }, 'Gratis 120 core-hour/bulan untuk akun GitHub Free (±60 jam runner 2-core). Runner berhenti sendiri setelah 30 menit tidak dipakai.');
  const cs = client();
  if (!cs)
    return body.replaceChildren(intro,
      h('button', { class: 'btn primary big', onclick: () => (haptic(), connectCodespaces('create')) }, ic('github'), 'Hubungkan GitHub Codespaces'),
      h('div', { class: 'dim small', style: 'margin-top:10px;text-align:center' }, 'Izin `codespace` hanya disimpan di HP ini, tidak di server snugcode.'),
      fine,
    );
  try {
    const user = await checkAccount(cs);
    const upstream = await runnerRepo();
    const existing = await cloudMachines();
    if (existing.length) {
      const m = existing[0];
      return body.replaceChildren(intro,
        h('button', { class: 'btn primary big', onclick: async () => (ui.closeSheet(), (await import('./machine.js')).openMachine(m)) }, ic('cloud'), 'Buka runner ' + m.name),
        h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => recreate(m) }, ic('refresh'), 'Buat ulang runner'),
        fine,
      );
    }
    const repo = await cs.findRunnerRepo(user.login, upstream);
    if (!repo)
      return body.replaceChildren(intro,
        h('div', { class: 'label' }, 'Langkah 1 · sekali saja'),
        h('div', { class: 'muted small' }, `Fork repo ${upstream} ke akunmu. Codespace runner dibuat dari fork itu, dan secret runner hanya bisa dibaca codespace dari fork itu.`),
        h('a', { class: 'btn primary', style: 'margin-top:12px', href: `https://github.com/${upstream}/fork`, target: '_blank', rel: 'noopener' }, ic('github'), 'Fork di GitHub'),
        h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => cloudSetupSheet() }, ic('check'), 'Sudah, lanjutkan'),
        fine,
      );
    const go = h('button', { class: 'btn primary big', onclick: () => createRunner(body, repo, user) }, ic('cloud'), 'Buat runner');
    body.replaceChildren(intro,
      h('div', { class: 'tags', style: 'justify-content:center;margin-bottom:14px' }, h('span', { class: 'tag' }, '@' + user.login), h('span', { class: 'tag' }, repo.full_name)),
      go,
      fine,
    );
  } catch (e) {
    body.replaceChildren(h('div', { class: 'err' }, e.message), h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => (e.status === 401 ? connectCodespaces('create') : cloudSetupSheet()) }, ic('refresh'), e.status === 401 ? 'Hubungkan lagi' : 'Coba lagi'));
  }
}

async function recreate(m) {
  if (!(await ui.confirm({ title: 'Buat ulang runner?', text: 'Codespace lama beserta sesi & worktree di dalamnya dihapus. Commit yang belum di-push ikut hilang.', ok: 'Hapus & buat ulang', danger: true, icon: 'refresh', stay: true }))) return;
  try {
    await removeRunner(m, { quiet: true });
  } catch (e) {
    return toast(e.message, true);
  }
  cloudSetupSheet();
}

async function createRunner(body, repo, user) {
  haptic(15);
  const cs = client();
  const list = h('ol', { class: 'steps' });
  const err = h('div', { class: 'err', role: 'alert' });
  body.replaceChildren(h('div', { class: 'muted small', style: 'margin-bottom:10px' }, 'Pertama kali ±3–5 menit (memasang snugcode & Chromium). Boleh tinggalkan layar ini — runner tetap disiapkan.'), list, err);
  const add = (t) => {
    const s = step(t);
    list.append(s.el);
    return s;
  };
  let cur;
  try {
    cur = add('Mendaftarkan runner di akun snugcode');
    const prov = await api('/api/machines/provision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Cloud', provider: 'codespace' }) });
    if (prov.error) throw new Error(prov.error);
    const pin = randomPin();
    store.set('cloudpin.' + prov.mid, pin);
    cur.done();

    cur = add('Menyimpan token & PIN sebagai Codespaces secret');
    await cs.setSecrets({ SNUGCODE_MACHINE_TOKEN: prov.token, SNUGCODE_PAIR_PIN: pin, SNUGCODE_RELAY: location.origin }, repo.id);
    cur.done('terenkripsi di HP');

    cur = add('Membuat codespace');
    const c = await cs.create(repo, prov.mid);
    store.set('cloud.' + prov.mid, { codespace: c.name });
    cur.done(c.machine?.display_name || '');

    cur = add('Menunggu runner menyala');
    const m = await waitOnline(prov.mid, c.name, (t) => cur.note(t));
    cur.done();
    haptic(25);
    toast('Runner siap · @' + user.login);
    ui.closeSheet();
    (await import('./machine.js')).openMachine(m);
  } catch (e) {
    cur?.fail();
    err.textContent = e.message;
    body.append(h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => cloudSetupSheet() }, ic('refresh'), 'Coba lagi'));
  }
}

// Tunggu codespace menyala dan daemon-nya tersambung ke relay.
async function waitOnline(mid, name, onState, ms = 12 * 60_000) {
  const cs = client();
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    const { machines } = await api('/api/machines');
    const m = machines.find((x) => x.id === mid);
    if (!m) throw new Error('Runner dihapus dari akun.');
    if (m.online) return m;
    const c = await cs.get(name).catch(() => null);
    if (c?.state === 'Failed') throw new Error('Codespace gagal dibuat. Buka di GitHub untuk melihat log: ' + c.web_url);
    if (c?.state === 'Shutdown') await cs.start(name);
    const t = stateText(c?.state);
    if (t !== last) onState?.((last = t));
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('Runner belum tersambung setelah 12 menit. Coba buka lagi nanti, atau lihat log di codespace: /workspaces/.snugcode/cloud.log');
}

async function codespaceOf(m) {
  const cs = client();
  if (!cs) return null;
  const c = await cs.find(m.id, store.get('cloud.' + m.id)?.codespace);
  if (c) store.set('cloud.' + m.id, { codespace: c.name });
  return c;
}

// ---------- Nyalakan / hentikan / hapus ----------
// Dipanggil saat runner offline dibuka. onState(teks) untuk layar tunggu. Mengembalikan false bila
// tidak bisa dinyalakan dari HP ini (belum ada izin Codespaces) — pemanggil menampilkan tombolnya.
export async function wakeRunner(m, onState) {
  if (!client()) return false;
  const c = await codespaceOf(m);
  if (!c) throw new Error('Codespace runner tidak ditemukan (mungkin sudah dihapus atau kedaluwarsa). Buat ulang dari menu Tambah PC → Runner cloud.');
  onState?.(stateText(c.state));
  if (!['Available', 'Starting', 'Provisioning', 'Queued', 'Rebuilding', 'Updating', 'Created'].includes(c.state)) await client().start(c.name);
  // Daemon tersambung sendiri; status codespace ditampilkan sampai relay melihatnya online.
  const t = setInterval(async () => {
    if (app.current?.m.id !== m.id || app.current.ready) return clearInterval(t);
    const now = await client()?.get(c.name).catch(() => null);
    if (now) onState?.(stateText(now.state));
  }, 5000);
  return true;
}

export async function stopRunnerNow(m) {
  const c = await codespaceOf(m);
  if (!c) throw new Error('Codespace runner tidak ditemukan.');
  await client().stop(c.name);
}

export async function removeRunner(m, { quiet = false } = {}) {
  const cs = client();
  const c = cs ? await codespaceOf(m).catch(() => null) : null;
  if (c) await cs.remove(c.name);
  await api('/api/machines/' + m.id, { method: 'DELETE' });
  if (cs) await cs.deleteSecrets(SECRET_NAMES).catch(() => {});
  for (const k of ['cloud.', 'cloudpin.', 'dev.']) store.set(k + m.id, null);
  if (!quiet) toast('Runner dihapus');
}

export async function openRunnerOnGithub(m) {
  const c = await codespaceOf(m);
  if (!c) throw new Error('Codespace runner tidak ditemukan.');
  window.open(c.web_url, '_blank', 'noopener');
}

// Tampilan untuk layar tunggu saat izin Codespaces belum ada di HP ini.
export const connectButton = () => h('button', { class: 'btn primary', style: 'margin-top:16px', onclick: () => connectCodespaces('wake') }, ic('github'), 'Hubungkan Codespaces untuk menyalakan');
export const wakeArt = () => mascot('think xl');

// Pilihan "berhenti otomatis setelah N menit" (runner menghentikan dirinya sendiri lewat token dari HP).
export async function idleSheet(back) {
  const info = app.current.info;
  const cur = info.runner?.idleStopMinutes ?? 30;
  const opts = [[15, '15 menit'], [30, '30 menit (disarankan)'], [60, '1 jam'], [120, '2 jam'], [0, 'Jangan berhenti otomatis']];
  ui.sheet(
    ui.head('Berhenti otomatis', { sub: app.current.m.name, back }),
    h('div', { class: 'muted small', style: 'margin-bottom:10px' }, 'Runner dianggap menganggur bila agen, perintah, dan dev server tidak berjalan, dan aplikasi tidak sedang dibuka.'),
    h('div', { class: 'group' },
      ...opts.map(([n, label]) =>
        h('button', {
          class: 'menuitem',
          onclick: async (e) => {
            const done = busyButton(/** @type {HTMLButtonElement} */ (e.currentTarget), label);
            try {
              const runner = await app.conn.call('runnerConfig', { idleStopMinutes: n, ...(ghcs() ? { token: ghcs().token } : {}) });
              app.current.info = { ...info, runner };
              toast('Berhenti otomatis: ' + label);
              back();
            } catch (err) {
              done();
              toast(err.message, true);
            }
          },
        }, h('span', { class: 'mi' }, ic(n === cur ? 'check' : 'clock')), h('span', { class: 'grow' }, h('div', { class: 't1' }, label))),
      ),
    ),
    !info.runner?.autoStop && info.runner?.provider === 'codespace' ? h('div', { class: 'fine' }, 'Hubungkan Codespaces di HP ini agar runner bisa menghentikan dirinya sendiri.') : null,
  );
}
