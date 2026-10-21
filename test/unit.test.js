import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../shared/crypto.js';
import { toolSummary } from '../daemon/sessions.js';

test('PIN pairing: correct -> same secret, wrong -> rejected on the phone', async () => {
  const prs = await C.pinToPrs('123456', 'm1');
  const p1 = C.pairStartPhone(prs);
  const m1 = C.pairRespondMachine(prs, p1.msg);
  const p2 = C.pairFinishPhone(p1.state, m1.msg);
  assert.ok(p2);
  assert.deepEqual(C.pairVerifyMachine(m1.state, p2.msg), p2.deviceSecret);

  const bad = C.pairStartPhone(await C.pinToPrs('654321', 'm1'));
  assert.equal(C.pairFinishPhone(bad.state, C.pairRespondMachine(prs, bad.msg).msg), null);
});

test('session channel: two-way encryption + anti replay + wrong secret rejected', () => {
  const secret = C.randomBytes(32);
  const a = C.authStartPhone();
  const b = C.authRespondMachine(secret, a.msg);
  assert.equal(C.authFinishPhone(C.randomBytes(32), a.state, b.msg), null);
  const fin = C.authFinishPhone(secret, a.state, b.msg);
  const m = C.authVerifyMachine(b.state, fin.msg);
  const f = fin.channel.seal({ x: 1 });
  assert.deepEqual(m.open(f), { x: 1 });
  assert.throws(() => m.open(f), /replay/);
  assert.deepEqual(fin.channel.open(m.seal('ok')), 'ok');
});

test('toolSummary: paths inside the worktree become relative', () => {
  const cwd = String.raw`C:\Users\a\ws\s-1`;
  assert.equal(toolSummary('Read', { file_path: String.raw`C:\Users\a\ws\s-1\src\x.js` }, cwd), 'src/x.js');
  assert.equal(toolSummary('Bash', { command: 'cat C:/Users/a/ws/s-1/README && ls /etc' }, cwd), 'cat README && ls /etc');
  assert.equal(toolSummary('Read', { file_path: '/home/u/ws/s-1/a.txt' }, '/home/u/ws/s-1'), 'a.txt');
});

test('alphanumeric PIN: case-insensitive', async () => {
  assert.ok(C.PIN_RE.test('moon42'));
  assert.ok(!C.PIN_RE.test('moon4'));
  assert.ok(!C.PIN_RE.test('moon-42'));
  assert.deepEqual(await C.pinToPrs('Moon42', 'm1'), await C.pinToPrs(' moon42', 'm1'));
});

test('groupModels: ag/ effort variants are merged into a slider', async () => {
  const M = await import('../shared/models.js');
  const ids = ['ag/gemini-3.8-flash-high', 'ag/gemini-3.8-flash-medium', 'ag/gemini-3.8-flash-low', 'ag/gemini-3.8-flash',
    'ag/gemini-3.5-flash-high', 'ag/gemini-3.5-flash-low', 'ag/gemini-3.5-flash-extra-low',
    'ag/gemini-3.1-pro-low', 'ag/gpt-oss-120b-medium', 'ag/gemini-3-flash-agent', 'ag/claude-opus-4-6-thinking', 'gemini/gemini-3.8-flash'];
  const g = M.groupModels(ids);
  const by = (k) => g.find((x) => x.key === k);
  assert.equal(g.length, 7);
  assert.deepEqual(by('ag/gemini-3.8-flash').levels.map((l) => l.effort), ['low', 'medium', 'high']);
  assert.equal(by('ag/gemini-3.8-flash').auto, 'ag/gemini-3.8-flash');
  assert.ok(by('ag/gemini-3.8-flash').slider);
  assert.deepEqual(by('ag/gemini-3.5-flash').levels.map((l) => l.effort), ['extra-low', 'low', 'high']);
  assert.equal(by('ag/gemini-3.1-pro').fixed, 'low');
  assert.equal(by('ag/gemini-3.1-pro').slider, false);
  assert.ok(by('ag/gemini-3-flash-agent') && by('ag/claude-opus-4-6-thinking'));
  assert.ok(by('gemini/gemini-3.8-flash'), 'different providers are not merged');
  assert.equal(M.defaultChoice(by('ag/gemini-3.8-flash'), 'x'), 'medium');
  assert.equal(M.defaultChoice(by('ag/gemini-3.8-flash'), 'ag/gemini-3.8-flash-high'), 'high');
  assert.equal(M.defaultChoice(by('ag/gemini-3.5-flash'), 'x'), 'low');
  assert.equal(M.resolveId(by('ag/gemini-3.8-flash'), null), 'ag/gemini-3.8-flash');
  assert.equal(M.resolveId(by('ag/gemini-3.8-flash'), 'high'), 'ag/gemini-3.8-flash-high');
  assert.equal(M.modelLabel('ag/gemini-3.5-flash-extra-low'), 'gemini-3.5-flash · x-low');
  assert.equal(M.ctxLabel(1048576), '1M');
});

