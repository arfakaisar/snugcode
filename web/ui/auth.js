// Relay API, GitHub login screen, and machine list.
import { token, store } from '../conn.js';
import { app } from './state.js';
import { $, ago, coarse, copyText, greeting, h, haptic, ic, menuItem, onLongPress, pullToRefresh, scrollCol, skeletons, mascot, toast, ui } from './dom.js';
import { openMachine } from './machine.js';
import { accountMenu } from './push.js';
import { cloudSetupSheet, codespacesError, ghcs, isCodespace, removeRunner } from './cloud.js';

// ---------- API relay ----------
export async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { authorization: 'Bearer ' + token(), ...(opts.headers || {}) } });
  if (r.status === 401) {
    store.set('token', null);
    showLogin();
    throw new Error('Your session has expired');
  }
  return r.json();
}

// Active logins are renewed (at most once a day): a phone in regular use is never forced to sign in
// again when the 30-day token expires. Old relays without /api/renew: silently skipped.
export async function renewToken() {
  if (!token() || Date.now() - (store.get('renewedAt') || 0) < 24 * 3600 * 1000) return;
  try {
    const r = await fetch('/api/renew', { method: 'POST', headers: { authorization: 'Bearer ' + token() } });
    const t = r.ok && (await r.json()).token;
    if (t) store.set('token', t);
    store.set('renewedAt', Date.now());
  } catch {}
}

// ---------- Screen: login ----------
export function showLogin() {
  ui.set('snugcode', { dot: 'none' });
  $('#bar').hidden = true;
  const feats = [
    ['shield', 'End-to-end encrypted', 'the relay only forwards encrypted messages'],
    ['cloud', 'No PC needed', 'a cloud runner on your own GitHub Codespaces'],
    ['branch', 'Safe for your repos', 'one worktree & branch per session'],
  ];
  ui.view(
    h('div', { class: 'scroll' },
      h('div', { class: 'hero login' },
        h('div', { class: 'brand' }, mascot('draw xl tap'), h('span', { class: 'wordmark' }, 'snugcode')),
        h('h1', { class: 'serif display' }, 'Code from your pocket,', h('br'), h('span', { class: 'accent-text' }, 'powered by your PC or the cloud.')),
        h('p', { class: 'lead' }, 'A coding agent (Claude, GPT, Gemini, or any model you like) runs on your computer or in the cloud — explore repos, edit, commit, and push straight from your phone.'),
        h('div', { class: 'feats' }, ...feats.map(([icon, t1, t2], i) => h('div', { class: 'feat', style: `--i:${i}` }, h('span', { class: 'fi' }, ic(icon)), h('span', {}, h('b', {}, t1), h('span', {}, t2))))),
        h('a', { class: 'btn primary big', href: '/auth/login?kind=user', onclick: () => haptic() }, ic('github'), 'Sign in with GitHub'),
        h('div', { class: 'fine' }, 'Have a PC? Use the same GitHub account you used for setup on it. No PC? Pick a cloud runner after signing in.'),
        // New tab: in the installed app, `/` redirects back to /agent/ (landing/boot.js).
        h('a', { class: 'fine link', href: '/', target: '_blank', rel: 'noopener' }, 'About snugcode & cloud servers →'),
      ),
    ),
  );
}

