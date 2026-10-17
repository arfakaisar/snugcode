// Penerjemah format untuk loopback proxy: Claude Agent SDK hanya bicara Anthropic Messages API,
// sedangkan sebagian endpoint (Gemini API, Groq, xAI, router tanpa /v1/messages) hanya punya
// OpenAI Chat Completions. Request diterjemahkan Anthropic -> OpenAI dan stream jawabannya
// OpenAI -> Anthropic SSE, per baris utuh (lihat proxy.js).
//
// Endpoint yang punya format Anthropic sendiri TIDAK lewat sini (diteruskan apa adanya): penerjemahan
// selalu kehilangan sesuatu (cache prompt eksplisit, blok thinking bertanda tangan).
import { randomBytes } from 'node:crypto';

const EFFORT_SUFFIX = /-(minimal|low|medium|high)$/;
// Batas output yang aman untuk hampir semua model OpenAI-compatible (Claude Code meminta 32k–64k).
const MAX_OUT = 32_000;

// Gemini 3 mewajibkan "thought signature" dari function call dikirim balik di riwayat. Format
// Anthropic tidak punya tempat untuknya, jadi disimpan di memori per ID tool call. Bila hilang
// (daemon restart, sesi lama), Gemini menerima nilai pengganti resmi ini.
const signatures = new Map();
const MAX_SIGS = 5000;
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';
function rememberSig(id, sig) {
  if (!id || !sig) return;
  signatures.set(id, sig);
  if (signatures.size > MAX_SIGS) signatures.delete(signatures.keys().next().value);
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
const imagePart = (b) => (b?.source?.type === 'base64' ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } } : b?.source?.type === 'url' ? { type: 'image_url', image_url: { url: b.source.url } } : null);

// Gemini hanya menerima subset JSON Schema (OpenAPI 3); kata kunci lain membuat request ditolak.
const GEMINI_SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable', 'anyOf', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'title', 'default']);
export function geminiSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    else if (k === 'type' && Array.isArray(v)) {
      // ["string","null"] -> string + nullable
      const t = v.filter((x) => x !== 'null');
      out.type = t[0] || 'string';
      if (v.includes('null')) out.nullable = true;
    } else out[k] = typeof v === 'object' ? geminiSchema(v) : v;
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

/**
 * Body /v1/messages -> body /chat/completions.
 * @param {any} a body Anthropic
 * @param {{ kind?: string }} [opts] kind koneksi (gemini: skema tool & thought signature)
 */
export function anthropicToOpenAI(a, { kind } = {}) {
  const gemini = kind === 'gemini';
  let model = String(a.model || '');
  let effort = null;
  const m = model.match(EFFORT_SUFFIX);
  if (m) {
    effort = m[1];
    model = model.slice(0, -m[0].length);
  }
  /** @type {any[]} */
  const messages = [];
  const sys = textOf(a.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const msg of a.messages || []) {
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];
    if (msg.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const sig = signatures.get(b.id) || (gemini ? GEMINI_SKIP_SIGNATURE : null);
          return { id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }, ...(gemini && sig ? { extra_content: { google: { thought_signature: sig } } } : {}) };
        });
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Pesan user: hasil tool harus langsung setelah tool_calls asisten, baru teks/gambar user.
    const extraImages = [];
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '') }];
      const t = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      for (const p of parts) if (p.type === 'image') extraImages.push(imagePart(p));
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? '[error] ' : '') + (t || (extraImages.length ? '(image attached below)' : '(no output)')) });
    }
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') parts.push(imagePart(b));
    }
    parts.push(...extraImages);
    /** @type {any[]} */
    const clean = parts.filter(Boolean);
    if (clean.length) messages.push({ role: 'user', content: clean.every((p) => p.type === 'text') ? clean.map((p) => p.text).join('\n') : clean });
  }
  const tools = (a.tools || [])
    .filter((t) => t && t.name && t.input_schema)
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: gemini ? geminiSchema(t.input_schema) : t.input_schema } }));
  /** @type {any} */
  const o = { model, messages, stream: !!a.stream, max_tokens: Math.min(+a.max_tokens || 8192, MAX_OUT) };
  if (a.stream) o.stream_options = { include_usage: true };
  if (tools.length) o.tools = tools;
  const tc = a.tool_choice;
  if (tc && tools.length) o.tool_choice = tc.type === 'any' ? 'required' : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } } : tc.type === 'none' ? 'none' : 'auto';
  if (a.temperature != null) o.temperature = a.temperature;
  if (a.top_p != null) o.top_p = a.top_p;
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length) o.stop = a.stop_sequences.slice(0, 4);
  if (effort) o.reasoning_effort = effort;
  return o;
}

const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

