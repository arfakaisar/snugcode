// Agent permission policy shared by the Claude engine (canUseTool) and Codex (decideCodex):
// the snugcode data folder, repo config files that can change tool behavior, pushes to remotes,
// and "Always" rules. Pure functions: no dependency on session state.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, WORKSPACES, CLAUDE_DIR } from './config.js';
import { DEV_START } from './devtools.js';

// Passed to the SDK via settings.plansDirectory, so its location is fixed (not the user's ~/.claude).
export const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');

export const isInside = (p, dir) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The snugcode data folder holds 9router keys, GitHub tokens, device secrets, repo .env templates,
// and binaries the daemon runs: the agent must never touch it (including under auto-approve).
// Exceptions: session worktrees, the plans folder, and READING the agent's own Claude config folder
// (Claude Code stores large tool output there and reads it back). Writing to the Claude config
// folder is still denied: a settings.json there could install hooks that bypass the permission system.
export const isSensitivePath = (p, { write = false } = {}) =>
  within(p, HOME) && !within(p, WORKSPACES) && !within(p, PLANS_DIR) && (write || !within(p, CLAUDE_DIR));
// Paths already realpath'd (file explorer) are also compared with the data folder's realpath: on macOS
// the temp folder /var/… is a symlink to /private/var/…, as is a home moved via symlink.
const realDirs = new Map();
function realDir(dir) {
  let r = realDirs.get(dir);
  if (r) return r;
  try {
    r = fs.realpathSync(dir);
  } catch {
    return dir; // doesn't exist yet: don't cache, it may be created later
  }
  realDirs.set(dir, r);
  return r;
}
const within = (p, dir) => isInside(p, dir) || isInside(p, realDir(dir));
// Only catches obvious cases for Bash; the real protection is the OS sandbox (see sandbox.js).
export const SECRET_CMD_RE = /secrets\.(?:json|key)|\.(?:snugcode|pocketcode)[\\/]+(?:secrets|config|sessions|claude|codex|gemini|env|bin|tools)\b|\$\{?(?:SNUGCODE|POCKETCODE)_HOME\b/i;

// Repo files that change tool behavior without the user running anything: Claude Code settings & hooks
// (.claude/), Codex (.codex/) & Gemini CLI (.gemini/) config, project MCP servers (.mcp.json), and .git contents (hooks, config
// core.fsmonitor/hooksPath that run when the daemon calls git). Changing them always asks,
// even under auto-approve: a README/issue with a prompt injection must not silently install hooks.
// Also files that run code somewhere else without the user starting it: CI workflows & composite actions (run with the
// repo's secrets once pushed; the GitHub token has the `workflow` scope), dev containers (Codespaces), editor tasks
// (VS Code `runOn: folderOpen`), git hook managers (.husky), and direnv (.envrc).
const PROTECTED_DIRS = new Set(['.git', '.claude', '.codex', '.gemini', '.devcontainer', '.vscode', '.husky']);
const PROTECTED_SUBDIRS = [['.github', 'workflows'], ['.github', 'actions']];
const PROTECTED_ROOT_FILES = new Set(['.mcp.json', '.envrc', '.devcontainer.json']);
export function isProtectedRepoPath(p, cwd) {
  const rel = path.relative(cwd, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]+/).map((x) => x.toLowerCase());
  if (parts.some((x) => PROTECTED_DIRS.has(x))) return true;
  if (PROTECTED_SUBDIRS.some(([a, b]) => parts.some((x, i) => x === a && parts[i + 1] === b))) return true;
  return parts.length === 1 && PROTECTED_ROOT_FILES.has(parts[0]);
}

// Paths touched by file tools (Glob with an absolute pattern: the part before the first glob character).
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

// Commands that write to a remote always ask, even with auto-approve on.
// git global options before the subcommand are recognized too: `git -C dir push`, `git -c k=v push`.
const GIT_PUSH_RE = /\bgit(?:\.exe)?(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=(?:"[^"]*"|'[^']*'|\S+))?))*\s+push\b/i;
const GH_WRITE_RE = /\bgh(?:\.exe)?\s+(?:pr\s+(?:create|merge)|release\s+create|repo\s+(?:create|delete|fork))\b/i;
export const isRemoteWrite = (tool, input) => (tool === 'Bash' || tool === DEV_START) && (GIT_PUSH_RE.test(input?.command || '') || GH_WRITE_RE.test(input?.command || ''));
// Commands asking to run outside the OS sandbox (Claude Code retries commands that failed due to the sandbox).
export const escapesSandbox = (tool, input) => tool === 'Bash' && input?.dangerouslyDisableSandbox === true;
// Pushes, commands touching credentials / escaping the sandbox, questions, and plans can never be "Always".
export const neverAlways = (tool, input) =>
  isRemoteWrite(tool, input) || SECRET_CMD_RE.test(input?.command || '') || escapesSandbox(tool, input) || tool === 'AskUserQuestion' || tool === 'ExitPlanMode';

// The "Always" rule from Claude Code's suggestion for this permission request, e.g. Bash(npm test *):
// only similar commands pass, not all of Bash. Without a suggested rule (Edit outside the
// worktree, MCP tools, …) "Always" applies to the whole tool.
/** @returns {{ toolName: string, ruleContent: string }[]} */
export function suggestedRules(tool, suggestions) {
  return (Array.isArray(suggestions) ? suggestions : [])
    .filter((s) => s?.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules))
    .flatMap((s) => s.rules)
    .filter((r) => r?.toolName === tool && typeof r.ruleContent === 'string' && r.ruleContent);
}
export const ruleText = (r) => `${r.toolName}(${r.ruleContent})`;
// The rule "Bash(npm test *)" matches commands starting with "npm test" (used by the Codex engine;
// the Claude engine matches it itself via settings.permissions.allow).
export function ruleMatches(rule, command) {
  const m = String(rule).match(/^Bash\((.*)\)$/);
  if (!m) return false;
  const pat = m[1].replace(/:\*$|\s*\*$/, '').trim();
  const cmd = String(command || '').trim();
  return !!pat && !/[;&|`$<>]/.test(cmd) && (cmd === pat || cmd.startsWith(pat + ' '));
}
