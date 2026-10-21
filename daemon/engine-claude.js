// Claude Agent SDK engine: Claude models and Anthropic / OpenAI Chat format endpoints (via the translator
// in the loopback proxy). One `claude` process per session, reused across prompts (streaming input).
// Permissions (canUseTool), checkpoints (PreToolUse hook), and events stay with Session (sessions.js).
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR } from './config.js';
import { resolveModelEffort, lightModel, parseModelId, nativeEffortModel } from '../shared/models.js';
import { splitRef, isClaudeId } from '../shared/providers.js';
import { knownRefs } from './providers.js';
import { subagents } from './agents.js';
import { findNativeBinary, missingBinaryMessage } from './nativebin.js';
import { snugcodePrompt, projectInstructions } from './prompt.js';
import { PLANS_DIR, isSensitivePath } from './permissions.js';
import { sandboxMode, sandboxSupport, sandboxOptions, excludeSandboxStubs } from './sandbox.js';
import { toolchainEnv } from './toolchain.js';
import { devToolsServer, DEV_START } from './devtools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Built-in tools offered to the model (snugcode MCP tools are added automatically). Without this list
// Claude Code sends ~27 tools (Cron*, ScheduleWakeup, SendMessage, Workflow, EnterWorktree, …)
// that snugcode doesn't use: ~40 KB of schemas (≈10k tokens) on EVERY model request.
// Grep/Glob must be listed: the native build replaces them with Bash grep/find (unbounded output).
export const AGENT_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'AskUserQuestion', 'ExitPlanMode', 'WebFetch', 'WebSearch'];
// Tools that can change files: only allowed to run after the prompt checkpoint is saved (PreToolUse hook),
// including those that pass without canUseTool via "Always" rules (e.g. Bash(npm test *)).
const MUTATING_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit|' + DEV_START;

// Every agent step = one model request (1–10 seconds through a router), so the number of steps
// determines speed. Non-Claude models (Gemini) read files 40–120 lines per step and
// search for file names first, then search their contents again: 4–9× more requests for the same
// task. This hook widens partial Reads to the whole file (if it fits in one read) and
// Grep without output_mode to matching lines + line numbers. Permissions still go through canUseTool.
const WIDEN_MATCHER = 'Read|Grep';
const WIDEN_MAX_BYTES = 64 * 1024; // ~16k tokens: well below Claude Code's Read token limit
const WIDEN_MAX_LINES = 2000; // Read's default line limit without a limit
const GREP_HEAD_LIMIT = 100;
const NO_WIDEN_EXT = /\.(pdf|ipynb|png|jpe?g|gif|webp|bmp|ico|svg)$/i;
// Claude models: cc/…, claude-… without a provider, or claude-… via another provider (ag/claude-sonnet-4-6).
export const isClaudeModel = (id) => {
  const p = parseModelId(id || '');
  return (p.conn === 'router' && nativeEffortModel(p.provider, p.base)) || isClaudeId(p.base);
};

/** The widened tool input, or null to leave it as-is. */
export function widenToolInput(tool, input, cwd) {
  if (!input || typeof input !== 'object') return null;
  if (tool === 'Read') {
    if (input.offset == null && input.limit == null) return null;
    if (typeof input.file_path !== 'string' || NO_WIDEN_EXT.test(input.file_path)) return null;
    const file = path.resolve(cwd, input.file_path);
    if (isSensitivePath(file)) return null;
    let buf;
    try {
      if (fs.statSync(file).size > WIDEN_MAX_BYTES) return null;
      buf = fs.readFileSync(file);
    } catch {
      return null;
    }
    if (buf.includes(0)) return null; // binary
    let lines = 1;
    for (const b of buf) if (b === 10 && ++lines > WIDEN_MAX_LINES) return null;
    const { offset, limit, ...rest } = input;
    return rest;
  }
  if (tool === 'Grep' && !input.output_mode) {
    return { ...input, output_mode: 'content', '-n': true, head_limit: input.head_limit ?? GREP_HEAD_LIMIT };
  }
  return null;
}

// Claude binary path for query(): `claudeExecutable` in config.json (manual fallback)
// or the binary from the SDK's platform package. Fails early with a clear message.
function claudeExecutable(cfg) {
  if (cfg.claudeExecutable) {
    if (!fs.existsSync(cfg.claudeExecutable)) throw new Error(`claudeExecutable in config.json not found: ${cfg.claudeExecutable}`);
    return cfg.claudeExecutable;
  }
  if (!findNativeBinary(import.meta.url)) throw new Error(missingBinaryMessage(ROOT));
  return undefined;
}

// User message queue for query() in streaming input mode: one claude process per session
// receives prompt after prompt through this iterator.
function inputQueue() {
  const items = [];
  let wake = null;
  let done = false;
  const poke = () => {
    wake?.();
    wake = null;
  };
  return {
    push(m) {
      items.push(m);
      poke();
    },
    end() {
      done = true;
      poke();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (done) return;
        await new Promise((r) => (wake = r));
      }
    },
  };
}

