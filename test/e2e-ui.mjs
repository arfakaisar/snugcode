// Uji end-to-end antarmuka: PWA hasil build (relay/public) di Chromium sungguhan + TUI di
// pseudo-terminal, terhadap daemon asli dan mock 9router (lihat e2e-harness.mjs). Memeriksa layar
// login/daftar PC/sesi, dok izin, kartu rencana, markdown streaming, sheet git/model/run/menu,
// pemutaran ulang riwayat tanpa duplikat, dan tidak ada error JavaScript.
//   Terminal 1: npm run build:web && npm run dev:relay
//   Terminal 2: npm run test:ui              (SHOTS=folder untuk menyimpan tangkapan layar)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findBrowser } from '../daemon/browser.js';
import { setup, ok, RELAY, routerLog } from './e2e-harness.mjs';

const { name: PCNAME, HOME, repo, cleanEnv, mem, conn, s: sess, cleanup } = await setup();
// Dok izin Write diuji lewat mode tinjau edit (bawaannya edit di worktree langsung diterapkan).
await conn.call('edits', { id: sess.id, on: true });
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const exe = process.env.CHROME || findBrowser();
if (!exe) throw new Error('Chrome/Chromium tidak ditemukan; set env CHROME ke path browsernya.');
const browser = await chromium.launch({ executablePath: exe, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
process.on('uncaughtException', async (e) => {
  console.log('GAGAL:', e.message.split('\n')[0]);
  try {
    await shot('gagal');
    console.log((await page.evaluate(() => document.body.innerText)).slice(-1500));
  } catch {}
  console.log('errors', errors, '\nrouter', JSON.stringify(routerLog.slice(-4)));
  process.exit(1);
});
const shot = (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, n + '.png') });
const closeSheet = async () => {
  await page.locator('#sheet:not([hidden]) [aria-label="Tutup"]').first().click();
  await page.waitForSelector('#sheet', { state: 'hidden' });
};

// Halaman login tampil tanpa error, lalu masuk dengan token + perangkat yang sudah dipasangkan
await page.goto(RELAY + '/');
await page.waitForSelector('text=Login dengan GitHub');
await page.evaluate((kv) => { for (const [k, v] of kv) localStorage.setItem(k, v); }, [...mem.entries()]);
await page.reload();
await page.waitForSelector('text=' + PCNAME);
await shot('1-pc');
ok('layar login & daftar PC');
await page.locator('text=' + PCNAME).first().click();
await page.waitForSelector('text=' + path.basename(repo), { timeout: 20000 });
await shot('2-sesi');
ok('PC dibuka: daftar sesi tampil');
await page.locator('text=' + path.basename(repo)).first().click();
await page.waitForSelector('#input');

// Prompt lewat UI: izin Write muncul di dok -> Izinkan -> jawaban tampil
// Prompt panjang = judul sesi panjang: dipakai di bawah untuk memastikan kartu tidak melebar keluar layar.
await page.fill('#input', 'tolong WRITE file ' + 'dan tambahkan dark mode di halaman pengaturan beserta penyimpanan pilihan tema '.repeat(3));
await page.click('#send');
await page.waitForSelector('#dock .perm', { timeout: 30000 });
await shot('3-izin');
await page.locator('#dock button', { hasText: 'Izinkan' }).click();
await page.waitForSelector('text=Selesai menulis file.', { timeout: 30000 });
await page.waitForSelector('.donel');
ok('prompt dari UI: dok izin Write, Izinkan, jawaban & ringkasan selesai');

// Rencana (TodoWrite) dirender dari `todos` terstruktur
await page.fill('#input', 'buat TODOS');
await page.click('#send');
await page.waitForSelector('.todo .it.doing', { timeout: 30000 });
const todo = await page.evaluate(() => [...document.querySelectorAll('.todo .it')].map((x) => x.className.replace('it ', '') + ':' + x.textContent));
assert.deepEqual(todo, ['done:✓Baca kode', 'doing:◐Ubah tombol', 'todo:○Uji']);
await page.waitForFunction(() => document.querySelectorAll('.donel').length >= 2, null, { timeout: 30000 });
ok('kartu rencana: ' + todo.join(' | '));

// Markdown panjang dirender bertahap
await page.fill('#input', 'tolong MARKDOWN');
await page.click('#send');
await page.waitForFunction(() => document.querySelectorAll('.donel').length >= 3, null, { timeout: 30000 });
const dom = await page.evaluate(() => {
  const t = [...document.querySelectorAll('.ln.txt')].at(-1);
  return { h3: t.querySelectorAll('h3').length, code: t.querySelectorAll('.code').length, li: t.querySelectorAll('li').length };
});
assert.deepEqual(dom, { h3: 12, code: 12, li: 24 });
await shot('4-markdown');
ok('markdown streaming: 12 judul, 12 blok kode, 24 item');

