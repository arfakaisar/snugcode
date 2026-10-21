// Cloud runner (no PC) from the phone: connect GitHub Codespaces, create a runner, start/stop, delete.
// The runner shows up in the list as a regular "PC"; protocol, encryption, and session screens are unchanged.
import { store } from '../conn.js';
import { Codespaces, SECRET_NAMES, randomPin, stateText } from '../codespaces.js';
import { app } from './state.js';
import { api } from './auth.js';
import { busyButton, copyText, h, haptic, ic, loading, mascot, toast, ui } from './dom.js';
import { progress } from './progress.js';

/** @returns {{ token: string, login: string } | null} */
export const ghcs = () => store.get('ghcs');
export const cloudPin = (mid) => store.get('cloudpin.' + mid);
export const isCodespace = (m) => m?.kind === 'cloud' && m.provider === 'codespace';
// A token GitHub rejects (401) is dropped right away, so the next screen offers "Reconnect".
const client = () => (ghcs() ? new Codespaces(ghcs().token, { onAuthError: () => store.set('ghcs', null) }) : null);
export const isAuthError = (e) => e?.status === 401;

let health = null;
async function runnerRepo() {
  health ??= await fetch('/api/health').then((r) => r.json()).catch(() => ({}));
  return health.runnerRepo || 'arfakaisar/snugcode';
}

// GitHub Codespaces access (`codespace` scope) via the relay; the token comes back in the URL fragment (#gh=…).
// `next`: what to continue after returning ('create' = open the runner wizard).
export function connectCodespaces(next = 'create') {
  store.set('cloudNext', next);
  location.href = '/auth/login?kind=gh';
}

// Failure due to invalid Codespaces access: offer to reconnect (then return to `next`).
// @returns true if handled.
export async function codespacesError(e, next = 'wake') {
  if (!isAuthError(e)) return false;
  if (await ui.confirm({ title: 'Reconnect GitHub Codespaces', text: 'This phone’s GitHub Codespaces access is no longer valid (revoked or expired). Reconnect to continue — the runner & its contents stay as they are.', ok: 'Reconnect', icon: 'github' })) connectCodespaces(next);
  return true;
}

