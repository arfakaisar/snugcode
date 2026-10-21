// snugcode — cross-platform autostart management (Windows Startup, macOS launchd, Linux systemd).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const AUTOSTART_UNIT = 'snugcode';
// Names from before the rebrand: old autostart entries are migrated automatically (see migrateLegacyAutostart).
const LEGACY_UNIT = 'pocketcode';

function fileFor(unit) {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', unit + '.vbs');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'LaunchAgents', `dev.${unit}.plist`);
  return path.join(os.homedir(), '.config', 'systemd', 'user', unit + '.service');
}

export const autostartFilePath = () => fileFor(AUTOSTART_UNIT);

export function isAutostartEnabled() {
  try {
    return fs.existsSync(autostartFilePath()) || fs.existsSync(fileFor(LEGACY_UNIT));
  } catch {
    return false;
  }
}

export function writeAutostart(cliPath, nodePath = process.execPath) {
  migrateLegacyAutostart();
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
  <key>Label</key><string>dev.${AUTOSTART_UNIT}</string>
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
Description=snugcode daemon
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
      spawnSync('systemctl', ['--user', 'enable', AUTOSTART_UNIT]);
    } catch {}
  }
  return file;
}

// Disable & remove one autostart entry. The launchd/systemd unit is not stopped when `keepRunning`:
// used when migrating from inside a daemon that was started by that very old unit.
function removeUnit(unit, { keepRunning = false } = {}) {
  const file = fileFor(unit);
  if (process.platform === 'darwin' && !keepRunning) {
    try {
      spawnSync('launchctl', ['unload', file]);
    } catch {}
  } else if (process.platform === 'linux') {
    try {
      spawnSync('systemctl', ['--user', 'disable', ...(keepRunning ? [] : ['--now']), unit]);
    } catch {}
  }
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function disableAutostart() {
  removeUnit(LEGACY_UNIT);
  return removeUnit(AUTOSTART_UNIT);
}

// Autostart entries from before the rename: remove them so two daemons don't start at login. Returns
// true if an old entry was found (the caller then writes a new entry for the active CLI).
export function migrateLegacyAutostart() {
  if (!fs.existsSync(fileFor(LEGACY_UNIT))) return false;
  removeUnit(LEGACY_UNIT, { keepRunning: true });
  return true;
}

// Make sure the autostart script always calls the active/latest CLI file if autostart was ever enabled.
export function syncAutostart(cliPath, nodePath = process.execPath) {
  if (!isAutostartEnabled()) return false;
  try {
    if (migrateLegacyAutostart() || !fs.existsSync(autostartFilePath())) {
      writeAutostart(cliPath, nodePath);
      return true;
    }
    const current = fs.readFileSync(autostartFilePath(), 'utf8');
    // If the CLI or node path changed, update the autostart file
    if (!current.includes(cliPath) || !current.includes(nodePath)) {
      writeAutostart(cliPath, nodePath);
      return true;
    }
  } catch {}
  return false;
}
