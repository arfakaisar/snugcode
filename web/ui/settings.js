// Machine settings from the phone (previously only via `snugcode setup` / `pin` / `devices` / `revoke` on the PC):
// models & API keys (connections), paired devices, and PIN. Essential for cloud runners, which have no terminal.
import * as C from '../../shared/crypto.js';
import * as M from '../../shared/models.js';
import { PROVIDERS, keyCandidates, ENGINE_LABEL, engineFor, REJECTED_KEYS } from '../../shared/providers.js';
import { store } from '../conn.js';
import { app } from './state.js';
import { ago, busyButton, copyText, h, haptic, ic, isOldDaemon, loading, menuItem, toast, ui } from './dom.js';
import { cloudPin } from './cloud.js';

const has = (m) => !!app.current?.info?.caps?.includes(m);
export const canConfigure = () => has('configure');
export const canConnect = () => has('connAdd');
const oldMsg = 'Update snugcode on the PC first to manage this from your phone.';

// ---------- Models & API keys (connections) ----------
const KIND_ICON = { chatgpt: 'spark', router: 'globe', custom: 'globe' };
const connName = (c) => c.label || PROVIDERS[c.kind]?.label || c.kind;
// Engine used by this connection (for display): Codex for ChatGPT/OpenAI, Gemini CLI for the Gemini API,
// Claude Agent SDK for the rest.
function engineText(c) {
  const engines = new Set();
  if (c.kind === 'chatgpt') engines.add('codex');
  else for (const id of c.kind === 'gemini' ? ['gemini-x'] : ['x', 'gpt-5']) {
    const r = engineFor(c, id);
    if (r) engines.add(r.engine);
  }
  return [...engines].map((e) => ENGINE_LABEL[e]).join(' + ');
}
function connLine(c) {
  const who = c.kind === 'chatgpt' ? c.account?.email || 'ChatGPT login' : c.key || c.url?.replace(/^https?:\/\//, '') || '';
  return [who, engineText(c), c.models != null ? c.models + (c.models === 1 ? ' model' : ' models') : null].filter(Boolean).join(' · ');
}

// Hint while typing a key: a guess at the key type (nothing is sent).
function keyHint(key, url) {
  const k = key.trim();
  if (!k) return '';
  const bad = REJECTED_KEYS.find((r) => r.re.test(k));
  if (bad) return '✗ ' + bad.why;
  if (url.trim()) return 'Custom endpoint: the format (Anthropic / OpenAI / Responses) is detected when connecting.';
  const c = keyCandidates(k);
  if (c.length === 1) return 'Looks like a ' + PROVIDERS[c[0]].label + ' key.';
  if (c.length > 1) return 'This key could belong to ' + c.map((x) => PROVIDERS[x].short).join(' / ') + ': each will be checked.';
  return 'Unrecognized key type: if it’s a router key (9router, OmniRoute, LiteLLM, …), add its URL too.';
}

/** @param {{ first?: boolean, back?: () => void, after?: () => void }} [opts] */
export async function connectionsSheet({ first = false, back, after } = {}) {
  if (!canConnect()) return routerSheet({ first, back, after });
  const info = app.current.info;
  const list = h('div', {});
  const renderList = (conns) => {
    list.replaceChildren(
      conns.length
        ? h('div', { class: 'group' },
            ...conns.map((c) =>
              menuItem({ icon: KIND_ICON[c.kind] || 'key', t1: connName(c), t2: connLine(c), onclick: () => connDetail(c, () => connectionsSheet({ back, after })) }),
            ),
          )
        : null,
    );
  };
  renderList(info.connections || []);
  const err = h('div', { class: 'err', role: 'alert' });
  const hint = h('div', { class: 'dim small', style: 'margin:6px 2px 0;min-height:1.2em' });
  const key = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'Paste an API key', 'aria-label': 'API key', enterkeyhint: 'go' });
  const url = h('input', { class: 'field', type: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'https://router.example.com/v1', 'aria-label': 'Router or endpoint URL' });
  const urlBox = h('details', { class: 'addpc', style: 'margin-top:10px' }, h('summary', {}, ic('plus'), 'Router / endpoint URL (9router, OmniRoute, local, …)'), url);
  const btn = h('button', { class: 'btn primary big', style: 'margin-top:14px' }, ic('check'), 'Connect');
  const update = () => {
    hint.textContent = keyHint(key.value, url.value);
    // An unrecognized key is almost certainly a router key: open its URL field.
    if (key.value.trim() && !keyCandidates(key.value.trim()).length && !REJECTED_KEYS.some((r) => r.re.test(key.value.trim()))) urlBox.open = true;
  };
  key.oninput = update;
  url.oninput = update;
  const save = async () => {
    if (!key.value.trim() && !url.value.trim()) return (err.textContent = 'Paste an API key first.');
    const done = busyButton(btn, 'Detecting & testing…');
    err.textContent = '';
    try {
      const r = await app.conn.call('connAdd', { key: key.value.trim() || undefined, url: url.value.trim() || undefined });
      app.current.info = r.info;
      haptic(25);
      toast(`${connName(r.conn)} connected · ${engineText(r.conn)} · ${r.models} models`);
      (await import('./model-picker.js')).modelCache.list = null;
      (await import('./sessions.js')).showSessionsMeta();
      if (after) return after();
      connectionsSheet({ back, after });
    } catch (e) {
      done();
      err.textContent = isOldDaemon(e) ? oldMsg : e.message;
    }
  };
  btn.onclick = save;
  key.onkeydown = (e) => e.key === 'Enter' && save();
  const chatgpt = has('chatgptLogin') && !(info.connections || []).some((c) => c.kind === 'chatgpt');
  ui.sheet(
    ui.head(first ? 'Connect a model' : 'Models & API keys', { sub: app.current.m.name, back }),
    first ? h('div', { class: 'muted', style: 'margin-bottom:12px' }, 'The agent needs an AI model. Sign in to ChatGPT or paste your own API key — the type is detected automatically and snugcode picks the best way to run each model. Nothing else to set up.') : null,
    list,
    chatgpt
      ? h('button', { class: 'btn big', style: 'margin:4px 0 10px', onclick: () => chatgptSheet(() => connectionsSheet({ first, back, after }), after) }, ic('spark'), 'Sign in with ChatGPT')
      : null,
    h('div', { class: 'label' }, (info.connections || []).length ? 'Add an API key' : 'API key'),
    key,
    hint,
    urlBox,
    err,
    btn,
    h('div', { class: 'fine' }, 'Supported: Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Kimi, GLM, xAI, Groq, and OpenAI- or Anthropic-compatible routers/endpoints. Keys are sent encrypted straight to this machine and never shown again.'),
    h('div', { class: 'fine', style: 'margin-top:6px' }, 'Claude Pro/Max subscriptions and Gemini CLI/Antigravity logins may not be used by third-party apps (Anthropic & Google terms): use an API key.'),
  );
  if (first) setTimeout(() => key.focus(), 150);
  // The daemon counts models per connection in the background: refresh the list.
  app.conn.call('connections').then((conns) => (app.current.info = { ...app.current.info, connections: conns }, renderList(conns))).catch(() => {});
}

