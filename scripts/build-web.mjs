// Bundle PWA (web/ + shared/crypto.js) ke relay/public untuk di-deploy bersama relay.
import { build } from 'esbuild';
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
for (const f of ['index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'sw.js']) fs.copyFileSync(path.join(root, 'web', f), path.join(out, f));
console.log('PWA → relay/public');
