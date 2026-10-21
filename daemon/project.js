// Detects how to set up & run the project in a worktree, plus per-repo .env templates.
// A new worktree only has the files tracked by git: no node_modules and no .env,
// so the dev server won't run until both are prepared.
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

// `.snugcode.json` (or legacy `.pocketcode.json`) at the repo root can override detection: { "setup": "...", "dev": "..." }.
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

// Copy the repo's .env template into a new worktree (never overwrites existing files).
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

// Save git-ignored env files (.env*, .dev.vars) from the worktree as the repo template.
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
