// Automatic cleaner for workspaces and orphaned folders.
// Removes worktrees and repositories no longer used by any session,
// clears stale log files, and prunes git worktree references on the host PC.

import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES, SESSIONS_DIR } from './config.js';
import { git, repoDirName, LAST_USED } from './github.js';

// Base clones not used by any session are kept for this long (default 3 days):
// a new session on the same repo only needs a `fetch`, not a fresh clone.
export const REPO_TTL_MS = 3 * 24 * 3600 * 1000;

// Remove files / folders safely and robustly on Windows/Linux/macOS.
// Handles temporary file locks and read-only attributes common on git packfiles.
export function safeRm(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return;
  try {
    fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } catch {
    try {
      chmodRecursive(targetPath);
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Fail quietly without an uncaught exception; the background cleaner will retry later.
    }
  }
}

function chmodRecursive(target) {
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      fs.chmodSync(target, 0o777);
      for (const entry of fs.readdirSync(target)) {
        chmodRecursive(path.join(target, entry));
      }
    } else {
      fs.chmodSync(target, 0o666);
    }
  } catch {}
}

export async function cleanupWorkspaces(sessions, options = {}) {
  // `busy(folderRepo)`: a repo currently being used to create a new session (clone/worktree in progress)
  // must not be touched at all, even if its new worktree isn't registered as a session yet.
  const { workspacesDir = WORKSPACES, sessionsDir = SESSIONS_DIR, minAgeMs = 30000, repoTtlMs = REPO_TTL_MS, busy = () => false } = options;
  const activeSessions = sessions instanceof Map ? [...sessions.values()] : Array.isArray(sessions) ? sessions : [];

  const activeCwds = new Set(
    activeSessions.map((s) => path.resolve(s.meta?.cwd || s.cwd || '').toLowerCase()).filter(Boolean),
  );
  // Compared by folder name (see repoDirName), not an "owner/name" guessed from the folder.
  const activeRepos = new Set(
    activeSessions.map((s) => s.meta?.repo || s.repo).filter(Boolean).map((r) => repoDirName(r).toLowerCase()),
  );
  const activeIds = new Set(
    activeSessions.map((s) => String(s.meta?.id || s.id || '').toLowerCase()).filter(Boolean),
  );

  const result = {
    removedWorktrees: [],
    removedRepos: [],
    removedLogs: [],
  };

  if (!fs.existsSync(workspacesDir)) return result;

  let repoEntries = [];
  try {
    repoEntries = fs.readdirSync(workspacesDir);
  } catch {
    return result;
  }

  const now = Date.now();

  for (const entry of repoEntries) {
    const repoPath = path.join(workspacesDir, entry);
    let stat;
    try {
      stat = fs.statSync(repoPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || busy(entry)) continue;

    const baseDir = path.join(repoPath, '_base');
    let subDirs = [];
    try {
      subDirs = fs.readdirSync(repoPath);
    } catch {
      continue;
    }

    // 1. Clean up session worktrees (s-*) not in the active session list
    for (const sub of subDirs) {
      if (!/^s-[\w-]+$/i.test(sub)) continue;
      const wtPath = path.join(repoPath, sub);
      const resolved = path.resolve(wtPath).toLowerCase();
      if (!activeCwds.has(resolved)) {
        let wtStat;
        try {
          wtStat = fs.statSync(wtPath);
        } catch {
          continue;
        }
        // Avoid a race: don't remove folders created just seconds ago
        if (minAgeMs > 0 && now - wtStat.mtimeMs < minAgeMs) continue;
        if (busy(entry)) break;

        try {
          if (fs.existsSync(baseDir)) {
            await git(baseDir, ['worktree', 'remove', '--force', wtPath]).catch(() => {});
            await git(baseDir, ['worktree', 'prune']).catch(() => {});
          }
        } catch {}

        safeRm(wtPath);
        result.removedWorktrees.push(wtPath);
      }
    }

    // 2. Check whether this repository is still used by any session
    let remaining = [];
    try {
      remaining = fs.readdirSync(repoPath);
    } catch {
      remaining = [];
    }

    const hasActiveWorktree = remaining.some(
      (r) => /^s-[\w-]+$/i.test(r) && activeCwds.has(path.resolve(repoPath, r).toLowerCase()),
    );

    const isRepoActive = activeRepos.has(entry.toLowerCase()) || hasActiveWorktree;

    // When this clone was last used (.last-used marker; old clones without one: folder mtime).
    let lastUsed = stat.mtimeMs;
    try {
      lastUsed = Math.max(lastUsed, fs.statSync(path.join(repoPath, LAST_USED)).mtimeMs);
    } catch {}
    const idleFor = now - lastUsed;
    // TTL 0 = remove now. Without this exception, the nanosecond-precision mtime (APFS) of a just-touched
    // folder can slightly exceed Date.now() rounded to milliseconds, making idleFor negative.
    const ttl = Math.max(repoTtlMs, minAgeMs);

    // No active sessions left in this repo and its clone hasn't been used for a while.
    // `busy` is re-checked right before removing: session creation may have started during the `await` above.
    if (!isRepoActive && (ttl <= 0 || idleFor >= ttl) && !busy(entry)) {
      safeRm(repoPath);
      result.removedRepos.push(repoPath);
    } else if (fs.existsSync(baseDir)) {
      // Repo still active: prune git's internal worktree list
      try {
        await git(baseDir, ['worktree', 'prune']).catch(() => {});
      } catch {}
    }
  }

  // 3. Clean up .jsonl logs of deleted sessions
  if (fs.existsSync(sessionsDir)) {
    try {
      const files = fs.readdirSync(sessionsDir);
      for (const f of files) {
        const m = f.match(/^([\w-]+)\.jsonl$/i);
        if (m && !activeIds.has(m[1].toLowerCase())) {
          const logPath = path.join(sessionsDir, f);
          let logStat;
          try {
            logStat = fs.statSync(logPath);
          } catch {
            continue;
          }
          if (minAgeMs <= 0 || now - logStat.mtimeMs >= minAgeMs) {
            safeRm(logPath);
            result.removedLogs.push(f);
          }
        }
      }
    } catch {}
  }

  return result;
}
