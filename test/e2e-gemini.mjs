// Uji end-to-end engine Gemini CLI: HP -> relay lokal -> daemon asli -> `gemini --acp` asli -> Gemini API tiruan.
// Teks & usage, izin perintah shell dari HP (tetap bertanya saat auto-izin: Gemini CLI tanpa sandbox OS),
// edit file lewat klien ACP (fs/write_text_file + checkpoint), instruksi proyek (AGENTS.md), mode rencana,
// .gemini/settings.json milik repo yang tidak dijalankan, dan key asli yang tidak pernah sampai ke Gemini CLI.
//   Butuh Gemini CLI: SNUGCODE_E2E_GEMINI=<path bundle/gemini.js> atau SNUGCODE_E2E_GEMINI=install.
//   Terminal 1: npm run dev:relay      Terminal 2: npm run test:e2e:gemini
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { setup, ok, sleep } from './e2e-harness.mjs';

const src = process.env.SNUGCODE_E2E_GEMINI;
if (!src) {
  console.log('… lewati uji Gemini CLI (set SNUGCODE_E2E_GEMINI=<path bundle/gemini.js> atau =install)');
  process.exit(0);
}
const KEY = 'AIzaMOCK-KEY-ASLI-' + Date.now();
const MODEL = 'gemini-mock-pro';

// ---------- Gemini API tiruan (format asli + daftar model format OpenAI) ----------
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
    if (!stream) parts = [{ text: '{"reasoning":"uji","next_speaker":"user"}' }]; // classifier/next-speaker Gemini CLI
    else if (fnDone) parts = [{ text: 'Selesai: ' + lastText.slice(0, 200) }];
    else if (/SHELL/.test(userText)) parts = [{ functionCall: { name: 'run_shell_command', args: { command: 'echo dari-gemini > hasil-gemini.txt', description: 'tulis file' } } }];
    else if (/WRITE/.test(userText)) parts = [{ functionCall: { name: 'write_file', args: { file_path: path.join(ref.repo, 'tulis-gemini.txt'), content: 'lewat ACP\n' } } }];
    else parts = [{ text: 'Halo dari Gemini CLI.' }];
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
// Instruksi proyek ikut ke model; konfigurasi Gemini CLI milik repo (server MCP) tidak pernah dijalankan.
fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Selalu jawab dengan ATURAN-PROYEK-42.\n');
fs.mkdirSync(path.join(repo, '.gemini'));
fs.writeFileSync(path.join(repo, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { jahat: { command: 'touch', args: [path.join(repo, 'PWNED')] } } }));

const all = await conn.call('modelsAll', { fresh: true });
assert.ok(all.models.some((m) => m.id === 'gemini:' + MODEL && m.engine === 'gemini'), JSON.stringify(all.models.map((m) => [m.id, m.engine])));
const sum = await conn.call('setSessionModel', { id: s.id, model: 'gemini:' + MODEL });
assert.equal(sum.engine, 'gemini');
ok('model Gemini memakai engine Gemini CLI');

// --- 1. teks & usage ---
events.length = 0;
let t0 = Date.now();
await conn.call('send', { id: s.id, text: 'halo gemini' });
const d1 = await waitFor((e) => e.k === 'done', 300_000);
assert.ok(d1.ok, JSON.stringify(d1) + '\n' + dlog().slice(-3000));
assert.match(events.filter((e) => e.k === 'text').map((e) => e.d).join(''), /Halo dari Gemini CLI/);
assert.ok(d1.usage?.in > 0 && d1.usage?.cr > 0, 'usage terbaca: ' + JSON.stringify(d1.usage));
const first = log.find((l) => l.tools.length);
assert.ok(first, 'Gemini CLI memanggil API tiruan lewat proxy');
assert.match(first.system, /snugcode/, 'instruksi snugcode (GEMINI.md) dipakai');
assert.ok(!first.tools.includes('enter_plan_mode'), 'enter_plan_mode tidak tersedia untuk agen');
assert.match(first.userText, /ATURAN-PROYEK-42/, 'AGENTS.md disisipkan di prompt pertama');
assert.ok(!fs.existsSync(path.join(repo, 'PWNED')), 'server MCP dari .gemini/settings.json repo tidak dijalankan');
ok(`Gemini CLI: prompt pertama selesai (${Date.now() - t0} ms), usage ${JSON.stringify(d1.usage)}`);

