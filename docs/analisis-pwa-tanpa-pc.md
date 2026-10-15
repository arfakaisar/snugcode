# Analisis: snugcode "all-in-one" dari HP tanpa setup PC

> Tujuan: pengguna cukup membuka PWA di HP → login GitHub → langsung bisa coding dengan agen,
> **tanpa memasang apa pun di PC**. Dokumen ini memetakan apa yang sudah ada, apa yang sebenarnya
> terikat ke PC, opsi arsitektur, dan rencana paling efektif untuk mencapainya.

---

## 1. Ringkasan eksekutif

**Kesimpulan utama:** PWA-nya sudah siap. Yang terikat ke PC hanya *tempat daemon berjalan*.
Protokol snugcode sudah memisahkan "klien" (PWA/TUI) dari "mesin" (daemon) lewat relay, dan relay
sudah mendukung banyak mesin per akun. Jadi cara paling efektif bukan memindahkan agen ke dalam
browser, melainkan **menjalankan daemon yang sama di container cloud** yang dibuat dan dibangunkan
langsung dari PWA. Bagi PWA, container itu hanya "PC" lain.

| Opsi | Kode yang dipakai ulang | Fitur yang tetap ada | Verdict |
|---|---|---|---|
| **A. Agen 100% di browser** (WebContainers/OPFS/isomorphic-git + loop agen sendiri) | ±40% (UI saja) | Tanpa shell nyata, tanpa Python/Docker, agen berhenti saat PWA ke latar belakang | ✗ jangan jadikan jalur utama |
| **B. Daemon di HP via Termux** | ±95% | Android saja, setup Termux tetap rumit, binary Claude glibc tidak jalan di bionic | ✗ |
| **C. Daemon di GitHub Codespaces milik pengguna** | ±95% | Hampir semua fitur; kuota gratis milik pengguna | ✓ **direkomendasikan** |
| **D. Daemon di container milik pemilik relay** (Cloudflare Containers / Fly.io / VPS) | ±95% | Semua fitur; biaya ditanggung pemilik | ✓ opsi kedua (provider tambahan) |

Rencana: buat abstraksi **Runner** (sumber mesin: `pc` | `codespace` | `container`), implementasikan
Codespaces lebih dulu, lalu siapkan image Docker yang sama untuk provider lain.

---

## 2. Peta sistem saat ini

±13 ribu baris JS tanpa framework, Node 22+, ESM, `tsc --checkJs`, CI di 3 OS + e2e.

```
HP (PWA, web/)  ──wss E2EE──►  Relay (relay/, CF Worker + DO)  ◄──wss E2EE──  Daemon (daemon/, di PC)
                                                                              ├─ Claude Agent SDK (spawn binary `claude`)
                                                                              ├─ loopback proxy → 9router
                                                                              ├─ git worktree per sesi, GitHub REST
                                                                              ├─ dev server, cloudflared tunnel, Chrome headless
                                                                              └─ IPC lokal → TUI (`snugcode`)
```

| Bagian | File kunci | Catatan relevan untuk tujuan ini |
|---|---|---|
| Relay | `relay/src/index.js` (378 baris) | `Hub` DO per akun berisi daftar mesin + soket; relay hanya meneruskan byte. **Sudah generik**: tidak peduli mesin itu PC atau container. |
| Penautan mesin | `/auth/machine/start` + `/poll` + `Pending` DO | Mesin baru *harus* ditautkan lewat login browser. **Belum ada jalur headless** untuk membuat mesin dari PWA. |
| Daemon | `daemon/server.js` (644), `sessions.js` (1196) | Sepenuhnya headless (Node + git + child process). Satu-satunya yang benar-benar butuh "komputer" adalah binary `claude`, shell, git, dan Chrome. Semua tersedia di Linux container. |
| RPC | tabel `RPC` di `server.js` | 40+ metode; `info.caps` sudah dipakai PWA untuk deteksi fitur → menambah RPC baru tidak merusak daemon lama. |
| Setup | `daemon/cli.js setup` | Sudah ada flag non-interaktif (`--key --model --relay --name --pin --github-token --skip-github --no-browser`), **kecuali** langkah penautan mesin yang wajib browser. |
| Fitur khusus PC | `keepawake.js`, `autostart.js`, `updater.js`, IPC/TUI, sesi "Komputer" | Tidak relevan di cloud; harus bisa dimatikan, bukan dihapus. |
| PWA | `web/conn.js`, `web/ui/*.js`, `sw.js`, manifest | Sudah PWA lengkap: installable, offline shell, Web Push (termasuk iOS 16.4+), pairing PIN, deteksi daemon lama. Layar kosong saat belum ada PC hanya menampilkan perintah `npm i -g …`. |
| Konfigurasi yang hanya bisa lewat CLI | `setup` (key 9router), `pin`, `devices`, `revoke` | **Harus pindah ke RPC** agar bisa diatur dari HP (bermanfaat juga bagi pengguna PC). |

