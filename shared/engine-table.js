// Default engine per connection type + model pattern, on top of the format rules in engineFor (shared/providers.js).
// Filled from benchmark results (`npm run bench`, scripts/bench.mjs): the same tasks run on each
// engine for one model, and the engine with the highest pass rate (ties: faster, cheaper) is
// picked. Rows without bench results use the design rationale ("the model maker's official harness").
// Can be overridden per machine with env SNUGCODE_ENGINE=claude (force the Claude Agent SDK).
/** @type {{ kind: string, model: string, engine: 'claude' | 'codex' | 'gemini', why: string }[]} */
export const ENGINE_TABLE = [
  // Gemini CLI = Google's official harness for Gemini (native API format, no translator). Needs a Google AI
  // API key (`gemini` connection); routers that only speak OpenAI/Anthropic format still go through the Claude Agent SDK.
  { kind: 'gemini', model: '^gemini-', engine: 'gemini', why: 'Google\'s official harness' },
];
