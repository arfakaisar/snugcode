// Penyimpanan state daemon di ~/.pocketcode.
//   config.json  : pengaturan biasa (relay, model, nama PC)
//   secrets.json : token & kunci (izin file 600 di macOS/Linux)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.POCKETCODE_HOME || path.join(os.homedir(), '.pocketcode');
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

function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
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
