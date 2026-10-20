# snugcode runner

Codespace ini menjalankan **daemon snugcode** — agen Claude Code yang kamu kendalikan dari aplikasi
snugcode di HP. Kamu tidak perlu melakukan apa pun di sini.

- Log runner: `/workspaces/.snugcode/cloud.log`; log pemasangan: `install.log` di folder yang sama
  (bila `/workspaces` tidak bisa ditulis, folder data pindah ke `~/.snugcode`).
- Tahap dan error saat runner menyala juga dikirim ke aplikasi, jadi biasanya log tidak perlu dibuka.
- Status: `snugcode status`
- Runner berhenti sendiri setelah 30 menit tidak dipakai (bisa diubah di aplikasi: Pengaturan runner →
  Berhenti otomatis), dan menyala lagi saat kamu membuka runner "Cloud" di aplikasi.
- Repo yang dikerjakan agen ada di `/workspaces/.snugcode/workspaces/`, satu worktree per sesi.
- Jangan hapus codespace ini dari GitHub bila masih dipakai; untuk berhenti memakai runner, hapus dari
  aplikasi (daftar mesin → ⋯ → Hapus) agar codespace, secret, dan mesinnya ikut terhapus.

## Prebuild (opsional): runner baru lebih cepat

Tanpa prebuild, membuat runner butuh ±3–5 menit (memasang Chromium, bubblewrap, dan snugcode). Dengan prebuild,
semua itu sudah ada di snapshot dan runner menyala dalam ±1 menit. Prebuild diatur di setelan repo **fork**-mu
(GitHub tidak menyediakan API untuk ini):

1. Buka fork snugcode-mu → **Settings → Codespaces → Set up prebuild**.
2. Branch `main`, konfigurasi `.devcontainer/devcontainer.json`, region yang sama dengan codespace-mu.
3. Trigger: **On configuration change** (prebuild hanya dibuat ulang saat `.devcontainer/` berubah; snugcode
   memperbarui dirinya sendiri setelah menyala).

Snapshot prebuild memakai kuota penyimpanan Codespaces (gratis 15 GB-bulan untuk akun Free), dan setiap build
memakai core-jam Actions. Pemakaian core-jam runner bulan ini (perkiraan) tampil di aplikasi: menu runner →
Runner cloud.
