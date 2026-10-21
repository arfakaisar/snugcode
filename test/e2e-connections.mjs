// Multi-provider connection end-to-end test: phone -> local relay -> real daemon -> real harness -> fake endpoints.
//   1. An OpenAI-only endpoint (like the Gemini API/Groq): connected from the phone (connAdd), its format detected,
//      then the Claude Agent SDK runs it through the proxy's format translator (a Write tool call + its result).
//   2. A Responses API endpoint with a GPT model: run by the real Codex app-server (sandbox, command permissions
//      from the phone, snugcode MCP tools through the bridge, the real key never reaches Codex).
//      Needs Codex: SNUGCODE_E2E_CODEX=<folder containing node_modules/@openai/codex> or SNUGCODE_E2E_CODEX=install.
//   Terminal 1: npm run dev:relay      Terminal 2: npm run test:e2e:connections
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { setup, ok, sleep } from './e2e-harness.mjs';

const KEY = 'MOCK-REAL-KEY-' + Date.now();

// ---------- fake OpenAI Chat Completions endpoint ----------
const chatLog = [];
const chat = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    let j = {};
    try {
      j = JSON.parse(b);
    } catch {}
    const json = (st, o) => (res.writeHead(st, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    if (req.headers.authorization !== 'Bearer ' + KEY) return json(401, { error: { message: 'bad key' } });
    if (req.url === '/v1/models') return json(200, { data: [{ id: 'mock-oss-1' }, { id: 'mock-oss-1-mini' }] });
    if (req.url !== '/v1/chat/completions') return json(404, { error: { message: 'no' } });
    if (!j.messages) return json(400, { error: { message: 'messages required' } }); // format probe
    chatLog.push(j);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    // Claude Code may split a prompt into several user messages (system reminders, environment, prompt).
    const lastUser = JSON.stringify(j.messages.slice(j.messages.findLastIndex((m) => m.role === 'assistant') + 1));
    const toolDone = j.messages.slice(j.messages.findLastIndex((m) => m.role === 'assistant') + 1).some((m) => m.role === 'tool');
    if (!toolDone && /WRITE/.test(lastUser)) {
      send({ choices: [{ delta: { content: 'Writing a file…' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_w1', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: path.join(cwdRef.cwd, 'from-openai.txt'), content: 'via the translator\n' }).slice(0, 20) } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: path.join(cwdRef.cwd, 'from-openai.txt'), content: 'via the translator\n' }).slice(20) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ delta: { content: toolDone ? 'The file has been written.' : 'Hello from the OpenAI endpoint.' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    send({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } } });
    res.end('data: [DONE]\n\n');
  });
});
const cwdRef = { cwd: '' };
await new Promise((r) => chat.listen(0, '127.0.0.1', r));

const { HOME, repo, conn, events, waitFor, s, cleanup, dlog } = await setup();
cwdRef.cwd = repo;

// ---------- 1. An OpenAI-only endpoint via the Claude Agent SDK ----------
const info0 = await conn.call('info');
assert.ok(info0.caps.includes('connAdd') && info0.caps.includes('chatgptLogin'));
assert.equal(info0.connections.length, 1, 'the legacy router shows up as a connection');
assert.equal(info0.connections[0].id, 'router');
const add = await conn.call('connAdd', { key: KEY, url: `http://127.0.0.1:${chat.address().port}/v1` });
assert.equal(add.conn.id, 'router2');
assert.deepEqual(add.conn.formats, { anthropic: false, openai: true, responses: false });
assert.equal(add.models, 2);
assert.ok(!JSON.stringify(add).includes(KEY), 'the key is not returned to the phone');
const all = await conn.call('modelsAll', { fresh: true });
assert.ok(all.models.some((m) => m.id === 'router2:mock-oss-1' && m.engine === 'claude'), JSON.stringify(all).slice(0, 400));
assert.ok(all.models.some((m) => m.id === 'claude-mock-1'), 'the legacy router\'s models are still there');
const probe = await conn.call('probeModel', { model: 'router2:mock-oss-1' });
assert.ok(probe.ok, JSON.stringify(probe));
await assert.rejects(conn.call('connAdd', { key: 'wrong', url: `http://127.0.0.1:${chat.address().port}/v1` }), /401/);
ok('connAdd: OpenAI-only endpoint detected (format, models, model test), wrong key rejected');

const sum = await conn.call('setSessionModel', { id: s.id, model: 'router2:mock-oss-1' });
assert.equal(sum.engine, 'claude');
await conn.call('auto', { id: s.id, on: true });
events.length = 0;
await conn.call('send', { id: s.id, text: 'please WRITE a file' });
const d1 = await waitFor((e) => e.k === 'done');
assert.ok(d1.ok, JSON.stringify(d1));
assert.equal(fs.readFileSync(path.join(repo, 'from-openai.txt'), 'utf8'), 'via the translator\n');
assert.match(events.filter((e) => e.k === 'text').map((e) => e.d).join(''), /The file has been written/);
const withTools = chatLog.find((j) => j.tools?.length);
assert.ok(withTools.tools.some((t) => t.function.name === 'Write'), 'Claude Code tools translated to OpenAI format');
assert.ok(chatLog.some((j) => j.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_w1')), 'the tool result is sent back');
assert.ok(d1.usage?.cr > 0, 'cache tokens reported: ' + JSON.stringify(d1.usage));
ok('Claude Agent SDK + OpenAI-only endpoint: Write tool call via the translator, file written, cache tokens read');

// Remove the connection: the session's model can't be used anymore, with a clear message.
await conn.call('connRemove', { id: 'router2' });
await waitFor((e) => e.k === 'status' && e.s === 'idle');
await assert.rejects(conn.call('send', { id: s.id, text: 'hello' }), /was removed/);
ok('connRemove: sessions using that connection get a clear message');

// ---------- 2. Codex (Responses API) ----------
const codexSrc = process.env.SNUGCODE_E2E_CODEX;
if (!codexSrc) {
  console.log('… skipping the Codex test (set SNUGCODE_E2E_CODEX=<codex folder> or =install)');
} else {
  if (codexSrc !== 'install') {
    fs.mkdirSync(path.join(HOME, 'tools'), { recursive: true });
    fs.symlinkSync(path.resolve(codexSrc), path.join(HOME, 'tools', 'codex'), 'dir');
  }
  const respLog = [];
  let n = 0;
  const sse = (res, evs) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of evs) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  };
  const msgItem = (text) => ({ type: 'message', id: 'msg_' + ++n, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  const done = (id, items) => ({ type: 'response.completed', response: { id, status: 'completed', output: items, usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 80 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 126 } } });
  const reply = (res, item, text) => {
    const id = 'resp_' + ++n;
    const evs = [{ type: 'response.created', response: { id, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: text ? { ...item, status: 'in_progress', content: [] } : item }];
    if (text) evs.push({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
    evs.push({ type: 'response.output_item.done', output_index: 0, item }, done(id, [item]));
    sse(res, evs);
  };
  const resp = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      let j = {};
      try {
        j = JSON.parse(b);
      } catch {}
      const json = (st, o) => (res.writeHead(st, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      if (req.headers.authorization !== 'Bearer ' + KEY) return json(401, { error: { message: 'bad key' } });
      if (req.url === '/v1/models') return json(200, { data: [{ id: 'gpt-mock-5' }] });
      if (req.url !== '/v1/responses') return json(404, {});
      if (!j.input) return json(400, { error: { message: 'input required' } });
      respLog.push({ tools: (j.tools || []).map((t) => t.name || t.type), raw: j.tools, input: j.input, instructions: j.instructions || '' });
      const last = j.input.at(-1) || {};
      const userText = JSON.stringify(j.input.filter((i) => i.role === 'user').at(-1) || '');
      if (last.type === 'function_call_output') return reply(res, msgItem('Command finished.'), 'Command finished.');
      if (/RUNCMD/.test(userText)) {
        const cmd = `echo from-codex > hasil-codex.txt; cat ${JSON.stringify(path.join(HOME, 'secrets.json'))} >/dev/null 2>&1 && echo LEAKED || echo CLOSED`;
        return reply(res, { type: 'function_call', id: 'fc_' + n, call_id: 'call_c' + n, name: 'exec_command', arguments: JSON.stringify({ cmd }), status: 'completed' });
      }
      if (/DEVLIST/.test(userText)) {
        // Codex sends MCP tools as a "mcp__snugcode" namespace containing the dev_* functions.
        const ns = (j.tools || []).find((t) => t.type === 'namespace' && t.tools?.some((x) => x.name === 'dev_list'));
        if (ns) return reply(res, { type: 'function_call', id: 'fc_' + n, call_id: 'call_d' + n, namespace: ns.name, name: 'dev_list', arguments: '{}', status: 'completed' });
      }
      reply(res, msgItem('Hello from Codex.'), 'Hello from Codex.');
    });
  });
  await new Promise((r) => resp.listen(0, '127.0.0.1', r));
  const add2 = await conn.call('connAdd', { key: KEY, url: `http://127.0.0.1:${resp.address().port}/v1` });
  assert.equal(add2.conn.formats.responses, true);
  const s2 = await conn.call('setSessionModel', { id: s.id, model: add2.conn.id + ':gpt-mock-5' });
  assert.equal(s2.engine, 'codex');
  await conn.call('auto', { id: s.id, on: false });
  events.length = 0;
  let t0 = Date.now();
  await conn.call('send', { id: s.id, text: 'hello codex' });
  const c1 = await waitFor((e) => e.k === 'done', 240_000);
  assert.ok(c1.ok, JSON.stringify(c1) + '\n' + dlog().slice(-2000));
  assert.match(events.filter((e) => e.k === 'text').map((e) => e.d).join(''), /Hello from Codex/);
  assert.ok(respLog[0].instructions.includes('snugcode') || JSON.stringify(respLog[0].input).includes('snugcode'), 'snugcode developer instructions sent');
  ok(`Codex: first prompt finished (${Date.now() - t0} ms), usage ${JSON.stringify(c1.usage)}`);

  // An agent command -> a permission card on the phone -> run in the sandbox; the snugcode data folder is unreadable.
  await waitFor((e) => e.k === 'status' && e.s === 'idle');
  events.length = 0;
  await conn.call('send', { id: s.id, text: 'RUNCMD now' });
  const perm = await waitFor((e) => e.k === 'perm', 60_000);
  assert.equal(perm.tool, 'Bash');
  assert.match(perm.s, /echo from-codex/);
  await conn.call('perm', { id: s.id, pid: perm.pid, decision: 'allow' });
  const c2 = await waitFor((e) => e.k === 'done', 60_000);
  assert.ok(c2.ok, JSON.stringify(c2));
  assert.equal(fs.readFileSync(path.join(repo, 'hasil-codex.txt'), 'utf8').trim(), 'from-codex');
  const out = events.find((e) => e.k === 'result')?.d || '';
  assert.match(out, /CLOSED/, 'the Codex sandbox denies reading secrets.json: ' + out);
  assert.ok(events.some((e) => e.k === 'cp'), 'checkpoint made before the Codex turn');
  ok('Codex: command permission from the phone, the command runs in the sandbox, secrets.json unreadable by the agent');

  // snugcode MCP tools through the bridge (dev_list).
  const toolNames = respLog.at(-1).tools;
  if (respLog.at(-1).raw?.some((t) => t.type === 'namespace' && t.name === 'mcp__snugcode')) {
    await waitFor((e) => e.k === 'status' && e.s === 'idle');
    events.length = 0;
    await conn.call('send', { id: s.id, text: 'DEVLIST please' });
    const c3 = await waitFor((e) => e.k === 'done', 60_000);
    assert.ok(c3.ok, JSON.stringify(c3));
    const r3 = events.find((e) => e.k === 'result');
    assert.ok(r3 && r3.ok, 'dev_list through the MCP bridge: ' + JSON.stringify(events.filter((e) => ['tool', 'result'].includes(e.k))).slice(0, 600));
    ok('Codex: snugcode MCP tool (dev_list) through the daemon bridge');
  } else console.log('… snugcode MCP tools not registered in Codex yet: ' + toolNames.join(','));

  // Plan mode: the Codex turn is read-only; once off, the snugcode sandbox profile applies again.
  const runOnce = async () => {
    await waitFor((e) => e.k === 'status' && e.s === 'idle');
    events.length = 0;
    await conn.call('send', { id: s.id, text: 'RUNCMD again' });
    const pm = await waitFor((e) => e.k === 'perm', 60_000);
    await conn.call('perm', { id: s.id, pid: pm.pid, decision: 'allow' });
    assert.ok((await waitFor((e) => e.k === 'done', 60_000)).ok);
    return events.find((e) => e.k === 'result')?.d || '';
  };
  fs.rmSync(path.join(repo, 'hasil-codex.txt'), { force: true });
  await conn.call('plan', { id: s.id, on: true });
  assert.match(await runOnce(), /Read-only/i);
  assert.ok(!fs.existsSync(path.join(repo, 'hasil-codex.txt')), 'plan mode: no file written');
  await conn.call('plan', { id: s.id, on: false });
  assert.match(await runOnce(), /CLOSED/);
  assert.ok(fs.existsSync(path.join(repo, 'hasil-codex.txt')), 'after plan mode: writing works again');
  ok('Codex: plan mode is read-only, then the snugcode sandbox (data folder closed) applies again');

  // The real key never reaches Codex: the app-server process env only has the proxy's local token.
  if (process.platform === 'linux') {
    const { execFileSync } = await import('node:child_process');
    const pids = execFileSync('pgrep', ['-f', 'app-server'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const envs = pids.map((p) => {
      try {
        return fs.readFileSync(`/proc/${p}/environ`, 'utf8');
      } catch {
        return '';
      }
    }).join('\n');
    assert.ok(!envs.includes(KEY), 'the real key is not in the Codex env');
    assert.match(envs, /SNUGCODE_CODEX_TOKEN=pc-local-/);
    ok('Codex: the real key is not in the app-server env (only the proxy\'s local token)');
  }
  resp.close();
}

await cleanup();
chat.close();
await sleep(100);
process.exit(0);
