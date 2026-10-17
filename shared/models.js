// Pengelompokan model: varian effort yang dipisah per ID di router
// (mis. ag/gemini-3.8-flash-low / -medium / -high) digabung jadi satu model
// dengan tingkat effort. 9router tidak menerima parameter effort
// (thinkingEffortSupported=false), jadi effort = memilih ID varian.
// Model dari koneksi lain ("anthropic:claude-opus-5-5", lihat shared/providers.js) membawa daftar
// effort-nya sendiri (`efforts`), yang menjadi varian virtual "<ref>-<effort>".
import { splitRef, joinRef, connKind, PROVIDERS } from './providers.js';

// Urutan dari paling hemat ke paling dalam berpikir.
export const EFFORTS = ['minimal', 'extra-low', 'low', 'medium', 'high', 'xhigh', 'max'];
// Non-greedy agar "-extra-low" terbaca utuh, bukan "-extra" + "low".
const EFFORT_RE = new RegExp(`^(.+?)-(${EFFORTS.join('|')})$`);

export const EFFORT_LABEL = { minimal: 'minimal', 'extra-low': 'x-low', low: 'low', medium: 'med', high: 'high', xhigh: 'x-high', max: 'max' };

export const PROVIDER_LABEL = { ag: 'Antigravity', gemini: 'Gemini API', cmc: 'CommandCode', cc: 'Claude Code', ...Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, p.short])) };

// "ag/gemini-3.8-flash-high" -> { conn: 'router', provider: 'ag', base: 'gemini-3.8-flash', effort: 'high' }
// "anthropic:claude-opus-5-5-high" -> { conn: 'anthropic', provider: 'anthropic', base: 'claude-opus-5-5', effort: 'high' }
// Untuk koneksi selain router lama, `provider` = koneksi dan `base` tetap memuat awalan model
// milik endpoint itu (mis. OpenRouter "google/gemini-3-pro").
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

// Kunci grup (model tanpa effort) dalam bentuk referensi lengkap.
const groupKey = (p) => (p.conn !== 'router' ? `${p.conn}:${p.base}` : (p.provider ? p.provider + '/' : '') + p.base);

// Model yang effort-nya diatur lewat parameter native Claude Code (bukan ID varian router):
// provider cc/, atau ID claude-* tanpa provider. Model claude-* di provider lain (mis.
// ag/claude-opus-4-6-thinking) diteruskan apa adanya karena router-nya tidak mengenal effort.
// Koneksi Anthropic official: model claude-*. Koneksi OpenAI/ChatGPT: effort diteruskan ke Codex.
export const nativeEffortModel = (provider, base) =>
  provider === 'cc' || (provider === '' && base.startsWith('claude-')) || (connKind(provider) === 'anthropic' && base.startsWith('claude-')) || ['openai', 'chatgpt'].includes(connKind(provider));

// Effort native yang ditawarkan slider (semuanya diterima opsi `effort` Agent SDK).
const NATIVE_EFFORTS = ['low', 'medium', 'high', 'max'];

// Model ringan untuk subagen (Explore, general-purpose, Plan) dan tugas utilitas Claude Code
// (ringkasan WebFetch, dsb.). Hanya dua pilihan: Claude Haiku 5.5 atau Gemini 3.8 Flash.
// Model utama Claude (cc/ atau claude-* tanpa provider): Haiku dulu, lalu Flash.
// Model utama lain (ag/, gemini/, …): Flash dulu, lalu Haiku.
export const LIGHT_HAIKU = 'claude-haiku-5-5';
export const LIGHT_FLASH = 'gemini-3.8-flash';
// Varian Flash yang paling cocok untuk subagen: cukup berpikir, tetap cepat.
const FLASH_EFFORTS = ['low', null, 'minimal', 'extra-low', 'medium', 'high', 'xhigh', 'max'];

