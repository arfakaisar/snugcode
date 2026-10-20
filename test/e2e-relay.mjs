// Uji relay (tanpa daemon): jenis token terpisah, pencabutan login, konfirmasi penautan PC, batas mesin,
// dan security header PWA. Butuh relay dev: `npm run dev:relay` (CI: wrangler dev --var DEV_AUTH:1).
import assert from 'node:assert/strict';
import { RELAY, ok } from './e2e-harness.mjs';

const user = 'relay-' + Date.now().toString(36);
const login = async (u = user) => {
  const r = await fetch(`${RELAY}/auth/dev/login?kind=user&login=${u}`, { redirect: 'manual' });
  return decodeURIComponent(r.headers.get('location').split('#login=')[1]);
};
const me = (token) => fetch(RELAY + '/api/me', { headers: { authorization: 'Bearer ' + token } });
const wsStatus = (token) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${RELAY.replace(/^http/, 'ws')}/ws/phone?token=${encodeURIComponent(token)}&mid=x`);
    ws.onopen = () => (ws.close(), resolve('open'));
    ws.onerror = () => resolve('ditolak');
  });

// 1. Token state OAuth (terlihat di URL GitHub) tidak lolos sebagai token user.
{
  const r = await fetch(RELAY + '/auth/login?kind=user', { redirect: 'manual' });
  const loc = r.headers.get('location') || '';
  if (/github\.com\/login\/oauth/.test(loc)) {
    const state = new URL(loc).searchParams.get('state');
    assert.equal((await me(state)).status, 401);
    assert.equal(await wsStatus(state), 'ditolak');
    ok('token state OAuth ditolak sebagai token user (API & WebSocket)');
  } else console.log('… GITHUB_CLIENT_ID tidak di-set: uji token state dilewati');
}

// 2. Keluar dari semua perangkat: semua token lama dicabut, login baru tetap jalan.
{
  const a = await login();
  const b = await login();
  assert.equal((await me(a)).status, 200);
  assert.equal((await fetch(RELAY + '/api/logout-all', { method: 'POST', headers: { authorization: 'Bearer ' + b } })).status, 200);
  assert.equal((await me(a)).status, 401);
  assert.equal((await me(b)).status, 401);
  assert.equal(await wsStatus(a), 'ditolak');
  await new Promise((r) => setTimeout(r, 5));
  const c = await login();
  assert.equal((await me(c)).status, 200);
  ok('logout-all mencabut token lama (API & WebSocket), login baru tetap berlaku');
}

// 3. Penautan PC lewat link butuh konfirmasi yang menampilkan nama & kode PC.
{
  const { code } = await (await fetch(RELAY + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: 'PC <uji>' }) })).json();
  const r = await fetch(`${RELAY}/auth/login?kind=machine&pc=${code}`, { redirect: 'manual' });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Hubungkan PC\?/);
  assert.ok(html.includes(code) && html.includes('PC &lt;uji&gt;'), 'nama di-escape & kode tampil');
  assert.match(html, /confirm=1/);
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.equal((await fetch(`${RELAY}/auth/login?kind=machine&pc=TIDAKADA`, { redirect: 'manual' })).status, 404);
  const go = await fetch(`${RELAY}/auth/login?kind=machine&pc=${code}&confirm=1`, { redirect: 'manual' });
  assert.ok([200, 302].includes(go.status));
  ok('penautan PC menampilkan halaman konfirmasi (nama ter-escape, kode, tanpa skrip)');
}

// 4. Batas mesin per akun.
{
  const owner = user + '-m';
  let last;
  for (let i = 0; i < 21; i++) {
    const { code } = await (await fetch(RELAY + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: 'pc' + i }) })).json();
    last = await fetch(`${RELAY}/auth/dev/login?kind=machine&pc=${code}&login=${owner}`);
  }
  assert.equal(last.status, 409);
  assert.match(await last.text(), /Maksimal 20 mesin/);
  const { machines } = await (await fetch(RELAY + '/api/machines', { headers: { authorization: 'Bearer ' + (await login(owner)) } })).json();
  assert.equal(machines.length, 20);
  ok('mesin ke-21 ditolak (maks 20 per akun)');
}

// 5. Security header PWA.
{
  const r = await fetch(RELAY + '/');
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const html = await r.text();
  assert.ok(!/<script>/.test(html), 'tanpa skrip inline');
  assert.ok(!/fonts\.googleapis/.test(html), 'font di-host sendiri');
  assert.equal((await fetch(RELAY + '/fonts/jetbrains-mono-400.woff2')).status, 200);
  ok('PWA: CSP ketat, tanpa skrip inline & font pihak ketiga');
}
console.log('\nSemua uji relay lulus.');
