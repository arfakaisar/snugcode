// Per-prompt checkpoints: the worktree contents (including uncommitted files) are saved as a git
// tree through a temporary index, without touching the user's index, branch, or stash.
// Rewind restores every file to the snapshot and deletes files created afterwards.
import path from 'node:path';
import fs from 'node:fs';
import { git } from './github.js';

// node_modules without a .gitignore can hold hundreds of thousands of files: never snapshot it.
const PATHSPEC = ['--', '.', ':(exclude,glob)**/node_modules/**'];

// The temporary index location per worktree never changes: ask git once.
const indexFiles = new Map();
async function indexEnv(cwd) {
  let file = indexFiles.get(cwd);
  if (!file) {
    file = path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', 'pocketcode-index'] /* old name kept: checkpoints of old sessions can still be rewound */)).trim());
    indexFiles.set(cwd, file);
  }
  fs.rmSync(file + '.lock', { force: true });
  return { GIT_INDEX_FILE: file };
}

// The temporary index is reused between snapshots, so only changed files are re-hashed.
export async function snapshot(cwd) {
  const env = await indexEnv(cwd);
  await git(cwd, ['add', '-A', ...PATHSPEC], null, { env });
  return (await git(cwd, ['write-tree'], null, { env })).trim();
}

export async function rewind(cwd, tree) {
  const now = await snapshot(cwd);
  const added = (await git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', tree, now, ...PATHSPEC])).split('\0').filter(Boolean);
  for (const f of added) fs.rmSync(path.join(cwd, f), { force: true });
  const changed = (await git(cwd, ['diff', '--name-only', '-z', '--no-renames', tree, now, ...PATHSPEC])).split('\0').filter(Boolean);
  if (changed.length > added.length) await git(cwd, ['restore', `--source=${tree}`, '--worktree', ...PATHSPEC]);
  return changed.length;
}
