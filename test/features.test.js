// Fitur dari HP: file explorer (batas folder sesi), edit dengan deteksi konflik, batalkan hunk, terminal PTY.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-feat-'));
process.env.SNUGCODE_HOME = TMP_HOME;
test.after(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }));

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
function repo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i');
  return dir;
}

test('file explorer: daftar folder, batas folder sesi, folder data snugcode tertutup', async () => {
  const { listDir, readFile, resolveIn } = await import('../daemon/files.js');
  const { WORKSPACES, HOME } = await import('../daemon/config.js');
  const cwd = repo(path.join(WORKSPACES, 'o__files'), { 'src/a.js': 'a\n', 'README.md': '# x\n', 'img.png': 'PNG' });
  fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
  const l = listDir(cwd, '');
  assert.deepEqual(l.entries.map((e) => e.name), ['src', 'bin.dat', 'img.png', 'README.md']);
  assert.ok(l.entries[0].dir && !l.entries.some((e) => e.name === '.git'));
  assert.equal(listDir(cwd, 'src').entries[0].name, 'a.js');
  assert.deepEqual(readFile(cwd, 'src/a.js').text, 'a\n');
  assert.equal(readFile(cwd, 'bin.dat').binary, true);
  assert.equal(readFile(cwd, 'img.png').image.mime, 'image/png');
  for (const bad of ['../x', '../../secrets.json', 'src/../../o__other']) assert.throws(() => resolveIn(cwd, bad), /luar folder sesi/, bad);
  // Path absolut dari klien selalu relatif ke folder sesi.
  assert.equal(resolveIn(cwd, '/src/a.js').rel, 'src/a.js');
  assert.throws(() => readFile(cwd, '/etc/passwd'), /tidak ditemukan/);
  // Symlink ke luar folder sesi (mis. ke secrets.json) tidak bisa dibuka & tidak tampil.
  fs.writeFileSync(path.join(HOME, 'secrets.json'), '{"k":1}');
  fs.symlinkSync(path.join(HOME, 'secrets.json'), path.join(cwd, 'leak.json'));
  assert.throws(() => readFile(cwd, 'leak.json'), /luar folder sesi/);
  assert.ok(!listDir(cwd, '').entries.some((e) => e.name === 'leak.json'));
  // Sesi Komputer di folder induk folder data: isi folder data tidak tampil/terbaca.
  const parent = path.dirname(HOME);
  assert.ok(!listDir(parent, '').entries.some((e) => e.name === path.basename(HOME)));
  assert.throws(() => readFile(parent, path.join(path.basename(HOME), 'secrets.json')), /Folder data snugcode/);
});

test('file explorer: simpan editan ditolak bila file sudah berubah sejak dibuka', async () => {
  const { readFile, writeFile } = await import('../daemon/files.js');
  const { WORKSPACES } = await import('../daemon/config.js');
  const cwd = repo(path.join(WORKSPACES, 'o__edit'), { 'a.txt': 'satu\n' });
  const f = readFile(cwd, 'a.txt');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'diubah agen\n');
  assert.throws(() => writeFile(cwd, 'a.txt', 'dari hp\n', { hash: f.hash }), /sudah berubah/);
  const g = readFile(cwd, 'a.txt');
  assert.equal(writeFile(cwd, 'a.txt', 'dari hp\n', { hash: g.hash }).path, 'a.txt');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'dari hp\n');
  assert.equal(writeFile(cwd, 'baru/b.txt', 'b', { create: true }).path, 'baru/b.txt');
  assert.throws(() => writeFile(cwd, 'baru/b.txt', 'c', { create: true }), /sudah ada/);
  assert.throws(() => writeFile(cwd, '.git/config', 'x'), /\.git/);
});

