// Kebijakan izin agen yang dipakai bersama engine Claude (canUseTool) dan Codex (decideCodex):
// folder data snugcode, file konfigurasi repo yang bisa mengubah perilaku tool, push ke remote,
// dan aturan "Selalu". Fungsi murni: tidak bergantung pada state sesi.
import path from 'node:path';
import { HOME, WORKSPACES, CLAUDE_DIR } from './config.js';
import { DEV_START } from './devtools.js';

// Diteruskan ke SDK lewat settings.plansDirectory, jadi lokasinya pasti (bukan ~/.claude milik pengguna).
export const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');

export const isInside = (p, dir) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Folder data snugcode berisi key 9router, token GitHub, secret perangkat, template .env repo,
// dan binary yang dijalankan daemon: agen tidak boleh menyentuhnya (termasuk saat auto-izin).
// Pengecualian: worktree sesi, folder plans, dan BACA folder config Claude milik agen sendiri
// (output tool besar disimpan Claude Code di sana lalu dibaca kembali). Menulis ke folder config
// Claude tetap ditolak: settings.json di sana bisa memasang hook yang lolos dari sistem izin.
export const isSensitivePath = (p, { write = false } = {}) =>
  isInside(p, HOME) && !isInside(p, WORKSPACES) && !isInside(p, PLANS_DIR) && (write || !isInside(p, CLAUDE_DIR));
// Hanya penangkap kasus jelas untuk Bash; perlindungan sebenarnya adalah sandbox OS (lihat sandbox.js).
export const SECRET_CMD_RE = /secrets\.json|\.(?:snugcode|pocketcode)[\\/]+(?:secrets|config|sessions|claude|codex|env|bin|tools)\b|\$\{?(?:SNUGCODE|POCKETCODE)_HOME\b/i;

// File di repo yang mengubah perilaku tool tanpa dijalankan pengguna: setelan & hook Claude Code
// (.claude/), konfigurasi Codex (.codex/), server MCP proyek (.mcp.json), dan isi .git (hook, config
// core.fsmonitor/hooksPath yang dijalankan saat daemon memanggil git). Mengubahnya selalu bertanya,
// termasuk saat auto-izin: README/issue yang berisi prompt injection tidak boleh memasang hook diam-diam.
const PROTECTED_DIRS = new Set(['.git', '.claude', '.codex']);
export function isProtectedRepoPath(p, cwd) {
  const rel = path.relative(cwd, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]+/);
  return parts.some((x) => PROTECTED_DIRS.has(x.toLowerCase())) || (parts.length === 1 && parts[0].toLowerCase() === '.mcp.json');
}

// Path yang disentuh tool file (Glob dengan pola absolut: bagian sebelum karakter glob pertama).
export function toolPaths(tool, input = {}, cwd) {
  const out = [input.file_path, input.notebook_path, input.path].filter((p) => typeof p === 'string' && p);
  if (tool === 'Glob' && typeof input.pattern === 'string' && path.isAbsolute(input.pattern)) out.push(input.pattern.split(/[*?[{]/)[0] || input.pattern);
  return out.map((p) => path.resolve(cwd, p));
}

export const isLocalUrl = (u) => {
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol) && /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(url.hostname);
  } catch {
    return false;
  }
};

// Perintah yang menulis ke remote selalu meminta izin, termasuk saat auto-izin aktif.
// Opsi global git di depan subcommand ikut dikenali: `git -C dir push`, `git -c k=v push`.
const GIT_PUSH_RE = /\bgit(?:\.exe)?(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=(?:"[^"]*"|'[^']*'|\S+))?))*\s+push\b/i;
const GH_WRITE_RE = /\bgh(?:\.exe)?\s+(?:pr\s+(?:create|merge)|release\s+create|repo\s+(?:create|delete|fork))\b/i;
export const isRemoteWrite = (tool, input) => (tool === 'Bash' || tool === DEV_START) && (GIT_PUSH_RE.test(input?.command || '') || GH_WRITE_RE.test(input?.command || ''));
// Perintah yang minta dijalankan di luar sandbox OS (Claude Code mengulang perintah yang gagal karena sandbox).
export const escapesSandbox = (tool, input) => tool === 'Bash' && input?.dangerouslyDisableSandbox === true;
// Push, perintah yang menyentuh kredensial / keluar dari sandbox, pertanyaan, dan rencana tidak pernah bisa "Selalu".
export const neverAlways = (tool, input) =>
  isRemoteWrite(tool, input) || SECRET_CMD_RE.test(input?.command || '') || escapesSandbox(tool, input) || tool === 'AskUserQuestion' || tool === 'ExitPlanMode';

// Aturan "Selalu" dari saran Claude Code untuk permintaan izin ini, mis. Bash(npm test *):
// cukup perintah sejenis yang lolos, bukan semua Bash. Tanpa saran aturan (Edit di luar
// worktree, tool MCP, …) "Selalu" berlaku untuk seluruh tool tersebut.
/** @returns {{ toolName: string, ruleContent: string }[]} */
export function suggestedRules(tool, suggestions) {
  return (Array.isArray(suggestions) ? suggestions : [])
    .filter((s) => s?.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules))
    .flatMap((s) => s.rules)
    .filter((r) => r?.toolName === tool && typeof r.ruleContent === 'string' && r.ruleContent);
}
export const ruleText = (r) => `${r.toolName}(${r.ruleContent})`;
// Aturan "Bash(npm test *)" cocok dengan perintah berawalan "npm test" (dipakai engine Codex;
// engine Claude mencocokkannya sendiri lewat settings.permissions.allow).
export function ruleMatches(rule, command) {
  const m = String(rule).match(/^Bash\((.*)\)$/);
  if (!m) return false;
  const pat = m[1].replace(/:\*$|\s*\*$/, '').trim();
  const cmd = String(command || '').trim();
  return !!pat && !/[;&|`$<>]/.test(cmd) && (cmd === pat || cmd.startsWith(pat + ' '));
}
