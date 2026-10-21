// User-owned model connections: detect API key / endpoint type, list models per connection,
// and quick model tests. The provider catalog & model reference format live in shared/providers.js.
//
// Stored in secrets.connections[id] (closed to the agent, never sent back to the phone):
//   { kind, key, label, openai?, anthropic?, formats: { anthropic, openai, responses }, router?, addedAt }
// The `router` connection = the legacy router (once the only one: config.routerUrl + secrets.routerKey). Its models
// are referenced without a prefix ("cc/claude-opus-5-5"), so old sessions & config still work.
import { PROVIDERS, REJECTED_KEYS, keyCandidates, joinRef, splitRef, engineFor, connKind, maskKey, isClaudeId, isGptModel } from '../shared/providers.js';
import { resolveModelEffort } from '../shared/models.js';

const TIMEOUT = 20_000;
const TTL = 5 * 60 * 1000;

/** @typedef {{ id: string, kind: string, key?: string, label?: string, openai?: string, anthropic?: string, formats: { anthropic?: boolean, openai?: boolean, responses?: boolean }, router?: boolean, legacy?: boolean, account?: { email?: string | null, plan?: string | null }, addedAt?: number }} Conn */

const trimUrl = (/** @type {any} */ u) => String(u || '').trim().replace(/\/+$/, '');
const strip = (/** @type {any} */ u, /** @type {RegExp} */ re) => trimUrl(u).replace(re, '');

// Legacy router: config.routerUrl + secrets.routerKey -> the `router` connection (migrated once).
export function migrateLegacy(cfg, sec) {
  sec.connections ??= {};
  if (sec.routerKey && !sec.connections.router && cfg.routerUrl) {
    sec.connections.router = { kind: 'router', key: sec.routerKey, openai: trimUrl(cfg.routerUrl), anthropic: strip(cfg.routerUrl, /\/v1$/), formats: { anthropic: true, openai: true }, router: true, legacy: true, label: labelForUrl(cfg.routerUrl), addedAt: Date.now() };
    return true;
  }
  return false;
}

/** @returns {Record<string, Conn>} */
export function allConnections(sec) {
  return Object.fromEntries(Object.entries(sec.connections || {}).map(([id, c]) => [id, { ...c, id }]));
}

export function getConn(sec, id) {
  const c = sec.connections?.[id];
  return c ? { ...c, id } : null;
}

// Save a detected connection; returns its ID. One connection per catalog provider (replacing
// the old one); routers & custom endpoints can be many (router, router2, …). The `router` connection = models
// without a prefix, so the first router keeps using the old model references.
/** @param {any} sec @param {any} conn @param {{ replace?: string }} [opts] */
export function putConnection(sec, conn, { replace } = {}) {
  sec.connections ??= {};
  const kind = conn.kind === 'custom' ? 'router' : conn.kind;
  let id = replace && sec.connections[replace] ? replace : kind !== 'router' ? kind : null;
  if (!id) {
    // The same endpoint connected again (e.g. a new key): replace it, don't duplicate.
    id = Object.entries(sec.connections).find(([, c]) => c.kind === 'router' && c.openai === conn.openai)?.[0] || 'router';
    for (let n = 2; sec.connections[id] && sec.connections[id].openai !== conn.openai; n++) id = 'router' + n;
  }
  const prev = sec.connections[id];
  const { id: _id, models: _models, ...rest } = /** @type {any} */ (conn);
  sec.connections[id] = { ...rest, kind, ...(prev?.legacy ? { legacy: true } : {}), addedAt: prev?.addedAt || Date.now() };
  forgetModels(id);
  return id;
}

export const hasConnections = (sec) => Object.keys(sec.connections || {}).length > 0 || !!sec.routerKey;

// Summary for the phone/TUI: without the key (only a snippet to recognize it).
export function connSummary(c) {
  return { id: c.id, kind: c.kind, label: c.label || PROVIDERS[c.kind]?.label || c.kind, url: c.openai || c.anthropic || null, key: c.key ? maskKey(c.key) : null, formats: c.formats, account: c.account || null, legacy: !!c.legacy };
}

