// Bundles the PWA into dist/web (or SNUGCODE_WEB_OUT). The hosted relay serves exactly these files, so
// anyone can rebuild them from a release tag and compare build.json (docs/security.md):
//   /agent/   PWA snugcode agent (web/ + shared/)
//   /sw.js    PWA service worker at the root (scope `/`): registrations & push subscriptions of phones that
//             installed the PWA while it lived at `/` stay the same, so notifications needn't be re-allowed.
//   /fonts/   shared fonts, /install.sh & /install.ps1 (one-line installers), build.json, _headers
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { securityHeaders } from '../shared/headers.js';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.SNUGCODE_WEB_OUT || path.join(root, 'dist', 'web'));
const agent = path.join(out, 'agent');
// Empty the folder without deleting it (on Windows a folder watched by a dev server can't be deleted).
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { recursive: true, force: true });
fs.mkdirSync(agent);
await build({
  entryPoints: [path.join(root, 'web', 'app.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2022', 'safari15'],
  outfile: path.join(agent, 'app.js'),
  logLevel: 'info',
});
// xterm.js is only loaded when the terminal opens (dynamic import by URL, not part of app.js).
await build({
  entryPoints: [path.join(root, 'web', 'xterm.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2022', 'safari15'],
  outfile: path.join(agent, 'xterm.js'),
  logLevel: 'warning',
});
fs.copyFileSync(path.join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), path.join(agent, 'xterm.css'));
const shell = ['index.html', 'theme.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'apple-touch-icon-precomposed.png'];
for (const f of shell) fs.copyFileSync(path.join(root, 'web', f), path.join(agent, f));
// Root: installers (their URLs are used in the README & on PCs: snugcode.dev/install.sh) and icons
// browsers/iOS look up at the root.
for (const f of ['install.sh', 'install.ps1', 'icon.svg', 'apple-touch-icon.png', 'apple-touch-icon-precomposed.png']) fs.copyFileSync(path.join(root, 'web', f), path.join(out, f));
// iOS 27: the "Add to Home Screen" sheet uses its own image loader that fails to fetch icons from network URLs
// (resulting in a letter "S" icon), while data: URIs work since Safari 27. The PNG is still served for older iOS.
const indexHtml = fs.readFileSync(path.join(agent, 'index.html'), 'utf8');
const touchIcon = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'web', 'apple-touch-icon.png')).toString('base64');
const inlined = indexHtml.replace('rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png"', `rel="apple-touch-icon" sizes="180x180" href="${touchIcon}"`);
if (inlined === indexHtml) throw new Error('index.html: <link rel="apple-touch-icon"> not found');
fs.writeFileSync(path.join(agent, 'index.html'), inlined);
// Security headers for assets served directly by the hosted site; the relay adds them itself.
// WebSocket hosts allowed by the CSP: the public & legacy addresses of the hosted relay, or
// SNUGCODE_WS_HOSTS="a.example,b.example" for another relay.
const WS_HOSTS = ['snugcode.dev', 'snugcode.arfak.workers.dev', 'pocketcode-relay.arfak.workers.dev'];
const wsHosts = process.env.SNUGCODE_WS_HOSTS ? process.env.SNUGCODE_WS_HOSTS.split(',') : WS_HOSTS;
fs.writeFileSync(path.join(out, '_headers'), '/*\n' + Object.entries(securityHeaders(wsHosts.map((s) => s.trim()))).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n' +
  // Content-hashed site assets: a changed file always gets a new name.
  '/assets/*\n  cache-control: public, max-age=31536000, immutable\n');
// Self-hosted fonts (see @font-face in style.css).
const FONTS = {
  'jetbrains-mono-400.woff2': '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
  'jetbrains-mono-500.woff2': '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2',
  'source-serif-4.woff2': '@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2',
  'source-serif-4-italic.woff2': '@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-italic.woff2',
};
fs.mkdirSync(path.join(out, 'fonts'));
for (const [name, src] of Object.entries(FONTS)) fs.copyFileSync(path.join(root, 'node_modules', src), path.join(out, 'fonts', name));
// Service worker cache name = hash of the assets: every deploy that changes the UI makes a different
// sw.js, so phones install the new version without bumping a version number by hand.
const hash = crypto.createHash('sha256');
for (const f of ['app.js', 'xterm.js', 'xterm.css', ...shell]) hash.update(fs.readFileSync(path.join(agent, f)));
const sw = fs.readFileSync(path.join(root, 'web', 'sw.js'), 'utf8');
const stamped = sw.replace(/const CACHE = '[^']*';/, `const CACHE = 'snugcode-${hash.digest('hex').slice(0, 10)}';`);
if (stamped === sw) throw new Error('sw.js: line `const CACHE = ...` not found');
fs.writeFileSync(path.join(out, 'sw.js'), stamped);
// SHA-256 of every served file (build.json, attached to GitHub releases): anyone can compare the PWA served
// by the relay with a build from source (`npm ci && npm run build:web`). See docs/security.md.
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
console.log(`PWA (/agent/) → ${path.relative(root, out) || out} (build ${digest.slice(0, 16)})`);
