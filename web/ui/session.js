// Session screen (conversation with the agent): git/run header, card composer with a + button (attachments,
// modes, quick actions), active mode pills, model picker, and re-attach after the connection recovers.
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

// Autonomy presets (shared/risk.js AUTONOMY): label, description, icon.
const AUTONOMY_UI = {
  ask: ['Ask everything', 'every edit & command waits for your approval', 'eye'],
  balanced: ['Balanced', 'edits apply directly (rewindable), commands ask first', 'shield'],
  trusted: ['Routine auto', 'tests, lint & builds run right away; other commands ask', 'flask'],
  auto: ['Full', 'everything runs right away, except push & PRs', 'bolt'],
};

// ---------- Screen: session ----------
export const QUICK = [
  { icon: 'book', t1: 'Explain this repo', t2: 'structure, how to run it, key parts', text: 'Explain this repo’s structure, how to run it, and its most important parts. Keep it short.' },
  { icon: 'diff', t1: 'Review changes', t2: 'check git diff, find bugs, summarize', text: 'Review the uncommitted changes (git diff): look for bugs or risks, then summarize.' },
  { icon: 'flask', t1: 'Run & fix tests', t2: 'find the test command, run it, fix failures', text: 'Find how to run the tests in this repo, run them, then fix any failures.' },
  { icon: 'bug', t1: 'Fix the last error', t2: 'continue from the previous output', text: 'Fix the last error that came up in this session, then verify.' },
  { icon: 'commit', t1: 'Commit changes', t2: 'write a clear commit message and commit', text: 'Look at the current changes, write a clear commit message, then commit. Don’t push.' },
];
export const QUICK_SH = ['git status', 'git log --oneline -n 8', 'git diff --stat', 'ls'];

