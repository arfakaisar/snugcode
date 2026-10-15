// Runner cloud: daemon snugcode di GitHub Codespaces atau container (Docker/Fly/VPS), tanpa PC.
//
// `snugcode cloud` membaca konfigurasi dari environment (lihat bootstrapCloud), lalu menjalankan
// daemon di bawah supervisor kecil. Semua setelan lain (key 9router, model, login GitHub, PIN,
// perangkat) diatur dari HP lewat RPC. Saat tidak dipakai, runner berhenti sendiri (stopRunner).
//
// Env yang dibaca (semuanya opsional kecuali token mesin):
//   SNUGCODE_MACHINE_TOKEN  token mesin dari relay (/api/machines/provision); mid & akun dibaca darinya
//   SNUGCODE_PAIR_PIN       PIN pairing (dibuat di HP); hanya diterapkan bila berubah sejak start terakhir
//   SNUGCODE_RELAY          URL relay (bawaan: defaults.js)
//   SNUGCODE_ROUTER         URL 9router;  SNUGCODE_ROUTER_KEY  key 9router;  SNUGCODE_MODEL  model default
//   SNUGCODE_GITHUB_TOKEN   token GitHub untuk clone/push (bisa juga login dari HP)
//   SNUGCODE_NAME           nama mesin;  SNUGCODE_IDLE_MINUTES  berhenti setelah N menit menganggur (0 = tidak)
//   SNUGCODE_IDLE_EXIT=1    container: keluar (exit 0) saat menganggur
//   CODESPACE_NAME          diisi Codespaces: runner dihentikan lewat GitHub API (token dari HP)
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pinToPrs, bytesToHex, PIN_RE, normalizePin } from '../shared/crypto.js';
import { DEFAULT_RELAY_URL, DEFAULT_ROUTER_URL } from './defaults.js';

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
      sec.pinFails = 0;
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
    sec.pinFails = 0;
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
