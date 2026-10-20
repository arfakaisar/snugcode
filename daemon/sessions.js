// Sesi agen: menjalankan harness agen yang paling cocok untuk model sesi — Claude Agent SDK
// (model Claude & endpoint format Anthropic/OpenAI) atau Codex (model GPT: login ChatGPT / Responses
// API) — mengubah pesannya menjadi event ringkas untuk HP, dan menyimpan riwayatnya. Izin,
// checkpoint, dan tool dev snugcode sama untuk kedua engine.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SESSIONS_DIR, CLAUDE_DIR, WORKSPACES, SESSION_INDEX, writeJson, readSessionIndex } from './config.js';
import { prepareWorktree, removeWorktree, inspectLocalRepo, currentBranch, repoDirName } from './github.js';
import { startProxy } from './proxy.js';
import { resolveRoute, authHeaders, geminiRoot, knownRefs, allConnections, getConn } from './providers.js';
import { todosFromInput, todoText } from '../shared/events.js';
import { permRisk, autonomyOf, autonomyFlags, AUTONOMY } from '../shared/risk.js';
import { PLANS_DIR, isInside, isSensitivePath, isProtectedRepoPath, SECRET_CMD_RE, toolPaths, isLocalUrl, isRemoteWrite, escapesSandbox, neverAlways, suggestedRules, ruleText, ruleMatches } from './permissions.js';
import { AGENT_TOOLS, widenToolInput, isClaudeModel, startClaudeAgent } from './engine-claude.js';
import { startCodexAgent, decideCodex } from './engine-codex.js';
import { startGeminiAgent, decideGemini } from './engine-gemini.js';
import { cleanupWorkspaces, safeRm } from './cleaner.js';
import { ProcManager } from './procs.js';
import { shellSpawn, toolchainEnv } from './toolchain.js';
import { openTunnel } from './tunnel.js';
import { snapshot, rewind } from './checkpoint.js';
import { restoreEnv, detectProject } from './project.js';
import { SAFE_DEV_TOOLS, DEV_START, SCREENSHOT } from './devtools.js';
import { closeBrowser } from './browser.js';

const OUT_LIMIT = 4000;

export { isSensitivePath, toolPaths, isRemoteWrite, suggestedRules, ruleMatches, AGENT_TOOLS, widenToolInput };

// Proses claude dibiarkan hidup di antara prompt (streaming input): prompt berikutnya langsung
// diproses tanpa spawn ulang + resume transcript. Dimatikan setelah menganggur selama ini, dan
// paling banyak MAX_IDLE_AGENTS proses menganggur dibiarkan hidup bersamaan (hemat RAM).
const AGENT_IDLE_MS = 5 * 60 * 1000;
const MAX_IDLE_AGENTS = 3;
// Riwayat sesi yang tidak dibuka siapa pun dilepas dari memori setelah selama ini.
const HISTORY_IDLE_MS = 30 * 60 * 1000;
// Saat memuat riwayat dari .jsonl, cukup baca bagian akhirnya (yang lebih lama tetap di file).
const LOAD_TAIL_BYTES = 8 * 1024 * 1024;

// Tool yang tidak pernah butuh izin di sesi ini. Tool baca (Read/Glob/Grep/LS) hanya lolos tanpa
// bertanya bila sasarannya di dalam worktree; WebFetch tidak termasuk karena bisa dipakai
// mengirim isi file ke luar (prompt injection dari README/issue).
const SAFE_TOOLS = new Set(['TodoWrite', 'Task', 'Agent', 'WebSearch', 'ToolSearch', 'BashOutput', ...SAFE_DEV_TOOLS]);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_TOOLS = new Set([...READ_TOOLS, ...EDIT_TOOLS]);

// Gambar dari HP (kamera/galeri/tempel), sudah dikompres di sisi HP agar muat satu frame relay (~1MB).
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
function checkImages(images) {
  if (!Array.isArray(images) || !images.length) return [];
  if (images.length > 4) throw new Error('Maksimal 4 gambar per pesan');
  if (images.some((i) => !IMAGE_TYPES.has(i?.mime) || typeof i.data !== 'string')) throw new Error('Format gambar tidak didukung');
  if (images.reduce((n, i) => n + i.data.length, 0) > 700_000) throw new Error('Gambar terlalu besar');
  return images.map((i) => ({ mime: i.mime, data: i.data }));
}

// Event riwayat yang disimpan di memori per sesi; yang lebih lama tetap ada di file .jsonl.
const MEM_EVENTS = 3000;