export const QUICK_COMPUTER = [
  { icon: 'monitor', t1: 'System info summary', t2: 'OS, CPU, memory, current directory', text: 'Show a summary of system info: OS, specs, current directory, and environment status. Keep it short.' },
  { icon: 'term', t1: 'Check processes & ports', t2: 'see running processes and open ports', text: 'Check the running processes and the ports in use or open on this computer.' },
  { icon: 'bug', t1: 'Fix the last error', t2: 'continue from the previous output', text: 'Fix the last error that came up in this session, then verify.' },
  { icon: 'search', t1: 'Find files on the computer', t2: 'help find a specific file or folder', text: 'Help me find a file or folder on this computer.' },
  { icon: 'branch', t1: 'Check git status', t2: 'inspect the git repo in this folder, if any', text: 'Check the git status in this directory if it’s a git repository.' },
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
  const wl = h('span', { class: 'wl shimmer' }, 'Thinking…');
  const wt = h('span', { class: 't' }, '0s');
  const working = h('div', { id: 'working', hidden: true }, mascot('think'), wl, wt);
  const toBottom = h('button', { id: 'tobottom', hidden: true, 'aria-label': 'Jump to latest' }, ic('arrowdown'));
  const dock = h('div', { id: 'dock' });
  const input = h('textarea', { id: 'input', rows: 1, placeholder: s.computer ? 'Ask anything on your computer…' : 'Ask the agent…', autocapitalize: 'sentences', enterkeyhint: coarse ? 'enter' : 'send', 'aria-label': 'Message' });
  const send = h('button', { id: 'send', class: 'idle', 'aria-label': 'Send' }, ic('send'));
  const plusBtn = h('button', { class: 'cbtn plus', 'aria-label': 'Attachments & tools' }, ic('plus'));
  const modelChip = h('button', { class: 'cbtn model', 'aria-label': 'Change model' });
  const modes = h('div', { id: 'modes', hidden: true });
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const camIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const thumbs = h('div', { id: 'thumbs', hidden: true });
  const gitBadge = h('span', { class: 'badge', hidden: true });
  const gitBtn = h('button', { class: 'iconbtn', 'aria-label': 'Git', title: 'Git', onclick: () => (haptic(6), showGit()) }, ic('branch'), gitBadge);
  const runBtn = h('button', { class: 'iconbtn', 'aria-label': 'Run & preview', title: 'Run & Preview', onclick: () => (haptic(6), showRun()) }, ic('play'));
  const composer = h('div', { id: 'composer' },
    h('div', { class: 'inner' },
      dock,
      h('div', { class: 'cbox' }, thumbs, modes, input, h('div', { class: 'crow' }, plusBtn, modelChip, h('span', { class: 'grow' }), send)),
    ),
    fileIn, camIn,
  );
  ui.set(s.title || repoName(s), { sub: sessionSub(s), menu: true, onTitle: () => sessionMenu(), titleLabel: 'Session menu', dot: 'on', actions: [runBtn, gitBtn] });
  const view = h('div', { class: 'session chat' }, term, working, toBottom, composer);
  ui.view(view);

  const r = new Renderer(term, col, dock);
  app.current.renderer = r;
  app.current.procs = new Map();
  app.current.preview = null;

  // The composer floats over the conversation: its real height becomes empty space below the messages.
  const ro = new ResizeObserver(() => {
    if (!view.isConnected) return ro.disconnect();
    view.style.setProperty('--ch', composer.offsetHeight + 'px');
    r.keepBottom();
  });
  ro.observe(composer);

  // --- run & preview: live dot + running process count in the header ---
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

  // --- modes: plan (on the PC), shell (local), auto-allow (on the PC) — shown as active pills ---
  let shellMode = false;
  const renderModes = () => {
    const ss = app.current.session;
    const pill = (cls, icon, label, off) => h('button', { class: 'mode ' + cls, onclick: () => (haptic(8), Promise.resolve(off()).catch((e) => toast(e.message, true))) }, ic(icon), label, ic('x', 'mx'));
    const list = [
      ss.plan ? pill('plan', 'list', 'Plan', () => setPlanRemote(false)) : null,
      shellMode ? pill('shell', 'term', 'Shell', () => setMode(false)) : null,
      ss.auto ? pill('auto', 'bolt', 'Auto-allow', () => setAutoRemote(false)) : null,
      !ss.auto && ss.autoLow ? pill('auto low', 'flask', 'Routine auto', () => app.conn.call('autonomy', { id: s.id, level: 'balanced' }).then((r) => (Object.assign(app.current.session, r), renderModes()))) : null,
    ].filter(Boolean);
    const was = !modes.hidden;
    modes.hidden = !list.length;
    modes.replaceChildren(...list);
    if (!was && list.length) anim(modes, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 240);
    input.placeholder = ss.plan ? 'What should we plan?' : shellMode ? (ss.computer ? 'Shell command on the PC…' : 'Shell command in the worktree…') : (ss.computer ? 'Ask anything on your computer…' : 'Ask the agent…');
    plusBtn.classList.toggle('on', list.length > 0);
  };
  app.current.setPlan = (on) => {
    app.current.session.plan = on;
    renderModes();
  };
  const setPlanRemote = async (on) => {
    try {
      app.current.setPlan((await app.conn.call('plan', { id: s.id, on })).plan);
      toast(app.current.session.plan ? 'Plan mode: the agent drafts a plan first, without changing files' : 'Plan mode off');
    } catch (e) {
      throw isOldDaemon(e) ? new Error('Update snugcode on the PC for plan mode.') : e;
    }
    return app.current.session.plan;
  };
  const setAuto = (on) => {
    app.current.session.auto = on;
    renderModes();
  };
  // Autonomy presets (new daemons): one tiered choice instead of separate auto-allow + review-edits switches.
  const autonomySheet = () => {
    const cur = app.current.session.autonomy || 'balanced';
    const pick = async (level) => {
      if (level === cur) return ui.closeSheet();
      if (level === 'auto' && !(await ui.confirm({ title: 'Full autonomy?', text: 'The agent may run any shell command without asking (in an OS sandbox when available). git push and creating PRs always ask for permission. All file changes can still be rewound.', ok: 'Turn on', danger: true, icon: 'bolt' }))) return;
      try {
        Object.assign(app.current.session, await app.conn.call('autonomy', { id: s.id, level }));
        renderModes();
        ui.closeSheet();
        toast('Autonomy: ' + AUTONOMY_UI[level][0]);
      } catch (e) {
        toast(e.message, true);
      }
    };
    ui.sheet(
      ui.head('Agent autonomy', { sub: 'How much the agent may do without asking' }),
      h('div', { class: 'group autonomy' },
        ...Object.entries(AUTONOMY_UI).map(([level, [t1, t2, icon]]) =>
          h('button', { class: 'menuitem' + (level === cur ? ' on' : ''), 'aria-pressed': String(level === cur), onclick: () => (haptic(8), pick(level)) },
            h('span', { class: 'mi' }, ic(icon)),
            h('span', { class: 'grow' }, h('div', { class: 't1' }, t1), h('div', { class: 't2' }, t2)),
            level === cur ? ic('check', 'chev') : null,
          ),
        ),
      ),
      h('p', { class: 'muted small', style: 'margin:12px 4px 0' }, 'Pushing to GitHub, creating PRs, and credential files always ask, at every level.'),
    );
  };
  const setAutoRemote = async (on) => {
    if (on && !(await ui.confirm({ title: 'Turn on auto-allow?', text: 'The agent may run any shell command without asking. git push and creating PRs always ask for permission.', ok: 'Turn on', danger: true, icon: 'bolt' }))) return false;
    setAuto((await app.conn.call('auto', { id: s.id, on })).auto);
    if (on) toast('Auto-allow on');
    return app.current.session.auto;
  };
  const setMode = (sh) => {
    shellMode = sh;
    input.classList.toggle('shell', sh || input.value.startsWith('!'));
    input.autocapitalize = sh ? 'off' : 'sentences';
    renderModes();
  };

  // --- image attachments (camera, gallery, or paste from clipboard) ---
  let images = [];
  const renderThumbs = () => {
    thumbs.hidden = !images.length;
    thumbs.replaceChildren(...images.map((im, i) => h('button', { class: 'thumb', style: `--i:${i}`, 'aria-label': 'Remove image', onclick: () => ((images = images.filter((_, j) => j !== i)), renderThumbs(), syncSend()) }, h('img', { src: `data:${im.mime};base64,${im.data}`, alt: '' }), ic('x'))));
  };
  const addImages = async (files) => {
    for (const f of [...files].filter((f) => f.type.startsWith('image/'))) {
      if (images.length >= 4) return toast('Up to 4 images', true);
      try {
        images.push(await compressImage(f));
      } catch {
        toast('Couldn’t read the image', true);
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

  // --- + button: attachments, modes, quick actions in one sheet ---
  const tile = (icon, label, onclick) => h('button', { class: 'tile', onclick: () => (haptic(6), onclick()) }, h('span', { class: 'ti' }, ic(icon)), label);
  plusBtn.onclick = () => {
    haptic(6);
    const ss = app.current.session;
      const isComp = !!ss.computer;
      const qkList = isComp ? QUICK_COMPUTER : QUICK;
      const qkShList = isComp ? QUICK_COMPUTER_SH : QUICK_SH;
      return ui.sheet(
        ui.head('Attachments & tools'),
        h('div', { class: 'tiles' },
          tile('camera', 'Camera', () => (ui.closeSheet(), camIn.click())),
          tile('image', 'Gallery', () => (ui.closeSheet(), fileIn.click())),
          tile('play', 'Run', () => showRun()),
          tile('branch', 'Git', () => showGit()),
          has('files') ? tile('folder', 'Files', () => ((app.current.filesDir = ''), showFiles())) : null,
          has('termOpen') ? tile('term', 'Terminal', () => showTerminal()) : null,
        ),
        h('div', { class: 'label' }, 'Mode'),
        h('div', { class: 'group' },
          toggleItem({ icon: 'list', t1: 'Plan mode', t2: 'the agent reads & drafts a plan first', on: !!ss.plan, onchange: setPlanRemote }),
          toggleItem({ icon: 'term', t1: 'Shell mode', t2: 'messages are sent as commands ($)', on: shellMode, onchange: (v) => (setMode(v), v) }),
          has('autonomy')
            ? menuItem({ icon: 'bolt', t1: 'Agent autonomy', t2: AUTONOMY_UI[ss.autonomy || 'balanced'][0] + ' · ' + AUTONOMY_UI[ss.autonomy || 'balanced'][1], onclick: autonomySheet })
            : toggleItem({ icon: 'bolt', t1: 'Auto-allow', t2: 'no asking, except push & PRs', on: !!ss.auto, danger: true, onchange: setAutoRemote }),
          // Default: worktree edits apply directly (rewindable); turn on to approve each diff.
          'askEdits' in ss && !has('autonomy')
            ? toggleItem({
                icon: 'diff', t1: 'Review every edit', t2: 'Write/Edit wait for your approval', on: !!ss.askEdits,
                onchange: async (on) => {
                  try {
                    Object.assign(app.current.session, await app.conn.call('edits', { id: s.id, on }));
                  } catch (e) {
                    throw isOldDaemon(e) ? new Error('Update snugcode on the PC for this feature') : e;
                  }
                  return app.current.session.askEdits;
                },
              })
            : null,
        ),
        h('div', { class: 'label' }, 'Quick actions'),
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
    if (app.current.running) return toast('Wait for the agent to finish (or Stop) before changing models.', true);
    pickModel({
      title: 'Model for this session',
      current: app.current.session.model,
      onPick: async (id) => {
        let sum;
        try {
          sum = await app.conn.call('setSessionModel', { id: s.id, model: id });
        } catch (e) {
          throw isOldDaemon(e) ? new Error('Update snugcode on the PC to change models mid-session.') : e;
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

  // --- git: change-count badge in the header ---
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

  // --- running status + work indicator ---
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const setRunning = (on) => {
    const was = app.current.running;
    app.current.running = on;
    if (!!was !== on) {
      send.replaceChildren(ic(on ? 'stop' : 'send'));
      anim(send.firstChild, [{ transform: 'scale(.4) rotate(-90deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    }
    send.setAttribute('aria-label', on ? 'Stop' : 'Send');
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
        const txt = r.permQueue.length ? 'Waiting for your permission' : cap(r.activity || 'thinking…');
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
      // Events already received (e.g. via attach after a reconnect) aren't drawn twice.
      if (!app.current.cursor.accept(e)) continue;
      if (e.k === 'status') setRunning(e.s === 'running');
      else if (e.k === 'proc') onProc(e);
      else if (e.k === 'procOut') app.current.procOut?.(e);
      else if (e.k === 'preview') (app.current.preview = e.url ? e : null), app.current.syncRun();
      else if (e.k === 'mode') app.current.setPlan(e.plan);
      else r.add(e);
      if (e.k === 'done') (haptic(e.ok ? 15 : 50), e.ok || toast('The agent stopped: ' + (e.err || 'error'), true));
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
  // Fill the composer from another screen (e.g. "Ask agent" in the file explorer) without sending.
  app.current.compose = (t) => {
    input.value = t + input.value;
    autosize();
    syncSend();
    input.focus();
    input.setSelectionRange(t.length, t.length);
  };
  r.suggest = QUICK;
  r.onQuick = quick;
  if (s.computer) r.nextSteps = [['Continue', 'Continue.'], ['Summarize', 'Summarize what you just did and the result.']];
  send.onclick = submit;
  input.onkeydown = (e) => {
    // Phone: Enter = new line (send with the button). Physical keyboard: Enter sends, Shift+Enter new line.
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
    if (fresh && res.truncated) r.line('meta', '… older history not shown');
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

// Shrink images (longest side 1568px, JPEG) to save tokens and keep 4 images within one relay
// frame (1 MiB; the encrypted payload grows ~4/3 from base64).
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
  throw new Error('too large');
}

// Session menu (tap the title): details, git/run/model, .env, delete.
export function sessionMenu() {
  const s = app.current.session;
  const isComp = !!s.computer;
  ui.sheet(
    ui.head(s.title || (isComp ? 'Computer session' : repoName(s)), { sub: sessionSub(s) }),
    h('div', { class: 'tags', style: 'margin:0 0 14px' },
      isComp ? h('span', { class: 'tag' }, ic('monitor'), 'computer') : null,
      isComp && s.cwd ? h('span', { class: 'tag' }, tildify(s.cwd)) : null,
      !isComp ? h('span', { class: 'tag' }, ic('branch'), s.branch) : null,
      !isComp ? h('span', { class: 'tag' }, 'base ' + s.base) : null,
      h('span', { class: 'tag' }, ic('cpu'), M.modelLabel(s.model)),
      s.local ? h('span', { class: 'tag' }, ic('term'), 'terminal') : null,
    ),
    // A visible safety net: the user knows the agent's work is isolated and can be undone.
    !isComp && !s.local ? h('p', { class: 'muted small safety' }, ic('shield'), `The agent works on a separate ${s.branch} branch; ${s.base} doesn’t change until you merge. Every prompt can be rewound.`) : null,
    h('div', { class: 'group' },
      menuItem({ icon: 'branch', t1: 'Git', t2: 'status, diff, commit, push, PR', onclick: () => showGit() }),
      menuItem({ icon: 'play', t1: 'Run & Preview', t2: 'dev server, logs, preview on your phone', onclick: () => showRun() }),
      has('files') ? menuItem({ icon: 'folder', t1: 'Files', t2: 'browse, view & edit files', onclick: () => ((app.current.filesDir = ''), showFiles()) }) : null,
      has('termOpen') ? menuItem({ icon: 'term', t1: 'Terminal', t2: 'interactive shell in the ' + (isComp ? 'PC' : 'worktree'), onclick: () => showTerminal() }) : null,
      menuItem({ icon: 'cpu', t1: 'Change model / effort', t2: M.modelLabel(s.model), onclick: () => app.current.changeModel?.() }),
      has('budget') ? menuItem({ icon: 'clock', t1: 'Cost & limit', t2: `${usd(s.spent)} this session · ${s.budget ? 'limit ' + usd(s.budget) : 'no limit'}`, onclick: () => budgetSheet(s) }) : null,
      (s.local || isComp) ? null : menuItem({
        icon: 'save', t1: 'Save .env as a template', t2: 'restored automatically in new sessions for this repo',
        onclick: async () => {
          try {
            const f = await app.conn.call('envSave', { id: s.id });
            toast(f.length ? 'Saved: ' + f.join(', ') : 'No .env files in the worktree', !f.length);
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ),
    h('div', { class: 'group' },
      menuItem({ icon: 'home', t1: 'Back to home', chev: false, onclick: () => (ui.closeSheet(), (ui.dir = -1), showSessions()) }),
      menuItem({ icon: 'trash', t1: 'Delete session', t2: isComp ? 'removes the session history on the PC' : 'also removes its worktree on the PC', danger: true, chev: false, onclick: () => deleteSession(s) }),
    ),
  );
}

const usd = (v) => '$' + (+v || 0).toFixed(+v && v < 1 ? 3 : 2);

// Session cost limit: a brake that makes users comfortable handing over big tasks. Checked after every turn
// (cost from the Agent SDK; the Codex/Gemini engines don't report cost).
function budgetSheet(s) {
  const field = h('input', { class: 'field', type: 'number', inputmode: 'decimal', min: '0', step: '0.5', placeholder: 'e.g. 5', value: s.budget ? String(s.budget) : '' });
  const save = async (v) => {
    try {
      Object.assign(app.current.session, await app.conn.call('budget', { id: s.id, usd: +v || 0 }));
      ui.closeSheet();
      toast(+v ? `Session cost limit: ${usd(+v)}` : 'Cost limit off');
    } catch (e) {
      toast(e.message, true);
    }
  };
  ui.sheet(
    ui.head('Cost & limit', { sub: `${usd(s.spent)} spent in this session (estimate)` }),
    h('p', { class: 'muted small', style: 'margin:0 4px 12px' }, 'When the total cost hits the limit, the next prompt is held and you’re notified (with a warning at 80% too). Cost is only available for models running on the Claude Agent SDK.'),
    h('div', { class: 'chips', style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' }, ...[1, 5, 20].map((v) => h('button', { class: 'btn', onclick: () => save(v) }, usd(v)))),
    field,
    h('div', { class: 'btnrow', style: 'margin-top:12px' },
      h('button', { class: 'btn ghost', onclick: () => save(0) }, 'No limit'),
      h('button', { class: 'btn primary', onclick: () => save(field.value) }, 'Save'),
    ),
  );
}

// Saved prompts per repo (this phone): frequent requests are one tap away. Text in the message box
// can be saved from here; long-press to delete.
function savedPrompts(ss, draft, run) {
  const key = 'prompts.' + (ss.computer ? 'computer' : ss.repo);
  const list = /** @type {string[]} */ (store.get(key) || []);
  const save = () => {
    store.set(key, [draft, ...list.filter((x) => x !== draft)].slice(0, 12));
    toast('Saved as a quick prompt');
    ui.closeSheet();
  };
  const items = list.map((t) => {
    const el = menuItem({ icon: 'spark', t1: t.length > 60 ? t.slice(0, 60) + '…' : t, t2: 'saved · long-press to delete', onclick: () => run(t) });
    onLongPress(el, async () => {
      if (!(await ui.confirm({ title: 'Delete saved prompt?', text: t.slice(0, 200), ok: 'Delete', danger: true, icon: 'trash' }))) return;
      store.set(key, (store.get(key) || []).filter((x) => x !== t));
    });
    return el;
  });
  if (draft && !list.includes(draft)) items.push(menuItem({ icon: 'save', t1: 'Save this text as a quick prompt', t2: draft.slice(0, 60), chev: false, onclick: save }));
  return items.length ? h('div', { class: 'group' }, ...items) : null;
}
