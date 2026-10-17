# snugcode — Master Project Documentation

> **Remote Coding Agent di PC Pribadi (atau runner cloud) yang Dikendalikan Penuh dari Smartphone — model apa pun, di harness terbaiknya (Claude Agent SDK / Codex).**  
> *Bekerja di repository PC lokalmu dari mana saja: review kode, edit, commit, push, buat PR, dan eksekusi perintah shell langsung dari HP.*

---

## 1. Executive Summary & Visi Produk

**snugcode** adalah platform *remote agentic coding* yang memungkinkan pengguna menjalankan dan mengendalikan coding agent — **Claude Agent SDK** untuk model Claude & endpoint format Anthropic/OpenAI, **Codex** resmi untuk model GPT — di komputer lokal (PC/laptop) secara langsung dari perangkat seluler (HP/tablet) melalui Progressive Web App (PWA) modern, maupun melalui terminal PC (TUI) secara bersamaan. Tanpa PC pun bisa: daemon yang sama berjalan sebagai **runner cloud** di GitHub Codespaces milik pengguna atau di container Docker (lihat §3 → Runner cloud).

### Filosofi Desain
1. **Compute Tetap di PC Lokal**: Seluruh kode sumber, compiler, runtime (Node, Python, Docker, dll.), file berukuran besar, dan proses build berada di PC milik pengguna. HP hanya berfungsi sebagai remote control cerdas (thin client).
2. **Tanpa Konfigurasi Jaringan Rumit**: Tidak memerlukan IP publik, port forwarding, VPN, Tailscale, ngrok, atau sewa VPS cloud. Baik PC maupun HP sama-sama melakukan koneksi keluar (*outbound WebSocket*) ke relay Cloudflare.
3. **Keamanan Zero-Knowledge & Kriptografi Modern**: Semua komunikasi antara HP dan PC dienkripsi *end-to-end* (E2EE) menggunakan PAKE (CPace di atas kurva Ristretto255) dan XChaCha20-Poly1305. Relay di Cloudflare Workers sama sekali tidak bisa membaca pesan, kode sumber, PIN, maupun data sensitif.
4. **Credential Isolation**: Koneksi model (API key official/router, login ChatGPT) dan token GitHub **tersimpan di mesin daemon** (`~/.snugcode/secrets.json` & `~/.snugcode/codex` di PC, atau di disk runner cloud). Key yang diisi dari HP dikirim lewat kanal E2EE dan tidak pernah dikembalikan ke HP; relay tidak pernah melihatnya; proses agen hanya memegang token lokal loopback proxy.
6. **Harness Terbaik per Model, Tanpa Router Terpusat**: Lalu lintas model berjalan langsung dari mesin daemon ke provider dalam format aslinya. snugcode tidak meneruskan langganan lewat jalur tidak resmi (langganan Claude Pro/Max & login Gemini CLI dilarang untuk aplikasi pihak ketiga); login ChatGPT dijalankan lewat Codex resmi (diizinkan OpenAI).
5. **Mobile-First UX**: Antarmuka HP dirancang khusus untuk kenyamanan layar sentuh: tombol persetujuan izin 1-klik (*permission prompt*), visualisasi mini-diff berwarna, haptic feedback, input auto-resize, dan penanganan viewport keyboard virtual.

---

## 2. Arsitektur Sistem

Berikut adalah alur komunikasi tingkat tinggi arsitektur `snugcode`:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SMARTPHONE / BROWSER                            │
│  Progressive Web App (PWA) — Mobile Terminal UI                        │
│  • Enkripsi lokal via WebCrypto & @noble kripto                        │
│  • Pairing PIN sekali via CPace (Ristretto255)                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ wss:// (E2EE Encrypted Payload)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 CLOUDFLARE WORKERS + DURABLE OBJECTS                   │
│                     snugcode Relay (Zero-Knowledge)                    │
│  • Worker alias `snugcode`: PWA + service binding ke `pocketcode-relay`│
│  • Hub DO (1 per User GitHub): Mengarahkan koneksi HP ke PC yang tepat │
│  • Pending DO: Menjembatani penautan PC lewat login browser            │
│  • Relay hanya meneruskan byte terenkripsi; TIDAK bisa membaca pesan   │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │ wss:// (Outbound WebSocket Connection)
┌───────────────────────────────────┴────────────────────────────────────┐
│          PC PENGGUNA (DAEMON SERVICE) — atau runner cloud              │
│  daemon/server.js (Background process via Windows/macOS/Linux service) │
│  ├─ Keep-Awake Manager (Away Mode win32 / caffeinate / systemd)        │
│  ├─ IPC Local Pipe/Socket (Koneksi untuk Terminal TUI `snugcode`)      │
│  ├─ Git Worktree Manager (Worktree terisolasi per sesi; atau Komputer) │
│  ├─ Local Loopback Proxy (127.0.0.1: token per koneksi, penerjemah)    │
│  ├─ Claude Agent SDK  (model Claude / endpoint Anthropic & OpenAI)     │
│  └─ Codex app-server  (model GPT: login ChatGPT / Responses API)       │
│         │ HTTPS (lewat loopback proxy)        │ git / REST API         │
│         ▼                                     ▼                        │
│  ┌──────────────────────┐             ┌───────────────────────┐        │
│  │ Provider model milik │             │        GitHub         │        │
│  │ pengguna: Anthropic, │             │ (clone, push, PR)     │        │
│  │ OpenAI, Gemini, …    │             └───────────────────────┘        │
│  │ atau router (9router)│                                              │
│  └──────────────────────┘                                              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Komponen Utama Repositori