---

## 3. Apa yang sebenarnya membutuhkan PC?

| Kebutuhan | Di PC sekarang | Bisa di browser HP? | Bisa di container Linux? |
|---|---|---|---|
| Claude Agent SDK | spawn binary native `claude` | **Tidak** (perlu proses OS) — harus menulis ulang loop agen | Ya, tanpa perubahan |
| Shell (`Bash`, `!cmd`, `npm test`) | PowerShell/bash | Hanya Node di WebContainers (lisensi komersial, butuh COOP/COEP, berat di mobile); tanpa Python/Docker/binary native | Ya |
| git worktree, clone, push | git CLI + token | isomorphic-git + CORS proxy; clone besar lambat & boros memori | Ya |
| Dev server + preview | proses + cloudflared | Terbatas (WebContainers) | Ya (`tunnel.js` jalan apa adanya) |
| Screenshot | Chrome headless | Tidak | Ya (pasang Chromium di image) |
| Agen tetap jalan saat HP terkunci | PC menyala | **Tidak**: iOS membekukan PWA di latar belakang, Android membatasi tab latar belakang | Ya |
| Kredensial (key 9router, token GitHub) | `~/.snugcode/secrets.json` | Harus di `localStorage` HP | Di disk container |

Baris "agen tetap jalan saat HP terkunci" adalah alasan paling kuat menolak opsi A: tugas agen
berlangsung menit hingga puluhan menit, dan pengguna HP pasti berpindah aplikasi. Compute harus
berada di luar HP.

---

## 4. Penilaian opsi

### A. Semua di browser — ✗ untuk jalur utama
- Harus mengganti Claude Agent SDK dengan loop tool-use buatan sendiri. Hilang: subagen, hook,
  `canUseTool`, mode rencana, MCP, resume transcript, prompt preset Claude Code, dan semua
  optimasi di `sessions.js`/`proxy.js`.
- Tanpa shell nyata, agen tidak bisa menjalankan test/build. Itu fitur inti snugcode.
- Key 9router harus disimpan di HP (atau diproksikan relay, yang berarti relay tidak lagi zero-knowledge).
- **Yang masih layak (fase akhir, opsional):** "Mode Ringan" untuk membaca repo, edit kecil, dan
  commit lewat GitHub API (`createCommitOnBranch`) saat runner mati. Tidak perlu WebContainers.

### B. Termux di Android — ✗
- `nativebin.js` sudah mengenali `platform === 'android'` (paket `…-linux-arm64-android`), tapi paket
  itu **tidak ada** di `package-lock.json` (hanya `linux-arm64` glibc & musl). Binary glibc tidak jalan
  di bionic tanpa proot.
- Tidak menjawab iOS, dan instal Termux + Node + git sama sekali bukan "tanpa setup".

### C. GitHub Codespaces milik pengguna — ✓ direkomendasikan
Kenapa cocok dengan snugcode:
- **Akun sudah GitHub.** Login relay sudah OAuth App GitHub; tinggal minta scope `codespace` (+ `repo`).
- **Biaya nol untuk pemilik relay**, gratis untuk pengguna dalam kuota: akun GitHub Free mendapat
  120 core-hour + 15 GB-month per bulan (Pro: 180 + 20). Mesin 2-core = ±60 jam/bulan.
- **Disk persisten** antara stop/start: worktree, `sessions/`, `claude/` (transcript untuk resume) tetap ada.
- Linux lengkap: git, Node, Python, Docker-in-Docker, Chromium. `tunnel.js`, `browser.js`, `procs.js` jalan apa adanya.
- REST API untuk membuat/menyalakan/mematikan codespace (`POST /user/codespaces`, `/start`, `/stop`),
  yang bisa dipanggil langsung dari PWA (api.github.com mendukung CORS).

Kekurangan yang harus divalidasi dulu (lihat §8):
- **Idle timeout.** Bawaan 30 menit; batas maksimal yang terdokumentasi untuk CLI adalah 240 menit.
  Aktivitas yang dihitung = input/output terminal atau interaksi editor. Daemon yang berjalan di
  latar belakang **belum tentu** dihitung aktif, sehingga codespace bisa berhenti di tengah tugas agen.
- Cold start ±30–90 detik (prebuild bisa memangkasnya).
- Codespaces menyuntikkan `GITHUB_TOKEN` ke environment (lihat §7).

