# snugcode runner

Codespace ini menjalankan **daemon snugcode** — agen Claude Code yang kamu kendalikan dari aplikasi
snugcode di HP. Kamu tidak perlu melakukan apa pun di sini.

- Log runner: `/workspaces/.snugcode/cloud.log`
- Status: `snugcode status`
- Runner berhenti sendiri setelah 30 menit tidak dipakai (bisa diubah di aplikasi), dan menyala lagi
  saat kamu membuka PC "Cloud" di aplikasi.
- Repo yang dikerjakan agen ada di `/workspaces/.snugcode/workspaces/`, satu worktree per sesi.
