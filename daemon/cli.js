#!/usr/bin/env node
// snugcode — CLI daemon.
//   snugcode setup     : setup awal (API key model, GitHub, PIN)
//   snugcode start     : jalankan daemon
//   snugcode stop      : hentikan daemon yang berjalan di latar belakang
//   snugcode autostart : jalankan otomatis saat login (on|off)
//   snugcode pin       : ganti PIN / buka kunci setelah salah berkali-kali
//   snugcode devices   : daftar HP terpasang;  snugcode revoke <id|all>
//   snugcode status    : ringkasan konfigurasi
//   snugcode cloud     : runner cloud (Codespaces/container) — konfigurasi dari env, lihat runner.js
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { loadConfig, saveConfig, loadSecrets, saveSecrets, ensureDirs, HOME, SESSIONS_DIR, isCloud, scrubSecretEnv } from './config.js';
import { DEFAULT_RELAY_URL, GITHUB_CLIENT_ID, DEFAULT_ROUTER_URL, PACKAGE_SPEC } from './defaults.js';
import { deviceFlowLogin, gitCredentialToken, gh } from './github.js';
import { pinToPrs, PIN_RE, normalizePin } from '../shared/crypto.js';
import { lightModel } from '../shared/models.js';
import { keyCandidates, splitRef, ENGINE_LABEL, engineFor } from '../shared/providers.js';
import { detectConnection, putConnection, mirrorLegacy, migrateLegacy, hasConnections, allConnections, connSummary } from './providers.js';
import { checkUpdate, performUpdate } from './updater.js';
import { AUTOSTART_UNIT, autostartFilePath, writeAutostart, disableAutostart, syncAutostart } from './autostart.js';

const CLI = fileURLToPath(import.meta.url);
const COMMAND_NAMES = ['setup', 'login', 'connect', 'disconnect', 'start', 'stop', 'restart', 'update', 'clean', 'autostart', 'pin', 'devices', 'revoke', 'status', 'help', 'cloud'];
const args = process.argv.slice(2);
// Tanpa perintah -> buka TUI (seperti `claude`). Kata pertama yang bukan
// perintah dianggap prompt awal: snugcode "jelaskan repo ini".
const cmd = args[0] && COMMAND_NAMES.includes(args[0]) ? args.shift() : 'tui';
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    flags[k] = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : true;
  } else if (args[i].startsWith('-') && args[i].length > 1) {
    const k = args[i].slice(1);
    if (k === 'c') flags.computer = true;
    else if (k === 'p') flags.pick = true;
    else flags[k] = true;
  }
}

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };

let rl;
function ask(q, def, { hidden = false } = {}) {
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const prompt = `${q}${def ? c.d(` [${def}]`) : ''}: `;
  return new Promise((resolve) => {
    if (hidden) {
      const orig = rl._writeToOutput;
      rl._writeToOutput = (s) => orig.call(rl, s.startsWith(prompt) ? prompt : s.replace(/[^\r\n]/g, '*'));
      rl.question(prompt, (a) => {
        rl._writeToOutput = orig;
        resolve(a.trim() || def || '');
      });
    } else rl.question(prompt, (a) => resolve(a.trim() || def || ''));
  });
}

function openBrowser(url) {
  const p =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
}

async function pickModel(models, label, def) {
  if (flags[label]) return flags[label];
  // OpenRouter & router besar punya ratusan model: tampilkan sebagian, nama lain tetap bisa diketik.
  models.slice(0, 40).forEach((m, i) => console.log(c.d(String(i + 1).padStart(3)) + '  ' + m));
  if (models.length > 40) console.log(c.d(`  … ${models.length - 40} model lain (ketik namanya)`));
  const a = await ask(`Pilih ${label === 'model' ? 'model utama' : 'model kecil (tugas ringan)'} (nomor atau nama)`, def);
  return /^\d+$/.test(a) ? models[+a - 1] : a;
}

