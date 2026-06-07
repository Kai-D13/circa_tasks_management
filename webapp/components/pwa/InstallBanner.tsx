'use client'

import { useEffect, useState } from 'react'
import { useUserStore } from '@/store/userStore'
import { Button } from '@/components/ui/button'
import { Download, Share, X } from 'lucide-react'
import { BIP_EVENT, type BeforeInstallPromptEvent } from '@/components/pwa/ServiceWorkerRegister'

const DISMISS_KEY = 'pwa-install-dismissed'

// Staff-only home-screen install prompt. The beforeinstallprompt event is captured
// globally in ServiceWorkerRegister (it can fire on /login before this mounts), stashed
// on window, and re-dispatched as BIP_EVENT. Here we read the stash on mount and also
// listen for the custom event in case it arrives later. iOS Safari has no such event, so
// we show Share→Add instructions; on Android without a captured event we fall back to a
// Chrome-menu instruction rather than hiding entirely. Hidden when already installed
// (standalone) or previously dismissed (localStorage).
export function InstallBanner() {
  const role = useUserStore((s) => s.profile?.role)

  const [mounted, setMounted]   = useState(false)
  const [isIOS, setIsIOS]       = useState(false)
  const [standalone, setStand]  = useState(false)
  const [dismissed, setDismiss] = useState(true)
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    setMounted(true)

    const ua = window.navigator.userAgent
    // iPadOS in desktop mode reports as MacIntel and no longer matches iPad in the UA,
    // so also treat a touch-capable "Mac" as iOS-like for the Share instructions.
    const isIOSLike =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    setIsIOS(isIOSLike)

    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true
    setStand(isStandalone)

    setDismiss(localStorage.getItem(DISMISS_KEY) === '1')

    // Pick up an event already captured by ServiceWorkerRegister before we mounted.
    if (window.__circaBeforeInstallPrompt) setInstallEvt(window.__circaBeforeInstallPrompt)

    const onBip = () => {
      if (window.__circaBeforeInstallPrompt) setInstallEvt(window.__circaBeforeInstallPrompt)
    }
    window.addEventListener(BIP_EVENT, onBip)

    const onInstalled = () => setStand(true)
    window.addEventListener('appinstalled', onInstalled)

    return () => {
      window.removeEventListener(BIP_EVENT, onBip)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismiss(true)
  }

  async function install() {
    if (!installEvt) return
    await installEvt.prompt()
    const { outcome } = await installEvt.userChoice
    setInstallEvt(null)
    window.__circaBeforeInstallPrompt = null
    if (outcome === 'accepted') setStand(true)
  }

  // Render nothing until mounted (avoids hydration mismatch), for non-staff, when
  // already installed, or when dismissed. Otherwise always show: iOS + Android-with-event
  // get a tailored CTA; Android without a captured event gets a Chrome-menu fallback.
  if (!mounted || role !== 'staff' || standalone || dismissed) return null

  return (
    <div className="fixed inset-x-0 bottom-16 z-40 px-3 md:hidden">
      <div className="mx-auto flex max-w-md items-start gap-3 rounded-lg border bg-background p-3 shadow-lg">
        <div className="flex-1 text-sm">
          <p className="font-medium">Cài Circa Tasks vào màn hình chính</p>
          {isIOS ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Nhấn nút Chia sẻ <Share className="inline h-3 w-3" /> rồi chọn “Thêm vào màn hình chính”.
            </p>
          ) : installEvt ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Mở nhanh như một ứng dụng, toàn màn hình.
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Mở menu trình duyệt <span className="font-medium">⋮</span> rồi chọn “Cài đặt ứng dụng” / “Thêm vào màn hình chính”.
            </p>
          )}
          {!isIOS && installEvt && (
            <Button size="sm" className="mt-2 h-8 gap-1.5 text-xs" onClick={install}>
              <Download className="h-3.5 w-3.5" />
              Cài đặt
            </Button>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Đóng"
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
