// secrets.json terenkripsi dengan kunci di keychain OS (opt-in: `snugcode keychain on`).
// Isinya (token relay, token GitHub, API key, secret perangkat HP) dienkripsi XChaCha20-Poly1305;
// kuncinya hanya tersimpan di keychain OS: macOS Keychain (`security`), Secret Service di Linux
// (`secret-tool`: GNOME Keyring / KWallet), atau DPAPI di Windows (dibungkus per user Windows).
// Salinan folder data (backup, sinkronisasi cloud, disk yang dicuri/dipinjam) tidak membuka isinya.
// Proses lain milik user yang sama yang boleh membuka keychain tetap bisa: ini perlindungan saat
// diam (at rest), bukan sandbox. Agen tetap dibatasi kebijakan izin & sandbox OS.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const SERVICE = 'snugcode';
const AAD = new TextEncoder().encode('snugcode-secrets-v1');
const TIMEOUT = 15_000;

// Satu item per folder data (beberapa instalasi / SNUGCODE_HOME tidak saling menimpa).
export const accountFor = (home) => 'data-' + createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);

const run = (file, args, input) => execFileSync(file, args, { input, encoding: 'utf8', timeout: TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
const missing = (e) => e?.status === 44 || e?.status === 1; // security: 44 = tidak ada; secret-tool: 1

const PS_PROTECT = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,[Text.Encoding]::UTF8.GetBytes('${SERVICE}'),'CurrentUser'))`;
const PS_UNPROTECT = PS_PROTECT.replace('::Protect(', '::Unprotect(');
const ps = (script, input) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input);

/** @typedef {{ name: string, label: string, available(): string | null, get(home: string): string | null, set(home: string, hex: string): void, del(home: string): void }} Backend */

/** @type {Record<string, Backend>} */
const BACKENDS = {
  darwin: {
    name: 'macos',
    label: 'macOS Keychain',
    available: () => (fs.existsSync('/usr/bin/security') ? null : '/usr/bin/security tidak ada'),
    get(home) {
      try {
        return run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', accountFor(home), '-w']);
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    // Lewat `security -i` (stdin) agar kunci tidak terlihat di daftar proses.
    set: (home, hex) => void run('/usr/bin/security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${accountFor(home)} -l "snugcode secrets" -w ${hex}\n`),
    del(home) {
      try {
        run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', accountFor(home)]);
      } catch {}
    },
  },
  linux: {
    name: 'secret-service',
    label: 'Secret Service (GNOME Keyring / KWallet)',
    available() {
      const onPath = (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, 'secret-tool')));
      if (!onPath) return 'secret-tool tidak terpasang (Debian/Ubuntu: sudo apt install libsecret-tools)';
      const uid = process.getuid?.();
      if (!process.env.DBUS_SESSION_BUS_ADDRESS && !(uid != null && fs.existsSync(`/run/user/${uid}/bus`))) return 'tidak ada sesi D-Bus (jalankan dari sesi desktop)';
      return null;
    },
    get(home) {
      try {
        return run('secret-tool', ['lookup', 'service', SERVICE, 'account', accountFor(home)]) || null;
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    set: (home, hex) => void run('secret-tool', ['store', '--label=snugcode secrets', 'service', SERVICE, 'account', accountFor(home)], hex),
    del(home) {
      try {
        run('secret-tool', ['clear', 'service', SERVICE, 'account', accountFor(home)]);
      } catch {}
    },
  },
  // DPAPI tidak punya tempat simpan: kunci yang sudah dibungkus (hanya bisa dibuka user Windows ini
  // di PC ini) disimpan di secrets.key, di samping secrets.json.
  win32: {
    name: 'dpapi',
    label: 'Windows DPAPI',
    available: () => null,
    get(home) {
      const f = path.join(home, 'secrets.key');
      if (!fs.existsSync(f)) return null;
      return Buffer.from(ps(PS_UNPROTECT, fs.readFileSync(f, 'utf8')), 'base64').toString('hex');
    },
    set: (home, hex) => fs.writeFileSync(path.join(home, 'secrets.key'), ps(PS_PROTECT, Buffer.from(hex, 'hex').toString('base64')), { mode: 0o600 }),
    del: (home) => fs.rmSync(path.join(home, 'secrets.key'), { force: true }),
  },
};

