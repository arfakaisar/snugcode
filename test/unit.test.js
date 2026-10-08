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

test('nativebin: nama paket binary per platform + deteksi di disk', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { platformBinaryPackage, platformBinaryPackages, nativeBinaryInstalled, missingBinaryMessage } = await import('../daemon/nativebin.js');
  assert.equal(platformBinaryPackage({ platform: 'win32', arch: 'x64' }), 'claude-agent-sdk-win32-x64');
  assert.equal(platformBinaryPackage({ platform: 'darwin', arch: 'arm64' }), 'claude-agent-sdk-darwin-arm64');
  assert.deepEqual(platformBinaryPackages({ platform: 'linux', arch: 'x64', musl: false }), ['claude-agent-sdk-linux-x64', 'claude-agent-sdk-linux-x64-musl']);
  assert.deepEqual(platformBinaryPackages({ platform: 'linux', arch: 'arm64', musl: true }), ['claude-agent-sdk-linux-arm64-musl', 'claude-agent-sdk-linux-arm64']);
  assert.match(missingBinaryMessage('/x'), /--include=optional/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bin-'));
  try {
    assert.equal(nativeBinaryInstalled(root), false);
    const dir = path.join(root, 'node_modules', '@anthropic-ai', platformBinaryPackage());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
    assert.equal(nativeBinaryInstalled(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keepawake: inisialisasi dan penghentian bersih', async () => {
  const { startKeepAwake } = await import('../daemon/keepawake.js');
  const ka = startKeepAwake();
  assert.equal(typeof ka.stop, 'function');
  assert.equal(typeof ka.active, 'function');
  ka.stop();
});

test('groupModels: cc/claude-opus-5-5 menghasilkan virtual slider effort', async () => {
  const M = await import('../shared/models.js');
  const ids = ['cc/claude-opus-5-5'];
  const g = M.groupModels(ids);
  assert.equal(g.length, 1);
  const opus = g[0];
  assert.equal(opus.key, 'cc/claude-opus-5-5');
  assert.ok(opus.slider);
  assert.deepEqual(opus.levels.map((l) => l.effort), ['low', 'medium', 'high', 'max']);
  assert.equal(opus.auto, 'cc/claude-opus-5-5');

  assert.equal(M.resolveId(opus, 'high'), 'cc/claude-opus-5-5-high');
  assert.equal(M.resolveId(opus, null), 'cc/claude-opus-5-5');

  const resolvedHigh = M.resolveModelEffort('cc/claude-opus-5-5-high');
  assert.equal(resolvedHigh.actualModel, 'cc/claude-opus-5-5');
  assert.equal(resolvedHigh.effort, 'high');

  const resolvedAuto = M.resolveModelEffort('cc/claude-opus-5-5');
  assert.equal(resolvedAuto.actualModel, 'cc/claude-opus-5-5');
  assert.equal(resolvedAuto.effort, null);
});

// Upstream tiruan: handler(req, res) menentukan cara membalas.
async function withProxy(handler, fn) {
  const http = await import('node:http');
  const { startRouterProxy } = await import('../daemon/proxy.js');
  const up = http.createServer(handler);
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = startRouterProxy(`http://127.0.0.1:${up.address().port}/v1`);
  try {
    return await fn(await proxy.ready());
  } finally {
    proxy.close();
    up.closeAllConnections?.();
    up.close();
  }
}

test('loopback proxy: sanitasi header, tanpa menyuntikkan API key', async () => {
  const { stripIdeToolSuffix } = await import('../daemon/proxy.js');
  assert.equal(stripIdeToolSuffix('{"name":"Bash_ide"}'), '{"name":"Bash"}');
  assert.equal(stripIdeToolSuffix('{"name": "Read_ide"}'), '{"name":"Read"}');
  assert.equal(stripIdeToolSuffix('{"name":"normal_tool"}'), '{"name":"normal_tool"}');

  let seen = null;
  const text = await withProxy(
    (req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: content_block_start\ndata: {"content_block":{"name":"Bash_ide"}}\n\n');
    },
    (url) => fetch(url + '/v1/messages', { headers: { 'user-agent': 'claude-cli/1.0.0', 'x-app': 'cli', other: 'keep' } }).then((r) => r.text()),
  );
  assert.ok(text.includes('"name":"Bash"') && !text.includes('Bash_ide'));
  assert.equal(seen['user-agent'], 'pocketcode/0.1');
  assert.equal(seen['x-app'], undefined);
  assert.equal(seen.other, 'keep');
  // Request tanpa kredensial (mis. dari program lain di PC) tidak boleh mendapat key 9router.
  assert.equal(seen['x-api-key'], undefined);
  assert.equal(seen.authorization, undefined);
});

test('loopback proxy: _ide terbelah di batas chunk & UTF-8 multi-byte tetap utuh', async () => {
  const event = 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash_ide","input":{}}}\n\n';
  const payload = Buffer.from('x'.repeat(100) + '\n' + event + 'data: {"text":"✓ selesai — ok"}\n\n');
  // Potong di setiap posisi di dalam "Bash_ide" dan di tengah karakter ✓ (3 byte).
  const nameAt = payload.indexOf('Bash_ide');
  const checkAt = payload.indexOf(Buffer.from('✓'));
  const cuts = [...Array(10).keys()].map((i) => nameAt - 1 + i).concat([checkAt + 1, checkAt + 2]);
  for (const cut of cuts) {
    const text = await withProxy(
      (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(payload.subarray(0, cut));
        setTimeout(() => res.end(payload.subarray(cut)), 20);
      },
      (url) => fetch(url + '/v1/messages').then((r) => r.text()),
    );
    assert.ok(!text.includes('Bash_ide'), 'potongan di byte ' + cut);
    assert.ok(text.includes('"name":"Bash"'), 'potongan di byte ' + cut);
    assert.ok(text.includes('✓ selesai — ok'), 'UTF-8 rusak di byte ' + cut);
  }
});

test('loopback proxy: koneksi router putus di tengah stream -> klien tidak menggantung', async () => {
  const outcome = await withProxy(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"message_start"}\n\n');
      setTimeout(() => req.socket.destroy(), 30);
    },
    (url) =>
      fetch(url + '/v1/messages', { signal: AbortSignal.timeout(4000) })
        .then((r) => r.text())
        .then(() => 'selesai', (e) => (e.name === 'TimeoutError' ? 'menggantung' : 'error')),
  );
  assert.equal(outcome, 'error');
});

test('loopback proxy: router tidak bisa dihubungi -> 502 berformat error Anthropic', async () => {
  const net = await import('node:net');
  const { startRouterProxy } = await import('../daemon/proxy.js');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r)); // port kosong
  const proxy = startRouterProxy(`http://127.0.0.1:${port}`);
  const res = await fetch((await proxy.ready()) + '/v1/messages', { method: 'POST', body: '{}' });
  proxy.close();
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.equal(j.type, 'error');
  assert.match(j.error.message, /Router proxy error/);
});

