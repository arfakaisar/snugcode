// Setelan mesin dari HP (dulu hanya lewat `snugcode setup` / `pin` / `devices` / `revoke` di terminal PC):
// model & API key (koneksi), perangkat terpasang, dan PIN. Wajib untuk runner cloud yang tidak punya terminal.
import * as C from '../../shared/crypto.js';
import * as M from '../../shared/models.js';
import { PROVIDERS, keyCandidates, ENGINE_LABEL, engineFor, REJECTED_KEYS } from '../../shared/providers.js';
import { store } from '../conn.js';
import { app } from './state.js';
import { ago, busyButton, copyText, h, haptic, ic, isOldDaemon, loading, menuItem, toast, ui } from './dom.js';
import { cloudPin } from './cloud.js';

const has = (m) => !!app.current?.info?.caps?.includes(m);
export const canConfigure = () => has('configure');
export const canConnect = () => has('connAdd');
const oldMsg = 'Perbarui snugcode di PC dulu untuk mengatur ini dari HP.';

// ---------- Model & API key (koneksi) ----------
const KIND_ICON = { chatgpt: 'spark', router: 'globe', custom: 'globe' };
const connName = (c) => c.label || PROVIDERS[c.kind]?.label || c.kind;
// Engine yang dipakai koneksi ini (untuk ditampilkan): Codex untuk ChatGPT/OpenAI, Claude Agent SDK untuk lainnya.
function engineText(c) {
  const engines = new Set();
  if (c.kind === 'chatgpt') engines.add('codex');
  else {
    const any = engineFor(c, 'x');
    const gpt = engineFor(c, 'gpt-5');
    if (any) engines.add(any.engine);
    if (gpt) engines.add(gpt.engine);
  }
  return [...engines].map((e) => ENGINE_LABEL[e]).join(' + ');
}
function connLine(c) {
  const who = c.kind === 'chatgpt' ? c.account?.email || 'login ChatGPT' : c.key || c.url?.replace(/^https?:\/\//, '') || '';
  return [who, engineText(c), c.models != null ? c.models + ' model' : null].filter(Boolean).join(' · ');
}

// Petunjuk saat key diketik: tebakan jenis key (tanpa mengirim apa pun).
function keyHint(key, url) {
  const k = key.trim();
  if (!k) return '';
  const bad = REJECTED_KEYS.find((r) => r.re.test(k));
  if (bad) return '✗ ' + bad.why;
  if (url.trim()) return 'Endpoint sendiri: format (Anthropic / OpenAI / Responses) dideteksi saat disambungkan.';
  const c = keyCandidates(k);
  if (c.length === 1) return 'Terlihat seperti key ' + PROVIDERS[c[0]].label + '.';
  if (c.length > 1) return 'Key ini bisa milik ' + c.map((x) => PROVIDERS[x].short).join(' / ') + ': dicek ke masing-masing.';
  return 'Jenis key tidak dikenali: bila ini key router (9router, OmniRoute, LiteLLM, …), isi juga URL-nya.';
}

/** @param {{ first?: boolean, back?: () => void, after?: () => void }} [opts] */
export async function connectionsSheet({ first = false, back, after } = {}) {
  if (!canConnect()) return routerSheet({ first, back, after });
  const info = app.current.info;
  const list = h('div', {});
  const renderList = (conns) => {
    list.replaceChildren(
      conns.length
        ? h('div', { class: 'group' },
            ...conns.map((c) =>
              menuItem({ icon: KIND_ICON[c.kind] || 'key', t1: connName(c), t2: connLine(c), onclick: () => connDetail(c, () => connectionsSheet({ back, after })) }),
            ),
          )
        : null,
    );
  };
  renderList(info.connections || []);
  const err = h('div', { class: 'err', role: 'alert' });
  const hint = h('div', { class: 'dim small', style: 'margin:6px 2px 0;min-height:1.2em' });
  const key = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'Tempel API key', 'aria-label': 'API key', enterkeyhint: 'go' });
  const url = h('input', { class: 'field', type: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://router.contoh.com/v1', 'aria-label': 'URL router atau endpoint' });
  const urlBox = h('details', { class: 'addpc', style: 'margin-top:10px' }, h('summary', {}, ic('plus'), 'URL router / endpoint (9router, OmniRoute, lokal, …)'), url);
  const btn = h('button', { class: 'btn primary big', style: 'margin-top:14px' }, ic('check'), 'Sambungkan');
  const update = () => {
    hint.textContent = keyHint(key.value, url.value);
    // Key yang tidak dikenali hampir pasti key router: buka kolom URL-nya.
    if (key.value.trim() && !keyCandidates(key.value.trim()).length && !REJECTED_KEYS.some((r) => r.re.test(key.value.trim()))) urlBox.open = true;
  };
  key.oninput = update;
  url.oninput = update;
  const save = async () => {
    if (!key.value.trim() && !url.value.trim()) return (err.textContent = 'Tempel API key dulu.');
    const done = busyButton(btn, 'Mendeteksi & menguji…');
    err.textContent = '';
    try {
      const r = await app.conn.call('connAdd', { key: key.value.trim() || undefined, url: url.value.trim() || undefined });
      app.current.info = r.info;
      haptic(25);
      toast(`${connName(r.conn)} tersambung · ${engineText(r.conn)} · ${r.models} model`);
      (await import('./model-picker.js')).modelCache.list = null;
      (await import('./sessions.js')).showSessionsMeta();
      if (after) return after();
      connectionsSheet({ back, after });
    } catch (e) {
      done();
      err.textContent = isOldDaemon(e) ? oldMsg : e.message;
    }
  };
  btn.onclick = save;
  key.onkeydown = (e) => e.key === 'Enter' && save();
  const chatgpt = has('chatgptLogin') && !(info.connections || []).some((c) => c.kind === 'chatgpt');
  ui.sheet(
    ui.head(first ? 'Sambungkan model' : 'Model & API key', { sub: app.current.m.name, back }),
    first ? h('div', { class: 'muted', style: 'margin-bottom:12px' }, 'Agen butuh model AI. Login ChatGPT, atau tempel API key milikmu — jenisnya dideteksi otomatis dan harness terbaik dipilih untuk tiap model.') : null,
    list,
    chatgpt
      ? h('button', { class: 'btn big', style: 'margin:4px 0 10px', onclick: () => chatgptSheet(() => connectionsSheet({ first, back, after }), after) }, ic('spark'), 'Login dengan ChatGPT')
      : null,
    h('div', { class: 'label' }, (info.connections || []).length ? 'Tambah API key' : 'API key'),
    key,
    hint,
    urlBox,
    err,
    btn,
    h('div', { class: 'fine' }, 'Didukung: Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Kimi, GLM, xAI, Groq, dan router/endpoint kompatibel OpenAI atau Anthropic. Key dikirim terenkripsi langsung ke mesin ini dan tidak pernah ditampilkan lagi.'),
    h('div', { class: 'fine', style: 'margin-top:6px' }, 'Langganan Claude Pro/Max dan login Gemini CLI/Antigravity tidak boleh dipakai aplikasi pihak ketiga (ketentuan Anthropic & Google): pakai API key.'),
  );
  if (first) setTimeout(() => key.focus(), 150);
  // Jumlah model per koneksi dihitung di latar belakang oleh daemon: segarkan daftar.
  app.conn.call('connections').then((conns) => (app.current.info = { ...app.current.info, connections: conns }, renderList(conns))).catch(() => {});
}

function connDetail(c, back) {
  const remove = async () => {
    if (!(await ui.confirm({ title: `Hapus ${connName(c)}?`, text: 'Sesi yang memakai model dari koneksi ini perlu pindah model.', ok: 'Hapus koneksi', danger: true, icon: 'trash' }))) return connDetail(c, back);
    try {
      app.current.info = c.kind === 'chatgpt' ? await app.conn.call('chatgptLogout') : await app.conn.call('connRemove', { id: c.id });
      (await import('./model-picker.js')).modelCache.list = null;
      toast('Koneksi dihapus');
      back();
    } catch (e) {
      toast(e.message, true);
    }
  };
  const fmt = Object.entries(c.formats || {}).filter(([, v]) => v).map(([k]) => ({ anthropic: 'Anthropic Messages', openai: 'OpenAI Chat', responses: 'Responses API' })[k] || k);
  ui.sheet(
    ui.head(connName(c), { sub: c.kind === 'chatgpt' ? 'login ChatGPT' : c.key || '', back }),
    h('div', { class: 'group' },
      menuItem({ icon: 'cpu', t1: 'Harness', t2: engineText(c) || '-', chev: false }),
      c.kind === 'chatgpt' ? menuItem({ icon: 'spark', t1: 'Akun', t2: [c.account?.email, c.account?.plan].filter(Boolean).join(' · ') || 'ChatGPT', chev: false }) : menuItem({ icon: 'globe', t1: 'Format API', t2: fmt.join(' · ') || '-', chev: false }),
      c.url ? menuItem({ icon: 'globe', t1: 'Endpoint', t2: c.url.replace(/^https?:\/\//, ''), chev: false }) : null,
      menuItem({ icon: 'list', t1: 'Model', t2: c.models != null ? c.models + ' model tersedia' : 'memuat…', chev: false }),
    ),
    h('div', { class: 'group', style: 'margin-top:14px' }, menuItem({ icon: 'trash', t1: c.kind === 'chatgpt' ? 'Logout ChatGPT' : 'Hapus koneksi', danger: true, chev: false, onclick: remove })),
  );
}

// Login ChatGPT lewat Codex resmi: kode perangkat diselesaikan di browser HP.
export async function chatgptSheet(back, after) {
  const body = h('div', {}, loading('Menyiapkan Codex & meminta kode login… (pertama kali ±1–2 menit)'));
  ui.sheet(ui.head('Login ChatGPT', { sub: 'untuk ' + app.current.m.name, back }), body);
  let r;
  try {
    r = await app.conn.call('chatgptLogin');
  } catch (e) {
    return body.replaceChildren(h('div', { class: 'err' }, isOldDaemon(e) ? oldMsg : e.message), h('button', { class: 'btn', onclick: () => chatgptSheet(back, after) }, ic('refresh'), 'Coba lagi'));
  }
  const copyBtn = h('button', { class: 'copybtn', onclick: async (e) => (await copyText(r.code)) && (e.currentTarget.classList.add('done'), toast('Kode disalin')) }, ic('copy'), 'salin');
  const status = h('div', { class: 'loading', style: 'justify-content:center' }, h('span', { class: 'spinner' }), h('span', {}, 'menunggu login ChatGPT…'));
  body.replaceChildren(
    h('div', { class: 'muted small' }, 'Buka halaman OpenAI, login dengan akun ChatGPT-mu, lalu masukkan kode ini:'),
    h('div', { class: 'ghcode' }, h('span', {}, r.code), copyBtn),
    status,
    h('a', { class: 'btn primary', href: r.url, target: '_blank', rel: 'noopener', onclick: () => copyText(r.code) }, ic('spark'), 'Salin kode & buka OpenAI'),
    h('div', { class: 'dim small', style: 'margin-top:12px;text-align:center' }, r.url.replace(/^https:\/\//, '')),
    h('div', { class: 'fine' }, 'Login disimpan di mesin ini oleh Codex resmi (OpenAI mengizinkan langganan ChatGPT dipakai di harness pihak ketiga).'),
  );
  app.current.onChatgpt = async (msg) => {
    app.current.onChatgpt = null;
    if (!msg.ok) {
      status.replaceChildren(h('span', { class: 'e' }, '✗ ' + (msg.err || 'Login gagal')));
      return;
    }
    haptic(25);
    toast('ChatGPT tersambung');
    try {
      app.current.info = await app.conn.call('info');
    } catch {}
    (await import('./model-picker.js')).modelCache.list = null;
    (await import('./sessions.js')).showSessionsMeta();
    if (after) return after();
    back ? back() : ui.closeSheet();
  };
}

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
    canConnect()
      ? menuItem({ icon: 'key', t1: info.routerConfigured ? 'Model & API key' : 'Model & API key (perlu)', t2: (info.connections || []).map((c) => connName(c)).join(' · ') || 'belum ada model tersambung', onclick: () => connectionsSheet({ back }) })
      : menuItem({ icon: 'key', t1: info.routerConfigured ? 'Key 9router' : 'Key 9router (perlu)', t2: (info.router || '').replace(/^https?:\/\//, '') || 'belum diatur', onclick: () => routerSheet({ back }) }),
    menuItem({ icon: 'shield', t1: 'Perangkat terpasang', t2: 'lihat & cabut akses HP', onclick: () => devicesSheet(back) }),
    menuItem({ icon: 'lock', t1: cloudPin(app.current.m.id) ? 'PIN untuk HP lain' : 'Ganti PIN', t2: 'pairing HP baru', onclick: () => pinSheet(back) }),
  ];
}