Repositori `snugcode` dibangun secara modular dengan arsitektur monorepo ringan tanpa framework besar (Vanilla JS modern dengan Node.js 22+ native modules):

| Direktori / Berkas | Peran & Deskripsi |
|---|---|
| `daemon/cli.js` | Antarmuka CLI utama (`snugcode setup`, `login`, `start`, `stop`, `restart`, `update`, `clean`, `pin`, `cloud`, dll.); tanpa perintah membuka TUI (`--pick`, `--computer`). `snugcode cloud` membungkus daemon dengan supervisor. |
| `daemon/autostart.js` | Autostart lintas platform (Windows Startup `.vbs`, launchd `dev.snugcode`, systemd user `snugcode`), sinkron otomatis ke path CLI aktif saat start/update, migrasi entri `pocketcode` lama. |
| `daemon/cleaner.js` | Pembersih worktree/repo/log yatim (`safeRm` tahan file read-only & kunci Windows); clone dasar disimpan 3 hari setelah sesi terakhirnya dihapus. Jalan saat start, setelah hapus sesi, tiap 30 menit, `snugcode clean`, `/clean`, dan tombol di HP. |
| `daemon/config.js` | Lokasi data (`~/.snugcode`, bisa diganti lewat `SNUGCODE_HOME`), baca/tulis `config.json` & `secrets.json` secara atomik, path IPC. |
| `daemon/defaults.js` | Nilai bawaan: URL relay, URL router bawaan untuk key router tanpa URL, GitHub OAuth client ID, spesifikasi paket (bisa ditimpa env `SNUGCODE_*`). |
| `daemon/nativebin.js` | Deteksi binary native Claude (`claude.exe`) per platform dari paket opsional Agent SDK. |
| `daemon/server.js` | Core Daemon: mengelola koneksi WebSocket relay, IPC pipe lokal, pairing HP, tabel RPC (dengan validasi input; `info.caps` untuk deteksi fitur), Web Push, dan pengawas runner cloud yang menganggur. |
| `daemon/sessions.js` | Pengelola sesi (`SessionManager` & `Session`): tiga jenis sesi (repo/worktree, folder lokal dari terminal, Komputer), pemilihan engine per model (Claude Agent SDK / Codex) dengan izin & checkpoint yang sama, integrasi Claude Agent SDK, parsing event streaming, permission gating, hook PreToolUse, dan eksekusi direct shell (`!`). |
| `daemon/proxy.js` | Loopback HTTP proxy lokal (`127.0.0.1`) multi-rute: satu token lokal per koneksi+format, key asli disuntikkan per request. Rute `anthropic` (diteruskan apa adanya; khusus router: sanitasi header & `_ide`), `openai` (diterjemahkan, lihat `translate.js`), `responses` (Codex → endpoint OpenAI). |
| `daemon/translate.js` | Penerjemah Anthropic Messages ⇄ OpenAI Chat Completions (request, stream SSE, error, `count_tokens`): skema tool & *thought signature* Gemini 3, effort dari akhiran ID → `reasoning_effort`, cache token → `cache_read_input_tokens`. |
| `daemon/providers.js` | Koneksi model: deteksi API key/endpoint (pola key + uji ke API, deteksi format tanpa memanggil model), daftar model per koneksi (cache 5 menit), rute model → koneksi/engine (`resolveRoute`), uji model (*probe*), migrasi router lama. |
| `daemon/codex.js` | Engine Codex: pemasangan `@openai/codex` (versi dipatok di `codex-version.json`), klien JSON-RPC `codex app-server`, profil sandbox (tolak baca folder data snugcode), login ChatGPT dengan device code, daftar model ChatGPT, dan `CodexAgent` (event Codex → event snugcode, izin lewat kebijakan snugcode). |
| `daemon/mcp-bridge.js` | Server MCP stdio untuk engine Codex: tool `dev_*`/`preview_screenshot` diteruskan ke daemon lewat kanal lokal dengan token jembatan per sesi (hanya bisa memanggil tool dev sesi itu). |
| `shared/providers.js` | Katalog provider (URL, pola key, format), key yang ditolak (token langganan Claude, OAuth Google, admin key), referensi model `<koneksi>:<model>`, dan pemilihan engine per koneksi+model (`engineFor`). |
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
| `daemon/prompt.js` | Tambahan system prompt snugcode: hanya aturan perilaku agen (±1,9 KB), dikirim di setiap request model. Dua varian: sesi repo (`SNUGCODE_SYSTEM_PROMPT`, tetap di worktree, tanpa `git push`) dan Mode Komputer (`SNUGCODE_COMPUTER_PROMPT`). |
| `daemon/agents.js` | Definisi ulang subagen bawaan (Explore, Plan, general-purpose, claude) dengan effort rendah; modelnya model ringan sesi. |
| `daemon/checkpoint.js` | Snapshot worktree per prompt (index git sementara) dan rewind. |
| `daemon/webpush.js` | Web Push terenkripsi (RFC 8291 + VAPID) ke HP saat PWA ditutup. |
| `daemon/runner.js` | Runner cloud (tanpa PC): `bootstrapCloud` mengisi config/secrets dari env secara idempoten (token mesin, PIN, relay, router, model), `stopRunner` menghentikan runner yang menganggur (Codespaces API dengan token dari HP, atau keluar dari container), `reportStatus` melaporkan kegagalan konfigurasi ke relay. |
| `.devcontainer/`, `Dockerfile` | Runner Codespaces: `install.sh` (postCreate: Chromium + paket snugcode), `start.sh` (postStart: `snugcode cloud` di latar belakang; fallback ke kode repo bila paket global gagal), `lib.sh` (folder data `/workspaces/.snugcode` atau `~/.snugcode`, log, laporan tahap ke relay). `Dockerfile`: image yang sama untuk VPS/Fly.io (volume `/data`). |
| `relay/src/index.js` | Cloudflare Worker `pocketcode-relay` + Durable Objects (`Hub` dan `Pending`) sebagai message broker aman. Lihat tabel endpoint di bawah. |
| `relay/src/alias.js` | Worker alias `snugcode` (alamat publik `snugcode.arfak.workers.dev`): menyajikan PWA dan meneruskan semua request lain ke relay lewat service binding. |
| `web/app.js` | Titik masuk PWA: boot, service worker, sambung ulang saat aplikasi kembali terlihat, impor data dari alamat lama (`#import=`), token Codespaces dari fragmen (`#gh=`). |
| `web/sw.js` | Service worker stale-while-revalidate; nama cache = hash isi aset (diisi `build:web`). |
| `web/ui/*.js` | Layar PWA per modul: `dom` (elemen, ikon, toast, header/sheet), `auth` (login & daftar mesin, hapus mesin dari daftar), `machine` (koneksi PC, pairing, update, login GitHub PC, menu Pengaturan PC), `sessions` (beranda, drawer, sesi baru: tab Repository/Komputer), `session`, `renderer` (event agen), `run`, `git`, `model-picker`, `push`, `progress` (bar tahap + perkiraan sisa); state bersama di `state.js` (`app.conn`, `app.current`, `app.me`). |
| `web/eta.js` | Perhitungan progress tanpa DOM: bar per tahap yang melambat mendekati akhir, sisa waktu, durasi tahap yang dipelajari per HP. |
| `web/conn.js` | Koneksi terenkripsi HP ↔ PC: pairing PIN, auth perangkat, kanal E2EE teks/biner, RPC. |
| `web/codespaces.js` | Klien GitHub Codespaces tanpa DOM: cari fork runner, secret terenkripsi (sealed box) khusus repo fork, buat/cari/nyalakan/hentikan/hapus codespace. |
| `web/ui/cloud.js`, `web/ui/settings.js` | Wizard & siklus hidup runner cloud; setelan mesin dari HP: Model & API key (koneksi, login ChatGPT dengan device code, deteksi jenis key saat diketik), perangkat, PIN. |
| `shared/sealedbox.js` | `crypto_box_seal` libsodium (X25519 + XSalsa20-Poly1305) untuk Codespaces secrets. |
| `web/md.js` | Markdown ringan untuk teks agen + `stableCut` untuk render bertahap saat streaming. |
| `web/index.html` & `style.css` | Struktur dan styling antarmuka mobile bergaya aplikasi chat: tema terang/gelap (token CSS), teks agen serif, drawer, composer kartu, animasi transform/opacity. |
| `shared/crypto.js` | Implementasi kriptografi bersama (CPace, Ristretto255, X25519, XChaCha20-Poly1305, Scrypt, HKDF). |
| `shared/events.js` | Model event sesi agen bersama daemon/PWA/TUI: tipe event (JSDoc), rencana TodoWrite terstruktur, label aktivitas, ringkasan selesai, `EventCursor` (penyaring event duplikat). |
| `shared/models.js` | Normalisasi ID model AI, pengelompokan varian reasoning effort ke virtual slider. |
| `scripts/build-web.mjs` | Build script untuk membundel dan menempatkan aset web PWA ke `relay/public` (dipakai kedua worker). |
| `scripts/docs-images.mjs`, `scripts/icons.mjs` | `npm run docs:images` (gambar & GIF README dari UI asli, butuh relay dev) dan `npm run icons` (PNG/maskable/apple-touch dari SVG). |
| `tsconfig.json` | `tsc --checkJs` untuk seluruh JS (daemon, shared, web); relay punya tsconfig sendiri dengan tipe `wrangler types`. `npm run typecheck`, juga di CI. |
| `.github/workflows/` | `ci.yml`: cek sintaks, typecheck, unit test (Linux/Windows/macOS), bundle PWA, lalu e2e (agen, runner cloud, UI) di Linux. `deploy.yml`: `npm run deploy` saat `main` berubah di `relay/`, `web/`, `shared/` (atau manual), butuh secret `CLOUDFLARE_API_TOKEN`. |
| `test/` | `e2e-harness.mjs` (setup bersama), `e2e-ui.mjs` (`npm run test:ui`: PWA di Chrome + TUI di pty), `unit.test.js` & `providers.test.js` (`npm test`, juga dijalankan CI di Linux/Windows/macOS), `e2e-connections.mjs` (`npm run test:e2e:connections`: koneksi dari HP, endpoint OpenAI-only lewat penerjemah, Codex asli dengan izin/sandbox/jembatan MCP), `e2e-agent.mjs` (`npm run test:e2e`: HP → relay lokal → daemon → Agent SDK → mock 9router; butuh `npm run dev:relay`), `e2e-cloud.mjs` (`npm run test:e2e:cloud`: provision → `snugcode cloud` → pairing otomatis → setelan dari HP), `worktree.it.mjs` (integrasi git, butuh internet), `e2e-phone.mjs` (simulasi HP manual). |

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
`runtime: 'cloud'` tidak menjalankan anti-sleep/autostart, boleh start tanpa koneksi model (diisi dari HP lewat RPC
`connAdd`/`chatgptLogin`, atau env `SNUGCODE_API_KEY`), dan memeriksa tiap menit apakah ia menganggur (tidak ada agen/`!perintah`/dev server/tunnel, tidak
ada HP yang membuka aplikasi). Setelah `idleStopMinutes` (bawaan 30) codespace dihentikan lewat GitHub API dengan
token `codespace` yang dikirim HP (RPC `runnerConfig`). Saat runner tidur dibuka lagi, PWA menyalakannya (`/start`).

