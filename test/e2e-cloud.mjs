// End-to-end cloud runner test (no PC): the PWA registers a machine via /api/machines/provision,
// `snugcode cloud` runs from env only (like in Codespaces/Docker), the phone pairs itself with a PIN it
// generated, then every setting (model API key, PIN, devices) is managed from the phone.
// Also checks that GITHUB_TOKEN from the environment is invisible to the agent/shell, and that a restart
// from the phone is handled by the supervisor.
//   Terminal 1: npm run dev:relay      Terminal 2: npm run test:e2e:cloud
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { RELAY, ok, sleep, startMockRouter, routerLog } from './e2e-harness.mjs';
import { findBrowser } from '../daemon/browser.js';

const KEY = 'ROUTER-KEY-CLOUD';
const PIN = 'cloud7x';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-cloud-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-cloud-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
const router = await startMockRouter({ cwd: repo, secrets: path.join(HOME, 'secrets.json') }, null, { key: KEY });
const routerUrl = `http://127.0.0.1:${router.address().port}/v1`;

// ---------- phone: login + register the runner ----------
// localStorage per "phone": the second phone (PIN change/revoke test) has its own storage.
const phones = { a: new Map(), b: new Map() };
let mem = phones.a;
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.location = { protocol: new URL(RELAY).protocol, host: new URL(RELAY).host };
const { Conn, store } = await import('../web/conn.js');
const login = 'cloud' + Date.now().toString(36);
const r = await fetch(`${RELAY}/auth/dev/login?kind=user&login=${login}`, { redirect: 'manual' });
const userToken = decodeURIComponent(r.headers.get('location').split('#login=')[1]);
store.set('token', userToken);
const api = (p, opts = {}) => fetch(RELAY + p, { ...opts, headers: { authorization: 'Bearer ' + userToken, ...(opts.headers || {}) } });
assert.equal((await fetch(RELAY + '/api/machines/provision', { method: 'POST' })).status, 401, 'provision without login is rejected');
const prov = await (await api('/api/machines/provision', { method: 'POST', body: JSON.stringify({ name: 'Cloud e2e', provider: 'codespace' }) })).json();
assert.ok(prov.token && prov.mid, JSON.stringify(prov));
let { machines } = await (await api('/api/machines')).json();
assert.deepEqual(machines.map((m) => [m.id, m.kind, m.provider, m.online]), [[prov.mid, 'cloud', 'codespace', false]]);
for (let i = 0; i < 2; i++) await api('/api/machines/provision', { method: 'POST', body: '{}' });
assert.equal((await api('/api/machines/provision', { method: 'POST', body: '{}' })).status, 409, 'cloud runner limit per account');
// A runner that is setting itself up reports its stage with its machine token (shown in the phone wizard).
const report = (tok, body) => fetch(RELAY + '/api/runner/status', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify(body) });
assert.equal((await report(userToken, { stage: 'starting', msg: 'x' })).status, 401, 'a user token is not a machine token');
assert.equal((await report(prov.token, { stage: 'installing', msg: 'Installing snugcode…' })).status, 200);
({ machines } = await (await api('/api/machines')).json());
assert.deepEqual([machines.find((m) => m.id === prov.mid).boot.stage, machines.find((m) => m.id === prov.mid).boot.msg], ['installing', 'Installing snugcode…']);
ok('provision: cloud machine registered without logging in from it; per-account limit applies; runner reports its stage');

