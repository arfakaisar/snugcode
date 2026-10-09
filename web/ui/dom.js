// Utilitas DOM bersama: elemen, ikon, tema, viewport, toast, header/layar/sheet/drawer,
// gestur sentuh (tarik sheet, geser drawer, tarik-untuk-muat-ulang, tekan lama), markdown.
// Semua animasi hanya memakai transform/opacity (CSS atau Web Animations) agar ringan di HP.
import { md as mdRender } from '../md.js';
import { store } from '../conn.js';
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
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
export const haptic = (/** @type {number | number[]} */ ms = 12) => navigator.vibrate?.(ms);
// Animasi sekali jalan lewat Web Animations API (tanpa reflow paksa); dilewati bila gerak dikurangi.
/** @param {Element | null | undefined} el @param {Keyframe[]} frames @param {number | KeyframeAnimationOptions} [opts] */
export function anim(el, frames, opts = 260) {
  if (!el?.animate || reduce.matches) return null;
  return el.animate(frames, typeof opts === 'number' ? { duration: opts, easing: 'cubic-bezier(.2,.8,.2,1)' } : { easing: 'cubic-bezier(.2,.8,.2,1)', ...opts });
}
export const pop = (el) => anim(el, [{ transform: 'scale(.6)', opacity: 0.4 }, { transform: 'scale(1.12)', offset: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 360 });
export function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt';
  if (s < 86400) return Math.floor(s / 3600) + ' jam';
  return Math.floor(s / 86400) + ' hari';
}
export function greeting() {
  const hr = new Date().getHours();
  return hr < 4 ? 'Selamat malam' : hr < 11 ? 'Selamat pagi' : hr < 15 ? 'Selamat siang' : hr < 18 ? 'Selamat sore' : 'Selamat malam';
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
  menu: '<path d="M4 8h16M4 16h10"/>',
  home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  compose: '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M17.6 2.6a2 2 0 0 1 2.8 2.8L12 13.8l-3.6.8.8-3.6z"/>',
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
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14.5 8.5l2 2"/>',
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
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/><circle cx="12" cy="12" r="6.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.6 6.6 0 0 0 10 10z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  github: '<path fill="currentColor" stroke="none" d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0C17.3 4.8 18.3 5 18.3 5c.7 1.6.3 2.8.1 3.1.8.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5z"/>',
};
/** @returns {SVGElement} */
export function ic(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  return /** @type {SVGElement} */ (t.content.firstChild);
}
// Maskot "Snug": mochi clay bertopi tidur bintang, berselimut, dengan "zzz". Semua gerak ada di CSS:
//   (bawaan) tidur: bernapas, topi bergoyang, zzz melayang
//   think       : bangun & bekerja — mata berkedip, kepala mengangguk, kaki "mengetik", titik berpikir
//   draw        : muncul meletup (squash & stretch) lalu selimut naik
//   tap         : bisa dicolek — melompat kaget sebentar
const MASCOT = `<ellipse class="m-shadow" cx="32" cy="58.6" rx="21" ry="2.4"/>
<g class="m-bob"><g class="m-breath">
<path class="m-body" d="M13 50C13 33 21 21.5 32 21.5S51 33 51 50Z"/>
<g class="m-face">
<g class="m-sleep"><path d="M23.4 37.2q3 3 6 0"/><path d="M34.6 37.2q3 3 6 0"/></g>
<g class="m-open"><ellipse cx="26.4" cy="37.6" rx="2" ry="2.5"/><ellipse cx="37.6" cy="37.6" rx="2" ry="2.5"/></g>
<ellipse class="m-blush" cx="21.6" cy="42" rx="2.8" ry="1.7"/><ellipse class="m-blush" cx="42.4" cy="42" rx="2.8" ry="1.7"/>
<ellipse class="m-mouth" cx="32" cy="42.3" rx="1.4" ry="1.2"/>
</g>
<g class="m-cap"><path class="m-capb" d="M15.5 32.5C16 22.5 24 16.5 33.5 16.5c8.5 0 15.5 3.5 19.5 10.5 2.5 4.5 4 8 4.2 11.5.2 1.9-1.6 2.5-2.4.9-1.4-3.4-3.8-6.9-7.6-9.2-7.7-3.2-23.2-2.8-31.7 2.3Z"/>
<path class="m-star" d="M27 22.2l.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z"/><circle class="m-star" cx="40.5" cy="21.5" r="1"/><circle class="m-star" cx="20.5" cy="27.6" r=".8"/><path class="m-band" d="M16.4 31.8C24.5 27 39 26.6 47.3 30"/><circle class="m-pom" cx="56" cy="40.4" r="3.4"/></g>
</g>
<g class="m-blanket"><path class="m-blk" d="M7 51c0-4.8 3.8-7 9.5-6.6 6 .4 10 2.6 15.5 2.6s9.5-2.2 15.5-2.6C53.2 44 57 46.2 57 51v3.5c0 1.9-1.4 3.1-3.4 3.1H10.4c-2 0-3.4-1.2-3.4-3.1Z"/>
<path class="m-stitch" d="M11.5 53.2h41"/><ellipse class="m-paw" cx="24.4" cy="45.6" rx="3.5" ry="2.5"/><ellipse class="m-paw" cx="39.6" cy="45.6" rx="3.5" ry="2.5"/></g>
</g>
<g class="m-zz"><path d="M45.5 15h3l-3 3.2h3"/><path d="M50.5 8.5h4l-4 4.2h4"/><path d="M56.5 1h5l-5 5.2h5"/></g>
<g class="m-dots"><circle cx="47" cy="16" r="1.7"/><circle cx="52.4" cy="12" r="2"/><circle cx="58.4" cy="7" r="2.3"/></g>`;
/** @returns {SVGElement} */
export function mascot(cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="mascot ${cls}" viewBox="0 0 64 64" aria-hidden="true">${MASCOT}</svg>`;
  const svg = /** @type {SVGElement} */ (t.content.firstChild);
  if (/\btap\b/.test(cls))
    svg.addEventListener('pointerdown', () => {
      haptic(10);
      svg.classList.remove('poke');
      requestAnimationFrame(() => svg.classList.add('poke'));
      clearTimeout(/** @type {any} */ (svg).pokeT);
      /** @type {any} */ (svg).pokeT = setTimeout(() => svg.classList.remove('poke'), 1400);
    });
  return svg;
}

// ---------- tema: sistem / terang / gelap ----------
export function applyTheme(t = store.get('theme') || 'system') {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  const meta = $('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim() || '#262624');
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => applyTheme());

// ---------- viewport: shell mengikuti area yang benar-benar terlihat ----------
// iOS tidak mengecilkan layout saat keyboard muncul; tanpa ini composer
// tertutup keyboard dan halaman ikut bergeser.
export const vv = window.visualViewport;
export let kbOpen = false;
export function syncViewport() {
  const vh = vv ? vv.height : window.innerHeight;
  const open = vv ? window.innerHeight - vv.height > 140 || (document.activeElement?.matches?.('input,textarea') && screen.height - vh > 260) : false;
  // --app-h/--app-top hanya dipakai saat keyboard terbuka (html.kb); selain itu shell menempel ke tepi
  // layar lewat CSS, karena di PWA iOS innerHeight/visualViewport bisa kurang sebesar status bar.
  const hgt = vh;
  const root = document.documentElement.style;
  root.setProperty('--app-h', vh + 'px');
  root.setProperty('--app-top', (open && vv ? Math.max(0, vv.offsetTop) : 0) + 'px');
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
  const el = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, h('span', { class: 'ic' }, ic(bad ? 'x' : 'check')), h('span', {}, msg));
  const kill = () => {
    if (el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
  };
  el.onclick = kill;
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(kill, ms);
  if (bad) haptic(30);
  return el;
}

// ---------- header / layar / sheet ----------
/**
 * @typedef {{ icon: string, label: string, onclick: () => void }} HeaderAction
 * @typedef {{ sub?: string, back?: () => void, menu?: boolean, actions?: (HeaderAction | Element)[], dot?: string, onTitle?: () => void, titleLabel?: string }} HeaderOpts
 * @typedef {{ sub?: string, back?: () => void, close?: boolean }} SheetHeadOpts
 * @typedef {{ title: string, text?: string, ok?: string, danger?: boolean, icon?: string, stay?: boolean }} ConfirmOpts
 */
export const ui = {
  /** Arah transisi layar berikutnya: 1 = maju, -1 = kembali. */
  dir: 1,
  sdir: 1,
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  closeT: undefined,
  /** @type {(() => void) | null} */
  onDismiss: null,
  /** @param {string} title @param {HeaderOpts} [opts] */
  set(title, { sub = '', back, menu = false, actions = [], dot = 'none', onTitle, titleLabel } = {}) {
    const tt = $('#titleText');
    if (tt.textContent !== title) {
      tt.textContent = title;
      anim($('#title'), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 280);
    }
    $('#subText').textContent = sub;
    const b = $('#back');
    b.hidden = !back;
    b.onclick = back ? () => ((ui.dir = -1), back()) : null;
    $('#menuBtn').hidden = !menu || !!back;
    drawer.enabled = menu;
    const t = $('#title');
    t.onclick = onTitle ? () => (haptic(6), onTitle()) : null;
    t.classList.toggle('tap', !!onTitle);
    t.tabIndex = onTitle ? 0 : -1;
    if (onTitle) t.setAttribute('aria-label', titleLabel || title);
    else t.removeAttribute('aria-label');
    $('#actions').replaceChildren(...actions.map((a) => ('nodeType' in a ? a : h('button', { class: 'iconbtn', 'aria-label': a.label, title: a.label, onclick: a.onclick }, ic(a.icon)))));
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
    kids[0]?.classList?.add(this.dir < 0 ? 'screen-back' : 'screen-enter');
    this.dir = 1;
    return v;
  },
  sheet(...kids) {
    const s = $('#sheet');
    const body = $('#sheetBody');
    clearTimeout(this.closeT);
    this.dismiss();
    const wasOpen = !s.hidden && !s.classList.contains('closing');
    s.classList.remove('closing');
    body.replaceChildren(...kids);
    body.scrollTop = 0;
    if (s.hidden) {
      s.hidden = false;
      $('#sheetPanel').style.transform = '';
      if (drawer.open) drawer.close();
    } else if (wasOpen) anim(body, [{ opacity: 0, transform: `translateX(${this.sdir * 18}px)` }, { opacity: 1, transform: 'none' }], 240);
    this.sdir = 1;
  },
  closeSheet() {
    const s = $('#sheet');
    if (s.hidden || s.classList.contains('closing')) return;
    /** @type {HTMLElement} */ (document.activeElement)?.blur?.();
    this.dismiss();
    s.classList.add('closing');
    this.closeT = setTimeout(() => {
      s.hidden = true;
      s.classList.remove('closing');
      $('#sheetPanel').style.transform = '';
      $('#sheetBody').replaceChildren();
    }, 260);
  },
  dismiss() {
    const f = this.onDismiss;
    this.onDismiss = null;
    f?.();
  },
  /** @param {string} title @param {SheetHeadOpts} [opts] */
  head(title, { sub, back, close = true } = {}) {
    return h('div', { class: 'sheethead' },
      back ? h('button', { class: 'iconbtn small', 'aria-label': 'Kembali', onclick: () => ((ui.sdir = -1), back()) }, ic('back')) : null,
      h('h2', {}, title, sub ? h('span', { class: 'sub' }, sub) : null),
      close ? h('button', { class: 'iconbtn small', 'aria-label': 'Tutup', onclick: () => ui.closeSheet() }, ic('x')) : null,
    );
  },
  // Pengganti confirm(): sheet dengan ikon, teks, Batal / OK. `stay` = sheet tetap terbuka setelah OK
  // (pemanggil langsung mengganti isinya, mis. menampilkan progres).
  /** @param {ConfirmOpts} o @returns {Promise<boolean>} */
  confirm({ title, text, ok = 'Lanjut', danger = false, icon = 'alert', stay = false }) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => {
        if (done) return;
        done = true;
        if (this.onDismiss === cancel) this.onDismiss = null;
        resolve(v);
      };
      const cancel = () => fin(false);
      const okBtn = h('button', { class: 'btn ' + (danger ? 'dangerfill' : 'primary'), onclick: () => (haptic(12), fin(true), stay || this.closeSheet()) }, ok);
      this.sheet(
        h('div', { class: 'confirm' },
          h('div', { class: 'cicon' + (danger ? ' danger' : '') }, ic(icon)),
          h('h2', {}, title),
          text ? h('p', {}, text) : null,
          h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: () => this.closeSheet() }, 'Batal'), okBtn),
        ),
      );
      this.onDismiss = cancel;
      haptic(danger ? [20, 40, 20] : 10);
    });
  },
};
$('#back').append(ic('back'));
$('#menuBtn').append(ic('menu'));
$('#menuBtn').addEventListener('click', () => drawer.show());
$('#titleRow').append(ic('down', 'tchev'));
$('#sheetBackdrop').addEventListener('click', () => ui.closeSheet());
document.addEventListener('keydown', (e) => e.key === 'Escape' && (drawer.open ? drawer.close() : ui.closeSheet()));

const wide = matchMedia('(min-width: 720px)');
// Tarik sheet ke bawah untuk menutup: dari handle, judul, atau isi yang sudah di paling atas.
(() => {
  const panel = $('#sheetPanel');
  const body = $('#sheetBody');
  let y0 = null;
  let x0 = 0;
  let dy = 0;
  let t0 = 0;
  let drag = false;
  panel.addEventListener('touchstart', (e) => {
    if (wide.matches || e.touches.length > 1) return;
    const tgt = /** @type {Element} */ (e.target);
    const onTop = tgt.closest('#sheetGrab, .sheethead');
    if (!onTop && (body.scrollTop > 0 || tgt.closest('textarea, input[type=range], pre, .dfb, .diffmini, .mlist .effort, .tiles, .qsh'))) return;
    y0 = e.touches[0].clientY;
    x0 = e.touches[0].clientX;
    dy = 0;
    drag = false;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const t = e.touches[0];
    dy = t.clientY - y0;
    if (!drag) {
      if (Math.abs(dy) < 8 && Math.abs(t.clientX - x0) < 8) return;
      if (dy <= 0 || Math.abs(t.clientX - x0) > Math.abs(dy) || body.scrollTop > 0) return void (y0 = null);
      drag = true;
      t0 = performance.now();
      y0 = t.clientY;
      dy = 0;
      panel.style.transition = 'none';
    }
    e.preventDefault();
    panel.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    if (!drag) return;
    drag = false;
    const v = dy / Math.max(1, performance.now() - t0);
    panel.style.transition = '';
    if (dy > 110 || (dy > 30 && v > 0.6)) {
      haptic(8);
      ui.closeSheet();
    } else panel.style.transform = '';
  };
  panel.addEventListener('touchend', end);
  panel.addEventListener('touchcancel', end);
})();

// ---------- drawer samping (gaya aplikasi chat) ----------
// Isi drawer dibuat ulang setiap dibuka (drawer.build, diisi sessions.js) dan dikosongkan saat
// ditutup, jadi tidak ada elemen tersembunyi yang ikut terhitung di layar utama.
export const drawer = {
  enabled: false,
  open: false,
  /** @type {(() => Element[]) | null} */
  build: null,
  mount() {
    if (!this.build) return false;
    clearTimeout(this.t);
    $('#drawerPanel').replaceChildren(...this.build());
    $('#drawer').hidden = false;
    return true;
  },
  show() {
    if (!this.enabled || this.open || !this.mount()) return;
    haptic(8);
    /** @type {HTMLElement} */ (document.activeElement)?.blur?.();
    requestAnimationFrame(() => requestAnimationFrame(() => this.setOpen(true)));
  },
  setOpen(on) {
    this.open = on;
    document.documentElement.classList.toggle('drawer-open', on);
    if (!on) this.t = setTimeout(() => this.open || (($('#drawer').hidden = true), $('#drawerPanel').replaceChildren()), 380);
  },
  close() {
    if (this.open) this.setOpen(false);
  },
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  t: undefined,
};
$('#drawerScrim').addEventListener('click', () => drawer.close());
// Geser dari tepi kiri untuk membuka, geser ke kiri untuk menutup.
(() => {
  const panel = $('#drawerPanel');
  const scrim = $('#drawerScrim');
  const appEl = $('#app');
  const root = document.documentElement;
  let x0 = 0;
  let y0 = 0;
  let mode = '';
  let p = 0;
  let w = 300;
  let last = 0;
  let lastT = 0;
  let vx = 0;
  const setP = (v) => {
    p = Math.max(0, Math.min(1, v));
    panel.style.transform = `translateX(${(p - 1) * 100}%)`;
    scrim.style.opacity = String(p);
    appEl.style.transform = `translateX(${p * w * 0.28}px)`;
  };
  document.addEventListener('touchstart', (e) => {
    mode = '';
    if (!drawer.enabled || !$('#sheet').hidden || e.touches.length > 1) return;
    const t = e.touches[0];
    if (!drawer.open && t.clientX > 26) return;
    x0 = last = t.clientX;
    y0 = t.clientY;
    lastT = performance.now();
    vx = 0;
    mode = 'pending';
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!mode) return;
    const t = e.touches[0];
    const mx = t.clientX - x0;
    const my = t.clientY - y0;
    if (mode === 'pending') {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      if (Math.abs(my) > Math.abs(mx) || (drawer.open ? mx > 0 : mx < 0)) return void (mode = '');
      if (!drawer.open && !drawer.mount()) return void (mode = '');
      mode = 'drag';
      w = panel.offsetWidth || 300;
      root.classList.add('drawer-drag');
    }
    const now = performance.now();
    vx = (t.clientX - last) / Math.max(1, now - lastT);
    last = t.clientX;
    lastT = now;
    setP((drawer.open ? 1 : 0) + mx / w);
  }, { passive: true });
  const end = () => {
    if (mode !== 'drag') return void (mode = '');
    mode = '';
    root.classList.remove('drawer-drag');
    const on = vx > 0.35 ? true : vx < -0.35 ? false : p > 0.5;
    panel.style.transform = scrim.style.opacity = appEl.style.transform = '';
    if (on && !drawer.open) haptic(8);
    drawer.setOpen(on);
  };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);
})();

// ---------- gestur kecil ----------
// Tarik ke bawah di paling atas daftar untuk memuat ulang (hanya layar sentuh).
/** @param {HTMLElement} scroller @param {() => *} onRefresh */
export function pullToRefresh(scroller, onRefresh) {
  if (!coarse) return;
  const ind = h('div', { class: 'ptr' }, mascot('think'));
  scroller.prepend(ind);
  let y0 = null;
  let pull = 0;
  const content = () => /** @type {HTMLElement} */ (scroller.children[1]);
  scroller.addEventListener('touchstart', (e) => {
    y0 = scroller.scrollTop <= 0 ? e.touches[0].clientY : null;
    pull = 0;
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy <= 0 || scroller.scrollTop > 0) {
      if (pull) ((pull = 0), (content().style.transform = ''), (ind.style.opacity = '0'));
      return;
    }
    const was = pull > 70;
    pull = Math.min(120, dy * 0.45);
    if (pull > 70 && !was) haptic(8);
    content().style.transition = 'none';
    content().style.transform = `translateY(${pull}px)`;
    ind.style.opacity = String(Math.min(1, pull / 70));
    ind.style.transform = `translateX(-50%) scale(${0.5 + Math.min(pull, 70) / 140}, ${0.5 + Math.min(pull, 90) / 120})`;
  }, { passive: true });
  scroller.addEventListener('touchend', () => {
    if (y0 == null) return;
    y0 = null;
    const go = pull > 70;
    const c = content();
    c.style.transition = '';
    if (go) {
      c.style.transform = 'translateY(56px)';
      ind.classList.add('spin');
      ind.style.transform = '';
      onRefresh();
    } else {
      c.style.transform = '';
      ind.style.opacity = '0';
    }
    pull = 0;
  });
}
// Tekan lama (±0,5 detik) memanggil fn; klik sesudahnya diabaikan.
/** @param {HTMLElement} el @param {() => void} fn */
export function onLongPress(el, fn) {
  let t;
  let x0 = 0;
  let y0 = 0;
  let fired = false;
  const cancel = () => clearTimeout(t);
  el.addEventListener('pointerdown', (e) => {
    fired = false;
    x0 = e.clientX;
    y0 = e.clientY;
    t = setTimeout(() => {
      fired = true;
      haptic(18);
      anim(el, [{ transform: 'scale(.97)' }, { transform: 'none' }], 220);
      fn();
    }, 480);
  });
  el.addEventListener('pointermove', (e) => Math.hypot(e.clientX - x0, e.clientY - y0) > 8 && cancel());
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, cancel);
  el.addEventListener('click', (e) => fired && ((fired = false), e.stopImmediatePropagation(), e.preventDefault()), true);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Isi elemen diganti hanya bila `key` berubah. Mencegah animasi masuk diputar ulang saat data yang
// sama digambar lagi (mis. pil & banner beranda setelah hasil cek pembaruan tiba).
/** @param {HTMLElement} el @param {string} key @param {() => (Node | null | false)[]} build */
export function renderIf(el, key, build) {
  if (el.dataset.key === key) return false;
  el.dataset.key = key;
  // null/false dibuang oleh replaceChildren versi di atas.
  el.replaceChildren(.../** @type {Node[]} */ (build()));
  return true;
}

export const loading = (text) => h('div', { class: 'loading' }, mascot('think'), h('span', { class: 'shimmer' }, text));
export const skeletons = (n = 3) => h('div', {}, ...Array.from({ length: n }, (_, i) => h('div', { class: 'skeleton', style: `--i:${i}` })));
export const scrollCol = (...kids) => h('div', { class: 'scroll' }, h('div', { class: 'col' }, ...kids));
/** @param {{ icon: string, t1: *, t2?: *, onclick?: (ev: MouseEvent) => *, danger?: boolean, chev?: boolean }} item */
export function menuItem({ icon, t1, t2, onclick, danger, chev = true }) {
  return h('button', { class: 'menuitem' + (danger ? ' danger' : ''), onclick },
    h('span', { class: 'mi' }, ic(icon)),
    h('span', { class: 'grow' }, h('div', { class: 't1' }, t1), t2 ? h('div', { class: 't2' }, t2) : null),
    chev ? ic('right', 'chev') : null,
  );
}
// Baris menu dengan sakelar. onchange(nilaiBaru) mengembalikan nilai sebenarnya (atau melempar):
// sakelar bergerak seketika lalu kembali bila gagal.
/** @param {{ icon: string, t1: *, t2?: *, on: boolean, danger?: boolean, onchange: (on: boolean) => * }} item */
export function toggleItem({ icon, t1, t2, on, danger, onchange }) {
  const sw = h('span', { class: 'switch' + (on ? ' on' : '') + (danger ? ' danger' : ''), role: 'switch', 'aria-checked': String(on) }, h('i'));
  const set = (v) => {
    on = !!v;
    sw.classList.toggle('on', on);
    sw.setAttribute('aria-checked', String(on));
  };
  const btn = h('button', { class: 'menuitem' }, h('span', { class: 'mi' }, ic(icon)), h('span', { class: 'grow' }, h('div', { class: 't1' }, t1), t2 ? h('div', { class: 't2' }, t2) : null), sw);
  btn.onclick = async () => {
    const want = !on;
    haptic(8);
    set(want);
    try {
      const r = await onchange(want);
      set(r === undefined ? want : r);
    } catch (e) {
      set(!want);
      toast(e.message, true);
    }
  };
  return btn;
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
