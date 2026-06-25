'use client'

import Link from 'next/link'
import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button, buttonVariants } from '@/components/ui/button'
import { deleteAnnouncement } from '@/app/actions/announcements'
import { Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function AnnouncementAdminActions({ announcementId }: { announcementId: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()

  function onDelete() {
    if (!confirm('Xóa thông báo này? Hành động không thể hoàn tác.')) return
    start(async () => {
      const r = await deleteAnnouncement(announcementId)
      if ('error' in r) { toast.error(r.error); return }
      toast.success('Đã xóa thông báo')
      router.push('/announcements')
      router.refresh()
    })
  }

  return (
    <div className="flex gap-2">
      <Link href={`/announcements/${announcementId}/edit`} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
        <Pencil className="h-3.5 w-3.5 mr-1" /> Sửa
      </Link>
      <Button variant="outline" size="sm" onClick={onDelete} disabled={pending}
        className="text-destructive hover:text-destructive">
        <Trash2 className="h-3.5 w-3.5 mr-1" /> {pending ? 'Đang xóa...' : 'Xóa'}
      </Button>
    </div>
  )
}
