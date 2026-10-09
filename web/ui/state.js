// State aplikasi yang dipakai bersama semua layar (dulu variabel global di app.js).
//   conn    : koneksi E2EE ke PC yang sedang dibuka (web/conn.js)
//   current : konteks layar aktif { m, info, session, renderer, procs, preview, ... }
//   me      : akun relay yang sedang login { login }
export const app = { conn: null, current: null, me: null };
