# Changelog

Notable changes to snugcode (formerly pocketcode). Features are described in the [user guide](docs/guide.md). Entries
for releases up to v0.4.0 are kept in their original language (Indonesian). Older entries may mention the relay,
landing page, or internal docs, which are no longer part of this repo.

## 2026-10-24 — v0.5.0: open client (AGPL-3.0), supply-chain & sandbox hardening, app lock, prompt queue

### Security
- **Installers only install from the official GitHub repo** (latest release tag). They used to install whatever
  package was called `snugcode` on npm, a name nobody had claimed yet. `SNUGCODE_PACKAGE` overrides the source.
- **Pinned dependencies for users** (`npm-shrinkwrap.json`): global and git installs ignored `package-lock.json`.
- **The hosted PWA is deployed from release tags only**, and `build.json` records the source `commit`.
- **No OS sandbox → auto-approve only runs routine commands** (Claude engine, e.g. on Windows): other Bash commands
  ask, so the agent can't quietly read `~/.snugcode/secrets.json`. `"sandbox": "off"` is the explicit opt-out.
- **Codex sandbox checked for real**: the start-up probe runs snugcode's profile and must fail to read a file in the
  data folder. On Windows Codex can't apply that profile, which broke every sandboxed command; it now asks instead.
- **CI, dev container, editor-task and hook files always ask** before the agent changes them (`.github/workflows`,
  `.github/actions`, `.devcontainer`, `.vscode`, `.husky`, `.envrc`).
- **Unrecognized API keys are never sent to a default router**: give the router URL.
- **Machine tokens are renewed by the relay** (weekly), so its signing key can be rotated without re-linking PCs.
- **App lock** (Account & appearance): the phone's fingerprint, face, or PIN (WebAuthn) before the app opens.

### New
- **Prompt queue**: prompts sent while the agent works wait in the session (max 10, from any phone or terminal) and
  run one by one; remove them above the composer, Stop clears them.
- **Token usage for every engine** in Cost & limit (Codex and Gemini CLI report tokens, not cost).

### Fixed
- **Checkpoints older than ~2 weeks can be rewound again**: `git gc` used to delete them (they're now kept under
  `refs/snugcode/cp/` in snugcode's worktrees and dropped with the session).
- **The diff view no longer leaves intent-to-add entries in your index** (local sessions).
- **Fewer writes and relay messages**: session-list writes are coalesced; terminal output floods are batched every
  50 ms over the relay (typing echo stays at 16 ms).
- **The service worker only caches the app**, not the website's pages.

### Changed
- **New license: GNU AGPL-3.0** (from MIT) for all code in this repo from now on. Code published earlier stays MIT. The
  snugcode name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md), and contributions are accepted under the
  [CLA](CLA.md).
- **Open client, hosted relay.** This repo contains everything that runs on your devices: the daemon, the PWA, the
  encryption & protocol, and the cloud runner image. The relay and website at snugcode.dev are now maintained
  separately as a hosted service. The PWA it serves is still built from this repo and can be verified against
  `build.json` ([docs/security.md](docs/security.md)), which now also lists what the relay can and can't see.
- **`npm run build:web` builds into `dist/web`** (`SNUGCODE_WEB_OUT` to change it). Security headers moved to
  `shared/headers.js`.
- **`npm run dev:relay` starts a small local relay** (`test/dev-relay.mjs`: in memory, loopback only, dev sign-in) that
  speaks the same protocol, so the e2e tests and local development need no Cloudflare account or wrangler.
- **Shorter README**; the full reference moved to [docs/guide.md](docs/guide.md).

### New
- **snugcode is now in English.** The whole product — the snugcode agent PWA, the CLI/TUI, relay pages, the landing
  page, and the docs (`README.md`, `master.md`, `CONTRIBUTING.md`, `docs/security.md`, formerly `docs/keamanan.md`) —
  is in English, to reach a wider audience. `README.en.md` was merged into `README.md`.
- **Landing page redesigned for mobile.** Responsive layout and a smoother flow on phones: a lighter hero, cards and
  pricing that fit small screens, and touch-friendly navigation.
- **snugcode Cloud landing page at `snugcode.dev`; the app (now *snugcode agent*) moved to `snugcode.dev/agent/`.**
  The landing page (`landing/`) has features, how it works, a deploy demo, pricing + a server configurator, and an FAQ.
  The **Open snugcode agent** button opens the agent directly when signed in; otherwise it offers **Sign in with GitHub**
  or **Create a new account** (`/auth/login?signup=1`), then returns to where you came from (`next=/` or `/agent/`, only
  those two paths). The sign-in is shared (`pc.token`, same origin). Nothing needs to be reinstalled: the service worker
  stays at `/sw.js` (scope `/`) so push notifications keep working, and home-screen apps, notification links, and
  `#gh=`/`#import=` links that still point to `/` are forwarded to `/agent/`. `install.sh`/`install.ps1` stay at the root.

### Fixes
- **Runners/PCs that die suddenly no longer look online.** A codespace that is stopped abruptly (or a PC that loses
  power / its network) has no chance to close its socket to the relay, and Cloudflare keeps that socket open, so the
  machine showed as online forever and the phone tried to connect in vain. The relay now uses the daemon's ping (every
  25 seconds, answered automatically): a machine socket without a ping for 80 seconds is closed (code 4006) and the
  machine is marked offline, checked when the machine list is opened, when a phone connects/sends a message, and
  periodically (alarm) while a phone is connected. A stopped Codespaces runner is now started right away when it is
  opened from the app.
- **A Codespaces runner whose daemon died no longer gets stuck at "waiting for snugcode to connect…".** The daemon was
  only started when the codespace started (`postStartCommand`), so a daemon that died while the codespace stayed up
  never came back. Now:
  - the `snugcode cloud` supervisor restarts a daemon that was hit by a signal (e.g. `pkill node` / `killall node` from
    the agent); a supervised daemon exits with 128+signal, not 0. On Codespaces the supervisor also ignores SIGTERM
    (deliberate stops: `snugcode stop` or from the app; stopping the codespace still shuts everything down);
  - the app restarts the codespace once (stop → start) if it has been running for 45 seconds without the runner
    connecting or reporting, and shows an error with a hint about `cloud.log` (a *Try again* button) if the runner is
    still silent after 6 minutes — previously the screen waited forever.
- **The PWA icon on iPhone no longer shows up as the letter "S".** iOS generates a letter icon when `apple-touch-icon`
  can't be fetched during "Add to Home Screen"; on iOS 27 that sheet's loader fails to fetch icons from network URLs.
  The 180×180 icon is now inlined as a `data:` URI in `index.html` at build time (`sizes="180x180"`), and
  `apple-touch-icon-precomposed.png` is also served at the root for iOS versions that look for it directly. The SVG icon
  was removed from `manifest.webmanifest` (iOS can only use PNG icons for the home screen) and replaced by a 180×180 PNG.
