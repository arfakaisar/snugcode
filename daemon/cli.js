#!/usr/bin/env node
// snugcode — CLI daemon.
//   snugcode setup     : first-time setup (model API key, GitHub, PIN)
//   snugcode start     : run the daemon
//   snugcode stop      : stop the daemon running in the background
//   snugcode autostart : start automatically at login (on|off)
//   snugcode pin       : change the PIN / unlock after too many wrong attempts
//   snugcode devices   : list paired phones;  snugcode revoke <id|all>
//   snugcode status    : configuration summary
//   snugcode cloud     : cloud runner (Codespaces/container) — configured from env, see runner.js
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { loadConfig, saveConfig, loadSecrets, saveSecrets, ensureDirs, HOME, SESSIONS_DIR, isCloud, scrubSecretEnv, resetPinLock, pinLockedUntil, secretsSealed, setKeychain } from './config.js';
import { DEFAULT_RELAY_URL, GITHUB_CLIENT_ID, DEFAULT_ROUTER_URL, PACKAGE_SPEC } from './defaults.js';
import { deviceFlowLogin, gitCredentialToken, gh } from './github.js';
import { pinToPrs, PIN_RE, normalizePin } from '../shared/crypto.js';
import { lightModel } from '../shared/models.js';
import { keyCandidates, splitRef, ENGINE_LABEL, engineFor } from '../shared/providers.js';
import { detectConnection, putConnection, mirrorLegacy, migrateLegacy, hasConnections, allConnections, connSummary } from './providers.js';
import { checkUpdate, performUpdate, performRollback, updateChannel } from './updater.js';
import { AUTOSTART_UNIT, autostartFilePath, writeAutostart, disableAutostart, syncAutostart } from './autostart.js';

const CLI = fileURLToPath(import.meta.url);
const COMMAND_NAMES = ['setup', 'login', 'connect', 'disconnect', 'start', 'stop', 'restart', 'update', 'clean', 'autostart', 'pin', 'devices', 'revoke', 'status', 'help', 'cloud', 'keychain'];
const args = process.argv.slice(2);
// No command -> open the TUI (like `claude`). A first word that isn't a
// command is taken as the initial prompt: snugcode "explain this repo".
const cmd = args[0] && COMMAND_NAMES.includes(args[0]) ? args.shift() : 'tui';
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    flags[k] = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : true;
  } else if (args[i].startsWith('-') && args[i].length > 1) {
    const k = args[i].slice(1);
    if (k === 'c') flags.computer = true;
    else if (k === 'p') flags.pick = true;
    else flags[k] = true;
  }
}

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };

let rl;
function ask(q, def, { hidden = false } = {}) {
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const prompt = `${q}${def ? c.d(` [${def}]`) : ''}: `;
  return new Promise((resolve) => {
    if (hidden) {
      const orig = rl._writeToOutput;
      rl._writeToOutput = (s) => orig.call(rl, s.startsWith(prompt) ? prompt : s.replace(/[^\r\n]/g, '*'));
      rl.question(prompt, (a) => {
        rl._writeToOutput = orig;
        resolve(a.trim() || def || '');
      });
    } else rl.question(prompt, (a) => resolve(a.trim() || def || ''));
  });
}

function openBrowser(url) {
  const p =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
}

async function pickModel(models, label, def) {
  if (flags[label]) return flags[label];
  // OpenRouter & big routers have hundreds of models: show some, other names can still be typed.
  models.slice(0, 40).forEach((m, i) => console.log(c.d(String(i + 1).padStart(3)) + '  ' + m));
  if (models.length > 40) console.log(c.d(`  … ${models.length - 40} more models (type the name)`));
  const a = await ask(`Pick the ${label === 'model' ? 'main model' : 'small model (light tasks)'} (number or name)`, def);
  return /^\d+$/.test(a) ? models[+a - 1] : a;
}

async function askPin() {
  if (flags.pin) {
    if (!PIN_RE.test(String(flags.pin))) throw new Error('The PIN must be 6–12 letters/digits.');
    return String(flags.pin);
  }
  for (;;) {
    const a = await ask('Create a PIN (6–12 letters/digits, e.g. moon42) to pair your phone', '', { hidden: true });
    if (!PIN_RE.test(a)) {
      console.log(c.r('The PIN must be 6–12 letters/digits.'));
      continue;
    }
    const b = await ask('Repeat the PIN', '', { hidden: true });
    if (normalizePin(a) === normalizePin(b)) return a;
    console.log(c.r('The PINs don\'t match.'));
  }
}

