// Cloud runner: the snugcode daemon on GitHub Codespaces or a container (Docker/Fly/VPS), no PC needed.
//
// `snugcode cloud` reads its configuration from the environment (see bootstrapCloud), then runs the
// daemon under a small supervisor. Every other setting (API key / model login, GitHub login, PIN,
// devices) is managed from the phone over RPC. When idle, the runner stops itself (stopRunner).
//
// Env read (all optional except the machine token):
//   SNUGCODE_MACHINE_TOKEN  machine token from the relay (/api/machines/provision); mid & account are read from it
//   SNUGCODE_PAIR_PIN       pairing PIN (created on the phone); only applied if changed since the last start
//   SNUGCODE_RELAY          relay URL (default: defaults.js)
//   SNUGCODE_API_KEY        any model API key (Anthropic, OpenAI, Gemini, OpenRouter, router, …), auto-detected
//   SNUGCODE_API_URL        router/endpoint URL for keys that aren't official keys (9router, OmniRoute, …)
//   SNUGCODE_ROUTER         9router URL;  SNUGCODE_ROUTER_KEY  9router key (legacy form);  SNUGCODE_MODEL  default model
//   SNUGCODE_GITHUB_TOKEN   GitHub token for clone/push (you can also sign in from the phone)
//   SNUGCODE_NAME           machine name;  SNUGCODE_IDLE_MINUTES  stop after N idle minutes (0 = never)
//   SNUGCODE_IDLE_EXIT=1    container: exit (exit 0) when idle
//   CODESPACE_NAME          set by Codespaces: the runner is stopped via the GitHub API (token from the phone)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pinToPrs, bytesToHex, PIN_RE, normalizePin } from '../shared/crypto.js';
import { DEFAULT_RELAY_URL, DEFAULT_ROUTER_URL } from './defaults.js';
import { resetPinLock, HOME } from './config.js';

export const IDLE_MINUTES_DEFAULT = 30;

const env1 = (env, k) => env['SNUGCODE_' + k] || env['POCKETCODE_' + k] || '';

// Machine token payload (created & signed by the relay): { kind: 'machine', sub, login, mid }.
// Not verified here — the relay verifies it when the daemon connects.
export function decodeMachineToken(token) {
  try {
    const body = String(token).split('.')[0];
    const p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p?.kind === 'machine' && typeof p.mid === 'string' ? p : null;
  } catch {
    return null;
  }
}

// Env values are applied only when they differ from what was last applied from env, so
// changes made from the phone (new PIN, new key) aren't overwritten on every runner restart.
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
 * Fill config & secrets from the environment (idempotent). Mutates the given objects.
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
    if (!p) throw new Error('SNUGCODE_MACHINE_TOKEN is invalid');
    if (p.mid !== cfg.machineId) {
      // New machine: phone pairings & PIN of the old machine no longer apply.
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
  if (!sec.machineToken) throw new Error('SNUGCODE_MACHINE_TOKEN is not set. Create the runner from the phone app (Use cloud), or copy the token from /api/machines/provision.');
  cfg.linkedRelay = cfg.relayUrl;
  cfg.machineName = env1(env, 'NAME') || cfg.machineName || 'Cloud';

  const pin = env1(env, 'PAIR_PIN');
  if (pin && !PIN_RE.test(pin)) warnings.push('SNUGCODE_PAIR_PIN ignored: must be 6–12 letters/digits.');
  else if (pin && (fromEnv(sec, 'pin', cfg.machineId + ':' + normalizePin(pin)) || !sec.prs)) {
    sec.prs = bytesToHex(await pinToPrs(pin, cfg.machineId));
    resetPinLock(sec);
  }
  if (!sec.prs) warnings.push('No PIN yet: phones can\'t pair. Set SNUGCODE_PAIR_PIN.');

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

// The Codespaces runner supervisor ignores SIGTERM (see cli.js cloud): a daemon that dies while the
// codespace is running would never be started again by anyone. Containers (Docker) still stop cleanly.
export const supervisorIgnoresTerm = (cfg) => cfg.runner?.provider === 'codespace';

// Stop an idle runner. Codespaces: via the GitHub API with a `codespace`-scoped token
// sent by the phone (RPC runnerConfig). Container: the daemon exits (exit 0) and the supervisor stops too.
// @returns 'stopped' | 'exit' | null (no way to stop this runner)
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
      throw new Error('the Codespaces token from the phone is no longer valid (open the app to refresh it)');
    }
    throw new Error('GitHub answered ' + res.status);
  }
  if (r.idleExit) return 'exit';
  return null;
}

// Report the runner's stage/failure to the relay (shown in the phone app while the runner isn't connected yet).
// Only when a machine token is available; network failures are ignored.
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

// ---------- Estimated quota usage ----------
// GitHub's billing API can't be read with the `codespace` scope, so the runner records how long
// it's been running per month (UTC, like the Codespaces quota cycle) times the core count. It's an estimate:
// time the codespace ran before the daemon started (build, start) and other codespaces' usage aren't counted.
const USAGE_FILE = path.join(HOME, 'runner-usage.json');
const TICK_MAX = 5 * 60; // a gap longer than this = the runner was down (not counted)
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

/** Add running time since the last tick. @returns {any} the new file contents */
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
  // Keep only the last 12 months.
  u.months = Object.fromEntries(Object.entries(u.months).sort(([a], [b]) => a.localeCompare(b)).slice(-12));
  try {
    fs.writeFileSync(file, JSON.stringify(u));
  } catch {}
  return u;
}

/** Current month summary for the phone. */
export function usageSummary(now = Date.now(), file = USAGE_FILE) {
  const u = readUsage(file);
  const cur = u.months[month(now)] || { secs: 0, coreSecs: 0 };
  return { month: month(now), hours: +(cur.secs / 3600).toFixed(1), coreHours: +(cur.coreSecs / 3600).toFixed(1), cores: u.cores || os.cpus().length, free: FREE_CORE_HOURS };
}
