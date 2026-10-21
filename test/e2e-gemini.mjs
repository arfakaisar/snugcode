// End-to-end Gemini CLI engine test: phone -> local relay -> real daemon -> real `gemini --acp` -> fake Gemini API.
// Text & usage, shell command permission from the phone (still asks in auto-allow: Gemini CLI has no OS sandbox),
// file edits through the ACP client (fs/write_text_file + checkpoint), project instructions (AGENTS.md), plan mode,
// a repo's own .gemini/settings.json that is never run, and a real key that never reaches Gemini CLI.
//   Needs Gemini CLI: SNUGCODE_E2E_GEMINI=<path to bundle/gemini.js> or SNUGCODE_E2E_GEMINI=install.
//   Terminal 1: npm run dev:relay      Terminal 2: npm run test:e2e:gemini
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { setup, ok, sleep } from './e2e-harness.mjs';

const src = process.env.SNUGCODE_E2E_GEMINI;
if (!src) {
  console.log('… skipping the Gemini CLI test (set SNUGCODE_E2E_GEMINI=<path to bundle/gemini.js> or =install)');
  process.exit(0);
}
const KEY = 'AIzaMOCK-KEY-REAL-' + Date.now();
const MODEL = 'gemini-mock-pro';

// ---------- fake Gemini API (native format + OpenAI-format model list) ----------
const log = [];
const ref = { repo: '' };
const api = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    let j = {};
    try {
      j = JSON.parse(b);
    } catch {}
    const json = (st, o) => (res.writeHead(st, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    const key = req.headers['x-goog-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (key !== KEY) return json(401, { error: { code: 401, message: 'API key not valid', status: 'UNAUTHENTICATED' } });
    if (req.url.startsWith('/v1beta/openai/models')) return json(200, { object: 'list', data: [{ id: 'models/' + MODEL, object: 'model' }] });
    if (/:countTokens/.test(req.url)) return json(200, { totalTokens: 10 });
    const stream = /:streamGenerateContent/.test(req.url);
    if (!stream && !/:generateContent/.test(req.url)) return json(404, { error: { message: 'no' } });
    const tools = (j.tools || []).flatMap((t) => t.functionDeclarations || []).map((f) => f.name);
    const last = j.contents?.at(-1) || {};
    const lastText = JSON.stringify(last);
    const userText = JSON.stringify((j.contents || []).filter((c) => c.role === 'user' && c.parts?.some((p) => p.text)).at(-1) || '');
    if (stream) log.push({ url: req.url, tools, userText, system: JSON.stringify(j.systemInstruction || ''), all: JSON.stringify(j.contents || []) });
    const fnDone = last.parts?.some((p) => p.functionResponse);
    let parts;
    if (!stream) parts = [{ text: '{"reasoning":"test","next_speaker":"user"}' }]; // Gemini CLI classifier/next-speaker
    else if (fnDone) parts = [{ text: 'Done: ' + lastText.slice(0, 200) }];
    else if (/SHELL/.test(userText)) parts = [{ functionCall: { name: 'run_shell_command', args: { command: 'echo from-gemini > gemini-result.txt', description: 'write a file' } } }];
    else if (/WRITE/.test(userText)) parts = [{ functionCall: { name: 'write_file', args: { file_path: path.join(ref.repo, 'gemini-write.txt'), content: 'via ACP\n' } } }];
    else parts = [{ text: 'Hello from Gemini CLI.' }];
    const body = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105, cachedContentTokenCount: 40 }, modelVersion: MODEL };
    if (!stream) return json(200, body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify(body) + '\r\n\r\n');
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${api.address().port}`;

const gemini = { kind: 'gemini', key: KEY, label: 'Google Gemini API', openai: base + '/v1beta/openai', formats: { anthropic: false, openai: true, responses: false }, addedAt: Date.now() };
const env = src === 'install' ? {} : { SNUGCODE_GEMINI_BIN: path.resolve(src) };
const { HOME, repo, conn, events, waitFor, s, cleanup, dlog } = await setup({ secrets: { connections: { gemini } }, env });
ref.repo = repo;
// Project instructions reach the model; the repo's own Gemini CLI config (MCP server) is never run.
fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Always answer with PROJECT-RULE-42.\n');
fs.mkdirSync(path.join(repo, '.gemini'));
fs.writeFileSync(path.join(repo, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { evil: { command: 'touch', args: [path.join(repo, 'PWNED')] } } }));

const all = await conn.call('modelsAll', { fresh: true });
assert.ok(all.models.some((m) => m.id === 'gemini:' + MODEL && m.engine === 'gemini'), JSON.stringify(all.models.map((m) => [m.id, m.engine])));
const sum = await conn.call('setSessionModel', { id: s.id, model: 'gemini:' + MODEL });
assert.equal(sum.engine, 'gemini');
ok('Gemini models use the Gemini CLI engine');

// --- 1. text & usage ---
events.length = 0;
let t0 = Date.now();
await conn.call('send', { id: s.id, text: 'hello gemini' });
const d1 = await waitFor((e) => e.k === 'done', 300_000);
assert.ok(d1.ok, JSON.stringify(d1) + '\n' + dlog().slice(-3000));
assert.match(events.filter((e) => e.k === 'text').map((e) => e.d).join(''), /Hello from Gemini CLI/);
assert.ok(d1.usage?.in > 0 && d1.usage?.cr > 0, 'usage read: ' + JSON.stringify(d1.usage));
const first = log.find((l) => l.tools.length);
assert.ok(first, 'Gemini CLI calls the fake API through the proxy');
assert.match(first.system, /snugcode/, 'snugcode instructions (GEMINI.md) used');
assert.ok(!first.tools.includes('enter_plan_mode'), 'enter_plan_mode is not available to the agent');
assert.match(first.userText, /PROJECT-RULE-42/, 'AGENTS.md is inserted into the first prompt');
assert.ok(!fs.existsSync(path.join(repo, 'PWNED')), 'the MCP server from the repo .gemini/settings.json is not run');
ok(`Gemini CLI: first prompt done (${Date.now() - t0} ms), usage ${JSON.stringify(d1.usage)}`);

// --- 2. shell command: still asks even with auto-allow on ---
await conn.call('auto', { id: s.id, on: true });
events.length = 0;
await conn.call('send', { id: s.id, text: 'please SHELL' });
const perm = await waitFor((e) => e.k === 'perm', 120_000);
assert.equal(perm.tool, 'Bash');
assert.match(perm.s, /echo from-gemini/);
await conn.call('perm', { id: s.id, pid: perm.pid, decision: 'allow' });
const d2 = await waitFor((e) => e.k === 'done', 120_000);
assert.ok(d2.ok, JSON.stringify(d2));
assert.equal(fs.readFileSync(path.join(repo, 'gemini-result.txt'), 'utf8').trim(), 'from-gemini');
assert.ok(events.some((e) => e.k === 'cp'), 'checkpoint made before the Gemini turn');
assert.ok(events.some((e) => e.k === 'tool' && e.name === 'Bash'), 'the shell tool shows as Bash');
ok('Gemini CLI: shell commands ask the phone even with auto-allow on, then run');

// --- 3. file edit through the ACP client: applied directly inside the worktree ---
await conn.call('auto', { id: s.id, on: false });
events.length = 0;
await conn.call('send', { id: s.id, text: 'please WRITE' });
const d3 = await waitFor((e) => e.k === 'done', 120_000);
assert.ok(d3.ok, JSON.stringify(d3));
assert.ok(!events.some((e) => e.k === 'perm'), 'edits inside the worktree do not ask');
assert.equal(fs.readFileSync(path.join(repo, 'gemini-write.txt'), 'utf8'), 'via ACP\n');
ok('Gemini CLI: write_file applied through snugcode fs/write_text_file');

// --- 4. the Gemini CLI process dies: the next prompt resumes the same session (session/load) ---
if (process.platform === 'linux') {
  const { execFileSync } = await import('node:child_process');
  // Only Gemini CLI processes of this test daemon (GEMINI_CLI_HOME in the test data folder).
  for (const pid of execFileSync('pgrep', ['-f', '--', '--acp'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)) {
    try {
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').includes('GEMINI_CLI_HOME=' + HOME)) process.kill(Number(pid));
    } catch {}
  }
  await sleep(500);
  events.length = 0;
  await conn.call('send', { id: s.id, text: 'still remember?' });
  const d4 = await waitFor((e) => e.k === 'done', 120_000);
  assert.ok(d4.ok, JSON.stringify(d4) + '\n' + dlog().slice(-2000));
  const last = log.at(-1).all;
  assert.match(last, /please WRITE/, 'previous session history is carried over (session/load)');
  assert.equal((last.match(/PROJECT-RULE-42/g) || []).length, 1, 'project instructions are not inserted again');
  ok('Gemini CLI: process died, then the session resumed with its history (session/load)');
}

// --- 5. plan mode: Gemini CLI in `plan` mode (read-only) ---
await conn.call('plan', { id: s.id, on: true });
fs.rmSync(path.join(repo, 'gemini-write.txt'), { force: true });
events.length = 0;
await conn.call('send', { id: s.id, text: 'please WRITE again' });
const d5 = await waitFor((e) => e.k === 'done' || e.k === 'perm', 120_000);
if (d5.k === 'perm') await conn.call('perm', { id: s.id, pid: d5.pid, decision: 'deny' }), await waitFor((e) => e.k === 'done', 120_000);
assert.ok(!fs.existsSync(path.join(repo, 'gemini-write.txt')), 'plan mode: no file written');
await conn.call('plan', { id: s.id, on: false });
ok('Gemini CLI: plan mode writes no files');

// --- 6. the real key never reaches Gemini CLI ---
if (process.platform === 'linux') {
  const { execFileSync } = await import('node:child_process');
  const pids = execFileSync('pgrep', ['-f', '--', '--acp'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const envs = pids.map((p) => {
    try {
      return fs.readFileSync(`/proc/${p}/environ`, 'utf8');
    } catch {
      return '';
    }
  }).join('\n');
  assert.ok(envs, 'gemini --acp process found');
  assert.ok(!envs.includes(KEY), 'the real key is not in the Gemini CLI env');
  assert.match(envs, /GEMINI_API_KEY=pc-local-/);
  const gdir = path.join(HOME, 'gemini', 'repo', '.gemini');
  const files = fs.readdirSync(gdir, { recursive: true }).map((f) => path.join(gdir, String(f))).filter((f) => fs.statSync(f).isFile());
  assert.ok(!files.some((f) => fs.readFileSync(f, 'utf8').includes(KEY)), 'the key is not written in GEMINI_CLI_HOME');
  ok('Gemini CLI: real key not in the env (only the local proxy token)');
}

await cleanup();
api.close();
await sleep(100);
process.exit(0);
