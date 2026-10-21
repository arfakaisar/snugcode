// OS sandbox for Claude-engine Bash commands (Claude Code's sandbox feature: bubblewrap + socat on
// Linux, Seatbelt on macOS). A regex blocklist isn't enough to protect the snugcode data folder
// (`cat ~/.snug*/s*.json` gets through), so when commands run without the user watching (auto-approve)
// they run in a sandbox that denies reading credentials at the OS level.
//
// Measured with the real Agent SDK: in the sandbox the data folder is closed, worktree & git commit still work,
// outbound network still works (allowedDomains '*'), but the host's `localhost` is NOT reachable
// (local dev servers/DBs). That's why by default the sandbox is only for auto-approve; commands that need
// to leave the sandbox (dangerouslyDisableSandbox) always ask the user.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, WORKSPACES } from './config.js';
import { deniedPaths } from './codex.js';

const onPath = (bin) => (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));

/** Mode from config.json `sandbox` / env SNUGCODE_SANDBOX: 'auto' (default: only under auto-approve), 'always', 'off'. */
export function sandboxMode(cfg = {}) {
  const v = String(process.env.SNUGCODE_SANDBOX ?? cfg.sandbox ?? 'auto').toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(v)) return 'off';
  if (['always', '1', 'on', 'true'].includes(v)) return 'always';
  return 'auto';
}

// Checked once per daemon process. Missing dependencies make Claude Code silently run
// WITHOUT a sandbox (only a stderr warning), so we check ourselves to be able to tell the user.
// Windows isn't enabled yet: not tested with snugcode.
/** @type {Promise<{ ok: boolean, reason?: string }> | null} */
let probe = null;
export function sandboxSupport() {
  probe ??= (async () => {
    if (process.platform === 'darwin') return fs.existsSync('/usr/bin/sandbox-exec') ? { ok: true } : { ok: false, reason: 'sandbox-exec not found' };
    if (process.platform !== 'linux') return { ok: false, reason: `not supported on ${process.platform} yet` };
    const missing = ['bwrap', 'socat'].filter((b) => !onPath(b));
    if (missing.length) return { ok: false, reason: `install ${missing.map((m) => (m === 'bwrap' ? 'bubblewrap' : m)).join(' & ')} (e.g. \`sudo apt install bubblewrap socat\`)` };
    // User namespaces can be blocked (Docker without extra permissions, Ubuntu 24.04+ AppArmor).
    return new Promise((resolve) =>
      execFile('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', 'true'], { timeout: 10_000 }, (err) =>
        resolve(err ? { ok: false, reason: 'bubblewrap can\'t create namespaces (restricted by the container/AppArmor)' } : { ok: true }),
      ),
    );
  })();
  return probe;
}

// Package caches that install/build commands reasonably write to (outside the worktree). Bin folders (~/.cargo/bin,
// ~/go/bin, …) are deliberately excluded: binaries planted there would later run outside the sandbox.
const CACHE_DIRS = ['.npm', '.cache', '.pnpm-store', '.local/share/pnpm/store', '.yarn/berry/cache', '.bun/install/cache', '.cargo/registry', '.cargo/git', 'go/pkg/mod', '.gradle/caches', '.m2/repository'];
const ALWAYS_CREATE = new Set(['.npm', '.cache']);

// Git hooks & config are run by the daemon (commits from the phone) outside the sandbox: they must not be writable from inside.
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

// Inside the sandbox, Claude Code masks dangerous dotfiles not yet in the worktree (.bashrc,
// .mcp.json, .vscode, …) with /dev/null placeholders. Those placeholders aren't on disk, but
// `git add -A` inside the sandbox chokes on them, so they're ignored via the repo's info/exclude managed
// by snugcode (not the repo's .gitignore; the user's local repo isn't touched). Names already tracked by
// git aren't affected by exclude. All of .claude/: its contents (agents, hooks, settings.json, …) change per
// Claude Code version, and changing files there always needs the user's approval anyway.
const SANDBOX_STUBS = ['.claude/', '.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.idea', '.mcp.json', '.profile', '.ripgreprc', '.vscode', '.zprofile', '.zshrc'];
const EXCLUDE_MARK = '# snugcode: sandbox placeholder (see daemon/sandbox.js)';
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
 * `sandbox` option for the Agent SDK's query().
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
  // Computer Mode may write in the user's home folder (not just the worktree); the data folder stays closed.
  const allowWrite = [...(computer ? [home] : [WORKSPACES]), ...caches];
  return {
    enabled: true,
    // Dependencies are checked by us (sandboxSupport); don't let one failing command kill the session.
    failIfUnavailable: false,
    // Approval still goes through snugcode's policy (canUseTool), same as without a sandbox.
    autoAllowBashIfSandboxed: false,
    network: { allowedDomains: ['*'] },
    filesystem: { denyRead: deniedPaths(), allowWrite, denyWrite: [...(computer ? [HOME] : []), ...gitGuards(cwd)] },
  };
}
