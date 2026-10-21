// Gemini CLI engine (`gemini --acp`): Google's official harness for Gemini models. One process per session;
// Gemini CLI only sees the loopback proxy + a local token, permissions go through snugcode's policy (decideGemini).
import { GeminiAgent, geminiCommand, installGemini, geminiHome, geminiEnv, diffOf } from './gemini.js';
import { decideCodex } from './engine-codex.js';
import { toolchainEnv } from './toolchain.js';

export async function startGeminiAgent(s, route) {
  const cfg = s.mgr.config;
  let cmd = geminiCommand(cfg);
  if (!cmd) {
    s.emitEvent({ k: 'note', d: '◆ Installing Gemini CLI for this model (once, ~1–2 min)…' });
    cmd = await installGemini(cfg);
    s.emitEvent({ k: 'note', d: '✓ Gemini CLI installed' });
  }
  const proxy = s.mgr.proxy;
  const proxyUrl = proxy ? await proxy.ready().catch(() => null) : null;
  if (!proxyUrl) throw new Error('The snugcode loopback proxy is not running. Restart the daemon (`snugcode restart`).');
  const token = s.mgr.tokenFor(route.conn, 'gemini');
  const computer = !!s.meta.computer;
  // Model & plan mode apply per prompt (session/set_model, session/set_mode): not part of the key.
  const key = ['gemini', cmd.join(' '), route.conn.id, token, proxyUrl, computer].join('|');
  const cur = s.agent;
  if (cur && !cur.dead && cur.key === key) {
    clearTimeout(cur.idle);
    cur.idle = null;
    cur.setRoute(route);
    return cur;
  }
  s.closeAgent();
  const env = geminiEnv(await toolchainEnv('', { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }), { home: geminiHome({ computer }), baseUrl: proxyUrl, token });
  const agent = new GeminiAgent(s, { cmd, env, route, log: (m) => s.mgr.log(m) });
  agent.key = key;
  s.agent = agent;
  try {
    await agent.start();
  } catch (e) {
    agent.close();
    if (s.agent === agent) s.agent = null;
    throw new Error('Gemini CLI failed to start: ' + e.message);
  }
  return agent;
}

// Permission decision for Gemini CLI tool calls (session/request_permission), same policy as the
// other engines: shell commands & file edits via decideCodex, leaving plan mode = ExitPlanMode.
export async function decideGemini(s, tc) {
  const cwd = s.meta.cwd;
  const kind = tc.kind || 'other';
  const title = String(tc.title || '');
  if (kind === 'execute') {
    // The title of a Gemini CLI shell tool call = its command.
    const command = String(tc.rawInput?.command || title);
    return (await decideCodex(s, 'command', { command })) === 'accept';
  }
  if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    const diffs = diffOf(tc.content, cwd);
    const paths = diffs.length ? diffs.map((d) => d.path) : (tc.locations || []).map((l) => l.path);
    const changes = paths.map((p, i) => ({ path: p, diff: diffs[i]?.diff || '' }));
    return (await decideCodex(s, 'file', { changes })) === 'accept';
  }
  if (kind === 'switch_mode') {
    const plan = contentPlan(tc) || title;
    const r = await s.askPermission('ExitPlanMode', { plan }, {});
    return r.behavior === 'allow';
  }
  // Everything else (web fetch, other tools) uses the general policy: WebFetch/WebSearch are safe, the rest ask.
  const tool = toolOf(tc);
  const r = await s.askPermission(kind === 'fetch' ? (tool === 'google_web_search' ? 'WebSearch' : 'WebFetch') : 'gemini__' + tool, { url: tc.rawInput?.url, command: title }, {});
  return r.behavior === 'allow';
}

// Gemini CLI tool call IDs look like `<tool name>__<tool name>_<time>_<n>`.
export const toolOf = (tc) => String(tc.toolCallId || '').split('__')[0] || String(tc.title || '').split(/[\s(]/)[0] || 'tool';

const contentPlan = (tc) =>
  (tc.content || [])
    .map((c) => (c.type === 'content' && c.content?.type === 'text' ? c.content.text : ''))
    .filter(Boolean)
    .join('\n');
