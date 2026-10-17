# Analisis: harness agen & koneksi model (snugcode "all-in-one")

> Tujuan akhir: pengguna membuka aplikasi, menyambungkan GitHub dan akun/model mereka sendiri (tanpa menyiapkan
> 9router dulu), lalu snugcode otomatis memakai harness terbaik untuk model itu. Dokumen ini merangkum analisis
> (Oktober 2026), keputusan desain, dan status implementasinya.

---

## Status implementasi (2026-10-17)

| Bagian | File | Status |
|---|---|---|
| Koneksi model: API key apa pun, deteksi jenis key & format endpoint | `shared/providers.js`, `daemon/providers.js` | ✓ unit (fetch tiruan) & e2e |
| Login ChatGPT (device code, dari HP/terminal) lewat Codex resmi | `daemon/codex.js`, RPC `chatgptLogin` | ✓ unit (app-server tiruan); login asli butuh akun |
| Engine per model: Claude Agent SDK / Codex | `daemon/sessions.js` (`startAgent`, `startCodexAgent`, `decideCodex`) | ✓ e2e dengan Codex 0.163 asli |
| Penerjemah Anthropic ⇄ OpenAI Chat untuk endpoint tanpa format Anthropic | `daemon/translate.js`, `daemon/proxy.js` | ✓ unit & e2e dengan Agent SDK asli |
| Proxy multi-rute (token lokal per koneksi, key tidak pernah ke agen) | `daemon/proxy.js` | ✓ unit & e2e (env proses agen diperiksa) |
| Sandbox OS Codex yang menolak membaca folder data snugcode | `daemon/codex.js` (`codexArgs`, `sandboxWorks`) | ✓ e2e (`cat secrets.json` → Permission denied) |
| Tool dev snugcode untuk Codex (jembatan MCP) | `daemon/mcp-bridge.js`, `daemon/devtools.js` | ✓ e2e (`dev_list` lewat namespace `mcp__snugcode`) |
| UI HP: Model & API key, login ChatGPT, pemilih model per koneksi | `web/ui/settings.js`, `web/ui/model-picker.js` | ✓ e2e PWA (Chromium) |
| CLI: `snugcode connect`/`disconnect`, setup dengan key apa pun, `SNUGCODE_API_KEY` | `daemon/cli.js` | ✓ manual |

**Masih terbuka:** engine Gemini CLI (ACP) untuk model Gemini, benchmark harness per model (tabel engine bawaan dari
data, bukan aturan), dan uji Codex dengan login ChatGPT asli.

---

## 1. Kenapa Gemini lewat Claude Agent SDK lambat

Jalur lama: `claude` (Agent SDK) → loopback proxy → 9router (menerjemahkan Anthropic → Gemini) → provider.
Angka yang sudah diukur (CHANGELOG 2026-10-11): proxy +0 ms, overhead SDK 50–150 ms/langkah, RTT router ±25 ms,
tetapi **satu request Gemini Flash 2,5–10 detik** dan tugas yang sama butuh 45–53 langkah (Opus: 8).

Jadi perpindahan antar proses bukan penyebab utama (<5%). Penyebabnya:
1. **Prompt & tool dirancang untuk Claude.** Gemini membaca file sepotong-sepotong, jarang memanggil tool paralel.
   Hook `widenToolInput` sudah memangkas 3×, tapi tetap ±2× langkah Opus.
2. **Payload tetap ±35 KB per langkah**; bila provider/router tidak meng-cache, seluruh konteks diproses ulang tiap langkah.
3. **Terjemahan format di router berpotensi kehilangan informasi** (thought signature Gemini 3, `cache_control`,
   tool call paralel).

## 2. Perbandingan harness

Setiap harness dirancang untuk keluarga modelnya sendiri; tidak ada yang "cepat untuk semua model".

| | Claude Agent SDK | Codex (`codex app-server`) | DeepSeek Harness (`dsh`) | Harness sendiri |
|---|---|---|---|---|
| Dirancang untuk | Claude | GPT | DeepSeek | model pilihan |
| Embed | binary + SDK TS | JSON-RPC stdio (thread/turn/approval) | Node, plugin Cordis, Python SDK | in-process |
| Format API | Anthropic Messages | Responses API saja | adapter DeepSeek/Anthropic/OpenAI | native per provider |
| Kematangan | stabil | stabil, cepat berubah | 0.1.0-rc, breaking changes | nol |

