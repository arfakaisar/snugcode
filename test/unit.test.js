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
// `fn(url, headers)`: headers berisi token lokal proxy (seperti yang dipegang proses claude).
async function withProxy(handler, fn, { key = 'router-key-asli' } = {}) {
  const http = await import('node:http');
  const { startRouterProxy } = await import('../daemon/proxy.js');
  const up = http.createServer(handler);
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = startRouterProxy(`http://127.0.0.1:${up.address().port}/v1`, { getKey: () => key });
  try {
    return await fn(await proxy.ready(), { authorization: 'Bearer ' + proxy.token });
  } finally {
    proxy.close();
    up.closeAllConnections?.();
    up.close();
  }
}

test('loopback proxy: sanitasi header, key asli hanya disuntikkan untuk pemegang token lokal', async () => {
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
    (url, auth) => fetch(url + '/v1/messages', { headers: { ...auth, 'user-agent': 'claude-cli/1.0.0', 'x-app': 'cli', other: 'keep' } }).then((r) => r.text()),
  );
  assert.ok(text.includes('"name":"Bash"') && !text.includes('Bash_ide'));
  assert.equal(seen['user-agent'], 'pocketcode/0.1');
  assert.equal(seen['x-app'], undefined);
  assert.equal(seen.other, 'keep');
  // Router menerima key asli; token lokal tidak pernah keluar dari PC.
  assert.equal(seen.authorization, 'Bearer router-key-asli');
  assert.equal(seen['x-api-key'], undefined);

  // Request tanpa token lokal (mis. program lain di PC, atau key 9router mentah) ditolak, tidak diteruskan.
  seen = null;
  const statuses = await withProxy(
    (req, res) => ((seen = req.headers), res.end('{}')),
    async (url) => [
      (await fetch(url + '/v1/messages')).status,
      (await fetch(url + '/v1/messages', { headers: { 'x-api-key': 'router-key-asli' } })).status,
      (await fetch(url + '/v1/messages', { headers: { authorization: 'Bearer pc-local-salah' } })).status,
    ],
  );
  assert.deepEqual(statuses, [401, 401, 401]);
  assert.equal(seen, null);
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
      (url, auth) => fetch(url + '/v1/messages', { headers: auth }).then((r) => r.text()),
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
    (url, auth) =>
      fetch(url + '/v1/messages', { headers: auth, signal: AbortSignal.timeout(4000) })
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
  const proxy = startRouterProxy(`http://127.0.0.1:${port}`, { getKey: () => 'k' });
  const res = await fetch((await proxy.ready()) + '/v1/messages', { method: 'POST', body: '{}', headers: { 'x-api-key': proxy.token } });
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

    // Repo sedang dipakai membuat sesi baru: tidak boleh disentuh walau belum terdaftar.
    const busyRepoDir = path.join(wsDir, 'user__creating');
    fs.mkdirSync(path.join(busyRepoDir, 's-new1'), { recursive: true });
    // Repo tak terpakai tapi baru dipakai: clone dasar disimpan (TTL), worktree yatimnya tetap dibersihkan.
    const recentRepoDir = path.join(wsDir, 'user__recent');
    fs.mkdirSync(path.join(recentRepoDir, '_base'), { recursive: true });
    fs.mkdirSync(path.join(recentRepoDir, 's-old2'), { recursive: true });
    fs.writeFileSync(path.join(recentRepoDir, '.last-used'), '');
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(unusedRepoDir), old, old);

    const ttl = await cleanupWorkspaces(activeSessions, { workspacesDir: wsDir, sessionsDir: sessDir, minAgeMs: 0, busy: (d) => d === 'user__creating' });
    assert.ok(fs.existsSync(path.join(busyRepoDir, 's-new1')), 'repo yang sedang dibuat tidak disentuh');
    assert.ok(fs.existsSync(path.join(recentRepoDir, '_base')), 'clone yang baru dipakai disimpan (TTL)');
    assert.ok(!fs.existsSync(path.join(recentRepoDir, 's-old2')), 'worktree yatim tetap dihapus');
    assert.ok(ttl.removedRepos.includes(unusedRepoDir), 'clone yang lama tidak dipakai dihapus');
    fs.mkdirSync(path.join(unusedRepoDir, '_base'), { recursive: true });
    fs.mkdirSync(orpWt, { recursive: true });
    fs.writeFileSync(path.join(orpWt, 'orphan.js'), 'orphan');
    fs.writeFileSync(path.join(sessDir, 'old9.jsonl'), 'log9');
    safeRm(busyRepoDir);
    safeRm(recentRepoDir);

    const res = await cleanupWorkspaces(activeSessions, {
      workspacesDir: wsDir,
      sessionsDir: sessDir,
      minAgeMs: 0,
      repoTtlMs: 0,
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




// Repo git sementara dengan satu commit; dihapus otomatis setelah fn selesai.
async function withRepo(fn) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { git } = await import('../daemon/github.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-repo-'));
  try {
    await git(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.env\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await git(dir, ['add', '-A']);
    await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
    await fn(dir, fs, path, git);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('checkpoint: rewind mengembalikan isi, file terhapus, dan menghapus file baru (tanpa menyentuh index/node_modules)', async () => {
  const { snapshot, rewind } = await import('../daemon/checkpoint.js');
  await withRepo(async (dir, fs, path, git) => {
    const p = (f) => path.join(dir, f);
    fs.writeFileSync(p('draft.txt'), 'belum di-commit');
    fs.mkdirSync(p('node_modules/x'), { recursive: true });
    fs.writeFileSync(p('node_modules/x/i.js'), 'v1');
    const tree = await snapshot(dir);
    fs.writeFileSync(p('a.txt'), 'diubah agen');
    fs.rmSync(p('draft.txt'));
    fs.writeFileSync(p('baru.txt'), 'dibuat agen');
    fs.writeFileSync(p('node_modules/x/i.js'), 'v2');
    await git(dir, ['add', 'baru.txt']);
    assert.equal(await rewind(dir, tree), 3);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'a');
    assert.equal(fs.readFileSync(p('draft.txt'), 'utf8'), 'belum di-commit');
    assert.equal(fs.existsSync(p('baru.txt')), false);
    assert.equal(fs.readFileSync(p('node_modules/x/i.js'), 'utf8'), 'v2', 'node_modules tidak di-snapshot');
    assert.equal(await rewind(dir, tree), 0);
  });
});

test('project: deteksi perintah setup/dev dan simpan/pulihkan template .env', async () => {
  const { detectProject, saveEnv, restoreEnv } = await import('../daemon/project.js');
  await withRepo(async (dir, fs, path) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node s.js', dev: 'vite' } }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    assert.deepEqual(detectProject(dir), { setup: 'pnpm install', dev: 'pnpm run dev' });
    fs.writeFileSync(path.join(dir, '.pocketcode.json'), JSON.stringify({ dev: 'pnpm dev --host' }));
    assert.equal(detectProject(dir).dev, 'pnpm dev --host');

    const repo = 'test/pc-env-' + process.pid;
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=1');
    assert.deepEqual(await saveEnv(repo, dir), ['.env']);
    const wt = fs.mkdtempSync(dir + '-wt');
    try {
      assert.deepEqual(restoreEnv(repo, wt), ['.env']);
      assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'KEY=1');
      assert.deepEqual(restoreEnv(repo, wt), [], 'file yang sudah ada tidak ditimpa');
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
      const { HOME } = await import('../daemon/config.js');
      fs.rmSync(path.join(HOME, 'env', repo.replace('/', '__')), { recursive: true, force: true });
    }
  });
});