Selama runner belum tersambung, skrip `.devcontainer/` (dan `snugcode cloud` bila konfigurasinya gagal) melaporkan
tahapnya ke relay (`POST /api/runner/status` dengan token mesin: `stage` installing/starting/error, `step`
chromium/install/start, pesan + baris log terakhir). Relay menyimpannya sebagai `boot` di daftar mesin, dan PWA
memakainya untuk progress bar serta pesan error; codespace yang menyala >6 menit tanpa laporan dianggap gagal
(secret tidak sampai / skrip tidak jalan). Batas: maksimal 3 mesin cloud per akun (`provision` menjawab 409), dan
wizard hanya membuat satu runner Codespaces (sisanya *Buat ulang*). Token Codespaces di HP yang ditolak GitHub (401)
langsung dibuang dan PWA menawarkan "Hubungkan lagi". Mesin (PC maupun runner) bisa dihapus langsung dari daftar
mesin tanpa harus tersambung.

### Endpoint relay
| Endpoint | Fungsi |
|---|---|
| `GET /auth/login?kind=user\|machine\|gh` | Login GitHub (web flow). `user` → token PWA di `#login=`; `machine` → menautkan PC yang menunggu (`pc=<kode>`); `gh` → token ber-scope `codespace` untuk PWA di `#gh=…&ghlogin=…` (tidak disimpan relay). Di host lama dialihkan ke `PUBLIC_URL`. |
| `POST /auth/machine/start`, `GET /auth/machine/poll` | Penautan PC dari `snugcode setup` lewat `Pending` DO (kode berlaku 15 menit). |
| `GET /api/me`, `GET /api/machines` | Akun & daftar mesin (`kind`, `provider`, `online`, `lastSeen`, `boot`). |
| `POST /api/machines/provision` | Daftarkan runner cloud tanpa login dari mesinnya; mengembalikan token mesin ke PWA. |
| `POST /api/runner/status` | Laporan tahap runner (token mesin). |
| `DELETE /api/machines/<mid>` | Hapus mesin; soket PC & HP-nya ditutup (4003). |
| `GET /ws/machine`, `GET /ws/phone?mid=` | WebSocket daemon & HP; frame teks atau biner `[cid][payload]`. |
| `GET /api/health` | `devAuth`, `runnerRepo`, dan penanda host lama (`legacy`, `publicUrl`). |

