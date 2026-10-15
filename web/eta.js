// Perhitungan progress & perkiraan waktu (tanpa DOM, diuji di unit test). Dipakai web/ui/progress.js.
export const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const fmtLeft = (s) => (s < 50 ? `±${Math.max(5, Math.round(s / 5) * 5)} dtk lagi` : `±${Math.max(1, Math.round(s / 60))} mnt lagi`);

// Fraksi tahap yang sudah lewat berdasarkan waktu: linear sampai 90% di perkiraan, lalu mendekati 99%,
// jadi bar tidak pernah penuh sebelum tahapnya benar-benar selesai.
export function stepFraction(t, est) {
  if (t <= est) return (0.9 * t) / est;
  return 0.9 + 0.09 * (1 - Math.exp(-(t - est) / est));
}

/** Persen keseluruhan (0–99) saat berada di tahap ke-`cur` selama `inStep` detik. */
export function overall(ests, cur, inStep) {
  const total = ests.reduce((a, b) => a + b, 0);
  const before = ests.slice(0, cur).reduce((a, b) => a + b, 0);
  return Math.min(99, (100 * (before + stepFraction(inStep, ests[cur]) * ests[cur])) / total);
}

/** Perkiraan sisa detik: sisa tahap ini + tahap berikutnya. */
export function remaining(ests, cur, inStep) {
  return Math.max(0, ests[cur] - inStep) + ests.slice(cur + 1).reduce((a, b) => a + b, 0);
}

// Durasi yang dipelajari: rata-rata bergerak dari durasi nyata (bobot 50%).
export function learn(prev, took) {
  const next = { ...prev };
  for (const [id, s] of Object.entries(took)) next[id] = Math.round(prev[id] != null ? prev[id] * 0.5 + s * 0.5 : s);
  return next;
}
