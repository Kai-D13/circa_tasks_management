'use client'

import { useEffect } from 'react'

// Minimal typing for the non-standard beforeinstallprompt event (Chromium only).
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

declare global {
  interface Window {
    __circaBeforeInstallPrompt?: BeforeInstallPromptEvent | null
  }
}

// Custom event InstallBanner listens for when the prompt is captured after it mounts.
export const BIP_EVENT = 'circa:beforeinstallprompt'

// Registers the minimal service worker (public/sw.js) so the app is installable
// on Android/Chromium. Renders nothing. Mounted once in the root layout so it
// runs on every route (including /login). The SW caches nothing — see sw.js.
//
// Also captures `beforeinstallprompt` here (not in InstallBanner). On Android Chrome
// the event can fire on /login before the dashboard-only InstallBanner mounts; if it
// were only captured there it would be missed and the install button never shown.
// We stash it on window and re-dispatch so the banner can pick it up whenever it mounts.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch((err) => console.error('[sw] registration failed:', err))
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      window.__circaBeforeInstallPrompt = e as BeforeInstallPromptEvent
      window.dispatchEvent(new Event(BIP_EVENT))
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)

    const onInstalled = () => {
      window.__circaBeforeInstallPrompt = null
    }
    window.addEventListener('appinstalled', onInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  return null
}
