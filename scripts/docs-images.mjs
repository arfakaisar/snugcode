// README images & GIFs (docs/images) from the real UI: the built PWA in Chromium against the real daemon +
// a mock 9router (test/e2e-harness.mjs) that plays the agent scenarios below. Every screenshot is made
// in the dark & light themes; GIFs are recorded from the same screens and encoded with gifenc.
// The hero & terminal are rendered from docs/mockups/*.html.
//   Terminal 1: npm run build:web && npm run dev:relay
//   Terminal 2: npm run docs:images            (ONLY=hero,tui for the mockups only)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../daemon/browser.js';
import { setup, RELAY, sleep } from '../test/e2e-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const PC = 'Laptop Arfa';
fs.mkdirSync(OUT, { recursive: true });

// ---------- agent scenarios (mock 9router replies) ----------
let nMsg = 0;
// blocks: string = text (streamed in pieces), { tool, input } = tool_use.
function msg(model, blocks, out = 180) {
  const ev = [{ type: 'message_start', message: { id: 'msg_doc' + ++nMsg, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, cache_read_input_tokens: 17200, output_tokens: 1 } } }];
  let tool = false;
  blocks.forEach((b, index) => {
    if (typeof b === 'string') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const t of b.match(/[\s\S]{1,5}/g)) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } });
    } else {
      tool = true;
      ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'toolu_doc' + nMsg + '_' + index, name: b.tool, input: {} } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: out } });
  ev.push({ type: 'message_stop' });
  return ev;
}

const todos = (done, active) =>
  ['Read the settings page', 'Add a dark theme toggle', 'Save the choice to localStorage', 'Run the tests'].map((content, i) => ({
    content,
    activeForm: content.replace(/^Read/, 'Reading').replace(/^Add/, 'Adding').replace(/^Save/, 'Saving').replace(/^Run/, 'Running'),
    status: i < done ? 'completed' : i === active ? 'in_progress' : 'pending',
  }));

const SETTINGS_OLD = `      </section>
    </main>`;
const SETTINGS_NEW = `      </section>
      <section>
        <h2>Appearance</h2>
        <Toggle label="Dark theme" checked={theme === 'dark'}
          onChange={(on) => setTheme(on ? 'dark' : 'light')} />
      </section>
    </main>`;
const USE_THEME = `import { useEffect, useState } from 'react';

const KEY = 'toko-kopi:theme';

export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem(KEY) || 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(KEY, theme);
  }, [theme]);
  return [theme, setTheme];
}
`;

const SCENES = [
  {
    key: 'dark mode',
    delay: 28,
    steps: (cwd) => [
      ['Let me check the settings page and how themes are used in the app first.', { tool: 'TodoWrite', input: { todos: todos(0, 0) } }],
      [{ tool: 'Read', input: { file_path: cwd + '/src/pages/Settings.jsx' } }],
      [{ tool: 'TodoWrite', input: { todos: todos(1, 1) } }],
      [{ tool: 'Edit', input: { file_path: cwd + '/src/pages/Settings.jsx', old_string: SETTINGS_OLD, new_string: SETTINGS_NEW } }],
      [{ tool: 'Write', input: { file_path: cwd + '/src/hooks/useTheme.js', content: USE_THEME } }],
      [{ tool: 'TodoWrite', input: { todos: todos(3, 3) } }],
      [{ tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }],
      [{ tool: 'TodoWrite', input: { todos: todos(4, -1) } }],
      [
        'Dark mode is now on the **settings page**.\n\n' +
          '- A new *Dark theme* toggle in the **Appearance** section\n' +
          '- The choice is saved to `localStorage` by the `useTheme` hook and restored when the page loads\n' +
          '- All **6 tests pass**\n\n' +
          'Want me to make a commit and a pull request too?',
      ],
    ],
  },
  { key: 'navbar', delay: 4, steps: () => [['The navbar now turns into a hamburger menu below `768px`, and the active link is underlined.']] },
  { key: 'report', delay: 220, steps: () => [['I started from the `transactions` table schema, then added a `GET /reports/daily` endpoint that groups sales by hour. '.repeat(4)]] },
];

