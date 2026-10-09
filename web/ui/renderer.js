// Renderer event agen: teks markdown bertahap, tool, izin, rencana, pertanyaan, rewind.
import { stableCut } from '../md.js';
import { doneParts, todoItems, toolActivity } from '../../shared/events.js';
import { app } from './state.js';
import { anim, copyText, h, haptic, ic, md, spark, toast, ui } from './dom.js';
import { localNotify } from './push.js';

// ---------- Renderer event agen ----------
export const TOOL_KIND = { Bash: ['bash', '$'], dev_start: ['bash', '▶'], dev_stop: ['bash', '■'], dev_logs: ['read', '≡'], dev_list: ['read', '≡'], preview_screenshot: ['web', '◐'], Read: ['read', '◱'], NotebookRead: ['read', '◱'], Edit: ['edit', '✎'], MultiEdit: ['edit', '✎'], NotebookEdit: ['edit', '✎'], Write: ['write', '+'], Grep: ['search', '⌕'], Glob: ['search', '⌕'], LS: ['search', '⌕'], WebFetch: ['web', '⊕'], WebSearch: ['web', '⊕'], Task: ['agent', '◈'], Agent: ['agent', '◈'], AskUserQuestion: ['agent', '?'], ExitPlanMode: ['agent', '☰'] };

const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);

export const DOM_MAX = 2500;
export const DOM_TRIM = 500;

