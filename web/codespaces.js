// Klien GitHub Codespaces untuk runner cloud (tanpa DOM, bisa diuji di Node).
//
// Runner = codespace dari fork repo snugcode milik pengguna (berisi .devcontainer/ yang menjalankan
// `snugcode cloud`). Token mesin, PIN, dan URL relay dikirim sebagai Codespaces user secret yang
// dienkripsi di HP (sealed box ke public key akun GitHub), dibatasi ke repo fork itu saja.
// Token GitHub di sini ber-scope `codespace` dan hanya disimpan di HP.
import { sealedBox } from '../shared/sealedbox.js';
import { b64, unb64 } from '../shared/crypto.js';

const API = 'https://api.github.com';
export const SECRET_NAMES = ['SNUGCODE_MACHINE_TOKEN', 'SNUGCODE_PAIR_PIN', 'SNUGCODE_RELAY'];
// Nama tampilan codespace menyimpan ID mesin: runner bisa ditemukan lagi dari HP lain.
export const displayName = (mid) => 'snugcode ' + mid;
// Batas maksimal GitHub. Runner sendiri berhenti jauh lebih cepat saat menganggur (lihat daemon/runner.js);
// batas panjang ini hanya pengaman agar tugas agen yang lama tidak terhenti di tengah jalan.
export const IDLE_TIMEOUT = 240;

// PIN acak untuk pairing otomatis (6–12 huruf/angka, lihat PIN_RE). Tanpa huruf/angka yang mirip.
export function randomPin(n = 10) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) if (b < 248 && out.length < n) out += abc[b % abc.length];
  }
  return out;
}

export class Codespaces {
  /** @param {string} token @param {{ fetchImpl?: typeof fetch }} [opts] */
  constructor(token, { fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.token = token;
    this.f = fetchImpl;
  }

  async req(method, path, body) {
    const r = await this.f(API + path, {
      method,
      headers: {
        authorization: 'Bearer ' + this.token,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204 || r.status === 202) return r.status === 202 ? await r.json().catch(() => null) : null;
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const e = /** @type {Error & { status?: number }} */ (new Error(r.status === 401 ? 'Izin GitHub Codespaces habis atau dicabut. Hubungkan lagi.' : `GitHub ${r.status}: ${data?.message || 'gagal'}`));
      e.status = r.status;
      throw e;
    }
    return data;
  }

  user() {
    return this.req('GET', '/user');
  }

  // Repo runner milik pengguna: repo upstream itu sendiri (pemiliknya), fork bernama sama, atau fork yang diganti namanya.
  async findRunnerRepo(login, upstream) {
    const [owner, name] = upstream.split('/');
    const same = (n) => !!n && n.toLowerCase() === upstream.toLowerCase();
    if (owner.toLowerCase() === login.toLowerCase()) return this.req('GET', `/repos/${upstream}`);
    try {
      const r = await this.req('GET', `/repos/${login}/${name}`);
      if (r.owner?.login?.toLowerCase() === login.toLowerCase() && (same(r.parent?.full_name) || same(r.source?.full_name))) return r;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const forks = await this.req('GET', `/repos/${upstream}/forks?per_page=100&sort=newest`).catch(() => []);
    return forks.find((f) => f.owner?.login?.toLowerCase() === login.toLowerCase()) || null;
  }

  // Secret dienkripsi di sini; GitHub hanya menyimpan ciphertext dan menyuntikkannya ke codespace repo `repoId`.
  async setSecrets(values, repoId) {
    const { key_id, key } = await this.req('GET', '/user/codespaces/secrets/public-key');
    const pk = unb64(key);
    for (const [name, value] of Object.entries(values)) {
      await this.req('PUT', `/user/codespaces/secrets/${name}`, {
        encrypted_value: b64(sealedBox(new TextEncoder().encode(value), pk)),
        key_id,
        selected_repository_ids: [repoId],
      });
    }
  }

  async deleteSecrets(names = SECRET_NAMES) {
    for (const n of names) await this.req('DELETE', `/user/codespaces/secrets/${n}`).catch((e) => e.status === 404 || Promise.reject(e));
  }

  create(repo, mid) {
    return this.req('POST', '/user/codespaces', { repository_id: repo.id, ref: repo.default_branch, display_name: displayName(mid), idle_timeout_minutes: IDLE_TIMEOUT });
  }

  async list() {
    return (await this.req('GET', '/user/codespaces?per_page=100'))?.codespaces || [];
  }

  get(name) {
    return this.req('GET', `/user/codespaces/${encodeURIComponent(name)}`);
  }

  // Codespace runner untuk mesin `mid`: dari nama yang diingat, atau dicari lewat nama tampilan.
  async find(mid, name) {
    if (name) {
      try {
        return await this.get(name);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    return (await this.list()).find((c) => c.display_name === displayName(mid)) || null;
  }

  // 409 = sedang menyala / sudah menyala: bukan kegagalan.
  async start(name) {
    try {
      return await this.req('POST', `/user/codespaces/${encodeURIComponent(name)}/start`);
    } catch (e) {
      if (e.status === 409) return null;
      throw e;
    }
  }

  async stop(name) {
    try {
      return await this.req('POST', `/user/codespaces/${encodeURIComponent(name)}/stop`);
    } catch (e) {
      if (e.status === 409) return null;
      throw e;
    }
  }

  async remove(name) {
    try {
      await this.req('DELETE', `/user/codespaces/${encodeURIComponent(name)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
}

// Status codespace → teks singkat untuk layar HP.
export function stateText(state) {
  return (
    {
      Queued: 'mengantre di GitHub…',
      Provisioning: 'menyiapkan mesin…',
      Created: 'dibuat…',
      Starting: 'menyala…',
      Rebuilding: 'membangun ulang…',
      Updating: 'memperbarui…',
      Available: 'menyala · menunggu snugcode tersambung…',
      ShuttingDown: 'sedang berhenti…',
      Shutdown: 'berhenti',
      Failed: 'gagal dibuat',
      Unavailable: 'tidak tersedia',
      Deleted: 'sudah dihapus',
    }[state] || String(state || '…').toLowerCase()
  );
}
