// Engine bawaan per jenis koneksi + pola model, di atas aturan format di engineFor (shared/providers.js).
// Diisi dari hasil benchmark (`npm run bench`, scripts/bench.mjs): tugas yang sama dijalankan di tiap
// engine untuk satu model, lalu engine dengan tingkat lulus tertinggi (seri: lebih cepat, lebih hemat)
// dipilih. Baris tanpa hasil bench memakai alasan desain ("harness resmi pembuat model").
// Bisa ditimpa per mesin dengan env SNUGCODE_ENGINE=claude (paksa Claude Agent SDK).
/** @type {{ kind: string, model: string, engine: 'claude' | 'codex' | 'gemini', why: string }[]} */
export const ENGINE_TABLE = [
  // Gemini CLI = harness resmi Google untuk Gemini (format API asli, tanpa penerjemah). Butuh API key
  // Google AI (koneksi `gemini`); router yang hanya melayani format OpenAI/Anthropic tetap lewat Claude Agent SDK.
  { kind: 'gemini', model: '^gemini-', engine: 'gemini', why: 'harness resmi Google' },
];
