// Worktree integration test (needs internet, uses the public repo octocat/Hello-World).
//   node test/worktree.it.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.SNUGCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wt-'));
const { prepareWorktree, removeWorktree, git } = await import('../daemon/github.js');
const REPO = 'octocat/Hello-World';
const ok = (m) => console.log('✔ ' + m);

// 1. Continue the default branch (used to fail: "'master' is already used by worktree at …/_base").
const s1 = await prepareWorktree(null, REPO, { branch: 'master', sessionId: 'a1' });
assert.equal((await git(s1.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'master');
assert.ok(fs.existsSync(path.join(s1.cwd, 'README')));
ok('continue the default branch (master)');

// 2. The same branch in a second session -> a clear message.
await assert.rejects(prepareWorktree(null, REPO, { branch: 'master', sessionId: 'a2' }), /is open in another session \(a1\)/);
ok('a branch in use by another session is rejected with a clear message');

// 3. A new branch from the default base.
const s3 = await prepareWorktree(null, REPO, { branch: 'snug/a3', sessionId: 'a3' });
assert.equal(s3.base, 'master');
ok('new branch from the default base');
// 4. Another branch that exists on GitHub -> tracks origin.
const s4 = await prepareWorktree(null, REPO, { branch: 'test', sessionId: 'a4' });
assert.equal((await git(s4.cwd, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim(), 'origin/test');
ok('continue another remote branch (test) with an upstream');

// 5. A local branch from a deleted session (not pushed yet) -> its commit is still there.
fs.writeFileSync(path.join(s3.cwd, 'x.txt'), 'x');
await git(s3.cwd, ['add', '-A']);
await git(s3.cwd, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'local']);
await removeWorktree(s3.cwd);
const s5 = await prepareWorktree(null, REPO, { branch: 'snug/a3', sessionId: 'a5' });
assert.equal((await git(s5.cwd, ['log', '-1', '--pretty=%s'])).trim(), 'local');
ok('continue an unpushed local branch without losing commits');

// 6. After session 1 is deleted, master can be opened again.
await removeWorktree(s1.cwd);
await prepareWorktree(null, REPO, { branch: 'master', sessionId: 'a6' });
ok('a branch can be opened again after its old session is deleted');

fs.rmSync(process.env.SNUGCODE_HOME, { recursive: true, force: true });