---

## 4. Keamanan & Kriptografi End-to-End (E2EE)

Aspek keamanan `snugcode` dirancang dengan prinsip **Zero Trust** terhadap server relay:

### A. Pairing Awal (CPace PAKE)
- Pengguna menentukan PIN sederhana (6–12 karakter huruf/angka, case-insensitive) di PC saat menjalankan `snugcode setup`.
- PIN di-hash di PC menggunakan **Scrypt KDF** (N=2¹⁵) dengan salt ID mesin (`pocketcode-pin:<machineId>`; label `pocketcode-*` di `shared/crypto.js` adalah identitas protokol dan sengaja tidak diganti saat rebranding) menghasilkan Password-Related String (PRS). PIN asli tidak pernah disimpan dalam plaintext.
- PIN bisa diganti dari PC (`snugcode setup`/`snugcode pin`, berlaku setelah daemon di-restart) atau dari HP yang sudah terpasang (RPC `setPin`, langsung berlaku). Runner cloud memakai PIN acak yang dibuat HP dan dikirim sebagai Codespaces secret, sehingga HP pembuatnya langsung terpasang tanpa mengetik PIN.
- Saat HP pertama kali terhubung, dilakukan pertukaran kunci **CPace** (di atas kurva *Ristretto255*).
- Server relay hanya bertindak sebagai perantara pesan hex. Relay tidak dapat memecahkan PIN secara offline (*offline dictionary attack resistant*).
- Jika ada upaya brute-force, daemon membatasi maksimal 5 kali kegagalan sebelum pairing dikunci (*lockout*).
- Keberhasilan pairing menghasilkan shared secret permanen (`deviceSecret`) 256-bit yang disimpan di `localStorage` HP dan `~/.snugcode/secrets.json` di PC.

### B. Enkripsi Kanal Sesi (Session Channel)
- Setiap kali HP tersambung ulang (*reconnect*), kedua pihak melakukan pertukaran kunci ephemeral **X25519**.
- Kunci diturunkan bersama `deviceSecret` menggunakan **HKDF-SHA256**, menghasilkan sepasang kunci simetris **XChaCha20-Poly1305** independen (arah HP ke PC dan arah PC ke HP).
- Dilengkapi nomor urut pesan (*monotonic sequence counter*) untuk mencegah serangan *replay attack*.
- **Proto 2 (kanal biner)**: bila HP & relay mendukungnya (disepakati saat auth), pesan dikirim sebagai frame biner `[versi][nonce][ciphertext]` dan pesan besar dipecah per 256 KB, sehingga riwayat (4 MB), diff (2 MB), dan screenshot tidak terpotong batas 1 MB relay. Klien/daemon lama tetap memakai frame teks.

### C. Setelan mesin dari HP
- RPC `connAdd`/`connRemove`/`connections` (API key official/router, dideteksi & divalidasi dulu; key tidak pernah dikembalikan), `chatgptLogin`/`chatgptLogout` (Codex, device code), `configure` (bentuk lama: satu router), `devices`, `revoke` (koneksi perangkat langsung diputus), `setPin`, dan `runnerConfig` (khusus runner cloud: token Codespaces untuk berhenti sendiri, menit menganggur).
- `GITHUB_TOKEN`, `GH_TOKEN`, token Codespaces, dan env bootstrap runner (`SNUGCODE_MACHINE_TOKEN`, `_PAIR_PIN`, `_ROUTER_KEY`, `_GITHUB_TOKEN`) dibuang dari environment daemon saat start (`scrubSecretEnv`), sehingga tidak terwariskan ke agen, Bash, dev server, atau `!perintah`.

