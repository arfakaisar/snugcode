// Engine Gemini CLI (`gemini --acp`): harness resmi Google untuk model Gemini. Satu proses per sesi;
// Gemini CLI hanya melihat loopback proxy + token lokal, izin lewat kebijakan snugcode (decideGemini).
import { GeminiAgent, geminiCommand, installGemini, geminiHome, geminiEnv, diffOf } from './gemini.js';
import { decideCodex } from './engine-codex.js';
import { toolchainEnv } from './toolchain.js';

export async function startGeminiAgent(s, route) {
  const cfg = s.mgr.config;
  let cmd = geminiCommand(cfg);
  if (!cmd) {
    s.emitEvent({ k: 'note', d: '◆ Memasang Gemini CLI untuk model ini (sekali saja, ±1–2 menit)…' });
    cmd = await installGemini(cfg);
    s.emitEvent({ k: 'note', d: '✓ Gemini CLI terpasang' });
  }
  const proxy = s.mgr.proxy;
  const proxyUrl = proxy ? await proxy.ready().catch(() => null) : null;
  if (!proxyUrl) throw new Error('Loopback proxy snugcode tidak berjalan. Restart daemon (`snugcode restart`).');
  const token = s.mgr.tokenFor(route.conn, 'gemini');
  const computer = !!s.meta.computer;
  // Model & mode rencana berlaku per prompt (session/set_model, session/set_mode): tidak masuk kunci.
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
    throw new Error('Gemini CLI gagal dimulai: ' + e.message);
  }
  return agent;
}

// Keputusan izin untuk tool call Gemini CLI (session/request_permission), kebijakan yang sama dengan
// engine lain: perintah shell & edit file lewat decideCodex, peralihan dari mode rencana = ExitPlanMode.
export async function decideGemini(s, tc) {
  const cwd = s.meta.cwd;
  const kind = tc.kind || 'other';
  const title = String(tc.title || '');
  if (kind === 'execute') {
    // Judul tool call shell Gemini CLI = perintahnya.
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
  // Sisanya (web fetch, tool lain) lewat kebijakan umum: WebFetch/WebSearch aman, lainnya bertanya.
  const tool = toolOf(tc);
  const r = await s.askPermission(kind === 'fetch' ? (tool === 'google_web_search' ? 'WebSearch' : 'WebFetch') : 'gemini__' + tool, { url: tc.rawInput?.url, command: title }, {});
  return r.behavior === 'allow';
}

// ID tool call Gemini CLI berbentuk `<nama tool>__<nama tool>_<waktu>_<n>`.
export const toolOf = (tc) => String(tc.toolCallId || '').split('__')[0] || String(tc.title || '').split(/[\s(]/)[0] || 'tool';

const contentPlan = (tc) =>
  (tc.content || [])
    .map((c) => (c.type === 'content' && c.content?.type === 'text' ? c.content.text : ''))
    .filter(Boolean)
    .join('\n');