async function askPin() {
  if (flags.pin) {
    if (!PIN_RE.test(String(flags.pin))) throw new Error('PIN harus 6–12 karakter huruf/angka.');
    return String(flags.pin);
  }
  for (;;) {
    const a = await ask('Buat PIN (6–12 huruf/angka, mis. moon42) untuk memasangkan HP', '', { hidden: true });
    if (!PIN_RE.test(a)) {
      console.log(c.r('PIN harus 6–12 karakter huruf/angka.'));
      continue;
    }
    const b = await ask('Ulangi PIN', '', { hidden: true });
    if (normalizePin(a) === normalizePin(b)) return a;
    console.log(c.r('PIN tidak sama.'));
  }
}

async function setup() {
  ensureDirs();
  const cfg = loadConfig();
  const sec = loadSecrets();
  console.log(c.b('\nsnugcode setup') + c.d(`  (data disimpan di ${HOME})\n`));

  // 1. Model: API key apa pun (official / router / endpoint sendiri), jenisnya dideteksi otomatis.
  migrateLegacy(cfg, sec);
  console.log(c.b('1) Model & API key'));
  console.log(c.d('   Tempel API key: Anthropic (sk-ant-api…), OpenAI, Gemini (AIza…), OpenRouter, DeepSeek, Kimi, GLM, xAI, Groq,'));
  console.log(c.d('   atau key router (9router, OmniRoute, LiteLLM, …) beserta URL-nya. Login ChatGPT: dari aplikasi HP → Model & API key.'));
  const have = hasConnections(sec);
  let models;
  for (;;) {
    const key = flags.key || (await ask('API key', have ? '(tetap)' : '', { hidden: true }));
    if (key === '(tetap)' && have) break;
    let url = flags.router || flags.url || '';
    if (!url && key && !keyCandidates(key).length && !flags.key) url = await ask('URL router / endpoint (key ini bukan key official yang dikenal)', cfg.routerUrl || DEFAULT_ROUTER_URL);
    else if (!url && key && !keyCandidates(key).length) url = cfg.routerUrl || DEFAULT_ROUTER_URL;
    try {
      const det = await detectConnection({ key, url });
      const { models: list, ...conn } = det;
      const id = putConnection(sec, conn);
      mirrorLegacy(cfg, sec);
      const fmt = Object.entries(conn.formats || {}).filter(([, v]) => v).map(([k]) => k).join(', ');
      console.log(c.g(`✓ ${conn.label}: ${list.length} model`) + c.d(` · format ${fmt || '-'} · koneksi "${id}"`));
      models = list.map((m) => m.id);
      break;
    } catch (e) {
      console.log(c.r('✗ ' + e.message));
      if (flags.key) process.exit(1);
    }
  }
  if (models?.length) {
    const { defaultModel } = await import('./server.js');
    cfg.model = await pickModel(models, 'model', models.includes(cfg.model) ? cfg.model : defaultModel(models));
    // Subagen selalu memakai model ringan dari koneksi yang sama (otomatis per model utama).
    delete cfg.smallModel;
    const light = lightModel(cfg.model, models);
    const conn = allConnections(sec)[splitRef(cfg.model).conn];
    const route = conn && engineFor(conn, splitRef(cfg.model).id);
    console.log(c.d(`  harness: ${route ? ENGINE_LABEL[route.engine] : '-'} · model ringan (subagen): ${light.kind === 'main' ? 'model utama' : light.id}`));
  }

  // 2. Semua pertanyaan dulu, supaya langkah login bisa diselesaikan sekaligus.
  console.log(c.b('\n2) GitHub (untuk clone, push, dan PR)'));
  let githubMode = flags.github || (flags['github-token'] ? 'token' : flags['skip-github'] ? 'skip' : null);
  if (!githubMode) {
    const opts = [];
    if (GITHUB_CLIENT_ID) opts.push(['Login lewat browser / HP (disarankan)', 'device']);
    opts.push(['Pakai login git yang sudah ada di PC ini (Git Credential Manager / GitHub Desktop)', 'cred']);
    opts.push(['Tempel Personal Access Token', 'pat']);
    if (sec.githubToken) opts.push(['Tetap pakai token yang tersimpan', 'keep']);
    opts.forEach(([l], i) => console.log(`  ${i + 1}. ${l}`));
    githubMode = opts[(+(await ask('Pilihan', sec.githubToken ? String(opts.length) : '1')) || 1) - 1]?.[1] || 'skip';
  }
  if (githubMode === 'token') sec.githubToken = flags['github-token'];
  else if (githubMode === 'pat') sec.githubToken = await ask('Token (scope: repo, workflow)', '', { hidden: true });
  else if (githubMode === 'cred') {
    sec.githubToken = await gitCredentialToken();
    if (!sec.githubToken) console.log(c.r('✗ Tidak ada kredensial GitHub tersimpan di git.'));
  } else if (githubMode === 'skip') delete sec.githubToken;

  console.log(c.b('\n3) PC & PIN'));
  cfg.relayUrl = (flags.relay || (DEFAULT_RELAY_URL && !cfg.relayUrl ? DEFAULT_RELAY_URL : await ask('URL relay', cfg.relayUrl || DEFAULT_RELAY_URL))).replace(/\/+$/, '');
  cfg.machineName = flags.name || (await ask('Nama PC ini', cfg.machineName || os.hostname()));
  const relink = !sec.machineToken || cfg.linkedRelay !== cfg.relayUrl || flags.relink || (!flags.name && (await ask('Tautkan ulang PC ke akun? (y/n)', 'n')) === 'y');
  let pin = null;
  if (!sec.prs || relink || flags.pin || (await ask('Ganti PIN? (y/n)', 'n')) === 'y') pin = await askPin();

  // 4. Login: tautkan PC + (opsional) GitHub device flow, ditampilkan bersamaan.
  const tasks = [];
  const steps = [];
  if (relink) {
    const r = await fetch(cfg.relayUrl + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: cfg.machineName }) });
    if (!r.ok) throw new Error('Relay tidak bisa dihubungi: ' + r.status);
    const { code, url } = await r.json();
    steps.push(`Tautkan PC ke akun GitHub-mu — buka:\n     ${c.b(url)}`);
    tasks.push(
      (async () => {
        for (;;) {
          await new Promise((res) => setTimeout(res, 2000));
          const p = await (await fetch(cfg.relayUrl + '/auth/machine/poll?code=' + code)).json();
          if (p.status === 'ok') {
            sec.machineToken = p.token;
            cfg.machineId = p.mid;
            cfg.relayLogin = p.login;
            cfg.linkedRelay = cfg.relayUrl;
            sec.devices = {};
            console.log(c.g(`✓ PC tertaut ke akun @${p.login}`));
            return;
          }
          if (p.status === 'expired') throw new Error('Link penautan kedaluwarsa, ulangi setup.');
        }
      })(),
    );
  }
  if (githubMode === 'device') {
    let announce;
    const shown = new Promise((res) => (announce = res));
    tasks.push(
      deviceFlowLogin(GITHUB_CLIENT_ID, (code, uri) => {
        steps.push(`Login GitHub untuk PC ini — buka ${c.b(uri)}\n     lalu masukkan kode: ${c.b(code)}`);
        announce();
      }).then((t) => (sec.githubToken = t)),
    );
    await shown;
  }
  if (steps.length) {
    console.log(c.b('\n4) Selesaikan dari browser (boleh dari HP):'));
    steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    if (!flags['no-browser'] && relink) openBrowser(steps[0].match(/https?:\/\/\S+/)[0].replace(/\x1b\[[0-9;]*m/g, ''));
    console.log(c.d('  Menunggu…'));
    await Promise.all(tasks);
  }

  if (sec.githubToken) {
    try {
      const me = await gh(sec.githubToken, 'GET', '/user');
      cfg.githubLogin = me.login;
      cfg.githubId = me.id;
      console.log(c.g(`✓ GitHub: @${me.login}`));
    } catch (e) {
      console.log(c.r('✗ Token GitHub tidak valid: ' + e.message));
      delete sec.githubToken;
    }
  } else console.log(c.y('! Tanpa GitHub: hanya repo publik, tanpa push.'));

  if (pin) {
    sec.prs = Buffer.from(await pinToPrs(pin, cfg.machineId)).toString('hex');
    sec.pinFails = 0;
  }

  saveConfig(cfg);
  saveSecrets(sec);
  rl?.close();
  console.log(c.g('\n✓ Setup selesai.') + ` Jalankan ${c.b('snugcode start')} (atau ${c.b('snugcode autostart on')}), lalu buka ${c.b(cfg.relayUrl)} di HP.\n`);
}

