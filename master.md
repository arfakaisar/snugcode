# snugcode — Master Project Documentation

> **Remote Coding Agent Harness (Claude Code + 9router) di PC Pribadi yang Dikendalikan Penuh dari Smartphone.**  
> *Bekerja di repository PC lokalmu dari mana saja: review kode, edit, commit, push, buat PR, dan eksekusi perintah shell langsung dari HP.*

---

## 1. Executive Summary & Visi Produk

**snugcode** adalah platform *remote agentic coding* yang memungkinkan pengguna menjalankan dan mengendalikan **Claude Code (Agent SDK)** yang terpasang di komputer lokal (PC/laptop) secara langsung dari perangkat seluler (HP/tablet) melalui Progressive Web App (PWA) modern, maupun melalui terminal PC (TUI) secara bersamaan.

### Filosofi Desain
1. **Compute Tetap di PC Lokal**: Seluruh kode sumber, compiler, runtime (Node, Python, Docker, dll.), file berukuran besar, dan proses build berada di PC milik pengguna. HP hanya berfungsi sebagai remote control cerdas (thin client).
2. **Tanpa Konfigurasi Jaringan Rumit**: Tidak memerlukan IP publik, port forwarding, VPN, Tailscale, ngrok, atau sewa VPS cloud. Baik PC maupun HP sama-sama melakukan koneksi keluar (*outbound WebSocket*) ke relay Cloudflare.
3. **Keamanan Zero-Knowledge & Kriptografi Modern**: Semua komunikasi antara HP dan PC dienkripsi *end-to-end* (E2EE) menggunakan PAKE (CPace di atas kurva Ristretto255) dan XChaCha20-Poly1305. Relay di Cloudflare Workers sama sekali tidak bisa membaca pesan, kode sumber, PIN, maupun data sensitif.
4. **Credential Isolation**: API Key AI (9router) dan GitHub Personal Access Token **100% tersimpan di PC pengguna** (`~/.snugcode/secrets.json`). Kredensial tidak pernah dikirimkan ke relay atau ke HP.
5. **Mobile-First UX**: Antarmuka HP dirancang khusus untuk kenyamanan layar sentuh: tombol persetujuan izin 1-klik (*permission prompt*), visualisasi mini-diff berwarna, haptic feedback, input auto-resize, dan penanganan viewport keyboard virtual.

---

## 2. Arsitektur Sistem

Berikut adalah alur komunikasi tingkat tinggi arsitektur `snugcode`:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SMARTPHONE / BROWSER                           │
│  Progressive Web App (PWA) — Mobile Terminal UI                        │
│  • Enkripsi lokal via WebCrypto & @noble kripto                        │
│  • Pairing PIN sekali via CPace (Ristretto255)                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ wss:// (E2EE Encrypted Payload)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 CLOUDFLARE WORKERS + DURABLE OBJECTS                   │
│                     snugcode Relay (Zero-Knowledge)                  │
│  • Hub DO (1 per User GitHub): Mengarahkan koneksi HP ke PC yang tepat │
│  • Pending DO: Menjembatani Device Authorization Flow                  │
│  • Relay hanya meneruskan byte terenkripsi; TIDAK bisa membaca pesan  │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │ wss:// (Outbound WebSocket Connection)
┌───────────────────────────────────┴────────────────────────────────────┐
│                       PC PENGGUNA (DAEMON SERVICE)                     │
│  daemon/server.js (Background process via Windows/macOS/Linux service) │
│  ├─ Keep-Awake Manager (Away Mode win32 / caffeinate / systemd)       │
│  ├─ IPC Local Pipe/Socket (Koneksi untuk Terminal TUI `snugcode`)   │
│  ├─ Git Worktree Manager (Worktree terisolasi per sesi coding)         │
│  ├─ Local Loopback Proxy (127.0.0.1: Sanitasi header & router bridge) │
│  └─ Claude Code Agent SDK (@anthropic-ai/claude-agent-sdk)            │
│         │ HTTPS (lewat loopback proxy)        │ git / REST API         │
│         ▼                                     ▼                        │
│  ┌──────────────┐                     ┌───────────────────────┐        │
│  │   9router    │                     │        GitHub         │        │
│  │ (AI Gateway) │                     │ (clone, push, PR)     │        │
│  └──────────────┘                     └───────────────────────┘        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Komponen Utama Repositori

Repositori `snugcode` dibangun secara modular dengan arsitektur monorepo ringan tanpa framework besar (Vanilla JS modern dengan Node.js 22+ native modules):

