// Screenshot + log konsol halaman lewat Chrome/Edge headless (Chrome DevTools Protocol),
// tanpa Playwright: cukup browser Chromium yang sudah terpasang di PC dan WebSocket bawaan Node.
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

// Klien CDP minimal: satu WebSocket, perintah berbasis id, event lewat callback.
async function connectCdp(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('Gagal tersambung ke browser headless'));
  });
  let id = 0;
  const pending = new Map();
  const handlers = new Set();
  const cdp = {
    closed: false,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        if (cdp.closed) return reject(new Error('Browser headless tertutup'));
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
    for (const { reject } of pending.values()) reject(new Error('Browser headless tertutup'));
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
  throw new Error('Browser headless tidak merespons');
}

// Satu browser headless dipakai ulang antar screenshot (agen biasanya mengambil beberapa
// berturut-turut saat memverifikasi UI): start Chrome 1–2 detik hanya dibayar sekali. Tiap
// screenshot memakai browser context baru (seperti jendela incognito), jadi cookie/storage
// tidak terbawa. Browser ditutup setelah menganggur IDLE_MS.
const IDLE_MS = 3 * 60 * 1000;
let shared = null; // Promise<{ proc, cdp, profile }>
let idleTimer = null;
let inUse = 0;

function launch(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketcode-cdp-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--hide-scrollbars', '--mute-audio'];
  // Chrome menolak berjalan sebagai root tanpa --no-sandbox (Linux server/WSL/container).
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  const proc = spawn(exe, [...args, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const kill = () => {
    proc.kill();
    // Profil sementara dipegang browser beberapa saat setelah ditutup (Windows).
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

// Buka `url`, tunggu load (+ jeda agar framework selesai render), lalu ambil screenshot JPEG
// dan log konsol/error. Request yang tidak pernah selesai (HMR, SSE) tidak membuatnya macet.
// `scale`: device pixel ratio. 2 = tajam di layar HP; 1 untuk agen (gambar 4× lebih sedikit piksel,
// jadi jauh lebih sedikit token gambar yang menetap di konteks model).
/** @param {string} url @param {{ width?: number, height?: number, scale?: number, wait?: number, timeout?: number, fullPage?: boolean, cfg?: { browserExecutable?: string } }} [opts] */
export async function capture(url, { width = 390, height = 844, scale = 2, wait = 1500, timeout = 20000, fullPage = false, cfg } = {}) {
  const exe = findBrowser(cfg);
  if (!exe) throw new Error('Chrome/Edge/Chromium tidak ditemukan di PC. Pasang salah satunya, atau isi "browserExecutable" di ~/.pocketcode/config.json.');
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
    if (nav.errorText) throw new Error(`Gagal membuka ${url}: ${nav.errorText}`);
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
