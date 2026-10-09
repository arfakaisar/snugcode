// Subagen bawaan Claude Code didefinisikan ulang agar effort-nya rendah. Modelnya selalu model
// ringan sesi (Claude Haiku 5.5 / Gemini 3.8 Flash, lihat lightModel di shared/models.js) lewat
// CLAUDE_CODE_SUBAGENT_MODEL(+_FORCE); tanpa definisi ini subagen mewarisi effort model utama
// (mis. high), jadi model kecil pun berpikir panjang.
// Nama sama dengan subagen bawaan (Explore, general-purpose, Plan, claude) sehingga
// menimpanya, bukan menambah daftar agen yang dikirim ke model di setiap request.

const REPORT = 'Finish with one concise final message: the answer first, then the relevant absolute file paths (with line numbers when useful). Quote code only when the exact text matters. Never write report or summary files.';

const READ_ONLY = 'READ-ONLY task: never create, modify, move or delete files, never use redirects or heredocs to write files, and never run commands that change state (installs, git add/commit, builds that write output). Bash is only for read-only commands such as ls, git log, git diff, git show.';

const SEARCH_TIPS = 'Use Glob to find files by pattern, Grep to search contents, Read (with offset/limit for large files) when you know the path. Send independent searches and reads together in one message so they run in parallel. Stop as soon as you can answer.';

const GENERAL = {
  description: 'General-purpose agent on a fast model for open-ended, multi-step research: questions that need many searches and reads, or a self-contained side task. Can run commands and edit files when the task explicitly asks for it.',
  prompt: `You are a subagent of snugcode's coding agent. Complete the delegated task fully and efficiently. ${SEARCH_TIPS} Only edit files or run state-changing commands when the task explicitly asks for it. ${REPORT}`,
  tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
  effort: /** @type {const} */ ('medium'),
};

/** @returns {Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>} */
export function subagents() {
  return {
    Explore: {
      description: 'Fast read-only codebase search on a cheap model. Use for broad searches across many files or directories when you only need the conclusion (where something is defined or used, how a flow works), not the file contents. State the thoroughness: "quick", "medium" or "very thorough".',
      prompt: `You are a fast file-search subagent. ${READ_ONLY} ${SEARCH_TIPS} Match the thoroughness the caller asked for. ${REPORT}`,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      effort: 'low',
    },
    Plan: {
      description: 'Read-only software architect on a fast model: investigates the code and returns a step-by-step implementation plan with the critical files and trade-offs.',
      prompt: `You are a planning subagent. ${READ_ONLY} ${SEARCH_TIPS} Return a concrete, numbered implementation plan: files to change and how, risks, and how to verify. ${REPORT}`,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      effort: 'medium',
    },
    'general-purpose': GENERAL,
    // Dipakai Claude Code bila subagent_type kosong; deskripsi pendek agar tidak menggandakan teks
    // general-purpose di daftar agen yang ikut setiap request.
    claude: { ...GENERAL, description: 'Same as general-purpose (used when no type is given).' },
  };
}