test('updater: detects install type and package version', async () => {
  const { getInstallInfo, checkUpdate } = await import('../daemon/updater.js');
  const info = getInstallInfo();
  assert.equal(info.version, JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.ok(['git', 'npm'].includes(info.installType));
  assert.ok(info.commit);

  const st = await checkUpdate();
  assert.equal(typeof st.updateAvailable, 'boolean');
  assert.ok(st.currentCommit);
  assert.ok(['git', 'npm'].includes(st.installType));
});

test('nativebin: per-platform binary package names + on-disk detection', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { platformBinaryPackage, platformBinaryPackages, nativeBinaryInstalled, missingBinaryMessage } = await import('../daemon/nativebin.js');
  assert.equal(platformBinaryPackage({ platform: 'win32', arch: 'x64' }), 'claude-agent-sdk-win32-x64');
  assert.equal(platformBinaryPackage({ platform: 'darwin', arch: 'arm64' }), 'claude-agent-sdk-darwin-arm64');
  assert.deepEqual(platformBinaryPackages({ platform: 'linux', arch: 'x64', musl: false }), ['claude-agent-sdk-linux-x64', 'claude-agent-sdk-linux-x64-musl']);
  assert.deepEqual(platformBinaryPackages({ platform: 'linux', arch: 'arm64', musl: true }), ['claude-agent-sdk-linux-arm64-musl', 'claude-agent-sdk-linux-arm64']);
  assert.match(missingBinaryMessage('/x'), /--include=optional/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bin-'));
  try {
    assert.equal(nativeBinaryInstalled(root), false);
    const dir = path.join(root, 'node_modules', '@anthropic-ai', platformBinaryPackage());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
    assert.equal(nativeBinaryInstalled(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keepawake: initializes and stops cleanly', async () => {
  const { startKeepAwake } = await import('../daemon/keepawake.js');
  const ka = startKeepAwake();
  assert.equal(typeof ka.stop, 'function');
  assert.equal(typeof ka.active, 'function');
  ka.stop();
});

test('groupModels: cc/claude-opus-5-5 yields a virtual effort slider', async () => {
  const M = await import('../shared/models.js');
  const ids = ['cc/claude-opus-5-5'];
  const g = M.groupModels(ids);
  assert.equal(g.length, 1);
  const opus = g[0];
  assert.equal(opus.key, 'cc/claude-opus-5-5');
  assert.ok(opus.slider);
  assert.deepEqual(opus.levels.map((l) => l.effort), ['low', 'medium', 'high', 'max']);
  assert.equal(opus.auto, 'cc/claude-opus-5-5');

  assert.equal(M.resolveId(opus, 'high'), 'cc/claude-opus-5-5-high');
  assert.equal(M.resolveId(opus, null), 'cc/claude-opus-5-5');

  const resolvedHigh = M.resolveModelEffort('cc/claude-opus-5-5-high');
  assert.equal(resolvedHigh.actualModel, 'cc/claude-opus-5-5');
  assert.equal(resolvedHigh.effort, 'high');

  const resolvedAuto = M.resolveModelEffort('cc/claude-opus-5-5');
  assert.equal(resolvedAuto.actualModel, 'cc/claude-opus-5-5');
  assert.equal(resolvedAuto.effort, null);
});

// Fake upstream: handler(req, res) decides how to reply.
// `fn(url, headers)`: headers hold the proxy's local token (like the one the claude process holds).
async function withProxy(handler, fn, { key = 'real-router-key' } = {}) {
  const http = await import('node:http');
  const { startRouterProxy } = await import('../daemon/proxy.js');
  const up = http.createServer(handler);
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = startRouterProxy(`http://127.0.0.1:${up.address().port}/v1`, { getKey: () => key });
  try {
    return await fn(await proxy.ready(), { authorization: 'Bearer ' + proxy.token });
  } finally {
    proxy.close();
    up.closeAllConnections?.();
    up.close();
  }
}

test('loopback proxy: header sanitizing, the real key is only injected for local token holders', async () => {
  const { stripIdeToolSuffix } = await import('../daemon/proxy.js');
  assert.equal(stripIdeToolSuffix('{"name":"Bash_ide"}'), '{"name":"Bash"}');
  assert.equal(stripIdeToolSuffix('{"name": "Read_ide"}'), '{"name":"Read"}');
  assert.equal(stripIdeToolSuffix('{"name":"normal_tool"}'), '{"name":"normal_tool"}');

  let seen = null;
  const text = await withProxy(
    (req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: content_block_start\ndata: {"content_block":{"name":"Bash_ide"}}\n\n');
    },
    (url, auth) => fetch(url + '/v1/messages', { headers: { ...auth, 'user-agent': 'claude-cli/1.0.0', 'x-app': 'cli', other: 'keep' } }).then((r) => r.text()),
  );
  assert.ok(text.includes('"name":"Bash"') && !text.includes('Bash_ide'));
  assert.equal(seen['user-agent'], 'snugcode/0.1');
  assert.equal(seen['x-app'], undefined);
  assert.equal(seen.other, 'keep');
  // The router receives the real key; the local token never leaves the PC.
  assert.equal(seen.authorization, 'Bearer real-router-key');
  assert.equal(seen['x-api-key'], undefined);

  // Requests without the local token (e.g. other programs on the PC, or a raw 9router key) are rejected, not forwarded.
  seen = null;
  const statuses = await withProxy(
    (req, res) => ((seen = req.headers), res.end('{}')),
    async (url) => [
      (await fetch(url + '/v1/messages')).status,
      (await fetch(url + '/v1/messages', { headers: { 'x-api-key': 'real-router-key' } })).status,
      (await fetch(url + '/v1/messages', { headers: { authorization: 'Bearer pc-local-wrong' } })).status,
    ],
  );
  assert.deepEqual(statuses, [401, 401, 401]);
  assert.equal(seen, null);
});

test('loopback proxy: _ide split at a chunk boundary & multi-byte UTF-8 stay intact', async () => {
  const event = 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash_ide","input":{}}}\n\n';
  const payload = Buffer.from('x'.repeat(100) + '\n' + event + 'data: {"text":"✓ done — ok"}\n\n');
  // Cut at every position inside "Bash_ide" and in the middle of the ✓ character (3 bytes).
  const nameAt = payload.indexOf('Bash_ide');
  const checkAt = payload.indexOf(Buffer.from('✓'));
  const cuts = [...Array(10).keys()].map((i) => nameAt - 1 + i).concat([checkAt + 1, checkAt + 2]);
  for (const cut of cuts) {
    const text = await withProxy(
      (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(payload.subarray(0, cut));
        setTimeout(() => res.end(payload.subarray(cut)), 20);
      },
      (url, auth) => fetch(url + '/v1/messages', { headers: auth }).then((r) => r.text()),
    );
    assert.ok(!text.includes('Bash_ide'), 'cut at byte ' + cut);
    assert.ok(text.includes('"name":"Bash"'), 'cut at byte ' + cut);
    assert.ok(text.includes('✓ done — ok'), 'UTF-8 broken at byte ' + cut);
  }
});

test('loopback proxy: router connection drops mid-stream -> the client doesn\'t hang', async () => {
  const outcome = await withProxy(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"message_start"}\n\n');
      setTimeout(() => req.socket.destroy(), 30);
    },
    (url, auth) =>
      fetch(url + '/v1/messages', { headers: auth, signal: AbortSignal.timeout(4000) })
        .then((r) => r.text())
        .then(() => 'done', (e) => (e.name === 'TimeoutError' ? 'hanging' : 'error')),
  );
  assert.equal(outcome, 'error');
});

test('loopback proxy: unreachable router -> 502 with an Anthropic-format error', async () => {
  const net = await import('node:net');
  const { startRouterProxy } = await import('../daemon/proxy.js');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r)); // free port
  const proxy = startRouterProxy(`http://127.0.0.1:${port}`, { getKey: () => 'k' });
  const res = await fetch((await proxy.ready()) + '/v1/messages', { method: 'POST', body: '{}', headers: { 'x-api-key': proxy.token } });
  proxy.close();
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.equal(j.type, 'error');
  assert.match(j.error.message, /Router proxy error/);
});

test('effort: claude models on non-cc providers get no virtual slider', async () => {
  const M = await import('../shared/models.js');
  const [g] = M.groupModels(['ag/claude-opus-4-6-thinking']);
  assert.equal(g.slider, false);
  assert.deepEqual(g.levels, []);
  assert.deepEqual(M.resolveModelEffort('ag/claude-opus-4-6-thinking'), { actualModel: 'ag/claude-opus-4-6-thinking', effort: null });
  // Real effort variants from the router (separate IDs) are still passed as-is.
  assert.deepEqual(M.resolveModelEffort('ag/gemini-3.8-flash-high'), { actualModel: 'ag/gemini-3.8-flash-high', effort: null });
  assert.deepEqual(M.resolveModelEffort('claude-sonnet-5-5-max'), { actualModel: 'claude-sonnet-5-5', effort: 'max' });
});

test('permissions: pushes & remote writes are always recognized', async () => {
  const { isRemoteWrite } = await import('../daemon/sessions.js');
  const yes = ['git push', 'git push -u origin HEAD', 'cd x && git push --force', 'git -C ../repo push', 'git -c http.extraheader=x push origin main', 'git --no-pager push', 'git.exe push', 'gh pr create --fill', 'gh pr merge 3', 'gh release create v1'];
  const no = ['git status', 'git log --grep push', 'echo pushing', 'git commit -m "push later"', 'gh pr list', 'npm run push-docs'];
  for (const cmd of yes) assert.ok(isRemoteWrite('Bash', { command: cmd }), cmd);
  for (const cmd of no) assert.ok(!isRemoteWrite('Bash', { command: cmd }), cmd);
  assert.ok(!isRemoteWrite('Read', { command: 'git push' }));
});

test('lightModel: subagents only Claude Haiku 5.5 / Gemini 3.8 Flash, ordered by the main model\'s provider', async () => {
  const { lightModel } = await import('../shared/models.js');
  const ids = ['cc/claude-opus-5-5', 'cc/claude-sonnet-5-5', 'cc/claude-haiku-5-5', 'ag/gemini-3.8-flash-high', 'ag/gemini-3.8-flash-low', 'ag/gemini-3.8-flash-medium', 'ag/gemini-3.1-pro-high', 'gemini/gemini-3.8-flash'];
  // cc/: Haiku first (plain ID; effort set per subagent), Flash second.
  assert.deepEqual(lightModel('cc/claude-opus-5-5-high', ids), { id: 'cc/claude-haiku-5-5', kind: 'haiku' });
  assert.deepEqual(lightModel('cc/claude-sonnet-5-5', ids), { id: 'cc/claude-haiku-5-5', kind: 'haiku' });
  assert.deepEqual(lightModel('cc/claude-opus-5-5', ids.filter((i) => !i.includes('haiku'))), { id: 'ag/gemini-3.8-flash-low', kind: 'flash' });
  // ag/: Flash first (low variant), Haiku second.
  assert.deepEqual(lightModel('ag/gemini-3.1-pro-high', ids), { id: 'ag/gemini-3.8-flash-low', kind: 'flash' });
  assert.deepEqual(lightModel('ag/gemini-3.1-pro-high', ['cc/claude-haiku-5-5', 'ag/gemini-3.1-pro-high']), { id: 'cc/claude-haiku-5-5', kind: 'haiku' });
  // The gemini/ provider: Flash from the same provider comes first.
  assert.deepEqual(lightModel('gemini/gemini-3.8-pro', ids), { id: 'gemini/gemini-3.8-flash', kind: 'flash' });
  // Neither is on the router: keep going with the main model (no virtual effort).
  assert.deepEqual(lightModel('cc/claude-opus-5-5-high', ['cc/claude-opus-5-5']), { id: 'cc/claude-opus-5-5', kind: 'main' });
  // Model list unknown yet: a default guess per provider.
  assert.deepEqual(lightModel('cc/claude-opus-5-5', null), { id: 'cc/claude-haiku-5-5', kind: 'haiku' });
  assert.deepEqual(lightModel('ag/gemini-3.1-pro-high', null), { id: 'ag/gemini-3.8-flash-low', kind: 'flash' });
});