test('procs: proses latar belakang, deteksi port dari log, stop', async () => {
  const { ProcManager, procName } = await import('../daemon/procs.js');
  assert.equal(procName('npm run dev'), 'dev');
  assert.equal(procName('pnpm dev --host'), 'dev');
  assert.equal(procName('npx vite'), 'vite');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-proc-'));
  // Skrip di file: kutipan `node -e` berbeda antara PowerShell dan bash.
  fs.writeFileSync(path.join(dir, 'srv.js'), 'console.log("\\x1b[32m  Local:   http://localhost:5199/\\x1b[0m PORT=" + process.env.PORT); setInterval(() => {}, 1000);');
  const events = [];
  const pm = new ProcManager({ cwd: dir, onChange: (p) => events.push(p.status), onOut: () => {} });
  try {
    await pm.start('node srv.js', 'web');
    assert.equal(await pm.waitPort('web', 10000), 5199);
    assert.match(pm.logs('web'), /Local: {3}http:\/\/localhost:5199\/ PORT=\d+/);
    await assert.rejects(pm.start('node -v', 'web'), /masih berjalan/);
    await pm.stopAll();
    assert.equal(pm.list()[0].status, 'exited');
    assert.equal(pm.list()[0].killed, true);
    assert.deepEqual([events[0], events.at(-1)], ['running', 'exited']);
  } finally {
    await pm.stopAll();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('webpush: payload aes128gcm bisa didekripsi penerima (RFC 8291)', async () => {
  const crypto = await import('node:crypto');
  const { encrypt, checkPush } = await import('../daemon/webpush.js');
  const ua = crypto.createECDH('prime256v1');
  const uaPub = ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://push.example/x', keys: { p256dh: uaPub.toString('base64url'), auth: auth.toString('base64url') } };
  const msg = JSON.stringify({ title: 'pocketcode ✓', body: 'selesai' });
  const buf = encrypt(sub, msg);
  const salt = buf.subarray(0, 16);
  const asPub = buf.subarray(21, 21 + buf[20]);
  const ct = buf.subarray(21 + buf[20]);
  const ikm = crypto.hkdfSync('sha256', ua.computeSecret(asPub), auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const key = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce));
  d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(pt.at(-1), 2);
  assert.equal(pt.subarray(0, -1).toString(), msg);
  const vapid = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  assert.equal(checkPush({ sub, vapid }).sub.endpoint, sub.endpoint);
  assert.throws(() => checkPush({ sub: { ...sub, endpoint: 'http://x' }, vapid }), /tidak valid/);
});

test('toolchain: folder shim pnpm/yarn ditambahkan di akhir PATH (tanpa variabel PATH ganda)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { HOME } = await import('../daemon/config.js');
  const { toolchainEnv } = await import('../daemon/toolchain.js');
  const dir = path.join(HOME, 'bin', 'pm');
  const had = fs.existsSync(path.join(dir, 'pnpm'));
  // Tanpa shim & perintah tidak butuh pnpm/yarn: env tidak berubah, tidak ada instalasi.
  if (!had) assert.deepEqual(await toolchainEnv('npm run dev', { Path: 'a' }), { Path: 'a' });
  fs.mkdirSync(dir, { recursive: true });
  if (!had) fs.writeFileSync(path.join(dir, 'pnpm'), '');
  try {
    const env = await toolchainEnv('pnpm install', { Path: 'a', X: '1' });
    assert.equal(env.Path, 'a' + path.delimiter + dir);
    assert.equal(env.PATH, undefined);
    assert.equal(env.X, '1');
    assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
  } finally {
    if (!had) fs.rmSync(path.join(dir, 'pnpm'), { force: true });
  }
});

test('kanal biner: pesan besar dipecah & disusun ulang, anti replay, seq bersama frame teks', () => {
  const secret = C.randomBytes(32);
  const a = C.authStartPhone();
  const b = C.authRespondMachine(secret, a.msg);
  const fin = C.authFinishPhone(secret, a.state, b.msg);
  const pc = C.authVerifyMachine(b.state, fin.msg);
  const hp = fin.channel;
  const big = { id: 1, r: { diff: 'é'.repeat(700_000) } }; // ±1,4MB UTF-8 -> beberapa frame
  const frames = pc.sealBin(big);
  assert.ok(frames.length >= 6, 'frames: ' + frames.length);
  assert.ok(frames.every((f) => f.length <= C.BIN_CHUNK + 64));
  const got = frames.map((f) => hp.openBin(f.slice().buffer));
  assert.deepEqual(got.slice(0, -1), Array(frames.length - 1).fill(undefined));
  assert.deepEqual(got.at(-1), big);
  assert.throws(() => hp.openBin(frames[0]), /replay/);
  // Frame teks & biner berbagi nomor urut: urutan campuran tetap diterima.
  assert.deepEqual(hp.open(pc.seal({ t: 1 })), { t: 1 });
  assert.deepEqual(hp.openBin(pc.sealBin({ t: 2 })[0]), { t: 2 });
  // Ukuran: frame biner jauh lebih kecil dari frame teks (base64 + JSON berlapis).
  const msg = { ev: 'events', es: [{ k: 'text', d: 'x'.repeat(30_000) }] };
  const textLen = JSON.stringify({ t: 'd', cid: 'abcdefghijkl', d: JSON.stringify(pc.seal(msg)) }).length;
  const binLen = C.frameWithCid('abcdefghijkl', pc.sealBin(msg)[0]).length;
  assert.ok(binLen < textLen * 0.8, `${binLen} vs ${textLen}`);
  const { cid, payload } = C.splitCid(C.frameWithCid('abcdefghijkl', new Uint8Array([1, 2, 3])));
  assert.equal(cid, 'abcdefghijkl');
  assert.deepEqual([...payload], [1, 2, 3]);
});

test('git status porcelain v2: branch, ahead, file baru/ubah/rename/untracked', async () => {
  const { gitStatus, parseStatusV2 } = await import('../daemon/github.js');
  await withRepo(async (dir, fs, path, git) => {
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    await git(dir, ['add', 'b.txt']);
    await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'diubah');
    await git(dir, ['mv', 'b.txt', 'c d.txt']);
    fs.writeFileSync(path.join(dir, 'baru x.txt'), 'x');
    const st = await gitStatus(dir);
    assert.ok(st.branch && st.branch !== 'HEAD');
    const by = Object.fromEntries(st.files.map((f) => [f.path, f.st]));
    assert.equal(by['a.txt'], ' M');
    assert.equal(by['b.txt -> c d.txt'], 'R ');
    assert.equal(by['baru x.txt'], '??');
    assert.equal(st.hasUpstream, false);
    assert.equal(st.ahead, 2, 'tanpa remote: semua commit belum di-push');
    assert.equal(st.log.length, 2);
  });
  const p = parseStatusV2('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +3 -1\n1 .M N... 100644 100644 100644 a a x.js\n');
  assert.deepEqual({ ...p, files: p.files }, { branch: 'main', ahead: 3, behind: 1, upstream: true, files: [{ st: ' M', path: 'x.js' }] });
  assert.equal(parseStatusV2('# branch.head (detached)\n').branch, 'HEAD');
});

