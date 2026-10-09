// Layar sesi (terminal agen): composer, lampiran gambar, mode, attach ulang.
import * as M from '../../shared/models.js';
import { EventCursor } from '../../shared/events.js';
import { store } from '../conn.js';
import { app } from './state.js';
import { $, coarse, h, haptic, ic, isOldDaemon, menuItem, toast, ui } from './dom.js';
import { showGit } from './git.js';
import { pickModel } from './model-picker.js';
import { Renderer } from './renderer.js';
import { onProc, showRun } from './run.js';
import { sessionSub, showSessions } from './sessions.js';

// ---------- Layar: sesi (terminal) ----------
export const QUICK = [
  { icon: 'book', t1: 'Jelaskan repo ini', t2: 'struktur, cara menjalankan, bagian penting', text: 'Jelaskan struktur repo ini, cara menjalankannya, dan bagian terpentingnya. Singkat.' },
  { icon: 'diff', t1: 'Review perubahan', t2: 'cek git diff, cari bug, ringkas', text: 'Review perubahan yang belum di-commit (git diff): cari bug atau risiko, lalu ringkas.' },
  { icon: 'flask', t1: 'Jalankan & perbaiki test', t2: 'temukan perintah test, jalankan, perbaiki yang gagal', text: 'Temukan cara menjalankan test di repo ini, jalankan, lalu perbaiki yang gagal.' },
  { icon: 'bug', t1: 'Perbaiki error terakhir', t2: 'lanjutkan dari output sebelumnya', text: 'Perbaiki error terakhir yang muncul di sesi ini, lalu verifikasi.' },
  { icon: 'commit', t1: 'Commit perubahan', t2: 'tulis pesan commit yang jelas lalu commit', text: 'Lihat perubahan yang ada, tulis pesan commit yang jelas, lalu commit. Jangan push.' },
];
export const QUICK_SH = ['git status', 'git log --oneline -n 8', 'git diff --stat', 'ls'];