---

## 5. Alur Kerja Sesi & Manajemen Git Worktree

`snugcode` membedakan tiga jenis sesi yang semuanya terlihat dari HP maupun terminal:

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
- Menghapus sesi lokal hanya menghapus riwayatnya; folder pengguna tidak pernah dihapus. Template `.env` tidak tersedia.

### 3. Sesi Komputer (Mode Komputer)
- Dibuat dari HP (Sesi baru → tab **Komputer**, folder awal opsional; bawaan home), dari TUI (`/computer`, pemilih sesi), atau `snugcode --computer` / `-c` (folder aktif).
- Meta sesi: `computer: true`, `repo: 'Komputer'`, `cwd` folder pilihan; tanpa clone, worktree, atau branch baru. System prompt memakai `SNUGCODE_COMPUTER_PROMPT` (akses seluruh komputer, tidak dibatasi satu repo).
- Izin: tool baca dan edit file lolos tanpa bertanya **di mana pun** (bukan hanya di dalam `cwd`), kecuali mode *Tinjau edit* / mode rencana. Bash yang tidak read-only dan tool lain tetap lewat prompt izin/auto-izin. Penolakan folder data `~/.snugcode`, prompt wajib untuk push/`gh` dan `secrets.json` tetap berlaku.
- Tidak ada checkpoint & rewind (RPC `rewind` ditolak) dan tidak ada template `.env`. Git status/diff dicoba di `cwd`; bila bukan repo, dikembalikan kosong dengan `notRepo`.
- Menghapus sesi hanya menghapus riwayat `.jsonl`; file di PC tidak disentuh.
- Catatan: mode ini juga tersedia di runner cloud (bekerja di dalam container runner).

### 4. Sistem Izin (Permission Gating)
- Agen AI Claude Code dapat memanggil berbagai tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, dll.
- SDK berjalan dengan `permissionMode: 'default'`, jadi setiap tool yang tidak aman lewat `canUseTool` di daemon.
- **Daftar tool eksplisit** (`AGENT_TOOLS`): `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Agent`, `AskUserQuestion`, `ExitPlanMode`, `WebFetch`, `WebSearch` + tool MCP `mcp__snugcode__*`. `EnterPlanMode` dilarang (mode rencana hanya diatur pengguna).
- **Safe Tools**: `TodoWrite`, `WebSearch`, `ToolSearch`, `BashOutput`, subagent `Task`/`Agent`, tool dev non-eksekusi (`dev_stop`, `dev_logs`, `dev_list`, `preview_screenshot` ke localhost), dan tool baca (`Read`, `Glob`, `Grep`, `LS`) **yang sasarannya di dalam worktree** (atau folder config Claude milik agen) langsung diizinkan otomatis. Membaca di luar worktree, `WebFetch`, dan screenshot URL non-localhost meminta izin (atau auto-izin) agar isi file tidak bisa diam-diam dikirim ke luar lewat prompt injection; screenshot `file:` selalu bertanya.
- **Folder data `~/.snugcode`** (API key, login ChatGPT Codex, token GitHub, secret perangkat, template `.env`, binary; kecuali worktree, plans, dan *membaca* folder config Claude milik agen) selalu ditolak untuk tool file, juga saat auto-izin. Menulis ke folder config Claude tetap ditolak karena `settings.json` di sana bisa memasang hook. Perintah Bash yang menyebut `secrets.json` atau subfolder data snugcode selalu meminta izin dan tidak bisa "Selalu diizinkan".
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

## 6. Koneksi Model, Engine (Harness) & Router

### Koneksi
Pengguna menyambungkan model dari HP (**Pengaturan PC → Model & API key**, RPC `connAdd`/`connRemove`/`chatgptLogin`), dari terminal (`snugcode connect`), atau lewat env runner (`SNUGCODE_API_KEY`/`SNUGCODE_API_URL`). Satu koneksi = satu kredensial, disimpan di `secrets.connections[id]` (`kind`, `key`, URL `anthropic`/`openai`, `formats`). ID = jenis provider (`anthropic`, `openai`, `chatgpt`, `gemini`, `openrouter`, `deepseek`, `moonshot`, `zai`, `xai`, `groq`) atau `router`, `router2`, … untuk router/endpoint sendiri.

- **Deteksi** (`detectConnection`): key terlarang ditolak dengan alasan (token langganan Claude `sk-ant-oat…`, OAuth Google `ya29.…`, admin key). Pola key menentukan kandidat provider (`sk-ant-api…` → Anthropic, `AIza…` → Gemini, `sk-or-v1-…` → OpenRouter, `sk-proj-…` → OpenAI, `xai-…`, `gsk_…`, key GLM, dll.); key ambigu (`sk-…`) diuji ke beberapa provider bersamaan. Key yang tidak dikenali butuh URL (router). Format endpoint dideteksi dengan POST body kosong ke `/v1/messages`, `/chat/completions`, `/responses` (400/422 = ada, 404/405 = tidak ada) sehingga tidak memakan token. Endpoint format Anthropic pihak ketiga (DeepSeek, Kimi, GLM, OpenRouter) juga diverifikasi dengan cara ini.
- **Referensi model**: `<koneksi>:<id model>` (mis. `anthropic:claude-opus-5-5-high`, `chatgpt:gpt-5.5`). Model koneksi `router` ditulis tanpa awalan (`cc/claude-opus-5-5`), jadi config & sesi lama tetap berlaku; router lama (`config.routerUrl` + `secrets.routerKey`) dipindahkan otomatis menjadi koneksi `router` dan tetap dicerminkan ke field lama.
- **Daftar model**: `modelsAll` menggabungkan semua koneksi (koneksi yang gagal dilaporkan terpisah); model non-chat (embedding, audio, gambar) dan model yang menyatakan tidak mendukung tool dibuang.

