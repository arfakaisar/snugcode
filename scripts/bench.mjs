// Benchmark engine per model: tugas coding kecil yang sama dijalankan di tiap engine (Claude Agent SDK,
// Codex, Gemini CLI) untuk satu model, lalu dinilai dengan test otomatis. Hasilnya tabel tingkat lulus,
// waktu & token, plus baris saran untuk shared/engine-table.js.
//
//   npm run bench -- --models gemini:gemini-3.8-flash,openai:gpt-5.5 [--engines claude,gemini,codex]
//                    [--tasks fix-bug,feature,rename] [--runs 2] [--timeout 600] [--out hasil.json]
//
// Memakai koneksi & API key di PC ini (biaya token ditagihkan ke key-mu). Berjalan di folder data
// sementara: riwayat sesi asli tidak tersentuh, tool yang sudah terpasang (Codex/Gemini CLI) dipakai ulang.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINES = ['claude', 'codex', 'gemini'];
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const [k, v] = a.slice(2).split(/=(.*)/s);
  args[k] = v ?? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
}

// ---------- tugas: file awal + test yang harus lulus ----------
const TASKS = {
  'fix-bug': {
    prompt: 'The test in test.js fails. Find and fix the bug in sum.js (do not change test.js). Run `node test.js` to verify.',
    files: {
      'sum.js': 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n',
      'test.js': "import assert from 'node:assert/strict';\nimport { sumTo } from './sum.js';\nassert.equal(sumTo(1), 1);\nassert.equal(sumTo(4), 10);\nassert.equal(sumTo(0), 0);\nconsole.log('ok');\n",
      'package.json': '{ "type": "module" }\n',
    },
    check: ['node', 'test.js'],
  },
  feature: {
    prompt:
      'Implement `slugify(text)` in slug.js: lowercase, strip accents (é -> e), replace every run of non-alphanumeric characters with a single "-", and trim leading/trailing "-". Make `node test.js` pass without editing test.js.',
    files: {
      'slug.js': 'export function slugify(text) {\n  // TODO\n}\n',
      'test.js': "import assert from 'node:assert/strict';\nimport { slugify } from './slug.js';\nassert.equal(slugify('Hello World'), 'hello-world');\nassert.equal(slugify('  Café   au lait!! '), 'cafe-au-lait');\nassert.equal(slugify('a--b__c'), 'a-b-c');\nassert.equal(slugify('---'), '');\nconsole.log('ok');\n",
      'package.json': '{ "type": "module" }\n',
    },
    check: ['node', 'test.js'],
  },
  rename: {
    prompt: 'Rename the function `getUsr` to `getUser` everywhere in this project (all files, including call sites), keeping behavior identical. Then run `node test.js`.',
    files: {
      'users.js': "const USERS = { 1: 'ana', 2: 'budi' };\nexport function getUsr(id) {\n  return USERS[id] ?? null;\n}\n",
      'greet.js': "import { getUsr } from './users.js';\nexport const greet = (id) => `halo ${getUsr(id) ?? 'tamu'}`;\n",
      'test.js': "import assert from 'node:assert/strict';\nimport * as users from './users.js';\nimport { greet } from './greet.js';\nimport fs from 'node:fs';\nassert.equal(users.getUser(1), 'ana');\nassert.equal(users.getUsr, undefined);\nassert.equal(greet(2), 'halo budi');\nassert.equal(greet(9), 'halo tamu');\nassert.ok(!/getUsr/.test(fs.readFileSync('greet.js', 'utf8')));\nconsole.log('ok');\n",
      'package.json': '{ "type": "module" }\n',
    },
    check: ['node', 'test.js'],
  },
};

if (!process.env.SNUGCODE_BENCH_CHILD) await parent();
else await child();

// ---------- proses induk: folder data sementara berisi salinan koneksi ----------
async function parent() {
  if (!args.models || args.help) {
    console.log('Pakai: npm run bench -- --models <koneksi:model,...> [--engines claude,codex,gemini] [--tasks ' + Object.keys(TASKS).join(',') + '] [--runs 1] [--timeout 600] [--out hasil.json]');
    process.exit(args.help ? 0 : 1);
  }
  const { loadConfig, loadSecrets, HOME } = await import('../daemon/config.js');
  const config = loadConfig();
  const secrets = loadSecrets();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-bench-'));
  try {
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ ...config, relayUrl: null }));
    fs.writeFileSync(path.join(tmp, 'secrets.json'), JSON.stringify({ connections: secrets.connections || {}, routerKey: secrets.routerKey }), { mode: 0o600 });
    if (fs.existsSync(path.join(HOME, 'tools'))) fs.symlinkSync(path.join(HOME, 'tools'), path.join(tmp, 'tools'), 'dir');
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, SNUGCODE_HOME: tmp, SNUGCODE_BENCH_CHILD: '1' } });
    process.exitCode = r.status ?? 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- proses anak: jalankan tugas lewat SessionManager asli ----------
