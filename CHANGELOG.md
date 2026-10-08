# Changelog

Riwayat perubahan penting pocketcode. Arsitektur & fitur lengkap ada di [`master.md`](master.md).
(Menggantikan `change1.md` dan `fix-native-binary.md`.)

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

### Lainnya
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
