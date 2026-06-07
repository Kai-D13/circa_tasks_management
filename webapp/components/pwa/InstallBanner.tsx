'use client'

import { useEffect, useState } from 'react'
import { useUserStore } from '@/store/userStore'
import { Button } from '@/components/ui/button'
import { Download, Share, X } from 'lucide-react'

const DISMISS_KEY = 'pwa-install-dismissed'

// Minimal typing for the non-standard beforeinstallprompt event (Chromium only).
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// Staff-only home-screen install prompt. Shows a "Cài đặt" button on Android/Chromium
// (driven by beforeinstallprompt) and Share→Add instructions on iOS Safari. Hidden when
// already installed (standalone) or previously dismissed (localStorage).
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
    setIsIOS(/iPad|iPhone|iPod/.test(ua))

    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true
    setStand(isStandalone)

    setDismiss(localStorage.getItem(DISMISS_KEY) === '1')

    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      setInstallEvt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)

    const onInstalled = () => setStand(true)
    window.addEventListener('appinstalled', onInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
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
    if (outcome === 'accepted') setStand(true)
  }

  // Render nothing until mounted (avoids hydration mismatch), for non-staff, when
  // already installed, or when dismissed. On non-iOS we also need a captured
  // beforeinstallprompt event to offer the button.
  if (!mounted || role !== 'staff' || standalone || dismissed) return null
  if (!isIOS && !installEvt) return null

  return (
    <div className="fixed inset-x-0 bottom-16 z-40 px-3 md:hidden">
      <div className="mx-auto flex max-w-md items-start gap-3 rounded-lg border bg-background p-3 shadow-lg">
        <div className="flex-1 text-sm">
          <p className="font-medium">Cài Circa Tasks vào màn hình chính</p>
          {isIOS ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Nhấn nút Chia sẻ <Share className="inline h-3 w-3" /> rồi chọn “Thêm vào màn hình chính”.
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Mở nhanh như một ứng dụng, toàn màn hình.
            </p>
          )}
          {!isIOS && (
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
