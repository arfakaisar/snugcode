// Multi-provider connection tests: API key detection, engine routing, format translator, multi-route proxy,
// and Codex engine helpers. No real APIs are called (fetch & upstream are faked).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Temporary data folder: the Codex helper writes CODEX_HOME inside it.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-prov-'));
process.env.SNUGCODE_HOME = TMP_HOME;
process.on('exit', () => fs.rmSync(TMP_HOME, { recursive: true, force: true }));

const P = await import('../shared/providers.js');
const M = await import('../shared/models.js');
const D = await import('../daemon/providers.js');
const T = await import('../daemon/translate.js');

// Fake fetch: routes = { 'METHOD url-prefix': (body, headers) => [status, json] }
function fakeFetch(routes, log = []) {
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push({ method, url, headers: init.headers, body });
    const hit = Object.entries(routes).find(([k]) => {
      const [m, u] = k.split(' ');
      return m === method && url.startsWith(u);
    });
    const [status, json] = hit ? hit[1](body, init.headers || {}) : [404, { error: { message: 'not found' } }];
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
}

test('key detection: provider patterns, forbidden keys, and ambiguous candidates', () => {
  assert.deepEqual(P.keyCandidates('sk-ant-api03-' + 'a'.repeat(40)), ['anthropic']);
  assert.deepEqual(P.keyCandidates('AIza' + 'b'.repeat(35)), ['gemini']);
  assert.deepEqual(P.keyCandidates('sk-or-v1-' + 'c'.repeat(64)), ['openrouter']);
  assert.deepEqual(P.keyCandidates('sk-proj-' + 'd'.repeat(40)), ['openai']);
  assert.deepEqual(P.keyCandidates('sk-' + 'e'.repeat(32)), ['deepseek']);
  assert.deepEqual(P.keyCandidates('0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp'), ['zai']);
  assert.deepEqual(P.keyCandidates('sk-' + 'A1'.repeat(24)), ['openai', 'moonshot', 'deepseek']);
  assert.deepEqual(P.keyCandidates('random-router-key'), []);
  assert.ok(P.REJECTED_KEYS.some((r) => r.re.test('sk-ant-oat01-xyz')), 'Claude subscription token rejected');
});

test('detectConnection: official Anthropic -> Anthropic format, connection-prefixed models, native effort', async () => {
  const log = [];
  const f = fakeFetch({ 'GET https://api.anthropic.com/v1/models': () => [200, { data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }] }] }, log);
  const c = await D.detectConnection({ key: 'sk-ant-api03-' + 'a'.repeat(40) }, { fetchImpl: f });
  assert.equal(c.kind, 'anthropic');
  assert.deepEqual(c.formats, { anthropic: true, openai: false, responses: false });
  assert.equal(log[0].headers['x-api-key'], 'sk-ant-api03-' + 'a'.repeat(40));
  assert.equal(log[0].headers.authorization, undefined);
  assert.deepEqual(c.models.map((m) => m.id), ['anthropic:claude-opus-5-5', 'anthropic:claude-haiku-5-5']);
  assert.deepEqual(c.models[0].efforts, ['low', 'medium', 'high', 'max']);
  assert.equal(c.models[0].engine, 'claude');
  await assert.rejects(D.detectConnection({ key: 'sk-ant-oat01-abc' }), /Claude subscription/);
});

test('detectConnection: an ambiguous key is tested against several providers, the one that answers wins', async () => {
  const key = 'sk-' + 'A1'.repeat(24);
  const f = fakeFetch({
    'GET https://api.openai.com/v1/models': () => [401, { error: { message: 'bad key' } }],
    'GET https://api.deepseek.com/models': () => [401, { error: { message: 'bad key' } }],
    'GET https://api.moonshot.ai/v1/models': () => [200, { data: [{ id: 'kimi-k3' }] }],
    'POST https://api.moonshot.ai/anthropic/v1/messages': () => [400, { error: { message: 'bad request' } }],
  });
  const c = await D.detectConnection({ key }, { fetchImpl: f });
  assert.equal(c.kind, 'moonshot');
  assert.equal(c.formats.anthropic, true, 'Kimi\'s Anthropic endpoint detected (400 = exists)');
  assert.deepEqual(c.models.map((m) => m.id), ['moonshot:kimi-k3']);
  // All reject: a clear 401 message.
  const no = fakeFetch({ 'GET https': () => [401, { error: { message: 'x' } }] });
  await assert.rejects(D.detectConnection({ key }, { fetchImpl: no }), /401/);
});