| Direktori / Berkas | Peran & Deskripsi |
|---|---|
| `daemon/cli.js` | Antarmuka CLI utama (`snugcode setup`, `login`, `start`, `stop`, `restart`, `update`, `pin`, dll.). |
| `daemon/config.js` | Lokasi data (`~/.snugcode`, bisa diganti lewat `SNUGCODE_HOME`), baca/tulis `config.json` & `secrets.json` secara atomik, path IPC. |
| `daemon/defaults.js` | Nilai bawaan: URL relay, URL 9router, GitHub OAuth client ID, spesifikasi paket (bisa ditimpa env `SNUGCODE_*`). |
| `daemon/nativebin.js` | Deteksi binary native Claude (`claude.exe`) per platform dari paket opsional Agent SDK. |
| `daemon/server.js` | Core Daemon: mengelola koneksi WebSocket relay, IPC pipe lokal, pairing HP, dan routing RPC. |
| `daemon/sessions.js` | Pengelola sesi (`SessionManager` & `Session`): mengintegrasikan Claude Agent SDK, parsing event streaming, permission gating, dan eksekusi direct shell (`!`). |
| `daemon/proxy.js` | Loopback HTTP proxy lokal (`127.0.0.1`) untuk sanitasi header SDK, normalisasi tool name, dan komunikasi upstream ke 9router. |
| `daemon/router.js` | Klien 9router: mengambil daftar model (cache 5 menit) dan menguji model yang dipilih (*probe*). |
| `daemon/updater.js` | Mekanisme self-update otomatis (mendukung instalasi `git` maupun `npm -g`), graceful restart berjangka. |
| `daemon/keepawake.js` | Anti-sleep service: menjaga CPU & koneksi jaringan PC tetap menyala saat daemon berjalan. |
| `daemon/github.js` | Integrasi Git & GitHub REST API: pembuatan `git worktree`, branching, auto-prune, status, diff, commit, push, dan PR. |
| `daemon/ghauth.js` | Pengelola otentikasi GitHub device flow dan notifikasi perubahan status token. |
| `daemon/tui.js` | Terminal User Interface (TUI) interaktif di PC (`snugcode` / `snug`). |
| `daemon/term.js` | Teks terminal untuk TUI: warna, lebar tampilan sadar ANSI, pembungkus baris, markdown → ANSI. |
| `daemon/toolchain.js` | Shell perintah (PowerShell/bash) + pnpm/yarn otomatis lewat corepack bila tidak terpasang di PC. |
| `daemon/procs.js` | Proses latar belakang per sesi (dev server/watcher): log ring buffer, deteksi port, kill satu pohon proses. |
| `daemon/tunnel.js` | Preview untuk HP: Cloudflare quick tunnel + gerbang token lokal (rewrite Host/Origin, WebSocket HMR). |
| `daemon/project.js` | Deteksi perintah setup/dev, template `.env` per repo (`~/.snugcode/env`). |
| `daemon/browser.js` | Screenshot + log konsol via Chrome/Edge headless (CDP), tanpa Playwright. |
| `daemon/devtools.js` | Tool MCP in-process untuk agen: `dev_start`, `dev_stop`, `dev_logs`, `dev_list`, `preview_screenshot` (agen: DPR 1, opsi `image:false`, log konsol diringkas). |
| `daemon/prompt.js` | Tambahan system prompt snugcode: hanya aturan perilaku agen (±1,8 KB), dikirim di setiap request model. |
| `daemon/agents.js` | Definisi ulang subagen bawaan (Explore, Plan, general-purpose, claude) dengan effort rendah; modelnya model ringan sesi. |
| `daemon/checkpoint.js` | Snapshot worktree per prompt (index git sementara) dan rewind. |
| `daemon/webpush.js` | Web Push terenkripsi (RFC 8291 + VAPID) ke HP saat PWA ditutup. |
| `daemon/runner.js` | Runner cloud (tanpa PC): `bootstrapCloud` mengisi config/secrets dari env secara idempoten (token mesin, PIN, relay, router, model), `stopRunner` menghentikan runner yang menganggur (Codespaces API dengan token dari HP, atau keluar dari container). |
| `.devcontainer/`, `Dockerfile` | Runner Codespaces (`postStartCommand` → `snugcode cloud`, data di `/workspaces/.snugcode`) dan image container yang sama untuk VPS/Fly.io. |
| `relay/src/index.js` | Cloudflare Worker + Durable Objects (`Hub` dan `Pending`) sebagai message broker aman. |
| `web/app.js` | Titik masuk PWA: boot, service worker, sambung ulang saat aplikasi kembali terlihat. |
| `web/ui/*.js` | Layar PWA per modul: `dom` (elemen, ikon, toast, header/sheet), `auth` (login & daftar PC), `machine` (koneksi PC, pairing, update, login GitHub PC), `sessions`, `session`, `renderer` (event agen), `run`, `git`, `model-picker`, `push`; state bersama di `state.js` (`app.conn`, `app.current`, `app.me`). |
| `web/conn.js` | Koneksi terenkripsi HP ↔ PC: pairing PIN, auth perangkat, kanal E2EE teks/biner, RPC. |
| `web/codespaces.js` | Klien GitHub Codespaces tanpa DOM: cari fork runner, secret terenkripsi (sealed box) khusus repo fork, buat/cari/nyalakan/hentikan/hapus codespace. |
| `web/ui/cloud.js`, `web/ui/settings.js` | Wizard & siklus hidup runner cloud; setelan mesin dari HP (key 9router, perangkat, PIN). |
| `shared/sealedbox.js` | `crypto_box_seal` libsodium (X25519 + XSalsa20-Poly1305) untuk Codespaces secrets. |
| `web/md.js` | Markdown ringan untuk teks agen + `stableCut` untuk render bertahap saat streaming. |
| `web/index.html` & `style.css` | Struktur dan styling antarmuka mobile bergaya aplikasi chat: tema terang/gelap (token CSS), teks agen serif, drawer, composer kartu, animasi transform/opacity. |
| `shared/crypto.js` | Implementasi kriptografi bersama (CPace, Ristretto255, X25519, XChaCha20-Poly1305, Scrypt, HKDF). |
| `shared/events.js` | Model event sesi agen bersama daemon/PWA/TUI: tipe event (JSDoc), rencana TodoWrite terstruktur, label aktivitas, ringkasan selesai, `EventCursor` (penyaring event duplikat). |
| `shared/models.js` | Normalisasi ID model AI, pengelompokan varian reasoning effort ke virtual slider. |
| `scripts/build-web.mjs` | Build script untuk membundel dan menempatkan aset web PWA ke folder relay Cloudflare. |
| `tsconfig.json` | `tsc --checkJs` untuk seluruh JS (daemon, shared, web); relay punya tsconfig sendiri dengan tipe `wrangler types`. `npm run typecheck`, juga di CI. |
| `test/` | `e2e-harness.mjs` (setup bersama), `e2e-ui.mjs` (`npm run test:ui`: PWA di Chrome + TUI di pty), `unit.test.js` (`npm test`, juga dijalankan CI di Linux/Windows/macOS), `e2e-agent.mjs` (`npm run test:e2e`: HP → relay lokal → daemon → Agent SDK → mock 9router; butuh `npm run dev:relay`), `worktree.it.mjs` (integrasi git, butuh internet), `e2e-phone.mjs`. |