function cut(s, n = OUT_LIMIT) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} karakter dipotong)` : s;
}

// "mcp__snugcode__dev_start" -> "dev_start" (tool MCP lain: "server:tool").
const shortName = (n) => (n.startsWith('mcp__') ? n.replace(/^mcp__snugcode__/, '').replace(/^mcp__([^_]+(?:_[^_]+)*?)__/, '$1:') : n);

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

// Ringkasan input tool supaya muat di layar HP (path dibuat relatif ke worktree).
export function toolSummary(name, input = {}, cwd) {
  const s = toolSummaryRaw(name, input);
  if (!cwd || typeof s !== 'string') return s;
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const base = norm(cwd).replace(/\/+$/, '') + '/';
  const rel = (p) => (norm(p).startsWith(base) ? p.slice(base.length).replace(/\\/g, '/') || '.' : norm(p) === base.slice(0, -1) ? '.' : p);
  return s.replace(/[A-Za-z]:[\\/][^\s'"]*|\/[^\s'"]+/g, rel);
}

function toolSummaryRaw(name, input = {}) {
  switch (name) {
    case 'Bash':
    case DEV_START:
      return input.command;
    case 'mcp__snugcode__preview_screenshot':
      return input.url || input.path || '/';
    case 'mcp__snugcode__dev_stop':
    case 'mcp__snugcode__dev_logs':
      return input.name;
    case 'mcp__snugcode__dev_list':
      return '';
    case 'AskUserQuestion':
      return (input.questions || []).map((q) => q.question).join('\n');
    case 'ExitPlanMode':
      return input.plan;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return input.file_path || input.notebook_path;
    case 'Glob':
      return input.pattern;
    case 'Grep':
      return `${input.pattern}${input.path ? '  in ' + input.path : ''}`;
    case 'WebFetch':
      return input.url;
    case 'WebSearch':
      return input.query;
    case 'Task':
    case 'Agent':
      return input.description || input.prompt;
    case 'TodoWrite':
      return todoText(todosFromInput(input.todos));
    default:
      return cut(input, 400);
  }
}

// Untuk Edit/Write: kirim cuplikan perubahan agar bisa ditampilkan sebagai diff mini.
function toolDetail(name, input = {}) {
  if (name === 'Edit') return { old: cut(input.old_string || '', 3000), new: cut(input.new_string || '', 3000) };
  if (name === 'MultiEdit') return { edits: (input.edits || []).slice(0, 10).map((e) => ({ old: cut(e.old_string, 1500), new: cut(e.new_string, 1500) })) };
  if (name === 'Write') return { new: cut(input.content || '', 3000) };
  return undefined;
}

export class Session extends EventEmitter {
  constructor(meta, manager) {
    super();
    this.meta = meta;
    this.mgr = manager;
    this._history = null; // dimuat dari .jsonl saat pertama dibutuhkan
    this.trimmed = false;
    this._lastSeq = 0;
    this.status = 'idle';
    this.agent = null; // proses claude yang hidup (lihat ensureAgent)
    this.turn = null; // prompt yang sedang dikerjakan: { resolve, agent }
    this.cpReady = null; // checkpoint prompt berjalan; tool yang mengubah file menunggunya
    this.perms = new Map(); // pid -> { resolve, tool, input }
    // "Selalu izinkan" disimpan di meta agar tetap berlaku setelah daemon restart.
    this.alwaysAllow = new Set(meta.alwaysAllow || []);
    // Aturan izin per pola perintah ("Bash(npm test *)"), diteruskan ke Claude Code.
    this.allowRules = new Set(meta.allowRules || []);
    this.textBuf = '';
    this.textTimer = null;
    this.logFile = path.join(SESSIONS_DIR, meta.id + '.jsonl');
    this.logStream = null;
    this.procs = new ProcManager({ cwd: meta.cwd, onChange: (p) => this.onProc(p), onOut: (name, d) => this.live({ k: 'procOut', name, d }) });
    this.tunnel = null;
  }

  // Event sesaat (log proses, screenshot, status preview): langsung ke klien, tidak masuk riwayat
  // agar tidak menggeser percakapan dari memori dan tidak membengkakkan file .jsonl.
  live(e) {
    this.emit('event', e);
  }

  onProc(p) {
    this.live({ k: 'proc', ...p });
    if (p.status !== 'exited') return;
    if (this.tunnel?.name === p.name) this.closeTunnel();
    if (!p.killed && p.code !== 0) this.mgr.notify(this, `✗ ${p.name} berhenti (exit ${p.code})`, { minor: true });
  }

  // Siapkan dependency bila perlu (proses "setup"), lalu jalankan dev server.
  async runDev(cmd) {
    const det = detectProject(this.meta.cwd);
    const dev = String(cmd || '').trim() || det.dev;
    if (!dev) throw new Error('Perintah dev tidak terdeteksi. Isi perintahnya, mis. "npm run dev", atau tambahkan .snugcode.json { "dev": "..." }.');
    if (!cmd && det.setup && this.procs.procs.get('setup')?.status !== 'running') {
      await this.procs.start(det.setup, 'setup');
      this.procs.get('setup').done.then((code) => code === 0 && this.procs.start(dev).catch((e) => this.emitEvent({ k: 'error', d: e.message })));
      return { setup: det.setup, dev };
    }
    await this.procs.start(dev);
    return { dev };
  }

  async preview(name) {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const port = await this.procs.waitPort(name, 60000);
      if (!port) throw new Error(`Port "${name}" belum terdeteksi. Cek log prosesnya.`);
      const t = this.tunnel;
      if (t?.port === port && t.name === name) return this.previewInfo();
      if (t) {
        // Tunnel yang sudah ada cukup diarahkan ke port baru: URL & cookie HP tetap berlaku,
        // tanpa menunggu cloudflared + DNS subdomain baru (5–15 detik).
        t.retarget(port);
        t.name = name;
      } else {
        const nt = await openTunnel(port, { cfg: this.mgr.config, onExit: () => this.tunnel === nt && this.closeTunnel() });
        nt.name = name;
        this.tunnel = nt;
      }
      this.live({ k: 'preview', ...this.previewInfo() });
      return this.previewInfo();
    })().finally(() => (this.opening = null));
    return this.opening;
  }

  previewInfo() {
    const t = this.tunnel;
    return t ? { name: t.name, port: t.port, url: t.url, link: t.link } : null;
  }

  closeTunnel() {
    if (!this.tunnel) return;
    this.tunnel.close();
    this.tunnel = null;
    this.live({ k: 'preview' });
  }

  get id() {
    return this.meta.id;
  }

  get events() {
    if (!this._history) this.load();
    return this._history;
  }

  get seq() {
    if (!this._history) this.load();
    return this._lastSeq;
  }

  // Hanya bagian akhir file yang dibaca: riwayat panjang tidak perlu dimuat seluruhnya.
  load() {
    this._history = [];
    this.trimmed = false;
    let text;
    try {
      const fd = fs.openSync(this.logFile, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - LOAD_TAIL_BYTES);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
        if (start > 0) {
          text = text.slice(text.indexOf('\n') + 1);
          this.trimmed = true;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        this._history.push(e);
        this._lastSeq = e.seq;
      } catch {}
    }
    this.trim();
  }

  trim() {
    if (this._history.length <= MEM_EVENTS) return;
    this._history.splice(0, this._history.length - MEM_EVENTS);
    this.trimmed = true;
  }

  // Lepaskan riwayat dari memori (dimuat ulang dari file saat dibutuhkan lagi).
  unload() {
    if (!this._history || this.logStream?.writableLength) return false;
    this._history = null;
    this.closeLog();
    return true;
  }

  appendLog(e) {
    if (!this.logStream) {
      this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
      this.logStream.on('error', (err) => {
        this.mgr.log('! gagal menulis riwayat sesi: ' + err.message);
        this.logStream = null;
      });
    }
    this.logStream.write(JSON.stringify(e) + '\n');
  }

  closeLog() {
    const s = this.logStream;
    this.logStream = null;
    return s ? new Promise((r) => s.end(r)) : Promise.resolve();
  }

  summary() {
    const m = this.meta;
    // Di sesi lokal pengguna bisa pindah branch dari terminal; baca yang aktif sekarang.
    const branch = (m.local && currentBranch(m.cwd)) || m.branch || '-';
    let engine = null;
    try {
      engine = resolveRoute(this.mgr.secrets, m.model).engine;
    } catch {}
    return { id: m.id, repo: m.repo, branch, base: m.base, title: m.title, model: m.model, engine, status: this.status, updatedAt: m.updatedAt, auto: !!m.auto, autoLow: !!m.autoLow, autonomy: autonomyOf(m), spent: m.spentUsd || 0, budget: m.budgetUsd || 0, plan: !!m.plan, askEdits: !!m.askEdits, local: !!m.local, computer: !!m.computer, cwd: m.cwd };
  }

  emitEvent(e, { persist = true } = {}) {
    if (e.k !== 'text') this.flushText();
    if (e.k === 'done') this.account(e);
    const events = this.events;
    e.seq = ++this._lastSeq;
    e.ts = Date.now();
    events.push(e);
    if (events.length > MEM_EVENTS + 500) this.trim();
    if (persist) this.appendLog(e);
    this.emit('event', e);
    return e;
  }

  // Biaya: Agent SDK melaporkan total berjalan per proses (bukan per giliran), dan proses yang melanjutkan
  // transcript mulai dari total tersimpan. Diubah menjadi biaya giliran ini (`cost`) + total sesi (`spent`),
  // lalu dibandingkan dengan batas biaya sesi (meta.budgetUsd). Engine tanpa biaya (Codex/Gemini) dilewati.
  account(e) {
    if (typeof e.cost !== 'number' || !(e.cost >= 0)) return;
    const m = this.meta;
    const agent = this.agent;
    const prev = agent && agent.lastCost != null ? agent.lastCost : m.costSeen ?? null;
    const delta = prev != null && e.cost >= prev ? e.cost - prev : e.cost;
    if (agent) agent.lastCost = e.cost;
    m.costSeen = e.cost;
    m.spentUsd = Math.round(((m.spentUsd || 0) + delta) * 1e6) / 1e6;
    e.cost = delta || undefined;
    e.spent = m.spentUsd;
    if (m.budgetUsd > 0) {
      const ratio = m.spentUsd / m.budgetUsd;
      if (ratio >= 1) this.mgr.notify(this, `Batas biaya sesi $${m.budgetUsd} tercapai ($${m.spentUsd.toFixed(2)}). Prompt berikutnya ditahan sampai batas dinaikkan.`);
      else if (ratio >= 0.8 && !m.budgetWarned) {
        m.budgetWarned = true;
        this.mgr.notify(this, `Biaya sesi sudah ${Math.round(ratio * 100)}% dari batas $${m.budgetUsd}.`);
      }
    }
    this.mgr.saveIndex();
  }

  // Batas biaya sesi dalam USD (0 = tanpa batas). Dicek sebelum setiap prompt.
  setBudget(usd) {
    const v = Math.max(0, Math.min(10_000, Number(usd) || 0));
    this.meta.budgetUsd = v || undefined;
    this.meta.budgetWarned = v > 0 && (this.meta.spentUsd || 0) >= v * 0.8;
    this.mgr.saveIndex();
  }

  // Delta teks dikumpulkan ~80ms agar tidak mengirim satu pesan per token.
  pushText(t) {
    this.textBuf += t;
    if (!this.textTimer) this.textTimer = setTimeout(() => this.flushText(), 80);
  }
  flushText() {
    if (this.textTimer) clearTimeout(this.textTimer);
    this.textTimer = null;
    if (!this.textBuf) return;
    const d = this.textBuf;
    this.textBuf = '';
    this.emitEvent({ k: 'text', d });
  }

  pushThinking(t) {
    if (!t) return;
    const words = t.trim().split(/\s+/).filter(Boolean).length || 1;
    this.thinkingWords = (this.thinkingWords || 0) + words;
    if (!this.thinkingTimer) {
      this.thinkingTimer = setTimeout(() => {
        this.thinkingTimer = null;
        if (this.thinkingWords) this.emitEvent({ k: 'thinking', words: this.thinkingWords }, { persist: false });
      }, 200);
    }
  }

  clearThinking() {
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = null;
    this.thinkingWords = 0;
  }

  setStatus(s) {
    this.status = s;
    this.meta.updatedAt = Date.now();
    this.mgr.saveIndex();
    this.emitEvent({ k: 'status', s }, { persist: false });
  }

  since(seq) {
    const ev = this.events;
    // Event berurutan menurut seq: cari batasnya dari belakang (umumnya hanya beberapa event baru).
    let i = ev.length;
    while (i > 0 && ev[i - 1].seq > seq) i--;
    return ev.slice(i);
  }

  // true bila event setelah `seq` sebagian sudah dibuang dari memori.
  missingSince(seq) {
    return this.trimmed && (this.events[0]?.seq ?? 0) > seq + 1;
  }

  // Konteks risiko satu permintaan izin (lihat shared/risk.js).
  permCtx(tool, input) {
    const cwd = this.meta.cwd;
    const paths = FILE_TOOLS.has(tool) ? toolPaths(tool, input, cwd) : [];
    const write = FILE_TOOLS.has(tool) && !READ_TOOLS.has(tool);
    return {
      push: isRemoteWrite(tool, input),
      secret: (tool === 'Bash' || tool === DEV_START) && SECRET_CMD_RE.test(input?.command || ''),
      escapes: escapesSandbox(tool, input),
      protectedEdit: write && paths.some((p) => isProtectedRepoPath(p, cwd)),
      outside: paths.length > 0 && !paths.every((p) => isInside(p, cwd)),
      computer: !!this.meta.computer,
    };
  }

  permEvent(pid, p) {
    const { tool, input } = p;
    const rules = suggestedRules(tool, p.suggestions);
    const ctx = this.permCtx(tool, input);
    const risk = permRisk(tool, input, ctx);
    // Cakupan tombol "Selalu" untuk ditampilkan; tidak ada untuk aksi yang tidak pernah bisa "Selalu".
    const always = neverAlways(tool, input) ? undefined : rules.length ? rules.map((r) => r.ruleContent).join(', ') : shortName(tool);
    // Jaring pengaman yang terlihat: perubahan file di worktree sesi repo bisa dikembalikan (checkpoint per prompt).
    const undo = !this.meta.computer && !ctx.push && !ctx.outside && (EDIT_TOOLS.has(tool) || tool === 'Bash' || tool === DEV_START) ? (EDIT_TOOLS.has(tool) ? 'file' : 'cmd') : undefined;
    return { pid, tool: shortName(tool), s: toolSummary(tool, input, this.meta.cwd), title: p.title, push: ctx.push, plan: tool === 'ExitPlanMode' || undefined, ask: tool === 'AskUserQuestion' ? input.questions : undefined, x: toolDetail(tool, input), always, risk: risk || undefined, undo };
  }

  pendingPerms() {
    return [...this.perms.entries()].map(([pid, p]) => {
      const e = this.permEvent(pid, p);
      return { ...e, summary: e.s };
    });
  }

  async send(text, images) {
    if (this.status === 'running') throw new Error('Agen masih berjalan. Hentikan dulu (Stop) atau tunggu selesai.');
    images = checkImages(images);
    if (text.startsWith('!') && !images.length) return this.shell(text.slice(1).trim());
    if (!text && !images.length) return;
    if (this.meta.budgetUsd > 0 && (this.meta.spentUsd || 0) >= this.meta.budgetUsd)
      throw new Error(`Batas biaya sesi ini ($${this.meta.budgetUsd}) sudah tercapai ($${this.meta.spentUsd.toFixed(2)}). Naikkan batasnya di menu sesi untuk melanjutkan.`);
    // Model tanpa koneksi (runner baru, koneksi dihapus): pesan yang jelas sebelum prompt dicatat.
    resolveRoute(this.mgr.secrets, this.meta.model);
    if (!this.meta.title) this.meta.title = (text || 'gambar').slice(0, 80);
    const u = this.emitEvent({ k: 'user', d: text, img: images.length || undefined });
    this.run(text, images, u.seq).catch((err) => {
      this.emitEvent({ k: 'error', d: String(err?.message || err) });
      this.endTurn(true);
    });
  }

  // Pengguna mengubah file langsung (editor / batalkan hunk di HP): dicatat di riwayat, dan agen diberi
  // tahu di prompt berikutnya agar tidak mengedit berdasarkan isi lama.
  userChanged(what, note) {
    const line = `[snugcode] The user ${what} outside of this conversation. Re-read affected files before editing them.`;
    this.meta.note = this.meta.note ? this.meta.note + '\n' + line : line;
    this.mgr.saveIndex();
    this.emitEvent({ k: 'note', d: note });
  }

  // Kembalikan semua file worktree ke kondisi sebelum prompt `seq` dijalankan.
  async rewindTo(seq) {
    if (this.meta.computer) throw new Error('Checkpoint dan rewind hanya tersedia untuk sesi repository git.');
    if (this.status === 'running') throw new Error('Hentikan agen dulu sebelum mengembalikan file.');
    const cp = this.events.find((e) => e.k === 'cp' && e.of === seq);
    const u = this.events.find((e) => e.seq === seq);
    if (!cp || !u) throw new Error('Checkpoint untuk prompt ini tidak ada (sudah terlalu lama).');
    const n = await rewind(this.meta.cwd, cp.tree);
    const title = String(u.d || 'gambar').slice(0, 80);
    // Agen tidak tahu file berubah di luar dirinya; beri tahu di prompt berikutnya.
    this.meta.note = `[snugcode] The user restored all files to their state before the prompt "${title}". Every change made after that point is gone. Re-read files before editing them.`;
    this.mgr.saveIndex();
    this.emitEvent({ k: 'note', d: `↺ ${n} file dikembalikan ke sebelum "${title}"` });
    return n;
  }

  // Tinjau setiap edit file (Write/Edit) sebelum diterapkan. Mati (bawaan): edit di dalam worktree
  // langsung diterapkan, karena setiap prompt punya checkpoint dan bisa di-rewind.
  setAskEdits(on) {
    this.meta.askEdits = !!on;
    this.mgr.saveIndex();
  }

  // Preset otonomi (shared/risk.js): satu pilihan menggantikan kombinasi auto-izin + tinjau edit.
  setAutonomy(level) {
    if (!AUTONOMY.includes(level)) throw new Error('Tingkat otonomi tidak dikenal');
    Object.assign(this.meta, autonomyFlags(level));
    this.mgr.saveIndex();
  }

  setPlan(on) {
    this.meta.plan = !!on;
    this.mgr.saveIndex();
    this.agent?.setPlan?.(on);
    this.live({ k: 'mode', plan: !!on });
  }

  // Proses claude untuk sesi ini: dipakai ulang antar prompt. Ganti model/effort diterapkan
  // langsung ke proses yang hidup (setModel / applyFlagSettings); proses baru (melanjutkan
  // percakapan lewat `resume`) hanya bila binary, URL, token, atau model ringan berubah.
  // Panggilan bersamaan (pre-warm saat sesi dibuka + prompt) berbagi satu proses.
  async ensureAgent() {
    while (this._ensuring) await this._ensuring.catch(() => {});
    const p = (this._ensuring = this.startAgent());
    try {
      return await p;
    } finally {
      if (this._ensuring === p) this._ensuring = null;
    }
  }

  // Engine per model (engine-claude.js / engine-codex.js / engine-gemini.js); izin, checkpoint & event tetap milik sesi.
  async startAgent() {
    const route = resolveRoute(this.mgr.secrets, this.meta.model);
    if (route.engine === 'codex') return startCodexAgent(this, route);
    if (route.engine !== 'gemini') return startClaudeAgent(this, route);
    try {
      return await startGeminiAgent(this, route);
    } catch (e) {
      // Gemini CLI tidak bisa dipasang/dijalankan (mis. npm offline): model yang sama lewat Claude Agent SDK.
      if (!route.conn.formats?.openai && !route.conn.openai) throw e;
      this.mgr.log('! ' + e.message);
      if (!this.warnedGemini) this.emitEvent({ k: 'note', d: `◆ ${e.message.slice(0, 200)} Model ini dijalankan lewat Claude Agent SDK.` });
      this.warnedGemini = true;
      return startClaudeAgent(this, { ...route, engine: 'claude', wire: 'openai' });
    }
  }

  // Keputusan izin untuk permintaan Codex (dipanggil CodexAgent), lihat engine-codex.js.
  decideCodex(kind, p) {
    return decideCodex(this, kind, p);
  }

  // Keputusan izin untuk tool call Gemini CLI (dipanggil GeminiAgent), lihat engine-gemini.js.
  decideGemini(tc) {
    return decideGemini(this, tc);
  }

  // Hook PreToolUse untuk tool yang bisa mengubah file. Berjalan juga untuk tool yang lolos lewat
  // aturan "Selalu" (mis. Bash(git *)) tanpa melewati canUseTool, jadi di sinilah dua jaminan dijaga:
  // checkpoint prompt sudah tersimpan, dan push / perintah yang menyentuh kredensial tetap bertanya.
  async beforeTool(h) {
    await this.cpReady;
    const input = /** @type {any} */ (h)?.tool_input;
    if (h && 'tool_name' in h && neverAlways(h.tool_name, input)) return { hookSpecificOutput: { hookEventName: /** @type {const} */ ('PreToolUse'), permissionDecision: /** @type {const} */ ('ask'), permissionDecisionReason: 'snugcode: selalu butuh persetujuan pengguna' } };
    return {};
  }

  // Hook PreToolUse Read/Grep (lihat widenToolInput). Model Claude sudah membaca & mencari secara
  // efisien (dan paralel), jadi hanya model lain yang dilebarkan. Model dibaca saat itu juga:
  // ganti model di proses berjalan tidak membuat proses baru.
  widenTool(h) {
    if (!h || !('tool_name' in h) || isClaudeModel(this.meta.model)) return {};
    const updatedInput = widenToolInput(h.tool_name, /** @type {any} */ (h.tool_input), this.meta.cwd);
    return updatedInput ? { hookSpecificOutput: { hookEventName: /** @type {const} */ ('PreToolUse'), updatedInput } } : {};
  }

  // Sesi dibuka (HP/terminal): siapkan proses claude di latar belakang, jadi prompt pertama tidak
  // menunggu spawn + resume transcript. Ditutup lagi bila tetap menganggur (AGENT_IDLE_MS).
  warm() {
    if (this.agent || this._ensuring || this.status !== 'idle') return;
    this.ensureAgent().then(
      (a) => {
        if (this.turn || a.dead || a.idle) return;
        this.idleAgent(a);
      },
      () => {},
    );
  }

  idleAgent(agent) {
    clearTimeout(agent.idle);
    agent.lastUsed = Date.now();
    agent.idle = setTimeout(() => this.closeAgent(agent), AGENT_IDLE_MS);
    agent.idle.unref?.();
    this.mgr.trimAgents();
  }

  async consume(agent) {
    try {
      for await (const m of agent.q) {
        if (agent.dead) break;
        this.onAgentMessage(agent, m);
      }
    } catch (err) {
      if (!agent.dead && this.turn?.agent === agent) this.emitEvent({ k: 'error', d: String(err?.message || err) });
    } finally {
      agent.dead = true;
      clearTimeout(agent.idle);
      if (this.agent === agent) this.agent = null;
      // Proses mati di tengah prompt (crash / ditutup): prompt itu selesai, sesi kembali idle.
      // Prompt milik proses lain (mis. proses baru setelah ganti model) tidak disentuh.
      if (this.turn?.agent === agent) this.endTurn();
    }
  }

  onAgentMessage(agent, m) {
    // Agen bisa memulai giliran sendiri (mis. notifikasi tugas latar belakang selesai).
    if (!this.turn && (m.type === 'assistant' || m.type === 'stream_event') && !m.parent_tool_use_id) {
      this.turn = { resolve() {}, agent };
      this.setStatus('running');
    }
    if (m.type === 'system' && m.subtype === 'init') {
      if (this.meta.claudeSessionId !== m.session_id) {
        this.meta.claudeSessionId = m.session_id;
        this.mgr.saveIndex();
      }
    } else if (m.type === 'system' && m.subtype === 'api_retry') {
      this.emitEvent({ k: 'retry', attempt: m.attempt, max: m.max_retries, status: m.error_status });
    } else if (m.type === 'stream_event') {
      const ev = m.event;
      if (ev.type === 'message_start') {
        agent.currentMsgId = ev.message?.id;
        // Isi konteks = token input request terakhir (termasuk cache), untuk indikator konteks.
        const u = ev.message?.usage;
        if (u && !m.parent_tool_use_id) this.lastCtx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        this.clearThinking();
        this.flushText();
        this.emitEvent({ k: 'toolStart', name: shortName(ev.content_block.name) }, { persist: false });
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
        this.pushThinking(ev.delta.thinking);
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        this.clearThinking();
        agent.streamed.add(agent.currentMsgId);
        this.pushText(ev.delta.text);
      } else if (ev.type === 'content_block_stop') {
        this.clearThinking();
        this.flushText();
      }
    } else if (m.type === 'assistant') {
      if (m.parent_tool_use_id) return; // isi subagent tidak ditampilkan rinci
      for (const b of m.message.content || []) {
        if (b.type === 'text' && !agent.streamed.has(m.message.id) && b.text) this.emitEvent({ k: 'text', d: b.text });
        if (b.type === 'tool_use') this.emitEvent({ k: 'tool', id: b.id, name: shortName(b.name), s: toolSummary(b.name, b.input, this.meta.cwd), x: toolDetail(b.name, b.input), todos: b.name === 'TodoWrite' ? todosFromInput(b.input?.todos) : undefined });
      }
    } else if (m.type === 'user' && !m.parent_tool_use_id) {
      const content = m.message?.content;
      if (Array.isArray(content))
        for (const b of content) {
          if (b.type === 'tool_result') this.emitEvent({ k: 'result', id: b.tool_use_id, ok: !b.is_error, d: cut(toolResultText(b.content)) });
        }
    } else if (m.type === 'result') {
      this.flushText();
      const u = m.usage;
      // modelUsage juga memuat model kecil (subagen/utility); ambil milik model utama.
      const ctxMax = m.modelUsage?.[agent.model]?.contextWindow;
      const ok = m.subtype === 'success' && !m.is_error;
      this.emitEvent({
        k: 'done',
        ok,
        turns: m.num_turns,
        ms: m.duration_ms,
        // cr/cw: token input yang dibaca dari / ditulis ke prompt cache (cr ≈ 0 terus = router tidak meng-cache).
        usage: u ? { in: u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 } : undefined,
        cost: m.total_cost_usd || undefined,
        ctx: ctxMax && this.lastCtx ? Math.round((this.lastCtx / ctxMax) * 100) : undefined,
        err: m.subtype !== 'success' ? m.subtype : m.is_error ? cut(m.result || '', 600) : undefined,
      });
      this.mgr.notify(this, ok ? `✓ selesai · ${String(m.result || '').replace(/\s+/g, ' ').slice(0, 140)}` : `✗ berhenti · ${String(m.result || m.subtype).slice(0, 140)}`);
      agent.streamed.clear();
      if (this.turn?.agent === agent) this.endTurn();
      if (!agent.dead) this.idleAgent(agent);
    }
  }

  // Akhiri prompt yang berjalan: izin yang masih menunggu ditolak, status kembali idle.
  endTurn(force = false) {
    this.clearThinking();
    this.flushText();
    for (const p of this.perms.values()) p.resolve({ behavior: 'deny', message: 'Sesi dihentikan' });
    this.perms.clear();
    const t = this.turn;
    this.turn = null;
    if (t || (force && this.status === 'running')) this.setStatus('idle');
    t?.resolve();
  }

  closeAgent(agent = this.agent) {
    if (!agent) return;
    agent.dead = true;
    clearTimeout(agent.idle);
    agent.close();
    if (this.agent === agent) this.agent = null;
    if (this.turn?.agent === agent) this.endTurn();
  }

  async run(prompt, images = [], userSeq) {
    this.setStatus('running');
    this.turn = { resolve() {} };
    // Checkpoint berjalan paralel dengan start-up agen; tool yang mengubah file menunggu
    // checkpoint ini selesai (askPermission), jadi rewind tetap mendapat kondisi sebelum prompt.
    if (userSeq && !this.meta.computer)
      this.cpReady = snapshot(this.meta.cwd).then(
        (tree) => tree && this.emitEvent({ k: 'cp', of: userSeq, tree }),
        (e) => this.mgr.log('! checkpoint gagal: ' + e.message),
      );
    if (this.meta.note) {
      prompt = this.meta.note + '\n\n' + prompt;
      delete this.meta.note;
      this.mgr.saveIndex();
    }
    const agent = await this.ensureAgent();
    const done = new Promise((resolve) => (this.turn = { resolve, agent }));
    // Codex/Gemini CLI tidak punya hook "tunggu sebelum tool": checkpoint harus selesai sebelum giliran dimulai.
    if ((agent.kind === 'codex' || agent.kind === 'gemini') && this.cpReady) await this.cpReady;
    await agent.push({ text: prompt, images });
    return done;
  }

  // Pertanyaan pilihan (AskUserQuestion) dan persetujuan rencana (ExitPlanMode) selalu
  // menunggu pengguna, termasuk saat auto-izin aktif.
  /** @returns {Promise<import('@anthropic-ai/claude-agent-sdk').PermissionResult>} */
  async askPermission(tool, input, opts) {
    const cwd = this.meta.cwd;
    const allow = { behavior: /** @type {const} */ ('allow'), updatedInput: input };
    const paths = FILE_TOOLS.has(tool) ? toolPaths(tool, input, cwd) : [];
    const write = FILE_TOOLS.has(tool) && !READ_TOOLS.has(tool);
    if (paths.some((p) => isSensitivePath(p, { write }))) return { behavior: 'deny', message: 'Folder data snugcode berisi kredensial dan tidak boleh diakses agen.' };
    const isPush = isRemoteWrite(tool, input);
    const secretCmd = (tool === 'Bash' || tool === DEV_START) && SECRET_CMD_RE.test(input?.command || '');
    const shotUrl = tool === SCREENSHOT ? input?.url : null;
    const shotFile = shotUrl && !/^https?:/i.test(shotUrl);
    // Konfigurasi tool di repo (.claude/, .codex/, .mcp.json, .git/) dan perintah di luar sandbox selalu bertanya.
    const protectedEdit = write && paths.some((p) => isProtectedRepoPath(p, cwd));
    const needsUser = isPush || secretCmd || shotFile || protectedEdit || escapesSandbox(tool, input) || tool === 'AskUserQuestion' || tool === 'ExitPlanMode';
    // Mode rencana: agen menulis draf rencananya ke folder plans milik Claude (bukan worktree).
    const planFile = this.meta.plan && ['Write', 'Edit'].includes(tool) && path.resolve(String(input?.file_path || '')).startsWith(PLANS_DIR + path.sep);
    const readInside = READ_TOOLS.has(tool) && (this.meta.computer || paths.every((p) => isInside(p, cwd) || isInside(p, CLAUDE_DIR)));
    const safe = (SAFE_TOOLS.has(tool) && !(shotUrl && !isLocalUrl(shotUrl))) || readInside;
    // Edit di dalam worktree langsung diterapkan (bisa di-rewind), kecuali mode tinjau edit / rencana.
    const editInside = EDIT_TOOLS.has(tool) && paths.length > 0 && (this.meta.computer || paths.every((p) => isInside(p, cwd))) && !this.meta.askEdits && !this.meta.plan;
    // Tool yang bisa mengubah file baru jalan setelah checkpoint prompt ini tersimpan.
    if (!safe && this.cpReady) await this.cpReady;
    // Auto-izin untuk Bash hanya bila proses agen ini memang berjalan dengan sandbox (atau sandbox tidak didukung).
    const auto = this.meta.auto && !(tool === 'Bash' && this.agent?.unsandboxedAuto);
    if (!needsUser && (planFile || safe || editInside || auto || this.alwaysAllow.has(tool))) return allow;
    // Preset "Perintah rutin otomatis": test/lint/build tanpa rangkaian perintah lolos tanpa bertanya.
    if (!needsUser && this.meta.autoLow && !this.meta.plan && (tool === 'Bash' || tool === DEV_START) && permRisk(tool, input, this.permCtx(tool, input))?.level === 'low') return allow;
    return this.requestUser(tool, input, opts);
  }

  // Tanya pengguna (kartu izin di HP/terminal + notifikasi) dan tunggu jawabannya.
  /** @returns {Promise<import('@anthropic-ai/claude-agent-sdk').PermissionResult>} */
  requestUser(tool, input, opts) {
    const pid = randomBytes(6).toString('hex');
    return new Promise((resolve) => {
      const p = { resolve, tool, input, title: opts?.title, suggestions: opts?.suggestions };
      this.perms.set(pid, p);
      this.live({ k: 'perm', ...this.permEvent(pid, p) });
      // Isi notifikasi cukup untuk memutuskan dari layar kunci; risiko rendah/sedang bisa dijawab langsung
      // dari tombol notifikasi (sw.js), risiko tinggi selalu membuka aplikasi.
      const e = this.permEvent(pid, p);
      const what = tool === 'AskUserQuestion' ? 'Agen bertanya' : tool === 'ExitPlanMode' ? 'Rencana siap ditinjau' : `Butuh izin ${e.tool}: ${String(e.s || '').split('\n')[0].slice(0, 120)}`;
      this.mgr.notify(this, what, { perm: true, pid: e.risk && e.risk.level !== 'high' && !e.push ? pid : undefined, risk: e.risk?.level });
      opts?.signal?.addEventListener('abort', () => {
        if (this.perms.delete(pid)) resolve({ behavior: 'deny', message: 'dibatalkan' });
      });
    });
  }

  // decision: 'allow' | 'always' | 'deny'. `answers` (AskUserQuestion: pertanyaan → jawaban)
  // dan `message` (alasan tolak / revisi rencana) opsional.
  /** @param {string} pid @param {'allow' | 'always' | 'deny'} decision @param {{ answers?: Record<string, string>, message?: string }} [extra] */
  answerPermission(pid, decision, { answers, message } = {}) {
    const p = this.perms.get(pid);
    if (!p) return false;
    this.perms.delete(pid);
    let updatedPermissions;
    if (decision === 'always' && !neverAlways(p.tool, p.input)) {
      const rules = suggestedRules(p.tool, p.suggestions);
      if (rules.length) {
        // Berlaku langsung di proses berjalan (session) dan di proses berikutnya (settings).
        updatedPermissions = [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }];
        for (const r of rules) this.allowRules.add(ruleText(r));
        this.meta.allowRules = [...this.allowRules];
      } else {
        this.alwaysAllow.add(p.tool);
        this.meta.alwaysAllow = [...this.alwaysAllow];
      }
      this.mgr.saveIndex();
    }
    const allow = decision === 'allow' || decision === 'always';
    let s = toolSummary(p.tool, p.input, this.meta.cwd);
    let input = p.input;
    if (p.tool === 'AskUserQuestion' && allow) {
      input = { ...p.input, answers: Object.fromEntries(Object.entries(answers || {}).map(([k, v]) => [String(k), String(v).slice(0, 2000)])) };
      s = Object.values(input.answers).join(' · ');
    }
    if (p.tool === 'ExitPlanMode') {
      s = allow ? 'rencana disetujui' : 'rencana direvisi';
      if (allow) this.setPlan(false);
    }
    this.emitEvent({ k: 'permAnswer', pid, allow, tool: shortName(p.tool), s });
    const why = String(message || '').trim().slice(0, 4000);
    p.resolve(allow ? { behavior: 'allow', updatedInput: input, ...(updatedPermissions ? { updatedPermissions } : {}) } : { behavior: 'deny', message: why || 'Pengguna menolak aksi ini dari HP.' });
    return true;
  }

  async interrupt() {
    if (this.shellProc) this.shellProc.kill();
    const agent = this.agent;
    const turn = this.turn;
    if (!agent || turn?.agent !== agent) return;
    await Promise.resolve(agent.interrupt()).catch(() => {});
    // Normalnya agen membalas dengan `result`; bila tidak dalam 8 detik, matikan prosesnya.
    setTimeout(() => this.turn === turn && this.closeAgent(agent), 8000).unref?.();
  }

  // Matikan proses claude(.exe), dev server, dan tunnel sepenuhnya, mis. sebelum update/hapus sesi.
  async close() {
    if (this.shellProc) this.shellProc.kill();
    // Tunggu (maks. 3 detik) proses claude benar-benar keluar: di Windows claude.exe yang masih
    // hidup mengunci file binary (update) dan file worktree (hapus sesi).
    const exited = this.agent?.loop;
    this.closeAgent();
    this.closeTunnel();
    await Promise.all([this.procs.stopAll(), this.closeLog(), exited && Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])]);
  }

  // "!perintah" -> jalankan langsung di worktree (seperti ! di Claude Code).
  async shell(cmd) {
    if (!cmd) return;
    this.emitEvent({ k: 'sh', d: cmd });
    this.setStatus('running');
    let env;
    try {
      env = await toolchainEnv(cmd, { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
    } catch (e) {
      this.emitEvent({ k: 'error', d: e.message });
      this.emitEvent({ k: 'shDone', code: 1 });
      return this.setStatus('idle');
    }
    const p = shellSpawn(cmd, { cwd: this.meta.cwd, env });
    this.shellProc = p;
    let buf = '';
    let total = 0;
    const flush = () => {
      if (buf) this.emitEvent({ k: 'out', d: buf });
      buf = '';
    };
    const timer = setInterval(flush, 150);
    const onData = (d) => {
      total += d.length;
      if (total < 512 * 1024) buf += d.toString();
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const kill = setTimeout(() => p.kill(), 10 * 60 * 1000);
    p.on('close', (code) => {
      clearInterval(timer);
      clearTimeout(kill);
      flush();
      this.shellProc = null;
      this.emitEvent({ k: 'shDone', code });
      this.setStatus('idle');
    });
    p.on('error', (e) => this.emitEvent({ k: 'error', d: e.message }));
  }
}

// Bangun ulang daftar sesi dari worktree di disk bila index.json rusak: tanpa ini sesi (dan
// pekerjaan yang belum di-push) hilang dari aplikasi, dan pembersih akan menganggapnya yatim.
function recoverIndex(defaultModel) {
  const out = [];
  let repos = [];
  try {
    repos = fs.readdirSync(WORKSPACES);
  } catch {
    return out;
  }
  for (const dir of repos) {
    const repoDir = path.join(WORKSPACES, dir);
    let base = '';
    try {
      base = fs.readFileSync(path.join(repoDir, '_base', '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'utf8').trim().replace(/^ref: refs\/remotes\/origin\//, '');
    } catch {}
    let subs = [];
    try {
      subs = fs.readdirSync(repoDir).filter((s) => /^s-[\w-]+$/.test(s));
    } catch {}
    for (const sub of subs) {
      const cwd = path.join(repoDir, sub);
      const id = sub.slice(2);
      let st;
      try {
        st = fs.statSync(cwd);
      } catch {
        continue;
      }
      let title = '';
      try {
        const first = fs.readFileSync(path.join(SESSIONS_DIR, id + '.jsonl'), 'utf8').split('\n').find((l) => l.includes('"k":"user"'));
        if (first) title = String(JSON.parse(first).d || '').slice(0, 80);
      } catch {}
      const branch = currentBranch(cwd) || 'snug/' + id;
      out.push({ id, repo: dir.replace('__', '/'), cwd, branch, base: base || 'main', model: defaultModel, title, createdAt: st.birthtimeMs || st.mtimeMs, updatedAt: st.mtimeMs, auto: false });
    }
  }
  return out;
}

export class SessionManager {
  constructor({ config, secrets, log, notify }) {
    this.config = config;
    this.secrets = secrets;
    this.log = log || (() => {});
    this.notify = notify || (() => {});
    this.sessions = new Map();
    this.busyRepos = new Map(); // folder repo (huruf kecil) -> jumlah sesi yang sedang dibuat
    try {
      this.proxy = startProxy({ log: (m) => this.log(m) });
    } catch (e) {
      this.log('! gagal memulai loopback proxy: ' + e.message);
    }
    this.routeTokens = new Map(); // `${koneksi}|${format}` -> token lokal proxy
    this.bridges = new Map(); // token jembatan MCP (engine Codex) -> sesi
    // Daftar model diambil di latar belakang: pemilihan model ringan subagen membacanya dari cache.
    for (const id of Object.keys(allConnections(secrets))) knownRefs(secrets, id);
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const idx = readSessionIndex({ quarantine: true });
    let index = idx.list;
    if (!idx.ok) {
      index = recoverIndex(config.model);
      console.error(`! sessions/index.json rusak (disimpan sebagai index.json.broken-*); ${index.length} sesi dipulihkan dari worktree.`);
    }
    for (const meta of index) if (meta?.id && meta.cwd && fs.existsSync(meta.cwd)) this.sessions.set(meta.id, new Session(meta, this));
    if (!idx.ok) this.saveIndex();
    // Pindai dan bersihkan folder yatim secara otomatis di latar belakang
    setTimeout(() => this.cleanupOrphans().catch(() => {}), 1500).unref?.();
    this.cleanupTimer = setInterval(() => {
      this.cleanupOrphans().catch(() => {});
      this.unloadIdle();
    }, 30 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  // Dev server & tunnel milik sesi tidak boleh tertinggal saat daemon berhenti (di Windows
  // proses anak tidak ikut mati bersama induknya).
  close() {
    this.proxy?.close();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    return Promise.all([...this.sessions.values()].map((s) => s.close()).concat(closeBrowser()));
  }

  // Riwayat sesi yang lama tidak dibuka dilepas dari memori.
  unloadIdle(now = Date.now()) {
    for (const s of this.sessions.values()) {
      if (s.status === 'idle' && !s.agent && !s.listenerCount('event') && now - (s.meta.updatedAt || 0) > HISTORY_IDLE_MS) s.unload();
    }
  }

  // Batasi jumlah proses claude menganggur: yang paling lama tidak dipakai ditutup lebih dulu.
  trimAgents() {
    const idle = [...this.sessions.values()].filter((s) => s.agent && !s.turn).sort((a, b) => b.agent.lastUsed - a.agent.lastUsed);
    for (const s of idle.slice(MAX_IDLE_AGENTS)) s.closeAgent();
  }

  async cleanupOrphans(opts) {
    if (this.cleaning) return { removedWorktrees: [], removedRepos: [], removedLogs: [] };
    this.cleaning = true;
    try {
      return await cleanupWorkspaces(this.sessions, { ...opts, busy: (dir) => this.busyRepos.has(dir.toLowerCase()) });
    } finally {
      this.cleaning = false;
    }
  }

  // Di Windows claude.exe yang masih jalan mengunci file-nya sehingga npm gagal
  // menimpanya (dan diam-diam melewati paket binary). Tutup semua sesi dulu.
  async stopAll({ wait = 1500 } = {}) {
    const active = [...this.sessions.values()].filter((s) => s.agent || s.shellProc || s.procs.running() || s.tunnel);
    for (const s of active) if (s.turn || s.shellProc || s.procs.running()) s.emitEvent({ k: 'note', d: '◆ dihentikan untuk memasang pembaruan' });
    await Promise.all(active.map((s) => s.close()));
    if (active.length) await new Promise((r) => setTimeout(r, wait));
    return active.length;
  }

  // Token lokal proxy untuk satu koneksi + format. Alamat & key dibaca dari secrets pada setiap
  // request, jadi key yang diganti dari HP langsung berlaku tanpa membuat ulang proses agen.
  tokenFor(conn, wire) {
    const k = `${conn.id}|${wire}`;
    let t = this.routeTokens.get(k);
    if (t) return t;
    if (!this.proxy) throw new Error('Loopback proxy snugcode tidak berjalan.');
    const id = conn.id;
    const cur = () => getConn(this.secrets, id) || conn;
    t = this.proxy.register({
      wire: /** @type {any} */ (wire),
      base: () => (wire === 'gemini' ? geminiRoot(cur()) : wire === 'anthropic' ? cur().anthropic : cur().openai) || '',
      auth: () => authHeaders(cur(), wire === 'anthropic' || wire === 'gemini' ? wire : 'openai'),
      router: !!(conn.router || conn.kind === 'router'),
      kind: conn.kind,
    });
    this.routeTokens.set(k, t);
    return t;
  }

  // Koneksi diubah/dihapus dari HP: token lamanya dicabut, proses agen yang memakainya dibuat ulang
  // pada prompt berikutnya (kuncinya memuat token).
  resetRouter(connId = 'router') {
    for (const [k, t] of this.routeTokens) {
      if (!k.startsWith(connId + '|')) continue;
      this.proxy?.unregister(t);
      this.routeTokens.delete(k);
    }
    if (getConn(this.secrets, connId)) knownRefs(this.secrets, connId);
  }

  // Token jembatan MCP: hanya bisa memanggil tool dev untuk satu sesi (lihat server.js LocalConn).
  bridgeToken(session) {
    for (const [t, s] of this.bridges) if (s === session) return t;
    const t = 'bridge-' + randomBytes(24).toString('hex');
    this.bridges.set(t, session);
    return t;
  }
  bridgeSession(token) {
    return typeof token === 'string' ? this.bridges.get(token) || null : null;
  }

  // Ada pekerjaan yang berjalan (agen, `!perintah`, dev server, atau tunnel preview)?
  busy() {
    return [...this.sessions.values()].some((s) => s.status === 'running' || s.shellProc || s.procs.running() || s.tunnel);
  }

  // Atomik: gagal menulis (mis. disk penuh) membiarkan index lama tetap utuh, tidak memutus alur agen.
  saveIndex() {
    try {
      writeJson(SESSION_INDEX, [...this.sessions.values()].map((s) => s.meta), 0o644);
    } catch (e) {
      console.error('! gagal menyimpan daftar sesi: ' + e.message);
    }
  }

  list() {
    return [...this.sessions.values()].map((s) => s.summary()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Sesi tidak ditemukan');
    return s;
  }

  async create({ repo, base, branch, model, local, computer, cwd, type }) {
    if (computer || repo === '__computer__' || type === 'computer') {
      const id = randomBytes(4).toString('hex');
      const targetCwd = path.resolve(cwd || os.homedir());
      const meta = {
        id,
        repo: 'Komputer',
        cwd: targetCwd,
        branch: os.hostname() || 'pc',
        base: '-',
        computer: true,
        model: model || this.config.model,
        title: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        auto: false,
      };
      const s = new Session(meta, this);
      this.sessions.set(id, s);
      this.saveIndex();
      return s;
    }
    if (local) {
      // Folder lokal dari terminal: pakai ulang sesi yang sudah ada untuk folder yang sama.
      const info = await inspectLocalRepo(local);
      const existing = [...this.sessions.values()].find((s) => s.meta.local && path.resolve(s.meta.cwd).toLowerCase() === info.cwd.toLowerCase());
      if (existing) return existing;
      const id = randomBytes(4).toString('hex');
      const meta = { id, repo: info.repo, cwd: info.cwd, branch: info.branch, base: info.base, local: true, model: model || this.config.model, title: '', createdAt: Date.now(), updatedAt: Date.now(), auto: false };
      const s = new Session(meta, this);
      this.sessions.set(id, s);
      this.saveIndex();
      return s;
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Format repo harus owner/nama');
    const id = randomBytes(4).toString('hex');
    branch = (branch || '').trim() || 'snug/' + id;
    // Selama clone/worktree disiapkan, pembersih tidak boleh menyentuh repo ini.
    const busyKey = repoDirName(repo).toLowerCase();
    this.busyRepos.set(busyKey, (this.busyRepos.get(busyKey) || 0) + 1);
    let s;
    try {
      const wt = await prepareWorktree(this.secrets.githubToken, repo, { base: base || undefined, branch, sessionId: id });
      const meta = { id, repo, ...wt, model: model || this.config.model, title: '', createdAt: Date.now(), updatedAt: Date.now(), auto: false };
      s = new Session(meta, this);
      this.sessions.set(id, s);
      this.saveIndex();
    } finally {
      const n = this.busyRepos.get(busyKey) - 1;
      if (n > 0) this.busyRepos.set(busyKey, n);
      else this.busyRepos.delete(busyKey);
    }
    // Template .env repo (disimpan dari sesi sebelumnya) agar dev server langsung bisa jalan.
    const env = restoreEnv(repo, s.meta.cwd);
    if (env.length) s.emitEvent({ k: 'note', d: `◆ env dipulihkan: ${env.join(', ')}` });
    return s;
  }

  async remove(id) {
    const s = this.get(id);
    await s.close();
    for (const [t, x] of this.bridges) if (x === s) this.bridges.delete(t);
    await new Promise((r) => setTimeout(r, 150)); // claude.exe melepas file worktree
    this.sessions.delete(id);
    this.saveIndex();
    try {
      safeRm(s.logFile);
    } catch {}
    // Folder lokal milik pengguna tidak pernah dihapus; hanya riwayat sesinya.
    if (!s.meta.local && !s.meta.computer) {
      await removeWorktree(s.meta.cwd).catch(() => {});
    }
    // Bersihkan worktree / log yatim (clone dasar repo disimpan beberapa hari untuk sesi berikutnya)
    await this.cleanupOrphans({ minAgeMs: 0 }).catch(() => {});
  }
}
