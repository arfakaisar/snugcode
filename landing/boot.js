// Loaded in <head> before render (separate file: the CSP only allows same-origin scripts).
// 1. Old links and apps that still open `/` are sent to snugcode agent (/agent/): apps added to the home screen
//    before the move, push notification links (#open=), Codespaces auth (#gh=) and moves from the old host (#import=).
// 2. Back from signing in on the landing page (#login=): the token is stored under the same key as snugcode agent
//    (pc.token), so the agent opens without signing in again.
// 3. Theme (pc.theme, shared with snugcode agent) and signed-in state are applied before CSS renders (no flash).
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