### Runner cloud (tanpa PC)
Mesin di relay tidak harus PC. `POST /api/machines/provision` (akun yang login) mendaftarkan mesin `kind: 'cloud'`
dan mengembalikan token mesinnya ke PWA. PWA lalu:
1. membuat PIN acak (disimpan di HP untuk pairing otomatis),
2. menyimpan token mesin, PIN, dan URL relay sebagai **Codespaces user secret** yang dienkripsi di HP dengan
   sealed box ke public key akun GitHub, dibatasi ke repo fork snugcode milik pengguna,
3. membuat codespace dari fork itu (`display_name = "snugcode <mid>"`, idle timeout 240 menit sebagai pengaman).

Di codespace, `.devcontainer/start.sh` menjalankan `snugcode cloud`: `bootstrapCloud` membaca env (idempoten —
perubahan dari HP seperti ganti PIN/key tidak ditimpa saat runner start ulang), menghapus env rahasia, lalu
menjalankan daemon di bawah **supervisor** (exit 75 = restart/update dari HP, exit 0 = berhenti). Daemon dengan
`runtime: 'cloud'` tidak menjalankan anti-sleep/autostart, boleh start tanpa key 9router (diisi dari HP lewat RPC
`configure`), dan memeriksa tiap menit apakah ia menganggur (tidak ada agen/`!perintah`/dev server/tunnel, tidak
ada HP yang membuka aplikasi). Setelah `idleStopMinutes` (bawaan 30) codespace dihentikan lewat GitHub API dengan
token `codespace` yang dikirim HP (RPC `runnerConfig`). Saat runner tidur dibuka lagi, PWA menyalakannya (`/start`).

---

## 4. Keamanan & Kriptografi End-to-End (E2EE)

Aspek keamanan `snugcode` dirancang dengan prinsip **Zero Trust** terhadap server relay:

### A. Pairing Awal (CPace PAKE)
- Pengguna menentukan PIN sederhana (6–12 karakter huruf/angka, case-insensitive) di PC saat menjalankan `snugcode setup`.
- PIN di-hash di PC menggunakan **Scrypt KDF** dengan salt ID mesin (`snugcode-pin:<machineId>`) menghasilkan Password-Related String (PRS). PIN asli tidak pernah disimpan dalam plaintext.
- Saat HP pertama kali terhubung, dilakukan pertukaran kunci **CPace** (di atas kurva *Ristretto255*).
- Server relay hanya bertindak sebagai perantara pesan hex. Relay tidak dapat memecahkan PIN secara offline (*offline dictionary attack resistant*).
- Jika ada upaya brute-force, daemon membatasi maksimal 5 kali kegagalan sebelum pairing dikunci (*lockout*).
- Keberhasilan pairing menghasilkan shared secret permanen (`deviceSecret`) 256-bit yang disimpan di `localStorage` HP dan `~/.snugcode/secrets.json` di PC.

### B. Enkripsi Kanal Sesi (Session Channel)
- Setiap kali HP tersambung ulang (*reconnect*), kedua pihak melakukan pertukaran kunci ephemeral **X25519**.
- Kunci diturunkan bersama `deviceSecret` menggunakan **HKDF-SHA256**, menghasilkan sepasang kunci simetris **XChaCha20-Poly1305** independen (arah HP ke PC dan arah PC ke HP).
- Dilengkapi nomor urut pesan (*monotonic sequence counter*) untuk mencegah serangan *replay attack*.

---

## 5. Alur Kerja Sesi & Manajemen Git Worktree

`snugcode` membedakan dua mode kerja sesi yang saling terhubung:

### 1. Sesi Remote (via HP / PWA)
- Pengguna memilih repository GitHub dari daftar repositori miliknya.
- Daemon membuat clone dasar (*bare/base*) di `~/.snugcode/workspaces/<owner>__<repo>/_base`.
- Setiap sesi baru dibuatkan direktori **Git Worktree** terisolasi di `~/.snugcode/workspaces/<owner>__<repo>/s-<sessionId>`.
- Worktree memiliki branch sendiri (default `snug/<sessionId>`). Agen AI bekerja murni di dalam worktree tersebut, sehingga tidak mengotori *working tree* proyek lain.
- Terdapat pembersihan otomatis terhadap file kunci yang tertinggal (`.git/index.lock` stale pruning) dan `git worktree prune`.

### 2. Sesi Lokal (via Terminal PC)
- Pengguna cukup membuka terminal di folder proyek lokal mana pun dan mengetik `snugcode` (atau `snug`).
- Folder aktif tersebut langsung menjadi sesi lokal (*direct directory* tanpa clone).
- Sesi tersebut otomatis muncul di aplikasi HP dengan badge **"terminal"**. Pengguna bisa melanjutkan percakapan atau memonitor progress dari HP saat berjalan menjauh dari PC.

### 3. Sistem Izin (Permission Gating)
- Agen AI Claude Code dapat memanggil berbagai tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, dll.
- SDK berjalan dengan `permissionMode: 'default'`, jadi setiap tool yang tidak aman lewat `canUseTool` di daemon.
- **Safe Tools**: `TodoWrite`, `WebSearch`, subagent `Task`/`Agent`, tool dev non-eksekusi, dan tool baca (`Read`, `Glob`, `Grep`, `LS`) **yang sasarannya di dalam worktree** langsung diizinkan otomatis. Membaca di luar worktree dan `WebFetch` meminta izin (atau auto-izin) agar isi file tidak bisa diam-diam dikirim ke luar lewat prompt injection.
- **Folder data `~/.snugcode`** (key 9router, token GitHub, secret perangkat; kecuali worktree & plans) selalu ditolak untuk tool file, juga saat auto-izin. Perintah Bash yang menyebut `secrets.json` selalu meminta izin dan tidak bisa "Selalu diizinkan".
- **Checkpoint**: snapshot worktree per prompt berjalan paralel dengan start-up agen; tool yang bisa mengubah file baru dijalankan setelah snapshot selesai.
- **Edit file**: `Write`/`Edit`/`MultiEdit` yang sasarannya di dalam worktree langsung diterapkan (setiap prompt punya checkpoint, jadi bisa di-rewind). *Tinjau edit* (menu sesi di HP / `/edits` di terminal, disimpan sebagai `askEdits`) membuat setiap edit menunggu persetujuan dengan cuplikan mini-diff. Edit di luar worktree dan di mode rencana selalu bertanya.
- **Perintah `Bash`** yang tidak read-only (Claude Code sendiri meloloskan perintah baca seperti `ls`, `grep`, `git status`) meminta keputusan pengguna:
  - *Izinkan* (sekali)
  - *Selalu* — memakai saran aturan Claude Code untuk perintah itu (mis. `Bash(npm test *)`), bukan seluruh Bash. Aturan berlaku langsung di proses berjalan, disimpan sebagai `allowRules` di `sessions/index.json`, dan diteruskan lewat `settings.permissions.allow` ke proses berikutnya. Perintah gabungan (`npm test && rm …`) tetap bertanya untuk bagian yang tidak cocok. Tool tanpa saran aturan (mis. `dev_start`) memakai "Selalu" per tool seperti sebelumnya.
  - *Tolak*
