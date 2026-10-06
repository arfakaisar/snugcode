# pocketcode

Coding agent **Claude Code** yang berjalan di PC masing-masing, memakai model dari **9router**, dan dikendalikan dari **HP** lewat UI bergaya terminal. Repo GitHub di-clone ke PC (bukan ke HP), lalu dianalisis, diedit, di-commit, di-push, dan dibuatkan PR langsung dari HP.

```
 HP (PWA)  ──wss──►  Relay (Cloudflare Worker + Durable Object)  ◄──wss──  PC (daemon pocketcode)
                     hanya meneruskan pesan terenkripsi E2E                 ├─ Claude Code (Agent SDK)
                                                                           ├─ git worktree per sesi
                                                                           └─ 9router (key milik tiap teman)
```

- **Tanpa VPS, tanpa Tailscale, tanpa port terbuka.** PC dan HP sama-sama membuka koneksi keluar ke relay.
- **Login GitHub dan PIN.** HP login dengan akun GitHub yang sama dengan PC, lalu memasukkan PIN **sekali** per HP. Ini bisa dilakukan dari mana saja, tidak perlu scan QR.
- **Enkripsi end-to-end.** PIN diverifikasi dengan PAKE (CPace/ristretto255), jadi relay tidak bisa melihat PIN maupun isi percakapan. Setelah 5 kali salah, pairing terkunci.
- **Key tetap di PC.** API key 9router dan token GitHub tidak pernah dikirim ke HP atau relay.

**Aplikasi HP:** https://pocketcode-relay.arfak.workers.dev

---

## A. Pasang di PC (untuk setiap teman)

Butuh: **Node.js 22+** ([nodejs.org](https://nodejs.org)) dan **git**. Siapkan juga **API key 9router** milikmu.

```bash
npm i -g github:arfakaisar/pocketcode
pocketcode setup
pocketcode autostart on
```

`pocketcode setup` menanyakan:
1. **API key 9router** (`https://router.gemz.space/v1`), lalu model utama dan model kecil.
2. **Cara login GitHub** untuk clone, push, dan PR. Disarankan *login lewat browser/HP*.
3. **Nama PC** dan **PIN** (6–12 huruf/angka, tidak peka huruf besar/kecil, misal `moon42`).
4. Lalu tampil **satu link** (menautkan PC ke akun GitHub-mu) dan **satu kode** (login GitHub untuk PC). Keduanya boleh dibuka dari HP.

`pocketcode autostart on` menjalankan daemon di latar belakang sekarang juga, dan otomatis setiap kali login ke Windows, macOS, atau Linux.

> PC harus menyala dan **tidak tertidur** selama dipakai dari HP. Di Windows: Settings → System → Power → Sleep: *Never* (saat dicolok).

Cara cepat tanpa install global (tanpa autostart): `npx github:arfakaisar/pocketcode setup`, lalu `npx github:arfakaisar/pocketcode start`.



## B. Di HP

1. Buka **https://pocketcode-relay.arfak.workers.dev** di browser HP, lalu **Login dengan GitHub** (akun yang sama dengan setup PC).
2. Pilih PC, lalu masukkan PIN (cukup sekali).
3. Menu browser → **Add to Home screen**, supaya terbuka layar penuh seperti aplikasi.

Cara pakai:
- **+ Sesi baru**: pilih repo, lalu branch baru (default `pocket/<id>`) atau lanjutkan branch yang sudah ada. Setiap sesi memakai git worktree sendiri.
- Ketik permintaan seperti biasa. Awali dengan `!` untuk menjalankan perintah shell langsung, misal `!npm test`.
- **Prompt izin**: perintah yang mengubah sesuatu meminta *Izinkan / Selalu / Tolak*. `git push` dari agen selalu meminta izin.
- **⚡ auto-izin**: semua perintah dijalankan tanpa bertanya, kecuali push.
- **⎇ git**: status, diff berwarna, commit, push, dan Pull Request.
- **■**: hentikan agen yang sedang berjalan.
- Menu `⋯` di daftar sesi: ganti model default.

## Perintah CLI

| Perintah | Fungsi |
|---|---|
| `pocketcode setup` | Setup / ubah konfigurasi |
| `pocketcode start` | Jalankan daemon di terminal ini |
| `pocketcode autostart on\|off` | Jalankan di latar belakang + otomatis saat login |
| `pocketcode stop` | Hentikan daemon latar belakang |
| `pocketcode pin` | Ganti PIN dan buka kunci setelah PIN salah berkali-kali |
| `pocketcode devices` | Daftar HP yang sudah dipasangkan |
| `pocketcode revoke <id\|all>` | Cabut akses HP |
| `pocketcode status` | Ringkasan konfigurasi |

Data disimpan di `~/.pocketcode` (bisa diganti dengan env `POCKETCODE_HOME`):
- `config.json`, `secrets.json`
- `workspaces/<owner>__<repo>/` (clone dasar + worktree per sesi)
- `sessions/` (riwayat event), `daemon.log` (log daemon latar belakang)
- `claude/` (`CLAUDE_CONFIG_DIR` terpisah, jadi tidak mengganggu Claude Code pribadimu)

## Keamanan

- Relay tidak pernah melihat PIN, isi percakapan, kode, key 9router, atau token GitHub.
- Token GitHub disuntikkan lewat env hanya ke perintah git milik daemon. Token tidak ditulis ke `.git/config` dan tidak terlihat oleh agen.
- Agen bekerja di worktree repo. Perintah shell non-read-only meminta izin dari HP, kecuali auto-izin dinyalakan.
- `settingSources: ['project']` berarti `CLAUDE.md` dan `.claude/settings.json` dari repo ikut dimuat, termasuk hook di dalamnya. Pakai hanya untuk repo yang kamu percaya.
- `secrets.json` saat ini berupa file biasa (izin 600 di macOS/Linux). Integrasi keychain OS ada di daftar TODO.

## Untuk pemilik: relay

Relay (Worker `pocketcode-relay` di akun Cloudflare pemilik) dan OAuth App GitHub sudah disiapkan. Untuk deploy ulang setelah mengubah `relay/` atau `web/`:

```bash
npm install && (cd relay && npm install)
CLOUDFLARE_API_TOKEN=<token> npm run deploy
```

Secret relay di Cloudflare: `GITHUB_CLIENT_SECRET` dan `TOKEN_SECRET`. Kalau `TOKEN_SECRET` diganti, semua login HP dan PC harus diulang.

## Pengembangan lokal

```bash
npm install && (cd relay && npm install)
printf 'TOKEN_SECRET=dev\n' > relay/.dev.vars
npm run dev:relay                         # relay + PWA di http://127.0.0.1:8787, login dev tanpa GitHub

POCKETCODE_HOME=/tmp/pc node daemon/cli.js setup --relay http://127.0.0.1:8787 \
  --key <key 9router> --model gemini/gemini-3.8-flash --skip-github --pin 123456 --name DevPC
POCKETCODE_HOME=/tmp/pc node daemon/cli.js start

npm test                                   # unit test kripto
node test/e2e-phone.mjs                    # simulasi HP: pairing → sesi → agen → git
```

## TODO / ide berikutnya

- Integrasi keychain OS untuk `secrets.json`, dan opsi "cegah sleep" selama sesi aktif.
- Web Push notification (saat ini notifikasi hanya muncul ketika PWA terbuka).
- Pane shell interaktif (PTY) dan upload gambar/screenshot ke agen.
- Dukungan model Claude asli (bagian kedua rencana): cukup tambahkan pilihan provider per sesi di `daemon/sessions.js`.
