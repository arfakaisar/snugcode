// End-to-end UI test: the built PWA (relay/public) in a real Chromium + the TUI in a
// pseudo-terminal, against the real daemon and a mock 9router (see e2e-harness.mjs). Checks the
// login/PC list/session screens, permission dock, plan card, streaming markdown, git/model/run/menu sheets,
// history replay without duplicates, and no JavaScript errors.
//   Terminal 1: npm run build:web && npm run dev:relay
//   Terminal 2: npm run test:ui              (SHOTS=folder to save screenshots)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findBrowser } from '../daemon/browser.js';
import { setup, ok, RELAY, routerLog } from './e2e-harness.mjs';

const { name: PCNAME, HOME, repo, cleanEnv, mem, conn, s: sess, cleanup } = await setup();
// The Write permission dock is tested through edit review mode (by default worktree edits apply directly).
await conn.call('edits', { id: sess.id, on: true });
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const exe = process.env.CHROME || findBrowser();
if (!exe) throw new Error('Chrome/Chromium not found; set env CHROME to the browser path.');
const browser = await chromium.launch({ executablePath: exe, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
process.on('uncaughtException', async (e) => {
  console.log('FAILED:', e.message.split('\n')[0]);
  try {
    await shot('failed');
    console.log((await page.evaluate(() => document.body.innerText)).slice(-1500));
  } catch {}
  console.log('errors', errors, '\nrouter', JSON.stringify(routerLog.slice(-4)));
  process.exit(1);
});
const shot = (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, n + '.png') });
const closeSheet = async () => {
  await page.locator('#sheet:not([hidden]) [aria-label="Close"]').first().click();
  await page.waitForSelector('#sheet', { state: 'hidden' });
};

// The login page shows without errors, then sign in with a token + an already paired device
await page.goto(RELAY + '/agent/');
await page.waitForSelector('text=Sign in with GitHub');
await page.evaluate((kv) => { for (const [k, v] of kv) localStorage.setItem(k, v); }, [...mem.entries()]);
await page.reload();
await page.waitForSelector('text=' + PCNAME);
await shot('1-pc');
ok('login screen & PC list');
await page.locator('text=' + PCNAME).first().click();
await page.waitForSelector('text=' + path.basename(repo), { timeout: 20000 });
await shot('2-sessions');
ok('PC opened: session list shown');
await page.locator('text=' + path.basename(repo)).first().click();
await page.waitForSelector('#input');

// Prompt from the UI: Write permission shows in the dock -> Allow -> the reply shows
// Long prompt = long session title: used below to make sure cards don't overflow the screen.
await page.fill('#input', 'please WRITE a file ' + 'and add dark mode to the settings page along with saving the theme choice '.repeat(3));
await page.click('#send');
await page.waitForSelector('#dock .perm', { timeout: 30000 });
await shot('3-permission');
await page.locator('#dock button', { hasText: 'Allow' }).click();
await page.waitForSelector('text=Finished writing the file.', { timeout: 30000 });
await page.waitForSelector('.donel');
ok('prompt from the UI: Write permission dock, Allow, reply & done summary');

// The plan (TodoWrite) is rendered from structured `todos`
await page.fill('#input', 'make TODOS');
await page.click('#send');
await page.waitForSelector('.todo .it.doing', { timeout: 30000 });
const todo = await page.evaluate(() => [...document.querySelectorAll('.todo .it')].map((x) => x.className.replace('it ', '') + ':' + x.textContent));
assert.deepEqual(todo, ['done:✓Read the code', 'doing:◐Change the button', 'todo:○Test']);
await page.waitForFunction(() => document.querySelectorAll('.donel').length >= 2, null, { timeout: 30000 });
ok('plan card: ' + todo.join(' | '));

