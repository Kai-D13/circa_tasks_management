'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  /** Poll interval in ms. Pick per page (e.g. list 25–30s, detail 10–15s). */
  intervalMs?: number
}

/**
 * Lightweight polling refresh: calls router.refresh() on an interval, only while
 * the tab is visible, and pauses when hidden. No realtime sockets (kept simple
 * for self-host); upgrade to Supabase realtime later if needed. Renders nothing.
 */
export function AutoRefresh({ intervalMs = 30000 }: Props) {
  const router = useRouter()

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (timer) return
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') router.refresh()
      }, intervalMs)
    }
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start()
      else stop()
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [router, intervalMs])

  return null
}