// ---------- runner: env only, no interactive setup ----------
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_|SNUGCODE_|POCKETCODE_|CODESPACE)/.test(k)));
const runnerEnv = {
  ...cleanEnv,
  SNUGCODE_HOME: HOME,
  SNUGCODE_MACHINE_TOKEN: prov.token,
  SNUGCODE_PAIR_PIN: PIN,
  SNUGCODE_RELAY: RELAY,
  SNUGCODE_ROUTER: routerUrl,
  SNUGCODE_NAME: 'Cloud e2e',
  SNUGCODE_IDLE_MINUTES: '0',
  GITHUB_TOKEN: 'ghs_LEAKED_FROM_CODESPACES',
  GH_TOKEN: 'gho_LEAKED_TOO',
};
const runner = spawn(process.execPath, [new URL('../daemon/cli.js', import.meta.url).pathname, 'cloud'], { env: runnerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let rlog = '';
runner.stdout.on('data', (d) => (rlog += d));
runner.stderr.on('data', (d) => (rlog += d));
process.on('exit', () => runner.exitCode === null && runner.kill('SIGKILL'));
const until = async (pred, what, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(150);
  }
  throw new Error('timeout: ' + what + '\nrunner log:\n' + rlog.slice(-3000));
};
await until(() => /Connected to the relay/.test(rlog), 'runner connected');
const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
assert.equal(cfg.runtime, 'cloud');
assert.equal(cfg.machineId, prov.mid);
assert.match(rlog, /No model connected yet/);
({ machines } = await (await api('/api/machines')).json());
assert.equal(machines.find((m) => m.id === prov.mid).online, true);
ok('snugcode cloud: config from env, connected to the relay without a model API key');

// ---------- PWA in Chromium: auto pairing, API key from the phone, runner menu, no-machines screen ----------
const exe = process.env.CHROME || findBrowser();
if (exe) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  const SHOTS = process.env.SHOTS || '';
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (ls) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push('console: ' + m.text()));
    await page.goto(RELAY + '/agent/');
    await page.evaluate((kv) => { for (const [k, v] of kv) localStorage.setItem(k, v); }, ls);
    await page.reload();
    return { page, errors, shot: (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, 'cloud-' + n + '.png') }) };
  };
  // The phone generates the runner PIN when creating the runner (cloud.js): that phone pairs without a PIN screen.
  const P = await open([['pc.token', JSON.stringify(userToken)], ['pc.cloudpin.' + prov.mid, JSON.stringify(PIN)]]);
  await P.page.waitForSelector('text=Cloud e2e');
  assert.match(await P.page.locator('.card.pc').first().innerText(), /cloud runner/);
  await P.page.locator('text=Cloud e2e').first().click();
  await P.page.waitForSelector('text=Connect a model', { timeout: 20000 });
  assert.equal(await P.page.locator('text=Pair this phone').count(), 0, 'no PIN screen');
  await P.shot('1-key');
  // Unrecognized key: the router URL field opens by itself; a wrong key is rejected by its endpoint.
  await P.page.fill('input[aria-label="API key"]', 'wrong');
  await P.page.waitForSelector('text=Unrecognized key type');
  assert.ok(await P.page.locator('input[aria-label="Router or endpoint URL"]').isVisible(), 'URL field open');
  await P.page.fill('input[aria-label="Router or endpoint URL"]', routerUrl);
  await P.page.locator('#sheet button', { hasText: /^Connect$/ }).click();
  await P.page.waitForSelector('text=/Key rejected/');
  await P.page.locator('#sheet:not([hidden]) [aria-label="Close"]').first().click();
  await P.page.waitForSelector('#sheet', { state: 'hidden' });
  await P.page.click('[aria-label="PC settings"]');
  await P.page.waitForSelector('text=Cloud runner');
  for (const t of ['Cloud · container', 'Models & API keys (required)', 'Paired devices', 'PIN for another phone', 'Auto-stop']) assert.ok(await P.page.locator('#sheet').getByText(t).count(), t);
  await P.shot('2-menu');
  await P.page.locator('#sheet').getByText('Paired devices').click();
  await P.page.waitForSelector('text=this phone');
  // Remove a machine straight from the list (⋯ button) without connecting to it: the offline spare runner.
  await P.page.evaluate(() => localStorage.removeItem('pc.last'));
  await P.page.reload();
  await P.page.waitForSelector('.cardrow');
  const before = await P.page.locator('.cardrow').count();
  const spare = (await (await api('/api/machines')).json()).machines.find((m) => m.id !== prov.mid);
  await P.page.locator('.cardrow', { hasText: spare.name }).filter({ hasNotText: 'online' }).first().locator('[aria-label^="Options"]').click();
  await P.page.locator('#sheet').getByText('Remove runner').first().click();
  await P.page.waitForSelector('text=github.com/codespaces'); // no Codespaces access: the codespace is deleted manually
  await P.shot('4-remove');
  await P.page.locator('#sheet button.dangerfill').click();
  await P.page.waitForFunction((n) => document.querySelectorAll('.cardrow').length === n - 1, before);
  assert.equal((await (await api('/api/machines')).json()).machines.length, before - 1);
  assert.ok(await P.page.locator('text=Cloud e2e').count(), 'the runner in use is still there');
  // GitHub rejects the phone's Codespaces access (401) when starting the runner: the token is dropped & a reconnect button shows.
  await P.page.route('https://api.github.com/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Bad credentials"}' }));
  await P.page.evaluate(() => localStorage.setItem('pc.ghcs', JSON.stringify({ token: 'expired', login: 'x' })));
  await P.page.locator('.cardrow', { hasText: 'asleep' }).first().locator('.card').click();
  await P.page.waitForSelector('text=Reconnect GitHub Codespaces', { timeout: 20000 });
  assert.equal(await P.page.evaluate(() => localStorage.getItem('pc.ghcs')), null, 'the rejected token is dropped');
  await P.shot('5-reconnect');
  await P.page.unroute('https://api.github.com/**');
  // The codespace is up but snugcode inside it is dead (not online, not reporting): restarted once
  // (stop → start, postStartCommand runs the runner again); still silent → an error with log hints.
  {
    const dead = (await (await api('/api/machines')).json()).machines.find((m) => m.id !== prov.mid);
    let state = 'Available';
    const calls = [];
    await P.page.route('https://api.github.com/**', (r) => {
      const u = new URL(r.request().url());
      if (r.request().method() === 'POST') calls.push(u.pathname.split('/').pop());
      if (u.pathname.endsWith('/stop')) state = 'Shutdown';
      if (u.pathname.endsWith('/start')) state = 'Available';
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'cs-dead', state, web_url: 'https://github.com/codespaces' }) });
    });
    await P.page.evaluate((mid) => {
      localStorage.setItem('pc.ghcs', JSON.stringify({ token: 'ok', login: 'x' }));
      localStorage.setItem('pc.cloud.' + mid, JSON.stringify({ codespace: 'cs-dead' }));
      localStorage.removeItem('pc.last');
    }, dead.id);
    await P.page.reload();
    await P.page.waitForSelector('.cardrow');
    await P.page.clock.install();
    await P.page.locator('.cardrow', { hasText: 'asleep' }).first().locator('.card').click();
    await P.page.waitForSelector('text=Starting the runner');
    const tick = async (n) => {
      for (let i = 0; i < n; i++) await P.page.clock.runFor(5000), await sleep(60);
    };
    await tick(12); // > 45 seconds up without a report
    assert.deepEqual(calls, ['stop', 'start'], 'codespace restarted once: ' + calls);
    await tick(80); // > 6 minutes after the restart, still no report
    await P.page.waitForSelector('text=runner isn’t reporting');
    assert.deepEqual(calls, ['stop', 'start'], 'not restarted over and over');
    assert.ok(await P.page.getByText('Try again').count(), 'try again button');
    await P.shot('6-runner-dead');
    await P.page.unroute('https://api.github.com/**');
  }
  assert.deepEqual(P.errors, []);
  await P.page.close();
  // An account without machines: the main choice is "Use the cloud", the wizard asks for Codespaces access.
  const r2 = await fetch(`${RELAY}/auth/dev/login?kind=user&login=empty${Date.now().toString(36)}`, { redirect: 'manual' });
  const E = await open([['pc.token', JSON.stringify(decodeURIComponent(r2.headers.get('location').split('#login=')[1]))]]);
  await E.page.waitForSelector('text=No machines yet');
  await E.page.click('text=Use the cloud — no PC');
  await E.page.waitForSelector('text=Connect GitHub Codespaces');
  await E.shot('3-wizard');
  assert.deepEqual(E.errors, []);
  await browser.close();
  await sleep(3100); // the daemon allows one pairing attempt per 3 seconds
  ok('PWA: auto pairing with the runner PIN, API key sheet + detection + validation, runner menu, remove a machine from the list, reconnect Codespaces when access is rejected, codespace with a dead runner restarted, no-machines screen');
} else console.log('- Chrome not found: cloud runner PWA test skipped');