// Called at boot (app.js) with the URL fragment.
export function acceptGhToken(hash) {
  const m = hash.match(/[#&]gh=([^&]+)/);
  if (!m) return false;
  const login = decodeURIComponent(hash.match(/[#&]ghlogin=([^&]+)/)?.[1] || '');
  store.set('ghcs', { token: decodeURIComponent(m[1]), login });
  return true;
}

// The Codespaces token must belong to the same account as the snugcode login.
async function checkAccount(cs) {
  const u = await cs.user();
  const me = app.me?.login || (await api('/api/me').catch(() => ({}))).login;
  if (me && u.login.toLowerCase() !== me.toLowerCase()) {
    store.set('ghcs', null);
    throw new Error(`Codespaces access was granted for @${u.login}, but you’re signed in as @${me}. Reconnect with the same account.`);
  }
  return u;
}

async function cloudMachines() {
  const { machines } = await api('/api/machines');
  return machines.filter(isCodespace);
}

// ---------- Wizard: create a runner ----------
export async function cloudSetupSheet() {
  store.set('cloudNext', null);
  const body = h('div', {}, loading('Checking…'));
  ui.sheet(ui.head('Cloud runner', { sub: 'snugcode without a PC' }), body);
  const intro = h('div', { class: 'empty', style: 'padding:6px 0 10px' },
    h('div', { class: 'emptyart up' }, ic('cloud')),
    h('b', {}, 'The agent runs on GitHub Codespaces'),
    'A private Linux machine on your GitHub account: git, Node, Python, and Chromium for previews. Your phone is just the remote, and the agent keeps working while it’s locked.',
  );
  const fine = h('div', {},
    h('div', { class: 'fine' }, 'Free 120 core-hours/month on GitHub Free (~60 hours of a 2-core runner). The runner stops itself after 30 idle minutes.'),
    dockerOption(),
  );
  const cs = client();
  if (!cs)
    return body.replaceChildren(intro,
      h('button', { class: 'btn primary big', onclick: () => (haptic(), connectCodespaces('create')) }, ic('github'), 'Connect GitHub Codespaces'),
      h('div', { class: 'dim small', style: 'margin-top:10px;text-align:center' }, 'The `codespace` grant is stored only on this phone, not on snugcode’s servers.'),
      fine,
    );
  try {
    const user = await checkAccount(cs);
    const upstream = await runnerRepo();
    const existing = await cloudMachines();
    if (existing.length) {
      const m = existing[0];
      return body.replaceChildren(intro,
        h('button', { class: 'btn primary big', onclick: async () => (ui.closeSheet(), (await import('./machine.js')).openMachine(m)) }, ic('cloud'), 'Open runner ' + m.name),
        h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => recreate(m) }, ic('refresh'), 'Recreate runner'),
        fine,
      );
    }
    const repo = await cs.findRunnerRepo(user.login, upstream);
    if (!repo)
      return body.replaceChildren(intro,
        h('div', { class: 'label' }, 'Step 1 · just once'),
        h('div', { class: 'muted small' }, `Fork ${upstream} to your account. The runner codespace is created from that fork, and runner secrets are readable only by codespaces of that fork.`),
        h('a', { class: 'btn primary', style: 'margin-top:12px', href: `https://github.com/${upstream}/fork`, target: '_blank', rel: 'noopener' }, ic('github'), 'Fork on GitHub'),
        h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => cloudSetupSheet() }, ic('check'), 'Done, continue'),
        fine,
      );
    const go = h('button', { class: 'btn primary big', onclick: () => createRunner(body, repo, user) }, ic('cloud'), 'Create runner');
    body.replaceChildren(intro,
      h('div', { class: 'tags', style: 'justify-content:center;margin-bottom:14px' }, h('span', { class: 'tag' }, '@' + user.login), h('span', { class: 'tag' }, repo.full_name)),
      go,
      fine,
      prebuildTip(repo.full_name),
    );
  } catch (e) {
    body.replaceChildren(h('div', { class: 'err' }, e.message), h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => (e.status === 401 ? connectCodespaces('create') : cloudSetupSheet()) }, ic('refresh'), e.status === 401 ? 'Reconnect' : 'Try again'));
  }
}

// Codespaces prebuild (optional, set only in the fork's settings): a new runner starts in ~1 minute instead of 3–5.
const prebuildTip = (fork) =>
  h('details', { class: 'addpc' },
    h('summary', {}, ic('bolt'), 'Faster runners with prebuilds'),
    h('div', { class: 'muted small' }, 'Optional. In the fork’s settings: Codespaces → Set up prebuild, branch main, trigger "On configuration change". Prebuild snapshots use Codespaces storage quota.'),
    h('a', { class: 'btn', style: 'margin-top:10px', href: `https://github.com/${fork}/settings/codespaces`, target: '_blank', rel: 'noopener' }, ic('github'), 'Open the fork’s Codespaces settings'),
  );

// Runner on your own server (VPS, Fly.io, Railway, NAS): the same Docker image, token & PIN from the phone.
function dockerOption() {
  const out = h('div', {});
  const btn = h('button', { class: 'btn', style: 'margin-top:10px' }, ic('term'), 'Generate Docker command');
  btn.onclick = async () => {
    const done = busyButton(btn, 'Registering…');
    try {
      const prov = await api('/api/machines/provision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Server', provider: 'container' }) });
      if (prov.error) throw new Error(prov.error);
      const pin = randomPin();
      store.set('cloudpin.' + prov.mid, pin);
      const cmd = `docker build -t snugcode https://github.com/${await runnerRepo()}.git && docker run -d --name snugcode --restart unless-stopped -v snugcode:/data -e SNUGCODE_RELAY=${location.origin} -e SNUGCODE_PAIR_PIN=${pin} -e SNUGCODE_MACHINE_TOKEN=${prov.token} snugcode`;
      btn.remove();
      out.replaceChildren(
        h('div', { class: 'muted small' }, 'Run this on your server (Docker). It contains the machine token — don’t share it. The server appears in your machine list once the container is up, and this phone is paired automatically.'),
        h('div', { class: 'copyline' }, h('code', {}, cmd), h('button', { class: 'copybtn', onclick: async (e) => (await copyText(cmd)) && (e.currentTarget.classList.add('done'), toast('Command copied')) }, ic('copy'), 'copy')),
      );
    } catch (e) {
      done();
      toast(e.message, true);
    }
  };
  return h('details', { class: 'addpc' }, h('summary', {}, ic('term'), 'Your own server (Docker / VPS)'), h('div', { class: 'muted small' }, 'No Codespaces: run the runner on any server with Docker.'), btn, out);
}

