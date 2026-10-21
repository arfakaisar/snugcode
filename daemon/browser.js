// Page screenshot + console log via headless Chrome/Edge (Chrome DevTools Protocol),
// without Playwright: just a Chromium browser already installed on the PC and Node's built-in WebSocket.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = {
  win32: [
    ['PROGRAMFILES', 'Google/Chrome/Application/chrome.exe'],
    ['PROGRAMFILES(X86)', 'Google/Chrome/Application/chrome.exe'],
    ['LOCALAPPDATA', 'Google/Chrome/Application/chrome.exe'],
    ['PROGRAMFILES(X86)', 'Microsoft/Edge/Application/msedge.exe'],
    ['PROGRAMFILES', 'Microsoft/Edge/Application/msedge.exe'],
    ['PROGRAMFILES', 'BraveSoftware/Brave-Browser/Application/brave.exe'],
  ].map(([env, rel]) => process.env[env] && path.join(process.env[env], rel)),
  darwin: ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser'].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`),
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].flatMap((n) => ['/usr/bin/', '/snap/bin/'].map((d) => d + n)),
};

export function findBrowser(cfg = {}) {
  if (cfg.browserExecutable) return fs.existsSync(cfg.browserExecutable) ? cfg.browserExecutable : null;
  return (CANDIDATES[process.platform] || []).find((p) => p && fs.existsSync(p)) || null;
}

// Minimal CDP client: one WebSocket, id-based commands, events via callback.
async function connectCdp(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('Failed to connect to the headless browser'));
  });
  let id = 0;
  const pending = new Map();
  const handlers = new Set();
  const cdp = {
    closed: false,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        if (cdp.closed) return reject(new Error('Headless browser closed'));
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      }),
    on: (h) => (handlers.add(h), () => handlers.delete(h)),
    close: () => ws.close(),
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) for (const h of handlers) h(m);
  };
  ws.onclose = () => {
    cdp.closed = true;
    for (const { reject } of pending.values()) reject(new Error('Headless browser closed'));
    pending.clear();
  };
  return cdp;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFile(file, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    try {
      const [port, wsPath] = fs.readFileSync(file, 'utf8').split('\n');
      if (wsPath) return `ws://127.0.0.1:${port}${wsPath.trim()}`;
    } catch {}
  }
  throw new Error('The headless browser is not responding');
}

// One headless browser is reused across screenshots (the agent usually takes several
// in a row when verifying UI): Chrome's 1–2 second startup is paid only once. Each
// screenshot uses a new browser context (like an incognito window), so cookies/storage
// don't carry over. The browser is closed after IDLE_MS of inactivity.
const IDLE_MS = 3 * 60 * 1000;
let shared = null; // Promise<{ proc, cdp, profile }>
let idleTimer = null;
let inUse = 0;

function launch(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'snugcode-cdp-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--hide-scrollbars', '--mute-audio'];
  // Chrome refuses to run as root without --no-sandbox (Linux servers/WSL/containers).
  // Containers (cloud runner, Docker) usually also lack user namespaces for Chrome's sandbox; their /dev/shm is small.
  if (process.getuid?.() === 0 || process.env.SNUGCODE_SUPERVISED === '1') args.push('--no-sandbox', '--disable-dev-shm-usage');
  const proc = spawn(exe, [...args, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const kill = () => {
    proc.kill();
    // The temporary profile is held by the browser for a while after closing (Windows).
    setTimeout(() => fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }, () => {}), 1500).unref?.();
  };
  const p = (async () => {
    try {
      const cdp = await connectCdp(await waitFile(path.join(profile, 'DevToolsActivePort'), 10000));
      return { proc, cdp, kill };
    } catch (e) {
      kill();
      throw e;
    }
  })();
  proc.once('exit', () => {
    if (shared === p) shared = null;
  });
  return p;
}

async function acquire(exe) {
  clearTimeout(idleTimer);
  inUse++;
  try {
    let b = await (shared ??= launch(exe));
    if (b.cdp.closed || b.proc.exitCode !== null) {
      b.kill();
      shared = null;
      b = await (shared = launch(exe));
    }
    return b;
  } catch (e) {
    release();
    shared = null;
    throw e;
  }
}

function release() {
  inUse = Math.max(0, inUse - 1);
  if (inUse) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeBrowser, IDLE_MS);
  idleTimer.unref?.();
}

export async function closeBrowser() {
  const p = shared;
  shared = null;
  clearTimeout(idleTimer);
  if (!p) return;
  try {
    const b = await p;
    b.cdp.close();
    b.kill();
  } catch {}
}

// Open `url`, wait for load (+ a pause so frameworks finish rendering), then take a JPEG screenshot
// and the console/error log. Requests that never finish (HMR, SSE) don't make it hang.
// `scale`: device pixel ratio. 2 = sharp on phone screens; 1 for the agent (4× fewer pixels,
// so far fewer image tokens staying in the model's context).
/** @param {string} url @param {{ width?: number, height?: number, scale?: number, wait?: number, timeout?: number, fullPage?: boolean, cfg?: { browserExecutable?: string } }} [opts] */
export async function capture(url, { width = 390, height = 844, scale = 2, wait = 1500, timeout = 20000, fullPage = false, cfg } = {}) {
  const exe = findBrowser(cfg);
  if (!exe) throw new Error('Chrome/Edge/Chromium not found on this PC. Install one, or set "browserExecutable" in ~/.snugcode/config.json.');
  const { cdp } = await acquire(exe);
  const logs = [];
  let contextId;
  let off;
  try {
    ({ browserContextId: contextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true }));
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: contextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => cdp.send(m, p, sessionId);
    let loaded;
    const onLoad = new Promise((r) => (loaded = r));
    off = cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      const p = m.params;
      if (m.method === 'Page.loadEventFired') loaded();
      else if (m.method === 'Runtime.consoleAPICalled')
        logs.push({ level: p.type, text: p.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 2000) });
      else if (m.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails;
        logs.push({ level: 'exception', text: (d.exception?.description || d.text || 'error').slice(0, 2000) });
      } else if (m.method === 'Log.entryAdded' && p.entry.level === 'error') logs.push({ level: 'error', text: `${p.entry.text}${p.entry.url ? ' ' + p.entry.url : ''}`.slice(0, 2000) });
    });
    await Promise.all([S('Page.enable'), S('Runtime.enable'), S('Log.enable')]);
    await S('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 768 });
    const nav = await S('Page.navigate', { url });
    if (nav.errorText) throw new Error(`Failed to open ${url}: ${nav.errorText}`);
    await Promise.race([onLoad, sleep(timeout)]);
    await sleep(wait);
    const shot = await S('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: fullPage });
    const title = (await S('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value || '';
    return { data: shot.data, mime: 'image/jpeg', title, logs: logs.slice(-100) };
  } finally {
    off?.();
    if (contextId) await cdp.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => {});
    release();
  }
}