async function child() {
  const { loadConfig, loadSecrets } = await import('../daemon/config.js');
  const { SessionManager } = await import('../daemon/sessions.js');
  const { resolveRoute } = await import('../daemon/providers.js');
  const config = loadConfig();
  const secrets = loadSecrets();
  const mgr = new SessionManager({ config, secrets, log: (m) => process.env.DEBUG && console.error('[daemon]', m) });
  const models = args.models.split(',').map((x) => x.trim()).filter(Boolean);
  const engines = (args.engines || ENGINES.join(',')).split(',').filter((e) => ENGINES.includes(e));
  const tasks = (args.tasks || Object.keys(TASKS).join(',')).split(',').filter((t) => TASKS[t]);
  const runs = Math.max(1, Number(args.runs) || 1);
  const timeout = (Number(args.timeout) || 600) * 1000;
  const results = [];

  for (const model of models) {
    for (const engine of engines) {
      process.env.SNUGCODE_ENGINE = engine;
      let route;
      try {
        route = resolveRoute(secrets, model);
      } catch (e) {
        console.log(`✗ ${model}: ${e.message}`);
        break;
      }
      if (route.engine !== engine) {
        console.log(`… ${model} × ${engine}: endpoint tidak mendukung engine ini, dilewati`);
        continue;
      }
      for (const task of tasks)
        for (let i = 0; i < runs; i++) {
          const r = await runTask(mgr, model, engine, task, timeout);
          results.push(r);
          console.log(`${r.pass ? '✔' : '✗'} ${model} × ${engine} × ${task}#${i + 1}: ${(r.ms / 1000).toFixed(1)} s, ${r.in}+${r.out} token${r.err ? ' · ' + r.err : ''}`);
        }
    }
  }
  await mgr.close();
  report(results);
  if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  process.exit(0);
}

async function runTask(mgr, model, engine, task, timeout) {
  const T = TASKS[task];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `snug-bench-${task}-`));
  for (const [f, c] of Object.entries(T.files)) fs.writeFileSync(path.join(dir, f), c);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=bench', '-c', 'user.email=bench@snugcode', 'commit', '-qm', 'awal');
  const s = await mgr.create({ local: dir, model });
  s.meta.auto = true;
  const t0 = Date.now();
  let done = null;
  let err = '';
  await new Promise((resolve) => {
    const timer = setTimeout(() => ((err = 'batas waktu'), s.interrupt().finally(resolve)), timeout);
    s.on('event', (e) => {
      if (process.env.DEBUG) console.error('[event]', JSON.stringify(e).slice(0, 300));
      // Bench tanpa pengguna: setiap izin (mis. perintah shell Gemini CLI) disetujui.
      if (e.k === 'perm') s.answerPermission(e.pid, 'allow');
      if (e.k === 'error') err ||= String(e.d).slice(0, 160);
      if (e.k === 'done') ((done = e), clearTimeout(timer), resolve());
    });
    s.send(T.prompt).catch((e) => ((err = e.message), clearTimeout(timer), resolve()));
  });
  const ms = Date.now() - t0;
  const check = spawnSync(T.check[0], T.check.slice(1), { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  const pass = check.status === 0;
  if (!pass && !err && done && !done.ok) err = String(done.err || 'agen gagal').slice(0, 160);
  if (!pass && !err) err = (String(check.stderr || check.stdout).split('\n').find((l) => /Error|assert/i.test(l)) || 'test gagal').trim().slice(0, 160);
  await s.close?.();
  mgr.sessions.delete(s.meta.id);
  fs.rmSync(dir, { recursive: true, force: true });
  const u = done?.usage || {};
  return { model, engine, task, pass, ms, in: u.in || 0, out: u.out || 0, cr: u.cr || 0, turns: done?.turns || 0, err: pass ? '' : err };
}

function report(results) {
  if (!results.length) return console.log('Tidak ada hasil.');
  const med = (xs) => (xs.sort((a, b) => a - b), xs[Math.floor(xs.length / 2)]);
  const groups = new Map();
  for (const r of results) {
    const k = r.model + '|' + r.engine;
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  const rows = [...groups.values()].map((rs) => ({
    model: rs[0].model,
    engine: rs[0].engine,
    pass: rs.filter((r) => r.pass).length,
    n: rs.length,
    ms: med(rs.map((r) => r.ms)),
    tok: Math.round(rs.reduce((a, r) => a + r.in + r.out, 0) / rs.length),
  }));
  console.log('\n| Model | Engine | Lulus | Median waktu | Token rata-rata |\n|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.model} | ${r.engine} | ${r.pass}/${r.n} | ${(r.ms / 1000).toFixed(1)} s | ${r.tok} |`);
  // Saran untuk shared/engine-table.js: lulus terbanyak, seri -> lebih cepat, lalu lebih hemat.
  const better = (a, b) => a.pass / a.n - b.pass / b.n || b.ms - a.ms || b.tok - a.tok;
  const best = new Map();
  for (const r of rows) if (!best.has(r.model) || better(r, best.get(r.model)) > 0) best.set(r.model, r);
  const day = new Date().toISOString().slice(0, 10);
  console.log('\nSaran baris shared/engine-table.js:');
  for (const r of best.values()) {
    const [conn, id] = r.model.includes(':') ? r.model.split(/:(.*)/s) : ['router', r.model];
    const kind = conn.replace(/\d+$/, '');
    console.log(`  { kind: '${kind}', model: '^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$', engine: '${r.engine}', why: 'bench ${day}: ${r.pass}/${r.n} lulus, median ${(r.ms / 1000).toFixed(0)} s' },`);
  }
}