async function recreate(m) {
  if (!(await ui.confirm({ title: 'Recreate the runner?', text: 'The old codespace is deleted along with its sessions & worktrees. Unpushed commits are lost too.', ok: 'Delete & recreate', danger: true, icon: 'refresh', stay: true }))) return;
  try {
    await removeRunner(m, { quiet: true });
  } catch (e) {
    return toast(e.message, true);
  }
  cloudSetupSheet();
}

// Runner creation steps. machine/chromium/install/start follow the codespace state and the runner's own
// reports (.devcontainer/lib.sh), so the bar reflects real progress in the codespace.
const CREATE_STEPS = [
  { id: 'provision', label: 'Registering the runner', est: 2 },
  { id: 'secrets', label: 'Saving token & PIN (encrypted on the phone)', est: 3 },
  { id: 'codespace', label: 'Creating the codespace', est: 6 },
  { id: 'machine', label: 'Preparing the machine on GitHub', est: 75 },
  { id: 'chromium', label: 'Installing Chromium', est: 50 },
  { id: 'install', label: 'Installing snugcode', est: 80 },
  { id: 'start', label: 'Starting snugcode', est: 12 },
];

// Progress step from codespace state + runner reports. A new codespace that's running but whose script
// hasn't reported yet is still "preparing the machine" (onCreate just started).
export function runnerPhase(state, boot) {
  if (boot?.step) return boot.step;
  if (boot?.stage === 'starting') return 'start';
  if (boot?.stage === 'installing') return 'install';
  return 'machine';
}

async function createRunner(body, repo, user) {
  haptic(15);
  const cs = client();
  const p = progress('cloud-create', CREATE_STEPS);
  const err = h('div', { class: 'err', role: 'alert' });
  body.replaceChildren(p.el, err, h('div', { class: 'fine' }, 'You can leave this screen — the runner keeps setting up and will appear in your machine list.'));
  try {
    const prov = await api('/api/machines/provision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Cloud', provider: 'codespace' }) });
    if (prov.error) throw new Error(prov.error);
    const pin = randomPin();
    store.set('cloudpin.' + prov.mid, pin);

    p.step('secrets');
    await cs.setSecrets({ SNUGCODE_MACHINE_TOKEN: prov.token, SNUGCODE_PAIR_PIN: pin, SNUGCODE_RELAY: location.origin }, repo.id);

    p.step('codespace');
    const c = await cs.create(repo, prov.mid);
    store.set('cloud.' + prov.mid, { codespace: c.name });

    p.step('machine', stateText(c.state));
    const m = await waitOnline(prov.mid, c.name, (t, phase) => p.step(phase, t));
    p.done('Runner connected');
    haptic(25);
    toast('Runner ready · @' + user.login);
    // The wizard was closed and the user is on another screen: just notify, don't switch screens.
    if (!body.isConnected) return;
    ui.closeSheet();
    (await import('./machine.js')).openMachine(m);
  } catch (e) {
    p.fail();
    err.textContent = e.message;
    body.append(
      isAuthError(e)
        ? h('button', { class: 'btn primary', style: 'margin-top:12px', onclick: () => connectCodespaces('create') }, ic('github'), 'Reconnect GitHub Codespaces')
        : h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => cloudSetupSheet() }, ic('refresh'), 'Try again'),
    );
  }
}

// Stage reported by the runner itself (.devcontainer/lib.sh → /api/runner/status) since `since`.
export const bootOf = (m, since = 0) => (m?.boot && m.boot.at >= since ? m.boot : null);