test('review diff: batalkan satu hunk, file baru, dan hunk yang sudah basi', async () => {
  const { revertChange, splitPatch } = await import('../daemon/files.js');
  const { gitDiff } = await import('../daemon/github.js');
  const { WORKSPACES } = await import('../daemon/config.js');
  const lines = Array.from({ length: 40 }, (_, i) => `baris ${i + 1}`);
  const cwd = repo(path.join(WORKSPACES, 'o__hunk'), { 'a.txt': lines.join('\n') + '\n' });
  const changed = [...lines];
  changed[2] = 'UBAH ATAS';
  changed[35] = 'UBAH BAWAH';
  fs.writeFileSync(path.join(cwd, 'a.txt'), changed.join('\n') + '\n');
  fs.writeFileSync(path.join(cwd, 'baru.txt'), 'baru\n');
  const { diff } = await gitDiff(cwd);
  const filePatch = diff.slice(diff.indexOf('diff --git a/a.txt'), diff.indexOf('diff --git a/baru.txt'));
  const { hunks } = splitPatch(filePatch);
  assert.equal(hunks.length, 2);
  // Hunk kedua dibatalkan; perubahan di atas tetap.
  assert.deepEqual(await revertChange(cwd, 'a.txt', hunks[1]), { path: 'a.txt', hunks: 1 });
  const now = fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8');
  assert.match(now, /UBAH ATAS/);
  assert.doesNotMatch(now, /UBAH BAWAH/);
  // Hunk yang sudah tidak ada di diff ditolak.
  await assert.rejects(revertChange(cwd, 'a.txt', hunks[1]), /sudah berubah/);
  // File baru: batalkan = hapus file dan entri intent-to-add.
  await revertChange(cwd, 'baru.txt');
  assert.ok(!fs.existsSync(path.join(cwd, 'baru.txt')));
  assert.doesNotMatch(git(cwd, 'status', '--porcelain'), /baru\.txt/);
  // Batalkan seluruh file.
  await revertChange(cwd, 'a.txt');
  assert.equal(git(cwd, 'status', '--porcelain').trim(), '');
  await assert.rejects(revertChange(cwd, 'a.txt'), /tidak punya perubahan/);
});

