// Uji end-to-end agen: HP (web/conn.js) -> relay lokal -> daemon asli -> Claude Agent SDK -> mock 9router.
// Memeriksa kanal biner, izin dari HP, checkpoint/rewind, proses claude dipakai ulang antar prompt,
// ganti model, Stop, klien lama (frame teks), penolakan akses ~/.pocketcode, dan IPC terminal.
//   Terminal 1: npm run dev:relay        (relay dev di http://127.0.0.1:8787; TOKEN_SECRET di relay/.dev.vars)
//   Terminal 2: node test/e2e-agent.mjs  (Linux/macOS; butuh binary native Claude dari npm install)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as C from '../shared/crypto.js';
import http from 'node:http';

// ---------- mock 9router (Anthropic Messages API, streaming) ----------
// Prompt berisi WRITE -> tool_use Write; SLOW -> jawaban lambat; READSECRET -> Read secrets.json.
const routerLog = [];
let n = 0;
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
function textMsg(model, text) {
  const id = 'msg_' + ++n;
  return [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...text.match(/.{1,6}/gs).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}
function toolMsg(model, name, input) {
  const id = 'msg_' + ++n;
  return [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + n, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}
const textOf = (c) => (typeof c === 'string' ? c : (c || []).map((b) => b.text || '').join(' '));
function startMockRouter(cwdRef) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      routerLog.push({ url: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'] });
      if (!req.url.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 10, data: [] }));
      }
      let j = {};
      try { j = JSON.parse(body); } catch {}
      const model = j.model || 'x';
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const hasResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
      const lastText = JSON.stringify(msgs.filter((m) => m.role === 'user').at(-1) || '');
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      }
      if (hasResult || lastText.includes('"type":"tool_result"')) return sse(res, textMsg(model, 'Selesai menulis file.\n\nBaris **dua**.'));
      if (/SLOW/.test(lastText)) {
        const ev = textMsg(model, 'x'.repeat(600));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const t = setInterval(() => {
          if (i >= ev.length) return clearInterval(t), res.end();
          res.write(`event: ${ev[i].type}\ndata: ${JSON.stringify(ev[i])}\n\n`);
          i++;
        }, 200);
        res.on('close', () => clearInterval(t));
        return;
      }
      if (/READSECRET/.test(lastText)) return sse(res, toolMsg(model, 'Read', { file_path: cwdRef.secrets }));
      if (/WRITE/.test(lastText)) return sse(res, toolMsg(model, 'Write', { file_path: cwdRef.cwd + '/hasil.txt', content: 'dibuat agen\n' }));
      return sse(res, textMsg(model, 'Halo dari mock router.'));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const RELAY = process.env.RELAY || 'http://127.0.0.1:8787';
const PIN = 'moon42';
const ok = (m) => console.log('✔ ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(100) + '\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
const ref = { cwd: repo, secrets: path.join(HOME, 'secrets.json') };
const router = await startMockRouter(ref);

// --- registrasi PC di relay dev ---
const { code } = await (await fetch(RELAY + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: 'e2e-pc' }) })).json();
await fetch(`${RELAY}/auth/dev/login?kind=machine&pc=${code}&login=tester`);
const reg = await (await fetch(`${RELAY}/auth/machine/poll?code=${code}`)).json();
assert.equal(reg.status, 'ok');
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ relayUrl: RELAY, routerUrl: `http://127.0.0.1:${router.address().port}/v1`, machineName: 'e2e-pc', machineId: reg.mid, model: 'claude-mock-1' }));
fs.writeFileSync(ref.secrets, JSON.stringify({ machineToken: reg.token, prs: C.bytesToHex(await C.pinToPrs(PIN, reg.mid)), routerKey: 'ROUTER-KEY-ASLI', devices: {}, pinFails: 0, githubToken: null }));
// Env Claude Code/Anthropic milik shell pemanggil (mis. dijalankan dari dalam Claude Code) tidak ikut ke daemon uji.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/.test(k)));
const DAEMON = `
  const { loadConfig } = await import(${JSON.stringify(new URL('../daemon/config.js', import.meta.url).href)});
  const { Daemon } = await import(${JSON.stringify(new URL('../daemon/server.js', import.meta.url).href)});
  const d = new Daemon(loadConfig(), { log: (m) => console.log('[daemon]', m) });
  d.start();
  process.on('SIGTERM', () => Promise.resolve(d.stop()).finally(() => process.exit(0)));`;
