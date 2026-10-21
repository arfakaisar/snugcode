// Connection to one PC: PIN pairing, PC settings, remote updates, the PC's GitHub login.
import * as C from '../../shared/crypto.js';
import * as M from '../../shared/models.js';
import { Conn, store } from '../conn.js';
import { app } from './state.js';
import { goMachines } from './auth.js';
import { anim, busyButton, copyText, h, haptic, ic, isOldDaemon, loading, menuItem, renderIf, mascot, toast, ui } from './dom.js';
import { pickModel } from './model-picker.js';
import { enableNotifications, localNotify, syncPush } from './push.js';
import { reattach } from './session.js';
import { sessionSub, showSessions, showSessionsMeta } from './sessions.js';
import { cloudPin, codespacesError, connectButton, connectCodespaces, ghcs, idleSheet, isAuthError, isCodespace, openRunnerOnGithub, removeRunner, stopRunnerNow, wakeRunner } from './cloud.js';
import { connectionsSheet, settingsItems } from './settings.js';
import { progress } from './progress.js';
import { ENGINE_LABEL } from '../../shared/providers.js';

// ---------- Connection to one PC ----------
/** @param {{ id: string, name?: string, kind?: string, provider?: string }} m @param {{ sid?: string }} [opts] */
export function openMachine(m, { sid } = {}) {
  app.conn?.close();
  app.conn = new Conn(m);
  app.current = { m, resumeSid: sid };
  store.set('last', { mid: m.id, sid });
  const msg = h('div', { class: 'muted' });
  const showStatus = (title, text, busy = true, extra = null) =>
    ui.view(h('div', { class: 'hero center' }, busy ? mascot('think xl') : h('div', { class: 'lockicon' }, ic('monitor')), h('h1', { class: 'serif' + (busy ? ' shimmer' : '') }, title), msg, text ? h('p', { class: 'dim small' }, text) : null, extra));
  ui.set(m.name, { sub: 'connecting…', back: goMachines, dot: 'busy' });
  const connecting = progress('connect', [
    { id: 'relay', label: 'Contacting the relay', est: 1 },
    { id: 'auth', label: 'Opening an encrypted channel', est: 2 },
  ]);
  app.current.connecting = connecting;
  // Slow to connect (phone just woke up, network not back yet): show the attempt number and a try-now
  // button instead of an endless spinner. conn.js itself replaces stuck sockets.
  const retry = h('div', { class: 'pretry', hidden: true }, h('p', { class: 'dim small' }, 'The relay hasn’t answered yet. Check your phone’s internet — snugcode keeps trying on its own.'), h('button', { class: 'btn', onclick: () => (haptic(), app.conn.retry()) }, ic('refresh'), 'Try now'));
  connecting.el.append(retry);
  const slowT = setTimeout(() => (retry.hidden = false), 12000);
  app.conn.on('attempt', (n) => !app.current?.ready && n > 1 && connecting.note(`Retrying… (attempt ${n})`));
  showStatus('Connecting', null, true, connecting.el);
  app.conn.on('state', (s) => {
    app.current?.watch?.(s);
    if (s === 'online') (clearTimeout(slowT), (retry.hidden = true), connecting.note(''), connecting.step('auth'), app.current.wakeProg?.step('auth'));
    if (s === 'offline') {
      connecting.stop();
      ui.dot('off');
      ui.sub('offline');
      if (!app.current.ready && isCodespace(m)) return wakeScreen(m, msg, showStatus);
      if (!app.current.ready) {
        msg.textContent = 'The PC is offline.';
        if (m.kind === 'cloud') showStatus('Waiting for the runner', 'Make sure the snugcode container is running on the server (docker ps / docker start snugcode). This page connects automatically once the runner is online.', true);
        else showStatus('Waiting for the PC', 'Make sure snugcode is running on the PC (snugcode autostart on) and the PC isn’t asleep. This page connects automatically once the PC is online.', true);
      } else toast('PC offline — waiting to reconnect…', true);
    } else if (s === 'online' || s === 'reconnecting') {
      ui.dot('busy');
      if (app.current.ready) ui.sub('reconnecting…');
    } else if (s === 'needpin') {
      // A cloud runner created from this phone: its PIN is known, so pairing is automatic (once per connection).
      const pin = cloudPin(m.id);
      if (pin && !app.current.autoPaired) {
        app.current.autoPaired = true;
        msg.textContent = 'Pairing this phone with the runner…';
        connecting.step('auth', 'pairing the phone (first time)');
        app.conn.pair(pin).then((r) => r.ok || showPin(m));
      } else showPin(m);
    }
    else if (s === 'revoked') (toast('This phone’s access to the PC was revoked.', true), showPin(m));
    else if (s === 'removed') (toast('This PC was removed from your account.', true), goMachines());
    else if (s === 'authfail') toast('PC verification failed.', true);
  });
  app.conn.on('ready', (info) => {
    ui.dot('on');
    connecting.done();
    app.current.wakeProg?.done();
    app.current.wakeProg = null;
    app.current.watch?.('ready');
    const first = !app.current.ready;
    app.current.ready = true;
    app.current.info = info;
    clearInterval(app.current.updateTimer);
    app.current.updateTimer = setInterval(() => checkUpdateStatus(true), 90000);
    checkUpdateStatus(false);
    syncPush(false);
    if (document.visibilityState !== 'visible') app.conn.call('visible', { on: false }).catch(() => {});
    if (first) {
      showSessions();
      if (info.runtime === 'cloud') setupCloud(info);
      else if (info.routerConfigured === false) connectionsSheet({ first: true });
    } else if (app.current.session) (reattach(), app.current.onTermReady?.(), ui.sub(sessionSub(app.current.session)));
    else showSessionsMeta();
  });
  app.conn.on('events', (msg) => app.current?.onEvents?.(msg));
  app.conn.on('term', (msg) => app.current?.onTerm?.(msg));
  app.conn.on('github', (msg) => onGithubStatus(msg));
  // ChatGPT sign-in finished (or failed) on the machine; connections & the default model changed.
  app.conn.on('chatgpt', (msg) => app.current?.onChatgpt?.(msg));
  app.conn.on('connections', (msg) => app.current?.info && (app.current.info = { ...app.current.info, connections: msg.list, routerConfigured: msg.list.length > 0 }));
  app.conn.on('info', (msg) => {
    if (!app.current?.info) return;
    app.current.info = { ...app.current.info, ...msg.info };
    showSessionsMeta();
  });
  app.conn.on('update', (st) => onUpdateStatus(st, true));
  app.conn.on('notice', (msg) => {
    if (app.current?.session?.id === msg.sid && document.visibilityState === 'visible') return;
    toast(`${msg.title}: ${msg.msg}`);
    localNotify('snugcode', `${msg.title}: ${msg.msg}`);
  });
  app.conn.connect();
}

