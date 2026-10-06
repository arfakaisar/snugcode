// GitHub: login (device flow / kredensial git yang ada), API repo, dan git.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES } from './config.js';

const API = 'https://api.github.com';

export async function gh(token, method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'pocketcode',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${data?.message || res.statusText}`);
  return data;
}

export async function deviceFlowLogin(clientId, onCode) {
  const post = (url, body) =>
    fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const start = await post('https://github.com/login/device/code', { client_id: clientId, scope: 'repo read:user' });
  if (!start.device_code) throw new Error(start.error_description || 'Device flow gagal dimulai');
  onCode(start.user_code, start.verification_uri);
  let interval = (start.interval || 5) * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, interval));
    const t = await post('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      device_code: start.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (t.access_token) return t.access_token;
    if (t.error === 'slow_down') interval += 5000;
    else if (t.error !== 'authorization_pending') throw new Error(t.error_description || t.error);
  }
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

export async function listRepos(token, q) {
  if (!token) return [];
  if (q) {
    const me = await gh(token, 'GET', '/user');
    const r = await gh(token, 'GET', `/search/repositories?q=${encodeURIComponent(q + ' user:' + me.login + ' fork:true')}&per_page=30`);
    const r2 = await gh(token, 'GET', `/user/repos?per_page=100&sort=pushed`);
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
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64');
  }
  return env;
}

export function git(cwd, args, token, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: gitEnv(token), maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');

// Clone dasar per repo (tanpa checkout) + git worktree per sesi,
// supaya beberapa sesi di repo yang sama tidak saling bertabrakan.
export async function prepareWorktree(token, full, { base, branch, sessionId }) {
  const [owner, name] = full.split('/');
  const repoDir = path.join(WORKSPACES, safe(owner) + '__' + safe(name));
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
  await git(baseDir, ['fetch', '--prune', 'origin'], token);
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
  const hasRemote = !!(await git(baseDir, ['ls-remote', '--heads', 'origin', branch], token)).trim();
  const hasLocal = await git(baseDir, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]).then(() => true, () => false);
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

export async function removeWorktree(cwd) {
  const baseDir = path.join(path.dirname(cwd), '_base');
  await git(baseDir, ['worktree', 'remove', '--force', cwd]).catch(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await git(baseDir, ['worktree', 'prune']).catch(() => {});
}

export async function gitStatus(cwd, token) {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const porcelain = await git(cwd, ['status', '--porcelain=v1', '-uall']);
  const files = porcelain
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ st: l.slice(0, 2), path: l.slice(3) }));
  let ahead = null;
  let behind = null;
  try {
    const ab = (await git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/);
    ahead = +ab[0];
    behind = +ab[1];
  } catch {
    // Belum ada upstream: hitung commit yang belum ada di remote mana pun.
    ahead = +(await git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes']).catch(() => '0')).trim();
  }
  const log = (await git(cwd, ['log', '-n', '8', '--pretty=format:%h %s'])).split('\n').filter(Boolean);
  return { branch, files, ahead, behind, log, hasUpstream: behind !== null };
}

export async function gitDiff(cwd) {
  // intent-to-add agar file baru ikut muncul di diff.
  await git(cwd, ['add', '-A', '-N']).catch(() => {});
  let diff = await git(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff']);
  const LIMIT = 400 * 1024;
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