// ---------- phone: pairing with the PIN the phone generated ----------
async function phone(pin) {
  const conn = new Conn({ id: prov.mid });
  const states = [];
  let ready;
  const readyP = new Promise((res) => (ready = res));
  conn.on('state', (s) => states.push(s));
  conn.on('ready', (info) => ready(info));
  const events = [];
  conn.on('events', (msg) => events.push(...msg.es));
  conn.connect();
  await until(() => states.includes('needpin'), 'needpin');
  const pr = await conn.pair(pin);
  assert.ok(pr.ok, JSON.stringify(pr));
  return { conn, states, events, info: await readyP };
}
const A = await phone(PIN);
assert.equal(A.info.runtime, 'cloud');
assert.equal(A.info.routerConfigured, false);
assert.equal(A.info.runner.provider, 'container');
assert.equal(A.info.preventSleep, false);
assert.ok(A.info.caps.includes('configure'));
ok('phone paired with the PIN from env; info: cloud runtime, router not configured yet');

// ---------- settings from the phone ----------
const s = await A.conn.call('create', { local: repo });
await assert.rejects(A.conn.call('send', { id: s.id, text: 'hello' }), /Models & API keys/);
await assert.rejects(A.conn.call('configure', { routerKey: 'wrong' }), /Key rejected/);
await assert.rejects(A.conn.call('configure', { routerKey: KEY, routerUrl: 'ftp://x' }), /http/);
const info2 = await A.conn.call('configure', { routerKey: KEY });
assert.equal(info2.routerConfigured, true);
assert.equal(info2.model, 'claude-mock-1');
assert.ok(!JSON.stringify(info2).includes(KEY), 'the key is never returned');
await A.conn.call('attach', { id: s.id, since: 0 });
const waitEv = (pred, what) => until(() => A.events.some(pred), what, 60000);
await A.conn.call('send', { id: s.id, text: 'hello cloud' });
await waitEv((e) => e.k === 'done', 'agent done');
assert.ok(A.events.find((e) => e.k === 'done').ok, JSON.stringify(A.events.slice(-3)));
assert.ok(routerLog.some((l) => l.auth === 'Bearer ' + KEY && l.url.includes('/messages')), 'the key from the phone is used by the proxy');
ok('router key from the phone (legacy `configure` form): validated, saved, used by the agent');

