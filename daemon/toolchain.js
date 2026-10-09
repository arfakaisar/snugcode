// Shell & toolchain untuk perintah pengguna/agen (`!perintah`, proses latar belakang).
//
// pnpm/yarn tanpa instalasi global: banyak repo memakainya, tapi PC belum tentu punya
// (dan sejak Node 25 corepack tidak lagi ikut Node). Corepack dipasang sekali ke
// ~/.snugcode/tools, shim pnpm/yarn-nya ke ~/.snugcode/bin/pm. Versi pnpm/yarn mengikuti
// "packageManager" di package.json proyek. Folder shim ditaruh di AKHIR PATH, jadi pnpm/yarn
// milik pengguna (bila ada) tetap diutamakan.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { HOME } from './config.js';

const isWin = process.platform === 'win32';

// PowerShell di Windows, $SHELL di macOS/Linux. ExecutionPolicy default Windows memblokir
// npm.ps1/npx.ps1 ("running scripts is disabled"); Bypass hanya berlaku untuk proses ini.
export function shellSpawn(cmd, opts) {
  return spawn(isWin ? 'powershell.exe' : process.env.SHELL || 'bash', isWin ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd] : ['-lc', cmd], { windowsHide: true, ...opts });
}

const PM_DIR = path.join(HOME, 'bin', 'pm');
const TOOLS = path.join(HOME, 'tools');
const PM_RE = /(?:^|[\s;&|(])(pnpm|pnpx|yarn|yarnpkg)(?=\s|$)/;
const ready = () => fs.existsSync(path.join(PM_DIR, 'pnpm'));

export function which(name) {
  try {
    return execFileSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

const exited = (p, what) =>
  new Promise((resolve, reject) => {
    let err = '';
    p.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${what} gagal (exit ${code}): ${err.trim()}`))));
  });

async function installShims() {
  fs.mkdirSync(TOOLS, { recursive: true });
  const pkg = path.join(TOOLS, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, '{ "private": true }\n');
  await exited(shellSpawn('npm install corepack --no-audit --no-fund --loglevel=error', { cwd: TOOLS }), 'Memasang corepack');
  fs.mkdirSync(PM_DIR, { recursive: true });
  const corepack = path.join(TOOLS, 'node_modules', 'corepack', 'dist', 'corepack.js');
  await exited(spawn(process.execPath, [corepack, 'enable', '--install-directory', PM_DIR, 'pnpm', 'yarn'], { windowsHide: true }), 'corepack enable');
}

let installing = null;
// env untuk proses yang menjalankan `cmd`: pasang shim dulu bila perintahnya butuh pnpm/yarn
// yang tidak ada di PC, lalu tambahkan foldernya ke PATH.
export async function toolchainEnv(cmd, env) {
  const need = String(cmd || '').match(PM_RE)?.[1];
  if (need && !ready() && !which(need)) await (installing ??= installShims().finally(() => (installing = null)));
  if (!ready()) return env;
  // Windows: kuncinya "Path"; menambah "PATH" terpisah membuat dua variabel bentrok.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { ...env, [key]: (env[key] ? env[key] + path.delimiter : '') + PM_DIR, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
}
