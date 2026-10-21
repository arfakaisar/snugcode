// Layar sesi (percakapan dengan agen): header git/run, composer kartu dengan tombol + (lampiran,
// mode, aksi cepat), pil mode aktif, pemilih model, dan attach ulang setelah koneksi pulih.
import * as M from '../../shared/models.js';
import { EventCursor } from '../../shared/events.js';
import { store } from '../conn.js';
import { app } from './state.js';
import { anim, coarse, drawer, h, haptic, ic, isOldDaemon, menuItem, onLongPress, pop, mascot, toast, toggleItem, ui } from './dom.js';
import { showGit } from './git.js';
import { showFiles } from './files.js';
import { prefetchTerminal, showTerminal } from './terminal.js';
import { pickModel } from './model-picker.js';
import { Renderer } from './renderer.js';
import { onProc, showRun } from './run.js';
import { deleteSession, repoName, sessionSub, showSessions, tildify } from './sessions.js';

const has = (m) => !!app.current.info?.caps?.includes(m);

// Preset otonomi (shared/risk.js AUTONOMY): label, penjelasan, ikon.
const AUTONOMY_UI = {
  ask: ['Tanya semua', 'setiap edit & perintah menunggu persetujuanmu', 'eye'],
  balanced: ['Seimbang', 'edit langsung (bisa di-rewind), perintah ditanyakan', 'shield'],
  trusted: ['Rutin otomatis', 'test, lint & build langsung jalan; perintah lain ditanyakan', 'flask'],
  auto: ['Penuh', 'semua langsung jalan, kecuali push & PR', 'bolt'],
};

// ---------- Layar: sesi ----------
export const QUICK = [
  { icon: 'book', t1: 'Jelaskan repo ini', t2: 'struktur, cara menjalankan, bagian penting', text: 'Jelaskan struktur repo ini, cara menjalankannya, dan bagian terpentingnya. Singkat.' },
  { icon: 'diff', t1: 'Review perubahan', t2: 'cek git diff, cari bug, ringkas', text: 'Review perubahan yang belum di-commit (git diff): cari bug atau risiko, lalu ringkas.' },
  { icon: 'flask', t1: 'Jalankan & perbaiki test', t2: 'temukan perintah test, jalankan, perbaiki yang gagal', text: 'Temukan cara menjalankan test di repo ini, jalankan, lalu perbaiki yang gagal.' },
  { icon: 'bug', t1: 'Perbaiki error terakhir', t2: 'lanjutkan dari output sebelumnya', text: 'Perbaiki error terakhir yang muncul di sesi ini, lalu verifikasi.' },
  { icon: 'commit', t1: 'Commit perubahan', t2: 'tulis pesan commit yang jelas lalu commit', text: 'Lihat perubahan yang ada, tulis pesan commit yang jelas, lalu commit. Jangan push.' },
];
export const QUICK_SH = ['git status', 'git log --oneline -n 8', 'git diff --stat', 'ls'];

export const QUICK_COMPUTER = [
  { icon: 'monitor', t1: 'Ringkas info sistem', t2: 'OS, CPU, memory, direktori aktif', text: 'Tampilkan ringkasan info sistem: OS, spesifikasi, direktori aktif, dan status lingkungan. Singkat.' },
  { icon: 'term', t1: 'Cek proses & port', t2: 'lihat proses berjalan dan port terbuka', text: 'Cek proses yang sedang berjalan dan port yang sedang digunakan atau terbuka di komputer ini.' },
  { icon: 'bug', t1: 'Perbaiki error terakhir', t2: 'lanjutkan dari output sebelumnya', text: 'Perbaiki error terakhir yang muncul di sesi ini, lalu verifikasi.' },
  { icon: 'search', t1: 'Cari file di komputer', t2: 'bantu cari file atau folder tertentu', text: 'Bantu cari file atau folder di komputer ini.' },
  { icon: 'branch', t1: 'Cek status git', t2: 'periksa repositori git di folder ini jika ada', text: 'Periksa status git di direktori ini jika merupakan git repository.' },
];
export const QUICK_COMPUTER_SH = ['ls', 'git status', 'whoami', 'pwd'];

