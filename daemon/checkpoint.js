// Per-prompt checkpoints: the worktree contents (including uncommitted files) are saved as a git
// tree through a temporary index, without touching the user's index, branch, or stash.
// Rewind restores every file to the snapshot and deletes files created afterwards.
import path from 'node:path';
import fs from 'node:fs';
import { git } from './github.js';

// node_modules without a .gitignore can hold hundreds of thousands of files: never snapshot it.
const PATHSPEC = ['--', '.', ':(exclude,glob)**/node_modules/**'];

// Temporary indexes per worktree (their location never changes: ask git once). `pocketcode-index` = checkpoints (old
// name kept: checkpoints of old sessions can still be rewound); `snugcode-diff-index` = the phone's diff view, separate
// so a diff and a checkpoint running at the same time never share an index (each one clears its own stale lock).
export const CHECKPOINT_INDEX = 'pocketcode-index';
export const DIFF_INDEX = 'snugcode-diff-index';
const indexFiles = new Map();
async function indexEnv(cwd, name) {
  const k = cwd + '\0' + name;
  let file = indexFiles.get(k);
  if (!file) {
    file = path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', name])).trim());
    indexFiles.set(k, file);
  }
  fs.rmSync(file + '.lock', { force: true });
  return { GIT_INDEX_FILE: file };
}

// The temporary index is reused between snapshots, so only changed files are re-hashed.
export async function snapshot(cwd, { index = CHECKPOINT_INDEX } = {}) {
  const env = await indexEnv(cwd, index);
  await git(cwd, ['add', '-A', ...PATHSPEC], null, { env });
  return (await git(cwd, ['write-tree'], null, { env })).trim();
}

// A tree that no ref points at is deleted by `git gc` after ~2 weeks, and then that prompt can't be rewound anymore.
// Checkpoints of snugcode's own worktrees are kept reachable under refs/snugcode/cp/<session>/<prompt> (not branches
// or tags: invisible to `git branch`, never fetched or pushed) and dropped with the session.
const cpRef = (sid, seq) => `refs/snugcode/cp/${sid}/${seq}`;
export async function keepCheckpoint(cwd, sid, seq, tree) {
  await git(cwd, ['update-ref', cpRef(sid, seq), tree]);
}
export async function dropCheckpoints(cwd, sid) {
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname)', `refs/snugcode/cp/${sid}/`])).split('\n').filter(Boolean);
  if (!refs.length) return 0;
  await git(cwd, ['update-ref', '--stdin'], null, { input: refs.map((r) => `delete ${r}\n`).join('') });
  return refs.length;
}

export async function rewind(cwd, tree) {
  const now = await snapshot(cwd);
  const added = (await git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', tree, now, ...PATHSPEC])).split('\0').filter(Boolean);
  for (const f of added) fs.rmSync(path.join(cwd, f), { force: true });
  const changed = (await git(cwd, ['diff', '--name-only', '-z', '--no-renames', tree, now, ...PATHSPEC])).split('\0').filter(Boolean);
  if (changed.length > added.length) await git(cwd, ['restore', `--source=${tree}`, '--worktree', ...PATHSPEC]);
  return changed.length;
}
