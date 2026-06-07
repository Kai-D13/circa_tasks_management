// KILL-SWITCH service worker — unregisters itself to roll back the PWA.
//
// The PWA rollout caused navigation lag on mobile *browsers* (not just the installed
// app), because a service worker was registered at scope '/' for every mobile visitor.
// Devices that registered an earlier SW stay controlled by it until a new SW actively
// unregisters. This version does exactly that: it installs, removes its own
// registration, and reloads any open pages so they run with NO service worker.
//
// /sw.js is served with Cache-Control: no-store (see next.config.ts), and browsers
// soft-update an already-registered SW on navigation, so existing devices fetch this
// cleanup script and free themselves on next open — even though the app no longer
// calls navigator.serviceWorker.register().

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        await self.registration.unregister()
      } catch {
        // ignore — best effort
      }
      // Reload controlled/open windows so they detach from this SW immediately.
      try {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        for (const client of clients) {
          client.navigate(client.url)
        }
      } catch {
        // ignore — best effort
      }
    })(),
  )
})
