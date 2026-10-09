// Service worker: membuat PWA bisa di-install, membuka shell aplikasi saat offline,
// dan menampilkan Web Push dari PC saat aplikasi ditutup. API & WebSocket tidak pernah di-cache.
const CACHE = 'pocketcode-v8';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || /^\/(api|auth|ws)\//.test(url.pathname)) return;
  // Stale-while-revalidate: aset dari cache langsung dipakai (PWA terbuka instan walau sinyal
  // lemah), versi terbaru diunduh di latar belakang untuk pembukaan berikutnya.
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: url.pathname === '/' });
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
      // Aplikasi sedang dilihat: notifikasi in-app sudah cukup.
      if (wins.some((w) => w.visibilityState === 'visible')) return;
      return self.registration.showNotification(d.title || 'pocketcode', { body: d.body || '', tag: d.tag, renotify: true, icon: 'icon.svg', badge: 'icon.svg', data: { sid: d.sid, mid: d.mid } });
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { sid, mid } = e.notification.data || {};
  const url = new URL('./', self.registration.scope);
  if (mid) url.hash = `open=${mid}${sid ? ':' + sid : ''}`;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const w = wins[0];
      if (!w) return self.clients.openWindow(url.href);
      w.postMessage({ open: { mid, sid } });
      return w.focus();
    }),
  );
});
