'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
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
}

const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  unread: 0,
  markRead: async () => {},
})

export function useNotifications() {
  return useContext(NotificationContext)
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const profile  = useUserStore((s) => s.profile)
  const userId   = profile?.id
  const supabase = useMemo(() => createClient(), [])
  const [notifications, setNotifications] = useState<AppNotification[]>([])

  const unread = notifications.filter((n) => !n.is_read).length

  async function markRead(ids: string[]) {
    await supabase.from('notifications').update({ is_read: true }).in('id', ids)
    setNotifications((prev) => prev.map((n) => ids.includes(n.id) ? { ...n, is_read: true } : n))
  }

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
      if (!cancelled && data) setNotifications(data)
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
    <NotificationContext.Provider value={{ notifications, unread, markRead }}>
      {children}
    </NotificationContext.Provider>
  )
}