const userText = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
const isPrompt = (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
let TOKO_DIR = '';
function reply({ model, msgs, body }) {
  if (!body.tools?.length) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!isPrompt(msgs[i])) continue;
    const scene = SCENES.find((s) => userText(msgs[i]).includes(s.key));
    if (!scene) return null;
    const step = msgs.slice(i + 1).filter((m) => m.role === 'assistant').length;
    const steps = scene.steps(TOKO_DIR);
    return { events: msg(model, steps[Math.min(step, steps.length - 1)]), delay: scene.delay };
  }
  return null;
}

// ---------- sample repos ----------
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Arfa', '-c', 'user.email=arfa@example.com', ...a], { cwd, stdio: 'pipe' });
function writeTree(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
}
const SITE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Coffee Shop — Menu</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6efe6;color:#2b1d14}header{padding:28px 22px 18px;background:#2b1d14;color:#f6efe6}header h1{margin:0;font:600 28px Georgia,serif}header p{margin:4px 0 0;opacity:.7}
main{padding:18px}.c{display:flex;justify-content:space-between;align-items:center;background:#fff;border-radius:14px;padding:14px 16px;margin-bottom:10px;box-shadow:0 1px 2px #0001}.c b{display:block}.c span{opacity:.6;font-size:14px}.p{font-weight:600;color:#a0522d}
.e{margin-top:16px;padding:14px;border-radius:14px;background:#fde8e4;color:#9b2c1f;font-size:14px}</style></head>
<body><header><h1>Coffee Shop</h1><p>Today's menu · open 7am–10pm</p></header><main>
<div class="c"><div><b>Palm Sugar Latte</b><span>espresso, fresh milk, palm sugar</span></div><div class="p">22k</div></div>
<div class="c"><div><b>Americano</b><span>double shot</span></div><div class="p">18k</div></div>
<div class="c"><div><b>Matcha Latte</b><span>Uji matcha, oat milk</span></div><div class="p">26k</div></div>
<div class="e" id="promo">Couldn't load promos.</div></main>
<script>const promo = undefined; document.getElementById('promo').textContent = promo.items.map((p) => p.name).join(', ');</script></body></html>`;
const TOKO = {
  'package.json': JSON.stringify({ name: 'toko-kopi', private: true, scripts: { dev: 'node server.js', test: 'node test/run.js' } }, null, 2) + '\n',
  'server.js': `const fs = require('fs');\nrequire('http').createServer((q, s) => { s.setHeader('content-type', 'text/html; charset=utf-8'); s.end(fs.readFileSync(__dirname + '/index.html')); }).listen(process.env.PORT || 5173);\n`,
  'index.html': SITE,
  'src/pages/Settings.jsx': `import { useState } from 'react';
import { Toggle } from '../components/Toggle';
import { useTheme } from '../hooks/useTheme';

export default function Settings() {
  const [notif, setNotif] = useState(true);
  const [theme, setTheme] = useTheme();

  return (
    <main className="settings">
      <h1>Settings</h1>
      <section>
        <h2>Notifications</h2>
        <Toggle label="Promos & new menu items" checked={notif} onChange={setNotif} />
${SETTINGS_OLD}
  );
}
`,
  'src/components/Toggle.jsx': `export function Toggle({ label, checked, onChange }) {\n  return <label className="toggle"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>;\n}\n`,
  'test/run.js': `// Lightweight test without dependencies: checks component contents.
const fs = require('fs');
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const settings = read('src/pages/Settings.jsx');
const hook = read('src/hooks/useTheme.js');
const cases = [
  ['Settings › shows the notifications toggle', settings.includes('Promos & new menu items')],
  ['Settings › shows the dark theme toggle', settings.includes('Dark theme')],
  ['Toggle › passes the checkbox value', read('src/components/Toggle.jsx').includes('e.target.checked')],
  ['useTheme › reads the saved theme', hook.includes('localStorage.getItem')],
  ['useTheme › saves the choice to localStorage', hook.includes('localStorage.setItem')],
  ['useTheme › applies data-theme', hook.includes('dataset.theme')],
];
let fail = 0;
for (const [name, ok] of cases) { console.log((ok ? '  ✓ ' : '  ✗ ') + name); if (!ok) fail++; }
console.log('\\n  ' + (cases.length - fail) + ' passed · ' + fail + ' failed');
process.exit(fail ? 1 : 0);
`,
};

// ---------- GIF recorder ----------
// Successive PNG screenshots of the page; time spent on still captures isn't recorded.
function recorder(page) {
  let frames = [], on = false, loop = null, paused = false, skew = 0;
  return {
    start() {
      frames = [];
      on = true;
      loop = (async () => {
        while (on) {
          if (paused) {
            await sleep(40);
            continue;
          }
          const t = Date.now() - skew;
          frames.push({ t, buf: await page.screenshot({ type: 'png' }) });
        }
      })();
    },
    async still(fn) {
      paused = true;
      const t0 = Date.now();
      await sleep(150);
      await fn();
      skew += Date.now() - t0;
      paused = false;
    },
    async stop(hold = 2600) {
      await sleep(400);
      on = false;
      await loop;
      // Identical frames are merged; the last frame is held before the GIF loops.
      const out = [];
      for (let i = 0; i < frames.length; i++) {
        const next = frames[i + 1]?.t ?? frames[i].t + hold;
        const last = out.at(-1);
        if (last && last.buf.equals(frames[i].buf)) last.delay += next - frames[i].t;
        else out.push({ buf: frames[i].buf, delay: next - frames[i].t });
      }
      for (const f of out) f.delay = Math.min(f.delay, 1800);
      out.at(-1).delay = hold;
      return out;
    },
  };
}

// Encode in a separate Chromium page: PNG → canvas (downscaled) → global palette → changed pixels only
// (pixels equal to the previous frame are made transparent to keep the GIF small).
async function encodeGif(browser, frames, width, file) {
  const enc = await browser.newPage();
  const src = fs.readFileSync(path.join(ROOT, 'node_modules/gifenc/dist/gifenc.esm.js')).toString('base64');
  await enc.evaluate(async (src) => (window.G = await import('data:text/javascript;base64,' + src)), src);
  const b64 = (f) => f.buf.toString('base64');
  const sample = frames.filter((_, i) => i % Math.max(1, Math.floor(frames.length / 10)) === 0).slice(0, 12).map(b64);
  await enc.evaluate(async ([sample, width]) => {
    const load = async (s) => createImageBitmap(await (await fetch('data:image/png;base64,' + s)).blob());
    const first = await load(sample[0]);
    const w = width, h = Math.round((first.height * width) / first.width);
    const cv = new OffscreenCanvas(w, h);
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high';
    const px = async (s) => (cx.drawImage(await load(s), 0, 0, w, h), cx.getImageData(0, 0, w, h).data);
    const all = new Uint8ClampedArray(w * h * 4 * sample.length);
    for (let i = 0; i < sample.length; i++) all.set(await px(sample[i]), i * w * h * 4);
    const pal = G.quantize(all, 255);
    while (pal.length < 255) pal.push([0, 0, 0]);
    pal.push([255, 0, 255]);
    window.S = { w, h, px, pal, gif: G.GIFEncoder(), prev: null };
  }, [sample, width]);
  for (const f of frames)
    await enc.evaluate(async ([s, delay]) => {
      const idx = G.applyPalette(await S.px(s), S.pal);
      const first = !S.prev;
      if (!first) for (let i = 0; i < idx.length; i++) if (idx[i] === S.prev[i]) idx[i] = 255;
      if (!first) for (let i = 0; i < idx.length; i++) if (idx[i] !== 255) S.prev[i] = idx[i];
      if (first) S.prev = idx.slice();
      S.gif.writeFrame(idx, S.w, S.h, { palette: first ? S.pal : undefined, delay, transparent: !first, transparentIndex: 255, dispose: 1 });
    }, [b64(f), f.delay]);
  const out = await enc.evaluate(() => {
    S.gif.finish();
    const b = S.gif.bytes();
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  });
  await enc.close();
  fs.writeFileSync(path.join(OUT, file), Buffer.from(out, 'base64'));
  console.log(`✔ ${file} (${frames.length} frame, ${(fs.statSync(path.join(OUT, file)).size / 1048576).toFixed(1)} MB)`);
}

// ---------- PWA captures ----------
async function capturePwa(browser) {
  const { mem, conn, s: harnessSess, cleanup } = await setup({ name: PC, reply });
  await conn.call('delete', { id: harnessSess.id }); // replaced by the sample repos below
  // Sample repos with realistic names & GitHub remotes; local sessions are created after the remote is set.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-docs-'));
  const makeRepo = (name, files, branch, message = 'init') => {
    const dir = path.join(tmp, name);
    writeTree(dir, files);
    git(dir, 'init', '-qb', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', message);
    if (branch) git(dir, 'checkout', '-qb', branch);
    git(dir, 'remote', 'add', 'origin', `https://github.com/arfakaisar/${name}.git`);
    return dir;
  };
  TOKO_DIR = makeRepo('toko-kopi', TOKO, 'feature/dark-mode', 'Settings page & notifications toggle');
  const extra = [];
  for (const [name, prompt] of [['portfolio-site', 'Fix the navbar layout on mobile'], ['pos-api', 'Add a daily sales report endpoint']]) {
    const dir = makeRepo(name, { 'README.md': '# ' + name + '\n' });
    extra.push({ dir, prompt, s: await conn.call('create', { local: dir }) });
  }
  await conn.call('send', { id: extra[0].s.id, text: extra[0].prompt });
  await sleep(300);
  const sess = await conn.call('create', { local: TOKO_DIR });
  await conn.call('edits', { id: sess.id, on: true }); // edit permissions show as a diff on the phone

  const swaps = [
    ['claude-mock-1', 'claude-opus-5-5'],
    ['claude-mock-2', 'claude-sonnet-5-5'],
    ['tester', 'arfakaisar'],
    ['GitHub not signed in', '@arfakaisar'],
  ];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'dark' });
  // Sample data & a tap indicator are installed on every page: text is swapped as the DOM changes.
  await ctx.addInitScript((swaps) => {
    const fix = (root) => {
      if (!root) return;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode()); ) for (const [a, b] of swaps) if (n.nodeValue.includes(a)) n.nodeValue = n.nodeValue.split(a).join(b);
      for (const el of document.querySelectorAll('.metachip.warn')) el.classList.remove('warn');
    };
    addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = '#ghBanner{display:none!important} .tapfx{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(255,255,255,.28);border:2px solid rgba(255,255,255,.75);pointer-events:none;z-index:2147483647;transition:transform .45s ease-out,opacity .45s ease-out} html.noToast #toasts{display:none!important}';
      document.head.append(st);
      fix(document.body);
      new MutationObserver((ms) => ms.forEach((m) => (m.type === 'characterData' ? fix(m.target.parentNode || document.body) : m.addedNodes.forEach((n) => n.nodeType === 1 ? fix(n) : n.nodeType === 3 && fix(n.parentNode))))).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    window.__tap = (x, y) => {
      const d = Object.assign(document.createElement('div'), { className: 'tapfx' });
      d.style.left = x + 'px';
      d.style.top = y + 'px';
      document.body.append(d);
      setTimeout(() => ((d.style.opacity = '0'), (d.style.transform = 'scale(1.5)')), 260);
      setTimeout(() => d.remove(), 760);
    };
  }, swaps);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const rec = recorder(page);

  const tap = async (loc) => {
    loc = loc.first();
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    await page.evaluate(([x, y]) => window.__tap(x, y), [b.x + b.width / 2, b.y + b.height / 2]);
    await sleep(230);
    await loc.click();
  };
  // Still captures: dark & light, without toasts.
  const shot = async (name, wait = 900) => {
    await sleep(wait);
    await page.evaluate(() => document.documentElement.classList.add('noToast'));
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme });
      await sleep(350);
      await page.screenshot({ path: path.join(OUT, `${name}${scheme === 'light' ? '-light' : ''}.jpg`), type: 'jpeg', quality: 88 });
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => document.documentElement.classList.remove('noToast'));
    await sleep(300);
    console.log('✔ ' + name);
  };
  const closeSheet = async () => {
    await tap(page.locator('#sheet:not([hidden]) [aria-label="Close"]'));
    await page.waitForSelector('#sheet', { state: 'hidden' });
  };
  const sheet = '#sheet:not([hidden])';

  try {
    await page.goto(RELAY + '/agent/');
    await page.waitForSelector('text=Sign in with GitHub');
    await shot('login', 1400);
    await page.evaluate((kv) => { for (const [k, v] of kv) localStorage.setItem(k, v); }, [...mem.entries()]);
    await page.reload();
    await page.locator('.card.pc.online', { hasText: PC }).first().click();
    await page.locator('#view >> text=toko-kopi').first().click();
    await page.waitForSelector('#input');
    await sleep(800);

    // GIF 1: prompt → plan → edit permission → npm test permission → summary.
    rec.start();
    await sleep(600);
    await tap(page.locator('#input'));
    await page.locator('#input').pressSequentially('Add dark mode to the settings page', { delay: 38 });
    await sleep(350);
    await tap(page.locator('#send'));
    await page.waitForSelector('#dock .perm', { timeout: 60000 });
    await sleep(1600);
    await rec.still(() => shot('session', 200));
    // Every permission (Edit, Write, npm test) is approved with one tap until the agent is done.
    while (!(await page.$('.donel'))) {
      const perm = await page.$('#dock .perm');
      if (!perm) {
        await sleep(120);
        continue;
      }
      await sleep(1300);
      await tap(page.locator('#dock button', { hasText: 'Allow' }));
      await perm.waitForElementState('hidden').catch(() => {});
    }
    await page.waitForFunction(() => document.querySelectorAll('.donel').length >= 1, null, { timeout: 60000 });
    await sleep(800);
    await encodeGif(browser, await rec.stop(3200), 540, 'demo-agent.gif');
    await shot('summary', 300);

    // GIF 2: git — status, diff, commit.
    rec.start();
    await sleep(500);
    await tap(page.locator('[aria-label="Git"]'));
    await page.waitForSelector(sheet + ' >> text=Settings.jsx', { timeout: 15000 });
    await sleep(1300);
    await rec.still(() => shot('git', 200));
    await tap(page.locator(sheet + ' button', { hasText: 'View diff' }));
    await page.waitForSelector(sheet + ' .difffile', { timeout: 15000 });
    await sleep(2200);
    await rec.still(() => shot('diff', 200));
    await page.mouse.move(195, 600);
    await page.mouse.wheel(0, 500);
    await sleep(1400);
    await tap(page.locator(sheet + ' [aria-label="Back"]'));
    await page.waitForSelector(sheet + ' input[placeholder="Commit message…"]');
    await sleep(500);
    await tap(page.locator(sheet + ' input[placeholder="Commit message…"]'));
    await page.locator(sheet + ' input[placeholder="Commit message…"]').pressSequentially('Add dark mode to settings', { delay: 36 });
    await sleep(300);
    await tap(page.locator(sheet + ' button', { hasText: 'Commit' }).last());
    await page.waitForSelector(sheet + ' >> text=Add dark mode to settings', { timeout: 15000 });
    await sleep(1200);
    await encodeGif(browser, await rec.stop(2800), 540, 'demo-git.gif');
    await closeSheet();

    await tap(page.locator('[aria-label="Change model"]'));
    await page.waitForSelector(sheet + ' .model.sel');
    await shot('model');
    await closeSheet();

    // GIF 3: Run & Preview — dev server, screenshot from Chrome on the PC, console errors.
    rec.start();
    await sleep(500);
    await tap(page.locator('[aria-label="Run & preview"]'));
    await sleep(900);
    await tap(page.locator('#sheet button', { hasText: 'Run' }));
    await page.waitForSelector('#sheet .proc.on >> text=/port \\d+/', { timeout: 90000 });
    await sleep(1500);
    await rec.still(() => shot('run', 2600));
    await tap(page.locator(sheet + ' button', { hasText: 'Screenshot' }));
    await page.waitForSelector(sheet + ' img.shot', { timeout: 60000 });
    await sleep(1800);
    await rec.still(() => shot('preview', 300));
    await page.mouse.move(195, 600);
    await page.mouse.wheel(0, 1400);
    await sleep(2000);
    await encodeGif(browser, await rec.stop(3000), 540, 'demo-run.gif');
    await closeSheet();

    // Home: one session still working.
    await conn.call('send', { id: extra[1].s.id, text: extra[1].prompt });
    await page.click('#menuBtn');
    await page.waitForSelector('#drawerPanel .dsess');
    await shot('drawer', 1000);
    await page.locator('#drawerPanel button', { hasText: 'Home' }).click();
    await page.waitForSelector('#view .card.sess');
    await shot('sessions', 1500);
  } catch (e) {
    await page.screenshot({ path: path.join(os.tmpdir(), 'snug-docs-failed.png') }).catch(() => {});
    console.log('FAILED:', e.message, '\n' + (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(-1200));
    throw e;
  } finally {
    await ctx.close();
    await cleanup().catch(() => {});
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
  if (errors.length) console.log('JavaScript errors:', errors);
  return errors;
}

// ---------- mockup: terminal & hero ----------
async function renderMockups(browser) {
  // The terminal is animated by tui.html itself (window.at(ms)); one frame every 90 ms.
  const p = await browser.newPage({ viewport: { width: 880, height: 700 }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(path.join(ROOT, 'docs', 'mockups', 'tui.html')).href);
  await p.waitForTimeout(800);
  const total = await p.evaluate(() => window.TOTAL);
  const frames = [];
  for (let t = 0; t <= total; t += 90) {
    await p.evaluate((t) => window.at(t), t);
    const buf = await p.screenshot({ type: 'png' });
    if (frames.at(-1)?.buf.equals(buf)) frames.at(-1).delay += 90;
    else frames.push({ buf, delay: 90 });
  }
  frames.at(-1).delay = 3500;
  await p.screenshot({ path: path.join(OUT, 'tui.jpg'), type: 'jpeg', quality: 90 });
  await p.close();
  await encodeGif(browser, frames, 880, 'demo-tui.gif');
  // The hero uses the latest captures (including tui.jpg above).
  const hero = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
  await hero.goto(pathToFileURL(path.join(ROOT, 'docs', 'mockups', 'hero.html')).href);
  await hero.waitForTimeout(1500);
  await hero.screenshot({ path: path.join(OUT, 'hero.jpg'), type: 'jpeg', quality: 90 });
  await hero.close();
  console.log('✔ hero');
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || findBrowser() });
let errors = [];
if (!ONLY || ONLY.includes('pwa')) errors = await capturePwa(browser);
if (!ONLY || ONLY.includes('hero') || ONLY.includes('tui')) await renderMockups(browser);
await browser.close();
process.exit(errors.length ? 1 : 0);
