// Agent & daemon safeguards: repo config files, OS sandbox under auto-approve, CLAUDE.md, PIN lockout, update channels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Temporary data folder (before daemon modules are imported: HOME is read at import time).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-hard-'));
process.env.SNUGCODE_HOME = TMP_HOME;
delete process.env.SNUGCODE_SANDBOX;
test.after(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }));

const settled = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('waiting'), 50))]);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i');
  return dir;
}

test('permissions: repo config files (.claude/.codex/.mcp.json/.git) are recognized', async () => {
  const { isProtectedRepoPath, neverAlways } = await import('../daemon/permissions.js');
  const cwd = path.join(TMP_HOME, 'workspaces', 'a__b');
  for (const p of ['.claude/settings.json', '.claude/settings.local.json', 'sub/.claude/agents/x.md', '.codex/config.toml', '.mcp.json', '.git/hooks/pre-commit', '.git/config', '.GIT/config', '.git']) assert.ok(isProtectedRepoPath(path.join(cwd, p), cwd), p);
  // Files that run code in CI / Codespaces / the editor without the user starting them.
  for (const p of ['.github/workflows/ci.yml', '.GitHub/Workflows/x.yaml', '.github/actions/setup/action.yml', '.devcontainer/devcontainer.json', '.devcontainer.json', '.vscode/tasks.json', '.husky/pre-commit', '.envrc']) assert.ok(isProtectedRepoPath(path.join(cwd, p), cwd), p);
  for (const p of ['src/a.js', 'docs/.mcp.json', 'claude/x', '.github/ISSUE_TEMPLATE/bug.md', '.github/CODEOWNERS', 'docs/.envrc', '.gitignore', 'CLAUDE.md']) assert.ok(!isProtectedRepoPath(path.join(cwd, p), cwd), p);
  assert.ok(!isProtectedRepoPath('/etc/.git/config', cwd), 'outside the worktree: other rules apply');
  assert.ok(neverAlways('Bash', { command: 'npm test', dangerouslyDisableSandbox: true }));
  assert.ok(!neverAlways('Bash', { command: 'npm test' }));
  assert.ok(neverAlways('Bash', { command: 'cat $SNUGCODE_HOME/x' }));
});

test('permissions: auto-approve still asks for repo config, leaving the sandbox, and Bash without a sandbox', async () => {
  const { Session } = await import('../daemon/sessions.js');
  const cwd = repo(path.join(TMP_HOME, 'workspaces', 'perm-' + Date.now()));
  const mgr = { config: {}, secrets: {}, log() {}, notify() {}, saveIndex() {}, trimAgents() {} };
  const s = new Session({ id: 'thard', cwd, repo: 'a/b', model: 'm' }, mgr);
  try {
    // A regular edit in the worktree: direct; tool config: asks even under auto-approve.
    assert.equal((await s.askPermission('Write', { file_path: path.join(cwd, 'b.js'), content: 'x' })).behavior, 'allow');
    s.meta.auto = true;
    assert.equal(await settled(s.askPermission('Write', { file_path: path.join(cwd, '.claude', 'settings.json'), content: '{"hooks":{}}' })), 'waiting');
    assert.equal(await settled(s.askPermission('Edit', { file_path: path.join(cwd, '.git', 'config'), old_string: 'a', new_string: 'b' })), 'waiting');
    // Reading config is still allowed.
    assert.equal((await s.askPermission('Read', { file_path: path.join(cwd, '.mcp.json') })).behavior, 'allow');
    // Auto-approve + a sandboxed agent process: Bash passes; leaving the sandbox: asks.
    s.agent = /** @type {any} */ ({ unsandboxedAuto: false });
    assert.equal((await s.askPermission('Bash', { command: 'npm test' })).behavior, 'allow');
    assert.equal(await settled(s.askPermission('Bash', { command: 'npm test', dangerouslyDisableSandbox: true })), 'waiting');
    // Bash without an OS sandbox (Windows, or auto-approve turned on mid-process): only routine commands pass,
    // anything else asks (it could read the credentials in the snugcode data folder).
    s.agent = /** @type {any} */ ({ unsandboxedAuto: true });
    assert.equal(await settled(s.askPermission('Bash', { command: 'ls' })), 'waiting');
    assert.equal(await settled(s.askPermission('Bash', { command: 'type %USERPROFILE%\\.snug*\\s*.json' })), 'waiting');
    assert.equal((await s.askPermission('Bash', { command: 'npm test' })).behavior, 'allow');
    assert.equal(await settled(s.askPermission('Bash', { command: 'npm test && cat x' })), 'waiting');
    assert.equal((await s.askPermission('Write', { file_path: path.join(cwd, 'c.js'), content: 'x' })).behavior, 'allow');
    // Codex engine: repo config file changes also ask.
    s.agent = null;
    assert.equal(await settled(s.decideCodex('file', { changes: [{ path: '.codex/config.toml', diff: '+x' }] })), 'waiting');
    assert.equal(await s.decideCodex('file', { changes: [{ path: 'src/x.js', diff: '+x' }] }), 'accept');
  } finally {
    s.agent = null;
    s.endTurn();
  }
});

