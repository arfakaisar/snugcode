// Sandbox OS untuk perintah Bash engine Claude (fitur sandbox Claude Code: bubblewrap + socat di
// Linux, Seatbelt di macOS). Daftar hitam regex tidak cukup untuk melindungi folder data snugcode
// (`cat ~/.snug*/s*.json` lolos), jadi saat perintah berjalan tanpa dilihat pengguna (auto-izin)
// perintah dijalankan di sandbox yang menolak membaca kredensial di tingkat OS.
//
// Diukur dengan Agent SDK asli: di sandbox, folder data tertutup, worktree & git commit tetap jalan,
// jaringan keluar tetap ada (allowedDomains '*'), tetapi `localhost` milik host TIDAK terjangkau
// (dev server/DB lokal). Karena itu bawaannya sandbox hanya untuk auto-izin; perintah yang perlu
// keluar dari sandbox (dangerouslyDisableSandbox) selalu meminta persetujuan pengguna.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, WORKSPACES } from './config.js';
import { deniedPaths } from './codex.js';

const onPath = (bin) => (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));

/** Mode dari config.json `sandbox` / env SNUGCODE_SANDBOX: 'auto' (bawaan: hanya saat auto-izin), 'always', 'off'. */
export function sandboxMode(cfg = {}) {
  const v = String(process.env.SNUGCODE_SANDBOX ?? cfg.sandbox ?? 'auto').toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(v)) return 'off';
  if (['always', '1', 'on', 'true'].includes(v)) return 'always';
  return 'auto';
}

// Dicek sekali per proses daemon. Dependensi yang hilang membuat Claude Code diam-diam berjalan
// TANPA sandbox (hanya peringatan di stderr), jadi kita periksa sendiri agar bisa memberi tahu pengguna.
// Windows belum diaktifkan: belum diuji dengan snugcode.
/** @type {Promise<{ ok: boolean, reason?: string }> | null} */
let probe = null;
export function sandboxSupport() {
  probe ??= (async () => {
    if (process.platform === 'darwin') return fs.existsSync('/usr/bin/sandbox-exec') ? { ok: true } : { ok: false, reason: 'sandbox-exec tidak ditemukan' };
    if (process.platform !== 'linux') return { ok: false, reason: `belum didukung di ${process.platform}` };
    const missing = ['bwrap', 'socat'].filter((b) => !onPath(b));
    if (missing.length) return { ok: false, reason: `pasang ${missing.map((m) => (m === 'bwrap' ? 'bubblewrap' : m)).join(' & ')} (mis. \`sudo apt install bubblewrap socat\`)` };
    // User namespace bisa diblokir (Docker tanpa izin tambahan, AppArmor Ubuntu 24.04+).
    return new Promise((resolve) =>
      execFile('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', 'true'], { timeout: 10_000 }, (err) =>
        resolve(err ? { ok: false, reason: 'bubblewrap tidak bisa membuat namespace (container/AppArmor membatasinya)' } : { ok: true }),
      ),
    );
  })();
  return probe;
}

// Cache paket yang wajar ditulis perintah instal/build (di luar worktree). Folder bin (~/.cargo/bin,
// ~/go/bin, …) sengaja tidak termasuk: binary yang ditanam di sana dijalankan nanti di luar sandbox.
const CACHE_DIRS = ['.npm', '.cache', '.pnpm-store', '.local/share/pnpm/store', '.yarn/berry/cache', '.bun/install/cache', '.cargo/registry', '.cargo/git', 'go/pkg/mod', '.gradle/caches', '.m2/repository'];
const ALWAYS_CREATE = new Set(['.npm', '.cache']);

// Hook & config git dijalankan daemon (commit dari HP) di luar sandbox: tidak boleh ditulis dari dalam.
function gitGuards(cwd) {
  const git = (args) => {
    try {
      return path.resolve(cwd, execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch {
      return null;
    }
  };
  const common = git(['rev-parse', '--git-common-dir']);
  if (!common) return [];
  const dir = git(['rev-parse', '--git-dir']);
  return [path.join(common, 'hooks'), path.join(common, 'config'), dir && path.join(dir, 'config.worktree')].filter((p) => p && fs.existsSync(p));
}

// Di dalam sandbox, Claude Code menutup dotfile berbahaya yang belum ada di worktree (.bashrc,
// .mcp.json, .vscode, …) dengan placeholder /dev/null. Placeholder itu tidak ada di disk, tetapi
// `git add -A` di dalam sandbox menolaknya, jadi diabaikan lewat info/exclude repo yang dikelola
// snugcode (bukan .gitignore milik repo; repo lokal pengguna tidak disentuh). Nama yang sudah dilacak
// git tidak terpengaruh exclude. .claude/ seluruhnya: isinya (agents, hooks, settings.json, …) berubah per
// versi Claude Code, dan mengubah file di sana memang selalu lewat persetujuan pengguna.
const SANDBOX_STUBS = ['.claude/', '.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.idea', '.mcp.json', '.profile', '.ripgreprc', '.vscode', '.zprofile', '.zshrc'];
const EXCLUDE_MARK = '# snugcode: placeholder sandbox (lihat daemon/sandbox.js)';
export function excludeSandboxStubs(cwd) {
  try {
    const file = path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur.includes(EXCLUDE_MARK)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + EXCLUDE_MARK + '\n' + SANDBOX_STUBS.map((n) => '/' + n).join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Opsi `sandbox` untuk query() Agent SDK.
 * @param {{ cwd: string, computer?: boolean, home?: string }} o
 */
export function sandboxOptions({ cwd, computer = false, home = os.homedir() }) {
  const caches = CACHE_DIRS.map((d) => path.join(home, d)).filter((p) => {
    if (ALWAYS_CREATE.has(path.relative(home, p))) {
      try {
        fs.mkdirSync(p, { recursive: true });
      } catch {}
    }
    return fs.existsSync(p);
  });
  // Mode Komputer boleh menulis di folder home pengguna (bukan hanya worktree); folder data tetap tertutup.
  const allowWrite = [...(computer ? [home] : [WORKSPACES]), ...caches];
  return {
    enabled: true,
    // Dependensi dicek sendiri (sandboxSupport); jangan sampai satu perintah yang gagal mematikan sesi.
    failIfUnavailable: false,
    // Persetujuan tetap lewat kebijakan snugcode (canUseTool), sama seperti tanpa sandbox.
    autoAllowBashIfSandboxed: false,
    network: { allowedDomains: ['*'] },
    filesystem: { denyRead: deniedPaths(), allowWrite, denyWrite: [...(computer ? [HOME] : []), ...gitGuards(cwd)] },
  };
}
