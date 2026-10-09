// Kriptografi bersama untuk daemon (Node) dan PWA (browser).
//
// 1. Pairing PIN  : CPace di atas ristretto255. Relay meneruskan pesan tapi
//                   tidak bisa melihat PIN maupun menebaknya secara offline.
//                   Hasilnya: deviceSecret permanen yang disimpan di HP & PC.
// 2. Kanal sesi   : setiap koneksi melakukan handshake (deviceSecret + X25519
//                   ephemeral) -> kunci XChaCha20-Poly1305 per arah.
import { ristretto255, ristretto255_hasher as R, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { randomBytes, concatBytes, utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

export { randomBytes, bytesToHex, hexToBytes };

const enc = (s) => utf8ToBytes(s);
const dec = (b) => new TextDecoder().decode(b);

export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function ctEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// PIN boleh huruf + angka, tidak peka huruf besar/kecil (keyboard HP sering
// mengkapitalkan huruf pertama).
export const PIN_RE = /^[a-z0-9]{6,12}$/i;
export const normalizePin = (pin) => String(pin).trim().toLowerCase();

// PIN -> password-related string. Disimpan daemon (bukan PIN mentahnya).
export async function pinToPrs(pin, machineId) {
  return scryptAsync(enc(normalizePin(pin)), enc('pocketcode-pin:' + machineId), { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
}

// ---------- CPace ----------
function cpaceGenerator(prs, sid) {
  return R.hashToCurve(concatBytes(enc('CPace'), prs, sid), { DST: 'pocketcode-cpace-v1' });
}
function cpaceKeys(sid, ya, yb, k) {
  const isk = sha256(concatBytes(enc('pocketcode-isk'), sid, ya, yb, k));
  return {
    macKeyA: hmac(sha256, isk, enc('mac-A')),
    macKeyB: hmac(sha256, isk, enc('mac-B')),
    deviceSecret: hkdf(sha256, isk, sid, enc('pocketcode-device-secret'), 32),
  };
}

// Sisi HP (inisiator). Langkah 1 -> kirim { sid, ya } ke PC.
export function pairStartPhone(prs) {
  const sid = randomBytes(16);
  const G = cpaceGenerator(prs, sid);
  const a = R.hashToScalar(randomBytes(64));
  const Ya = G.multiply(a).toBytes();
  return { state: { sid, a, Ya }, msg: { sid: bytesToHex(sid), ya: bytesToHex(Ya) } };
}

// Sisi PC. Terima { sid, ya } -> balas { yb, macB }. Simpan state untuk verifikasi macA.
export function pairRespondMachine(prs, msg) {
  const sid = hexToBytes(msg.sid);
  const Ya = hexToBytes(msg.ya);
  const PYa = ristretto255.Point.fromBytes(Ya);
  if (PYa.equals(ristretto255.Point.ZERO)) throw new Error('bad point');
  const G = cpaceGenerator(prs, sid);
  const b = R.hashToScalar(randomBytes(64));
  const Yb = G.multiply(b).toBytes();
  const K = PYa.multiply(b).toBytes();
  const keys = cpaceKeys(sid, Ya, Yb, K);
  const transcript = concatBytes(sid, Ya, Yb);
  const macB = hmac(sha256, keys.macKeyB, transcript);
  return { state: { keys, transcript }, msg: { yb: bytesToHex(Yb), macB: bytesToHex(macB) } };
}

// Sisi HP. Verifikasi macB; null berarti PIN salah. Jika benar -> kirim { macA }.
export function pairFinishPhone(state, msg) {
  const Yb = hexToBytes(msg.yb);
  const PYb = ristretto255.Point.fromBytes(Yb);
  if (PYb.equals(ristretto255.Point.ZERO)) return null;
  const K = PYb.multiply(state.a).toBytes();
  const keys = cpaceKeys(state.sid, state.Ya, Yb, K);
  const transcript = concatBytes(state.sid, state.Ya, Yb);
  if (!ctEqual(hmac(sha256, keys.macKeyB, transcript), hexToBytes(msg.macB))) return null;
  return { deviceSecret: keys.deviceSecret, msg: { macA: bytesToHex(hmac(sha256, keys.macKeyA, transcript)) } };
}

// Sisi PC. Verifikasi macA -> deviceSecret, atau null bila gagal.
export function pairVerifyMachine(state, msg) {
  const expect = hmac(sha256, state.keys.macKeyA, state.transcript);
  if (!ctEqual(expect, hexToBytes(msg.macA))) return null;
  return state.keys.deviceSecret;
}

// ---------- Handshake kanal sesi ----------
function sessionKeys(secret, na, nb, ea, eb, ss) {
  const okm = hkdf(sha256, concatBytes(secret, ss), concatBytes(na, nb), concatBytes(enc('pocketcode-session'), ea, eb), 96);
  return { p2m: okm.slice(0, 32), m2p: okm.slice(32, 64), mac: okm.slice(64, 96) };
}

export function authStartPhone() {
  const na = randomBytes(32);
  const { secretKey, publicKey } = x25519.keygen();
  return { state: { na, esk: secretKey, ea: publicKey }, msg: { na: bytesToHex(na), ea: bytesToHex(publicKey) } };
}

export function authRespondMachine(secret, msg) {
  const na = hexToBytes(msg.na);
  const ea = hexToBytes(msg.ea);
  const nb = randomBytes(32);
  const { secretKey, publicKey: eb } = x25519.keygen();
  const ss = x25519.getSharedSecret(secretKey, ea);
  const keys = sessionKeys(secret, na, nb, ea, eb, ss);
  const tr = concatBytes(na, nb, ea, eb);
  return {
    state: { keys, tr },
    msg: { nb: bytesToHex(nb), eb: bytesToHex(eb), macB: bytesToHex(hmac(sha256, keys.mac, concatBytes(enc('B'), tr))) },
  };
}

export function authFinishPhone(secret, state, msg) {
  const nb = hexToBytes(msg.nb);
  const eb = hexToBytes(msg.eb);
  const ss = x25519.getSharedSecret(state.esk, eb);
  const keys = sessionKeys(secret, state.na, nb, state.ea, eb, ss);
  const tr = concatBytes(state.na, nb, state.ea, eb);
  if (!ctEqual(hmac(sha256, keys.mac, concatBytes(enc('B'), tr)), hexToBytes(msg.macB))) return null;
  return {
    channel: new Channel(keys.p2m, keys.m2p),
    msg: { macA: bytesToHex(hmac(sha256, keys.mac, concatBytes(enc('A'), tr))) },
  };
}

export function authVerifyMachine(state, msg) {
  const expect = hmac(sha256, state.keys.mac, concatBytes(enc('A'), state.tr));
  if (!ctEqual(expect, hexToBytes(msg.macA))) return null;
  return new Channel(state.keys.m2p, state.keys.p2m);
}

// Kanal terenkripsi dua arah dengan nomor urut (anti-replay).
export class Channel {
  constructor(sendKey, recvKey) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendSeq = 0;
    this.recvSeq = -1;
  }
  seal(obj) {
    const nonce = randomBytes(24);
    const pt = enc(JSON.stringify({ s: this.sendSeq++, m: obj }));
    const ct = xchacha20poly1305(this.sendKey, nonce).encrypt(pt);
    return { t: 'e', n: b64(nonce), c: b64(ct) };
  }
  open(frame) {
    const pt = xchacha20poly1305(this.recvKey, unb64(frame.n)).decrypt(unb64(frame.c));
    const { s, m } = JSON.parse(dec(pt));
    if (!(s > this.recvSeq)) throw new Error('replay');
    this.recvSeq = s;
    return m;
  }

  // ---------- Kanal biner (protokol v2) ----------
  // Frame WebSocket biner: [versi 1B][nonce 24B][ciphertext]. Plaintext: [flag 1B][seq 4B BE][potongan JSON].
  // Dibanding frame teks (JSON → base64 → JSON lagi) ukurannya ±25–35% lebih kecil dan relay
  // tidak perlu mem-parse JSON. Pesan > BIN_CHUNK dipecah (flag MORE), jadi tidak lagi
  // terbentur batas 1MB per frame relay. Nomor urut dipakai bersama dengan frame teks.
  sealBin(obj) {
    const body = enc(JSON.stringify(obj));
    const frames = [];
    for (let off = 0; off === 0 || off < body.length; off += BIN_CHUNK) {
      const part = body.subarray(off, off + BIN_CHUNK);
      const pt = new Uint8Array(5 + part.length);
      pt[0] = off + BIN_CHUNK < body.length ? FLAG_MORE : 0;
      new DataView(pt.buffer).setUint32(1, this.sendSeq++);
      pt.set(part, 5);
      const nonce = randomBytes(24);
      frames.push(concatBytes(BIN_V1, nonce, xchacha20poly1305(this.sendKey, nonce).encrypt(pt)));
    }
    return frames;
  }

  // Hasil `undefined` = potongan pesan; pesan utuh dikembalikan setelah potongan terakhir.
  openBin(frame) {
    const b = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (b.length < 1 + 24 + 16 + 5 || b[0] !== BIN_V1[0]) throw new Error('frame biner tidak dikenal');
    const pt = xchacha20poly1305(this.recvKey, b.subarray(1, 25)).decrypt(b.subarray(25));
    const s = new DataView(pt.buffer, pt.byteOffset).getUint32(1);
    if (!(s > this.recvSeq)) throw new Error('replay');
    this.recvSeq = s;
    const part = pt.subarray(5);
    this.parts ??= [];
    this.partsLen = (this.partsLen || 0) + part.length;
    if (this.partsLen > BIN_MAX) throw new Error('pesan terlalu besar');
    this.parts.push(part);
    if (pt[0] & FLAG_MORE) return undefined;
    const whole = this.parts.length === 1 ? part : concatBytes(...this.parts);
    this.parts = [];
    this.partsLen = 0;
    return JSON.parse(dec(whole));
  }
}

const BIN_V1 = new Uint8Array([1]);
const FLAG_MORE = 1;
export const BIN_CHUNK = 256 * 1024;
const BIN_MAX = 64 * 1024 * 1024;

// Bingkai relay biner: [panjang cid 1B][cid ASCII][payload]. Dipakai PC <-> relay
// (relay menambah/membuang cid; HP hanya melihat payload).
export function frameWithCid(cid, payload) {
  const id = enc(cid);
  const out = new Uint8Array(1 + id.length + payload.length);
  out[0] = id.length;
  out.set(id, 1);
  out.set(payload, 1 + id.length);
  return out;
}
export function splitCid(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const n = b[0];
  return { cid: dec(b.subarray(1, 1 + n)), payload: b.subarray(1 + n) };
}
