// pocketcode — Manajemen autostart lintas platform (Windows Startup, macOS launchd, Linux systemd).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function autostartFilePath() {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'pocketcode.vbs');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.pocketcode.plist');
  }
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'pocketcode.service');
}

export function isAutostartEnabled() {
  try {
    return fs.existsSync(autostartFilePath());
  } catch {
    return false;
  }
}

export function writeAutostart(cliPath, nodePath = process.execPath) {
  const file = autostartFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (process.platform === 'win32') {
    const q = (s) => '""' + s + '""';
    fs.writeFileSync(file, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${q(nodePath)} ${q(cliPath)} start --log", 0, False\r\n`);
  } else if (process.platform === 'darwin') {
    fs.writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.pocketcode</string>
  <key>ProgramArguments</key><array><string>${nodePath}</string><string>${cliPath}</string><string>start</string><string>--log</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH || ''}</string></dict>
</dict></plist>
`,
    );
  } else {
    fs.writeFileSync(
      file,
      `[Unit]
Description=pocketcode daemon
After=network-online.target

[Service]
ExecStart=${nodePath} ${cliPath} start --log
Restart=always
RestartSec=5
Environment=PATH=${process.env.PATH || ''}

[Install]
WantedBy=default.target
`,
    );
    try {
      spawnSync('systemctl', ['--user', 'daemon-reload']);
      spawnSync('systemctl', ['--user', 'enable', 'pocketcode']);
    } catch {}
  }
  return file;
}

export function disableAutostart() {
  const file = autostartFilePath();
  if (process.platform === 'darwin') {
    try {
      spawnSync('launchctl', ['unload', file]);
    } catch {}
  } else if (process.platform === 'linux') {
    try {
      spawnSync('systemctl', ['--user', 'disable', '--now', 'pocketcode']);
    } catch {}
  }
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Pastikan skrip autostart selalu memanggil file CLI yang aktif/terbaru jika autostart pernah dinyalakan.
export function syncAutostart(cliPath, nodePath = process.execPath) {
  if (!isAutostartEnabled()) return false;
  try {
    const file = autostartFilePath();
    const current = fs.readFileSync(file, 'utf8');
    // Jika path CLI atau node berubah, perbarui file autostart
    if (!current.includes(cliPath) || !current.includes(nodePath)) {
      writeAutostart(cliPath, nodePath);
      return true;
    }
  } catch {}
  return false;
}
