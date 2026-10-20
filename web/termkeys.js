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

// Keyboard HP (Gboard, Samsung, SwiftKey, suara, ketik geser) mengubah isi textarea lewat komposisi
// IME & koreksi otomatis, bukan per tombol. Selisih isi sebelum → sesudah diubah jadi input terminal:
// DEL untuk setiap karakter yang hilang dari ujung, lalu karakter barunya (baris baru = Enter).
// Dihitung per code point: emoji/karakter non-Latin dihapus shell dengan satu DEL.
export function imeDelta(prev, next) {
  const a = [...prev];
  const b = [...next];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return '\x7f'.repeat(a.length - i) + b.slice(i).join('').replace(/\r?\n/g, '\r');
}
