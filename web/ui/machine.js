// Koneksi ke satu PC: pairing PIN, menu PC, pembaruan jarak jauh, login GitHub PC.
import * as C from '../../shared/crypto.js';
import * as M from '../../shared/models.js';
import { Conn, store } from '../conn.js';
import { app } from './state.js';
import { goMachines } from './auth.js';
import { busyButton, copyText, h, haptic, ic, isOldDaemon, loading, menuItem, toast, ui } from './dom.js';
import { pickModel } from './model-picker.js';
import { enableNotifications, localNotify, syncPush } from './push.js';
import { reattach } from './session.js';
import { sessionSub, showSessions, showSessionsMeta } from './sessions.js';

// ---------- Koneksi ke satu PC ----------
/** @param {{ id: string, name?: string }} m @param {{ sid?: string }} [opts] */
export function openMachine(m, { sid } = {}) {
  app.conn?.close();
  app.conn = new Conn(m);
  app.current = { m, resumeSid: sid };
  store.set('last', { mid: m.id, sid });
  const msg = h('div', { class: 'muted' });
  const showStatus = (title, text, busy = true) =>
    ui.view(h('div', { class: 'hero' }, h('div', { class: 'lockicon' }, busy ? h('span', { class: 'spinner', style: 'width:26px;height:26px' }) : ic('monitor')), h('h1', {}, title), msg, text ? h('p', { class: 'dim small' }, text) : null));
  ui.set(m.name, { sub: 'menghubungkan…', back: goMachines, dot: 'busy' });
  msg.textContent = 'Membuka kanal terenkripsi ke PC…';
  showStatus('Menghubungkan');
  app.conn.on('state', (s) => {
    if (s === 'offline') {
      ui.dot('off');
      ui.sub('offline');
      if (!app.current.ready) {
        msg.textContent = 'PC sedang offline.';
        showStatus('Menunggu PC', 'Pastikan pocketcode berjalan di PC (pocketcode autostart on) dan PC tidak tertidur. Halaman ini tersambung otomatis begitu PC online.', true);
      } else toast('PC offline — menunggu tersambung lagi…', true);
    } else if (s === 'online' || s === 'reconnecting') {
      ui.dot('busy');
      if (app.current.ready) ui.sub('menyambung ulang…');
    } else if (s === 'needpin') showPin(m);
    else if (s === 'revoked') (toast('HP ini dicabut aksesnya dari PC.', true), showPin(m));
    else if (s === 'removed') (toast('PC ini sudah dihapus dari akun.', true), goMachines());
    else if (s === 'authfail') toast('Verifikasi PC gagal.', true);
  });
  app.conn.on('ready', (info) => {
    ui.dot('on');
    const first = !app.current.ready;
    app.current.ready = true;
    app.current.info = info;
    clearInterval(app.current.updateTimer);
    app.current.updateTimer = setInterval(() => checkUpdateStatus(true), 90000);
    checkUpdateStatus(false);
    syncPush(false);
    if (document.visibilityState !== 'visible') app.conn.call('visible', { on: false }).catch(() => {});
    if (first) showSessions();
    else if (app.current.session) (reattach(), ui.sub(sessionSub(app.current.session)));
    else showSessionsMeta();
  });
  app.conn.on('events', (msg) => app.current?.onEvents?.(msg));
  app.conn.on('github', (msg) => onGithubStatus(msg));
  app.conn.on('update', (st) => onUpdateStatus(st, true));
  app.conn.on('notice', (msg) => {
    if (app.current?.session?.id === msg.sid && document.visibilityState === 'visible') return;
    toast(`${msg.title}: ${msg.msg}`);
    localNotify('pocketcode', `${msg.title}: ${msg.msg}`);
  });
  app.conn.connect();
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
  const btn = h('button', { class: 'btn primary', style: 'margin-top:14px' }, 'Pasangkan');
  const go = async () => {
    const pin = input.value.trim();
    if (!C.PIN_RE.test(pin)) {
      err.textContent = 'PIN 6–12 huruf/angka.';
      wrap.classList.remove('shake');
      void wrap.offsetWidth;
      wrap.classList.add('shake');
      return;
    }
    const done = busyButton(btn, 'Memverifikasi…');
    err.textContent = '';
    const r = await app.conn.pair(pin);
    done();
    if (r.ok) return haptic(20);
    input.value = '';
    wrap.classList.remove('shake');
    void wrap.offsetWidth;
    wrap.classList.add('shake');
    haptic(60);
    err.textContent =
      r.reason === 'pin' ? `PIN salah.${r.left != null ? ` Sisa ${r.left} percobaan.` : ''}`
      : r.reason === 'locked' ? 'Pairing terkunci karena terlalu banyak PIN salah. Jalankan `pocketcode pin` di PC.'
      : r.reason === 'slow' ? 'Terlalu cepat, tunggu beberapa detik.'
      : r.reason === 'nopin' ? 'PC belum punya PIN. Jalankan `pocketcode setup`.'
      : 'Gagal: ' + r.reason;
  };
  btn.onclick = go;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') go();
  };
  ui.view(
    h('div', { class: 'scroll' },
      h('div', { class: 'hero' },
        h('div', { class: 'lockicon' }, ic('lock')),
        h('h1', {}, 'Pasangkan HP ini'),
        h('div', { class: 'muted' }, `Masukkan PIN yang kamu buat saat setup di `, h('b', {}, m.name), '.'),
        h('div', { class: 'dim small', style: 'margin-top:6px' }, 'Cukup sekali per HP. PIN diverifikasi langsung oleh PC — tidak pernah dikirim ke server.'),
        wrap, err, btn,
      ),
    ),
  );
  setTimeout(() => input.focus(), 120);
}

