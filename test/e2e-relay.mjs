// Uji relay (tanpa daemon): jenis token terpisah, pencabutan login, konfirmasi penautan PC, batas mesin,
// dan security header PWA. Butuh relay dev: `npm run dev:relay` (CI: wrangler dev --var DEV_AUTH:1).
import assert from 'node:assert/strict';
import { RELAY, ok, linkMachine } from './e2e-harness.mjs';

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

// 3. Penautan PC butuh konfirmasi SETELAH login (POST + token bertanda tangan); parameter URL tidak bisa melewatinya.
{
  const owner = user + '-link';
  const { code } = await (await fetch(RELAY + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: 'PC <uji>' }) })).json();
  assert.equal((await fetch(`${RELAY}/auth/login?kind=machine&pc=TIDAKADA`, { redirect: 'manual' })).status, 404);
  // Link "confirm=1" lama tidak lagi langsung menautkan: tetap berhenti di halaman konfirmasi.
  const r = await fetch(`${RELAY}/auth/dev/login?kind=machine&pc=${code}&login=${owner}&confirm=1`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
  const html = await r.text();
  assert.match(html, /Hubungkan PC\?/);
  assert.ok(html.includes(code) && html.includes('PC &lt;uji&gt;') && html.includes('@' + owner), 'nama di-escape, kode & akun tampil');
  assert.match(html, /method="post"/);
  assert.equal((await (await fetch(`${RELAY}/auth/machine/poll?code=${code}`)).json()).status, 'pending');
  // Token palsu / jenis lain ditolak.
  assert.equal((await fetch(RELAY + '/auth/machine/confirm', { method: 'POST', body: new URLSearchParams({ t: await login(owner) }) })).status, 400);
  const t = html.match(/name="t" value="([^"]+)"/)[1];
  assert.equal((await fetch(RELAY + '/auth/machine/confirm', { method: 'POST', body: new URLSearchParams({ t }) })).status, 200);
  assert.equal((await (await fetch(`${RELAY}/auth/machine/poll?code=${code}`)).json()).status, 'ok');
  ok('penautan PC: konfirmasi setelah login dengan POST bertoken (nama ter-escape, tanpa skrip, tidak bisa dilewati)');
}

