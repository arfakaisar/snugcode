// App lock (web/ui/lock.js) in Chromium with a virtual WebAuthn platform authenticator (CDP): turning it on from
// Account & appearance, the lock screen at start, a failed verification keeps the app locked (no PC shown), unlocking,
// and turning it off again.
//   Terminal 1: npm run build:web && npm run dev:relay
//   Terminal 2: npm run test:e2e:lock
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findBrowser } from '../daemon/browser.js';
import { setup, ok, RELAY } from './e2e-harness.mjs';

const { name: PCNAME, mem, cleanup } = await setup();
// WebAuthn needs a domain as the relying party ID (an IP address like 127.0.0.1 is rejected).
const URL_ = RELAY.replace('127.0.0.1', 'localhost');

const exe = process.env.CHROME || findBrowser();
if (!exe) throw new Error('Chrome/Chromium not found; set env CHROME to the browser path.');
const browser = await chromium.launch({ executablePath: exe, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
// The lock screen may come and go within milliseconds (the virtual authenticator answers at once): record it.
await page.addInitScript(() => {
  new MutationObserver(() => document.getElementById('lockscreen') && (window.__lockSeen = true)).observe(document, { childList: true, subtree: true });
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const done = async (code) => {
  await browser.close();
  cleanup?.();
  process.exit(code);
};
process.on('unhandledRejection', async (e) => {
  console.error('FAILED:', e?.message || e);
  console.log((await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 800));
  await done(1);
});

const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

await page.goto(URL_ + '/agent/');
await page.waitForSelector('text=Sign in with GitHub');
await page.evaluate((kv) => { for (const [k, v] of kv) localStorage.setItem(k, v); }, [...mem.entries()]);
await page.reload();
await page.waitForSelector('text=' + PCNAME);

// Turn the lock on.
await page.locator('[aria-label="Account"]').first().click();
await page.locator('text=App lock').click();
await page.waitForFunction(() => !!JSON.parse(localStorage.getItem('pc.lock') || 'null')?.id);
ok('app lock turned on with the phone\'s screen lock (platform authenticator)');

// Start: the lock screen asks first, then the app opens.
await page.reload();
await page.waitForSelector('text=' + PCNAME, { timeout: 15000 });
assert.ok(await page.evaluate(() => window.__lockSeen), 'the lock screen showed first');
assert.equal(await page.locator('#lockscreen').count(), 0);
ok('start: unlocked by the screen lock, then the PC list shows');

// Verification fails: still locked, nothing from the account shows.
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await page.reload();
await page.waitForSelector('#lockscreen');
await page.waitForFunction(() => /didn’t confirm|Cancelled|not allowed/i.test(document.querySelector('#lockscreen [role=status]')?.textContent || ''), null, { timeout: 15000 });
assert.ok(!(await page.locator('text=' + PCNAME).count()), 'no PC visible while locked');
ok('failed verification: the app stays locked and shows no PCs');

await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
await page.locator('#lockscreen button').click();
await page.waitForSelector('text=' + PCNAME, { timeout: 15000 });
ok('Unlock button: the app opens');

// Turn it off (needs the screen lock too).
await page.locator('[aria-label="Account"]').first().click();
await page.locator('text=App lock').click();
await page.waitForFunction(() => !localStorage.getItem('pc.lock'));
ok('app lock turned off');

assert.deepEqual(errors, []);
console.log('ALL OK');
await done(0);