const daemon = spawn(process.execPath, ['--input-type=module', '-e', DAEMON], { env: { ...cleanEnv, POCKETCODE_HOME: HOME, POCKETCODE_DEBUG: process.env.DEBUG || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let dlog = '';
process.on('exit', () => daemon.exitCode === null && daemon.kill('SIGKILL'));
daemon.stdout.on('data', (d) => (dlog += d));
daemon.stderr.on('data', (d) => (dlog += d));
for (let i = 0; i < 50 && !/Terhubung ke relay/.test(dlog); i++) await sleep(200);
assert.match(dlog, /Terhubung ke relay/);
ok('daemon tersambung ke relay');

// --- HP: web/conn.js di Node ---
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.location = { protocol: 'http:', host: '127.0.0.1:8787' };
const { Conn, store } = await import('../web/conn.js');
const r = await fetch(`${RELAY}/auth/dev/login?kind=user&login=tester`, { redirect: 'manual' });
store.set('token', decodeURIComponent(r.headers.get('location').split('#login=')[1]));
const conn = new Conn({ id: reg.mid });
const states = [];
let ready;
const readyP = new Promise((res) => (ready = res));
conn.on('state', (s) => states.push(s));
conn.on('ready', (info) => ready(info));
const events = [];
let onEv = null;
conn.on('events', (msg) => {
  events.push(...msg.es);
  onEv?.();
});
conn.connect();
for (let i = 0; i < 50 && !states.includes('needpin'); i++) await sleep(100);
assert.ok(states.includes('needpin'), 'needpin: ' + states);
const pr = await conn.pair(PIN);
assert.ok(pr.ok, JSON.stringify(pr));
const info = await readyP;
assert.equal(conn.bin, true, 'kanal biner disepakati');
assert.equal(info.proto, 2);
ok('pairing PIN + auth, kanal biner aktif (proto ' + info.proto + ')');

const waitFor = async (pred, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const e = events.find(pred);
    if (e) return e;
    await new Promise((res) => {
      onEv = res;
      setTimeout(res, 200);
    });
  }
  throw new Error('timeout menunggu event; events=' + JSON.stringify(events).slice(0, 1500) + ' router=' + JSON.stringify(routerLog).slice(0, 800) + '\ndaemon log:\n' + dlog.slice(-3000));
};

const s = await conn.call('create', { local: repo });
const att = await conn.call('attach', { id: s.id, since: 0 });
ok('sesi lokal dibuat & attach (' + att.events.length + ' event)');

// Prompt 1: agen menulis file -> izin dari HP -> checkpoint -> selesai
const claudePids = () => {
  try {
    return execFileSync('pgrep', ['-P', String(daemon.pid), '-f', 'claude-agent-sdk-linux'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
let t0 = Date.now();
await conn.call('send', { id: s.id, text: 'tolong WRITE file' });
const perm = await waitFor((e) => e.k === 'perm');
assert.equal(perm.tool, 'Write');
await conn.call('perm', { id: s.id, pid: perm.pid, decision: 'allow' });
const done1 = await waitFor((e) => e.k === 'done');
assert.ok(done1.ok, JSON.stringify(done1));
const t1 = Date.now() - t0;
assert.equal(fs.readFileSync(path.join(repo, 'hasil.txt'), 'utf8'), 'dibuat agen\n');
assert.ok(events.some((e) => e.k === 'cp'), 'checkpoint tersimpan');
assert.match(events.filter((e) => e.k === 'text').map((e) => e.d).join(''), /Selesai menulis file/);
const pids1 = claudePids();
ok(`prompt 1: izin Write dari HP, file ditulis, checkpoint ada (${t1} ms), proses claude: ${pids1.length}`);

// Prompt 2: proses claude yang sama dipakai ulang
await waitFor((e) => e.k === 'status' && e.s === 'idle');
events.length = 0;
t0 = Date.now();
await conn.call('send', { id: s.id, text: 'halo lagi' });
const done2 = await waitFor((e) => e.k === 'done');
const t2 = Date.now() - t0;
assert.ok(done2.ok);
const pids2 = claudePids();
assert.deepEqual(pids2, pids1, 'proses claude sama');
ok(`prompt 2 memakai proses claude yang sama (${t2} ms vs ${t1} ms)`);

// Key 9router asli hanya dilihat router (lewat proxy), bukan proses claude
assert.ok(routerLog.length && routerLog.every((l) => l.auth === 'Bearer ROUTER-KEY-ASLI' && !l.key), JSON.stringify(routerLog.slice(0, 3)));
if (process.platform === 'linux') {
  const envOfClaude = pids2.map((p) => fs.readFileSync(`/proc/${p}/environ`, 'utf8')).join('\n');
  assert.ok(!envOfClaude.includes('ROUTER-KEY-ASLI'), 'key asli tidak ada di env proses claude');
  assert.match(envOfClaude, /ANTHROPIC_AUTH_TOKEN=pc-local-/);
}
ok('key 9router tidak ada di env proses claude; proxy menyuntikkannya ke router');

// Prompt 3: agen mencoba membaca secrets.json -> ditolak otomatis (walau auto-izin aktif)
await waitFor((e) => e.k === 'status' && e.s === 'idle');
await conn.call('auto', { id: s.id, on: true });
events.length = 0;
await conn.call('send', { id: s.id, text: 'READSECRET sekarang' });
const res3 = await waitFor((e) => e.k === 'result');
assert.equal(res3.ok, false);
assert.match(res3.d, /kredensial|tidak boleh/);
await waitFor((e) => e.k === 'done');
ok('Read ~/.pocketcode/secrets.json ditolak walau auto-izin: ' + res3.d.slice(0, 80));

// Pesan > 1MB lewat kanal biner (dipecah per 256KB)
fs.writeFileSync(path.join(repo, 'big.txt'), ('y'.repeat(99) + '\n').repeat(15000));
const diff = await conn.call('diff', { id: s.id });
assert.ok(diff.diff.length > 1_400_000, 'diff ' + diff.diff.length);
ok(`diff ${(diff.diff.length / 1e6).toFixed(2)} MB diterima utuh lewat kanal biner (dulu dipotong 400KB)`);

// Ganti model -> proses baru dengan resume
await waitFor((e) => e.k === 'status' && e.s === 'idle');
await conn.call('setSessionModel', { id: s.id, model: 'claude-mock-2' });
events.length = 0;
await conn.call('send', { id: s.id, text: 'halo model baru' });
const done4 = await waitFor((e) => e.k === 'done');
assert.ok(done4.ok);
await sleep(300);
const pids4 = claudePids();
assert.equal(pids4.length, 1, 'proses lama ditutup: ' + pids4);
assert.notDeepEqual(pids4, pids2);
ok('ganti model: proses lama ditutup, proses baru melanjutkan percakapan');

// Stop di tengah jawaban: agen berhenti cepat, proses tetap bisa dipakai prompt berikutnya
await waitFor((e) => e.k === 'status' && e.s === 'idle');
await conn.call('auto', { id: s.id, on: false });
events.length = 0;
await conn.call('send', { id: s.id, text: 'SLOW tolong' });
await waitFor((e) => e.k === 'text');
const tStop = Date.now();
await conn.call('interrupt', { id: s.id });
await waitFor((e) => e.k === 'status' && e.s === 'idle', 15000);
const stopMs = Date.now() - tStop;
events.length = 0;
await conn.call('send', { id: s.id, text: 'halo setelah stop' });
assert.ok((await waitFor((e) => e.k === 'done')).ok);
ok(`Stop: agen berhenti dalam ${stopMs} ms, prompt berikutnya tetap jalan`);

// Klien lama (frame teks, tanpa kanal biner) tetap dilayani; batas 1MB relay tetap dihormati
const conn2 = new Conn({ id: reg.mid });
const orig = conn2.onFrame.bind(conn2);
conn2.onFrame = (raw) => orig(raw.replace(',"bin":1', ''));
let ready2;
const ready2P = new Promise((res) => (ready2 = res));
conn2.on('ready', (i) => ready2(i));
conn2.connect();
await ready2P;
assert.equal(conn2.bin, false);
const diff2 = await conn2.call('diff', { id: s.id });
assert.ok(diff2.truncated && diff2.diff.length <= 400 * 1024);
assert.equal((await conn2.call('sessions')).length, 1);
conn2.close();
ok('klien lama (frame teks) tetap berfungsi; diff dipotong 400KB sesuai batas frame');

// Rewind ke sebelum prompt 1
const hist = await conn.call('attach', { id: s.id, since: 0 });
const u1 = hist.events.find((e) => e.k === 'user' && /WRITE/.test(e.d));
const nRw = await conn.call('rewind', { id: s.id, seq: u1.seq });
assert.ok(!fs.existsSync(path.join(repo, 'hasil.txt')));
ok(`rewind: ${nRw} file dikembalikan, hasil.txt hilang`);

// Index atomik & daftar sesi
const idx = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', 'index.json'), 'utf8'));
assert.equal(idx[0].id, s.id);
ok('index.json valid');

// Terminal (IPC lokal, seperti TUI) memakai tabel RPC yang sama; shutdown hanya dari terminal
await assert.rejects(conn.call('shutdown'), /Hanya dari terminal/);
const net = await import('node:net');
const sock = net.connect(path.join(HOME, 'daemon.sock'));
const lines = [];
let lineWake;
let lbuf = '';
sock.on('data', (d) => {
  lbuf += d;
  let i;
  while ((i = lbuf.indexOf('\n')) >= 0) (lines.push(JSON.parse(lbuf.slice(0, i))), (lbuf = lbuf.slice(i + 1)));
  lineWake?.();
});
const nextLine = async (pred) => {
  for (;;) {
    const i = lines.findIndex(pred);
    if (i >= 0) return lines.splice(i, 1)[0];
    await new Promise((r) => (lineWake = r));
  }
};
const localToken = JSON.parse(fs.readFileSync(ref.secrets, 'utf8')).localToken;
sock.write(JSON.stringify({ t: 'hello', token: localToken }) + '\n');
const rd = await nextLine((l) => l.ev === 'ready');
assert.equal(rd.info.proto, 2);
sock.write(JSON.stringify({ id: 1, m: 'sessions' }) + '\n');
assert.equal((await nextLine((l) => l.id === 1)).r.length, 1);
sock.write(JSON.stringify({ id: 2, m: 'tidakAda' }) + '\n');
assert.match((await nextLine((l) => l.id === 2)).err, /Metode tidak dikenal/);
sock.write(JSON.stringify({ id: 3, m: 'constructor' }) + '\n');
assert.match((await nextLine((l) => l.id === 3)).err, /Metode tidak dikenal/);
sock.end();
ok('terminal (IPC lokal): ready + RPC jalan; metode asing & prototype ditolak; shutdown dari HP ditolak');

conn.close();
daemon.kill('SIGTERM');
await new Promise((r) => daemon.on('exit', r));
await sleep(500);
let left = [];
try { left = execFileSync('pgrep', ['-f', 'claude-agent-sdk-linux'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch {}
assert.equal(left.length, 0, 'semua proses claude mati bersama daemon: ' + left);
ok('daemon berhenti rapi, tidak ada proses claude tertinggal');
router.close();
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });
if (process.env.DEBUG) console.log(dlog);
process.exit(0);
