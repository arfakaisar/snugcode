// Uji end-to-end tanpa HP: bertindak seperti PWA terhadap relay lokal (mode dev).
//   RELAY=http://127.0.0.1:8787 PIN=123456 node test/e2e-phone.mjs
import * as C from '../shared/crypto.js';

const RELAY = process.env.RELAY || 'http://127.0.0.1:8787';
const LOGIN = process.env.LOGIN || 'tester';
const PIN = process.env.PIN || '123456';
const REPO = process.env.REPO || 'octocat/Hello-World';
const PROMPT = process.env.PROMPT || 'Create a file NOTES.md with a 2-line summary of this repository, then run `git status --short` with Bash.';
const log = (...a) => console.log('[phone]', ...a);

const r = await fetch(`${RELAY}/auth/dev/login?kind=user&login=${LOGIN}`, { redirect: 'manual' });
const token = decodeURIComponent(r.headers.get('location').split('#login=')[1]);
const { machines } = await (await fetch(`${RELAY}/api/machines`, { headers: { authorization: 'Bearer ' + token } })).json();
log('machines:', machines.map((m) => `${m.name}(${m.online ? 'online' : 'offline'})`).join(', '));
const m = machines.find((x) => x.online) || machines[0];

const ws = new WebSocket(`${RELAY.replace('http', 'ws')}/ws/phone?token=${encodeURIComponent(token)}&mid=${m.id}`);
const frames = [];
let waiter = null;
ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data);
  if (waiter && waiter.pred(f)) {
    const w = waiter;
    waiter = null;
    w.resolve(f);
  } else frames.push(f);
};
const next = (pred, ms = 60000) =>
  new Promise((resolve, reject) => {
    const i = frames.findIndex(pred);
    if (i >= 0) return resolve(frames.splice(i, 1)[0]);
    waiter = { pred, resolve };
    setTimeout(() => reject(new Error('timeout menunggu frame')), ms);
  });
await new Promise((res) => (ws.onopen = res));
log('status:', JSON.stringify(await next((f) => f.t === 'status')));

async function pair(pin) {
  const p = C.pairStartPhone(await C.pinToPrs(pin, m.id));
  ws.send(JSON.stringify({ t: 'pair1', ...p.msg, name: 'e2e-test' }));
  const f2 = await next((f) => f.t === 'pair2' || f.t === 'pair_err');
  if (f2.t === 'pair_err') return { err: f2.reason };
  const fin = C.pairFinishPhone(p.state, f2);
  if (!fin) return { err: 'pin salah (terdeteksi di HP), sisa ' + f2.left };
  ws.send(JSON.stringify({ t: 'pair3', ...fin.msg }));
  const ok = await next((f) => f.t === 'pair_ok' || f.t === 'pair_err');
  return ok.t === 'pair_ok' ? { deviceId: ok.deviceId, secret: fin.deviceSecret } : { err: ok.reason };
}
log('pair PIN salah  ->', (await pair('000000')).err);
await new Promise((r) => setTimeout(r, 3100));
const dev = await pair(PIN);
log('pair PIN benar  ->', dev.deviceId ? 'OK deviceId=' + dev.deviceId : dev.err);

const a = C.authStartPhone();
ws.send(JSON.stringify({ t: 'auth1', deviceId: dev.deviceId, ...a.msg }));
const fin = C.authFinishPhone(dev.secret, a.state, await next((f) => f.t === 'auth2'));
ws.send(JSON.stringify({ t: 'auth3', ...fin.msg }));
const ch = fin.channel;

// Setelah auth, semua frame terenkripsi.
const pending = new Map();
let rpc = 0;
const handlers = [];
ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data);
  if (f.t !== 'e') return;
  const msg = ch.open(f);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.err ? p.reject(new Error(msg.err)) : p.resolve(msg.r);
  } else handlers.forEach((h) => h(msg));
};
const readyMsg = await new Promise((res) => handlers.push((m) => m.ev === 'ready' && res(m)));
log('ready:', JSON.stringify(readyMsg.info));
const call = (method, p = {}) => {
  const id = ++rpc;
  ws.send(JSON.stringify(ch.seal({ id, m: method, p })));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

log('repos (tanpa GitHub) ->', await call('repos').catch((e) => 'error: ' + e.message));
const s = await call('create', { repo: REPO });
log('session:', JSON.stringify(s));
await call('attach', { id: s.id });

const done = new Promise((resolve) =>
  handlers.push((msg) => {
    if (msg.ev !== 'events') return;
    for (const e of msg.es) {
      if (e.k === 'text') process.stdout.write(e.d);
      else if (e.k === 'tool') log(`tool ${e.name}: ${String(e.s).slice(0, 120)}`);
      else if (e.k === 'result') log(`  result ok=${e.ok}: ${String(e.d).slice(0, 120).replace(/\n/g, ' | ')}`);
      else if (e.k === 'perm') {
        log(`PERMISSION ${e.tool}: ${e.s} -> allow`);
        call('perm', { id: s.id, pid: e.pid, decision: 'allow' });
      } else if (e.k === 'done') {
        log('\ndone:', JSON.stringify(e));
        resolve();
      } else if (e.k !== 'status') log(e.k, JSON.stringify(e).slice(0, 200));
    }
  }),
);
await call('send', { id: s.id, text: PROMPT });
await done;

const st = await call('status', { id: s.id });
log('git status:', JSON.stringify(st.files), 'branch', st.branch, 'ahead', st.ahead);
const { diff } = await call('diff', { id: s.id });
log('diff:\n' + diff.slice(0, 600));
log('commit ->', await call('commit', { id: s.id, message: 'Add NOTES.md' }));
log('push (tanpa token, harus gagal) ->', await call('push', { id: s.id }).catch((e) => 'error: ' + e.message.slice(0, 120)));

const before = (await call('attach', { id: s.id, since: 0 })).events.length;
log('riwayat event tersimpan:', before);
await call('send', { id: s.id, text: '!git log --oneline -n 2' });
await new Promise((r) => setTimeout(r, 4000));
log('sessions:', JSON.stringify((await call('sessions')).map((x) => x.title)));
ws.close();
process.exit(0);
