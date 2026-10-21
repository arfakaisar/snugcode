// Catalog of model providers & model references, used by the daemon, PWA, and TUI.
//
// Connection = one user-owned credential (official API key, a router key such as 9router /
// OpenRouter / OmniRoute, or a ChatGPT login). Models are referenced as "<connection>:<model id>",
// e.g. "anthropic:claude-opus-5-5" or "chatgpt:gpt-5.5". References without a connection prefix
// ("cc/claude-opus-5-5") belong to the legacy router connection (`router`, once the only one: 9router).
//
// Claude subscriptions (Pro/Max) and Gemini CLI/Antigravity logins may NOT be used by third-party
// apps (Anthropic & Google terms, 2026): API keys only. ChatGPT login is allowed by OpenAI
// and runs through the official Codex (see daemon/codex.js).
import { ENGINE_TABLE } from './engine-table.js';

/**
 * @typedef {'anthropic' | 'openai' | 'responses'} WireFormat
 * anthropic = Messages API (/v1/messages), openai = Chat Completions, responses = Responses API.
 * @typedef {{
 *   label: string, short: string,
 *   key?: RegExp,                 // key pattern that certainly belongs to this provider
 *   anthropic?: string,          // Anthropic-format base URL (without /v1)
 *   openai?: string,             // OpenAI-format base URL (with /v1 or equivalent)
 *   responses?: boolean,         // the openai base also serves /responses
 *   models?: 'anthropic' | 'openai', // how to fetch the model list
 *   keyUrl?: string,             // where to create a key (shown in the app)
 *   oauth?: boolean,
 *   note?: string,
 * }} Provider
 */

