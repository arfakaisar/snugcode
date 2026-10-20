// State aplikasi yang dipakai bersama semua layar (dulu variabel global di app.js).
//   conn    : koneksi E2EE ke PC yang sedang dibuka (web/conn.js)
//   current : konteks layar aktif { m, info, session, renderer, procs, preview, ... }
//   me      : akun relay yang sedang login { login }
//   permFromPush : jawaban izin dari tombol notifikasi { pid, decision }, dipakai renderer saat kartu itu muncul
/** @type {{ conn: any, current: any, me: any, permFromPush?: { pid: string, decision: 'allow' | 'deny' } | null }} */
export const app = { conn: null, current: null, me: null, permFromPush: null };
