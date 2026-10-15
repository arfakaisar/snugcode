// Setelan mesin dari HP (dulu hanya lewat `snugcode setup` / `pin` / `devices` / `revoke` di terminal PC):
// key 9router, perangkat terpasang, dan PIN. Wajib untuk runner cloud yang tidak punya terminal.
import * as C from '../../shared/crypto.js';
import * as M from '../../shared/models.js';
import { store } from '../conn.js';
import { app } from './state.js';
import { ago, busyButton, copyText, h, haptic, ic, isOldDaemon, loading, menuItem, toast, ui } from './dom.js';
import { cloudPin } from './cloud.js';

const has = (m) => !!app.current?.info?.caps?.includes(m);
export const canConfigure = () => has('configure');
const oldMsg = 'Perbarui snugcode di PC dulu untuk mengatur ini dari HP.';

// ---------- Key 9router ----------
// first: dibuka otomatis karena mesin belum punya key (runner cloud baru). after(): lanjutan setelah tersimpan.
/** @param {{ first?: boolean, back?: () => void, after?: () => void }} [opts] */
export function routerSheet({ first = false, back, after } = {}) {
  const info = app.current.info;
  const err = h('div', { class: 'err', role: 'alert' });
  const key = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: info.routerConfigured ? 'Key baru (kosongkan = tetap)' : 'Tempel API key 9router', 'aria-label': 'API key 9router', enterkeyhint: 'go' });
  const url = h('input', { class: 'field', type: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: info.router || '', 'aria-label': 'URL router' });
  const btn = h('button', { class: 'btn primary big', style: 'margin-top:14px' }, ic('check'), 'Simpan & uji');
  const save = async () => {
    if (!key.value.trim() && !info.routerConfigured) return (err.textContent = 'Key masih kosong.');
    const done = busyButton(btn, 'Menguji router…');
    err.textContent = '';
    try {
      const next = await app.conn.call('configure', { routerKey: key.value.trim() || undefined, routerUrl: url.value.trim() || undefined });
      app.current.info = next;
      haptic(25);
      toast('9router tersambung · model ' + (M.modelLabel(next.model) || next.model));
      (await import('./sessions.js')).showSessionsMeta();
      if (after) return after();
      ui.closeSheet();
    } catch (e) {
      done();
      err.textContent = isOldDaemon(e) ? oldMsg : e.message;
    }
  };
  btn.onclick = save;
  key.onkeydown = (e) => e.key === 'Enter' && save();
  ui.sheet(
    ui.head(first ? 'Satu langkah lagi' : 'Key 9router', { sub: app.current.m.name, back }),
    first ? h('div', { class: 'muted', style: 'margin-bottom:12px' }, 'Agen memakai model dari 9router. Tempel API key-mu — cukup sekali untuk mesin ini.') : null,
    key,
    h('details', { class: 'addpc', style: 'margin-top:12px' }, h('summary', {}, ic('gear'), 'URL router (lanjutan)'), url),
    err,
    btn,
    h('div', { class: 'fine' }, 'Key dikirim lewat kanal terenkripsi langsung ke mesin ini dan tidak pernah ditampilkan lagi. Relay tidak bisa membacanya.'),
  );
  setTimeout(() => key.focus(), 150);
}