// ---------- Pembaruan PC Otomatis (dari HP) ----------
export function renderUpdateBanner() {
  const el = document.getElementById('updateBanner');
  if (!el) return;
  const st = app.current?.updateStatus;
  if (!st?.updateAvailable) return el.replaceChildren();

  const sha = st.latestCommit ? st.latestCommit.slice(0, 7) : 'terbaru';
  const behind = st.commitsBehind > 1 ? `${st.commitsBehind} commit tertinggal` : 'Pembaruan baru tersedia';
  const msg = st.latestMessage ? `"${st.latestMessage}"` : behind;

  const upBtn = h(
    'button',
    {
      class: 'btn-up-now',
      onclick: async (e) => {
        e.stopPropagation();
        const done = busyButton(e.currentTarget, 'Memperbarui…');
        try {
          haptic(20);
          const res = await app.conn.call('update');
          haptic(25);
          toast(res.message || 'Pembaruan berhasil! PC sedang me-restart…', false, 7000);
          app.current.updateStatus = null;
          renderUpdateBanner();
          showSessionsMeta();
        } catch (err) {
          done();
          toast('Pembaruan gagal: ' + err.message, true, 6000);
        }
      },
    },
    'Perbarui PC',
  );

  el.replaceChildren(
    h(
      'button',
      {
        class: 'card update-banner',
        onclick: () => updateMachineSheet(),
      },
      h('span', { class: 'avatar up-avatar' }, ic('spark')),
      h(
        'span',
        { class: 'grow' },
        h('div', { class: 'name' }, `Pembaruan PC Tersedia (${sha})`),
        h('div', { class: 'sub', style: 'white-space:normal' }, `${msg} · Ketuk untuk rincian`),
      ),
      upBtn,
    ),
  );
}

export function onUpdateStatus(st, notify = false) {
  if (!app.current) return;
  const was = app.current.updateStatus?.updateAvailable;
  app.current.updateStatus = st;
  renderUpdateBanner();
  showSessionsMeta();
  if (st.updateAvailable && !was && notify) {
    haptic(15);
    toast(`Pembaruan pocketcode tersedia (${st.latestCommit})! Ketuk banner untuk perbarui.`, false, 6000);
  }
}

export async function checkUpdateStatus(notify = false) {
  if (!app.conn || !app.current?.ready) return;
  try {
    const st = await app.conn.call('updateStatus');
    onUpdateStatus(st, notify);
  } catch {}
}

// ---------- Login GitHub PC (dari HP) ----------
// Token GitHub di PC bisa dicabut. Daemon memulai device flow dan kodenya
// tampil di sini, jadi login ulang bisa dilakukan dari mana saja.
export const ghBad = () => ['invalid', 'missing'].includes(app.current?.info?.githubState);

