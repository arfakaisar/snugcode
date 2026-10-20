// Koneksi ke satu PC: pairing PIN, pengaturan PC, pembaruan jarak jauh, login GitHub PC.
import * as C from '../../shared/crypto.js';
import * as M from '../../shared/models.js';
import { Conn, store } from '../conn.js';
import { app } from './state.js';
import { goMachines } from './auth.js';
import { anim, busyButton, copyText, h, haptic, ic, isOldDaemon, loading, menuItem, renderIf, mascot, toast, ui } from './dom.js';
import { pickModel } from './model-picker.js';
import { enableNotifications, localNotify, syncPush } from './push.js';
import { reattach } from './session.js';
import { sessionSub, showSessions, showSessionsMeta } from './sessions.js';
import { cloudPin, codespacesError, connectButton, connectCodespaces, ghcs, idleSheet, isAuthError, isCodespace, openRunnerOnGithub, removeRunner, stopRunnerNow, wakeRunner } from './cloud.js';
import { connectionsSheet, settingsItems } from './settings.js';
import { progress } from './progress.js';
import { ENGINE_LABEL } from '../../shared/providers.js';

// ---------- Koneksi ke satu PC ----------
/** @param {{ id: string, name?: string, kind?: string, provider?: string }} m @param {{ sid?: string }} [opts] */
export function openMachine(m, { sid } = {}) {
  app.conn?.close();
  app.conn = new Conn(m);
  app.current = { m, resumeSid: sid };
  store.set('last', { mid: m.id, sid });
  const msg = h('div', { class: 'muted' });
  const showStatus = (title, text, busy = true, extra = null) =>
    ui.view(h('div', { class: 'hero center' }, busy ? mascot('think xl') : h('div', { class: 'lockicon' }, ic('monitor')), h('h1', { class: 'serif' + (busy ? ' shimmer' : '') }, title), msg, text ? h('p', { class: 'dim small' }, text) : null, extra));
  ui.set(m.name, { sub: 'menghubungkan…', back: goMachines, dot: 'busy' });
  const connecting = progress('connect', [
    { id: 'relay', label: 'Menghubungi relay', est: 1 },
    { id: 'auth', label: 'Membuka kanal terenkripsi', est: 2 },
  ]);
  app.current.connecting = connecting;
  showStatus('Menghubungkan', null, true, connecting.el);
  app.conn.on('state', (s) => {
    app.current?.watch?.(s);
    if (s === 'online') (connecting.step('auth'), app.current.wakeProg?.step('auth'));
    if (s === 'offline') {
      connecting.stop();
      ui.dot('off');
      ui.sub('offline');
      if (!app.current.ready && isCodespace(m)) return wakeScreen(m, msg, showStatus);
      if (!app.current.ready) {
        msg.textContent = 'PC sedang offline.';
        if (m.kind === 'cloud') showStatus('Menunggu runner', 'Pastikan container snugcode berjalan di server (docker ps / docker start snugcode). Halaman ini tersambung otomatis begitu runner online.', true);
        else showStatus('Menunggu PC', 'Pastikan snugcode berjalan di PC (snugcode autostart on) dan PC tidak tertidur. Halaman ini tersambung otomatis begitu PC online.', true);
      } else toast('PC offline — menunggu tersambung lagi…', true);
    } else if (s === 'online' || s === 'reconnecting') {
      ui.dot('busy');
      if (app.current.ready) ui.sub('menyambung ulang…');
    } else if (s === 'needpin') {
      // Runner cloud yang dibuat dari HP ini: PIN-nya diketahui, pairing otomatis (sekali per koneksi).
      const pin = cloudPin(m.id);
      if (pin && !app.current.autoPaired) {
        app.current.autoPaired = true;
        msg.textContent = 'Memasangkan HP ini ke runner…';
        connecting.step('auth', 'memasangkan HP (pertama kali)');
        app.conn.pair(pin).then((r) => r.ok || showPin(m));
      } else showPin(m);
    }
    else if (s === 'revoked') (toast('HP ini dicabut aksesnya dari PC.', true), showPin(m));
    else if (s === 'removed') (toast('PC ini sudah dihapus dari akun.', true), goMachines());
    else if (s === 'authfail') toast('Verifikasi PC gagal.', true);
  });
  app.conn.on('ready', (info) => {
    ui.dot('on');
    connecting.done();
    app.current.wakeProg?.done();
    app.current.wakeProg = null;
    app.current.watch?.('ready');
    const first = !app.current.ready;
    app.current.ready = true;
    app.current.info = info;
    clearInterval(app.current.updateTimer);
    app.current.updateTimer = setInterval(() => checkUpdateStatus(true), 90000);
    checkUpdateStatus(false);
    syncPush(false);
    if (document.visibilityState !== 'visible') app.conn.call('visible', { on: false }).catch(() => {});
    if (first) {
      showSessions();
      if (info.runtime === 'cloud') setupCloud(info);
      else if (info.routerConfigured === false) connectionsSheet({ first: true });
    } else if (app.current.session) (reattach(), app.current.onTermReady?.(), ui.sub(sessionSub(app.current.session)));
    else showSessionsMeta();
  });
  app.conn.on('events', (msg) => app.current?.onEvents?.(msg));
  app.conn.on('term', (msg) => app.current?.onTerm?.(msg));
  app.conn.on('github', (msg) => onGithubStatus(msg));
  // Login ChatGPT selesai (atau gagal) di mesin; daftar koneksi & model default berubah.
  app.conn.on('chatgpt', (msg) => app.current?.onChatgpt?.(msg));
  app.conn.on('connections', (msg) => app.current?.info && (app.current.info = { ...app.current.info, connections: msg.list, routerConfigured: msg.list.length > 0 }));
  app.conn.on('info', (msg) => {
    if (!app.current?.info) return;
    app.current.info = { ...app.current.info, ...msg.info };
    showSessionsMeta();
  });
  app.conn.on('update', (st) => onUpdateStatus(st, true));
  app.conn.on('notice', (msg) => {
    if (app.current?.session?.id === msg.sid && document.visibilityState === 'visible') return;
    toast(`${msg.title}: ${msg.msg}`);
    localNotify('snugcode', `${msg.title}: ${msg.msg}`);
  });
  app.conn.connect();
}