export class Renderer {
  constructor(term, col, dock) {
    this.term = term;
    this.el = col;
    this.dock = dock;
    this.tools = new Map();
    this.users = new Map(); // seq prompt -> tombol rewind
    this.permQueue = [];
    this.textEl = null;
    /** @type {{ el: HTMLElement, src: string, done: number, pending: boolean } | null} */
    this.textBlock = null; // blok teks agen yang sedang di-stream
    this.outEl = null;
    this.lastTodo = null;
    this.stick = true;
    this.unread = 0;
    this.activity = '';
    this.quiet = false;
    /** @type {(unread: number) => void} */
    this.onUnread = () => {};
    /** Saran di layar sambutan sesi kosong (diisi session.js). */
    /** @type {{ icon: string, t1: string, t2: string, text: string }[]} */
    this.suggest = [];
    /** @type {(text: string) => void} */
    this.onQuick = () => {};
    term.addEventListener('scroll', () => {
      const near = term.scrollHeight - term.scrollTop - term.clientHeight < 90;
      if (near !== this.stick || (near && this.unread)) {
        this.stick = near;
        if (near) this.unread = 0;
        this.onUnread(this.unread);
      }
    }, { passive: true });
    // Tombol salin pada blok kode.
    term.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-copy]');
      if (!b) return;
      const code = b.closest('.code')?.querySelector('code')?.textContent || '';
      if (await copyText(code)) {
        b.classList.add('done');
        b.lastChild.textContent = 'tersalin';
        haptic(10);
        setTimeout(() => (b.classList.remove('done'), (b.lastChild.textContent = 'salin')), 1500);
      }
    });
  }
  batch(fn) {
    this.quiet = true;
    try {
      fn();
    } finally {
      this.quiet = false;
    }
  }
  keepBottom() {
    if (this.stick) this.term.scrollTop = this.term.scrollHeight;
  }
  scroll(force) {
    if (force) {
      this.stick = true;
      this.unread = 0;
      this.onUnread(0);
    }
    if (this.stick) requestAnimationFrame(() => (this.term.scrollTop = this.term.scrollHeight));
  }
  append(node, animate = true) {
    if (animate && !this.quiet) node.classList.add('ev');
    this.el.append(node);
    // Sesi sangat panjang: buang node terlama agar HP tetap ringan (hanya saat pengguna di bawah,
    // supaya posisi baca tidak melompat).
    if (this.el.childElementCount > DOM_MAX && this.stick && !this.quiet) {
      for (let i = 0; i < DOM_TRIM; i++) this.el.firstElementChild?.remove();
      this.el.prepend(h('div', { class: 'meta' }, '… riwayat lama disembunyikan (buka ulang sesi untuk melihat lebih banyak)'));
    }
    if (!this.stick && !this.quiet) {
      this.unread++;
      this.onUnread(this.unread);
    }
    this.scroll();
    return node;
  }
  line(cls, text) {
    this.textEl = null;
    this.outEl = null;
    return this.append(h('div', { class: 'ln ' + cls }, text));
  }
  welcome(s) {
    const name = s.repo.split('/')[1] || s.repo;
    this.append(
      h('div', { class: 'welcome' },
        spark('draw xl'),
        h('h2', { class: 'serif' }, 'Apa yang mau dikerjakan di ', h('span', { class: 'accent-text' }, name), '?'),
        h('div', { class: 'tags', style: 'justify-content:center' }, h('span', { class: 'tag' }, ic('branch'), s.branch), s.base ? h('span', { class: 'tag' }, 'dari ' + s.base) : null),
        h('div', { class: 'sugs' },
          ...this.suggest.slice(0, 4).map((q, i) => h('button', { class: 'sug', style: `--i:${i}`, onclick: () => (haptic(8), this.onQuick(q.text)) }, h('span', { class: 'si' }, ic(q.icon)), h('span', {}, h('b', {}, q.t1), h('span', {}, q.t2)))),
        ),
        h('div', { class: 'tips' }, 'Ketik ', h('span', { class: 'kbd' }, '!'), ' di awal pesan untuk perintah shell · tombol ', h('span', { class: 'kbd' }, '+'), ' untuk lampiran, mode & aksi cepat'),
      ),
    );
  }
  add(e, replay = false) {
    switch (e.k) {
      case 'user': {
        this.textEl = null;
        this.outEl = null;
        this.activity = 'berpikir…';
        this.textBlock = null;
        this.el.querySelector('.welcome:not(.used)')?.classList.add('used');
        const undo = h('button', { class: 'rw', 'aria-label': 'Kembalikan file ke sebelum prompt ini', hidden: true, onclick: () => rewindTo(e) }, ic('undo'), 'rewind');
        const copy = h('button', { class: 'rw', 'aria-label': 'Salin pesan', onclick: (ev) => copyBtn(ev.currentTarget, String(e.d || '')) }, ic('copy'));
        this.users.set(e.seq, undo);
        return this.append(h('div', { class: 'ln u' }, h('div', { class: 'bubble' }, e.d, e.img ? h('span', { class: 'tag' }, ic('image'), e.img) : null), h('div', { class: 'uact' }, copy, undo)));
      }
      case 'cp': {
        // Checkpoint tersedia: tampilkan tombol rewind pada prompt terkait.
        const b = this.users.get(e.of);
        if (b?.hidden) (b.hidden = false), this.quiet || anim(b, [{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'none' }], 240);
        return;
      }
      case 'shot':
        this.textEl = null;
        return this.append(h('figure', { class: 'shotmsg' }, h('img', { src: `data:${e.mime};base64,${e.data}`, alt: 'screenshot', loading: 'lazy', onclick: (ev) => ev.currentTarget.classList.toggle('big') }), h('figcaption', {}, e.url)));
      case 'text': {
        if (!this.textEl) {
          this.textEl = this.append(h('div', { class: 'ln txt' }, h('div'), h('div')));
          this.textBlock = { el: this.textEl, src: '', done: 0, pending: false };
        }
        // Status render melekat pada bloknya sendiri: blok yang sudah ditutup (tool/done tiba di
        // frame yang sama dengan potongan teks terakhir) tetap dirender sampai potongan terakhir.
        const t = this.textBlock;
        t.src += e.d;
        this.activity = 'menulis…';
        if (!t.pending) {
          t.pending = true;
          const flush = () => {
            t.pending = false;
            this.renderText(t);
            this.scroll();
          };
          this.quiet ? flush() : requestAnimationFrame(flush);
        }
        return;
      }
      case 'thinking':
        this.activity = `berpikir… (${e.words} kata)`;
        return;
      case 'toolStart':
        this.activity = `menyiapkan ${e.name}…`;
        return;
      case 'tool':
        return e.name === 'TodoWrite' ? this.todo(e) : this.tool(e);
      case 'result':
        return this.result(e);
      case 'perm':
        return this.perm(e);
      case 'permAnswer':
        return this.permAnswer(e);
      case 'retry':
        return this.line('note', `↻ 9router error ${e.status ?? ''} — mencoba lagi (${e.attempt}/${e.max})…`);
      case 'done': {
        this.activity = '';
        const txt = e.ok ? ['selesai', ...doneParts(e)].join(' · ') : `berhenti · ${e.err || 'error'}`;
        if (e.ctx >= 80 && !this.quiet) toast(`Konteks ${e.ctx}% penuh — kirim /compact agar agen tetap fokus`, false, 6000);
        this.textEl = null;
        const ans = e.ok && this.textBlock?.src.trim();
        this.textBlock = null;
        return this.append(
          h('div', { class: 'donel' + (e.ok ? '' : ' bad') },
            h('span', { class: 'dt' }, (e.ok ? '✓ ' : '✗ ') + txt),
            ans ? h('button', { class: 'rw', 'aria-label': 'Salin jawaban', onclick: (ev) => copyBtn(ev.currentTarget, ans) }, ic('copy')) : null,
          ),
        );
      }
      case 'sh':
        this.activity = '$ ' + e.d;
        this.textEl = null;
        this.append(h('div', { class: 'ln u shell' }, h('div', { class: 'bubble' }, h('span', { class: 'pr' }, '$'), e.d)));
        this.outEl = null;
        return;
      case 'out':
        if (!this.outEl) this.outEl = this.append(h('pre', { class: 'shout' }));
        this.outEl.append(e.d);
        this.outEl.scrollTop = this.outEl.scrollHeight;
        return this.scroll();
      case 'shDone':
        this.outEl = null;
        return this.append(h('div', { class: 'meta', style: 'margin-bottom:8px' }, e.code === 0 ? '✓ exit 0' : `✗ exit ${e.code}`));
      case 'note':
        return this.append(h('div', { class: 'note' }, h('span', {}, '◆'), h('span', {}, e.d)));
      case 'error':
        return this.line('e', '✗ ' + e.d);
    }
  }
  // Markdown dirender bertahap: blok yang sudah selesai (dipisah baris kosong di luar blok kode)
  // dibekukan, hanya blok terakhir yang dirender ulang per frame. Dulu seluruh teks dirender
  // ulang setiap delta (O(n²) untuk jawaban panjang dan saat memutar ulang riwayat).
  /** @param {{ el: HTMLElement, src: string, done: number }} t */
  renderText(t) {
    const [done, tail] = t.el.children;
    const cut = stableCut(t.src, t.done);
    if (cut > t.done) {
      done.insertAdjacentHTML('beforeend', md(t.src.slice(t.done, cut)));
      t.done = cut;
    }
    tail.innerHTML = md(t.src.slice(t.done));
  }
  tool(e) {
    this.textEl = null;
    this.outEl = null;
    const [kind, glyph] = TOOL_KIND[e.name] || ['other', '•'];
    const first = String(e.s || '').split('\n')[0];
    this.activity = lowerFirst(toolActivity(e)).slice(0, 80);
    const stat = h('span', { class: 'tstat' }, h('span', { class: 'spinner', style: 'width:14px;height:14px' }));
    const body = h('div', { class: 'tb' });
    const el = h('div', { class: `tool t-${kind} live` },
      h('button', { class: 'th', 'aria-expanded': 'false' }, h('span', { class: 'ti' }, glyph), h('span', { class: 'tn' }, e.name), h('span', { class: 'ts' }, first), stat),
      body,
    );
    el.firstChild.onclick = () => {
      el.classList.toggle('open');
      el.firstChild.setAttribute('aria-expanded', el.classList.contains('open'));
      if (el.classList.contains('open') && !body.childNodes.length) body.append(h('pre', { class: 'tout' }, e.s || '(tanpa detail)'));
    };
    let add = 0;
    let del = 0;
    if (e.x) {
      const d = miniDiff(e.x);
      ({ add, del } = d);
      body.append(h('pre', { class: 'tout', style: 'max-height:none;padding-bottom:0' }, e.s || ''), d.el);
    }
    this.tools.set(e.id, { el, stat, body, name: e.name, add, del });
    this.append(el);
  }
  result(e) {
    const t = this.tools.get(e.id);
    if (!t) return;
    this.activity = 'berpikir…';
    if (t.todo) return;
    t.el.classList.remove('live');
    const out = String(e.d || '').trim();
    const n = out ? out.split('\n').length : 0;
    t.stat.replaceChildren(
      t.add || t.del ? h('span', { class: 'dstat' }, h('span', { class: 'a' }, '+' + t.add), ' ', h('span', { class: 'd' }, '−' + t.del)) : n > 1 ? `${n} baris` : '',
      ic(e.ok ? 'check' : 'x', e.ok ? 'ok-i' : 'bad-i'),
      ic('down', 'chev'),
    );
    if (!e.ok) t.el.classList.add('fail');
    if (!t.add && !t.del) {
      t.body.replaceChildren(h('pre', { class: 'tout' + (e.ok ? '' : ' fail') }, out || '(tanpa output)'));
    } else if (!e.ok) t.body.append(h('pre', { class: 'tout fail' }, out));
    if (!e.ok && !this.quiet) t.el.classList.add('open');
  }
  todo(e) {
    this.textEl = null;
    this.outEl = null;
    const items = todoItems(e);
    const done = items.filter((i) => i.st === 'done').length;
    const doing = items.find((i) => i.st === 'doing');
    if (doing) this.activity = '◐ ' + doing.t;
    this.lastTodo?.classList.add('stale');
    const card = h('div', { class: 'todo' },
      h('div', { class: 'tt' }, ic('list'), h('span', {}, 'Rencana'), h('span', { class: 'bar' }, h('i', { style: `width:${items.length ? (done / items.length) * 100 : 0}%` })), h('span', {}, `${done}/${items.length}`)),
      ...items.map((i) => h('div', { class: 'it ' + i.st }, h('span', { class: 'ck' }, i.st === 'done' ? '✓' : i.st === 'doing' ? '◐' : '○'), h('span', {}, i.t))),
    );
    this.lastTodo = card;
    this.tools.set(e.id, { todo: true });
    this.append(card);
  }
  // Permintaan izin ditampilkan di dok di atas composer (tidak perlu scroll).
  perm(e) {
    if (this.permQueue.some((p) => p.pid === e.pid)) return;
    this.permQueue.push(e);
    this.renderDock();
    if (!this.quiet) {
      haptic([40, 60, 40]);
      localNotify('pocketcode — butuh izin', `${e.tool}: ${String(e.s || '').slice(0, 120)}`);
    }
  }
  permAnswer(e) {
    this.permQueue = this.permQueue.filter((p) => p.pid !== e.pid);
    this.renderDock();
    this.append(h('div', { class: 'meta', style: 'margin:6px 0' }, `${e.allow ? '✓ diizinkan' : '✗ ditolak'} · ${e.tool}${e.s ? ' · ' + String(e.s).split('\n')[0].slice(0, 70) : ''}`));
  }
  renderDock() {
    const e = this.permQueue[0];
    if (!e) return this.dock.replaceChildren();
    const buttons = h('div', { class: 'btnrow' });
    const answer = async (decision, extra = {}) => {
      this.dock.querySelectorAll('button').forEach((b) => (b.disabled = true));
      haptic(12);
      try {
        await app.conn.call('perm', { id: app.current.session.id, pid: e.pid, decision, ...extra });
      } catch (x) {
        toast(x.message, true);
        this.dock.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    };
    const more = this.permQueue.length > 1 ? h('div', { class: 'more' }, `+${this.permQueue.length - 1} permintaan lagi`) : null;
    if (e.ask) return this.dock.replaceChildren(askPanel(e, answer, more));
    if (e.plan) return this.dock.replaceChildren(planPanel(e, answer, more));
    buttons.append(
      h('button', { class: 'btn ghost', onclick: () => answer('deny') }, 'Tolak'),
      e.push ? null : h('button', { class: 'btn', onclick: () => answer('always') }, 'Selalu'),
      h('button', { class: 'btn ' + (e.push ? 'dangerfill' : 'primary'), onclick: () => answer('allow') }, 'Izinkan'),
    );
    const [kind, glyph] = TOOL_KIND[e.tool] || ['other', '•'];
    this.dock.replaceChildren(
      h('div', { class: 'perm' + (e.push ? ' push' : '') },
        h('div', { class: 'q' }, h('span', { class: `pi t-${kind}` }, e.push ? ic('push') : glyph), h('span', { class: 'grow' }, e.push ? 'Agen ingin push ke GitHub' : `Izinkan ${e.tool}?`, e.title ? h('span', { class: 'pt' }, e.title) : null)),
        h('pre', {}, e.summary || e.s || ''),
        e.x ? miniDiff(e.x).el : null,
        buttons,
        !e.push && e.always ? h('div', { class: 'more' }, 'Selalu = izinkan otomatis di sesi ini: ' + e.always) : null,
        more,
      ),
    );
    requestAnimationFrame(() => this.keepBottom());
  }
}

