// Agent event renderer: streamed markdown text, tools, permissions, plans, questions, rewind.
import { stableCut } from '../md.js';
import { doneParts, todoItems, toolActivity } from '../../shared/events.js';
import { app } from './state.js';
import { anim, copyText, h, haptic, ic, md, mascot, toast, ui } from './dom.js';
import { localNotify } from './push.js';

// ---------- Agent event renderer ----------
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
    this.users = new Map(); // prompt seq -> rewind button
    /** @type {Set<string>} notes already shown on this screen */
    this.notes = new Set();
    this.permQueue = [];
    this.nextSteps = NEXT_OK;
    this.nextEl = null;
    this.textEl = null;
    /** @type {{ el: HTMLElement, src: string, done: number, pending: boolean } | null} */
    this.textBlock = null; // agent text block being streamed
    this.outEl = null;
    this.lastTodo = null;
    this.stick = true;
    this.unread = 0;
    this.activity = '';
    this.quiet = false;
    /** @type {(unread: number) => void} */
    this.onUnread = () => {};
    /** Suggestions on an empty session's welcome screen (set by session.js). */
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
    // Copy button on code blocks.
    term.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-copy]');
      if (!b) return;
      const code = b.closest('.code')?.querySelector('code')?.textContent || '';
      if (await copyText(code)) {
        b.classList.add('done');
        b.lastChild.textContent = 'copied';
        haptic(10);
        setTimeout(() => (b.classList.remove('done'), (b.lastChild.textContent = 'copy')), 1500);
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
    // Very long session: drop the oldest nodes to keep the phone light (only when the user is at the
    // bottom, so the reading position doesn't jump).
    if (this.el.childElementCount > DOM_MAX && this.stick && !this.quiet) {
      for (let i = 0; i < DOM_TRIM; i++) this.el.firstElementChild?.remove();
      this.el.prepend(h('div', { class: 'meta' }, '… older history hidden (reopen the session to see more)'));
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
        mascot('draw xl tap'),
        h('h2', { class: 'serif' }, 'What should we work on in ', h('span', { class: 'accent-text' }, name), '?'),
        h('div', { class: 'tags', style: 'justify-content:center' }, h('span', { class: 'tag' }, ic('branch'), s.branch), s.base ? h('span', { class: 'tag' }, 'from ' + s.base) : null),
        h('div', { class: 'sugs' },
          ...this.suggest.slice(0, 4).map((q, i) => h('button', { class: 'sug', style: `--i:${i}`, onclick: () => (haptic(8), this.onQuick(q.text)) }, h('span', { class: 'si' }, ic(q.icon)), h('span', {}, h('b', {}, q.t1), h('span', {}, q.t2)))),
        ),
        h('div', { class: 'tips' }, 'Start a message with ', h('span', { class: 'kbd' }, '!'), ' for a shell command · the ', h('span', { class: 'kbd' }, '+'), ' button for attachments, modes & quick actions'),
      ),
    );
  }
  add(e, replay = false) {
    switch (e.k) {
      case 'user': {
        this.nextEl?.remove();
        this.nextEl = null;
        this.textEl = null;
        this.outEl = null;
        this.activity = 'thinking…';
        this.textBlock = null;
        this.el.querySelector('.welcome:not(.used)')?.classList.add('used');
        const undo = h('button', { class: 'rw', 'aria-label': 'Restore files to before this prompt', hidden: true, onclick: () => rewindTo(e) }, ic('undo'), 'rewind');
        const copy = h('button', { class: 'rw', 'aria-label': 'Copy message', onclick: (ev) => copyBtn(ev.currentTarget, String(e.d || '')) }, ic('copy'));
        this.users.set(e.seq, undo);
        return this.append(h('div', { class: 'ln u' }, h('div', { class: 'bubble' }, e.d, e.img ? h('span', { class: 'tag' }, ic('image'), e.img) : null), h('div', { class: 'uact' }, copy, undo)));
      }
      case 'cp': {
        // Checkpoint available: show the rewind button on that prompt.
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
        // Render state lives on the block itself: a block that's already closed (tool/done arrived in
        // the same frame as the last text chunk) still renders through its last chunk.
        const t = this.textBlock;
        t.src += e.d;
        this.activity = 'writing…';
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
        this.activity = `thinking… (${e.words} words)`;
        return;
      case 'toolStart':
        this.activity = `preparing ${e.name}…`;
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
        return this.line('note', `↻ model error ${e.status ?? ''} — retrying${e.attempt ? ` (${e.attempt}/${e.max})` : ''}…`);
      case 'done': {
        this.activity = '';
        const txt = e.ok ? ['done', ...doneParts(e)].join(' · ') : `stopped · ${e.err || 'error'}`;
        if (e.ctx >= 80 && !this.quiet) toast(`Context ${e.ctx}% full — send /compact to keep the agent focused`, false, 6000);
        this.textEl = null;
        const ans = e.ok && this.textBlock?.src.trim();
        this.textBlock = null;
        const line = this.append(
          h('div', { class: 'donel' + (e.ok ? '' : ' bad') },
            h('span', { class: 'dt' }, (e.ok ? '✓ ' : '✗ ') + txt),
            ans ? h('button', { class: 'rw', 'aria-label': 'Copy answer', onclick: (ev) => copyBtn(ev.currentTarget, ans) }, ic('copy')) : null,
          ),
        );
        // Common next steps, one tap away (typing on a phone is costly). Only under the last turn.
        this.nextEl?.remove();
        const next = this.onQuick && (e.ok ? this.nextSteps : NEXT_FAIL);
        this.nextEl = next?.length ? this.append(h('div', { class: 'nextsteps' }, ...next.map(([label, text]) => h('button', { class: 'chip', onclick: () => (haptic(6), this.onQuick(text)) }, label)))) : null;
        return line;
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
      case 'note': {
        // Daemon text may start with "◆" (the icon is added here). The same warning (e.g. OS sandbox,
        // sent once per daemon process) shows only once even if the daemon restarted.
        const text = String(e.d).replace(/^◆\s*/, '');
        if (this.notes.has(text)) return;
        this.notes.add(text);
        return this.append(h('div', { class: 'note' }, h('span', {}, '◆'), h('span', {}, text)));
      }
      case 'error':
        return this.line('e', '✗ ' + e.d);
    }
  }
  // Markdown renders incrementally: finished blocks (split by blank lines outside code blocks) are
  // frozen, and only the last block re-renders per frame. Previously the whole text re-rendered on
  // every delta (O(n²) for long answers and history replay).
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
      if (el.classList.contains('open') && !body.childNodes.length) body.append(h('pre', { class: 'tout' }, e.s || '(no details)'));
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
    this.activity = 'thinking…';
    if (t.todo) return;
    t.el.classList.remove('live');
    const out = String(e.d || '').trim();
    const n = out ? out.split('\n').length : 0;
    t.stat.replaceChildren(
      t.add || t.del ? h('span', { class: 'dstat' }, h('span', { class: 'a' }, '+' + t.add), ' ', h('span', { class: 'd' }, '−' + t.del)) : n > 1 ? `${n} lines` : '',
      ic(e.ok ? 'check' : 'x', e.ok ? 'ok-i' : 'bad-i'),
      ic('down', 'chev'),
    );
    if (!e.ok) t.el.classList.add('fail');
    if (!t.add && !t.del) {
      t.body.replaceChildren(h('pre', { class: 'tout' + (e.ok ? '' : ' fail') }, out || '(no output)'));
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
      h('div', { class: 'tt' }, ic('list'), h('span', {}, 'Plan'), h('span', { class: 'bar' }, h('i', { style: `width:${items.length ? (done / items.length) * 100 : 0}%` })), h('span', {}, `${done}/${items.length}`)),
      ...items.map((i) => h('div', { class: 'it ' + i.st }, h('span', { class: 'ck' }, i.st === 'done' ? '✓' : i.st === 'doing' ? '◐' : '○'), h('span', {}, i.t))),
    );
    this.lastTodo = card;
    this.tools.set(e.id, { todo: true });
    this.append(card);
  }
  // Permission requests show in a dock above the composer (no scrolling needed).
  perm(e) {
    if (this.permQueue.some((p) => p.pid === e.pid)) return;
    this.permQueue.push(e);
    this.renderDock();
    if (app.permFromPush?.pid === e.pid) return this.answerFromPush();
    if (!this.quiet) {
      haptic([40, 60, 40]);
      localNotify('snugcode — needs permission', `${e.tool}: ${String(e.s || '').slice(0, 120)}`);
    }
  }
  // Answer from a notification button (sw.js → app.js). Only for a permission that's still pending, and
  // only low/medium risk (the daemon omits the pid for high risk).
  async answerFromPush() {
    if (app.locked) return; // answered after unlocking (ui/lock.js)
    const want = app.permFromPush;
    app.permFromPush = null;
    const e = want && this.permQueue.find((p) => p.pid === want.pid);
    if (!e || e.push || e.risk?.level === 'high') return;
    try {
      await app.conn.call('perm', { id: app.current.session.id, pid: e.pid, decision: want.decision });
      toast(want.decision === 'allow' ? `✓ ${e.tool} allowed from the notification` : `✗ ${e.tool} denied from the notification`);
    } catch (x) {
      toast(x.message, true);
    }
  }
  permAnswer(e) {
    this.permQueue = this.permQueue.filter((p) => p.pid !== e.pid);
    this.renderDock();
    this.append(h('div', { class: 'meta', style: 'margin:6px 0' }, `${e.allow ? '✓ allowed' : '✗ denied'} · ${e.tool}${e.s ? ' · ' + String(e.s).split('\n')[0].slice(0, 70) : ''}`));
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
    const more = this.permQueue.length > 1 ? h('div', { class: 'more' }, `+${this.permQueue.length - 1} more request${this.permQueue.length === 2 ? '' : 's'}`) : null;
    if (e.ask) return this.dock.replaceChildren(askPanel(e, answer, more));
    if (e.plan) return this.dock.replaceChildren(planPanel(e, answer, more));
    // High risk looks different (red, no "Always"): to counter the habit of tapping Allow blindly.
    const high = e.push || e.risk?.level === 'high';
    buttons.append(
      h('button', { class: 'btn ghost', onclick: () => answer('deny') }, 'Deny'),
      high || !e.always ? null : h('button', { class: 'btn', onclick: () => answer('always') }, 'Always'),
      h('button', { class: 'btn ' + (high ? 'dangerfill' : 'primary'), onclick: () => answer('allow') }, 'Allow'),
    );
    const [kind, glyph] = TOOL_KIND[e.tool] || ['other', '•'];
    const RISK = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' };
    this.dock.replaceChildren(
      h('div', { class: 'perm' + (high ? ' push' : '') + (e.risk ? ' r-' + e.risk.level : '') },
        h('div', { class: 'q' }, h('span', { class: `pi t-${kind}` }, e.push ? ic('push') : glyph), h('span', { class: 'grow' }, e.push ? 'The agent wants to push to GitHub' : `Allow ${e.tool}?`, e.title ? h('span', { class: 'pt' }, e.title) : null)),
        e.risk ? h('div', { class: 'risk' }, h('span', { class: 'rl' }, ic(e.risk.level === 'low' ? 'shield' : 'alert'), RISK[e.risk.level]), e.risk.why ? h('span', {}, e.risk.why) : null) : null,
        h('pre', {}, e.summary || e.s || ''),
        e.x ? miniDiff(e.x).el : null,
        e.undo ? h('div', { class: 'undo' }, ic('undo'), e.undo === 'file' ? 'Can be undone: rewind to before this prompt.' : 'File changes can be rewound; effects outside the session folder (network, global packages) can’t.') : null,
        buttons,
        !high && e.always ? h('div', { class: 'more' }, 'Always = auto-allow in this session: ' + e.always) : null,
        more,
      ),
    );
    requestAnimationFrame(() => this.keepBottom());
  }
}

