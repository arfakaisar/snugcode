// Model event sesi agen yang dipakai bersama daemon (pembuat), PWA, dan TUI (penampil).
//
// Daemon mengirim event ringkas, bukan pesan mentah Agent SDK. Ada tiga golongan:
//   - riwayat  : punya `seq`, disimpan di sessions/<id>.jsonl, diputar ulang saat attach
//   - sesaat   : punya `seq` tapi tidak disimpan (status, thinking, toolStart)
//   - langsung : tanpa `seq`, hanya ke klien yang sedang terhubung (LIVE_KINDS)

/**
 * @typedef {'todo' | 'doing' | 'done'} TodoState
 * @typedef {{ st: TodoState, t: string }} TodoItem
 *
 * @typedef {object} AgentEvent
 * @property {string} k    jenis event: user | text | thinking | toolStart | tool | result | perm | permAnswer
 *                         | retry | done | sh | out | shDone | note | error | status | cp | mode | proc | procOut
 *                         | preview | shot
 * @property {number} [seq] nomor urut per sesi (tidak ada pada event langsung)
 * @property {number} [ts]  waktu dibuat (ms)
 * @property {string} [d]   teks (user/text/out/note/error/sh/result)
 * @property {string} [s]   ringkasan input tool, atau status sesi ('running' | 'idle') untuk k='status'
 * @property {string} [name] nama tool (tanpa prefiks mcp__pocketcode__) / nama proses
 * @property {string} [id]  id tool_use (tool/result)
 * @property {boolean} [ok] hasil tool / prompt berhasil
 * @property {TodoItem[]} [todos] daftar rencana (k='tool', name='TodoWrite'); daemon lama hanya mengirim `s`
 * @property {number} [words] jumlah kata thinking
 * @property {number} [turns] jumlah langkah (k='done')
 * @property {number} [ms]  durasi (k='done')
 * @property {{ in: number, out: number, cr?: number, cw?: number }} [usage] token (k='done'); `in` termasuk cache,
 *                         cr = dibaca dari prompt cache, cw = ditulis ke cache (daemon lama tidak mengirimnya)
 * @property {number} [ctx]  isi konteks dalam persen (k='done')
 * @property {number} [cost] biaya USD (k='done')
 * @property {string} [err]  alasan berhenti (k='done')
 * @property {*} [x]     detail tambahan (mis. cuplikan diff Edit/Write)
 */

// Event yang tidak punya seq dan tidak pernah disimpan di riwayat.
export const LIVE_KINDS = new Set(['perm', 'mode', 'proc', 'procOut', 'preview', 'shot']);

// ---------- rencana (TodoWrite) ----------
export const TODO_GLYPH = { done: '☑', doing: '◐', todo: '☐' };
const GLYPH_STATE = { '☑': 'done', '◐': 'doing', '☐': 'todo' };

/** Dari input TodoWrite Agent SDK (`{ content, status }[]`). @returns {TodoItem[]} */
export function todosFromInput(todos) {
  return (Array.isArray(todos) ? todos : []).map((t) => ({ st: t?.status === 'completed' ? 'done' : t?.status === 'in_progress' ? 'doing' : 'todo', t: String(t?.content ?? '') }));
}

/** Teks ringkas berglyph (dipakai sebagai `s`, juga untuk klien lama). @param {TodoItem[]} items */
export const todoText = (items) => items.map((i) => `${TODO_GLYPH[i.st]} ${i.t}`).join('\n');

/** Daftar rencana dari event tool TodoWrite: field `todos` (daemon baru) atau parse `s` (daemon lama). @param {AgentEvent} e @returns {TodoItem[]} */
export function todoItems(e) {
  if (Array.isArray(e?.todos)) return e.todos;
  return String(e?.s || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ st: GLYPH_STATE[l[0]] || 'todo', t: GLYPH_STATE[l[0]] ? l.slice(2) : l }));
}

