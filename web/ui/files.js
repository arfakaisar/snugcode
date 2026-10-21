// Lightweight file explorer: browse session folders, view files (numbered text, images), edit & save
// (refused if the agent changed the file since it was opened), new files, and "ask the agent" about a file.
import { app } from './state.js';
import { busyButton, copyText, h, haptic, ic, isOldDaemon, loading, toast, ui } from './dom.js';

const MAX_LINES = 4000; // lines drawn right away; the rest via a button
const join = (dir, name) => (dir ? dir + '/' + name : name);
const parentOf = (p) => p.split('/').slice(0, -1).join('/');
export const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB');

const oldDaemon = (e) => (isOldDaemon(e) ? new Error('Update snugcode on the PC to open files from your phone.') : e);

// Git status per path (changed files, folders with changes); empty if not a repo.
async function gitMarks(id) {
  const marks = new Map();
  try {
    const st = await app.conn.call('status', { id });
    for (const f of st.files || []) {
      const code = f.st.includes('?') || f.st.includes('A') ? 'A' : f.st.includes('D') ? 'D' : 'M';
      marks.set(f.path, code);
      for (let d = parentOf(f.path); d; d = parentOf(d)) if (!marks.has(d + '/')) marks.set(d + '/', 'M');
      if (!marks.has('/')) marks.set('/', 'M');
    }
  } catch {}
  return marks;
}

export async function showFiles(dir = app.current.filesDir || '') {
  const s = app.current.session;
  app.current.filesDir = dir;
  const body = h('div', {}, loading('Loading folder…'));
  const back = dir ? () => showFiles(parentOf(dir)) : undefined;
  ui.sheet(ui.head(dir ? dir.split('/').at(-1) : 'Files', { sub: '/' + dir, back }), body);
  let res, marks;
  try {
    [res, marks] = await Promise.all([app.conn.call('files', { id: s.id, path: dir }), gitMarks(s.id)]);
  } catch (e) {
    if (dir && !isOldDaemon(e)) return showFiles(parentOf(dir)); // folder was deleted: go up one level
    return body.replaceChildren(h('div', { class: 'err' }, oldDaemon(e).message));
  }
  if (app.current.session !== s) return;
  const newBtn = h('button', { class: 'chip', onclick: () => newFile(dir) }, ic('plus'), 'New file');
  const rows = res.entries.map((e, i) => {
    const p = join(res.path, e.name);
    const mark = e.dir ? marks.get(p + '/') : marks.get(p);
    return h('button', { class: 'frow', style: `--i:${Math.min(i, 14)}`, onclick: () => (haptic(5), e.dir ? showFiles(p) : showFile(p)) },
      h('span', { class: 'fi' + (e.dir ? ' dir' : '') }, ic(e.dir ? 'folder' : 'file')),
      h('span', { class: 'fn' }, e.name, e.link ? h('span', { class: 'dim' }, ' ↪') : null),
      mark ? h('span', { class: 'fm ' + mark }, e.dir ? '•' : mark) : null,
      e.dir ? ic('right', 'chev') : h('span', { class: 'fs' }, fmtSize(e.size)),
    );
  });
  body.replaceChildren(
    h('div', { class: 'fbar' }, h('span', { class: 'dim small grow' }, `${res.entries.length}${res.more ? '+' : ''} items`), newBtn),
    rows.length ? h('div', { class: 'flist' }, ...rows) : h('div', { class: 'empty' }, 'Empty folder.'),
    res.more ? h('div', { class: 'dim small' }, '… list truncated (too many files)') : null,
  );
}