test('snugcode prompt: compact, only rules that change agent behavior', async () => {
  const { SNUGCODE_SYSTEM_PROMPT } = await import('../daemon/prompt.js');
  // Sent with every model request: keep it small.
  assert.ok(SNUGCODE_SYSTEM_PROMPT.length < 2600, 'prompt ' + SNUGCODE_SYSTEM_PROMPT.length + ' characters');
  assert.match(SNUGCODE_SYSTEM_PROMPT, /snugcode/i);
  assert.match(SNUGCODE_SYSTEM_PROMPT, /worktree/i);
  assert.match(SNUGCODE_SYSTEM_PROMPT, /git push/i);
  assert.match(SNUGCODE_SYSTEM_PROMPT, /dev_start/);
  assert.match(SNUGCODE_SYSTEM_PROMPT, /Grep\/Glob/);
  assert.doesNotMatch(SNUGCODE_SYSTEM_PROMPT, /CPace|XChaCha20|Cloudflare/);
});

test('agent: lean tool list & built-in subagents overridden with low effort', async () => {
  const { AGENT_TOOLS } = await import('../daemon/sessions.js');
  const { subagents } = await import('../daemon/agents.js');
  for (const t of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'AskUserQuestion', 'ExitPlanMode']) assert.ok(AGENT_TOOLS.includes(t), t);
  for (const t of ['CronCreate', 'ScheduleWakeup', 'SendMessage', 'Workflow', 'EnterWorktree', 'EnterPlanMode']) assert.ok(!AGENT_TOOLS.includes(t), t);
  const a = subagents();
  assert.deepEqual(Object.keys(a).sort(), ['Explore', 'Plan', 'claude', 'general-purpose']);
  assert.equal(a.Explore.effort, 'low');
  for (const name of ['Explore', 'Plan']) assert.ok(!a[name].tools.some((t) => ['Edit', 'Write'].includes(t)), name + ' read-only');
  for (const d of Object.values(a)) assert.ok(!('model' in d), 'subagent model is set via CLAUDE_CODE_SUBAGENT_MODEL');
});

test('cleaner: removes orphan worktrees, unused repos, and stale logs', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { cleanupWorkspaces, safeRm } = await import('../daemon/cleaner.js');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-clean-'));
  const wsDir = path.join(tmpRoot, 'workspaces');
  const sessDir = path.join(tmpRoot, 'sessions');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(sessDir, { recursive: true });

  try {
    // 1. Active repo: arfakaisar__myrepo
    //    Has active worktree s-act1 and orphan worktree s-orp1
    const activeRepoDir = path.join(wsDir, 'arfakaisar__myrepo');
    const actWt = path.join(activeRepoDir, 's-act1');
    const orpWt = path.join(activeRepoDir, 's-orp1');
    const baseDir = path.join(activeRepoDir, '_base');
    fs.mkdirSync(actWt, { recursive: true });
    fs.mkdirSync(orpWt, { recursive: true });
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(actWt, 'app.js'), 'active');
    fs.writeFileSync(path.join(orpWt, 'orphan.js'), 'orphan');

    // 2. Unused repo: user__unused
    //    Only has _base, no active sessions
    const unusedRepoDir = path.join(wsDir, 'user__unused');
    fs.mkdirSync(path.join(unusedRepoDir, '_base'), { recursive: true });

    // 3. File logs
    fs.writeFileSync(path.join(sessDir, 'act1.jsonl'), 'log1');
    fs.writeFileSync(path.join(sessDir, 'old9.jsonl'), 'log9');

    // Active session list
    const activeSessions = [
      { id: 'act1', repo: 'arfakaisar/myrepo', cwd: actWt },
    ];

    // A repo in use creating a new session: must not be touched even if not registered yet.
    const busyRepoDir = path.join(wsDir, 'user__creating');
    fs.mkdirSync(path.join(busyRepoDir, 's-new1'), { recursive: true });
    // An unused but recently used repo: the base clone is kept (TTL), its orphan worktree is still cleaned.
    const recentRepoDir = path.join(wsDir, 'user__recent');
    fs.mkdirSync(path.join(recentRepoDir, '_base'), { recursive: true });
    fs.mkdirSync(path.join(recentRepoDir, 's-old2'), { recursive: true });
    fs.writeFileSync(path.join(recentRepoDir, '.last-used'), '');
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(unusedRepoDir), old, old);

    const ttl = await cleanupWorkspaces(activeSessions, { workspacesDir: wsDir, sessionsDir: sessDir, minAgeMs: 0, busy: (d) => d === 'user__creating' });
    assert.ok(fs.existsSync(path.join(busyRepoDir, 's-new1')), 'a repo being created is not touched');
    assert.ok(fs.existsSync(path.join(recentRepoDir, '_base')), 'a recently used clone is kept (TTL)');
    assert.ok(!fs.existsSync(path.join(recentRepoDir, 's-old2')), 'orphan worktrees are still removed');
    assert.ok(ttl.removedRepos.includes(unusedRepoDir), 'a clone unused for a long time is removed');
    fs.mkdirSync(path.join(unusedRepoDir, '_base'), { recursive: true });
    fs.mkdirSync(orpWt, { recursive: true });
    fs.writeFileSync(path.join(orpWt, 'orphan.js'), 'orphan');
    fs.writeFileSync(path.join(sessDir, 'old9.jsonl'), 'log9');
    safeRm(busyRepoDir);
    safeRm(recentRepoDir);

    const res = await cleanupWorkspaces(activeSessions, {
      workspacesDir: wsDir,
      sessionsDir: sessDir,
      minAgeMs: 0,
      repoTtlMs: 0,
    });

    assert.equal(res.removedWorktrees.length, 1);
    assert.equal(res.removedWorktrees[0], orpWt);
    assert.equal(fs.existsSync(orpWt), false, 's-orp1 must be removed');
    assert.equal(fs.existsSync(actWt), true, 's-act1 must remain');

    assert.equal(res.removedRepos.length, 1);
    assert.equal(res.removedRepos[0], unusedRepoDir);
    assert.equal(fs.existsSync(unusedRepoDir), false, 'user__unused must be removed');
    assert.equal(fs.existsSync(activeRepoDir), true, 'arfakaisar__myrepo must remain');

    assert.equal(res.removedLogs.length, 1);
    assert.equal(res.removedLogs[0], 'old9.jsonl');
    assert.equal(fs.existsSync(path.join(sessDir, 'old9.jsonl')), false);
    assert.equal(fs.existsSync(path.join(sessDir, 'act1.jsonl')), true);
  } finally {
    safeRm(tmpRoot);
    assert.equal(fs.existsSync(tmpRoot), false, 'safeRm cleans tmpRoot');
  }
});

test('autostart: file path detection and automatic sync', async () => {
  const { autostartFilePath, syncAutostart, isAutostartEnabled } = await import('../daemon/autostart.js');
  const filePath = autostartFilePath();
  assert.ok(typeof filePath === 'string' && filePath.length > 5);
  // isAutostartEnabled returns a boolean
  assert.equal(typeof isAutostartEnabled(), 'boolean');
});