// Runner Codespaces yang sedang tidur: nyalakan dari HP (butuh izin Codespaces di HP ini).
function wakeScreen(m, msg, showStatus) {
  if (app.current.waking) return;
  app.current.waking = true;
  msg.textContent = '';
  const wp = progress('cloud-wake', [
    { id: 'boot', label: 'Menyalakan codespace', est: 35 },
    { id: 'start', label: 'Menyalakan snugcode', est: 10 },
    { id: 'auth', label: 'Menyambungkan HP', est: 3 },
  ]);
  app.current.wakeProg = wp;
  showStatus('Menyalakan runner', 'Halaman ini tersambung otomatis begitu runner siap.', true, wp.el);
  wakeRunner(m, (t, phase) => wp.step(phase, t))
    .then((ok) => {
      if (ok || app.current?.m.id !== m.id || app.current.ready) return;
      wp.stop();
      app.current.wakeProg = null;
      app.current.waking = false;
      showStatus('Runner tidur', 'Runner berhenti sendiri saat tidak dipakai. Hubungkan GitHub Codespaces di HP ini untuk menyalakannya.', false);
      $view()?.querySelector('.hero')?.append(connectButton());
    })
    .catch((e) => {
      if (app.current?.m.id !== m.id) return;
      app.current.waking = false;
      wp.fail(e.message);
      app.current.wakeProg = null;
      ui.sub('gagal menyalakan');
      const hero = $view()?.querySelector('.hero');
      // Izin Codespaces ditolak: hubungkan lagi, lalu runner dinyalakan otomatis saat kembali ke aplikasi.
      if (isAuthError(e)) hero?.append(connectButton('Hubungkan lagi GitHub Codespaces'));
      else hero?.append(h('button', { class: 'btn', style: 'margin-top:16px', onclick: () => wakeScreen(m, msg, showStatus) }, ic('refresh'), 'Coba lagi'));
    });
}
const $view = () => document.getElementById('view');

// Runner cloud tersambung: beri token Codespaces (agar bisa berhenti sendiri saat menganggur), lalu
// minta model (login ChatGPT / API key) bila belum ada — runner baru tidak punya terminal untuk `snugcode setup`.
function setupCloud(info) {
  const t = ghcs();
  if (t && info.runner?.provider === 'codespace' && info.caps?.includes('runnerConfig'))
    app.conn.call('runnerConfig', { token: t.token }).then((runner) => app.current && (app.current.info = { ...app.current.info, runner })).catch(() => {});
  if (!info.routerConfigured) connectionsSheet({ first: true, after: () => (ghBad() ? githubLoginSheet() : ui.closeSheet()) });
}