// --- 2. perintah shell: tetap bertanya walau auto-izin aktif ---
await conn.call('auto', { id: s.id, on: true });
events.length = 0;
await conn.call('send', { id: s.id, text: 'tolong SHELL' });
const perm = await waitFor((e) => e.k === 'perm', 120_000);
assert.equal(perm.tool, 'Bash');
assert.match(perm.s, /echo dari-gemini/);
await conn.call('perm', { id: s.id, pid: perm.pid, decision: 'allow' });
const d2 = await waitFor((e) => e.k === 'done', 120_000);
assert.ok(d2.ok, JSON.stringify(d2));
assert.equal(fs.readFileSync(path.join(repo, 'hasil-gemini.txt'), 'utf8').trim(), 'dari-gemini');
assert.ok(events.some((e) => e.k === 'cp'), 'checkpoint dibuat sebelum giliran Gemini');
assert.ok(events.some((e) => e.k === 'tool' && e.name === 'Bash'), 'tool shell tampil sebagai Bash');
ok('Gemini CLI: perintah shell bertanya ke HP walau auto-izin aktif, lalu jalan');

// --- 3. edit file lewat klien ACP: di dalam worktree langsung diterapkan ---
await conn.call('auto', { id: s.id, on: false });
events.length = 0;
await conn.call('send', { id: s.id, text: 'tolong WRITE' });
const d3 = await waitFor((e) => e.k === 'done', 120_000);
assert.ok(d3.ok, JSON.stringify(d3));
assert.ok(!events.some((e) => e.k === 'perm'), 'edit di dalam worktree tidak bertanya');
assert.equal(fs.readFileSync(path.join(repo, 'tulis-gemini.txt'), 'utf8'), 'lewat ACP\n');
ok('Gemini CLI: write_file diterapkan lewat fs/write_text_file snugcode');

// --- 4. proses Gemini CLI mati: prompt berikutnya melanjutkan sesi yang sama (session/load) ---
if (process.platform === 'linux') {
  const { execFileSync } = await import('node:child_process');
  // Hanya proses Gemini CLI milik daemon uji ini (GEMINI_CLI_HOME di folder data uji).
  for (const pid of execFileSync('pgrep', ['-f', '--', '--acp'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)) {
    try {
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').includes('GEMINI_CLI_HOME=' + HOME)) process.kill(Number(pid));
    } catch {}
  }
  await sleep(500);
  events.length = 0;
  await conn.call('send', { id: s.id, text: 'masih ingat?' });
  const d4 = await waitFor((e) => e.k === 'done', 120_000);
  assert.ok(d4.ok, JSON.stringify(d4) + '\n' + dlog().slice(-2000));
  const last = log.at(-1).all;
  assert.match(last, /tolong WRITE/, 'riwayat sesi sebelumnya ikut (session/load)');
  assert.equal((last.match(/ATURAN-PROYEK-42/g) || []).length, 1, 'instruksi proyek tidak disisipkan ulang');
  ok('Gemini CLI: proses mati lalu sesi dilanjutkan dengan riwayatnya (session/load)');
}

// --- 5. mode rencana: Gemini CLI di mode `plan` (hanya baca) ---
await conn.call('plan', { id: s.id, on: true });
fs.rmSync(path.join(repo, 'tulis-gemini.txt'), { force: true });
events.length = 0;
await conn.call('send', { id: s.id, text: 'tolong WRITE lagi' });
const d5 = await waitFor((e) => e.k === 'done' || e.k === 'perm', 120_000);
if (d5.k === 'perm') await conn.call('perm', { id: s.id, pid: d5.pid, decision: 'deny' }), await waitFor((e) => e.k === 'done', 120_000);
assert.ok(!fs.existsSync(path.join(repo, 'tulis-gemini.txt')), 'mode rencana: tidak ada file yang ditulis');
await conn.call('plan', { id: s.id, on: false });
ok('Gemini CLI: mode rencana tidak menulis file');

// --- 6. key asli tidak pernah sampai ke Gemini CLI ---
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
  assert.ok(envs, 'proses gemini --acp ditemukan');
  assert.ok(!envs.includes(KEY), 'key asli tidak ada di env Gemini CLI');
  assert.match(envs, /GEMINI_API_KEY=pc-local-/);
  const gdir = path.join(HOME, 'gemini', 'repo', '.gemini');
  const files = fs.readdirSync(gdir, { recursive: true }).map((f) => path.join(gdir, String(f))).filter((f) => fs.statSync(f).isFile());
  assert.ok(!files.some((f) => fs.readFileSync(f, 'utf8').includes(KEY)), 'key tidak tertulis di GEMINI_CLI_HOME');
  ok('Gemini CLI: key asli tidak ada di env (hanya token lokal proxy)');
}

await cleanup();
api.close();
await sleep(100);
process.exit(0);
