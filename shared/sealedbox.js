// libsodium crypto_box_seal (sealed box): enkripsi anonim ke sebuah public key X25519.
// Dipakai PWA untuk Codespaces secrets — GitHub mewajibkan nilai secret dienkripsi dengan
// sealed box ke public key akun, jadi token mesin & PIN runner tidak pernah dikirim polos
// (dan tidak pernah lewat relay).
//
//   sealed = epk || crypto_box(msg, nonce = blake2b-24(epk || pk), pk, esk)
//   crypto_box = XSalsa20-Poly1305 dengan kunci HSalsa20(X25519(esk, pk), 0^16)
import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { hsalsa, xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]); // "expand 32-byte k"
const u32 = (b) => new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4);

// crypto_box_beforenm: HSalsa20 dari shared secret X25519 dengan nonce nol.
function boxKey(shared) {
  const out = new Uint32Array(8);
  hsalsa(SIGMA, u32(Uint8Array.from(shared)), new Uint32Array(4), out);
  return new Uint8Array(out.buffer);
}

/** @param {Uint8Array} message @param {Uint8Array} publicKey 32 byte @returns {Uint8Array} */
export function sealedBox(message, publicKey, esk = randomBytes(32)) {
  if (publicKey.length !== 32) throw new Error('public key harus 32 byte');
  const epk = x25519.getPublicKey(esk);
  const nonce = blake2b(concatBytes(epk, publicKey), { dkLen: 24 });
  const key = boxKey(x25519.getSharedSecret(esk, publicKey));
  return concatBytes(epk, xsalsa20poly1305(key, nonce).encrypt(message));
}

// Kebalikannya (untuk uji): dibuka dengan secret key penerima.
/** @param {Uint8Array} sealed @param {Uint8Array} secretKey @returns {Uint8Array} */
export function openSealedBox(sealed, secretKey) {
  const epk = sealed.subarray(0, 32);
  const pk = x25519.getPublicKey(secretKey);
  const nonce = blake2b(concatBytes(epk, pk), { dkLen: 24 });
  return xsalsa20poly1305(boxKey(x25519.getSharedSecret(secretKey, epk)), nonce).decrypt(sealed.subarray(32));
}
