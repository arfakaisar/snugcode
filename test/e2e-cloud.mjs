// Uji end-to-end runner cloud (tanpa PC): PWA mendaftarkan mesin lewat /api/machines/provision,
// `snugcode cloud` berjalan dari env saja (seperti di Codespaces/Docker), HP memasangkan diri dengan
// PIN yang dibuatnya sendiri, lalu seluruh setelan (key 9router, PIN, perangkat) diatur dari HP.
// Juga memastikan GITHUB_TOKEN dari environment tidak terlihat oleh agen/shell, dan restart dari HP
// ditangani supervisor.
//   Terminal 1: npm run dev:relay      Terminal 2: npm run test:e2e:cloud
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { RELAY, ok, sleep, startMockRouter, routerLog } from './e2e-harness.mjs';

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

// ---------- HP: login + daftarkan runner ----------
// localStorage per "HP": HP kedua (uji ganti PIN/cabut akses) punya penyimpanan sendiri.
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
assert.equal((await fetch(RELAY + '/api/machines/provision', { method: 'POST' })).status, 401, 'provision tanpa login ditolak');
const prov = await (await api('/api/machines/provision', { method: 'POST', body: JSON.stringify({ name: 'Cloud e2e', provider: 'codespace' }) })).json();
assert.ok(prov.token && prov.mid, JSON.stringify(prov));
let { machines } = await (await api('/api/machines')).json();
assert.deepEqual(machines.map((m) => [m.id, m.kind, m.provider, m.online]), [[prov.mid, 'cloud', 'codespace', false]]);
for (let i = 0; i < 2; i++) await api('/api/machines/provision', { method: 'POST', body: '{}' });
assert.equal((await api('/api/machines/provision', { method: 'POST', body: '{}' })).status, 409, 'batas runner cloud per akun');
ok('provision: mesin cloud terdaftar tanpa login dari mesinnya; batas per akun berlaku');

// ---------- runner: hanya env, tanpa setup interaktif ----------
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
  GITHUB_TOKEN: 'ghs_BOCOR_DARI_CODESPACES',
  GH_TOKEN: 'gho_BOCOR_JUGA',
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
  throw new Error('timeout: ' + what + '\nlog runner:\n' + rlog.slice(-3000));
};
await until(() => /Terhubung ke relay/.test(rlog), 'runner tersambung');
const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
assert.equal(cfg.runtime, 'cloud');
assert.equal(cfg.machineId, prov.mid);
assert.match(rlog, /Key 9router belum diisi/);
({ machines } = await (await api('/api/machines')).json());
assert.equal(machines.find((m) => m.id === prov.mid).online, true);
ok('snugcode cloud: konfigurasi dari env, tersambung ke relay tanpa key 9router');

// ---------- HP: pairing dengan PIN yang dibuat HP ----------
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
ok('HP terpasang dengan PIN dari env; info: runtime cloud, router belum dikonfigurasi');

// ---------- setelan dari HP ----------
const s = await A.conn.call('create', { local: repo });
await assert.rejects(A.conn.call('send', { id: s.id, text: 'halo' }), /Key 9router belum diisi/);
await assert.rejects(A.conn.call('configure', { routerKey: 'salah' }), /Key ditolak router/);
await assert.rejects(A.conn.call('configure', { routerKey: KEY, routerUrl: 'ftp://x' }), /http/);
const info2 = await A.conn.call('configure', { routerKey: KEY });
assert.equal(info2.routerConfigured, true);
assert.equal(info2.model, 'claude-mock-1');
assert.ok(!JSON.stringify(info2).includes(KEY), 'key tidak pernah dikembalikan');
await A.conn.call('attach', { id: s.id, since: 0 });
const waitEv = (pred, what) => until(() => A.events.some(pred), what, 60000);
await A.conn.call('send', { id: s.id, text: 'halo cloud' });
await waitEv((e) => e.k === 'done', 'agen selesai');
assert.ok(A.events.find((e) => e.k === 'done').ok, JSON.stringify(A.events.slice(-3)));
assert.ok(routerLog.some((l) => l.auth === 'Bearer ' + KEY && l.url.includes('/messages')), 'key dari HP dipakai proxy');
ok('key 9router dari HP: divalidasi, disimpan, dipakai agen');