// Sheet: git, model, run, menu sesi, aksi cepat
await page.click('[aria-label="Git"]');
await page.waitForSelector('#sheet:not([hidden]) >> text=hasil.txt', { timeout: 15000 });
await shot('5-git');
await closeSheet();
await page.click('[aria-label="Ganti model"]');
await page.waitForSelector('#sheet:not([hidden])');
await page.waitForTimeout(800);
await shot('6-model');
await closeSheet();
await page.click('[aria-label="Jalankan & preview"]');
await page.waitForSelector('#sheet:not([hidden])');
await page.waitForTimeout(500);
await shot('7-run');
await closeSheet();
await page.click('[aria-label="Menu sesi"]');
await page.waitForSelector('#sheet:not([hidden])');
await shot('8-menu');
await closeSheet();
await page.click('[aria-label="Lampiran & alat"]');
await page.waitForSelector('#sheet:not([hidden]) >> text=Mode rencana');
await page.waitForSelector('#sheet:not([hidden]) >> text=Jelaskan repo ini');
await shot('9-alat');
await closeSheet();
ok('sheet git (file hasil.txt terlihat), model, run, menu sesi, lampiran & alat terbuka & tertutup');

// Drawer: daftar sesi terbaru, lalu Beranda -> buka lagi: riwayat diputar ulang tanpa duplikat
await page.click('#menuBtn');
await page.waitForSelector('#drawerPanel .dsess.on');
await page.waitForTimeout(500);
await shot('10-drawer');
await page.locator('#drawerPanel button', { hasText: 'Beranda' }).click();
await page.waitForSelector('#drawer', { state: 'hidden' });
await page.waitForSelector('#view >> text=' + path.basename(repo));
ok('drawer: sesi aktif ditandai, Beranda kembali ke daftar sesi');
const overflow = await page.evaluate(() => [...document.querySelectorAll('#view *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.className || el.tagName));
assert.deepEqual(overflow, [], 'elemen melewati lebar layar');
ok('judul sesi panjang terpotong rapi, tidak ada elemen keluar layar');
await page.locator('#view >> text=' + path.basename(repo)).first().click();
await page.locator('text=' + path.basename(repo)).first().click();
await page.waitForFunction(() => document.querySelectorAll('.donel').length === 3, null, { timeout: 20000 });
const replay = await page.evaluate(() => ({ done: document.querySelectorAll('.donel').length, todo: document.querySelectorAll('#term .col > .todo').length, h3: document.querySelectorAll('.ln.txt h3').length }));
assert.deepEqual(replay, { done: 3, todo: 1, h3: 12 });
ok('buka ulang sesi: riwayat diputar ulang tanpa duplikat ' + JSON.stringify(replay));

assert.deepEqual(errors, []);
ok('tanpa error JavaScript di seluruh alur');
await browser.close();

// TUI di pseudo-terminal: membuka sesi folder repo, memutar ulang riwayat, lalu kirim prompt
const CLI = new URL('../daemon/cli.js', import.meta.url).pathname;
// `script` (util-linux/BSD) memberi TUI pseudo-terminal sungguhan; dilewati bila tidak tersedia.
const tui = spawn('script', process.platform === 'darwin' ? ['-q', '/dev/null', process.execPath, CLI] : ['-qfec', `${process.execPath} ${CLI}`, '/dev/null'], { cwd: repo, env: { ...cleanEnv, SNUGCODE_HOME: HOME, TERM: 'xterm-256color', COLUMNS: '100', LINES: '40' }, stdio: ['pipe', 'pipe', 'pipe'] });
let tout = '';
tui.stdout.on('data', (d) => (tout += d));
tui.stderr.on('data', (d) => (tout += d));
const plain = () => tout.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
const waitOut = async (re, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (re.test(plain())) return;
  throw new Error('TUI tidak menampilkan ' + re + '\n' + plain().slice(-1500));
};
await waitOut(/Selesai · 1 langkah/);
await waitOut(/Ubah tombol/);
tui.stdin.write('halo dari tui');
await new Promise((r) => setTimeout(r, 300));
tui.stdin.write('\r');
await waitOut(/Halo dari mock router\./);
const doneLines = plain().match(/Selesai · [^\n]*/g) || [];
console.log('TUI done:', doneLines.at(-1));
tui.stdin.write('\x03');
await new Promise((r) => setTimeout(r, 800));
tui.kill('SIGKILL');
ok('TUI: riwayat (rencana & ringkasan selesai) tampil, prompt dari terminal dijawab');
await cleanup();
process.exit(0);
