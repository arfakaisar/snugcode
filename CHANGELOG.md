# Changelog

Riwayat perubahan penting pocketcode. Arsitektur & fitur lengkap ada di [`master.md`](master.md).
(Menggantikan `change1.md` dan `fix-native-binary.md`.)

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