async function setup() {
  ensureDirs();
  const cfg = loadConfig();
  const sec = loadSecrets();
  console.log(c.b('\nsnugcode setup') + c.d(`  (data stored in ${HOME})\n`));

  // 1. Model: any API key (official / router / your own endpoint), its type detected automatically.
  migrateLegacy(cfg, sec);
  console.log(c.b('1) Model & API key'));
  console.log(c.d('   Paste an API key: Anthropic (sk-ant-api…), OpenAI, Gemini (AIza…), OpenRouter, DeepSeek, Kimi, GLM, xAI, Groq,'));
  console.log(c.d('   or a router key (9router, OmniRoute, LiteLLM, …) with its URL. ChatGPT login: from the phone app → Models & API keys.'));
  const have = hasConnections(sec);
  let models;
  for (;;) {
    const key = flags.key || (await ask('API key', have ? '(keep)' : '', { hidden: true }));
    if (key === '(keep)' && have) break;
    let url = flags.router || flags.url || '';
    if (!url && key && !keyCandidates(key).length && !flags.key) url = await ask('Router / endpoint URL (this key isn\'t a known official key)', cfg.routerUrl || DEFAULT_ROUTER_URL);
    else if (!url && key && !keyCandidates(key).length) url = cfg.routerUrl || DEFAULT_ROUTER_URL;
    // An unrecognized key (router / own endpoint) is only sent to a URL the user chose, never to a default address.
    if (!url && key && key !== '(keep)' && !keyCandidates(key).length) {
      console.log(c.r('✗ This isn\'t a known official key: also give the router / endpoint URL (--url https://…/v1).'));
      if (flags.key) process.exit(1);
      continue;
    }
    try {
      const det = await detectConnection({ key, url });
      const { models: list, ...conn } = det;
      const id = putConnection(sec, conn);
      mirrorLegacy(cfg, sec);
      const fmt = Object.entries(conn.formats || {}).filter(([, v]) => v).map(([k]) => k).join(', ');
      console.log(c.g(`✓ ${conn.label}: ${list.length} models`) + c.d(` · format ${fmt || '-'} · connection "${id}"`));
      models = list.map((m) => m.id);
      break;
    } catch (e) {
      console.log(c.r('✗ ' + e.message));
      if (flags.key) process.exit(1);
    }
  }
  if (models?.length) {
    const { defaultModel } = await import('./server.js');
    const def = models.includes(cfg.model) ? cfg.model : defaultModel(models);
    // Non-interactive (--key without --model): the default model is picked automatically.
    cfg.model = flags.key && !flags.model ? def : await pickModel(models, 'model', def);
    // Subagents always use the light model from the same connection (automatic per main model).
    delete cfg.smallModel;
    const light = lightModel(cfg.model, models);
    const conn = allConnections(sec)[splitRef(cfg.model).conn];
    const route = conn && engineFor(conn, splitRef(cfg.model).id);
    console.log(c.d(`  harness: ${route ? ENGINE_LABEL[route.engine] : '-'} · light model (subagents): ${light.kind === 'main' ? 'main model' : light.id}`));
  }

  // 2. All questions first, so the login steps can be completed in one go.
  console.log(c.b('\n2) GitHub (for clone, push, and PRs)'));
  let githubMode = flags.github || (flags['github-token'] ? 'token' : flags['skip-github'] ? 'skip' : null);
  if (!githubMode) {
    const opts = [];
    if (GITHUB_CLIENT_ID) opts.push(['Sign in via browser / phone (recommended)', 'device']);
    opts.push(['Use the git login already on this PC (Git Credential Manager / GitHub Desktop)', 'cred']);
    opts.push(['Paste a Personal Access Token', 'pat']);
    if (sec.githubToken) opts.push(['Keep using the saved token', 'keep']);
    opts.forEach(([l], i) => console.log(`  ${i + 1}. ${l}`));
    githubMode = opts[(+(await ask('Choice', sec.githubToken ? String(opts.length) : '1')) || 1) - 1]?.[1] || 'skip';
  }
  if (githubMode === 'token') sec.githubToken = flags['github-token'];
  else if (githubMode === 'pat') sec.githubToken = await ask('Token (scope: repo, workflow)', '', { hidden: true });
  else if (githubMode === 'cred') {
    sec.githubToken = await gitCredentialToken();
    if (!sec.githubToken) console.log(c.r('✗ No GitHub credentials stored in git.'));
  } else if (githubMode === 'skip') delete sec.githubToken;

  console.log(c.b('\n3) PC & PIN'));
  cfg.relayUrl = (flags.relay || (DEFAULT_RELAY_URL && !cfg.relayUrl ? DEFAULT_RELAY_URL : await ask('Relay URL', cfg.relayUrl || DEFAULT_RELAY_URL))).replace(/\/+$/, '');
  cfg.machineName = flags.name || (await ask('Name of this PC', cfg.machineName || os.hostname()));
  const relink = !sec.machineToken || cfg.linkedRelay !== cfg.relayUrl || flags.relink || (!flags.name && (await ask('Relink this PC to your account? (y/n)', 'n')) === 'y');
  let pin = null;
  if (!sec.prs || relink || flags.pin || (await ask('Change the PIN? (y/n)', 'n')) === 'y') pin = await askPin();

  // 4. Login: link the PC + (optionally) the GitHub device flow, shown together.
  const tasks = [];
  const steps = [];
  if (relink) {
    const r = await fetch(cfg.relayUrl + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: cfg.machineName }) });
    if (!r.ok) throw new Error('Can\'t reach the relay: ' + r.status);
    const { code, url } = await r.json();
    steps.push(`Link this PC to your GitHub account — open:\n     ${c.b(url)}\n     and make sure that page shows the code ${c.b(code)}`);
    tasks.push(
      (async () => {
        for (;;) {
          await new Promise((res) => setTimeout(res, 2000));
          const p = await (await fetch(cfg.relayUrl + '/auth/machine/poll?code=' + code)).json();
          if (p.status === 'ok') {
            sec.machineToken = p.token;
            cfg.machineId = p.mid;
            cfg.relayLogin = p.login;
            cfg.linkedRelay = cfg.relayUrl;
            sec.devices = {};
            console.log(c.g(`✓ PC linked to @${p.login}`));
            return;
          }
          if (p.status === 'expired') throw new Error('The link expired, run setup again.');
        }
      })(),
    );
  }
  if (githubMode === 'device') {
    let announce;
    const shown = new Promise((res) => (announce = res));
    tasks.push(
      deviceFlowLogin(GITHUB_CLIENT_ID, (code, uri) => {
        steps.push(`Sign in to GitHub for this PC — open ${c.b(uri)}\n     and enter the code: ${c.b(code)}`);
        announce();
      }).then((t) => (sec.githubToken = t)),
    );
    await shown;
  }
  if (steps.length) {
    console.log(c.b('\n4) Finish in your browser (your phone works too):'));
    steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    if (!flags['no-browser'] && relink) openBrowser(steps[0].match(/https?:\/\/\S+/)[0].replace(/\x1b\[[0-9;]*m/g, ''));
    console.log(c.d('  Waiting…'));
    await Promise.all(tasks);
  }

  if (sec.githubToken) {
    try {
      const me = await gh(sec.githubToken, 'GET', '/user');
      cfg.githubLogin = me.login;
      cfg.githubId = me.id;
      console.log(c.g(`✓ GitHub: @${me.login}`));
    } catch (e) {
      console.log(c.r('✗ Invalid GitHub token: ' + e.message));
      delete sec.githubToken;
    }
  } else console.log(c.y('! Without GitHub: public repos only, no push.'));

  if (pin) {
    sec.prs = Buffer.from(await pinToPrs(pin, cfg.machineId)).toString('hex');
    resetPinLock(sec);
  }

  saveConfig(cfg);
  saveSecrets(sec);
  rl?.close();
  console.log(c.g('\n✓ Setup complete.') + ` Run ${c.b('snugcode start')} (or ${c.b('snugcode autostart on')}), then open ${c.b(cfg.relayUrl + '/agent/')} on your phone.\n`);
}

