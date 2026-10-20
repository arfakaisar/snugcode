// Uji ketahanan koneksi PWA saat HP kembali dari latar belakang: jaringan yang "menelan" paket (soket
// lama setengah mati, koneksi baru tertahan tanpa jawaban) tidak boleh membuat layar macet di
// "Menghubungi relay". PWA dibuka lewat proxy TCP lokal yang bisa diatur:
//   pass     : meneruskan apa adanya
//   tarpit   : koneksi WebSocket BARU diterima tapi tidak pernah dijawab (tertahan di CONNECTING)
//   blackhole: semua koneksi yang ADA berhenti meneruskan data tanpa menutup (soket setengah mati)
//   Terminal 1: npm run build:web && npm run dev:relay
//   Terminal 2: npm run test:e2e:resume
import net from 'node:net';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findBrowser } from '../daemon/browser.js';
import { setup, ok, sleep, RELAY } from './e2e-harness.mjs';

const { name: PCNAME, repo, mem, cleanup } = await setup();
const target = new URL(RELAY);

let mode = 'pass';
/** @type {Set<{ c: net.Socket, u: net.Socket, dead: boolean }>} */
const links = new Set();
const proxy = net.createServer((c) => {
  c.on('error', () => {});
  c.once('data', (first) => {
    // Tertahan hanya untuk WebSocket: halaman & API tetap termuat (seperti daftar PC yang tampil online).
    if (mode === 'tarpit' && /^upgrade:\s*websocket/im.test(first.toString('latin1'))) return links.add({ c, u: null, dead: true });
    const u = net.connect(+target.port, target.hostname);
    const l = { c, u, dead: false };
    links.add(l);
    u.write(first);
    c.on('data', (d) => !l.dead && u.write(d));
    u.on('data', (d) => !l.dead && c.write(d));
    const end = () => (c.destroy(), u.destroy(), links.delete(l));
    c.on('close', end);
    u.on('close', end).on('error', end);
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${proxy.address().port}`;
const blackhole = () => links.forEach((l) => (l.dead = true));

const exe = process.env.CHROME || findBrowser();
if (!exe) throw new Error('Chrome/Chromium tidak ditemukan; set env CHROME ke path browsernya.');
const browser = await chromium.launch({ executablePath: exe, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const fail = async (m) => {
  console.log('GAGAL:', m);
  console.log((await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 800));
  await browser.close();
  cleanup?.();
  process.exit(1);
};
// Tersambung penuh = titik status hijau (kanal terenkripsi siap) dan daftar sesi tampil.
const ready = (ms) =>
  page
    .waitForFunction((name) => document.querySelector('#dot')?.className === 'on' && document.body.innerText.includes(name), repo.split('/').pop(), { timeout: ms })
    .then(() => true)
    .catch(() => false);
// Aplikasi kembali terlihat (di HP: visibilitychange setelah dibuka dari latar belakang).
const resume = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

await page.goto(URL_ + '/');
await page.evaluate((kv) => { for (const [k, v] of kv) localStorage.setItem(k, v); }, [...mem.entries()]);
await page.reload();
await page.locator('text=' + PCNAME).first().click();
if (!(await ready(20000))) await fail('PC tidak terbuka');
ok('PWA tersambung lewat proxy');

// 1) HP tidur: soket lama setengah mati, koneksi baru tertahan. Jaringan pulih lalu aplikasi dibuka lagi.
blackhole();
mode = 'tarpit';
await sleep(3000);
await resume();
// Probe ping tidak dijawab → soket lama dilepas, soket baru tertahan.
await page.waitForFunction(() => document.querySelector('#dot')?.className !== 'on', null, { timeout: 10000 }).catch(() => fail('soket setengah mati tidak terdeteksi'));
await sleep(6000);
mode = 'pass';
await resume();
let t0 = Date.now();
if (!(await ready(25000))) await fail('tidak pulih setelah soket setengah mati');
ok(`soket setengah mati + koneksi tertahan: pulih ${((Date.now() - t0) / 1000).toFixed(1)} dtk setelah jaringan kembali`);

// 2) Aplikasi dimuat ulang (dibuang OS / versi baru) saat koneksi baru masih tertahan: tidak boleh
//    macet di "Menghubungi relay" setelah jaringan pulih.
mode = 'tarpit';
await page.reload();
await page.waitForSelector('text=Menghubungi relay', { timeout: 15000 });
await sleep(4000);
mode = 'pass';
t0 = Date.now();
if (!(await ready(30000))) await fail('macet di "Menghubungi relay" walau jaringan sudah pulih');
ok(`muat ulang saat koneksi tertahan: pulih ${((Date.now() - t0) / 1000).toFixed(1)} dtk setelah jaringan kembali`);

// 3) Tombol "Coba lagi" muncul bila menyambung terlalu lama (bukan spinner tanpa akhir).
mode = 'tarpit';
await page.reload();
await page.waitForSelector('text=Coba sekarang', { timeout: 30000 }).catch(() => fail('tidak ada tombol coba lagi'));
mode = 'pass';
t0 = Date.now();
await page.locator('text=Coba sekarang').click();
if (!(await ready(10000))) await fail('"Coba sekarang" tidak menyambung');
ok(`menyambung lama: tombol "Coba sekarang" tampil dan langsung menyambung (${((Date.now() - t0) / 1000).toFixed(1)} dtk)`);

assert.deepEqual(errors, []);
await browser.close();
proxy.close();
for (const l of links) (l.c.destroy(), l.u?.destroy());
cleanup?.();
console.log('SEMUA OK');
process.exit(0);