// The legacy router is still mirrored in config.routerUrl / secrets.routerKey (old daemon versions & `snugcode status`).
export function mirrorLegacy(cfg, sec) {
  const r = sec.connections?.router;
  if (r?.key) {
    sec.routerKey = r.key;
    cfg.routerUrl = r.openai || cfg.routerUrl;
  } else delete sec.routerKey;
}

function labelForUrl(url) {
  try {
    const h = new URL(url).hostname;
    if (/router\.gemz\.space|9router/i.test(url)) return '9router';
    if (/omniroute/i.test(url)) return 'OmniRoute';
    if (/openrouter\.ai/i.test(h)) return 'OpenRouter';
    if (/litellm/i.test(url)) return 'LiteLLM';
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(h)) return 'Lokal · ' + new URL(url).host;
    return h;
  } catch {
    return 'Router';
  }
}

// ---------- HTTP ----------
/** @param {string} url @param {{ method?: string, headers?: Record<string, string>, body?: any, timeout?: number, fetchImpl?: typeof fetch }} [o] */
async function req(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  let text = '';
  try {
    text = await r.text();
  } catch {}
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, ok: r.ok, json, text };
}

// Auth headers per format. Official Anthropic uses x-api-key; Anthropic-format endpoints of
// other providers (DeepSeek, Kimi, GLM, OpenRouter, router) follow Claude Code's ANTHROPIC_AUTH_TOKEN (Bearer).
export function authHeaders(c, wire) {
  if (wire === 'gemini') return { 'x-goog-api-key': c.key };
  if (wire === 'anthropic') return c.kind === 'anthropic' ? { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + c.key, 'anthropic-version': '2023-06-01' };
  if (c.kind === 'openrouter') return { authorization: 'Bearer ' + c.key, 'http-referer': 'https://github.com/arfakaisar/snugcode', 'x-title': 'snugcode' };
  return { authorization: 'Bearer ' + c.key };
}

const errMsg = (r) => {
  const j = r.json;
  const m = j?.error?.message || j?.error?.msg || j?.message || (typeof j?.error === 'string' ? j.error : '') || r.text;
  return String(m || 'HTTP ' + r.status).replace(/\s+/g, ' ').trim().slice(0, 200);
};

// An endpoint "exists" = answers anything other than 404/405 to an empty body (400/422 = exists but invalid body).
// Doesn't call the model, so it costs no tokens.
async function endpointExists(url, headers, fetchImpl) {
  try {
    const r = await req(url, { method: 'POST', headers, body: {}, timeout: 12_000, fetchImpl });
    if (r.status === 401 || r.status === 403) return 'auth';
    return r.status !== 404 && r.status !== 405 && r.status < 500;
  } catch {
    return false;
  }
}

// ---------- detection ----------
/**
 * Recognize a key/endpoint and its format. Saves nothing.
 * @param {{ key?: string, url?: string, kind?: string }} input
 * @returns {Promise<Conn & { models: ReturnType<typeof normalizeModels> }>}
 */
export async function detectConnection({ key, url, kind } = {}, { fetchImpl = fetch } = {}) {
  key = String(key || '').trim().replace(/^Bearer\s+/i, '');
  url = trimUrl(url);
  if (!key && !url) throw new Error('Paste an API key (and the URL if you use a router/your own endpoint).');
  for (const r of REJECTED_KEYS) if (r.re.test(key)) throw new Error(r.why);
  if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('The URL must start with http:// or https://');

  // A URL belonging to a catalog provider -> treat it as that provider.
  if (url && !kind) kind = Object.entries(PROVIDERS).find(([, p]) => [p.openai, p.anthropic].some((u) => u && trimUrl(u).startsWith(strip(url, /\/v1$/))))?.[0];
  if (url && (!kind || kind === 'router' || kind === 'custom')) return detectEndpoint(key, url, fetchImpl);

  const cands = kind ? [kind] : keyCandidates(key);
  if (!cands.length) throw new Error('Key type not recognized. If this is a router key (9router, OmniRoute, LiteLLM, …) or another endpoint, also fill in its URL.');
  // All candidates are tested at once; catalog order decides the winner if more than one answers.
  /** @type {{ conn?: any, auth?: boolean, kind?: string, err?: string }[]} */
  const results = await Promise.all(cands.map((k) => tryProvider(k, key, fetchImpl).catch((e) => ({ err: e.message }))));
  const hit = results.find((r) => r.conn);
  if (hit) return hit.conn;
  const auth = results.find((r) => r.auth);
  if (auth) throw new Error(`Key rejected by ${PROVIDERS[auth.kind].label} (401). Check the key again.`);
  throw new Error(results.map((r) => r.err).filter(Boolean)[0] || 'The key could not be verified.');
}

