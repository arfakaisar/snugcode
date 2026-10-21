// Relay tests (no daemon): separate token kinds, login revocation, PC link confirmation, machine limits,
// and site security headers. Needs the dev relay: `npm run dev:relay` (CI: wrangler dev --var DEV_AUTH:1).
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
    ws.onerror = () => resolve('rejected');
  });

// 1. The OAuth state token (visible in the GitHub URL) doesn't pass as a user token.
{
  const r = await fetch(RELAY + '/auth/login?kind=user', { redirect: 'manual' });
  const loc = r.headers.get('location') || '';
  if (/github\.com\/login\/oauth/.test(loc)) {
    const state = new URL(loc).searchParams.get('state');
    assert.equal((await me(state)).status, 401);
    assert.equal(await wsStatus(state), 'rejected');
    ok('OAuth state token rejected as a user token (API & WebSocket)');
  } else console.log('… GITHUB_CLIENT_ID not set: state token test skipped');
}

// 2. Sign out of all devices: every old token is revoked, new logins still work.
{
  const a = await login();
  const b = await login();
  assert.equal((await me(a)).status, 200);
  assert.equal((await fetch(RELAY + '/api/logout-all', { method: 'POST', headers: { authorization: 'Bearer ' + b } })).status, 200);
  assert.equal((await me(a)).status, 401);
  assert.equal((await me(b)).status, 401);
  assert.equal(await wsStatus(a), 'rejected');
  await new Promise((r) => setTimeout(r, 5));
  const c = await login();
  assert.equal((await me(c)).status, 200);
  ok('logout-all revokes old tokens (API & WebSocket), new logins stay valid');
}

// 3. Linking a PC needs confirmation AFTER login (POST + signed token); URL parameters can't skip it.
{
  const owner = user + '-link';
  const { code } = await (await fetch(RELAY + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: 'PC <test>' }) })).json();
  assert.equal((await fetch(`${RELAY}/auth/login?kind=machine&pc=NOTFOUND`, { redirect: 'manual' })).status, 404);
  // The old "confirm=1" link no longer links directly: it still stops at the confirmation page.
  const r = await fetch(`${RELAY}/auth/dev/login?kind=machine&pc=${code}&login=${owner}&confirm=1`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
  const html = await r.text();
  assert.match(html, /Connect this PC\?/);
  assert.ok(html.includes(code) && html.includes('PC &lt;test&gt;') && html.includes('@' + owner), 'name escaped, code & account shown');
  assert.match(html, /method="post"/);
  assert.equal((await (await fetch(`${RELAY}/auth/machine/poll?code=${code}`)).json()).status, 'pending');
  // Fake tokens / other kinds are rejected.
  assert.equal((await fetch(RELAY + '/auth/machine/confirm', { method: 'POST', body: new URLSearchParams({ t: await login(owner) }) })).status, 400);
  const t = html.match(/name="t" value="([^"]+)"/)[1];
  assert.equal((await fetch(RELAY + '/auth/machine/confirm', { method: 'POST', body: new URLSearchParams({ t }) })).status, 200);
  assert.equal((await (await fetch(`${RELAY}/auth/machine/poll?code=${code}`)).json()).status, 'ok');
  ok('PC link: confirmation after login with a tokened POST (name escaped, no scripts, can\'t be skipped)');
}

// 3b. Login tokens can be renewed, and the WebSocket accepts the token via subprotocol (not the URL).
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
      ws.onerror = () => resolve('rejected');
    });
  assert.equal(await open(['snugcode', 't.' + r.token]), 'snugcode');
  assert.equal(await open(['snugcode', 't.wrong']), 'rejected');
  ok('login token renewed; WebSocket token via subprotocol');
}

// 4. Machine limit per account.
{
  const owner = user + '-m';
  let last;
  for (let i = 0; i < 21; i++) {
    const { code } = await (await fetch(RELAY + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: 'pc' + i }) })).json();
    last = await linkMachine(code, owner);
  }
  assert.equal(last.status, 409);
  assert.match(await last.text(), /At most 20 machines/);
  const { machines } = await (await fetch(RELAY + '/api/machines', { headers: { authorization: 'Bearer ' + (await login(owner)) } })).json();
  assert.equal(machines.length, 20);
  ok('the 21st machine is rejected (max 20 per account)');
}