// GITHUB_TOKEN dari environment runner tidak terlihat oleh `!perintah` maupun proses agen.
A.events.length = 0;
await A.conn.call('send', { id: s.id, text: '!env' });
await waitEv((e) => e.k === 'shDone', '!env selesai');
const out = A.events.filter((e) => e.k === 'out').map((e) => e.d).join('');
assert.match(out, /SNUGCODE_HOME=/);
assert.ok(!/BOCOR|SNUGCODE_MACHINE_TOKEN|SNUGCODE_PAIR_PIN/.test(out), 'env bersih: ' + out.match(/.*(BOCOR|MACHINE_TOKEN|PAIR_PIN).*/)?.[0]);
if (process.platform === 'linux') {
  const pids = execFileSync('pgrep', ['-f', 'claude-agent-sdk-linux'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const envs = pids.map((p) => { try { return fs.readFileSync(`/proc/${p}/environ`, 'utf8'); } catch { return ''; } }).join('\n');
  assert.ok(envs.includes('SNUGCODE') || envs.includes('ANTHROPIC_BASE_URL'), 'proses claude ditemukan');
  assert.ok(!envs.includes('BOCOR'), 'GITHUB_TOKEN tidak ada di env proses claude');
}
ok('GITHUB_TOKEN/GH_TOKEN & env bootstrap tidak terwariskan ke shell dan agen');

// Perangkat, ganti PIN, cabut akses — tanpa terminal.
const devs = await A.conn.call('devices');
assert.equal(devs.length, 1);
assert.equal(devs[0].current, true);
await assert.rejects(A.conn.call('setPin', { pin: '12' }), /6–12/);
await A.conn.call('setPin', { pin: 'baru99x' });
mem = phones.b;
store.set('token', userToken);
await sleep(3100); // daemon membatasi satu percobaan pairing per 3 detik
const B = await phone('baru99x');
assert.equal((await B.conn.call('devices')).length, 2);
const bId = (await A.conn.call('devices')).find((d) => !d.current).id;
await A.conn.call('revoke', { id: bId });
await until(() => B.states.includes('revoked'), 'HP kedua dicabut');
B.conn.close();
mem = phones.a;
ok('ganti PIN dari HP, HP kedua terpasang dengan PIN baru, lalu dicabut dari HP pertama');

// runnerConfig + restart dari HP: supervisor menyalakan daemon lagi, HP tersambung ulang otomatis.
const rc = await A.conn.call('runnerConfig', { idleStopMinutes: 15 });
assert.equal(rc.idleStopMinutes, 15);
let readyAgain;
const again = new Promise((res) => (readyAgain = res));
A.conn.on('ready', (info) => readyAgain(info));
await A.conn.call('restart');
const info3 = await Promise.race([again, sleep(30000).then(() => null)]);
assert.ok(info3, 'tersambung lagi setelah restart\n' + rlog.slice(-2000));
assert.equal(info3.routerConfigured, true);
assert.equal(info3.runner.idleStopMinutes, 15);
assert.equal(runner.exitCode, null, 'supervisor tetap hidup');
ok('restart dari HP: supervisor menyalakan daemon lagi, setelan tetap');

// Supervisor berhenti rapi (container ikut berhenti).
A.conn.close();
runner.kill('SIGTERM');
const code = await Promise.race([new Promise((res) => runner.on('exit', (c) => res(c))), sleep(10000).then(() => 'timeout')]);
assert.equal(code, 0, 'supervisor keluar 0');
ok('SIGTERM: supervisor & daemon berhenti rapi');

for (const m of (await (await api('/api/machines')).json()).machines) await api('/api/machines/' + m.id, { method: 'DELETE' });
router.close();
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });
console.log('\nSemua uji runner cloud lulus.');
process.exit(0);