async function resetPin() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  if (!cfg.machineId) throw new Error('Belum setup.');
  const pin = await askPin();
  sec.prs = Buffer.from(await pinToPrs(pin, cfg.machineId)).toString('hex');
  sec.pinFails = 0;
  saveSecrets(sec);
  rl?.close();
  console.log(c.g('✓ PIN diganti dan kunci dibuka. (Daemon yang sedang berjalan perlu di-restart.)'));
}

function devices() {
  const sec = loadSecrets();
  const list = Object.entries(sec.devices);
  if (!list.length) return console.log('Belum ada HP yang dipasangkan.');
  for (const [id, d] of list) console.log(`${c.b(id)}  ${d.name}  ${c.d('terakhir: ' + new Date(d.lastSeen).toLocaleString())}`);
}

function revoke(id) {
  const sec = loadSecrets();
  if (id === 'all') sec.devices = {};
  else if (!sec.devices[id]) throw new Error('ID tidak ditemukan');
  else delete sec.devices[id];
  saveSecrets(sec);
  console.log(c.g('✓ Dicabut. (Restart daemon agar koneksi aktif langsung terputus.)'));
}

// ---------- proses latar belakang ----------
const PID_FILE = path.join(HOME, 'daemon.pid');
const LOG_FILE = path.join(HOME, 'daemon.log');

