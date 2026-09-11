/* System notifications for an open browser session; no offline caching. */
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