### Engine per model
`engineFor(koneksi, model)` (shared/providers.js) memilih harness:

| Kondisi | Engine | Jalur |
|---|---|---|
| Koneksi `chatgpt` | **Codex** | login ChatGPT milik Codex (`CODEX_HOME`) |
| Endpoint punya Responses API dan model GPT (atau koneksi `openai`) | **Codex** | provider kustom Codex → proxy (rute `responses`) |
| Endpoint punya format Anthropic | **Claude Agent SDK** | proxy (rute `anthropic`), diteruskan apa adanya |
| Hanya OpenAI Chat Completions | **Claude Agent SDK** | proxy (rute `openai`) + penerjemah format |

`SNUGCODE_ENGINE=claude` memaksa Claude Agent SDK untuk endpoint yang juga punya format Anthropic/OpenAI. Sesi menyimpan referensi model, bukan engine; ganti model ke koneksi/engine lain membuat proses agen baru pada prompt berikutnya.

### Engine Codex (`daemon/codex.js`)
- Dipasang sekali ke `~/.snugcode/tools/codex` saat pertama dibutuhkan (versi dipatok; protokol app-server masih eksperimental). Satu proses `codex app-server` per sesi, dipakai ulang antar prompt; thread Codex disimpan di meta sesi (`codexThreadId`) dan dilanjutkan dengan `thread/resume`.
- `approvalPolicy: 'untrusted'`: setiap perintah masuk ke daemon (`item/commandExecution/requestApproval`) dan diputuskan kebijakan snugcode yang sama dengan engine Claude (`decideCodex`): aksi baca saja menurut parser Codex lolos (kecuali menyentuh folder data), aturan "Selalu" per pola perintah, auto-izin, push/`gh` & `secrets.json` selalu bertanya. Perubahan file di dalam worktree diterapkan (kecuali *Tinjau edit*/mode rencana); pertanyaan `request_user_input` jadi kartu AskUserQuestion di HP.
- Sandbox: profil izin `snugcode` (extends `:workspace`, jaringan aktif) menolak membaca `secrets.json`, `config.json`, `codex/`, `claude/`, `env/`, `sessions/`, `daemon.log` di tingkat OS (bubblewrap/Seatbelt). Ketersediaan sandbox diuji sekali (`codex sandbox … echo`); bila tidak tersedia (container tanpa user namespace) Codex berjalan tanpa sandbox OS, pengguna diberi tahu, dan izin tetap lewat snugcode.
- Checkpoint diambil sebelum giliran Codex dimulai (Codex tidak punya hook "tunggu sebelum tool"). Mode rencana = sandbox `readOnly` untuk giliran itu.
- Tool dev snugcode tersedia lewat `mcp_servers.snugcode` → `daemon/mcp-bridge.js` → kanal lokal daemon (token jembatan per sesi; `dev_start` & screenshot URL luar tetap lewat izin).
- Event: delta pesan & reasoning → teks/thinking, `commandExecution`/`fileChange`/`mcpToolCall`/`webSearch` → kartu tool + hasil, `turn/plan/updated` → kartu rencana, `thread/tokenUsage/updated` → token & cache per giliran, `turn/completed` → ringkasan selesai.

### Router (9router, OmniRoute, LiteLLM, …)
Router tetap didukung sebagai koneksi biasa (key + URL). Header SDK disanitasi dan suffix `_ide` dibuang hanya untuk koneksi router. Router yang meneruskan langganan Claude/Antigravity (provider `cc/`, `ag/`) berisiko bagi akun pengguna (lihat §1 butir 6).

### Virtual Effort Level Slider
- Model Gemini membagi tingkat reasoning per ID terpisah (misal `ag/gemini-3.8-flash-low`, `-medium`, `-high`). `snugcode` menyatukannya menjadi **1 pilihan model dengan slider tingkat effort**.
- Model koneksi selain router membawa daftar effort-nya sendiri (`efforts`): Claude 4.5+/5 di koneksi Anthropic (`low`–`max`, opsi `effort` Agent SDK), GPT di OpenAI/ChatGPT (diteruskan ke Codex per giliran), Gemini 2.5+/3 (`low`/`medium`/`high`, ikut di ID dan diterjemahkan proxy menjadi `reasoning_effort`).
- Untuk model native Claude di router (`cc/claude-opus-5-5`, `cc/claude-sonnet-5-5`, atau `claude-*` tanpa provider), daemon menyediakan slider virtual (*auto*, *low*, *medium*, *high*, *max*) yang memetakan ID virtual (mis. `cc/claude-opus-5-5-high`) ke model asli + opsi `effort` Agent SDK. Ganti model/effort diterapkan ke proses yang hidup (`setModel` / `applyFlagSettings({ effortLevel })`).