async function tryProvider(kind, key, fetchImpl) {
  const p = PROVIDERS[kind];
  /** @type {Conn} */
  const c = { id: kind, kind, key, label: p.label, openai: p.openai, anthropic: p.anthropic, formats: { anthropic: !!p.anthropic, openai: !!p.openai, responses: !!p.responses } };
  let models;
  try {
    models = await fetchModels(c, fetchImpl);
  } catch (e) {
    if (/\b40[13]\b/.test(e.message)) return { auth: true, kind };
    throw e;
  }
  // Third-party Anthropic-format endpoints are verified (they may change/close): if missing,
  // the agent still works through the proxy's OpenAI-format translator.
  if (c.anthropic && kind !== 'anthropic') {
    const ok = await endpointExists(c.anthropic + '/v1/messages', authHeaders(c, 'anthropic'), fetchImpl);
    c.formats.anthropic = ok === true;
  }
  return { conn: { ...c, models } };
}

async function detectEndpoint(key, url, fetchImpl) {
  // OpenAI base: the URL as-is if it already ends with /v1 (or another version), otherwise + /v1.
  const base = strip(url, /\/(chat\/completions|messages|responses|models)$/);
  const openai = /\/v\d+(beta)?$|\/openai$/.test(base) ? base : base + '/v1';
  const root = strip(openai, /\/v1$/);
  /** @type {Conn} */
  const c = { id: 'router', kind: 'router', key, label: labelForUrl(url), openai, anthropic: root, formats: {}, router: true };
  const h = key ? { authorization: 'Bearer ' + key } : {};
  const [anth, chat, resp] = await Promise.all([
    endpointExists(root + '/v1/messages', { ...h, 'anthropic-version': '2023-06-01' }, fetchImpl),
    endpointExists(openai + '/chat/completions', h, fetchImpl),
    endpointExists(openai + '/responses', h, fetchImpl),
  ]);
  if ([anth, chat, resp].includes('auth')) throw new Error(`Key rejected by ${c.label} (401). Check the key again.`);
  c.formats = { anthropic: anth === true, openai: chat === true, responses: resp === true };
  if (!c.formats.anthropic && !c.formats.openai && !c.formats.responses) throw new Error(`${c.label} can't be reached or isn't a model endpoint (no /v1/messages, /chat/completions, or /responses).`);
  let models = [];
  try {
    models = await fetchModels(c, fetchImpl);
  } catch (e) {
    if (/\b40[13]\b/.test(e.message)) throw new Error(`Key rejected by ${c.label} (401). Check the key again.`);
  }
  if (!models.length) throw new Error(`${c.label} returned no models that support tool calling.`);
  return { ...c, models };
}

// ---------- model list ----------
const cache = new Map(); // conn id -> { sig, at, list }
const sig = (c) => [c.kind, c.key, c.openai, c.anthropic].join('|');

// Native effort: Claude 4.5+/5 (Agent SDK), GPT models (Codex), Gemini (reasoning_effort via the proxy).
function effortsFor(c, id) {
  const kind = connKind(c.kind);
  if (kind === 'anthropic' && /claude-(opus|sonnet|fable)-([5-9]|4-[5-9])/.test(id)) return ['low', 'medium', 'high', 'max'];
  if ((kind === 'openai' || kind === 'chatgpt') && isGptModel(id)) return /gpt-5|codex/.test(id) ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'];
  if (kind === 'gemini' && /gemini-([3-9]|2\.5)/.test(id)) return ['low', 'medium', 'high'];
  return undefined;
}

const SKIP_OPENAI = /(embed|audio|realtime|tts|transcri|whisper|dall-e|image|moderation|search|instruct|davinci|babbage|-vision-preview)/i;
const SKIP_GEMINI = /(embed|aqa|imagen|veo|tts|live|native-audio|image|learnlm|gemma)/i;

