// Minimal service worker for installability ONLY — caches nothing.
//
// The app uses Supabase auth + RLS + file uploads, so we deliberately do NOT
// cache any responses (no stale data, no cached credentials, no stale-after-deploy).
// The fetch listener exists so the SW is "in control", but it never calls
// respondWith — the browser performs its normal network request every time.

self.addEventListener('install', () => {
  // Activate this SW immediately, replacing any previous version.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Take control of open clients right away.
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', () => {
  // Intentionally empty: no respondWith → default network handling, nothing cached.
})
