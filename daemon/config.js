// Daemon state storage in ~/.snugcode.
//   config.json  : regular settings (relay, model, PC name)
//   secrets.json : tokens & keys (file mode 600 on macOS/Linux)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSealed, openSealed, seal, enableKeychain, disableKeychain } from './keychain.js';

// Old installs (before the rename from pocketcode) keep using ~/.pocketcode if that folder exists:
// worktrees, agent history, and phone pairings are stored there with absolute paths.
const LEGACY_HOME = path.join(os.homedir(), '.pocketcode');
const NEW_HOME = path.join(os.homedir(), '.snugcode');
export const HOME =
  process.env.SNUGCODE_HOME || process.env.POCKETCODE_HOME || (!fs.existsSync(NEW_HOME) && fs.existsSync(LEGACY_HOME) ? LEGACY_HOME : NEW_HOME);

// Local daemon <-> terminal (TUI) channel: a named pipe on Windows, a unix socket on
// macOS/Linux. Unique per data folder so multiple installs don't clash. The 'pocketcode-' prefix is deliberately
// kept: newer terminals can still talk to a daemon that's still on an old version.
export const IPC_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\pocketcode-' + createHash('sha1').update(HOME.toLowerCase()).digest('hex').slice(0, 12)
    : path.join(HOME, 'daemon.sock');
export const WORKSPACES = path.join(HOME, 'workspaces');
export const SESSIONS_DIR = path.join(HOME, 'sessions');
export const CLAUDE_DIR = path.join(HOME, 'claude');

const CONFIG_FILE = path.join(HOME, 'config.json');
const SECRETS_FILE = path.join(HOME, 'secrets.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomic write (tmp + rename): a crash, power loss, or full disk mid-write
// never leaves a truncated file. Rename on Windows can be briefly refused
// (EPERM/EBUSY) while antivirus/indexers read the file, so it's retried for a moment.
export function writeJson(file, data, mode, { pretty = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), { mode });
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(tmp, file);
    } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}

// Session list (sessions/index.json). `ok: false` means the file EXISTS but can't be read: callers
// must treat the session list as unknown (don't run a cleaner that deletes
// "orphan" worktrees based on an empty list). A corrupted file is kept as a backup.
export const SESSION_INDEX = path.join(SESSIONS_DIR, 'index.json');
export function readSessionIndex({ quarantine = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(SESSION_INDEX, 'utf8');
  } catch (e) {
    return { ok: e.code === 'ENOENT', list: [] };
  }
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) return { ok: true, list };
  } catch {}
  if (quarantine) {
    try {
      fs.renameSync(SESSION_INDEX, SESSION_INDEX + '.broken-' + Date.now());
    } catch {}
  }
  return { ok: false, list: [] };
}

export function loadConfig() {
  return readJson(CONFIG_FILE, {});
}
export function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg, 0o644);
}

// secrets.json may be encrypted with a key in the OS keychain (`snugcode keychain on`, see keychain.js).
// Failing to open an encrypted file = an error (not empty secrets that then overwrite the real file).
export function loadSecrets() {
  let raw = readJson(SECRETS_FILE, {});
  if (isSealed(raw)) raw = openSealed(raw, HOME);
  return { devices: {}, pinFails: 0, ...raw };
}

// PIN pairing lockout: after 5 failed attempts pairing is locked temporarily (15 minutes, doubling with each
// subsequent lock, max ~16 hours), not permanently. A successful pairing / new PIN unlocks it.
export const MAX_PIN_FAILS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
export function resetPinLock(sec) {
  sec.pinFails = 0;
  delete sec.pinLockUntil;
  delete sec.pinLockouts;
}
export const pinLockedUntil = (sec, now = Date.now()) => (sec.pinLockUntil > now ? sec.pinLockUntil : 0);
/** Record one pairing attempt. @returns {{ ok: true, left: number } | { ok: false, until: number }} */
export function pinAttempt(sec, now = Date.now()) {
  const until = pinLockedUntil(sec, now);
  if (until) return { ok: false, until };
  // The lock has expired (or a permanent lock from an old version): start a new round.
  if (sec.pinFails >= MAX_PIN_FAILS) sec.pinFails = 0;
  sec.pinFails = (sec.pinFails || 0) + 1;
  if (sec.pinFails >= MAX_PIN_FAILS) {
    sec.pinLockouts = (sec.pinLockouts || 0) + 1;
    sec.pinLockUntil = now + PIN_LOCK_MS * 2 ** Math.min(sec.pinLockouts - 1, 6);
  }
  return { ok: true, left: MAX_PIN_FAILS - sec.pinFails };
}
// The mode (encrypted or not) follows the file on disk, so `snugcode keychain on|off` while the daemon
// runs applies right away to that daemon's next save.
export function saveSecrets(sec) {
  const cur = readJson(SECRETS_FILE, null);
  writeJson(SECRETS_FILE, isSealed(cur) ? seal(sec, HOME, cur.kc) : sec, 0o600);
}

export const secretsSealed = () => isSealed(readJson(SECRETS_FILE, null));

/** @param {boolean} on @returns {string} name of the keychain used / released */
export function setKeychain(on) {
  const cur = readJson(SECRETS_FILE, {});
  const sec = loadSecrets();
  if (on) {
    if (isSealed(cur)) return 'already on';
    const b = enableKeychain(HOME);
    writeJson(SECRETS_FILE, seal(sec, HOME, b.name), 0o600);
    return b.label;
  }
  if (!isSealed(cur)) return 'already off';
  writeJson(SECRETS_FILE, sec, 0o600);
  disableKeychain(HOME);
  return 'off';
}

export function ensureDirs() {
  for (const d of [HOME, WORKSPACES, SESSIONS_DIR, CLAUDE_DIR]) fs.mkdirSync(d, { recursive: true });
}

// Cloud runner (Codespaces / container): the same daemon, without PC-only features (anti-sleep,
// autostart) and fully configurable from the phone. See `snugcode cloud` in cli.js.
export const isCloud = (cfg) => cfg?.runtime === 'cloud';

// Credentials in the environment that must not be inherited by the agent process, its Bash, dev servers, and `!commands`:
// GitHub tokens (Codespaces always sets GITHUB_TOKEN) and the cloud runner's bootstrap env.
export const SECRET_ENV_RE =
  /^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GITHUB_CODESPACE_TOKEN|(SNUGCODE|POCKETCODE)_(MACHINE_TOKEN|PAIR_PIN|ROUTER_KEY|GITHUB_TOKEN|RUNNER_TOKEN|API_KEY|CODEX_TOKEN|BRIDGE))$/i;
export function scrubSecretEnv(env = process.env) {
  for (const k of Object.keys(env)) if (SECRET_ENV_RE.test(k)) delete env[k];
  return env;
}

// Base URL for Claude Code: without /v1 because Claude Code appends /v1/messages itself.
export function anthropicBaseUrl(routerUrl) {
  return routerUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}
