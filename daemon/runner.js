// Runner cloud: daemon snugcode di GitHub Codespaces atau container (Docker/Fly/VPS), tanpa PC.
//
// `snugcode cloud` membaca konfigurasi dari environment (lihat bootstrapCloud), lalu menjalankan
// daemon di bawah supervisor kecil. Semua setelan lain (API key / login model, login GitHub, PIN,
// perangkat) diatur dari HP lewat RPC. Saat tidak dipakai, runner berhenti sendiri (stopRunner).
//
// Env yang dibaca (semuanya opsional kecuali token mesin):
//   SNUGCODE_MACHINE_TOKEN  token mesin dari relay (/api/machines/provision); mid & akun dibaca darinya
//   SNUGCODE_PAIR_PIN       PIN pairing (dibuat di HP); hanya diterapkan bila berubah sejak start terakhir
//   SNUGCODE_RELAY          URL relay (bawaan: defaults.js)
//   SNUGCODE_API_KEY        API key model apa pun (Anthropic, OpenAI, Gemini, OpenRouter, router, …), dideteksi otomatis
//   SNUGCODE_API_URL        URL router/endpoint untuk key yang bukan key official (9router, OmniRoute, …)
//   SNUGCODE_ROUTER         URL 9router;  SNUGCODE_ROUTER_KEY  key 9router (bentuk lama);  SNUGCODE_MODEL  model default
//   SNUGCODE_GITHUB_TOKEN   token GitHub untuk clone/push (bisa juga login dari HP)
//   SNUGCODE_NAME           nama mesin;  SNUGCODE_IDLE_MINUTES  berhenti setelah N menit menganggur (0 = tidak)
//   SNUGCODE_IDLE_EXIT=1    container: keluar (exit 0) saat menganggur
//   CODESPACE_NAME          diisi Codespaces: runner dihentikan lewat GitHub API (token dari HP)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pinToPrs, bytesToHex, PIN_RE, normalizePin } from '../shared/crypto.js';
import { DEFAULT_RELAY_URL, DEFAULT_ROUTER_URL } from './defaults.js';
import { resetPinLock, HOME } from './config.js';

export const IDLE_MINUTES_DEFAULT = 30;

const env1 = (env, k) => env['SNUGCODE_' + k] || env['POCKETCODE_' + k] || '';

// Payload token mesin (dibuat & ditandatangani relay): { kind: 'machine', sub, login, mid }.
// Tidak diverifikasi di sini — relay yang memverifikasinya saat daemon tersambung.
export function decodeMachineToken(token) {
  try {
    const body = String(token).split('.')[0];
    const p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p?.kind === 'machine' && typeof p.mid === 'string' ? p : null;
  } catch {
    return null;
  }
}

// Nilai dari env diterapkan hanya bila berbeda dari yang terakhir diterapkan dari env, sehingga
// perubahan dari HP (ganti PIN, ganti key) tidak ditimpa lagi setiap runner start ulang.
const fp = (scope, v) => createHash('sha256').update(scope + '\0' + v).digest('hex').slice(0, 32);
function fromEnv(sec, name, value) {
  if (!value) return false;
  sec.envApplied ??= {};
  const f = fp(name, value);
  if (sec.envApplied[name] === f) return false;
  sec.envApplied[name] = f;
  return true;
}

/**
 * Isi config & secrets dari environment (idempoten). Mengubah objek yang diberikan.
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ relinked: boolean, warnings: string[] }>}
 */
export async function bootstrapCloud(env, cfg, sec) {
  const warnings = [];
  cfg.runtime = 'cloud';
  cfg.relayUrl = (env1(env, 'RELAY') || cfg.relayUrl || DEFAULT_RELAY_URL).replace(/\/+$/, '');
  cfg.routerUrl = (env1(env, 'ROUTER') || cfg.routerUrl || DEFAULT_ROUTER_URL).replace(/\/+$/, '');

  let relinked = false;
  const token = env1(env, 'MACHINE_TOKEN');
  if (token && token !== sec.machineToken) {
    const p = decodeMachineToken(token);
    if (!p) throw new Error('SNUGCODE_MACHINE_TOKEN tidak valid');
    if (p.mid !== cfg.machineId) {
      // Mesin baru: pairing HP & PIN milik mesin lama tidak berlaku lagi.
      sec.devices = {};
      resetPinLock(sec);
      delete sec.prs;
      if (sec.envApplied) delete sec.envApplied.pin;
      relinked = true;
    }
    sec.machineToken = token;
    cfg.machineId = p.mid;
    cfg.relayLogin = p.login;
  }
  if (!sec.machineToken) throw new Error('SNUGCODE_MACHINE_TOKEN belum di-set. Buat runner dari aplikasi HP (Pakai cloud), atau salin token dari /api/machines/provision.');
  cfg.linkedRelay = cfg.relayUrl;
  cfg.machineName = env1(env, 'NAME') || cfg.machineName || 'Cloud';

  const pin = env1(env, 'PAIR_PIN');
  if (pin && !PIN_RE.test(pin)) warnings.push('SNUGCODE_PAIR_PIN diabaikan: harus 6–12 huruf/angka.');
  else if (pin && (fromEnv(sec, 'pin', cfg.machineId + ':' + normalizePin(pin)) || !sec.prs)) {
    sec.prs = bytesToHex(await pinToPrs(pin, cfg.machineId));
    resetPinLock(sec);
  }
  if (!sec.prs) warnings.push('Belum ada PIN: HP belum bisa dipasangkan. Set SNUGCODE_PAIR_PIN.');

  const key = env1(env, 'ROUTER_KEY');
  if (fromEnv(sec, 'routerKey', key)) sec.routerKey = key;
  const gh = env1(env, 'GITHUB_TOKEN');
  if (fromEnv(sec, 'githubToken', gh)) sec.githubToken = gh;
  const model = env1(env, 'MODEL');
  if (model && (fromEnv(sec, 'model', model) || !cfg.model)) cfg.model = model;

  const idle = env1(env, 'IDLE_MINUTES');
  if (idle !== '' && Number.isFinite(+idle)) cfg.idleStopMinutes = Math.max(0, Math.min(24 * 60, +idle));
  if (env.CODESPACE_NAME) cfg.runner = { provider: 'codespace', name: env.CODESPACE_NAME };
  else cfg.runner = { provider: 'container', idleExit: /^(1|true|yes)$/i.test(env1(env, 'IDLE_EXIT')), host: os.hostname() };
  return { relinked, warnings };
}

