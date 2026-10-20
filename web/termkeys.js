// Tombol modifier terminal HP (tanpa DOM, diuji di test/features.test.js).
// Ctrl+huruf → karakter kontrol (Ctrl+C = \x03); Ctrl+[ = Esc, Ctrl+spasi = NUL, Ctrl+? = DEL.
export function ctrlKey(d) {
  if (d.length !== 1) return d;
  const c = d.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c & 31);
  if (d === ' ') return '\x00';
  if (d === '?') return '\x7f';
  return d;
}
