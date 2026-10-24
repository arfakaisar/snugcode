// App lock (optional, per phone): the app asks for the phone's own screen lock (fingerprint, face, device PIN) through
// WebAuthn before it shows anything or uses a PC pairing, at start and after being in the background for a while.
// A lost or borrowed unlocked phone then can't drive the PC with one tap. It's a local gate in this app (no server
// checks the signature): it doesn't protect against someone who can read the browser's storage with developer tools.
// Allow/Deny from a notification waits until the app is unlocked.
import { store } from '../conn.js';
import { b64, unb64, randomBytes } from '../../shared/crypto.js';
import { app } from './state.js';
import { h, ic, mascot } from './dom.js';

// Locked again after this long in the background.
const RELOCK_MS = 5 * 60 * 1000;
let hiddenAt = 0;

export const lockEnabled = () => !!store.get('lock')?.id;

export async function lockSupported() {
  try {
    return !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

// User verified = bit 2 of the authenticator data flags (byte 32).
const verified = (cred) => !!cred && (new Uint8Array(/** @type {any} */ (cred).response.authenticatorData)[32] & 0x04) !== 0;

/** Turn the lock on: creates a platform credential that requires the phone's screen lock. */
export async function enableLock() {
  if (!(await lockSupported())) throw new Error('This phone/browser has no screen lock that apps can use (fingerprint, face, or device PIN).');
  const cred = /** @type {PublicKeyCredential | null} */ (
    await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: 'snugcode', id: location.hostname },
        user: { id: randomBytes(16), name: 'snugcode', displayName: 'snugcode app lock' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60_000,
      },
    })
  );
  if (!cred) throw new Error('App lock was not set up.');
  store.set('lock', { id: b64(new Uint8Array(cred.rawId)) });
  return true;
}

export async function disableLock() {
  await verify(); // turning it off needs the screen lock too
  store.set('lock', null);
  return false;
}

async function verify() {
  const lock = store.get('lock');
  if (!lock?.id) return true;
  const cred = await navigator.credentials.get({
    publicKey: { challenge: randomBytes(32), allowCredentials: [{ type: 'public-key', id: unb64(lock.id) }], userVerification: 'required', timeout: 60_000 },
  });
  if (!verified(cred)) throw new Error('The phone did not confirm it’s you.');
  return true;
}

/** Shows the lock screen (if the lock is on) and resolves once unlocked. */
export function ensureUnlocked() {
  if (!lockEnabled()) return Promise.resolve();
  if (app.unlocking) return app.unlocking;
  app.locked = true;
  const msg = h('p', { class: 'muted small', role: 'status' }, '');
  const btn = h('button', { class: 'btn primary' }, ic('lock'), 'Unlock');
  const screen = h('div', { id: 'lockscreen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'snugcode is locked' },
    h('div', { class: 'inner' }, mascot('draw xl'), h('h2', { class: 'serif' }, 'snugcode is locked'), h('p', { class: 'muted' }, 'Use your phone’s screen lock to open it.'), btn, msg),
  );
  document.body.append(screen);
  app.unlocking = new Promise((resolve) => {
    const attempt = async () => {
      btn.disabled = true;
      msg.textContent = '';
      try {
        await verify();
        app.locked = false;
        app.unlocking = null;
        screen.remove();
        resolve();
        // A notification Allow/Deny tapped while locked is answered now.
        if (app.permFromPush) app.current?.renderer?.answerFromPush?.();
      } catch (e) {
        msg.textContent = e?.name === 'NotAllowedError' ? 'Cancelled. Tap Unlock to try again.' : String(e?.message || e);
      } finally {
        btn.disabled = false;
      }
    };
    btn.onclick = attempt;
    attempt();
  });
  return app.unlocking;
}

// Background → foreground after RELOCK_MS: lock again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (lockEnabled() && hiddenAt && Date.now() - hiddenAt > RELOCK_MS) ensureUnlocked();
});
