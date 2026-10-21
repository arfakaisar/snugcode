// Pengaman agen & daemon: file konfigurasi repo, sandbox OS auto-izin, CLAUDE.md, kunci PIN, kanal pembaruan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Folder data sementara (sebelum modul daemon diimpor: HOME dibaca saat impor).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-hard-'));
process.env.SNUGCODE_HOME = TMP_HOME;
delete process.env.SNUGCODE_SANDBOX;
test.after(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }));

const settled = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('menunggu'), 50))]);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i');
  return dir;
}

test('izin: file konfigurasi repo (.claude/.codex/.mcp.json/.git) dikenali', async () => {
  const { isProtectedRepoPath, neverAlways } = await import('../daemon/permissions.js');
  const cwd = path.join(TMP_HOME, 'workspaces', 'a__b');
  for (const p of ['.claude/settings.json', '.claude/settings.local.json', 'sub/.claude/agents/x.md', '.codex/config.toml', '.mcp.json', '.git/hooks/pre-commit', '.git/config', '.GIT/config', '.git']) assert.ok(isProtectedRepoPath(path.join(cwd, p), cwd), p);
  for (const p of ['src/a.js', 'docs/.mcp.json', 'claude/x', '.github/workflows/ci.yml', '.gitignore', 'CLAUDE.md']) assert.ok(!isProtectedRepoPath(path.join(cwd, p), cwd), p);
  assert.ok(!isProtectedRepoPath('/etc/.git/config', cwd), 'di luar worktree: aturan lain yang berlaku');
  assert.ok(neverAlways('Bash', { command: 'npm test', dangerouslyDisableSandbox: true }));
  assert.ok(!neverAlways('Bash', { command: 'npm test' }));
  assert.ok(neverAlways('Bash', { command: 'cat $SNUGCODE_HOME/x' }));
});

test('izin: auto-izin tetap bertanya untuk konfigurasi repo, keluar sandbox, dan Bash tanpa sandbox', async () => {
  const { Session } = await import('../daemon/sessions.js');
  const cwd = repo(path.join(TMP_HOME, 'workspaces', 'perm-' + Date.now()));
  const mgr = { config: {}, secrets: {}, log() {}, notify() {}, saveIndex() {}, trimAgents() {} };
  const s = new Session({ id: 'thard', cwd, repo: 'a/b', model: 'm' }, mgr);
  try {
    // Edit biasa di worktree: langsung; konfigurasi tool: bertanya walau auto-izin.
    assert.equal((await s.askPermission('Write', { file_path: path.join(cwd, 'b.js'), content: 'x' })).behavior, 'allow');
    s.meta.auto = true;
    assert.equal(await settled(s.askPermission('Write', { file_path: path.join(cwd, '.claude', 'settings.json'), content: '{"hooks":{}}' })), 'menunggu');
    assert.equal(await settled(s.askPermission('Edit', { file_path: path.join(cwd, '.git', 'config'), old_string: 'a', new_string: 'b' })), 'menunggu');
    // Membaca konfigurasi tetap boleh.
    assert.equal((await s.askPermission('Read', { file_path: path.join(cwd, '.mcp.json') })).behavior, 'allow');
    // Auto-izin + proses agen ber-sandbox: Bash lolos; keluar dari sandbox: bertanya.
    s.agent = /** @type {any} */ ({ unsandboxedAuto: false });
    assert.equal((await s.askPermission('Bash', { command: 'npm test' })).behavior, 'allow');
    assert.equal(await settled(s.askPermission('Bash', { command: 'npm test', dangerouslyDisableSandbox: true })), 'menunggu');
    // Auto-izin dinyalakan saat proses berjalan tanpa sandbox: Bash bertanya sampai proses berikutnya.
    s.agent = /** @type {any} */ ({ unsandboxedAuto: true });
    assert.equal(await settled(s.askPermission('Bash', { command: 'ls' })), 'menunggu');
    assert.equal((await s.askPermission('Write', { file_path: path.join(cwd, 'c.js'), content: 'x' })).behavior, 'allow');
    // Engine Codex: perubahan file konfigurasi repo juga bertanya.
    s.agent = null;
    assert.equal(await settled(s.decideCodex('file', { changes: [{ path: '.codex/config.toml', diff: '+x' }] })), 'menunggu');
    assert.equal(await s.decideCodex('file', { changes: [{ path: 'src/x.js', diff: '+x' }] }), 'accept');
  } finally {
    s.agent = null;
    s.endTurn();
  }
});

