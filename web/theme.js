// Theme is applied before CSS renders (no flash). A separate file, not an inline script: the PWA CSP
// (web/_headers) only allows same-origin scripts.
try {
  var t = JSON.parse(localStorage.getItem('pc.theme'));
  if (t && t !== 'system') document.documentElement.dataset.theme = t;
  // Text size (Account & appearance): stands in for the locked page zoom, see applyTextScale in dom.js.
  var z = Number(JSON.parse(localStorage.getItem('pc.textScale')));
  if (z > 0.5 && z < 2) document.documentElement.style.setProperty('--text-scale', String(z));
} catch (e) {}