export function showSession(s) {
  app.current.session = s;
  app.current.cursor = new EventCursor();
  store.set('last', { mid: app.current.m.id, sid: s.id });
  const col = h('div', { class: 'col' });
  const term = h('div', { id: 'term' }, col);
  const working = h('div', { id: 'working', hidden: true }, h('span', { class: 'orb' }), h('span', { class: 'wl' }, 'bekerja'), h('span', { class: 't' }, '0s'));
  const toBottom = h('button', { id: 'tobottom', hidden: true, 'aria-label': 'Ke pesan terbaru' }, ic('arrowdown'));
  const dock = h('div', { id: 'dock' });
  const input = h('textarea', { id: 'input', rows: 1, placeholder: 'Minta sesuatu ke agen…', autocapitalize: 'sentences', enterkeyhint: coarse ? 'enter' : 'send', 'aria-label': 'Pesan' });
  const send = h('button', { id: 'send', class: 'idle', 'aria-label': 'Kirim' }, ic('send'));
  const modeBtn = h('button', { class: 'modebtn', 'aria-label': 'Ganti mode agen / shell' }, '❯');
  const modelChip = h('button', { class: 'chip model', 'aria-label': 'Ganti model' });
  const runChip = h('button', { class: 'chip', 'aria-label': 'Jalankan & preview' }, ic('play'), 'run');
  const gitChip = h('button', { class: 'chip', 'aria-label': 'Git' }, ic('branch'), 'git');
  const autoChip = h('button', { class: 'chip', 'aria-label': 'Auto-izin' });
  const planChip = h('button', { class: 'chip', 'aria-label': 'Mode rencana' }, ic('list'), 'rencana');
  const quickChip = h('button', { class: 'chip', 'aria-label': 'Aksi cepat' }, ic('spark'), 'aksi cepat');
  const attachBtn = h('button', { class: 'modebtn attach', 'aria-label': 'Lampirkan gambar' }, ic('image'));
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const thumbs = h('div', { id: 'thumbs', hidden: true });
  ui.set(s.title || s.repo.split('/')[1], { sub: sessionSub(s), back: () => (app.conn.call('detach').catch(() => {}), showSessions()), dot: 'on', actions: [{ icon: 'dots', label: 'Menu sesi', onclick: () => sessionMenu() }] });
  ui.view(
    h('div', { class: 'session' },
      h('div', { style: 'flex:1;min-height:0;position:relative;display:flex;flex-direction:column' }, term, working, toBottom),
      dock,
      h('div', { id: 'composer' }, h('div', { class: 'inner' }, h('div', { id: 'chips' }, modelChip, runChip, gitChip, autoChip, planChip, quickChip), thumbs, h('div', { id: 'inputRow' }, modeBtn, attachBtn, fileIn, input, send))),
    ),
  );

  const r = new Renderer(term, col, dock);
  app.current.renderer = r;
  app.current.procs = new Map();
  app.current.preview = null;

  // --- run & preview: badge jumlah proses berjalan ---
  app.current.syncRun = () => {
    const n = [...app.current.procs.values()].filter((p) => p.status === 'running').length;
    runChip.className = 'chip' + (app.current.preview ? ' on' : '');
    runChip.replaceChildren(ic(app.current.preview ? 'globe' : 'play'), app.current.preview ? 'preview' : 'run', n ? h('span', { class: 'badge' }, n) : '');
    app.current.runSheet?.();
  };
  runChip.onclick = () => showRun();

  // --- mode rencana: agen hanya membaca & menyusun rencana, lalu meminta persetujuan ---
  app.current.setPlan = (on) => {
    app.current.session.plan = on;
    planChip.className = 'chip' + (on ? ' on' : '');
    input.placeholder = on ? 'Rencanakan apa?' : shellMode ? 'Perintah shell di worktree…' : 'Minta sesuatu ke agen…';
  };
  planChip.onclick = async () => {
    haptic();
    try {
      app.current.setPlan((await app.conn.call('plan', { id: s.id, on: !app.current.session.plan })).plan);
      toast(app.current.session.plan ? 'Mode rencana: agen menyusun rencana dulu, tanpa mengubah file' : 'Mode rencana mati');
    } catch (e) {
      toast(isOldDaemon(e) ? 'Perbarui pocketcode di PC untuk mode rencana.' : e.message, true);
    }
  };

  // --- lampiran gambar (kamera, galeri, atau tempel dari clipboard) ---
  let images = [];
  const renderThumbs = () => {
    thumbs.hidden = !images.length;
    thumbs.replaceChildren(...images.map((im, i) => h('button', { class: 'thumb', 'aria-label': 'Hapus gambar', onclick: () => ((images = images.filter((_, j) => j !== i)), renderThumbs(), syncSend()) }, h('img', { src: `data:${im.mime};base64,${im.data}`, alt: '' }), ic('x'))));
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
  attachBtn.onclick = () => fileIn.click();
  fileIn.onchange = () => (addImages(fileIn.files), (fileIn.value = ''));
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) (e.preventDefault(), addImages(files));
  });
  r.onUnread = (n) => {
    toBottom.hidden = n === 0 && r.stick;
    toBottom.replaceChildren(ic('arrowdown'), n ? h('span', { class: 'n' }, n) : '');
  };
  toBottom.onclick = () => r.scroll(true);

  // --- model chip ---
  const setModelChip = () => {
    const p = M.parseModelId(app.current.session.model || '');
    modelChip.replaceChildren(ic('cpu'), h('span', { class: 'ml' }, p.base), p.effort ? h('span', { class: 'eff' }, M.EFFORT_LABEL[p.effort] || p.effort) : '');
  };
  setModelChip();
  modelChip.onclick = () => {
    if (app.current.running) return toast('Tunggu agen selesai (atau Stop) sebelum ganti model.', true);
    pickModel({
      title: 'Model sesi ini',
      current: app.current.session.model,
      onPick: async (id) => {
        let sum;
        try {
          sum = await app.conn.call('setSessionModel', { id: s.id, model: id });
        } catch (e) {
          throw isOldDaemon(e) ? new Error('Perbarui pocketcode di PC untuk ganti model di tengah sesi.') : e;
        }
        app.current.session.model = sum.model;
        setModelChip();
        ui.closeSheet();
        toast('Model: ' + M.modelLabel(id));
      },
    });
  };

  // --- git chip + badge jumlah perubahan ---
  gitChip.onclick = () => showGit();
  let gitT;
  app.current.refreshGit = () => {
    clearTimeout(gitT);
    gitT = setTimeout(async () => {
      try {
        const st = await app.conn.call('status', { id: s.id });
        const n = st.files.length;
        gitChip.replaceChildren(ic('branch'), 'git', n ? h('span', { class: 'badge' }, n) : '', !n && st.ahead ? h('span', { class: 'badge' }, '↑' + st.ahead) : '');
      } catch {}
    }, 700);
  };

  // --- auto-izin ---
  const setAuto = (on) => {
    app.current.session.auto = on;
    autoChip.replaceChildren(ic('bolt'), on ? 'auto-izin ON' : 'auto-izin');
    autoChip.className = 'chip' + (on ? ' danger' : '');
  };
  autoChip.onclick = async () => {
    const on = !app.current.session.auto;
    if (on && !confirm('Auto-izin: agen boleh menjalankan perintah shell apa pun tanpa bertanya (kecuali git push). Lanjut?')) return;
    setAuto((await app.conn.call('auto', { id: s.id, on })).auto);
    haptic();
  };
  setAuto(!!s.auto);

  // --- mode agen / shell ---
  let shellMode = false;
  const setMode = (sh) => {
    shellMode = sh;
    modeBtn.textContent = sh ? '$' : '❯';
    modeBtn.classList.toggle('shell', sh);
    input.classList.toggle('shell', sh);
    input.autocapitalize = sh ? 'off' : 'sentences';
    app.current.setPlan(!!app.current.session.plan);
  };
  modeBtn.onclick = () => (setMode(!shellMode), haptic(), input.focus());
  setMode(false);

  quickChip.onclick = () =>
    ui.sheet(
      ui.head('Aksi cepat', { sub: 'kirim langsung ke agen' }),
      h('div', { class: 'group' }, ...QUICK.map((qk) => menuItem({ icon: qk.icon, t1: qk.t1, t2: qk.t2, onclick: () => (ui.closeSheet(), quick(qk.text)) }))),
      h('div', { class: 'label' }, 'Shell'),
      h('div', { class: 'group' }, ...QUICK_SH.map((c) => menuItem({ icon: 'term', t1: '$ ' + c, chev: false, onclick: () => (ui.closeSheet(), quick('!' + c)) }))),
    );

  // --- status berjalan + indikator kerja ---
  const setRunning = (on) => {
    const was = app.current.running;
    app.current.running = on;
    send.replaceChildren(ic(on ? 'stop' : 'send'));
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
        working.querySelector('.t').textContent = sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
        working.querySelector('.wl').textContent = r.permQueue.length ? 'menunggu izinmu ↓' : r.activity || 'berpikir…';
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
    haptic(10);
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

export function sessionMenu() {
  const s = app.current.session;
  ui.sheet(
    ui.head(s.title || 'Sesi', { sub: s.repo }),
    h('div', { class: 'tags', style: 'margin:0 0 12px' }, h('span', { class: 'tag' }, ic('branch'), s.branch), h('span', { class: 'tag' }, 'base ' + s.base), h('span', { class: 'tag' }, ic('cpu'), M.modelLabel(s.model))),
    h('div', { class: 'group' },
      menuItem({ icon: 'branch', t1: 'Git', t2: 'status, diff, commit, push, PR', onclick: () => showGit() }),
      menuItem({ icon: 'play', t1: 'Run & Preview', t2: 'dev server, log, preview di HP', onclick: () => showRun() }),
      menuItem({ icon: 'cpu', t1: 'Ganti model / effort', t2: M.modelLabel(s.model), onclick: () => (ui.closeSheet(), $('.chip.model')?.click()) }),
      s.local ? null : menuItem({
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
      menuItem({
        icon: 'trash', t1: 'Hapus sesi', t2: 'worktree di PC ikut dihapus', danger: true, chev: false,
        onclick: async () => {
          if (!confirm('Hapus sesi ini beserta worktree-nya di PC? Perubahan yang belum di-push akan hilang.')) return;
          await app.conn.call('delete', { id: s.id }).catch((e) => toast(e.message, true));
          ui.closeSheet();
          showSessions();
        },
      }),
    ),
  );
}
