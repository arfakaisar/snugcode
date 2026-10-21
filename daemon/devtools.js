// In-process MCP tools for the agent: run dev servers in the background, read logs,
// and see its own UI (screenshot + console errors) — without blocking Bash.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { capture } from './browser.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
const tail = (s, n = 6000) => (s.length > n ? '…' + s.slice(-n) : s) || '(no output yet)';

export const DEV_START = 'mcp__snugcode__dev_start';
// Allowed without asking only for localhost URLs (dev servers); other URLs/`file:` ask (see sessions.js).
export const SCREENSHOT = 'mcp__snugcode__preview_screenshot';
// Tools that don't run new commands: no permission needed.
export const SAFE_DEV_TOOLS = ['dev_stop', 'dev_logs', 'dev_list', 'preview_screenshot'].map((n) => 'mcp__snugcode__' + n);

// Console log for the model: duplicate lines (HMR/re-render spam) are merged, each line & the total are capped.
// Errors first; regular logs only fill the remaining space.
export function consoleSummary(logs, { maxLine = 400, maxTotal = 5000 } = {}) {
  const seen = new Map();
  for (const l of logs) {
    const key = `[${l.level}] ${String(l.text).slice(0, maxLine)}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const lines = [...seen].map(([k, n]) => (n > 1 ? `${k} (×${n})` : k));
  const bad = lines.filter((l) => /^\[(error|exception|assert|warning)\]/.test(l));
  const out = [];
  let total = 0;
  for (const l of [...bad, ...lines.filter((l) => !bad.includes(l))]) {
    if (total + l.length > maxTotal) {
      out.push(`… ${lines.length - out.length} more lines omitted`);
      break;
    }
    out.push(l);
    total += l.length + 1;
  }
  return out.join('\n');
}

// Dev tool definitions, used by the Claude engine (Agent SDK in-process MCP server) and the Codex engine
// (stdio MCP server, see mcp-bridge.js). handler(session, args) -> MCP result.
/** @type {{ name: string, description: string, shape: Record<string, any>, handler: (session: any, args: any) => Promise<any> }[]} */
const DEV_TOOLS = [
  {
    name: 'dev_start',
    description: 'Start a long-running process (dev server, watcher) in the background of this worktree, e.g. "npm run dev". Never run such commands with Bash (they block). Returns detected port and the first log lines. Env PORT is set to a free port; "{port}" in the command is replaced by it. To restart a server after code changes, dev_stop it first and reuse the same name.',
    shape: { command: z.string(), name: z.string().optional().describe('Process name, defaults to the script name') },
    async handler(session, { command, name }) {
      const procs = session.procs;
      const p = await procs.start(command, name);
      const port = await procs.waitPort(p.name, 25000);
      const st = procs.get(p.name);
      return text(`${st.status === 'running' ? 'running' : `exited (code ${st.code})`} · name=${p.name}${port ? ` · port=${port} · url=http://localhost:${port}` : ' · port not detected yet'}\n\n${tail(st.log, 3000)}`);
    },
  },
  { name: 'dev_stop', description: 'Stop a background process started with dev_start.', shape: { name: z.string() }, handler: async (session, { name }) => (session.procs.stop(name), text('stopped ' + name)) },
  { name: 'dev_logs', description: 'Read recent output of a background process (default last 4000 chars).', shape: { name: z.string(), chars: z.number().int().positive().max(20000).optional() }, handler: async (session, { name, chars }) => text(tail(session.procs.logs(name), chars || 4000)) },
  { name: 'dev_list', description: 'List background processes of this session with status and port.', shape: {}, handler: async (session) => text(JSON.stringify(session.procs.list(), null, 1) || '[]') },
  {
    name: 'preview_screenshot',
    description: 'Open a page in a headless browser on the PC and return a screenshot plus console errors. Use after visual UI changes. Default viewport is a phone (390x844). Pass image:false when only console errors/title are needed (much cheaper).',
    shape: {
      url: z.string().optional().describe('Full URL; defaults to the first running dev server'),
      path: z.string().optional().describe('Path appended to the dev server URL, e.g. /login'),
      width: z.number().int().min(200).max(2560).optional(),
      height: z.number().int().min(200).max(2560).optional(),
      fullPage: z.boolean().optional(),
      image: z.boolean().optional().describe('Return the screenshot image (default true)'),
    },
    async handler(session, { url, path = '/', width, height, fullPage, image = true }) {
      if (!url) {
        // Newest process: after the agent restarts a server, the old one may still be running stale code.
        const p = session.procs.list().filter((x) => x.status === 'running' && x.port).sort((a, b) => b.startedAt - a.startedAt)[0];
        if (!p) return fail('No running dev server with a detected port. Start one with dev_start or pass url.');
        url = `http://localhost:${p.port}${path.startsWith('/') ? path : '/' + path}`;
      }
      const r = await capture(url, { width, height, fullPage, scale: 1, cfg: session.mgr.config });
      // Also show it on the phone (not in history: base64 is too big for .jsonl). Relay frame limit ~1MB.
      if (r.data.length < 450_000) session.live({ k: 'shot', url, mime: r.mime, data: r.data });
      const logs = consoleSummary(r.logs);
      const info = { type: 'text', text: `${url} — "${r.title}"\nconsole:\n${logs || '(empty)'}` };
      return { content: image ? [{ type: 'image', data: r.data, mimeType: r.mime }, info] : [info] };
    },
  },
];

/** @param {(...a: any[]) => Promise<any>} fn */
const safeRun = (fn) => async (/** @type {any[]} */ ...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    return fail(e.message);
  }
};

export function devToolsServer(session) {
  return createSdkMcpServer({
    name: 'snugcode',
    version: '1.0.0',
    alwaysLoad: true,
    tools: DEV_TOOLS.map((t) => tool(t.name, t.description, t.shape, safeRun((args) => t.handler(session, args)))),
  });
}

// For the stdio MCP server (Codex engine): JSON schema of each tool.
export const devToolList = () => DEV_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.shape)) }));

// Called through the MCP bridge (Codex engine). In the Claude engine canUseTool checks permission before the tool
// runs; here the same permission is checked first (dev_start runs a command, screenshots of external URLs).
export async function callDevTool(session, name, args = {}) {
  const t = DEV_TOOLS.find((x) => x.name === name);
  if (!t) return fail('unknown tool ' + name);
  const parsed = z.object(t.shape).safeParse(args);
  if (!parsed.success) return fail('invalid arguments: ' + parsed.error.message.slice(0, 300));
  const perm = await session.askPermission('mcp__snugcode__' + name, parsed.data, {});
  if (perm.behavior !== 'allow') return fail('Denied by the user: ' + (perm.message || 'not allowed'));
  return safeRun(() => t.handler(session, perm.updatedInput || parsed.data))();
}