- Hook `PreToolUse` berjalan untuk tool yang bisa mengubah file (`Bash`, `Write`, `Edit`, `dev_start`, …), termasuk yang lolos lewat aturan tanpa melewati `canUseTool`: menahannya sampai checkpoint prompt tersimpan, dan memaksa prompt izin (`permissionDecision: 'ask'`) untuk push/`gh pr create` dan perintah yang menyebut `secrets.json`, walau cocok dengan aturan "Selalu" seperti `Bash(git *)`.
- **Aksi Kritis**: Perintah yang menulis ke remote — `git push` (termasuk `git -C dir push`, `git -c k=v push`), `gh pr create|merge`, `gh release create`, `gh repo create|delete|fork` — **selalu meminta izin eksplisit** terlepas dari auto-izin, dan tidak bisa "Selalu diizinkan". Deteksi berbasis pola teks perintah: ini pengaman dari kekeliruan agen, bukan sandbox (skrip yang memanggil `git push` dari dalam file tidak terdeteksi).
- **Mode ⚡ Auto-Izin**: Pengguna dapat menyalakan toggle auto-izin dari HP/terminal untuk membiarkan agen bekerja mandiri tanpa interupsi, kecuali untuk aksi kritis di atas.

---

## 6. Integrasi AI Model & Multi-Provider Router (9router)

`snugcode` menggunakan **9router** (`https://router.gemz.space/v1`) sebagai gerbang cerdas penyedia model AI (Claude, Gemini, OpenAI, dll.).

### Virtual Effort Level Slider
- Model Gemini membagi tingkat reasoning per ID terpisah (misal `ag/gemini-3.8-flash-low`, `-medium`, `-high`). `snugcode` menyatukannya menjadi **1 pilihan model dengan slider tingkat effort**.
- Untuk model native Claude (`cc/claude-opus-5-5`, `cc/claude-sonnet-5-5`, atau `claude-*` tanpa provider), daemon menyediakan slider virtual (*auto*, *low*, *medium*, *high*, *max*) yang memetakan ID virtual (mis. `cc/claude-opus-5-5-high`) ke model asli + opsi `effort` Agent SDK. Ganti model/effort diterapkan ke proses yang hidup (`setModel` / `applyFlagSettings({ effortLevel })`).

### Model Ringan Subagen
- Subagen (Explore, Plan, general-purpose) dan tugas utilitas Claude Code (mis. ringkasan WebFetch) memakai **model ringan** yang dipilih otomatis oleh `lightModel()` di `shared/models.js`, hanya dari dua pilihan:
  - Model utama Claude (`cc/` atau `claude-*` tanpa provider): **Claude Haiku 5.5** (`cc/claude-haiku-5-5`), lalu **Gemini 3.8 Flash**.
  - Model utama lain (`ag/`, `gemini/`, …): **Gemini 3.8 Flash** (varian `-low`, provider yang sama didahulukan), lalu **Claude Haiku 5.5**.
  - Keduanya tidak ada di router: memakai model utama.
- Diteruskan lewat `CLAUDE_CODE_SUBAGENT_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (tanpa `_FORCE`, subagen bawaan tetap memakai model utama) dan `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Effort subagen diatur di `daemon/agents.js` (Explore `low`, lainnya `medium`); tanpa itu subagen mewarisi effort model utama.
- Daftar model router diambil di latar belakang saat daemon start (cache 5 menit, boleh basi), jadi prompt tidak pernah menunggu request `/models`. Model ringan untuk model default terlihat di menu PC (HP) dan `snugcode status`; tidak bisa diganti manual.
- Model `claude-*` di provider lain (mis. `ag/claude-opus-4-6-thinking`) **tidak** diberi slider virtual: router-nya tidak mengenal effort, jadi ID diteruskan apa adanya.

### Pemeriksaan Model (Probe)
- Banyak model AI upstream yang sudah dihentikan (*deprecated*) tetap mengembalikan status HTTP 200 dengan payload teks error ("*...is no longer available*").
- Daftar model diambil dari `/models` 9router dan disaring ke model yang tidak menyatakan `tools: false`.
- Saat pengguna memilih model di HP, `daemon/router.js` mengirim satu pesan probe kecil (*stream probe*) dan menampilkan "✓ siap · 1.2s" atau alasan gagalnya (termasuk deteksi teks "no longer available"). Probe hanya menguji bahwa model menjawab, bukan kemampuan *tool calling*.

---

## 7. Analisis Mendalam Isu `_ide` pada Claude Opus 5.5