// GITHUB_TOKEN from the runner environment is invisible to `!commands` and the agent process.
A.events.length = 0;
await A.conn.call('send', { id: s.id, text: '!env' });
await waitEv((e) => e.k === 'shDone', '!env done');
const out = A.events.filter((e) => e.k === 'out').map((e) => e.d).join('');
assert.match(out, /SNUGCODE_HOME=/);
assert.ok(!/LEAKED|SNUGCODE_MACHINE_TOKEN|SNUGCODE_PAIR_PIN/.test(out), 'clean env: ' + out.match(/.*(LEAKED|MACHINE_TOKEN|PAIR_PIN).*/)?.[0]);
if (process.platform === 'linux') {
  const pids = execFileSync('pgrep', ['-f', 'claude-agent-sdk-linux'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const envs = pids.map((p) => { try { return fs.readFileSync(`/proc/${p}/environ`, 'utf8'); } catch { return ''; } }).join('\n');
  assert.ok(envs.includes('SNUGCODE') || envs.includes('ANTHROPIC_BASE_URL'), 'claude process found');
  assert.ok(!envs.includes('LEAKED'), 'GITHUB_TOKEN is not in the claude process env');
}
ok('GITHUB_TOKEN/GH_TOKEN & bootstrap env are not inherited by the shell and agent');

// Devices, PIN change, revoking access — no terminal.
const devs = await A.conn.call('devices');
assert.equal(devs.length, exe ? 2 : 1, 'this phone (+ the PWA in Chromium)');
assert.equal(devs.filter((d) => d.current).length, 1);
await assert.rejects(A.conn.call('setPin', { pin: '12' }), /6–12/);
await A.conn.call('setPin', { pin: 'new99xy' });
mem = phones.b;
store.set('token', userToken);
await sleep(3100); // the daemon allows one pairing attempt per 3 seconds
const B = await phone('new99xy');
assert.equal((await B.conn.call('devices')).length, devs.length + 1);
const bId = (await B.conn.call('devices')).find((d) => d.current).id;
await A.conn.call('revoke', { id: bId });
await until(() => B.states.includes('revoked'), 'second phone revoked');
B.conn.close();
mem = phones.a;
ok('PIN changed from the phone, a second phone paired with the new PIN, then revoked from the first phone');

// runnerConfig + restart from the phone: the supervisor starts the daemon again, the phone reconnects automatically.
const rc = await A.conn.call('runnerConfig', { idleStopMinutes: 15 });
assert.equal(rc.idleStopMinutes, 15);
let readyAgain;
const again = new Promise((res) => (readyAgain = res));
A.conn.on('ready', (info) => readyAgain(info));
await A.conn.call('restart');
const info3 = await Promise.race([again, sleep(30000).then(() => null)]);
assert.ok(info3, 'reconnected after the restart\n' + rlog.slice(-2000));
assert.equal(info3.routerConfigured, true);
assert.equal(info3.runner.idleStopMinutes, 15);
assert.equal(runner.exitCode, null, 'supervisor stays alive');
ok('restart from the phone: the supervisor starts the daemon again, settings kept');

// A SIGTERM that only hits the daemon (e.g. `kill` from the agent): the supervisor starts it again, the phone reconnects.
{
  const pid = +fs.readFileSync(path.join(HOME, 'daemon.pid'), 'utf8');
  let readyAfterKill;
  const back = new Promise((res) => (readyAfterKill = res));
  A.conn.on('ready', (info) => readyAfterKill(info));
  process.kill(pid, 'SIGTERM');
  const info4 = await Promise.race([back, sleep(30000).then(() => null)]);
  assert.ok(info4, 'reconnected after the daemon got SIGTERM\n' + rlog.slice(-2000));
  assert.notEqual(+fs.readFileSync(path.join(HOME, 'daemon.pid'), 'utf8'), pid, 'new daemon');
  assert.equal(runner.exitCode, null, 'supervisor stays alive');
  ok('daemon got SIGTERM: the supervisor started it again');
}

// The supervisor stops cleanly (the container stops with it).
A.conn.close();
runner.kill('SIGTERM');
const code = await Promise.race([new Promise((res) => runner.on('exit', (c) => res(c))), sleep(10000).then(() => 'timeout')]);
assert.equal(code, 0, 'supervisor exits 0');
ok('SIGTERM: supervisor & daemon stop cleanly');

for (const m of (await (await api('/api/machines')).json()).machines) await api('/api/machines/' + m.id, { method: 'DELETE' });
router.close();
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });
console.log('\nAll cloud runner tests passed.');
process.exit(0);
