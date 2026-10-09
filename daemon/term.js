// Teks terminal untuk TUI: warna (truecolor/256), lebar tampilan sadar ANSI & karakter lebar,
// pembungkus baris, dan markdown ke ANSI. Tanpa state, terpisah dari logika TUI.
const out = process.stdout;

// ---------- warna ----------
export const NO_COLOR = !!process.env.NO_COLOR;
export const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || '') || !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode' || process.platform === 'win32';
export const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const to256 = ([r, g, b]) => 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
export const fgc = (rgb) => (TRUECOLOR ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[38;5;${to256(rgb)}m`);
export const bgc = (rgb) => (TRUECOLOR ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[48;5;${to256(rgb)}m`);
export const paint = (open, close) => (s) => (NO_COLOR ? String(s) : open + s + close);
export const color = (hex) => paint(fgc(hexRgb(hex)), '\x1b[39m');
export const PAL = { clay: '#d97757', peach: '#f2b49b', green: '#5ee6a0', cyan: '#59d6e6', blue: '#7cb7ff', purple: '#c7a2ff', yellow: '#f2c14e', red: '#ff6b6b', pink: '#ff8fc7', gray: '#6f7a8a', fg: '#dbe2ea', soft: '#aab4c2', line: '#3a4352' };
export const c = Object.fromEntries(Object.entries(PAL).map(([k, v]) => [k, color(v)]));
export const bold = paint('\x1b[1m', '\x1b[22m');
export const dim = paint('\x1b[2m', '\x1b[22m');
export const italic = paint('\x1b[3m', '\x1b[23m');
export const under = paint('\x1b[4m', '\x1b[24m');
export const strike = paint('\x1b[9m', '\x1b[29m');
export const userBg = paint(bgc(hexRgb('#1b222d')), '\x1b[49m');
export function gradient(text, from = PAL.green, to = PAL.cyan) {
  if (NO_COLOR) return text;
  const a = hexRgb(from);
  const b = hexRgb(to);
  const chars = [...text];
  return chars.map((ch, i) => {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0;
    return fgc(a.map((v, k) => Math.round(v + (b[k] - v) * t))) + ch;
  }).join('') + '\x1b[39m';
}

// ---------- lebar tampilan & pembungkus baris (sadar ANSI) ----------
export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const strip = (s) => String(s).replace(ANSI_RE, '');
export const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u;
export const cw = (ch) => (WIDE.test(ch) ? 2 : 1);
export const width = (s) => [...strip(s)].reduce((n, ch) => n + cw(ch), 0);
export const cols = () => Math.max(40, out.columns || 80);
export const rowsN = () => Math.max(12, out.rows || 24);

// Potong per baris tampilan; warna dibuka ulang di baris lanjutan.
export function hardWrap(line, w) {
  const res = [];
  let cur = '';
  let curW = 0;
  let active = '';
  const re = /\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu;
  for (const m of String(line).matchAll(re)) {
    const tok = m[0];
    if (tok.length > 1 && tok[0] === '\x1b') {
      cur += tok;
      active = /\x1b\[0?m/.test(tok) ? '' : active + tok;
      continue;
    }
    const tw = cw(tok);
    if (curW + tw > w) {
      res.push(cur + (active ? '\x1b[0m' : ''));
      cur = active;
      curW = 0;
    }
    cur += tok;
    curW += tw;
  }
  res.push(cur);
  return res;
}
// Bungkus per kata dengan indentasi gantung (untuk prosa).
export function wrapWords(text, w, first = '', rest = first) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = first && !lines.length ? first : lines.length ? rest : first;
    let curW = width(cur);
    const prefixW = curW;
    let empty = true;
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const ww = width(word);
      if (/^\s+$/.test(word)) {
        if (!empty && curW + ww <= w) {
          cur += word;
          curW += ww;
        }
        continue;
      }
      if (!empty && curW + ww > w) {
        lines.push(cur.trimEnd());
        cur = rest;
        curW = width(rest);
      }
      if (width(rest) + ww > w) {
        for (const piece of hardWrap(word, w - width(rest))) {
          if (curW + width(piece) > w && !empty) {
            lines.push(cur);
            cur = rest;
            curW = width(rest);
          }
          cur += piece;
          curW += width(piece);
          empty = false;
        }
        continue;
      }
      cur += word;
      curW += ww;
      empty = false;
    }
    lines.push(empty && curW === prefixW ? cur.trimEnd() : cur);
  }
  return lines;
}
export const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
export const trunc = (s, w) => {
  s = String(s);
  if (width(s) <= w) return s;
  let o = '';
  let n = 0;
  for (const ch of strip(s)) {
    if (n + cw(ch) > w - 1) break;
    o += ch;
    n += cw(ch);
  }
  return o + '…';
};

// ---------- markdown -> ANSI ----------
export function inlineMd(s) {
  return s
    .replace(/`([^`\n]+)`/g, (_, x) => c.purple(x))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, x) => bold(x))
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, (_, a, x) => a + italic(x))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => under(c.blue(t)) + dim(` (${u})`));
}
export function renderMd(src, w, first = '', rest = '  ') {
  const L = src.replace(/\s+$/, '').split('\n');
  const outL = [];
  let lead = first;
  const take = () => {
    const l = lead;
    lead = rest;
    return l;
  };
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const fence = l.match(/^\s*```\s*([\w+#.-]*)/);
    if (fence) {
      const code = [];
      i++;
      while (i < L.length && !/^\s*```/.test(L[i])) code.push(L[i++]);
      if (fence[1]) outL.push(take() + dim(fence[1]));
      for (const cl of code) for (const part of hardWrap(cl.replace(/\t/g, '  '), w - width(rest) - 2)) outL.push((outL.length ? rest : take()) + c.line('│ ') + c.soft(part));
      continue;
    }
    if (!l.trim()) {
      if (outL.length && outL[outL.length - 1] !== '') outL.push('');
      continue;
    }
    const h = l.match(/^#{1,6}\s+(.*)/);
    if (h) {
      outL.push(take() + bold(c.blue(inlineMd(h[1]))));
      continue;
    }
    const li = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
    if (li) {
      const depth = Math.min(3, Math.floor(li[1].length / 2));
      const bullet = /\d/.test(li[2]) ? li[2] : '•';
      const ind = '  '.repeat(depth);
      const p = (outL.length ? rest : take()) + ind + c.green(bullet) + ' ';
      outL.push(...wrapWords(inlineMd(li[3]), w, p, rest + ind + ' '.repeat(width(bullet) + 1)));
      continue;
    }
    if (/^>\s?/.test(l)) {
      outL.push(...wrapWords(inlineMd(l.replace(/^>\s?/, '')), w, (outL.length ? rest : take()) + c.line('▎ '), rest + c.line('▎ ')));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      outL.push((outL.length ? rest : take()) + c.soft(trunc(l, w - width(rest))));
      continue;
    }
    outL.push(...wrapWords(inlineMd(l), w, outL.length ? rest : take(), rest));
  }
  return outL;
}