### Model Ringan Subagen
- Koneksi selain router: model ringan dari **koneksi yang sama** dan keluarga model yang sama (Claude → Haiku terbaru, Gemini → Flash terbaru varian `-low`, DeepSeek → `-flash`/`-chat`, GLM → `-air`/`-flash`); koneksi OpenAI/ChatGPT (Codex) mengatur subagennya sendiri.
- Router lama: subagen (Explore, Plan, general-purpose) dan tugas utilitas (mis. ringkasan WebFetch) memakai **model ringan** yang dipilih otomatis oleh `lightModel()` di `shared/models.js`, hanya dari dua pilihan:
  - Model utama Claude (`cc/` atau `claude-*` tanpa provider): **Claude Haiku 5.5** (`cc/claude-haiku-5-5`), lalu **Gemini 3.8 Flash**.
  - Model utama lain (`ag/`, `gemini/`, …): **Gemini 3.8 Flash** (varian `-low`, provider yang sama didahulukan), lalu **Claude Haiku 5.5**.
  - Keduanya tidak ada di router: memakai model utama.
- Diteruskan lewat `CLAUDE_CODE_SUBAGENT_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (tanpa `_FORCE`, subagen bawaan tetap memakai model utama) dan `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Effort subagen diatur di `daemon/agents.js` (Explore `low`, lainnya `medium`); tanpa itu subagen mewarisi effort model utama.
- Daftar model router diambil di latar belakang saat daemon start (cache 5 menit, boleh basi), jadi prompt tidak pernah menunggu request `/models`. Model ringan untuk model default terlihat di menu PC (HP) dan `snugcode status`; tidak bisa diganti manual.
- Model `claude-*` di provider lain (mis. `ag/claude-opus-4-6-thinking`) **tidak** diberi slider virtual: router-nya tidak mengenal effort, jadi ID diteruskan apa adanya.

### Efisiensi langkah untuk model non-Claude
- Setiap langkah agen = satu request model, jadi jumlah langkah yang menentukan kecepatan. Untuk model non-Claude (mis. Gemini), hook `PreToolUse` `Read|Grep` (`widenToolInput` di `daemon/sessions.js`) melebarkan Read potongan (offset/limit) dari file ≤ 2000 baris / 64 KB menjadi seluruh file, dan Grep tanpa `output_mode` menjadi baris yang cocok + nomor baris (`head_limit` 100). File biner, gambar, PDF, notebook, dan folder data snugcode tidak disentuh; izin tetap lewat `canUseTool`. Model Claude (termasuk `claude-*` di provider lain) tidak dilebarkan.
- Pengaturan env lain untuk menghemat token: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `BASH_MAX_OUTPUT_LENGTH=15000`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

### Pemeriksaan Model (Probe)
- Banyak model AI upstream yang sudah dihentikan (*deprecated*) tetap mengembalikan status HTTP 200 dengan payload teks error ("*...is no longer available*").
- Daftar model diambil dari `/models` tiap koneksi dan disaring ke model yang tidak menyatakan `tools: false`.
- Saat pengguna memilih model di HP, `probeRoute` (`daemon/providers.js`) mengirim satu pesan probe kecil dalam format rute model itu (Messages, Chat Completions, atau Responses; ChatGPT tidak diuji) (*stream probe*) dan menampilkan "✓ siap · 1.2s" atau alasan gagalnya (termasuk deteksi teks "no longer available"). Probe hanya menguji bahwa model menjawab, bukan kemampuan *tool calling*.

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
- Satu proses `claude` per sesi dibiarkan hidup di antara prompt (streaming input Agent SDK) dan ditutup setelah 5 menit menganggur (maksimal 3 proses menganggur sekaligus; yang paling lama tidak dipakai ditutup lebih dulu). Proses disiapkan di latar belakang saat sesi dibuka (pre-warm), jadi prompt pertama tidak menunggu spawn + resume. Ganti model/effort tidak membuat proses baru; proses baru (dengan `resume`) hanya bila model ringan, binary, atau URL berubah.
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
- **Detached Restart**: Daemon menunggu ~1 detik agar balasan RPC terkirim, berhenti, lalu helper child process independen (*detached*) menyalakan daemon baru ~2 detik kemudian. HP terputus beberapa detik lalu otomatis *reconnect* tanpa campur tangan manual di PC. Di runner cloud (`SNUGCODE_SUPERVISED=1`) daemon keluar dengan kode 75 dan supervisor `snugcode cloud` yang menyalakannya lagi.
- **Progress di HP**: pembaruan dari HP tampil sebagai tahap *pasang → restart → tersambung lagi* dengan perkiraan sisa waktu.

### B. Anti-Sleep Service (`daemon/keepawake.js`)
Mencegah PC masuk ke mode tidur (*system sleep*) selama daemon berjalan (dimulai saat daemon start, berhenti saat daemon berhenti; tidak dipakai di runner cloud):
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
Output perintah di-stream secara real-time ke layar HP (maks. 512 KB, dihentikan setelah 10 menit). Untuk perintah yang berjalan terus (dev server), pakai **Run & Preview**. pnpm/yarn yang tidak terpasang disiapkan otomatis lewat corepack (`daemon/toolchain.js`), juga untuk Bash agen dan proses Run.

