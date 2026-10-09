// Bundle PWA (web/ + shared/crypto.js) ke relay/public untuk di-deploy bersama relay.
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
const shell = ['index.html', 'style.css', 'manifest.webmanifest', 'icon.svg'];
for (const f of shell) fs.copyFileSync(path.join(root, 'web', f), path.join(out, f));
// Nama cache service worker = hash isi aset: setiap deploy yang mengubah UI otomatis membuat
// sw.js berbeda, sehingga HP memasang versi baru tanpa perlu menaikkan nomor versi manual.
const hash = crypto.createHash('sha256');
for (const f of ['app.js', ...shell]) hash.update(fs.readFileSync(path.join(out, f)));
const sw = fs.readFileSync(path.join(root, 'web', 'sw.js'), 'utf8');
const stamped = sw.replace(/const CACHE = '[^']*';/, `const CACHE = 'snugcode-${hash.digest('hex').slice(0, 10)}';`);
if (stamped === sw) throw new Error('sw.js: baris `const CACHE = ...` tidak ditemukan');
fs.writeFileSync(path.join(out, 'sw.js'), stamped);
console.log('PWA → relay/public');