function runningPid() {
  try {
    const pid = +fs.readFileSync(PID_FILE, 'utf8');
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function stop() {
  const pid = runningPid();
  if (!pid) return console.log('Daemon tidak sedang berjalan.');
  const { stopDaemon } = await import('./tui.js');
  await stopDaemon(pid);
  fs.rmSync(PID_FILE, { force: true });
  console.log(c.g(`✓ Daemon (pid ${pid}) dihentikan.`));
}

// Jalankan daemon terlepas dari terminal ini (tetap hidup walau terminal ditutup).
function spawnDetached() {
  const p = spawn(process.execPath, [CLI, 'start', '--log'], { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  return p.pid;
}

function autostart() {
  const mode = args.find((a) => !a.startsWith('--')) || 'on';
  if (mode === 'on' && CLI.includes('_npx')) {
    console.log(c.y('! Kamu menjalankan lewat npx. Untuk autostart, pasang global dulu agar path-nya tetap:'));
    console.log(`    npm i -g ${PACKAGE_SPEC}   lalu   snugcode autostart on`);
  }
  if (mode === 'off') {
    disableAutostart();
    return console.log(c.g('✓ Autostart dimatikan.'));
  }
  const file = writeAutostart(CLI, process.execPath);
  console.log(c.g('✓ Autostart aktif: ') + file);

  // Nyalakan sekarang juga bila belum berjalan.
  if (!runningPid()) {
    if (process.platform === 'linux') spawnSync('systemctl', ['--user', 'start', AUTOSTART_UNIT]);
    else if (process.platform === 'darwin') spawnSync('launchctl', ['load', autostartFilePath()]);
    else spawnDetached();
    console.log(c.g('✓ Daemon dijalankan di latar belakang.') + c.d(` Log: ${LOG_FILE}`));
  } else console.log(c.d('Daemon sudah berjalan.'));
}

async function start() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  // Runner cloud dikonfigurasi dari HP: key 9router boleh belum ada saat start pertama.
  if (isCloud(cfg) ? !cfg.relayUrl || !sec.machineToken : !cfg.relayUrl || !sec.machineToken || !hasConnections(sec) || !sec.prs) {
    if (isCloud(cfg)) throw new Error('Runner belum dikonfigurasi. Jalankan `snugcode cloud` dengan SNUGCODE_MACHINE_TOKEN.');
    console.log(c.y('Belum setup. Menjalankan setup dulu…\n'));
    await setup();
    return start();
  }
  ensureDirs();
  const other = runningPid();
  if (other && other !== process.pid) {
    console.log(c.y(`Daemon sudah berjalan (pid ${other}). Hentikan dengan `) + c.b('snugcode stop'));
    process.exit(1);
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on('exit', () => runningPid() === process.pid && fs.rmSync(PID_FILE, { force: true }));
  // Selalu sinkronkan skrip autostart jika autostart pernah diaktifkan pada sistem ini
  if (!isCloud(cfg)) syncAutostart(CLI, process.execPath);
  if (flags.log) {
    const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const write = (...a) => out.write(new Date().toISOString() + ' ' + util.format(...a).replace(/\x1b\[[0-9;]*m/g, '') + '\n');
    console.log = write;
    console.error = write;
  }
  const { Daemon } = await import('./server.js');
  console.log(c.b('snugcode') + c.d(` — ${cfg.machineName} · model ${cfg.model} · relay ${cfg.relayUrl}`));
  if (sec.pinFails >= 5) console.log(c.r('! Pairing terkunci karena PIN salah berkali-kali. Jalankan `snugcode pin`.'));
  const d = new Daemon(cfg);
  d.start();
  const bye = () => Promise.resolve(d.stop()).finally(() => process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

function status() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  console.log({
    home: HOME,
    runtime: cfg.runtime || 'pc',
    relay: cfg.relayUrl,
    account: cfg.relayLogin,
    machine: cfg.machineName,
    connections: Object.values(allConnections(sec)).map((x) => `${x.id}: ${connSummary(x).label}${x.key ? ' ' + connSummary(x).key : ''}`),
    model: cfg.model,
    lightModel: cfg.model ? lightModel(cfg.model).id : null,
    github: cfg.githubLogin || null,
    devices: Object.keys(sec.devices).length,
    pinLocked: sec.pinFails >= 5,
  });
}

// Login ulang GitHub saja (mis. token dicabut), tanpa mengulang seluruh setup.
async function login() {
  if (!GITHUB_CLIENT_ID) throw new Error('GITHUB_CLIENT_ID belum diatur.');
  // Daemon berjalan: login lewat daemon, token langsung berlaku tanpa restart.
  if (runningPid()) {
    try {
      const { loginViaDaemon } = await import('./tui.js');
      return await loginViaDaemon({ openBrowser: !flags['no-browser'] });
    } catch (e) {
      if (!/ECONNREFUSED|ENOENT|tidak menjawab|token lokal/.test(e.message)) throw e;
      // Daemon versi lama tanpa kanal lokal: lanjut cara lama (restart daemon).
    }
  }
  console.log(c.b('Login GitHub untuk PC ini') + c.d(' (clone, push, PR)'));
  const token = await deviceFlowLogin(GITHUB_CLIENT_ID, (code, uri) => {
    console.log(`  Buka ${c.b(uri)}\n  lalu masukkan kode ${c.b(code)}`);
    if (!flags['no-browser']) openBrowser(uri);
    console.log(c.d('  Menunggu…'));
  });
  const me = await gh(token, 'GET', '/user');
  // Daemon menyimpan secrets di memori: hentikan dulu agar token baru tidak tertimpa.
  const pid = runningPid();
  if (pid) await (await import('./tui.js')).stopDaemon(pid);
  const cfg = loadConfig();
  const sec = loadSecrets();
  sec.githubToken = token;
  cfg.githubLogin = me.login;
  cfg.githubId = me.id;
  saveConfig(cfg);
  saveSecrets(sec);
  console.log(c.g(`✓ GitHub: @${me.login}`));
  if (pid) {
    spawnDetached();
    console.log(c.g('✓ Daemon dinyalakan ulang dengan token baru.'));
  }
}

// `snugcode connect <api key> [--url URL]` · `snugcode connect chatgpt` · `snugcode connect` (daftar).
// Daemon berjalan: lewat daemon (langsung berlaku). Tidak berjalan: ditulis ke secrets.json.
async function connect() {
  const arg = args.find((a) => !a.startsWith('-'));
  const url = flags.url || flags.router || undefined;
  const pid = runningPid();
  if (arg === 'chatgpt') {
    if (!pid) throw new Error('Login ChatGPT berjalan lewat daemon: jalankan `snugcode start` (atau autostart) dulu, lalu ulangi.');
    const { chatgptLoginViaDaemon } = await import('./tui.js');
    return chatgptLoginViaDaemon({ openBrowser: !flags['no-browser'] });
  }
  if (!arg && !url) {
    const sec = loadSecrets();
    migrateLegacy(loadConfig(), sec);
    const list = Object.values(allConnections(sec)).map(connSummary);
    if (!list.length) return console.log(c.y('Belum ada model tersambung.') + c.d(' snugcode connect <api key> [--url URL] · snugcode connect chatgpt'));
    for (const x of list) console.log(`${c.b(x.id.padEnd(10))} ${x.label}${x.key ? c.d(' ' + x.key) : ''}${x.account?.email ? c.d(' ' + x.account.email) : ''}${x.url ? c.d(' · ' + x.url) : ''}`);
    return;
  }
  if (pid) {
    const { daemonCall } = await import('./tui.js');
    const r = await daemonCall('connAdd', { key: arg, url });
    return console.log(c.g(`✓ ${r.conn.label}: ${r.models} model`) + c.d(` · koneksi "${r.conn.id}" · model default ${r.info.model || '-'}`));
  }
  const cfg = loadConfig();
  const sec = loadSecrets();
  migrateLegacy(cfg, sec);
  const { models, ...conn } = await detectConnection({ key: arg, url });
  const id = putConnection(sec, conn);
  mirrorLegacy(cfg, sec);
  if (!cfg.model || splitRef(cfg.model).conn === id || !allConnections(sec)[splitRef(cfg.model).conn]) {
    const { defaultModel } = await import('./server.js');
    cfg.model = defaultModel(models.map((m) => m.id)) || cfg.model;
  }
  saveSecrets(sec);
  saveConfig(cfg);
  console.log(c.g(`✓ ${conn.label}: ${models.length} model`) + c.d(` · koneksi "${id}" · model default ${cfg.model}`));
}

async function disconnect() {
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) throw new Error('Pakai: snugcode disconnect <id koneksi>  (lihat `snugcode connect`)');
  if (runningPid()) {
    const { daemonCall } = await import('./tui.js');
    await daemonCall(id === 'chatgpt' ? 'chatgptLogout' : 'connRemove', { id });
  } else {
    const cfg = loadConfig();
    const sec = loadSecrets();
    migrateLegacy(cfg, sec);
    if (!sec.connections?.[id]) throw new Error('Koneksi tidak ditemukan: ' + id);
    delete sec.connections[id];
    mirrorLegacy(cfg, sec);
    if (splitRef(cfg.model || '').conn === id) cfg.model = '';
    saveSecrets(sec);
    saveConfig(cfg);
  }
  console.log(c.g('✓ Koneksi dihapus: ' + id));
}

function isSetUp() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  return !!(cfg.relayUrl && sec.machineToken && hasConnections(sec) && sec.prs);
}

async function tui() {
  if (!isSetUp()) {
    console.log(c.y('Belum setup. Menjalankan setup dulu…\n'));
    await setup();
  }
  const { runTui } = await import('./tui.js');
  const prompt = args.filter((a) => !a.startsWith('-')).join(' ').trim();
  await runTui({ prompt, pick: !!flags.pick || !!flags.sessions, computer: !!(flags.computer || flags.pc) });
}

async function cliRestart() {
  const pid = runningPid();
  if (!pid) {
    console.log(c.y('Daemon tidak sedang berjalan. Menjalankan daemon baru…'));
    const newPid = spawnDetached();
    return console.log(c.g(`✓ Daemon dijalankan (pid ${newPid}).`));
  }
  await (await import('./tui.js')).stopDaemon(pid);
  fs.rmSync(PID_FILE, { force: true });
  const newPid = spawnDetached();
  console.log(c.g(`✓ Daemon di-restart (pid ${newPid}).`));
}

async function cliUpdate() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  console.log(c.b('Memeriksa pembaruan snugcode…'));
  const st = await checkUpdate(cfg, sec);
  if (!st.updateAvailable && !flags.force) {
    console.log(c.g('✓ snugcode sudah versi terbaru') + c.d(` (${st.currentCommit})`));
    return;
  }
  console.log(c.y('Ada pembaruan: ') + `${c.b(st.latestCommit)}${st.latestMessage ? ' — ' + st.latestMessage : ''}`);
  // Hentikan daemon dulu (beserta claude.exe di sesinya) agar file tidak terkunci saat npm memasang.
  const wasRunning = await stopAndWait();
  if (wasRunning) console.log(c.d('Daemon dihentikan sementara untuk update.'));
  console.log(c.d('Memasang pembaruan…'));
  try {
    const r = await performUpdate(cfg, sec);
    console.log(c.g(`✓ Pembaruan berhasil dipasang (${r.commit}).`));
  } finally {
    if (wasRunning) console.log(c.g(`✓ Daemon dijalankan lagi (pid ${spawnDetached()}).`));
  }
}

async function stopAndWait() {
  const pid = runningPid();
  if (!pid) return false;
  await (await import('./tui.js')).stopDaemon(pid);
  // Windows: matikan juga claude.exe anak daemon (/T) yang mungkin tertinggal, tanpa menyentuh claude.exe lain.
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  fs.rmSync(PID_FILE, { force: true });
  // Proses claude.exe anak daemon bisa tertinggal sebentar setelah daemon mati.
  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

async function cliClean() {
  const { cleanupWorkspaces } = await import('./cleaner.js');
  const { readSessionIndex } = await import('./config.js');
  const idx = readSessionIndex();
  // Daftar sesi tidak terbaca = semua worktree akan terlihat "yatim": jangan hapus apa pun.
  if (!idx.ok) {
    console.log(c.r('✗ sessions/index.json tidak terbaca; pembersihan dibatalkan agar worktree tidak terhapus.'));
    return;
  }
  console.log(c.b('Memindai workspaces PC untuk folder yatim…'));
  const r = await cleanupWorkspaces(idx.list, { minAgeMs: 0, repoTtlMs: 0 });
  const wtCount = r.removedWorktrees.length;
  const repoCount = r.removedRepos.length;
  const logCount = r.removedLogs.length;
  if (wtCount === 0 && repoCount === 0 && logCount === 0) {
    console.log(c.g('✓ Workspace bersih. Tidak ada folder atau repositori yatim.'));
  } else {
    if (wtCount > 0) console.log(c.g(`✓ Dihapus ${wtCount} worktree yatim:`), r.removedWorktrees.map((w) => path.basename(w)).join(', '));
    if (repoCount > 0) console.log(c.g(`✓ Dihapus ${repoCount} repositori tak terpakai:`), r.removedRepos.map((r) => path.basename(r)).join(', '));
    if (logCount > 0) console.log(c.g(`✓ Dihapus ${logCount} file log basi:`), r.removedLogs.join(', '));
  }
}

function help() {
  console.log(`${c.b('snugcode')} — coding agent di PC-mu, dari terminal & HP

  ${c.g('snugcode')}                 buka UI terminal (folder repo ini jadi sesinya)
  ${c.g('snugcode --computer')}      buka mode komputer (kontrol seluruh PC seperti Claude Code)
  ${c.g('snugcode "prompt"')}        buka UI dan langsung kirim prompt
  ${c.g('snugcode --pick')}          pilih sesi (termasuk sesi dari HP)

  snugcode setup            setup / ubah konfigurasi
  snugcode login            login ulang GitHub (token dicabut/kedaluwarsa)
  snugcode autostart on     jalankan daemon di latar belakang + saat login
  snugcode start | stop     jalankan / hentikan daemon
  snugcode restart          restart daemon di latar belakang
  snugcode update           periksa & pasang pembaruan jarak jauh
  snugcode clean            pindai & bersihkan worktree / repo yatim
  snugcode pin              ganti PIN / buka kunci
  snugcode devices          HP yang terpasang;  snugcode revoke <id|all>
  snugcode status           ringkasan konfigurasi
  snugcode cloud            runner cloud tanpa PC (Codespaces/Docker), dikonfigurasi lewat env & HP`);
}

// ---------- runner cloud ----------
// Isi konfigurasi dari env (idempoten), lalu jalankan daemon di bawah supervisor: restart/update dari
// HP (exit 75) dan crash menyalakannya lagi; exit 0 (menganggur / shutdown) menghentikan supervisor —
// container ikut berhenti. --no-supervise: jalankan daemon langsung di proses ini.
async function cloud() {
  ensureDirs();
  // Dibaca sebelum env rahasia dibuang (scrubSecretEnv).
  const apiKey = process.env.SNUGCODE_API_KEY || '';
  const apiUrl = process.env.SNUGCODE_API_URL || '';
  const { bootstrapCloud, reportStatus } = await import('./runner.js');
  const cfg = loadConfig();
  const sec = loadSecrets();
  let boot;
  try {
    boot = await bootstrapCloud(process.env, cfg, sec);
  } catch (e) {
    await reportStatus(process.env, 'error', 'Konfigurasi runner gagal: ' + e.message);
    throw e;
  }
  const { relinked, warnings } = boot;
  saveConfig(cfg);
  saveSecrets(sec);
  scrubSecretEnv();
  console.log(c.b('snugcode cloud') + c.d(` — ${cfg.machineName} · @${cfg.relayLogin || '?'} · ${cfg.runner?.provider}${cfg.runner?.name ? ' ' + cfg.runner.name : ''} · data ${HOME}`));
  if (relinked) console.log(c.g('✓ Runner ditautkan ke mesin ' + cfg.machineId));
  for (const w of warnings) console.log(c.y('! ' + w));
  // SNUGCODE_API_KEY (+ SNUGCODE_API_URL): koneksi model apa pun, dideteksi seperti dari HP.
  if (apiKey && sec.envApplied?.apiKey !== apiKey.slice(-12) + '|' + apiUrl) {
    try {
      const { models: _m, ...conn } = await detectConnection({ key: apiKey, url: apiUrl });
      putConnection(sec, conn);
      mirrorLegacy(cfg, sec);
      sec.envApplied = { ...sec.envApplied, apiKey: apiKey.slice(-12) + '|' + apiUrl };
      saveSecrets(sec);
      saveConfig(cfg);
      console.log(c.g('✓ Koneksi model dari SNUGCODE_API_KEY: ' + conn.label));
    } catch (e) {
      console.log(c.y('! SNUGCODE_API_KEY diabaikan: ' + e.message));
    }
  }
  if (!hasConnections(sec)) console.log(c.y('! Belum ada model tersambung: buka aplikasi di HP → Pengaturan → Model & API key.'));
  // Container yang dinyalakan ulang memakai PID kecil yang sama lagi: daemon.pid dari sesi lalu bisa
  // menunjuk proses lain yang kebetulan hidup. Anggap berjalan hanya bila itu memang daemon snugcode.
  const other = runningPid();
  if (other && other !== process.pid) {
    let ours = true;
    try {
      ours = fs.readFileSync(`/proc/${other}/cmdline`, 'utf8').includes('cli.js');
    } catch {}
    if (ours) return console.log(c.d(`Daemon sudah berjalan (pid ${other}).`));
    fs.rmSync(PID_FILE, { force: true });
  }
  if (flags['no-supervise'] || process.env.SNUGCODE_SUPERVISED === '1') return start();
  const { RESTART_EXIT_CODE } = await import('./updater.js');
  let child = null;
  let stopping = false;
  let backoff = 1000;
  const run = () => {
    const t0 = Date.now();
    child = spawn(process.execPath, [CLI, 'start'], { stdio: 'inherit', env: { ...process.env, SNUGCODE_SUPERVISED: '1' } });
    child.on('exit', (code, signal) => {
      if (stopping || code === 0) return process.exit(0);
      if (Date.now() - t0 > 60_000) backoff = 1000;
      const wait = code === RESTART_EXIT_CODE ? 300 : backoff;
      if (code !== RESTART_EXIT_CODE) {
        console.log(c.y(`! daemon berhenti (${signal || 'exit ' + code}); dinyalakan lagi dalam ${Math.round(wait / 1000)} detik`));
        backoff = Math.min(backoff * 2, 30_000);
      }
      setTimeout(run, wait);
    });
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => ((stopping = true), child?.exitCode === null ? child.kill(sig) : process.exit(0)));
  run();
}

const commands = { tui, help, cloud, setup, login, connect, disconnect, start, stop, restart: cliRestart, update: cliUpdate, clean: cliClean, autostart, pin: resetPin, devices, revoke: () => revoke(args.find((a) => !a.startsWith('--'))), status };
Promise.resolve(commands[cmd]()).catch((e) => {
  console.error(c.r('✗ ' + (e?.message || e)));
  process.exit(1);
});