### D. Run & Preview (lihat hasil web app dari HP sebelum commit)
- Tombol **▶** di header sesi → **Jalankan**. Perintah setup (`npm ci`, `pnpm install`, `yarn install`, `bun install`) dan dev (script `dev`/`start`/`serve`/`preview`; juga `python manage.py runserver` dan `npx serve` untuk situs statis) terdeteksi otomatis, atau bisa diketik manual. Bisa juga ditimpa lewat `.snugcode.json` (atau `.pocketcode.json` lama) di root repo: `{ "setup": "…", "dev": "…" }`.
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
- **Akun ChatGPT** atau **API key model** apa pun (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Kimi, GLM, xAI, Groq, atau router seperti 9router/OmniRoute)
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
| `snugcode --computer` / `-c` | Membuka TUI dengan sesi Mode Komputer di direktori aktif. |
| `snugcode setup` | Menjalankan ulang panduan konfigurasi (API key, model, GitHub, PIN). |
| `snugcode login` | Login ulang GitHub saja (token dicabut/kedaluwarsa); langsung berlaku tanpa restart bila daemon berjalan. |
| `snugcode connect <key> [--url URL]` | Menyambungkan API key model; jenis & format dideteksi otomatis (lewat daemon bila berjalan). |
| `snugcode connect chatgpt` | Login ChatGPT lewat Codex (daemon harus berjalan); kode bisa diselesaikan di HP. |
| `snugcode connect` / `snugcode disconnect <id>` | Daftar koneksi model / menghapus satu koneksi. |
| `snugcode start` | Menjalankan daemon di foreground terminal ini. |
| `snugcode stop` | Menghentikan daemon yang sedang berjalan di background. |
| `snugcode restart` | Me-restart daemon background. |
| `snugcode update` | Memeriksa dan menginstal pembaruan snugcode terbaru dari GitHub. |
| `snugcode autostart on\|off` | Mengaktifkan/menonaktifkan auto-start daemon saat user login OS. |
| `snugcode clean` | Memindai & menghapus worktree, repo, dan log yatim (dibatalkan bila `sessions/index.json` tidak terbaca). |
| `snugcode pin` | Mengganti PIN pairing dan membuka kunci lockout jika terblokir (restart daemon agar berlaku). |
| `snugcode devices` | Melihat daftar perangkat HP yang saat ini terpasang (*paired*). |
| `snugcode revoke <id\|all>` | Mencabut izin akses perangkat HP tertentu atau semua perangkat (restart daemon agar berlaku). |
| `snugcode status` | Menampilkan ringkasan konfigurasi: runtime, relay, akun, model & model ringan, login GitHub, jumlah HP, status kunci PIN. |
| `snugcode cloud` | Runner cloud: konfigurasi dari env (`daemon/runner.js`), daemon di bawah supervisor (`--no-supervise` untuk langsung). |
| `snugcode help` | Daftar perintah. |

Flag non-interaktif `setup`: `--router`, `--key`, `--model`, `--github device|cred|pat|skip`, `--github-token <token>`, `--skip-github`, `--relay`, `--name`, `--pin`, `--relink`, `--no-browser`.

### Struktur Penyimpanan Data Lokal (`~/.snugcode/`)
- Lokasi bisa diganti dengan `SNUGCODE_HOME`; instalasi lama yang sudah punya `~/.pocketcode` tetap memakai folder itu. Runner Codespaces: `/workspaces/.snugcode`; Docker: `/data`.
- `config.json`: Konfigurasi umum (nama mesin, ID, URL relay, router URL, default model, `runtime`, `runner`, `installedCommit`).
- `secrets.json`: Kredensial lokal (token relay mesin, token GitHub, PIN PRS, device secret & langganan push HP terdaftar, token lokal IPC, token Codespaces runner). Izin berkas dibatasi (mode 600 di UNIX). Ditulis atomik (tmp + rename).
- `daemon.log`, `daemon.pid`, `daemon.sock`: Log, ID proses, dan unix socket IPC untuk TUI (Windows: named pipe `\\.\pipe\pocketcode-<hash>`). Runner cloud: `cloud.log` & `install.log`.
- `workspaces/<owner>__<repo>/`: Base clone (`_base`, disimpan 3 hari setelah sesi terakhir dihapus) dan direktori git worktree per sesi coding (`s-<id>`).
- `sessions/`: `index.json` (daftar sesi; bila rusak disimpan sebagai `index.json.broken-*` dan sesi dipulihkan dari worktree) dan riwayat event JSONL per sesi (`<sessionId>.jsonl`).
- `env/`: Template `.env` per repo. `bin/`: `cloudflared` dan shim pnpm/yarn (`bin/pm`). `tools/`: corepack.
- `claude/`: Direktori konfigurasi khusus Agent SDK (`CLAUDE_CONFIG_DIR`, termasuk `plans/`) terpisah dari instalasi Claude Code pengguna.

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
- [x] Runner cloud tanpa PC: GitHub Codespaces (dibuat & dinyalakan dari HP) dan Docker; setelan mesin (model & API key, PIN, perangkat) dari HP.
- [x] Mode Komputer (sesi dengan akses seluruh PC) di HP dan terminal.
- [x] Hook pelebar Read/Grep untuk model non-Claude (±3× lebih sedikit request model).
- [x] Laporan tahap runner, progress bar dengan perkiraan sisa, hapus mesin dari daftar, sambung ulang izin Codespaces.
- [x] Workflow Deploy (relay + PWA dari GitHub Actions).
- [x] Koneksi multi-provider: login ChatGPT (Codex) & API key apa pun dengan deteksi otomatis; engine per model (Claude Agent SDK / Codex), penerjemah format OpenAI, sandbox OS untuk Codex.
- [ ] Engine Gemini CLI (ACP) untuk model Gemini, dan benchmark harness per model (tabel engine bawaan dari data).
- [ ] Tampilan kuota Codespaces, notifikasi "runner berhenti", dan prebuild codespace.
- [ ] Integrasi OS Keychain (Windows Credential Manager / macOS Keychain / Linux SecretService) untuk `secrets.json`.
- [ ] Panel Terminal Interaktif PTY penuh di HP.
- [ ] Tunnel preview E2EE lewat relay sendiri (Service Worker), pengganti quick tunnel Cloudflare.
- [ ] File explorer/editor ringan dan review diff per hunk dengan komentar ke agen.
