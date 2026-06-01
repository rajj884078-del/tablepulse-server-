// TablePulse Service Worker
// Handles: offline caching + push notifications

const CACHE_NAME = 'tablepulse-v1';
const CACHED_URLS = [
  '/waiter.html',
  '/kitchen.html',
  '/barman.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install: cache all staff screens
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHED_URLS))
  );
  self.skipWaiting();
});

// Activate: remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network first, fall back to cache
self.addEventListener('fetch', event => {
  // Only handle GET requests for our own origin
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  // For API calls (/order, /active-orders etc) — network only, no cache
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/order') ||
      url.pathname.startsWith('/active-orders') ||
      url.pathname.startsWith('/login') ||
      url.pathname.startsWith('/verify') ||
      url.pathname.startsWith('/update-course') ||
      url.pathname.startsWith('/review') ||
      url.pathname.startsWith('/admin') ||
      url.pathname.startsWith('/r/')) {
    return; // Let these go to network directly
  }

  // For HTML/assets: network first, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Update cache with fresh response
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Push notification received
self.addEventListener('push', event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch (e) { return; }

  const title = data.title || 'TablePulse';
  const options = {
    body: data.body || 'New order update',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'tablepulse',       // replaces previous notification with same tag
    renotify: true,
    requireInteraction: false,
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click — open the relevant screen
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
