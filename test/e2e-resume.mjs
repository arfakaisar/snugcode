// PWA connection resilience when the phone returns from the background: a network that "swallows" packets
// (old socket half-dead, new connections stalled with no reply) must not leave the screen stuck on
// "Contacting the relay". The PWA is opened through a controllable local TCP proxy:
//   pass     : meneruskan apa adanya
//   tarpit   : NEW WebSocket connections are accepted but never answered (stuck in CONNECTING)
//   blackhole: all EXISTING connections stop forwarding data without closing (half-dead sockets)
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
    // Stalls only WebSockets: the page & API still load (like a PC list that shows the PC online).
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
if (!exe) throw new Error('Chrome/Chromium not found; set env CHROME to the browser path.');
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
// Fully connected = green status dot (encrypted channel ready) and the session list shows.
const ready = (ms) =>
  page
    .waitForFunction((name) => document.querySelector('#dot')?.className === 'on' && document.body.innerText.includes(name), repo.split('/').pop(), { timeout: ms })
    .then(() => true)
    .catch(() => false);
// The app becomes visible again (on a phone: visibilitychange after returning from the background).
const resume = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

await page.goto(URL_ + '/agent/');
await page.evaluate((kv) => { for (const [k, v] of kv) localStorage.setItem(k, v); }, [...mem.entries()]);
await page.reload();
await page.locator('text=' + PCNAME).first().click();
if (!(await ready(20000))) await fail('PC did not open');
ok('PWA connected through the proxy');

// 1) Phone asleep: old socket half-dead, new connections stalled. The network recovers, then the app is reopened.
blackhole();
mode = 'tarpit';
await sleep(3000);
await resume();
// Unanswered ping probe → old socket dropped, new socket stalled.
await page.waitForFunction(() => document.querySelector('#dot')?.className !== 'on', null, { timeout: 10000 }).catch(() => fail('half-dead socket not detected'));
await sleep(6000);
mode = 'pass';
await resume();
let t0 = Date.now();
if (!(await ready(25000))) await fail('did not recover after a half-dead socket');
ok(`half-dead socket + stalled connection: recovered ${((Date.now() - t0) / 1000).toFixed(1)} s after the network came back`);

// 2) The app reloads (evicted by the OS / new version) while new connections are still stalled: it must not
//    get stuck on "Contacting the relay" after the network recovers.
mode = 'tarpit';
await page.reload();
await page.waitForSelector('text=Contacting the relay', { timeout: 15000 });
await sleep(4000);
mode = 'pass';
t0 = Date.now();
if (!(await ready(30000))) await fail('stuck on "Contacting the relay" even though the network recovered');
ok(`reload while the connection is stalled: recovered ${((Date.now() - t0) / 1000).toFixed(1)} s after the network came back`);

// 3) A "Try now" button shows when connecting takes too long (not an endless spinner).
mode = 'tarpit';
await page.reload();
await page.waitForSelector('text=Try now', { timeout: 30000 }).catch(() => fail('no try-again button'));
mode = 'pass';
t0 = Date.now();
await page.locator('text=Try now').click();
if (!(await ready(10000))) await fail('"Try now" did not connect');
ok(`slow connect: the "Try now" button shows and connects right away (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

assert.deepEqual(errors, []);
await browser.close();
proxy.close();
for (const l of links) (l.c.destroy(), l.u?.destroy());
cleanup?.();
console.log('ALL OK');
process.exit(0);