Membangun harness sendiri setara Claude Code: ±6–10 minggu untuk "layak pakai", lalu tuning tanpa akhir; untuk
model Claude hampir pasti lebih buruk. Keputusan: **snugcode mengatur (orchestrate) harness resmi**, dan harness
sendiri hanya engine cadangan bila benchmark membuktikan perlu.

## 3. Kebijakan provider (menentukan apa yang boleh dibuat)

| Provider | OAuth langganan di aplikasi pihak ketiga | Yang dipakai snugcode |
|---|---|---|
| Claude Pro/Max | ✗ dilarang (ketentuan 19 Feb 2026, diblokir server ±4 Apr); dokumen Agent SDK: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products"* | API key, Bedrock/Vertex (nanti) |
| ChatGPT Plus/Pro | ✓ diizinkan OpenAI untuk harness pihak ketiga | login lewat Codex resmi |
| Gemini CLI / Antigravity | ✗ akun disuspend (pelanggaran kedua = ban permanen) | API key Gemini (AI Studio) |
| DeepSeek, Kimi, GLM, OpenRouter, xAI, Groq | – | API key |

Router yang meneruskan langganan (provider `cc/`, `ag/` di 9router) tetap bisa disambungkan sebagai router, tetapi
risikonya ditanggung akun pengguna; aplikasi menuliskannya dengan jelas.

## 4. Kenapa tidak membuat model router sendiri

Nilai 9router = (a) mengumpulkan akses langganan lewat OAuth, (b) menerjemahkan format. (a) adalah jalur yang
dilarang, (b) adalah sumber lambat. Router terpusat juga membuat lalu lintas model melewati server snugcode
(hilang zero-knowledge, ada biaya & tanggung jawab). Kendali penuh didapat dari **lapisan engine**: tiap engine bicara
langsung ke provider dalam format aslinya; penerjemahan hanya untuk endpoint yang tidak punya pilihan lain.

## 5. Arsitektur yang diimplementasikan

```
HP (PWA) ──E2EE──► Relay (zero-knowledge, tidak berubah) ◄──E2EE── daemon (PC / runner cloud)
                                                                  │
   Koneksi (secrets.connections): ChatGPT login · Anthropic · OpenAI · Gemini · OpenRouter · DeepSeek · … · router
                                                                  │  engineFor(koneksi, model)
                ┌─────────────────────────────────────────────────┴──────────────────────────┐
         Claude Agent SDK                                                               Codex app-server
   (Claude, endpoint Anthropic,                                                   (GPT: ChatGPT / Responses)
    endpoint OpenAI via penerjemah)                                                sandbox OS + jembatan MCP
                └──────────────── loopback proxy: token lokal per koneksi, key asli disuntikkan ──┘
                                       │ format asli, langsung ke provider
```

Lapisan bersama milik snugcode tidak bergantung engine: model event (`shared/events.js`), izin (`askPermission`,
`decideCodex`), checkpoint/rewind, tool dev, git/PR, relay & PWA.

### Pemetaan engine

| Kondisi | Engine | Jalur |
|---|---|---|
| koneksi `chatgpt` | Codex | login ChatGPT milik Codex |
| Responses API + model GPT (atau koneksi `openai`) | Codex | provider kustom → proxy `responses` |
| endpoint format Anthropic | Claude Agent SDK | proxy `anthropic` (apa adanya) |
| hanya OpenAI Chat | Claude Agent SDK | proxy `openai` + penerjemah |

### Keamanan
- Key tidak pernah masuk ke proses agen (Claude maupun Codex); hanya token lokal per koneksi yang tidak berguna di luar mesin.
- Codex: perintah agen di sandbox OS yang menolak membaca `secrets.json`, `codex/` (login ChatGPT), `claude/`, `env/`,
  `sessions/`; bila sandbox tidak tersedia, pengguna diberi tahu dan pembacaan folder data tidak pernah lolos otomatis.
- Jembatan MCP memakai token per sesi yang hanya bisa memanggil tool dev sesi itu; `dev_start` tetap lewat izin.

## 6. Langkah berikutnya

1. **Benchmark harness** (`snug-bench`): 5–10 tugas baku × (model, engine) — sukses, langkah, waktu, biaya, cache —
   dijadikan tabel engine bawaan.
2. **Engine Gemini CLI (ACP)** untuk koneksi Gemini (API key), dibandingkan dengan jalur penerjemah.
3. **Bedrock/Vertex** sebagai koneksi Claude untuk organisasi.
4. Uji berkala Codex dengan login ChatGPT asli (protokol app-server masih eksperimental; versi dipatok di
   `daemon/codex-version.json`).
