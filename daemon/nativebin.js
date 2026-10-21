// The native Claude Code binary (claude.exe) ships with the Agent SDK as per-platform packages
// in optionalDependencies. npm silently skips them when they fail to install
// (e.g. locked files on Windows), so we check ourselves before use.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PACKAGE_SPEC } from './defaults.js';

const SCOPE = '@anthropic-ai';
const SDK = 'claude-agent-sdk';

// Same way the SDK detects Linux musl (Alpine): no glibc version in the process report.
function isMusl() {
  if (process.platform !== 'linux') return false;
  const r = typeof process.report?.getReport === 'function' ? process.report.getReport() : null;
  return r != null && /** @type {any} */ (r).header?.glibcVersionRuntime === undefined;
}

// Candidate package names in the order the SDK tries them, e.g. "claude-agent-sdk-win32-x64".
/** @param {{ platform?: string, arch?: string, musl?: boolean }} [target] */
export function platformBinaryPackages({ platform = process.platform, arch = process.arch, musl } = {}) {
  musl ??= platform === 'linux' && isMusl();
  const base = `${SDK}-${platform === 'android' ? 'linux' : platform}-${arch}`;
  if (platform === 'android') return [`${base}-android`];
  if (platform === 'linux') return musl ? [`${base}-musl`, base] : [base, `${base}-musl`];
  return [base];
}

export function platformBinaryPackage(opts) {
  return platformBinaryPackages(opts)[0];
}

const binName = (platform = process.platform) => (platform === 'win32' ? 'claude.exe' : 'claude');

// Path of the claude(.exe) the SDK would use when loaded from `fromFile`, or null.
export function findNativeBinary(fromFile = import.meta.url) {
  const req = createRequire(fromFile);
  for (const pkg of platformBinaryPackages()) {
    try {
      const p = req.resolve(`${SCOPE}/${pkg}/${binName()}`);
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

// Check directly on disk (without Node's resolver cache) — used after npm install.
export function nativeBinaryInstalled(root) {
  const dirs = [path.join(root, 'node_modules'), path.join(root, 'node_modules', SCOPE, SDK, 'node_modules')];
  return platformBinaryPackages().some((pkg) => dirs.some((d) => fs.existsSync(path.join(d, SCOPE, pkg, binName()))));
}

export function reinstallHint(root) {
  const isGit = !!root && fs.existsSync(path.join(root, '.git'));
  const cmd = isGit ? `npm install --include=optional (in the folder ${root})` : `npm i -g ${PACKAGE_SPEC} --include=optional`;
  return `Run: snugcode stop${process.platform === 'win32' ? ' (also close any claude.exe still running)' : ''}, then ${cmd}, then snugcode start.`;
}

export function missingBinaryMessage(root) {
  const plat = `${process.platform}-${process.arch}`;
  return `Claude binary for ${plat} not found (package ${SCOPE}/${platformBinaryPackage()}). ${reinstallHint(root)}`;
}
