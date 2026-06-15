'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useUserStore } from '@/store/userStore'

export interface AppNotification {
  id: string
  type: string
  task_id: string | null
  title: string
  message: string
  is_read: boolean
  created_at: string
}

interface NotificationContextValue {
  notifications: AppNotification[]
  unread: number
  markRead: (ids: string[]) => Promise<void>
  soundEnabled: boolean
  toggleSound: () => void
}

const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  unread: 0,
  markRead: async () => {},
  soundEnabled: true,
  toggleSound: () => {},
})

export function useNotifications() {
  return useContext(NotificationContext)
}

const SOUND_KEY = 'circa:notif-sound'

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const profile  = useUserStore((s) => s.profile)
  const userId   = profile?.id
  const supabase = useMemo(() => createClient(), [])
  const [notifications, setNotifications] = useState<AppNotification[]>([])

  // Sound preference. Default ON for the store-computer use case ("like a store
  // speaker"). Start true on both server and first client render to avoid a
  // hydration mismatch, then hydrate from localStorage in an effect.
  const [soundEnabled, setSoundEnabled] = useState(true)
  const soundEnabledRef = useRef(true)
  const audioCtxRef     = useRef<AudioContext | null>(null)
  // Newest created_at we've already observed — a poll returning something newer
  // means a new notification arrived. null until the first fetch (no beep on load).
  const latestSeenRef   = useRef<string | null>(null)

  useEffect(() => {
    try {
      const v = localStorage.getItem(SOUND_KEY)
      if (v === '0') { setSoundEnabled(false); soundEnabledRef.current = false }
    } catch { /* private mode / storage disabled — keep default on */ }
  }, [])

  function toggleSound() {
    setSoundEnabled((prev) => {
      const next = !prev
      soundEnabledRef.current = next
      try { localStorage.setItem(SOUND_KEY, next ? '1' : '0') } catch { /* ignore */ }
      // Toggling ON counts as a user gesture — unlock/resume audio so the next
      // notification actually plays (browser autoplay policy).
      if (next) { ensureAudio(); audioCtxRef.current?.resume?.() }
      return next
    })
  }

  // Lazily create the AudioContext. Must be called from a user gesture the first
  // time or the browser leaves it suspended.
  function ensureAudio(): AudioContext | null {
    if (typeof window === 'undefined') return null
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return null
      try { audioCtxRef.current = new Ctx() } catch { return null }
    }
    return audioCtxRef.current
  }

  // Short two-note chime via Web Audio — no audio file asset needed.
  function playChime() {
    const ctx = ensureAudio()
    if (!ctx) return
    if (ctx.state === 'suspended') { void ctx.resume() }
    const now = ctx.currentTime
    const notes = [
      { freq: 784, at: 0,    dur: 0.18 }, // G5
      { freq: 1047, at: 0.16, dur: 0.28 }, // C6
    ]
    for (const n of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = n.freq
      const t = now + n.at
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start(t)
      osc.stop(t + n.dur + 0.02)
    }
  }

  const unread = notifications.filter((n) => !n.is_read).length

  async function markRead(ids: string[]) {
    await supabase.from('notifications').update({ is_read: true }).in('id', ids)
    setNotifications((prev) => prev.map((n) => ids.includes(n.id) ? { ...n, is_read: true } : n))
  }

  // One-time audio unlock on the first user interaction anywhere (autoplay policy).
  useEffect(() => {
    function unlock() {
      const ctx = ensureAudio()
      if (ctx?.state === 'suspended') void ctx.resume()
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  useEffect(() => {
    if (!userId) return
    // Staff are executors — they don't send or receive notifications on mobile hot paths.
    // Skipping the fetch entirely removes a DB round-trip on every dashboard mount for
    // the most common mobile role.
    if (profile?.role === 'staff') return

    // Polling instead of realtime: a persistent realtime subscription per admin/manager
    // tab drove ~99% of DB time via realtime.list_changes WAL polling. For the handful
    // of non-staff users, a 60s poll gives near-real-time notifications at a fraction of
    // the load. Removing the client subscription is what actually sheds the WAL-poll load.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function fetchNotifications() {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20)
      if (cancelled || !data) return
      setNotifications(data)

      // Detect arrivals between polls. created_at is ISO, so lexical compare works.
      const newest = data[0]?.created_at ?? null
      if (latestSeenRef.current === null) {
        latestSeenRef.current = newest   // first load establishes the baseline
      } else if (newest && newest > latestSeenRef.current) {
        latestSeenRef.current = newest
        if (soundEnabledRef.current) playChime()   // ring like a store speaker
      }
    }

    function schedule() {
      // 60s ± 15% jitter so multiple admins don't all poll the same wall-clock second.
      const delay = 60000 + (Math.random() * 2 - 1) * 9000
      timer = setTimeout(() => {
        // Skip the fetch while the tab is hidden; keep rescheduling so it resumes
        // automatically when the tab is foregrounded again.
        if (document.visibilityState === 'visible') void fetchNotifications()
        schedule()
      }, delay)
    }

    void fetchNotifications()   // immediate on mount
    schedule()

    // Refresh as soon as the tab becomes visible so a returning user sees current
    // state without waiting up to a full interval.
    function onVisibility() {
      if (document.visibilityState === 'visible') void fetchNotifications()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [userId, supabase, profile?.role])

  return (
    <NotificationContext.Provider value={{ notifications, unread, markRead, soundEnabled, toggleSound }}>
      {children}
    </NotificationContext.Provider>
  )
}
