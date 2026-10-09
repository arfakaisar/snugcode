// GitHub: login (device flow / kredensial git yang ada), API repo, dan git.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES } from './config.js';
import { safeRm } from './cleaner.js';

const API = 'https://api.github.com';
export const TOKEN_INVALID = 'Login GitHub di PC ini sudah tidak berlaku (token dicabut). Login ulang: tombol "Login GitHub" di aplikasi HP, /login di terminal, atau `snugcode login`.';

export async function gh(token, method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'snugcode',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401) throw new Error(TOKEN_INVALID);
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${data?.message || res.statusText}`);
  return data;
}

const postJson = (url, body) =>
  fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// Device flow dipecah dua: mulai (dapat kode untuk pengguna) dan tunggu (token).
// Token OAuth App tidak kedaluwarsa; hanya berhenti bila dicabut.
export async function deviceFlowStart(clientId) {
  const start = await postJson('https://github.com/login/device/code', { client_id: clientId, scope: 'repo read:user workflow' });
  if (!start.device_code) throw new Error(start.error_description || 'Device flow gagal dimulai');
  return start;
}

/** @param {string} clientId @param {any} start @param {{ signal?: AbortSignal }} [opts] */
export async function deviceFlowWait(clientId, start, { signal } = {}) {
  let interval = (start.interval || 5) * 1000;
  const deadline = Date.now() + (start.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    if (signal?.aborted) throw new Error('dibatalkan');
    const t = await postJson('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      device_code: start.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).catch(() => ({ error: 'authorization_pending' }));
    if (t.access_token) return t.access_token;
    if (t.error === 'slow_down') interval += 5000;
    else if (t.error === 'expired_token') break;
    else if (t.error !== 'authorization_pending') throw new Error(t.error_description || t.error);
  }
  throw new Error('Kode login kedaluwarsa. Mulai login lagi.');
}

export async function deviceFlowLogin(clientId, onCode) {
  const start = await deviceFlowStart(clientId);
  onCode(start.user_code, start.verification_uri);
  return deviceFlowWait(clientId, start);
}

// Ambil token GitHub dari credential helper git yang sudah login (mis. Git Credential Manager).
export function gitCredentialToken() {
  return new Promise((resolve) => {
    const p = spawn('git', ['credential', 'fill'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const m = out.match(/^password=(.+)$/m);
      resolve(m ? m[1].trim() : null);
    });
    p.stdin.end('protocol=https\nhost=github.com\n\n');
  });
}

// `login` (dari config) menghemat satu panggilan /user; tiga request lainnya berjalan paralel.
export async function listRepos(token, q, login) {
  if (!token) return [];
  if (q) {
    const user = login || (await gh(token, 'GET', '/user')).login;
    const [r, r2] = await Promise.all([
      gh(token, 'GET', `/search/repositories?q=${encodeURIComponent(q + ' user:' + user + ' fork:true')}&per_page=30`),
      gh(token, 'GET', `/user/repos?per_page=100&sort=pushed`),
    ]);
    const ql = q.toLowerCase();
    const seen = new Set();
    return [...r2.filter((x) => x.full_name.toLowerCase().includes(ql)), ...r.items]
      .filter((x) => !seen.has(x.full_name) && seen.add(x.full_name))
      .map(slim);
  }
  return (await gh(token, 'GET', '/user/repos?per_page=50&sort=pushed')).map(slim);
}
const slim = (r) => ({ full: r.full_name, private: r.private, branch: r.default_branch, pushed: r.pushed_at, desc: r.description });

// ---------- git ----------
// Token disuntikkan lewat env hanya untuk perintah git milik daemon,
// tidak pernah ditulis ke .git/config dan tidak terlihat oleh agen.
export function gitEnv(token) {
  // Jangan pernah memunculkan dialog login (Git Credential Manager) di desktop:
  // daemon sering dipakai dari jauh dan dialog itu akan menggantung proses.
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64');
  }
  return env;
}

export function git(cwd, args, token, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: { ...gitEnv(token), ...opts.env }, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 10 * 60 * 1000 }, (err, stdout, stderr) => {
      const msg = (stderr || err?.message || '').trim();
      if (err && token && /Authentication failed|could not read Username|terminal prompts disabled|returned error: 40[13]/i.test(msg)) reject(new Error(TOKEN_INVALID));
      else if (err) reject(new Error(msg));
      else resolve(stdout);
    });
  });
}

const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');

// Nama folder clone di ~/.snugcode/workspaces untuk "owner/nama" (dipakai juga oleh pembersih).
export const repoDirName = (full) => {
  const [owner = '', name = ''] = String(full).split('/');
  return safe(owner) + '__' + safe(name);
};

// Penanda kapan clone dasar terakhir dipakai: clone yang tidak dipakai sesi mana pun tetap
// disimpan beberapa hari (sesi baru tidak perlu clone ulang), baru kemudian dibersihkan.
export const LAST_USED = '.last-used';
export function touchRepo(repoDir) {
  try {
    const f = path.join(repoDir, LAST_USED);
    const now = new Date();
    if (fs.existsSync(f)) fs.utimesSync(f, now, now);
    else fs.writeFileSync(f, '');
  } catch {}
}

// Clone dasar per repo (tanpa checkout) + git worktree per sesi,
// supaya beberapa sesi di repo yang sama tidak saling bertabrakan.
export async function prepareWorktree(token, full, { base, branch, sessionId }) {
  const repoDir = path.join(WORKSPACES, repoDirName(full));
  const baseDir = path.join(repoDir, '_base');
  if (!fs.existsSync(path.join(baseDir, '.git'))) {
    fs.mkdirSync(repoDir, { recursive: true });
    await git(repoDir, ['clone', '--no-checkout', '--filter=blob:none', `https://github.com/${full}.git`, '_base'], token);
  }
  // Clone tetap "memegang" branch default (mis. main) walau tanpa checkout,
  // sehingga branch itu tidak bisa dibuka di worktree sesi. Lepaskan HEAD-nya
  // (detached) tanpa menyentuh file. Aman diulang untuk clone lama.
  if (await git(baseDir, ['symbolic-ref', '-q', 'HEAD']).then(() => true, () => false)) {
    const head = (await git(baseDir, ['rev-parse', 'HEAD'])).trim();
    await git(baseDir, ['update-ref', '--no-deref', 'HEAD', head]);
  }
  const lockFile = path.join(baseDir, '.git', 'index.lock');
  try {
    if (fs.existsSync(lockFile)) {
      const stat = fs.statSync(lockFile);
      if (Date.now() - stat.mtimeMs > 30000) fs.rmSync(lockFile, { force: true });
    }
  } catch {}
  touchRepo(repoDir);
  await Promise.all([git(baseDir, ['worktree', 'prune']).catch(() => {}), git(baseDir, ['fetch', '--prune', 'origin'], token)]);
  if (!base) base = (await git(baseDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], token).catch(() => 'origin/main')).trim().replace(/^origin\//, '');

  // Branch yang sedang dibuka sesi lain tidak bisa dibuka dua kali.
  const list = await git(baseDir, ['worktree', 'list', '--porcelain']);
  const holder = list
    .split(/\n\n+/)
    .map((b) => ({ dir: b.match(/^worktree (.+)$/m)?.[1], ref: b.match(/^branch (.+)$/m)?.[1] }))
    .find((w) => w.ref === 'refs/heads/' + branch);
  if (holder) {
    const sid = path.basename(holder.dir || '').replace(/^s-/, '');
    throw new Error(`Branch "${branch}" sedang dibuka di sesi lain (${sid}). Buka sesi itu, atau hapus sesinya dulu.`);
  }

  const wt = path.join(repoDir, 's-' + sessionId);
  // Ref remote baru saja disegarkan oleh `fetch --prune`: cukup cek lokal, tanpa ls-remote ke jaringan.
  const hasRef = (ref) => git(baseDir, ['show-ref', '--verify', '--quiet', ref]).then(() => true, () => false);
  const [hasRemote, hasLocal] = await Promise.all([hasRef('refs/remotes/origin/' + branch), hasRef('refs/heads/' + branch)]);
  if (hasLocal) {
    // Branch lokal (mis. dari sesi lama yang belum di-push): jangan ditimpa.
    await git(baseDir, ['worktree', 'add', wt, branch], token);
    if (hasRemote) {
      await git(wt, ['branch', '--set-upstream-to=origin/' + branch]);
      await git(wt, ['merge', '--ff-only', 'origin/' + branch]).catch(() => {}); // bercabang → biarkan, terlihat di status git
    }
  } else if (hasRemote) {
    await git(baseDir, ['worktree', 'add', '--track', '-b', branch, wt, 'origin/' + branch], token);
  } else {
    await git(baseDir, ['worktree', 'add', '--no-track', '-b', branch, wt, 'origin/' + base], token);
  }
  return { cwd: wt, base, branch };
}