async function resetPin() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  if (!cfg.machineId) throw new Error('Not set up yet.');
  const pin = await askPin();
  sec.prs = Buffer.from(await pinToPrs(pin, cfg.machineId)).toString('hex');
  resetPinLock(sec);
  saveSecrets(sec);
  rl?.close();
  console.log(c.g('✓ PIN changed and unlocked. (A running daemon needs a restart.)'));
}

function devices() {
  const sec = loadSecrets();
  const list = Object.entries(sec.devices);
  if (!list.length) return console.log('No phones paired yet.');
  for (const [id, d] of list) console.log(`${c.b(id)}  ${d.name}  ${c.d('last seen: ' + new Date(d.lastSeen).toLocaleString())}`);
}

function revoke(id) {
  const sec = loadSecrets();
  if (id === 'all') sec.devices = {};
  else if (!sec.devices[id]) throw new Error('ID not found');
  else delete sec.devices[id];
  saveSecrets(sec);
  console.log(c.g('✓ Revoked. (Restart the daemon to drop active connections right away.)'));
}

// ---------- background process ----------
const PID_FILE = path.join(HOME, 'daemon.pid');
const LOG_FILE = path.join(HOME, 'daemon.log');

function runningPid() {
  try {
    const pid = +fs.readFileSync(PID_FILE, 'utf8');
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function stop() {
  const pid = runningPid();
  if (!pid) return console.log('The daemon is not running.');
  const { stopDaemon } = await import('./tui.js');
  await stopDaemon(pid);
  fs.rmSync(PID_FILE, { force: true });
  console.log(c.g(`✓ Daemon (pid ${pid}) stopped.`));
}

// Run the daemon detached from this terminal (stays alive even if the terminal closes).
function spawnDetached() {
  const p = spawn(process.execPath, [CLI, 'start', '--log'], { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  return p.pid;
}

function autostart() {
  const mode = args.find((a) => !a.startsWith('--')) || 'on';
  if (mode === 'on' && CLI.includes('_npx')) {
    console.log(c.y('! You\'re running via npx. For autostart, install globally first so the path stays fixed:'));
    console.log(`    npm i -g ${PACKAGE_SPEC}   then   snugcode autostart on`);
  }
  if (mode === 'off') {
    disableAutostart();
    return console.log(c.g('✓ Autostart disabled.'));
  }
  const file = writeAutostart(CLI, process.execPath);
  console.log(c.g('✓ Autostart enabled: ') + file);

  // Start it right now if it isn't running.
  if (!runningPid()) {
    if (process.platform === 'linux') spawnSync('systemctl', ['--user', 'start', AUTOSTART_UNIT]);
    else if (process.platform === 'darwin') spawnSync('launchctl', ['load', autostartFilePath()]);
    else spawnDetached();
    console.log(c.g('✓ Daemon started in the background.') + c.d(` Log: ${LOG_FILE}`));
  } else console.log(c.d('The daemon is already running.'));
}

async function start() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  // Cloud runners are configured from the phone: the model key may not exist yet on the first start.
  if (isCloud(cfg) ? !cfg.relayUrl || !sec.machineToken : !cfg.relayUrl || !sec.machineToken || !hasConnections(sec) || !sec.prs) {
    if (isCloud(cfg)) throw new Error('The runner isn\'t configured yet. Run `snugcode cloud` with SNUGCODE_MACHINE_TOKEN.');
    console.log(c.y('Not set up yet. Running setup first…\n'));
    await setup();
    return start();
  }
  ensureDirs();
  const other = runningPid();
  if (other && other !== process.pid) {
    console.log(c.y(`The daemon is already running (pid ${other}). Stop it with `) + c.b('snugcode stop'));
    process.exit(1);
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on('exit', () => runningPid() === process.pid && fs.rmSync(PID_FILE, { force: true }));
  // Always sync the autostart script if autostart was ever enabled on this system
  if (!isCloud(cfg)) syncAutostart(CLI, process.execPath);
  if (flags.log) {
    const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const write = (...a) => out.write(new Date().toISOString() + ' ' + util.format(...a).replace(/\x1b\[[0-9;]*m/g, '') + '\n');
    console.log = write;
    console.error = write;
  }
  const { Daemon } = await import('./server.js');
  console.log(c.b('snugcode') + c.d(` — ${cfg.machineName} · model ${cfg.model} · relay ${cfg.relayUrl}`));
  if (pinLockedUntil(sec)) console.log(c.r(`! Pairing is locked until ${new Date(pinLockedUntil(sec)).toLocaleTimeString()} after too many wrong PINs. \`snugcode pin\` unlocks it now.`));
  const d = new Daemon(cfg);
  d.start();
  // Under the cloud runner supervisor, stopping by signal isn't an "intentional stop" (exit 0): exit
  // with 128+signal, the supervisor decides whether to start it again (e.g. `pkill node` from the agent).
  const bye = (sig) => Promise.resolve(d.stop()).finally(() => process.exit(process.env.SNUGCODE_SUPERVISED === '1' ? 128 + (os.constants.signals[sig] || 15) : 0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

function status() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  console.log({
    home: HOME,
    runtime: cfg.runtime || 'pc',
    relay: cfg.relayUrl,
    account: cfg.relayLogin,
    machine: cfg.machineName,
    connections: Object.values(allConnections(sec)).map((x) => `${x.id}: ${connSummary(x).label}${x.key ? ' ' + connSummary(x).key : ''}`),
    model: cfg.model,
    lightModel: cfg.model ? lightModel(cfg.model).id : null,
    github: cfg.githubLogin || null,
    devices: Object.keys(sec.devices).length,
    pinLocked: !!pinLockedUntil(sec),
    keychain: secretsSealed(),
  });
}

// secrets.json encrypted with a key in the OS keychain (see daemon/keychain.js). A running daemon
// saves in the new mode on its next write; no restart needed.
async function keychain() {
  const sub = args.find((a) => !a.startsWith('-')) || 'status';
  if (sub === 'status') {
    console.log(secretsSealed() ? c.g('✓ secrets.json is encrypted, its key is in the OS keychain') : c.d('secrets.json is not encrypted (file mode 600). Enable: snugcode keychain on'));
    return;
  }
  if (sub !== 'on' && sub !== 'off') throw new Error('Usage: snugcode keychain on | off | status');
  const r = setKeychain(sub === 'on');
  if (sub === 'on') console.log(r === 'already on' ? c.d('The keychain is already on.') : c.g(`✓ secrets.json encrypted; its key is stored in ${r}.`) + c.d('\n  Without that keychain (e.g. signing in over SSH while it\'s locked) the daemon can\'t read secrets.'));
  else console.log(r === 'already off' ? c.d('The keychain is already off.') : c.g('✓ secrets.json is unencrypted again (file mode 600); the key was removed from the keychain.'));
}

// Re-login to GitHub only (e.g. a revoked token), without redoing the whole setup.
async function login() {
  if (!GITHUB_CLIENT_ID) throw new Error('GITHUB_CLIENT_ID is not set.');
  // Daemon running: sign in through the daemon, the token applies right away without a restart.
  if (runningPid()) {
    try {
      const { loginViaDaemon } = await import('./tui.js');
      return await loginViaDaemon({ openBrowser: !flags['no-browser'] });
    } catch (e) {
      // The Indonesian alternatives match messages from daemons installed before the English release.
      if (!/ECONNREFUSED|ENOENT|tidak menjawab|token lokal|not answering|local token/.test(e.message)) throw e;
      // An old daemon without a local channel: fall back to the old way (restart the daemon).
    }
  }
  console.log(c.b('Sign in to GitHub for this PC') + c.d(' (clone, push, PRs)'));
  const token = await deviceFlowLogin(GITHUB_CLIENT_ID, (code, uri) => {
    console.log(`  Open ${c.b(uri)}\n  and enter the code ${c.b(code)}`);
    if (!flags['no-browser']) openBrowser(uri);
    console.log(c.d('  Waiting…'));
  });
  const me = await gh(token, 'GET', '/user');
  // The daemon keeps secrets in memory: stop it first so the new token isn't overwritten.
  const pid = runningPid();
  if (pid) await (await import('./tui.js')).stopDaemon(pid);
  const cfg = loadConfig();
  const sec = loadSecrets();
  sec.githubToken = token;
  cfg.githubLogin = me.login;
  cfg.githubId = me.id;
  saveConfig(cfg);
  saveSecrets(sec);
  console.log(c.g(`✓ GitHub: @${me.login}`));
  if (pid) {
    spawnDetached();
    console.log(c.g('✓ Daemon restarted with the new token.'));
  }
}

// `snugcode connect <api key> [--url URL]` · `snugcode connect chatgpt` · `snugcode connect` (list).
// Daemon running: through the daemon (applies immediately). Not running: written to secrets.json.
async function connect() {
  const arg = args.find((a) => !a.startsWith('-'));
  const url = flags.url || flags.router || undefined;
  const pid = runningPid();
  if (arg === 'chatgpt') {
    if (!pid) throw new Error('ChatGPT login runs through the daemon: run `snugcode start` (or autostart) first, then try again.');
    const { chatgptLoginViaDaemon } = await import('./tui.js');
    return chatgptLoginViaDaemon({ openBrowser: !flags['no-browser'] });
  }
  if (!arg && !url) {
    const sec = loadSecrets();
    migrateLegacy(loadConfig(), sec);
    const list = Object.values(allConnections(sec)).map(connSummary);
    if (!list.length) return console.log(c.y('No models connected yet.') + c.d(' snugcode connect <api key> [--url URL] · snugcode connect chatgpt'));
    for (const x of list) console.log(`${c.b(x.id.padEnd(10))} ${x.label}${x.key ? c.d(' ' + x.key) : ''}${x.account?.email ? c.d(' ' + x.account.email) : ''}${x.url ? c.d(' · ' + x.url) : ''}`);
    return;
  }
  if (pid) {
    const { daemonCall } = await import('./tui.js');
    const r = await daemonCall('connAdd', { key: arg, url });
    return console.log(c.g(`✓ ${r.conn.label}: ${r.models} models`) + c.d(` · connection "${r.conn.id}" · default model ${r.info.model || '-'}`));
  }
  const cfg = loadConfig();
  const sec = loadSecrets();
  migrateLegacy(cfg, sec);
  const { models, ...conn } = await detectConnection({ key: arg, url });
  const id = putConnection(sec, conn);
  mirrorLegacy(cfg, sec);
  if (!cfg.model || splitRef(cfg.model).conn === id || !allConnections(sec)[splitRef(cfg.model).conn]) {
    const { defaultModel } = await import('./server.js');
    cfg.model = defaultModel(models.map((m) => m.id)) || cfg.model;
  }
  saveSecrets(sec);
  saveConfig(cfg);
  console.log(c.g(`✓ ${conn.label}: ${models.length} models`) + c.d(` · connection "${id}" · default model ${cfg.model}`));
}

async function disconnect() {
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) throw new Error('Usage: snugcode disconnect <connection id>  (see `snugcode connect`)');
  if (runningPid()) {
    const { daemonCall } = await import('./tui.js');
    await daemonCall(id === 'chatgpt' ? 'chatgptLogout' : 'connRemove', { id });
  } else {
    const cfg = loadConfig();
    const sec = loadSecrets();
    migrateLegacy(cfg, sec);
    if (!sec.connections?.[id]) throw new Error('Connection not found: ' + id);
    delete sec.connections[id];
    mirrorLegacy(cfg, sec);
    if (splitRef(cfg.model || '').conn === id) cfg.model = '';
    saveSecrets(sec);
    saveConfig(cfg);
  }
  console.log(c.g('✓ Connection removed: ' + id));
}

function isSetUp() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  return !!(cfg.relayUrl && sec.machineToken && hasConnections(sec) && sec.prs);
}

async function tui() {
  if (!isSetUp()) {
    console.log(c.y('Not set up yet. Running setup first…\n'));
    await setup();
  }
  const { runTui } = await import('./tui.js');
  const prompt = args.filter((a) => !a.startsWith('-')).join(' ').trim();
  await runTui({ prompt, pick: !!flags.pick || !!flags.sessions, computer: !!(flags.computer || flags.pc) });
}

async function cliRestart() {
  const pid = runningPid();
  if (!pid) {
    console.log(c.y('The daemon is not running. Starting a new daemon…'));
    const newPid = spawnDetached();
    return console.log(c.g(`✓ Daemon started (pid ${newPid}).`));
  }
  await (await import('./tui.js')).stopDaemon(pid);
  fs.rmSync(PID_FILE, { force: true });
  const newPid = spawnDetached();
  console.log(c.g(`✓ Daemon restarted (pid ${newPid}).`));
}

async function cliUpdate() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  if (flags.channel) {
    if (!['stable', 'main'].includes(flags.channel)) throw new Error('Channel: stable (tagged releases) or main (latest commit).');
    cfg.updateChannel = flags.channel;
    saveConfig(cfg);
    console.log(c.g(`✓ Update channel: ${flags.channel}`));
  }
  if (flags.rollback) {
    const wasRunning = await stopAndWait();
    console.log(c.d(`Rolling back to ${cfg.previousSpec || '(none)'}…`));
    try {
      const r = await performRollback(cfg);
      console.log(c.g(`✓ Back to the previous version (${r.commit}).`));
    } finally {
      if (wasRunning) console.log(c.g(`✓ Daemon started again (pid ${spawnDetached()}).`));
    }
    return;
  }
  console.log(c.b('Checking for snugcode updates…') + c.d(` (channel ${updateChannel(cfg)})`));
  const st = await checkUpdate(cfg, sec);
  if (!st.updateAvailable && !flags.force) {
    console.log(c.g('✓ snugcode is up to date') + c.d(` (${st.currentCommit})`));
    return;
  }
  console.log(c.y('Update available: ') + `${c.b(st.latestCommit)}${st.latestMessage ? ' — ' + st.latestMessage : ''}`);
  // Stop the daemon first (with the claude.exe of its sessions) so files aren't locked while npm installs.
  const wasRunning = await stopAndWait();
  if (wasRunning) console.log(c.d('Daemon stopped temporarily for the update.'));
  console.log(c.d('Installing the update…'));
  try {
    const r = await performUpdate(cfg, sec);
    console.log(c.g(`✓ Update installed (${r.commit}).`));
  } finally {
    if (wasRunning) console.log(c.g(`✓ Daemon started again (pid ${spawnDetached()}).`));
  }
}

async function stopAndWait() {
  const pid = runningPid();
  if (!pid) return false;
  await (await import('./tui.js')).stopDaemon(pid);
  // Windows: also kill the daemon's child claude.exe (/T) that may linger, without touching other claude.exe.
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  fs.rmSync(PID_FILE, { force: true });
  // The daemon's child claude.exe can linger briefly after the daemon dies.
  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

async function cliClean() {
  const { cleanupWorkspaces } = await import('./cleaner.js');
  const { readSessionIndex } = await import('./config.js');
  const idx = readSessionIndex();
  // Unreadable session list = every worktree would look "orphaned": delete nothing.
  if (!idx.ok) {
    console.log(c.r('✗ sessions/index.json is unreadable; cleanup cancelled so no worktree gets deleted.'));
    return;
  }
  console.log(c.b('Scanning PC workspaces for orphaned folders…'));
  const r = await cleanupWorkspaces(idx.list, { minAgeMs: 0, repoTtlMs: 0 });
  const wtCount = r.removedWorktrees.length;
  const repoCount = r.removedRepos.length;
  const logCount = r.removedLogs.length;
  if (wtCount === 0 && repoCount === 0 && logCount === 0) {
    console.log(c.g('✓ Workspace is clean. No orphaned folders or repositories.'));
  } else {
    if (wtCount > 0) console.log(c.g(`✓ Removed ${wtCount} orphaned worktree(s):`), r.removedWorktrees.map((w) => path.basename(w)).join(', '));
    if (repoCount > 0) console.log(c.g(`✓ Removed ${repoCount} unused repositor${repoCount === 1 ? 'y' : 'ies'}:`), r.removedRepos.map((r) => path.basename(r)).join(', '));
    if (logCount > 0) console.log(c.g(`✓ Removed ${logCount} stale log file(s):`), r.removedLogs.join(', '));
  }
}

function help() {
  console.log(`${c.b('snugcode')} — a coding agent on your PC, from the terminal & your phone

  ${c.g('snugcode')}                 open the terminal UI (this repo folder becomes the session)
  ${c.g('snugcode --computer')}      open computer mode (an agent with access to the whole PC)
  ${c.g('snugcode "prompt"')}        open the UI and send a prompt right away
  ${c.g('snugcode --pick')}          pick a session (including sessions from the phone)

  snugcode setup            set up / change configuration
  snugcode login            sign in to GitHub again (token revoked/expired)
  snugcode connect <key>    connect a model API key (type auto-detected; --url for a router/endpoint)
  snugcode connect chatgpt  ChatGPT login (GPT models via Codex);  snugcode connect = list connections
  snugcode disconnect <id>  remove a model connection
  snugcode autostart on     run the daemon in the background + at login
  snugcode start | stop     start / stop the daemon
  snugcode restart          restart the background daemon
  snugcode update           check & install updates (tagged releases; --channel main|stable)
  snugcode update --rollback  go back to the version before the last update
  snugcode clean            scan & clean up orphaned worktrees / repos
  snugcode pin              change the PIN / unlock
  snugcode devices          paired phones;  snugcode revoke <id|all>
  snugcode status           configuration summary
  snugcode keychain on|off  encrypt secrets.json with a key in the OS keychain (macOS/Windows/Linux desktop)
  snugcode cloud            cloud runner without a PC (Codespaces/Docker), configured via env & the phone`);
}

// ---------- cloud runner ----------
// Fill config from env (idempotent), then run the daemon under a supervisor: restarts/updates from the
// phone (exit 75), crashes, and signals hitting only the daemon start it again; exit 0 (idle /
// `snugcode stop`) and SIGTERM to the supervisor stop it — the container stops too.
// --no-supervise: run the daemon directly in this process.
async function cloud() {
  ensureDirs();
  // Read before the secret env is scrubbed (scrubSecretEnv).
  const apiKey = process.env.SNUGCODE_API_KEY || '';
  const apiUrl = process.env.SNUGCODE_API_URL || '';
  const { bootstrapCloud, reportStatus, supervisorIgnoresTerm } = await import('./runner.js');
  const cfg = loadConfig();
  const sec = loadSecrets();
  let boot;
  try {
    boot = await bootstrapCloud(process.env, cfg, sec);
  } catch (e) {
    await reportStatus(process.env, 'error', 'Runner configuration failed: ' + e.message);
    throw e;
  }
  const { relinked, warnings } = boot;
  saveConfig(cfg);
  saveSecrets(sec);
  scrubSecretEnv();
  console.log(c.b('snugcode cloud') + c.d(` — ${cfg.machineName} · @${cfg.relayLogin || '?'} · ${cfg.runner?.provider}${cfg.runner?.name ? ' ' + cfg.runner.name : ''} · data ${HOME}`));
  if (relinked) console.log(c.g('✓ Runner linked to machine ' + cfg.machineId));
  for (const w of warnings) console.log(c.y('! ' + w));
  // SNUGCODE_API_KEY (+ SNUGCODE_API_URL): any model connection, detected the same way as from the phone.
  if (apiKey && sec.envApplied?.apiKey !== apiKey.slice(-12) + '|' + apiUrl) {
    try {
      const { models: _m, ...conn } = await detectConnection({ key: apiKey, url: apiUrl });
      putConnection(sec, conn);
      mirrorLegacy(cfg, sec);
      sec.envApplied = { ...sec.envApplied, apiKey: apiKey.slice(-12) + '|' + apiUrl };
      saveSecrets(sec);
      saveConfig(cfg);
      console.log(c.g('✓ Model connection from SNUGCODE_API_KEY: ' + conn.label));
    } catch (e) {
      console.log(c.y('! SNUGCODE_API_KEY ignored: ' + e.message));
    }
  }
  if (!hasConnections(sec)) console.log(c.y('! No model connected yet: open the app on your phone → Settings → Models & API keys.'));
  // A restarted container reuses the same small PIDs: daemon.pid from the last run may
  // point at another process that happens to be alive. Only treat it as running if it really is the snugcode daemon.
  const other = runningPid();
  if (other && other !== process.pid) {
    let ours = true;
    try {
      ours = fs.readFileSync(`/proc/${other}/cmdline`, 'utf8').includes('cli.js');
    } catch {}
    if (ours) return console.log(c.d(`The daemon is already running (pid ${other}).`));
    fs.rmSync(PID_FILE, { force: true });
  }
  if (flags['no-supervise'] || process.env.SNUGCODE_SUPERVISED === '1') return start();
  const { RESTART_EXIT_CODE } = await import('./updater.js');
  let child = null;
  let stopping = false;
  let backoff = 1000;
  const run = () => {
    const t0 = Date.now();
    child = spawn(process.execPath, [CLI, 'start'], { stdio: 'inherit', env: { ...process.env, SNUGCODE_SUPERVISED: '1' } });
    child.on('exit', (code, signal) => {
      if (stopping || code === 0) return process.exit(0);
      if (Date.now() - t0 > 60_000) backoff = 1000;
      const wait = code === RESTART_EXIT_CODE ? 300 : backoff;
      if (code !== RESTART_EXIT_CODE) {
        console.log(c.y(`! daemon stopped (${signal || 'exit ' + code}); restarting in ${Math.round(wait / 1000)} seconds`));
        backoff = Math.min(backoff * 2, 30_000);
      }
      setTimeout(run, wait);
    });
  };
  const stop = (sig) => ((stopping = true), child?.exitCode === null ? child.kill(sig) : process.exit(0));
  process.on('SIGINT', stop);
  // Codespaces: nothing starts the runner again while the codespace is still running (postStartCommand
  // only on start), so a stray SIGTERM (`pkill node`, `killall node` from the agent/terminal) is ignored.
  // Stopping the codespace still kills everything (SIGKILL). Intentional stop: `snugcode stop`.
  if (supervisorIgnoresTerm(cfg)) process.on('SIGTERM', () => console.log(c.y('! SIGTERM ignored: the Codespaces runner keeps running (stop it from the app or with `snugcode stop`).')));
  else process.on('SIGTERM', stop);
  run();
}

const commands = { tui, help, cloud, setup, login, connect, disconnect, start, stop, restart: cliRestart, update: cliUpdate, clean: cliClean, autostart, pin: resetPin, devices, revoke: () => revoke(args.find((a) => !a.startsWith('--'))), status, keychain };
Promise.resolve(commands[cmd]()).catch((e) => {
  console.error(c.r('✗ ' + (e?.message || e)));
  process.exit(1);
});