### Masalah yang Terjadi
Saat pengguna memilih model Claude Opus 5.5 (`cc/claude-opus-5-5`), agen gagal mengeksekusi tool dan mengulang pesan error:
```text
<tool_use_error>Error: No such tool available: Bash_ide</tool_use_error>
```
Meskipun model mencoba memanggil kembali dengan nama yang dianggapnya benar, error tersebut terus terulang.

### Akar Masalah (Root Cause)
1. **Routing Akun Claude Code IDE Upstream**:
   Di 9router, prefix `cc/*` (Claude Code) di-route ke backend Anthropic yang terintegrasi dengan **Claude Code IDE Extension (VS Code / JetBrains companion)**.
2. **Injeksi Suffix `_ide`**:
   Pada integrasi IDE, upstream secara otomatis mengubah nama tool yang dideklarasikan oleh client dengan menambahkan akhiran `_ide` (misalnya `Bash` menjadi `Bash_ide`, `Read` menjadi `Read_ide`, `Edit` menjadi `Edit_ide`), dan menandai tool CLI standar sebagai "*This tool is currently unavailable*".
3. **Ketidaksesuaian Registri Tool di SDK**:
   `snugcode` menjalankan `@anthropic-ai/claude-agent-sdk` di PC dalam mode CLI/Agent. SDK mendaftarkan tool native dengan nama standar: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`. Ketika response stream dari model Claude Opus 5.5 mengembalikan nama tool `Bash_ide`, SDK menolak karena `Bash_ide` tidak terdaftar di internal harness SDK.

### Solusi Permanen via Loopback Proxy Sanitizer (`daemon/proxy.js`)
`snugcode` memiliki loopback proxy lokal pada `127.0.0.1` (port acak) yang berada tepat di antara Claude Agent SDK dan 9router. Proxy ini dilengkapi dengan fungsi **Tool Name Sanitizer**:
- Menghapus header `accept-encoding` sehingga stream response tidak terkompresi.
- Menulis ulang respons SSE (`text/event-stream`) dan JSON secara streaming **per baris utuh**: event SSE dan JSON selalu diakhiri baris baru, jadi pola nama tool tidak pernah terbelah oleh batas chunk TCP. Karakter UTF-8 multi-byte yang terpotong di antara dua chunk disambung ulang dengan `StringDecoder`. Respons lain diteruskan apa adanya.
- Memotong suffix `_ide` pada nama tool (`"name":"Bash_ide"` -> `"name":"Bash"`, `"name":"Read_ide"` -> `"name":"Read"`).
- Bila koneksi ke router putus di tengah stream, koneksi ke SDK ikut diputus agar SDK melihat error dan mencoba ulang (tidak menggantung). Router yang tidak bisa dihubungi dijawab `502` berformat error Anthropic. Tombol Stop ikut membatalkan request ke router.
- Proses `claude` hanya memegang **token lokal acak** milik proxy (bukan key 9router); proxy menukarnya dengan key asli. Request tanpa token itu ditolak 401, sehingga program lain di PC tidak bisa memakai key pengguna, dan Bash agen tidak bisa membaca key dari env.
- Satu proses `claude` per sesi dibiarkan hidup di antara prompt (streaming input Agent SDK) dan ditutup setelah 5 menit menganggur. Proses disiapkan di latar belakang saat sesi dibuka (pre-warm), jadi prompt pertama tidak menunggu spawn + resume. Ganti model/effort tidak membuat proses baru; proses baru (dengan `resume`) hanya bila model ringan, binary, atau URL berubah.
- Diuji di `test/unit.test.js` dengan memotong stream di setiap posisi di dalam `"Bash_ide"` dan di tengah karakter multi-byte, serta end-to-end dengan `cc/claude-opus-5-5`.

---

## 8. Fitur-Fitur Unggulan Lainnya

### A. Remote Self-Update 1-Klik dari HP (`daemon/updater.js`)
- PC dapat memeriksa dan memperbarui instalasi `snugcode` secara jarak jauh.
- Mendukung dua mode instalasi:
  - **Git Checkout**: Menjalankan `git fetch`, memvalidasi working tree, `git pull --ff-only origin main`, lalu `npm install --omit=dev --include=optional`.
  - **Global npm**: Mengambil commit terbaru dari GitHub API (jumlah commit tertinggal dihitung lewat compare API), lalu mengeksekusi `npm install -g github:arfakaisar/snugcode --include=optional`. Commit dicatat di `config.json` (`installedCommit`); bila belum tercatat, waktu commit terbaru dibandingkan dengan waktu pemasangan paket.
- **Binary Native Claude Terjamin Ada** (`daemon/nativebin.js`): Agent SDK membawa `claude.exe` lewat paket per-platform opsional (`@anthropic-ai/claude-agent-sdk-win32-x64`, dst.) yang bisa dilewati npm tanpa error. Semua sesi/daemon dihentikan sebelum update (agar file tidak terkunci di Windows), lalu keberadaan binary diverifikasi setelah install. Sebelum tiap prompt, sesi juga memeriksa binary dan menampilkan perintah perbaikan bila hilang. Fallback manual: isi `"claudeExecutable": "C:\\path\\ke\\claude.exe"` di `~/.snugcode/config.json`.
- **Deteksi Otomatis Push Baru**: Daemon secara otomatis memeriksa commit baru setiap 10 menit. Begitu commit baru dideteksi, banner pembaruan dinamis muncul seketika di bagian atas layar HP pengguna.
- **Detached Restart**: Daemon menunggu ~1 detik agar balasan RPC terkirim, berhenti, lalu helper child process independen (*detached*) menyalakan daemon baru ~2 detik kemudian. HP terputus beberapa detik lalu otomatis *reconnect* tanpa campur tangan manual di PC.

### B. Anti-Sleep Service (`daemon/keepawake.js`)
Mencegah PC masuk ke mode tidur (*system sleep*) saat sesi sedang aktif:
- **Windows (win32)**: Memanggil Windows API `SetThreadExecutionState(0x80000041)` via background PowerShell. Mode ini mengaktifkan **Away Mode**, memungkinkan monitor/layar PC mati untuk hemat energi, namun CPU dan koneksi jaringan tetap bekerja penuh.
- **macOS (darwin)**: Menjalankan utilitas bawaan `caffeinate -s -w <pid>`.
- **Linux**: Menggunakan `systemd-inhibit --what=sleep`.

### C. Direct Shell Execution (`!`)
Di dalam chat (baik di HP maupun terminal PC), pesan yang diawali tanda seru (`!`) langsung dieksekusi sebagai perintah shell OS di direktori sesi (menggunakan PowerShell di Windows atau bash di macOS/Linux), misalnya:
```bash
!npm test
!git status
!dir
```
Output perintah di-stream secara real-time ke layar HP. Untuk perintah yang berjalan terus (dev server), pakai **Run & Preview**.

### D. Run & Preview (lihat hasil web app dari HP sebelum commit)
- Tombol **▶** di header sesi → **Jalankan**. Perintah setup (`npm ci`, `pnpm install`, …) dan dev (`npm run dev`, …) terdeteksi otomatis, atau bisa diketik manual. Bisa juga ditimpa lewat `.snugcode.json` di root repo: `{ "setup": "…", "dev": "…" }`.
- Proses berjalan di latar belakang tanpa memblokir agen. Env `PORT` diisi port bebas, dan `{port}` di perintah diganti port yang sama. Port terdeteksi dari log.
- **Preview di HP**: Cloudflare quick tunnel ke gerbang lokal `127.0.0.1`. Link berisi token rahasia (dikirim hanya lewat kanal E2EE), lalu ditukar menjadi cookie HttpOnly. Tanpa token, link ditolak 401. Host/Origin ditulis ulang ke `localhost` sehingga HMR Vite/Next berjalan. Tunnel tertutup saat proses berhenti.
- **Screenshot** halaman dari HP (Chrome/Edge headless di PC) beserta error konsol. Satu tap meneruskan error ke agen.
- Agen memakai tool yang sama (`dev_start`, `preview_screenshot`, …) untuk memverifikasi UI sendiri.
- **Template .env**: menu sesi → *Simpan .env sebagai template*. File itu dipulihkan otomatis di worktree baru repo yang sama.
- Kebutuhan: `cloudflared` (diunduh otomatis ke `~/.snugcode/bin`, atau isi `cloudflaredExecutable` di config) dan Chrome/Edge/Chromium untuk screenshot (`browserExecutable` di config bila tidak terdeteksi).

### E. Kolaborasi dengan agen
- **Kirim gambar** dari kamera/galeri/clipboard (dikompres di HP, maks. 4 per pesan).
- **Agen bertanya** (`AskUserQuestion`): opsi tap di HP, pilihan angka di terminal. Selalu menunggu pengguna, juga saat auto-izin aktif.
- **Mode rencana** (tombol **+** → *Mode rencana* / `/plan`): agen hanya membaca, lalu mengajukan rencana. *Setujui & kerjakan* mematikan mode rencana dan agen mulai mengerjakan.
- **Checkpoint & rewind**: tiap prompt menyimpan snapshot worktree (termasuk perubahan yang belum di-commit; `node_modules` dikecualikan). Tombol ↺ di prompt atau `/rewind` mengembalikan semua file.
- **Web Push**: aktifkan dari menu → *Izinkan notifikasi*. Notifikasi muncul saat agen selesai, butuh izin, atau bertanya, walau PWA ditutup (iOS: tambahkan ke Home Screen dulu).

---

## 9. Panduan Konfigurasi & Perintah CLI

### Prasyarat
- **Node.js 22+**
- **Git**
- **API Key 9router** (`https://router.gemz.space/v1`)
- Akun **GitHub**

