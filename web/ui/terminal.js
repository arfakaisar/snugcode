// Interactive terminal on the phone: xterm.js (loaded on first open) + an extra key row (Esc, Tab,
// Ctrl, Alt, arrows, …) for phone keyboards. The shell lives on the PC: closing this screen doesn't kill it,
// and reopening replays the latest output.
import { app } from './state.js';
import { store } from '../conn.js';
import { coarse, copyText, h, haptic, ic, isOldDaemon, toast, ui } from './dom.js';
import { ctrlKey, imeDelta } from '../termkeys.js';

/** @type {Promise<typeof import('../xterm.js')> | null} */
let lib = null;
function loadLib() {
  if (!document.querySelector('link[data-xterm]')) document.head.append(h('link', { rel: 'stylesheet', href: 'xterm.css', 'data-xterm': true }));
  // Separate bundle (scripts/build-web.mjs): app.js stays light for people who don't use the terminal.
  lib ??= import(new URL('xterm.js', document.baseURI).href).catch((e) => {
    lib = null;
    throw e;
  });
  return lib;
}

// Downloaded while the phone is idle once a session with a terminal opens (the service worker caches it), so
// opening the terminal on a weak signal doesn't fail to load. Only downloaded, not executed.
let prefetched = false;
export function prefetchTerminal() {
  if (prefetched) return;
  prefetched = true;
  const go = () => {
    for (const f of ['xterm.js', 'xterm.css']) fetch(new URL(f, document.baseURI), /** @type {RequestInit} */ ({ priority: 'low' })).catch(() => (prefetched = false));
  };
  'requestIdleCallback' in window ? requestIdleCallback(go, { timeout: 5000 }) : setTimeout(go, 2000);
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// xterm's default ANSI palette is made for dark backgrounds; the light theme uses deeper colors.
const LIGHT_ANSI = { black: '#1f1e1d', red: '#b3261e', green: '#2e7d32', yellow: '#8a6100', blue: '#1f5fbf', magenta: '#8e3fa8', cyan: '#0f7c80', white: '#6b6a64', brightBlack: '#6b6a64', brightRed: '#c4432f', brightGreen: '#3f8f5a', brightYellow: '#a8741a', brightBlue: '#2f6fb8', brightMagenta: '#7a5bd1', brightCyan: '#2a8a86', brightWhite: '#1f1e1d' };
function themeOf() {
  const bg = css('--code-bg');
  const rgb = (bg.match(/[\da-f]{2}/gi) || []).map((x) => parseInt(x, 16));
  const light = rgb.length === 3 && rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150;
  return { background: bg, foreground: css('--fg'), cursor: css('--accent'), cursorAccent: bg, selectionBackground: css('--accent-soft') || 'rgba(217,119,87,.3)', ...(light ? LIGHT_ANSI : {}) };
}

// Phone keyboards type through IME composition: xterm.js only forwards a word once committed (space/Enter)
// and keystrokes with keydown 229 outside a composition can get lost, so on Android the terminal looks frozen
// while typing. On touch screens, changes to xterm's helper textarea are sent ourselves as they happen,
// as a diff (imeDelta) — including autocorrect, swipe typing, and voice input. Composition & input events
// are stopped at the parent (capture phase) before reaching xterm's textarea listeners.
function mobileInput(term) {
  const ta = term.textarea;
  const host = term.element;
  if (!ta || !host) return;
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('enterkeyhint', 'enter');
  let prev = ta.value;
  let composing = false;
  // Characters from keypress were already sent by xterm, which doesn't cancel the event (e.g. a physical
  // keyboard space): text that then lands in the textarea is only recorded, not sent again.
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
    // Committed words pile up in the textarea: cleared after Enter / when long, outside a composition.
    if (!composing && (prev.length > 256 || prev.includes('\n'))) ta.value = prev = '';
  }, true);
  // keydown 229 = "via IME": handled by the input event above. Other keys (Enter, Backspace on an empty
  // textarea, arrows & physical keyboards) are still handled by xterm, which may clear the textarea (Enter, ^C):
  // the next diff is computed from the content after xterm's listener finishes.
  term.attachCustomKeyEventHandler((e) => {
    if (e.keyCode === 229) return false;
    if (e.type === 'keydown') {
      keyPressed = false;
      queueMicrotask(() => (prev = ta.value));
    } else if (e.type === 'keypress') keyPressed = !!e.charCode && !e.ctrlKey && !e.altKey && !e.metaKey;
    return true;
  });
}

