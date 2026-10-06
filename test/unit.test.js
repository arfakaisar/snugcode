import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/crypto.js';
import { toolSummary } from '../daemon/sessions.js';

test('pairing PIN: benar -> secret sama, salah -> ditolak di HP', async () => {
  const prs = await C.pinToPrs('123456', 'm1');
  const p1 = C.pairStartPhone(prs);
  const m1 = C.pairRespondMachine(prs, p1.msg);
  const p2 = C.pairFinishPhone(p1.state, m1.msg);
  assert.ok(p2);
  assert.deepEqual(C.pairVerifyMachine(m1.state, p2.msg), p2.deviceSecret);

  const bad = C.pairStartPhone(await C.pinToPrs('654321', 'm1'));
  assert.equal(C.pairFinishPhone(bad.state, C.pairRespondMachine(prs, bad.msg).msg), null);
});

test('kanal sesi: enkripsi dua arah + anti replay + secret salah ditolak', () => {
  const secret = C.randomBytes(32);
  const a = C.authStartPhone();
  const b = C.authRespondMachine(secret, a.msg);
  assert.equal(C.authFinishPhone(C.randomBytes(32), a.state, b.msg), null);
  const fin = C.authFinishPhone(secret, a.state, b.msg);
  const m = C.authVerifyMachine(b.state, fin.msg);
  const f = fin.channel.seal({ x: 1 });
  assert.deepEqual(m.open(f), { x: 1 });
  assert.throws(() => m.open(f), /replay/);
  assert.deepEqual(fin.channel.open(m.seal('ok')), 'ok');
});

test('toolSummary: path di dalam worktree jadi relatif', () => {
  const cwd = String.raw`C:\Users\a\ws\s-1`;
  assert.equal(toolSummary('Read', { file_path: String.raw`C:\Users\a\ws\s-1\src\x.js` }, cwd), 'src/x.js');
  assert.equal(toolSummary('Bash', { command: 'cat C:/Users/a/ws/s-1/README && ls /etc' }, cwd), 'cat README && ls /etc');
  assert.equal(toolSummary('Read', { file_path: '/home/u/ws/s-1/a.txt' }, '/home/u/ws/s-1'), 'a.txt');
});

test('PIN huruf+angka: tidak peka huruf besar/kecil', async () => {
  assert.ok(C.PIN_RE.test('moon42'));
  assert.ok(!C.PIN_RE.test('moon4'));
  assert.ok(!C.PIN_RE.test('moon-42'));
  assert.deepEqual(await C.pinToPrs('Moon42', 'm1'), await C.pinToPrs(' moon42', 'm1'));
});
