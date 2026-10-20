// Terminal interaktif di HP: xterm.js (dimuat saat pertama dibuka) + baris tombol ekstra (Esc, Tab,
// Ctrl, Alt, panah, …) untuk keyboard HP. Shell-nya hidup di PC: menutup layar ini tidak mematikannya,
// dan membukanya lagi memutar ulang output terakhir.
import { app } from './state.js';
import { store } from '../conn.js';
import { coarse, h, haptic, ic, isOldDaemon, toast, ui } from './dom.js';
import { ctrlKey, imeDelta } from '../termkeys.js';

/** @type {Promise<typeof import('../xterm.js')> | null} */
let lib = null;
function loadLib() {
  if (!document.querySelector('link[data-xterm]')) document.head.append(h('link', { rel: 'stylesheet', href: 'xterm.css', 'data-xterm': true }));
  // Bundle terpisah (scripts/build-web.mjs): app.js tetap ringan untuk yang tidak memakai terminal.
  lib ??= import(new URL('xterm.js', document.baseURI).href).catch((e) => {
    lib = null;
    throw e;
  });
  return lib;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// Palet ANSI bawaan xterm dibuat untuk latar gelap; tema terang memakai warna yang lebih pekat.
const LIGHT_ANSI = { black: '#1f1e1d', red: '#b3261e', green: '#2e7d32', yellow: '#8a6100', blue: '#1f5fbf', magenta: '#8e3fa8', cyan: '#0f7c80', white: '#6b6a64', brightBlack: '#6b6a64', brightRed: '#c4432f', brightGreen: '#3f8f5a', brightYellow: '#a8741a', brightBlue: '#2f6fb8', brightMagenta: '#7a5bd1', brightCyan: '#2a8a86', brightWhite: '#1f1e1d' };
function themeOf() {
  const bg = css('--code-bg');
  const rgb = (bg.match(/[\da-f]{2}/gi) || []).map((x) => parseInt(x, 16));
  const light = rgb.length === 3 && rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150;
  return { background: bg, foreground: css('--fg'), cursor: css('--accent'), cursorAccent: bg, selectionBackground: css('--accent-soft') || 'rgba(217,119,87,.3)', ...(light ? LIGHT_ANSI : {}) };
}

// Keyboard HP mengetik lewat komposisi IME: xterm.js baru meneruskan kata setelah di-commit (spasi/Enter)
// dan ketikan dengan keydown 229 di luar komposisi bisa hilang, jadi di Android layar terminal tampak diam
// saat mengetik. Di layar sentuh, perubahan isi textarea bantu xterm dikirim sendiri begitu terjadi
// sebagai selisih (imeDelta) — termasuk koreksi otomatis, ketik geser, dan input suara. Event komposisi &
// input dihentikan di elemen induk (fase capture) sebelum sampai ke listener xterm di textarea.
function mobileInput(term) {
  const ta = term.textarea;
  const host = term.element;
  if (!ta || !host) return;
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('enterkeyhint', 'enter');
  let prev = ta.value;
  let composing = false;
  // Karakter dari keypress sudah dikirim xterm, yang tidak membatalkan event-nya (mis. spasi keyboard
  // fisik): teks yang lalu masuk ke textarea hanya dicatat, tidak dikirim lagi.
  let keyPressed = false;
  const own = (/** @type {Event} */ e) => e.target === ta;
  host.addEventListener('compositionstart', (e) => own(e) && ((composing = true), e.stopPropagation()), true);
  host.addEventListener('compositionupdate', (e) => own(e) && e.stopPropagation(), true);
  host.addEventListener('compositionend', (e) => own(e) && ((composing = false), e.stopPropagation()), true);
  host.addEventListener('input', (e) => {
    if (!own(e)) return;
    e.stopPropagation();
    const d = imeDelta(prev, ta.value);
    prev = ta.value;
    if (d && !keyPressed) term.input(d, true);
    keyPressed = false;
    // Kata yang di-commit menumpuk di textarea: dikosongkan setelah Enter / bila panjang, di luar komposisi.
    if (!composing && (prev.length > 256 || prev.includes('\n'))) ta.value = prev = '';
  }, true);
  // keydown 229 = "lewat IME": ditangani event input di atas. Tombol lain (Enter, Backspace saat textarea
  // kosong, panah & keyboard fisik) tetap ditangani xterm, yang bisa mengosongkan textarea (Enter, ^C):
  // selisih berikutnya dihitung dari isi setelah listener xterm selesai.
  term.attachCustomKeyEventHandler((e) => {
    if (e.keyCode === 229) return false;
    if (e.type === 'keydown') {
      keyPressed = false;
      queueMicrotask(() => (prev = ta.value));
    } else if (e.type === 'keypress') keyPressed = !!e.charCode && !e.ctrlKey && !e.altKey && !e.metaKey;
    return true;
  });
}

// Cubit dua jari di layar terminal mengubah ukuran huruf (zoom halaman dikunci seperti aplikasi native).
// Fase capture: viewport xterm menangani sentuhan sendiri dan tidak meneruskannya ke induk.
const FONT_MIN = 8;
const FONT_MAX = 24;
function pinchFont(term, el, onChange) {
  let start = 0;
  let base = 0;
  const dist = (/** @type {TouchList} */ t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    start = dist(e.touches);
    base = term.options.fontSize;
  }, { passive: true, capture: true });
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !start) return;
    e.preventDefault();
    const size = Math.round(Math.max(FONT_MIN, Math.min(FONT_MAX, base * (dist(e.touches) / start))));
    if (size !== term.options.fontSize) (term.options.fontSize = size), onChange(size);
  }, { passive: false, capture: true });
  el.addEventListener('touchend', (e) => e.touches.length < 2 && (start = 0), { passive: true, capture: true });
}

