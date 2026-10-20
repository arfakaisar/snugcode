// Tema dipasang sebelum CSS dirender (tanpa kedip). File terpisah, bukan skrip inline: CSP PWA
// (web/_headers) hanya mengizinkan skrip dari alamat sendiri.
try {
  var t = JSON.parse(localStorage.getItem('pc.theme'));
  if (t && t !== 'system') document.documentElement.dataset.theme = t;
} catch (e) {}
