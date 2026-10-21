// Risk level of agent permission requests (used by the daemon for permission cards, autonomy presets, and the TUI).
// The goal is to fight "tap Allow out of habit": dangerous requests must look different from
// routine ones, and routine requests may pass automatically if the user picks that preset.
// This is a command-text heuristic for UX, NOT a security boundary (that's the OS sandbox & permission policy).

// Deleting/overwriting data, rewriting git history, system privileges, or killing processes.
const DESTRUCTIVE_RE =
  /\brm\s+-[a-z]*[rf]|\brmdir\b|\bdel\s+\/[sq]|\bRemove-Item\b.*-Recurse|\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\b|branch\s+-D|stash\s+(?:drop|clear)|rebase\b|filter-(?:branch|repo)|update-ref\s+-d)|\bchmod\s+-R|\bchown\b|\bsudo\b|\bdoas\b|\bmkfs|\bdd\s+if=|\bshutdown\b|\breboot\b|\bkillall\b|\bpkill\b|\bkill\s+-9\b|\btruncate\b|\bDROP\s+(?:TABLE|DATABASE)\b|\bformat\s+[a-z]:/i;
// Running scripts from the internet.
const PIPE_SHELL_RE = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|python3?|node)\b/i;
// Sending/fetching data over the network (could leak repo contents if the agent is prompt-injected).
const NETWORK_RE = /\b(?:curl|wget|scp|rsync|ncat|nc|ssh|ftp|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;
const INSTALL_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|\bpip3?\s+install\b|\b(?:cargo|go)\s+install\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b|\bgem\s+install\b/i;
// Routine development commands (test, lint, typecheck, build) without chaining/redirecting other commands.
const ROUTINE_RE =
  /^\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|type-check|check|build|format:check)(?::[\w-]+)?|(?:npx\s+|pnpm\s+exec\s+)?(?:tsc|eslint|vitest|jest|mocha|pytest|ruff|mypy|phpunit)|prettier\s+--check|python3?\s+-m\s+(?:pytest|unittest|mypy)|go\s+(?:test|vet|build)|cargo\s+(?:test|check|build|clippy|fmt\s+--check)|make\s+(?:test|check|lint)|deno\s+(?:test|lint|check)|dotnet\s+(?:test|build)|mvn\s+(?:test|verify)|gradle\s+(?:test|check|build))\b/i;
const CHAIN_RE = /[;&|`<>]|\$\(/;

/** @typedef {'low' | 'medium' | 'high'} RiskLevel */

/** Risk of a shell command. @param {string} cmd @returns {{ level: RiskLevel, why: string }} */
export function commandRisk(cmd) {
  const c = String(cmd || '');
  if (PIPE_SHELL_RE.test(c)) return { level: 'high', why: 'runs a script from outside' };
  if (DESTRUCTIVE_RE.test(c)) return { level: 'high', why: 'may delete/overwrite data or git history' };
  if (ROUTINE_RE.test(c) && !CHAIN_RE.test(c)) return { level: 'low', why: 'routine command (test/lint/build) — still runs repo code' };
  if (INSTALL_RE.test(c)) return { level: 'medium', why: 'installs packages from the internet' };
  if (NETWORK_RE.test(c)) return { level: 'medium', why: 'accesses the network' };
  return { level: 'medium', why: 'runs a command in the session folder' };
}

/**
 * Risk of a single permission request.
 * @param {string} tool original tool name (Bash, Edit, mcp__snugcode__dev_start, …)
 * @param {any} input
 * @param {{ push?: boolean, secret?: boolean, escapes?: boolean, protectedEdit?: boolean, outside?: boolean, computer?: boolean }} [ctx]
 * @returns {{ level: RiskLevel, why: string } | null} null = not an action (question / plan)
 */
export function permRisk(tool, input = {}, ctx = {}) {
  if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') return null;
  if (ctx.push) return { level: 'high', why: 'writes to GitHub (visible to others, can\'t be rewound)' };
  if (ctx.secret) return { level: 'high', why: 'mentions snugcode credential files' };
  if (ctx.escapes) return { level: 'high', why: 'asks to run outside the OS sandbox' };
  if (ctx.protectedEdit) return { level: 'high', why: 'changes the repo\'s tool/hook config (.git, .claude, .mcp.json, …)' };
  if (tool === 'Bash' || /dev_start$/.test(tool)) return commandRisk(input.command);
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return ctx.outside && !ctx.computer ? { level: 'high', why: 'changes files outside the session folder' } : { level: 'low', why: 'changes files in the session folder' };
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/.test(tool)) return { level: 'medium', why: 'reads files outside the session folder' };
  if (tool === 'WebFetch') return { level: 'medium', why: 'opens a web page (it may contain hidden instructions)' };
  if (/preview_screenshot$/.test(tool)) return { level: 'medium', why: /^https?:/i.test(String(input.url || '')) ? 'opens a URL outside localhost' : 'opens a local file in the browser' };
  if (tool === 'Permission' || tool === 'Izin') return { level: 'high', why: 'asks for extra permissions (network / writing outside the session folder)' };
  return { level: 'medium', why: '' };
}

// Agent autonomy presets: one easy-to-understand choice, mapped to session flags.
//   ask      : every edit & command asks
//   balanced : edits in the session folder apply directly (can be rewound), commands ask (default)
//   trusted  : + routine commands (test/lint/build) run directly
//   auto     : everything runs directly (in the OS sandbox if available), except push/PR & critical actions
export const AUTONOMY = ['ask', 'balanced', 'trusted', 'auto'];
/** @param {{ auto?: boolean, autoLow?: boolean, askEdits?: boolean }} m */
export const autonomyOf = (m) => (m.auto ? 'auto' : m.autoLow ? 'trusted' : m.askEdits ? 'ask' : 'balanced');
/** @param {string} level */
export const autonomyFlags = (level) => ({ auto: level === 'auto', autoLow: level === 'trusted', askEdits: level === 'ask' });
