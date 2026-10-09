// Layar git: status, diff, commit, push, Pull Request.
import { app } from './state.js';
import { busyButton, h, haptic, ic, loading, toast, ui } from './dom.js';

// ---------- Git ----------
export async function showGit() {
  const s = app.current.session;
  const body = h('div', {}, loading('Memuat status git…'));
  ui.sheet(ui.head('Git', { sub: s.repo }), body);
  let st;
  try {
    st = await app.conn.call('status', { id: s.id });
  } catch (e) {
    return body.replaceChildren(h('div', { class: 'err' }, e.message));
  }
  app.current.refreshGit?.();
  const msg = h('input', { class: 'field', placeholder: 'Pesan commit…', autocapitalize: 'sentences', enterkeyhint: 'done' });
  const err = h('div', { class: 'err' });
  const act = (content, fn, cls = 'btn') => {
    const b = h('button', { class: cls }, ...content);
    b.onclick = async () => {
      const done = busyButton(b, 'Memproses…');
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
  const sync = st.hasUpstream ? (st.ahead || st.behind ? `↑${st.ahead} · ↓${st.behind}` : 'sinkron dengan GitHub') : st.ahead ? `${st.ahead} commit belum di GitHub` : 'belum ada di GitHub';
  body.replaceChildren(
    h('div', { class: 'gitsum' },
      h('span', { class: 'gi' }, ic('branch')),
      h('span', { class: 'grow' }, h('b', {}, st.branch), h('span', { class: 'dim small' }, sync)),
      h('span', { class: 'dstat big' }, st.files.length ? `${st.files.length} file` : '✓ bersih'),
    ),
    h('div', { class: 'label' }, 'Perubahan', h('span', { class: 'count' }, st.files.length)),
    st.files.length
      ? h('div', { class: 'files' }, ...st.files.map((f, i) => h('div', { class: 'f', style: `--i:${Math.min(i, 12)}` }, h('span', { class: 'st ' + stCls(f.st) }, stTxt(f.st)), h('span', { class: 'p' }, '‎' + f.path))))
      : h('div', { class: 'dim small' }, 'Tidak ada perubahan yang belum di-commit.'),
    st.files.length ? h('div', { style: 'margin-top:10px' }, act([ic('diff'), 'Lihat diff'], showDiff)) : null,
    st.files.length
      ? h('div', {}, h('div', { class: 'label' }, 'Commit'), h('div', { class: 'inline' }, msg, act([ic('commit'), 'Commit'], async () => {
          if (!msg.value.trim()) throw new Error('Isi pesan commit.');
          const c = await app.conn.call('commit', { id: s.id, message: msg.value });
          toast('Commit ' + c);
          haptic(15);
          showGit();
        }, 'btn primary')))
      : null,
    h('div', { class: 'label' }, 'Kirim ke GitHub'),
    h('div', { class: 'btnrow' },
      act([ic('push'), 'Push'], async () => {
        if (!(await ui.confirm({ title: 'Push ke GitHub?', text: `Branch ${st.branch} dikirim ke origin.`, ok: 'Push', icon: 'push', stay: true }))) return;
        ui.sheet(ui.head('Git', { sub: s.repo }), loading('Push ke GitHub…'));
        try {
          await app.conn.call('push', { id: s.id });
          toast('Push berhasil');
          haptic(20);
        } catch (x) {
          toast(x.message, true);
        }
        showGit();
      }, 'btn primary'),
      act([ic('pr'), 'Pull Request'], () => showPR(st)),
    ),
    err,
    st.log.length ? h('div', {}, h('div', { class: 'label' }, 'Commit terakhir'), h('div', { class: 'log' }, ...st.log.map((l) => h('div', {}, h('span', { class: 'h' }, l.slice(0, 7)), l.slice(8))))) : null,
  );
}

export function showPR(st) {
  const s = app.current.session;
  const title = h('input', { class: 'field', value: s.title || '', placeholder: 'Judul PR', autocapitalize: 'sentences' });
  const desc = h('textarea', { class: 'field', rows: 5, placeholder: 'Deskripsi (opsional)', autocapitalize: 'sentences' });
  const err = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn primary' }, ic('pr'), 'Buat PR');
  btn.onclick = async () => {
    const done = busyButton(btn, 'Membuat PR…');
    try {
      const pr = await app.conn.call('pr', { id: s.id, title: title.value || st.branch, body: desc.value });
      haptic(20);
      ui.sheet(ui.head('PR dibuat', { sub: `#${pr.number}` }), h('div', { class: 'empty' }, h('div', { class: 'emptyart ok' }, ic('pr')), h('b', {}, `Pull Request #${pr.number}`), 'Siap ditinjau di GitHub.'), h('a', { class: 'btn primary', href: pr.url, target: '_blank', rel: 'noopener' }, ic('github'), 'Buka di GitHub'));
    } catch (e) {
      done();
      err.textContent = e.message + (/No commits|not all refs/.test(e.message) ? ' — push dulu.' : '');
    }
  };
  ui.sheet(ui.head('Pull Request', { sub: `${st.branch} → ${s.base}`, back: showGit }), title, h('div', { style: 'height:10px' }), desc, err, h('div', { class: 'sheetfoot' }, btn));
}

export async function showDiff() {
  const box = h('div', {}, loading('Memuat diff…'));
  ui.sheet(ui.head('Diff', { sub: app.current.session.repo, back: showGit }), box);
  const { diff, truncated } = await app.conn.call('diff', { id: app.current.session.id });
  const files = [];
  let cur = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) {
      cur = { path: l.replace(/^diff --git a\/(.+?) b\/.*$/, '$1'), lines: [], add: 0, del: 0 };
      files.push(cur);
    } else if (!cur || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) continue;
    else {
      cur.lines.push(l);
      if (l.startsWith('+')) cur.add++;
      else if (l.startsWith('-')) cur.del++;
    }
  }
  if (!files.length) return box.replaceChildren(h('div', { class: 'empty' }, 'Tidak ada perubahan.'));
  box.replaceChildren(
    h('div', { class: 'dim small' }, `${files.length} file · `, h('span', { class: 'dstat' }, h('span', { class: 'a' }, '+' + files.reduce((a, f) => a + f.add, 0)), ' ', h('span', { class: 'd' }, '−' + files.reduce((a, f) => a + f.del, 0)))),
    ...files.map((f, i) => {
      const el = h('div', { class: 'difffile' + (i > 4 ? ' collapsed' : '') });
      const head = h('button', { class: 'dfh' }, h('span', { class: 'p' }, f.path), h('span', { class: 'dstat' }, h('span', { class: 'a' }, '+' + f.add), ' ', h('span', { class: 'd' }, '−' + f.del)), ic('down'));
      head.onclick = () => el.classList.toggle('collapsed');
      el.append(head, h('div', { class: 'dfb' }, ...diffLines(f.lines)));
      return el;
    }),
    truncated ? h('div', { class: 'dim small' }, '… diff dipotong (terlalu besar)') : '',
  );
}

export function diffLines(lines) {
  return lines.map((l) => {
    if (l.startsWith('@@')) return h('span', { class: 'hunk' }, l);
    if (l.startsWith('+')) return h('span', { class: 'add' }, l);
    if (l.startsWith('-')) return h('span', { class: 'del' }, l);
    return h('span', { class: 'ctx' }, l || ' ');
  });
}
