'use client'

import { useEffect } from 'react'

// Registers the minimal service worker (public/sw.js) so the app is installable
// on Android/Chromium. Renders nothing. Mounted once in the root layout so it
// runs on every route (including /login). The SW caches nothing — see sw.js.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch((err) => console.error('[sw] registration failed:', err))
  }, [])

  return null
}
