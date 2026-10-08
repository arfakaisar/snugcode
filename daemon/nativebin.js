// Binary native Claude Code (claude.exe) dikirim Agent SDK lewat paket per-platform
// sebagai optionalDependencies. npm diam-diam melewatinya bila gagal dipasang
// (mis. file terkunci di Windows), jadi kita periksa sendiri sebelum dipakai.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PACKAGE_SPEC } from './defaults.js';

const SCOPE = '@anthropic-ai';
const SDK = 'claude-agent-sdk';

// Sama dengan cara SDK mendeteksi Linux musl (Alpine): tidak ada versi glibc di laporan proses.
function isMusl() {
  if (process.platform !== 'linux') return false;
  const r = typeof process.report?.getReport === 'function' ? process.report.getReport() : null;
  return r != null && r.header?.glibcVersionRuntime === undefined;
}

// Nama paket kandidat sesuai urutan yang dicoba SDK, mis. "claude-agent-sdk-win32-x64".
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

// Path claude(.exe) yang akan dipakai SDK bila dimuat dari `fromFile`, atau null.
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

// Cek langsung di disk (tanpa cache resolver Node) — dipakai setelah npm install.
export function nativeBinaryInstalled(root) {
  const dirs = [path.join(root, 'node_modules'), path.join(root, 'node_modules', SCOPE, SDK, 'node_modules')];
  return platformBinaryPackages().some((pkg) => dirs.some((d) => fs.existsSync(path.join(d, SCOPE, pkg, binName()))));
}

export function reinstallHint(root) {
  const isGit = !!root && fs.existsSync(path.join(root, '.git'));
  const cmd = isGit ? `npm install --include=optional (di folder ${root})` : `npm i -g ${PACKAGE_SPEC} --include=optional`;
  return `Jalankan: pocketcode stop${process.platform === 'win32' ? ' (tutup juga claude.exe yang masih jalan)' : ''}, lalu ${cmd}, lalu pocketcode start.`;
}

export function missingBinaryMessage(root) {
  const plat = `${process.platform}-${process.arch}`;
  return `Binary Claude untuk ${plat} tidak ditemukan (paket ${SCOPE}/${platformBinaryPackage()}). ${reinstallHint(root)}`;
}
