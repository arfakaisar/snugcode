# Berkontribusi ke snugcode

## Alur kerja
- Kerjakan di branch, buka Pull Request ke `main`. CI (sintaks, typecheck, unit test di 3 OS, e2e) harus lulus;
  workflow Deploy baru berjalan setelah CI lulus di `main`.
- Pesan commit menjelaskan perubahan, mis. `fix(relay): konfirmasi penautan PC setelah login` — bukan `aaa`.
  Riwayat commit dibaca orang yang memakai kanal `main` dan saat menelusuri regresi.
- Perubahan perilaku dicatat di `CHANGELOG.md`; arsitektur/endpoint/RPC baru di `master.md`.

## Menjalankan test
```bash
npm ci && npm ci --prefix relay
npm test                      # unit test
npm run typecheck
npm run dev:relay             # terminal lain: relay lokal (DEV_AUTH)
npm run test:e2e:relay && npm run test:e2e && npm run test:ui   # CHROME=/path/chrome bila perlu
```

## Rilis (kanal "stable")
Daemon kanal stable hanya memasang rilis bertag. Tanpa tag, semua pengguna mendapat setiap commit `main`.
```bash
npm version minor     # naikkan versi + commit + tag vX.Y.Z (samakan dengan CHANGELOG)
git push --follow-tags
```
Workflow Release menjalankan test, melampirkan `build.json` (hash PWA, lihat `docs/keamanan.md`), dan menerbitkan ke
npm bila secret `NPM_TOKEN` ada.

## Keamanan
Celah keamanan dilaporkan secara privat (lihat `docs/keamanan.md`), bukan lewat issue publik.
