// Deteksi cara menyiapkan & menjalankan proyek di worktree, dan template .env per repo.
// Worktree baru hanya berisi file yang ada di git: tanpa node_modules dan tanpa .env,
// jadi dev server tidak akan jalan sebelum keduanya disiapkan.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';
import { git } from './github.js';

const ENV_DIR = path.join(HOME, 'env');
const LOCKS = [
  ['pnpm-lock.yaml', 'pnpm', 'pnpm install'],
  ['bun.lock', 'bun', 'bun install'],
  ['bun.lockb', 'bun', 'bun install'],
  ['yarn.lock', 'yarn', 'yarn install'],
  ['package-lock.json', 'npm', 'npm ci'],
];
const DEV_SCRIPTS = ['dev', 'start', 'serve', 'preview'];

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// `.snugcode.json` (atau `.pocketcode.json` lama) di root repo bisa menimpa deteksi: { "setup": "...", "dev": "..." }.
export function detectProject(cwd) {
  const own = readJson(path.join(cwd, '.snugcode.json')) || readJson(path.join(cwd, '.pocketcode.json')) || {};
  const has = (f) => fs.existsSync(path.join(cwd, f));
  const pkg = readJson(path.join(cwd, 'package.json'));
  let setup = null;
  let dev = null;
  if (pkg) {
    const lock = LOCKS.find(([f]) => has(f));
    const pm = lock?.[1] || pkg.packageManager?.split('@')[0] || 'npm';
    if (!has('node_modules')) setup = lock?.[2] || `${pm} install`;
    const script = DEV_SCRIPTS.find((s) => pkg.scripts?.[s]);
    if (script) dev = `${pm} run ${script}`;
  } else if (has('manage.py')) dev = 'python manage.py runserver {port}';
  else if (has('index.html')) dev = 'npx --yes serve -l {port}';
  return { setup: own.setup ?? setup, dev: own.dev ?? dev };
}

const envDir = (repo) => path.join(ENV_DIR, repo.replace('/', '__').replace(/[^\w.-]/g, '_'));

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

// Salin template .env repo ke worktree baru (tidak menimpa file yang sudah ada).
export function restoreEnv(repo, cwd) {
  const dir = envDir(repo);
  if (!fs.existsSync(dir)) return [];
  const copied = [];
  for (const rel of walk(dir)) {
    const dest = path.join(cwd, rel);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(dir, rel), dest);
    copied.push(rel.replace(/\\/g, '/'));
  }
  return copied;
}

// Simpan file env yang di-ignore git (.env*, .dev.vars) dari worktree sebagai template repo.
export async function saveEnv(repo, cwd) {
  const out = await git(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ':(glob)**/.env*', ':(glob)**/.dev.vars', ':(exclude,glob)**/node_modules/**']);
  const files = out.split('\0').filter(Boolean);
  const dir = envDir(repo);
  for (const rel of files) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(cwd, rel), dest);
  }
  return files;
}
