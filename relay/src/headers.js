// Security header PWA. Satu sumber untuk dua jalur: scripts/build-web.mjs menulisnya ke
// relay/public/_headers (aset yang disajikan langsung oleh worker alias), dan relay menambahkannya
// ke aset yang dilayani lewat env.ASSETS. Token login, secret perangkat HP, dan token Codespaces
// disimpan di localStorage: CSP ketat membatasi dampak XSS (tanpa skrip inline / pihak ketiga).
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Atribut style dipakai UI (posisi sheet, variabel CSS per elemen).
  "style-src 'self' 'unsafe-inline'",
  // Screenshot preview & gambar lampiran dikirim sebagai data: URL.
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // wss: koneksi relay (alamat lama & baru); api.github.com: runner Codespaces dari HP.
  "connect-src 'self' wss: https://api.github.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

// Halaman HTML buatan relay (login, konfirmasi): tanpa skrip sama sekali.
export const PAGE_HEADERS = {
  ...SECURITY_HEADERS,
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'cache-control': 'no-store',
};
