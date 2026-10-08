// pocketcode — Pemeriksaan, pembaruan jarak jauh, dan restart daemon.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { PACKAGE_SPEC } from './defaults.js';
import { loadConfig, saveConfig, HOME } from './config.js';
import { nativeBinaryInstalled, missingBinaryMessage } from './nativebin.js';
import { syncAutostart } from './autostart.js';

const execFileAsync = promisify(execFile);
const NPM_TIMEOUT = 10 * 60 * 1000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'daemon', 'cli.js');
const PID_FILE = path.join(HOME, 'daemon.pid');

const UPSTREAM_API = 'https://api.github.com/repos/arfakaisar/pocketcode';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function getInstallInfo(cfg = loadConfig()) {
  let version = '0.1.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.version) version = pkg.version;
  } catch {}

  const isGit = fs.existsSync(path.join(ROOT, '.git'));
  let commit = cfg.installedCommit || 'main';

  if (isGit) {
    try {
      commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    } catch {
      try {
        const gitDir = path.join(ROOT, '.git');
        let headPath = path.join(gitDir, 'HEAD');
        if (fs.existsSync(gitDir) && fs.statSync(gitDir).isFile()) {
          const gd = fs.readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim();
          headPath = path.resolve(ROOT, gd, 'HEAD');
        }
        if (fs.existsSync(headPath)) {
          const head = fs.readFileSync(headPath, 'utf8').trim();
          if (!head.startsWith('ref: ')) commit = head.slice(0, 7);
          else {
            const refPath = path.resolve(path.dirname(headPath), head.slice(5));
            if (fs.existsSync(refPath)) commit = fs.readFileSync(refPath, 'utf8').trim().slice(0, 7);
          }
        }
      } catch {}
    }
  }

  return {
    version,
    commit,
    installType: isGit ? 'git' : 'npm',
    root: ROOT,
    cli: CLI,
  };
}

async function githubApi(p, sec = {}) {
  const headers = { 'user-agent': 'pocketcode', accept: 'application/vnd.github+json' };
  if (sec.githubToken) headers.authorization = 'Bearer ' + sec.githubToken;
  const res = await fetch(UPSTREAM_API + p, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('GitHub API ' + res.status);
  return res.json();
}

export async function checkUpdate(cfg = loadConfig(), sec = {}) {
  const info = getInstallInfo(cfg);
  if (info.installType === 'git') {
    try {
      await execFileAsync('git', ['fetch', '--quiet', 'origin'], { cwd: ROOT, timeout: 20000 });
      const { stdout: localHead } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT });
      const { stdout: remoteHead } = await execFileAsync('git', ['rev-parse', '--short', 'origin/main'], { cwd: ROOT });
      const { stdout: behindStr } = await execFileAsync('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: ROOT });
      const { stdout: logMsg } = await execFileAsync('git', ['log', '-1', '--format=%s', 'origin/main'], { cwd: ROOT });

      const localSha = localHead.trim();
      const remoteSha = remoteHead.trim();
      const behind = parseInt(behindStr.trim(), 10) || 0;

      return {
        updateAvailable: behind > 0 || localSha !== remoteSha,
        currentCommit: localSha,
        latestCommit: remoteSha,
        commitsBehind: behind,
        latestMessage: logMsg.trim(),
        installType: 'git',
      };
    } catch (e) {
      return {
        updateAvailable: false,
        currentCommit: info.commit,
        latestCommit: info.commit,
        commitsBehind: 0,
        latestMessage: '',
        installType: 'git',
        error: e.message,
      };
    }
  }

  // Pemasangan npm global
  try {
    const data = await githubApi('/commits/main', sec);
    const remoteSha = data.sha ? data.sha.slice(0, 7) : 'main';
    const latestMessage = data.commit?.message?.split('\n')[0] || '';

    let currentCommit = cfg.installedCommit;
    if (!currentCommit) {
      // npm tidak mencatat commit yang terpasang. Bandingkan waktu commit terbaru dengan
      // waktu pemasangan paket: commit yang lebih baru berarti memang ada pembaruan.
      const committed = Date.parse(data.commit?.committer?.date || '') || 0;
      let installed = 0;
      try {
        installed = fs.statSync(path.join(ROOT, 'package.json')).mtimeMs;
      } catch {}
      if (committed && installed && committed > installed) {
        return { updateAvailable: true, currentCommit: 'tidak diketahui', latestCommit: remoteSha, commitsBehind: null, latestMessage, installType: 'npm' };
      }
      cfg.installedCommit = currentCommit = remoteSha;
      saveConfig(cfg);
    }

    const updateAvailable = currentCommit !== remoteSha;
    let commitsBehind = 0;
    if (updateAvailable) {
      commitsBehind = await githubApi(`/compare/${currentCommit}...main`, sec)
        .then((c) => c.ahead_by ?? null)
        .catch(() => null);
    }
    return {
      updateAvailable,
      currentCommit,
      latestCommit: remoteSha,
      commitsBehind,
      latestMessage,
      installType: 'npm',
    };
  } catch (e) {
    return {
      updateAvailable: false,
      currentCommit: cfg.installedCommit || 'main',
      latestCommit: cfg.installedCommit || 'main',
      commitsBehind: 0,
      latestMessage: '',
      installType: 'npm',
      error: e.message,
    };
  }
}