// ---------- Perangkat terpasang ----------
export async function devicesSheet(back) {
  const body = h('div', {}, loading('Memuat perangkat…'));
  ui.sheet(ui.head('Perangkat terpasang', { sub: app.current.m.name, back }), body);
  let list;
  try {
    list = await app.conn.call('devices');
  } catch (e) {
    return body.replaceChildren(h('div', { class: 'err' }, isOldDaemon(e) ? oldMsg : e.message));
  }
  const revoke = async (d) => {
    const self = d.current;
    if (!(await ui.confirm({ title: `Cabut ${d.name}?`, text: self ? 'Ini HP yang sedang kamu pakai: perlu PIN lagi untuk tersambung.' : 'Perangkat itu langsung terputus dan perlu PIN lagi untuk tersambung.', ok: 'Cabut akses', danger: true, icon: 'unlink' }))) return devicesSheet(back);
    try {
      await app.conn.call('revoke', { id: d.id });
      toast('Akses dicabut');
      if (!self) devicesSheet(back);
    } catch (e) {
      toast(e.message, true);
    }
  };
  body.replaceChildren(
    h('div', { class: 'group' },
      ...list.sort((a, b) => +b.current - +a.current || (b.lastSeen || 0) - (a.lastSeen || 0)).map((d) =>
        menuItem({
          icon: d.current ? 'check' : 'monitor',
          t1: h('span', {}, d.name, d.current ? h('span', { class: 'tag on', style: 'margin-left:8px' }, 'HP ini') : null, d.online && !d.current ? h('span', { class: 'tag', style: 'margin-left:8px' }, 'online') : null),
          t2: `dipasangkan ${ago(d.pairedAt) || '-'} lalu · aktif ${ago(d.lastSeen) || '-'} lalu${d.push ? ' · notifikasi' : ''}`,
          onclick: () => revoke(d),
        }),
      ),
    ),
    h('div', { class: 'fine' }, 'Ketuk perangkat untuk mencabut aksesnya.'),
  );
}

// ---------- PIN ----------
export function pinSheet(back) {
  const m = app.current.m;
  const input = h('input', { class: 'field', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '12', placeholder: 'PIN baru (6–12 huruf/angka)', 'aria-label': 'PIN baru', enterkeyhint: 'go' });
  const err = h('div', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn primary', style: 'margin-top:12px' }, 'Ganti PIN');
  const go = async () => {
    const pin = input.value.trim();
    if (!C.PIN_RE.test(pin)) return (err.textContent = 'PIN 6–12 huruf/angka.');
    const done = busyButton(btn, 'Menyimpan…');
    try {
      await app.conn.call('setPin', { pin });
      if (cloudPin(m.id)) store.set('cloudpin.' + m.id, C.normalizePin(pin));
      toast('PIN diganti. HP yang sudah terpasang tetap tersambung.');
      back ? back() : ui.closeSheet();
    } catch (e) {
      done();
      err.textContent = isOldDaemon(e) ? oldMsg : e.message;
    }
  };
  btn.onclick = go;
  input.onkeydown = (e) => e.key === 'Enter' && go();
  const pin = cloudPin(m.id);
  ui.sheet(
    ui.head('PIN pairing', { sub: m.name, back }),
    pin
      ? h('div', {}, h('div', { class: 'muted small' }, 'PIN runner ini (dibuat otomatis oleh HP ini). Pakai untuk memasangkan HP lain:'),
          h('div', { class: 'ghcode' }, h('span', {}, pin), h('button', { class: 'copybtn', onclick: async (e) => (await copyText(pin)) && (e.currentTarget.classList.add('done'), toast('PIN disalin')) }, ic('copy'), 'salin')))
      : h('div', { class: 'muted small', style: 'margin-bottom:10px' }, 'PIN dipakai sekali per HP untuk pairing. Mengganti PIN juga membuka kunci setelah PIN salah berkali-kali.'),
    h('div', { class: 'label' }, 'Ganti PIN'),
    input,
    err,
    btn,
  );
}

// Baris menu setelan untuk "Pengaturan PC" (hanya bila daemon mendukungnya).
export function settingsItems(back) {
  if (!canConfigure()) return [];
  const info = app.current.info;
  return [
    menuItem({ icon: 'key', t1: info.routerConfigured ? 'Key 9router' : 'Key 9router (perlu)', t2: (info.router || '').replace(/^https?:\/\//, '') || 'belum diatur', onclick: () => routerSheet({ back }) }),
    menuItem({ icon: 'shield', t1: 'Perangkat terpasang', t2: 'lihat & cabut akses HP', onclick: () => devicesSheet(back) }),
    menuItem({ icon: 'lock', t1: cloudPin(app.current.m.id) ? 'PIN untuk HP lain' : 'Ganti PIN', t2: 'pairing HP baru', onclick: () => pinSheet(back) }),
  ];
}