// Follow-up chips after a turn finishes / fails (label, prompt). A session can replace them via renderer.nextSteps.
export const NEXT_OK = [
  ['Run tests', 'Run the tests relevant to those changes and fix anything that fails.'],
  ['Review changes', 'Review the uncommitted changes (git diff): look for bugs or risks, then summarize.'],
  ['Commit', 'Look at the current changes, write a clear commit message, then commit. Don’t push.'],
];
const NEXT_FAIL = [
  ['Try again', 'Continue the previous task from where it left off.'],
  ['Explain the error', 'Briefly explain why it failed and what the options to fix it are.'],
];

// Multiple-choice questions from the agent (AskUserQuestion): 1–4 questions, tap options + free answer.
export function askPanel(e, answer, more) {
  const picks = e.ask.map(() => new Set());
  const others = e.ask.map(() => h('input', { class: 'field', placeholder: 'Other answer (optional)', autocapitalize: 'sentences' }));
  const ok = h('button', { class: 'btn primary' }, 'Send answer');
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
    h('div', { class: 'q' }, h('span', { class: 'pi t-agent' }, '?'), h('span', { class: 'grow' }, 'The agent asks')),
    ...qs,
    h('div', { class: 'btnrow' }, h('button', { class: 'btn ghost', onclick: () => answer('deny', { message: 'The user skipped the question; decide yourself with the most sensible choice.' }) }, 'Skip'), ok),
    more,
  );
}