export async function startClaudeAgent(s, route) {
  const cfg = s.mgr.config;
  const sec = s.mgr.secrets;
  const claudeExe = claudeExecutable(cfg);
  const actualModel = route.model;
  const effort = /** @type {import('@anthropic-ai/claude-agent-sdk').EffortLevel | null} */ (route.effort);
  // Subagents & utility tasks: a light model from the same connection (Haiku / Flash, see lightModel).
  const light = lightModel(s.meta.model, knownRefs(sec, route.conn.id));
  const lightId = splitRef(resolveModelEffort(light.id).actualModel).id;
  const proxy = s.mgr.proxy;
  const baseUrl = proxy ? await proxy.ready().catch(() => null) : null;
  if (!baseUrl) throw new Error('The snugcode loopback proxy is not running. Restart the daemon (`snugcode restart`).');
  // The claude process only holds a local token for this connection; the real key is injected by the proxy.
  const authToken = s.mgr.tokenFor(route.conn, route.wire);
  // OS sandbox for Bash when commands pass without the user seeing them (auto-approve), or always if configured.
  const mode = sandboxMode(cfg);
  const support = mode === 'off' ? { ok: false } : await sandboxSupport();
  const sandboxed = support.ok && (mode === 'always' || !!s.meta.auto);
  if (s.meta.auto && mode !== 'off' && !support.ok && !s.mgr.warnedClaudeSandbox) {
    s.mgr.warnedClaudeSandbox = true;
    s.emitEvent({ k: 'note', d: `◆ OS sandbox unavailable (${support.reason}): auto-approved commands run without a sandbox, so credentials in the snugcode data folder aren't protected at the OS level.` });
  }
  const key = ['claude', claudeExe, lightId, baseUrl, authToken, sandboxed].join('|');
  if (sandboxed && !s.meta.local && !s.meta.computer) excludeSandboxStubs(s.meta.cwd);
  const cur = s.agent;
  if (cur && !cur.dead && cur.key === key) {
    clearTimeout(cur.idle);
    cur.idle = null;
    try {
      if (cur.model !== actualModel) await cur.q.setModel(actualModel);
      cur.model = actualModel;
      // null = the model's default effort ("auto").
      if (cur.effort !== effort) await cur.q.applyFlagSettings({ effortLevel: effort });
      cur.effort = effort;
      return cur;
    } catch (e) {
      s.mgr.log('! switching model in the running process failed, recreating the process: ' + e.message);
    }
  }
  s.closeAgent();

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_EFFORT_LEVEL|CLAUDE_CODE_SUBAGENT_MODEL|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)/.test(k)) delete env[k];
  Object.assign(env, {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_DEFAULT_OPUS_MODEL: actualModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: actualModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: lightId,
    // _FORCE: without it the built-in subagents (Explore, …) still use the main model.
    CLAUDE_CODE_SUBAGENT_MODEL: lightId,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CONFIG_DIR: CLAUDE_DIR,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Long processes go through dev_start; background Bash/Agent only add schemas & stray turns.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    // Bash output (npm install/test, build) entering the context is capped; Claude Code's default is 30k characters.
    BASH_MAX_OUTPUT_LENGTH: process.env.BASH_MAX_OUTPUT_LENGTH || '15000',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'snugcode/0.1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  });
  // pnpm/yarn stay available to the agent's Bash even without a global install (once the shims are prepared).
  Object.assign(env, await toolchainEnv('', env));

  const input = inputQueue();
  const q = query({
    prompt: input,
    options: {
      cwd: s.meta.cwd,
      env,
      ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
      model: actualModel,
      ...(effort ? { effort } : {}),
      resume: s.meta.claudeSessionId || undefined,
      includePartialMessages: true,
      // 'default': Write/Edit also go through canUseTool (checkpoint, edit review mode, data folder);
      // auto-approve & "Always" still let them through without asking.
      // Plan mode is only set from the phone/terminal, so the agent may not enter it on its own.
      permissionMode: s.meta.plan ? 'plan' : 'default',
      // Project settings (.claude/settings.json) are NOT loaded: their contents (hooks, permission rules, env,
      // apiKeyHelper) can be written by anyone with the repo. CLAUDE.md is loaded by us (projectInstructions).
      settingSources: [],
      ...(sandboxed ? { sandbox: sandboxOptions({ cwd: s.meta.cwd, computer: !!s.meta.computer }) } : {}),
      settings: { plansDirectory: PLANS_DIR, ...(s.allowRules.size ? { permissions: { allow: [...s.allowRules] } } : {}) },
      tools: AGENT_TOOLS,
      disallowedTools: ['EnterPlanMode'],
      agents: subagents(),
      mcpServers: { snugcode: devToolsServer(s) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: snugcodePrompt({ computer: !!s.meta.computer, project: projectInstructions(s.meta.cwd) }) },
      canUseTool: (tool, toolInput, opts) => s.askPermission(tool, toolInput, opts),
      hooks: {
        PreToolUse: [
          { matcher: MUTATING_MATCHER, hooks: [(h) => s.beforeTool(h)] },
          { matcher: WIDEN_MATCHER, hooks: [async (h) => s.widenTool(h)] },
        ],
      },
      stderr: (d) => s.mgr.log('[claude] ' + d.trim()),
    },
  });
  const agent = {
    kind: 'claude',
    key,
    q,
    // Auto-approve was turned on while this process runs without a sandbox: Bash keeps asking until the next prompt.
    unsandboxedAuto: support.ok && !sandboxed,
    input,
    model: actualModel,
    effort,
    streamed: new Set(),
    currentMsgId: null,
    dead: false,
    idle: null,
    lastUsed: Date.now(),
    loop: /** @type {Promise<void> | null} */ (null),
    // Images are sent as content blocks of the user message.
    push({ text, images = [] }) {
      const content = images.length ? [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), ...(text ? [{ type: 'text', text }] : [])] : text;
      input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    },
    interrupt: () => q.interrupt(),
    setPlan: (on) => q.setPermissionMode(on ? 'plan' : 'default').catch(() => {}),
    close() {
      input.end();
      try {
        q.close();
      } catch {}
    },
  };
  s.agent = agent;
  agent.loop = s.consume(agent);
  return agent;
}
