// Git screen: status, diff, commit, push, Pull Request.
import { app } from './state.js';
import { busyButton, h, haptic, ic, loading, toast, ui } from './dom.js';
import { progress } from './progress.js';
import { showFile } from './files.js';

// ---------- Git ----------
export async function showGit() {
  const s = app.current.session;
  const body = h('div', {}, loading('Loading git status…'));
  ui.sheet(ui.head('Git', { sub: s.computer ? 'Computer' : s.repo }), body);
  let st;
  try {
    st = await app.conn.call('status', { id: s.id });
  } catch (e) {
    return body.replaceChildren(h('div', { class: 'err' }, e.message));
  }
  if (st.notRepo) {
    return body.replaceChildren(
      h('div', { class: 'empty' },
        h('div', { class: 'emptyart' }, ic('branch')),
        h('b', {}, 'Not a git repository'),
        'This session’s working folder isn’t a git repository. Commit, push, and PRs need a git repo.',
      ),
    );
  }
  app.current.refreshGit?.();
  const msg = h('input', { class: 'field', placeholder: 'Commit message…', autocapitalize: 'sentences', enterkeyhint: 'done' });
  const err = h('div', { class: 'err' });
  const act = (content, fn, cls = 'btn') => {
    const b = h('button', { class: cls }, ...content);
    b.onclick = async () => {
      const done = busyButton(b, 'Working…');
      err.textContent = '';
      try {
        await fn();
      } catch (x) {
        err.textContent = x.message;
        haptic(50);
      }
      if (b.isConnected) done();
    };
    return b;
  };
  const stCls = (code) => (code.includes('?') || code.includes('A') ? 'A' : code.includes('D') ? 'D' : code.includes('R') ? 'R' : 'M');
  const stTxt = (code) => (code.includes('?') ? 'A' : code.trim()[0] || 'M');
  const sync = st.hasUpstream ? (st.ahead || st.behind ? `↑${st.ahead} · ↓${st.behind}` : 'in sync with GitHub') : st.ahead ? `${st.ahead} commit${st.ahead === 1 ? '' : 's'} not on GitHub yet` : 'not on GitHub yet';
  body.replaceChildren(
    h('div', { class: 'gitsum' },
      h('span', { class: 'gi' }, ic('branch')),
      h('span', { class: 'grow' }, h('b', {}, st.branch), h('span', { class: 'dim small' }, sync)),
      h('span', { class: 'dstat big' }, st.files.length ? `${st.files.length} file${st.files.length === 1 ? '' : 's'}` : '✓ clean'),
    ),
    h('div', { class: 'label' }, 'Changes', h('span', { class: 'count' }, st.files.length)),
    st.files.length
      ? h('div', { class: 'files' }, ...st.files.map((f, i) => h('div', { class: 'f', style: `--i:${Math.min(i, 12)}` }, h('span', { class: 'st ' + stCls(f.st) }, stTxt(f.st)), h('span', { class: 'p' }, '‎' + f.path))))
      : h('div', { class: 'dim small' }, 'No uncommitted changes.'),
    st.files.length ? h('div', { style: 'margin-top:10px' }, act([ic('diff'), 'View diff'], showDiff)) : null,
    st.files.length
      ? h('div', {}, h('div', { class: 'label' }, 'Commit'), h('div', { class: 'inline' }, msg, act([ic('commit'), 'Commit'], async () => {
          if (!msg.value.trim()) throw new Error('Enter a commit message.');
          const c = await app.conn.call('commit', { id: s.id, message: msg.value });
          toast('Commit ' + c);
          haptic(15);
          showGit();
        }, 'btn primary')))
      : null,
    h('div', { class: 'label' }, 'Send to GitHub'),
    h('div', { class: 'btnrow' },
      act([ic('push'), 'Push'], async () => {
        if (!(await ui.confirm({ title: 'Push to GitHub?', text: `Branch ${st.branch} will be pushed to origin.`, ok: 'Push', icon: 'push', stay: true }))) return;
        const p = progress('git-push', [{ id: 'push', label: `Pushing ${st.branch} to GitHub`, est: 6 }]);
        ui.sheet(ui.head('Git', { sub: s.repo }), p.el);
        try {
          await app.conn.call('push', { id: s.id });
          p.done();
          toast('Pushed');
          haptic(20);
        } catch (x) {
          p.fail(x.message);
          toast(x.message, true);
        }
        showGit();
      }, 'btn primary'),
      act([ic('pr'), 'Pull Request'], () => showPR(st)),
    ),
    err,
    st.log.length ? h('div', {}, h('div', { class: 'label' }, 'Recent commits'), h('div', { class: 'log' }, ...st.log.map((l) => h('div', {}, h('span', { class: 'h' }, l.slice(0, 7)), l.slice(8))))) : null,
  );
}