### D. Container milik pemilik relay — ✓ sebagai provider kedua
- **Cloudflare Containers** paling terintegrasi (dikendalikan Durable Object, satu akun dengan relay),
  tetapi **disk container hilang setiap kali tidur**; persistensi hanya lewat storage DO, FUSE ke R2,
  atau snapshot yang belum tersedia. Worktree dan transcript agen harus di-backup/restore, sehingga
  ini lebih sulit daripada kelihatannya.
- **Fly.io Machines** / VPS: volume persisten, auto-stop. Paling sederhana secara teknis, tapi biaya
  komputasi semua pengguna ditanggung pemilik.
- Image Docker yang sama juga berguna untuk pengguna yang ingin self-host (Railway/Render/VPS).

---

## 5. Arsitektur yang direkomendasikan

```
                          ┌─────────────── HP (PWA) ───────────────┐
                          │ onboarding: "PC sendiri" / "Cloud"     │
                          │ CloudRunner: buat/bangunkan/hentikan   │──── api.github.com (Codespaces API,
                          │ pairing otomatis, setelan dari HP      │      token scope `codespace` di HP)
                          └──────────────┬─────────────────────────┘
                                         │ wss E2EE (tidak berubah)
                                  ┌──────▼──────┐
                                  │   Relay     │  + /api/machines/provision (mesin headless)
                                  │  Hub DO     │  + kind/provider di daftar mesin
                                  └──▲───────▲──┘
                         wss E2EE    │       │   wss E2EE
                   ┌─────────────────┘       └──────────────────┐
             PC (seperti sekarang)               Codespace / container
             `snugcode setup`                    `snugcode cloud` (bootstrap dari env)
                                                 daemon yang SAMA, runtime='cloud'
```

Prinsip:
1. **Satu engine.** Tidak ada fork daemon. Perbedaan PC vs cloud adalah `config.runtime` yang
   mematikan keepawake, autostart, sesi "Komputer", dan IPC/TUI.
2. **Relay tetap bodoh.** Relay hanya menambah endpoint untuk *mendaftarkan* mesin headless.
   Konten tetap E2EE dan relay tidak pernah melihat key 9router atau PIN.
3. **Semua setelan bisa dari HP.** Apa pun yang sekarang hanya ada di `snugcode setup/pin/devices/revoke`
   mendapat RPC, sehingga pengguna cloud tidak pernah butuh terminal.

### Alur pengguna baru (tanpa PC)
1. Buka PWA → **Login dengan GitHub**.
2. Layar "Belum ada PC tertaut" menampilkan dua pilihan: **Pakai cloud (tanpa PC)** / Pasang di PC.
3. Pilih cloud → izinkan scope `codespace` (OAuth tambahan, sekali).
4. PWA:
   - memanggil `POST /api/machines/provision` → relay mendaftarkan mesin dan mengembalikan `machineToken` + `mid`;
   - membuat **PIN acak** di HP (tidak pernah dikirim ke relay);
   - menyimpan `SNUGCODE_MACHINE_TOKEN`, `SNUGCODE_MACHINE_ID`, `SNUGCODE_PAIR_PIN` sebagai
     **Codespaces user secret** (dienkripsi di HP dengan sealed box ke public key GitHub);
   - membuat codespace dari template repo dengan `.devcontainer/` milik snugcode.
5. `postStartCommand` → `snugcode cloud` → daemon tersambung ke relay → PWA otomatis pairing
   dengan PIN yang disimpannya.
6. Wizard di HP: masukkan **key 9router** (dikirim lewat kanal E2EE ke daemon, RPC `configure`),
   pilih model, lalu login GitHub untuk daemon (device flow sudah ada: RPC `githubLogin`).
7. Selesai. Sesi berikutnya: bila mesin offline, PWA memanggil `/start` lalu menunggu daemon online.

---

## 6. Perubahan konkret per file

