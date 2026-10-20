# Keamanan snugcode: apa yang dilindungi, apa yang tidak

Dokumen ini menjelaskan model ancaman snugcode secara jujur, supaya kamu bisa menilai sendiri seberapa jauh
mempercayainya. Ringkasan teknis fitur keamanan ada di [README → Keamanan](../README.md#keamanan) dan
[`master.md` §4](../master.md).

## Pihak yang terlibat

| Pihak | Dipercaya untuk | Tidak dipercaya untuk |
|---|---|---|
| **PC / runner-mu** (daemon) | Menyimpan kode, API key, token GitHub, dan secret perangkat | — (kalau PC-mu sendiri dibobol, semuanya ikut) |
| **HP-mu** (PWA) | Menyimpan token login relay & secret perangkat per PC (`localStorage`) | — |
| **Relay** (Cloudflare Worker) | Meneruskan pesan, login GitHub, daftar mesin, **menyajikan kode PWA** | Membaca isi pesan |
| **Agen AI** | Mengerjakan tugas di folder sesi | Membaca kredensial, push tanpa izin, mengubah hook/konfigurasi tool |
| **Provider model** (Anthropic, OpenAI, …) | Memproses prompt & kode yang dikirim agen | — (mereka melihat semua yang dibaca agen) |

## Yang dilindungi

- **Isi percakapan, kode, diff, PIN, API key** tidak bisa dibaca relay: pairing memakai PAKE (CPace) dan setiap
  pesan dienkripsi end-to-end (XChaCha20-Poly1305). Relay yang hanya *menguping* tidak mendapat apa pun, dan tidak
  bisa menebak PIN secara offline.
- **Kredensial tidak sampai ke agen**: proses agen hanya memegang token lokal; folder data `~/.snugcode` ditolak
  untuk semua tool file dan (saat auto-izin / Codex) oleh sandbox OS.
- **Penautan PC ke akun** butuh konfirmasi eksplisit *setelah* login GitHub (POST dengan token bertanda tangan).
  Link dari orang lain tidak bisa diam-diam menautkan PC mereka ke akunmu.
- **Aksi ke remote** (`git push`, `gh pr create`, …) selalu bertanya, di semua tingkat otonomi.

## Yang TIDAK dilindungi (batasan yang perlu kamu tahu)

1. **Relay menyajikan kode PWA.** Enkripsi end-to-end di browser berarti kode enkripsinya datang dari server yang
   sama yang meneruskan pesan. Siapa pun yang menguasai deploy relay (akun Cloudflare, token
   `CLOUDFLARE_API_TOKEN`, workflow Deploy, atau repo ini) **bisa mengirim versi PWA yang membaca secret
   perangkat** dari `localStorage` lalu membuka kanal ke PC-mu. Ini batasan umum semua aplikasi web E2EE. Mitigasi:
   - CSP ketat: tanpa skrip inline/pihak ketiga, `connect-src` hanya ke relay sendiri (XSS tidak bisa mengirim data
     ke server lain).
   - **Build yang bisa diverifikasi** (lihat bawah): bandingkan PWA yang disajikan dengan hasil build kode sumber.
   - **Self-host relay** (lihat bawah) bila kamu tidak ingin mempercayai relay publik.
2. **Prompt injection.** Agen membaca README, issue, dan output perintah yang bisa berisi instruksi jahat.
   Kebijakan izin, tingkat risiko di kartu izin, dan sandbox OS membatasi dampaknya, tapi **perintah yang kamu
   izinkan berjalan sebagai user-mu** (di luar auto-izin tanpa sandbox). Baca perintah berisiko tinggi sebelum
   mengizinkan.
3. **Deteksi perintah berbasis pola teks** (push, file kredensial, tingkat risiko) adalah pengaman UX, bukan batas
   keamanan. Skrip yang memanggil `git push` dari dalam file tidak terdeteksi sebagai push.
4. **Provider model** melihat semua yang dibaca dan ditulis agen, termasuk isi file di repo.
5. **Mode Komputer & terminal PTY** sengaja memberi akses ke seluruh PC (terminal tanpa sandbox).
6. **HP yang hilang**: siapa pun yang membuka PWA di HP itu bisa memakai PC-mu. Cabut dari aplikasi
   (Pengaturan PC → Perangkat), `snugcode revoke all` di PC, dan *Keluar dari semua perangkat*.

## Memverifikasi PWA yang kamu pakai

Setiap build menulis `build.json` berisi SHA-256 tiap file yang disajikan. Rilis GitHub melampirkan `build.json`
hasil build dari kode bertag, dan workflow Deploy memastikan relay menyajikan build commit yang lulus CI.

```bash
# PWA yang sedang disajikan relay
curl -s https://snugcode.arfak.workers.dev/build.json | jq -r .digest
# hasil build dari kode sumber (tag yang sama)
git checkout vX.Y.Z && npm ci && npm run build:web && jq -r .digest relay/public/build.json
# atau unduh build.json dari halaman rilis GitHub dan bandingkan
```

Digest yang berbeda berarti PWA yang disajikan bukan hasil build kode itu. Cek satu file langsung:
`curl -s https://snugcode.arfak.workers.dev/app.js | sha256sum` dibandingkan dengan `files["app.js"]`.

## Self-host relay

Relay adalah satu Cloudflare Worker + Durable Objects (paket gratis cukup untuk pemakaian pribadi).

1. Fork repo ini. Buat **OAuth App** GitHub (Settings → Developer settings → OAuth Apps) dengan callback
   `https://<nama-worker>.<akun>.workers.dev/auth/callback`.
2. Di `relay/wrangler.jsonc`: ganti `GITHUB_CLIENT_ID`, `PUBLIC_URL` (alamatmu), kosongkan `LEGACY_HOSTS`, dan
   `RUNNER_REPO` ke fork-mu (untuk runner Codespaces).
3. Secret: `cd relay && npx wrangler secret put GITHUB_CLIENT_SECRET` dan `npx wrangler secret put TOKEN_SECRET`
   (string acak panjang, mis. `openssl rand -hex 32`).
4. Deploy: `npm run deploy` (atau set `CLOUDFLARE_API_TOKEN` di Actions fork-mu agar workflow Deploy jalan setelah
   CI lulus). Bila tidak memakai worker alias, deploy cukup `npx wrangler deploy` di `relay/`.
5. Di PC: `snugcode setup --relay https://<alamatmu>` (atau pemasang:
   `curl -fsSL https://<alamatmu>/install.sh | SNUGCODE_RELAY=https://<alamatmu> sh`). Buka `https://<alamatmu>`
   di HP.

CSP PWA otomatis mengizinkan WebSocket ke `PUBLIC_URL` & `LEGACY_HOSTS` dari `wrangler.jsonc` (atau
`SNUGCODE_WS_HOSTS=host1,host2 npm run build:web`).

## Melaporkan celah keamanan

Jangan buka issue publik. Kirim email ke pemilik repo (lihat profil GitHub) dengan langkah reproduksi; laporan
akan dijawab secepatnya dan dicatat di CHANGELOG setelah diperbaiki.
