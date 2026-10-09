// Pembersih otomatis ruang kerja dan folder yatim (orphan cleaner).
// Menghapus worktree dan repository yang sudah tidak digunakan lagi oleh sesi apa pun,
// membersihkan file log basi, serta merapikan referensi git worktree di PC host.

import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES, SESSIONS_DIR } from './config.js';
import { git, repoDirName, LAST_USED } from './github.js';

// Clone dasar yang tidak dipakai sesi mana pun tetap disimpan selama ini (default 3 hari):
// sesi baru di repo yang sama cukup `fetch`, tidak perlu clone ulang dari nol.
export const REPO_TTL_MS = 3 * 24 * 3600 * 1000;

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
  // `busy(folderRepo)`: repo yang sedang dipakai membuat sesi baru (clone/worktree berjalan)
  // tidak boleh disentuh sama sekali, walau worktree barunya belum terdaftar sebagai sesi.
  const { workspacesDir = WORKSPACES, sessionsDir = SESSIONS_DIR, minAgeMs = 30000, repoTtlMs = REPO_TTL_MS, busy = () => false } = options;
  const activeSessions = sessions instanceof Map ? [...sessions.values()] : Array.isArray(sessions) ? sessions : [];

  const activeCwds = new Set(
    activeSessions.map((s) => path.resolve(s.meta?.cwd || s.cwd || '').toLowerCase()).filter(Boolean),
  );
  // Dibandingkan dengan nama folder (lihat repoDirName), bukan "owner/nama" yang ditebak dari folder.
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

    const isRepoActive = activeRepos.has(entry.toLowerCase()) || hasActiveWorktree;

    // Kapan clone ini terakhir dipakai (penanda .last-used; clone lama tanpa penanda: mtime folder).
    let lastUsed = stat.mtimeMs;
    try {
      lastUsed = Math.max(lastUsed, fs.statSync(path.join(repoPath, LAST_USED)).mtimeMs);
    } catch {}
    const idleFor = now - lastUsed;

    // Tidak ada sesi aktif lagi di repo ini dan clone-nya sudah lama tidak dipakai.
    // `busy` dicek ulang tepat sebelum menghapus: pembuatan sesi bisa dimulai saat `await` di atas.
    if (!isRepoActive && idleFor >= Math.max(repoTtlMs, minAgeMs) && !busy(entry)) {
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
