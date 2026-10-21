// Agent end-to-end test: phone (web/conn.js) -> local relay -> real daemon -> Claude Agent SDK -> mock 9router.
// Checks the binary channel, permissions from the phone, checkpoint/rewind, the claude process reused across prompts,
// model switching, Stop, old clients (text frames), denied access to ~/.snugcode, and terminal IPC.
//   Terminal 1: npm run dev:relay        (dev relay at http://127.0.0.1:8787; TOKEN_SECRET in relay/.dev.vars)
//   Terminal 2: npm run test:e2e         (Linux/macOS; needs the native Claude binary from npm install)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { setup, ok, sleep, routerLog } from './e2e-harness.mjs';

const { HOME, repo, ref, reg, daemon, conn, Conn, events, waitFor, s, cleanup } = await setup();

// Prompt 1: the agent writes a file -> permission from the phone -> checkpoint -> done
const claudePids = () => {
  try {
    return execFileSync('pgrep', ['-P', String(daemon.pid), '-f', 'claude-agent-sdk-linux'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
// Edit review mode: Write waits for permission from the phone (with a diff snippet).
await conn.call('edits', { id: s.id, on: true });
let t0 = Date.now();
await conn.call('send', { id: s.id, text: 'please WRITE a file' });
const perm = await waitFor((e) => e.k === 'perm');
assert.equal(perm.tool, 'Write');
await conn.call('perm', { id: s.id, pid: perm.pid, decision: 'allow' });
const done1 = await waitFor((e) => e.k === 'done');
assert.ok(done1.ok, JSON.stringify(done1));
const t1 = Date.now() - t0;
assert.equal(fs.readFileSync(path.join(repo, 'result.txt'), 'utf8'), 'made by the agent\n');
assert.ok(events.some((e) => e.k === 'cp'), 'checkpoint saved');
assert.match(events.filter((e) => e.k === 'text').map((e) => e.d).join(''), /Finished writing the file/);
const pids1 = claudePids();
ok(`prompt 1: Write permission from the phone, file written, checkpoint exists (${t1} ms), claude processes: ${pids1.length}`);

// Prompt 2: the same claude process is reused
await waitFor((e) => e.k === 'status' && e.s === 'idle');
events.length = 0;
t0 = Date.now();
await conn.call('send', { id: s.id, text: 'hello again' });
const done2 = await waitFor((e) => e.k === 'done');
const t2 = Date.now() - t0;
assert.ok(done2.ok);
const pids2 = claudePids();
assert.deepEqual(pids2, pids1, 'same claude process');
ok(`prompt 2 uses the same claude process (${t2} ms vs ${t1} ms)`);

// Default (edit review off): Write in the worktree applies directly without a permission prompt
await conn.call('edits', { id: s.id, on: false });
events.length = 0;
await conn.call('send', { id: s.id, text: 'please WRITE2 a file' });
assert.ok((await waitFor((e) => e.k === 'done')).ok);
assert.ok(!events.some((e) => e.k === 'perm'), 'no permission prompt');
assert.equal(fs.readFileSync(path.join(repo, 'result2.txt'), 'utf8'), 'direct\n');
ok('edit review off: Write in the worktree applies directly (a checkpoint is still made)');

// The real 9router key is only seen by the router (through the proxy), not by the claude process
assert.ok(routerLog.length && routerLog.every((l) => l.auth === 'Bearer ROUTER-KEY-REAL' && !l.key), JSON.stringify(routerLog.slice(0, 3)));
if (process.platform === 'linux') {
  const envOfClaude = pids2.map((p) => fs.readFileSync(`/proc/${p}/environ`, 'utf8')).join('\n');
  assert.ok(!envOfClaude.includes('ROUTER-KEY-REAL'), 'the real key is not in the claude process env');
  assert.match(envOfClaude, /ANTHROPIC_AUTH_TOKEN=pc-local-/);
}
ok('the 9router key is not in the claude process env; the proxy injects it for the router');

// Prompt 3: the agent tries to read secrets.json -> denied automatically (even with auto-approve on)
await waitFor((e) => e.k === 'status' && e.s === 'idle');
await conn.call('auto', { id: s.id, on: true });
events.length = 0;
await conn.call('send', { id: s.id, text: 'READSECRET now' });
const res3 = await waitFor((e) => e.k === 'result');
assert.equal(res3.ok, false);
assert.match(res3.d, /credentials|may not be accessed/);
await waitFor((e) => e.k === 'done');
ok('Read ~/.snugcode/secrets.json denied even under auto-approve: ' + res3.d.slice(0, 80));

// Auto-approve: Bash runs in the OS sandbox, which denies reading the data folder (if the sandbox is available).
const { sandboxSupport } = await import('../daemon/sandbox.js');
const support = await sandboxSupport();
events.length = 0;
await conn.call('send', { id: s.id, text: 'BASHSECRET now' });
const res5 = await waitFor((e) => e.k === 'result' || e.k === 'perm');
if (support.ok) {
  assert.equal(res5.k, 'result', 'auto-approved Bash passes without asking');
  assert.doesNotMatch(JSON.stringify(res5), /ROUTER-KEY-REAL|machineToken/);
  assert.match(res5.d, /Permission denied|No such file/);
  ok('auto-approved Bash in the OS sandbox: `cat <data>/s*.json` denied (' + res5.d.split('\n')[0].slice(0, 60) + ')');
} else {
  if (res5.k === 'perm') await conn.call('perm', { id: s.id, pid: res5.pid, decision: 'deny' });
  console.log('… OS sandbox unavailable (' + support.reason + '): sandboxed auto-approve Bash test skipped');
}
await waitFor((e) => e.k === 'done');

// A message > 1MB over the binary channel (split into 256KB pieces)
fs.writeFileSync(path.join(repo, 'big.txt'), ('y'.repeat(99) + '\n').repeat(15000));
const diff = await conn.call('diff', { id: s.id });
assert.ok(diff.diff.length > 1_400_000, 'diff ' + diff.diff.length);
ok(`${(diff.diff.length / 1e6).toFixed(2)} MB diff received whole over the binary channel (formerly cut at 400KB)`);

// Switch model -> applied to the same claude process (no spawn + resume)
await waitFor((e) => e.k === 'status' && e.s === 'idle');
await conn.call('setSessionModel', { id: s.id, model: 'claude-mock-2' });
events.length = 0;
await conn.call('send', { id: s.id, text: 'hello new model' });
const done4 = await waitFor((e) => e.k === 'done');
assert.ok(done4.ok);
await sleep(300);
const pids4 = claudePids();
// Auto-approve with the OS sandbox starts a new claude process (sandbox options per process); without a sandbox it stays the same.
if (!support.ok) assert.deepEqual(pids4, pids2, 'the claude process stays the same');
assert.equal(pids4.length, 1, 'one claude process');
assert.equal(routerLog.filter((l) => l.url.includes('/messages') && l.model).at(-1).model, 'claude-mock-2');
ok('model switch: the same claude process uses the new model right away');

// Stop mid-reply: the agent stops quickly, the process can still serve the next prompt
await waitFor((e) => e.k === 'status' && e.s === 'idle');
await conn.call('auto', { id: s.id, on: false });
events.length = 0;
await conn.call('send', { id: s.id, text: 'SLOW please' });
await waitFor((e) => e.k === 'text');
const tStop = Date.now();
await conn.call('interrupt', { id: s.id });
await waitFor((e) => e.k === 'status' && e.s === 'idle', 15000);
const stopMs = Date.now() - tStop;
events.length = 0;
await conn.call('send', { id: s.id, text: 'hello after stop' });
assert.ok((await waitFor((e) => e.k === 'done')).ok);
ok(`Stop: the agent stopped within ${stopMs} ms, the next prompt still runs`);

// Old clients (text frames, no binary channel) are still served; the relay's 1MB limit is still respected
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
ok('old clients (text frames) still work; the diff is cut at 400KB per the frame limit');

// Rewind to before prompt 1
const hist = await conn.call('attach', { id: s.id, since: 0 });
const u1 = hist.events.find((e) => e.k === 'user' && /WRITE/.test(e.d));
const nRw = await conn.call('rewind', { id: s.id, seq: u1.seq });
assert.ok(!fs.existsSync(path.join(repo, 'result.txt')));
assert.ok(!fs.existsSync(path.join(repo, 'result2.txt')));
ok(`rewind: ${nRw} file(s) restored, result.txt gone`);

// Atomic index & session list
const idx = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', 'index.json'), 'utf8'));
assert.equal(idx[0].id, s.id);
ok('index.json valid');

// The terminal (local IPC, like the TUI) uses the same RPC table; shutdown only from the terminal
await assert.rejects(conn.call('shutdown'), /Only from the PC terminal/);
const net = await import('node:net');
// Same as IPC_PATH in daemon/config.js: a named pipe on Windows, a unix socket on macOS/Linux.
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
sock.write(JSON.stringify({ id: 2, m: 'doesNotExist' }) + '\n');
assert.match((await nextLine((l) => l.id === 2)).err, /Unknown method/);
sock.write(JSON.stringify({ id: 3, m: 'constructor' }) + '\n');
assert.match((await nextLine((l) => l.id === 3)).err, /Unknown method/);
sock.end();
ok('terminal (local IPC): ready + RPC works; unknown methods & prototype rejected; shutdown from the phone rejected');

// The daemon stops: its child claude processes exit too (not left behind as orphans).
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
assert.deepEqual(alive, [], 'claude processes left behind after the daemon stopped');
ok(`daemon stopped cleanly, ${children.length} claude process(es) exited with it`);
await ctx.cleanup();
process.exit(0);