test('detectConnection: custom endpoint -> format detected without calling a model', async () => {
  const log = [];
  const f = fakeFetch(
    {
      'POST http://r.local/v1/messages': () => [404, {}],
      'POST http://r.local/v1/chat/completions': () => [400, { error: { message: 'messages required' } }],
      'POST http://r.local/v1/responses': () => [404, {}],
      'GET http://r.local/v1/models': () => [200, { data: [{ id: 'cc/claude-x' }, { id: 'no-tools', capabilities: { tools: false } }] }],
    },
    log,
  );
  const c = await D.detectConnection({ key: 'rk-1', url: 'http://r.local/v1/' }, { fetchImpl: f });
  assert.equal(c.kind, 'router');
  assert.deepEqual(c.formats, { anthropic: false, openai: true, responses: false });
  assert.deepEqual(c.models.map((m) => m.id), ['cc/claude-x'], 'models without tool calling dropped; router connection = no prefix');
  assert.ok(log.filter((l) => l.method === 'POST').every((l) => JSON.stringify(l.body) === '{}'), 'format probes use no model tokens');
  await assert.rejects(D.detectConnection({ key: 'x', url: 'http://r.local' }, { fetchImpl: fakeFetch({}) }), /can't be reached/);
});

test('detectConnection: Gemini & OpenAI -> non-chat models dropped', async () => {
  const g = await D.detectConnection({ key: 'AIza' + 'b'.repeat(35) }, { fetchImpl: fakeFetch({ 'GET https://generativelanguage.googleapis.com/v1beta/openai/models': () => [200, { data: [{ id: 'models/gemini-3.8-pro' }, { id: 'models/gemini-3.8-flash' }, { id: 'models/text-embedding-005' }, { id: 'models/imagen-4' }] }] }) });
  assert.deepEqual(g.models.map((m) => m.id), ['gemini:gemini-3.8-pro', 'gemini:gemini-3.8-flash']);
  assert.equal(g.models[0].engine, 'gemini', 'Gemini models use the Gemini CLI harness');
  const o = await D.detectConnection({ key: 'sk-proj-' + 'd'.repeat(40) }, { fetchImpl: fakeFetch({ 'GET https://api.openai.com/v1/models': () => [200, { data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-codex' }, { id: 'text-embedding-3-large' }, { id: 'gpt-realtime' }, { id: 'dall-e-3' }] }] }) });
  assert.deepEqual(o.models.map((m) => m.id), ['openai:gpt-5.5', 'openai:gpt-5.5-codex']);
  assert.equal(o.models[0].engine, 'codex', 'GPT models use the Codex harness');
});

test('engineFor & resolveRoute: the best-fitting harness per connection and model', () => {
  const E = (formats, kind = 'router') => (id) => P.engineFor({ kind, formats }, id);
  assert.deepEqual(E({}, 'chatgpt')('gpt-5.5'), { engine: 'codex', wire: 'chatgpt' });
  assert.deepEqual(E({ responses: true, openai: true }, 'openai')('gpt-5.5'), { engine: 'codex', wire: 'responses' });
  assert.deepEqual(E({ anthropic: true, openai: true, responses: true })('cx/gpt-5.5-codex'), { engine: 'codex', wire: 'responses' });
  assert.deepEqual(E({ anthropic: true, openai: true, responses: true })('cc/claude-opus-5-5'), { engine: 'claude', wire: 'anthropic' });
  assert.deepEqual(E({ openai: true }, 'gemini')('gemini-3.8-pro'), { engine: 'gemini', wire: 'gemini' });
  // Gemini models via a router (OpenAI/Anthropic format only) stay on the Claude Agent SDK.
  assert.deepEqual(E({ openai: true })('gemini-3.8-pro'), { engine: 'claude', wire: 'openai' });
  assert.equal(E({})('x'), null);

  const sec = { connections: { anthropic: { kind: 'anthropic', key: 'k', anthropic: 'https://api.anthropic.com', formats: { anthropic: true } }, gemini: { kind: 'gemini', key: 'g', openai: 'https://g/v1', formats: { openai: true } } } };
  const r = D.resolveRoute(sec, 'anthropic:claude-opus-5-5-high');
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.effort, 'high');
  assert.equal(r.engine, 'claude');
  // Gemini: effort stays in the ID (Gemini CLI uses the real ID, the proxy translator uses reasoning_effort).
  assert.equal(D.resolveRoute(sec, 'gemini:gemini-3.8-pro-high').model, 'gemini-3.8-pro-high');
  assert.equal(D.resolveRoute(sec, 'gemini:gemini-3.8-pro').engine, 'gemini');
  assert.equal(D.geminiRoot(sec.connections.gemini), 'https://g/v1');
  assert.equal(D.geminiRoot({ openai: 'https://generativelanguage.googleapis.com/v1beta/openai/' }), 'https://generativelanguage.googleapis.com');
  process.env.SNUGCODE_ENGINE = 'claude';
  try {
    assert.deepEqual(D.resolveRoute(sec, 'gemini:gemini-3.8-pro').wire, 'openai', 'SNUGCODE_ENGINE=claude forces the Claude Agent SDK');
  } finally {
    delete process.env.SNUGCODE_ENGINE;
  }
  assert.throws(() => D.resolveRoute(sec, 'openai:gpt-5.5'), /was removed/);
  assert.throws(() => D.resolveRoute({}, 'cc/claude-opus-5-5'), /Models & API keys/);
});

test('connections: legacy router migrated, unique ID per router, summary without the key', () => {
  const cfg = { routerUrl: 'https://router.gemz.space/v1' };
  const sec = { routerKey: 'rk-old' };
  assert.ok(D.migrateLegacy(cfg, sec));
  assert.equal(sec.connections.router.label, '9router');
  assert.equal(sec.connections.router.anthropic, 'https://router.gemz.space');
  assert.ok(!D.migrateLegacy(cfg, sec), 'only once');
  assert.equal(D.putConnection(sec, { kind: 'router', key: 'k2', openai: 'http://other/v1', formats: {} }), 'router2');
  assert.equal(D.putConnection(sec, { kind: 'router', key: 'k3', openai: 'http://other/v1', formats: {} }), 'router2', 'the same endpoint is replaced');
  assert.equal(D.putConnection(sec, { kind: 'anthropic', key: 'a', formats: {} }), 'anthropic');
  assert.equal(sec.connections.router.legacy, true);
  const s = D.connSummary({ id: 'anthropic', ...sec.connections.anthropic, key: 'sk-ant-api03-abcdefghijklmnop1234' });
  assert.ok(!JSON.stringify(s).includes('abcdefghijklmnop'), 'the key is never sent whole');
  delete sec.connections.router;
  D.mirrorLegacy(cfg, sec);
  assert.equal(sec.routerKey, undefined);
});

test('models: connection references, virtual effort, light model per connection', () => {
  assert.deepEqual(M.resolveModelEffort('chatgpt:gpt-5.5-xhigh'), { actualModel: 'chatgpt:gpt-5.5', effort: 'xhigh' });
  assert.deepEqual(M.resolveModelEffort('deepseek:deepseek-v4-pro'), { actualModel: 'deepseek:deepseek-v4-pro', effort: null });
  const [g] = M.groupModels([{ id: 'anthropic:claude-opus-5-5', efforts: ['low', 'high'], label: 'Claude API', engine: 'claude' }]);
  assert.equal(g.conn, 'anthropic');
  assert.equal(g.label, 'Claude API');
  assert.deepEqual(g.levels.map((l) => l.id), ['anthropic:claude-opus-5-5-low', 'anthropic:claude-opus-5-5-high']);
  assert.equal(g.auto, 'anthropic:claude-opus-5-5');
  assert.deepEqual(M.lightModel('anthropic:claude-opus-5-5-high', ['anthropic:claude-opus-5-5', 'anthropic:claude-haiku-4-5', 'anthropic:claude-haiku-5-5']), { id: 'anthropic:claude-haiku-5-5', kind: 'haiku' });
  assert.deepEqual(M.lightModel('gemini:gemini-3.8-pro', ['gemini:gemini-3.5-flash', 'gemini:gemini-3.8-flash', 'gemini:gemini-3.8-flash-lite']), { id: 'gemini:gemini-3.8-flash-low', kind: 'flash' });
  assert.deepEqual(M.lightModel('openrouter:anthropic/claude-sonnet-5-5', ['openrouter:anthropic/claude-haiku-5-5', 'gemini:x']), { id: 'openrouter:anthropic/claude-haiku-5-5', kind: 'haiku' });
  assert.equal(M.lightModel('chatgpt:gpt-5.5', null).kind, 'main', 'Codex manages its own subagents');
  assert.equal(M.modelLabel('anthropic:claude-opus-5-5-high', { provider: true }), 'Claude API · claude-opus-5-5 · high');
  // The legacy router is unchanged.
  assert.equal(P.splitRef('cc/claude-opus-5-5').conn, 'router');
  assert.equal(P.splitRef('llama3:8b').conn, 'router', 'a colon in a model ID is not a connection prefix');
});

test('translate: Anthropic -> OpenAI (system, tools, tool results, images, effort, Gemini)', () => {
  const a = {
    model: 'gemini-3.8-pro-high',
    max_tokens: 64000,
    stream: true,
    system: [{ type: 'text', text: 'You are X' }],
    tools: [{ name: 'Read', description: 'read', input_schema: { $schema: 'x', type: 'object', additionalProperties: false, properties: { file_path: { type: ['string', 'null'], exclusiveMinimum: 1 } }, required: ['file_path'] } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read a' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'contents of a' }] }, { type: 'text', text: 'continue' }] },
    ],
  };
  const o = T.anthropicToOpenAI(a, { kind: 'gemini' });
  assert.equal(o.model, 'gemini-3.8-pro');
  assert.equal(o.reasoning_effort, 'high');
  assert.equal(o.max_tokens, 32000);
  assert.deepEqual(o.stream_options, { include_usage: true });
  assert.deepEqual(o.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.equal(o.messages[1].content[1].image_url.url, 'data:image/png;base64,AAA');
  assert.equal(o.messages[2].tool_calls[0].function.arguments, '{"file_path":"a"}');
  assert.equal(o.messages[2].tool_calls[0].extra_content.google.thought_signature, T.GEMINI_SKIP_SIGNATURE, 'Gemini 3: placeholder signature when unknown');
  assert.equal(o.messages[3].tool_call_id, 'call_1');
  assert.equal(o.messages[3].content, 'contents of a');
  const params = o.tools[0].function.parameters;
  assert.equal(params.$schema, undefined);
  assert.equal(params.additionalProperties, undefined);
  assert.deepEqual(params.properties.file_path, { type: 'string', nullable: true });
  // Non-Gemini: schema as-is, no signature.
  const o2 = T.anthropicToOpenAI({ ...a, model: 'x' }, { kind: 'groq' });
  assert.equal(o2.tools[0].function.parameters.$schema, 'x');
  assert.equal(o2.messages[2].tool_calls[0].extra_content, undefined);
  assert.equal(o2.reasoning_effort, undefined);
});

// Anthropic SSE -> list of events { type, ... }
const parseSse = (text) => text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));

test('translate: OpenAI stream -> Anthropic SSE (text, reasoning, split tool calls, usage, signature)', () => {
  const tr = T.createStreamTranslator('m1');
  const chunks = [
    { choices: [{ delta: { reasoning_content: 'thinking' } }] },
    { choices: [{ delta: { content: 'Hal' } }] },
    { choices: [{ delta: { content: 'o' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'Bash', arguments: '{"comm' }, extra_content: { google: { thought_signature: 'SIG9' } } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } },
  ];
  // A line split in the middle: the translator reassembles it.
  const raw = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  const out = tr.push(raw.slice(0, 50)) + tr.push(raw.slice(50)) + tr.end();
  const ev = parseSse(out);
  assert.equal(ev[0].type, 'message_start');
  assert.deepEqual(ev.filter((e) => e.type === 'content_block_start').map((e) => e.content_block.type), ['thinking', 'text', 'tool_use']);
  assert.equal(ev.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join(''), 'Halo');
  assert.equal(ev.filter((e) => e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join(''), '{"command":"ls"}');
  const md = ev.find((e) => e.type === 'message_delta');
  assert.equal(md.delta.stop_reason, 'tool_use');
  assert.deepEqual(md.usage, { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 });
  assert.equal(ev.at(-1).type, 'message_stop');
  assert.equal(ev.filter((e) => e.type === 'message_stop').length, 1, '[DONE] + end don\'t duplicate the closing event');
  // The signature is remembered and sent back in the next history.
  const next = T.anthropicToOpenAI({ model: 'g', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_9', name: 'Bash', input: { command: 'ls' } }] }] }, { kind: 'gemini' });
  assert.equal(next.messages[0].tool_calls[0].extra_content.google.thought_signature, 'SIG9');
});

async function upstream(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

test('proxy: OpenAI-only routes are translated, the real key is injected, errors are Anthropic-formatted', async () => {
  const { startProxy } = await import('../daemon/proxy.js');
  let seen = null;
  const up = await upstream((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) };
      if (seen.body.model === 'bad') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify([{ error: { message: 'quota exhausted' } }]));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hai' } }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  const p = startProxy();
  const token = p.register({ wire: 'openai', base: () => up.url + '/v1', auth: () => ({ authorization: 'Bearer REAL-KEY' }), kind: 'groq' });
  try {
    const base = await p.ready();
    const r = await fetch(base + '/v1/messages?beta=true', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    const ev = parseSse(await r.text());
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.auth, 'Bearer REAL-KEY');
    assert.equal(seen.body.messages[0].content, 'hi');
    assert.equal(ev.find((e) => e.delta?.type === 'text_delta').delta.text, 'hai');
    assert.equal(ev.find((e) => e.type === 'message_delta').delta.stop_reason, 'end_turn');
    const bad = await fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ model: 'bad', messages: [] }) });
    assert.equal(bad.status, 429);
    assert.deepEqual(await bad.json(), { type: 'error', error: { type: 'rate_limit_error', message: 'quota exhausted' } });
    const ct = await fetch(base + '/v1/messages/count_tokens', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(400) }] }) });
    assert.ok((await ct.json()).input_tokens >= 100);
    assert.equal((await fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer REAL-KEY' }, body: '{}' })).status, 401, 'the real key is not valid at the proxy');
  } finally {
    p.close();
    up.srv.close();
  }
});

test('proxy: official Anthropic & Responses (Codex) routes forwarded as-is with per-connection auth', async () => {
  const { startProxy } = await import('../daemon/proxy.js');
  const seen = [];
  const up = await upstream((req, res) => {
    seen.push({ url: req.url, h: req.headers });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"x","name":"Bash_ide"}\n\n');
  });
  const p = startProxy();
  const ta = p.register({ wire: 'anthropic', base: () => up.url, auth: () => ({ 'x-api-key': 'sk-ant-REAL', 'anthropic-version': '2023-06-01' }), kind: 'anthropic' });
  const tr = p.register({ wire: 'responses', base: () => up.url + '/v1', auth: () => ({ authorization: 'Bearer sk-proj-REAL' }), kind: 'openai' });
  try {
    const base = await p.ready();
    const a = await (await fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + ta, 'user-agent': 'claude-cli/1' }, body: '{}' })).text();
    assert.equal(seen[0].url, '/v1/messages');
    assert.equal(seen[0].h['x-api-key'], 'sk-ant-REAL');
    assert.equal(seen[0].h.authorization, undefined);
    assert.equal(seen[0].h['user-agent'], 'claude-cli/1', 'not a router: SDK headers unchanged');
    assert.ok(a.includes('Bash_ide'), 'not a router: not rewritten');
    await (await fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer ' + tr }, body: '{}' })).text();
    assert.equal(seen[1].url, '/v1/responses');
    assert.equal(seen[1].h.authorization, 'Bearer sk-proj-REAL');
  } finally {
    p.close();
    up.srv.close();
  }
});