// A sleeping Codespaces runner: start it from the phone (needs Codespaces access on this phone).
function wakeScreen(m, msg, showStatus) {
  if (app.current.waking) return;
  app.current.waking = true;
  msg.textContent = '';
  const wp = progress('cloud-wake', [
    { id: 'boot', label: 'Starting the codespace', est: 35 },
    { id: 'start', label: 'Starting snugcode', est: 10 },
    { id: 'auth', label: 'Connecting the phone', est: 3 },
  ]);
  app.current.wakeProg = wp;
  showStatus('Starting the runner', 'This page connects automatically once the runner is ready.', true, wp.el);
  const failed = (e) => {
    if (app.current?.m.id !== m.id || app.current.ready) return;
    app.current.waking = false;
    wp.fail(e.message);
    app.current.wakeProg = null;
    ui.sub('failed to start');
    const hero = $view()?.querySelector('.hero');
    // Codespaces access refused: reconnect, and the runner starts automatically back in the app.
    if (isAuthError(e)) hero?.append(connectButton('Reconnect GitHub Codespaces'));
    else hero?.append(h('button', { class: 'btn', style: 'margin-top:16px', onclick: () => wakeScreen(m, msg, showStatus) }, ic('refresh'), 'Try again'));
  };
  wakeRunner(m, (t, phase) => wp.step(phase, t), failed)
    .then((ok) => {
      if (ok || app.current?.m.id !== m.id || app.current.ready) return;
      wp.stop();
      app.current.wakeProg = null;
      app.current.waking = false;
      showStatus('The runner is asleep', 'The runner stops itself when idle. Connect GitHub Codespaces on this phone to start it.', false);
      $view()?.querySelector('.hero')?.append(connectButton());
    })
    .catch(failed);
}
const $view = () => document.getElementById('view');