// Hanya untuk test: keychain palsu berupa folder (SNUGCODE_KEYCHAIN_FAKE=<folder>).
const fakeBackend = (dir) => ({
  name: 'fake',
  label: 'keychain uji',
  available: () => null,
  get: (home) => (fs.existsSync(path.join(dir, accountFor(home))) ? fs.readFileSync(path.join(dir, accountFor(home)), 'utf8') : null),
  set: (home, hex) => (fs.mkdirSync(dir, { recursive: true }), fs.writeFileSync(path.join(dir, accountFor(home)), hex)),
  del: (home) => fs.rmSync(path.join(dir, accountFor(home)), { force: true }),
});

/** @returns {Backend | null} */
export function backend() {
  if (process.env.SNUGCODE_KEYCHAIN_FAKE) return fakeBackend(process.env.SNUGCODE_KEYCHAIN_FAKE);
  return BACKENDS[process.platform] || null;
}

export const isSealed = (obj) => !!obj && typeof obj === 'object' && obj.snugcodeKeychain === 1;

const keys = new Map(); // kunci yang sudah dibuka di proses ini (satu panggilan keychain per proses)
function keyFor(home, kc) {
  const cached = keys.get(home);
  if (cached) return cached;
  const b = backend();
  const why = !b ? 'OS ini tidak didukung' : b.name !== kc ? `dibuat dengan ${kc}, sekarang ${b.name}` : b.available();
  let hex = null;
  let err = why;
  if (!why) {
    try {
      hex = b.get(home);
      if (!hex) err = 'kuncinya tidak ada di keychain';
    } catch (e) {
      err = String(e?.stderr || e?.message || e).trim().split('\n')[0] || 'keychain menolak';
    }
  }
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex))
    throw new Error(
      `secrets.json terenkripsi dengan kunci di keychain OS, tapi kuncinya tidak bisa dibuka (${err || 'format kunci salah'}). ` +
        'Buka kunci keychain (login ke sesi desktop) lalu coba lagi. Bila kuncinya hilang permanen: hapus secrets.json di folder data snugcode, lalu `snugcode setup` dan pasangkan HP lagi.',
    );
  const key = Buffer.from(hex, 'hex');
  keys.set(home, key);
  return key;
}

/** @param {any} file @param {string} home */
export function openSealed(file, home) {
  const key = keyFor(home, file.kc);
  try {
    const pt = xchacha20poly1305(key, Buffer.from(file.n, 'hex'), AAD).decrypt(Buffer.from(file.c, 'base64'));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new Error('secrets.json terenkripsi tidak bisa dibuka dengan kunci di keychain (kunci berbeda atau file rusak).');
  }
}

/** @param {object} sec @param {string} home @param {string} kc */
export function seal(sec, home, kc) {
  const key = keyFor(home, kc);
  const n = randomBytes(24);
  const c = xchacha20poly1305(key, n, AAD).encrypt(new TextEncoder().encode(JSON.stringify(sec)));
  return { snugcodeKeychain: 1, kc, n: n.toString('hex'), c: Buffer.from(c).toString('base64') };
}

// `snugcode keychain on`: kunci baru di keychain, diverifikasi bisa dibaca kembali sebelum dipakai.
/** @param {string} home */
export function enableKeychain(home) {
  const b = backend();
  if (!b) throw new Error('Keychain OS belum didukung di ' + process.platform);
  const why = b.available();
  if (why) throw new Error(`${b.label} tidak tersedia: ${why}`);
  const hex = randomBytes(32).toString('hex');
  b.set(home, hex);
  if (b.get(home) !== hex) throw new Error(`${b.label} tidak mengembalikan kunci yang sama; keychain tidak dipakai.`);
  keys.set(home, Buffer.from(hex, 'hex'));
  return b;
}

/** @param {string} home */
export function disableKeychain(home) {
  backend()?.del(home);
  keys.delete(home);
}