function usageOf(u) {
  if (!u) return null;
  const cached = u.prompt_tokens_details?.cached_tokens || u.cached_tokens || 0;
  return { input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached), output_tokens: u.completion_tokens || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

const sigOf = (tc) => tc?.extra_content?.google?.thought_signature || tc?.thought_signature || null;

/** Jawaban /chat/completions non-stream -> pesan Anthropic. */
export function openAIToAnthropic(j, model) {
  const ch = j.choices?.[0] || {};
  const msg = ch.message || {};
  const content = [];
  if (msg.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content, signature: '' });
  if (msg.content) content.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : textOf(msg.content) });
  for (const tc of msg.tool_calls || []) {
    const id = tc.id || 'toolu_' + randomBytes(8).toString('hex');
    rememberSig(id, sigOf(tc));
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || '{}');
    } catch {}
    content.push({ type: 'tool_use', id, name: tc.function?.name, input });
  }
  return { id: j.id || 'msg_' + randomBytes(8).toString('hex'), type: 'message', role: 'assistant', model, content, stop_reason: STOP[ch.finish_reason] || 'end_turn', stop_sequence: null, usage: usageOf(j.usage) || { input_tokens: 0, output_tokens: 0 } };
}

/**
 * Penerjemah stream SSE OpenAI -> SSE Anthropic. push(teks) mengembalikan teks SSE Anthropic.
 * Teks masuk harus sudah per baris utuh (proxy memecahnya per baris).
 */
export function createStreamTranslator(model) {
  let started = false;
  let index = -1;
  let open = null; // 'text' | 'thinking' | { tool: i }
  const tools = new Map(); // index tool OpenAI -> { block, id }
  let stop = null;
  let usage = null;
  let done = false;
  let buf = '';
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const start = () => {
    if (started) return '';
    started = true;
    return ev('message_start', { message: { id: 'msg_' + randomBytes(10).toString('hex'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const close = () => {
    if (open === null) return '';
    const out = ev('content_block_stop', { index });
    open = null;
    return out;
  };
  const openBlock = (kind, block) => {
    let out = close();
    index++;
    open = kind;
    out += ev('content_block_start', { index, content_block: block });
    return out;
  };
  const finish = () => {
    if (done) return '';
    done = true;
    let out = start() + close();
    out += ev('message_delta', { delta: { stop_reason: stop || 'end_turn', stop_sequence: null }, usage: usage || { output_tokens: 0 } });
    out += ev('message_stop', {});
    return out;
  };
  const onChunk = (j) => {
    let out = start();
    if (j.error) {
      done = true;
      return out + ev('error', { error: { type: 'api_error', message: String(j.error.message || j.error) } });
    }
    if (j.usage) usage = usageOf(j.usage);
    const ch = j.choices?.[0];
    if (!ch) return out;
    const d = ch.delta || {};
    const reasoning = d.reasoning_content || d.reasoning;
    if (typeof reasoning === 'string' && reasoning) {
      if (open !== 'thinking') out += openBlock('thinking', { type: 'thinking', thinking: '' });
      out += ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: reasoning } });
    }
    if (typeof d.content === 'string' && d.content) {
      if (open !== 'text') out += openBlock('text', { type: 'text', text: '' });
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: d.content } });
    }
    for (const tc of d.tool_calls || []) {
      const ti = tc.index ?? tools.size;
      let t = tools.get(ti);
      if (!t) {
        const id = tc.id || 'toolu_' + randomBytes(8).toString('hex');
        out += openBlock({ tool: ti }, { type: 'tool_use', id, name: tc.function?.name || '', input: {} });
        t = { block: index, id };
        tools.set(ti, t);
      } else if (typeof open !== 'object' || open?.tool !== ti) {
        // Argumen untuk tool yang bloknya sudah ditutup (jarang): abaikan agar urutan blok tetap sah.
        continue;
      }
      rememberSig(t.id, sigOf(tc));
      const args = tc.function?.arguments;
      if (args) out += ev('content_block_delta', { index: t.block, delta: { type: 'input_json_delta', partial_json: args } });
    }
    if (ch.finish_reason) stop = STOP[ch.finish_reason] || 'end_turn';
    return out;
  };
  return {
    push(text) {
      buf += text;
      let out = '';
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:') || done) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          out += finish();
          continue;
        }
        try {
          out += onChunk(JSON.parse(data));
        } catch {}
      }
      return out;
    },
    end() {
      const rest = buf.trim() ? this.push('\n') : '';
      return rest + finish();
    },
  };
}

// Status HTTP -> tipe error Anthropic (Claude Code mencoba ulang 429/5xx/529).
export function anthropicError(status, message) {
  const type = status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status === 529 || status === 503 ? 'overloaded_error' : 'api_error';
  return { type: 'error', error: { type, message } };
}

// count_tokens tidak ada di OpenAI: perkiraan kasar (±4 karakter per token) cukup untuk Claude Code.
export const estimateTokens = (body) => ({ input_tokens: Math.ceil(JSON.stringify(body?.messages || []).length / 4 + JSON.stringify(body?.system || '').length / 4 + JSON.stringify(body?.tools || []).length / 4) });
