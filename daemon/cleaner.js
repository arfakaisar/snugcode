// Pembersih otomatis ruang kerja dan folder yatim (orphan cleaner).
// Menghapus worktree dan repository yang sudah tidak digunakan lagi oleh sesi apa pun,
// membersihkan file log basi, serta merapikan referensi git worktree di PC host.

import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES, SESSIONS_DIR } from './config.js';
import { git } from './github.js';

// Hapus berkas / folder secara aman dan tangguh di Windows/Linux/macOS.
// Mengatasi file lock sementara dan atribut read-only yang sering terjadi pada git packfile.
export function safeRm(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return;
  try {
    fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } catch {
    try {
      chmodRecursive(targetPath);
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Biarkan gagal tanpa melempar uncaught exception; background cleaner akan mencoba lagi nanti.
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
  const { workspacesDir = WORKSPACES, sessionsDir = SESSIONS_DIR, minAgeMs = 30000 } = options;
  const activeSessions = sessions instanceof Map ? [...sessions.values()] : Array.isArray(sessions) ? sessions : [];

  const activeCwds = new Set(
    activeSessions.map((s) => path.resolve(s.meta?.cwd || s.cwd || '').toLowerCase()).filter(Boolean),
  );
  const activeRepos = new Set(
    activeSessions.map((s) => String(s.meta?.repo || s.repo || '').toLowerCase()).filter(Boolean),
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
    if (!stat.isDirectory()) continue;

    const baseDir = path.join(repoPath, '_base');
    let subDirs = [];
    try {
      subDirs = fs.readdirSync(repoPath);
    } catch {
      continue;
    }

    // 1. Bersihkan worktree sesi (s-*) yang tidak ada di daftar sesi aktif
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
        // Cegah race condition: jangan hapus folder yang baru dibuat beberapa detik lalu
        if (minAgeMs > 0 && now - wtStat.mtimeMs < minAgeMs) continue;

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

    // 2. Evaluasi apakah repository ini masih dipakai oleh sesi mana pun
    let remaining = [];
    try {
      remaining = fs.readdirSync(repoPath);
    } catch {
      remaining = [];
    }

    const hasActiveWorktree = remaining.some(
      (r) => /^s-[\w-]+$/i.test(r) && activeCwds.has(path.resolve(repoPath, r).toLowerCase()),
    );

    // Nama repo dari nama folder (misal arfakaisar__pocketcode -> arfakaisar/pocketcode)
    const repoName = entry.replace('__', '/').toLowerCase();
    const isRepoActive = activeRepos.has(repoName) || hasActiveWorktree;

    // Jika tidak ada sesi aktif lagi di repo ini dan folder bukan baru dibuat
    if (!isRepoActive && (minAgeMs <= 0 || now - stat.mtimeMs >= minAgeMs)) {
      safeRm(repoPath);
      result.removedRepos.push(repoPath);
    } else if (fs.existsSync(baseDir)) {
      // Repo masih aktif: rapikan daftar worktree internal git
      try {
        await git(baseDir, ['worktree', 'prune']).catch(() => {});
      } catch {}
    }
  }

  // 3. Bersihkan file log .jsonl dari sesi yang sudah dihapus
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