// Cloud runner connected: hand it the Codespaces token (so it can stop itself when idle), then ask for
// a model (ChatGPT sign-in / API key) if it has none — a new runner has no terminal for `snugcode setup`.
function setupCloud(info) {
  const t = ghcs();
  if (t && info.runner?.provider === 'codespace' && info.caps?.includes('runnerConfig'))
    app.conn.call('runnerConfig', { token: t.token }).then((runner) => app.current && (app.current.info = { ...app.current.info, runner })).catch(() => {});
  if (!info.routerConfigured) connectionsSheet({ first: true, after: () => (ghBad() ? githubLoginSheet() : ui.closeSheet()) });
}

export function showPin(m) {
  ui.set(m.name, { sub: 'pair this phone', back: goMachines, dot: 'busy' });
  const err = h('div', { class: 'err', role: 'alert' });
  const input = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '12', placeholder: '••••••', 'aria-label': 'PIN', enterkeyhint: 'go' });
  const eye = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Show PIN' }, ic('eye'));
  eye.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.replaceChildren(ic(show ? 'eyeoff' : 'eye'));
    input.focus();
  };
  const wrap = h('div', { class: 'pinwrap' }, input, eye);
  const lock = h('div', { class: 'lockicon' }, ic('lock'));
  const btn = h('button', { class: 'btn primary big', style: 'margin-top:14px' }, 'Pair');
  const shake = () => anim(wrap, [{ transform: 'none' }, { transform: 'translateX(-9px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }], { duration: 420, easing: 'ease-out' });
  const go = async () => {
    const pin = input.value.trim();
    if (!C.PIN_RE.test(pin)) {
      err.textContent = 'PIN must be 6–12 letters/digits.';
      shake();
      return;
    }
    const done = busyButton(btn, 'Verifying…');
    err.textContent = '';
    lock.classList.add('busy');
    const r = await app.conn.pair(pin);
    lock.classList.remove('busy');
    done();
    if (r.ok) return (haptic(20), lock.classList.add('ok'));
    input.value = '';
    shake();
    haptic(60);
    err.textContent =
      r.reason === 'pin' ? `Wrong PIN.${r.left != null ? ` ${r.left} attempt${r.left === 1 ? '' : 's'} left.` : ''}`
      : r.reason === 'locked' ? `Too many wrong PINs. Try again ${r.until ? 'at ' + new Date(r.until).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'later'}, or run \`snugcode pin\` on the PC to unlock it now.`
      : r.reason === 'slow' ? 'Too fast — wait a few seconds.'
      : r.reason === 'nopin' ? 'The PC has no PIN yet. Run `snugcode setup`.'
      : 'Failed: ' + r.reason;
  };
  btn.onclick = go;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') go();
  };
  ui.view(
    h('div', { class: 'scroll' },
      h('div', { class: 'hero center' },
        lock,
        h('h1', { class: 'serif' }, 'Pair this phone'),
        h('div', { class: 'muted' }, `Enter the PIN you created during setup on `, h('b', {}, m.name), '.'),
        h('div', { class: 'dim small', style: 'margin-top:6px' }, 'Just once per phone. The PIN is verified directly by the PC — it’s never sent to the server.'),
        wrap, err, btn,
      ),
    ),
  );
  setTimeout(() => input.focus(), 120);
}

// ---------- Automatic PC updates (from the phone) ----------
// Progress: install (update RPC reply) → daemon restart → reconnected (ready event).
// method: 'update' (latest version) or 'rollback' (the version before the last update).
async function runUpdate(_btn, after, method = 'update') {
  const where = here();
  const p = progress('pc-update', [
    { id: 'install', label: 'Downloading & installing the update', est: 90 },
    { id: 'restart', label: 'Restarting snugcode', est: 8 },
    { id: 'reconnect', label: 'Reconnecting', est: 4 },
  ]);
  const closeBtn = h('button', { class: 'btn', style: 'margin-top:14px', onclick: () => ui.closeSheet() }, 'Close — keeps running');
  ui.sheet(ui.head(method === 'rollback' ? 'Rolling back snugcode' : 'Updating snugcode', { sub: app.current.m.name }), p.el, h('div', { class: 'fine' }, `Sessions running on ${where} are stopped first so files aren’t locked.`), closeBtn);
  const cur = app.current;
  try {
    haptic(20);
    const res = await app.conn.call(method);
    p.step('restart', res.commit ? 'version ' + res.commit : '');
    cur.watch = (ev) => {
      if (ev === 'reconnecting' || ev === 'online' || ev === 'offline') p.step('reconnect');
      if (ev !== 'ready') return;
      cur.watch = null;
      p.done(method === 'rollback' ? 'snugcode is back on the previous version' : 'snugcode updated');
      haptic(25);
      after?.();
      setTimeout(() => closeBtn.isConnected && ui.closeSheet(), 1500);
    };
  } catch (err) {
    p.fail('Failed: ' + err.message);
    toast('Update failed: ' + err.message, true, 6000);
  }
}

export function renderUpdateBanner() {
  const el = document.getElementById('updateBanner');
  if (!el) return;
  if (legacyDaemon())
    return renderIf(el, 'legacy', () => [
      h('button', { class: 'banner up', onclick: () => migrateSheet() },
        h('span', { class: 'bi' }, mascot()),
        h('span', { class: 'grow' }, h('div', { class: 'name' }, 'Move this PC to snugcode'), h('div', { class: 'sub' }, 'The PC still runs the old version (pocketcode). Tap to migrate — pairing & sessions stay.')),
        ic('right', 'chev'),
      ),
    ]);
  const st = app.current?.updateStatus;
  if (!st?.updateAvailable) return renderIf(el, '', () => []);

  const sha = st.latestCommit ? st.latestCommit.slice(0, 7) : 'latest';
  const behind = st.commitsBehind > 1 ? `${st.commitsBehind} commits behind` : 'A new update is available';
  const msg = st.latestMessage ? `"${st.latestMessage}"` : behind;
  const upBtn = h('button', {
    class: 'pillbtn',
    onclick: (e) => {
      e.stopPropagation();
      runUpdate(e.currentTarget, () => {
        app.current.updateStatus = null;
        renderUpdateBanner();
        showSessionsMeta();
      });
    },
  }, 'Update');
  renderIf(el, 'up|' + sha + '|' + msg, () => [
    h('button', { class: 'banner up', onclick: () => updateMachineSheet() },
      h('span', { class: 'bi' }, ic('spark')),
      h('span', { class: 'grow' }, h('div', { class: 'name' }, `Update available for ${here()} · ${sha}`), h('div', { class: 'sub' }, msg)),
      upBtn,
    ),
  ]);
}

export function onUpdateStatus(st, notify = false) {
  if (!app.current) return;
  const was = app.current.updateStatus?.updateAvailable;
  app.current.updateStatus = st;
  renderUpdateBanner();
  showSessionsMeta();
  if (st.updateAvailable && !was && notify) {
    haptic(15);
    toast(`A snugcode update is available (${st.latestCommit})! Tap the banner to update.`, false, 6000);
  }
}

export async function checkUpdateStatus(notify = false) {
  if (!app.conn || !app.current?.ready) return;
  try {
    const st = await app.conn.call('updateStatus');
    onUpdateStatus(st, notify);
  } catch {}
}

// ---------- Migration from pocketcode (the old name) ----------
// Old daemons don't send `brand`. Their remote update can't switch to the new package by itself (it
// installs `snugcode` and then restarts its old code), so migration runs as a command: install snugcode →
// stop & remove pocketcode → start snugcode. The ~/.pocketcode data folder is kept, so phone pairing,
// sessions, and worktrees don't change.
export const legacyDaemon = () => !!app.current?.info && !app.current.info.brand;
const PKG = 'github:arfakaisar/snugcode';
export function migrateCommands(platform) {
  if (platform === 'win32')
    return {
      manual: `npm i -g ${PKG} --include=optional; if ($?) { pocketcode stop; npm rm -g pocketcode; snugcode autostart on }`,
      // Via a session: a separate process (survives stopping the old daemon); a failed install changes nothing.
      viaSession: `Start-Process cmd -WindowStyle Hidden -ArgumentList '/c npm i -g ${PKG} --include=optional > "%USERPROFILE%\\.pocketcode\\migrate.log" 2>&1 && (pocketcode stop & ping -n 4 127.0.0.1 >nul & npm rm -g pocketcode & snugcode autostart on)'`,
    };
  const steps = `npm i -g ${PKG} --include=optional && { pocketcode stop; npm rm -g pocketcode; snugcode autostart on; }`;
  return {
    manual: steps,
    viaSession: `node -e "require('child_process').spawn('sh',['-c',process.argv[1]],{detached:true,stdio:'ignore'}).unref()" '{ ${steps}; } > ~/.pocketcode/migrate.log 2>&1'`,
  };
}

export function migrateSheet() {
  const cmds = migrateCommands(app.current?.info?.platform);
  const copy = async (e) => (await copyText(cmds.manual)) && (e.currentTarget.classList.add('done'), toast('Command copied'));
  ui.sheet(
    ui.head('Migrate to snugcode', { sub: app.current.m.name }),
    h('div', { class: 'empty', style: 'padding:6px 0 10px' },
      h('div', { class: 'emptyart up' }, mascot('draw xl tap')),
      h('b', {}, 'This PC still uses pocketcode'),
      'Install snugcode, then stop & remove the old version. Phone pairing, sessions, and worktrees stay — the ~/.pocketcode data folder keeps being used.',
    ),
    h('div', { class: 'label' }, 'Run in a terminal on the PC'),
    h('div', { class: 'copyline' }, h('code', {}, cmds.manual), h('button', { class: 'copybtn', onclick: copy }, ic('copy'), 'copy')),
    h('div', { class: 'label' }, 'Or from your phone'),
    h('button', {
      class: 'btn primary',
      onclick: async (ev) => {
        if (!(await ui.confirm({ title: 'Migrate now?', text: 'The command runs on the PC through an idle session. The daemon is down ~1 minute while installing, then reconnects as snugcode.', ok: 'Migrate', icon: 'push' }))) return;
        try {
          // Old daemons can't create a session without a repo, so an existing one is used.
          const target = (await app.conn.call('sessions')).find((x) => x.status !== 'running');
          if (!target) throw new Error('no idle session. Create a session first, or run the command above in a terminal on the PC.');
          await app.conn.call('send', { id: target.id, text: '!' + cmds.viaSession });
          toast('Migration is running on the PC. Wait for it to reconnect…', false, 8000);
        } catch (err) {
          toast('Failed: ' + err.message, true);
        }
      },
    }, ic('push'), 'Migrate automatically (via a session)'),
    h('div', { class: 'fine' }, 'Migration log: ~/.pocketcode/migrate.log on the PC.'),
  );
}

// ---------- The PC's GitHub login (from the phone) ----------
// The GitHub token on the PC can be revoked. The daemon starts a device flow and its code
// shows up here, so you can sign in again from anywhere.
// "this PC" / "this runner" depending on the open machine.
const here = () => (app.current?.info?.runtime === 'cloud' ? 'this runner' : 'this PC');
export const ghBad = () => ['invalid', 'missing'].includes(app.current?.info?.githubState);

export function renderGhBanner() {
  const el = document.getElementById('ghBanner');
  if (!el) return;
  if (!ghBad()) return renderIf(el, '', () => []);
  renderIf(el, 'gh|' + app.current.info.githubState, () => [
    h('button', { class: 'banner warn', onclick: () => githubLoginSheet() },
      h('span', { class: 'bi' }, ic('github')),
      h('span', { class: 'grow' },
        h('div', { class: 'name' }, app.current.info.githubState === 'missing' ? 'GitHub isn’t signed in on ' + here() : 'The GitHub login on ' + here() + ' is no longer valid'),
        h('div', { class: 'sub' }, 'Push, PRs, and the repo list are unavailable. Tap to sign in again from your phone.'),
      ),
      ic('right', 'chev'),
    ),
  ]);
}

export function onGithubStatus(st) {
  if (!app.current?.info) return;
  const was = app.current.info.githubState;
  app.current.info.githubState = st.state;
  if (st.login) app.current.info.github = st.login;
  renderGhBanner();
  showSessionsMeta();
  app.current.ghSheet?.(st);
  if (st.state === 'invalid' && was !== 'invalid' && !app.current.ghSheet) toast('The GitHub login on the PC is no longer valid — tap the banner to sign in again', true, 5000);
}

const doneState = (title, text) => h('div', { class: 'empty' }, h('div', { class: 'emptyart ok' }, ic('check')), h('b', {}, title), text);

export async function githubLoginSheet() {
  const body = h('div', {}, loading('Requesting a login code from GitHub…'));
  ui.sheet(ui.head('GitHub sign-in', { sub: 'for ' + app.current.m.name }), body);
  let timer;
  const close = () => {
    clearInterval(timer);
    app.current.ghSheet = null;
  };
  const render = (st) => {
    clearInterval(timer);
    if (st.state === 'ok' && !st.pending) {
      haptic(25);
      body.replaceChildren(
        doneState('GitHub connected', `@${st.login} — push, PRs, and the repo list work again.`),
        h('button', { class: 'btn primary', onclick: () => (close(), ui.closeSheet()) }, 'Done'),
      );
      return;
    }
    const p = st.pending;
    if (!p) return;
    const left = h('span', {});
    const tick = () => {
      const s = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      left.textContent = s ? `code valid for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'code expired';
    };
    tick();
    timer = setInterval(tick, 1000);
    const copyBtn = h('button', { class: 'copybtn', onclick: async (e) => (await copyText(p.code)) && (e.currentTarget.classList.add('done'), toast('Code copied')) }, ic('copy'), 'copy');
    body.replaceChildren(
      h('div', { class: 'muted small' }, 'Enter this code on the GitHub page, then tap Authorize:'),
      h('div', { class: 'ghcode' }, h('span', {}, p.code), copyBtn),
      p.error ? h('div', { class: 'err' }, p.error) : h('div', { class: 'loading', style: 'justify-content:center' }, mascot('think'), h('span', {}, 'waiting for authorization · ', left)),
      h('a', { class: 'btn primary', href: p.uri, target: '_blank', rel: 'noopener', onclick: () => copyText(p.code) }, ic('github'), 'Copy code & open GitHub'),
      h('div', { class: 'dim small', style: 'margin-top:12px;text-align:center' }, p.uri.replace(/^https:\/\//, '')),
      p.error ? h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => githubLoginSheet() }, ic('refresh'), 'Request a new code') : null,
    );
  };
  app.current.ghSheet = render;
  try {
    render(await app.conn.call('githubLogin'));
  } catch (e) {
    close();
    body.replaceChildren(h('div', { class: 'err' }, isOldDaemon(e) ? 'Update snugcode on the PC to sign in to GitHub from your phone (run `snugcode login` on the PC).' : e.message));
  }
}

export function modelItem(t1, id, onclick) {
  const engine = app.current?.info?.model === id ? app.current.info.engine : null;
  return menuItem({ icon: 'cpu', t1, t2: (M.modelLabel(id, { provider: true }) || '(not selected)') + (engine ? ' · ' + (ENGINE_LABEL[engine] || engine) : ''), onclick });
}

export function showMachineMenu() {
  const info = app.current.info;
  const m = app.current.m;
  const cloud = info.runtime === 'cloud';
  const settings = settingsItems(showMachineMenu);
  const idle = info.runner?.idleStopMinutes;
  const pick = (title, field) =>
    pickModel({
      title,
      current: info[field] || info.model,
      onBack: showMachineMenu,
      onPick: async (id) => {
        app.current.info = await app.conn.call('setModel', { [field]: id });
        toast(title + ': ' + M.modelLabel(id));
        showMachineMenu();
        showSessionsMeta();
      },
    });
  ui.sheet(
    ui.head(cloud ? 'Runner settings' : 'PC settings', { sub: app.current.m.name }),
    h('div', { class: 'pchero' },
      h('span', { class: 'avatar' }, ic(cloud ? 'cloud' : 'monitor'), h('i', { class: 'live' })),
      h('div', { class: 'grow' }, h('b', {}, app.current.m.name), h('div', { class: 'dim small' }, [cloud ? (info.runner?.provider === 'codespace' ? 'Cloud · Codespaces' : 'Cloud · container') : { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[info.platform] || info.platform, info.commit ? 'v' + info.commit : null, info.github && !ghBad() ? '@' + info.github : 'GitHub not signed in'].filter(Boolean).join(' · '))),
    ),
    h('div', { class: 'label' }, 'Model'),
    h('div', { class: 'group' },
      modelItem('Default for new sessions', info.model, () => pick('Default model', 'model')),
      // The light subagent model is picked automatically by the daemon (Claude Haiku 5.5 / Gemini 3.8 Flash).
      info.lightModel
        ? menuItem({ icon: 'bolt', t1: 'Light model (subagents) · auto', t2: M.modelLabel(info.lightModel) + (info.engine === 'codex' ? ' · managed by Codex' : info.engine === 'gemini' ? ' · managed by Gemini CLI' : ''), chev: false, onclick: () => toast('Picked automatically from the same connection: Haiku for Claude, Flash for Gemini/DeepSeek. GPT models use Codex subagents.') })
        : modelItem('Small model (light tasks)', info.smallModel || info.model, () => pick('Small model', 'smallModel')),
    ),
    h('div', { class: 'label' }, 'GitHub'),
    h('div', { class: 'group' },
      menuItem({ icon: 'github', t1: ghBad() ? 'Sign in to GitHub (required)' : 'Sign in to GitHub again', t2: info.github && !ghBad() ? '@' + info.github + ' · connected' : 'push, PRs, and the repo list', onclick: () => githubLoginSheet() }),
    ),
    settings.length ? h('div', { class: 'label' }, 'Models & access') : null,
    settings.length ? h('div', { class: 'group' }, ...settings) : null,
    cloud ? h('div', { class: 'label' }, 'Cloud runner') : null,
    cloud
      ? h('div', { class: 'group' },
          menuItem({ icon: 'clock', t1: 'Auto-stop', t2: idle ? `after ${idle} idle minutes${info.runner?.autoStop ? '' : ' · not active yet'}` : 'off — the runner stays on', onclick: () => idleSheet(showMachineMenu) }),
          isCodespace(m) && info.runner?.usage ? usageItem(info.runner.usage) : null,
          isCodespace(m) ? menuItem({ icon: 'stop', t1: 'Stop the runner now', t2: 'it starts again when you open it', onclick: () => runnerAction('stop') }) : null,
          isCodespace(m) ? menuItem({ icon: 'github', t1: 'Open the codespace on GitHub', t2: 'runner log: /workspaces/.snugcode/cloud.log', onclick: () => runnerAction('github') }) : null,
          isCodespace(m) ? menuItem({ icon: 'key', t1: ghcs() ? 'Reconnect GitHub Codespaces' : 'Connect GitHub Codespaces (required)', t2: ghcs() ? `@${ghcs().login || '?'} · to start & stop the runner` : 'this phone can’t start the runner yet', onclick: () => connectCodespaces('wake') }) : null,
          isCodespace(m) ? menuItem({ icon: 'trash', t1: 'Delete runner', t2: 'the codespace with its sessions & worktrees', danger: true, chev: false, onclick: () => runnerAction('remove') }) : null,
        )
      : null,
    h('div', { class: 'label' }, 'System & updates'),
    h('div', { class: 'group' },
      menuItem({
        icon: 'spark',
        t1: 'Update snugcode on the PC',
        t2: info.commit ? `Version: ${info.commit}${info.version ? ' (' + info.version + ')' : ''}` : 'Check for & install remote updates',
        onclick: () => updateMachineSheet(),
      }),
      menuItem({
        icon: 'trash',
        t1: 'Clean up unused folders',
        t2: 'Remove orphaned worktrees & repos on the PC',
        onclick: async () => {
          try {
            toast('Scanning folders…');
            const r = await app.conn.call('cleanup');
            const wtCount = r.removedWorktrees?.length || 0;
            const repoCount = r.removedRepos?.length || 0;
            toast(wtCount || repoCount ? `Cleaned up: ${wtCount} worktree${wtCount === 1 ? '' : 's'}, ${repoCount} repo${repoCount === 1 ? '' : 's'}` : 'The PC workspace is already clean.');
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
      menuItem({
        icon: 'refresh',
        t1: 'Restart the PC daemon',
        t2: info.preventSleep ? 'Prevent PC sleep: on' : 'Restart the daemon connection',
        onclick: async () => {
          if (!(await ui.confirm({ title: 'Restart the daemon?', text: 'The snugcode daemon on the PC restarts. Sessions reconnect automatically after a few seconds.', ok: 'Restart', icon: 'refresh' }))) return;
          try {
            const r = await app.conn.call('restart');
            toast(r.message || 'Daemon restarting…');
          } catch (e) {
            toast(e.message, true);
          }
        },
      }),
    ),
    h('div', { class: 'label' }, 'Device'),
    h('div', { class: 'group' },
      menuItem({ icon: 'bell', t1: 'Allow notifications', t2: 'Updates when the agent finishes / needs permission', onclick: enableNotifications }),
      menuItem({ icon: 'monitor', t1: 'Switch PC', t2: 'back to the computer list', onclick: () => (ui.closeSheet(), goMachines()) }),
      menuItem({ icon: 'unlink', t1: 'Forget this phone’s pairing', t2: 'You’ll need the PIN again to connect', danger: true, chev: false, onclick: () => (store.set('dev.' + app.current.m.id, null), ui.closeSheet(), openMachine(app.current.m)) }),
    ),
  );
}

// Estimated Codespaces quota use this month (tracked by the runner itself; GitHub billing can't be read).
function usageItem(u) {
  const pct = u.free ? Math.min(100, Math.round((u.coreHours / u.free) * 100)) : 0;
  return menuItem({
    icon: 'bolt',
    t1: `~${u.coreHours} core-hours this month`,
    t2: `${u.hours} h × ${u.cores} cores · ${pct}% of ${u.free} free (GitHub Free)`,
    chev: false,
    onclick: () => toast('Estimated from how long the runner ran this month (UTC). Codespace start-up time and other codespaces on your account aren’t counted; exact numbers are at github.com/settings/billing.', false, 6000),
  });
}

async function runnerAction(kind) {
  const m = app.current.m;
  try {
    if (kind === 'github') return await openRunnerOnGithub(m);
    if (kind === 'stop') {
      if (!(await ui.confirm({ title: 'Stop the runner?', text: 'Running agents, dev servers, and previews stop too. Sessions & files are kept.', ok: 'Stop', icon: 'stop' }))) return;
      await stopRunnerNow(m);
      toast('Runner stopped');
      return goMachines();
    }
    if (!(await ui.confirm({ title: 'Delete the runner?', text: 'The codespace is deleted for good, along with all sessions, worktrees, and unpushed commits.', ok: 'Delete runner', danger: true, icon: 'trash' }))) return;
    await removeRunner(m);
    goMachines();
  } catch (e) {
    if (!(await codespacesError(e))) toast(e.message, true);
  }
}

export async function updateMachineSheet() {
  const body = h('div', {}, loading('Checking for updates on the PC…'));
  ui.sheet(ui.head('PC update', { sub: app.current.m.name }), body);
  try {
    const st = await app.conn.call('updateStatus');
    const hasUpdate = st.updateAvailable;
    const btn = h('button', { class: 'btn primary', style: 'margin-top:14px', onclick: (e) => runUpdate(e.currentTarget, () => ui.closeSheet()) }, hasUpdate ? 'Update now' : 'Force reinstall');
    body.replaceChildren(
      h('div', { class: 'empty', style: 'padding:16px 0' },
        h('div', { class: 'emptyart' + (hasUpdate ? ' up' : ' ok') }, ic(hasUpdate ? 'push' : 'check')),
        h('b', {}, hasUpdate ? 'Update available' : 'snugcode is up to date'),
        hasUpdate && st.latestMessage ? h('div', { class: 'quote' }, st.latestMessage) : null,
        h('div', { class: 'tags', style: 'justify-content:center;margin-top:12px' },
          st.currentCommit ? h('span', { class: 'tag' }, 'current ' + st.currentCommit) : null,
          st.latestCommit ? h('span', { class: 'tag' + (hasUpdate ? ' on' : '') }, 'latest ' + st.latestCommit) : null,
        ),
      ),
      btn,
      // New version misbehaving: go back to the version before the last update (supported daemons only).
      st.canRollback && app.current.info?.caps?.includes('rollback')
        ? h('button', { class: 'btn', style: 'margin-top:8px', onclick: async (e) => (await ui.confirm({ title: 'Go back to the previous version?', text: 'snugcode on the PC is reinstalled at the version before the last update, then the daemon restarts.', ok: 'Roll back', icon: 'refresh' })) && runUpdate(e.currentTarget, () => ui.closeSheet(), 'rollback') }, 'Go back to the previous version')
        : null,
    );
  } catch (e) {
    if (isOldDaemon(e)) return migrateSheet();
    body.replaceChildren(
      h('div', { class: 'err' }, 'Couldn’t check for updates: ' + e.message),
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => updateMachineSheet() }, 'Try again'),
    );
  }
}
