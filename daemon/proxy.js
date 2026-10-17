// snugcode — Loopback proxy lokal di antara harness agen (Claude Agent SDK / Codex) dan endpoint model.
// 1. Key asli tidak pernah masuk ke proses agen (dan Bash/perintah agen yang mewarisi env-nya):
//    proses itu hanya memegang token lokal acak per koneksi. Proxy menukarnya dengan key asli
//    dan meneruskan ke endpoint koneksi itu. Request tanpa token lokal yang benar (program lain
//    di PC) ditolak 401, jadi port ini tidak bisa dipakai untuk menumpang key pengguna.
// 2. Koneksi tanpa format Anthropic (Gemini API, Groq, …) diterjemahkan ke OpenAI Chat Completions
//    (lihat translate.js), jadi Claude Agent SDK bisa memakai model apa pun.
// 3. Khusus router (9router, OmniRoute, …): header SDK bawaan (user-agent claude-cli, x-app: cli)
//    dinetralkan karena memicu injeksi parameter yang tidak valid di upstream (reasoning_effort),
//    dan suffix `_ide` pada nama tool ("Bash_ide" -> "Bash") dihapus agar cocok dengan registri SDK.
import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { anthropicToOpenAI, openAIToAnthropic, createStreamTranslator, anthropicError, estimateTokens } from './translate.js';

export function stripIdeToolSuffix(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/"name"\s*:\s*"([a-zA-Z0-9_-]+)_ide"/g, '"name":"$1"');
}

// Hanya SSE dan JSON yang ditulis ulang; selain itu diteruskan apa adanya.
const REWRITE_RE = /^(text\/event-stream|application\/(.+\+)?json)\b/i;

// Penulis ulang streaming: teks diproses per baris utuh, sehingga `"name":"Bash_ide"`
// tidak pernah terbelah di batas chunk TCP. StringDecoder menjaga karakter UTF-8
// multi-byte yang terpotong di antara dua chunk. `map` mengubah tiap potongan baris utuh.
export function createLineRewriter(map = stripIdeToolSuffix) {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  return {
    push(chunk) {
      const text = carry + decoder.write(chunk);
      const nl = text.lastIndexOf('\n');
      if (nl < 0) {
        carry = text;
        return '';
      }
      carry = text.slice(nl + 1);
      return map(text.slice(0, nl + 1));
    },
    end() {
      const rest = carry + decoder.end();
      carry = '';
      return map(rest);
    },
  };
}
export const createToolNameRewriter = () => createLineRewriter(stripIdeToolSuffix);

const agents = { 'http:': null, 'https:': null };
function agentFor(protocol) {
  const mod = protocol === 'https:' ? https : http;
  return (agents[protocol] ??= new mod.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 64, maxFreeSockets: 16, timeout: 120000 }));
}

/**
 * @typedef {{
 *   wire: 'anthropic' | 'openai' | 'responses',
 *   base: () => string,            // anthropic: root tanpa /v1; openai/responses: base dengan /v1
 *   auth: () => Record<string, string> | null, // header otentikasi asli (dibaca tiap request)
 *   router?: boolean,              // sanitasi header & _ide (9router dan sejenisnya)
 *   kind?: string,                 // jenis koneksi (gemini: skema tool & thought signature)
 * }} Route
 */