// claude.exe berukuran ratusan MB: beri waktu cukup dan jangan telan error npm.
async function npmInstall(args, opts = {}) {
  try {
    await execFileAsync(npmCmd, args, { timeout: NPM_TIMEOUT, maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32', ...opts });
  } catch (e) {
    const detail = String(e.stderr || e.message || e).trim().split('\n').slice(-8).join('\n');
    throw new Error(`npm ${args.join(' ')} gagal${e.killed ? ' (timeout)' : ''}:\n${detail}`);
  }
}

async function globalPackageRoot() {
  try {
    const { stdout } = await execFileAsync(npmCmd, ['root', '-g'], { timeout: 20000, shell: process.platform === 'win32' });
    if (stdout.trim()) return path.join(stdout.trim(), 'pocketcode');
  } catch {}
  return ROOT;
}

// npm melewati optionalDependencies yang gagal dipasang tanpa error; pastikan binary ada.
function verifyNativeBinary(root) {
  if (!nativeBinaryInstalled(root)) throw new Error('Pembaruan terpasang tapi ' + missingBinaryMessage(root));
}

export async function performUpdate(cfg = loadConfig(), sec = {}) {
  const info = getInstallInfo(cfg);
  if (info.installType === 'git') {
    const { stdout: st } = await execFileAsync('git', ['status', '--porcelain'], { cwd: ROOT });
    if (st.trim()) {
      throw new Error('Ada perubahan lokal di direktori git. Commit atau buang perubahan terlebih dahulu.');
    }
    await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: ROOT, timeout: 60000 });
    await npmInstall(['install', '--omit=dev', '--include=optional'], { cwd: ROOT });
    verifyNativeBinary(ROOT);
    syncAutostart(path.join(ROOT, 'daemon', 'cli.js'));
    const { stdout: newHead } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT });
    const commit = newHead.trim();
    cfg.installedCommit = commit;
    saveConfig(cfg);
    return { ok: true, commit, installType: 'git' };
  }

  // Pemasangan npm global. Commit dibaca sebelum install supaya push yang masuk
  // selama npm berjalan tetap terdeteksi sebagai pembaruan berikutnya.
  const commit = await githubApi('/commits/main', sec)
    .then((d) => d.sha?.slice(0, 7))
    .catch(() => null);
  await npmInstall(['install', '-g', PACKAGE_SPEC, '--include=optional']);
  const globalRoot = await globalPackageRoot();
  verifyNativeBinary(globalRoot);
  syncAutostart(path.join(globalRoot, 'daemon', 'cli.js'));

  if (commit) cfg.installedCommit = commit;
  else delete cfg.installedCommit; // dideteksi ulang dari waktu pemasangan
  saveConfig(cfg);
  return { ok: true, commit: commit || 'terbaru', installType: 'npm' };
}

export function restartDaemon(daemon, { delay = 1000 } = {}) {
  setTimeout(() => {
    try {
      if (fs.existsSync(PID_FILE)) {
        try {
          if (+fs.readFileSync(PID_FILE, 'utf8') === process.pid) fs.rmSync(PID_FILE, { force: true });
        } catch {}
      }
      daemon?.stop();
    } catch {}

    const helper = 'setTimeout(() => { const { spawn } = require("node:child_process"); const p = spawn(process.argv[1], [process.argv[2], "start", "--log"], { detached: true, stdio: "ignore", windowsHide: true }); p.unref(); }, 1800);';
    const child = spawn(process.execPath, ['-e', helper, '--', process.execPath, CLI], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    process.exit(0);
  }, delay);
}
