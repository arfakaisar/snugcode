// secrets.json encrypted with a key in the OS keychain (opt-in: `snugcode keychain on`).
// Its contents (relay token, GitHub token, API keys, phone device secrets) are encrypted with XChaCha20-Poly1305;
// the key lives only in the OS keychain: macOS Keychain (`security`), Secret Service on Linux
// (`secret-tool`: GNOME Keyring / KWallet), or DPAPI on Windows (wrapped per Windows user).
// Copies of the data folder (backups, cloud sync, a stolen/borrowed disk) don't reveal the contents.
// Other processes of the same user that may open the keychain still can: this is protection at
// rest, not a sandbox. The agent is still limited by the permission policy & OS sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const SERVICE = 'snugcode';
const AAD = new TextEncoder().encode('snugcode-secrets-v1');
const TIMEOUT = 15_000;

// One item per data folder (multiple installs / SNUGCODE_HOME don't overwrite each other).
export const accountFor = (home) => 'data-' + createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16);

const run = (file, args, input) => execFileSync(file, args, { input, encoding: 'utf8', timeout: TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
const missing = (e) => e?.status === 44 || e?.status === 1; // security: 44 = not found; secret-tool: 1

const PS_PROTECT = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,[Text.Encoding]::UTF8.GetBytes('${SERVICE}'),'CurrentUser'))`;
const PS_UNPROTECT = PS_PROTECT.replace('::Protect(', '::Unprotect(');
const ps = (script, input) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input);

/** @typedef {{ name: string, label: string, available(): string | null, get(home: string): string | null, set(home: string, hex: string): void, del(home: string): void }} Backend */

/** @type {Record<string, Backend>} */
const BACKENDS = {
  darwin: {
    name: 'macos',
    label: 'macOS Keychain',
    available: () => (fs.existsSync('/usr/bin/security') ? null : '/usr/bin/security not found'),
    get(home) {
      try {
        return run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', accountFor(home), '-w']);
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    // Via `security -i` (stdin) so the key isn't visible in the process list.
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
      if (!onPath) return 'secret-tool is not installed (Debian/Ubuntu: sudo apt install libsecret-tools)';
      const uid = process.getuid?.();
      if (!process.env.DBUS_SESSION_BUS_ADDRESS && !(uid != null && fs.existsSync(`/run/user/${uid}/bus`))) return 'no D-Bus session (run from a desktop session)';
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
  // DPAPI has no store: the wrapped key (only this Windows user on this PC can unwrap it)
  // is kept in secrets.key, next to secrets.json.
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

// Tests only: a fake keychain backed by a folder (SNUGCODE_KEYCHAIN_FAKE=<folder>).
const fakeBackend = (dir) => ({
  name: 'fake',
  label: 'test keychain',
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

const keys = new Map(); // keys already unlocked in this process (one keychain call per process)
function keyFor(home, kc) {
  const cached = keys.get(home);
  if (cached) return cached;
  const b = backend();
  const why = !b ? 'this OS is not supported' : b.name !== kc ? `created with ${kc}, now ${b.name}` : b.available();
  let hex = null;
  let err = why;
  if (!why) {
    try {
      hex = b.get(home);
      if (!hex) err = 'the key is not in the keychain';
    } catch (e) {
      err = String(e?.stderr || e?.message || e).trim().split('\n')[0] || 'keychain refused';
    }
  }
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex))
    throw new Error(
      `secrets.json is encrypted with a key in the OS keychain, but the key can't be unlocked (${err || 'bad key format'}). ` +
        'Unlock the keychain (sign in to a desktop session) and try again. If the key is permanently lost: delete secrets.json in the snugcode data folder, then run `snugcode setup` and pair your phone again.',
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
    throw new Error('The encrypted secrets.json can\'t be opened with the keychain key (different key or corrupted file).');
  }
}

/** @param {object} sec @param {string} home @param {string} kc */
export function seal(sec, home, kc) {
  const key = keyFor(home, kc);
  const n = randomBytes(24);
  const c = xchacha20poly1305(key, n, AAD).encrypt(new TextEncoder().encode(JSON.stringify(sec)));
  return { snugcodeKeychain: 1, kc, n: n.toString('hex'), c: Buffer.from(c).toString('base64') };
}

// `snugcode keychain on`: a new key in the keychain, verified to read back before use.
/** @param {string} home */
export function enableKeychain(home) {
  const b = backend();
  if (!b) throw new Error('OS keychain is not supported on ' + process.platform);
  const why = b.available();
  if (why) throw new Error(`${b.label} is unavailable: ${why}`);
  const hex = randomBytes(32).toString('hex');
  b.set(home, hex);
  if (b.get(home) !== hex) throw new Error(`${b.label} didn't return the same key; keychain not used.`);
  keys.set(home, Buffer.from(hex, 'hex'));
  return b;
}

/** @param {string} home */
export function disableKeychain(home) {
  backend()?.del(home);
  keys.delete(home);
}
