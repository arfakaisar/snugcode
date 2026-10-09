// Utilitas DOM bersama: elemen, ikon, viewport, toast, header/layar/sheet, markdown.
import { md as mdRender } from '../md.js';
import { app } from './state.js';

// ---------- util ----------
export const $ = (s) => document.querySelector(s);
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
// replaceChildren/append bawaan mengubah null menjadi teks "null"; banyak tampilan
// memakai pola `kondisi ? elemen : null`, jadi nilai kosong diabaikan di sini.
for (const method of ['replaceChildren', 'append']) {
  const orig = Element.prototype[method];
  Element.prototype[method] = function (...kids) {
    return orig.apply(this, kids.flat().filter((k) => k != null && k !== false));
  };
}
export const coarse = matchMedia('(pointer: coarse)').matches;
export const haptic = (/** @type {number | number[]} */ ms = 12) => navigator.vibrate?.(ms);
export function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt';
  if (s < 86400) return Math.floor(s / 3600) + ' jam';
  return Math.floor(s / 86400) + ' hari';
}
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = h('textarea', { style: 'position:fixed;opacity:0;font-size:16px' });
    t.value = text;
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

// ---------- ikon (SVG statis) ----------
export const P = {
  back: '<path d="m15 18-6-6 6-6"/>',
  dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9a6 6 0 0 1-6 6H8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  arrowdown: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  push: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>',
  pr: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4"/><path d="m13 4-2 2 2 2"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  diff: '<path d="M12 3v14M5 10h14"/><path d="M5 21h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  unlink: '<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 4 8M8 12h4M2 2l20 20"/>',
  term: '<path d="m5 8 4 4-4 4M12 16h7"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M12 20v-9M3 13h5M16 13h5M4 7l4 2M20 7l-4 2M4 19l4-2M20 19l-4-2M9 4l1.5 2M15 4l-1.5 2"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7 15h10"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
  github: '<path fill="currentColor" stroke="none" d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0C17.3 4.8 18.3 5 18.3 5c.7 1.6.3 2.8.1 3.1.8.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5z"/>',
};
/** @returns {SVGElement} */
export function ic(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  return /** @type {SVGElement} */ (t.content.firstChild);
}

// ---------- viewport: shell mengikuti area yang benar-benar terlihat ----------
// iOS tidak mengecilkan layout saat keyboard muncul; tanpa ini composer
// tertutup keyboard dan halaman ikut bergeser.
export const vv = window.visualViewport;
export let kbOpen = false;
export function syncViewport() {
  const hgt = vv ? vv.height : window.innerHeight;
  const top = vv ? Math.max(0, vv.offsetTop) : 0;
  const root = document.documentElement.style;
  root.setProperty('--app-h', hgt + 'px');
  root.setProperty('--app-top', top + 'px');
  const open = vv ? window.innerHeight - vv.height > 140 || (document.activeElement?.matches?.('input,textarea') && screen.height - hgt > 260) : false;
  if (open !== kbOpen) {
    kbOpen = open;
    document.documentElement.classList.toggle('kb', open);
  }
  document.documentElement.classList.toggle('short', hgt < 520);
  if (window.scrollY) window.scrollTo(0, 0);
  app.current?.renderer?.keepBottom();
}
vv?.addEventListener('resize', syncViewport);
vv?.addEventListener('scroll', syncViewport);
window.addEventListener('resize', syncViewport);
window.addEventListener('orientationchange', () => setTimeout(syncViewport, 250));
document.addEventListener('focusin', () => setTimeout(syncViewport, 60));
document.addEventListener('focusout', () => setTimeout(syncViewport, 120));
syncViewport();