### Daemon
| File | Perubahan |
|---|---|
| `daemon/cli.js` | Perintah baru `cloud`: bootstrap idempoten dari env (`SNUGCODE_MACHINE_TOKEN`, `_MACHINE_ID`, `_RELAY`, `_PAIR_PIN` → `prs`, opsional `_ROUTER_KEY`), set `runtime: 'cloud'`, lalu `start`. Tanpa prompt interaktif. |
| `daemon/config.js` | `config.runtime` (`pc` \| `cloud`). `HOME` di cloud diarahkan ke disk persisten (mis. `/workspaces/.snugcode` di Codespaces). |
| `daemon/server.js` | RPC baru: `configure` (routerUrl/routerKey; balas tanpa pernah mengembalikan key), `devices`, `revoke`, `setPin`, `runtimeStatus`. `info()` menambah `runtime`, `routerConfigured`. Di cloud: lewati `startKeepAwake`. |
| `daemon/sessions.js` | **Hapus `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_CODESPACE_TOKEN`, `CODESPACE_*` dari env agen** (§7). Tolak tipe sesi `computer` saat `runtime === 'cloud'`. Pesan error jelas bila key 9router belum diisi. |
| `daemon/updater.js` | Di cloud: update tetap lewat `npm i -g` (disk persisten), atau dinonaktifkan dan mengikuti versi image. |
| `daemon/server.js` (opsional) | Self-stop saat menganggur (tidak ada sesi `running`, tidak ada HP tersambung selama N menit) untuk menghemat kuota. |

### Relay
| File | Perubahan |
|---|---|
| `relay/src/index.js` | `POST /api/machines/provision` (auth user) → `registerMachine` + `kind: 'cloud'`, `provider`, opsional `ref` (nama codespace). `Hub /machines` mengembalikan `kind/provider/ref`. |
| `relay/src/index.js` | OAuth scope bertingkat: `/auth/login?kind=user&scope=codespace` mengembalikan **access token GitHub ke fragmen URL** (seperti `#login=`), tanpa disimpan di relay. |
| `relay/src/index.js` | Batasi jumlah mesin cloud per akun dan rate-limit `provision`. |

### PWA
| File | Perubahan |
|---|---|
| `web/ui/cloud.js` (baru) | Klien Codespaces API: buat, start, stop, hapus, status, kuota; sealed box untuk user secret (`@noble/curves` x25519 + `@noble/hashes` blake2b + `@noble/ciphers` xsalsa20poly1305, semuanya sudah jadi dependensi). |
| `web/ui/auth.js` | Layar kosong: dua pilihan (Cloud / PC). Kartu mesin cloud: status `stopped / starting / online`, tombol **Bangunkan** dan **Hentikan**. |
| `web/ui/machine.js` | Saat mesin cloud offline: panggil `start`, tampilkan progres boot, lalu tunggu `status online` (sudah ada). Pairing otomatis dengan PIN tersimpan. |
| `web/ui/setup.js` (baru) | Wizard: key 9router → model → login GitHub daemon. Dipakai juga oleh pengguna PC untuk mengganti key. |
| `web/ui/push.js` / menu akun | Kelola perangkat (devices/revoke), ganti PIN. |

### Infrastruktur
| File | Isi |
|---|---|
| `.devcontainer/devcontainer.json` (baru) | Image Node 22 + feature git, Chromium; `postCreateCommand: npm i -g github:arfakaisar/snugcode --include=optional`; `postStartCommand: snugcode cloud`. Konfigurasi prebuild. |
| `Dockerfile` (baru) | Image yang sama untuk Fly.io/VPS/Cloudflare Containers; `ENTRYPOINT ["snugcode","cloud"]`. |
| `test/e2e-cloud.mjs` (baru) | Memakai `e2e-harness.mjs`: provision → `snugcode cloud` dengan env → pairing otomatis → prompt ke mock 9router. Bisa jalan di CI yang sudah ada. |

---

## 7. Keamanan: apa yang berubah

| Aspek | Mode PC | Mode cloud |
|---|---|---|
| Relay melihat konten? | Tidak (E2EE) | Tidak (E2EE, tidak berubah) |
| Relay melihat PIN / key 9router? | Tidak | Tidak: PIN dibuat di HP, key dikirim lewat E2EE |
| Siapa yang memegang kode & key 9router | PC pengguna | Penyedia runner (GitHub/Microsoft, atau pemilik container) |
| Token GitHub untuk Codespaces API | – | Di `localStorage` HP (scope `codespace`), bukan di relay |

Model kepercayaan berubah: penyedia runner bisa melihat isi container. Ini harus tertulis jujur
di README dan di layar onboarding cloud.

**Temuan yang perlu diperbaiki sebelum mode cloud dirilis (berlaku juga di PC):**
`Session.startAgent()` (`daemon/sessions.js`) menyalin `process.env` ke proses agen dan hanya
membuang `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH*`, dll. Variabel seperti `GITHUB_TOKEN`/`GH_TOKEN`
**ikut terwariskan** ke Bash agen. Codespaces selalu menyuntikkan `GITHUB_TOKEN`, sehingga agen
(atau prompt injection dari README/issue) bisa push tanpa melewati pengaman `isRemoteWrite`.
Prinsip "token tidak terlihat oleh agen" di README tidak berlaku di sana. Tambahkan pola tersebut
ke daftar yang dihapus.