test('effort: model claude di provider non-cc tidak diberi slider virtual', async () => {
  const M = await import('../shared/models.js');
  const [g] = M.groupModels(['ag/claude-opus-4-6-thinking']);
  assert.equal(g.slider, false);
  assert.deepEqual(g.levels, []);
  assert.deepEqual(M.resolveModelEffort('ag/claude-opus-4-6-thinking'), { actualModel: 'ag/claude-opus-4-6-thinking', effort: null });
  // Varian effort asli dari router (ID terpisah) tetap diteruskan apa adanya.
  assert.deepEqual(M.resolveModelEffort('ag/gemini-3.8-flash-high'), { actualModel: 'ag/gemini-3.8-flash-high', effort: null });
  assert.deepEqual(M.resolveModelEffort('claude-sonnet-5-5-max'), { actualModel: 'claude-sonnet-5-5', effort: 'max' });
});

test('izin: push & penulisan ke remote selalu dikenali', async () => {
  const { isRemoteWrite } = await import('../daemon/sessions.js');
  const yes = ['git push', 'git push -u origin HEAD', 'cd x && git push --force', 'git -C ../repo push', 'git -c http.extraheader=x push origin main', 'git --no-pager push', 'git.exe push', 'gh pr create --fill', 'gh pr merge 3', 'gh release create v1'];
  const no = ['git status', 'git log --grep push', 'echo pushing', 'git commit -m "push later"', 'gh pr list', 'npm run push-docs'];
  for (const cmd of yes) assert.ok(isRemoteWrite('Bash', { command: cmd }), cmd);
  for (const cmd of no) assert.ok(!isRemoteWrite('Bash', { command: cmd }), cmd);
  assert.ok(!isRemoteWrite('Read', { command: 'git push' }));
});

test('fastModelVariant: varian effort tinggi diturunkan ke low untuk smallModel/subagent', async () => {
  const { fastModelVariant } = await import('../shared/models.js');
  assert.equal(fastModelVariant('ag/gemini-3.8-flash-high'), 'ag/gemini-3.8-flash-low');
  assert.equal(fastModelVariant('ag/gemini-3.8-flash-medium'), 'ag/gemini-3.8-flash-low');
  assert.equal(fastModelVariant('ag/gemini-3.8-flash-low'), 'ag/gemini-3.8-flash-low');
  assert.equal(fastModelVariant('cc/claude-opus-5-5-high'), 'cc/claude-opus-5-5-low');
  assert.equal(fastModelVariant('ag/gemini-3.1-pro-low'), 'ag/gemini-3.1-pro-low');
  assert.equal(fastModelVariant('cc/claude-opus-5-5'), 'cc/claude-opus-5-5');
  assert.equal(fastModelVariant(null), null);
});

