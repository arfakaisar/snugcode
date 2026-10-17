// Katalog provider model & referensi model, dipakai daemon, PWA, dan TUI.
//
// Koneksi = satu kredensial milik pengguna (API key official, key router seperti 9router /
// OpenRouter / OmniRoute, atau login ChatGPT). Model dirujuk sebagai "<koneksi>:<id model>",
// mis. "anthropic:claude-opus-5-5" atau "chatgpt:gpt-5.5". Referensi tanpa awalan koneksi
// ("cc/claude-opus-5-5") milik koneksi router lama (`router`, dulu satu-satunya: 9router).
//
// Langganan Claude (Pro/Max) dan login Gemini CLI/Antigravity TIDAK boleh dipakai aplikasi
// pihak ketiga (ketentuan Anthropic & Google, 2026): hanya API key. Login ChatGPT diizinkan OpenAI
// dan dijalankan lewat Codex resmi (lihat daemon/codex.js).

/**
 * @typedef {'anthropic' | 'openai' | 'responses'} WireFormat
 * anthropic = Messages API (/v1/messages), openai = Chat Completions, responses = Responses API.
 * @typedef {{
 *   label: string, short: string,
 *   key?: RegExp,                 // pola key yang pasti milik provider ini
 *   anthropic?: string,          // base URL format Anthropic (tanpa /v1)
 *   openai?: string,             // base URL format OpenAI (dengan /v1 atau setara)
 *   responses?: boolean,         // openai base juga melayani /responses
 *   models?: 'anthropic' | 'openai', // cara mengambil daftar model
 *   keyUrl?: string,             // tempat membuat key (ditampilkan di aplikasi)
 *   oauth?: boolean,
 *   note?: string,
 * }} Provider
 */

