// Harness uji end-to-end bersama: mock 9router, PC terdaftar di relay dev, daemon asli dengan
// SNUGCODE_HOME sementara, klien HP (web/conn.js) yang sudah dipasangkan, dan satu sesi lokal.
// Dipakai test/e2e-agent.mjs dan test/e2e-ui.mjs. Butuh relay dev: `npm run dev:relay`.
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

// ---------- mock 9router (Anthropic Messages API, streaming) ----------
// Prompt berisi WRITE -> tool_use Write; SLOW -> jawaban lambat; READSECRET -> Read secrets.json;
// MARKDOWN -> jawaban markdown panjang; TODOS -> TodoWrite; WRITE2 -> tool_use Write ke hasil2.txt.
export const routerLog = [];
// Markdown panjang (judul, kode berbaris kosong, list) untuk menguji render bertahap.
const MD = Array.from({ length: 12 }, (_, i) => `## Bagian ${i + 1}\n\nParagraf **tebal** dan \`kode\` nomor ${i + 1}.\n\n\`\`\`js\nconst x${i} = 1;\n\nconsole.log(x${i});\n\`\`\`\n\n- item a${i}\n- item b${i}`).join('\n\n');
let n = 0;
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
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
function startMockRouter(cwdRef) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch {}
      routerLog.push({ url: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'], model: j.model });
      if (!req.url.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        // /models: model ringan (Haiku 5.5) tersedia, jadi subagen tidak ikut berganti saat model utama diganti.
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
      if (/WRITE2/.test(lastText)) return sse(res, toolMsg(model, 'Write', { file_path: cwdRef.cwd + '/hasil2.txt', content: 'langsung\n' }));
      if (/WRITE/.test(lastText)) return sse(res, toolMsg(model, 'Write', { file_path: cwdRef.cwd + '/hasil.txt', content: 'dibuat agen\n' }));
      return sse(res, textMsg(model, 'Halo dari mock router.'));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}


// Relay dev menyimpan state antar run: nama PC unik agar mudah dikenali (mis. di layar daftar PC).
export async function setup({ name = 'e2e-' + Date.now().toString(36) } = {}) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(100) + '\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
  const ref = { cwd: repo, secrets: path.join(HOME, 'secrets.json') };
  const router = await startMockRouter(ref);

  // --- registrasi PC di relay dev ---
  const { code } = await (await fetch(RELAY + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name }) })).json();
  await fetch(`${RELAY}/auth/dev/login?kind=machine&pc=${code}&login=tester`);
  const reg = await (await fetch(`${RELAY}/auth/machine/poll?code=${code}`)).json();
  assert.equal(reg.status, 'ok');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ relayUrl: RELAY, routerUrl: `http://127.0.0.1:${router.address().port}/v1`, machineName: name, machineId: reg.mid, model: 'claude-mock-1' }));
  fs.writeFileSync(ref.secrets, JSON.stringify({ machineToken: reg.token, prs: C.bytesToHex(await C.pinToPrs(PIN, reg.mid)), routerKey: 'ROUTER-KEY-ASLI', devices: {}, pinFails: 0, githubToken: null }));
  // Env Claude Code/Anthropic milik shell pemanggil (mis. dijalankan dari dalam Claude Code) tidak ikut ke daemon uji.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/.test(k)));
  const DAEMON = `
    const { loadConfig } = await import(${JSON.stringify(new URL('../daemon/config.js', import.meta.url).href)});
    const { Daemon } = await import(${JSON.stringify(new URL('../daemon/server.js', import.meta.url).href)});
    const d = new Daemon(loadConfig(), { log: (m) => console.log('[daemon]', m) });
    d.start();
    process.on('SIGTERM', () => Promise.resolve(d.stop()).finally(() => process.exit(0)));`;
  const daemon = spawn(process.execPath, ['--input-type=module', '-e', DAEMON], { env: { ...cleanEnv, SNUGCODE_HOME: HOME, SNUGCODE_DEBUG: process.env.DEBUG || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let dlog = '';
  process.on('exit', () => daemon.exitCode === null && daemon.kill('SIGKILL'));
  daemon.stdout.on('data', (d) => (dlog += d));
  daemon.stderr.on('data', (d) => (dlog += d));
  for (let i = 0; i < 50 && !/Terhubung ke relay/.test(dlog); i++) await sleep(200);
  assert.match(dlog, /Terhubung ke relay/);
  ok('daemon tersambung ke relay');

  // --- HP: web/conn.js di Node ---
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.location = { protocol: new URL(RELAY).protocol, host: new URL(RELAY).host };
  const { Conn, store } = await import('../web/conn.js');
  const r = await fetch(`${RELAY}/auth/dev/login?kind=user&login=tester`, { redirect: 'manual' });
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
  assert.equal(conn.bin, true, 'kanal biner disepakati');
  assert.equal(info.proto, 2);
  ok('pairing PIN + auth, kanal biner aktif (proto ' + info.proto + ')');

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
    throw new Error('timeout menunggu event; events=' + JSON.stringify(events).slice(0, 1500) + ' router=' + JSON.stringify(routerLog).slice(0, 800) + '\ndaemon log:\n' + dlog.slice(-3000));
  };

  const s = await conn.call('create', { local: repo });
  const att = await conn.call('attach', { id: s.id, since: 0 });
  ok('sesi lokal dibuat & attach (' + att.events.length + ' event)');
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
