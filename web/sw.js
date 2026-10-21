// Service worker: makes the PWA installable, opens the app shell offline, and shows Web Push from
// the PC while the app is closed. The API & WebSocket are never cached.
// CACHE is replaced with an asset hash by scripts/build-web.mjs. Served at the root (/sw.js, scope `/`)
// even though the app lives in /agent/: registrations & push subscriptions from phones that installed the PWA at `/` keep working.
const CACHE = 'snugcode-dev';
// index.html is left out: the relay redirects it (307) to 'agent/'.
const SHELL = ['agent/', 'agent/theme.js', 'agent/style.css', 'agent/app.js', 'agent/manifest.webmanifest', 'agent/icon.svg', 'agent/icon-192.png'];
// cache: 'reload' = always from the network, not the browser HTTP cache that may hold an old version.
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || /^\/(api|auth|ws)\//.test(url.pathname)) return;
  // Stale-while-revalidate: cached assets are used right away (the PWA opens instantly even on a weak
  // signal), and the latest version downloads in the background for next time.
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: url.pathname === '/agent/' });
      const fresh = fetch(e.request)
        .then((r) => {
          if (r.ok) c.put(e.request, r.clone());
          return r;
        })
        .catch(() => hit || Response.error());
      if (hit) {
        e.waitUntil(fresh.catch(() => {}));
        return hit;
      }
      return fresh;
    }),
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data.json();
  } catch {}
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((wins) => {
      // The app is being viewed: the in-app notice is enough.
      if (wins.some((w) => w.visibilityState === 'visible')) return;
      // Low/medium-risk permissions can be answered from the notification (the app opens & answers over E2EE);
      // high risk carries no pid, so it always opens and is decided in the app.
      const actions = d.pid ? [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }] : [];
      return self.registration.showNotification(d.title || 'snugcode', { body: d.body || '', tag: d.tag, renotify: true, icon: 'agent/icon-192.png', badge: 'agent/icon-192.png', actions, data: { sid: d.sid, mid: d.mid, pid: d.pid } });
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { sid, mid, pid } = e.notification.data || {};
  const decision = pid && (e.action === 'allow' || e.action === 'deny') ? e.action : null;
  const url = new URL('agent/', self.registration.scope);
  if (mid) url.hash = `open=${mid}${sid ? ':' + sid : ''}` + (decision ? `&perm=${pid}:${decision}` : '');
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // snugcode agent windows only: landing page tabs don't handle this message.
      const w = wins.find((x) => new URL(x.url).pathname.startsWith('/agent/'));
      if (!w) return self.clients.openWindow(url.href);
      w.postMessage({ open: { mid, sid }, perm: decision ? { pid, decision } : null });
      return w.focus();
    }),
  );
});
