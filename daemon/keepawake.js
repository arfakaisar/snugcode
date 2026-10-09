// pocketcode — Mencegah PC tertidur selama daemon berjalan.
import { spawn } from 'node:child_process';

/** @param {{ log?: (msg: string) => void }} [opts] */
export function startKeepAwake({ log = () => {} } = {}) {
  let proc = null;
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // Windows: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED = 0x80000041)
      const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class S {
    [DllImport("kernel32.dll")]
    public static extern int SetThreadExecutionState(int f);
}
'@
[S]::SetThreadExecutionState([int]0x80000041) | Out-Null
Start-Sleep -Seconds 864000
`.trim();
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true,
      });
      proc.on('error', (e) => log('! keepawake win32 error: ' + e.message));
    } else if (platform === 'darwin') {
      proc = spawn('caffeinate', ['-s', '-w', String(process.pid)], {
        stdio: 'ignore',
      });
      proc.on('error', (e) => log('! keepawake darwin error: ' + e.message));
    } else if (platform === 'linux') {
      proc = spawn('systemd-inhibit', ['--what=sleep', '--why=pocketcode daemon active', 'sleep', '864000'], {
        stdio: 'ignore',
      });
      proc.on('error', () => {
        proc = null;
      });
    }
  } catch (e) {
    log('! keepawake failed to start: ' + e.message);
  }

  const cleanup = () => {
    if (proc) {
      try {
        proc.kill();
      } catch {}
      proc = null;
    }
  };

  process.once('exit', cleanup);

  return {
    stop() {
      cleanup();
    },
    active() {
      return !!proc;
    },
  };
}