test('markdown: render bertahap hanya membekukan blok yang sudah selesai', async () => {
  const { md, stableCut, esc } = await import('../web/md.js');
  assert.equal(esc('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  assert.equal(md('**b** <i>'), '<p><b>b</b> &lt;i&gt;</p>');
  const src = 'Paragraf satu.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nList:\n- a\n- b';
  // Blok kode yang belum ditutup tidak boleh dipotong di baris kosong di dalamnya.
  const partial = src.slice(0, src.indexOf('const b'));
  assert.equal(stableCut(partial), 'Paragraf satu.\n\n'.length);
  // Hasil render potongan-potongan sama dengan render utuh.
  let done = 0;
  let html = '';
  for (let i = 1; i <= src.length; i += 7) {
    const cut = stableCut(src.slice(0, i), done);
    if (cut > done) (html += md(src.slice(done, cut))), (done = cut);
  }
  html += md(src.slice(done));
  assert.equal(html, md(src));
});

test('izin: path sensitif & tool baca di luar worktree', async () => {
  const path = await import('node:path');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const { HOME, WORKSPACES } = await import('../daemon/config.js');
  const { isSensitivePath, toolPaths, Session } = await import('../daemon/sessions.js');
  assert.ok(isSensitivePath(path.join(HOME, 'secrets.json')));
  assert.ok(isSensitivePath(path.join(HOME, 'env', 'x', '.env')));
  assert.ok(isSensitivePath(HOME));
  assert.ok(!isSensitivePath(path.join(WORKSPACES, 'a__b', 's-1', 'x.js')));
  assert.ok(!isSensitivePath(path.join(HOME + '-lain', 'x')));
  // Output tool besar disimpan Claude Code di folder config-nya: boleh dibaca, tidak boleh ditulis.
  const { CLAUDE_DIR } = await import('../daemon/config.js');
  assert.ok(!isSensitivePath(path.join(CLAUDE_DIR, 'projects', 'p', 'tool-results', 'x.txt')));
  assert.ok(isSensitivePath(path.join(CLAUDE_DIR, 'settings.json'), { write: true }));
  assert.deepEqual(toolPaths('Glob', { pattern: path.join(HOME, '**', '*.json') }, '/w'), [path.join(HOME, path.sep)].map((p) => path.resolve(p)));

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-perm-'));
  const mgr = { config: {}, secrets: {}, log() {}, notify() {}, saveIndex() {}, trimAgents() {} };
  const s = new Session({ id: 'tperm', cwd, repo: 'a/b', model: 'm' }, mgr);
  const settled = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('menunggu'), 50))]);
  try {
    assert.equal((await s.askPermission('Read', { file_path: path.join(cwd, 'a.js') })).behavior, 'allow');
    assert.equal((await s.askPermission('Grep', { pattern: 'x' })).behavior, 'allow');
    assert.equal((await s.askPermission('Read', { file_path: path.join(CLAUDE_DIR, 'projects', 'x', 'tool-results', 'o.txt') })).behavior, 'allow');
    assert.equal((await s.askPermission('Read', { file_path: path.join(HOME, 'secrets.json') })).behavior, 'deny');
    assert.equal(await settled(s.askPermission('Read', { file_path: '/etc/hosts' })), 'menunggu');
    assert.equal(await settled(s.askPermission('WebFetch', { url: 'https://x.y/?q=1' })), 'menunggu');
    assert.equal((await s.askPermission('mcp__pocketcode__preview_screenshot', { url: 'http://localhost:5173/' })).behavior, 'allow');
    assert.equal(await settled(s.askPermission('mcp__pocketcode__preview_screenshot', { url: 'file:///etc/passwd' })), 'menunggu');
    s.meta.auto = true;
    assert.equal((await s.askPermission('WebFetch', { url: 'https://x.y' })).behavior, 'allow');
    assert.equal((await s.askPermission('Write', { file_path: path.join(HOME, 'config.json'), content: '' })).behavior, 'deny');
    assert.equal((await s.askPermission('Edit', { file_path: path.join(CLAUDE_DIR, 'settings.json') })).behavior, 'deny');
    assert.equal(await settled(s.askPermission('Bash', { command: 'cat ~/.pocketcode/secrets.json' })), 'menunggu');
    // Izin yang tertunda: "Selalu" tidak berlaku untuk perintah yang menyentuh kredensial.
    const pending = [...s.perms.entries()].find(([, p]) => p.tool === 'Bash');
    s.answerPermission(pending[0], 'always');
    assert.ok(!s.alwaysAllow.has('Bash'));
  } finally {
    s.endTurn();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('index sesi rusak: sesi dipulihkan dari worktree & tidak ada yang dihapus', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-idx-'));
  try {
    const wt = path.join(home, 'workspaces', 'octo__repo', 's-ab12');
    fs.mkdirSync(path.join(home, 'workspaces', 'octo__repo', '_base'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, 'kerja.txt'), 'belum di-push');
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(wt, old, old);
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', 'index.json'), '[{"id":"ab12","cwd":'); // terpotong
    fs.writeFileSync(path.join(home, 'sessions', 'ab12.jsonl'), JSON.stringify({ k: 'user', d: 'perbaiki login', seq: 1 }) + '\n');
    const script = `
      const { SessionManager } = await import(${JSON.stringify(new URL('../daemon/sessions.js', import.meta.url).href)});
      const m = new SessionManager({ config: { routerUrl: 'http://127.0.0.1:9/v1', model: 'm' }, secrets: {}, log() {} });
      await new Promise((r) => setTimeout(r, 2500)); // pembersih otomatis berjalan 1,5 detik setelah start
      console.log(JSON.stringify(m.list()));
      await m.close();
      process.exit(0);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, POCKETCODE_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const list = JSON.parse(out.trim().split('\n').at(-1));
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'ab12');
    assert.equal(list[0].repo, 'octo/repo');
    assert.equal(list[0].title, 'perbaiki login');
    assert.ok(fs.existsSync(path.join(wt, 'kerja.txt')), 'worktree tidak dihapus');
    assert.ok(fs.readdirSync(path.join(home, 'sessions')).some((f) => f.startsWith('index.json.broken-')), 'file rusak disimpan');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'index.json'), 'utf8'))[0].id, 'ab12');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('model event bersama: rencana, aktivitas, ringkasan selesai, penyaring duplikat', async () => {
  const E = await import('../shared/events.js');
  const todos = E.todosFromInput([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }]);
  assert.deepEqual(todos, [{ st: 'done', t: 'a' }, { st: 'doing', t: 'b' }, { st: 'todo', t: 'c' }]);
  // Daemon baru mengirim `todos`; daemon lama hanya teks berglyph — hasilnya sama.
  assert.deepEqual(E.todoItems({ k: 'tool', name: 'TodoWrite', todos }), todos);
  assert.deepEqual(E.todoItems({ k: 'tool', name: 'TodoWrite', s: E.todoText(todos) }), todos);
  assert.equal(E.toolActivity({ k: 'tool', name: 'TodoWrite', todos }), 'b');
  assert.equal(E.toolActivity({ k: 'tool', name: 'Bash', s: 'npm test\nlagi' }), 'Menjalankan npm test');
  assert.equal(E.toolActivity({ k: 'tool', name: 'alat_baru', s: 'x' }), 'alat_baru x');
  assert.deepEqual(E.doneParts({ k: 'done', turns: 3, ms: 4200, usage: { in: 12345, out: 800 }, ctx: 40, cost: 0.0123 }), ['3 langkah', '4.2s', '12k→800 tok', 'konteks 40%', '$0.012']);
  assert.equal(E.fmtDuration(95_000), '1m 35s');
  const cur = new E.EventCursor();
  assert.deepEqual([{ seq: 1 }, { seq: 2 }, { seq: 2 }, { k: 'proc' }, { seq: 1 }, { seq: 3 }].map((e) => cur.accept(/** @type {any} */ (e))), [true, true, false, true, false, true]);
  assert.equal(cur.lastSeq, 3);

  // Daemon menyertakan `todos` terstruktur pada event TodoWrite.
  const { toolSummary } = await import('../daemon/sessions.js');
  assert.equal(toolSummary('TodoWrite', { todos: [{ content: 'a', status: 'completed' }] }), '☑ a');
});