// 5. Where to go after login: only the landing page or snugcode agent (no other host/path).
{
  const loc = async (next) => (await fetch(`${RELAY}/auth/dev/login?kind=user&login=${user}&next=${encodeURIComponent(next)}`, { redirect: 'manual' })).headers.get('location') || '';
  assert.match(await loc('/'), /^http[^#]+\/#login=/);
  assert.match(await loc('/agent/'), /\/agent\/#login=/);
  for (const bad of ['https://evil.example/', '//evil.example/', '/api/me']) assert.match(await loc(bad), new RegExp('^' + RELAY + '/agent/#login='));
  ok('login: back to the landing page or agent, no open redirect');
}

// 6. Security headers of the landing page & PWA (/agent/).
for (const p of ['/', '/agent/']) {
  const r = await fetch(RELAY + p);
  assert.equal(r.status, 200, p);
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/wss:(\s|;|$)/.test(csp), 'connect-src doesn\'t allow wss: to any host');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const html = await r.text();
  assert.ok(!/<script>/.test(html), 'no inline scripts');
  assert.ok(!/fonts\.googleapis/.test(html), 'self-hosted fonts');
  ok(p + ': strict CSP, no inline scripts or third-party fonts');
}
{
  for (const f of ['/fonts/jetbrains-mono-400.woff2', '/sw.js', '/install.sh', '/agent/app.js', '/agent/manifest.webmanifest']) assert.equal((await fetch(RELAY + f)).status, 200, f);
  ok('shared assets at the root: fonts, service worker, installer');
}
// 7. Machines that die without closing their socket (codespace stopped, PC unplugged) don't stay online forever.
// Needs a second relay with a small MACHINE_STALE_MS (CI: RELAY_STALE), so the test doesn't wait 80 seconds.
if (process.env.RELAY_STALE) {
  const R = process.env.RELAY_STALE;
  const WS = R.replace(/^http/, 'ws');
  const owner = user + '-stale';
  const auth = { authorization: 'Bearer ' + (await (async () => decodeURIComponent((await fetch(`${R}/auth/dev/login?kind=user&login=${owner}`, { redirect: 'manual' })).headers.get('location').split('#login=')[1]))()) };
  const { code } = await (await fetch(R + '/auth/machine/start', { method: 'POST', body: JSON.stringify({ name: 'dead' }) })).json();
  const page = await (await fetch(`${R}/auth/dev/login?kind=machine&pc=${code}&login=${owner}`)).text();
  await fetch(R + '/auth/machine/confirm', { method: 'POST', body: new URLSearchParams({ t: page.match(/name="t" value="([^"]+)"/)[1] }) });
  const { mid, token: mt } = await (await fetch(`${R}/auth/machine/poll?code=${code}`)).json();
  const online = async () => (await (await fetch(R + '/api/machines', { headers: auth })).json()).machines.find((m) => m.id === mid).online;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A "live" machine: pings every second like the daemon (every 25 seconds).
  const machine = () =>
    new Promise((resolve) => {
      const ws = new WebSocket(WS + '/ws/machine', ['snugcode', 't.' + mt]);
      ws.onopen = () => resolve({ ws, ping: setInterval(() => ws.send('ping'), 1000) });
    });
  const m1 = await machine();
  await sleep(5000);
  assert.equal(await online(), true, 'a machine that keeps pinging stays online past the stale limit');
  const statuses = [];
  const phone = new WebSocket(`${WS}/ws/phone?mid=${mid}`, ['snugcode', 't.' + auth.authorization.slice(7)]);
  phone.onmessage = (ev) => typeof ev.data === 'string' && ev.data !== 'pong' && JSON.parse(ev.data).t === 'status' && statuses.push(JSON.parse(ev.data).online);
  const phonePing = setInterval(() => phone.readyState === 1 && phone.send('ping'), 1000);
  await sleep(1500);
  assert.deepEqual(statuses, [true]);
  // "Codespace stopped": the socket stays open, but no more pings.
  clearInterval(m1.ping);
  const closed = new Promise((r) => (m1.ws.onclose = (ev) => r(ev.code)));
  const t0 = Date.now();
  while (statuses.length < 2 && Date.now() - t0 < 15000) await sleep(250);
  assert.deepEqual(statuses, [true, false], 'connected phones are told the machine went offline (alarm)');
  assert.equal(await online(), false);
  assert.equal(await closed, 4006, 'the dead socket is closed by the relay');
  // The machine starts again: back online and phones are told.
  const m2 = await machine();
  await sleep(500);
  assert.equal(await online(), true);
  assert.equal(statuses.at(-1), true);
  clearInterval(m2.ping);
  m2.ws.close();
  clearInterval(phonePing);
  phone.close();
  ok('a machine that dies without closing its socket goes offline; phones are told; starting again → online');
}
console.log('\nAll relay tests passed.');