- **The PWA on iPhone (iOS 26) now reaches the bottom edge and the header is no longer blurred.** WebKit bug 301108:
  with `viewport-fit=cover` + the `black-translucent` status bar, the installed app's viewport is made shorter than the
  screen, so the composer floated above an empty strip. `html` is now as tall as the screen in standalone mode. The iOS
  26 "Liquid Glass" scroll-edge effect that blurs the strip under the status bar (which can't be turned off) is avoided
  with extra top spacing in a solid background color for the header, drawer, sheets, toasts, and terminal (installed
  iOS only).
- System notes (e.g. "OS sandbox not available") no longer show a double "◆ ◆" icon, and the same warning is shown once
  per session even if the daemon restarted.
- **Typing in the terminal from an Android phone now shows up immediately.** Phone keyboards (Gboard, Samsung,
  SwiftKey) type through IME composition; xterm.js only forwarded a word after space/Enter (the screen looked frozen
  while typing), and letters with keydown 229 outside a composition could be lost entirely. On touch screens, changes to
  the xterm textarea are now sent to the shell as they happen, as a diff (`imeDelta` in `web/termkeys.js`: DEL for
  removed characters + new characters), including Backspace through the IME, autocorrect, swipe typing, and voice
  input. Physical keyboards are still handled by xterm without doubled letters. Tested by `test/e2e-ui.mjs` (IME
  composition through CDP) and unit tests.
- **The PWA no longer gets stuck at "Contacting relay" after the phone is reopened.** A WebSocket stuck in the
  connecting stage (a phone that just woke up, a mobile network swallowing packets) used to have no timeout, and
  `wake()` ignored it, so the screen could sit still for minutes while the PC list (over plain HTTP) showed "online".
  Now a socket without a relay answer within 10–30 s is replaced, reopening the app immediately replaces a stuck socket,
  a PC that doesn't answer auth within 20 s is retried on a new channel, and the connecting screen shows the attempt
  number and a **Try now** button. Tested by `test/e2e-resume.mjs` (a proxy that holds connections).
- The snugcode data folder stays closed in the file explorer when its path goes through a symlink (macOS `/var` →
  `/private/var`).

### Improvements
- **Landing page is much lighter, same look.** Measured idle (headless Chromium, 4× CPU throttle, phone viewport), the
  main thread went from ~100% busy to 0–40% depending on the section. Decorative CSS loops pause in sections that are
  off screen; animated `box-shadow`/`background-position`/`z-index` (status dots, glows, badge shine, model deck) became
  transform/opacity animations the compositor runs alone; the hero's `blur(90px)` blobs became equivalent gradients;
  the scroll handler no longer forces a layout per frame. The hero plays its entrance from the first paint instead of
  waiting for `landing.js`. Transfer 304 → 214 KB: the landing serif is cut to the weights it uses
  (`scripts/landing-fonts.py`, optical sizes kept), and CSS/JS are minified into content-hashed `/assets/` cached for
  a year.
- **PWA zoom is locked like a native app**: viewport meta `maximum-scale=1, user-scalable=no`, `touch-action:
  pan-x pan-y` on every element (pinch & double-tap don't zoom, scrolling still works), and Safari iOS pinch gestures
  (which ignore `user-scalable`) are cancelled in `web/ui/dom.js`.
- **Text size** (Account & appearance: Small / Normal / Large / Extra large) as a replacement for page zoom, for
  accessibility: CSS `zoom` on the screen content, sheets & drawer, applied by `theme.js` before the first render (no flash).
- **Phone terminal**: a two-finger pinch changes the font size (8–24 px, remembered per device); **Paste** (clipboard
  contents through bracketed paste — long-pressing the xterm screen gives no Paste menu), **Copy** (selected text, or the
  whole screen with wrapped lines joined), **Home**, and **End** buttons.
- Terminal assets (`xterm.js`, `xterm.css`) are downloaded while the phone is idle as soon as a session with a terminal
  is opened, so opening the terminal on a weak signal no longer fails with "Failed to load terminal".
- Long-pressing buttons no longer selects text or brings up a copy menu.

## 2026-10-20 — v0.4.0: keamanan relay, koneksi tahan banting, izin bertingkat risiko, biaya sesi

### Keamanan
- **Penautan PC tidak bisa lagi dilewati lewat link.** Dulu halaman "Hubungkan PC?" muncul sebelum login GitHub dan
  bisa dilewati dengan menambahkan `confirm=1` ke URL (PC orang lain tertaut ke akunmu tanpa klik). Kini konfirmasi
  tampil *setelah* login (nama PC, kode, akun) dan dikirim lewat POST dengan token `link` bertanda tangan
  (`/auth/machine/confirm`).
- **CSP `connect-src`** hanya ke relay sendiri (`'self'` + `wss://` alamat dari `wrangler.jsonc`), bukan `wss:` ke host
  mana pun.
- **Token WebSocket lewat subprotocol** (`snugcode, t.<token>`), tidak lagi di query string yang tercatat di log. Relay
  tetap menerima `?token=` untuk klien lama; daemon memakai subprotocol bila `/api/health` menyatakan `wsProto`.
- **Perpanjangan login** (`POST /api/renew`, maks. sekali sehari dari PWA): HP yang dipakai rutin tidak lagi dipaksa
  login ulang setiap 30 hari. Token yang dicabut (logout-all) tidak bisa diperpanjang.
- **cloudflared dipatok versi + SHA-256** (`daemon/cloudflared-version.json`), bukan `releases/latest` tanpa verifikasi.
- **Model ancaman yang jujur** — [`docs/keamanan.md`](docs/security.md): apa yang dilindungi & tidak (relay juga
  menyajikan kode PWA), cara memverifikasi build, cara self-host relay. Klaim "relay tidak bisa membaca apa pun"
  di README & layar login diperjelas.

### Infrastruktur
- **Deploy hanya setelah CI lulus** (`workflow_run`), memakai commit yang lulus CI, lalu smoke test: `build.json`
  yang disajikan relay harus sama dengan hasil build commit itu.
- **Build PWA yang bisa diverifikasi**: `npm run build:web` menulis `build.json` (SHA-256 tiap file + digest); rilis
  GitHub melampirkannya.
- **Observability Workers** aktif untuk relay & worker alias.
- **Pemasang satu baris** — `curl -fsSL https://snugcode.arfak.workers.dev/install.sh | sh` /
  `irm …/install.ps1 | iex`: cek Node.js 22+ & git, pasang snugcode, lalu `snugcode setup`.
- Tabel RPC dipindah dari `daemon/server.js` ke `daemon/rpc.js`.

### Koneksi
- **Heartbeat dengan batas waktu** di daemon & HP: soket setengah mati (ganti Wi-Fi ↔ seluler, PC bangun dari tidur)
  dideteksi dari `pong` yang tidak datang dan langsung disambung ulang. HP juga menguji koneksi saat aplikasi dibuka
  lagi atau jaringan kembali (`online`).
- **Timeout RPC** (30 dtk; 3 mnt untuk operasi lama seperti clone, update, push): tombol & spinner tidak lagi menunggu
  selamanya, dengan pesan yang jelas.

### Pengalaman pengguna
- **Kartu izin bertingkat risiko** (`shared/risk.js`): label rendah/sedang/tinggi + alasan, di HP dan TUI. Risiko
  tinggi tampil merah tanpa tombol *Selalu*. Jaring pengaman terlihat: "Bisa dibatalkan: rewind".
- **Preset otonomi agen** (RPC `autonomy`, TUI `/otonomi`): *Tanya semua*, *Seimbang*, *Rutin otomatis* (test, lint,
  typecheck, build tanpa rangkaian perintah lolos sendiri), *Penuh*.
- **Biaya sesi & batas biaya** (RPC `budget`): biaya Agent SDK (total berjalan per proses) diubah menjadi biaya per
  giliran + total sesi; peringatan di 80%, prompt ditahan saat batas tercapai. Ringkasan selesai menampilkan
  `$giliran · sesi $total` (dulu angka biayanya total berjalan yang terlihat seperti biaya per giliran).
- **Izin dari notifikasi**: tombol *Izinkan / Tolak* untuk risiko rendah/sedang; isi notifikasi memuat perintahnya.
  Preferensi *Kabar yang dikirim: Semua / Penting saja*.
- **Tambah PC**: perintah pemasang per OS, lalu HP memantau dan membuka PC baru begitu tertaut.
- **Chip langkah berikutnya** setelah agen selesai/gagal, dan **prompt tersimpan per repo**.
- **Kontras WCAG AA** untuk teks redup, aksen, peringatan, dan tombol (gelap & terang).
- Copy usang ("Agen Claude Code", "Claude Code harness + 9router") diganti sesuai produk multi-model; istilah
  "harness" di layar koneksi disederhanakan.

## 2026-10-20 — v0.3.0: file & terminal dari HP, engine Gemini CLI, keychain OS

### Dari HP
- **File explorer** (menu sesi → File) — `daemon/files.js`, `web/ui/files.js`. Telusuri worktree, baca teks &
  gambar, edit atau buat file. Menyimpan file yang sudah berubah di PC ditolak (hash), dan agen diberi tahu di prompt
  berikutnya bahwa pengguna mengubah file. Hanya di dalam folder sesi: folder data snugcode ditolak, symlink keluar
  disembunyikan. *Tanya agen* mengisi composer dengan path file.
- **Review diff per hunk** — layar Git: komentar per baris/hunk dikirim sebagai satu pesan ke agen (*Kirim ke agen*),
  dan *Batalkan hunk / file* (`git apply -R`; file baru dihapus). Ditolak saat agen berjalan.
- **Terminal interaktif (PTY)** (menu sesi → Terminal) — `daemon/pty.js`, `web/ui/terminal.js`. xterm.js (dimuat
  terpisah, app.js tetap ringan), baris tombol Esc/Tab/Ctrl/Alt/panah, sampai 4 tab per sesi. Shell tetap hidup saat
  layar ditutup atau koneksi putus; membukanya lagi memutar ulang output terakhir. Paket opsional `@lydell/node-pty`.

### Engine
- **Gemini CLI (ACP)** untuk model Gemini dengan API key Google AI — `daemon/gemini.js`, `daemon/engine-gemini.js`.
  Harness resmi Google dengan format API asli (tanpa penerjemah), dipasang otomatis sekali (versi dipatok di
  `gemini-version.json`); bila gagal dipasang, model dijalankan Claude Agent SDK seperti sebelumnya. Key asli tetap
  hanya di proxy (`x-goog-api-key` ditukar), izin lewat kebijakan snugcode yang sama, edit file lewat snugcode
  (checkpoint, folder data ditolak), sesi dilanjutkan dengan `session/load`. Konfigurasi `.gemini/` milik repo tidak
  dijalankan (folder tidak tepercaya); instruksi proyek (`GEMINI.md`/`AGENTS.md`/`CLAUDE.md`) disisipkan snugcode.
  Gemini CLI tidak punya sandbox OS, jadi perintah shell tetap bertanya saat auto-izin.
- **Tabel engine & benchmark** — `shared/engine-table.js` dibaca `engineFor` sebelum aturan format; `npm run bench`
  (`scripts/bench.mjs`) mengukur engine per model dengan tugas yang sama dan mencetak saran baris tabel.
  `SNUGCODE_ENGINE` kini menerima `claude`, `codex`, atau `gemini`.

### Keamanan
- **`snugcode keychain on|off|status`** — `daemon/keychain.js`. `secrets.json` dienkripsi (XChaCha20-Poly1305) dengan
  kunci di keychain OS: macOS Keychain, Secret Service (GNOME Keyring / KWallet, `secret-tool`), atau DPAPI di
  Windows. Bila kunci tidak bisa dibuka, daemon berhenti dengan pesan jelas tanpa menimpa secrets.
- `.gemini/` di repo ikut dilindungi (edit selalu bertanya), dan `secrets.key` & folder `gemini/` ikut dalam
  pola perintah yang selalu bertanya.

### Runner cloud
- **Perkiraan kuota Codespaces** di menu runner: core-jam bulan ini (dicatat runner sendiri, karena billing GitHub
  tidak bisa dibaca dengan izin `codespace`).
- **Prebuild**: pemasangan dipindah ke `onCreateCommand` agar ikut snapshot prebuild (runner baru ±1 menit). Prebuild
  diatur di setelan Codespaces fork (tidak ada API); panduan di `.devcontainer/README.md` dan tautan di wizard.

### Proyek
- Uji baru: `test/features.test.js` (explorer, konflik, revert hunk, PTY, keychain, Gemini, kuota runner),
  `test/e2e-gemini.mjs` (Gemini CLI asli vs Gemini API tiruan, juga di CI), skenario UI explorer/review/terminal di
  `test/e2e-ui.mjs`. Versi 0.3.0.
- Ditunda dengan alasan: tunnel preview E2EE lewat relay (butuh origin terpisah dari PWA & WebSocket HMR), Amazon
  Bedrock / Vertex AI (butuh penandatanganan SigV4 / OAuth di proxy).

## 2026-10-20 — v0.2.0: pengamanan agen & relay, rilis bertag + rollback

### Agen
- **Sandbox OS saat auto-izin (engine Claude)** — `daemon/sandbox.js`. Sebelumnya Bash auto-izin hanya dijaga
  regex, dan `cat ~/.snug*/s*.json` terbukti membaca API key (diuji dengan Agent SDK asli). Kini proses `claude`
  sesi auto-izin memakai sandbox Claude Code (bubblewrap + socat / Seatbelt): folder data tidak terbaca, hook &
  config git tidak bisa ditulis, worktree + cache paket + jaringan tetap jalan. Perintah yang minta keluar dari
  sandbox selalu bertanya. Dukungan dideteksi sendiri (termasuk probe user namespace) karena Claude Code diam-diam
  berjalan tanpa sandbox bila dependensi tidak ada; sesi memberi tahu bila tidak tersedia. Opsi `config.sandbox`
  (`auto` | `always` | `off`) / `SNUGCODE_SANDBOX`. Runner Docker & Codespaces memasang bubblewrap + socat.
- **Setelan proyek Claude Code tidak dimuat lagi** (`settingSources: []`): `.claude/settings.json` dari repo bisa
  memasang hook, aturan izin, env, atau `apiKeyHelper` yang lolos dari kebijakan snugcode. `CLAUDE.md` dan
  `.claude/CLAUDE.md` tetap dibaca sebagai instruksi proyek.
- **Konfigurasi tool di repo dilindungi**: edit ke `.claude/`, `.codex/`, `.mcp.json`, dan `.git/` selalu bertanya
  (kedua engine, juga saat auto-izin).
- Refactor: `daemon/permissions.js` (kebijakan izin), `daemon/engine-claude.js`, `daemon/engine-codex.js`;
  `sessions.js` turun dari 1.392 ke ±1.040 baris.

### Relay & PWA
- Token `state` OAuth punya jenis sendiri: sebelumnya token state di URL GitHub lolos sebagai token user
  (akun bersama tanpa `sub`).
- **Keluar dari semua perangkat** (Akun → menu; `POST /api/logout-all`): token login dicabut di relay.
- Menautkan PC lewat link menampilkan halaman konfirmasi berisi nama & kode PC.
- Maks 20 mesin per akun; rate limit per IP untuk login & pendaftaran mesin.
- CSP ketat & security header untuk PWA (`relay/src/headers.js`); skrip tema dipindah dari inline ke `theme.js`;
  font di-host sendiri (tanpa Google Fonts).

### Daemon
- Kunci PIN berbatas waktu (15 menit, berlipat dua, maks ±16 jam), bukan permanen sampai `snugcode pin`.
- **Rilis bertag + rollback**: kanal `stable` (bawaan) memasang rilis GitHub terbaru, `main` commit terbaru (dipatok
  ke SHA). `snugcode update --rollback` / tombol "Kembali ke versi sebelumnya" di HP. Workflow `Release` (tag
  `vX.Y.Z`).
- Runner cloud mengirim Web Push "runner dihentikan" sebelum berhenti karena menganggur.

### Proyek
- `LICENSE` (MIT), Dependabot, versi 0.2.0, Agent SDK 0.3.304.
- Uji baru: `test/hardening.test.js`, `test/e2e-relay.mjs` (CI), skenario e2e Bash auto-izin di sandbox; CI
  memasang bubblewrap + socat sehingga jalur sandbox benar-benar diuji.

## 2026-10-17 — Model apa pun, harness terbaik per model: login ChatGPT, API key otomatis, engine Codex

Analisis & alasan desain: [`docs/analisis-harness-dan-provider.md`](docs/analisis-harness-dan-provider.md).

### Koneksi model (pengganti "key 9router")
- **Model & API key** di HP (Pengaturan PC), `snugcode connect` di terminal, atau `SNUGCODE_API_KEY` di runner:
  tempel API key apa pun — Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Kimi, GLM, xAI, Groq — atau key router
  (9router, OmniRoute, LiteLLM, lokal) beserta URL-nya. Jenis key dikenali dari polanya (petunjuk tampil saat diketik),
  key ambigu diuji ke beberapa provider sekaligus, format endpoint (Anthropic / OpenAI Chat / Responses) dideteksi
  tanpa memakan token, lalu daftar model dan model default terisi otomatis.
- **Login ChatGPT** (Plus/Pro) lewat Codex resmi dengan kode perangkat yang bisa diselesaikan di HP
  (`daemon/codex.js`, RPC `chatgptLogin`; `snugcode connect chatgpt`).
- Token langganan Claude (`sk-ant-oat…`), OAuth Google, dan admin key ditolak dengan penjelasan: Anthropic & Google
  melarang langganan Pro/Max / login Gemini CLI dipakai aplikasi pihak ketiga.
- Banyak koneksi sekaligus; model dirujuk `<koneksi>:<model>`. Router lama (`routerUrl` + `routerKey`) dipindahkan
  otomatis menjadi koneksi `router` dengan referensi model yang sama, jadi sesi lama tetap jalan. Pemilih model
  mengelompokkan per koneksi, menampilkan engine, dan koneksi yang gagal.

### Engine per model
- **Claude Agent SDK** untuk model Claude dan endpoint format Anthropic (langsung ke `api.anthropic.com` dengan
  `x-api-key` & prompt cache native; endpoint Anthropic DeepSeek/Kimi/GLM/OpenRouter).
- **Codex** (`codex app-server`, versi dipatok) untuk model GPT (ChatGPT, OpenAI, router dengan Responses API):
  izin perintah/perubahan file/pertanyaan lewat kebijakan snugcode yang sama, checkpoint sebelum giliran, sandbox
  OS yang menolak membaca folder data snugcode, tool `dev_*`/`preview_screenshot` lewat jembatan MCP
  (`daemon/mcp-bridge.js`). Key API tidak pernah diberikan ke Codex (provider kustom → loopback proxy).
- **Penerjemah format** (`daemon/translate.js`): endpoint yang hanya punya OpenAI Chat Completions (Gemini API, Groq,
  xAI, router) tetap bisa dipakai Claude Agent SDK — tool call & hasil, gambar, stream, error, cache token, skema tool
  & thought signature Gemini 3, effort → `reasoning_effort`.
- Loopback proxy kini multi-rute: satu token lokal per koneksi+format; key yang diganti dari HP langsung berlaku.
- Model ringan subagen dari koneksi yang sama (Haiku, Flash, …); `SNUGCODE_ENGINE=claude` memaksa Claude Agent SDK.

### Lainnya
- Branding: snugcode tidak lagi menyebut dirinya "Claude Code" (pedoman Agent SDK).
- Uji: `test/providers.test.js` (deteksi, routing, penerjemah, proxy, Codex, login ChatGPT tiruan) dan
  `npm run test:e2e:connections` (koneksi dari HP, penerjemah dengan Claude Agent SDK asli, Codex asli dengan izin dari
  HP, sandbox, jembatan MCP; juga di CI).

## 2026-10-16 — Izin Codespaces yang ditolak bisa disambung lagi (#8)

- Saat GitHub menolak token Codespaces di HP (401: dicabut/kedaluwarsa), token itu langsung dibuang
  (`Codespaces` `onAuthError`) dan layar menawarkan jalan keluar, bukan hanya pesan error:
  - menyalakan runner: tombol **Hubungkan lagi GitHub Codespaces** (setelah kembali ke aplikasi, runner
    dinyalakan otomatis); kegagalan lain mendapat tombol **Coba lagi**;
  - menu runner, hapus mesin, dan wizard: 401 membuka konfirmasi / tombol hubungkan lagi;
  - menu runner: **Hubungkan ulang GitHub Codespaces** selalu tersedia.
- Uji: unit (`onAuthError`) dan e2e-cloud di Chromium (api.github.com 401 → tombol muncul, token dibuang).

## 2026-10-15 — Progress yang jelas untuk proses lama (#6, #7)

- Komponen progress (`web/ui/progress.js`, perhitungan di `web/eta.js`): bar yang terus bergerak,
  daftar tahap (selesai / sedang / berikutnya), waktu berjalan, dan perkiraan sisa. Di dalam satu
  tahap bar maju mengikuti perkiraan durasinya dan melambat mendekati akhir, jadi tidak pernah penuh
  sebelum tahapnya selesai; tahap yang jauh melewati perkiraan diberi keterangan "lebih lama dari
  biasanya, masih berjalan". Durasi nyata tiap tahap dipelajari per HP, jadi perkiraan makin tepat.
- Dipakai di: membuat runner cloud (tahap mengikuti status codespace dan laporan runner —
  Chromium / snugcode / menyalakan), menyalakan runner yang tidur, menghubungkan ke mesin,
  pembaruan PC dari HP (pasang → restart → tersambung lagi), membuat sesi repo (clone), dan push.
- Runner melaporkan langkahnya (`step`) ke relay bersama tahap & pesan.
- Mesin bisa dihapus langsung dari daftar (tombol ⋯ atau tekan lama), juga saat offline atau macet. PC
  dihapus dari akun (daemon langsung terputus) dan pairing di HP dibersihkan; runner Codespaces ikut
  menghapus codespace + secret bila HP punya izin Codespaces (bila tidak, diberi tahu untuk menghapus
  manual); runner server diingatkan menghentikan container-nya.
- Uji `procs` di Windows memakai batas bawaan `waitPort` (30 dtk), bukan 10 dtk yang lebih ketat dari
  kodenya sendiri (sebelumnya gagal sesekali di runner CI Windows).

## 2026-10-15 — Runner melaporkan tahap & error ke HP, workflow Deploy (#4, #5)

### Runner yang macet tidak lagi diam
- `.devcontainer/lib.sh`: runner melaporkan tahap (memasang, menyalakan, error + baris log terakhir) ke
  relay lewat `POST /api/runner/status` dengan token mesinnya; relay menyimpannya sebagai `boot` di
  `/api/machines`. Folder data dibuat dengan sudo, atau pindah ke `~/.snugcode` bila `/workspaces` tidak
  bisa ditulis.
- `install.sh`: log ke `install.log`, kegagalan npm dilaporkan. `start.sh`: binary dicari di PATH & folder
  global npm; bila paket global gagal, daemon dijalankan dari kode repo codespace; daemon yang langsung
  mati dilaporkan. `snugcode cloud`: kegagalan konfigurasi dilaporkan ke relay.
- PWA: wizard & layar menyalakan runner menampilkan tahap/error dari runner, dan gagal cepat bila
  codespace menyala 6 menit tanpa laporan (secret tidak sampai / skrip tidak jalan).

### Deploy tanpa PC
- Workflow `Deploy` (`.github/workflows/deploy.yml`): `npm run deploy` otomatis saat `main` berubah di
  `relay/`, `web/`, atau `shared/`, atau manual lewat *Run workflow*. Butuh secret repo
  `CLOUDFLARE_API_TOKEN` (`CLOUDFLARE_ACCOUNT_ID` opsional); memeriksa `/api/health` setelah deploy.

## 2026-10-15 — snugcode tanpa PC: runner cloud dari HP (#3)

### Runner cloud (GitHub Codespaces / Docker)
- `snugcode cloud` (`daemon/runner.js`): daemon yang sama dengan di PC, dikonfigurasi dari env
  (`SNUGCODE_MACHINE_TOKEN`, `SNUGCODE_PAIR_PIN`, `SNUGCODE_RELAY`, …) secara idempoten, di bawah
  supervisor (restart/update dari HP tetap jalan di container). Boleh start tanpa key 9router.
- Berhenti sendiri saat menganggur (bawaan 30 menit; bisa diatur dari HP): Codespaces dihentikan lewat
  GitHub API dengan token dari HP, container keluar (`SNUGCODE_IDLE_EXIT=1`).
- Relay: `POST /api/machines/provision` mendaftarkan mesin cloud tanpa login dari mesinnya (maks. 3 per
  akun); daftar mesin membawa `kind`/`provider`; login `kind=gh` memberi PWA token ber-scope `codespace`
  lewat fragmen URL (tidak disimpan relay).
- PWA: **Pakai cloud — tanpa PC** di daftar mesin. Wizard: izin Codespaces → fork (sekali) → provision →
  secret terenkripsi di HP (sealed box, `shared/sealedbox.js`, diuji dengan vektor libsodium) → codespace →
  tunggu online → pairing otomatis dengan PIN yang dibuat HP. Runner yang tidur dinyalakan saat dibuka.
  Menu runner: berhenti otomatis, hentikan sekarang, buka di GitHub, hapus. Opsi *Server sendiri* membuat
  perintah Docker lengkap.
- `.devcontainer/` (Codespaces) dan `Dockerfile`.

### Setelan mesin dari HP (PC & runner)
- RPC baru `configure` (key/URL 9router, divalidasi ke router dulu, key tidak pernah dikembalikan),
  `devices`, `revoke`, `setPin`, `runnerConfig`; `info` membawa `runtime`, `routerConfigured`, `runner`.
- PWA: Pengaturan PC → *Router & akses*: key 9router, perangkat terpasang (cabut akses), ganti PIN.

### Keamanan
- `GITHUB_TOKEN`, `GH_TOKEN`, dan env bootstrap runner dibuang dari environment daemon saat start, sehingga
  tidak terwariskan ke agen, Bash, dev server, atau `!perintah` (sebelumnya terwariskan bila ada di env PC).

### Uji
- `npm run test:e2e:cloud` (juga di CI): provision → `snugcode cloud` dari env saja → pairing otomatis di
  Chromium → key 9router dari HP → env bersih → ganti PIN/cabut HP → restart lewat supervisor.

## 2026-10-11 — Agen 2–3× lebih cepat dengan model non-Claude

### Diagnosis (diukur, bukan ditebak)
- Harness snugcode sendiri bukan penyebabnya: proxy loopback +0 ms, overhead SDK/sesi ±50–150 ms
  per langkah, checkpoint ±150 ms per prompt, RTT ke router ±25 ms.
- Penyebabnya jumlah langkah: setiap langkah = satu request model (Gemini Flash high: 2,5–10 detik
  per request). Gemini membaca file 40–120 baris per langkah (129 dari 132 Read di sesi nyata
  dipotong offset/limit) dan memakai Grep mode daftar file lalu mencari ulang isinya. Tugas
  eksplorasi yang sama: Opus 8 request, Gemini 45–53 request.

### Perbaikan
- Hook PreToolUse `Read|Grep` (hanya model non-Claude): Read potongan dari file ≤ 2000 baris /
  64 KB dilebarkan menjadi seluruh file; Grep tanpa `output_mode` menjadi baris yang cocok + nomor
  baris (`head_limit` 100). Izin tetap lewat `canUseTool`; folder data snugcode, file biner,
  gambar, PDF, dan notebook tidak disentuh. Hasil pada tugas eksplorasi yang sama (3 kali uji):
  135–178 detik / 45–53 request → 52–72 detik / 13–16 request, token input turun ±60%.
- System prompt: arahan efisiensi diperjelas (gabungkan tool call yang independen, baca file
  utuh, Grep `content`), menggantikan arahan lama yang mendorong membaca potongan offset/limit.

## 2026-10-11 — Mode Komputer: agen dengan akses seluruh PC

- Jenis sesi baru di samping sesi repo (worktree) dan folder lokal: **Komputer** (`computer: true`,
  repo `Komputer`). Berjalan di folder pilihan (bawaan home) tanpa clone/worktree/branch; agen boleh membaca
  dan mengedit file di seluruh PC tanpa bertanya (Bash tetap lewat izin). Folder data snugcode dan aksi ke
  remote tetap dijaga.
- System prompt sendiri (`SNUGCODE_COMPUTER_PROMPT`): tidak dibatasi satu repo.
- Tanpa checkpoint/rewind dan template `.env`; git status/diff dicoba di folder kerja (kosong bila bukan
  repo). Menghapus sesi hanya menghapus riwayatnya.
- PWA: **Sesi baru** punya tab *Repository* / *Komputer* (folder awal + model). TUI: `snugcode --computer`
  (`-c`), `/computer`, dan pilihan "Sesi Komputer" di pemilih sesi.

## 2026-10-09 — Alamat singkat, ikon baru, perbaikan beranda

### Alamat: snugcode.arfak.workers.dev
- Worker alias `snugcode` (`relay/wrangler.alias.jsonc`, `relay/src/alias.js`) menyajikan PWA dan
  meneruskan semua API & WebSocket ke worker relay lewat service binding: tanpa migrasi data, PC
  dengan URL lama tetap tersambung. `npm run deploy` kini men-deploy keduanya.
- Host lama: `/auth/login` dialihkan ke alamat utama (callback OAuth App hanya boleh satu host) dan
  PWA menawarkan **Pindah sekarang**: isi localStorage (login, pairing PC, tema) dibawa lewat
  fragmen URL `#import=` — tidak pernah dikirim ke server — dan hanya diterima bila alamat tujuan
  belum login. `/api/health` memberi tahu PWA bila ia dibuka dari host lama.
- PC baru memakai alamat utama secara bawaan.

### Ikon aplikasi
- Maskot lebih besar dan dipusatkan secara optis; PNG 192/512, ikon maskable (zona aman untuk
  potongan lingkaran/squircle launcher Android), dan `apple-touch-icon.png` untuk iOS (iOS tidak
  memakai SVG untuk ikon layar utama). Dibuat dengan `npm run icons`.

### Dokumentasi
- README ditulis ulang untuk UI baru: GIF demo (agen, Run & Preview, git, terminal), galeri layar
  yang mengikuti tema gelap/terang GitHub (`<picture>`), dan tanpa emoji dekoratif.
- `npm run docs:images` merekam UI asli dengan repo contoh (`toko-kopi`) dan skenario agen di mock
  9router (`setup({ reply })` di `test/e2e-harness.mjs`); GIF di-encode dengan `gifenc` (frame
  berbeda saja, palet global). Terminal dianimasikan dari `docs/mockups/tui.html`.

### Perbaikan
- Celah di bawah kotak input (PWA iOS): `innerHeight`/`visualViewport` di sana bisa kurang sebesar
  status bar, sehingga shell berakhir ±60pt sebelum dasar layar. Shell, drawer, dan sheet kini menempel
  ke tepi layar lewat CSS; tinggi dari JS hanya dipakai saat keyboard terbuka. Jarak bawah ±safe-area
  dan kontrol composer berupa pil abu-abu, seperti aplikasi Claude.
- Sesi kosong: sambutan di tengah layar dan tidak lagi terpotong di bawah header.
- Pil model/GitHub dan banner beranda tidak lagi "memantul dua kali": isinya hanya digambar ulang
  bila berubah (`renderIf`), dan animasinya mengikuti sapaan di atasnya.

## 2026-10-09 — Ganti nama: pocketcode → snugcode, maskot "Snug"

### Nama baru
- Paket `snugcode`, perintah `snugcode` (alias `snug`), branch sesi `snug/<id>`, env `SNUGCODE_*`,
  konfigurasi repo `.snugcode.json`, autostart `snugcode` / `dev.snugcode`, tool MCP `mcp__snugcode__*`.
- Pembaruan jarak jauh mengambil `github:arfakaisar/snugcode`.

### Tetap kompatibel dengan instalasi lama
- Folder data `~/.pocketcode` tetap dipakai bila sudah ada; env `POCKETCODE_*` dan `.pocketcode.json`
  tetap dibaca; entri autostart lama dipindahkan otomatis saat daemon baru jalan.
- Tidak diganti karena identitas protokol/penyimpanan: label kriptografi pairing & kanal
  (`shared/crypto.js`), nama pipe IPC, indeks checkpoint git, dan URL/nama worker relay.
- Daemon kini mengirim `brand`; PWA mengenali daemon lama dan menawarkan migrasi (perintah siap
  salin atau dijalankan lewat sesi). Lihat README → Migrasi dari pocketcode.

### Maskot & logo
- Maskot **Snug**: mochi clay bertopi tidur berbintang, berselimut, dengan "zzz". SVG beranimasi CSS:
  tidur (bernapas, topi bergoyang, zzz melayang), bekerja (mata berkedip, mengangguk, kaki
  "mengetik", titik berpikir), muncul (squash & stretch, selimut naik), dan bisa dicolek.
- Ikon PWA, favicon, gambar README, dan TUI (`(˘ᵕ˘)ᶻ snugcode`, indikator kerja berupa wajah
  maskot yang berkedip) memakai maskot yang sama.

## 2026-10-09 — PWA dirombak: gaya aplikasi chat, navigasi lebih ringkas, banyak animasi ringan

### Tampilan
- Palet hangat dengan aksen *clay*, **tema Sistem / Terang / Gelap** (menu akun), teks jawaban agen
  memakai serif (Source Serif 4), kode tetap JetBrains Mono. `theme-color` mengikuti tema.
- Pesan pengguna berupa gelembung di kanan dengan tombol salin & ↺ rewind di bawahnya; jawaban agen
  tanpa gelembung, ringkasan selesai punya tombol salin jawaban.
- Langkah tool berurutan menyatu jadi satu kartu, nama tool berkilau selama berjalan.
- Kartu rencana memakai lingkaran centang + progres beranimasi; kartu izin melayang di atas composer.
- Logo "spark" beranimasi: tumbuh saat muncul, berdenyut bergelombang saat agen bekerja.

### Navigasi & QOL
- **Drawer samping** (☰ atau geser dari tepi kiri): sesi baru, beranda, sesi terbaru, ganti PC,
  akun, pengaturan PC. Tombol kembali di layar sesi diganti drawer.
- **Beranda PC**: sapaan, chip model/GitHub, daftar sesi, tombol "Mulai sesi baru…" bergaya
  composer, tarik-untuk-muat-ulang, tekan lama sesi untuk buka/hapus.
- **Composer**: 9 kontrol menjadi 3 (**+**, model, kirim). Tombol **+** menggabungkan kamera,
  galeri, run, git, sakelar mode rencana / shell / auto-izin / tinjau edit, aksi cepat, dan perintah
  shell cepat. Mode aktif tampil sebagai pil yang bisa diketuk untuk dimatikan.
- Git (badge jumlah perubahan) dan Run (titik hidup saat preview aktif) pindah ke header; judul
  sesi membuka menu sesi. Sesi kosong menampilkan kartu saran.
- Semua `confirm()` bawaan browser diganti sheet konfirmasi; sheet bisa ditarik turun dari judul
  atau isinya yang sudah di paling atas, dan isi sheet bergeser saat berpindah halaman.

### Performa
- Animasi hanya transform/opacity (CSS + Web Animations API), tanpa library; animasi berulang
  hanya berjalan saat dibutuhkan, dan semuanya mati bila `prefers-reduced-motion`.
- Isi drawer dibuat saat dibuka dan dibuang saat ditutup; daftar sesinya hanya dirender ulang bila
  berubah. Tanpa dependensi baru: `app.js` 51 → 57 KB, `style.css` 10 → 14 KB (gzip).

### Pembaruan PWA otomatis
- Nama cache service worker kini hash isi aset (dibuat `build:web`), jadi setiap deploy UI langsung
  terdeteksi tanpa menaikkan versi manual. Aset shell diunduh dengan `cache: 'reload'`.
- PWA yang dilanjutkan dari latar belakang mengecek pembaruan, lalu memuat ulang sendiri saat versi
  baru aktif (atau menawarkan lewat toast bila sedang ada teks yang diketik).

## 2026-10-09 — Agen hemat token & lebih cepat: tool ramping, subagen ringan, izin lebih cerdas

Diukur dengan Agent SDK asli terhadap mock router (env bersih). Sebelumnya setiap langkah agen
mengirim ±77 KB (±20k token): 27 tool (±55 KB skema) dan system prompt tambahan 5,4 KB.

### Token per request: ±77 KB → ±35 KB (−55%)
- **Daftar tool eksplisit** (`AGENT_TOOLS`): Bash, Read, Edit, Write, Glob, Grep, Agent,
  AskUserQuestion, ExitPlanMode, WebFetch, WebSearch + tool MCP pocketcode. Dibuang: Cron*,
  ScheduleWakeup, SendMessage, Workflow, ListAgents, ReportFindings, TaskStop, NotebookEdit, Skill,
  EnterWorktree/ExitWorktree (bentrok dengan worktree pocketcode), ±40 KB per request.
  Grep/Glob kini tersedia (build native menggantinya dengan Bash grep/find yang outputnya tak dibatasi).
- **System prompt tambahan 5,4 KB → 1,8 KB**: hanya aturan yang mengubah perilaku agen (jawaban
  ringkas untuk HP, Grep/Glob, Explore untuk eksplorasi luas, dev_start, tanpa git push).
  Penjelasan arsitektur (E2EE, Cloudflare, keep-awake, …) dibuang.
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (proses panjang lewat `dev_start`), output Bash yang
  masuk konteks dibatasi 15k karakter (`BASH_MAX_OUTPUT_LENGTH`, bawaan 30k).
- Screenshot agen memakai DPR 1 (4× lebih sedikit piksel), opsi `image:false` bila hanya butuh
  error konsol, dan log konsol diringkas (baris kembar digabung, error didahulukan, maks. 5k karakter;
  dulu sampai 100×2000 karakter). `dev_logs` bawaan 4k karakter, maks. 20k.

### Subagen: model ringan sungguhan
- **Bug**: untuk model `cc/`, "model kecil" = model utama (`fastModelVariant` menurunkan effort ke
  `-low`, lalu `resolveModelEffort` membuangnya). Subagen Explore/general-purpose berjalan di
  Opus dengan effort penuh. Selain itu tanpa `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` subagen bawaan
  memang selalu memakai model utama.
- Kini `lightModel()` memilih **Claude Haiku 5.5** (prioritas 1 untuk model utama `cc/`) atau
  **Gemini 3.8 Flash** (prioritas 1 untuk `ag/` dan lainnya, prioritas 2 untuk `cc/`), dari daftar
  model router yang di-cache (tidak menahan prompt). Pilihan manual "model kecil" dihapus dari
  setup, menu PC, dan RPC.
- Subagen bawaan didefinisikan ulang (`daemon/agents.js`) dengan effort rendah (Explore `low`,
  lainnya `medium`) dan prompt ringkas; tanpa ini subagen mewarisi effort model utama.

### Latensi
- **Pre-warm**: proses `claude` disiapkan saat sesi dibuka di HP/terminal; prompt pertama tidak
  menunggu spawn + resume transcript.
- **Ganti model/effort tanpa restart**: `setModel()` + `applyFlagSettings({ effortLevel })` di proses
  yang hidup (dulu proses ditutup lalu dibuat ulang dengan `resume`).
- Riwayat saat attach: potongan teks streaming (satu event per ~80 ms) digabung jadi satu event per
  blok, jadi membuka ulang sesi panjang di HP lebih ringan.

### Izin (lebih sedikit bolak-balik ke HP)
- **Edit di worktree langsung diterapkan** (setiap prompt punya checkpoint & rewind). Mode
  *Tinjau edit* (menu sesi / `/edits`) mengembalikan persetujuan per diff. Di luar worktree dan di
  mode rencana tetap bertanya.
- **"Selalu" per pola perintah**: memakai saran aturan Claude Code (mis. `Bash(npm test *)`), bukan
  lagi seluruh Bash. Berlaku langsung (izin `session`) dan disimpan (`allowRules`) untuk proses
  berikutnya. HP & terminal menampilkan cakupannya.
- Hook `PreToolUse` memastikan tool yang mengubah file tetap menunggu checkpoint, dan push /
  perintah yang menyentuh kredensial tetap meminta izin, termasuk yang lolos lewat aturan "Selalu"
  (mis. `Bash(git *)`) tanpa melewati `canUseTool`.

### Diagnostik biaya
- Ringkasan selesai menampilkan **cache %** (`usage.cr` / `usage.cw`). Selalu 0% berarti provider
  di 9router tidak meng-cache prompt, sehingga setiap langkah ditagih penuh.

## 2026-10-09 — Refactor PWA per layar, model event bersama, type checking, e2e UI

### Bug yang ditemukan uji browser
- **Potongan teks terakhir jawaban agen bisa tidak tampil di PWA** bila tiba di frame yang sama
  dengan `done`/tool berikutnya (render dijadwalkan ke frame berikutnya, tapi blok teksnya sudah
  ditutup sehingga render dibatalkan; pola ini sudah ada sebelum optimasi). Status render kini
  melekat pada blok teksnya sendiri, jadi setiap blok selalu dirender sampai potongan terakhir.

### Struktur
- `web/app.js` (2.200 baris) dipecah menjadi `web/ui/*.js` per layar. Pemecahan memakai resolusi
  simbol TypeScript (bukan potong-tempel), jadi setiap import/export dihitung dari referensi nyata.
  Variabel global yang ditulis lintas layar (`conn`, `current`, `me`) kini objek `app` di
  `web/ui/state.js`. `web/app.js` tinggal titik masuk (±35 baris).
- **`shared/events.js`**: model event sesi bersama daemon/PWA/TUI — tipe event (JSDoc), rencana
  TodoWrite terstruktur (`todos`; dulu teks berglyph yang di-parse ulang di dua klien, tetap
  dikirim untuk klien lama), label aktivitas, ringkasan "selesai", dan `EventCursor` (penyaring
  event duplikat, kini juga dipakai TUI).

### Kualitas
- **Type checking**: `tsc --checkJs` untuk seluruh daemon, shared, PWA, dan relay (tipe Worker dari
  `wrangler types`); 98 error awal dibereskan dengan JSDoc. `npm run typecheck`, dijalankan CI.
- **Uji e2e di CI** (Linux): relay dev + daemon asli + Agent SDK + mock 9router (`npm run test:e2e`),
  dan PWA hasil build di Chrome + TUI di pseudo-terminal (`npm run test:ui`, memakai
  `playwright-core` tanpa unduhan browser). Setup bersama di `test/e2e-harness.mjs`.

## 2026-10-09 — Optimasi menyeluruh: keamanan data, latensi agen, protokol biner

### Keamanan data & kredensial
- **`sessions/index.json` ditulis atomik** (tmp + rename). Dulu crash/disk penuh saat menulis bisa
  meninggalkan file terpotong → daftar sesi kosong → pembersih otomatis menghapus semua worktree
  (termasuk kerja yang belum di-push). Index yang rusak sekarang disimpan sebagai
  `index.json.broken-*` dan sesi **dipulihkan dari worktree di disk**. `pocketcode clean` menolak
  berjalan bila index tidak terbaca.
- **Race pembersih vs sesi baru**: repo yang sedang di-clone/disiapkan untuk sesi baru tidak lagi
  bisa dihapus oleh pembersih (hapus sesi lain / tombol bersihkan) di tengah jalan.
- **Key 9router tidak lagi ada di env proses claude**: proxy lokal memegang key asli dan hanya
  menerima token lokal acak. `echo $ANTHROPIC_AUTH_TOKEN` dari Bash agen tidak membocorkan key.
- **Izin diperketat**: `~/.pocketcode` (kecuali worktree & plans) selalu ditolak untuk tool file;
  Read/Glob/Grep di luar worktree dan `WebFetch` meminta izin; screenshot URL non-localhost/`file:`
  meminta izin; perintah yang menyebut `secrets.json` tidak bisa "selalu diizinkan".
- **Event tidak hilang saat pindah sesi**: antrean event per koneksi dikirim dulu sebelum
  berganti sesi (dulu event sesi baru bisa berlabel sesi lama lalu dibuang HP).

### Latensi agen
- **Proses `claude` tetap hidup antar prompt** (streaming input Agent SDK): prompt berikutnya tidak
  lagi spawn proses + resume transcript. Di uji e2e: prompt kedua 65 ms vs 680–1100 ms. Proses
  ditutup setelah 5 menit menganggur, maksimal 3 proses menganggur, dan otomatis dibuat ulang
  (dengan resume) saat model/effort/URL berubah. Stop tetap instan.
- **Checkpoint paralel**: snapshot worktree berjalan bersamaan dengan start-up agen; tool yang
  mengubah file menunggu checkpoint selesai, jadi rewind tetap akurat.
- **Git lebih sedikit proses**: `gitStatus` 1× `status --porcelain=v2 --branch` + log paralel
  (dulu 4 proses berurutan); sesi baru tanpa `ls-remote` ekstra; clone dasar repo disimpan
  3 hari setelah sesi terakhirnya dihapus (sesi baru tidak clone ulang dari nol).
- **Screenshot**: browser headless dipakai ulang (context terisolasi per screenshot): ~0,4 s vs ~2 s.
  Chrome sebagai root (Linux server/WSL) kini jalan (`--no-sandbox` hanya untuk root).
- **Preview**: ganti port dev server tidak membuat tunnel baru; URL & cookie HP tetap berlaku.
- **Log proses** memakai ring buffer (tidak menyalin ulang 256KB per chunk output).
- **Riwayat sesi**: ditulis lewat write stream; saat dibuka hanya 8MB terakhir file `.jsonl` yang
  dibaca; riwayat sesi yang 30 menit tidak dibuka dilepas dari memori.
- **Repo search GitHub**: tanpa panggilan `/user` ekstra, request berjalan paralel.

### Protokol & relay (proto 2)
- **Kanal biner** HP ↔ relay ↔ PC: frame `[versi][nonce][ciphertext]` tanpa base64 & JSON
  berlapis (±25–35% lebih kecil, relay tidak mem-parse JSON), dan pesan besar dipecah per 256KB,
  jadi batas 1MB relay tidak lagi memotong riwayat (sampai 4MB), diff (2MB), dan screenshot.
  Dinegosiasikan saat auth; HP/daemon/relay versi lama tetap memakai frame teks.
- `info` memuat `proto` dan `caps` (daftar metode RPC) untuk deteksi fitur.
- RPC daemon kini tabel handler dengan validasi input, bukan satu `switch` 180 baris.

### PWA & TUI
- Markdown dirender **bertahap** saat streaming (dulu seluruh teks dirender ulang tiap delta, O(n²));
  output shell ditambah sebagai node teks; DOM sesi sangat panjang dipangkas; event duplikat
  (setelah reconnect) diabaikan berdasarkan `seq`.
- Service worker **stale-while-revalidate**: PWA terbuka instan walau sinyal lemah.
- `web/app.js` dipecah: `web/conn.js` (koneksi E2EE + RPC) dan `web/md.js` (markdown);
  `daemon/tui.js` dipecah: `daemon/term.js` (warna, wrap, markdown ANSI).
- CI GitHub Actions: cek sintaks, unit test (Linux/Windows/macOS), dan bundle PWA.

> **Urutan deploy**: kanal biner aktif bila relay sudah di-deploy ulang (`npm run deploy`) dan
> daemon diperbarui. Semua kombinasi versi lama/baru tetap kompatibel (fallback ke frame teks).

## 2026-10-09 — pnpm/yarn tanpa instalasi global (`daemon/toolchain.js`)
- **Bug**: Run di repo pnpm/yarn gagal dengan `pnpm : The term 'pnpm' is not recognized` bila
  PC tidak punya pnpm. Sejak Node 25, corepack juga tidak lagi ikut terpasang dengan Node.
- Sekarang, saat perintah butuh pnpm/yarn yang tidak ada, corepack dipasang sekali ke
  `~/.pocketcode/tools`, dan shim pnpm/yarn-nya ke `~/.pocketcode/bin/pm`. Versinya mengikuti
  `packageManager` di package.json proyek. Folder shim ditaruh di akhir PATH, jadi pnpm/yarn milik
  pengguna tetap diutamakan. Berlaku untuk Run, `!perintah`, dan Bash agen.

## 2026-10-09 — Run & Preview, agen bisa melihat hasil UI, dan fitur remote coding lain

### Run & Preview (`daemon/procs.js`, `daemon/tunnel.js`, `daemon/project.js`)
- **Masalah**: dev server (`npm run dev`) hanya bisa dibuka di `localhost` PC. Dari HP/laptop lain
  hasilnya tidak bisa dilihat sama sekali. `!npm run dev` juga memblokir sesi dan dimatikan setelah 10 menit.
- **Proses latar belakang per sesi**: berjalan terpisah dari agen tanpa batas waktu. Log disimpan di
  ring buffer dan di-stream ke HP. Port terdeteksi otomatis dari log (Vite/Next/dll.) atau dari env
  `PORT` bebas yang disuntikkan (dua sesi tidak bentrok di port 3000). Proses dimatikan beserta
  anak-anaknya (`taskkill /T` di Windows, process group di Unix).
- **Preview di HP**: Cloudflare quick tunnel (tanpa akun; `cloudflared` diunduh sekali ke
  `~/.pocketcode/bin`). Tunnel masuk lewat gerbang lokal yang mewajibkan token rahasia. Token hanya
  dikirim ke HP lewat kanal E2EE, jadi URL yang bocor ditolak (401). Gerbang menulis ulang
  Host/Origin ke `localhost` agar Vite (`allowedHosts`) dan Next (`allowedDevOrigins`) menerima
  request, termasuk WebSocket HMR. Link baru diberikan setelah DNS dan edge siap, sehingga tidak
  memunculkan error "tidak ditemukan" yang tersimpan di cache HP.
- **Worktree siap jalan**: perintah setup (`npm ci` / `pnpm install` / dst.) dan dev dideteksi
  otomatis, bisa ditimpa lewat `.pocketcode.json` `{ "setup", "dev" }`. File `.env*` bisa disimpan
  sebagai template per repo dan dipulihkan otomatis di sesi baru.
- **Screenshot dari HP** dengan Chrome/Edge headless lewat CDP (tanpa Playwright), lengkap dengan
  error konsol dan tombol "Suruh agen perbaiki".
- PowerShell kini memakai `-ExecutionPolicy Bypass` untuk proses ini saja. Sebelumnya `npm`/`npx`
  gagal di Windows dengan setelan default ("running scripts is disabled").
- `pocketcode stop/restart/update` menghentikan daemon dengan rapi lewat IPC. Dev server dan tunnel
  ikut mati; dulu `process.kill` di Windows meninggalkan proses anak.

### Agen bisa melihat hasilnya sendiri (`daemon/devtools.js`)
- Tool MCP in-process: `dev_start`, `dev_stop`, `dev_logs`, `dev_list`, `preview_screenshot`
  (gambar + log konsol dikirim ke model, dan screenshot tampil di HP). System prompt melarang dev
  server lewat Bash dan meminta verifikasi visual setelah perubahan UI.

### Fitur lain
- **Web Push** (`daemon/webpush.js`, `web/sw.js`): notifikasi tetap muncul saat PWA ditutup
  (agen selesai/berhenti, butuh izin, bertanya). Isinya dienkripsi untuk HP (RFC 8291), dan kunci
  VAPID dibuat di HP lalu dibagikan ke tiap PC lewat kanal E2EE. Mengetuk notifikasi membuka sesi terkait.
- **Kirim gambar** dari kamera/galeri/clipboard. Gambar dikompres di HP agar muat satu frame relay.
- **Agen bertanya** (`AskUserQuestion`) dengan opsi tap di HP dan pilihan di terminal.
- **Mode rencana**: agen hanya membaca dan menyusun rencana, lalu meminta persetujuan (Setujui / Revisi).
- **Checkpoint & rewind**: tiap prompt men-snapshot worktree (termasuk file yang belum di-commit)
  lewat index git sementara, tanpa menyentuh index/stash/branch pengguna. Tombol ↺ mengembalikan
  semua file ke kondisi sebelum prompt itu, dan agen diberi tahu di prompt berikutnya.
- Ringkasan tiap giliran kini menampilkan **persentase konteks** dan **biaya**. Ada peringatan saat konteks ≥80%.
- TUI: `/run`, `/ps`, `/logs`, `/stop`, `/preview`, `/plan`, `/rewind`.

## 2026-10-08 — Perbaikan proxy, izin, effort, updater

### Loopback proxy (`daemon/proxy.js`)
- **Bug `_ide` di batas chunk**: proxy dulu menahan 64 karakter terakhir tiap chunk; bila batas
  jatuh di tengah `"name":"Bash_ide"`, nama lolos tanpa diubah dan error
  `No such tool available: Bash_ide` muncul lagi. Sekarang teks ditulis ulang **per baris utuh**
  (event SSE dan JSON selalu diakhiri baris baru), jadi pola tidak pernah terbelah.
- **UTF-8 rusak**: karakter multi-byte (✓, —, huruf non-Latin) yang terbelah di antara dua chunk
  dulu menjadi `���`. Sekarang memakai `StringDecoder`.
- **Menggantung saat router putus**: error/putusnya stream upstream tidak ditangani sehingga agen
  menunggu tanpa batas. Sekarang koneksi ke SDK ikut diputus (SDK melihat error & retry), router
  yang tidak bisa dihubungi dijawab 502 berformat error Anthropic, dan tombol Stop ikut membatalkan
  request ke router.
- **Keamanan**: proxy tidak lagi menyuntikkan API key 9router ke request tanpa kredensial. Dulu
  program lain di PC (atau halaman web lewat request lintas situs ke `127.0.0.1`) bisa memakai key.
  SDK sudah mengirim key-nya sendiri.
- Hanya respons `text/event-stream`/JSON yang ditulis ulang; lainnya diteruskan apa adanya
  (`content-length` dipertahankan).

### Izin (`daemon/sessions.js`, `web/app.js`, `daemon/tui.js`)
- Sesi dulu berjalan dengan `permissionMode: 'acceptEdits'`, sehingga **Edit/Write tidak pernah
  meminta izin** walau dokumentasi menjanjikannya. Sekarang `default`: Write/Edit/MultiEdit lewat
  prompt izin, dan **cuplikan diff tampil di prompt izin** (HP & terminal).
- Deteksi push lebih ketat: `git -C dir push`, `git -c k=v push`, `git.exe push`,
  `gh pr create|merge`, `gh release create`, `gh repo create|delete|fork` selalu meminta izin,
  termasuk saat ⚡ auto-izin. Aksi ini tidak bisa "Selalu diizinkan".
- "Selalu izinkan" disimpan di `sessions/index.json`, jadi tetap berlaku setelah daemon restart.

### Model & effort (`shared/models.js`)
- Slider effort virtual dulu juga muncul untuk model `claude-*` di provider lain
  (mis. `ag/claude-opus-4-6-thinking`), lalu ID palsu `…-high` dikirim ke router dan gagal.
  Sekarang slider virtual hanya untuk `cc/*` dan `claude-*` tanpa provider.

### Updater (`daemon/updater.js`)
- Mode npm: bila `installedCommit` belum tercatat, daemon dulu langsung menganggap versi terbaru
  sudah terpasang, sehingga pembaruan yang sebenarnya ada terlewat. Sekarang dibandingkan dengan
  waktu pemasangan paket.
- `commitsBehind` (mode npm) dihitung sungguhan lewat GitHub compare API, tidak lagi selalu 1.
- Commit dicatat **sebelum** `npm install`, sehingga push yang masuk selama instalasi tetap
  terdeteksi sebagai pembaruan berikutnya.

### Kecepatan & Responsivitas (`daemon/sessions.js`, `daemon/proxy.js`, `web/app.js`, `daemon/tui.js`)
- **Subagent & Small Model tidak lagi tertahan effort tinggi**: `ANTHROPIC_DEFAULT_HAIKU_MODEL` dan
  `CLAUDE_CODE_SUBAGENT_MODEL` dulu dipaksa memakai model utama (bahkan dengan effort `high`/`max`).
  Akibatnya tugas kecil (deskripsi tool, subagent pencarian file, micro-tasks) memakan waktu 20–40 detik
  per panggilan hanya untuk berpikir ribuan token. Sekarang `fastModelVariant` otomatis melunakkan
  effort ke `-low` untuk model pembantu.
- **Connection pool & TCP NoDelay di proxy**: proxy sekarang memakai persistent keep-alive agent
  dan `setNoDelay(true)` pada soket masuk dan upstream, mencegah latensi buffering Nagle (40–200ms)
  pada chunk streaming SSE.
- **Indikator streaming thinking & tool call**: event `thinking_delta` dan `content_block_start` tool
  sekarang ditangkap dan diteruskan ke UI (PWA & terminal). Pengguna langsung melihat progres kata
  berpikir dan nama tool yang sedang disiapkan, bukan layar hening yang terkesan macet.

### Manajemen File & Ruang Kerja (`daemon/cleaner.js`, `daemon/sessions.js`, `daemon/cli.js`, `daemon/tui.js`, `web/app.js`)
- **Pembersihan Sesi Tangguh**: penghapusan sesi kini menutup proses subagen & query terlebih dahulu (`s.close()`), mencegah kunci file Windows (`EBUSY`/`EPERM`). Fungsi `safeRm` menangani file read-only git packfile dengan retry rekursif dan penyesuaian izin chmod.
- **Deteksi & Pembersihan Folder Yatim Otomatis**: sistem secara otomatis memindai PC host untuk mendeteksi folder worktree (`s-*`) yang tidak terhubung ke sesi aktif, repository yang sudah tidak memiliki sesi lagi, dan log `.jsonl` basi.
- **Terintegrasi Tanpa Hambatan (Seamless)**:
  - Berjalan otomatis di latar belakang saat daemon dinyalakan (startup).
  - Berjalan otomatis segera setelah sesi dihapus (merapikan repository bila sesi terakhir dihapus).
  - Berjalan berkala setiap 30 menit saat daemon aktif.
  - Perintah CLI `pocketcode clean`, slash command `/clean` di TUI, dan tombol "Bersihkan folder tak terpakai" di menu Sistem & Pembaruan pada HP (PWA).

### Autostart Tangguh Lintas Platform (`daemon/autostart.js`, `daemon/cli.js`, `daemon/updater.js`)
- **Sinkronisasi Otomatis Jalur Eksekusi**: file startup sistem (Windows `pocketcode.vbs`, macOS launchd plist, Linux systemd service) kini otomatis disinkronkan ke lokasi binary aktif setiap kali daemon dinyalakan (`pocketcode start`) dan setiap kali pembaruan dipasang (`performUpdate`).
- **Mencegah Eksekusi Versi Usang**: jika pengguna pernah mengaktifkan autostart dari folder repositori lokal lama lalu memperbarui pocketcode lewat npm global atau PWA di HP, entri autostart otomatis diperbarui agar saat PC di-restart, sistem dijamin selalu menjalankan pocketcode versi paling baru.

### Lainnya
- **Identitas & Pengetahuan Sistem Pocketcode (`daemon/prompt.js`)**: System prompt terpadu
  disuntikkan ke Claude Agent SDK. Model kini sepenuhnya sadar bahwa ia adalah agen coding dari
  pocketcode (bukan harness lain), mengerti arsitektur lokal daemon, E2EE relay Cloudflare, isolasi
  git worktree, izin interaktif diff, dan fitur sistem pocketcode.
- Riwayat event sesi dimuat dari `.jsonl` saat dibutuhkan (bukan semuanya saat daemon start) dan
  dibatasi 3000 event per sesi di memori; riwayat lengkap tetap di disk.
- Scope GitHub: tambahkan `workflow` ke OAuth device flow (`repo read:user workflow`) agar token
  di masa mendatang dapat mengelola file GitHub Actions.
- Test baru: proxy (chunk terbelah di tiap posisi, UTF-8, router putus, router mati, tanpa key),
  effort non-`cc`, deteksi push.

## 2026-10-08 — Binary native Claude (`28088eb`)

- Gejala: `Native CLI binary for win32-x64 not found` setelah update.
- Penyebab: `claude-agent-sdk@0.3.x` mengirim `claude.exe` lewat paket per-platform
  (`optionalDependencies`). Update berjalan saat sesi hidup → `claude.exe` terkunci di Windows →
  npm diam-diam melewati paket `-win32-x64`. Mode git juga menelan error `npm install`.
- Perbaikan: `daemon/nativebin.js` (deteksi paket per platform, termasuk `-musl`);
  `performUpdate()` memakai `--include=optional`, timeout 10 menit, tidak menelan error, dan
  memverifikasi binary; RPC `update` menghentikan semua sesi dulu; `pocketcode update` menghentikan
  daemon dulu; tombol update daemon lama di PWA berjalan sebagai proses terpisah; preflight binary
  sebelum tiap prompt; opsi manual `claudeExecutable` di `config.json`.
- Perbaikan manual bila masih terjadi:
  ```powershell
  pocketcode stop
  npm i -g github:arfakaisar/pocketcode --include=optional
  pocketcode start
  ```

## 2026-10-08 — Remote update, anti-sleep, Claude Opus 5.5

- `daemon/updater.js`: cek & pasang pembaruan (git checkout / npm global), restart daemon lewat
  helper terlepas. RPC `updateStatus`, `update`, `restart`; perintah `pocketcode update|restart`,
  `/update` `/restart` di TUI; menu "Sistem & Pembaruan" dan banner otomatis di HP (cek tiap 10 menit).
- `daemon/keepawake.js`: Away Mode Windows, `caffeinate` macOS, `systemd-inhibit` Linux.
- `daemon/github.js`: hapus `index.lock` basi (> 30 dtk) dan `git worktree prune` sebelum membuat worktree.
- `daemon/proxy.js`: loopback proxy yang menetralkan `user-agent: claude-cli`/`x-app` (9router
  menyuntikkan `reasoning_effort` → Anthropic menjawab 400) dan suffix `_ide` pada nama tool.
- Slider effort virtual untuk `cc/*` → opsi `effort` + `CLAUDE_CODE_EFFORT_LEVEL`.
- Perbaikan: `npm.cmd` di Windows butuh `shell: true` (CVE-2024-27980); hash HEAD dibaca dengan
  `git rev-parse`; polling `pocketcode restart`; fallback update untuk daemon lama di PWA.
