// Penyimpanan state daemon di ~/.snugcode.
//   config.json  : pengaturan biasa (relay, model, nama PC)
//   secrets.json : token & kunci (izin file 600 di macOS/Linux)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSealed, openSealed, seal, enableKeychain, disableKeychain } from './keychain.js';

// Instalasi lama (sebelum ganti nama dari pocketcode) tetap memakai ~/.pocketcode bila folder itu sudah ada:
// worktree, riwayat agen, dan pairing HP tersimpan dengan path absolut di dalamnya.
const LEGACY_HOME = path.join(os.homedir(), '.pocketcode');
const NEW_HOME = path.join(os.homedir(), '.snugcode');
export const HOME =
  process.env.SNUGCODE_HOME || process.env.POCKETCODE_HOME || (!fs.existsSync(NEW_HOME) && fs.existsSync(LEGACY_HOME) ? LEGACY_HOME : NEW_HOME);

// Kanal lokal daemon <-> terminal (TUI): named pipe di Windows, unix socket di
// macOS/Linux. Unik per folder data agar beberapa instalasi tidak bentrok. Prefiks 'pocketcode-' sengaja
// dipertahankan: terminal versi baru tetap bisa bicara dengan daemon yang masih versi lama.
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

// Tulis atomik (tmp + rename): crash, mati listrik, atau disk penuh di tengah penulisan
// tidak pernah meninggalkan file yang terpotong. Rename di Windows bisa sesaat ditolak
// (EPERM/EBUSY) bila file sedang dibaca antivirus/indexer, jadi dicoba ulang sebentar.
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

// Daftar sesi (sessions/index.json). `ok: false` berarti file ADA tapi tidak terbaca: pemanggil
// wajib menganggap daftar sesi tidak diketahui (jangan jalankan pembersih yang menghapus
// worktree "yatim" berdasarkan daftar kosong). File rusak disimpan sebagai cadangan.
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

// secrets.json bisa terenkripsi dengan kunci di keychain OS (`snugcode keychain on`, lihat keychain.js).
// Gagal membuka file terenkripsi = error (bukan secrets kosong yang lalu menimpa file aslinya).
export function loadSecrets() {
  let raw = readJson(SECRETS_FILE, {});
  if (isSealed(raw)) raw = openSealed(raw, HOME);
  return { devices: {}, pinFails: 0, ...raw };
}

// Kunci pairing PIN: setelah 5 percobaan gagal, pairing dikunci sementara (15 menit, berlipat dua tiap
// kunci berikutnya, maks ±16 jam), bukan permanen. Pairing yang berhasil / PIN baru membuka kunci.
export const MAX_PIN_FAILS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
export function resetPinLock(sec) {
  sec.pinFails = 0;
  delete sec.pinLockUntil;
  delete sec.pinLockouts;
}
export const pinLockedUntil = (sec, now = Date.now()) => (sec.pinLockUntil > now ? sec.pinLockUntil : 0);
/** Catat satu percobaan pairing. @returns {{ ok: true, left: number } | { ok: false, until: number }} */
export function pinAttempt(sec, now = Date.now()) {
  const until = pinLockedUntil(sec, now);
  if (until) return { ok: false, until };
  // Kunci sudah lewat (atau kunci permanen dari versi lama): mulai putaran baru.
  if (sec.pinFails >= MAX_PIN_FAILS) sec.pinFails = 0;
  sec.pinFails = (sec.pinFails || 0) + 1;
  if (sec.pinFails >= MAX_PIN_FAILS) {
    sec.pinLockouts = (sec.pinLockouts || 0) + 1;
    sec.pinLockUntil = now + PIN_LOCK_MS * 2 ** Math.min(sec.pinLockouts - 1, 6);
  }
  return { ok: true, left: MAX_PIN_FAILS - sec.pinFails };
}
// Mode (terenkripsi atau tidak) mengikuti file di disk, jadi `snugcode keychain on|off` saat daemon
// berjalan langsung berlaku untuk penyimpanan berikutnya daemon itu.
export function saveSecrets(sec) {
  const cur = readJson(SECRETS_FILE, null);
  writeJson(SECRETS_FILE, isSealed(cur) ? seal(sec, HOME, cur.kc) : sec, 0o600);
}

export const secretsSealed = () => isSealed(readJson(SECRETS_FILE, null));

/** @param {boolean} on @returns {string} nama keychain yang dipakai / dilepas */
export function setKeychain(on) {
  const cur = readJson(SECRETS_FILE, {});
  const sec = loadSecrets();
  if (on) {
    if (isSealed(cur)) return 'sudah aktif';
    const b = enableKeychain(HOME);
    writeJson(SECRETS_FILE, seal(sec, HOME, b.name), 0o600);
    return b.label;
  }
  if (!isSealed(cur)) return 'sudah mati';
  writeJson(SECRETS_FILE, sec, 0o600);
  disableKeychain(HOME);
  return 'mati';
}

export function ensureDirs() {
  for (const d of [HOME, WORKSPACES, SESSIONS_DIR, CLAUDE_DIR]) fs.mkdirSync(d, { recursive: true });
}

// Runner cloud (Codespaces / container): daemon yang sama, tanpa fitur khusus PC (anti-sleep,
// autostart) dan bisa dikonfigurasi sepenuhnya dari HP. Lihat `snugcode cloud` di cli.js.
export const isCloud = (cfg) => cfg?.runtime === 'cloud';

// Kredensial di environment yang tidak boleh terwariskan ke proses agen, Bash-nya, dev server, dan `!perintah`:
// token GitHub (Codespaces selalu mengisi GITHUB_TOKEN) dan env bootstrap runner cloud.
export const SECRET_ENV_RE =
  /^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GITHUB_CODESPACE_TOKEN|(SNUGCODE|POCKETCODE)_(MACHINE_TOKEN|PAIR_PIN|ROUTER_KEY|GITHUB_TOKEN|RUNNER_TOKEN|API_KEY|CODEX_TOKEN|BRIDGE))$/i;
export function scrubSecretEnv(env = process.env) {
  for (const k of Object.keys(env)) if (SECRET_ENV_RE.test(k)) delete env[k];
  return env;
}

// Base URL untuk Claude Code: tanpa /v1 karena Claude Code menambahkan /v1/messages sendiri.
export function anthropicBaseUrl(routerUrl) {
  return routerUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}