function newFile(dir) {
  const name = h('input', { class: 'field mono', placeholder: 'file-name.js or folder/name.ts', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const go = () => {
    const n = name.value.trim().replace(/^\/+/, '');
    if (!n || /(^|\/)\.\.?(\/|$)/.test(n)) return toast('Invalid file name', true);
    editFile({ path: join(dir, n), text: '', create: true });
  };
  name.onkeydown = (e) => e.key === 'Enter' && go();
  ui.sheet(ui.head('New file', { sub: '/' + dir, back: () => showFiles(dir) }), name, h('div', { class: 'sheetfoot' }, h('button', { class: 'btn primary', onclick: go }, ic('plus'), 'Create')));
  setTimeout(() => name.focus(), 300);
}

// File text as numbered lines (textContent only: file content never becomes HTML).
function codeView(text) {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const box = h('div', { class: 'codeview' });
  const render = (n) => {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) frag.append(h('div', { class: 'cl' }, h('span', { class: 'ln' }, i + 1), h('span', { class: 'lt' }, lines[i] || ' ')));
    box.replaceChildren(frag);
  };
  render(Math.min(lines.length, MAX_LINES));
  if (lines.length <= MAX_LINES) return box;
  const more = h('button', { class: 'btn ghost' }, `Show all ${lines.length} lines`);
  more.onclick = () => (render(lines.length), more.remove());
  return h('div', {}, box, more);
}

export async function showFile(p) {
  const s = app.current.session;
  const body = h('div', {}, loading('Opening file…'));
  const name = p.split('/').at(-1);
  ui.sheet(ui.head(name, { sub: '/' + parentOf(p), back: () => showFiles(parentOf(p)) }), body);
  let f;
  try {
    f = await app.conn.call('fileRead', { id: s.id, path: p });
  } catch (e) {
    return body.replaceChildren(h('div', { class: 'err' }, oldDaemon(e).message));
  }
  const ask = () => {
    ui.closeSheet();
    app.current.compose?.(`About \`${p}\`: `);
  };
  const actions = h('div', { class: 'fbar' },
    h('span', { class: 'dim small grow' }, fmtSize(f.size), f.truncated ? ' · truncated' : ''),
    f.text != null && !f.truncated ? h('button', { class: 'chip', onclick: () => editFile({ path: p, text: f.text, hash: f.hash }) }, ic('compose'), 'Edit') : null,
    h('button', { class: 'chip', onclick: ask }, ic('spark'), 'Ask agent'),
    h('button', { class: 'chip', 'aria-label': 'Copy path', onclick: async () => toast((await copyText(p)) ? 'Path copied' : 'Couldn’t copy', false, 1500) }, ic('copy')),
  );
  let content;
  if (f.image) content = h('div', { class: 'fimg' }, h('img', { src: `data:${f.image.mime};base64,${f.image.data}`, alt: name }));
  else if (f.binary) content = h('div', { class: 'empty' }, h('b', {}, 'Binary file'), 'Can’t be shown as text.');
  else content = codeView(f.text);
  body.replaceChildren(actions, content, f.truncated ? h('div', { class: 'dim small' }, '… file is over 1 MB: only the beginning is shown, and it can’t be edited.') : null);
}

/** @param {{ path: string, text: string, draft?: string, hash?: string, create?: boolean }} f */
function editFile(f) {
  const s = app.current.session;
  const ta = h('textarea', { class: 'field mono editor', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', wrap: 'off' });
  ta.value = f.draft ?? f.text;
  const err = h('div', { class: 'err' });
  const save = h('button', { class: 'btn primary' }, ic('save'), f.create ? 'Create file' : 'Save');
  const leave = () => (f.create ? showFiles(parentOf(f.path)) : showFile(f.path));
  const cancel = async () => {
    if (ta.value !== f.text && !(await ui.confirm({ title: 'Discard changes?', text: 'Unsaved edits will be lost.', ok: 'Discard', danger: true, icon: 'trash' }))) return editFile({ ...f, draft: ta.value });
    leave();
  };
  save.onclick = async () => {
    const done = busyButton(save, 'Saving…');
    err.textContent = '';
    try {
      await app.conn.call('fileWrite', { id: s.id, path: f.path, text: ta.value, hash: f.hash, create: !!f.create });
      haptic(15);
      toast(f.create ? 'File created' : 'Saved', false, 1500);
      showFile(f.path);
    } catch (e) {
      done();
      err.textContent = oldDaemon(e).message;
      haptic(50);
    }
  };
  // Tab inserts indentation (physical keyboard) instead of moving focus.
  ta.onkeydown = (e) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
  };
  ui.sheet(
    ui.head(f.create ? 'New file' : 'Edit', { sub: f.path, back: cancel }),
    ta,
    err,
    h('div', { class: 'sheetfoot' }, h('div', { class: 'btnrow' }, h('button', { class: 'btn', onclick: cancel }, 'Cancel'), save)),
  );
}