// Folder repo lokal yang dibuka langsung dari terminal (seperti `claude`):
// tanpa clone/worktree, agen bekerja di folder itu sendiri.
export async function inspectLocalRepo(dir) {
  const top = (await git(dir, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (!top) throw new Error('Folder ini bukan repo git: ' + dir);
  const url = (await git(top, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const m = url.match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  const repo = m ? `${m[1]}/${m[2]}` : 'lokal/' + path.basename(top);
  const branch = (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim();
  const base = (await git(top, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim().replace(/^origin\//, '') || branch;
  return { cwd: path.resolve(top), repo, branch, base, github: !!m };
}

// Branch aktif tanpa menjalankan git (dibaca dari HEAD; worktree punya file .git).
export function currentBranch(cwd) {
  try {
    let gitDir = path.join(cwd, '.git');
    if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(cwd, fs.readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
  } catch {
    return null;
  }
}

export async function removeWorktree(cwd) {
  const baseDir = path.join(path.dirname(cwd), '_base');
  touchRepo(path.dirname(cwd));
  try {
    if (fs.existsSync(baseDir)) {
      await git(baseDir, ['worktree', 'remove', '--force', cwd]).catch(() => {});
      await git(baseDir, ['worktree', 'prune']).catch(() => {});
    }
  } catch {}
  safeRm(cwd);
}

// Satu `git status --porcelain=v2 --branch` memberi branch, upstream, ahead/behind, dan daftar
// file sekaligus (dulu 4 proses berurutan); log diambil paralel.
export function parseStatusV2(out) {
  let branch = 'HEAD';
  let ahead = null;
  let behind = null;
  let upstream = false;
  const files = [];
  for (const l of out.split('\n')) {
    if (!l) continue;
    if (l.startsWith('# ')) {
      const [, key, ...rest] = l.split(' ');
      if (key === 'branch.head') branch = rest[0] === '(detached)' ? 'HEAD' : rest.join(' ');
      else if (key === 'branch.upstream') upstream = true;
      else if (key === 'branch.ab') {
        ahead = Math.abs(+rest[0]);
        behind = Math.abs(+rest[1]);
      }
      continue;
    }
    const xy = (s) => s.replace(/\./g, ' ');
    if (l[0] === '?') files.push({ st: '??', path: l.slice(2) });
    else if (l[0] === '1') files.push({ st: xy(l.slice(2, 4)), path: l.split(' ').slice(8).join(' ') });
    else if (l[0] === '2') {
      const [p, orig] = l.split(' ').slice(9).join(' ').split('\t');
      files.push({ st: xy(l.slice(2, 4)), path: orig ? `${orig} -> ${p}` : p });
    } else if (l[0] === 'u') files.push({ st: xy(l.slice(2, 4)), path: l.split(' ').slice(10).join(' ') });
  }
  return { branch, files, ahead, behind, upstream };
}

export async function gitStatus(cwd) {
  const [st, log] = await Promise.all([
    git(cwd, ['status', '--porcelain=v2', '--branch', '-uall']).then(parseStatusV2),
    git(cwd, ['log', '-n', '8', '--pretty=format:%h %s']).catch(() => ''),
  ]);
  let { ahead, behind } = st;
  if (!st.upstream || ahead === null) {
    // Belum ada upstream: hitung commit yang belum ada di remote mana pun.
    ahead = +(await git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes']).catch(() => '0')).trim();
    behind = null;
  }
  return { branch: st.branch, files: st.files, ahead, behind, log: log.split('\n').filter(Boolean), hasUpstream: behind !== null };
}

export async function gitDiff(cwd, { limit = 400 * 1024 } = {}) {
  // intent-to-add agar file baru ikut muncul di diff.
  await git(cwd, ['add', '-A', '-N']).catch(() => {});
  let diff = await git(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff']);
  const LIMIT = limit;
  let truncated = false;
  if (diff.length > LIMIT) {
    diff = diff.slice(0, LIMIT);
    truncated = true;
  }
  return { diff, truncated };
}

export async function gitCommit(cwd, message, identity) {
  await git(cwd, ['add', '-A']);
  const cfg = [];
  const name = (await git(cwd, ['config', 'user.name']).catch(() => '')).trim();
  const email = (await git(cwd, ['config', 'user.email']).catch(() => '')).trim();
  if (!name && identity?.login) cfg.push('-c', 'user.name=' + identity.login);
  if (!email && identity?.login) cfg.push('-c', `user.email=${identity.id}+${identity.login}@users.noreply.github.com`);
  await git(cwd, [...cfg, 'commit', '-m', message]);
  return (await git(cwd, ['log', '-n', '1', '--pretty=format:%h %s'])).trim();
}

export async function gitPush(cwd, token) {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await git(cwd, ['push', '-u', 'origin', 'HEAD:refs/heads/' + branch], token);
  return branch;
}

export async function createPR(token, full, { head, base, title, body }) {
  const pr = await gh(token, 'POST', `/repos/${full}/pulls`, { head, base, title, body });
  return { number: pr.number, url: pr.html_url };
}
