// Tingkat risiko permintaan izin agen (dipakai daemon untuk kartu izin, preset otonomi, dan TUI).
// Tujuannya melawan "kebiasaan asal ketuk Izinkan": permintaan berbahaya harus terlihat berbeda dari
// permintaan rutin, dan permintaan rutin boleh lolos otomatis bila pengguna memilih preset itu.
// Ini heuristik teks perintah untuk UX, BUKAN batas keamanan (itu tugas sandbox OS & kebijakan izin).

// Menghapus/menimpa data, mengubah riwayat git, hak akses sistem, atau mematikan proses.
const DESTRUCTIVE_RE =
  /\brm\s+-[a-z]*[rf]|\brmdir\b|\bdel\s+\/[sq]|\bRemove-Item\b.*-Recurse|\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\b|branch\s+-D|stash\s+(?:drop|clear)|rebase\b|filter-(?:branch|repo)|update-ref\s+-d)|\bchmod\s+-R|\bchown\b|\bsudo\b|\bdoas\b|\bmkfs|\bdd\s+if=|\bshutdown\b|\breboot\b|\bkillall\b|\bpkill\b|\bkill\s+-9\b|\btruncate\b|\bDROP\s+(?:TABLE|DATABASE)\b|\bformat\s+[a-z]:/i;
// Menjalankan skrip dari internet.
const PIPE_SHELL_RE = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|python3?|node)\b/i;
// Mengirim/mengambil data lewat jaringan (bisa membocorkan isi repo bila agen terkena prompt injection).
const NETWORK_RE = /\b(?:curl|wget|scp|rsync|ncat|nc|ssh|ftp|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;
const INSTALL_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|\bpip3?\s+install\b|\b(?:cargo|go)\s+install\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b|\bgem\s+install\b/i;
// Perintah rutin pengembangan (test, lint, typecheck, build) tanpa rangkaian/pengalihan perintah lain.
const ROUTINE_RE =
  /^\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|type-check|check|build|format:check)(?::[\w-]+)?|(?:npx\s+|pnpm\s+exec\s+)?(?:tsc|eslint|vitest|jest|mocha|pytest|ruff|mypy|phpunit)|prettier\s+--check|python3?\s+-m\s+(?:pytest|unittest|mypy)|go\s+(?:test|vet|build)|cargo\s+(?:test|check|build|clippy|fmt\s+--check)|make\s+(?:test|check|lint)|deno\s+(?:test|lint|check)|dotnet\s+(?:test|build)|mvn\s+(?:test|verify)|gradle\s+(?:test|check|build))\b/i;
const CHAIN_RE = /[;&|`<>]|\$\(/;

/** @typedef {'low' | 'medium' | 'high'} RiskLevel */

/** Risiko perintah shell. @param {string} cmd @returns {{ level: RiskLevel, why: string }} */
export function commandRisk(cmd) {
  const c = String(cmd || '');
  if (PIPE_SHELL_RE.test(c)) return { level: 'high', why: 'menjalankan skrip dari luar' };
  if (DESTRUCTIVE_RE.test(c)) return { level: 'high', why: 'bisa menghapus/menimpa data atau riwayat git' };
  if (ROUTINE_RE.test(c) && !CHAIN_RE.test(c)) return { level: 'low', why: 'perintah rutin (test/lint/build) — tetap menjalankan kode repo' };
  if (INSTALL_RE.test(c)) return { level: 'medium', why: 'memasang paket dari internet' };
  if (NETWORK_RE.test(c)) return { level: 'medium', why: 'mengakses jaringan' };
  return { level: 'medium', why: 'menjalankan perintah di folder sesi' };
}

/**
 * Risiko satu permintaan izin.
 * @param {string} tool nama tool asli (Bash, Edit, mcp__snugcode__dev_start, …)
 * @param {any} input
 * @param {{ push?: boolean, secret?: boolean, escapes?: boolean, protectedEdit?: boolean, outside?: boolean, computer?: boolean }} [ctx]
 * @returns {{ level: RiskLevel, why: string } | null} null = bukan aksi (pertanyaan / rencana)
 */
export function permRisk(tool, input = {}, ctx = {}) {
  if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') return null;
  if (ctx.push) return { level: 'high', why: 'menulis ke GitHub (terlihat orang lain, tidak bisa di-rewind)' };
  if (ctx.secret) return { level: 'high', why: 'menyebut file kredensial snugcode' };
  if (ctx.escapes) return { level: 'high', why: 'minta dijalankan di luar sandbox OS' };
  if (ctx.protectedEdit) return { level: 'high', why: 'mengubah konfigurasi tool/hook repo (.git, .claude, .mcp.json, …)' };
  if (tool === 'Bash' || /dev_start$/.test(tool)) return commandRisk(input.command);
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return ctx.outside && !ctx.computer ? { level: 'high', why: 'mengubah file di luar folder sesi' } : { level: 'low', why: 'mengubah file di folder sesi' };
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/.test(tool)) return { level: 'medium', why: 'membaca file di luar folder sesi' };
  if (tool === 'WebFetch') return { level: 'medium', why: 'membuka halaman web (isinya bisa berisi instruksi tersembunyi)' };
  if (/preview_screenshot$/.test(tool)) return { level: 'medium', why: /^https?:/i.test(String(input.url || '')) ? 'membuka URL di luar localhost' : 'membuka file lokal di browser' };
  if (tool === 'Izin') return { level: 'high', why: 'minta izin tambahan (jaringan / tulis di luar folder sesi)' };
  return { level: 'medium', why: '' };
}

// Preset otonomi agen: satu pilihan yang mudah dipahami, dipetakan ke flag sesi.
//   ask      : setiap edit & perintah ditanyakan
//   balanced : edit di folder sesi langsung (bisa di-rewind), perintah ditanyakan (bawaan)
//   trusted  : + perintah rutin (test/lint/build) langsung
//   auto     : semua langsung (di sandbox OS bila tersedia), kecuali push/PR & aksi kritis
export const AUTONOMY = ['ask', 'balanced', 'trusted', 'auto'];
/** @param {{ auto?: boolean, autoLow?: boolean, askEdits?: boolean }} m */
export const autonomyOf = (m) => (m.auto ? 'auto' : m.autoLow ? 'trusted' : m.askEdits ? 'ask' : 'balanced');
/** @param {string} level */
export const autonomyFlags = (level) => ({ auto: level === 'auto', autoLow: level === 'trusted', askEdits: level === 'ask' });
