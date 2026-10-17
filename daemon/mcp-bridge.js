#!/usr/bin/env node
// Server MCP stdio kecil untuk engine Codex: meneruskan tool dev snugcode (dev_start, dev_logs,
// preview_screenshot, …) ke daemon lewat kanal lokal (named pipe / unix socket), sehingga tool itu
// berjalan di daemon dengan izin & proses milik sesi. Dijalankan Codex (mcp_servers.snugcode).
//
// Env: SNUGCODE_IPC (path kanal lokal), SNUGCODE_BRIDGE (token jembatan sesi ini — hanya boleh
// memanggil tool dev untuk satu sesi, bukan RPC daemon lainnya).
import net from 'node:net';

const IPC = process.env.SNUGCODE_IPC;
const TOKEN = process.env.SNUGCODE_BRIDGE;

let daemon = null;
let ready = null;
let nextId = 1;
const pending = new Map();

function connectDaemon() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    const sock = net.connect(IPC);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ t: 'hello', bridge: TOKEN }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.ev === 'ready') resolve(sock);
        else if (m.ev === 'denied') reject(new Error('daemon menolak jembatan MCP'));
        else if (m.id != null && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          m.err ? p.reject(new Error(m.err)) : p.resolve(m.r);
        }
      }
    });
    sock.on('error', reject);
    sock.on('close', () => {
      for (const p of pending.values()) p.reject(new Error('kanal daemon tertutup'));
      pending.clear();
      ready = null;
    });
    daemon = sock;
  });
  return ready;
}

async function rpc(m, p) {
  await connectDaemon();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    daemon.write(JSON.stringify({ id, m, p }) + '\n');
  });
}

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (id == null) return; // notifikasi (notifications/initialized, …)
  try {
    let result;
    if (method === 'initialize') result = { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'snugcode', version: '1.0.0' } };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: await rpc('devTools', {}) };
    else if (method === 'tools/call') result = await rpc('devTool', { name: params?.name, args: params?.arguments || {} });
    else return out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
    out({ jsonrpc: '2.0', id, result });
  } catch (e) {
    if (method === 'tools/call') out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e?.message || e) }], isError: true } });
    else out({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e?.message || e) } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {}
  }
});
process.stdin.on('end', () => process.exit(0));