// Plan from plan mode (ExitPlanMode): approve and the agent starts working, or ask for a revision.
export function planPanel(e, answer, more) {
  const note = h('textarea', { class: 'field', rows: 2, placeholder: 'Revision notes (optional)', autocapitalize: 'sentences' });
  return h('div', { class: 'perm ask' },
    h('div', { class: 'q' }, h('span', { class: 'pi t-agent' }, ic('list')), h('span', { class: 'grow' }, 'Plan ready — approve?')),
    h('div', { class: 'plan txt', html: md(String(e.summary || e.s || '')) }),
    note,
    h('div', { class: 'btnrow' },
      h('button', { class: 'btn', onclick: () => answer('deny', { message: note.value.trim() ? 'Revise the plan: ' + note.value.trim() : 'The user wants to revise the plan. Stop now and wait for revision instructions.' }) }, 'Revise'),
      h('button', { class: 'btn primary', onclick: () => answer('allow') }, 'Approve & start'),
    ),
    more,
  );
}

// Small copy button: its icon briefly turns into a check.
async function copyBtn(b, text) {
  if (!(await copyText(text))) return;
  haptic(10);
  b.classList.add('done');
  b.firstChild.replaceWith(ic('check'));
  setTimeout(() => (b.classList.remove('done'), b.firstChild.replaceWith(ic('copy'))), 1400);
}

export async function rewindTo(e) {
  const label = String(e.d || 'image').slice(0, 60);
  if (!(await ui.confirm({ title: 'Rewind to before this prompt?', text: `All worktree files go back to how they were before "${label}". Later changes (by the agent or by hand) will be lost.`, ok: 'Rewind', danger: true, icon: 'undo' }))) return;
  try {
    const n = await app.conn.call('rewind', { id: app.current.session.id, seq: e.seq });
    haptic(20);
    toast(n ? `${n} file${n === 1 ? '' : 's'} restored` : 'No files changed');
    app.current.refreshGit?.();
  } catch (x) {
    toast(x.message, true);
  }
}
// Snippet of Edit/MultiEdit/Write changes ({ old?, new? } or { edits: [...] }).
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