// A two-finger pinch on the terminal changes the font size (page zoom is locked like a native app).
// Capture phase: xterm's viewport handles touches itself and doesn't pass them to the parent.
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
    return toast('Couldn’t load the terminal. Check the connection and try again.', true);
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
  const empty = h('div', { class: 'tempty', hidden: true }, h('div', { class: 'dim small' }, 'No terminals open.'), h('button', { class: 'btn primary', onclick: () => openNew() }, ic('plus'), 'Open a terminal'));
  const keys = h('div', { class: 'tkeys' });
  const view = h('div', { class: 'termview', role: 'dialog', 'aria-label': 'Terminal' },
    h('div', { class: 'tbar' },
      h('button', { class: 'iconbtn', 'aria-label': 'Close terminal screen', onclick: () => close() }, ic('back')),
      tabs,
      h('button', { class: 'iconbtn', 'aria-label': 'New terminal', onclick: () => openNew() }, ic('plus')),
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

  // --- input: batched per ~8ms into one RPC (fast typing / pasted text) ---
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

  // --- size: the PTY on the PC follows the last screen that opened that terminal ---
  let rsT;
  term.onResize(({ cols, rows }) => {
    clearTimeout(rsT);
    rsT = setTimeout(() => cur && app.conn.call('termResize', { tid: cur, cols, rows }).catch(() => {}), 120);
  });
  const ro = new ResizeObserver(syncSize);
  ro.observe(screen);

  // --- extra keys ---
  const arrow = (c) => (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c;
  // Long-pressing xterm on a phone doesn't bring up a Paste menu: clipboard content is sent via a button,
  // using term.paste (bracketed paste when the shell asks for it, newlines become Enter).
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
      else toast('Clipboard is empty');
    } catch {
      toast('Allow clipboard access to paste.', true);
    }
  };
  // Selecting on xterm's canvas is hard on touch screens: with no selection, the whole screen is copied
  // (wrapped lines are joined back).
  const copy = async () => {
    let text = term.getSelection();
    if (!text) {
      const b = term.buffer.active;
      for (let i = 0; i < term.rows; i++) {
        const line = b.getLine(b.viewportY + i);
        if (!line) break;
        text += (i && !line.isWrapped ? '\n' : '') + line.translateToString(!b.getLine(b.viewportY + i + 1)?.isWrapped);
      }
      text = text.replace(/\s+$/, '');
    }
    if (text && (await copyText(text))) toast(term.hasSelection() ? 'Selection copied' : 'Screen copied');
    term.focus();
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
    ['Paste', 'paste'],
    ['Copy', 'copy'],
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
          // Don't steal focus from xterm: the phone keyboard stays open.
          onpointerdown: (e) => e.preventDefault(),
          onclick: () => {
            haptic(5);
            if (act === 'paste') paste();
            else if (act === 'copy') copy();
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
          t.tid === cur ? h('button', { class: 'tx', 'aria-label': 'Close ' + t.title, onclick: () => closeTerm(t) }, ic('x')) : null,
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
      toast(isOldDaemon(e) ? 'Update snugcode on the PC for the interactive terminal.' : e.message, true);
      renderTabs();
    }
  };
  const closeTerm = async (t) => {
    if (!(await ui.confirm({ title: `Close ${t.title}?`, text: 'The shell and any processes running in it will be stopped.', ok: 'Close', danger: true, icon: 'term' }))) return term.focus();
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
      term.write(`\r\n\x1b[2m[shell exited · code ${m.exit}]\x1b[0m\r\n`);
      list = list.filter((t) => t.tid !== m.tid);
      cur = null;
      renderTabs();
      empty.hidden = true;
      screen.hidden = false;
    }
  };
  // Reconnected after a drop: resubscribe & replay output.
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
    if (isOldDaemon(e)) return close(), toast('Update snugcode on the PC for the interactive terminal.', true);
  }
  if (list.length) await attach(list.at(-1).tid);
  else await openNew();
}
