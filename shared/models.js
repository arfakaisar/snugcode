// Pengelompokan model 9router: varian effort yang dipisah per ID
// (mis. ag/gemini-3.8-flash-low / -medium / -high) digabung jadi satu model
// dengan tingkat effort. 9router tidak menerima parameter effort
// (thinkingEffortSupported=false), jadi effort = memilih ID varian.

// Urutan dari paling hemat ke paling dalam berpikir.
export const EFFORTS = ['minimal', 'extra-low', 'low', 'medium', 'high', 'xhigh', 'max'];
// Non-greedy agar "-extra-low" terbaca utuh, bukan "-extra" + "low".
const EFFORT_RE = new RegExp(`^(.+?)-(${EFFORTS.join('|')})$`);

export const EFFORT_LABEL = { minimal: 'minimal', 'extra-low': 'x-low', low: 'low', medium: 'med', high: 'high', xhigh: 'x-high', max: 'max' };

export const PROVIDER_LABEL = { ag: 'Antigravity', gemini: 'Gemini API', cmc: 'CommandCode', cc: 'Claude Code' };

// "ag/gemini-3.8-flash-high" -> { provider: 'ag', base: 'gemini-3.8-flash', effort: 'high' }
export function parseModelId(id) {
  const slash = id.indexOf('/');
  const provider = slash > 0 ? id.slice(0, slash) : '';
  const rest = slash > 0 ? id.slice(slash + 1) : id;
  const m = rest.match(EFFORT_RE);
  return m ? { provider, base: m[1], effort: m[2] } : { provider, base: rest, effort: null };
}

// list: [{ id, ctx?, vision?, reasoning? }] atau [string] (daemon versi lama).
export function groupModels(list) {
  const groups = new Map();
  for (const raw of list) {
    const m = typeof raw === 'string' ? { id: raw } : raw;
    const p = parseModelId(m.id);
    const key = (p.provider ? p.provider + '/' : '') + p.base;
    let g = groups.get(key);
    if (!g) {
      g = { key, provider: p.provider, name: p.base, variants: [], ctx: m.ctx, vision: m.vision, reasoning: m.reasoning };
      groups.set(key, g);
    }
    g.variants.push({ effort: p.effort, id: m.id });
  }
  for (const g of groups.values()) {
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
  return (provider && p.provider ? p.provider + '/' : '') + p.base + (p.effort ? ' · ' + (EFFORT_LABEL[p.effort] || p.effort) : '');
}

export function ctxLabel(n) {
  if (!n) return '';
  return n >= 1e6 ? Math.round(n / 1e5) / 10 + 'M' : Math.round(n / 1000) + 'K';
}
