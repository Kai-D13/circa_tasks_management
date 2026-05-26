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

    supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => setNotifications(data ?? []))

    // One channel per user session — no instanceId needed since Provider mounts once
    const channel = supabase
      .channel(`notifications-${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`,
      }, (payload) => {
        setNotifications((prev) => [payload.new as AppNotification, ...prev.slice(0, 19)])
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId, supabase])

  return (
    <NotificationContext.Provider value={{ notifications, unread, markRead }}>
      {children}
    </NotificationContext.Provider>
  )
}
