// Beranda PC (daftar sesi), drawer navigasi, dan layar membuat sesi baru (repo, branch, model).
import * as M from '../../shared/models.js';
import { store } from '../conn.js';
import { app } from './state.js';
import { goMachines } from './auth.js';
import { ago, busyButton, drawer, greeting, h, haptic, ic, onLongPress, pullToRefresh, renderIf, scrollCol, skeletons, mascot, toast, ui } from './dom.js';
import { checkUpdateStatus, ghBad, modelItem, renderGhBanner, renderUpdateBanner, showMachineMenu } from './machine.js';
import { pickModel } from './model-picker.js';
import { accountMenu } from './push.js';
import { showSession } from './session.js';

export const tildify = (p) => {
  if (!p) return '~';
  return p.replace(/^[A-Za-z]:[\\/][Uu]sers[\\/][^\\/]+/i, '~').replace(/^\/home\/[^\\/]+/i, '~').replace(/\\/g, '/');
};

export function sessionSub(s) {
  if (s.computer) return `Komputer · ${tildify(s.cwd)}`;
  return `${s.repo} · ${s.branch}`;
}
export const repoName = (s) => (s.computer ? 'Komputer' : s.repo.split('/')[1] || s.repo);
// Warna avatar tetap per repo (bukan per posisi), jadi repo yang sama selalu berwarna sama.
const tint = (name) => [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 5;

// ---------- Layar: beranda PC ----------
export async function showSessions() {
  if (app.current.session) app.conn?.call('detach').catch(() => {});
  app.current.session = null;
  app.current.onEvents = null;
  app.current.renderer = null;
  clearInterval(app.current.workTimer);
  drawer.build = buildDrawer;
  ui.set(app.current.m.name, { menu: true, dot: 'on', onTitle: showMachineMenu, titleLabel: 'Pengaturan PC', actions: [{ icon: 'compose', label: 'Sesi baru', onclick: () => (haptic(), showNewSession()) }] });
  const list = h('div', {}, skeletons(3));
  const sc = scrollCol(
    h('div', { id: 'updateBanner' }),
    h('div', { id: 'ghBanner' }),
    h('div', { class: 'greet' }, mascot('draw tap'), h('h1', { class: 'serif' }, greeting() + (app.me?.login ? ', ' + app.me.login : ''))),
    h('div', { id: 'homeMeta', class: 'homemeta' }),
    list,
  );
  ui.view(
    h('div', { class: 'session home' },
      sc,
      h('div', { class: 'starter' },
        h('button', { class: 'starterbtn', onclick: () => (haptic(), showNewSession()) },
          h('span', { class: 'si' }, ic('plus')),
          h('span', { class: 'grow' }, 'Mulai sesi baru…'),
          h('span', { class: 'sk' }, ic('monitor'), 'repo / PC'),
        ),
      ),
    ),
  );
  pullToRefresh(sc, () => showSessions());
  showSessionsMeta();
  renderUpdateBanner();
  renderGhBanner();
  checkUpdateStatus(false);
  try {
    const sessions = await app.conn.call('sessions');
    if (!list.isConnected) return;
    app.current.sessions = sessions;
    const resume = app.current.resumeSid && sessions.find((x) => x.id === app.current.resumeSid);
    app.current.resumeSid = null;
    if (resume) return showSession(resume);
    store.set('last', { mid: app.current.m.id });
    if (!sessions.length)
      return list.replaceChildren(
        h('div', { class: 'empty' },
          h('div', { class: 'emptyart' }, ic('term')),
          h('b', {}, 'Belum ada sesi'),
          'Pilih repo GitHub untuk coding terisolasi, atau jalankan mode Komputer untuk mengontrol seluruh PC seperti Claude Code.',
          h('button', { class: 'btn primary', style: 'margin-top:16px', onclick: () => showNewSession() }, ic('plus'), 'Mulai sesi pertama'),
        ),
      );
    const running = sessions.filter((s) => s.status === 'running').length;
    list.replaceChildren(
      h('div', { class: 'label' }, 'Sesi', h('span', { class: 'count' }, sessions.length), running ? h('span', { class: 'tag run' }, running + ' berjalan') : null),
      h('div', { class: 'list' }, ...sessions.map((s, i) => sessionCard(s, i))),
      h('div', { class: 'fine' }, 'Tekan lama sebuah sesi untuk opsi lainnya.'),
    );
  } catch (e) {
    list.replaceChildren(h('div', { class: 'err' }, e.message));
  }
}

export function sessionCard(s, i) {
  const name = repoName(s);
  const run = s.status === 'running';
  const isComp = !!s.computer;
  const el = h('button', { class: 'card sess' + (run ? ' running' : ''), style: `--i:${Math.min(i, 10)}`, onclick: () => (haptic(), showSession(s)) },
    h('span', { class: 'avatar t' + (isComp ? '1' : tint(name)) }, isComp ? ic('monitor') : name[0].toUpperCase(), run ? h('i', { class: 'live' }) : null),
    h('span', { class: 'grow' },
      h('div', { class: 'row' }, h('div', { class: 'name' }, s.title || (isComp ? 'Sesi Komputer' : '(belum ada prompt)')), h('span', { class: 'when' }, ago(s.updatedAt))),
      h('div', { class: 'sub' }, isComp ? `Komputer · ${s.cwd ? tildify(s.cwd) : 'seluruh PC'}` : s.repo),
      h('div', { class: 'tags' },
        run ? h('span', { class: 'tag run' }, 'berjalan') : null,
        isComp ? h('span', { class: 'tag' }, ic('monitor'), 'komputer') : null,
        s.local ? h('span', { class: 'tag' }, ic('term'), 'terminal') : null,
        !isComp ? h('span', { class: 'tag' }, ic('branch'), s.branch) : null,
        s.model ? h('span', { class: 'tag' }, ic('cpu'), M.modelLabel(s.model)) : null,
        s.auto ? h('span', { class: 'tag warn' }, ic('bolt'), 'auto') : null,
      ),
    ),
  );
  onLongPress(el, () => sessionActions(s));
  return el;
}

// Opsi cepat sebuah sesi (tekan lama di beranda).
export function sessionActions(s) {
  const isComp = !!s.computer;
  ui.sheet(
    ui.head(s.title || (isComp ? 'Sesi Komputer' : repoName(s)), { sub: sessionSub(s) }),
    h('div', { class: 'group' },
      h('button', { class: 'menuitem', onclick: () => (ui.closeSheet(), showSession(s)) }, h('span', { class: 'mi' }, ic('term')), h('span', { class: 'grow' }, h('div', { class: 't1' }, 'Buka sesi'))),
      h('button', { class: 'menuitem danger', onclick: () => deleteSession(s) }, h('span', { class: 'mi' }, ic('trash')), h('span', { class: 'grow' }, h('div', { class: 't1' }, 'Hapus sesi'), h('div', { class: 't2' }, isComp ? 'riwayat sesi di PC dihapus' : 'worktree di PC ikut dihapus'))),
    ),
  );
}

export async function deleteSession(s) {
  const isComp = !!s.computer;
  const text = isComp
    ? 'Riwayat sesi komputer ini akan dihapus. File & sistem di PC tetap aman dan tidak disentuh.'
    : 'Worktree-nya di PC ikut dihapus. Perubahan yang belum di-push akan hilang.';
  if (!(await ui.confirm({ title: 'Hapus sesi ini?', text, ok: 'Hapus', danger: true, icon: 'trash' }))) return;
  try {
    await app.conn.call('delete', { id: s.id });
    toast('Sesi dihapus');
    ui.dir = -1;
    showSessions();
  } catch (e) {
    toast(e.message, true);
  }
}

export function showSessionsMeta() {
  const info = app.current?.info;
  const el = document.getElementById('homeMeta');
  if (!info || app.current.session || !el) return;
  ui.sub('');
  const model = M.modelLabel(info.model) || 'pilih model';
  const gh = info.github && !ghBad() ? '@' + info.github : '';
  const up = !!app.current.updateStatus?.updateAvailable;
  renderIf(el, [model, gh, up].join('|'), () => [
    h('button', { class: 'metachip', style: '--i:0', onclick: showMachineMenu }, ic('cpu'), model),
    h('button', { class: 'metachip' + (gh ? '' : ' warn'), style: '--i:1', onclick: showMachineMenu }, ic('github'), gh || 'GitHub belum login'),
    up ? h('span', { class: 'metachip on', style: '--i:2' }, ic('spark'), 'update tersedia') : null,
  ]);
}

// ---------- Drawer: navigasi + sesi terbaru ----------
function buildDrawer() {
  const cur = app.current;
  const list = h('div', { class: 'dlist' });
  const go = (fn) => () => (drawer.close(), fn());
  const item = (s, i) => {
    const on = cur.session?.id === s.id;
    const isComp = !!s.computer;
    return h('button', { class: 'dsess' + (on ? ' on' : '') + (s.status === 'running' ? ' running' : ''), style: `--i:${Math.min(i, 12)}`, onclick: on ? () => drawer.close() : go(() => showSession(s)) },
      h('span', { class: 'sdot' }),
      h('span', { class: 'grow' },
        h('span', { class: 'st' }, s.title || (isComp ? 'Sesi Komputer' : '(belum ada prompt)')),
        h('span', { class: 'ss' }, (isComp ? 'Komputer' : repoName(s)) + ' · ' + (ago(s.updatedAt) || '-'))
      ),
    );
  };
  const render = (ss) => list.replaceChildren(...(ss?.length ? ss.map(item) : [h('div', { class: 'dempty' }, ss ? 'Belum ada sesi.' : 'Memuat…')]));
  const sig = (ss) => (ss || []).map((s) => s.id + s.status + s.title + s.updatedAt).join();
  render(cur.sessions);
  app.conn?.call('sessions').then((ss) => {
    const changed = !cur.sessions || sig(ss) !== sig(cur.sessions);
    cur.sessions = ss;
    if (changed && list.isConnected) render(ss);
  }, () => {});
  const login = app.me?.login;
  return [
    h('div', { class: 'dhead' }, mascot('draw tap'), h('span', { class: 'wordmark' }, 'snugcode')),
    h('button', { class: 'dnew', onclick: go(showNewSession) }, h('span', { class: 'si' }, ic('plus')), 'Sesi baru'),
    h('div', { class: 'dnav' },
      h('button', { class: 'ditem' + (cur.session ? '' : ' on'), onclick: go(() => ((ui.dir = -1), showSessions())) }, ic('home'), 'Beranda'),
      h('button', { class: 'ditem', onclick: go(goMachines) }, ic('monitor'), 'Ganti PC'),
    ),
    h('div', { class: 'dlabel' }, 'Sesi terbaru'),
    list,
    h('div', { class: 'dfoot' },
      h('button', { class: 'dme', onclick: accountMenu },
        h('span', { class: 'meav' }, login ? login[0].toUpperCase() : '?'),
        h('span', { class: 'grow' }, h('b', {}, login ? '@' + login : 'Akun'), h('span', {}, h('i', { class: 'odot' }), cur.m.name)),
      ),
      h('button', { class: 'iconbtn', 'aria-label': 'Pengaturan PC', onclick: showMachineMenu }, ic('gear')),
    ),
  ];
}

// ---------- Layar: sesi baru ----------
export function showNewSession(initialTab = 'repo') {
  ui.set('Sesi baru', { sub: initialTab === 'repo' ? 'pilih repo GitHub' : 'kontrol seluruh PC', back: showSessions, dot: 'on' });
  let tab = initialTab;

  const segRepo = h('button', { class: tab === 'repo' ? 'on' : '', onclick: () => (haptic(6), switchTab('repo')) }, ic('branch'), 'Repository');
  const segPc = h('button', { class: tab === 'computer' ? 'on' : '', onclick: () => (haptic(6), switchTab('computer')) }, ic('monitor'), 'Komputer');
  const seg = h('div', { class: 'seg slide', style: `--n:2;--at:${tab === 'repo' ? '0' : '1'};margin-bottom:14px` }, h('i', { class: 'knob' }), segRepo, segPc);

  // Tab 1: Repo
  const q = h('input', { class: 'field', type: 'search', placeholder: 'Cari repo atau ketik owner/nama', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const results = h('div', {}, skeletons(4));
  const repoView = h('div', { hidden: tab !== 'repo' }, h('div', { class: 'search' }, ic('search'), q), results);

  // Tab 2: Komputer
  let compModel = app.current.info?.model;
  const compModelSlot = h('div', { class: 'group' });
  const renderCompModel = () =>
    compModelSlot.replaceChildren(
      modelItem('Model sesi komputer', compModel, () => pickModel({ title: 'Model sesi komputer', current: compModel, onBack: () => showNewSession('computer'), onPick: (id) => ((compModel = id), renderCompModel(), (ui.sdir = -1), showNewSession('computer')) })),
    );
  renderCompModel();
  const cwdIn = h('input', { class: 'field', placeholder: 'Folder awal, mis. ~ atau biarkan kosong', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const compErr = h('div', { class: 'err' });
  const compBtn = h('button', { class: 'btn primary', style: 'margin-top:16px;width:100%' }, ic('monitor'), 'Mulai sesi komputer');
  compBtn.onclick = async () => {
    const done = busyButton(compBtn, 'Menyiapkan sesi komputer…');
    compErr.textContent = '';
    try {
      const s = await app.conn.call('create', { computer: true, model: compModel, cwd: cwdIn.value.trim() || undefined });
      haptic(20);
      showSession(s);
    } catch (e) {
      compErr.textContent = e.message;
      done();
    }
  };
  const compView = h('div', { hidden: tab !== 'computer' },
    h('div', { class: 'card', style: 'cursor:default;margin-bottom:14px;padding:14px 16px' },
      h('span', { class: 'avatar t1' }, ic('monitor')),
      h('span', { class: 'grow' },
        h('div', { class: 'name', style: 'font-size:15px;font-weight:600' }, 'Kontrol Seluruh PC'),
        h('div', { class: 'sub', style: 'margin-top:4px;line-height:1.4' }, 'Jalankan Claude Code dengan akses penuh ke komputermu. Agen dapat membuka & mengedit file di seluruh komputer, menjalankan perintah di terminal, dan mengelola sistem.'),
      ),
    ),
    h('div', { class: 'label' }, 'Folder Kerja Awal (CWD)'),
    cwdIn,
    h('div', { class: 'dim small', style: 'margin-top:6px;margin-bottom:14px' }, 'Default: folder home pengguna (~). Agen tetap bisa mengakses direktori lain di PC.'),
    h('div', { class: 'label' }, 'Model'),
    compModelSlot,
    compErr,
    h('div', { style: 'margin-top:16px' }, compBtn),
  );

  const switchTab = (t) => {
    tab = t;
    seg.style.setProperty('--at', t === 'repo' ? '0' : '1');
    segRepo.classList.toggle('on', t === 'repo');
    segPc.classList.toggle('on', t === 'computer');
    repoView.hidden = t !== 'repo';
    compView.hidden = t !== 'computer';
    ui.sub(t === 'repo' ? 'pilih repo GitHub' : 'kontrol seluruh PC');
  };

  ui.view(scrollCol(seg, repoView, compView));
  let timer;
  let seq = 0;
  const row = (r, i = 0) => {
    const name = r.full.split('/')[1] || r.full;
    return h('button', { class: 'card', style: `--i:${Math.min(i, 10)}`, onclick: () => (haptic(), pickBranch(r)) },
      h('span', { class: 'avatar t' + tint(name) }, (name || '?')[0].toUpperCase()),
      h('span', { class: 'grow' },
        h('div', { class: 'name' }, name),
        h('div', { class: 'sub' }, r.desc || r.full),
        h('div', { class: 'tags' }, h('span', { class: 'tag' }, r.full.split('/')[0]), r.private ? h('span', { class: 'tag' }, ic('lock'), 'private') : null, r.pushed ? h('span', { class: 'tag' }, 'push ' + ago(Date.parse(r.pushed)) + ' lalu') : null),
      ),
      ic('right', 'chev'),
    );
  };
  const load = async () => {
    const my = ++seq;
    const term = q.value.trim();
    const typed = /^[\w.-]+\/[\w.-]+$/.test(term) ? { full: term, desc: 'pakai nama ini' } : null;
    try {
      const repos = await app.conn.call('repos', { q: term || undefined });
      if (my !== seq) return;
      const list = [...(typed && !repos.some((r) => r.full === term) ? [typed] : []), ...repos];
      results.replaceChildren(
        h('div', { class: 'label' }, term ? 'Hasil' : 'Terakhir di-push', h('span', { class: 'count' }, list.length)),
        ...(list.length ? [h('div', { class: 'list' }, ...list.map(row))] : [h('div', { class: 'empty' }, 'Tidak ada repo.')]),
      );
    } catch (e) {
      if (my !== seq) return;
      // Tanpa login GitHub tetap bisa membuka repo publik dengan mengetik owner/nama.
      results.replaceChildren(...(typed ? [row(typed)] : []), h('div', { class: 'err' }, e.message), h('div', { class: 'dim small' }, 'Kamu tetap bisa mengetik owner/nama untuk repo publik.'));
    }
  };
  q.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 300);
  };
  load();
}

export async function pickBranch(repo) {
  const branches = h('select', { class: 'field', 'aria-label': 'Branch' }, h('option', { value: '' }, '(branch default)'));
  const mode = { v: 'new' };
  const newName = h('input', { class: 'field', placeholder: 'nama branch baru (opsional)', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const err = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn primary' }, ic('term'), 'Mulai sesi');
  const segNew = h('button', { onclick: () => (haptic(6), setMode('new')) }, 'Branch baru');
  const segOld = h('button', { onclick: () => (haptic(6), setMode('existing')) }, 'Lanjutkan branch');
  const seg = h('div', { class: 'seg slide', style: '--n:2' }, h('i', { class: 'knob' }), segNew, segOld);
  const branchLabel = h('div', { class: 'label', style: 'margin-top:16px' });
  const hint = h('div', { class: 'dim small', style: 'margin-top:8px' });
  const setMode = (v) => {
    mode.v = v;
    seg.style.setProperty('--at', v === 'new' ? '0' : '1');
    segNew.classList.toggle('on', v === 'new');
    segOld.classList.toggle('on', v === 'existing');
    newName.hidden = v !== 'new';
    branchLabel.textContent = v === 'new' ? 'Dibuat dari' : 'Branch yang dilanjutkan';
    hint.textContent = v === 'new' ? 'Kosongkan nama untuk branch otomatis snug/<id>.' : 'Perubahan baru akan ditambahkan ke branch ini.';
  };
  setMode('new');
  let model = app.current.info.model;
  const modelSlot = h('div', { class: 'group' });
  const nodes = [];
  const reshow = () => ui.sheet(...nodes);
  const renderModel = () =>
    modelSlot.replaceChildren(
      modelItem('Model untuk sesi ini', model, () => pickModel({ title: 'Model sesi', current: model, onBack: reshow, onPick: (id) => ((model = id), renderModel(), (ui.sdir = -1), reshow()) })),
    );
  renderModel();
  btn.onclick = async () => {
    const done = busyButton(btn, 'Menyiapkan repo…');
    err.textContent = '';
    try {
      const params = mode.v === 'new' ? { repo: repo.full, base: branches.value || undefined, branch: newName.value.trim() || undefined } : { repo: repo.full, branch: branches.value || repo.branch };
      params.model = model;
      const s = await app.conn.call('create', params);
      haptic(20);
      ui.closeSheet();
      showSession(s);
    } catch (e) {
      err.textContent = e.message;
      done();
    }
  };
  nodes.push(
    ui.head(repo.full.split('/')[1] || repo.full, { sub: repo.full }),
    seg,
    branchLabel, branches, newName, hint,
    h('div', { class: 'label' }, 'Model'), modelSlot,
    err,
    h('div', { class: 'sheetfoot' }, btn),
  );
  reshow();
  try {
    const list = await app.conn.call('branches', { repo: repo.full });
    branches.replaceChildren(...list.map((b) => h('option', { value: b, selected: b === repo.branch }, b)));
  } catch {}
}
