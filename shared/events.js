// Agent session event model shared by the daemon (producer), the PWA, and the TUI (viewers).
//
// The daemon sends compact events, not raw Agent SDK messages. There are three groups:
//   - history  : has a `seq`, stored in sessions/<id>.jsonl, replayed on attach
//   - transient: has a `seq` but isn't stored (status, thinking, toolStart)
//   - live     : no `seq`, only sent to currently connected clients (LIVE_KINDS)

/**
 * @typedef {'todo' | 'doing' | 'done'} TodoState
 * @typedef {{ st: TodoState, t: string }} TodoItem
 *
 * @typedef {object} AgentEvent
 * @property {string} k    event kind: user | text | thinking | toolStart | tool | result | perm | permAnswer
 *                         | retry | done | sh | out | shDone | note | error | status | cp | mode | proc | procOut
 *                         | preview | shot
 * @property {number} [seq] per-session sequence number (absent on live events)
 * @property {number} [ts]  creation time (ms)
 * @property {string} [d]   text (user/text/out/note/error/sh/result)
 * @property {string} [s]   tool input summary, or the session status ('running' | 'idle') for k='status'
 * @property {string} [name] tool name (without the mcp__snugcode__ prefix) / process name
 * @property {string} [id]  id tool_use (tool/result)
 * @property {boolean} [ok] tool / prompt succeeded
 * @property {TodoItem[]} [todos] plan list (k='tool', name='TodoWrite'); old daemons only send `s`
 * @property {number} [words] thinking word count
 * @property {number} [turns] number of steps (k='done')
 * @property {number} [ms]  duration (k='done')
 * @property {{ in: number, out: number, cr?: number, cw?: number }} [usage] token (k='done'); `in` includes cache,
 *                         cr = read from the prompt cache, cw = written to the cache (old daemons don't send it)
 * @property {number} [ctx]  context usage in percent (k='done')
 * @property {number} [cost] USD cost of this turn (k='done')
 * @property {number} [spent] total USD cost of the session so far (k='done')
 * @property {string} [err]  stop reason (k='done')
 * @property {*} [x]     extra detail (e.g. an Edit/Write diff snippet)
 */

// Events with no seq that are never stored in history.
export const LIVE_KINDS = new Set(['perm', 'mode', 'proc', 'procOut', 'preview', 'shot']);

// ---------- plan (TodoWrite) ----------
export const TODO_GLYPH = { done: '☑', doing: '◐', todo: '☐' };
const GLYPH_STATE = { '☑': 'done', '◐': 'doing', '☐': 'todo' };

/** From the Agent SDK's TodoWrite input (`{ content, status }[]`). @returns {TodoItem[]} */
export function todosFromInput(todos) {
  return (Array.isArray(todos) ? todos : []).map((t) => ({ st: t?.status === 'completed' ? 'done' : t?.status === 'in_progress' ? 'doing' : 'todo', t: String(t?.content ?? '') }));
}

/** Compact glyph text (used as `s`, also for old clients). @param {TodoItem[]} items */
export const todoText = (items) => items.map((i) => `${TODO_GLYPH[i.st]} ${i.t}`).join('\n');

/** Plan list from a TodoWrite tool event: the `todos` field (new daemons) or parsing `s` (old daemons). @param {AgentEvent} e @returns {TodoItem[]} */
export function todoItems(e) {
  if (Array.isArray(e?.todos)) return e.todos;
  return String(e?.s || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ st: GLYPH_STATE[l[0]] || 'todo', t: GLYPH_STATE[l[0]] ? l.slice(2) : l }));
}

// ---------- activity ("what it's doing") ----------
export const TOOL_ACTIVITY = {
  Bash: 'Running',
  dev_start: 'Starting',
  dev_stop: 'Stopping',
  dev_logs: 'Reading logs',
  dev_list: 'Listing processes',
  preview_screenshot: 'Viewing page',
  Read: 'Reading',
  NotebookRead: 'Reading',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  NotebookEdit: 'Editing',
  Write: 'Writing',
  Grep: 'Searching',
  Glob: 'Searching',
  LS: 'Listing',
  WebFetch: 'Opening',
  WebSearch: 'Searching the web',
  Task: 'Subagent',
  Agent: 'Subagent',
  TodoWrite: 'Planning',
  AskUserQuestion: 'Asking',
  ExitPlanMode: 'Drafting a plan',
};

/** Activity sentence for a tool event, e.g. "Running npm test" or the plan step in progress. @param {AgentEvent} e */
export function toolActivity(e) {
  if (e.name === 'TodoWrite') {
    const doing = todoItems(e).find((i) => i.st === 'doing');
    return doing ? doing.t : TOOL_ACTIVITY.TodoWrite;
  }
  const first = String(e.s || '').split('\n')[0];
  return `${TOOL_ACTIVITY[e.name] || e.name} ${first}`.trim();
}

// ---------- numbers ----------
export const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
export const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? (ms < 10_000 ? (ms / 1000).toFixed(1) : s) + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
};

/** Pieces of the prompt-finished summary: ["3 steps", "4.2s", "12k→800 tok", "context 40%", "$0.012"]. @param {AgentEvent} e */
export function doneParts(e) {
  const out = [`${e.turns ?? 0} ${e.turns === 1 ? 'step' : 'steps'}`, fmtDuration(e.ms || 0)];
  if (e.usage) out.push(`${fmtTok(e.usage.in)}→${fmtTok(e.usage.out)} tok`);
  // Share of input read from the prompt cache (cheap & fast). A constant 0% = the router doesn't cache.
  const pct = cachePct(e.usage);
  if (pct != null) out.push(`cache ${pct}%`);
  if (e.ctx != null) out.push(`context ${e.ctx}%`);
  if (e.cost) out.push(`$${e.cost.toFixed(e.cost < 1 ? 3 : 2)}`);
  if (e.spent && e.spent !== e.cost) out.push(`session $${e.spent.toFixed(e.spent < 1 ? 3 : 2)}`);
  return out;
}

/** @param {AgentEvent['usage']} u @returns {number | null} */
export function cachePct(u) {
  if (!u || typeof u.cr !== 'number' || !u.in) return null;
  return Math.round((u.cr / u.in) * 100);
}

// Streaming text chunks (one event per ~80ms) are merged before history is sent on attach:
// thousands of small events become a few whole ones (much lighter payload & rendering on the phone).
// Safe for the seq filter: a merged event uses the seq of its last chunk, and all its chunks
// are in a range that's equally new to the client.
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

// ---------- event order ----------
// Events with a seq already received (e.g. from an attach after reconnect, or a frame
// sent twice) are ignored. Live events (no seq) are always accepted.
export class EventCursor {
  constructor(lastSeq = 0) {
    this.lastSeq = lastSeq;
  }
  /** @param {AgentEvent} e @returns {boolean} true if the event is new */
  accept(e) {
    if (!e.seq) return true;
    if (e.seq <= this.lastSeq) return false;
    this.lastSeq = e.seq;
    return true;
  }
}
