// Run & Preview: proses latar belakang, log, preview lewat tunnel, screenshot.
import { app } from './state.js';
import { busyButton, h, haptic, ic, isOldDaemon, toast, ui } from './dom.js';

// ---------- Run & Preview ----------
export function onProc(p) {
  const was = app.current.procs.get(p.name);
  app.current.procs.set(p.name, { ...was, ...p });
  if (was?.status === 'running' && p.status === 'exited' && !p.killed) toast(`${p.name} berhenti (exit ${p.code})`, p.code !== 0);
  if (!was?.port && p.port) toast(`${p.name} siap di port ${p.port}`);
  app.current.syncRun();
}

export function showRun() {
  const s = app.current.session;
  const body = h('div', {});
  const cmdIn = h('input', { class: 'field', placeholder: 'mis. npm run dev (kosongkan = otomatis)', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go' });
  let detected = null;
  const act = (b, fn) => async () => {
    const done = busyButton(b, 'Memproses…');
    try {
      await fn();
    } catch (e) {
      toast(isOldDaemon(e) ? 'Perbarui pocketcode di PC untuk fitur Run & Preview.' : e.message, true);
    }
    if (b.isConnected) done();
  };
  const startBtn = h('button', { class: 'btn primary' }, ic('play'), 'Jalankan');
  startBtn.onclick = act(startBtn, async () => {
    const r = await app.conn.call('runDev', { id: s.id, cmd: cmdIn.value.trim() || undefined });
    haptic(15);
    toast(r.setup ? `Memasang dependency (${r.setup}), lalu ${r.dev}` : `Menjalankan ${r.dev}`);
    cmdIn.value = '';
  });
  cmdIn.onkeydown = (e) => e.key === 'Enter' && startBtn.click();

  const procCard = (p) => {
    const run = p.status === 'running';
    const pv = app.current.preview?.name === p.name ? app.current.preview : null;
    const btns = h('div', { class: 'btnrow' });
    if (run && p.port) {
      // Tab baru dibuka dari ketukan langsung pada link: popup setelah await diblokir iOS.
      const prev = pv
        ? h('a', { class: 'btn primary', href: pv.link, target: '_blank', rel: 'noopener', onclick: () => haptic() }, ic('globe'), 'Buka preview')
        : h('button', { class: 'btn primary' }, ic('globe'), 'Preview di HP');
      if (!pv)
        prev.onclick = act(prev, async () => {
          toast('Membuka tunnel aman… (±10 detik)');
          app.current.preview = await app.conn.call('preview', { id: s.id, name: p.name });
          app.current.syncRun();
          haptic(20);
          toast('Preview siap — ketuk "Buka preview"');
        });
      const shot = h('button', { class: 'btn' }, ic('camera'), 'Screenshot');
      shot.onclick = act(shot, async () => showShot(await app.conn.call('screenshot', { id: s.id, name: p.name, width: Math.round(innerWidth), height: Math.round(innerHeight) })));
      btns.append(prev, shot);
    }
    const logBtn = h('button', { class: 'btn' }, ic('term'), 'Log');
    logBtn.onclick = () => showLogs(p.name);
    const stop = h('button', { class: 'btn ghost danger' }, run ? ic('stop') : ic('trash'), run ? 'Stop' : 'Hapus');
    stop.onclick = act(stop, async () => {
      await app.conn.call('procStop', { id: s.id, name: p.name });
      if (!run) app.current.procs.delete(p.name), app.current.syncRun();
    });
    btns.append(logBtn, stop);
    const closePv = pv && h('button', { class: 'linkbtn' }, 'tutup');
    if (closePv) closePv.onclick = act(closePv, () => app.conn.call('previewClose', { id: s.id }));
    return h('div', { class: 'proc' + (run ? ' on' : '') },
      h('div', { class: 'ph' }, h('span', { class: 'pdot' }), h('b', {}, p.name), h('span', { class: 'dim small grow' }, run ? (p.port ? `port ${p.port}` : 'menunggu port…') : `berhenti · exit ${p.code ?? '-'}`)),
      h('code', { class: 'pcmd' }, p.cmd),
      pv ? h('div', { class: 'purl' }, ic('lock'), h('span', {}, pv.url.replace(/^https:\/\//, '')), closePv) : null,
      btns,
    );
  };

  const render = () => {
    const ps = [...app.current.procs.values()].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt);
    body.replaceChildren(
      ps.length ? h('div', {}, ...ps.map(procCard)) : h('div', { class: 'empty', style: 'padding:18px 8px 6px' }, h('div', { class: 'emptyart' }, ic('play')), h('b', {}, 'Belum ada proses'), 'Dev server berjalan di PC, lalu bisa dibuka di HP lewat tunnel terenkripsi khusus untukmu.'),
      h('div', { class: 'label' }, 'Jalankan'),
      cmdIn,
      detected ? h('div', { class: 'dim small', style: 'margin:8px 2px 0' }, detected.dev ? `Otomatis: ${detected.setup ? detected.setup + ' → ' : ''}${detected.dev}` : 'Perintah dev tidak terdeteksi — isi manual.') : null,
      h('div', { style: 'margin-top:10px' }, startBtn),
      h('div', { class: 'fine', style: 'margin-top:14px' }, 'Preview memakai Cloudflare Tunnel dengan token rahasia yang hanya dikirim ke perangkatmu: tanpa token, link ditolak. Tunnel tertutup otomatis saat proses berhenti.'),
    );
  };
  app.current.runSheet = () => body.isConnected ? render() : (app.current.runSheet = null);
  ui.sheet(ui.head('Run & Preview', { sub: s.repo }), body);
  render();
  app.conn.call('project', { id: s.id }).then((r) => {
    detected = r;
    for (const p of r.procs) app.current.procs.set(p.name, p);
    app.current.preview = r.preview;
    app.current.syncRun();
  }, () => {});
}

export function showLogs(name) {
  const s = app.current.session;
  const pre = h('pre', { class: 'shout logview' }, 'memuat…');
  const stick = () => pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const append = (d) => {
    const end = stick();
    pre.textContent = (pre.textContent + d).slice(-200_000);
    if (end) pre.scrollTop = pre.scrollHeight;
  };
  app.current.procOut = (e) => (pre.isConnected ? e.name === name && append(e.d) : (app.current.procOut = null));
  ui.sheet(ui.head('Log ' + name, { back: showRun }), pre);
  app.conn.call('procLogs', { id: s.id, name }).then((t) => ((pre.textContent = t || '(belum ada output)'), (pre.scrollTop = pre.scrollHeight)), (e) => (pre.textContent = e.message));
}

export function showShot(r) {
  const errs = r.logs.filter((l) => /error|exception/.test(l.level));
  const s = app.current.session;
  ui.sheet(
    ui.head('Screenshot', { sub: r.title || '', back: showRun }),
    h('img', { class: 'shot', src: `data:${r.mime};base64,${r.data}`, alt: 'screenshot' }),
    r.logs.length ? h('div', {}, h('div', { class: 'label' }, 'Console', errs.length ? h('span', { class: 'tag warn' }, errs.length + ' error') : null), h('pre', { class: 'shout' }, r.logs.map((l) => `[${l.level}] ${l.text}`).join('\n'))) : h('div', { class: 'dim small' }, 'Console bersih.'),
    errs.length
      ? h('div', { class: 'sheetfoot' }, h('button', { class: 'btn primary', onclick: async () => {
          ui.closeSheet();
          await app.conn.call('send', { id: s.id, text: `Halaman preview menampilkan error berikut di console browser. Perbaiki, lalu verifikasi dengan preview_screenshot:\n\n${errs.map((l) => l.text).join('\n').slice(0, 6000)}` }).catch((e) => toast(e.message, true));
        } }, ic('bug'), 'Suruh agen perbaiki'))
      : null,
  );
}
