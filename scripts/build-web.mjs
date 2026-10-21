// Bundle PWA (web/ + shared/crypto.js) ke relay/public untuk di-deploy bersama relay.
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { securityHeaders } from '../relay/src/headers.js';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'relay', 'public');
// Kosongkan isi folder tanpa menghapus foldernya (di Windows folder yang
// sedang dipantau `wrangler dev` tidak bisa dihapus).
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, 'web', 'app.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2022', 'safari15'],
  outfile: path.join(out, 'app.js'),
  logLevel: 'info',
});
// xterm.js hanya dimuat saat terminal dibuka (import dinamis dengan URL, tidak ikut app.js).
await build({
  entryPoints: [path.join(root, 'web', 'xterm.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2022', 'safari15'],
  outfile: path.join(out, 'xterm.js'),
  logLevel: 'warning',
});
fs.copyFileSync(path.join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), path.join(out, 'xterm.css'));
const shell = ['index.html', 'install.sh', 'install.ps1', 'theme.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'apple-touch-icon-precomposed.png'];
for (const f of shell) fs.copyFileSync(path.join(root, 'web', f), path.join(out, f));
// Security header untuk aset yang disajikan langsung (worker alias); relay menambahkannya sendiri.
// Host WebSocket yang diizinkan CSP: alamat publik & lama dari relay/wrangler.jsonc (relay self-host
// memakai varsnya sendiri), atau SNUGCODE_WS_HOSTS="a.example,b.example".
const wrangler = JSON.parse(fs.readFileSync(path.join(root, 'relay', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const wsHosts = process.env.SNUGCODE_WS_HOSTS
  ? process.env.SNUGCODE_WS_HOSTS.split(',')
  : [wrangler.vars?.PUBLIC_URL ? new URL(wrangler.vars.PUBLIC_URL).host : '', ...String(wrangler.vars?.LEGACY_HOSTS || '').split(',')];
fs.writeFileSync(path.join(out, '_headers'), '/*\n' + Object.entries(securityHeaders(wsHosts.map((s) => s.trim()))).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n');
// Font di-host sendiri (lihat @font-face di style.css).
const FONTS = {
  'jetbrains-mono-400.woff2': '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
  'jetbrains-mono-500.woff2': '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2',
  'source-serif-4.woff2': '@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2',
  'source-serif-4-italic.woff2': '@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-italic.woff2',
};
fs.mkdirSync(path.join(out, 'fonts'));
for (const [name, src] of Object.entries(FONTS)) fs.copyFileSync(path.join(root, 'node_modules', src), path.join(out, 'fonts', name));
// Nama cache service worker = hash isi aset: setiap deploy yang mengubah UI otomatis membuat
// sw.js berbeda, sehingga HP memasang versi baru tanpa perlu menaikkan nomor versi manual.
const hash = crypto.createHash('sha256');
for (const f of ['app.js', 'xterm.js', 'xterm.css', ...shell]) hash.update(fs.readFileSync(path.join(out, f)));
const sw = fs.readFileSync(path.join(root, 'web', 'sw.js'), 'utf8');
const stamped = sw.replace(/const CACHE = '[^']*';/, `const CACHE = 'snugcode-${hash.digest('hex').slice(0, 10)}';`);
if (stamped === sw) throw new Error('sw.js: baris `const CACHE = ...` tidak ditemukan');
fs.writeFileSync(path.join(out, 'sw.js'), stamped);
// SHA-256 tiap file yang disajikan (build.json, ikut di rilis GitHub): siapa pun bisa membandingkan PWA yang
// dilayani relay dengan hasil build dari kode sumber (`npm ci && npm run build:web`). Lihat docs/keamanan.md.
const files = {};
const walk = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else files[path.relative(out, p).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
};
walk(out);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const digest = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({ version, digest, files }, null, 2) + '\n');
console.log(`PWA → relay/public (build ${digest.slice(0, 16)})`);
