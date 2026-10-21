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

// File explorer: daftar folder (penanda git), lihat & edit file dari HP
const openTool = async (label) => {
  await page.click('[aria-label="Lampiran & alat"]');
  await page.locator('#sheet:not([hidden]) .tile', { hasText: label }).click();
};
await openTool('File');
await page.waitForSelector('#sheet:not([hidden]) .frow >> text=hasil.txt');
assert.equal(await page.locator('.frow', { hasText: 'hasil.txt' }).locator('.fm').textContent(), 'A');
await page.locator('.frow', { hasText: 'hasil.txt' }).click();
await page.waitForSelector('.codeview .cl');
await shot('11-file');
await page.locator('#sheet:not([hidden]) .chip', { hasText: 'Edit' }).click();
await page.fill('textarea.editor', 'baris satu\nbaris dua dari HP\n');
await page.locator('#sheet:not([hidden]) button', { hasText: 'Simpan' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.codeview .lt')].map((x) => x.textContent).join('|') === 'baris satu|baris dua dari HP');
assert.equal(fs.readFileSync(path.join(repo, 'hasil.txt'), 'utf8'), 'baris satu\nbaris dua dari HP\n');
ok('file explorer: penanda git, lihat file bernomor baris, edit & simpan dari HP');
// Review diff: komentar per baris lalu batalkan file baru
await page.locator('#sheet:not([hidden]) [aria-label="Kembali"]').click();
await closeSheet();
await page.click('[aria-label="Git"]');
await page.locator('#sheet:not([hidden]) button', { hasText: 'Lihat diff' }).click();
await page.waitForSelector('.difffile .dl');
await page.locator('.dl', { hasText: 'baris dua dari HP' }).click();
await page.fill('.cbox2 textarea', 'Ganti jadi bahasa Inggris');
await page.locator('.cbox2 button', { hasText: 'Tambah' }).click();
await page.waitForSelector('.cmt >> text=Ganti jadi bahasa Inggris');
await page.waitForSelector('.sheetfoot >> text=1 komentar');
await shot('12-review');
await page.locator('.sheetfoot button', { hasText: 'Hapus' }).click();
await page.waitForSelector('.difffile .dl');
await page.locator('.difffile .chip', { hasText: 'Hapus file baru' }).click();
await page.locator('#sheet:not([hidden]) .confirm button', { hasText: 'Batalkan perubahan' }).click();
await page.waitForSelector('#sheet:not([hidden]) >> text=Tidak ada perubahan.');
assert.ok(!fs.existsSync(path.join(repo, 'hasil.txt')));
await closeSheet();
ok('review diff: komentar per baris (kirim ke agen), batalkan perubahan file dari HP');
// Terminal interaktif: shell di worktree, output, ditutup layarnya lalu dibuka lagi (riwayat terputar ulang)
await openTool('Terminal');
await page.waitForSelector('.termview .xterm-rows');
await page.waitForFunction(() => document.querySelector('.termview .xterm-rows')?.textContent.trim().length > 0, null, { timeout: 15000 });
await page.click('.termview .tscreen');
// Prompt pendek: baris perintah tidak terbungkus di lebar HP (prompt runner CI panjang), jadi isi baris bisa dicocokkan.
await page.keyboard.type("PS1='$ '");
await page.keyboard.press('Enter');
await page.keyboard.type('echo snug-$((6*7))');
await page.keyboard.press('Enter');
await page.waitForFunction(() => /snug-42/.test(document.querySelector('.termview .xterm-rows')?.textContent || ''), null, { timeout: 15000 });
await shot('13-terminal');
// Keyboard Android (Gboard): setiap huruf = keydown 229 + komposisi IME. Ketikan harus langsung sampai
// ke shell (dulu baru terkirim setelah spasi/Enter, jadi layar tampak diam), termasuk Backspace lewat
// IME, koreksi otomatis, dan Enter di tengah komposisi — tanpa huruf ganda.
{
  const cdp = await page.context().newCDPSession(page);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('.termview .xterm-rows > div')].map((d) => d.textContent.trimEnd()).join('\n'));
  const waitLine = (re) => page.waitForFunction((src) => [...document.querySelectorAll('.termview .xterm-rows > div')].some((d) => new RegExp(src).test(d.textContent.trimEnd())), re.source, { timeout: 10000 });
  const ime = async (text) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Unidentified' });
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 229, key: 'Unidentified' });
  };
  // Keyboard fisik/emulasi di atas tidak ikut terkirim ganda oleh penangan IME (spasi lewat keypress)
  assert.match(await rows(), /^\$ echo snug-\$\(\(6\*7\)\)$/m);
  for (const w of ['e', 'ec', 'ech', 'echo']) await ime(w);
  await waitLine(/[$#] echo$/);
  await cdp.send('Input.insertText', { text: 'echo ' });
  // "andorid" dikoreksi jadi "android" oleh keyboard, lalu huruf terakhir dihapus & diganti
  for (const w of ['a', 'an', 'and', 'ando', 'andor', 'andori', 'andorid', 'android', 'androi', 'android7']) await ime(w);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await waitLine(/^android7$/);
  assert.doesNotMatch(await rows(), /echoecho|android7android7/);
  await cdp.detach();
  // Tombol Tempel: isi clipboard dikirim ke shell (menekan lama layar xterm di HP tidak memberi menu Tempel).
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('echo tempel-$((2+3))\n'));
  await page.locator('.termview .tk', { hasText: 'Tempel' }).click();
  await waitLine(/tempel-\$\(\(2\+3/);
  // Bash memakai bracketed paste: baris baru hasil tempel tidak langsung menjalankan perintah.
  await page.keyboard.press('Enter');
  await waitLine(/^tempel-5$/);
  // Tombol Salin tanpa seleksi: seluruh isi layar terminal masuk clipboard
  await page.locator('.termview .tk', { hasText: 'Salin' }).click();
  await page.waitForSelector('.toast >> text=Isi layar disalin');
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^tempel-5$/m);
}
await page.click('.termview [aria-label="Tutup layar terminal"]');
await page.waitForSelector('.termview', { state: 'detached' });
await openTool('Terminal');
await page.waitForFunction(() => /snug-42/.test(document.querySelector('.termview .xterm-rows')?.textContent || ''), null, { timeout: 15000 });
await page.click('.termview .ttab.on .tx');
await page.locator('#sheet:not([hidden]) .confirm button', { hasText: 'Tutup' }).click();
await page.waitForSelector('.termview .tempty:not([hidden])');
await page.click('.termview [aria-label="Tutup layar terminal"]');
await page.waitForSelector('.termview', { state: 'detached' });
ok('terminal: perintah dijalankan di PTY PC, tetap hidup saat layar ditutup, ditutup dari HP');

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
// Ukuran teks (pengganti zoom halaman yang dikunci): isi layar membesar tanpa elemen keluar layar
await page.click('#menuBtn');
await page.locator('#drawerPanel .dme').click();
await page.locator('#sheet:not([hidden]) .seg button[aria-label="Sangat besar"]').click();
assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#view')).zoom), '1.3');
await shot('14-teks-besar');
await closeSheet();
const overflowBig = await page.evaluate(() => [...document.querySelectorAll('#view *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.className || el.tagName));
assert.deepEqual(overflowBig, [], 'teks besar: elemen melewati lebar layar');
ok('ukuran teks: Sangat besar diterapkan ke isi layar, tetap muat lebar HP');
await page.locator('#view >> text=' + path.basename(repo)).first().click();
await page.locator('text=' + path.basename(repo)).first().click();
await page.waitForFunction(() => document.querySelectorAll('.donel').length === 3, null, { timeout: 20000 });
const replay = await page.evaluate(() => ({ done: document.querySelectorAll('.donel').length, todo: document.querySelectorAll('#term .col > .todo').length, h3: document.querySelectorAll('.ln.txt h3').length }));
assert.deepEqual(replay, { done: 3, todo: 1, h3: 12 });
ok('buka ulang sesi: riwayat diputar ulang tanpa duplikat ' + JSON.stringify(replay));

// Ukuran teks dipasang theme.js sebelum render pertama (tanpa kedip), lalu dikembalikan ke Normal
await page.reload();
assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-scale')), '1.3');
await page.evaluate(() => localStorage.removeItem('pc.textScale'));

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