// ---------- Per-machine options: open / remove from account ----------
// Works even when the machine is offline or the runner is stuck (no connection to it needed).
export function machineActions(m) {
  const cloud = m.kind === 'cloud';
  const what = cloud ? 'runner' : 'PC';
  const remove = async () => {
    const text = cloud
      ? isCodespace(m)
        ? ghcs()
          ? 'The runner codespace is deleted for good, along with all sessions, worktrees, and unpushed commits.'
          : 'The runner is removed from your account. This phone isn’t connected to Codespaces, so delete the codespace yourself at github.com/codespaces.'
        : 'The runner is removed from your account and disconnected right away. Also stop its container on the server (docker rm -f snugcode).'
      : 'This PC is removed from your account and disconnected right away. Files & repos on the PC are untouched. To link it again, run `snugcode setup` on the PC.';
    if (!(await ui.confirm({ title: `Remove ${m.name}?`, text, ok: `Remove ${what}`, danger: true, icon: 'trash', stay: true }))) return;
    ui.sheet(ui.head('Removing…', { sub: m.name, close: false }), h('div', { class: 'loading' }, h('span', { class: 'shimmer' }, cloud ? 'Removing runner…' : 'Removing PC from your account…')));
    try {
      if (cloud) await removeRunner(m);
      else {
        const r = await api('/api/machines/' + m.id, { method: 'DELETE' });
        if (r?.error) throw new Error(r.error);
        store.set('dev.' + m.id, null);
        toast('PC removed from your account');
      }
      if (store.get('last')?.mid === m.id) store.set('last', null);
      ui.closeSheet();
      showMachines();
    } catch (e) {
      ui.closeSheet();
      if (!(await codespacesError(e, 'create'))) toast('Couldn’t remove: ' + e.message, true, 6000);
    }
  };
  ui.sheet(
    ui.head(m.name, { sub: (cloud ? (isCodespace(m) ? 'Codespaces runner' : 'Server runner') : 'PC') + (m.online ? ' · online' : ' · offline') }),
    h('div', { class: 'group' },
      menuItem({ icon: cloud ? 'cloud' : 'monitor', t1: 'Open', t2: m.online ? 'sessions & settings' : cloud ? 'start & open' : 'waiting for it to come online', onclick: () => (ui.closeSheet(), openMachine(m)) }),
      menuItem({ icon: 'trash', t1: `Remove ${what}`, t2: cloud ? (isCodespace(m) ? 'the codespace & its account entry' : 'from your snugcode account') : 'from your snugcode account', danger: true, chev: false, onclick: remove }),
    ),
  );
}

// ---------- Screen: machine list ----------
// The last position (PC + session) is saved so that when the PWA reopens — e.g. after iOS
// killed it in the background — the user lands right back in the same session.
export const goMachines = () => {
  clearInterval(app.current?.updateTimer);
  store.set('last', null);
  ui.dir = -1;
  showMachines();
};

const avatarBtn = () => {
  const login = app.me?.login;
  return h('button', { class: 'iconbtn me', 'aria-label': 'Account', title: 'Account', onclick: accountMenu }, login ? h('span', { class: 'meav' }, login[0].toUpperCase()) : ic('gear'));
};

export async function showMachines({ resume = false } = {}) {
  app.conn?.close();
  app.conn = null;
  app.current = null;
  $('#bar').hidden = false;
  const setHeader = () =>
    ui.set('My machines', { actions: [...(coarse ? [] : [{ icon: 'refresh', label: 'Reload', onclick: () => showMachines() }]), avatarBtn()] });
  setHeader();
  const hello = h('div', { class: 'greet' }, mascot('draw tap'), h('h1', { class: 'serif' }, greeting() + (app.me?.login ? ', ' + app.me.login : '')));
  const list = h('div', {}, skeletons(2));
  const sc = scrollCol(hello, h('p', { class: 'muted greet-sub' }, 'Pick a machine to get started.'), list);
  ui.view(sc);
  pullToRefresh(sc, () => showMachines());
  if (!app.me)
    api('/api/me').then((r) => {
      app.me = r;
      if (!r.login || app.current) return;
      setHeader();
      hello.lastChild.textContent = greeting() + ', ' + r.login;
    }).catch(() => {});
  let machines;
  try {
    ({ machines } = await api('/api/machines'));
  } catch (e) {
    return list.replaceChildren(h('div', { class: 'err' }, e.message));
  }
  const howto = installHowto(machines.length);
  const cloudBtn = (label) => h('button', { class: 'btn primary', style: 'margin-top:12px', onclick: () => (haptic(), cloudSetupSheet()) }, ic('cloud'), label);
  // Back from the Codespaces grant: continue the runner wizard.
  const next = store.get('cloudNext');
  if (next) store.set('cloudNext', null);
  if (next === 'create') setTimeout(cloudSetupSheet, 300);
  if (!machines.length)
    return list.replaceChildren(
      h('div', { class: 'empty' },
        h('div', { class: 'emptyart' }, ic('cloud')),
        h('b', {}, 'No machines yet'),
        'No PC? The agent runs on your own GitHub Codespaces, free within GitHub’s monthly quota.',
        cloudBtn('Use the cloud — no PC'),
      ),
      h('details', { class: 'addpc' }, h('summary', {}, ic('monitor'), 'Use my own PC'), h('div', { class: 'muted small' }, 'On your computer (needs Node.js 22+ and git — the installer checks), run this in a terminal:'), howto),
    );
  const last = resume ? store.get('last') : null;
  const lastM = last && machines.find((m) => m.id === last.mid);
  if (lastM) return openMachine(lastM, { sid: last.sid });
  const online = machines.filter((m) => m.online).length;
  list.replaceChildren(
    h('div', { class: 'label' }, 'Machines', h('span', { class: 'count' }, machines.length), online ? h('span', { class: 'tag on' }, online + ' online') : null),
    h('div', { class: 'list' },
      ...machines.map((m, i) => {
        const card = h('button', { class: 'card pc' + (m.online ? ' online' : ''), style: `--i:${i}`, onclick: () => (haptic(), openMachine(m)) },
          h('span', { class: 'avatar' + (m.online ? '' : ' off') }, ic(m.kind === 'cloud' ? 'cloud' : 'monitor'), h('i', { class: 'live' })),
          h('span', { class: 'grow' }, h('div', { class: 'name' }, m.name), h('div', { class: 'sub' }, m.online ? (m.kind === 'cloud' ? 'online · cloud runner' : 'online · ready') : m.kind === 'cloud' ? 'asleep · tap to start' : 'offline · last seen ' + (ago(m.lastSeen) || '-') + (m.lastSeen && ago(m.lastSeen) !== 'just now' ? ' ago' : ''))),
        );
        onLongPress(card, () => machineActions(m));
        return h('div', { class: 'cardrow', style: `--i:${i}` }, card, h('button', { class: 'iconbtn more', 'aria-label': 'Options for ' + m.name, title: 'Options', onclick: () => (haptic(6), machineActions(m)) }, ic('dots')));
      }),
    ),
    h('details', { class: 'addpc' },
      h('summary', {}, ic('plus'), 'Add another PC'),
      h('div', { class: 'muted small' }, 'On the other computer (needs Node.js 22+ and git), run this in a terminal:'),
      howto,
      machines.some(isCodespace) ? null : h('div', { class: 'muted small', style: 'margin-top:14px' }, 'Or without a PC:'),
      machines.some(isCodespace) ? null : cloudBtn('Create a cloud runner'),
    ),
  );
}