export const idleMinutes = (cfg) => (cfg.idleStopMinutes ?? IDLE_MINUTES_DEFAULT);

// Supervisor runner Codespaces mengabaikan SIGTERM (lihat cli.js cloud): daemon yang mati selagi
// codespace menyala tidak akan dinyalakan lagi oleh siapa pun. Container (Docker) tetap berhenti rapi.
export const supervisorIgnoresTerm = (cfg) => cfg.runner?.provider === 'codespace';

// Hentikan runner yang menganggur. Codespaces: lewat GitHub API dengan token ber-scope `codespace`
// yang dikirim HP (RPC runnerConfig). Container: daemon keluar (exit 0) dan supervisor ikut berhenti.
// @returns 'stopped' | 'exit' | null (tidak ada cara menghentikan runner ini)
export async function stopRunner(cfg, sec, { fetchImpl = fetch } = {}) {
  const r = cfg.runner || {};
  if (r.provider === 'codespace' && r.name && sec.runnerToken) {
    const res = await fetchImpl(`https://api.github.com/user/codespaces/${encodeURIComponent(r.name)}/stop`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + sec.runnerToken, accept: 'application/vnd.github+json', 'user-agent': 'snugcode', 'x-github-api-version': '2022-11-28' },
    });
    if (res.ok) return 'stopped';
    if (res.status === 401) {
      delete sec.runnerToken;
      throw new Error('token Codespaces dari HP tidak berlaku lagi (buka aplikasi untuk memperbaruinya)');
    }
    throw new Error('GitHub menjawab ' + res.status);
  }
  if (r.idleExit) return 'exit';
  return null;
}

// Laporkan tahap/kegagalan runner ke relay (tampil di aplikasi HP selama runner belum tersambung).
// Hanya bila token mesin tersedia; kegagalan jaringan diabaikan.
export async function reportStatus(env, stage, msg, { fetchImpl = fetch } = {}) {
  const token = env1(env, 'MACHINE_TOKEN');
  if (!token) return false;
  const relay = (env1(env, 'RELAY') || DEFAULT_RELAY_URL).replace(/\/+$/, '');
  try {
    const r = await fetchImpl(relay + '/api/runner/status', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ stage, msg: String(msg).slice(-400) }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ---------- Perkiraan pemakaian kuota ----------
// API billing GitHub tidak bisa dibaca dengan scope `codespace`, jadi runner mencatat sendiri berapa lama
// ia menyala per bulan (UTC, seperti siklus kuota Codespaces) dikali jumlah core. Ini perkiraan: waktu
// codespace menyala sebelum daemon berjalan (build, start) dan pemakaian codespace lain tidak terhitung.
const USAGE_FILE = path.join(HOME, 'runner-usage.json');
const TICK_MAX = 5 * 60; // celah lebih lama dari ini = runner sempat mati (tidak dihitung)
export const FREE_CORE_HOURS = 120; // GitHub Free; Pro: 180

const month = (t) => new Date(t).toISOString().slice(0, 7);

export function readUsage(file = USAGE_FILE) {
  try {
    const u = JSON.parse(fs.readFileSync(file, 'utf8'));
    return u && typeof u.months === 'object' ? u : { months: {} };
  } catch {
    return { months: {} };
  }
}

/** Tambahkan waktu menyala sejak tick terakhir. @returns {any} isi file yang baru */
export function tickUsage(now = Date.now(), { file = USAGE_FILE, cores = os.cpus().length } = {}) {
  const u = readUsage(file);
  const gap = u.last ? (now - u.last) / 1000 : 0;
  if (gap > 0 && gap <= TICK_MAX) {
    const m = month(now);
    const cur = u.months[m] || { secs: 0, coreSecs: 0 };
    u.months[m] = { secs: cur.secs + gap, coreSecs: cur.coreSecs + gap * cores };
  }
  u.last = now;
  u.cores = cores;
  // Simpan 12 bulan terakhir saja.
  u.months = Object.fromEntries(Object.entries(u.months).sort(([a], [b]) => a.localeCompare(b)).slice(-12));
  try {
    fs.writeFileSync(file, JSON.stringify(u));
  } catch {}
  return u;
}

/** Ringkasan bulan berjalan untuk HP. */
export function usageSummary(now = Date.now(), file = USAGE_FILE) {
  const u = readUsage(file);
  const cur = u.months[month(now)] || { secs: 0, coreSecs: 0 };
  return { month: month(now), hours: +(cur.secs / 3600).toFixed(1), coreHours: +(cur.coreSecs / 3600).toFixed(1), cores: u.cores || os.cpus().length, free: FREE_CORE_HOURS };
}
