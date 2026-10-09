// Daftar sesi dan layar membuat sesi baru (repo, branch, model).
import * as M from '../../shared/models.js';
import { store } from '../conn.js';
import { app } from './state.js';
import { goMachines } from './auth.js';
import { ago, busyButton, h, haptic, ic, scrollCol, skeletons, ui } from './dom.js';
import { checkUpdateStatus, modelItem, renderGhBanner, renderUpdateBanner, showMachineMenu } from './machine.js';
import { pickModel } from './model-picker.js';
import { showSession } from './session.js';

// ---------- Layar: daftar sesi ----------
export function sessionSub(s) {
  return `${s.repo} · ${s.branch}`;
}

export async function showSessions() {
  app.current.session = null;
  app.current.onEvents = null;
  app.current.renderer = null;
  clearInterval(app.current.workTimer);
  ui.set(app.current.m.name, { back: goMachines, dot: 'on', actions: [{ icon: 'dots', label: 'Pengaturan PC', onclick: showMachineMenu }] });
  showSessionsMeta();
  setTimeout(renderUpdateBanner);
  setTimeout(renderGhBanner);
  checkUpdateStatus(false);
  const list = h('div', {}, skeletons(3));
  ui.view(
    h('div', { class: 'session' },
      scrollCol(h('div', { id: 'updateBanner' }), h('div', { id: 'ghBanner' }), list, h('div', { style: 'height:80px' })),
      h('button', { class: 'fab', onclick: () => (haptic(), showNewSession()) }, ic('plus'), 'Sesi baru'),
    ),
  );
  try {
    const sessions = await app.conn.call('sessions');
    const resume = app.current.resumeSid && sessions.find((x) => x.id === app.current.resumeSid);
    app.current.resumeSid = null;
    if (resume) return showSession(resume);
    store.set('last', { mid: app.current.m.id });
    if (!sessions.length)
      return list.replaceChildren(
        h('div', { class: 'empty' }, h('div', { class: 'big' }, '❯_'), h('b', {}, 'Belum ada sesi'), 'Ketuk ', h('span', { class: 'kbd' }, '+ Sesi baru'), ' untuk memilih repo GitHub dan mulai bekerja.'),
      );
    const running = sessions.filter((s) => s.status === 'running').length;
    list.replaceChildren(
      h('div', { class: 'label' }, 'Sesi', h('span', { class: 'count' }, sessions.length), running ? h('span', { class: 'tag run' }, running + ' berjalan') : null),
      ...sessions.map((s, i) => sessionCard(s, i)),
    );
  } catch (e) {
    list.replaceChildren(h('div', { class: 'err' }, e.message));
  }
}

export function sessionCard(s, i) {
  const name = s.repo.split('/')[1] || s.repo;
  return h('button', { class: 'card', style: `animation-delay:${Math.min(i, 8) * 35}ms;align-items:flex-start`, onclick: () => (haptic(), showSession(s)) },
    h('span', { class: 'avatar' + (i % 2 ? ' alt' : '') }, name[0].toUpperCase()),
    h('span', { class: 'grow' },
      h('div', { class: 'row', style: 'display:flex;gap:8px;align-items:baseline' }, h('div', { class: 'name', style: 'flex:1' }, s.title || '(belum ada prompt)'), h('span', { class: 'dim small', style: 'flex:none' }, ago(s.updatedAt))),
      h('div', { class: 'sub' }, s.repo),
      h('div', { class: 'tags' },
        s.status === 'running' ? h('span', { class: 'tag run' }, 'berjalan') : null,
        s.local ? h('span', { class: 'tag' }, ic('term'), 'terminal') : null,
        h('span', { class: 'tag' }, ic('branch'), s.branch),
        s.model ? h('span', { class: 'tag' }, ic('cpu'), M.modelLabel(s.model)) : null,
        s.auto ? h('span', { class: 'tag warn' }, ic('bolt'), 'auto') : null,
      ),
    ),
  );
}

export function showSessionsMeta() {
  const info = app.current?.info;
  if (!info || app.current.session) return;
  const up = app.current?.updateStatus?.updateAvailable ? ' · ⬆ update tersedia' : '';
  ui.sub(`◆ ${M.modelLabel(info.model)}${up}${info.github ? ' · @' + info.github : ' · GitHub belum login'}`);
}

// ---------- Layar: sesi baru ----------
export function showNewSession() {
  ui.set('Sesi baru', { sub: 'pilih repo GitHub', back: showSessions, dot: 'on' });
  const q = h('input', { class: 'field', type: 'search', placeholder: 'Cari repo atau ketik owner/nama', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const results = h('div', {}, skeletons(4));
  ui.view(scrollCol(h('div', { class: 'search' }, ic('search'), q), results));
  let timer;
  let seq = 0;
  const row = (r, i = 0) =>
    h('button', { class: 'card', style: `animation-delay:${Math.min(i, 8) * 30}ms`, onclick: () => (haptic(), pickBranch(r)) },
      h('span', { class: 'avatar' + (i % 2 ? ' alt' : '') }, (r.full.split('/')[1] || '?')[0].toUpperCase()),
      h('span', { class: 'grow' },
        h('div', { class: 'name' }, r.full.split('/')[1] || r.full),
        h('div', { class: 'sub' }, r.desc || r.full),
        h('div', { class: 'tags' }, h('span', { class: 'tag' }, r.full.split('/')[0]), r.private ? h('span', { class: 'tag' }, ic('lock'), 'private') : null, r.pushed ? h('span', { class: 'tag' }, 'push ' + ago(Date.parse(r.pushed)) + ' lalu') : null),
      ),
      ic('right', 'chev'),
    );
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
        ...(list.length ? list.map(row) : [h('div', { class: 'empty' }, 'Tidak ada repo.')]),
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
  const segNew = h('button', { onclick: () => setMode('new') }, 'Branch baru');
  const segOld = h('button', { onclick: () => setMode('existing') }, 'Lanjutkan branch');
  const branchLabel = h('div', { class: 'label', style: 'margin-top:16px' });
  const hint = h('div', { class: 'dim small', style: 'margin-top:8px' });
  const setMode = (v) => {
    mode.v = v;
    segNew.classList.toggle('on', v === 'new');
    segOld.classList.toggle('on', v === 'existing');
    newName.hidden = v !== 'new';
    branchLabel.textContent = v === 'new' ? 'Dibuat dari' : 'Branch yang dilanjutkan';
    hint.textContent = v === 'new' ? 'Kosongkan nama untuk branch otomatis pocket/<id>.' : 'Perubahan baru akan ditambahkan ke branch ini.';
  };
  setMode('new');
  let model = app.current.info.model;
  const modelSlot = h('div', { class: 'group' });
  const nodes = [];
  const reshow = () => ui.sheet(...nodes);
  const renderModel = () =>
    modelSlot.replaceChildren(
      modelItem('Model untuk sesi ini', model, () => pickModel({ title: 'Model sesi', current: model, onBack: reshow, onPick: (id) => ((model = id), renderModel(), reshow()) })),
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
    h('div', { class: 'seg' }, segNew, segOld),
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