export function showPR(st) {
  const s = app.current.session;
  const title = h('input', { class: 'field', value: s.title || '', placeholder: 'PR title', autocapitalize: 'sentences' });
  const desc = h('textarea', { class: 'field', rows: 5, placeholder: 'Description (optional)', autocapitalize: 'sentences' });
  const err = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn primary' }, ic('pr'), 'Create PR');
  btn.onclick = async () => {
    const done = busyButton(btn, 'Creating PR…');
    try {
      const pr = await app.conn.call('pr', { id: s.id, title: title.value || st.branch, body: desc.value });
      haptic(20);
      ui.sheet(ui.head('PR created', { sub: `#${pr.number}` }), h('div', { class: 'empty' }, h('div', { class: 'emptyart ok' }, ic('pr')), h('b', {}, `Pull Request #${pr.number}`), 'Ready for review on GitHub.'), h('a', { class: 'btn primary', href: pr.url, target: '_blank', rel: 'noopener' }, ic('github'), 'Open on GitHub'));
    } catch (e) {
      done();
      err.textContent = e.message + (/No commits|not all refs/.test(e.message) ? ' — push first.' : '');
    }
  };
  ui.sheet(ui.head('Pull Request', { sub: `${st.branch} → ${s.base}`, back: showGit }), title, h('div', { style: 'height:10px' }), desc, err, h('div', { class: 'sheetfoot' }, btn));
}

// `git diff HEAD` per file → hunks. Paths come from the +++/--- lines (safe for names with spaces).
export function parseDiff(diff) {
  const files = [];
  let cur = null;
  let hunk = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) {
      cur = { path: l.replace(/^diff --git a\/(.+?) b\/.*$/, '$1'), hunks: [], add: 0, del: 0, isNew: false, binary: false };
      files.push(cur);
      hunk = null;
    } else if (!cur) continue;
    else if (!hunk) {
      if (l.startsWith('+++ b/')) cur.path = l.slice(6);
      else if (l.startsWith('--- a/') && !cur.hunks.length) cur.path = l.slice(6);
      else if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('Binary files')) cur.binary = true;
      if (l.startsWith('@@')) cur.hunks.push((hunk = hunkOf(l)));
    } else if (l.startsWith('@@')) cur.hunks.push((hunk = hunkOf(l)));
    else {
      hunk.lines.push(l);
      if (l.startsWith('+')) cur.add++;
      else if (l.startsWith('-')) cur.del++;
    }
  }
  // The trailing empty line from split isn't part of a hunk.
  for (const f of files) for (const x of f.hunks) while (x.lines.length && x.lines.at(-1) === '') x.lines.pop();
  return files;
}
function hunkOf(head) {
  const m = head.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/) || [];
  return { head, lines: [], old: +m[1] || 0, new: +m[2] || 0 };
}
const hunkText = (x) => [x.head, ...x.lines].join('\n');

// Review comments waiting to be sent to the agent (per session, kept when the diff reloads).
function review() {
  const sid = app.current.session.id;
  if (app.current.review?.sid !== sid) app.current.review = { sid, items: [] };
  return app.current.review;
}

export function reviewMessage(items) {
  const parts = items.map((c, i) => {
    const where = c.line ? `\`${c.path}\` line ${c.line}` : `\`${c.path}\``;
    const code = c.code.split('\n').slice(0, 40).join('\n');
    return `${i + 1}. ${where}:\n\`\`\`diff\n${code}\n\`\`\`\n${c.text}`;
  });
  return `I reviewed the uncommitted changes (git diff). Address each comment below, then summarize what you changed:\n\n${parts.join('\n\n')}`;
}

