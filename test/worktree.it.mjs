// Uji integrasi worktree (butuh internet, pakai repo publik octocat/Hello-World).
//   node test/worktree.it.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.POCKETCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-wt-'));
const { prepareWorktree, removeWorktree, git } = await import('../daemon/github.js');
const REPO = 'octocat/Hello-World';
const ok = (m) => console.log('✔ ' + m);

// 1. Lanjutkan branch default (dulu gagal: "'master' is already used by worktree at …/_base").
const s1 = await prepareWorktree(null, REPO, { branch: 'master', sessionId: 'a1' });
assert.equal((await git(s1.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'master');
assert.ok(fs.existsSync(path.join(s1.cwd, 'README')));
ok('lanjutkan branch default (master)');

// 2. Branch yang sama di sesi kedua -> pesan jelas.
await assert.rejects(prepareWorktree(null, REPO, { branch: 'master', sessionId: 'a2' }), /sedang dibuka di sesi lain \(a1\)/);
ok('branch yang sedang dipakai sesi lain ditolak dengan pesan jelas');

// 3. Branch baru dari base default.
const s3 = await prepareWorktree(null, REPO, { branch: 'pocket/a3', sessionId: 'a3' });
assert.equal(s3.base, 'master');
ok('branch baru dari base default');

// 4. Branch lain yang ada di GitHub -> tracking origin.
const s4 = await prepareWorktree(null, REPO, { branch: 'test', sessionId: 'a4' });
assert.equal((await git(s4.cwd, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim(), 'origin/test');
ok('lanjutkan branch remote lain (test) dengan upstream');

// 5. Branch lokal dari sesi yang sudah dihapus (belum di-push) -> commit-nya tetap ada.
fs.writeFileSync(path.join(s3.cwd, 'x.txt'), 'x');
await git(s3.cwd, ['add', '-A']);
await git(s3.cwd, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'lokal']);
await removeWorktree(s3.cwd);
const s5 = await prepareWorktree(null, REPO, { branch: 'pocket/a3', sessionId: 'a5' });
assert.equal((await git(s5.cwd, ['log', '-1', '--pretty=%s'])).trim(), 'lokal');
ok('lanjutkan branch lokal yang belum di-push tanpa kehilangan commit');

// 6. Setelah sesi 1 dihapus, master bisa dibuka lagi.
await removeWorktree(s1.cwd);
await prepareWorktree(null, REPO, { branch: 'master', sessionId: 'a6' });
ok('branch bisa dibuka lagi setelah sesi lamanya dihapus');

fs.rmSync(process.env.POCKETCODE_HOME, { recursive: true, force: true });
