#!/usr/bin/env node
// pocketcode — CLI daemon.
//   pocketcode setup     : setup awal (relay, 9router, GitHub, PIN)
//   pocketcode start     : jalankan daemon
//   pocketcode stop      : hentikan daemon yang berjalan di latar belakang
//   pocketcode autostart : jalankan otomatis saat login (on|off)
//   pocketcode pin       : ganti PIN / buka kunci setelah salah berkali-kali
//   pocketcode devices   : daftar HP terpasang;  pocketcode revoke <id|all>
//   pocketcode status    : ringkasan konfigurasi
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { loadConfig, saveConfig, loadSecrets, saveSecrets, ensureDirs, HOME, SESSIONS_DIR } from './config.js';
import { DEFAULT_RELAY_URL, GITHUB_CLIENT_ID, DEFAULT_ROUTER_URL, PACKAGE_SPEC } from './defaults.js';
import { deviceFlowLogin, gitCredentialToken, gh } from './github.js';
import { pinToPrs, PIN_RE, normalizePin } from '../shared/crypto.js';
import { fastModelVariant } from '../shared/models.js';
import { checkUpdate, performUpdate } from './updater.js';
import { writeAutostart, disableAutostart, syncAutostart } from './autostart.js';

const CLI = fileURLToPath(import.meta.url);
const COMMAND_NAMES = ['setup', 'login', 'start', 'stop', 'restart', 'update', 'clean', 'autostart', 'pin', 'devices', 'revoke', 'status', 'help'];
const args = process.argv.slice(2);
// Tanpa perintah -> buka TUI (seperti `claude`). Kata pertama yang bukan
// perintah dianggap prompt awal: pocketcode "jelaskan repo ini".
const cmd = args[0] && COMMAND_NAMES.includes(args[0]) ? args.shift() : 'tui';
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    flags[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
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

async function fetchModels(routerUrl, key) {
  const r = await fetch(routerUrl.replace(/\/+$/, '') + '/models', { headers: { authorization: 'Bearer ' + key } });
  if (r.status === 401) throw new Error('API key ditolak 9router');
  if (!r.ok) throw new Error('9router menjawab ' + r.status);
  const j = await r.json();
  return j.data.filter((m) => m.capabilities?.tools !== false).map((m) => m.id);
}

async function pickModel(models, label, def) {
  if (flags[label]) return flags[label];
  models.forEach((m, i) => console.log(c.d(String(i + 1).padStart(3)) + '  ' + m));
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
  console.log(c.b('\npocketcode setup') + c.d(`  (data disimpan di ${HOME})\n`));

  // 1. 9router
  console.log(c.b('1) 9router'));
  cfg.routerUrl = flags.router || (flags.key ? cfg.routerUrl || DEFAULT_ROUTER_URL : await ask('URL 9router', cfg.routerUrl || DEFAULT_ROUTER_URL));
  let models;
  for (;;) {
    const key = flags.key || (await ask('API key 9router milikmu', sec.routerKey ? '(tetap)' : '', { hidden: true }));
    if (key && key !== '(tetap)') sec.routerKey = key;
    try {
      models = await fetchModels(cfg.routerUrl, sec.routerKey);
      console.log(c.g(`✓ Key valid, ${models.length} model tersedia.`));
      break;
    } catch (e) {
      console.log(c.r('✗ ' + e.message));
      if (flags.key) process.exit(1);
    }
  }
  cfg.model = await pickModel(models, 'model', cfg.model || models[0]);
  const smallDefault = cfg.smallModel || fastModelVariant(cfg.model);
  cfg.smallModel = await pickModel(models, 'small-model', smallDefault);

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
  console.log(c.g('\n✓ Setup selesai.') + ` Jalankan ${c.b('pocketcode start')} (atau ${c.b('pocketcode autostart on')}), lalu buka ${c.b(cfg.relayUrl)} di HP.\n`);
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
    console.log(`    npm i -g ${PACKAGE_SPEC}   lalu   pocketcode autostart on`);
  }
  if (mode === 'off') {
    disableAutostart();
    return console.log(c.g('✓ Autostart dimatikan.'));
  }
  const file = writeAutostart(CLI, process.execPath);
  console.log(c.g('✓ Autostart aktif: ') + file);

  // Nyalakan sekarang juga bila belum berjalan.
  if (!runningPid()) {
    if (process.platform === 'linux') spawnSync('systemctl', ['--user', 'start', 'pocketcode']);
    else if (process.platform === 'darwin') spawnSync('launchctl', ['load', path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.pocketcode.plist')]);
    else spawnDetached();
    console.log(c.g('✓ Daemon dijalankan di latar belakang.') + c.d(` Log: ${LOG_FILE}`));
  } else console.log(c.d('Daemon sudah berjalan.'));
}

async function start() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  if (!cfg.relayUrl || !sec.machineToken || !sec.routerKey || !sec.prs) {
    console.log(c.y('Belum setup. Menjalankan setup dulu…\n'));
    await setup();
    return start();
  }
  ensureDirs();
  const other = runningPid();
  if (other && other !== process.pid) {
    console.log(c.y(`Daemon sudah berjalan (pid ${other}). Hentikan dengan `) + c.b('pocketcode stop'));
    process.exit(1);
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on('exit', () => runningPid() === process.pid && fs.rmSync(PID_FILE, { force: true }));
  // Selalu sinkronkan skrip autostart jika autostart pernah diaktifkan pada sistem ini
  syncAutostart(CLI, process.execPath);
  if (flags.log) {
    const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const write = (...a) => out.write(new Date().toISOString() + ' ' + util.format(...a).replace(/\x1b\[[0-9;]*m/g, '') + '\n');
    console.log = write;
    console.error = write;
  }
  const { Daemon } = await import('./server.js');
  console.log(c.b('pocketcode') + c.d(` — ${cfg.machineName} · model ${cfg.model} · relay ${cfg.relayUrl}`));
  if (sec.pinFails >= 5) console.log(c.r('! Pairing terkunci karena PIN salah berkali-kali. Jalankan `pocketcode pin`.'));
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
    relay: cfg.relayUrl,
    account: cfg.relayLogin,
    machine: cfg.machineName,
    router: cfg.routerUrl,
    model: cfg.model,
    smallModel: cfg.smallModel,
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

function isSetUp() {
  const cfg = loadConfig();
  const sec = loadSecrets();
  return !!(cfg.relayUrl && sec.machineToken && sec.routerKey && sec.prs);
}

async function tui() {
  if (!isSetUp()) {
    console.log(c.y('Belum setup. Menjalankan setup dulu…\n'));
    await setup();
  }
  const { runTui } = await import('./tui.js');
  const prompt = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  await runTui({ prompt, pick: !!flags.pick || !!flags.sessions });
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
  console.log(c.b('Memeriksa pembaruan pocketcode…'));
  const st = await checkUpdate(cfg, sec);
  if (!st.updateAvailable && !flags.force) {
    console.log(c.g('✓ pocketcode sudah versi terbaru') + c.d(` (${st.currentCommit})`));
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
  console.log(`${c.b('pocketcode')} — coding agent di PC-mu, dari terminal & HP

  ${c.g('pocketcode')}                 buka UI terminal (folder repo ini jadi sesinya)
  ${c.g('pocketcode "prompt"')}        buka UI dan langsung kirim prompt
  ${c.g('pocketcode --pick')}          pilih sesi (termasuk sesi dari HP)

  pocketcode setup            setup / ubah konfigurasi
  pocketcode login            login ulang GitHub (token dicabut/kedaluwarsa)
  pocketcode autostart on     jalankan daemon di latar belakang + saat login
  pocketcode start | stop     jalankan / hentikan daemon
  pocketcode restart          restart daemon di latar belakang
  pocketcode update           periksa & pasang pembaruan jarak jauh
  pocketcode clean            pindai & bersihkan worktree / repo yatim
  pocketcode pin              ganti PIN / buka kunci
  pocketcode devices          HP yang terpasang;  pocketcode revoke <id|all>
  pocketcode status           ringkasan konfigurasi`);
}

const commands = { tui, help, setup, login, start, stop, restart: cliRestart, update: cliUpdate, clean: cliClean, autostart, pin: resetPin, devices, revoke: () => revoke(args.find((a) => !a.startsWith('--'))), status };
Promise.resolve(commands[cmd]()).catch((e) => {
  console.error(c.r('✗ ' + (e?.message || e)));
  process.exit(1);
});
