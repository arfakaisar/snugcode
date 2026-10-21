// Model grouping: effort variants split into separate IDs on routers
// (e.g. ag/gemini-3.8-flash-low / -medium / -high) are merged into one model
// with effort levels. 9router doesn't accept an effort parameter
// (thinkingEffortSupported=false), so effort = picking the variant ID.
// Models from other connections ("anthropic:claude-opus-5-5", see shared/providers.js) carry their own
// effort list (`efforts`), which becomes virtual variants "<ref>-<effort>".
import { splitRef, joinRef, connKind, PROVIDERS } from './providers.js';

// Ordered from cheapest to deepest thinking.
export const EFFORTS = ['minimal', 'extra-low', 'low', 'medium', 'high', 'xhigh', 'max'];
// Non-greedy so "-extra-low" is read whole, not "-extra" + "low".
const EFFORT_RE = new RegExp(`^(.+?)-(${EFFORTS.join('|')})$`);

export const EFFORT_LABEL = { minimal: 'minimal', 'extra-low': 'x-low', low: 'low', medium: 'med', high: 'high', xhigh: 'x-high', max: 'max' };

export const PROVIDER_LABEL = { ag: 'Antigravity', gemini: 'Gemini API', cmc: 'CommandCode', cc: 'Claude Code', ...Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, p.short])) };

// "ag/gemini-3.8-flash-high" -> { conn: 'router', provider: 'ag', base: 'gemini-3.8-flash', effort: 'high' }
// "anthropic:claude-opus-5-5-high" -> { conn: 'anthropic', provider: 'anthropic', base: 'claude-opus-5-5', effort: 'high' }
// For connections other than the legacy router, `provider` = the connection and `base` keeps that
// endpoint's model prefix (e.g. OpenRouter "google/gemini-3-pro").
export function parseModelId(id) {
  const { conn, id: rest0 } = splitRef(id);
  if (conn !== 'router') {
    const m = rest0.match(EFFORT_RE);
    return m ? { conn, provider: conn, base: m[1], effort: m[2] } : { conn, provider: conn, base: rest0, effort: null };
  }
  const slash = rest0.indexOf('/');
  const provider = slash > 0 ? rest0.slice(0, slash) : '';
  const rest = slash > 0 ? rest0.slice(slash + 1) : rest0;
  const m = rest.match(EFFORT_RE);
  return m ? { conn, provider, base: m[1], effort: m[2] } : { conn, provider, base: rest, effort: null };
}

// Group key (model without effort) as a full reference.
const groupKey = (p) => (p.conn !== 'router' ? `${p.conn}:${p.base}` : (p.provider ? p.provider + '/' : '') + p.base);

// Models whose effort is set via Claude Code's native parameter (not a router variant ID):
// provider cc/, or claude-* IDs without a provider. claude-* models on other providers (e.g.
// ag/claude-opus-4-6-thinking) are passed as-is because their router doesn't know effort.
// Official Anthropic connection: claude-* models. OpenAI/ChatGPT connections: effort is passed to Codex.
export const nativeEffortModel = (provider, base) =>
  provider === 'cc' || (provider === '' && base.startsWith('claude-')) || (connKind(provider) === 'anthropic' && base.startsWith('claude-')) || ['openai', 'chatgpt'].includes(connKind(provider));

// Native efforts offered by the slider (all accepted by the Agent SDK's `effort` option).
const NATIVE_EFFORTS = ['low', 'medium', 'high', 'max'];

// Light model for subagents (Explore, general-purpose, Plan) and Claude Code utility tasks
// (WebFetch summaries, etc.). Only two choices: Claude Haiku 5.5 or Gemini 3.8 Flash.
// Claude main models (cc/ or claude-* without a provider): Haiku first, then Flash.
// Other main models (ag/, gemini/, …): Flash first, then Haiku.
export const LIGHT_HAIKU = 'claude-haiku-5-5';
export const LIGHT_FLASH = 'gemini-3.8-flash';
// The Flash variant best suited for subagents: thinks enough, stays fast.
const FLASH_EFFORTS = ['low', null, 'minimal', 'extra-low', 'medium', 'high', 'xhigh', 'max'];