export function showSession(s) {
  app.current.session = s;
  app.current.cursor = new EventCursor();
  store.set('last', { mid: app.current.m.id, sid: s.id });
  drawer.close();
  if (has('termOpen')) prefetchTerminal();
  const col = h('div', { class: 'col' });
  const term = h('div', { id: 'term' }, col);
  const wl = h('span', { class: 'wl shimmer' }, 'Berpikir…');
  const wt = h('span', { class: 't' }, '0s');
  const working = h('div', { id: 'working', hidden: true }, mascot('think'), wl, wt);
  const toBottom = h('button', { id: 'tobottom', hidden: true, 'aria-label': 'Ke pesan terbaru' }, ic('arrowdown'));
  const dock = h('div', { id: 'dock' });
  const input = h('textarea', { id: 'input', rows: 1, placeholder: s.computer ? 'Perintahkan apa saja di komputermu…' : 'Minta sesuatu ke agen…', autocapitalize: 'sentences', enterkeyhint: coarse ? 'enter' : 'send', 'aria-label': 'Pesan' });
  const send = h('button', { id: 'send', class: 'idle', 'aria-label': 'Kirim' }, ic('send'));
  const plusBtn = h('button', { class: 'cbtn plus', 'aria-label': 'Lampiran & alat' }, ic('plus'));
  const modelChip = h('button', { class: 'cbtn model', 'aria-label': 'Ganti model' });
  const modes = h('div', { id: 'modes', hidden: true });
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const camIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const thumbs = h('div', { id: 'thumbs', hidden: true });
  const gitBadge = h('span', { class: 'badge', hidden: true });
  const gitBtn = h('button', { class: 'iconbtn', 'aria-label': 'Git', title: 'Git', onclick: () => (haptic(6), showGit()) }, ic('branch'), gitBadge);
  const runBtn = h('button', { class: 'iconbtn', 'aria-label': 'Jalankan & preview', title: 'Run & Preview', onclick: () => (haptic(6), showRun()) }, ic('play'));
  const composer = h('div', { id: 'composer' },
    h('div', { class: 'inner' },
      dock,
      h('div', { class: 'cbox' }, thumbs, modes, input, h('div', { class: 'crow' }, plusBtn, modelChip, h('span', { class: 'grow' }), send)),
    ),
    fileIn, camIn,
  );
  ui.set(s.title || repoName(s), { sub: sessionSub(s), menu: true, onTitle: () => sessionMenu(), titleLabel: 'Menu sesi', dot: 'on', actions: [runBtn, gitBtn] });
  const view = h('div', { class: 'session chat' }, term, working, toBottom, composer);
  ui.view(view);

  const r = new Renderer(term, col, dock);
  app.current.renderer = r;
  app.current.procs = new Map();
  app.current.preview = null;

  // Composer melayang di atas percakapan: tinggi aslinya menjadi ruang kosong di bawah pesan.
  const ro = new ResizeObserver(() => {
    if (!view.isConnected) return ro.disconnect();
    view.style.setProperty('--ch', composer.offsetHeight + 'px');
    r.keepBottom();
  });
  ro.observe(composer);

  // --- run & preview: titik hidup + jumlah proses berjalan di header ---
  let lastRun = '';
  app.current.syncRun = () => {
    const n = [...app.current.procs.values()].filter((p) => p.status === 'running').length;
    const pv = !!app.current.preview;
    const key = `${n}|${pv}`;
    runBtn.className = 'iconbtn' + (pv ? ' live' : n ? ' busy' : '');
    if (key !== lastRun) {
      runBtn.replaceChildren(ic(pv ? 'globe' : 'play'), n ? h('span', { class: 'badge' }, n) : null);
      if (lastRun) pop(runBtn.lastElementChild);
      lastRun = key;
    }
    app.current.runSheet?.();
  };

  // --- mode: rencana (di PC), shell (lokal), auto-izin (di PC) — ditampilkan sebagai pil aktif ---
  let shellMode = false;
  const renderModes = () => {
    const ss = app.current.session;
    const pill = (cls, icon, label, off) => h('button', { class: 'mode ' + cls, onclick: () => (haptic(8), Promise.resolve(off()).catch((e) => toast(e.message, true))) }, ic(icon), label, ic('x', 'mx'));
    const list = [
      ss.plan ? pill('plan', 'list', 'Rencana', () => setPlanRemote(false)) : null,
      shellMode ? pill('shell', 'term', 'Shell', () => setMode(false)) : null,
      ss.auto ? pill('auto', 'bolt', 'Auto-izin', () => setAutoRemote(false)) : null,
      !ss.auto && ss.autoLow ? pill('auto low', 'flask', 'Rutin otomatis', () => app.conn.call('autonomy', { id: s.id, level: 'balanced' }).then((r) => (Object.assign(app.current.session, r), renderModes()))) : null,
    ].filter(Boolean);
    const was = !modes.hidden;
    modes.hidden = !list.length;
    modes.replaceChildren(...list);
    if (!was && list.length) anim(modes, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 240);
    input.placeholder = ss.plan ? 'Rencanakan apa?' : shellMode ? (ss.computer ? 'Perintah shell di PC…' : 'Perintah shell di worktree…') : (ss.computer ? 'Perintahkan apa saja di komputermu…' : 'Minta sesuatu ke agen…');
    plusBtn.classList.toggle('on', list.length > 0);
  };
  app.current.setPlan = (on) => {
    app.current.session.plan = on;
    renderModes();
  };
  const setPlanRemote = async (on) => {
    try {
      app.current.setPlan((await app.conn.call('plan', { id: s.id, on })).plan);
      toast(app.current.session.plan ? 'Mode rencana: agen menyusun rencana dulu, tanpa mengubah file' : 'Mode rencana mati');
    } catch (e) {
      throw isOldDaemon(e) ? new Error('Perbarui snugcode di PC untuk mode rencana.') : e;
    }
    return app.current.session.plan;
  };
  const setAuto = (on) => {
    app.current.session.auto = on;
    renderModes();
  };
  // Preset otonomi (daemon baru): satu pilihan bertingkat, bukan sakelar auto-izin + tinjau edit terpisah.
  const autonomySheet = () => {
    const cur = app.current.session.autonomy || 'balanced';
    const pick = async (level) => {
      if (level === cur) return ui.closeSheet();
      if (level === 'auto' && !(await ui.confirm({ title: 'Otonomi penuh?', text: 'Agen boleh menjalankan perintah shell apa pun tanpa bertanya (di sandbox OS bila tersedia). git push dan pembuatan PR tetap selalu meminta izin. Semua perubahan file tetap bisa di-rewind.', ok: 'Nyalakan', danger: true, icon: 'bolt' }))) return;
      try {
        Object.assign(app.current.session, await app.conn.call('autonomy', { id: s.id, level }));
        renderModes();
        ui.closeSheet();
        toast('Otonomi: ' + AUTONOMY_UI[level][0]);
      } catch (e) {
        toast(e.message, true);
      }
    };
    ui.sheet(
      ui.head('Otonomi agen', { sub: 'Seberapa banyak agen boleh bekerja tanpa bertanya' }),
      h('div', { class: 'group autonomy' },
        ...Object.entries(AUTONOMY_UI).map(([level, [t1, t2, icon]]) =>
          h('button', { class: 'menuitem' + (level === cur ? ' on' : ''), 'aria-pressed': String(level === cur), onclick: () => (haptic(8), pick(level)) },
            h('span', { class: 'mi' }, ic(icon)),
            h('span', { class: 'grow' }, h('div', { class: 't1' }, t1), h('div', { class: 't2' }, t2)),
            level === cur ? ic('check', 'chev') : null,
          ),
        ),
      ),
      h('p', { class: 'muted small', style: 'margin:12px 4px 0' }, 'Push ke GitHub, pembuatan PR, dan file kredensial selalu ditanyakan di semua tingkat.'),
    );
  };
  const setAutoRemote = async (on) => {
    if (on && !(await ui.confirm({ title: 'Nyalakan auto-izin?', text: 'Agen boleh menjalankan perintah shell apa pun tanpa bertanya. git push dan pembuatan PR tetap selalu meminta izin.', ok: 'Nyalakan', danger: true, icon: 'bolt' }))) return false;
    setAuto((await app.conn.call('auto', { id: s.id, on })).auto);
    if (on) toast('Auto-izin aktif');
    return app.current.session.auto;
  };
  const setMode = (sh) => {
    shellMode = sh;
    input.classList.toggle('shell', sh || input.value.startsWith('!'));
    input.autocapitalize = sh ? 'off' : 'sentences';
    renderModes();
  };

  // --- lampiran gambar (kamera, galeri, atau tempel dari clipboard) ---
  let images = [];
  const renderThumbs = () => {
    thumbs.hidden = !images.length;
    thumbs.replaceChildren(...images.map((im, i) => h('button', { class: 'thumb', style: `--i:${i}`, 'aria-label': 'Hapus gambar', onclick: () => ((images = images.filter((_, j) => j !== i)), renderThumbs(), syncSend()) }, h('img', { src: `data:${im.mime};base64,${im.data}`, alt: '' }), ic('x'))));
  };
  const addImages = async (files) => {
    for (const f of [...files].filter((f) => f.type.startsWith('image/'))) {
      if (images.length >= 4) return toast('Maksimal 4 gambar', true);
      try {
        images.push(await compressImage(f));
      } catch {
        toast('Gambar tidak bisa dibaca', true);
      }
    }
    renderThumbs();
    syncSend();
  };
  fileIn.onchange = () => (addImages(fileIn.files), (fileIn.value = ''));
  camIn.onchange = () => (addImages(camIn.files), (camIn.value = ''));
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) (e.preventDefault(), addImages(files));
  });
  r.onUnread = (n) => {
    toBottom.hidden = n === 0 && r.stick;
    toBottom.replaceChildren(ic('arrowdown'), n ? h('span', { class: 'n' }, n) : '');
  };
  toBottom.onclick = () => r.scroll(true);

  // --- tombol +: lampiran, mode, aksi cepat dalam satu sheet ---
  const tile = (icon, label, onclick) => h('button', { class: 'tile', onclick: () => (haptic(6), onclick()) }, h('span', { class: 'ti' }, ic(icon)), label);
  plusBtn.onclick = () => {
    haptic(6);
    const ss = app.current.session;
      const isComp = !!ss.computer;
      const qkList = isComp ? QUICK_COMPUTER : QUICK;
      const qkShList = isComp ? QUICK_COMPUTER_SH : QUICK_SH;
      return ui.sheet(
        ui.head('Lampiran & alat'),
        h('div', { class: 'tiles' },
          tile('camera', 'Kamera', () => (ui.closeSheet(), camIn.click())),
          tile('image', 'Galeri', () => (ui.closeSheet(), fileIn.click())),
          tile('play', 'Run', () => showRun()),
          tile('branch', 'Git', () => showGit()),
          has('files') ? tile('folder', 'File', () => ((app.current.filesDir = ''), showFiles())) : null,
          has('termOpen') ? tile('term', 'Terminal', () => showTerminal()) : null,
        ),
        h('div', { class: 'label' }, 'Mode'),
        h('div', { class: 'group' },
          toggleItem({ icon: 'list', t1: 'Mode rencana', t2: 'agen membaca & menyusun rencana dulu', on: !!ss.plan, onchange: setPlanRemote }),
          toggleItem({ icon: 'term', t1: 'Mode shell', t2: 'pesan dikirim sebagai perintah ($)', on: shellMode, onchange: (v) => (setMode(v), v) }),
          has('autonomy')
            ? menuItem({ icon: 'bolt', t1: 'Otonomi agen', t2: AUTONOMY_UI[ss.autonomy || 'balanced'][0] + ' · ' + AUTONOMY_UI[ss.autonomy || 'balanced'][1], onclick: autonomySheet })
            : toggleItem({ icon: 'bolt', t1: 'Auto-izin', t2: 'tanpa bertanya, kecuali push & PR', on: !!ss.auto, danger: true, onchange: setAutoRemote }),
          // Bawaan: edit di worktree langsung diterapkan (bisa di-rewind); nyalakan untuk menyetujui tiap diff.
          'askEdits' in ss && !has('autonomy')
            ? toggleItem({
                icon: 'diff', t1: 'Tinjau setiap edit', t2: 'Write/Edit menunggu persetujuanmu', on: !!ss.askEdits,
                onchange: async (on) => {
                  try {
                    Object.assign(app.current.session, await app.conn.call('edits', { id: s.id, on }));
                  } catch (e) {
                    throw isOldDaemon(e) ? new Error('Perbarui snugcode di PC untuk fitur ini') : e;
                  }
                  return app.current.session.askEdits;
                },
              })
            : null,
        ),
        h('div', { class: 'label' }, 'Aksi cepat'),
        savedPrompts(ss, input.value.trim(), (t) => (ui.closeSheet(), quick(t))),
        h('div', { class: 'group' }, ...qkList.map((qk) => menuItem({ icon: qk.icon, t1: qk.t1, t2: qk.t2, onclick: () => (ui.closeSheet(), quick(qk.text)) }))),
        h('div', { class: 'label' }, 'Shell'),
        h('div', { class: 'qsh' }, ...qkShList.map((c) => h('button', { class: 'chip mono', onclick: () => (ui.closeSheet(), quick('!' + c)) }, '$ ' + c))),
      );
  };

  // --- model ---
  const setModelChip = () => {
    const p = M.parseModelId(app.current.session.model || '');
    modelChip.replaceChildren(h('span', { class: 'ml' }, p.base || 'model'), p.effort ? h('span', { class: 'eff' }, M.EFFORT_LABEL[p.effort] || p.effort) : '', ic('down', 'cv'));
  };
  setModelChip();
  const changeModel = () => {
    if (app.current.running) return toast('Tunggu agen selesai (atau Stop) sebelum ganti model.', true);
    pickModel({
      title: 'Model sesi ini',
      current: app.current.session.model,
      onPick: async (id) => {
        let sum;
        try {
          sum = await app.conn.call('setSessionModel', { id: s.id, model: id });
        } catch (e) {
          throw isOldDaemon(e) ? new Error('Perbarui snugcode di PC untuk ganti model di tengah sesi.') : e;
        }
        app.current.session.model = sum.model;
        setModelChip();
        pop(modelChip);
        ui.closeSheet();
        toast('Model: ' + M.modelLabel(id));
      },
    });
  };
  app.current.changeModel = changeModel;
  modelChip.onclick = () => (haptic(6), changeModel());

  // --- git: badge jumlah perubahan di header ---
  let gitT;
  let gitLast = '';
  app.current.refreshGit = () => {
    clearTimeout(gitT);
    gitT = setTimeout(async () => {
      try {
        const st = await app.conn.call('status', { id: s.id });
        if (st.notRepo) {
          gitBadge.hidden = true;
          return;
        }
        const n = st.files?.length || 0;
        const txt = n ? String(n) : st.ahead ? '↑' + st.ahead : '';
        gitBadge.hidden = !txt;
        gitBadge.textContent = txt;
        if (txt && txt !== gitLast) pop(gitBadge);
        gitLast = txt;
      } catch {}
    }, 700);
  };

  setAuto(!!s.auto);
  setMode(false);

  // --- status berjalan + indikator kerja ---
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const setRunning = (on) => {
    const was = app.current.running;
    app.current.running = on;
    if (!!was !== on) {
      send.replaceChildren(ic(on ? 'stop' : 'send'));
      anim(send.firstChild, [{ transform: 'scale(.4) rotate(-90deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    }
    send.setAttribute('aria-label', on ? 'Hentikan' : 'Kirim');
    syncSend();
    ui.dot(on ? 'busy' : 'on');
    clearInterval(app.current.workTimer);
    working.hidden = !on;
    if (on) {
      const t0 = app.current.runStart && was ? app.current.runStart : Date.now();
      app.current.runStart = t0;
      const tick = () => {
        const sec = Math.round((Date.now() - t0) / 1000);
        wt.textContent = sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
        const txt = r.permQueue.length ? 'Menunggu izinmu' : cap(r.activity || 'berpikir…');
        if (wl.textContent !== txt) wl.textContent = txt;
        working.classList.toggle('wait', r.permQueue.length > 0);
      };
      tick();
      app.current.workTimer = setInterval(tick, 1000);
    } else if (was) {
      app.current.runStart = null;
      app.current.refreshGit();
    }
  };
  const syncSend = () => {
    const has = input.value.trim().length > 0 || images.length > 0;
    send.className = app.current.running ? 'stop' : has ? '' : 'idle';
  };
  app.current.setRunning = setRunning;
  app.current.onEvents = (msg) => {
    if (msg.sid !== s.id) return;
    for (const e of msg.es) {
      // Event yang sudah diterima (mis. lewat attach setelah reconnect) tidak digambar dua kali.
      if (!app.current.cursor.accept(e)) continue;
      if (e.k === 'status') setRunning(e.s === 'running');
      else if (e.k === 'proc') onProc(e);
      else if (e.k === 'procOut') app.current.procOut?.(e);
      else if (e.k === 'preview') (app.current.preview = e.url ? e : null), app.current.syncRun();
      else if (e.k === 'mode') app.current.setPlan(e.plan);
      else r.add(e);
      if (e.k === 'done') (haptic(e.ok ? 15 : 50), e.ok || toast('Agen berhenti: ' + (e.err || 'error'), true));
    }
  };

  // --- input ---
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, window.innerHeight * 0.38) + 'px';
  };
  input.oninput = () => {
    autosize();
    syncSend();
    input.classList.toggle('shell', shellMode || input.value.startsWith('!'));
  };
  const submit = async () => {
    if (app.current.running) {
      haptic(20);
      await app.conn.call('interrupt', { id: s.id }).catch((e) => toast(e.message, true));
      return;
    }
    let text = input.value.trim();
    const imgs = images;
    if (!text && !imgs.length) return input.focus();
    if (shellMode && !imgs.length && !text.startsWith('!')) text = '!' + text;
    input.value = '';
    images = [];
    renderThumbs();
    autosize();
    syncSend();
    input.classList.toggle('shell', shellMode);
    haptic(10);
    anim(send, [{ transform: 'translateY(0)' }, { transform: 'translateY(-5px) scale(.92)' }, { transform: 'none' }], 300);
    r.scroll(true);
    try {
      await app.conn.call('send', { id: s.id, text, ...(imgs.length ? { images: imgs } : {}) });
    } catch (e) {
      toast(e.message, true);
      input.value = text;
      images = imgs;
      renderThumbs();
      syncSend();
    }
  };
  const quick = (t) => {
    input.value = t;
    submit();
  };
  // Isi composer dari layar lain (mis. "Tanya agen" di file explorer) tanpa langsung mengirim.
  app.current.compose = (t) => {
    input.value = t + input.value;
    autosize();
    syncSend();
    input.focus();
    input.setSelectionRange(t.length, t.length);
  };
  r.suggest = QUICK;
  r.onQuick = quick;
  if (s.computer) r.nextSteps = [['Lanjutkan', 'Lanjutkan.'], ['Ringkas hasilnya', 'Ringkas apa yang barusan dilakukan dan hasilnya.']];
  send.onclick = submit;
  input.onkeydown = (e) => {
    // HP: Enter = baris baru (kirim pakai tombol). Keyboard fisik: Enter kirim, Shift+Enter baris baru.
    if (e.key === 'Enter' && !e.isComposing && ((!coarse && !e.shiftKey) || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };
  input.addEventListener('focus', () => setTimeout(() => r.keepBottom(), 300));
  reattach(true);
}

export async function reattach(fresh) {
  const s = app.current.session;
  const r = app.current.renderer;
  try {
    const cursor = app.current.cursor;
    const res = await app.conn.call('attach', { id: s.id, since: fresh ? 0 : cursor.lastSeq });
    if (fresh && res.truncated) r.line('meta', '… riwayat lama tidak ditampilkan');
    r.batch(() => {
      for (const e of res.events) if (cursor.accept(e)) r.add(e, true);
    });
    for (const p of res.perms) r.add({ k: 'perm', ...p });
    app.current.setRunning(res.session.status === 'running');
    app.current.setPlan(!!res.session.plan);
    app.current.procs = new Map((res.procs || []).map((p) => [p.name, p]));
    app.current.preview = res.preview || null;
    app.current.syncRun();
    if (fresh && !res.events.length) r.welcome(s);
    r.scroll(true);
    app.current.refreshGit?.();
  } catch (e) {
    toast(e.message, true);
  }
}

// Kecilkan gambar (sisi terpanjang 1568px, JPEG) agar hemat token dan 4 gambar tetap muat satu
// frame relay (1 MiB; payload terenkripsi membesar ±4/3 karena base64).
export async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k);
  cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  for (const q of [0.8, 0.65, 0.5, 0.35]) {
    const data = cv.toDataURL('image/jpeg', q).split(',')[1];
    if (data.length < 170_000) return { mime: 'image/jpeg', data };
  }
  throw new Error('terlalu besar');
}

// Menu sesi (ketuk judul): rincian, git/run/model, .env, hapus.
export function sessionMenu() {
  const s = app.current.session;
  const isComp = !!s.computer;
  ui.sheet(
    ui.head(s.title || (isComp ? 'Sesi Komputer' : repoName(s)), { sub: sessionSub(s) }),
    h('div', { class: 'tags', style: 'margin:0 0 14px' },
      isComp ? h('span', { class: 'tag' }, ic('monitor'), 'komputer') : null,
      isComp && s.cwd ? h('span', { class: 'tag' }, tildify(s.cwd)) : null,
      !isComp ? h('span', { class: 'tag' }, ic('branch'), s.branch) : null,
      !isComp ? h('span', { class: 'tag' }, 'base ' + s.base) : null,
      h('span', { class: 'tag' }, ic('cpu'), M.modelLabel(s.model)),
      s.local ? h('span', { class: 'tag' }, ic('term'), 'terminal') : null,
    ),
    // Jaring pengaman yang terlihat: pengguna tahu kerja agen terisolasi dan bisa dikembalikan.
    !isComp && !s.local ? h('p', { class: 'muted small safety' }, ic('shield'), `Agen bekerja di branch ${s.branch} terpisah; branch ${s.base} tidak berubah sampai kamu merge. Setiap prompt bisa di-rewind.`) : null,
    h('div', { class: 'group' },
      menuItem({ icon: 'branch', t1: 'Git', t2: 'status, diff, commit, push, PR', onclick: () => showGit() }),
      menuItem({ icon: 'play', t1: 'Run & Preview', t2: 'dev server, log, preview di HP', onclick: () => showRun() }),
      has('files') ? menuItem({ icon: 'folder', t1: 'File', t2: 'jelajah, lihat & edit file', onclick: () => ((app.current.filesDir = ''), showFiles()) }) : null,
      has('termOpen') ? menuItem({ icon: 'term', t1: 'Terminal', t2: 'shell interaktif di ' + (isComp ? 'PC' : 'worktree'), onclick: () => showTerminal() }) : null,
      menuItem({ icon: 'cpu', t1: 'Ganti model / effort', t2: M.modelLabel(s.model), onclick: () => app.current.changeModel?.() }),
      has('budget') ? menuItem({ icon: 'clock', t1: 'Biaya & batas', t2: `${usd(s.spent)} sesi ini · ${s.budget ? 'batas ' + usd(s.budget) : 'tanpa batas'}`, onclick: () => budgetSheet(s) }) : null,
      (s.local || isComp) ? null : menuItem({
        icon: 'save', t1: 'Simpan .env sebagai template', t2: 'dipulihkan otomatis di sesi baru repo ini',
        onclick: async () => {
          try {
            const f = await app.conn.call('envSave', { id: s.id });
            toast(f.length ? 'Disimpan: ' + f.join(', ') : 'Tidak ada file .env di worktree', !f.length);
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ),
    h('div', { class: 'group' },
      menuItem({ icon: 'home', t1: 'Kembali ke beranda', chev: false, onclick: () => (ui.closeSheet(), (ui.dir = -1), showSessions()) }),
      menuItem({ icon: 'trash', t1: 'Hapus sesi', t2: isComp ? 'riwayat sesi di PC dihapus' : 'worktree di PC ikut dihapus', danger: true, chev: false, onclick: () => deleteSession(s) }),
    ),
  );
}

const usd = (v) => '$' + (+v || 0).toFixed(+v && v < 1 ? 3 : 2);

// Batas biaya sesi: rem yang membuat pengguna berani memberi tugas besar. Dicek setiap giliran selesai
// (biaya dari Agent SDK; engine Codex/Gemini tidak melaporkan biaya).
function budgetSheet(s) {
  const field = h('input', { class: 'field', type: 'number', inputmode: 'decimal', min: '0', step: '0.5', placeholder: 'mis. 5', value: s.budget ? String(s.budget) : '' });
  const save = async (v) => {
    try {
      Object.assign(app.current.session, await app.conn.call('budget', { id: s.id, usd: +v || 0 }));
      ui.closeSheet();
      toast(+v ? `Batas biaya sesi: ${usd(+v)}` : 'Batas biaya dimatikan');
    } catch (e) {
      toast(e.message, true);
    }
  };
  ui.sheet(
    ui.head('Biaya & batas', { sub: `${usd(s.spent)} terpakai di sesi ini (perkiraan)` }),
    h('p', { class: 'muted small', style: 'margin:0 4px 12px' }, 'Saat total biaya mencapai batas, prompt berikutnya ditahan dan kamu diberi tahu (juga peringatan di 80%). Biaya hanya tersedia untuk model yang berjalan di Claude Agent SDK.'),
    h('div', { class: 'chips', style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' }, ...[1, 5, 20].map((v) => h('button', { class: 'btn', onclick: () => save(v) }, usd(v)))),
    field,
    h('div', { class: 'btnrow', style: 'margin-top:12px' },
      h('button', { class: 'btn ghost', onclick: () => save(0) }, 'Tanpa batas'),
      h('button', { class: 'btn primary', onclick: () => save(field.value) }, 'Simpan'),
    ),
  );
}

// Prompt tersimpan per repo (HP ini): permintaan yang sering diulang cukup satu ketukan. Teks di kotak pesan
// bisa disimpan dari sini; tekan lama untuk menghapus.
function savedPrompts(ss, draft, run) {
  const key = 'prompts.' + (ss.computer ? 'computer' : ss.repo);
  const list = /** @type {string[]} */ (store.get(key) || []);
  const save = () => {
    store.set(key, [draft, ...list.filter((x) => x !== draft)].slice(0, 12));
    toast('Disimpan sebagai prompt cepat');
    ui.closeSheet();
  };
  const items = list.map((t) => {
    const el = menuItem({ icon: 'spark', t1: t.length > 60 ? t.slice(0, 60) + '…' : t, t2: 'tersimpan · tekan lama untuk hapus', onclick: () => run(t) });
    onLongPress(el, async () => {
      if (!(await ui.confirm({ title: 'Hapus prompt tersimpan?', text: t.slice(0, 200), ok: 'Hapus', danger: true, icon: 'trash' }))) return;
      store.set(key, (store.get(key) || []).filter((x) => x !== t));
    });
    return el;
  });
  if (draft && !list.includes(draft)) items.push(menuItem({ icon: 'save', t1: 'Simpan teks ini sebagai prompt cepat', t2: draft.slice(0, 60), chev: false, onclick: save }));
  return items.length ? h('div', { class: 'group' }, ...items) : null;
}
