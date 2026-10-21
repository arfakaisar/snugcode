// The daemon's RPC method table (phone via relay & terminal via IPC): one function per method, (conn, params) -> result.
// `c.d` = Daemon (server.js), `c.big` = binary channel. Input is validated here: client messages are never trusted.
import * as C from '../shared/crypto.js';
import { saveConfig, isCloud, resetPinLock } from './config.js';
import { getConn, detectConnection, resolveRoute, probeRoute } from './providers.js';
import { chatgptLoginStart, chatgptLogout } from './codex.js';
import { devToolList, callDevTool } from './devtools.js';
import { mergeText } from '../shared/events.js';
import { listRepos, gitStatus, gitDiff, gitCommit, gitPush, createPR, gh, currentBranch } from './github.js';
import { checkUpdate, performUpdate, performRollback, restartDaemon } from './updater.js';
import { detectProject, saveEnv } from './project.js';
import { capture } from './browser.js';
import { checkPush } from './webpush.js';
import { listDir, readFile, writeFile, revertChange } from './files.js';

// ---------- RPC ----------
// RPC input validation: the shape of messages from the phone/terminal is never trusted.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export function need(v, name, { type = 'string', max = 100_000 } = {}) {
  if (type === 'string' && (typeof v !== 'string' || !v || v.length > max)) throw new Error(`invalid ${name}`);
  if (type === 'number' && !Number.isFinite(+v)) throw new Error(`invalid ${name}`);
  return type === 'number' ? +v : v;
}
export const opt = (v, name, o) => (v == null || v === '' ? undefined : need(v, name, o));

// Default model when a new connection is added from the phone: Claude Sonnet/Opus if present, then other Claude,
// then Codex GPT models, Gemini Pro, then the first one.
export function defaultModel(ids) {
  const pref = [/^cc\/claude-sonnet/, /^cc\/claude-opus/, /^(cc\/|[a-z]+:)?claude-sonnet/, /^(cc\/|[a-z]+:)?claude-opus/, /^(cc\/)?claude-/, /claude/, /gpt-[\d.]+-codex(?!-mini)/, /gpt-[\d.]+$/, /gemini.*pro/, /gemini/];
  for (const re of pref) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return ids[0];
}