// Pertanyaan pilihan dari agen (AskUserQuestion): 1–4 pertanyaan, opsi tap + jawaban bebas.
export function askPanel(e, answer, more) {
  const picks = e.ask.map(() => new Set());
  const others = e.ask.map(() => h('input', { class: 'field', placeholder: 'Jawaban lain (opsional)', autocapitalize: 'sentences' }));
  const ok = h('button', { class: 'btn primary' }, 'Kirim jawaban');
  const sync = () => (ok.disabled = !e.ask.every((_, i) => picks[i].size || others[i].value.trim()));
  const qs = e.ask.map((q, i) =>
    h('div', { class: 'askq' },
      h('div', { class: 'qt' }, q.header ? h('span', { class: 'tag' }, q.header) : null, q.question),
      h('div', { class: 'opts' }, ...q.options.map((o) => {
        const b = h('button', { class: 'opt' }, h('b', {}, o.label), o.description ? h('span', {}, o.description) : null);
        b.onclick = () => {
          haptic(8);
          if (!q.multiSelect) picks[i].clear(), b.parentNode.querySelectorAll('.opt').forEach((x) => x.classList.remove('on'));
          picks[i].has(o.label) ? picks[i].delete(o.label) : picks[i].add(o.label);
          b.classList.toggle('on', picks[i].has(o.label));
          sync();
        };
        return b;
      })),
      others[i],
    ),
  );
  others.forEach((o) => (o.oninput = sync));
  sync();
  ok.onclick = () => answer('allow', { answers: Object.fromEntries(e.ask.map((q, i) => [q.question, [...picks[i], others[i].value.trim()].filter(Boolean).join(', ')])) });
  return h('div', { class: 'perm ask' },
    h('div', { class: 'q' }, h('span', { class: 'pi t-agent' }, '?'), h('span', { class: 'grow' }, 'Agen bertanya')),
    ...qs,
    h('div', { class: 'btnrow' }, h('button', { class: 'btn ghost', onclick: () => answer('deny', { message: 'Pengguna melewati pertanyaan; putuskan sendiri dengan pilihan paling masuk akal.' }) }, 'Lewati'), ok),
    more,
  );
}

