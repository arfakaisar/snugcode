// pocketcode — Loopback proxy lokal untuk sanitasi header & router forwarding.
// 1. Mencegah header SDK bawaan (user-agent claude-cli, x-app: cli) memicu injeksi
//    parameter yang tidak valid pada router upstream (seperti reasoning_effort pada Anthropic).
// 2. Menetralkan suffix `_ide` pada nama tool yang dihasilkan router upstream / Claude Code IDE
//    (misal "Bash_ide" -> "Bash", "Read_ide" -> "Read") agar cocok dengan registri tool bawaan SDK.
import http from 'node:http';
import https from 'node:https';

export function stripIdeToolSuffix(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/"name"\s*:\s*"([a-zA-Z0-9_-]+)_ide"/g, '"name":"$1"');
}

export function startRouterProxy(routerUrl, routerKey) {
  const target = new URL(routerUrl.replace(/\/+$/, '').replace(/\/v1$/, ''));
  const transport = target.protocol === 'https:' ? https : http;

  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: target.host };
    if (routerKey && !headers['x-api-key'] && !headers.authorization) {
      headers['x-api-key'] = routerKey;
    }
    delete headers['content-length'];
    delete headers['accept-encoding'];
    delete headers['x-app'];
    if (typeof headers['user-agent'] === 'string' && headers['user-agent'].includes('claude-cli')) {
      headers['user-agent'] = 'pocketcode/0.1';
    }

    const up = transport.request(target.origin + req.url, { method: req.method, headers }, (upRes) => {
      const resHeaders = { ...upRes.headers };
      delete resHeaders['content-length'];
      res.writeHead(upRes.statusCode, resHeaders);

      let carry = '';
      upRes.on('data', (chunk) => {
        const text = carry + chunk.toString('utf8');
        if (text.length > 64) {
          const safe = text.slice(0, text.length - 64);
          carry = text.slice(text.length - 64);
          res.write(stripIdeToolSuffix(safe));
        } else {
          carry = text;
        }
      });

      upRes.on('end', () => {
        if (carry) {
          res.write(stripIdeToolSuffix(carry));
          carry = '';
        }
        res.end();
      });
    });

    up.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Router proxy error: ' + err.message } }));
    });

    req.pipe(up);
  });

  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    resolveReady(addr ? `http://127.0.0.1:${addr.port}` : null);
  });

  return {
    server,
    ready() {
      const addr = server.address();
      if (addr) return Promise.resolve(`http://127.0.0.1:${addr.port}`);
      return readyPromise;
    },
    get url() {
      const addr = server.address();
      return addr ? `http://127.0.0.1:${addr.port}` : null;
    },
    close() {
      try {
        server.close();
      } catch {}
    },
  };
}
