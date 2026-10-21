// Phone terminal modifier keys (no DOM, tested in test/features.test.js).
// Ctrl+letter → control character (Ctrl+C = \x03); Ctrl+[ = Esc, Ctrl+space = NUL, Ctrl+? = DEL.
export function ctrlKey(d) {
  if (d.length !== 1) return d;
  const c = d.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c & 31);
  if (d === ' ') return '\x00';
  if (d === '?') return '\x7f';
  return d;
}

// Phone keyboards (Gboard, Samsung, SwiftKey, voice, swipe typing) change the textarea through IME
// composition & autocorrect, not per key. The before → after diff becomes terminal input:
// DEL for each character removed from the end, then the new characters (newline = Enter).
// Counted per code point: emoji/non-Latin characters are erased by the shell with a single DEL.
export function imeDelta(prev, next) {
  const a = [...prev];
  const b = [...next];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return '\x7f'.repeat(a.length - i) + b.slice(i).join('').replace(/\r?\n/g, '\r');
}