// ---------- Add a PC: installer command + wait for the new PC ----------
// The one-line installer (web/install.sh / install.ps1) checks Node & git, then runs setup. Once the
// command is copied, this screen watches the machine list and opens the new PC as soon as it's linked —
// no need to come back and guess whether setup on the PC has finished.
function installHowto(known) {
  const win = /Windows/.test(navigator.userAgent);
  const cmds = {
    unix: `curl -fsSL ${location.origin}/install.sh | sh`,
    win: `irm ${location.origin}/install.ps1 | iex`,
  };
  let os = win ? 'win' : 'unix';
  const code = h('code', {}, cmds[os]);
  const wait = h('div', { class: 'muted small waitpc', hidden: true }, mascot('think'), h('span', { class: 'shimmer' }, 'Waiting for the new PC to link… this screen opens it automatically.'));
  const seg = h('div', { class: 'seg small' },
    ...[['unix', 'macOS / Linux'], ['win', 'Windows']].map(([k, label]) =>
      h('button', { class: os === k ? 'on' : '', onclick: (e) => ((os = k), code.replaceChildren(cmds[k]), seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget))) }, label),
    ),
  );
  const copy = h('button', { class: 'copybtn', onclick: async (e) => {
    if (!(await copyText(cmds[os]))) return;
    e.currentTarget.classList.add('done');
    toast('Command copied — paste it into a terminal on the PC');
    watchNewMachine(known, wait);
  } }, ic('copy'), 'copy');
  return h('div', {}, seg, h('div', { class: 'copyline' }, code, copy), wait);
}

let watching = null;
function watchNewMachine(known, el) {
  el.hidden = false;
  if (watching) return;
  const until = Date.now() + 15 * 60 * 1000;
  const tick = async () => {
    if (!el.isConnected || Date.now() > until) return (watching = null);
    if (document.visibilityState === 'visible') {
      const r = await api('/api/machines').catch(() => null);
      const fresh = r?.machines?.length > known && r.machines.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
      if (fresh) {
        watching = null;
        haptic([10, 40, 10]);
        toast(`${fresh.name} linked ✓`);
        return openMachine(fresh);
      }
    }
    watching = setTimeout(tick, 4000);
  };
  watching = setTimeout(tick, 4000);
}
