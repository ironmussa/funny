/* System notifications and Web Push; no offline caching. */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = windows.find((window) => window.url === url.href) ?? windows[0];
      if (client) {
        if (client.url !== url.href) await client.navigate(url.href);
        await client.focus();
      } else {
        await self.clients.openWindow(url.href);
      }
    })(),
  );
});

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    /* Use a visible fallback. */
  }
  const title = typeof payload?.title === 'string' ? payload.title : 'funny';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload?.body === 'string' ? payload.body : 'Agent update',
      icon: '/notification-icon.png',
      tag: typeof payload?.tag === 'string' ? payload.tag : 'agent-update',
      data: { url: typeof payload?.url === 'string' ? payload.url : '/' },
    }),
  );
});