// ---------- toast ----------
export function toast(msg, bad = false, ms = 3200) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, h('span', { class: 'ic' }, bad ? '✕' : '✓'), h('span', {}, msg));
  const kill = () => {
    if (el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  el.onclick = kill;
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(kill, ms);
  if (bad) haptic(30);
}

// ---------- header / layar / sheet ----------
/**
 * @typedef {{ icon: string, label: string, onclick: () => void }} HeaderAction
 * @typedef {{ sub?: string, back?: () => void, actions?: HeaderAction[], dot?: string }} HeaderOpts
 * @typedef {{ sub?: string, back?: () => void, close?: boolean }} SheetHeadOpts
 */
export const ui = {
  /** @param {string} title @param {HeaderOpts} [opts] */
  set(title, { sub = '', back, actions = [], dot = 'none' } = {}) {
    $('#titleText').textContent = title;
    $('#subText').textContent = sub;
    const b = $('#back');
    b.hidden = !back;
    b.replaceChildren(ic('back'));
    b.onclick = back || null;
    $('#actions').replaceChildren(...actions.map((a) => h('button', { class: 'iconbtn', 'aria-label': a.label, title: a.label, onclick: a.onclick }, ic(a.icon))));
    this.dot(dot);
  },
  sub(text) {
    $('#subText').textContent = text;
  },
  dot(state) {
    $('#dot').className = state || '';
  },
  view(...kids) {
    const v = $('#view');
    v.replaceChildren(...kids);
    kids[0]?.classList?.add('screen-enter');
    return v;
  },
  sheet(...kids) {
    const s = $('#sheet');
    clearTimeout(this.closeT);
    s.classList.remove('closing');
    $('#sheetBody').replaceChildren(...kids);
    $('#sheetBody').scrollTop = 0;
    if (s.hidden) {
      s.hidden = false;
      $('#sheetPanel').style.transform = '';
    }
  },
  closeSheet() {
    const s = $('#sheet');
    if (s.hidden || s.classList.contains('closing')) return;
    /** @type {HTMLElement} */ (document.activeElement)?.blur?.();
    s.classList.add('closing');
    this.closeT = setTimeout(() => {
      s.hidden = true;
      s.classList.remove('closing');
      $('#sheetBody').replaceChildren();
    }, 210);
  },
  /** @param {string} title @param {SheetHeadOpts} [opts] */
  head(title, { sub, back, close = true } = {}) {
    return h('div', { class: 'sheethead' },
      back ? h('button', { class: 'iconbtn small', 'aria-label': 'Kembali', onclick: back }, ic('back')) : null,
      h('h2', {}, title, sub ? h('span', { class: 'sub' }, sub) : null),
      close ? h('button', { class: 'iconbtn small', 'aria-label': 'Tutup', onclick: () => ui.closeSheet() }, ic('x')) : null,
    );
  },
};
$('#sheetBackdrop').addEventListener('click', () => ui.closeSheet());
document.addEventListener('keydown', (e) => e.key === 'Escape' && ui.closeSheet());
// Geser handle sheet ke bawah untuk menutup.
(() => {
  const grab = $('#sheetGrab');
  const panel = $('#sheetPanel');
  let y0 = null;
  let dy = 0;
  grab.addEventListener('pointerdown', (e) => {
    y0 = e.clientY;
    dy = 0;
    grab.setPointerCapture(e.pointerId);
    panel.style.transition = 'none';
  });
  grab.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    panel.style.transition = 'transform .2s ease';
    if (dy > 90) ui.closeSheet();
    else panel.style.transform = '';
    setTimeout(() => (panel.style.transition = ''), 220);
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
})();

export const loading = (text) => h('div', { class: 'loading' }, h('span', { class: 'spinner' }), text);
export const skeletons = (n = 3) => h('div', {}, ...Array.from({ length: n }, () => h('div', { class: 'skeleton' })));
export const scrollCol = (...kids) => h('div', { class: 'scroll' }, h('div', { class: 'col' }, ...kids));
/** @param {{ icon: string, t1: *, t2?: *, onclick?: (ev: MouseEvent) => *, danger?: boolean, chev?: boolean }} item */
export function menuItem({ icon, t1, t2, onclick, danger, chev = true }) {
  return h('button', { class: 'menuitem' + (danger ? ' danger' : ''), onclick },
    h('span', { class: 'mi' }, ic(icon)),
    h('span', { class: 'grow' }, h('div', { class: 't1' }, t1), t2 ? h('div', { class: 't2' }, t2) : null),
    chev ? ic('right', 'chev') : null,
  );
}
export function busyButton(btn, label) {
  const prev = [...btn.childNodes];
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'spinner' }), label);
  return () => {
    btn.disabled = false;
    btn.replaceChildren(...prev);
  };
}

// ---------- Markdown (aman: semua teks di-escape) ----------
export let copyIconHtml = null;
export const md = (src) => mdRender(src, { copyIcon: (copyIconHtml ??= ic('copy').outerHTML) });
export const isOldDaemon = (e) => /Metode tidak dikenal/.test(e?.message || '');