// 3b. Token login bisa diperpanjang, dan WebSocket menerima token lewat subprotocol (bukan URL).
{
  const owner = user + '-ws';
  const { code } = await (await fetch(RELAY + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: 'ws' }) })).json();
  await linkMachine(code, owner);
  const { mid } = await (await fetch(`${RELAY}/auth/machine/poll?code=${code}`)).json();
  const r = await (await fetch(RELAY + '/api/renew', { method: 'POST', headers: { authorization: 'Bearer ' + (await login(owner)) } })).json();
  assert.equal((await me(r.token)).status, 200);
  const open = (protos) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${RELAY.replace(/^http/, 'ws')}/ws/phone?mid=${mid}`, protos);
      ws.onopen = () => (ws.close(), resolve(ws.protocol));
      ws.onerror = () => resolve('ditolak');
    });
  assert.equal(await open(['snugcode', 't.' + r.token]), 'snugcode');
  assert.equal(await open(['snugcode', 't.salah']), 'ditolak');
  ok('token login diperpanjang; token WebSocket lewat subprotocol');
}

// 4. Batas mesin per akun.
{
  const owner = user + '-m';
  let last;
  for (let i = 0; i < 21; i++) {
    const { code } = await (await fetch(RELAY + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: 'pc' + i }) })).json();
    last = await linkMachine(code, owner);
  }
  assert.equal(last.status, 409);
  assert.match(await last.text(), /Maksimal 20 mesin/);
  const { machines } = await (await fetch(RELAY + '/api/machines', { headers: { authorization: 'Bearer ' + (await login(owner)) } })).json();
  assert.equal(machines.length, 20);
  ok('mesin ke-21 ditolak (maks 20 per akun)');
}

// 5. Tujuan setelah login: landing page atau snugcode agent saja (bukan host/path lain).
{
  const loc = async (next) => (await fetch(`${RELAY}/auth/dev/login?kind=user&login=${user}&next=${encodeURIComponent(next)}`, { redirect: 'manual' })).headers.get('location') || '';
  assert.match(await loc('/'), /^http[^#]+\/#login=/);
  assert.match(await loc('/agent/'), /\/agent\/#login=/);
  for (const bad of ['https://jahat.example/', '//jahat.example/', '/api/me']) assert.match(await loc(bad), new RegExp('^' + RELAY + '/agent/#login='));
  ok('login: kembali ke landing atau agent, tanpa open redirect');
}

// 6. Security header landing page & PWA (/agent/).
for (const p of ['/', '/agent/']) {
  const r = await fetch(RELAY + p);
  assert.equal(r.status, 200, p);
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/wss:(\s|;|$)/.test(csp), 'connect-src tidak mengizinkan wss: ke host mana pun');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const html = await r.text();
  assert.ok(!/<script>/.test(html), 'tanpa skrip inline');
  assert.ok(!/fonts\.googleapis/.test(html), 'font di-host sendiri');
  ok(p + ': CSP ketat, tanpa skrip inline & font pihak ketiga');
}
{
  for (const f of ['/fonts/jetbrains-mono-400.woff2', '/sw.js', '/install.sh', '/agent/app.js', '/agent/manifest.webmanifest']) assert.equal((await fetch(RELAY + f)).status, 200, f);
  ok('aset bersama di root: font, service worker, pemasang');
}
// 6. Mesin yang mati tanpa menutup soket (codespace dihentikan, PC dicabut) tidak tampak online terus.
// Butuh relay kedua dengan MACHINE_STALE_MS kecil (CI: RELAY_STALE), agar uji tidak menunggu 80 detik.
if (process.env.RELAY_STALE) {
  const R = process.env.RELAY_STALE;
  const WS = R.replace(/^http/, 'ws');
  const owner = user + '-stale';
  const auth = { authorization: 'Bearer ' + (await (async () => decodeURIComponent((await fetch(`${R}/auth/dev/login?kind=user&login=${owner}`, { redirect: 'manual' })).headers.get('location').split('#login=')[1]))()) };
  const { code } = await (await fetch(R + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: 'mati' }) })).json();
  const page = await (await fetch(`${R}/auth/dev/login?kind=machine&pc=${code}&login=${owner}`)).text();
  await fetch(R + '/auth/machine/confirm', { method: 'POST', body: new URLSearchParams({ t: page.match(/name="t" value="([^"]+)"/)[1] }) });
  const { mid, token: mt } = await (await fetch(`${R}/auth/machine/poll?code=${code}`)).json();
  const online = async () => (await (await fetch(R + '/api/machines', { headers: auth })).json()).machines.find((m) => m.id === mid).online;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Mesin "hidup": ping tiap 1 detik seperti daemon (tiap 25 detik).
  const machine = () =>
    new Promise((resolve) => {
      const ws = new WebSocket(WS + '/ws/machine', ['snugcode', 't.' + mt]);
      ws.onopen = () => resolve({ ws, ping: setInterval(() => ws.send('ping'), 1000) });
    });
  const m1 = await machine();
  await sleep(5000);
  assert.equal(await online(), true, 'mesin yang terus ping tetap online melewati batas stale');
  const statuses = [];
  const phone = new WebSocket(`${WS}/ws/phone?mid=${mid}`, ['snugcode', 't.' + auth.authorization.slice(7)]);
  phone.onmessage = (ev) => typeof ev.data === 'string' && ev.data !== 'pong' && JSON.parse(ev.data).t === 'status' && statuses.push(JSON.parse(ev.data).online);
  const phonePing = setInterval(() => phone.readyState === 1 && phone.send('ping'), 1000);
  await sleep(1500);
  assert.deepEqual(statuses, [true]);
  // "Codespace dihentikan": soket tetap terbuka, tapi tidak ada ping lagi.
  clearInterval(m1.ping);
  const closed = new Promise((r) => (m1.ws.onclose = (ev) => r(ev.code)));
  const t0 = Date.now();
  while (statuses.length < 2 && Date.now() - t0 < 15000) await sleep(250);
  assert.deepEqual(statuses, [true, false], 'HP yang sedang tersambung diberi tahu mesin offline (alarm)');
  assert.equal(await online(), false);
  assert.equal(await closed, 4006, 'soket mati ditutup relay');
  // Mesin menyala lagi: online kembali dan HP diberi tahu.
  const m2 = await machine();
  await sleep(500);
  assert.equal(await online(), true);
  assert.equal(statuses.at(-1), true);
  clearInterval(m2.ping);
  m2.ws.close();
  clearInterval(phonePing);
  phone.close();
  ok('mesin yang mati tanpa menutup soket jadi offline; HP diberi tahu; menyala lagi → online');
}
console.log('\nSemua uji relay lulus.');