export async function showTerminal() {
  const s = app.current.session;
  let L;
  try {
    L = await loadLib();
  } catch {
    return toast('Gagal memuat terminal. Periksa koneksi lalu coba lagi.', true);
  }
  ui.closeSheet();
  const saved = Number(store.get('termFont'));
  const fontSize = saved >= FONT_MIN && saved <= FONT_MAX ? saved : coarse ? 12 : 13;
  const term = new L.Terminal({ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize, cursorBlink: true, scrollback: 5000, theme: themeOf() });
  const fit = new L.FitAddon();
  term.loadAddon(fit);

  /** @type {{ tid: string, title: string }[]} */
  let list = [];
  /** @type {string | null} */
  let cur = null;
  const mods = { ctrl: false, alt: false };
  const tabs = h('div', { class: 'ttabs' });
  const screen = h('div', { class: 'tscreen' });
  const empty = h('div', { class: 'tempty', hidden: true }, h('div', { class: 'dim small' }, 'Tidak ada terminal yang terbuka.'), h('button', { class: 'btn primary', onclick: () => openNew() }, ic('plus'), 'Buka terminal'));
  const keys = h('div', { class: 'tkeys' });
  const view = h('div', { class: 'termview', role: 'dialog', 'aria-label': 'Terminal' },
    h('div', { class: 'tbar' },
      h('button', { class: 'iconbtn', 'aria-label': 'Tutup layar terminal', onclick: () => close() }, ic('back')),
      tabs,
      h('button', { class: 'iconbtn', 'aria-label': 'Terminal baru', onclick: () => openNew() }, ic('plus')),
    ),
    h('div', { class: 'tbody' }, screen, empty),
    keys,
  );
  document.body.append(view);
  term.open(screen);
  const syncSize = () => {
    if (!view.isConnected) return;
    try {
      fit.fit();
    } catch {}
  };
  syncSize();
  if (coarse) {
    mobileInput(term);
    let fontT;
    pinchFont(term, screen, (size) => {
      syncSize();
      clearTimeout(fontT);
      fontT = setTimeout(() => store.set('termFont', size), 300);
    });
  }

  // --- input: dikumpulkan per ~8ms jadi satu RPC (ketikan cepat / tempel teks) ---
  let inq = '';
  let inT = null;
  const flushIn = () => {
    inT = null;
    const d = inq;
    inq = '';
    if (d && cur) app.conn.call('termIn', { tid: cur, d }).catch((e) => toast(e.message, true));
  };
  const sendIn = (d) => {
    if (!cur || !d) return;
    inq += d;
    inT ??= setTimeout(flushIn, 8);
  };
  const applyMods = (d) => {
    if (mods.ctrl) d = ctrlKey(d);
    if (mods.alt) d = '\x1b' + d;
    if (mods.ctrl || mods.alt) ((mods.ctrl = mods.alt = false), renderKeys());
    return d;
  };
  term.onData((d) => sendIn(applyMods(d)));

  // --- ukuran: PTY di PC mengikuti ukuran layar terakhir yang membuka terminal itu ---
  let rsT;
  term.onResize(({ cols, rows }) => {
    clearTimeout(rsT);
    rsT = setTimeout(() => cur && app.conn.call('termResize', { tid: cur, cols, rows }).catch(() => {}), 120);
  });
  const ro = new ResizeObserver(syncSize);
  ro.observe(screen);

  // --- tombol ekstra ---
  const arrow = (c) => (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c;
  // Menekan lama layar xterm di HP tidak memunculkan menu Tempel: isi clipboard dikirim lewat tombol,
  // memakai term.paste (bracketed paste bila shell memintanya, baris baru jadi Enter).
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
      else toast('Clipboard kosong');
    } catch {
      toast('Izinkan akses clipboard untuk menempel.', true);
    }
  };
  const KEYS = [
    ['Esc', () => '\x1b'],
    ['Tab', () => '\t'],
    ['Ctrl', 'ctrl'],
    ['Alt', 'alt'],
    ['←', () => arrow('D')],
    ['↓', () => arrow('B')],
    ['↑', () => arrow('A')],
    ['→', () => arrow('C')],
    ['Tempel', 'paste'],
    ['^C', () => '\x03'],
    ['Home', () => arrow('H')],
    ['End', () => arrow('F')],
    ['|', () => '|'],
    ['~', () => '~'],
    ['/', () => '/'],
    ['-', () => '-'],
  ];
  const renderKeys = () =>
    keys.replaceChildren(
      ...KEYS.map(([label, act]) =>
        h('button', {
          class: 'tk' + (typeof act === 'string' && mods[act] ? ' on' : ''),
          'aria-label': label === '^C' ? 'Ctrl+C' : null,
          // Jangan ambil fokus dari xterm: keyboard HP tetap terbuka.
          onpointerdown: (e) => e.preventDefault(),
          onclick: () => {
            haptic(5);
            if (act === 'paste') paste();
            else if (typeof act === 'string') (mods[act] = !mods[act]), renderKeys();
            else sendIn(applyMods(act()));
            term.focus();
          },
        }, label),
      ),
    );
  renderKeys();

  const renderTabs = () => {
    tabs.replaceChildren(
      ...list.map((t) =>
        h('div', { class: 'ttab' + (t.tid === cur ? ' on' : '') },
          h('button', { class: 'tt', onclick: () => t.tid !== cur && attach(t.tid) }, t.title),
          t.tid === cur ? h('button', { class: 'tx', 'aria-label': 'Tutup ' + t.title, onclick: () => closeTerm(t) }, ic('x')) : null,
        ),
      ),
    );
    empty.hidden = !!cur;
    screen.hidden = !cur;
    if (cur) syncSize();
  };

  const show = (r) => {
    cur = r.tid;
    term.reset();
    term.write(r.buf || '');
    renderTabs();
    if (r.cols !== term.cols || r.rows !== term.rows) app.conn.call('termResize', { tid: cur, cols: term.cols, rows: term.rows }).catch(() => {});
    term.focus();
  };
  const attach = async (tid) => {
    if (cur && cur !== tid) app.conn.call('termDetach', { tid: cur }).catch(() => {});
    try {
      show(await app.conn.call('termAttach', { tid }));
    } catch (e) {
      list = list.filter((t) => t.tid !== tid);
      cur = null;
      renderTabs();
      toast(e.message, true);
    }
  };
  const openNew = async () => {
    if (cur) app.conn.call('termDetach', { tid: cur }).catch(() => {});
    try {
      syncSize();
      const r = await app.conn.call('termOpen', { id: s.id, cols: term.cols, rows: term.rows });
      list.push({ tid: r.tid, title: r.title });
      show(r);
    } catch (e) {
      toast(isOldDaemon(e) ? 'Perbarui snugcode di PC untuk terminal interaktif.' : e.message, true);
      renderTabs();
    }
  };
  const closeTerm = async (t) => {
    if (!(await ui.confirm({ title: `Tutup ${t.title}?`, text: 'Shell dan proses yang berjalan di dalamnya dihentikan.', ok: 'Tutup', danger: true, icon: 'term' }))) return term.focus();
    await app.conn.call('termClose', { tid: t.tid }).catch(() => {});
    list = list.filter((x) => x.tid !== t.tid);
    cur = null;
    if (list.length) attach(list.at(-1).tid);
    else renderTabs();
  };

  app.current.onTerm = (m) => {
    if (m.tid !== cur) return;
    if (m.d) term.write(m.d);
    if (m.exit != null) {
      term.write(`\r\n\x1b[2m[shell selesai · kode ${m.exit}]\x1b[0m\r\n`);
      list = list.filter((t) => t.tid !== m.tid);
      cur = null;
      renderTabs();
      empty.hidden = true;
      screen.hidden = false;
    }
  };
  // Tersambung lagi setelah koneksi putus: berlangganan ulang & putar ulang output.
  app.current.onTermReady = () => cur && attach(cur);

  function close() {
    flushIn();
    ro.disconnect();
    if (cur) app.conn.call('termDetach', { tid: cur }).catch(() => {});
    app.current.onTerm = app.current.onTermReady = null;
    view.classList.add('closing');
    setTimeout(() => (term.dispose(), view.remove()), 200);
  }

  try {
    list = (await app.conn.call('termList', { id: s.id })).map((t) => ({ tid: t.tid, title: t.title }));
  } catch (e) {
    if (isOldDaemon(e)) return close(), toast('Perbarui snugcode di PC untuk terminal interaktif.', true);
  }
  if (list.length) await attach(list.at(-1).tid);
  else await openNew();
}