### Instalasi & Setup di PC
```bash
# Pasang secara global
npm i -g github:arfakaisar/snugcode

# Jalankan wizard interaktif setup
snugcode setup

# Aktifkan service latar belakang & jalankan saat PC booting
snugcode autostart on
```

### Daftar Perintah CLI Lengkap

| Perintah | Deskripsi |
|---|---|
| `snugcode` / `snug` | Membuka interactive Terminal UI pada direktori aktif saat ini. |
| `snugcode "prompt"` | Membuka TUI dan langsung mengirimkan prompt instruksi awal. |
| `snugcode --pick` | Membuka pemilih sesi aktif (termasuk sesi yang dibuat dari HP). |
| `snugcode setup` | Menjalankan ulang panduan konfigurasi (API key, model, GitHub, PIN). |
| `snugcode login` | Login ulang GitHub saja (token dicabut/kedaluwarsa); langsung berlaku tanpa restart bila daemon berjalan. |
| `snugcode start` | Menjalankan daemon di foreground terminal ini. |
| `snugcode stop` | Menghentikan daemon yang sedang berjalan di background. |
| `snugcode restart` | Me-restart daemon background. |
| `snugcode update` | Memeriksa dan menginstal pembaruan snugcode terbaru dari GitHub. |
| `snugcode autostart on\|off` | Mengaktifkan/menonaktifkan auto-start daemon saat user login OS. |
| `snugcode pin` | Mengganti PIN pairing dan membuka kunci lockout jika terblokir. |
| `snugcode devices` | Melihat daftar perangkat HP yang saat ini terpasang (*paired*). |
| `snugcode revoke <id\|all>` | Mencabut izin akses perangkat HP tertentu atau semua perangkat. |
| `snugcode status` | Menampilkan ringkasan status daemon, model, login GitHub, dan relay. |

