// Engine Codex (`codex app-server`): model GPT lewat login ChatGPT atau Responses API. Satu proses per
// sesi; perintah berjalan di sandbox OS Codex, izin lewat kebijakan snugcode yang sama (decideCodex),
// dan tool dev snugcode lewat jembatan MCP (mcp-bridge.js).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_PATH } from './config.js';
import { CodexAgent, codexCommand, installCodex, codexArgs, codexEnv, readOnlyActions, sandboxWorks } from './codex.js';
import { codexPrompt } from './prompt.js';
import { toolchainEnv } from './toolchain.js';
import { isInside, isSensitivePath, isProtectedRepoPath, SECRET_CMD_RE, isRemoteWrite, ruleMatches } from './permissions.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.js');

// Engine Codex (model GPT): satu proses `codex app-server` per sesi, dipakai ulang antar prompt.
// Model & effort berlaku per prompt, jadi ganti model tidak membuat proses baru.
export async function startCodexAgent(s, route) {
  const cfg = s.mgr.config;
  let cmd = codexCommand(cfg);
  if (!cmd) {
    s.emitEvent({ k: 'note', d: '◆ Memasang Codex untuk model ini (sekali saja, ±1–2 menit)…' });
    cmd = await installCodex(cfg);
    s.emitEvent({ k: 'note', d: '✓ Codex terpasang' });
  }
  const proxy = s.mgr.proxy;
  const proxyUrl = proxy ? await proxy.ready().catch(() => null) : null;
  // API key / router: Codex hanya melihat proxy lokal + token lokal. ChatGPT: login milik Codex sendiri.
  const token = route.wire === 'responses' ? s.mgr.tokenFor(route.conn, 'responses') : null;
  if (token && !proxyUrl) throw new Error('Loopback proxy snugcode tidak berjalan. Restart daemon (`snugcode restart`).');
  const computer = !!s.meta.computer;
  // Mode rencana = profil sandbox read-only milik proses (codexArgs); berganti mode = proses baru. Override
  // sandbox per giliran tidak dipakai: tersimpan di thread dan menimpa profil snugcode di giliran berikutnya.
  const plan = !!s.meta.plan;
  const key = ['codex', cmd.join(' '), route.conn.id, route.wire, token, proxyUrl, computer, plan].join('|');
  const cur = s.agent;
  if (cur && !cur.dead && cur.key === key) {
    clearTimeout(cur.idle);
    cur.idle = null;
    cur.setRoute(route);
    return cur;
  }
  s.closeAgent();
  const env = codexEnv(await toolchainEnv('', { ...process.env }), { ...(token ? { SNUGCODE_CODEX_TOKEN: token } : {}), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  const sandbox = await sandboxWorks(cmd);
  if (!sandbox && !s.mgr.warnedSandbox) {
    s.mgr.warnedSandbox = true;
    s.emitEvent({ k: 'note', d: '◆ Sandbox OS tidak tersedia di mesin ini (mis. container tanpa user namespace): perintah Codex berjalan tanpa sandbox, izin tetap lewat snugcode.' });
  }
  const args = codexArgs({
    provider: token ? { baseUrl: proxyUrl + '/v1', envKey: 'SNUGCODE_CODEX_TOKEN' } : null,
    computer,
    plan,
    sandbox,
    mcp: { command: process.execPath, args: [BRIDGE], env: { SNUGCODE_IPC: IPC_PATH, SNUGCODE_BRIDGE: s.mgr.bridgeToken(s) } },
  });
  const agent = new CodexAgent(s, { cmd, args, env, route, instructions: codexPrompt({ computer }), log: (m) => s.mgr.log(m) });
  agent.key = key;
  s.agent = agent;
  try {
    await agent.start();
  } catch (e) {
    agent.close();
    if (s.agent === agent) s.agent = null;
    throw new Error('Codex gagal dimulai: ' + e.message);
  }
  return agent;
}

// Keputusan izin untuk permintaan Codex, memakai kebijakan yang sama dengan engine Claude.
// kind: 'command' | 'file' | 'question' | 'permissions'.
export async function decideCodex(s, kind, p) {
  if (kind === 'command') {
    const input = { command: p.command };
    // Membaca folder data snugcode tidak pernah lolos otomatis (penting bila sandbox OS tidak tersedia).
    const sensitive = (p.actions || []).some((a) => a?.path && isSensitivePath(path.resolve(s.meta.cwd, String(a.path))));
    const special = isRemoteWrite('Bash', input) || SECRET_CMD_RE.test(p.command) || sensitive;
    // Perintah baca saja (cat/ls/rg …) lolos seperti di Claude Code; sandbox menolak folder data.
    if (!special && readOnlyActions(p.actions)) return 'accept';
    if (!special && [...s.allowRules].some((r) => ruleMatches(r, p.command))) return 'accept';
    const suggestions = Array.isArray(p.amendment) && p.amendment.length ? [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: p.amendment.join(' ') + ' *' }] }] : undefined;
    const r = await s.askPermission('Bash', input, { suggestions, title: p.reason || undefined });
    return r.behavior === 'allow' ? 'accept' : 'decline';
  }
  if (kind === 'file') {
    const cwd = s.meta.cwd;
    const paths = (p.changes || []).map((c) => path.resolve(cwd, String(c.path || '')));
    if (paths.some((x) => isSensitivePath(x, { write: true }))) return 'decline';
    if (s.cpReady) await s.cpReady;
    const inside = paths.length > 0 && (s.meta.computer || paths.every((x) => isInside(x, cwd)));
    const guarded = paths.some((x) => isProtectedRepoPath(x, cwd));
    if (!s.meta.plan && !guarded && ((inside && !s.meta.askEdits) || s.meta.auto)) return 'accept';
    const diff = (p.changes || []).map((c) => c.diff || '').join('\n');
    const r = await s.requestUser('Edit', { file_path: paths.map((x) => path.relative(cwd, x) || x).join(', '), old_string: '', new_string: diff }, { title: p.reason || undefined });
    return r.behavior === 'allow' ? 'accept' : 'decline';
  }
  if (kind === 'question') {
    const qs = p.questions || [];
    const questions = qs.map((q) => ({ question: q.question, header: q.header, multiSelect: false, options: (q.options || []).map((o) => ({ label: o.label, description: o.description || '' })) }));
    const r = await s.requestUser('AskUserQuestion', { questions }, {});
    const given = r.behavior === 'allow' ? r.updatedInput?.answers || {} : {};
    return Object.fromEntries(qs.map((q) => [q.id, { answers: given[q.question] != null ? [String(given[q.question])] : [] }]));
  }
  // Izin tambahan (jaringan / tulis di luar worktree) yang diminta agen.
  const r = await s.requestUser('Izin', { command: [p.reason, JSON.stringify(p.permissions || {})].filter(Boolean).join('\n') }, {});
  return r.behavior === 'allow';
}
