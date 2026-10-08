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

test('groupModels: varian effort ag/ digabung jadi slider', async () => {
  const M = await import('../shared/models.js');
  const ids = ['ag/gemini-3.8-flash-high', 'ag/gemini-3.8-flash-medium', 'ag/gemini-3.8-flash-low', 'ag/gemini-3.8-flash',
    'ag/gemini-3.5-flash-high', 'ag/gemini-3.5-flash-low', 'ag/gemini-3.5-flash-extra-low',
    'ag/gemini-3.1-pro-low', 'ag/gpt-oss-120b-medium', 'ag/gemini-3-flash-agent', 'ag/claude-opus-4-6-thinking', 'gemini/gemini-3.8-flash'];
  const g = M.groupModels(ids);
  const by = (k) => g.find((x) => x.key === k);
  assert.equal(g.length, 7);
  assert.deepEqual(by('ag/gemini-3.8-flash').levels.map((l) => l.effort), ['low', 'medium', 'high']);
  assert.equal(by('ag/gemini-3.8-flash').auto, 'ag/gemini-3.8-flash');
  assert.ok(by('ag/gemini-3.8-flash').slider);
  assert.deepEqual(by('ag/gemini-3.5-flash').levels.map((l) => l.effort), ['extra-low', 'low', 'high']);
  assert.equal(by('ag/gemini-3.1-pro').fixed, 'low');
  assert.equal(by('ag/gemini-3.1-pro').slider, false);
  assert.ok(by('ag/gemini-3-flash-agent') && by('ag/claude-opus-4-6-thinking'));
  assert.ok(by('gemini/gemini-3.8-flash'), 'provider berbeda tidak digabung');
  assert.equal(M.defaultChoice(by('ag/gemini-3.8-flash'), 'x'), 'medium');
  assert.equal(M.defaultChoice(by('ag/gemini-3.8-flash'), 'ag/gemini-3.8-flash-high'), 'high');
  assert.equal(M.defaultChoice(by('ag/gemini-3.5-flash'), 'x'), 'low');
  assert.equal(M.resolveId(by('ag/gemini-3.8-flash'), null), 'ag/gemini-3.8-flash');
  assert.equal(M.resolveId(by('ag/gemini-3.8-flash'), 'high'), 'ag/gemini-3.8-flash-high');
  assert.equal(M.modelLabel('ag/gemini-3.5-flash-extra-low'), 'gemini-3.5-flash · x-low');
  assert.equal(M.ctxLabel(1048576), '1M');
});

test('updater: deteksi tipe instalasi dan versi paket', async () => {
  const { getInstallInfo, checkUpdate } = await import('../daemon/updater.js');
  const info = getInstallInfo();
  assert.equal(info.version, '0.1.0');
  assert.ok(['git', 'npm'].includes(info.installType));
  assert.ok(info.commit);

  const st = await checkUpdate();
  assert.equal(typeof st.updateAvailable, 'boolean');
  assert.ok(st.currentCommit);
  assert.ok(['git', 'npm'].includes(st.installType));
});

test('keepawake: inisialisasi dan penghentian bersih', async () => {
  const { startKeepAwake } = await import('../daemon/keepawake.js');
  const ka = startKeepAwake();
  assert.equal(typeof ka.stop, 'function');
  assert.equal(typeof ka.active, 'function');
  ka.stop();
});

