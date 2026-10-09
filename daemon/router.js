// Akses 9router: daftar model (dengan cache) dan uji cepat sebuah model.
import { resolveModelEffort } from '../shared/models.js';

const TTL = 5 * 60 * 1000;
let cache = null;
let refreshing = null;

const base = (cfg) => cfg.routerUrl.replace(/\/+$/, '');

export async function listModels(cfg, key, { fresh = false } = {}) {
  if (!fresh && cache && cache.url === cfg.routerUrl && Date.now() - cache.at < TTL) return cache.list;
  const r = await fetch(base(cfg) + '/models', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('9router: ' + r.status);
  const j = await r.json();
  const list = j.data
    .filter((m) => m.capabilities?.tools !== false) // agen butuh tool calling
    .map((m) => ({
      id: m.id,
      ctx: m.context_length || m.capabilities?.contextWindow,
      vision: !!m.capabilities?.vision,
      reasoning: !!m.capabilities?.reasoning,
    }));
  cache = { url: cfg.routerUrl, at: Date.now(), list };
  return list;
}

// ID model terakhir yang diketahui (boleh basi) tanpa menunggu jaringan: dipakai saat memilih
// model ringan subagen, supaya prompt tidak tertahan request /models. Cache yang basi atau
// kosong disegarkan di latar belakang. null = belum pernah berhasil diambil.
/** @returns {string[] | null} */
export function knownModelIds(cfg, key) {
  const fresh = cache && cache.url === cfg.routerUrl && Date.now() - cache.at < TTL;
  if (!fresh && key && !refreshing) refreshing = listModels(cfg, key, { fresh: true }).catch(() => {}).finally(() => (refreshing = null));
  return cache && cache.url === cfg.routerUrl ? cache.list.map((m) => m.id) : null;
}

// Beberapa model yang sudah dihentikan tetap membalas "sukses" dengan teks
// seperti "Gemini 3.5 Flash is no longer available…", bukan error HTTP.
const DEAD_RE = /\b(no longer available|is not available|has been (deprecated|discontinued|removed)|please switch to)\b/i;

// Kirim satu pesan kecil lewat endpoint Anthropic (jalur yang sama dengan Claude Code).
export async function probeModel(cfg, key, model) {
  const { actualModel } = resolveModelEffort(model);
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(base(cfg) + '/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: actualModel, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.name === 'TimeoutError' ? 'timeout 45 detik' : e.message };
  }
  const raw = await r.text();
  if (!r.ok) return { ok: false, ms: Date.now() - t0, err: cleanErr(raw) || 'HTTP ' + r.status };
  let text = '';
  let err = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let e;
    try {
      e = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (e.type === 'error') err = e.error?.message || 'error';
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') text += e.delta.text;
  }
  // Respons non-stream (beberapa provider mengabaikan stream:true).
  if (!text && !err && raw.trim().startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    } catch {}
  }
  const ms = Date.now() - t0;
  text = text.trim();
  if (err) return { ok: false, ms, err: cleanErr(err) };
  if (DEAD_RE.test(text)) return { ok: false, ms, err: 'Model tidak tersedia lagi: ' + text.slice(0, 160) };
  if (!text) return { ok: false, ms, err: 'Balasan kosong' };
  return { ok: true, ms, text: text.slice(0, 80) };
}

function cleanErr(s) {
  const m = String(s).match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return (m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : String(s)).replace(/\s+/g, ' ').trim().slice(0, 200);
}
