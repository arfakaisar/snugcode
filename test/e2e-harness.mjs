// Shared end-to-end test harness: mock 9router, a PC registered with the dev relay, the real daemon with a
// temporary SNUGCODE_HOME, a paired phone client (web/conn.js), and one local session.
// Used by test/e2e-agent.mjs and test/e2e-ui.mjs. Needs the dev relay: `npm run dev:relay`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as C from '../shared/crypto.js';

export const RELAY = process.env.RELAY || 'http://127.0.0.1:8787';
export const PIN = 'moon42';
export const ok = (m) => console.log('✔ ' + m);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Link a PC (code from /auth/machine/start) to a dev account: login → confirmation page → POST the `link` token.
export async function linkMachine(code, login) {
  const page = await (await fetch(`${RELAY}/auth/dev/login?kind=machine&pc=${code}&login=${login}`)).text();
  const t = page.match(/name="t" value="([^"]+)"/)?.[1];
  if (!t) return new Response(page, { status: 400 });
  return fetch(RELAY + '/auth/machine/confirm', { method: 'POST', body: new URLSearchParams({ t }) });
}

// ---------- mock 9router (Anthropic Messages API, streaming) ----------
// A prompt containing WRITE -> tool_use Write; SLOW -> slow reply; READSECRET -> Read secrets.json;
// MARKDOWN -> long markdown reply; TODOS -> TodoWrite; WRITE2 -> tool_use Write to hasil2.txt;
// BASHSECRET -> Bash `cat <data folder>/s*.json`. Reply texts are fixtures asserted by the PWA tests.
export const routerLog = [];
// Long markdown (headings, code with blank lines, lists) to test incremental rendering.
const MD = Array.from({ length: 12 }, (_, i) => `## Bagian ${i + 1}\n\nParagraf **tebal** dan \`kode\` nomor ${i + 1}.\n\n\`\`\`js\nconst x${i} = 1;\n\nconsole.log(x${i});\n\`\`\`\n\n- item a${i}\n- item b${i}`).join('\n\n');
let n = 0;
// delay > 0: events are sent gradually (ms per event), e.g. to record documentation GIFs.
const sse = (res, events, delay = 0) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  if (!delay) {
    for (const e of events) send(e);
    return res.end();
  }
  let i = 0;
  const t = setInterval(() => (i < events.length ? send(events[i++]) : (clearInterval(t), res.end())), delay);
  res.on('close', () => clearInterval(t));
};
function textMsg(model, text) {
  const id = 'msg_' + ++n;
  return [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...text.match(/.{1,6}/gs).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}
function toolMsg(model, name, input) {
  const id = 'msg_' + ++n;
  return [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + n, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}
// key: if set, requests with another Authorization get 401 (tests key validation from the phone).
export function startMockRouter(cwdRef, reply, { key } = {}) {
  const srv = http.createServer((req, res) => {
    if (key && req.headers.authorization !== 'Bearer ' + key && req.headers['x-api-key'] !== key) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch {}
      routerLog.push({ url: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'], model: j.model });
      if (!req.url.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        // /models: the light model (Haiku 5.5) is available, so subagents don't switch when the main model changes.
        return res.end(JSON.stringify({ input_tokens: 10, data: ['claude-mock-1', 'claude-mock-2', 'cc/claude-haiku-5-5'].map((id) => ({ id })) }));
      }
      const model = j.model || 'x';
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const hasResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
      const lastText = JSON.stringify(msgs.filter((m) => m.role === 'user').at(-1) || '');
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      }
      // A custom scenario from the caller (scripts/docs-images.mjs): { events, delay } or null.
      const custom = reply?.({ model, msgs, lastText, cwd: cwdRef.cwd, body: j });
      if (custom) return sse(res, custom.events, custom.delay);
      if (hasResult || lastText.includes('"type":"tool_result"')) return sse(res, textMsg(model, 'Selesai menulis file.\n\nBaris **dua**.'));
      if (/SLOW/.test(lastText)) {
        const ev = textMsg(model, 'x'.repeat(600));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const t = setInterval(() => {
          if (i >= ev.length) return clearInterval(t), res.end();
          res.write(`event: ${ev[i].type}\ndata: ${JSON.stringify(ev[i])}\n\n`);
          i++;
        }, 200);
        res.on('close', () => clearInterval(t));
        return;
      }
      if (/MARKDOWN/.test(lastText)) return sse(res, textMsg(model, MD));
      if (/TODOS/.test(lastText)) return sse(res, toolMsg(model, 'TodoWrite', { todos: [{ content: 'Baca kode', status: 'completed', activeForm: 'Membaca kode' }, { content: 'Ubah tombol', status: 'in_progress', activeForm: 'Mengubah tombol' }, { content: 'Uji', status: 'pending', activeForm: 'Menguji' }] }));
      if (/READSECRET/.test(lastText)) return sse(res, toolMsg(model, 'Read', { file_path: cwdRef.secrets }));
      // Shell glob: gets past the regex blocklist, only the OS sandbox can deny it.
      if (/BASHSECRET/.test(lastText)) return sse(res, toolMsg(model, 'Bash', { command: `cat ${path.dirname(cwdRef.secrets)}/s*.json`, description: 'baca' }));
      if (/WRITE2/.test(lastText)) return sse(res, toolMsg(model, 'Write', { file_path: cwdRef.cwd + '/hasil2.txt', content: 'langsung\n' }));
      if (/WRITE/.test(lastText)) return sse(res, toolMsg(model, 'Write', { file_path: cwdRef.cwd + '/hasil.txt', content: 'dibuat agen\n' }));
      return sse(res, textMsg(model, 'Halo dari mock router.'));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}


// The dev relay keeps state between runs: unique PC names make them easy to recognize (e.g. on the PC list screen).
export async function setup({ name = 'e2e-' + Date.now().toString(36), reply, secrets = {}, env = {} } = {}) {
  // A unique account per run: the dev relay keeps machines between runs, and an account allows at most 20 machines.
  const login = 'tester' + Math.random().toString(36).slice(2, 8);
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(100) + '\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
  const ref = { cwd: repo, secrets: path.join(HOME, 'secrets.json') };
  const router = await startMockRouter(ref, reply);

  // --- register the PC with the dev relay ---
  const { code } = await (await fetch(RELAY + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name }) })).json();
  await linkMachine(code, login);
  const reg = await (await fetch(`${RELAY}/auth/machine/poll?code=${code}`)).json();
  assert.equal(reg.status, 'ok');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ relayUrl: RELAY, routerUrl: `http://127.0.0.1:${router.address().port}/v1`, machineName: name, machineId: reg.mid, model: 'claude-mock-1' }));
  fs.writeFileSync(ref.secrets, JSON.stringify({ machineToken: reg.token, prs: C.bytesToHex(await C.pinToPrs(PIN, reg.mid)), routerKey: 'ROUTER-KEY-ASLI', devices: {}, pinFails: 0, githubToken: null, ...secrets }));
  // The caller shell's Claude Code/Anthropic env (e.g. when run from inside Claude Code) doesn't leak into the test daemon.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/.test(k)));
  const DAEMON = `
    const { loadConfig } = await import(${JSON.stringify(new URL('../daemon/config.js', import.meta.url).href)});
    const { Daemon } = await import(${JSON.stringify(new URL('../daemon/server.js', import.meta.url).href)});
    const d = new Daemon(loadConfig(), { log: (m) => console.log('[daemon]', m) });
    d.start();
    process.on('SIGTERM', () => Promise.resolve(d.stop()).finally(() => process.exit(0)));`;
  const daemon = spawn(process.execPath, ['--input-type=module', '-e', DAEMON], { env: { ...cleanEnv, SNUGCODE_HOME: HOME, SNUGCODE_DEBUG: process.env.DEBUG || '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let dlog = '';
  process.on('exit', () => daemon.exitCode === null && daemon.kill('SIGKILL'));
  daemon.stdout.on('data', (d) => (dlog += d));
  daemon.stderr.on('data', (d) => (dlog += d));
  for (let i = 0; i < 50 && !/Connected to the relay|Terhubung ke relay/.test(dlog); i++) await sleep(200);
  assert.match(dlog, /Connected to the relay|Terhubung ke relay/);
  ok('daemon connected to the relay');

  // --- phone: web/conn.js in Node ---
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.location = { protocol: new URL(RELAY).protocol, host: new URL(RELAY).host };
  const { Conn, store } = await import('../web/conn.js');
  const r = await fetch(`${RELAY}/auth/dev/login?kind=user&login=${login}`, { redirect: 'manual' });
  store.set('token', decodeURIComponent(r.headers.get('location').split('#login=')[1]));
  const conn = new Conn({ id: reg.mid });
  const states = [];
  let ready;
  const readyP = new Promise((res) => (ready = res));
  conn.on('state', (s) => states.push(s));
  conn.on('ready', (info) => ready(info));
  const events = [];
  let onEv = null;
  conn.on('events', (msg) => {
    events.push(...msg.es);
    onEv?.();
  });
  conn.connect();
  for (let i = 0; i < 50 && !states.includes('needpin'); i++) await sleep(100);
  assert.ok(states.includes('needpin'), 'needpin: ' + states);
  const pr = await conn.pair(PIN);
  assert.ok(pr.ok, JSON.stringify(pr));
  const info = await readyP;
  assert.equal(conn.bin, true, 'binary channel agreed');
  assert.equal(info.proto, 2);
  ok('PIN pairing + auth, binary channel active (proto ' + info.proto + ')');

  const waitFor = async (pred, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = events.find(pred);
      if (e) return e;
      await new Promise((res) => {
        onEv = res;
        setTimeout(res, 200);
      });
    }
    throw new Error('timeout waiting for an event; events=' + JSON.stringify(events).slice(0, 1500) + ' router=' + JSON.stringify(routerLog).slice(0, 800) + '\ndaemon log:\n' + dlog.slice(-3000));
  };

  const s = await conn.call('create', { local: repo });
  const att = await conn.call('attach', { id: s.id, since: 0 });
  ok('local session created & attached (' + att.events.length + ' events)');
  const cleanup = async () => {
    conn.close();
    if (daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise((r) => daemon.on('exit', r));
    }
    router.close();
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  };
  return { name, HOME, repo, ref, reg, router, daemon, dlog: () => dlog, cleanEnv, mem, store, Conn, conn, events, waitFor, s, cleanup };
}
