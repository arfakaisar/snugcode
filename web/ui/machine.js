// Koneksi ke satu PC: pairing PIN, pengaturan PC, pembaruan jarak jauh, login GitHub PC.
import * as C from '../../shared/crypto.js';
import * as M from '../../shared/models.js';
import { Conn, store } from '../conn.js';
import { app } from './state.js';
import { goMachines } from './auth.js';
import { anim, busyButton, copyText, h, haptic, ic, isOldDaemon, loading, menuItem, spark, toast, ui } from './dom.js';
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
    ui.view(h('div', { class: 'hero center' }, busy ? spark('think xl') : h('div', { class: 'lockicon' }, ic('monitor')), h('h1', { class: 'serif' + (busy ? ' shimmer' : '') }, title), msg, text ? h('p', { class: 'dim small' }, text) : null));
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
async function runUpdate(btn, after) {
  const done = busyButton(btn, 'Memperbarui…');
  try {
    haptic(20);
    const res = await app.conn.call('update');
    haptic(25);
    toast(res.message || 'Pembaruan berhasil! PC sedang me-restart…', false, 7000);
    after?.();
  } catch (err) {
    done();
    toast('Pembaruan gagal: ' + err.message, true, 6000);
  }
}

export function renderUpdateBanner() {
  const el = document.getElementById('updateBanner');
  if (!el) return;
  const st = app.current?.updateStatus;
  if (!st?.updateAvailable) return el.replaceChildren();

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
  el.replaceChildren(
    h('button', { class: 'banner up', onclick: () => updateMachineSheet() },
      h('span', { class: 'bi' }, ic('spark')),
      h('span', { class: 'grow' }, h('div', { class: 'name' }, `Pembaruan PC tersedia · ${sha}`), h('div', { class: 'sub' }, msg)),
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
    h('button', { class: 'banner warn', onclick: () => githubLoginSheet() },
      h('span', { class: 'bi' }, ic('github')),
      h('span', { class: 'grow' },
        h('div', { class: 'name' }, app.current.info.githubState === 'missing' ? 'GitHub belum login di PC ini' : 'Login GitHub di PC ini tidak berlaku'),
        h('div', { class: 'sub' }, 'Push, PR, dan daftar repo tidak bisa dipakai. Ketuk untuk login ulang dari HP.'),
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
      p.error ? h('div', { class: 'err' }, p.error) : h('div', { class: 'loading', style: 'justify-content:center' }, spark('think'), h('span', {}, 'menunggu otorisasi · ', left)),
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
    ui.head('Pengaturan PC', { sub: app.current.m.name }),
    h('div', { class: 'pchero' },
      h('span', { class: 'avatar' }, ic('monitor'), h('i', { class: 'live' })),
      h('div', { class: 'grow' }, h('b', {}, app.current.m.name), h('div', { class: 'dim small' }, [{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[info.platform] || info.platform, info.commit ? 'v' + info.commit : null, info.github && !ghBad() ? '@' + info.github : 'GitHub belum login'].filter(Boolean).join(' · '))),
    ),
    h('div', { class: 'label' }, 'Model'),
    h('div', { class: 'group' },
      modelItem('Default untuk sesi baru', info.model, () => pick('Model default', 'model')),
      // Model ringan subagen dipilih otomatis oleh daemon (Claude Haiku 5.5 / Gemini 3.8 Flash).
      info.lightModel
        ? menuItem({ icon: 'bolt', t1: 'Model ringan (subagen) · otomatis', t2: M.modelLabel(info.lightModel), chev: false, onclick: () => toast('Dipilih otomatis: Haiku 5.5 untuk model Claude, Gemini 3.8 Flash untuk model lain') })
        : modelItem('Model kecil (tugas ringan)', info.smallModel || info.model, () => pick('Model kecil', 'smallModel')),
    ),
    h('div', { class: 'label' }, 'GitHub'),
    h('div', { class: 'group' },
      menuItem({ icon: 'github', t1: ghBad() ? 'Login GitHub (perlu)' : 'Login ulang GitHub', t2: info.github && !ghBad() ? '@' + info.github + ' · tersambung' : 'push, PR, dan daftar repo', onclick: () => githubLoginSheet() }),
    ),
    h('div', { class: 'label' }, 'Sistem & pembaruan'),
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
          if (!(await ui.confirm({ title: 'Restart daemon?', text: 'Daemon pocketcode di PC dimulai ulang. Sesi tersambung lagi otomatis setelah beberapa detik.', ok: 'Restart', icon: 'refresh' }))) return;
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
        h('b', {}, hasUpdate ? 'Pembaruan tersedia' : 'pocketcode sudah versi terbaru'),
        hasUpdate && st.latestMessage ? h('div', { class: 'quote' }, st.latestMessage) : null,
        h('div', { class: 'tags', style: 'justify-content:center;margin-top:12px' },
          st.currentCommit ? h('span', { class: 'tag' }, 'sekarang ' + st.currentCommit) : null,
          st.latestCommit ? h('span', { class: 'tag' + (hasUpdate ? ' on' : '') }, 'terbaru ' + st.latestCommit) : null,
        ),
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
        h('div', { class: 'empty', style: 'padding:16px 0' },
          h('div', { class: 'emptyart up' }, ic('push')),
          h('b', {}, 'Daemon PC perlu pembaruan awal'),
          h('div', { class: 'dim small', style: 'margin-top:8px;line-height:1.5' },
            'Daemon di PC masih versi lama sebelum ada fitur pembaruan otomatis jarak jauh. Ketuk tombol di bawah untuk memasang pembaruan ke PC lewat sesi aktif:',
          ),
          h('button', {
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
          }, 'Perbarui PC sekarang (via sesi)'),
          h('div', { class: 'dim small', style: 'margin-top:14px' }, 'Atau ketik langsung di chat sesi:'),
          h('pre', { class: 'shout', style: 'user-select:all;text-align:left;word-break:break-all' }, '!' + upCmd),
        ),
      );
      return;
    }
    body.replaceChildren(
      h('div', { class: 'err' }, 'Gagal memeriksa pembaruan: ' + e.message),
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => updateMachineSheet() }, 'Coba lagi'),
    );
  }
}
