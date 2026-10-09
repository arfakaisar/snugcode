// Uji end-to-end agen: HP (web/conn.js) -> relay lokal -> daemon asli -> Claude Agent SDK -> mock 9router.
// Memeriksa kanal biner, izin dari HP, checkpoint/rewind, proses claude dipakai ulang antar prompt,
// ganti model, Stop, klien lama (frame teks), penolakan akses ~/.snugcode, dan IPC terminal.
//   Terminal 1: npm run dev:relay        (relay dev di http://127.0.0.1:8787; TOKEN_SECRET di relay/.dev.vars)
//   Terminal 2: npm run test:e2e         (Linux/macOS; butuh binary native Claude dari npm install)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { setup, ok, sleep, routerLog } from './e2e-harness.mjs';

const { HOME, repo, ref, reg, daemon, conn, Conn, events, waitFor, s, cleanup } = await setup();

// Prompt 1: agen menulis file -> izin dari HP -> checkpoint -> selesai
const claudePids = () => {
  try {
    return execFileSync('pgrep', ['-P', String(daemon.pid), '-f', 'claude-agent-sdk-linux'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
// Mode tinjau edit: Write menunggu izin dari HP (dengan cuplikan diff).
await conn.call('edits', { id: s.id, on: true });
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

// Bawaan (tinjau edit mati): Write di worktree langsung diterapkan tanpa prompt izin
await conn.call('edits', { id: s.id, on: false });
events.length = 0;
await conn.call('send', { id: s.id, text: 'tolong WRITE2 file' });
assert.ok((await waitFor((e) => e.k === 'done')).ok);
assert.ok(!events.some((e) => e.k === 'perm'), 'tidak ada prompt izin');
assert.equal(fs.readFileSync(path.join(repo, 'hasil2.txt'), 'utf8'), 'langsung\n');
ok('tinjau edit mati: Write di worktree langsung diterapkan (checkpoint tetap dibuat)');

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
ok('Read ~/.snugcode/secrets.json ditolak walau auto-izin: ' + res3.d.slice(0, 80));

// Pesan > 1MB lewat kanal biner (dipecah per 256KB)
fs.writeFileSync(path.join(repo, 'big.txt'), ('y'.repeat(99) + '\n').repeat(15000));
const diff = await conn.call('diff', { id: s.id });
assert.ok(diff.diff.length > 1_400_000, 'diff ' + diff.diff.length);
ok(`diff ${(diff.diff.length / 1e6).toFixed(2)} MB diterima utuh lewat kanal biner (dulu dipotong 400KB)`);

// Ganti model -> diterapkan ke proses claude yang sama (tanpa spawn + resume)
await waitFor((e) => e.k === 'status' && e.s === 'idle');
await conn.call('setSessionModel', { id: s.id, model: 'claude-mock-2' });
events.length = 0;
await conn.call('send', { id: s.id, text: 'halo model baru' });
const done4 = await waitFor((e) => e.k === 'done');
assert.ok(done4.ok);
await sleep(300);
const pids4 = claudePids();
assert.deepEqual(pids4, pids2, 'proses claude tetap sama');
assert.equal(routerLog.filter((l) => l.url.includes('/messages') && l.model).at(-1).model, 'claude-mock-2');
ok('ganti model: proses claude yang sama langsung memakai model baru');

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
assert.ok(!fs.existsSync(path.join(repo, 'hasil2.txt')));
ok(`rewind: ${nRw} file dikembalikan, hasil.txt hilang`);

// Index atomik & daftar sesi
const idx = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', 'index.json'), 'utf8'));
assert.equal(idx[0].id, s.id);
ok('index.json valid');

// Terminal (IPC lokal, seperti TUI) memakai tabel RPC yang sama; shutdown hanya dari terminal
await assert.rejects(conn.call('shutdown'), /Hanya dari terminal/);
const net = await import('node:net');
// Sama dengan IPC_PATH di daemon/config.js: named pipe di Windows, unix socket di macOS/Linux.
const IPC = process.platform === 'win32' ? '\\\\.\\pipe\\pocketcode-' +createHash('sha1').update(HOME.toLowerCase()).digest('hex').slice(0, 12) : path.join(HOME, 'daemon.sock');
const sock = net.connect(IPC);
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

// Daemon berhenti: proses claude anaknya ikut keluar (tidak tertinggal sebagai yatim).
const children = claudePids();
const ctx = { cleanup };
conn.close();
daemon.kill('SIGTERM');
await new Promise((r) => daemon.on('exit', r));
await sleep(500);
const alive = children.filter((pid) => {
  try {
    process.kill(+pid, 0);
    return true;
  } catch {
    return false;
  }
});
assert.deepEqual(alive, [], 'proses claude tertinggal setelah daemon berhenti');
ok(`daemon berhenti rapi, ${children.length} proses claude ikut keluar`);
await ctx.cleanup();
process.exit(0);
