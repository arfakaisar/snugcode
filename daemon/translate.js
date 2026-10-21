// Format translator for the loopback proxy: the Claude Agent SDK only speaks the Anthropic Messages API,
// while some endpoints (Gemini API, Groq, xAI, routers without /v1/messages) only have
// OpenAI Chat Completions. Requests are translated Anthropic -> OpenAI and the streamed reply
// OpenAI -> Anthropic SSE, one whole line at a time (see proxy.js).
//
// Endpoints with their own Anthropic format do NOT go through here (forwarded as-is): translation
// always loses something (explicit prompt caching, signed thinking blocks).
import { randomBytes } from 'node:crypto';

const EFFORT_SUFFIX = /-(minimal|low|medium|high)$/;
// An output limit that's safe for almost every OpenAI-compatible model (Claude Code asks for 32k–64k).
const MAX_OUT = 32_000;

// Gemini 3 requires the "thought signature" of function calls to be sent back in the history. The Anthropic
// format has no place for it, so it's kept in memory per tool call ID. If it's lost
// (daemon restart, old session), Gemini receives this official placeholder value.
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

// Gemini only accepts a subset of JSON Schema (OpenAPI 3); other keywords get the request rejected.
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
 * @param {{ kind?: string }} [opts] connection kind (gemini: tool schemas & thought signatures)
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
    // User message: tool results must come right after the assistant's tool_calls, then the user's text/images.
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

/** Non-stream /chat/completions reply -> Anthropic message. */
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
 * Stream translator OpenAI SSE -> Anthropic SSE. push(text) returns Anthropic SSE text.
 * Incoming text must already be whole lines (the proxy splits it per line).
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
        // Arguments for a tool whose block is already closed (rare): ignore so the block order stays valid.
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

// HTTP status -> Anthropic error type (Claude Code retries 429/5xx/529).
export function anthropicError(status, message) {
  const type = status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status === 529 || status === 503 ? 'overloaded_error' : 'api_error';
  return { type: 'error', error: { type, message } };
}

// count_tokens doesn't exist in OpenAI: a rough estimate (~4 characters per token) is enough for Claude Code.
export const estimateTokens = (body) => ({ input_tokens: Math.ceil(JSON.stringify(body?.messages || []).length / 4 + JSON.stringify(body?.system || '').length / 4 + JSON.stringify(body?.tools || []).length / 4) });