// Rencana dari mode rencana (ExitPlanMode): setujui lalu agen mulai mengerjakan, atau minta revisi.
export function planPanel(e, answer, more) {
  const note = h('textarea', { class: 'field', rows: 2, placeholder: 'Catatan revisi (opsional)', autocapitalize: 'sentences' });
  return h('div', { class: 'perm ask' },
    h('div', { class: 'q' }, h('span', { class: 'pi t-agent' }, ic('list')), h('span', { class: 'grow' }, 'Rencana siap — setujui?')),
    h('div', { class: 'plan txt', html: md(String(e.summary || e.s || '')) }),
    note,
    h('div', { class: 'btnrow' },
      h('button', { class: 'btn', onclick: () => answer('deny', { message: note.value.trim() ? 'Revisi rencananya: ' + note.value.trim() : 'Pengguna ingin merevisi rencana. Berhenti sekarang dan tunggu arahan revisinya.' }) }, 'Revisi'),
      h('button', { class: 'btn primary', onclick: () => answer('allow') }, 'Setujui & kerjakan'),
    ),
    more,
  );
}

// Tombol salin kecil: ikonnya menjadi centang sebentar.
async function copyBtn(b, text) {
  if (!(await copyText(text))) return;
  haptic(10);
  b.classList.add('done');
  b.firstChild.replaceWith(ic('check'));
  setTimeout(() => (b.classList.remove('done'), b.firstChild.replaceWith(ic('copy'))), 1400);
}

