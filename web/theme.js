// Tema dipasang sebelum CSS dirender (tanpa kedip). File terpisah, bukan skrip inline: CSP PWA
// (web/_headers) hanya mengizinkan skrip dari alamat sendiri.
try {
  var t = JSON.parse(localStorage.getItem('pc.theme'));
  if (t && t !== 'system') document.documentElement.dataset.theme = t;
  // Ukuran teks (Akun & tampilan): pengganti zoom halaman yang dikunci, lihat applyTextScale di dom.js.
  var z = Number(JSON.parse(localStorage.getItem('pc.textScale')));
  if (z > 0.5 && z < 2) document.documentElement.style.setProperty('--text-scale', String(z));
} catch (e) {}