export async function showDiff() {
  const s = app.current.session;
  const box = h('div', {}, loading('Loading diff…'));
  const foot = h('div', { class: 'sheetfoot', hidden: true });
  ui.sheet(ui.head('Diff', { sub: s.computer ? 'Computer' : s.repo, back: showGit }), box, foot);
  let res;
  try {
    res = await app.conn.call('diff', { id: s.id });
  } catch (e) {
    return box.replaceChildren(h('div', { class: 'err' }, e.message));
  }
  if (res.notRepo) return box.replaceChildren(h('div', { class: 'empty' }, 'Not a git repository.'));
  const files = parseDiff(res.diff);
  const rv = review();
  const canEdit = !!app.current.info?.caps?.includes('revert');

  const syncFoot = () => {
    foot.hidden = !rv.items.length;
    if (!rv.items.length) return;
    const sendBtn = h('button', { class: 'btn primary' }, ic('send'), 'Send to agent');
    sendBtn.onclick = async () => {
      if (app.current.running) return toast('Wait for the agent to finish (or Stop) first.', true);
      const done = busyButton(sendBtn, 'Sending…');
      try {
        await app.conn.call('send', { id: s.id, text: reviewMessage(rv.items) });
        rv.items = [];
        haptic(15);
        ui.closeSheet();
      } catch (e) {
        done();
        toast(e.message, true);
      }
    };
    foot.replaceChildren(h('div', { class: 'inline' }, h('button', { class: 'btn ghost', style: 'width:auto', onclick: () => ((rv.items = []), showDiff()) }, 'Clear'), h('span', { class: 'grow dim small revcount' }, `${rv.items.length} comment${rv.items.length === 1 ? '' : 's'}`), sendBtn));
  };

  const revert = async (f, hk) => {
    const what = hk ? 'this hunk' : f.isNew ? 'this new file (the file is deleted)' : 'all changes to this file';
    if (!(await ui.confirm({ title: 'Revert changes?', text: `${what[0].toUpperCase() + what.slice(1)} in ${f.path} will be reverted to the last commit.`, ok: 'Revert changes', danger: true, icon: 'undo' }))) return showDiff();
    try {
      await app.conn.call('revert', { id: s.id, path: f.path, ...(hk ? { hunk: hunkText(hk) } : {}) });
      haptic(15);
      toast('Changes reverted', false, 1500);
    } catch (e) {
      toast(e.message, true);
    }
    app.current.refreshGit?.();
    showDiff();
  };

  // Tap a line → comment box below it. Comments keep a snippet of the line (or the whole hunk).
  const commentBox = (after, f, hk, line, code) => {
    after.nextElementSibling?.classList.contains('cbox2') && after.nextElementSibling.remove();
    const ta = h('textarea', { class: 'field', rows: 2, placeholder: line ? `Comment on line ${line}…` : 'Comment on this hunk…', autocapitalize: 'sentences' });
    const ok = h('button', { class: 'chip on' }, 'Add');
    const boxEl = h('div', { class: 'cbox2' }, ta, h('div', { class: 'btnrow' }, h('button', { class: 'chip', onclick: () => boxEl.remove() }, 'Cancel'), ok));
    ok.onclick = () => {
      const text = ta.value.trim();
      if (!text) return ta.focus();
      rv.items.push({ path: f.path, line, code, text });
      boxEl.replaceWith(h('div', { class: 'cmt' }, ic('compose'), text));
      haptic(8);
      syncFoot();
    };
    after.after(boxEl);
    ta.focus();
  };

  if (!files.length) return box.replaceChildren(h('div', { class: 'empty' }, 'No changes.'));
  box.replaceChildren(
    h('div', { class: 'dim small' }, `${files.length} file${files.length === 1 ? '' : 's'} · `, h('span', { class: 'dstat' }, h('span', { class: 'a' }, '+' + files.reduce((a, f) => a + f.add, 0)), ' ', h('span', { class: 'd' }, '−' + files.reduce((a, f) => a + f.del, 0))), canEdit ? ' · tap a line to comment' : ''),
    ...files.map((f, i) => {
      const el = h('div', { class: 'difffile' + (i > 4 ? ' collapsed' : '') });
      const head = h('button', { class: 'dfh' }, h('span', { class: 'p' }, f.path), h('span', { class: 'dstat' }, h('span', { class: 'a' }, '+' + f.add), ' ', h('span', { class: 'd' }, '−' + f.del)), ic('down'));
      head.onclick = () => el.classList.toggle('collapsed');
      const dfb = h('div', { class: 'dfb' });
      if (canEdit) {
        dfb.append(h('div', { class: 'dfa' },
          f.binary || f.path === '/dev/null' ? null : h('button', { class: 'chip', onclick: () => showFile(f.path) }, ic('file'), 'Open file'),
          h('button', { class: 'chip danger', onclick: () => revert(f) }, ic('undo'), f.isNew ? 'Delete new file' : 'Revert file'),
        ));
      }
      if (f.binary) dfb.append(h('span', { class: 'ctx' }, 'Binary file changed'));
      for (const hk of f.hunks) {
        const bar = h('div', { class: 'hunk hbar' }, h('span', { class: 'grow' }, hk.head));
        if (canEdit) {
          const cm = h('button', { class: 'hb', 'aria-label': 'Comment on hunk' }, ic('compose'));
          cm.onclick = () => commentBox(bar, f, hk, 0, hunkText(hk));
          const un = h('button', { class: 'hb', 'aria-label': 'Revert hunk' }, ic('undo'));
          un.onclick = () => revert(f, hk);
          bar.append(cm, un);
        }
        dfb.append(bar);
        let o = hk.old;
        let n = hk.new;
        for (const l of hk.lines) {
          const kind = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx';
          const num = kind === 'del' ? o : n;
          const row = h('span', { class: kind + ' dl', 'data-n': l.startsWith('\\') ? '' : num }, l || ' ');
          if (kind !== 'add') o++;
          if (kind !== 'del') n++;
          if (canEdit && !l.startsWith('\\')) row.onclick = () => commentBox(row, f, hk, num, l);
          dfb.append(row);
        }
      }
      el.append(head, dfb);
      return el;
    }),
    res.truncated ? h('div', { class: 'dim small' }, '… diff truncated (too large)') : '',
  );
  syncFoot();
}
