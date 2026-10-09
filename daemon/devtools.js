// Tool MCP in-process untuk agen: menjalankan dev server di latar belakang, membaca log,
// dan melihat hasil UI sendiri (screenshot + error konsol) — tanpa memblokir Bash.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { capture } from './browser.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
const tail = (s, n = 6000) => (s.length > n ? '…' + s.slice(-n) : s) || '(belum ada output)';

export const DEV_START = 'mcp__pocketcode__dev_start';
// Tool yang tidak menjalankan perintah baru: tidak perlu izin.
export const SAFE_DEV_TOOLS = ['dev_stop', 'dev_logs', 'dev_list', 'preview_screenshot'].map((n) => 'mcp__pocketcode__' + n);

export function devToolsServer(session) {
  const procs = session.procs;
  const run = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e.message);
    }
  };
  return createSdkMcpServer({
    name: 'pocketcode',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool(
        'dev_start',
        'Start a long-running process (dev server, watcher) in the background of this worktree, e.g. "npm run dev". Never run such commands with Bash (they block). Returns detected port and the first log lines. Env PORT is set to a free port; "{port}" in the command is replaced by it. To restart a server after code changes, dev_stop it first and reuse the same name.',
        { command: z.string(), name: z.string().optional().describe('Process name, defaults to the script name') },
        run(async ({ command, name }) => {
          const p = await procs.start(command, name);
          const port = await procs.waitPort(p.name, 25000);
          const st = procs.get(p.name);
          return text(`${st.status === 'running' ? 'running' : `exited (code ${st.code})`} · name=${p.name}${port ? ` · port=${port} · url=http://localhost:${port}` : ' · port not detected yet'}\n\n${tail(st.log, 3000)}`);
        }),
      ),
      tool('dev_stop', 'Stop a background process started with dev_start.', { name: z.string() }, run(async ({ name }) => (procs.stop(name), text('stopped ' + name)))),
      tool('dev_logs', 'Read recent output of a background process.', { name: z.string(), chars: z.number().int().positive().max(50000).optional() }, run(async ({ name, chars }) => text(tail(procs.logs(name), chars || 6000)))),
      tool('dev_list', 'List background processes of this session with status and port.', {}, run(async () => text(JSON.stringify(procs.list(), null, 1) || '[]'))),
      tool(
        'preview_screenshot',
        'Open a page in a headless browser on the PC and return a screenshot plus console errors. Use after UI changes to verify the result visually. Default viewport is a phone (390x844).',
        {
          url: z.string().optional().describe('Full URL; defaults to the first running dev server'),
          path: z.string().optional().describe('Path appended to the dev server URL, e.g. /login'),
          width: z.number().int().min(200).max(2560).optional(),
          height: z.number().int().min(200).max(2560).optional(),
          fullPage: z.boolean().optional(),
        },
        run(async ({ url, path = '/', width, height, fullPage }) => {
          if (!url) {
            // Proses terbaru: setelah agen menyalakan ulang server, yang lama bisa masih berjalan dengan kode basi.
            const p = procs.list().filter((x) => x.status === 'running' && x.port).sort((a, b) => b.startedAt - a.startedAt)[0];
            if (!p) return fail('No running dev server with a detected port. Start one with dev_start or pass url.');
            url = `http://localhost:${p.port}${path.startsWith('/') ? path : '/' + path}`;
          }
          const r = await capture(url, { width, height, fullPage, cfg: session.mgr.config });
          // Tampilkan juga di HP (bukan riwayat: base64 terlalu besar untuk .jsonl). Batas frame relay ~1MB.
          if (r.data.length < 450_000) session.live({ k: 'shot', url, mime: r.mime, data: r.data });
          const logs = r.logs.map((l) => `[${l.level}] ${l.text}`).join('\n');
          return { content: [{ type: 'image', data: r.data, mimeType: r.mime }, { type: 'text', text: `${url} — "${r.title}"\nconsole:\n${logs || '(kosong)'}` }] };
        }),
      ),
    ],
  });
}