export function showPin(m) {
  ui.set(m.name, { sub: 'pasangkan HP ini', back: goMachines, dot: 'busy' });
  const err = h('div', { class: 'err', role: 'alert' });
  const input = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '12', placeholder: '••••••', 'aria-label': 'PIN', enterkeyhint: 'go' });
  const eye = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Tampilkan PIN' }, ic('eye'));
  eye.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.replaceChildren(ic(show ? 'eyeoff' : 'eye'));
    input.focus();
  };
  const wrap = h('div', { class: 'pinwrap' }, input, eye);
  const lock = h('div', { class: 'lockicon' }, ic('lock'));
  const btn = h('button', { class: 'btn primary big', style: 'margin-top:14px' }, 'Pasangkan');
  const shake = () => anim(wrap, [{ transform: 'none' }, { transform: 'translateX(-9px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }], { duration: 420, easing: 'ease-out' });
  const go = async () => {
    const pin = input.value.trim();
    if (!C.PIN_RE.test(pin)) {
      err.textContent = 'PIN 6–12 huruf/angka.';
      shake();
      return;
    }
    const done = busyButton(btn, 'Memverifikasi…');
    err.textContent = '';
    lock.classList.add('busy');
    const r = await app.conn.pair(pin);
    lock.classList.remove('busy');
    done();
    if (r.ok) return (haptic(20), lock.classList.add('ok'));
    input.value = '';
    shake();
    haptic(60);
    err.textContent =
      r.reason === 'pin' ? `PIN salah.${r.left != null ? ` Sisa ${r.left} percobaan.` : ''}`
      : r.reason === 'locked' ? `Terlalu banyak PIN salah. Coba lagi${r.until ? ' ' + new Date(r.until).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : ' nanti'}, atau jalankan \`snugcode pin\` di PC untuk membukanya sekarang.`
      : r.reason === 'slow' ? 'Terlalu cepat, tunggu beberapa detik.'
      : r.reason === 'nopin' ? 'PC belum punya PIN. Jalankan `snugcode setup`.'
      : 'Gagal: ' + r.reason;
  };
  btn.onclick = go;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') go();
  };
  ui.view(
    h('div', { class: 'scroll' },
      h('div', { class: 'hero center' },
        lock,
        h('h1', { class: 'serif' }, 'Pasangkan HP ini'),
        h('div', { class: 'muted' }, `Masukkan PIN yang kamu buat saat setup di `, h('b', {}, m.name), '.'),
        h('div', { class: 'dim small', style: 'margin-top:6px' }, 'Cukup sekali per HP. PIN diverifikasi langsung oleh PC — tidak pernah dikirim ke server.'),
        wrap, err, btn,
      ),
    ),
  );
  setTimeout(() => input.focus(), 120);
}

// ---------- Pembaruan PC Otomatis (dari HP) ----------
// Progress: pasang (balasan RPC update) → daemon restart → tersambung lagi (event ready).
// method: 'update' (versi terbaru) atau 'rollback' (versi sebelum pembaruan terakhir).
async function runUpdate(_btn, after, method = 'update') {
  const where = here().split(' ')[0];
  const p = progress('pc-update', [
    { id: 'install', label: 'Mengunduh & memasang pembaruan', est: 90 },
    { id: 'restart', label: 'Menyalakan ulang snugcode', est: 8 },
    { id: 'reconnect', label: 'Menyambungkan lagi', est: 4 },
  ]);
  const closeBtn = h('button', { class: 'btn', style: 'margin-top:14px', onclick: () => ui.closeSheet() }, 'Tutup — tetap berjalan');
  ui.sheet(ui.head(method === 'rollback' ? 'Mengembalikan versi snugcode' : 'Memperbarui snugcode', { sub: app.current.m.name }), p.el, h('div', { class: 'fine' }, `Sesi yang sedang berjalan di ${where} dihentikan dulu agar file tidak terkunci.`), closeBtn);
  const cur = app.current;
  try {
    haptic(20);
    const res = await app.conn.call(method);
    p.step('restart', res.commit ? 'versi ' + res.commit : '');
    cur.watch = (ev) => {
      if (ev === 'reconnecting' || ev === 'online' || ev === 'offline') p.step('reconnect');
      if (ev !== 'ready') return;
      cur.watch = null;
      p.done(method === 'rollback' ? 'snugcode kembali ke versi sebelumnya' : 'snugcode diperbarui');
      haptic(25);
      after?.();
      setTimeout(() => closeBtn.isConnected && ui.closeSheet(), 1500);
    };
  } catch (err) {
    p.fail('Gagal: ' + err.message);
    toast('Pembaruan gagal: ' + err.message, true, 6000);
  }
}

export function renderUpdateBanner() {
  const el = document.getElementById('updateBanner');
  if (!el) return;
  if (legacyDaemon())
    return renderIf(el, 'legacy', () => [
      h('button', { class: 'banner up', onclick: () => migrateSheet() },
        h('span', { class: 'bi' }, mascot()),
        h('span', { class: 'grow' }, h('div', { class: 'name' }, 'Pindahkan PC ini ke snugcode'), h('div', { class: 'sub' }, 'PC masih menjalankan versi lama (pocketcode). Ketuk untuk migrasi — pairing & sesi tetap.')),
        ic('right', 'chev'),
      ),
    ]);
  const st = app.current?.updateStatus;
  if (!st?.updateAvailable) return renderIf(el, '', () => []);

  const sha = st.latestCommit ? st.latestCommit.slice(0, 7) : 'terbaru';
  const behind = st.commitsBehind > 1 ? `${st.commitsBehind} commit tertinggal` : 'Pembaruan baru tersedia';
  const msg = st.latestMessage ? `"${st.latestMessage}"` : behind;
  const upBtn = h('button', {
    class: 'pillbtn',
    onclick: (e) => {
      e.stopPropagation();
      runUpdate(e.currentTarget, () => {
        app.current.updateStatus = null;
        renderUpdateBanner();
        showSessionsMeta();
      });
    },
  }, 'Perbarui');
  renderIf(el, 'up|' + sha + '|' + msg, () => [
    h('button', { class: 'banner up', onclick: () => updateMachineSheet() },
      h('span', { class: 'bi' }, ic('spark')),
      h('span', { class: 'grow' }, h('div', { class: 'name' }, `Pembaruan ${here().split(' ')[0]} tersedia · ${sha}`), h('div', { class: 'sub' }, msg)),
      upBtn,
    ),
  ]);
}

export function onUpdateStatus(st, notify = false) {
  if (!app.current) return;
  const was = app.current.updateStatus?.updateAvailable;
  app.current.updateStatus = st;
  renderUpdateBanner();
  showSessionsMeta();
  if (st.updateAvailable && !was && notify) {
    haptic(15);
    toast(`Pembaruan snugcode tersedia (${st.latestCommit})! Ketuk banner untuk perbarui.`, false, 6000);
  }
}

export async function checkUpdateStatus(notify = false) {
  if (!app.conn || !app.current?.ready) return;
  try {
    const st = await app.conn.call('updateStatus');
    onUpdateStatus(st, notify);
  } catch {}
}

// ---------- Migrasi dari pocketcode (nama lama) ----------
// Daemon versi lama tidak mengirim `brand`. Pembaruan jarak jauhnya tidak bisa pindah sendiri ke paket
// baru (ia memasang paket `snugcode` lalu menyalakan ulang kode lamanya), jadi migrasi dilakukan
// dengan perintah: pasang snugcode → hentikan & hapus pocketcode → nyalakan snugcode. Folder data
// ~/.pocketcode tetap dipakai, sehingga pairing HP, sesi, dan worktree tidak berubah.
export const legacyDaemon = () => !!app.current?.info && !app.current.info.brand;
const PKG = 'github:arfakaisar/snugcode';
export function migrateCommands(platform) {
  if (platform === 'win32')
    return {
      manual: `npm i -g ${PKG} --include=optional; if ($?) { pocketcode stop; npm rm -g pocketcode; snugcode autostart on }`,
      // Lewat sesi: proses terpisah (tidak ikut mati saat daemon lama dihentikan); gagal pasang = tidak ada yang diubah.
      viaSession: `Start-Process cmd -WindowStyle Hidden -ArgumentList '/c npm i -g ${PKG} --include=optional > "%USERPROFILE%\\.pocketcode\\migrate.log" 2>&1 && (pocketcode stop & ping -n 4 127.0.0.1 >nul & npm rm -g pocketcode & snugcode autostart on)'`,
    };
  const steps = `npm i -g ${PKG} --include=optional && { pocketcode stop; npm rm -g pocketcode; snugcode autostart on; }`;
  return {
    manual: steps,
    viaSession: `node -e "require('child_process').spawn('sh',['-c',process.argv[1]],{detached:true,stdio:'ignore'}).unref()" '{ ${steps}; } > ~/.pocketcode/migrate.log 2>&1'`,
  };
}

export function migrateSheet() {
  const cmds = migrateCommands(app.current?.info?.platform);
  const copy = async (e) => (await copyText(cmds.manual)) && (e.currentTarget.classList.add('done'), toast('Perintah disalin'));
  ui.sheet(
    ui.head('Migrasi ke snugcode', { sub: app.current.m.name }),
    h('div', { class: 'empty', style: 'padding:6px 0 10px' },
      h('div', { class: 'emptyart up' }, mascot('draw xl tap')),
      h('b', {}, 'PC ini masih memakai pocketcode'),
      'Pasang snugcode, lalu hentikan & hapus versi lama. Pairing HP, sesi, dan worktree tetap — folder data ~/.pocketcode dipakai terus.',
    ),
    h('div', { class: 'label' }, 'Jalankan di terminal PC'),
    h('div', { class: 'copyline' }, h('code', {}, cmds.manual), h('button', { class: 'copybtn', onclick: copy }, ic('copy'), 'salin')),
    h('div', { class: 'label' }, 'Atau dari HP'),
    h('button', {
      class: 'btn primary',
      onclick: async (ev) => {
        if (!(await ui.confirm({ title: 'Migrasi sekarang?', text: 'Perintah dijalankan di PC lewat sesi yang sedang menganggur. Daemon mati ±1 menit selama memasang, lalu tersambung lagi sebagai snugcode.', ok: 'Migrasi', icon: 'push' }))) return;
        try {
          // Daemon lama tidak bisa membuat sesi tanpa repo, jadi dipakai sesi yang ada.
          const target = (await app.conn.call('sessions')).find((x) => x.status !== 'running');
          if (!target) throw new Error('tidak ada sesi yang menganggur. Buat sesi dulu, atau jalankan perintah di atas di terminal PC.');
          await app.conn.call('send', { id: target.id, text: '!' + cmds.viaSession });
          toast('Migrasi berjalan di PC. Tunggu PC tersambung lagi…', false, 8000);
        } catch (err) {
          toast('Gagal: ' + err.message, true);
        }
      },
    }, ic('push'), 'Migrasi otomatis (via sesi)'),
    h('div', { class: 'fine' }, 'Log migrasi: ~/.pocketcode/migrate.log di PC.'),
  );
}

// ---------- Login GitHub PC (dari HP) ----------
// Token GitHub di PC bisa dicabut. Daemon memulai device flow dan kodenya
// tampil di sini, jadi login ulang bisa dilakukan dari mana saja.
// "PC ini" / "runner ini" sesuai jenis mesin yang terbuka.
const here = () => (app.current?.info?.runtime === 'cloud' ? 'runner ini' : 'PC ini');
export const ghBad = () => ['invalid', 'missing'].includes(app.current?.info?.githubState);

export function renderGhBanner() {
  const el = document.getElementById('ghBanner');
  if (!el) return;
  if (!ghBad()) return renderIf(el, '', () => []);
  renderIf(el, 'gh|' + app.current.info.githubState, () => [
    h('button', { class: 'banner warn', onclick: () => githubLoginSheet() },
      h('span', { class: 'bi' }, ic('github')),
      h('span', { class: 'grow' },
        h('div', { class: 'name' }, app.current.info.githubState === 'missing' ? 'GitHub belum login di ' + here() : 'Login GitHub di ' + here() + ' tidak berlaku'),
        h('div', { class: 'sub' }, 'Push, PR, dan daftar repo tidak bisa dipakai. Ketuk untuk login ulang dari HP.'),
      ),
      ic('right', 'chev'),
    ),
  ]);
}

export function onGithubStatus(st) {
  if (!app.current?.info) return;
  const was = app.current.info.githubState;
  app.current.info.githubState = st.state;
  if (st.login) app.current.info.github = st.login;
  renderGhBanner();
  showSessionsMeta();
  app.current.ghSheet?.(st);
  if (st.state === 'invalid' && was !== 'invalid' && !app.current.ghSheet) toast('Login GitHub di PC tidak berlaku — ketuk banner untuk login ulang', true, 5000);
}

const doneState = (title, text) => h('div', { class: 'empty' }, h('div', { class: 'emptyart ok' }, ic('check')), h('b', {}, title), text);

export async function githubLoginSheet() {
  const body = h('div', {}, loading('Meminta kode login ke GitHub…'));
  ui.sheet(ui.head('Login GitHub', { sub: 'untuk ' + app.current.m.name }), body);
  let timer;
  const close = () => {
    clearInterval(timer);
    app.current.ghSheet = null;
  };
  const render = (st) => {
    clearInterval(timer);
    if (st.state === 'ok' && !st.pending) {
      haptic(25);
      body.replaceChildren(
        doneState('GitHub tersambung', `@${st.login} — push, PR, dan daftar repo bisa dipakai lagi.`),
        h('button', { class: 'btn primary', onclick: () => (close(), ui.closeSheet()) }, 'Selesai'),
      );
      return;
    }
    const p = st.pending;
    if (!p) return;
    const left = h('span', {});
    const tick = () => {
      const s = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      left.textContent = s ? `kode berlaku ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'kode kedaluwarsa';
    };
    tick();
    timer = setInterval(tick, 1000);
    const copyBtn = h('button', { class: 'copybtn', onclick: async (e) => (await copyText(p.code)) && (e.currentTarget.classList.add('done'), toast('Kode disalin')) }, ic('copy'), 'salin');
    body.replaceChildren(
      h('div', { class: 'muted small' }, 'Masukkan kode ini di halaman GitHub, lalu tekan Authorize:'),
      h('div', { class: 'ghcode' }, h('span', {}, p.code), copyBtn),
      p.error ? h('div', { class: 'err' }, p.error) : h('div', { class: 'loading', style: 'justify-content:center' }, mascot('think'), h('span', {}, 'menunggu otorisasi · ', left)),
      h('a', { class: 'btn primary', href: p.uri, target: '_blank', rel: 'noopener', onclick: () => copyText(p.code) }, ic('github'), 'Salin kode & buka GitHub'),
      h('div', { class: 'dim small', style: 'margin-top:12px;text-align:center' }, p.uri.replace(/^https:\/\//, '')),
      p.error ? h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => githubLoginSheet() }, ic('refresh'), 'Minta kode baru') : null,
    );
  };
  app.current.ghSheet = render;
  try {
    render(await app.conn.call('githubLogin'));
  } catch (e) {
    close();
    body.replaceChildren(h('div', { class: 'err' }, /Metode tidak dikenal/.test(e.message) ? 'Perbarui snugcode di PC untuk login GitHub dari HP (jalankan `snugcode login` di PC).' : e.message));
  }
}

export function modelItem(t1, id, onclick) {
  const engine = app.current?.info?.model === id ? app.current.info.engine : null;
  return menuItem({ icon: 'cpu', t1, t2: (M.modelLabel(id, { provider: true }) || '(belum dipilih)') + (engine ? ' · ' + (ENGINE_LABEL[engine] || engine) : ''), onclick });
}

export function showMachineMenu() {
  const info = app.current.info;
  const m = app.current.m;
  const cloud = info.runtime === 'cloud';
  const settings = settingsItems(showMachineMenu);
  const idle = info.runner?.idleStopMinutes;
  const pick = (title, field) =>
    pickModel({
      title,
      current: info[field] || info.model,
      onBack: showMachineMenu,
      onPick: async (id) => {
        app.current.info = await app.conn.call('setModel', { [field]: id });
        toast(title + ': ' + M.modelLabel(id));
        showMachineMenu();
        showSessionsMeta();
      },
    });
  ui.sheet(
    ui.head(cloud ? 'Pengaturan runner' : 'Pengaturan PC', { sub: app.current.m.name }),
    h('div', { class: 'pchero' },
      h('span', { class: 'avatar' }, ic(cloud ? 'cloud' : 'monitor'), h('i', { class: 'live' })),
      h('div', { class: 'grow' }, h('b', {}, app.current.m.name), h('div', { class: 'dim small' }, [cloud ? (info.runner?.provider === 'codespace' ? 'Cloud · Codespaces' : 'Cloud · container') : { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[info.platform] || info.platform, info.commit ? 'v' + info.commit : null, info.github && !ghBad() ? '@' + info.github : 'GitHub belum login'].filter(Boolean).join(' · '))),
    ),
    h('div', { class: 'label' }, 'Model'),
    h('div', { class: 'group' },
      modelItem('Default untuk sesi baru', info.model, () => pick('Model default', 'model')),
      // Model ringan subagen dipilih otomatis oleh daemon (Claude Haiku 5.5 / Gemini 3.8 Flash).
      info.lightModel
        ? menuItem({ icon: 'bolt', t1: 'Model ringan (subagen) · otomatis', t2: M.modelLabel(info.lightModel) + (info.engine === 'codex' ? ' · diatur Codex' : info.engine === 'gemini' ? ' · diatur Gemini CLI' : ''), chev: false, onclick: () => toast('Dipilih otomatis dari koneksi yang sama: Haiku untuk Claude, Flash untuk Gemini/DeepSeek. Model GPT memakai subagen Codex.') })
        : modelItem('Model kecil (tugas ringan)', info.smallModel || info.model, () => pick('Model kecil', 'smallModel')),
    ),
    h('div', { class: 'label' }, 'GitHub'),
    h('div', { class: 'group' },
      menuItem({ icon: 'github', t1: ghBad() ? 'Login GitHub (perlu)' : 'Login ulang GitHub', t2: info.github && !ghBad() ? '@' + info.github + ' · tersambung' : 'push, PR, dan daftar repo', onclick: () => githubLoginSheet() }),
    ),
    settings.length ? h('div', { class: 'label' }, 'Model & akses') : null,
    settings.length ? h('div', { class: 'group' }, ...settings) : null,
    cloud ? h('div', { class: 'label' }, 'Runner cloud') : null,
    cloud
      ? h('div', { class: 'group' },
          menuItem({ icon: 'clock', t1: 'Berhenti otomatis', t2: idle ? `setelah ${idle} menit tidak dipakai${info.runner?.autoStop ? '' : ' · belum aktif'}` : 'mati — runner terus menyala', onclick: () => idleSheet(showMachineMenu) }),
          isCodespace(m) && info.runner?.usage ? usageItem(info.runner.usage) : null,
          isCodespace(m) ? menuItem({ icon: 'stop', t1: 'Hentikan runner sekarang', t2: 'menyala lagi saat kamu membukanya', onclick: () => runnerAction('stop') }) : null,
          isCodespace(m) ? menuItem({ icon: 'github', t1: 'Buka codespace di GitHub', t2: 'log runner: /workspaces/.snugcode/cloud.log', onclick: () => runnerAction('github') }) : null,
          isCodespace(m) ? menuItem({ icon: 'key', t1: ghcs() ? 'Hubungkan ulang GitHub Codespaces' : 'Hubungkan GitHub Codespaces (perlu)', t2: ghcs() ? `@${ghcs().login || '?'} · untuk menyalakan & menghentikan runner` : 'HP ini belum bisa menyalakan runner', onclick: () => connectCodespaces('wake') }) : null,
          isCodespace(m) ? menuItem({ icon: 'trash', t1: 'Hapus runner', t2: 'codespace beserta sesi & worktree-nya', danger: true, chev: false, onclick: () => runnerAction('remove') }) : null,
        )
      : null,
    h('div', { class: 'label' }, 'Sistem & pembaruan'),
    h('div', { class: 'group' },
      menuItem({
        icon: 'spark',
        t1: 'Perbarui snugcode di PC',
        t2: info.commit ? `Versi: ${info.commit}${info.version ? ' (' + info.version + ')' : ''}` : 'Periksa & pasang pembaruan jarak jauh',
        onclick: () => updateMachineSheet(),
      }),
      menuItem({
        icon: 'trash',
        t1: 'Bersihkan folder tak terpakai',
        t2: 'Hapus worktree & repo yatim di PC',
        onclick: async () => {
          try {
            toast('Memindai folder…');
            const r = await app.conn.call('cleanup');
            const wtCount = r.removedWorktrees?.length || 0;
            const repoCount = r.removedRepos?.length || 0;
            toast(wtCount || repoCount ? `Dibersihkan: ${wtCount} worktree, ${repoCount} repo` : 'Workspace PC sudah bersih.');
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
      menuItem({
        icon: 'refresh',
        t1: 'Restart daemon PC',
        t2: info.preventSleep ? 'Cegah PC sleep: aktif' : 'Mulai ulang koneksi daemon',
        onclick: async () => {
          if (!(await ui.confirm({ title: 'Restart daemon?', text: 'Daemon snugcode di PC dimulai ulang. Sesi tersambung lagi otomatis setelah beberapa detik.', ok: 'Restart', icon: 'refresh' }))) return;
          try {
            const r = await app.conn.call('restart');
            toast(r.message || 'Daemon me-restart…');
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ),
    h('div', { class: 'label' }, 'Perangkat'),
    h('div', { class: 'group' },
      menuItem({ icon: 'bell', t1: 'Izinkan notifikasi', t2: 'Kabar saat agen selesai / butuh izin', onclick: enableNotifications }),
      menuItem({ icon: 'monitor', t1: 'Ganti PC', t2: 'kembali ke daftar komputer', onclick: () => (ui.closeSheet(), goMachines()) }),
      menuItem({ icon: 'unlink', t1: 'Lupakan pairing HP ini', t2: 'Perlu PIN lagi untuk tersambung', danger: true, chev: false, onclick: () => (store.set('dev.' + app.current.m.id, null), ui.closeSheet(), openMachine(app.current.m)) }),
    ),
  );
}

// Perkiraan pemakaian kuota Codespaces bulan ini (dicatat runner sendiri; billing GitHub tidak bisa dibaca).
function usageItem(u) {
  const pct = u.free ? Math.min(100, Math.round((u.coreHours / u.free) * 100)) : 0;
  return menuItem({
    icon: 'bolt',
    t1: `±${u.coreHours} core-jam bulan ini`,
    t2: `${u.hours} jam × ${u.cores} core · ${pct}% dari ${u.free} gratis (GitHub Free)`,
    chev: false,
    onclick: () => toast('Perkiraan dari lama runner menyala bulan ini (UTC). Waktu menyalakan codespace dan codespace lain di akunmu tidak terhitung; angka pasti ada di github.com/settings/billing.', false, 6000),
  });
}

async function runnerAction(kind) {
  const m = app.current.m;
  try {
    if (kind === 'github') return await openRunnerOnGithub(m);
    if (kind === 'stop') {
      if (!(await ui.confirm({ title: 'Hentikan runner?', text: 'Agen, dev server, dan preview yang berjalan ikut berhenti. Sesi & file tetap tersimpan.', ok: 'Hentikan', icon: 'stop' }))) return;
      await stopRunnerNow(m);
      toast('Runner dihentikan');
      return goMachines();
    }
    if (!(await ui.confirm({ title: 'Hapus runner?', text: 'Codespace beserta semua sesi, worktree, dan commit yang belum di-push dihapus permanen.', ok: 'Hapus runner', danger: true, icon: 'trash' }))) return;
    await removeRunner(m);
    goMachines();
  } catch (e) {
    if (!(await codespacesError(e))) toast(e.message, true);
  }
}

export async function updateMachineSheet() {
  const body = h('div', {}, loading('Memeriksa pembaruan di PC…'));
  ui.sheet(ui.head('Pembaruan PC', { sub: app.current.m.name }), body);
  try {
    const st = await app.conn.call('updateStatus');
    const hasUpdate = st.updateAvailable;
    const btn = h('button', { class: 'btn primary', style: 'margin-top:14px', onclick: (e) => runUpdate(e.currentTarget, () => ui.closeSheet()) }, hasUpdate ? 'Perbarui sekarang' : 'Paksa perbarui ulang');
    body.replaceChildren(
      h('div', { class: 'empty', style: 'padding:16px 0' },
        h('div', { class: 'emptyart' + (hasUpdate ? ' up' : ' ok') }, ic(hasUpdate ? 'push' : 'check')),
        h('b', {}, hasUpdate ? 'Pembaruan tersedia' : 'snugcode sudah versi terbaru'),
        hasUpdate && st.latestMessage ? h('div', { class: 'quote' }, st.latestMessage) : null,
        h('div', { class: 'tags', style: 'justify-content:center;margin-top:12px' },
          st.currentCommit ? h('span', { class: 'tag' }, 'sekarang ' + st.currentCommit) : null,
          st.latestCommit ? h('span', { class: 'tag' + (hasUpdate ? ' on' : '') }, 'terbaru ' + st.latestCommit) : null,
        ),
      ),
      btn,
      // Versi baru bermasalah: kembali ke versi sebelum pembaruan terakhir (daemon yang mendukungnya saja).
      st.canRollback && app.current.info?.caps?.includes('rollback')
        ? h('button', { class: 'btn', style: 'margin-top:8px', onclick: async (e) => (await ui.confirm({ title: 'Kembali ke versi sebelumnya?', text: 'snugcode di PC dipasang ulang ke versi sebelum pembaruan terakhir, lalu daemon dimulai ulang.', ok: 'Kembalikan', icon: 'refresh' })) && runUpdate(e.currentTarget, () => ui.closeSheet(), 'rollback') }, 'Kembali ke versi sebelumnya')
        : null,
    );
  } catch (e) {
    if (isOldDaemon(e)) return migrateSheet();
    body.replaceChildren(
      h('div', { class: 'err' }, 'Gagal memeriksa pembaruan: ' + e.message),
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => updateMachineSheet() }, 'Coba lagi'),
    );
  }
}