/**
 * @param {string} mainId the session's main model
 * @param {string[] | null} [ids] model IDs on the router; null = unknown yet (use the default guess)
 * @returns {{ id: string, kind: 'haiku' | 'flash' | 'main' }} kind 'main' = neither is on the router
 */
export function lightModel(mainId, ids = null) {
  const main = parseModelId(mainId || '');
  if (main.conn !== 'router') return lightForConn(main, ids);
  /** @type {('haiku' | 'flash')[]} */
  const order = nativeEffortModel(main.provider, main.base) ? ['haiku', 'flash'] : ['flash', 'haiku'];
  if (!ids) {
    const kind = order[0];
    if (kind === 'haiku') return { id: 'cc/' + LIGHT_HAIKU, kind };
    return { id: main.provider === 'gemini' ? 'gemini/' + LIGHT_FLASH : `ag/${LIGHT_FLASH}-low`, kind };
  }
  const parsed = ids.map((id) => ({ id, ...parseModelId(id) }));
  for (const kind of order) {
    const base = kind === 'haiku' ? LIGHT_HAIKU : LIGHT_FLASH;
    const home = kind === 'haiku' ? 'cc' : 'ag';
    const rank = (p) => (p.provider === main.provider ? 0 : p.provider === home ? 1 : 2) * 10 + (kind === 'flash' ? FLASH_EFFORTS.indexOf(p.effort) : p.effort === null ? 0 : 1);
    const best = parsed.filter((p) => p.base === base).sort((a, b) => rank(a) - rank(b))[0];
    // Native Haiku: effort is set per subagent (the `agents` option), so use its plain ID.
    if (best) return { id: kind === 'haiku' ? resolveModelEffort(best.id).actualModel : best.id, kind };
  }
  return { id: resolveModelEffort(mainId).actualModel, kind: 'main' };
}

// Connections other than the legacy router: a light model from the same connection and the same model family
// (Claude → latest Haiku, Gemini → latest Flash, GPT → latest *-mini, DeepSeek → *-flash/-chat).
// The Codex harness manages its own subagents, so OpenAI/ChatGPT connections use the main model.
const FAMILY = [
  { re: /claude/i, light: /claude-haiku/i, kind: /** @type {const} */ ('haiku') },
  { re: /gemini/i, light: /gemini-[\d.]+-flash(?!-lite|-image|-live|-tts)/i, kind: /** @type {const} */ ('flash') },
  { re: /deepseek/i, light: /deepseek-(v[\d.]+-)?(flash|chat)\b/i, kind: /** @type {const} */ ('flash') },
  { re: /glm/i, light: /glm-[\d.]+-(air|flash)/i, kind: /** @type {const} */ ('flash') },
];
// Newest version first: "gemini-3.8-flash" > "gemini-3.5-flash" (compare numbers per segment).
const versionCmp = (a, b) => b.localeCompare(a, 'en', { numeric: true });

function lightForConn(main, ids) {
  const mainRef = joinRef(main.conn, main.base);
  const kind = connKind(main.conn);
  const asMain = { id: resolveModelEffort(mainRef).actualModel, kind: /** @type {const} */ ('main') };
  if (kind === 'openai' || kind === 'chatgpt') return asMain;
  const fam = FAMILY.find((f) => f.re.test(main.base));
  if (!fam) return asMain;
  if (!ids) {
    if (kind === 'anthropic') return { id: 'anthropic:' + LIGHT_HAIKU, kind: /** @type {const} */ ('haiku') };
    if (kind === 'gemini') return { id: `gemini:${LIGHT_FLASH}-low`, kind: /** @type {const} */ ('flash') };
    return asMain;
  }
  const hits = ids.map((r) => parseModelId(r)).filter((p) => p.conn === main.conn && fam.light.test(p.base)).map((p) => p.base);
  const best = [...new Set(hits)].sort(versionCmp)[0];
  if (!best || best === main.base) return asMain;
  // Gemini via the proxy: effort is in the ID (translated to reasoning_effort), "low" is enough for subagents.
  return { id: joinRef(main.conn, kind === 'gemini' ? best + '-low' : best), kind: fam.kind };
}