test('terminal: shell PTY di folder sesi, input/output, resize, putar ulang saat attach, tutup', { skip: process.platform === 'win32' && 'shell Windows diuji manual' }, async (t) => {
  const { Terminals, loadPty } = await import('../daemon/pty.js');
  if (!loadPty()) return t.skip('paket PTY tidak terpasang');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-pty-'));
  const terms = new Terminals();
  const got = [];
  const conn = { push: (m) => got.push(m) };
  const out = () => got.map((m) => m.d || '').join('');
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('timeout; output: ' + JSON.stringify(out().slice(-400)));
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  const prevShell = process.env.SHELL;
  process.env.SHELL = '/bin/sh';
  try {
    const term = await terms.open({ id: 's1', meta: { cwd } }, { cols: 90, rows: 20 });
    process.env.SHELL = prevShell;
    terms.attach(term.tid, conn);
    terms.write(term.tid, 'pwd; echo "x$((40+2))y"; stty size\r');
    await until(() => /x42y/.test(out()) && /20 90/.test(out()));
    assert.ok(out().includes(fs.realpathSync(cwd)) || out().includes(cwd));
    terms.resize(term.tid, 120, 33);
    terms.write(term.tid, 'stty size\r');
    await until(() => /33 120/.test(out()));
    // HP lain menyambung: dapat scrollback.
    const again = terms.attach(term.tid, { push() {} });
    assert.match(again.buf, /x42y/);
    assert.equal(terms.list('s1').length, 1);
    assert.ok(terms.active());
    terms.write(term.tid, 'exit\r');
    await until(() => got.some((m) => m.exit != null));
    assert.equal(terms.list('s1').length, 0);
    await assert.rejects(async () => terms.write(term.tid, 'x'), /sudah ditutup/);
  } finally {
    process.env.SHELL = prevShell;
    terms.closeAll();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('terminal: batas per sesi & tombol Ctrl di HP', async (t) => {
  const { ctrlKey } = await import('../web/termkeys.js');
  assert.equal(ctrlKey('c'), '\x03');
  assert.equal(ctrlKey('['), '\x1b');
  assert.equal(ctrlKey('ab'), 'ab');
  const { Terminals, loadPty } = await import('../daemon/pty.js');
  if (!loadPty() || process.platform === 'win32') return t.skip('paket PTY tidak terpasang');
  const terms = new Terminals();
  const prevShell = process.env.SHELL;
  process.env.SHELL = '/bin/sh';
  try {
    const sess = { id: 's2', meta: { cwd: os.tmpdir() } };
    for (let i = 0; i < 4; i++) await terms.open(sess);
    await assert.rejects(terms.open(sess), /Maksimal 4/);
    terms.closeSession('s2');
    assert.equal(terms.list('s2').length, 0);
  } finally {
    process.env.SHELL = prevShell;
    terms.closeAll();
  }
});

test('keychain: secrets.json terenkripsi, tetap terenkripsi saat disimpan, kunci hilang = error (bukan kosong)', async () => {
  process.env.SNUGCODE_KEYCHAIN_FAKE = path.join(TMP_HOME, 'fake-keychain');
  const { loadSecrets, saveSecrets, setKeychain, secretsSealed, HOME } = await import('../daemon/config.js');
  const { disableKeychain } = await import('../daemon/keychain.js');
  const file = path.join(HOME, 'secrets.json');
  try {
    saveSecrets({ devices: { hp: { secret: 'ab' } }, machineToken: 'MT-RAHASIA' });
    assert.equal(setKeychain(true), 'keychain uji');
    assert.ok(secretsSealed());
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /MT-RAHASIA|hp/);
    assert.equal(loadSecrets().machineToken, 'MT-RAHASIA');
    // Daemon menyimpan perubahan: tetap terenkripsi.
    const s = loadSecrets();
    s.githubToken = 'gho_x';
    saveSecrets(s);
    assert.ok(secretsSealed());
    assert.equal(loadSecrets().githubToken, 'gho_x');
    assert.equal(setKeychain(true), 'sudah aktif');
    // Kunci hilang dari keychain: loadSecrets gagal dengan jelas (daemon tidak menimpa secrets dengan {}).
    const sealed = fs.readFileSync(file, 'utf8');
    disableKeychain(HOME);
    assert.throws(() => loadSecrets(), /kuncinya tidak ada di keychain/);
    assert.equal(fs.readFileSync(file, 'utf8'), sealed);
    // Menyimpan pun ditolak (tidak menimpa dengan teks biasa); pemulihan = hapus secrets.json lalu setup ulang.
    assert.throws(() => saveSecrets({ devices: {} }), /kuncinya tidak ada/);
    fs.rmSync(file);
    // Matikan: kembali teks biasa.
    saveSecrets({ devices: {}, machineToken: 'MT-2' });
    assert.equal(setKeychain(true), 'keychain uji');
    assert.equal(setKeychain(false), 'mati');
    assert.ok(!secretsSealed());
    assert.match(fs.readFileSync(file, 'utf8'), /MT-2/);
  } finally {
    delete process.env.SNUGCODE_KEYCHAIN_FAKE;
  }
});

test('engine Gemini CLI: konfigurasi, env tanpa kredensial, ID model, diff & instruksi proyek', async () => {
  const G = await import('../daemon/gemini.js');
  const { decideGemini, toolOf } = await import('../daemon/engine-gemini.js');
  const home = G.geminiHome({ computer: false });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(settings.security.folderTrust.enabled, true, 'konfigurasi Gemini CLI milik repo tidak dimuat');
  assert.equal(settings.general.enableAutoUpdate, false);
  assert.match(fs.readFileSync(path.join(home, '.gemini', 'GEMINI.md'), 'utf8'), /snugcode/);
  assert.ok(home.startsWith(TMP_HOME), 'GEMINI_CLI_HOME di folder data snugcode');

  const env = G.geminiEnv({ PATH: '/bin', GOOGLE_API_KEY: 'x', GOOGLE_APPLICATION_CREDENTIALS: '/c.json', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, { home, baseUrl: 'http://127.0.0.1:1', token: 'pc-local-t' });
  assert.equal(env.GEMINI_API_KEY, 'pc-local-t');
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:1');
  for (const k of ['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) assert.ok(!(k in env), k + ' dibuang');

  assert.equal(G.geminiModelId('gemini-3.8-pro-high'), 'gemini-3.8-pro');
  assert.equal(G.geminiModelId('gemini-3.8-flash'), 'gemini-3.8-flash');
  const d = G.diffOf([{ type: 'diff', path: '/r/a.js', oldText: 'a\nb\nc', newText: 'a\nB\nc' }], '/r');
  assert.equal(d[0].rel, 'a.js');
  assert.equal(d[0].diff, '@@ a.js @@\n-b\n+B');
  assert.equal(G.diffOf([{ type: 'diff', path: '/r/n.txt', oldText: null, newText: 'x' }], '/r')[0].diff, '@@ n.txt @@\n+x');
  assert.equal(toolOf({ toolCallId: 'run_shell_command__run_shell_command_1_0' }), 'run_shell_command');

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-gem-proj-'));
  assert.equal(G.projectInstructions(cwd), '');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'pakai pnpm\n');
  assert.match(G.projectInstructions(cwd), /<project_instructions file="AGENTS.md">\npakai pnpm\n<\/project_instructions>/);

  // Izin: perintah shell lewat kebijakan Bash (auto-izin tidak berlaku), edit di dalam worktree langsung.
  const asked = [];
  const s = {
    meta: { cwd, auto: true },
    allowRules: new Set(),
    agent: { unsandboxedAuto: true },
    askPermission: async (tool, input) => (asked.push([tool, input]), { behavior: 'deny' }),
    requestUser: async (tool, input) => (asked.push([tool, input]), { behavior: 'deny' }),
  };
  assert.equal(await decideGemini(s, { kind: 'execute', title: 'npm test' }), false);
  assert.deepEqual(asked.at(-1), ['Bash', { command: 'npm test' }]);
  s.meta.auto = false;
  assert.equal(await decideGemini(s, { kind: 'edit', content: [{ type: 'diff', path: path.join(cwd, 'a.js'), oldText: 'a', newText: 'b' }] }), true);
  assert.equal(await decideGemini(s, { kind: 'edit', content: [{ type: 'diff', path: path.join(TMP_HOME, 'secrets.json'), oldText: '', newText: 'x' }] }), false, 'folder data snugcode ditolak');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('runner Codespaces: perkiraan core-jam per bulan dari waktu menyala', async () => {
  const { tickUsage, usageSummary, readUsage } = await import('../daemon/runner.js');
  const file = path.join(TMP_HOME, 'usage-test.json');
  const t0 = Date.UTC(2026, 9, 31, 22, 0, 0);
  tickUsage(t0, { file, cores: 2 });
  for (let i = 1; i <= 60; i++) tickUsage(t0 + i * 60_000, { file, cores: 2 }); // 1 jam menyala
  let s = usageSummary(t0 + 60 * 60_000 - 1, file);
  assert.equal(s.month, '2026-10');
  assert.equal(s.hours, 1);
  assert.equal(s.coreHours, 2);
  // Celah panjang (runner mati) tidak dihitung; bulan baru mulai dari nol.
  tickUsage(t0 + 5 * 3600_000, { file, cores: 2 });
  tickUsage(t0 + 5 * 3600_000 + 60_000, { file, cores: 2 });
  s = usageSummary(t0 + 5 * 3600_000 + 60_000, file);
  assert.equal(s.month, '2026-11');
  assert.equal(s.coreHours, 0);
  assert.ok(readUsage(file).months['2026-11'].secs === 60);
  fs.writeFileSync(file, 'rusak');
  assert.deepEqual(readUsage(file), { months: {} }, 'file rusak tidak menggagalkan runner');
});
