// Penyimpanan state daemon di ~/.snugcode.
//   config.json  : pengaturan biasa (relay, model, nama PC)
//   secrets.json : token & kunci (izin file 600 di macOS/Linux)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

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

export function loadSecrets() {
  return { devices: {}, pinFails: 0, ...readJson(SECRETS_FILE, {}) };
}
export function saveSecrets(sec) {
  writeJson(SECRETS_FILE, sec, 0o600);
}

export function ensureDirs() {
  for (const d of [HOME, WORKSPACES, SESSIONS_DIR, CLAUDE_DIR]) fs.mkdirSync(d, { recursive: true });
}

// Base URL untuk Claude Code: tanpa /v1 karena Claude Code menambahkan /v1/messages sendiri.
export function anthropicBaseUrl(routerUrl) {
  return routerUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}