/** Raw endpoint list -> [{ id: ref, ctx?, vision?, reasoning?, efforts?, label, engine }] */
export function normalizeModels(c, data) {
  const kind = connKind(c.kind);
  let list = (Array.isArray(data) ? data : []).filter((m) => m && typeof m.id === 'string');
  if (kind === 'openai') list = list.filter((m) => isGptModel(m.id) && !SKIP_OPENAI.test(m.id));
  if (kind === 'gemini') list = list.map((m) => ({ ...m, id: m.id.replace(/^models\//, '') })).filter((m) => /^gemini-/.test(m.id) && !SKIP_GEMINI.test(m.id));
  // The agent needs tool calling: drop models that say they don't support it.
  list = list.filter((m) => m.capabilities?.tools !== false && !(Array.isArray(m.supported_parameters) && !m.supported_parameters.includes('tools')));
  const label = c.label || PROVIDERS[c.kind]?.short || c.kind;
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const route = engineFor(c, m.id);
    if (!route) continue;
    out.push({
      id: joinRef(c.id, m.id),
      ctx: m.context_length || m.context_window || m.max_input_tokens || m.capabilities?.contextWindow || m.top_provider?.context_length || undefined,
      vision: !!(m.capabilities?.vision || m.architecture?.input_modalities?.includes?.('image') || (kind === 'anthropic' && isClaudeId(m.id)) || kind === 'gemini'),
      reasoning: !!m.capabilities?.reasoning,
      efforts: effortsFor(c, m.id),
      label,
      engine: route.engine,
    });
  }
  return out;
}

async function fetchModels(c, fetchImpl = fetch) {
  if (c.kind === 'chatgpt') throw new Error('ChatGPT models are fetched via Codex');
  const p = PROVIDERS[c.kind] || PROVIDERS.custom;
  let r;
  if (p.models === 'anthropic') r = await req(c.anthropic + '/v1/models?limit=1000', { headers: authHeaders(c, 'anthropic'), fetchImpl });
  else r = await req(trimUrl(c.openai) + '/models', { headers: authHeaders(c, 'openai'), fetchImpl });
  if (!r.ok) throw new Error(`${c.label || c.kind}: ${r.status} ${errMsg(r)}`);
  const data = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json?.models) ? r.json.models.map((m) => ({ ...m, id: m.id || m.name })) : Array.isArray(r.json) ? r.json : [];
  return normalizeModels(c, data);
}

// `codexModels`: provider of the ChatGPT model list (see daemon/codex.js), injected by server.js.
/** @param {Conn} c @param {{ fresh?: boolean, fetchImpl?: typeof fetch, codexModels?: (c: Conn) => Promise<any[]> }} [o] @returns {Promise<any[]>} */
export async function listConnModels(c, { fresh = false, fetchImpl = fetch, codexModels } = {}) {
  const hit = cache.get(c.id);
  if (!fresh && hit && hit.sig === sig(c) && Date.now() - hit.at < TTL) return hit.list;
  const list = c.kind === 'chatgpt' ? await codexModels?.(c) ?? [] : await fetchModels(c, fetchImpl);
  cache.set(c.id, { sig: sig(c), at: Date.now(), list });
  return list;
}

// All models from all connections; failing connections are reported instead of failing everything.
/** @param {any} sec @param {{ fresh?: boolean, codexModels?: (c: Conn) => Promise<any[]> }} [opts] */
export async function listAllModels(sec, opts = {}) {
  const conns = Object.values(allConnections(sec));
  /** @type {{ c: Conn, list: any[], err?: string }[]} */
  const res = await Promise.all(conns.map((c) => listConnModels(c, opts).then((list) => ({ c, list }), (e) => ({ c, list: [], err: e.message }))));
  return { models: res.flatMap((r) => r.list), errors: res.filter((r) => r.err).map((r) => ({ conn: r.c.id, err: r.err })) };
}

// Last known model IDs (may be stale) without waiting on the network; refreshed in the background.
const refreshing = new Set();
export function knownRefs(sec, connId, opts = {}) {
  const c = getConn(sec, connId);
  if (!c) return null;
  const hit = cache.get(connId);
  const fresh = hit && hit.sig === sig(c) && Date.now() - hit.at < TTL;
  if (!fresh && !refreshing.has(connId) && (c.key || c.kind === 'chatgpt')) {
    refreshing.add(connId);
    listConnModels(c, { ...opts, fresh: true }).catch(() => {}).finally(() => refreshing.delete(connId));
  }
  return hit && hit.sig === sig(c) ? hit.list.map((m) => m.id) : null;
}

export function forgetModels(connId) {
  cache.delete(connId);
}

// Gemini API root (native format, for Gemini CLI) from the Gemini connection's OpenAI-compatible base.
export const geminiRoot = (c) => String(c.openai || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, '').replace(/\/v1(beta)?\/openai$/, '');

/** @param {Conn} c @param {string} engine @returns {ReturnType<typeof engineFor>} */
function forcedEngine(c, engine) {
  const f = c.formats || {};
  if (engine === 'claude' && (f.anthropic || f.openai)) return { engine: 'claude', wire: f.anthropic ? 'anthropic' : 'openai' };
  if (engine === 'codex' && f.responses) return { engine: 'codex', wire: 'responses' };
  if (engine === 'gemini' && c.kind === 'gemini') return { engine: 'gemini', wire: 'gemini' };
  return null;
}

/**
 * Route for one model reference: connection, real ID at the endpoint, effort, and the engine/format used.
 * @returns {{ conn: Conn, model: string, effort: string | null, engine: 'claude' | 'codex' | 'gemini', wire: string }}
 */
export function resolveRoute(sec, ref) {
  const { actualModel, effort } = resolveModelEffort(ref);
  const { conn: connId, id } = splitRef(actualModel);
  const c = getConn(sec, connId);
  if (!c) throw new Error(connId === 'router' ? 'No model connected yet. Open PC settings → Models & API keys in the app, then paste your API key.' : `Connection "${connId}" for model ${ref} was removed. Pick another model or connect it again.`);
  let r = engineFor(c, id);
  // SNUGCODE_ENGINE=claude|codex|gemini: force that engine if its endpoint supports it (e.g. the Claude Agent SDK
  // for Gemini/GPT models, or comparing engines in `npm run bench`).
  const want = process.env.SNUGCODE_ENGINE;
  if (r && want && want !== r.engine) r = forcedEngine(c, want) || r;
  if (!r) throw new Error(`${c.label || c.kind} has no API format the agent can use.`);
  return { conn: c, model: id, effort, ...r };
}

// ---------- model test ----------
const DEAD_RE = /\b(no longer available|is not available|has been (deprecated|discontinued|removed)|please switch to)\b/i;

export async function probeRoute(route, { fetchImpl = fetch } = {}) {
  const { conn: c, model, wire } = route;
  const t0 = Date.now();
  let r;
  try {
    if (wire === 'anthropic') r = await req(c.anthropic + '/v1/messages', { method: 'POST', headers: authHeaders(c, 'anthropic'), body: { model, max_tokens: 256, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }, timeout: 45_000, fetchImpl });
    else if (wire === 'responses') r = await req(trimUrl(c.openai) + '/responses', { method: 'POST', headers: authHeaders(c, 'openai'), body: { model, input: 'Reply with exactly: ok', max_output_tokens: 256 }, timeout: 45_000, fetchImpl });
    else r = await req(trimUrl(c.openai) + '/chat/completions', { method: 'POST', headers: authHeaders(c, 'openai'), body: { model: model.replace(/-(low|medium|high|minimal)$/, ''), max_tokens: 256, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }, timeout: 45_000, fetchImpl });
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.name === 'TimeoutError' ? 'timeout after 45 seconds' : e.message };
  }
  const ms = Date.now() - t0;
  if (!r.ok) return { ok: false, ms, err: errMsg(r) };
  const j = r.json || {};
  const text = String(
    wire === 'anthropic' ? (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') : wire === 'responses' ? j.output_text || (j.output || []).flatMap((o) => o.content || []).map((x) => x.text || '').join('') : j.choices?.[0]?.message?.content || '',
  ).trim();
  if (DEAD_RE.test(text)) return { ok: false, ms, err: 'Model no longer available: ' + text.slice(0, 160) };
  // Reasoning models can spend tokens thinking without text: a 200 answer is still considered healthy.
  return { ok: true, ms, text: text.slice(0, 80) };
}
