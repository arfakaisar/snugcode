// GitHub: login (device flow / existing git credentials), repo API, and git.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES } from './config.js';
import { safeRm } from './cleaner.js';
import { snapshot, DIFF_INDEX } from './checkpoint.js';

const API = 'https://api.github.com';
export const TOKEN_INVALID = 'The GitHub login on this PC is no longer valid (token revoked). Sign in again: the "Sign in to GitHub" button in the phone app, /login in the terminal, or `snugcode login`.';

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

// The device flow is split in two: start (get a code for the user) and wait (token).
// OAuth App tokens don't expire; they only stop working when revoked.
export async function deviceFlowStart(clientId) {
  const start = await postJson('https://github.com/login/device/code', { client_id: clientId, scope: 'repo read:user workflow' });
  if (!start.device_code) throw new Error(start.error_description || 'Device flow failed to start');
  return start;
}

/** @param {string} clientId @param {any} start @param {{ signal?: AbortSignal }} [opts] */
export async function deviceFlowWait(clientId, start, { signal } = {}) {
  let interval = (start.interval || 5) * 1000;
  const deadline = Date.now() + (start.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    if (signal?.aborted) throw new Error('cancelled');
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
  throw new Error('The login code expired. Start signing in again.');
}

export async function deviceFlowLogin(clientId, onCode) {
  const start = await deviceFlowStart(clientId);
  onCode(start.user_code, start.verification_uri);
  return deviceFlowWait(clientId, start);
}

// Get a GitHub token from git's credential helper if already signed in (e.g. Git Credential Manager).
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

// `login` (from config) saves one /user call; the other three requests run in parallel.
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
// The token is injected via env only for the daemon's own git commands,
// never written to .git/config and never visible to the agent.
export function gitEnv(token) {
  // Never pop up a login dialog (Git Credential Manager) on the desktop:
  // the daemon is often used remotely and that dialog would hang the process.
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
    const child = execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: { ...gitEnv(token), ...opts.env }, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 10 * 60 * 1000 }, (err, stdout, stderr) => {
      const msg = (stderr || err?.message || '').trim();
      if (err && token && /Authentication failed|could not read Username|terminal prompts disabled|returned error: 40[13]/i.test(msg)) reject(new Error(TOKEN_INVALID));
      else if (err) reject(new Error(msg));
      else resolve(stdout);
    });
    // stdin for commands like `update-ref --stdin`; otherwise closed so git never waits for input. git often exits
    // before reading it (EPIPE on Linux): ignored, the exit code and stderr above say what happened.
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input);
  });
}

const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');

// Clone folder name in ~/.snugcode/workspaces for "owner/name" (also used by the cleaner).
export const repoDirName = (full) => {
  const [owner = '', name = ''] = String(full).split('/');
  return safe(owner) + '__' + safe(name);
};

// Marker for when a base clone was last used: clones not used by any session are still
// kept for a few days (new sessions don't need a fresh clone), then cleaned up.
export const LAST_USED = '.last-used';
export function touchRepo(repoDir) {
  try {
    const f = path.join(repoDir, LAST_USED);
    const now = new Date();
    if (fs.existsSync(f)) fs.utimesSync(f, now, now);
    else fs.writeFileSync(f, '');
  } catch {}
}

// One base clone per repo (no checkout) + a git worktree per session,
// so several sessions on the same repo don't collide.
export async function prepareWorktree(token, full, { base, branch, sessionId }) {
  const repoDir = path.join(WORKSPACES, repoDirName(full));
  const baseDir = path.join(repoDir, '_base');
  if (!fs.existsSync(path.join(baseDir, '.git'))) {
    fs.mkdirSync(repoDir, { recursive: true });
    await git(repoDir, ['clone', '--no-checkout', '--filter=blob:none', `https://github.com/${full}.git`, '_base'], token);
  }
  // The clone still "holds" the default branch (e.g. main) even without a checkout,
  // so that branch couldn't be opened in a session worktree. Detach its HEAD
  // without touching files. Safe to repeat for old clones.
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

  // A branch open in another session can't be opened twice.
  const list = await git(baseDir, ['worktree', 'list', '--porcelain']);
  const holder = list
    .split(/\n\n+/)
    .map((b) => ({ dir: b.match(/^worktree (.+)$/m)?.[1], ref: b.match(/^branch (.+)$/m)?.[1] }))
    .find((w) => w.ref === 'refs/heads/' + branch);
  if (holder) {
    const sid = path.basename(holder.dir || '').replace(/^s-/, '');
    throw new Error(`Branch "${branch}" is open in another session (${sid}). Open that session, or delete it first.`);
  }

  const wt = path.join(repoDir, 's-' + sessionId);
  // Remote refs were just refreshed by `fetch --prune`: a local check is enough, no ls-remote over the network.
  const hasRef = (ref) => git(baseDir, ['show-ref', '--verify', '--quiet', ref]).then(() => true, () => false);
  const [hasRemote, hasLocal] = await Promise.all([hasRef('refs/remotes/origin/' + branch), hasRef('refs/heads/' + branch)]);
  if (hasLocal) {
    // Local branch (e.g. from an old unpushed session): don't overwrite it.
    await git(baseDir, ['worktree', 'add', wt, branch], token);
    if (hasRemote) {
      await git(wt, ['branch', '--set-upstream-to=origin/' + branch]);
      await git(wt, ['merge', '--ff-only', 'origin/' + branch]).catch(() => {}); // diverged → leave it, visible in git status
    }
  } else if (hasRemote) {
    await git(baseDir, ['worktree', 'add', '--track', '-b', branch, wt, 'origin/' + branch], token);
  } else {
    await git(baseDir, ['worktree', 'add', '--no-track', '-b', branch, wt, 'origin/' + base], token);
  }
  return { cwd: wt, base, branch };
}

// A local repo folder opened straight from the terminal (like `claude`):
// no clone/worktree, the agent works in that folder itself.
export async function inspectLocalRepo(dir) {
  const top = (await git(dir, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (!top) throw new Error('This folder is not a git repo: ' + dir);
  const url = (await git(top, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const m = url.match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  const repo = m ? `${m[1]}/${m[2]}` : 'local/' + path.basename(top);
  const branch = (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim();
  const base = (await git(top, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim().replace(/^origin\//, '') || branch;
  return { cwd: path.resolve(top), repo, branch, base, github: !!m };
}

// Current branch without running git (read from HEAD; worktrees have a .git file).
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

// One `git status --porcelain=v2 --branch` gives the branch, upstream, ahead/behind, and the file
// list at once (formerly 4 sequential processes); the log is fetched in parallel.
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
    // No upstream yet: count commits not on any remote.
    ahead = +(await git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes']).catch(() => '0')).trim();
    behind = null;
  }
  return { branch: st.branch, files: st.files, ahead, behind, log: log.split('\n').filter(Boolean), hasUpstream: behind !== null };
}

// Every uncommitted change (new files included) as one diff against HEAD. The working tree is snapshotted through a
// separate temporary index (checkpoint.js) instead of `git add -N`: the user's own index is never modified, which
// matters in local sessions where the repo is the user's own folder.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export async function worktreeDiff(cwd, paths = []) {
  const tree = await snapshot(cwd, { index: DIFF_INDEX });
  const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{tree}']).then((s) => s.trim(), () => EMPTY_TREE);
  return git(cwd, ['diff', head, tree, '--no-color', '--no-ext-diff', ...(paths.length ? ['--', ...paths] : [])]);
}

export async function gitDiff(cwd, { limit = 400 * 1024 } = {}) {
  let diff = await worktreeDiff(cwd);
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
