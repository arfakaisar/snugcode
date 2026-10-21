// Progress & time estimates (no DOM, unit tested). Used by web/ui/progress.js.
export const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const fmtLeft = (s) => (s < 50 ? `~${Math.max(5, Math.round(s / 5) * 5)} s left` : `~${Math.max(1, Math.round(s / 60))} min left`);

// Fraction of a step elapsed, by time: linear up to 90% at the estimate, then approaching 99%,
// so the bar never fills before the step actually finishes.
export function stepFraction(t, est) {
  if (t <= est) return (0.9 * t) / est;
  return 0.9 + 0.09 * (1 - Math.exp(-(t - est) / est));
}

/** Overall percent (0–99) while in step `cur` for `inStep` seconds. */
export function overall(ests, cur, inStep) {
  const total = ests.reduce((a, b) => a + b, 0);
  const before = ests.slice(0, cur).reduce((a, b) => a + b, 0);
  return Math.min(99, (100 * (before + stepFraction(inStep, ests[cur]) * ests[cur])) / total);
}

/** Estimated seconds left: the rest of this step + the following steps. */
export function remaining(ests, cur, inStep) {
  return Math.max(0, ests[cur] - inStep) + ests.slice(cur + 1).reduce((a, b) => a + b, 0);
}

// Learned durations: moving average of real durations (50% weight).
export function learn(prev, took) {
  const next = { ...prev };
  for (const [id, s] of Object.entries(took)) next[id] = Math.round(prev[id] != null ? prev[id] * 0.5 + s * 0.5 : s);
  return next;
}