export function renderGhBanner() {
  const el = document.getElementById('ghBanner');
  if (!el) return;
  if (!ghBad()) return el.replaceChildren();
  el.replaceChildren(
    h('button', { class: 'card ghwarn', onclick: () => githubLoginSheet() },
      h('span', { class: 'avatar off' }, ic('github')),
      h('span', { class: 'grow' },
        h('div', { class: 'name' }, app.current.info.githubState === 'missing' ? 'GitHub belum login di PC ini' : 'Login GitHub di PC ini tidak berlaku'),
        h('div', { class: 'sub', style: 'white-space:normal' }, 'Push, PR, dan daftar repo tidak bisa dipakai. Ketuk untuk login ulang dari HP.'),
      ),
      ic('right', 'chev'),
    ),
  );
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
        h('div', { class: 'empty' }, h('div', { class: 'big', style: 'color:var(--green)' }, '✓'), h('b', {}, 'GitHub tersambung'), `@${st.login} — push, PR, dan daftar repo bisa dipakai lagi.`),
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
      p.error
        ? h('div', { class: 'err' }, p.error)
        : h('div', { class: 'loading', style: 'justify-content:center' }, h('span', { class: 'spinner' }), h('span', {}, 'menunggu otorisasi · ', left)),
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
    body.replaceChildren(h('div', { class: 'err' }, /Metode tidak dikenal/.test(e.message) ? 'Perbarui pocketcode di PC untuk login GitHub dari HP (jalankan `pocketcode login` di PC).' : e.message));
  }
}

export function modelItem(t1, id, onclick) {
  return menuItem({ icon: 'cpu', t1, t2: M.modelLabel(id) || '(belum dipilih)', onclick });
}