// ---------- aktivitas ("sedang apa") ----------
export const TOOL_ACTIVITY = {
  Bash: 'Menjalankan',
  dev_start: 'Menyalakan',
  dev_stop: 'Menghentikan',
  dev_logs: 'Membaca log',
  dev_list: 'Melihat proses',
  preview_screenshot: 'Melihat halaman',
  Read: 'Membaca',
  NotebookRead: 'Membaca',
  Edit: 'Mengedit',
  MultiEdit: 'Mengedit',
  NotebookEdit: 'Mengedit',
  Write: 'Menulis',
  Grep: 'Mencari',
  Glob: 'Mencari',
  LS: 'Melihat',
  WebFetch: 'Membuka',
  WebSearch: 'Mencari di web',
  Task: 'Subagen',
  Agent: 'Subagen',
  TodoWrite: 'Merencanakan',
  AskUserQuestion: 'Bertanya',
  ExitPlanMode: 'Menyusun rencana',
};

/** Kalimat aktivitas untuk event tool, mis. "Menjalankan npm test" atau langkah rencana yang sedang dikerjakan. @param {AgentEvent} e */
export function toolActivity(e) {
  if (e.name === 'TodoWrite') {
    const doing = todoItems(e).find((i) => i.st === 'doing');
    return doing ? doing.t : TOOL_ACTIVITY.TodoWrite;
  }
  const first = String(e.s || '').split('\n')[0];
  return `${TOOL_ACTIVITY[e.name] || e.name} ${first}`.trim();
}

// ---------- angka ----------
export const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
export const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? (ms < 10_000 ? (ms / 1000).toFixed(1) : s) + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
};

/** Potongan ringkasan prompt selesai: ["3 langkah", "4.2s", "12k→800 tok", "konteks 40%", "$0.012"]. @param {AgentEvent} e */
export function doneParts(e) {
  const out = [`${e.turns ?? 0} langkah`, fmtDuration(e.ms || 0)];
  if (e.usage) out.push(`${fmtTok(e.usage.in)}→${fmtTok(e.usage.out)} tok`);
  // Porsi input yang dibaca dari prompt cache (murah & cepat). 0% terus-menerus = router tidak meng-cache.
  const pct = cachePct(e.usage);
  if (pct != null) out.push(`cache ${pct}%`);
  if (e.ctx != null) out.push(`konteks ${e.ctx}%`);
  if (e.cost) out.push(`$${e.cost.toFixed(e.cost < 1 ? 3 : 2)}`);
  return out;
}

/** @param {AgentEvent['usage']} u @returns {number | null} */
export function cachePct(u) {
  if (!u || typeof u.cr !== 'number' || !u.in) return null;
  return Math.round((u.cr / u.in) * 100);
}

// Potongan teks streaming (satu event per ~80ms) digabung sebelum riwayat dikirim saat attach:
// ribuan event kecil jadi beberapa event utuh (payload & render di HP jauh lebih ringan).
// Aman untuk penyaring seq: event gabungan memakai seq potongan terakhir, dan semua potongannya
// berada di rentang yang sama-sama baru bagi klien.
/** @param {AgentEvent[]} events @returns {AgentEvent[]} */
export function mergeText(events) {
  const out = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (e.k === 'text' && prev?.k === 'text') out[out.length - 1] = { ...prev, d: prev.d + e.d, seq: e.seq, ts: e.ts };
    else out.push(e);
  }
  return out;
}

// ---------- urutan event ----------
// Event dengan seq yang sudah pernah diterima (mis. dari attach setelah reconnect, atau frame
// yang terkirim dua kali) diabaikan. Event langsung (tanpa seq) selalu diterima.
export class EventCursor {
  constructor(lastSeq = 0) {
    this.lastSeq = lastSeq;
  }
  /** @param {AgentEvent} e @returns {boolean} true bila event baru */
  accept(e) {
    if (!e.seq) return true;
    if (e.seq <= this.lastSeq) return false;
    this.lastSeq = e.seq;
    return true;
  }
}
