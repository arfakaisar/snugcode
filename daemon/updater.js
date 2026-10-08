// pocketcode — Pemeriksaan, pembaruan jarak jauh, dan restart daemon.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { PACKAGE_SPEC } from './defaults.js';
import { loadConfig, saveConfig, HOME } from './config.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'daemon', 'cli.js');
const PID_FILE = path.join(HOME, 'daemon.pid');

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
    const headers = { 'user-agent': 'pocketcode' };
    if (sec.githubToken) headers.authorization = 'Bearer ' + sec.githubToken;
    const res = await fetch('https://api.github.com/repos/arfakaisar/pocketcode/commits/main', { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('GitHub API ' + res.status);
    const data = await res.json();
    const remoteSha = data.sha ? data.sha.slice(0, 7) : 'main';
    const latestMessage = data.commit?.message?.split('\n')[0] || '';

    let currentCommit = cfg.installedCommit;
    if (!currentCommit) {
      cfg.installedCommit = remoteSha;
      saveConfig(cfg);
      currentCommit = remoteSha;
    }

    const updateAvailable = currentCommit !== remoteSha;
    return {
      updateAvailable,
      currentCommit,
      latestCommit: remoteSha,
      commitsBehind: updateAvailable ? 1 : 0,
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

export async function performUpdate(cfg = loadConfig(), sec = {}) {
  const info = getInstallInfo(cfg);
  if (info.installType === 'git') {
    const { stdout: st } = await execFileAsync('git', ['status', '--porcelain'], { cwd: ROOT });
    if (st.trim()) {
      throw new Error('Ada perubahan lokal di direktori git. Commit atau buang perubahan terlebih dahulu.');
    }
    await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: ROOT, timeout: 60000 });
    await execFileAsync(npmCmd, ['install', '--omit=dev'], { cwd: ROOT, timeout: 120000, shell: process.platform === 'win32' }).catch(() => {});
    const { stdout: newHead } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT });
    const commit = newHead.trim();
    cfg.installedCommit = commit;
    saveConfig(cfg);
    return { ok: true, commit, installType: 'git' };
  }

  // Pemasangan npm global
  await execFileAsync(npmCmd, ['install', '-g', PACKAGE_SPEC], { timeout: 180000, shell: process.platform === 'win32' });
  let commit = 'terbaru';
  try {
    const res = await fetch('https://api.github.com/repos/arfakaisar/pocketcode/commits/main', { headers: { 'user-agent': 'pocketcode' }, signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      if (data.sha) commit = data.sha.slice(0, 7);
    }
  } catch {}

  cfg.installedCommit = commit;
  saveConfig(cfg);
  return { ok: true, commit, installType: 'npm' };
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