// RPC method table: (conn, params) -> result. `conn.d` = Daemon, `conn.big` = binary channel (no 1MB relay limit).
export const RPC = {
  info: (c) => c.info(),
  updateStatus: (c) => checkUpdate(c.d.config, c.d.secrets),
  async update(c) {
    // A still-running claude.exe locks its file → npm fails to install the new binary.
    await c.d.sessions.stopAll();
    const res = await performUpdate(c.d.config, c.d.secrets);
    restartDaemon(c.d, { delay: 1200 });
    return { ok: true, message: 'Update installed. The PC is restarting the daemon...', commit: res.commit };
  },
  // The new version misbehaves: reinstall the version from before the last update.
  async rollback(c) {
    await c.d.sessions.stopAll();
    const res = await performRollback(c.d.config);
    restartDaemon(c.d, { delay: 1200 });
    return { ok: true, message: `Rolled back to ${res.commit}. The PC is restarting the daemon...`, commit: res.commit };
  },
  restart(c) {
    restartDaemon(c.d, { delay: 1000 });
    return { ok: true, message: 'The daemon is restarting...' };
  },
  // `snugcode stop/restart` from the PC: stop cleanly so dev servers & tunnels die too
  // (on Windows, process.kill doesn't run any handlers).
  shutdown(c) {
    if (!c.local) throw new Error('Only from the PC terminal');
    setTimeout(() => Promise.resolve(c.d.stop()).finally(() => process.exit(0)), 50);
    return true;
  },
  githubStatus: (c, p) => (p.check ? c.d.github.check() : c.d.github.status()),
  githubLogin: (c) => c.d.github.begin(),
  models: async (c) => (await c.d.models()).models.map((m) => m.id), // old version: IDs only
  modelsInfo: async (c, p) => (await c.d.models({ fresh: !!p.fresh })).models,
  // Models from all connections + connections that failed (shown in the model picker).
  modelsAll: (c, p) => c.d.models({ fresh: !!p.fresh }),
  async probeModel(c, p) {
    const route = resolveRoute(c.d.secrets, need(p.model, 'model', { max: 300 }));
    // ChatGPT: model health is guaranteed by Codex; testing via the app-server is too expensive for every pick.
    if (route.wire === 'chatgpt') return { ok: true, ms: 0, text: 'ChatGPT' };
    return probeRoute(route);
  },
  setModel(c, p) {
    // The light model (subagents) can no longer be picked: it comes from the same connection automatically (Haiku / Flash).
    if (p.model) {
      const model = need(p.model, 'model', { max: 300 });
      resolveRoute(c.d.secrets, model); // this model's connection must exist
      c.d.config.model = model;
    }
    saveConfig(c.d.config);
    return c.info();
  },
  // ---------- model connections (official API keys, routers, custom endpoints, ChatGPT login) ----------
  // Keys are sent over the E2EE channel, validated against their endpoint first, and never returned to clients.
  connections: (c) => c.d.connList(),
  async connAdd(c, p) {
    const key = opt(p.key, 'API key', { max: 2000 })?.trim();
    const url = opt(p.url, 'URL', { max: 400 })?.trim();
    const kind = opt(p.kind, 'kind', { max: 32 });
    const det = await detectConnection({ key, url, kind });
    const { models, ...conn } = det;
    const id = c.d.saveConnection(conn, { replace: opt(p.replace, 'id', { max: 40 }), models });
    return { conn: c.d.connList().find((x) => x.id === id), models: models.length, info: c.info() };
  },
  connRemove(c, p) {
    c.d.removeConnection(need(p.id, 'id', { max: 40 }));
    return c.info();
  },
  // ChatGPT login (Plus/Pro subscription) via the official Codex, with a device code that can be completed from the phone.
  async chatgptLogin(c) {
    const d = c.d;
    const r = await chatgptLoginStart(d.config, {
      log: (m) => d.log(m),
      onDone: ({ ok, account, err }) => {
        if (ok) {
          d.saveConnection({ kind: 'chatgpt', label: 'ChatGPT', formats: {}, account: { email: account?.email || null, plan: account?.planType || null } }, { replace: 'chatgpt' });
          d.log(`✓ ChatGPT connected${account?.email ? ' as ' + account.email : ''}`);
        }
        d.broadcast({ ev: 'chatgpt', ok, err: ok ? null : err || 'ChatGPT login failed', info: null });
        d.broadcast({ ev: 'connections', list: d.connList() });
      },
    });
    return r;
  },
  async chatgptLogout(c) {
    await chatgptLogout(c.d.config).catch(() => {});
    if (getConn(c.d.secrets, 'chatgpt')) c.d.removeConnection('chatgpt');
    return c.info();
  },
  // ---------- Codex engine MCP bridge (single-session bridge connections only) ----------
  devTools(c) {
    if (!c.bridge) throw new Error('Only for the MCP bridge');
    return devToolList();
  },
  devTool(c, p) {
    if (!c.bridge) throw new Error('Only for the MCP bridge');
    return callDevTool(c.bridge, need(p.name, 'tool', { max: 64 }), p.args && typeof p.args === 'object' ? p.args : {});
  },
  // ---------- settings from the phone (formerly only `snugcode setup` / `pin` / `devices` / `revoke`) ----------
  // Old shape (old app versions): a single router = the `router` connection.
  async configure(c, p) {
    const cur = getConn(c.d.secrets, 'router');
    const url = p.routerUrl != null && p.routerUrl !== '' ? need(p.routerUrl, 'URL router', { max: 300 }).trim().replace(/\/+$/, '') : cur?.openai || c.d.config.routerUrl;
    if (!/^https?:\/\/[^\s/]+/i.test(url || '')) throw new Error('The router URL must start with http:// or https://');
    const key = p.routerKey ? need(p.routerKey, 'key 9router', { max: 1000 }).trim() : cur?.key;
    if (!key) throw new Error('The 9router key is empty');
    // Validated first: a wrong key/URL doesn't overwrite the running configuration.
    const { models, ...conn } = await detectConnection({ key, url, kind: 'router' });
    c.d.saveConnection(conn, { replace: 'router', models });
    return c.info();
  },
  devices: (c) =>
    Object.entries(c.d.secrets.devices).map(([id, d]) => ({
      id,
      name: d.name,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      push: !!d.push,
      current: id === c.deviceId,
      online: [...c.d.conns.values()].some((x) => x.ready && x.deviceId === id),
    })),
  revoke(c, p) {
    const devs = c.d.secrets.devices;
    const ids = p.id === 'all' ? Object.keys(devs) : [need(p.id, 'id', { max: 64 })];
    for (const id of ids) {
      if (!devs[id]) throw new Error('Device not found');
      delete devs[id];
    }
    c.d.saveSecrets();
    // Disconnected after the reply is sent (a device revoking itself still gets the answer).
    setTimeout(() => {
      for (const x of c.d.conns.values()) if (ids.includes(x.deviceId)) c.d.kick(x.cid, 'revoked');
    }, 300);
    return true;
  },
  async setPin(c, p) {
    const pin = need(p.pin, 'PIN', { max: 12 });
    if (!C.PIN_RE.test(pin)) throw new Error('The PIN must be 6–12 letters/digits.');
    const s = c.d.secrets;
    s.prs = C.bytesToHex(await C.pinToPrs(pin, c.d.config.machineId));
    resetPinLock(s);
    c.d.saveSecrets();
    return true;
  },
  // Cloud runner: the phone's Codespaces token (`codespace` scope) so the runner can stop itself
  // when idle, plus the idle minutes limit. Stored in secrets.json (closed to the agent).
  runnerConfig(c, p) {
    const cfg = c.d.config;
    if (!isCloud(cfg)) throw new Error('Only for cloud runners');
    if (p.token !== undefined) {
      if (p.token) c.d.secrets.runnerToken = need(p.token, 'token', { max: 400 });
      else delete c.d.secrets.runnerToken;
      c.d.saveSecrets();
    }
    if (p.idleStopMinutes != null) {
      cfg.idleStopMinutes = Math.max(0, Math.min(24 * 60, need(p.idleStopMinutes, 'minutes', { type: 'number' })));
      saveConfig(cfg);
    }
    return c.info().runner;
  },
  setSessionModel(c, p) {
    const s = c.d.sessions.get(p.id);
    if (s.status === 'running') throw new Error('Wait for the agent to finish (or Stop it) before switching models.');
    const model = need(p.model, 'model', { max: 200 });
    if (s.meta.model !== model) {
      s.emitEvent({ k: 'note', d: `◆ model: ${s.meta.model} → ${model}` });
      s.meta.model = model;
      c.d.sessions.saveIndex();
    }
    return s.summary();
  },
  repos(c, p) {
    if (!c.d.secrets.githubToken) throw new Error('This PC isn\'t signed in to GitHub. Sign in from PC settings → GitHub in the app, or run `snugcode login` on the PC.');
    return listRepos(c.d.secrets.githubToken, opt(p.q, 'q', { max: 200 }), c.d.config.githubLogin);
  },
  async branches(c, p) {
    if (!REPO_RE.test(p.repo || '')) throw new Error('invalid repo');
    const list = await gh(c.d.secrets.githubToken, 'GET', `/repos/${p.repo}/branches?per_page=100`);
    return list.map((b) => b.name);
  },
  sessions: (c) => c.d.sessions.list(),
  create: async (c, p) => (await c.d.sessions.create(p)).summary(),
  attach(c, p) {
    const s = c.d.sessions.get(p.id);
    c.subscribe(s);
    // Text relay frames are capped at ~1MB: only send recent history if it's too large.
    // The binary channel splits large messages, so its limit is much looser.
    const since = +p.since || 0;
    const all = mergeText(s.since(since));
    const limit = c.big ? 4_000_000 : 500_000;
    let i = all.length;
    for (let size = 0; i > 0 && size < limit; i--) size += JSON.stringify(all[i - 1]).length;
    const events = i ? all.slice(i) : all;
    s.warm();
    return { session: s.summary(), events, truncated: events.length < all.length || s.missingSince(since), perms: s.pendingPerms(), procs: s.procs.list(), preview: s.previewInfo() };
  },
  detach(c) {
    c.unsubscribe();
    return true;
  },
  async send(c, p) {
    await c.d.sessions.get(p.id).send(String(p.text || ''), p.images);
    return true;
  },
  async interrupt(c, p) {
    await c.d.sessions.get(p.id).interrupt();
    return true;
  },
  perm: (c, p) => c.d.sessions.get(p.id).answerPermission(p.pid, p.decision, { answers: p.answers, message: p.message }),
  plan(c, p) {
    const s = c.d.sessions.get(p.id);
    s.setPlan(p.on);
    return s.summary();
  },
  rewind: (c, p) => c.d.sessions.get(p.id).rewindTo(need(p.seq, 'seq', { type: 'number' })),
  // ---------- background processes & preview ----------
  project(c, p) {
    const s = c.d.sessions.get(p.id);
    return { ...detectProject(s.meta.cwd), procs: s.procs.list(), preview: s.previewInfo() };
  },
  runDev: (c, p) => c.d.sessions.get(p.id).runDev(opt(p.cmd, 'cmd')),
  procStart: (c, p) => c.d.sessions.get(p.id).procs.start(need(p.cmd, 'cmd'), opt(p.name, 'name', { max: 64 })),
  procStop(c, p) {
    c.d.sessions.get(p.id).procs.stop(p.name);
    return true;
  },
  procLogs: (c, p) => c.d.sessions.get(p.id).procs.logs(p.name, 64 * 1024),
  preview: (c, p) => c.d.sessions.get(p.id).preview(p.name),
  previewClose(c, p) {
    c.d.sessions.get(p.id).closeTunnel();
    return true;
  },
  async screenshot(c, p) {
    const s = c.d.sessions.get(p.id);
    const port = s.procs.list().find((x) => x.name === p.name)?.port;
    if (!port) throw new Error('Dev server port not detected yet');
    const clamp = (v, def) => Math.min(1600, Math.max(240, +v || def));
    const r = await capture(`http://localhost:${port}${String(p.path || '/').replace(/^(?!\/)/, '/')}`, { width: clamp(p.width, 390), height: clamp(p.height, 844), cfg: c.d.config });
    if (r.data.length > (c.big ? 6_000_000 : 450_000)) throw new Error('Screenshot too large to send; use a smaller viewport.');
    return { data: r.data, mime: r.mime, title: r.title, logs: r.logs };
  },
  envSave(c, p) {
    const s = c.d.sessions.get(p.id);
    if (s.meta.local || s.meta.computer) throw new Error('.env templates are only for git repository sessions.');
    return saveEnv(s.meta.repo, s.meta.cwd);
  },
  // ---------- interactive terminal (PTY) ----------
  async termOpen(c, p) {
    const t = await c.d.terms.open(c.d.sessions.get(p.id), { cols: p.cols, rows: p.rows });
    return c.d.terms.attach(t.tid, c);
  },
  termList: (c, p) => c.d.terms.list(c.d.sessions.get(p.id).id).map((t) => c.d.terms.summary(t)),
  termAttach: (c, p) => c.d.terms.attach(need(p.tid, 'tid', { max: 32 }), c),
  termDetach(c, p) {
    c.d.terms.detach(p.tid, c);
    return true;
  },
  termIn(c, p) {
    c.d.terms.write(need(p.tid, 'tid', { max: 32 }), need(p.d, 'input', { max: 64 * 1024 }));
    return true;
  },
  termResize(c, p) {
    c.d.terms.resize(need(p.tid, 'tid', { max: 32 }), p.cols, p.rows);
    return true;
  },
  termClose(c, p) {
    c.d.terms.close(p.tid);
    return true;
  },
  // ---------- Web Push (phone) ----------
  pushSub(c, p) {
    const dev = c.d.secrets.devices[c.deviceId];
    if (!dev) throw new Error('Only for paired phones');
    if (p.sub) dev.push = checkPush(p);
    else if (!('level' in p)) delete dev.push;
    // 'all' | 'important' (only permissions, questions & finished).
    if (p.level === 'all' || p.level === 'important') dev.pushLevel = p.level;
    c.d.saveSecrets();
    return true;
  },
  visible(c, p) {
    c.visible = !!p.on;
    return true;
  },
  edits(c, p) {
    const s = c.d.sessions.get(p.id);
    s.setAskEdits(p.on);
    return s.summary();
  },
  auto(c, p) {
    const s = c.d.sessions.get(p.id);
    s.meta.auto = !!p.on;
    if (p.on) s.meta.autoLow = false;
    c.d.sessions.saveIndex();
    return s.summary();
  },
  budget(c, p) {
    const s = c.d.sessions.get(p.id);
    s.setBudget(need(p.usd, 'budget', { type: 'number' }));
    return s.summary();
  },
  autonomy(c, p) {
    const s = c.d.sessions.get(p.id);
    s.setAutonomy(need(p.level, 'level', { max: 16 }));
    return s.summary();
  },
  async delete(c, p) {
    c.d.terms.closeSession(p.id);
    await c.d.sessions.remove(p.id);
    return true;
  },
  // Triggered by the user: base clones not used by any session are removed now as well.
  cleanup: (c) => c.d.sessions.cleanupOrphans({ minAgeMs: 0, repoTtlMs: 0 }),
  status: async (c, p) => {
    const s = c.d.sessions.get(p.id);
    if (s.meta.computer) {
      try {
        return await gitStatus(s.meta.cwd);
      } catch {
        return { branch: '-', files: [], ahead: 0, behind: 0, log: [], hasUpstream: false, notRepo: true };
      }
    }
    return gitStatus(s.meta.cwd);
  },
  diff: async (c, p) => {
    const s = c.d.sessions.get(p.id);
    if (s.meta.computer) {
      try {
        return await gitDiff(s.meta.cwd, { limit: c.big ? 2 * 1024 * 1024 : 400 * 1024 });
      } catch {
        return { diff: '', truncated: false, notRepo: true };
      }
    }
    return gitDiff(s.meta.cwd, { limit: c.big ? 2 * 1024 * 1024 : 400 * 1024 });
  },
  // ---------- file explorer & review diff per hunk ----------
  files: (c, p) => listDir(c.d.sessions.get(p.id).meta.cwd, opt(p.path, 'path', { max: 4096 }) || ''),
  fileRead(c, p) {
    const r = readFile(c.d.sessions.get(p.id).meta.cwd, need(p.path, 'path', { max: 4096 }));
    // The text relay channel is capped at ~1 MB: large files only go over the binary channel.
    if (!c.big && (r.text?.length > 400_000 || r.image?.data.length > 400_000)) throw new Error('File too large for this connection; update the app.');
    return r;
  },
  fileWrite(c, p) {
    const s = c.d.sessions.get(p.id);
    const r = writeFile(s.meta.cwd, need(p.path, 'path', { max: 4096 }), typeof p.text === 'string' ? p.text : need(p.text, 'text'), { hash: opt(p.hash, 'hash', { max: 64 }), create: !!p.create });
    s.userChanged(`${p.create ? 'created' : 'edited'} ${r.path}`, `✎ ${r.path} ${p.create ? 'created' : 'edited'} from the phone`);
    return r;
  },
  async revert(c, p) {
    const s = c.d.sessions.get(p.id);
    if (s.status === 'running') throw new Error('Stop the agent before reverting changes.');
    const r = await revertChange(s.meta.cwd, need(p.path, 'path', { max: 4096 }), opt(p.hunk, 'hunk', { max: 2_000_000 }));
    s.userChanged(`reverted ${p.hunk ? 'part of the changes' : 'all uncommitted changes'} in ${r.path}`, `↺ ${p.hunk ? 'one hunk' : 'all changes'} in ${r.path} reverted from the phone`);
    return r;
  },
  commit(c, p) {
    if (!p.message?.trim()) throw new Error('Empty commit message');
    const cfg = c.d.config;
    const identity = cfg.githubLogin ? { login: cfg.githubLogin, id: cfg.githubId } : null;
    return gitCommit(c.d.sessions.get(p.id).meta.cwd, String(p.message).trim(), identity);
  },
  async push(c, p) {
    if (!c.d.secrets.githubToken) throw new Error('This PC isn\'t signed in to GitHub.');
    const s = c.d.sessions.get(p.id);
    const branch = await gitPush(s.meta.cwd, c.d.secrets.githubToken);
    s.emitEvent({ k: 'note', d: `⇡ pushed to origin/${branch}` });
    return branch;
  },
  async pr(c, p) {
    const s = c.d.sessions.get(p.id);
    // Local sessions may switch branches from the terminal: use the current branch (read without git).
    const head = currentBranch(s.meta.cwd) || (await gitStatus(s.meta.cwd)).branch;
    const pr = await createPR(c.d.secrets.githubToken, s.meta.repo, { head, base: p.base || s.meta.base, title: p.title, body: p.body || '' });
    s.emitEvent({ k: 'note', d: `PR #${pr.number} created: ${pr.url}` });
    return pr;
  },
};