// A temporary git repo with one commit; removed automatically after fn finishes.
async function withRepo(fn) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { git } = await import('../daemon/github.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-repo-'));
  try {
    await git(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.env\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await git(dir, ['add', '-A']);
    await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
    await fn(dir, fs, path, git);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('checkpoint: rewind restores contents, deleted files, and removes new files (without touching index/node_modules)', async () => {
  const { snapshot, rewind } = await import('../daemon/checkpoint.js');
  await withRepo(async (dir, fs, path, git) => {
    const p = (f) => path.join(dir, f);
    fs.writeFileSync(p('draft.txt'), 'not committed yet');
    fs.mkdirSync(p('node_modules/x'), { recursive: true });
    fs.writeFileSync(p('node_modules/x/i.js'), 'v1');
    const tree = await snapshot(dir);
    fs.writeFileSync(p('a.txt'), 'changed by the agent');
    fs.rmSync(p('draft.txt'));
    fs.writeFileSync(p('new.txt'), 'created by the agent');
    fs.writeFileSync(p('node_modules/x/i.js'), 'v2');
    await git(dir, ['add', 'new.txt']);
    assert.equal(await rewind(dir, tree), 3);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'a');
    assert.equal(fs.readFileSync(p('draft.txt'), 'utf8'), 'not committed yet');
    assert.equal(fs.existsSync(p('new.txt')), false);
    assert.equal(fs.readFileSync(p('node_modules/x/i.js'), 'utf8'), 'v2', 'node_modules is not snapshotted');
    assert.equal(await rewind(dir, tree), 0);
  });
});

test('project: detects setup/dev commands and saves/restores .env templates', async () => {
  const { detectProject, saveEnv, restoreEnv } = await import('../daemon/project.js');
  await withRepo(async (dir, fs, path) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node s.js', dev: 'vite' } }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    assert.deepEqual(detectProject(dir), { setup: 'pnpm install', dev: 'pnpm run dev' });
    // The old name (.pocketcode.json) is still read; .snugcode.json wins.
    fs.writeFileSync(path.join(dir, '.pocketcode.json'), JSON.stringify({ dev: 'pnpm dev --legacy' }));
    assert.equal(detectProject(dir).dev, 'pnpm dev --legacy');
    fs.writeFileSync(path.join(dir, '.snugcode.json'), JSON.stringify({ dev: 'pnpm dev --host' }));
    assert.equal(detectProject(dir).dev, 'pnpm dev --host');

    const repo = 'test/pc-env-' + process.pid;
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=1');
    assert.deepEqual(await saveEnv(repo, dir), ['.env']);
    const wt = fs.mkdtempSync(dir + '-wt');
    try {
      assert.deepEqual(restoreEnv(repo, wt), ['.env']);
      assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'KEY=1');
      assert.deepEqual(restoreEnv(repo, wt), [], 'existing files are not overwritten');
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
      const { HOME } = await import('../daemon/config.js');
      fs.rmSync(path.join(HOME, 'env', repo.replace('/', '__')), { recursive: true, force: true });
    }
  });
});