/** @type {Record<string, Provider>} */
export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude API)', short: 'Claude API', key: /^sk-ant-api\d\d-[\w-]{20,}$/, anthropic: 'https://api.anthropic.com', models: 'anthropic', keyUrl: 'https://console.anthropic.com/settings/keys' },
  chatgpt: { label: 'ChatGPT (login)', short: 'ChatGPT', oauth: true, note: 'Langganan ChatGPT Plus/Pro lewat Codex resmi' },
  openai: { label: 'OpenAI API', short: 'OpenAI', key: /^sk-(proj|svcacct)-[\w-]{20,}$/, openai: 'https://api.openai.com/v1', responses: true, models: 'openai', keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Google Gemini API', short: 'Gemini', key: /^AIza[\w-]{35}$/, openai: 'https://generativelanguage.googleapis.com/v1beta/openai', models: 'openai', keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { label: 'OpenRouter', short: 'OpenRouter', key: /^sk-or-v1-[0-9a-f]{32,}$/, anthropic: 'https://openrouter.ai/api', openai: 'https://openrouter.ai/api/v1', models: 'openai', keyUrl: 'https://openrouter.ai/keys' },
  deepseek: { label: 'DeepSeek', short: 'DeepSeek', key: /^sk-[0-9a-f]{32}$/, anthropic: 'https://api.deepseek.com/anthropic', openai: 'https://api.deepseek.com', models: 'openai', keyUrl: 'https://platform.deepseek.com/api_keys' },
  moonshot: { label: 'Moonshot (Kimi)', short: 'Kimi', anthropic: 'https://api.moonshot.ai/anthropic', openai: 'https://api.moonshot.ai/v1', models: 'openai', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  zai: { label: 'Z.ai (GLM)', short: 'GLM', key: /^[0-9a-f]{32}\.[\w]{16}$/, anthropic: 'https://api.z.ai/api/anthropic', openai: 'https://api.z.ai/api/paas/v4', models: 'openai', keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  xai: { label: 'xAI (Grok)', short: 'Grok', key: /^xai-[\w]{20,}$/, openai: 'https://api.x.ai/v1', models: 'openai', keyUrl: 'https://console.x.ai' },
  groq: { label: 'Groq', short: 'Groq', key: /^gsk_[\w]{20,}$/, openai: 'https://api.groq.com/openai/v1', models: 'openai', keyUrl: 'https://console.groq.com/keys' },
  // Router/gateway (9router, OmniRoute, LiteLLM, …) dan endpoint lain: format dideteksi saat disambungkan.
  router: { label: 'Router', short: 'Router', models: 'openai' },
  custom: { label: 'Endpoint kustom', short: 'Kustom', models: 'openai' },
};

// Key yang tidak boleh dipakai: alasannya ditampilkan apa adanya ke pengguna.
export const REJECTED_KEYS = [
  { re: /^sk-ant-oat\d\d-/, why: 'Ini token langganan Claude (Pro/Max). Anthropic melarang token ini dipakai di aplikasi pihak ketiga dan memblokirnya. Buat API key di console.anthropic.com, atau pakai router/OpenRouter.' },
  { re: /^sk-ant-admin\d\d-/, why: 'Ini Admin API key Anthropic, bukan key untuk memanggil model. Buat API key biasa di console.anthropic.com.' },
  { re: /^sk-admin-/, why: 'Ini Admin key OpenAI, bukan key untuk memanggil model. Buat API key biasa di platform.openai.com.' },
  { re: /^ya29\./, why: 'Ini token OAuth Google. Login Gemini CLI/Antigravity tidak boleh dipakai aplikasi pihak ketiga (akun bisa disuspend). Pakai API key dari aistudio.google.com.' },
];

// Kandidat provider untuk key yang polanya tidak unik (diuji ke API masing-masing, yang menjawab menang).
export function keyCandidates(key) {
  const exact = Object.entries(PROVIDERS).filter(([, p]) => p.key?.test(key)).map(([k]) => k);
  if (exact.length) return exact;
  if (/^sk-[A-Za-z0-9]{40,64}$/.test(key)) return ['openai', 'moonshot', 'deepseek'];
  if (/^sk-[\w-]{20,}$/.test(key)) return ['openai', 'moonshot', 'deepseek', 'openrouter'];
  return [];
}

export const CONN_RE = /^(anthropic|chatgpt|openai|gemini|openrouter|deepseek|moonshot|zai|xai|groq|router|custom)(\d{0,3})$/;

/** "anthropic:claude-opus-5-5" -> { conn: 'anthropic', id: 'claude-opus-5-5' }; tanpa awalan -> koneksi router lama. */
export function splitRef(ref) {
  const s = String(ref || '');
  const i = s.indexOf(':');
  if (i > 0 && CONN_RE.test(s.slice(0, i))) return { conn: s.slice(0, i), id: s.slice(i + 1) };
  return { conn: 'router', id: s };
}
export const joinRef = (conn, id) => (conn === 'router' ? id : `${conn}:${id}`);
export const connKind = (conn) => String(conn || '').replace(/\d+$/, '');

// Engine (harness) yang dipakai: 'claude' = Claude Agent SDK, 'codex' = Codex app-server.
// Ditentukan per koneksi + model; daemon/engines.js memakai ini bersama format yang terdeteksi.
const GPT_RE = /(^|\/)(gpt-|o\d(-|$)|codex)/i;
export const isGptModel = (id) => GPT_RE.test(String(id || ''));
export const isClaudeId = (id) => /(^|\/)claude-/i.test(String(id || ''));

/**
 * @param {{ kind: string, formats?: Partial<Record<WireFormat, boolean>> }} conn
 * @param {string} id model tanpa awalan koneksi
 * @returns {{ engine: 'claude' | 'codex', wire: 'anthropic' | 'openai' | 'responses' | 'chatgpt' } | null}
 */
export function engineFor(conn, id) {
  const f = conn.formats || {};
  if (conn.kind === 'chatgpt') return { engine: 'codex', wire: 'chatgpt' };
  // Model GPT paling baik di harness-nya sendiri (Codex), bila endpoint melayani Responses API.
  if (f.responses && (conn.kind === 'openai' || isGptModel(id))) return { engine: 'codex', wire: 'responses' };
  if (f.anthropic) return { engine: 'claude', wire: 'anthropic' };
  if (f.openai) return { engine: 'claude', wire: 'openai' };
  return null;
}

export const ENGINE_LABEL = { claude: 'Claude Agent SDK', codex: 'Codex' };

export function maskKey(key) {
  const k = String(key || '');
  return k.length > 12 ? k.slice(0, Math.min(7, k.indexOf('-', 3) + 1 || 4)) + '…' + k.slice(-4) : k ? '…' + k.slice(-2) : '';
}