test('sandbox: mode, opsi SDK (kredensial tertutup, worktree & cache bisa ditulis, git hook terkunci)', async () => {
  const { sandboxMode, sandboxOptions, excludeSandboxStubs } = await import('../daemon/sandbox.js');
  const { WORKSPACES, HOME } = await import('../daemon/config.js');
  assert.equal(sandboxMode({}), 'auto');
  assert.equal(sandboxMode({ sandbox: 'always' }), 'always');
  assert.equal(sandboxMode({ sandbox: false }), 'off');
  process.env.SNUGCODE_SANDBOX = '0';
  assert.equal(sandboxMode({ sandbox: 'always' }), 'off');
  delete process.env.SNUGCODE_SANDBOX;

  const base = repo(path.join(WORKSPACES, 'o__r'));
  const wt = path.join(WORKSPACES, 'o__r--s1');
  git(base, 'worktree', 'add', '-q', '-b', 's1', wt);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-userhome-'));
  try {
    const o = sandboxOptions({ cwd: wt, home });
    assert.equal(o.enabled, true);
    assert.equal(o.autoAllowBashIfSandboxed, false, 'persetujuan tetap lewat kebijakan snugcode');
    assert.equal(o.failIfUnavailable, false);
    assert.deepEqual(o.network.allowedDomains, ['*']);
    assert.ok(o.filesystem.denyRead.includes(path.join(HOME, 'secrets.json')));
    assert.ok(o.filesystem.denyRead.includes(path.join(HOME, 'codex')));
    assert.ok(o.filesystem.allowWrite.includes(WORKSPACES));
    assert.ok(o.filesystem.allowWrite.includes(path.join(home, '.npm')) && fs.existsSync(path.join(home, '.npm')));
    assert.ok(!o.filesystem.allowWrite.includes(home), 'home pengguna tidak bisa ditulis di sesi repo');
    const gitDir = path.join(base, '.git');
    // realpath: di macOS folder sementara (/var/…) adalah symlink ke /private/var/…; di Windows os.tmpdir()
    // memakai nama pendek 8.3 (RUNNER~1) sedangkan git mengembalikan nama panjang — hanya versi native
    // yang menerjemahkannya.
    const real = (/** @type {string} */ p) => fs.realpathSync.native(p);
    const denied = o.filesystem.denyWrite.map(real);
    assert.ok(denied.includes(real(path.join(gitDir, 'hooks'))), JSON.stringify({ denied, gitDir }));
    assert.ok(denied.includes(real(path.join(gitDir, 'config'))));
    // Mode Komputer: home boleh ditulis, folder data tidak.
    const oc = sandboxOptions({ cwd: home, computer: true, home });
    assert.ok(oc.filesystem.allowWrite.includes(home));
    assert.ok(oc.filesystem.denyWrite.includes(HOME));
    // Placeholder sandbox diabaikan git di repo yang dikelola snugcode (sekali saja).
    assert.equal(excludeSandboxStubs(wt), true);
    assert.equal(excludeSandboxStubs(wt), false);
    const exclude = fs.readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^\/\.bashrc$/m);
    assert.match(exclude, /^\/\.claude\/$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('prompt: CLAUDE.md proyek dimuat sendiri (setelan proyek Claude Code tidak dimuat)', async () => {
  const { projectInstructions, snugcodePrompt } = await import('../daemon/prompt.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-md-'));
  try {
    assert.equal(projectInstructions(cwd), '');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Pakai pnpm.\n');
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.writeFileSync(path.join(cwd, '.claude', 'CLAUDE.md'), 'x'.repeat(50 * 1024));
    const p = projectInstructions(cwd);
    assert.match(p, /Contents of CLAUDE\.md[^]*Pakai pnpm\./);
    assert.match(p, /Contents of \.claude\/CLAUDE\.md[^]*…\(truncated\)/);
    assert.ok(p.length < 45 * 1024);
    assert.ok(snugcodePrompt({ project: p }).endsWith(p));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  const src = fs.readFileSync(new URL('../daemon/engine-claude.js', import.meta.url), 'utf8');
  assert.match(src, /settingSources: \[\]/);
});

test('PIN: 5 percobaan gagal mengunci sementara (berlipat), pairing berhasil / PIN baru membuka', async () => {
  const { pinAttempt, pinLockedUntil, resetPinLock, MAX_PIN_FAILS } = await import('../daemon/config.js');
  const sec = { pinFails: 0 };
  let t = 1_000_000;
  for (let i = 1; i <= MAX_PIN_FAILS; i++) assert.deepEqual(pinAttempt(sec, t), { ok: true, left: MAX_PIN_FAILS - i });
  const until = pinLockedUntil(sec, t);
  assert.equal(until, t + 15 * 60 * 1000);
  assert.deepEqual(pinAttempt(sec, t + 1000), { ok: false, until });
  // Kunci lewat: putaran baru, kunci berikutnya dua kali lebih lama.
  t = until + 1;
  for (let i = 0; i < MAX_PIN_FAILS; i++) assert.ok(pinAttempt(sec, t).ok);
  assert.equal(pinLockedUntil(sec, t), t + 30 * 60 * 1000);
  resetPinLock(sec);
  assert.equal(pinLockedUntil(sec, t), 0);
  assert.deepEqual(pinAttempt(sec, t), { ok: true, left: MAX_PIN_FAILS - 1 });
  // Kunci permanen versi lama (pinFails >= 5 tanpa waktu) tidak lagi mengunci selamanya.
  assert.ok(pinAttempt({ pinFails: 5 }, t).ok);
});

test('updater: kanal stable/main & perbandingan versi rilis', async () => {
  const { semverGt, updateChannel } = await import('../daemon/updater.js');
  assert.ok(semverGt('v0.2.0', '0.1.0'));
  assert.ok(semverGt('v1.0.0', '0.9.9'));
  assert.ok(semverGt('0.10.0', '0.9.0'));
  assert.ok(!semverGt('v0.2.0', '0.2.0'));
  assert.ok(!semverGt('v0.2.0-rc.1', '0.2.0'));
  assert.equal(updateChannel({}), 'stable');
  assert.equal(updateChannel({ updateChannel: 'main' }), 'main');
});