### Struktur Penyimpanan Data Lokal (`~/.snugcode/`)
- `config.json`: Konfigurasi umum (nama mesin, ID, URL relay, router URL, default model).
- `secrets.json`: Kredensial lokal (token relay mesin, token GitHub, PIN PRS, device secret HP terdaftar). Izin berkas dibatasi (mode 600 di UNIX).
- `daemon.log` & `daemon.pid`: Log eksekusi dan ID proses background daemon.
- `workspaces/<owner>__<repo>/`: Base clone dan direktori git worktree per sesi coding.
- `sessions/`: Riwayat event percakapan berformat JSONL per sesi (`<sessionId>.jsonl`).
- `claude/`: Direktori konfigurasi khusus Agent SDK terpisah dari instalasi Claude Code pengguna lain.

---

## 10. Status Pengembangan & Roadmap Masa Depan

- [x] Enkripsi End-to-End dengan CPace (Ristretto255) & XChaCha20-Poly1305.
- [x] Remote Self-Update & Deteksi Push Otomatis 1-Klik dari HP.
- [x] Anti-Sleep System (Windows Away Mode, macOS Caffeinate, Linux systemd-inhibit).
- [x] Dukungan Model Claude Opus 5.5, Sonnet 5.5 & Gemini via 9router.
- [x] Normalisasi Otomatis Tool Name Suffix `_ide` via Local Loopback Proxy.
- [x] Git Worktree Isolation & Stale Lock Cleanup.
- [x] Prompt izin Write/Edit dengan mini-diff; deteksi push/`gh` yang lebih ketat.
- [x] CI GitHub Actions (unit test + build web di Linux/Windows/macOS).
- [x] Run & Preview: dev server latar belakang + tunnel bertoken ke HP + screenshot.
- [x] Tool MCP agen untuk menjalankan dan melihat hasil UI sendiri.
- [x] Web Push Notification saat PWA ditutup di latar belakang.
- [x] Kirim gambar / screenshot ke agen dari kamera/galeri HP.
- [x] AskUserQuestion, mode rencana, checkpoint & rewind per prompt.
- [x] Runner cloud tanpa PC: GitHub Codespaces (dibuat & dinyalakan dari HP) dan Docker; setelan mesin (key 9router, PIN, perangkat) dari HP.
- [ ] Integrasi OS Keychain (Windows Credential Manager / macOS Keychain / Linux SecretService) untuk `secrets.json`.
- [ ] Panel Terminal Interaktif PTY penuh di HP.
- [ ] Tunnel preview E2EE lewat relay sendiri (Service Worker), pengganti quick tunnel Cloudflare.
- [ ] File explorer/editor ringan dan review diff per hunk dengan komentar ke agen.
