// snugcode — Manajemen autostart lintas platform (Windows Startup, macOS launchd, Linux systemd).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const AUTOSTART_UNIT = 'snugcode';
// Nama sebelum ganti merek: entri autostart lama dipindahkan otomatis (lihat migrateLegacyAutostart).
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

// Matikan & hapus satu entri autostart. Unit launchd/systemd tidak dihentikan bila `keepRunning`:
// dipakai saat migrasi dari dalam daemon yang justru dijalankan oleh unit lama itu.
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

// Entri autostart dari sebelum ganti nama: hapus agar tidak ada dua daemon saat login. Mengembalikan
// true bila entri lama ditemukan (pemanggil lalu menulis entri baru untuk CLI yang aktif).
export function migrateLegacyAutostart() {
  if (!fs.existsSync(fileFor(LEGACY_UNIT))) return false;
  removeUnit(LEGACY_UNIT, { keepRunning: true });
  return true;
}

// Pastikan skrip autostart selalu memanggil file CLI yang aktif/terbaru jika autostart pernah dinyalakan.
export function syncAutostart(cliPath, nodePath = process.execPath) {
  if (!isAutostartEnabled()) return false;
  try {
    if (migrateLegacyAutostart() || !fs.existsSync(autostartFilePath())) {
      writeAutostart(cliPath, nodePath);
      return true;
    }
    const current = fs.readFileSync(autostartFilePath(), 'utf8');
    // Jika path CLI atau node berubah, perbarui file autostart
    if (!current.includes(cliPath) || !current.includes(nodePath)) {
      writeAutostart(cliPath, nodePath);
      return true;
    }
  } catch {}
  return false;
}