const json = (res, status, body) => {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Proxy dengan banyak rute; tiap rute punya token lokal sendiri. @param {{ log?: (m: string) => void }} [o] */
export function startProxy({ log = () => {} } = {}) {
  /** @type {Map<string, { route: Route, buf: Buffer }>} */
  const routes = new Map();
  const find = (req) => {
    const got = String(req.headers['x-api-key'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const g = Buffer.from(got);
    for (const [, r] of routes) if (g.length === r.buf.length && timingSafeEqual(g, r.buf)) return r.route;
    return null;
  };

  const server = http.createServer((req, res) => {
    req.socket?.setNoDelay?.(true);
    const route = find(req);
    if (!route) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'snugcode proxy: token lokal tidak valid' } });
    if (route.wire === 'openai') return translated(route, req, res);
    passthrough(route, req, res);
  });

  // Anthropic -> endpoint format Anthropic, atau Responses API (Codex) -> endpoint OpenAI: apa adanya.
  function passthrough(route, req, res) {
    const base = route.base().replace(/\/+$/, '');
    // Codex memanggil <base_url>/responses dengan base_url = proxy + /v1.
    const pathPart = route.wire === 'responses' ? req.url.replace(/^\/v1(?=\/|$)/, '') : req.url;
    const target = new URL(base + pathPart);
    const transport = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: target.host };
    delete headers['x-api-key'];
    delete headers.authorization;
    Object.assign(headers, route.auth() || {});
    delete headers['accept-encoding'];
    delete headers.connection;
    if (route.router) {
      delete headers['x-app'];
      if (typeof headers['user-agent'] === 'string' && headers['user-agent'].includes('claude-cli')) headers['user-agent'] = 'snugcode/0.1';
    }

    const up = transport.request(target, { method: req.method, headers, agent: agentFor(target.protocol) }, (upRes) => {
      const resHeaders = { ...upRes.headers };
      const rewrite = route.router && REWRITE_RE.test(String(upRes.headers['content-type'] || ''));
      if (rewrite) delete resHeaders['content-length'];
      res.writeHead(upRes.statusCode, resHeaders);
      upRes.on('error', () => res.destroy());
      // Koneksi upstream putus sebelum selesai -> jangan biarkan agen menunggu selamanya.
      upRes.on('close', () => {
        if (!upRes.complete) res.destroy();
      });
      if (!rewrite) return upRes.pipe(res);
      const rw = createToolNameRewriter();
      upRes.on('data', (chunk) => {
        const out = rw.push(chunk);
        if (out) res.write(out);
      });
      upRes.on('end', () => res.end(rw.end()));
    });
    up.on('socket', (s) => s.setNoDelay?.(true));
    up.on('error', (err) => (res.headersSent ? res.destroy() : json(res, 502, anthropicError(502, 'Router proxy error: ' + err.message))));
    // Klien (agen) membatalkan request (mis. tombol Stop) -> hentikan juga request ke endpoint.
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  }

  // Anthropic Messages -> OpenAI Chat Completions -> Anthropic Messages.
  function translated(route, req, res) {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return json(res, 400, anthropicError(400, 'body bukan JSON'));
      }
      const p = new URL(req.url, 'http://x').pathname;
      if (p.endsWith('/messages/count_tokens')) return json(res, 200, estimateTokens(body));
      if (!p.endsWith('/messages')) return json(res, 404, anthropicError(404, 'snugcode proxy: endpoint tidak didukung untuk koneksi ini: ' + p));
      const o = anthropicToOpenAI(body, { kind: route.kind });
      const target = new URL(route.base().replace(/\/+$/, '') + '/chat/completions');
      const transport = target.protocol === 'https:' ? https : http;
      const payload = Buffer.from(JSON.stringify(o));
      const headers = { 'content-type': 'application/json', 'content-length': String(payload.length), accept: o.stream ? 'text/event-stream' : 'application/json', 'user-agent': 'snugcode/0.1', ...(route.auth() || {}) };
      const up = transport.request(target, { method: 'POST', headers, agent: agentFor(target.protocol) }, (upRes) => {
        const status = upRes.statusCode || 502;
        const dec = new StringDecoder('utf8');
        if (status >= 400 || !o.stream) {
          let text = '';
          upRes.on('data', (d) => (text += dec.write(d)));
          upRes.on('end', () => {
            text += dec.end();
            let j = null;
            try {
              j = JSON.parse(text);
            } catch {}
            const arr = Array.isArray(j) ? j[0] : j; // Gemini kadang membungkus error dalam array
            if (status >= 400) {
              const msg = arr?.error?.message || arr?.message || text.slice(0, 300) || 'HTTP ' + status;
              log(`! ${route.kind || 'endpoint'} ${status}: ${String(msg).slice(0, 200)}`);
              return json(res, status, anthropicError(status, String(msg)));
            }
            json(res, 200, openAIToAnthropic(arr || {}, body.model));
          });
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const tr = createStreamTranslator(body.model);
        upRes.on('data', (d) => {
          const out = tr.push(dec.write(d));
          if (out) res.write(out);
        });
        upRes.on('end', () => res.end(tr.push(dec.end()) + tr.end()));
        upRes.on('error', () => res.destroy());
        upRes.on('close', () => {
          if (!upRes.complete) res.destroy();
        });
      });
      up.on('socket', (s) => s.setNoDelay?.(true));
      up.on('error', (err) => (res.headersSent ? res.destroy() : json(res, 502, anthropicError(502, 'Router proxy error: ' + err.message))));
      res.on('close', () => {
        if (!res.writableFinished) up.destroy();
      });
      up.end(payload);
    });
  }

  let resolveReady;
  const readyPromise = new Promise((resolve) => (resolveReady = resolve));
  const addr = () => /** @type {import('node:net').AddressInfo | null} */ (server.address());
  server.listen(0, '127.0.0.1', () => resolveReady(addr() ? `http://127.0.0.1:${addr().port}` : null));
  server.on('error', (e) => log('! loopback proxy: ' + e.message));

  return {
    server,
    /** Daftarkan rute; mengembalikan token lokal yang dipegang proses agen. @param {Route} route */
    register(route, token = 'pc-local-' + randomBytes(24).toString('hex')) {
      routes.set(token, { route, buf: Buffer.from(token) });
      return token;
    },
    unregister(token) {
      routes.delete(token);
    },
    ready() {
      return addr() ? Promise.resolve(`http://127.0.0.1:${addr().port}`) : readyPromise;
    },
    get url() {
      return addr() ? `http://127.0.0.1:${addr().port}` : null;
    },
    close() {
      try {
        server.close();
        server.closeAllConnections?.();
      } catch {}
    },
  };
}

// Proxy satu router (bentuk lama, dipakai uji & alat lain): format Anthropic, header disanitasi.
export function startRouterProxy(routerUrl, { getKey = () => null } = {}) {
  const p = startProxy();
  const root = routerUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const token = p.register({ wire: 'anthropic', base: () => root, router: true, auth: () => (getKey() ? { authorization: 'Bearer ' + getKey() } : null) });
  return Object.assign(p, { token });
}
