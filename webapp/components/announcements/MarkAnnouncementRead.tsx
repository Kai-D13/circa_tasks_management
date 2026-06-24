'use client'

import { useEffect, useRef } from 'react'
import { markAnnouncementRead } from '@/app/actions/announcements'

// Fire-and-forget read receipt when a Staff/Store account opens an announcement.
export function MarkAnnouncementRead({ announcementId }: { announcementId: string }) {
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    void markAnnouncementRead(announcementId)
  }, [announcementId])
  return null
}
