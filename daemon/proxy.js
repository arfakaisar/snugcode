// pocketcode — Loopback proxy lokal untuk sanitasi header & router forwarding.
// 1. Mencegah header SDK bawaan (user-agent claude-cli, x-app: cli) memicu injeksi
//    parameter yang tidak valid pada router upstream (seperti reasoning_effort pada Anthropic).
// 2. Menetralkan suffix `_ide` pada nama tool yang dihasilkan router upstream / Claude Code IDE
//    (misal "Bash_ide" -> "Bash", "Read_ide" -> "Read") agar cocok dengan registri tool bawaan SDK.
// 3. Key 9router asli tidak pernah masuk ke proses claude (dan Bash agen yang mewarisi env-nya):
//    proses itu hanya memegang token lokal acak milik proxy ini. Proxy menukarnya dengan key asli.
//    Request tanpa token lokal yang benar (program lain di PC) ditolak 401, jadi port ini tidak
//    bisa dipakai untuk menumpang key pengguna, dan token yang bocor tidak berguna di luar PC.
import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export function stripIdeToolSuffix(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/"name"\s*:\s*"([a-zA-Z0-9_-]+)_ide"/g, '"name":"$1"');
}

// Hanya SSE dan JSON yang ditulis ulang; selain itu diteruskan apa adanya.
const REWRITE_RE = /^(text\/event-stream|application\/(.+\+)?json)\b/i;

// Penulis ulang streaming: teks diproses per baris utuh, sehingga `"name":"Bash_ide"`
// tidak pernah terbelah di batas chunk TCP. StringDecoder menjaga karakter UTF-8
// multi-byte yang terpotong di antara dua chunk.
export function createToolNameRewriter() {
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
      return stripIdeToolSuffix(text.slice(0, nl + 1));
    },
    end() {
      const rest = carry + decoder.end();
      carry = '';
      return stripIdeToolSuffix(rest);
    },
  };
}

// `getKey()`: key 9router terkini (dibaca setiap request agar `pocketcode setup` langsung berlaku).
export function startRouterProxy(routerUrl, { getKey = () => null } = {}) {
  const localToken = 'pc-local-' + randomBytes(24).toString('hex');
  const want = Buffer.from(localToken);
  const authorized = (req) => {
    const got = String(req.headers['x-api-key'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return got.length === want.length && timingSafeEqual(Buffer.from(got), want);
  };
  const target = new URL(routerUrl.replace(/\/+$/, '').replace(/\/v1$/, ''));
  const transport = target.protocol === 'https:' ? https : http;
  const agent =
    target.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 64, maxFreeSockets: 16, timeout: 120000 })
      : new http.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 64, maxFreeSockets: 16, timeout: 120000 });

  const server = http.createServer((req, res) => {
    req.socket?.setNoDelay?.(true);
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'pocketcode proxy: token lokal tidak valid' } }));
    }
    const headers = { ...req.headers, host: target.host };
    delete headers['x-api-key'];
    const key = getKey();
    if (key) headers.authorization = 'Bearer ' + key;
    else delete headers.authorization;
    delete headers['accept-encoding'];
    delete headers['x-app'];
    delete headers.connection;
    if (typeof headers['user-agent'] === 'string' && headers['user-agent'].includes('claude-cli')) {
      headers['user-agent'] = 'pocketcode/0.1';
    }

    const fail = (msg) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Router proxy error: ' + msg } }));
      } else res.destroy(); // stream sudah berjalan: putuskan agar SDK melihat error & retry
    };

    const up = transport.request(target.origin + req.url, { method: req.method, headers, agent }, (upRes) => {
      const resHeaders = { ...upRes.headers };
      const rewrite = REWRITE_RE.test(String(upRes.headers['content-type'] || ''));
      if (rewrite) delete resHeaders['content-length'];
      res.writeHead(upRes.statusCode, resHeaders);
      upRes.on('error', () => res.destroy());
      // Koneksi upstream putus sebelum selesai -> jangan biarkan SDK menunggu selamanya.
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
    up.on('error', (err) => fail(err.message));
    // Klien (SDK) membatalkan request (mis. tombol Stop) -> hentikan juga request ke router.
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  });

  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = /** @type {import('node:net').AddressInfo | null} */ (server.address());
    resolveReady(addr ? `http://127.0.0.1:${addr.port}` : null);
  });

  return {
    server,
    token: localToken,
    ready() {
      const addr = /** @type {import('node:net').AddressInfo | null} */ (server.address());
      if (addr) return Promise.resolve(`http://127.0.0.1:${addr.port}`);
      return readyPromise;
    },
    get url() {
      const addr = /** @type {import('node:net').AddressInfo | null} */ (server.address());
      return addr ? `http://127.0.0.1:${addr.port}` : null;
    },
    close() {
      try {
        server.close();
        agent.destroy();
      } catch {}
    },
  };
}