export async function rewindTo(e) {
  const label = String(e.d || 'gambar').slice(0, 60);
  if (!(await ui.confirm({ title: 'Rewind ke sebelum prompt ini?', text: `Semua file worktree dikembalikan ke kondisi sebelum "${label}". Perubahan setelahnya (oleh agen maupun manual) akan hilang.`, ok: 'Rewind', danger: true, icon: 'undo' }))) return;
  try {
    const n = await app.conn.call('rewind', { id: app.current.session.id, seq: e.seq });
    haptic(20);
    toast(n ? `${n} file dikembalikan` : 'Tidak ada file yang berubah');
    app.current.refreshGit?.();
  } catch (x) {
    toast(x.message, true);
  }
}
// Cuplikan perubahan Edit/MultiEdit/Write ({ old?, new? } atau { edits: [...] }).
export function miniDiff(x) {
  const el = h('div', { class: 'diffmini' });
  let add = 0;
  let del = 0;
  for (const ed of x.edits || [x]) {
    if (ed.old) for (const l of ed.old.split('\n')) (del++, el.append(h('span', { class: 'del' }, '- ' + l)));
    if (ed.new) for (const l of ed.new.split('\n')) (add++, el.append(h('span', { class: 'add' }, '+ ' + l)));
  }
  return { el, add, del };
}
