// Shell & toolchain for user/agent commands (`!command`, background processes).
//
// pnpm/yarn without a global install: many repos use them, but the PC may not have them
// (and since Node 25 corepack no longer ships with Node). Corepack is installed once into
// ~/.snugcode/tools, its pnpm/yarn shims into ~/.snugcode/bin/pm. The pnpm/yarn version follows
// "packageManager" in the project's package.json. The shim folder goes at the END of PATH, so the
// user's own pnpm/yarn (if any) still wins.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { HOME } from './config.js';

const isWin = process.platform === 'win32';

// PowerShell on Windows, $SHELL on macOS/Linux. Windows' default ExecutionPolicy blocks
// npm.ps1/npx.ps1 ("running scripts is disabled"); Bypass only applies to this process.
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
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${what} failed (exit ${code}): ${err.trim()}`))));
  });

async function installShims() {
  fs.mkdirSync(TOOLS, { recursive: true });
  const pkg = path.join(TOOLS, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, '{ "private": true }\n');
  await exited(shellSpawn('npm install corepack --no-audit --no-fund --loglevel=error', { cwd: TOOLS }), 'Installing corepack');
  fs.mkdirSync(PM_DIR, { recursive: true });
  const corepack = path.join(TOOLS, 'node_modules', 'corepack', 'dist', 'corepack.js');
  await exited(spawn(process.execPath, [corepack, 'enable', '--install-directory', PM_DIR, 'pnpm', 'yarn'], { windowsHide: true }), 'corepack enable');
}

let installing = null;
// env for the process running `cmd`: install the shims first if the command needs pnpm/yarn
// that the PC doesn't have, then add their folder to PATH.
export async function toolchainEnv(cmd, env) {
  const need = String(cmd || '').match(PM_RE)?.[1];
  if (need && !ready() && !which(need)) await (installing ??= installShims().finally(() => (installing = null)));
  if (!ready()) return env;
  // Windows: the key is "Path"; adding a separate "PATH" makes two conflicting variables.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { ...env, [key]: (env[key] ? env[key] + path.delimiter : '') + PM_DIR, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
}