// Wait for the codespace to start and its daemon to reach the relay. Meanwhile the runner's own stage
// (installing packages, starting snugcode, errors) is more informative than the codespace state.
async function waitOnline(mid, name, onState, ms = 12 * 60_000) {
  const cs = client();
  const t0 = Date.now();
  const end = t0 + ms;
  let last = '';
  let availableAt = 0;
  while (Date.now() < end) {
    const { machines } = await api('/api/machines');
    const m = machines.find((x) => x.id === mid);
    if (!m) throw new Error('The runner was removed from your account.');
    if (m.online) return m;
    const boot = bootOf(m, t0 - 60_000);
    if (boot?.stage === 'error') throw new Error('The runner failed to start: ' + boot.msg);
    const c = await cs.get(name).catch(() => null);
    if (c?.state === 'Failed') throw new Error('The codespace failed to create. Open it on GitHub to see the logs: ' + c.web_url);
    if (c?.state === 'Shutdown') await cs.start(name);
    if (c?.state === 'Available') availableAt ||= Date.now();
    // Codespace running for a long time with no report at all: the runner script isn't running or got no secrets.
    if (!boot && availableAt && Date.now() - availableAt > 6 * 60_000)
      throw new Error('The codespace is running but the runner isn’t reporting. Open the codespace on GitHub, check /workspaces/.snugcode/cloud.log, then recreate the runner.');
    const t = boot ? boot.msg : stateText(c?.state);
    const phase = runnerPhase(c?.state, boot);
    if (t + phase !== last) onState?.(t, phase), (last = t + phase);
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('The runner still isn’t connected after 12 minutes. Try opening it again later, or check the log in the codespace: /workspaces/.snugcode/cloud.log');
}

async function codespaceOf(m) {
  const cs = client();
  if (!cs) return null;
  const c = await cs.find(m.id, store.get('cloud.' + m.id)?.codespace);
  if (c) store.set('cloud.' + m.id, { codespace: c.name });
  return c;
}

// ---------- Start / stop / delete ----------
// Codespace running but snugcode inside isn't connected & hasn't reported for this long: the daemon died
// (permanent crash, killed) and nothing restarts it (postStartCommand only runs on codespace start), so
// the codespace is restarted once. Longer than the daemon's reconnect backoff (≤30 seconds).
const DEAD_RUNNER_MS = 45_000;
// Still no report after the restart: the runner script isn't running (missing secrets, broken setup).
const SILENT_MS = 6 * 60_000;

// Called when an offline runner is opened. onState(text) for the waiting screen; onFail(error) if the runner
// still can't start while waiting. Returns false if it can't be started from this phone (no Codespaces
// access yet) — the caller shows the button.
export async function wakeRunner(m, onState, onFail) {
  if (!client()) return false;
  const c = await codespaceOf(m);
  if (!c) throw new Error('The runner codespace wasn’t found (it may have been deleted or expired). Recreate it from Add PC → Cloud runner.');
  onState?.(stateText(c.state), c.state === 'Available' ? 'start' : 'boot');
  if (!['Available', 'Starting', 'Provisioning', 'Queued', 'Rebuilding', 'Updating', 'Created'].includes(c.state)) await client().start(c.name);
  // The daemon connects by itself; the codespace state is shown until the relay sees it online.
  let since = Date.now() - 60_000; // runner reports count from here (reset on restart)
  let availableAt = 0;
  let restarted = false;
  let busy = false;
  const t = setInterval(async () => {
    if (app.current?.m.id !== m.id || app.current.ready) return clearInterval(t);
    if (busy) return;
    busy = true;
    try {
      const now = await client()?.get(c.name).catch(() => null);
      const mach = now?.state === 'Available' ? (await api('/api/machines').catch(() => ({ machines: [] }))).machines.find((x) => x.id === m.id) : null;
      // Once the codespace runs, the runner's own stage (installing/starting/error) is more informative.
      const boot = bootOf(mach, since);
      availableAt = now?.state === 'Available' ? availableAt || Date.now() : 0;
      if (availableAt && !boot && !mach?.online) {
        const quiet = Date.now() - availableAt;
        if (!restarted && quiet > DEAD_RUNNER_MS) {
          restarted = true;
          since = Date.now();
          availableAt = 0;
          onState?.('snugcode isn’t running in the codespace · restarting the codespace…', 'boot');
          await client().stop(c.name);
          return;
        }
        if (restarted && quiet > SILENT_MS) throw new Error('The codespace is running but the runner isn’t reporting. Open the codespace on GitHub and check /workspaces/.snugcode/cloud.log, or recreate the runner.');
      }
      if (now) onState?.(boot ? (boot.stage === 'error' ? 'failed: ' : '') + boot.msg : stateText(now.state), now.state === 'Available' ? 'start' : 'boot');
      // Opened right while the runner was stopping (by itself or the restart above): /start is refused (409),
      // so start it once it has fully stopped.
      if (now?.state === 'Shutdown') await client().start(c.name).catch(() => {});
    } catch (e) {
      clearInterval(t);
      onFail?.(e);
    } finally {
      busy = false;
    }
  }, 5000);
  return true;
}

export async function stopRunnerNow(m) {
  const c = await codespaceOf(m);
  if (!c) throw new Error('Runner codespace not found.');
  await client().stop(c.name);
}

// Delete a runner: its codespace (if this phone has Codespaces access), its secrets, and its account entry.
// @returns {Promise<{ codespace: boolean }>} codespace = the codespace was deleted too
export async function removeRunner(m, { quiet = false } = {}) {
  const cs = isCodespace(m) ? client() : null;
  const c = cs ? await codespaceOf(m).catch(() => null) : null;
  if (c) await cs.remove(c.name);
  await api('/api/machines/' + m.id, { method: 'DELETE' });
  if (cs) await cs.deleteSecrets(SECRET_NAMES).catch(() => {});
  for (const k of ['cloud.', 'cloudpin.', 'dev.']) store.set(k + m.id, null);
  if (!quiet) toast(c || !isCodespace(m) ? 'Runner deleted' : 'Runner removed from your account. Delete its codespace yourself at github.com/codespaces.', false, c ? 3200 : 6000);
  return { codespace: !!c };
}

export async function openRunnerOnGithub(m) {
  const c = await codespaceOf(m);
  if (!c) throw new Error('Runner codespace not found.');
  window.open(c.web_url, '_blank', 'noopener');
}

// For the waiting screen when this phone has no Codespaces access yet.
export const connectButton = (label = 'Connect Codespaces to start it') => h('button', { class: 'btn primary', style: 'margin-top:16px', onclick: () => connectCodespaces('wake') }, ic('github'), label);
export const wakeArt = () => mascot('think xl');

// "Auto-stop after N minutes" options (the runner stops itself using the token from the phone).
export async function idleSheet(back) {
  const info = app.current.info;
  const cur = info.runner?.idleStopMinutes ?? 30;
  const opts = [[15, '15 minutes'], [30, '30 minutes (recommended)'], [60, '1 hour'], [120, '2 hours'], [0, 'Never auto-stop']];
  ui.sheet(
    ui.head('Auto-stop', { sub: app.current.m.name, back }),
    h('div', { class: 'muted small', style: 'margin-bottom:10px' }, 'The runner counts as idle when no agent, command, or dev server is running and the app isn’t open.'),
    h('div', { class: 'group' },
      ...opts.map(([n, label]) =>
        h('button', {
          class: 'menuitem',
          onclick: async (e) => {
            const done = busyButton(/** @type {HTMLButtonElement} */ (e.currentTarget), label);
            try {
              const runner = await app.conn.call('runnerConfig', { idleStopMinutes: n, ...(ghcs() ? { token: ghcs().token } : {}) });
              app.current.info = { ...info, runner };
              toast('Auto-stop: ' + label);
              back();
            } catch (err) {
              done();
              toast(err.message, true);
            }
          },
        }, h('span', { class: 'mi' }, ic(n === cur ? 'check' : 'clock')), h('span', { class: 'grow' }, h('div', { class: 't1' }, label))),
      ),
    ),
    !info.runner?.autoStop && info.runner?.provider === 'codespace' ? h('div', { class: 'fine' }, 'Connect Codespaces on this phone so the runner can stop itself.') : null,
  );
}
