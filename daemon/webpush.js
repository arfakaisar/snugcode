// Web Push (RFC 8291 aes128gcm + VAPID RFC 8292) using only node:crypto.
// The payload is encrypted for the phone's key, so the push service (FCM/Apple/Mozilla) can't read it.
// The VAPID key is created by the phone and sent to each PC over the E2EE channel: a browser push
// subscription can only use one key, while one phone can connect to many PCs.
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

const vapidPublic = (jwk) => b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));

function vapidAuth(jwk, endpoint) {
  const aud = new URL(endpoint).origin;
  const body = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://github.com/arfakaisar/snugcode' }))}`;
  const sig = crypto.sign('sha256', Buffer.from(body), { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${body}.${b64u(sig)}, k=${vapidPublic(jwk)}`;
}

export function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const secret = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, unb64u(sub.keys.auth), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = crypto.randomBytes(16);
  const cek = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head);
  head.writeUInt32BE(4096, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

// Validate subscription data from the phone: { sub: PushSubscription JSON, vapid: private P-256 JWK }.
export function checkPush(p) {
  const { sub, vapid } = p || {};
  if (!/^https:\/\//.test(sub?.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Invalid push subscription');
  if (vapid?.kty !== 'EC' || vapid.crv !== 'P-256' || !vapid.d || !vapid.x || !vapid.y) throw new Error('Invalid VAPID key');
  return { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, vapid: { kty: 'EC', crv: 'P-256', d: vapid.d, x: vapid.x, y: vapid.y } };
}

// true = delivered; false = the subscription is dead (404/410) and must be removed.
export async function sendPush({ sub, vapid }, data) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { authorization: vapidAuth(vapid, sub.endpoint), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high' },
    body: encrypt(sub, JSON.stringify(data)),
  });
  if (res.status === 404 || res.status === 410) return false;
  if (!res.ok) throw new Error(`push ${res.status}`);
  return true;
}
