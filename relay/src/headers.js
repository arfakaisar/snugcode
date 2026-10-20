// Security header PWA. Satu sumber untuk dua jalur: scripts/build-web.mjs menulisnya ke
// relay/public/_headers (aset yang disajikan langsung oleh worker alias), dan relay menambahkannya
// ke aset yang dilayani lewat env.ASSETS. Token login, secret perangkat HP, dan token Codespaces
// disimpan di localStorage: CSP ketat membatasi dampak XSS (tanpa skrip inline / pihak ketiga).
// connect-src hanya ke relay sendiri ('self' + host wss:// relay): XSS tidak bisa membuka WebSocket ke
// server penyerang untuk mengirim keluar secret perangkat. `hosts` = host publik relay (tanpa skema).
/** @param {string[]} [hosts] */
export function csp(hosts = []) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Atribut style dipakai UI (posisi sheet, variabel CSS per elemen).
    "style-src 'self' 'unsafe-inline'",
    // Screenshot preview & gambar lampiran dikirim sebagai data: URL.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // api.github.com: runner Codespaces dari HP.
    ["connect-src 'self'", ...[...new Set(hosts.filter(Boolean))].map((h) => 'wss://' + h), 'https://api.github.com'].join(' '),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}
export const CSP = csp();

/** @param {string[]} [hosts] */
export const securityHeaders = (hosts) => ({
  'content-security-policy': csp(hosts),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
});
export const SECURITY_HEADERS = securityHeaders();

// Halaman HTML buatan relay (login, konfirmasi): tanpa skrip sama sekali.
export const PAGE_HEADERS = {
  ...SECURITY_HEADERS,
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'cache-control': 'no-store',
};
