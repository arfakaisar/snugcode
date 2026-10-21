// GitHub Codespaces client for cloud runners (no DOM, testable in Node).
//
// Runner = a codespace from the user's fork of the snugcode repo (its .devcontainer/ runs
// `snugcode cloud`). Machine token, PIN, and relay URL are sent as Codespaces user secrets
// encrypted on the phone (sealed box to the GitHub account's public key), scoped to that fork only.
// The GitHub token here has the `codespace` scope and is stored only on the phone.
import { sealedBox } from '../shared/sealedbox.js';
import { b64, unb64 } from '../shared/crypto.js';

const API = 'https://api.github.com';
export const SECRET_NAMES = ['SNUGCODE_MACHINE_TOKEN', 'SNUGCODE_PAIR_PIN', 'SNUGCODE_RELAY'];
// The codespace display name holds the machine ID: the runner can be found again from another phone.
export const displayName = (mid) => 'snugcode ' + mid;
// GitHub's maximum. The runner stops itself much sooner when idle (see daemon/runner.js);
// this long limit is only a safeguard so long agent tasks aren't cut off midway.
export const IDLE_TIMEOUT = 240;

// Random PIN for automatic pairing (6–12 letters/digits, see PIN_RE). No look-alike characters.
export function randomPin(n = 10) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) if (b < 248 && out.length < n) out += abc[b % abc.length];
  }
  return out;
}

export class Codespaces {
  // onAuthError: called when GitHub rejects the token (401) — e.g. to drop the stale token on the phone.
  /** @param {string} token @param {{ fetchImpl?: typeof fetch, onAuthError?: () => void }} [opts] */
  constructor(token, { fetchImpl = globalThis.fetch.bind(globalThis), onAuthError } = {}) {
    this.token = token;
    this.f = fetchImpl;
    this.onAuthError = onAuthError;
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
      const e = /** @type {Error & { status?: number }} */ (new Error(r.status === 401 ? 'This phone’s GitHub Codespaces access is no longer valid (revoked or expired).' : `GitHub ${r.status}: ${data?.message || 'failed'}`));
      e.status = r.status;
      if (r.status === 401) this.onAuthError?.();
      throw e;
    }
    return data;
  }

  user() {
    return this.req('GET', '/user');
  }

  // The user's runner repo: the upstream itself (its owner), a same-named fork, or a renamed fork.
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

  // Secrets are encrypted here; GitHub only stores ciphertext and injects it into codespaces of repo `repoId`.
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

  // Runner codespace for machine `mid`: by the remembered name, or looked up by display name.
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

  // 409 = starting / already running: not a failure.
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

// Codespace state → short text for the phone screen.
export function stateText(state) {
  return (
    {
      Queued: 'queued at GitHub…',
      Provisioning: 'preparing the machine…',
      Created: 'created…',
      Starting: 'starting…',
      Rebuilding: 'rebuilding…',
      Updating: 'updating…',
      Available: 'running · waiting for snugcode to connect…',
      ShuttingDown: 'stopping…',
      Shutdown: 'stopped',
      Failed: 'failed to create',
      Unavailable: 'unavailable',
      Deleted: 'deleted',
    }[state] || String(state || '…').toLowerCase()
  );
}
