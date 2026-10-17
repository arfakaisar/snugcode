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