test('sandbox: mode, SDK options (credentials closed, worktree & caches writable, git hooks locked)', async () => {
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
    assert.equal(o.autoAllowBashIfSandboxed, false, 'approval still goes through snugcode\'s policy');
    assert.equal(o.failIfUnavailable, false);
    assert.deepEqual(o.network.allowedDomains, ['*']);
    assert.ok(o.filesystem.denyRead.includes(path.join(HOME, 'secrets.json')));
    assert.ok(o.filesystem.denyRead.includes(path.join(HOME, 'codex')));
    assert.ok(o.filesystem.allowWrite.includes(WORKSPACES));
    assert.ok(o.filesystem.allowWrite.includes(path.join(home, '.npm')) && fs.existsSync(path.join(home, '.npm')));
    assert.ok(!o.filesystem.allowWrite.includes(home), 'the user\'s home is not writable in repo sessions');
    const gitDir = path.join(base, '.git');
    // realpath: on macOS the temp folder (/var/…) is a symlink to /private/var/…; on Windows os.tmpdir()
    // uses an 8.3 short name (RUNNER~1) while git returns the long name — only the native version
    // translates it.
    const real = (/** @type {string} */ p) => fs.realpathSync.native(p);
    const denied = o.filesystem.denyWrite.map(real);
    assert.ok(denied.includes(real(path.join(gitDir, 'hooks'))), JSON.stringify({ denied, gitDir }));
    assert.ok(denied.includes(real(path.join(gitDir, 'config'))));
    // Computer Mode: home is writable, the data folder isn't.
    const oc = sandboxOptions({ cwd: home, computer: true, home });
    assert.ok(oc.filesystem.allowWrite.includes(home));
    assert.ok(oc.filesystem.denyWrite.includes(HOME));
    // Sandbox placeholders are ignored by git in snugcode-managed repos (only once).
    assert.equal(excludeSandboxStubs(wt), true);
    assert.equal(excludeSandboxStubs(wt), false);
    const exclude = fs.readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^\/\.bashrc$/m);
    assert.match(exclude, /^\/\.claude\/$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('prompt: the project CLAUDE.md is loaded by us (Claude Code project settings are not loaded)', async () => {
  const { projectInstructions, snugcodePrompt } = await import('../daemon/prompt.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-md-'));
  try {
    assert.equal(projectInstructions(cwd), '');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Use pnpm.\n');
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.writeFileSync(path.join(cwd, '.claude', 'CLAUDE.md'), 'x'.repeat(50 * 1024));
    const p = projectInstructions(cwd);
    assert.match(p, /Contents of CLAUDE\.md[^]*Use pnpm\./);
    assert.match(p, /Contents of \.claude\/CLAUDE\.md[^]*…\(truncated\)/);
    assert.ok(p.length < 45 * 1024);
    assert.ok(snugcodePrompt({ project: p }).endsWith(p));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  const src = fs.readFileSync(new URL('../daemon/engine-claude.js', import.meta.url), 'utf8');
  assert.match(src, /settingSources: \[\]/);
});

test('PIN: 5 failed attempts lock temporarily (doubling), a successful pairing / new PIN unlocks', async () => {
  const { pinAttempt, pinLockedUntil, resetPinLock, MAX_PIN_FAILS } = await import('../daemon/config.js');
  const sec = { pinFails: 0 };
  let t = 1_000_000;
  for (let i = 1; i <= MAX_PIN_FAILS; i++) assert.deepEqual(pinAttempt(sec, t), { ok: true, left: MAX_PIN_FAILS - i });
  const until = pinLockedUntil(sec, t);
  assert.equal(until, t + 15 * 60 * 1000);
  assert.deepEqual(pinAttempt(sec, t + 1000), { ok: false, until });
  // The lock expires: a new round, the next lock lasts twice as long.
  t = until + 1;
  for (let i = 0; i < MAX_PIN_FAILS; i++) assert.ok(pinAttempt(sec, t).ok);
  assert.equal(pinLockedUntil(sec, t), t + 30 * 60 * 1000);
  resetPinLock(sec);
  assert.equal(pinLockedUntil(sec, t), 0);
  assert.deepEqual(pinAttempt(sec, t), { ok: true, left: MAX_PIN_FAILS - 1 });
  // A permanent lock from an old version (pinFails >= 5 without a time) no longer locks forever.
  assert.ok(pinAttempt({ pinFails: 5 }, t).ok);
});

test('updater: stable/main channels & release version comparison', async () => {
  const { semverGt, updateChannel } = await import('../daemon/updater.js');
  assert.ok(semverGt('v0.2.0', '0.1.0'));
  assert.ok(semverGt('v1.0.0', '0.9.9'));
  assert.ok(semverGt('0.10.0', '0.9.0'));
  assert.ok(!semverGt('v0.2.0', '0.2.0'));
  assert.ok(!semverGt('v0.2.0-rc.1', '0.2.0'));
  assert.equal(updateChannel({}), 'stable');
  assert.equal(updateChannel({ updateChannel: 'main' }), 'main');
});
