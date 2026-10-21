# Analisis & rekomendasi perbaikan (Oktober 2026)

Tinjauan menyeluruh atas daemon, relay, PWA, test, dan alur rilis: apa yang sudah kuat, apa yang diperbaiki di
branch ini, dan rekomendasi berikutnya, diurutkan dari dampak terbesar. Angka di bawah diukur dari kode di branch
ini (`npm run build:web`, `npm test`, `npm run test:ui`).

## Yang sudah kuat

- **Keamanan berlapis**: PAKE (CPace) + XChaCha20-Poly1305 per pesan, CSP `script-src 'self'` (bahkan `eval` string
  ditolak), token WebSocket lewat subprotocol, cloudflared dipatok SHA-256, model ancaman yang ditulis jujur.
- **Koneksi tahan banting**: batas waktu menyambung/auth/RPC, heartbeat, `wake()` saat aplikasi dibuka lagi.
- **Test nyata**: 74 unit test, e2e relay + daemon asli + PWA di Chromium + TUI di PTY, CI di 3 OS.
- **PWA ringan**: xterm.js (345 KB) dipisah dari `app.js` dan hanya dimuat saat terminal dibuka; font di-host sendiri.

## Diperbaiki di branch ini

| Masalah | Penyebab | Perbaikan |
|---|---|---|
| Mengetik di terminal dari HP Android tidak memunculkan apa pun | Keyboard HP mengetik lewat komposisi IME (keydown 229). xterm.js baru meneruskan kata setelah spasi/Enter, dan huruf dengan keydown 229 di luar komposisi bisa hilang. | Jembatan input di `web/ui/terminal.js`: perubahan isi textarea xterm dikirim langsung sebagai selisih (`imeDelta`), event komposisi dihentikan sebelum sampai ke xterm. Keyboard fisik tetap lewat xterm (tanpa huruf ganda). |
| Halaman PWA bisa di-zoom (cubit / ketuk dua kali) | Meta viewport tanpa `user-scalable=no`; `touch-action: manipulation` masih mengizinkan pinch-zoom. | `maximum-scale=1, user-scalable=no`, `touch-action: pan-x pan-y`, `gesturestart` dibatalkan untuk Safari iOS. |
| Tidak bisa menempel teks ke terminal di HP | Menekan lama kanvas xterm tidak memberi menu Tempel. | Tombol **Tempel** (bracketed paste), **Home**, **End**. |
| Huruf terminal terlalu kecil/besar, padahal zoom dikunci | — | Cubit dua jari di terminal mengubah ukuran huruf (diingat per perangkat). |
| Pembaca yang butuh huruf besar kehilangan zoom halaman | Konsekuensi kunci zoom. | **Ukuran teks** di Akun & tampilan (4 tingkat, CSS `zoom` pada isi layar/sheet/drawer, tanpa kedip saat dibuka). |
| Sulit menyalin output terminal di HP | Seleksi di kanvas xterm sulit di layar sentuh. | Tombol **Salin**: teks terpilih, atau seluruh isi layar. |
| Membuka terminal di sinyal lemah gagal | `xterm.js` (345 KB) baru diunduh saat tombol Terminal diketuk. | Aset terminal di-prefetch saat idle ketika sesi dengan terminal dibuka (disimpan service worker). |

Regresi terminal dijaga `test/e2e-ui.mjs`: komposisi IME, koreksi otomatis, Backspace lewat IME, dan Enter di tengah
komposisi disimulasikan lewat CDP (`Input.imeSetComposition`). Test ini gagal di kode lama dan lulus di kode baru.

## Rekomendasi berikutnya

### Infrastruktur (dampak terbesar)

1. **Terbitkan tag rilis pertama (`v0.4.0`) dan lindungi `main`.** Repo belum punya satu pun tag, jadi kanal
   `stable` daemon jatuh ke `main` (`daemon/updater.js`). Setiap push ke `main` langsung terpasang otomatis di semua PC
   pengguna, termasuk commit langsung tanpa PR seperti `aaa`/`bbb` (masing-masing 1.400+ baris). Langkahnya:
   `git tag v0.4.0 <commit> && git push --tags`, lalu aktifkan branch protection (wajib PR + CI hijau) di GitHub.
   Workflow Release yang sudah ada akan melampirkan `build.json`.
2. **Pesan commit deskriptif** sesuai `CONTRIBUTING.md` (bisa dipaksa dengan pemeriksaan judul PR di CI). Riwayat
   seperti `teest`/`again`/`stable?` menyulitkan pelacakan regresi lewat `git bisect`.
3. **Code-splitting `app.js` sengaja tidak dilakukan.** Diukur dengan metafile esbuild: modul yang bisa ditunda
   (git, files, run, terminal) hanya ±12% dari 248 KB (±10 KB gzip) karena graf import antar layar saling terkait
   (`machine` ↔ `sessions` ↔ `session` ↔ `settings`). Manfaat sekecil itu tidak sebanding dengan risikonya: service
   worker stale-while-revalidate bisa menyajikan `app.js` lama yang merujuk chunk yang sudah hilang dari server.
   Layak ditinjau lagi bila layar besar (mis. runner cloud) dipisah dari `machine.js`.
4. **File besar**: `daemon/tui.js` (1.718 baris) dan `daemon/sessions.js` (1.130 baris) layak dipecah per tanggung
   jawab, seperti yang sudah dilakukan untuk engine (`engine-claude.js`, `engine-codex.js`, `engine-gemini.js`).

### UI/UX

1. **Uji di perangkat sungguhan** (Android Gboard/Samsung Keyboard, iPhone Safari) untuk terminal dan kunci zoom.
   Emulasi Chromium tidak mensimulasikan pinch-zoom halaman maupun semua perilaku keyboard IME.
