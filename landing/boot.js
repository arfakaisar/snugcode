// Dimuat di <head> sebelum render (file terpisah: CSP hanya mengizinkan skrip dari alamat sendiri).
// 1. Tautan & aplikasi lama yang masih menuju `/` diteruskan ke snugcode agent (/agent/): aplikasi yang
//    dipasang di layar utama sebelum pindah path, notifikasi push (#open=), izin Codespaces (#gh=), dan
//    pindah dari alamat lama (#import=).
// 2. Kembali dari login di landing page (#login=): token disimpan di kunci yang sama dengan snugcode agent
//    (pc.token), jadi agent langsung terbuka tanpa login lagi.
// 3. Tema (pc.theme, sama dengan snugcode agent) & status login dipasang sebelum CSS dirender (tanpa kedip).
(function () {
  var hash = location.hash;
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone || /[#&](open|gh|import)=/.test(hash)) {
    location.replace('/agent/' + hash);
    return;
  }
  var m = hash.match(/[#&]login=([^&]+)/);
  if (m) {
    try {
      localStorage.setItem('pc.token', JSON.stringify(decodeURIComponent(m[1])));
    } catch (e) {}
    history.replaceState(null, '', location.pathname);
  }
  var root = document.documentElement;
  var t = null;
  try {
    t = JSON.parse(localStorage.getItem('pc.theme'));
    if (JSON.parse(localStorage.getItem('pc.token'))) root.classList.add('authed');
  } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.dataset.theme = t;
})();
