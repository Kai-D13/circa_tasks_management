'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  /**
   * Base poll interval in ms (default 30 000).
   * Actual fire time = intervalMs ± 15% jitter so multiple users don't all
   * hit the server at the same second.
   */
  intervalMs?: number
}

/**
 * Lightweight polling refresh: calls router.refresh() on an interval.
 * Pauses automatically when:
 *  - the tab is hidden (visibilitychange)
 *  - any input / textarea / select / button inside the document is focused
 *    (covers form fields, dropdowns, file pickers, and the submit button
 *     while a transition is pending — avoids jarring mid-input refreshes)
 * Resumes as soon as focus leaves an interactive element AND the tab is visible.
 * Renders nothing.
 */
export function AutoRefresh({ intervalMs = 30000 }: Props) {
  const router       = useRouter()
  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pausedRef    = useRef(false)

  useEffect(() => {
    // Installed PWA (standalone): skip background polling entirely. Staff use the
    // home-screen app to upload/submit; a mid-action router.refresh() causes jank.
    // Desktop browser tabs (admin/manager) are unaffected — they keep auto-refreshing.
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true
    if (isStandalone) return

    function isEditable(el: Element | null): boolean {
      if (!el) return false
      return el.tagName === 'INPUT'
        || el.tagName === 'TEXTAREA'
        || el.tagName === 'SELECT'
        || (el as HTMLElement).isContentEditable
    }

    function shouldPause(): boolean {
      return document.visibilityState !== 'visible' || isEditable(document.activeElement)
    }

    function schedule() {
      if (timerRef.current) clearTimeout(timerRef.current)
      // ±15 % jitter — spreads users across a 30-second window so they don't
      // all fire router.refresh() at exactly the same wall-clock second.
      const jitter  = intervalMs * 0.15
      const delay   = intervalMs + (Math.random() * 2 - 1) * jitter
      timerRef.current = setTimeout(() => {
        if (!shouldPause()) {
          router.refresh()
        }
        schedule()                // reschedule regardless (stays paused next tick if needed)
      }, delay)
    }

    function onVisibility() {
      if (document.visibilityState === 'visible' && !pausedRef.current) {
        schedule()
      } else {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      }
    }

    function onFocusIn() {
      if (!isEditable(document.activeElement)) return
      pausedRef.current = true
      // Kill the pending timer immediately — don't let it wake up and skip;
      // the next schedule() after focusout will give a fresh full interval.
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    }
    function onFocusOut() {
      if (!pausedRef.current) return
      pausedRef.current = false
      // Full interval of quiet from the moment the user leaves the field.
      if (document.visibilityState === 'visible') schedule()
    }

    if (document.visibilityState === 'visible') schedule()

    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('focusin',  onFocusIn)
    document.addEventListener('focusout', onFocusOut)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('focusin',  onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [router, intervalMs])

  return null
}
