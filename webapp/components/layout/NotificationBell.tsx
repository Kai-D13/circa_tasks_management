'use client'

import { useEffect, useRef, useState } from 'react'
import { useNotifications } from '@/components/layout/NotificationProvider'
import { Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/dateUtils'
import Link from 'next/link'

export function NotificationBell() {
  const { notifications, unread, markRead } = useNotifications()
  const [open, setOpen]         = useState(false)
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 })
  const wrapperRef = useRef<HTMLDivElement>(null)
  const popupRef   = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const t = e.target as Node
      if (!wrapperRef.current?.contains(t) && !popupRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function handleOpen() {
    const next = !open

    if (next && wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect()
      const POPUP_W = 320
      const POPUP_H = 340
      const left = (window.innerWidth - rect.right) >= POPUP_W
        ? rect.right + 8
        : Math.max(8, rect.right - POPUP_W)
      const top = (window.innerHeight - rect.bottom) >= POPUP_H
        ? rect.bottom + 8
        : Math.max(8, rect.top - POPUP_H - 8)
      setPopupPos({ top, left })
    }

    setOpen(next)

    if (next && unread > 0) {
      const ids = notifications.filter((n) => !n.is_read).map((n) => n.id)
      await markRead(ids)
    }
  }

  return (
    <>
      <div ref={wrapperRef}>
        <Button
          variant="outline"
          size="sm"
          className="w-8 px-0 relative"
          onClick={handleOpen}
          title="Thông báo"
        >
          <Bell className="h-3.5 w-3.5" />
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-primary text-[9px] font-bold text-primary-foreground flex items-center justify-center leading-none">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </div>

      {open && (
        <div
          ref={popupRef}
          /* eslint-disable-next-line react/forbid-component-props */
          style={{ position: 'fixed', top: popupPos.top, left: popupPos.left }}
          className="w-80 rounded-lg border bg-popover shadow-xl z-[300] overflow-hidden"
        >
          <div className="px-3 py-2.5 border-b bg-muted/50 flex items-center justify-between">
            <p className="text-xs font-semibold">Thông báo</p>
            {notifications.length > 0 && (
              <span className="text-[10px] text-muted-foreground">{notifications.length} mục</span>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Bell className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">Không có thông báo nào</p>
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y">
              {notifications.map((n) => (
                <li key={n.id} className={cn('hover:bg-muted/60 transition-colors', !n.is_read && 'bg-primary/5')}>
                  {n.task_id ? (
                    <Link href={`/tasks/${n.task_id}`} onClick={() => setOpen(false)} className="block px-3 py-2.5">
                      <NotificationItem n={n} />
                    </Link>
                  ) : (
                    <div className="px-3 py-2.5">
                      <NotificationItem n={n} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  )
}

function NotificationItem({ n }: { n: { title: string; message: string; created_at: string } }) {
  return (
    <>
      <p className="text-xs font-medium text-foreground leading-snug">{n.title}</p>
      <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{n.message}</p>
      <p className="text-[10px] text-muted-foreground/60 mt-1">{formatDate(n.created_at)}</p>
    </>
  )
}