test('procs: background processes, port detection from logs, stop', async () => {
  const { ProcManager, procName } = await import('../daemon/procs.js');
  assert.equal(procName('npm run dev'), 'dev');
  assert.equal(procName('pnpm dev --host'), 'dev');
  assert.equal(procName('npx vite'), 'vite');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-proc-'));
  // Script in a file: `node -e` quoting differs between PowerShell and bash.
  fs.writeFileSync(path.join(dir, 'srv.js'), 'console.log("\\x1b[32m  Local:   http://localhost:5199/\\x1b[0m PORT=" + process.env.PORT); setInterval(() => {}, 1000);');
  const events = [];
  const pm = new ProcManager({ cwd: dir, onChange: (p) => events.push(p.status), onOut: () => {} });
  try {
    await pm.start('node srv.js', 'web');
    // waitPort's default limit (30 s): on Windows runners, starting PowerShell + node can take over 10 s.
    assert.equal(await pm.waitPort('web'), 5199);
    assert.match(pm.logs('web'), /Local: {3}http:\/\/localhost:5199\/ PORT=\d+/);
    await assert.rejects(pm.start('node -v', 'web'), /still running/);
    await pm.stopAll();
    assert.equal(pm.list()[0].status, 'exited');
    assert.equal(pm.list()[0].killed, true);
    assert.deepEqual([events[0], events.at(-1)], ['running', 'exited']);
  } finally {
    await pm.stopAll();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('webpush: aes128gcm payload can be decrypted by the recipient (RFC 8291)', async () => {
  const crypto = await import('node:crypto');
  const { encrypt, checkPush } = await import('../daemon/webpush.js');
  const ua = crypto.createECDH('prime256v1');
  const uaPub = ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://push.example/x', keys: { p256dh: uaPub.toString('base64url'), auth: auth.toString('base64url') } };
  const msg = JSON.stringify({ title: 'snugcode ✓', body: 'done' });
  const buf = encrypt(sub, msg);
  const salt = buf.subarray(0, 16);
  const asPub = buf.subarray(21, 21 + buf[20]);
  const ct = buf.subarray(21 + buf[20]);
  const ikm = crypto.hkdfSync('sha256', ua.computeSecret(asPub), auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const key = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce));
  d.setAuthTag(ct.subarray(-16));
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(pt.at(-1), 2);
  assert.equal(pt.subarray(0, -1).toString(), msg);
  const vapid = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  assert.equal(checkPush({ sub, vapid }).sub.endpoint, sub.endpoint);
  assert.throws(() => checkPush({ sub: { ...sub, endpoint: 'http://x' }, vapid }), /Invalid push subscription/);
});

test('toolchain: the pnpm/yarn shim folder is appended to PATH (no duplicate PATH variable)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { HOME } = await import('../daemon/config.js');
  const { toolchainEnv } = await import('../daemon/toolchain.js');
  const dir = path.join(HOME, 'bin', 'pm');
  const had = fs.existsSync(path.join(dir, 'pnpm'));
  // No shim & the command doesn't need pnpm/yarn: env unchanged, nothing installed.
  if (!had) assert.deepEqual(await toolchainEnv('npm run dev', { Path: 'a' }), { Path: 'a' });
  fs.mkdirSync(dir, { recursive: true });
  if (!had) fs.writeFileSync(path.join(dir, 'pnpm'), '');
  try {
    const env = await toolchainEnv('pnpm install', { Path: 'a', X: '1' });
    assert.equal(env.Path, 'a' + path.delimiter + dir);
    assert.equal(env.PATH, undefined);
    assert.equal(env.X, '1');
    assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
  } finally {
    if (!had) fs.rmSync(path.join(dir, 'pnpm'), { force: true });
  }
});

test('binary channel: large messages are split & reassembled, anti replay, seq shared with text frames', () => {
  const secret = C.randomBytes(32);
  const a = C.authStartPhone();
  const b = C.authRespondMachine(secret, a.msg);
  const fin = C.authFinishPhone(secret, a.state, b.msg);
  const pc = C.authVerifyMachine(b.state, fin.msg);
  const hp = fin.channel;
  const big = { id: 1, r: { diff: 'é'.repeat(700_000) } }; // ~1.4MB UTF-8 -> several frames
  const frames = pc.sealBin(big);
  assert.ok(frames.length >= 6, 'frames: ' + frames.length);
  assert.ok(frames.every((f) => f.length <= C.BIN_CHUNK + 64));
  const got = frames.map((f) => hp.openBin(f.slice().buffer));
  assert.deepEqual(got.slice(0, -1), Array(frames.length - 1).fill(undefined));
  assert.deepEqual(got.at(-1), big);
  assert.throws(() => hp.openBin(frames[0]), /replay/);
  // Text & binary frames share sequence numbers: mixed order is still accepted.
  assert.deepEqual(hp.open(pc.seal({ t: 1 })), { t: 1 });
  assert.deepEqual(hp.openBin(pc.sealBin({ t: 2 })[0]), { t: 2 });
  // Size: binary frames are much smaller than text frames (base64 + nested JSON).
  const msg = { ev: 'events', es: [{ k: 'text', d: 'x'.repeat(30_000) }] };
  const textLen = JSON.stringify({ t: 'd', cid: 'abcdefghijkl', d: JSON.stringify(pc.seal(msg)) }).length;
  const binLen = C.frameWithCid('abcdefghijkl', pc.sealBin(msg)[0]).length;
  assert.ok(binLen < textLen * 0.8, `${binLen} vs ${textLen}`);
  const { cid, payload } = C.splitCid(C.frameWithCid('abcdefghijkl', new Uint8Array([1, 2, 3])));
  assert.equal(cid, 'abcdefghijkl');
  assert.deepEqual([...payload], [1, 2, 3]);
});

test('git status porcelain v2: branch, ahead, new/changed/renamed/untracked files', async () => {
  const { gitStatus, parseStatusV2 } = await import('../daemon/github.js');
  await withRepo(async (dir, fs, path, git) => {
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    await git(dir, ['add', 'b.txt']);
    await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
    await git(dir, ['mv', 'b.txt', 'c d.txt']);
    fs.writeFileSync(path.join(dir, 'new x.txt'), 'x');
    const st = await gitStatus(dir);
    assert.ok(st.branch && st.branch !== 'HEAD');
    const by = Object.fromEntries(st.files.map((f) => [f.path, f.st]));
    assert.equal(by['a.txt'], ' M');
    assert.equal(by['b.txt -> c d.txt'], 'R ');
    assert.equal(by['new x.txt'], '??');
    assert.equal(st.hasUpstream, false);
    assert.equal(st.ahead, 2, 'no remote: every commit is unpushed');
    assert.equal(st.log.length, 2);
  });
  const p = parseStatusV2('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +3 -1\n1 .M N... 100644 100644 100644 a a x.js\n');
  assert.deepEqual({ ...p, files: p.files }, { branch: 'main', ahead: 3, behind: 1, upstream: true, files: [{ st: ' M', path: 'x.js' }] });
  assert.equal(parseStatusV2('# branch.head (detached)\n').branch, 'HEAD');
});

test('markdown: incremental rendering only freezes finished blocks', async () => {
  const { md, stableCut, esc } = await import('../web/md.js');
  assert.equal(esc('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  assert.equal(md('**b** <i>'), '<p><b>b</b> &lt;i&gt;</p>');
  const src = 'Paragraph one.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nList:\n- a\n- b';
  // An unclosed code block must not be cut at a blank line inside it.
  const partial = src.slice(0, src.indexOf('const b'));
  assert.equal(stableCut(partial), 'Paragraph one.\n\n'.length);
  // Rendering in pieces gives the same result as rendering whole.
  let done = 0;
  let html = '';
  for (let i = 1; i <= src.length; i += 7) {
    const cut = stableCut(src.slice(0, i), done);
    if (cut > done) (html += md(src.slice(done, cut))), (done = cut);
  }
  html += md(src.slice(done));
  assert.equal(html, md(src));
});

test('agent: partial Reads & Grep file lists widened for non-Claude models (fewer steps)', async () => {
  const path = await import('node:path');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const { HOME } = await import('../daemon/config.js');
  const { widenToolInput, Session } = await import('../daemon/sessions.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-widen-'));
  fs.writeFileSync(path.join(cwd, 'small.js'), 'a\n'.repeat(300));
  fs.writeFileSync(path.join(cwd, 'long.js'), 'a\n'.repeat(2500));
  fs.writeFileSync(path.join(cwd, 'big.js'), 'x'.repeat(70 * 1024));
  fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([1, 0, 2]));
  // A partial Read of a small file -> the whole file; other input is kept.
  assert.deepEqual(widenToolInput('Read', { file_path: 'small.js', offset: 10, limit: 40 }, cwd), { file_path: 'small.js' });
  // Read without a range, long/large/binary/image/missing files/the data folder: unchanged.
  assert.equal(widenToolInput('Read', { file_path: 'small.js' }, cwd), null);
  for (const f of ['long.js', 'big.js', 'bin.dat', 'x.png', 'nope.js', path.join(HOME, 'secrets.json')]) assert.equal(widenToolInput('Read', { file_path: f, offset: 1, limit: 5 }, cwd), null, f);
  // Grep without output_mode -> matching lines + line numbers (capped); an explicit output_mode is respected.
  assert.deepEqual(widenToolInput('Grep', { pattern: 'x' }, cwd), { pattern: 'x', output_mode: 'content', '-n': true, head_limit: 100 });
  assert.equal(widenToolInput('Grep', { pattern: 'x', head_limit: 5 }, cwd).head_limit, 5);
  assert.equal(widenToolInput('Grep', { pattern: 'x', output_mode: 'files_with_matches' }, cwd), null);
  assert.equal(widenToolInput('Bash', { command: 'ls' }, cwd), null);

  // Session hook: only for non-Claude models, and follows the model selected at the time.
  const mgr = { config: {}, secrets: {}, log() {}, notify() {}, saveIndex() {}, trimAgents() {} };
  const s = new Session({ id: 'twiden', cwd, repo: 'a/b', model: 'ag/gemini-3.8-flash-high' }, mgr);
  const h = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'small.js', offset: 3, limit: 2 } };
  assert.deepEqual(s.widenTool(h), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { file_path: 'small.js' } } });
  assert.ok(!('permissionDecision' in s.widenTool(h).hookSpecificOutput), 'permissions still go through canUseTool');
  for (const m of ['cc/claude-opus-5-5-high', 'claude-sonnet-5-5', 'ag/claude-sonnet-4-6']) {
    s.meta.model = m;
    assert.deepEqual(s.widenTool(h), {}, m);
  }
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('permissions: sensitive paths & read tools outside the worktree', async () => {
  const path = await import('node:path');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const { HOME, WORKSPACES } = await import('../daemon/config.js');
  const { isSensitivePath, toolPaths, Session } = await import('../daemon/sessions.js');
  assert.ok(isSensitivePath(path.join(HOME, 'secrets.json')));
  assert.ok(isSensitivePath(path.join(HOME, 'env', 'x', '.env')));
  assert.ok(isSensitivePath(HOME));
  assert.ok(!isSensitivePath(path.join(WORKSPACES, 'a__b', 's-1', 'x.js')));
  assert.ok(!isSensitivePath(path.join(HOME + '-other', 'x')));
  // Claude Code stores large tool output in its config folder: readable, not writable.
  const { CLAUDE_DIR } = await import('../daemon/config.js');
  assert.ok(!isSensitivePath(path.join(CLAUDE_DIR, 'projects', 'p', 'tool-results', 'x.txt')));
  assert.ok(isSensitivePath(path.join(CLAUDE_DIR, 'settings.json'), { write: true }));
  assert.deepEqual(toolPaths('Glob', { pattern: path.join(HOME, '**', '*.json') }, '/w'), [path.join(HOME, path.sep)].map((p) => path.resolve(p)));

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-perm-'));
  const mgr = { config: {}, secrets: {}, log() {}, notify() {}, saveIndex() {}, trimAgents() {} };
  const s = new Session({ id: 'tperm', cwd, repo: 'a/b', model: 'm' }, mgr);
  const settled = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('waiting'), 50))]);
  try {
    assert.equal((await s.askPermission('Read', { file_path: path.join(cwd, 'a.js') })).behavior, 'allow');
    assert.equal((await s.askPermission('Grep', { pattern: 'x' })).behavior, 'allow');
    assert.equal((await s.askPermission('Read', { file_path: path.join(CLAUDE_DIR, 'projects', 'x', 'tool-results', 'o.txt') })).behavior, 'allow');
    assert.equal((await s.askPermission('Read', { file_path: path.join(HOME, 'secrets.json') })).behavior, 'deny');
    assert.equal(await settled(s.askPermission('Read', { file_path: '/etc/hosts' })), 'waiting');
    assert.equal(await settled(s.askPermission('WebFetch', { url: 'https://x.y/?q=1' })), 'waiting');
    assert.equal((await s.askPermission('mcp__snugcode__preview_screenshot', { url: 'http://localhost:5173/' })).behavior, 'allow');
    assert.equal(await settled(s.askPermission('mcp__snugcode__preview_screenshot', { url: 'file:///etc/passwd' })), 'waiting');
    s.meta.auto = true;
    assert.equal((await s.askPermission('WebFetch', { url: 'https://x.y' })).behavior, 'allow');
    assert.equal((await s.askPermission('Write', { file_path: path.join(HOME, 'config.json'), content: '' })).behavior, 'deny');
    assert.equal((await s.askPermission('Edit', { file_path: path.join(CLAUDE_DIR, 'settings.json') })).behavior, 'deny');
    assert.equal(await settled(s.askPermission('Bash', { command: 'cat ~/.snugcode/secrets.json' })), 'waiting');
    assert.equal(await settled(s.askPermission('Bash', { command: 'cat ~/.pocketcode/config.json' })), 'waiting');
    // Pending permission: "Always" doesn't apply to commands touching credentials.
    const pending = [...s.perms.entries()].find(([, p]) => p.tool === 'Bash');
    assert.equal(s.permEvent(pending[0], pending[1]).always, undefined);
    s.answerPermission(pending[0], 'always');
    assert.ok(!s.alwaysAllow.has('Bash'));
    assert.equal(s.allowRules.size, 0);
  } finally {
    s.endTurn();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('permissions: edits in the worktree apply directly, "Always" for Bash uses per-command rules', async () => {
  const path = await import('node:path');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const { Session, suggestedRules } = await import('../daemon/sessions.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-edit-'));
  let saved = 0;
  const mgr = { config: {}, secrets: {}, log() {}, notify() {}, saveIndex: () => saved++, trimAgents() {} };
  const s = new Session({ id: 'tedit', cwd, repo: 'a/b', model: 'm' }, mgr);
  const settled = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('waiting'), 50))]);
  try {
    // Default: Write/Edit inside the worktree don't ask (checkpoint + rewind protect).
    assert.equal((await s.askPermission('Write', { file_path: path.join(cwd, 'a.txt'), content: 'x' })).behavior, 'allow');
    assert.equal((await s.askPermission('Edit', { file_path: 'src/b.js', old_string: 'a', new_string: 'b' })).behavior, 'allow');
    // Outside the worktree it still asks.
    assert.equal(await settled(s.askPermission('Write', { file_path: path.join(os.tmpdir(), 'outside.txt'), content: 'x' })), 'waiting');
    // Edit review mode & plan mode: ask again.
    s.setAskEdits(true);
    assert.equal(await settled(s.askPermission('Edit', { file_path: path.join(cwd, 'a.txt') })), 'waiting');
    s.setAskEdits(false);
    s.meta.plan = true;
    assert.equal(await settled(s.askPermission('Write', { file_path: path.join(cwd, 'a.txt'), content: 'x' })), 'waiting');
    s.meta.plan = false;
    s.endTurn();

    // "Always" for Bash uses Claude Code's suggested rule, not all of Bash.
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow', destination: 'localSettings' }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    assert.deepEqual(suggestedRules('Bash', suggestions), [{ toolName: 'Bash', ruleContent: 'npm test *' }]);
    const res = s.askPermission('Bash', { command: 'npm test' }, { suggestions });
    const [pid, p] = [...s.perms.entries()][0];
    assert.equal(s.permEvent(pid, p).always, 'npm test *');
    s.answerPermission(pid, 'always');
    const r = await res;
    assert.equal(r.behavior, 'allow');
    assert.deepEqual(r.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow', destination: 'session' }]);
    assert.ok(!s.alwaysAllow.has('Bash'));
    assert.deepEqual(s.meta.allowRules, ['Bash(npm test *)']);
    assert.ok(saved > 0);
    // Without a suggested rule: "Always" applies to that tool (old behavior).
    const res2 = s.askPermission('mcp__snugcode__dev_start', { command: 'npm run dev' });
    const [pid2] = [...s.perms.keys()];
    s.answerPermission(pid2, 'always');
    assert.equal((await res2).updatedPermissions, undefined);
    assert.ok(s.alwaysAllow.has('mcp__snugcode__dev_start'));

    // PreToolUse hook: waits for the checkpoint, and push/credentials still ask even when matching an "Always" rule.
    let release;
    s.cpReady = new Promise((r) => (release = r));
    const h = s.beforeTool({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    assert.equal(await settled(h), 'waiting');
    release();
    assert.deepEqual(await h, {});
    assert.equal((await s.beforeTool({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git -C . push origin x' } })).hookSpecificOutput.permissionDecision, 'ask');
    assert.equal((await s.beforeTool({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node -e "x" ~/.snugcode/secrets.json' } })).hookSpecificOutput.permissionDecision, 'ask');
  } finally {
    s.endTurn();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('corrupted session index: sessions recovered from worktrees & nothing deleted', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-idx-'));
  try {
    const wt = path.join(home, 'workspaces', 'octo__repo', 's-ab12');
    fs.mkdirSync(path.join(home, 'workspaces', 'octo__repo', '_base'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, 'work.txt'), 'not pushed yet');
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(wt, old, old);
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', 'index.json'), '[{"id":"ab12","cwd":'); // truncated
    fs.writeFileSync(path.join(home, 'sessions', 'ab12.jsonl'), JSON.stringify({ k: 'user', d: 'fix login', seq: 1 }) + '\n');
    const script = `
      const { SessionManager } = await import(${JSON.stringify(new URL('../daemon/sessions.js', import.meta.url).href)});
      const m = new SessionManager({ config: { routerUrl: 'http://127.0.0.1:9/v1', model: 'm' }, secrets: {}, log() {} });
      await new Promise((r) => setTimeout(r, 2500)); // the automatic cleaner runs 1.5 seconds after start
      console.log(JSON.stringify(m.list()));
      await m.close();
      process.exit(0);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, SNUGCODE_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const list = JSON.parse(out.trim().split('\n').at(-1));
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'ab12');
    assert.equal(list[0].repo, 'octo/repo');
    assert.equal(list[0].title, 'fix login');
    assert.ok(fs.existsSync(path.join(wt, 'work.txt')), 'the worktree is not deleted');
    assert.ok(fs.readdirSync(path.join(home, 'sessions')).some((f) => f.startsWith('index.json.broken-')), 'the corrupted file is kept');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'index.json'), 'utf8'))[0].id, 'ab12');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('shared event model: plans, activity, finished summary, duplicate filter', async () => {
  const E = await import('../shared/events.js');
  const todos = E.todosFromInput([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }]);
  assert.deepEqual(todos, [{ st: 'done', t: 'a' }, { st: 'doing', t: 'b' }, { st: 'todo', t: 'c' }]);
  // New daemons send `todos`; old daemons only glyph text — same result.
  assert.deepEqual(E.todoItems({ k: 'tool', name: 'TodoWrite', todos }), todos);
  assert.deepEqual(E.todoItems({ k: 'tool', name: 'TodoWrite', s: E.todoText(todos) }), todos);
  assert.equal(E.toolActivity({ k: 'tool', name: 'TodoWrite', todos }), 'b');
  assert.equal(E.toolActivity({ k: 'tool', name: 'Bash', s: 'npm test\nmore' }), 'Running npm test');
  assert.equal(E.toolActivity({ k: 'tool', name: 'new_tool', s: 'x' }), 'new_tool x');
  assert.deepEqual(E.doneParts({ k: 'done', turns: 3, ms: 4200, usage: { in: 12345, out: 800 }, ctx: 40, cost: 0.0123 }), ['3 steps', '4.2s', '12k→800 tok', 'context 40%', '$0.012']);
  // The cache share is shown when the daemon sends it (a constant 0% = the router doesn't cache).
  assert.deepEqual(E.doneParts({ k: 'done', turns: 1, ms: 1000, usage: { in: 20000, out: 100, cr: 17000, cw: 2000 } }), ['1 step', '1.0s', '20k→100 tok', 'cache 85%']);
  assert.deepEqual(E.doneParts({ k: 'done', turns: 1, ms: 1000, usage: { in: 20000, out: 100, cr: 0, cw: 0 } }).at(-1), 'cache 0%');
  // Streaming text chunks are merged for attach; other events & the last seq are kept.
  const ev = [{ k: 'user', d: 'hai', seq: 1 }, { k: 'text', d: 'Ha', seq: 2, ts: 1 }, { k: 'text', d: 'lo', seq: 3, ts: 2 }, { k: 'tool', name: 'Read', seq: 4 }, { k: 'text', d: '!', seq: 5, ts: 3 }];
  assert.deepEqual(E.mergeText(ev), [{ k: 'user', d: 'hai', seq: 1 }, { k: 'text', d: 'Halo', seq: 3, ts: 2 }, { k: 'tool', name: 'Read', seq: 4 }, { k: 'text', d: '!', seq: 5, ts: 3 }]);
  assert.equal(ev[1].d, 'Ha', 'the original history is not modified');
  assert.equal(E.fmtDuration(95_000), '1m 35s');
  const cur = new E.EventCursor();
  assert.deepEqual([{ seq: 1 }, { seq: 2 }, { seq: 2 }, { k: 'proc' }, { seq: 1 }, { seq: 3 }].map((e) => cur.accept(/** @type {any} */ (e))), [true, true, false, true, false, true]);
  assert.equal(cur.lastSeq, 3);

  // The daemon includes structured `todos` on TodoWrite events.
  const { toolSummary } = await import('../daemon/sessions.js');
  assert.equal(toolSummary('TodoWrite', { todos: [{ content: 'a', status: 'completed' }] }), '☑ a');
});

test('rename: the old ~/.pocketcode data folder is still used, new installs use ~/.snugcode', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SNUGCODE_HOME;
  delete env.POCKETCODE_HOME;
  const read = () => execFileSync(process.execPath, ['--input-type=module', '-e', `const { HOME } = await import(${JSON.stringify(new URL('../daemon/config.js', import.meta.url).href)}); console.log(HOME);`], { env, encoding: 'utf8' }).trim();
  try {
    assert.equal(read(), path.join(home, '.snugcode'));
    fs.mkdirSync(path.join(home, '.pocketcode'));
    assert.equal(read(), path.join(home, '.pocketcode'));
    fs.mkdirSync(path.join(home, '.snugcode'));
    assert.equal(read(), path.join(home, '.snugcode'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('rename: old autostart entries (pocketcode) are migrated to snugcode', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-auto-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home });
  try {
    const { autostartFilePath, isAutostartEnabled, syncAutostart } = await import('../daemon/autostart.js');
    const legacy = path.join(path.dirname(autostartFilePath()), path.basename(autostartFilePath()).replace(/snugcode/g, 'pocketcode'));
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, 'old');
    assert.ok(isAutostartEnabled());
    assert.equal(syncAutostart('/opt/snugcode/daemon/cli.js', '/usr/bin/node'), true);
    assert.ok(!fs.existsSync(legacy), 'the old entry is removed');
    assert.match(fs.readFileSync(autostartFilePath(), 'utf8'), /snugcode[\/]daemon[\/]cli\.js/);
  } finally {
    for (const [k, v] of Object.entries(saved)) v == null ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('computer mode: prompt, session creation, permissions, and credential protection', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { SNUGCODE_SYSTEM_PROMPT, SNUGCODE_COMPUTER_PROMPT, snugcodePrompt } = await import('../daemon/prompt.js');
  const { SessionManager } = await import('../daemon/sessions.js');
  const { HOME } = await import('../daemon/config.js');

  // 1. Prompt
  assert.equal(snugcodePrompt({ computer: false }), SNUGCODE_SYSTEM_PROMPT);
  assert.equal(snugcodePrompt({ computer: true }), SNUGCODE_COMPUTER_PROMPT);
  assert.match(SNUGCODE_COMPUTER_PROMPT, /Computer Mode/i);
  assert.match(SNUGCODE_COMPUTER_PROMPT, /access to the user's computer/i);
  assert.match(SNUGCODE_COMPUTER_PROMPT, /not limited to a single repository/i);
  assert.ok(SNUGCODE_COMPUTER_PROMPT.length < 2600);

  // 2. Creating a computer mode session via SessionManager
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-comp-home-'));
  const mgr = new SessionManager({
    config: { routerUrl: 'http://127.0.0.1:9/v1', model: 'claude-sonnet-5-5' },
    secrets: {},
    log() {},
  });

  try {
    const s = await mgr.create({ computer: true, cwd: tmpHome });
    assert.equal(s.meta.computer, true);
    assert.equal(s.meta.repo, 'Computer');
    assert.equal(s.meta.cwd, path.resolve(tmpHome));
    assert.equal(s.summary().computer, true);
    assert.equal(s.summary().repo, 'Computer');

    // Rewind is rejected in computer mode
    await assert.rejects(s.rewindTo(1), /Checkpoints and rewind are only available for git repository sessions/);

    // 3. Tool permissions in computer mode:
    // Reading any file (outside cwd) is allowed directly in computer mode
    assert.equal((await s.askPermission('Read', { file_path: path.join(os.tmpdir(), 'random.txt') })).behavior, 'allow');
    assert.equal((await s.askPermission('Grep', { pattern: 'test' })).behavior, 'allow');

    // snugcode's internal secrets are STILL denied/protected in computer mode
    assert.equal((await s.askPermission('Read', { file_path: path.join(HOME, 'secrets.json') })).behavior, 'deny');
    assert.equal((await s.askPermission('Write', { file_path: path.join(HOME, 'config.json'), content: '' })).behavior, 'deny');

    // 4. Deleting the session doesn't delete the host cwd folder
    await mgr.remove(s.meta.id);
    assert.equal(fs.existsSync(tmpHome), true, 'the user\'s folder is not deleted when the computer session is deleted');
  } finally {
    await mgr.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});


// ---------- cloud runner ----------
const fakeMachineToken = (mid, login = 'tester') => Buffer.from(JSON.stringify({ kind: 'machine', sub: '1', login, mid })).toString('base64url') + '.sig';

test('scrubSecretEnv: GitHub tokens & runner bootstrap env are not inherited by the agent', async () => {
  const { scrubSecretEnv } = await import('../daemon/config.js');
  const env = { PATH: '/bin', GITHUB_TOKEN: 'a', GH_TOKEN: 'b', GITHUB_CODESPACE_TOKEN: 'c', SNUGCODE_MACHINE_TOKEN: 'd', SNUGCODE_PAIR_PIN: 'e', SNUGCODE_ROUTER_KEY: 'f', POCKETCODE_GITHUB_TOKEN: 'g', SNUGCODE_HOME: '/h', CODESPACE_NAME: 'x', GITHUB_USER: 'u' };
  scrubSecretEnv(env);
  assert.deepEqual(Object.keys(env).sort(), ['CODESPACE_NAME', 'GITHUB_USER', 'PATH', 'SNUGCODE_HOME']);
});

test('bootstrapCloud: config from env, idempotent, changes from the phone not overwritten', async () => {
  const { bootstrapCloud, decodeMachineToken } = await import('../daemon/runner.js');
  assert.equal(decodeMachineToken(fakeMachineToken('m1')).mid, 'm1');
  assert.equal(decodeMachineToken('garbage'), null);
  const env = { SNUGCODE_MACHINE_TOKEN: fakeMachineToken('m1'), SNUGCODE_PAIR_PIN: 'moon42', SNUGCODE_RELAY: 'https://r.example/', CODESPACE_NAME: 'cs-1', SNUGCODE_IDLE_MINUTES: '45' };
  const cfg = {};
  const sec = { devices: {}, pinFails: 0 };
  const r1 = await bootstrapCloud(env, cfg, sec);
  assert.equal(r1.relinked, true);
  assert.equal(cfg.runtime, 'cloud');
  assert.equal(cfg.machineId, 'm1');
  assert.equal(cfg.relayLogin, 'tester');
  assert.equal(cfg.relayUrl, 'https://r.example');
  assert.deepEqual(cfg.runner, { provider: 'codespace', name: 'cs-1' });
  assert.equal(cfg.idleStopMinutes, 45);
  assert.equal(sec.prs, C.bytesToHex(await C.pinToPrs('moon42', 'm1')));
  assert.ok(!r1.warnings.length, r1.warnings.join());

  // PIN changed from the phone (RPC setPin), then the runner restarts with the same env: the phone's PIN stays.
  sec.prs = 'from-phone';
  sec.devices.d1 = { name: 'Phone' };
  sec.routerKey = 'key-from-phone';
  const r2 = await bootstrapCloud(env, cfg, sec);
  assert.equal(r2.relinked, false);
  assert.equal(sec.prs, 'from-phone');
  assert.ok(sec.devices.d1, 'pairing kept');
  assert.equal(sec.routerKey, 'key-from-phone');

  // The env PIN changes -> applied; a new machine (token with another mid) -> old pairings dropped.
  await bootstrapCloud({ ...env, SNUGCODE_PAIR_PIN: 'sun123' }, cfg, sec);
  assert.equal(sec.prs, C.bytesToHex(await C.pinToPrs('sun123', 'm1')));
  const r3 = await bootstrapCloud({ ...env, SNUGCODE_MACHINE_TOKEN: fakeMachineToken('m2'), CODESPACE_NAME: '' , SNUGCODE_IDLE_EXIT: '1' }, cfg, sec);
  assert.equal(r3.relinked, true);
  assert.equal(cfg.machineId, 'm2');
  assert.deepEqual(sec.devices, {});
  assert.equal(sec.prs, C.bytesToHex(await C.pinToPrs('moon42', 'm2')), 'the env PIN is re-applied for the new machine');
  assert.equal(cfg.runner.provider, 'container');
  assert.equal(cfg.runner.idleExit, true);

  await assert.rejects(bootstrapCloud({}, {}, { devices: {} }), /SNUGCODE_MACHINE_TOKEN/);
  await assert.rejects(bootstrapCloud({ SNUGCODE_MACHINE_TOKEN: 'x.y' }, {}, { devices: {} }), /is invalid/);
});

test('stopRunner & checkIdle: an idle runner is stopped, a busy one isn\'t', async () => {
  const { stopRunner } = await import('../daemon/runner.js');
  const { Daemon } = await import('../daemon/server.js');
  const calls = [];
  const fetchImpl = async (url, opts) => (calls.push({ url, auth: opts.headers.authorization }), { ok: true, status: 202 });
  const cfg = { runtime: 'cloud', runner: { provider: 'codespace', name: 'cs 1' } };
  assert.equal(await stopRunner(cfg, {}, { fetchImpl }), null, 'no token from the phone: can\'t stop');
  assert.equal(await stopRunner(cfg, { runnerToken: 't' }, { fetchImpl }), 'stopped');
  assert.deepEqual(calls, [{ url: 'https://api.github.com/user/codespaces/cs%201/stop', auth: 'Bearer t' }]);
  const sec = { runnerToken: 't' };
  await assert.rejects(stopRunner(cfg, sec, { fetchImpl: async () => ({ ok: false, status: 401 }) }), /no longer valid/);
  assert.equal(sec.runnerToken, undefined);
  assert.equal(await stopRunner({ runner: { provider: 'container', idleExit: true } }, {}), 'exit');

  // checkIdle: only after N minutes without activity, and only once.
  let active = false;
  const logs = [];
  const fake = { config: { runtime: 'cloud', idleStopMinutes: 30, runner: { provider: 'codespace', name: 'cs' } }, secrets: {}, lastActive: 0, isActive: () => active, log: (m) => logs.push(m), saveSecrets() {}, stop() {} };
  const check = (t) => Daemon.prototype.checkIdle.call(fake, t);
  assert.equal(await check(10 * 60_000), null, 'not 30 minutes yet');
  assert.equal(await check(31 * 60_000), null, 'no token: no way to stop');
  active = true;
  await check(40 * 60_000);
  assert.equal(fake.lastActive, 40 * 60_000, 'active: the count restarts');
  active = false;
  fake.config.idleStopMinutes = 0;
  assert.equal(await check(200 * 60_000), null, '0 = never stops');
});

test('defaultModel: Claude Sonnet first when a new router is added from the phone', async () => {
  const { defaultModel } = await import('../daemon/server.js');
  assert.equal(defaultModel(['ag/gemini-3.8-flash-low', 'cc/claude-opus-5-5', 'cc/claude-sonnet-5-5']), 'cc/claude-sonnet-5-5');
  assert.equal(defaultModel(['ag/gemini-3.8-flash-low', 'ag/gemini-3-pro-high']), 'ag/gemini-3-pro-high');
  assert.equal(defaultModel(['x/y']), 'x/y');
});

test('sealedBox: compatible with libsodium crypto_box_seal (Codespaces secrets)', async () => {
  const { sealedBox, openSealedBox } = await import('../shared/sealedbox.js');
  // Vector made with PyNaCl (libsodium): SealedBox(pk).encrypt(b'dari libsodium').
  const sk = Uint8Array.from(Buffer.from('Q51sZey2LLuTdK8wnOawoY7wXkg4if6dmK9S3Yr4DRQ=', 'base64'));
  const ct = Uint8Array.from(Buffer.from('CpPJECbbMMgGtPT105AaDDBQLfhgEN/iDyGvxtQP12UN8yriTUc+LN3IrpIfQsQdFLM92NOqLR5xJmyMohs=', 'base64'));
  assert.equal(new TextDecoder().decode(openSealedBox(ct, sk)), 'dari libsodium');
  const { x25519 } = await import('@noble/curves/ed25519.js');
  const sealed = sealedBox(new TextEncoder().encode('machine-token'), x25519.getPublicKey(sk));
  assert.equal(sealed.length, 32 + 16 + 'machine-token'.length);
  assert.equal(new TextDecoder().decode(openSealedBox(sealed, sk)), 'machine-token');
  assert.throws(() => openSealedBox(sealed, C.randomBytes(32)));
});

test('Codespaces (PWA): fork, secrets encrypted for the fork repo only, create/find/start runner', async () => {
  const { Codespaces, displayName, randomPin, SECRET_NAMES } = await import('../web/codespaces.js');
  const { openSealedBox } = await import('../shared/sealedbox.js');
  const { x25519 } = await import('@noble/curves/ed25519.js');
  const sk = C.randomBytes(32);
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, opts) => {
    const p = url.replace('https://api.github.com', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ m: opts.method, p, body, auth: opts.headers.authorization });
    if (p === '/repos/budi/snugcode') return res(200, { id: 77, full_name: 'budi/snugcode', default_branch: 'main', owner: { login: 'budi' }, parent: { full_name: 'arfakaisar/snugcode' } });
    if (p === '/repos/sari/snugcode') return res(404, { message: 'Not Found' });
    if (p.startsWith('/repos/arfakaisar/snugcode/forks')) return res(200, [{ id: 88, full_name: 'sari/snug-fork', owner: { login: 'Sari' } }]);
    if (p === '/user/codespaces/secrets/public-key') return res(200, { key_id: 'k1', key: C.b64(x25519.getPublicKey(sk)) });
    if (p.startsWith('/user/codespaces/secrets/')) return res(opts.method === 'DELETE' ? 204 : 201, null);
    if (p === '/user/codespaces' && opts.method === 'POST') return res(201, { name: 'cs-abc', state: 'Queued' });
    if (p === '/user/codespaces?per_page=100') return res(200, { codespaces: [{ name: 'cs-other', display_name: 'x' }, { name: 'cs-abc', display_name: displayName('m1'), state: 'Shutdown' }] });
    if (p === '/user/codespaces/gone') return res(404, {});
    if (p.endsWith('/start')) return res(409, { message: 'already running' });
    return res(500, { message: 'unexpected ' + p });
  };
  const cs = new Codespaces('tok', { fetchImpl });
  assert.equal((await cs.findRunnerRepo('budi', 'arfakaisar/snugcode')).id, 77);
  assert.equal((await cs.findRunnerRepo('sari', 'arfakaisar/snugcode')).id, 88, 'a renamed fork is found');
  await cs.setSecrets({ SNUGCODE_MACHINE_TOKEN: 'tok.machine', SNUGCODE_PAIR_PIN: 'moon42' }, 77);
  const puts = calls.filter((c) => c.m === 'PUT');
  assert.deepEqual(puts.map((c) => c.p), ['/user/codespaces/secrets/SNUGCODE_MACHINE_TOKEN', '/user/codespaces/secrets/SNUGCODE_PAIR_PIN']);
  for (const c of puts) {
    assert.deepEqual(c.body.selected_repository_ids, [77]);
    assert.equal(c.body.key_id, 'k1');
  }
  assert.equal(new TextDecoder().decode(openSealedBox(C.unb64(puts[0].body.encrypted_value), sk)), 'tok.machine');
  assert.ok(!JSON.stringify(calls).includes('moon42'), 'the PIN is never sent in the clear');
  const c = await cs.create({ id: 77, default_branch: 'main' }, 'm1');
  assert.equal(c.name, 'cs-abc');
  assert.deepEqual(calls.at(-1).body, { repository_id: 77, ref: 'main', display_name: 'snugcode m1', idle_timeout_minutes: 240 });
  assert.equal((await cs.find('m1', 'gone')).name, 'cs-abc', 'found by display name if the stored name is gone');
  assert.equal(await cs.start('cs-abc'), null, '409 (already running) is not an error');
  await cs.deleteSecrets(SECRET_NAMES);
  assert.ok(calls.every((x) => x.auth === 'Bearer tok'));
  for (let i = 0; i < 50; i++) assert.match(randomPin(), C.PIN_RE);
  // Token rejected by GitHub: the caller is told (the PWA drops the token & offers "Connect again").
  let dropped = 0;
  const dead = new Codespaces('old', { fetchImpl: async () => res(401, { message: 'Bad credentials' }), onAuthError: () => dropped++ });
  await assert.rejects(dead.list(), (e) => e.status === 401 && /no longer valid/.test(e.message));
  assert.equal(dropped, 1);
});

test('progress: the bar advances per stage, never full before done, remaining estimate & learned durations', async () => {
  const { stepFraction, overall, remaining, fmtLeft, fmtClock, learn } = await import('../web/eta.js');
  assert.equal(stepFraction(0, 10), 0);
  assert.equal(stepFraction(10, 10), 0.9);
  assert.ok(stepFraction(1000, 10) <= 0.99 && stepFraction(1000, 10) > 0.98, 'slows down, never full');
  const ests = [2, 3, 75, 50, 80, 12];
  assert.equal(overall(ests, 0, 0), 0);
  const mid = overall(ests, 3, 25);
  assert.ok(mid > overall(ests, 2, 75) && mid < overall(ests, 4, 0), 'monotonic across stages');
  assert.ok(overall(ests, 5, 9999) <= 99);
  assert.equal(remaining(ests, 2, 70), 5 + 50 + 80 + 12);
  assert.equal(remaining(ests, 2, 500), 50 + 80 + 12, 'an overrunning stage doesn\'t make the remainder negative');
  assert.match(fmtLeft(12), /^[±~]10 /);
  assert.match(fmtLeft(170), /^[±~]3 /);
  assert.equal(fmtClock(75), '1:15');
  assert.deepEqual(learn({ a: 100 }, { a: 40, b: 7 }), { a: 70, b: 7 });
});