---

## 8. Risiko & yang harus divalidasi lebih dulu (spike 1–2 hari, tanpa menulis fitur)

Buat satu codespace manual dari repo ini, lalu jalankan:
```bash
npm i -g . --include=optional
snugcode setup --key <key> --model <model> --github-token "$GITHUB_TOKEN" --pin 123456 --name Cloud --no-browser
snugcode start
```
Hal yang perlu diukur:
1. **Idle timeout:** apakah codespace berhenti saat agen bekerja >30 menit tanpa interaksi editor?
   Coba `idle_timeout_minutes` maksimal, dan apakah daemon yang menulis ke terminal terlihat (mis.
   dijalankan di terminal VS Code yang terbuka) dihitung aktif. Bila tetap berhenti, sesi harus
   tahan restart: transcript sudah persisten (`resume`), jadi minimal tambahkan event "runner
   dihentikan, lanjutkan?" di PWA.
2. Cold start dengan dan tanpa prebuild.
3. Binary `claude` (paket `linux-x64`), `cloudflared`, dan Chromium dari `browser.js` terdeteksi.
4. Preview lewat quick tunnel dari jaringan Codespaces.
5. Apakah memanggil Codespaces API dari PWA (CORS + token OAuth App dengan scope `codespace`) berjalan di Safari iOS.

Risiko lain:
- Kuota habis → PWA perlu menampilkan pemakaian (API billing) dan menghentikan runner yang menganggur.
- Organisasi tidak mendapat kuota gratis; ini khusus akun pribadi.
- Kebijakan GitHub soal pemakaian Codespaces: untuk pengembangan (bukan server/mining). Agen coding masuk kategori pengembangan, tapi daemon yang selalu menyala tetap harus dihindari; stop saat menganggur.

---

## 9. Roadmap bertahap

| Fase | Isi | Ukuran | Hasil |
|---|---|---|---|
| **0. Spike** | Validasi §8 secara manual | S | Go / no-go Codespaces; angka cold start & idle |
| **1. Fondasi (berguna juga untuk PC)** | RPC `configure/devices/revoke/setPin`; wizard setelan di PWA; fix env `GITHUB_TOKEN`; `config.runtime` | M | Semua setelan bisa dari HP |
| **2. Runner headless** | `snugcode cloud`, `/api/machines/provision`, `.devcontainer/`, `Dockerfile`, `test/e2e-cloud.mjs` | M | Daemon bisa hidup di container mana pun tanpa interaksi |
| **3. Codespaces dari PWA** | `web/ui/cloud.js`, onboarding Cloud/PC, bangunkan/hentikan, pairing otomatis, user secret | L | **Tujuan tercapai: tanpa PC** |
| **4. Siklus hidup & UX** | Self-stop menganggur, tampilan kuota, notifikasi "runner berhenti", prebuild | M | Hemat kuota, start cepat |
| **5. Opsional** | Provider Fly/Cloudflare Containers; terminal PTY di HP (xterm.js); file explorer; Mode Ringan via GitHub API | L | Opsi tanpa Codespaces & kenyamanan |

Urutan ini sengaja dimulai dari fase 1, karena hasilnya langsung bermanfaat bagi pengguna PC
dan merupakan prasyarat mode cloud. Fase 2 bisa diuji penuh di CI tanpa akun cloud.

---

## 10. Yang sebaiknya tidak dilakukan
- **Jangan** menulis ulang agen untuk berjalan di browser. Snugcode akan kehilangan keunggulan
  utamanya (Claude Agent SDK, shell nyata, test/build) dan tetap tidak bisa berjalan saat HP terkunci.
- **Jangan** menyimpan key 9router atau token GitHub di relay demi kemudahan. Kirim lewat kanal
  E2EE atau Codespaces secret.
- **Jangan** mem-fork daemon menjadi "versi cloud". Satu codebase dengan `runtime` flag menjaga
  semua perbaikan (proxy `_ide`, izin, checkpoint) tetap berlaku di dua mode.

---

### Referensi eksternal
- [GitHub Codespaces: setting your timeout period](https://docs.github.com/en/enterprise-cloud@latest/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces)
- [GitHub Codespaces: restricting the idle timeout period](https://docs.github.com/en/codespaces/managing-codespaces-for-your-organization/restricting-the-idle-timeout-period)
- [How use of GitHub Codespaces is measured (kuota gratis)](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)
- [Cloudflare Containers FAQ (disk ephemeral)](https://developers.cloudflare.com/containers/faq)
- [Cloudflare Containers: Container class (`sleepAfter`)](https://developers.cloudflare.com/containers/reference/container-class/)
