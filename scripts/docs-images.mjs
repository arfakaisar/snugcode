// Gambar README (docs/images) dari UI asli: PWA hasil build di Chromium terhadap daemon + mock 9router
// (test/e2e-harness.mjs), tema gelap, data contoh. Hero & TUI dirender dari docs/mockups/*.html.
//   Terminal 1: npm run build:web && npm run dev:relay
//   Terminal 2: npm run docs:images
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../daemon/browser.js';
import { setup, RELAY } from '../test/e2e-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const PC = 'Laptop Arfa';
const { repo, mem, conn, s: sess, cleanup } = await setup({ name: PC });
await conn.call('edits', { id: sess.id, on: true }); // dok izin Write ikut tampil
// Dev server kecil untuk layar Run & Preview.
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'toko-kopi', scripts: { dev: 'node server.js' } }));
fs.writeFileSync(path.join(repo, 'server.js'), "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT || 5173);\n");

const browser = await chromium.launch({ executablePath: process.env.CHROME || findBrowser() });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'dark' });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Data contoh yang lebih enak dibaca daripada nama acak dari harness.
const REPO = path.basename(repo);
const swaps = [
  [`lokal/${REPO}`, 'arfakaisar/toko-kopi'],
  [REPO, 'toko-kopi'],
  ['buat TODOS', 'Tambahkan dark mode ke halaman pengaturan'],
  ['tolong WRITE file', 'Simpan pilihan tema ke localStorage'],
  ['claude-mock-1', 'claude-opus-5-5'],
  ['claude-mock-2', 'claude-sonnet-5-5'],
  ['tester', 'arfakaisar'],
  ['master', 'main'],
];
const tidy = () =>
  page.evaluate((swaps) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) for (const [a, b] of swaps) if (n.nodeValue.includes(a)) n.nodeValue = n.nodeValue.split(a).join(b);
  }, swaps);
const shot = async (name, wait = 1200) => {
  await page.waitForTimeout(wait);
  await tidy();
  await page.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: 86 });
  console.log('✔ ' + name);
};
const closeSheet = async () => {
  await page.locator('#sheet:not([hidden]) [aria-label="Tutup"]').first().click();
  await page.waitForSelector('#sheet', { state: 'hidden' });
};

try {
  await page.goto(RELAY + '/');
  await page.waitForSelector('text=Login dengan GitHub');
  await shot('login', 1600);
  await page.evaluate((kv) => { for (const [k, v] of kv) localStorage.setItem(k, v); }, [...mem.entries()]);
  await page.reload();
  await page.locator('text=' + PC).first().click();
  await page.locator('#view >> text=' + REPO).first().click();
  await page.waitForSelector('#input');

  await page.fill('#input', 'buat TODOS');
  await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.donel').length >= 1, null, { timeout: 30000 });
  await page.fill('#input', 'tolong WRITE file');
  await page.click('#send');
  await page.waitForSelector('#dock .perm', { timeout: 30000 });
  await shot('session');
  await page.locator('#dock button', { hasText: 'Izinkan' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.donel').length >= 2, null, { timeout: 30000 });

  await page.click('[aria-label="Git"]');
  await page.waitForSelector('#sheet:not([hidden]) >> text=hasil.txt', { timeout: 15000 });
  await shot('git');
  await closeSheet();
  await page.click('[aria-label="Ganti model"]');
  await page.waitForSelector('#sheet:not([hidden]) .model.sel');
  await shot('model');
  await closeSheet();
  await page.click('[aria-label="Jalankan & preview"]');
  await page.locator('#sheet button', { hasText: 'Jalankan' }).click();
  await page.waitForSelector('#sheet .proc.on >> text=/port \\d+/', { timeout: 90000 });
  await shot('run');
  await closeSheet();

  await page.click('#menuBtn');
  await page.locator('#drawerPanel button', { hasText: 'Beranda' }).click();
  await page.waitForSelector('#view .card.sess');
  await shot('sessions', 1500);
} finally {
  await page.close();
}

// Hero & TUI dari mockup HTML (memakai ikon dan gambar ponsel yang baru dibuat).
for (const [name, w, h] of [['hero', 1280, 640], ['tui', 820, 960]]) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(path.join(ROOT, 'docs', 'mockups', name + '.html')).href);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: 88 });
  await p.close();
  console.log('✔ ' + name);
}
await browser.close();
if (errors.length) console.log('error JavaScript:', errors);
await cleanup().catch(() => {});
process.exit(errors.length ? 1 : 0);