// For native Claude models, separate the router's real ID from the virtual effort.
// Contoh: "cc/claude-opus-5-5-high" -> { actualModel: "cc/claude-opus-5-5", effort: "high" }.
export function resolveModelEffort(id) {
  if (!id) return { actualModel: '', effort: null };
  const p = parseModelId(id);
  if (nativeEffortModel(p.provider, p.base) && p.effort && (NATIVE_EFFORTS.includes(p.effort) || (p.conn !== 'router' && EFFORTS.includes(p.effort)))) {
    return { actualModel: groupKey(p), effort: p.effort };
  }
  return { actualModel: id, effort: null };
}

// list: [{ id, ctx?, vision?, reasoning?, efforts?, label?, engine? }] or [string] (old daemon versions).
// `efforts`: this model's native effort levels (connections other than the legacy router), as virtual variants.
export function groupModels(list) {
  const groups = new Map();
  for (const raw of list) {
    const m = typeof raw === 'string' ? { id: raw } : raw;
    // Connection models with their own effort list: their ID is always plain (no effort suffix).
    const p = m.efforts ? { ...parseModelId(m.id), base: splitRef(m.id).id, effort: null } : parseModelId(m.id);
    const key = groupKey(p);
    let g = groups.get(key);
    if (!g) {
      g = { key, conn: p.conn, provider: p.provider, name: p.base, variants: [], ctx: m.ctx, vision: m.vision, reasoning: m.reasoning, label: m.label, engine: m.engine };
      groups.set(key, g);
    }
    g.variants.push({ effort: p.effort, id: m.id });
    for (const lev of m.efforts || []) if (EFFORTS.includes(lev) && !g.variants.some((v) => v.effort === lev)) g.variants.push({ effort: lev, id: `${key}-${lev}`, virtual: true });
  }
  for (const g of groups.values()) {
    // Native Claude models (cc/ or claude-* without a provider):
    // 9router doesn't split Claude models per variant ID because Claude uses
    // adaptive thinking & a native effort parameter.
    if (g.conn === 'router' && nativeEffortModel(g.provider, g.name)) {
      for (const lev of NATIVE_EFFORTS) {
        if (!g.variants.some((v) => v.effort === lev)) {
          g.variants.push({ effort: lev, id: `${g.key}-${lev}`, virtual: true });
        }
      }
    }
    // A plain model without a suffix = the router's default setting ("auto").
    g.auto = g.variants.find((v) => v.effort === null)?.id || null;
    g.levels = g.variants.filter((v) => v.effort).sort((a, b) => EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort));
    // A single effort variant with no plain version -> not a choice, just a fixed label.
    g.fixed = !g.auto && g.levels.length === 1 ? g.levels[0].effort : null;
    g.slider = g.levels.length > 1 || (g.levels.length === 1 && !!g.auto);
  }
  return [...groups.values()];
}

export function findGroup(groups, id) {
  return groups.find((g) => g.variants.some((v) => v.id === id)) || null;
}

// Initial effort when a group is picked: keep the current choice if it's in the group,
// then medium, then auto, then the middle level.
export function defaultChoice(group, currentId) {
  const cur = group.variants.find((v) => v.id === currentId);
  if (cur) return cur.effort;
  if (group.levels.some((l) => l.effort === 'medium')) return 'medium';
  if (group.auto) return null;
  return group.levels[Math.floor((group.levels.length - 1) / 2)]?.effort ?? null;
}

export function resolveId(group, effort) {
  if (effort === null) return group.auto || group.levels[0]?.id;
  return group.levels.find((l) => l.effort === effort)?.id || group.auto || group.levels[0].id;
}

// Compact label: "gemini-3.8-flash · high", "gemini-3.8-flash · auto".
export function modelLabel(id, { provider = false } = {}) {
  if (!id) return '';
  const p = parseModelId(id);
  const pre = !provider || !p.provider ? '' : p.conn !== 'router' ? (PROVIDER_LABEL[connKind(p.conn)] || p.conn) + ' · ' : p.provider + '/';
  return pre + p.base + (p.effort ? ' · ' + (EFFORT_LABEL[p.effort] || p.effort) : '');
}

export function ctxLabel(n) {
  if (!n) return '';
  return n >= 1e6 ? Math.round(n / 1e5) / 10 + 'M' : Math.round(n / 1000) + 'K';
}
