// Minimal service worker for installability ONLY — caches nothing.
//
// The app uses Supabase auth + RLS + file uploads, so we deliberately do NOT
// cache any responses (no stale data, no cached credentials, no stale-after-deploy).
//
// There is intentionally NO `fetch` listener: the app caches nothing, so a fetch
// handler would only wake the SW thread on every request for zero benefit. Modern
// Chrome no longer requires a fetch handler for installability (manifest + HTTPS +
// a registered SW is sufficient), so the home-screen install is unaffected.

self.addEventListener('install', () => {
  // Activate this SW immediately, replacing any previous version (incl. older ones
  // that registered a fetch listener — they're dropped on this update).
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Take control of open clients right away.
  event.waitUntil(self.clients.claim())
})