// Long markdown is rendered incrementally
await page.fill('#input', 'please MARKDOWN');
await page.click('#send');
await page.waitForFunction(() => document.querySelectorAll('.donel').length >= 3, null, { timeout: 30000 });
const dom = await page.evaluate(() => {
  const t = [...document.querySelectorAll('.ln.txt')].at(-1);
  return { h3: t.querySelectorAll('h3').length, code: t.querySelectorAll('.code').length, li: t.querySelectorAll('li').length };
});
assert.deepEqual(dom, { h3: 12, code: 12, li: 24 });
await shot('4-markdown');
ok('streaming markdown: 12 headings, 12 code blocks, 24 items');

// Sheets: git, model, run, session menu, quick actions
await page.click('[aria-label="Git"]');
await page.waitForSelector('#sheet:not([hidden]) >> text=result.txt', { timeout: 15000 });
await shot('5-git');
await closeSheet();
await page.click('[aria-label="Change model"]');
await page.waitForSelector('#sheet:not([hidden])');
await page.waitForTimeout(800);
await shot('6-model');
await closeSheet();
await page.click('[aria-label="Run & preview"]');
await page.waitForSelector('#sheet:not([hidden])');
await page.waitForTimeout(500);
await shot('7-run');
await closeSheet();
await page.click('[aria-label="Session menu"]');
await page.waitForSelector('#sheet:not([hidden])');
await shot('8-menu');
await closeSheet();
await page.click('[aria-label="Attachments & tools"]');
await page.waitForSelector('#sheet:not([hidden]) >> text=Plan mode');
await page.waitForSelector('#sheet:not([hidden]) >> text=Explain this repo');
await shot('9-tools');
await closeSheet();
ok('git (result.txt visible), model, run, session menu, attachments & tools sheets open & close');