export function showMachineMenu() {
  const info = app.current.info;
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
    ui.head(app.current.m.name, { sub: info.github ? 'GitHub @' + info.github : 'GitHub belum login' }),
    h('div', { class: 'label', style: 'margin-top:4px' }, 'Model'),
    h('div', { class: 'group' },
      modelItem('Default untuk sesi baru', info.model, () => pick('Model default', 'model')),
      modelItem('Model kecil (tugas ringan)', info.smallModel || info.model, () => pick('Model kecil', 'smallModel')),
    ),
    h('div', { class: 'label' }, 'GitHub'),
    h('div', { class: 'group' },
      menuItem({ icon: 'github', t1: ghBad() ? 'Login GitHub (perlu)' : 'Login ulang GitHub', t2: info.github && !ghBad() ? '@' + info.github + ' · tersambung' : 'push, PR, dan daftar repo', onclick: () => githubLoginSheet() }),
    ),
    h('div', { class: 'label' }, 'Sistem & Pembaruan'),
    h('div', { class: 'group' },
      menuItem({
        icon: 'spark',
        t1: 'Perbarui pocketcode di PC',
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
            if (wtCount === 0 && repoCount === 0) {
              toast('Workspace PC sudah bersih.');
            } else {
              toast(`Dibersihkan: ${wtCount} worktree, ${repoCount} repo`);
            }
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
          if (!confirm('Restart daemon pocketcode di PC sekarang? Sesi akan otomatis tersambung lagi setelah beberapa detik.')) return;
          try {
            const r = await app.conn.call('restart');
            toast(r.message || 'Daemon me-restart…');
            ui.closeSheet();
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ),
    h('div', { class: 'label' }, 'Perangkat'),
    h('div', { class: 'group' },
      menuItem({ icon: 'bell', t1: 'Izinkan notifikasi', t2: 'Kabar saat agen selesai / butuh izin', onclick: enableNotifications }),
      menuItem({ icon: 'unlink', t1: 'Lupakan pairing HP ini', t2: 'Perlu PIN lagi untuk tersambung', danger: true, chev: false, onclick: () => (store.set('dev.' + app.current.m.id, null), ui.closeSheet(), openMachine(app.current.m)) }),
    ),
  );
}

export async function updateMachineSheet() {
  const body = h('div', {}, loading('Memeriksa pembaruan di PC…'));
  ui.sheet(ui.head('Pembaruan PC', { sub: app.current.m.name }), body);
  try {
    const st = await app.conn.call('updateStatus');
    const hasUpdate = st.updateAvailable;
    const currentTxt = st.currentCommit ? `Commit saat ini: ${st.currentCommit}` : '';
    const latestTxt = st.latestCommit ? `Versi terbaru: ${st.latestCommit}` : '';
    const msgTxt = st.latestMessage ? `"${st.latestMessage}"` : '';

    const btn = h(
      'button',
      {
        class: 'btn primary',
        style: 'margin-top:14px',
        onclick: async (e) => {
          const done = busyButton(e.currentTarget, 'Memperbarui di PC…');
          try {
            const res = await app.conn.call('update');
            haptic(25);
            toast(res.message || 'Pembaruan berhasil! PC sedang me-restart…', false, 6000);
            ui.closeSheet();
          } catch (err) {
            done();
            toast('Pembaruan gagal: ' + err.message, true, 6000);
          }
        },
      },
      hasUpdate ? 'Perbarui Sekarang' : 'Paksa Perbarui Ulang',
    );

    body.replaceChildren(
      h(
        'div',
        { class: 'empty', style: 'padding:16px 0' },
        h('div', { class: 'big', style: hasUpdate ? 'color:var(--yellow)' : 'color:var(--green)' }, hasUpdate ? '⬆' : '✓'),
        h('b', {}, hasUpdate ? 'Pembaruan Tersedia!' : 'pocketcode Sudah Versi Terbaru'),
        hasUpdate && msgTxt ? h('div', { style: 'color:var(--fg);margin-top:4px;font-size:14px;word-break:break-word' }, msgTxt) : null,
        h('div', { class: 'dim small', style: 'margin-top:8px' }, `${currentTxt} · ${latestTxt}`),
      ),
      btn,
    );
  } catch (e) {
    if (isOldDaemon(e)) {
      const isWin = app.current?.info?.platform === 'win32';
      // Windows: claude.exe milik daemon yang masih jalan mengunci file → npm diam-diam
      // melewati binary. Jalankan sebagai proses terpisah (lepas dari sesi ini) yang
      // menghentikan daemon dulu, baru memasang, lalu menyalakan daemon lagi.
      const upCmd = isWin
        ? `Start-Process cmd -WindowStyle Hidden -ArgumentList '/c pocketcode stop & ping -n 4 127.0.0.1 >nul & npm i -g github:arfakaisar/pocketcode --include=optional > "%USERPROFILE%\\.pocketcode\\update.log" 2>&1 & pocketcode restart'`
        : 'npm i -g github:arfakaisar/pocketcode --include=optional && pocketcode restart';
      body.replaceChildren(
        h(
          'div',
          { class: 'empty', style: 'padding:16px 0' },
          h('div', { class: 'big', style: 'color:var(--yellow)' }, '⬆'),
          h('b', {}, 'Daemon PC Perlu Pembaruan Awal'),
          h('div', { class: 'dim small', style: 'margin-top:8px;line-height:1.5' },
            'Daemon di PC masih versi lama sebelum ada fitur pembaruan otomatis jarak jauh. Klik tombol di bawah untuk memasang pembaruan ke PC lewat sesi aktif:'
          ),
          h(
            'button',
            {
              class: 'btn primary',
              style: 'margin-top:14px',
              onclick: async (btnEv) => {
                const done = busyButton(btnEv.currentTarget, 'Mengirim perintah update…');
                try {
                  // Perintah dijalankan lewat sesi yang sedang tidak sibuk. Daemon lama tidak bisa
                  // membuat sesi tanpa repo, jadi tanpa sesi pengguna diarahkan ke perintah manual.
                  const target = (await app.conn.call('sessions')).find((s) => s.status !== 'running');
                  if (!target) throw new Error('tidak ada sesi yang sedang menganggur. Buat sesi dulu, atau jalankan perintah di bawah langsung di terminal PC.');
                  await app.conn.call('send', { id: target.id, text: '!' + upCmd });
                  toast('Perintah update dikirim ke PC. Daemon akan me-restart…', false, 7000);
                  ui.closeSheet();
                } catch (err) {
                  done();
                  toast('Gagal: ' + err.message, true);
                }
              },
            },
            'Perbarui PC Sekarang (via Sesi)',
          ),
          h('div', { class: 'dim small', style: 'margin-top:14px;font-size:12px' },
            'Atau ketik langsung di chat sesi:',
          ),
          h('pre', { style: 'margin-top:4px;padding:8px;background:var(--bg2);border-radius:6px;user-select:all;font-size:12px;word-break:break-all' },
            '!' + upCmd
          ),
        ),
      );
      return;
    }
    body.replaceChildren(
      h('div', { class: 'err' }, 'Gagal memeriksa pembaruan: ' + e.message),
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => updateMachineSheet() }, 'Coba Lagi'),
    );
  }
}