test('codex: commands unwrapped from the shell, read-only actions, "Always" rules, the sandbox denies the data folder', async () => {
  const X = await import('../daemon/codex.js');
  const { ruleMatches } = await import('../daemon/sessions.js');
  const { HOME } = await import('../daemon/config.js');
  assert.equal(X.unwrapCommand("/bin/bash -lc 'npm test'"), 'npm test');
  assert.equal(X.unwrapCommand("bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
  assert.equal(X.unwrapCommand('ls -la'), 'ls -la');
  assert.ok(X.readOnlyActions([{ type: 'read' }, { type: 'search' }]));
  assert.ok(!X.readOnlyActions([{ type: 'read' }, { type: 'unknown' }]));
  assert.ok(!X.readOnlyActions([]));
  assert.ok(ruleMatches('Bash(npm test *)', 'npm test -- --watch=false'));
  assert.ok(ruleMatches('Bash(npm test:*)', 'npm test'));
  assert.ok(!ruleMatches('Bash(npm test *)', 'npm test && rm -rf /'), 'chained commands don\'t pass');
  assert.ok(!ruleMatches('Bash(npm test *)', 'npm testx'));
  const args = X.codexArgs({ provider: { baseUrl: 'http://127.0.0.1:1/v1', envKey: 'T' }, mcp: { command: 'node', args: ['b.js'], env: { A: '1' } } }).join(' ');
  assert.match(args, /default_permissions="snugcode"/);
  for (const p of X.deniedPaths()) assert.ok(args.includes(JSON.stringify(p) + '="deny"'), p);
  assert.ok(X.deniedPaths().includes(require_path(HOME, 'secrets.json')));
  assert.match(args, /network=\{enabled=true\}/);
  assert.match(args, /model_providers\.snugcode=\{name="snugcode",base_url="http:\/\/127\.0\.0\.1:1\/v1",env_key="T",wire_api="responses",requires_openai_auth=false\}/);
  assert.match(args, /mcp_servers\.snugcode=\{command="node",args=\["b\.js"\],env=\{A="1"\}\}/);
  assert.ok(X.codexArgs({ computer: true }).join(' ').includes('"/"="write"'));
  const env = X.codexEnv({ OPENAI_API_KEY: 'x', PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'y' });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CODEX_HOME, X.CODEX_HOME);
});

function require_path(...p) {
  return p.join(process.platform === 'win32' ? '\\' : '/');
}

// Fake Codex app-server: ChatGPT login with a device code + model list.
const FAKE_CODEX = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id == null) continue;
    if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } });
    else if (m.method === 'account/login/start') {
      out({ id: m.id, result: { type: 'chatgptDeviceCode', loginId: 'L1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } });
      setTimeout(() => out({ method: 'account/login/completed', params: { loginId: 'L1', success: true, error: null } }), 50);
    } else if (m.method === 'account/read') out({ id: m.id, result: { account: { type: 'chatgpt', email: 'u@x.com', planType: 'plus' }, requiresOpenaiAuth: true } });
    else if (m.method === 'model/list') out({ id: m.id, result: { data: [{ id: 'gpt-5.5', model: 'gpt-5.5', hidden: false, isDefault: true, inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }] }, { id: 'old', model: 'old', hidden: true, supportedReasoningEfforts: [] }], nextCursor: null } });
    else out({ id: m.id, result: {} });
  }
});
`;

test('ChatGPT: device code login via Codex, account & model list', { skip: process.platform === 'win32' }, async () => {
  const X = await import('../daemon/codex.js');
  const bin = path.join(TMP_HOME, 'fake-codex.mjs');
  fs.writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
  const cfg = { codexExecutable: bin };
  let done;
  const finished = new Promise((r) => (done = r));
  const r = await X.chatgptLoginStart(cfg, { onDone: done });
  assert.deepEqual(r, { url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234', loginId: 'L1' });
  const res = await finished;
  assert.equal(res.ok, true);
  assert.equal(res.account.email, 'u@x.com');
  const models = await X.chatgptModels(cfg);
  assert.deepEqual(models.map((m) => m.id), ['chatgpt:gpt-5.5'], 'hidden models dropped');
  assert.deepEqual(models[0].efforts, ['low', 'high', 'xhigh']);
  assert.equal(models[0].engine, 'codex');
  assert.equal(models[0].isDefault, true);
  assert.ok(fs.existsSync(X.CODEX_HOME), 'CODEX_HOME inside the snugcode data folder');
});