test('pocketcode prompt: mencakup identitas, arsitektur E2EE/daemon/worktree, dan aturan push', async () => {
  const { POCKETCODE_SYSTEM_PROMPT } = await import('../daemon/prompt.js');
  assert.ok(typeof POCKETCODE_SYSTEM_PROMPT === 'string' && POCKETCODE_SYSTEM_PROMPT.length > 500);
  assert.match(POCKETCODE_SYSTEM_PROMPT, /pocketcode/i);
  assert.match(POCKETCODE_SYSTEM_PROMPT, /E2EE|End-to-End Encrypted/);
  assert.match(POCKETCODE_SYSTEM_PROMPT, /CPace|XChaCha20-Poly1305/);
  assert.match(POCKETCODE_SYSTEM_PROMPT, /worktree/i);
  assert.match(POCKETCODE_SYSTEM_PROMPT, /git push/i);
});

test('cleaner: hapus orphan worktree, repo tak terpakai, dan log basi', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { cleanupWorkspaces, safeRm } = await import('../daemon/cleaner.js');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-clean-'));
  const wsDir = path.join(tmpRoot, 'workspaces');
  const sessDir = path.join(tmpRoot, 'sessions');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(sessDir, { recursive: true });

  try {
    // 1. Repo aktif: arfakaisar__myrepo
    //    Memiliki active worktree s-act1 dan orphan worktree s-orp1
    const activeRepoDir = path.join(wsDir, 'arfakaisar__myrepo');
    const actWt = path.join(activeRepoDir, 's-act1');
    const orpWt = path.join(activeRepoDir, 's-orp1');
    const baseDir = path.join(activeRepoDir, '_base');
    fs.mkdirSync(actWt, { recursive: true });
    fs.mkdirSync(orpWt, { recursive: true });
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(actWt, 'app.js'), 'active');
    fs.writeFileSync(path.join(orpWt, 'orphan.js'), 'orphan');

    // 2. Repo tidak terpakai: user__unused
    //    Hanya punya _base, tidak ada sesi aktif
    const unusedRepoDir = path.join(wsDir, 'user__unused');
    fs.mkdirSync(path.join(unusedRepoDir, '_base'), { recursive: true });

    // 3. File logs
    fs.writeFileSync(path.join(sessDir, 'act1.jsonl'), 'log1');
    fs.writeFileSync(path.join(sessDir, 'old9.jsonl'), 'log9');

    // Active session list
    const activeSessions = [
      { id: 'act1', repo: 'arfakaisar/myrepo', cwd: actWt },
    ];

    const res = await cleanupWorkspaces(activeSessions, {
      workspacesDir: wsDir,
      sessionsDir: sessDir,
      minAgeMs: 0,
    });

    assert.equal(res.removedWorktrees.length, 1);
    assert.equal(res.removedWorktrees[0], orpWt);
    assert.equal(fs.existsSync(orpWt), false, 's-orp1 harus terhapus');
    assert.equal(fs.existsSync(actWt), true, 's-act1 harus tetap ada');

    assert.equal(res.removedRepos.length, 1);
    assert.equal(res.removedRepos[0], unusedRepoDir);
    assert.equal(fs.existsSync(unusedRepoDir), false, 'user__unused harus terhapus');
    assert.equal(fs.existsSync(activeRepoDir), true, 'arfakaisar__myrepo harus tetap ada');

    assert.equal(res.removedLogs.length, 1);
    assert.equal(res.removedLogs[0], 'old9.jsonl');
    assert.equal(fs.existsSync(path.join(sessDir, 'old9.jsonl')), false);
    assert.equal(fs.existsSync(path.join(sessDir, 'act1.jsonl')), true);
  } finally {
    safeRm(tmpRoot);
    assert.equal(fs.existsSync(tmpRoot), false, 'safeRm membersihkan tmpRoot');
  }
});

test('autostart: deteksi path file dan sinkronisasi otomatis', async () => {
  const { autostartFilePath, syncAutostart, isAutostartEnabled } = await import('../daemon/autostart.js');
  const filePath = autostartFilePath();
  assert.ok(typeof filePath === 'string' && filePath.length > 5);
  // isAutostartEnabled mengembalikan boolean
  assert.equal(typeof isAutostartEnabled(), 'boolean');
});