function connDetail(c, back) {
  const remove = async () => {
    if (!(await ui.confirm({ title: `Remove ${connName(c)}?`, text: 'Sessions using a model from this connection will need to switch models.', ok: 'Remove connection', danger: true, icon: 'trash' }))) return connDetail(c, back);
    try {
      app.current.info = c.kind === 'chatgpt' ? await app.conn.call('chatgptLogout') : await app.conn.call('connRemove', { id: c.id });
      (await import('./model-picker.js')).modelCache.list = null;
      toast('Connection removed');
      back();
    } catch (e) {
      toast(e.message, true);
    }
  };
  const fmt = Object.entries(c.formats || {}).filter(([, v]) => v).map(([k]) => ({ anthropic: 'Anthropic Messages', openai: 'OpenAI Chat', responses: 'Responses API' })[k] || k);
  ui.sheet(
    ui.head(connName(c), { sub: c.kind === 'chatgpt' ? 'ChatGPT login' : c.key || '', back }),
    h('div', { class: 'group' },
      menuItem({ icon: 'cpu', t1: 'Harness', t2: engineText(c) || '-', chev: false }),
      c.kind === 'chatgpt' ? menuItem({ icon: 'spark', t1: 'Account', t2: [c.account?.email, c.account?.plan].filter(Boolean).join(' · ') || 'ChatGPT', chev: false }) : menuItem({ icon: 'globe', t1: 'API format', t2: fmt.join(' · ') || '-', chev: false }),
      c.url ? menuItem({ icon: 'globe', t1: 'Endpoint', t2: c.url.replace(/^https?:\/\//, ''), chev: false }) : null,
      menuItem({ icon: 'list', t1: 'Models', t2: c.models != null ? c.models + ' available' : 'loading…', chev: false }),
    ),
    h('div', { class: 'group', style: 'margin-top:14px' }, menuItem({ icon: 'trash', t1: c.kind === 'chatgpt' ? 'Sign out of ChatGPT' : 'Remove connection', danger: true, chev: false, onclick: remove })),
  );
}

// ChatGPT sign-in via the official Codex: the device code is completed in the phone's browser.
export async function chatgptSheet(back, after) {
  const body = h('div', {}, loading('Setting up Codex & requesting a login code… (first time ~1–2 minutes)'));
  ui.sheet(ui.head('Sign in to ChatGPT', { sub: 'for ' + app.current.m.name, back }), body);
  let r;
  try {
    r = await app.conn.call('chatgptLogin');
  } catch (e) {
    return body.replaceChildren(h('div', { class: 'err' }, isOldDaemon(e) ? oldMsg : e.message), h('button', { class: 'btn', onclick: () => chatgptSheet(back, after) }, ic('refresh'), 'Try again'));
  }
  const copyBtn = h('button', { class: 'copybtn', onclick: async (e) => (await copyText(r.code)) && (e.currentTarget.classList.add('done'), toast('Code copied')) }, ic('copy'), 'copy');
  const status = h('div', { class: 'loading', style: 'justify-content:center' }, h('span', { class: 'spinner' }), h('span', {}, 'waiting for ChatGPT sign-in…'));
  body.replaceChildren(
    h('div', { class: 'muted small' }, 'Open the OpenAI page, sign in with your ChatGPT account, then enter this code:'),
    h('div', { class: 'ghcode' }, h('span', {}, r.code), copyBtn),
    status,
    h('a', { class: 'btn primary', href: r.url, target: '_blank', rel: 'noopener', onclick: () => copyText(r.code) }, ic('spark'), 'Copy code & open OpenAI'),
    h('div', { class: 'dim small', style: 'margin-top:12px;text-align:center' }, r.url.replace(/^https:\/\//, '')),
    h('div', { class: 'fine' }, 'The login is stored on this machine by the official Codex (OpenAI allows ChatGPT subscriptions in third-party harnesses).'),
  );
  app.current.onChatgpt = async (msg) => {
    app.current.onChatgpt = null;
    if (!msg.ok) {
      status.replaceChildren(h('span', { class: 'e' }, '✗ ' + (msg.err || 'Sign-in failed')));
      return;
    }
    haptic(25);
    toast('ChatGPT connected');
    try {
      app.current.info = await app.conn.call('info');
    } catch {}
    (await import('./model-picker.js')).modelCache.list = null;
    (await import('./sessions.js')).showSessionsMeta();
    if (after) return after();
    back ? back() : ui.closeSheet();
  };
}

// ---------- 9router key ----------
// first: opened automatically because the machine has no key yet (new cloud runner). after(): continuation once saved.
/** @param {{ first?: boolean, back?: () => void, after?: () => void }} [opts] */
export function routerSheet({ first = false, back, after } = {}) {
  const info = app.current.info;
  const err = h('div', { class: 'err', role: 'alert' });
  const key = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: info.routerConfigured ? 'New key (leave empty = keep)' : 'Paste your 9router API key', 'aria-label': '9router API key', enterkeyhint: 'go' });
  const url = h('input', { class: 'field', type: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: info.router || '', 'aria-label': 'Router URL' });
  const btn = h('button', { class: 'btn primary big', style: 'margin-top:14px' }, ic('check'), 'Save & test');
  const save = async () => {
    if (!key.value.trim() && !info.routerConfigured) return (err.textContent = 'The key is empty.');
    const done = busyButton(btn, 'Testing router…');
    err.textContent = '';
    try {
      const next = await app.conn.call('configure', { routerKey: key.value.trim() || undefined, routerUrl: url.value.trim() || undefined });
      app.current.info = next;
      haptic(25);
      toast('9router connected · model ' + (M.modelLabel(next.model) || next.model));
      (await import('./sessions.js')).showSessionsMeta();
      if (after) return after();
      ui.closeSheet();
    } catch (e) {
      done();
      err.textContent = isOldDaemon(e) ? oldMsg : e.message;
    }
  };
  btn.onclick = save;
  key.onkeydown = (e) => e.key === 'Enter' && save();
  ui.sheet(
    ui.head(first ? 'One more step' : '9router key', { sub: app.current.m.name, back }),
    first ? h('div', { class: 'muted', style: 'margin-bottom:12px' }, 'The agent uses models from 9router. Paste your API key — just once for this machine.') : null,
    key,
    h('details', { class: 'addpc', style: 'margin-top:12px' }, h('summary', {}, ic('gear'), 'Router URL (advanced)'), url),
    err,
    btn,
    h('div', { class: 'fine' }, 'The key travels over an encrypted channel straight to this machine and is never shown again. The relay can’t read it.'),
  );
  setTimeout(() => key.focus(), 150);
}

// ---------- Paired devices ----------
export async function devicesSheet(back) {
  const body = h('div', {}, loading('Loading devices…'));
  ui.sheet(ui.head('Paired devices', { sub: app.current.m.name, back }), body);
  let list;
  try {
    list = await app.conn.call('devices');
  } catch (e) {
    return body.replaceChildren(h('div', { class: 'err' }, isOldDaemon(e) ? oldMsg : e.message));
  }
  const revoke = async (d) => {
    const self = d.current;
    if (!(await ui.confirm({ title: `Revoke ${d.name}?`, text: self ? 'This is the phone you’re using: it will need the PIN again to connect.' : 'That device is disconnected right away and will need the PIN again to connect.', ok: 'Revoke access', danger: true, icon: 'unlink' }))) return devicesSheet(back);
    try {
      await app.conn.call('revoke', { id: d.id });
      toast('Access revoked');
      if (!self) devicesSheet(back);
    } catch (e) {
      toast(e.message, true);
    }
  };
  body.replaceChildren(
    h('div', { class: 'group' },
      ...list.sort((a, b) => +b.current - +a.current || (b.lastSeen || 0) - (a.lastSeen || 0)).map((d) =>
        menuItem({
          icon: d.current ? 'check' : 'monitor',
          t1: h('span', {}, d.name, d.current ? h('span', { class: 'tag on', style: 'margin-left:8px' }, 'this phone') : null, d.online && !d.current ? h('span', { class: 'tag', style: 'margin-left:8px' }, 'online') : null),
          t2: `paired ${ago(d.pairedAt) || '-'} · active ${ago(d.lastSeen) || '-'}${d.push ? ' · notifications' : ''}`,
          onclick: () => revoke(d),
        }),
      ),
    ),
    h('div', { class: 'fine' }, 'Tap a device to revoke its access.'),
  );
}

// ---------- PIN ----------
export function pinSheet(back) {
  const m = app.current.m;
  const input = h('input', { class: 'field', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '12', placeholder: 'New PIN (6–12 letters/digits)', 'aria-label': 'New PIN', enterkeyhint: 'go' });
  const err = h('div', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn primary', style: 'margin-top:12px' }, 'Change PIN');
  const go = async () => {
    const pin = input.value.trim();
    if (!C.PIN_RE.test(pin)) return (err.textContent = 'PIN must be 6–12 letters/digits.');
    const done = busyButton(btn, 'Saving…');
    try {
      await app.conn.call('setPin', { pin });
      if (cloudPin(m.id)) store.set('cloudpin.' + m.id, C.normalizePin(pin));
      toast('PIN changed. Already-paired phones stay connected.');
      back ? back() : ui.closeSheet();
    } catch (e) {
      done();
      err.textContent = isOldDaemon(e) ? oldMsg : e.message;
    }
  };
  btn.onclick = go;
  input.onkeydown = (e) => e.key === 'Enter' && go();
  const pin = cloudPin(m.id);
  ui.sheet(
    ui.head('PIN pairing', { sub: m.name, back }),
    pin
      ? h('div', {}, h('div', { class: 'muted small' }, 'This runner’s PIN (created automatically by this phone). Use it to pair another phone:'),
          h('div', { class: 'ghcode' }, h('span', {}, pin), h('button', { class: 'copybtn', onclick: async (e) => (await copyText(pin)) && (e.currentTarget.classList.add('done'), toast('PIN copied')) }, ic('copy'), 'copy')))
      : h('div', { class: 'muted small', style: 'margin-bottom:10px' }, 'The PIN is used once per phone for pairing. Changing it also unlocks pairing after too many wrong attempts.'),
    h('div', { class: 'label' }, 'Change PIN'),
    input,
    err,
    btn,
  );
}

// Settings menu rows for "PC settings" (only when the daemon supports them).
export function settingsItems(back) {
  if (!canConfigure()) return [];
  const info = app.current.info;
  return [
    canConnect()
      ? menuItem({ icon: 'key', t1: info.routerConfigured ? 'Models & API keys' : 'Models & API keys (required)', t2: (info.connections || []).map((c) => connName(c)).join(' · ') || 'no model connected yet', onclick: () => connectionsSheet({ back }) })
      : menuItem({ icon: 'key', t1: info.routerConfigured ? '9router key' : '9router key (required)', t2: (info.router || '').replace(/^https?:\/\//, '') || 'not set', onclick: () => routerSheet({ back }) }),
    menuItem({ icon: 'shield', t1: 'Paired devices', t2: 'view & revoke phone access', onclick: () => devicesSheet(back) }),
    menuItem({ icon: 'lock', t1: cloudPin(app.current.m.id) ? 'PIN for another phone' : 'Change PIN', t2: 'pair a new phone', onclick: () => pinSheet(back) }),
  ];
}