// File explorer: folder listing (git markers), view & edit a file from the phone
const openTool = async (label) => {
  await page.click('[aria-label="Attachments & tools"]');
  await page.locator('#sheet:not([hidden]) .tile', { hasText: label }).click();
};
await openTool('Files');
await page.waitForSelector('#sheet:not([hidden]) .frow >> text=result.txt');
assert.equal(await page.locator('.frow', { hasText: 'result.txt' }).locator('.fm').textContent(), 'A');
await page.locator('.frow', { hasText: 'result.txt' }).click();
await page.waitForSelector('.codeview .cl');
await shot('11-file');
await page.locator('#sheet:not([hidden]) .chip', { hasText: 'Edit' }).click();
await page.fill('textarea.editor', 'line one\nline two from the phone\n');
await page.locator('#sheet:not([hidden]) button', { hasText: 'Save' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.codeview .lt')].map((x) => x.textContent).join('|') === 'line one|line two from the phone');
assert.equal(fs.readFileSync(path.join(repo, 'result.txt'), 'utf8'), 'line one\nline two from the phone\n');
ok('file explorer: git markers, view a file with line numbers, edit & save from the phone');
// Diff review: per-line comment, then revert the new file
await page.locator('#sheet:not([hidden]) [aria-label="Back"]').click();
await closeSheet();
await page.click('[aria-label="Git"]');
await page.locator('#sheet:not([hidden]) button', { hasText: 'View diff' }).click();
await page.waitForSelector('.difffile .dl');
await page.locator('.dl', { hasText: 'line two from the phone' }).click();
await page.fill('.cbox2 textarea', 'Make this English');
await page.locator('.cbox2 button', { hasText: 'Add' }).click();
await page.waitForSelector('.cmt >> text=Make this English');
await page.waitForSelector('.sheetfoot >> text=1 comment');
await shot('12-review');
await page.locator('.sheetfoot button', { hasText: 'Clear' }).click();
await page.waitForSelector('.difffile .dl');
await page.locator('.difffile .chip', { hasText: 'Delete new file' }).click();
await page.locator('#sheet:not([hidden]) .confirm button', { hasText: 'Revert changes' }).click();
await page.waitForSelector('#sheet:not([hidden]) >> text=No changes.');
assert.ok(!fs.existsSync(path.join(repo, 'result.txt')));
await closeSheet();
ok('diff review: per-line comments (sent to the agent), revert file changes from the phone');
// Interactive terminal: shell in the worktree, output, screen closed then reopened (history replayed)
await openTool('Terminal');
await page.waitForSelector('.termview .xterm-rows');
await page.waitForFunction(() => document.querySelector('.termview .xterm-rows')?.textContent.trim().length > 0, null, { timeout: 15000 });
await page.click('.termview .tscreen');
// Short prompt: the command line doesn't wrap at phone width (CI runner prompts are long), so lines can be matched.
await page.keyboard.type("PS1='$ '");
await page.keyboard.press('Enter');
await page.keyboard.type('echo snug-$((6*7))');
await page.keyboard.press('Enter');
await page.waitForFunction(() => /snug-42/.test(document.querySelector('.termview .xterm-rows')?.textContent || ''), null, { timeout: 15000 });
await shot('13-terminal');
// Android keyboards (Gboard): each letter = keydown 229 + IME composition. Typing must reach the shell
// immediately (it used to be sent only after space/Enter, so the screen looked frozen), including Backspace
// through the IME, autocorrect, and Enter mid-composition — without doubled letters.
{
  const cdp = await page.context().newCDPSession(page);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('.termview .xterm-rows > div')].map((d) => d.textContent.trimEnd()).join('\n'));
  const waitLine = (re) => page.waitForFunction((src) => [...document.querySelectorAll('.termview .xterm-rows > div')].some((d) => new RegExp(src).test(d.textContent.trimEnd())), re.source, { timeout: 10000 });
  const ime = async (text) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Unidentified' });
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 229, key: 'Unidentified' });
  };
  // The physical/emulated keyboard above isn't sent twice by the IME handler (space via keypress)
  assert.match(await rows(), /^\$ echo snug-\$\(\(6\*7\)\)$/m);
  for (const w of ['e', 'ec', 'ech', 'echo']) await ime(w);
  await waitLine(/[$#] echo$/);
  await cdp.send('Input.insertText', { text: 'echo ' });
  // "andorid" is autocorrected to "android", then the last letter is deleted & replaced
  for (const w of ['a', 'an', 'and', 'ando', 'andor', 'andori', 'andorid', 'android', 'androi', 'android7']) await ime(w);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await waitLine(/^android7$/);
  assert.doesNotMatch(await rows(), /echoecho|android7android7/);
  await cdp.detach();
  // Paste button: clipboard contents go to the shell (long-pressing xterm on a phone gives no Paste menu).
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('echo pasted-$((2+3))\n'));
  await page.locator('.termview .tk', { hasText: 'Paste' }).click();
  await waitLine(/pasted-\$\(\(2\+3/);
  // Bash uses bracketed paste: a pasted newline doesn't run the command right away.
  await page.keyboard.press('Enter');
  await waitLine(/^pasted-5$/);
  // Copy button without a selection: the whole terminal screen goes to the clipboard
  await page.locator('.termview .tk', { hasText: 'Copy' }).click();
  await page.waitForSelector('.toast >> text=Screen copied');
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^pasted-5$/m);
}
await page.click('.termview [aria-label="Close terminal screen"]');
await page.waitForSelector('.termview', { state: 'detached' });
await openTool('Terminal');
await page.waitForFunction(() => /snug-42/.test(document.querySelector('.termview .xterm-rows')?.textContent || ''), null, { timeout: 15000 });
await page.click('.termview .ttab.on .tx');
await page.locator('#sheet:not([hidden]) .confirm button', { hasText: 'Close' }).click();
await page.waitForSelector('.termview .tempty:not([hidden])');
await page.click('.termview [aria-label="Close terminal screen"]');
await page.waitForSelector('.termview', { state: 'detached' });
ok('terminal: commands run in the PC PTY, stay alive when the screen closes, closed from the phone');

// Drawer: recent sessions, then Home -> reopen: history replayed without duplicates
await page.click('#menuBtn');
await page.waitForSelector('#drawerPanel .dsess.on');
await page.waitForTimeout(500);
await shot('10-drawer');
await page.locator('#drawerPanel button', { hasText: 'Home' }).click();
await page.waitForSelector('#drawer', { state: 'hidden' });
await page.waitForSelector('#view >> text=' + path.basename(repo));
ok('drawer: active session marked, Home returns to the session list');
const overflow = await page.evaluate(() => [...document.querySelectorAll('#view *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.className || el.tagName));
assert.deepEqual(overflow, [], 'elements overflow the screen width');
ok('long session title truncated cleanly, no element overflows the screen');
// Text size (replaces the locked page zoom): content grows without anything overflowing the screen
await page.click('#menuBtn');
await page.locator('#drawerPanel .dme').click();
await page.locator('#sheet:not([hidden]) .seg button[aria-label="Extra large"]').click();
assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#view')).zoom), '1.3');
await shot('14-large-text');
await closeSheet();
const overflowBig = await page.evaluate(() => [...document.querySelectorAll('#view *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.className || el.tagName));
assert.deepEqual(overflowBig, [], 'large text: elements overflow the screen width');
ok('text size: Extra large applied to the content, still fits the phone width');
await page.locator('#view >> text=' + path.basename(repo)).first().click();
await page.locator('text=' + path.basename(repo)).first().click();
await page.waitForFunction(() => document.querySelectorAll('.donel').length === 3, null, { timeout: 20000 });
const replay = await page.evaluate(() => ({ done: document.querySelectorAll('.donel').length, todo: document.querySelectorAll('#term .col > .todo').length, h3: document.querySelectorAll('.ln.txt h3').length }));
assert.deepEqual(replay, { done: 3, todo: 1, h3: 12 });
ok('reopen session: history replayed without duplicates ' + JSON.stringify(replay));

// theme.js applies the text size before the first render (no flash), then it is reset to Normal
await page.reload();
assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-scale')), '1.3');
await page.evaluate(() => localStorage.removeItem('pc.textScale'));

assert.deepEqual(errors, []);
ok('no JavaScript errors in the whole flow');
await browser.close();

// TUI in a pseudo-terminal: opens the repo folder session, replays history, then sends a prompt
const CLI = new URL('../daemon/cli.js', import.meta.url).pathname;
// `script` (util-linux/BSD) gives the TUI a real pseudo-terminal.
const tui = spawn('script', process.platform === 'darwin' ? ['-q', '/dev/null', process.execPath, CLI] : ['-qfec', `${process.execPath} ${CLI}`, '/dev/null'], { cwd: repo, env: { ...cleanEnv, SNUGCODE_HOME: HOME, TERM: 'xterm-256color', COLUMNS: '100', LINES: '40' }, stdio: ['pipe', 'pipe', 'pipe'] });
let tout = '';
tui.stdout.on('data', (d) => (tout += d));
tui.stderr.on('data', (d) => (tout += d));
const plain = () => tout.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
const waitOut = async (re, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (re.test(plain())) return;
  throw new Error('TUI did not show ' + re + '\n' + plain().slice(-1500));
};
await waitOut(/Done · 1 step/);
await waitOut(/Change the button/);
tui.stdin.write('hello from the tui');
await new Promise((r) => setTimeout(r, 300));
tui.stdin.write('\r');
await waitOut(/Hello from the mock router\./);
const doneLines = plain().match(/Done · [^\n]*/g) || [];
console.log('TUI done:', doneLines.at(-1));
tui.stdin.write('\x03');
await new Promise((r) => setTimeout(r, 800));
tui.kill('SIGKILL');
ok('TUI: history (plan & done summary) shown, prompt from the terminal answered');
await cleanup();
process.exit(0);