/**
 * @param {string} mainId model utama sesi
 * @param {string[] | null} [ids] ID model di router; null = belum diketahui (pakai tebakan default)
 * @returns {{ id: string, kind: 'haiku' | 'flash' | 'main' }} kind 'main' = keduanya tidak ada di router
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
    // Haiku native: effort diatur per subagen (opsi `agents`), jadi pakai ID polosnya.
    if (best) return { id: kind === 'haiku' ? resolveModelEffort(best.id).actualModel : best.id, kind };
  }
  return { id: resolveModelEffort(mainId).actualModel, kind: 'main' };
}

// Koneksi selain router lama: model ringan dari koneksi yang sama dan keluarga model yang sama
// (Claude → Haiku terbaru, Gemini → Flash terbaru, GPT → *-mini terbaru, DeepSeek → *-flash/-chat).
// Harness Codex mengatur subagennya sendiri, jadi koneksi OpenAI/ChatGPT memakai model utama.
const FAMILY = [
  { re: /claude/i, light: /claude-haiku/i, kind: /** @type {const} */ ('haiku') },
  { re: /gemini/i, light: /gemini-[\d.]+-flash(?!-lite|-image|-live|-tts)/i, kind: /** @type {const} */ ('flash') },
  { re: /deepseek/i, light: /deepseek-(v[\d.]+-)?(flash|chat)\b/i, kind: /** @type {const} */ ('flash') },
  { re: /glm/i, light: /glm-[\d.]+-(air|flash)/i, kind: /** @type {const} */ ('flash') },
];
// Versi terbaru dulu: "gemini-3.8-flash" > "gemini-3.5-flash" (bandingkan angka per segmen).
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
  // Gemini lewat proxy: effort ikut di ID (diterjemahkan jadi reasoning_effort), "low" cukup untuk subagen.
  return { id: joinRef(main.conn, kind === 'gemini' ? best + '-low' : best), kind: fam.kind };
}

// Untuk model Claude native, pisahkan ID asli router dengan virtual effort.
// Contoh: "cc/claude-opus-5-5-high" -> { actualModel: "cc/claude-opus-5-5", effort: "high" }.
export function resolveModelEffort(id) {
  if (!id) return { actualModel: '', effort: null };
  const p = parseModelId(id);
  if (nativeEffortModel(p.provider, p.base) && p.effort && (NATIVE_EFFORTS.includes(p.effort) || (p.conn !== 'router' && EFFORTS.includes(p.effort)))) {
    return { actualModel: groupKey(p), effort: p.effort };
  }
  return { actualModel: id, effort: null };
}

// list: [{ id, ctx?, vision?, reasoning?, efforts?, label?, engine? }] atau [string] (daemon versi lama).
// `efforts`: tingkat effort native model ini (koneksi selain router lama), jadi varian virtual.
export function groupModels(list) {
  const groups = new Map();
  for (const raw of list) {
    const m = typeof raw === 'string' ? { id: raw } : raw;
    // Model koneksi dengan daftar effort sendiri: ID-nya selalu polos (tanpa akhiran effort).
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
    // Model Claude native (cc/ atau claude-* tanpa provider):
    // 9router tidak membagi model Claude per ID varian karena Claude memakai
    // adaptive thinking & parameter effort native.
    if (g.conn === 'router' && nativeEffortModel(g.provider, g.name)) {
      for (const lev of NATIVE_EFFORTS) {
        if (!g.variants.some((v) => v.effort === lev)) {
          g.variants.push({ effort: lev, id: `${g.key}-${lev}`, virtual: true });
        }
      }
    }
    // Model polos tanpa akhiran = pengaturan bawaan router ("auto").
    g.auto = g.variants.find((v) => v.effort === null)?.id || null;
    g.levels = g.variants.filter((v) => v.effort).sort((a, b) => EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort));
    // Satu-satunya varian ber-effort tanpa versi polos -> bukan pilihan, cukup label tetap.
    g.fixed = !g.auto && g.levels.length === 1 ? g.levels[0].effort : null;
    g.slider = g.levels.length > 1 || (g.levels.length === 1 && !!g.auto);
  }
  return [...groups.values()];
}

export function findGroup(groups, id) {
  return groups.find((g) => g.variants.some((v) => v.id === id)) || null;
}

// Effort awal saat sebuah grup dipilih: pertahankan pilihan sekarang bila ada di grup,
// lalu medium, lalu auto, lalu tingkat tengah.
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

// Label ringkas: "gemini-3.8-flash · high", "gemini-3.8-flash · auto".
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