/** @type {Record<string, Provider>} */
export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude API)', short: 'Claude API', key: /^sk-ant-api\d\d-[\w-]{20,}$/, anthropic: 'https://api.anthropic.com', models: 'anthropic', keyUrl: 'https://console.anthropic.com/settings/keys' },
  chatgpt: { label: 'ChatGPT (login)', short: 'ChatGPT', oauth: true, note: 'ChatGPT Plus/Pro subscription via the official Codex' },
  openai: { label: 'OpenAI API', short: 'OpenAI', key: /^sk-(proj|svcacct)-[\w-]{20,}$/, openai: 'https://api.openai.com/v1', responses: true, models: 'openai', keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Google Gemini API', short: 'Gemini', key: /^AIza[\w-]{35}$/, openai: 'https://generativelanguage.googleapis.com/v1beta/openai', models: 'openai', keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { label: 'OpenRouter', short: 'OpenRouter', key: /^sk-or-v1-[0-9a-f]{32,}$/, anthropic: 'https://openrouter.ai/api', openai: 'https://openrouter.ai/api/v1', models: 'openai', keyUrl: 'https://openrouter.ai/keys' },
  deepseek: { label: 'DeepSeek', short: 'DeepSeek', key: /^sk-[0-9a-f]{32}$/, anthropic: 'https://api.deepseek.com/anthropic', openai: 'https://api.deepseek.com', models: 'openai', keyUrl: 'https://platform.deepseek.com/api_keys' },
  moonshot: { label: 'Moonshot (Kimi)', short: 'Kimi', anthropic: 'https://api.moonshot.ai/anthropic', openai: 'https://api.moonshot.ai/v1', models: 'openai', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  zai: { label: 'Z.ai (GLM)', short: 'GLM', key: /^[0-9a-f]{32}\.[\w]{16}$/, anthropic: 'https://api.z.ai/api/anthropic', openai: 'https://api.z.ai/api/paas/v4', models: 'openai', keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  xai: { label: 'xAI (Grok)', short: 'Grok', key: /^xai-[\w]{20,}$/, openai: 'https://api.x.ai/v1', models: 'openai', keyUrl: 'https://console.x.ai' },
  groq: { label: 'Groq', short: 'Groq', key: /^gsk_[\w]{20,}$/, openai: 'https://api.groq.com/openai/v1', models: 'openai', keyUrl: 'https://console.groq.com/keys' },
  // Routers/gateways (9router, OmniRoute, LiteLLM, …) and other endpoints: format detected when connecting.
  router: { label: 'Router', short: 'Router', models: 'openai' },
  custom: { label: 'Custom endpoint', short: 'Custom', models: 'openai' },
};

// Keys that may not be used: the reason is shown to the user as-is.
export const REJECTED_KEYS = [
  { re: /^sk-ant-oat\d\d-/, why: 'This is a Claude subscription token (Pro/Max). Anthropic forbids using it in third-party apps and blocks it. Create an API key at console.anthropic.com, or use a router/OpenRouter.' },
  { re: /^sk-ant-admin\d\d-/, why: 'This is an Anthropic Admin API key, not a key for calling models. Create a regular API key at console.anthropic.com.' },
  { re: /^sk-admin-/, why: 'This is an OpenAI Admin key, not a key for calling models. Create a regular API key at platform.openai.com.' },
  { re: /^ya29\./, why: 'This is a Google OAuth token. Gemini CLI/Antigravity logins may not be used by third-party apps (the account can be suspended). Use an API key from aistudio.google.com.' },
];

// Provider candidates for keys whose pattern isn't unique (tested against each API, the one that answers wins).
export function keyCandidates(key) {
  const exact = Object.entries(PROVIDERS).filter(([, p]) => p.key?.test(key)).map(([k]) => k);
  if (exact.length) return exact;
  if (/^sk-[A-Za-z0-9]{40,64}$/.test(key)) return ['openai', 'moonshot', 'deepseek'];
  if (/^sk-[\w-]{20,}$/.test(key)) return ['openai', 'moonshot', 'deepseek', 'openrouter'];
  return [];
}

export const CONN_RE = /^(anthropic|chatgpt|openai|gemini|openrouter|deepseek|moonshot|zai|xai|groq|router|custom)(\d{0,3})$/;

/** "anthropic:claude-opus-5-5" -> { conn: 'anthropic', id: 'claude-opus-5-5' }; no prefix -> the legacy router connection. */
export function splitRef(ref) {
  const s = String(ref || '');
  const i = s.indexOf(':');
  if (i > 0 && CONN_RE.test(s.slice(0, i))) return { conn: s.slice(0, i), id: s.slice(i + 1) };
  return { conn: 'router', id: s };
}
export const joinRef = (conn, id) => (conn === 'router' ? id : `${conn}:${id}`);
export const connKind = (conn) => String(conn || '').replace(/\d+$/, '');

// Engine (harness) to use: 'claude' = Claude Agent SDK, 'codex' = Codex app-server, 'gemini' = Gemini CLI (ACP).
// Decided per connection + model: the engine table (shared/engine-table.js, from benchmarks), then the detected format.
const GPT_RE = /(^|\/)(gpt-|o\d(-|$)|codex)/i;
export const isGptModel = (id) => GPT_RE.test(String(id || ''));
export const isClaudeId = (id) => /(^|\/)claude-/i.test(String(id || ''));

/**
 * @param {{ kind: string, formats?: Partial<Record<WireFormat, boolean>> }} conn
 * @param {string} id model without the connection prefix
 * @returns {{ engine: 'claude' | 'codex' | 'gemini', wire: 'anthropic' | 'openai' | 'responses' | 'chatgpt' | 'gemini' } | null}
 */
export function engineFor(conn, id) {
  const f = conn.formats || {};
  if (conn.kind === 'chatgpt') return { engine: 'codex', wire: 'chatgpt' };
  const row = ENGINE_TABLE.find((r) => r.kind === conn.kind && new RegExp(r.model, 'i').test(String(id || '')));
  if (row?.engine === 'gemini') return { engine: 'gemini', wire: 'gemini' };
  // GPT models do best in their own harness (Codex), when the endpoint serves the Responses API.
  if (f.responses && (conn.kind === 'openai' || isGptModel(id))) return { engine: 'codex', wire: 'responses' };
  if (f.anthropic) return { engine: 'claude', wire: 'anthropic' };
  if (f.openai) return { engine: 'claude', wire: 'openai' };
  return null;
}

export const ENGINE_LABEL = { claude: 'Claude Agent SDK', codex: 'Codex', gemini: 'Gemini CLI' };

export function maskKey(key) {
  const k = String(key || '');
  return k.length > 12 ? k.slice(0, Math.min(7, k.indexOf('-', 3) + 1 || 4)) + '…' + k.slice(-4) : k ? '…' + k.slice(-2) : '';
}
