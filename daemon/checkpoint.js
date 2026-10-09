// Checkpoint per prompt: isi worktree (termasuk file yang belum di-commit) disimpan sebagai
// tree git lewat index sementara, tanpa menyentuh index, branch, atau stash pengguna.
// Rewind mengembalikan semua file ke snapshot dan menghapus file yang dibuat setelahnya.
import path from 'node:path';
import fs from 'node:fs';
import { git } from './github.js';

// node_modules tanpa .gitignore bisa berisi ratusan ribu file: jangan pernah di-snapshot.
const PATHSPEC = ['--', '.', ':(exclude,glob)**/node_modules/**'];

// Lokasi index sementara per worktree tidak berubah: cukup tanya git sekali.
const indexFiles = new Map();
async function indexEnv(cwd) {
  let file = indexFiles.get(cwd);
  if (!file) {
    file = path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', 'pocketcode-index'])).trim());
    indexFiles.set(cwd, file);
  }
  fs.rmSync(file + '.lock', { force: true });
  return { GIT_INDEX_FILE: file };
}

// Index sementara dipakai ulang antar snapshot, jadi hanya file yang berubah yang di-hash ulang.
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
