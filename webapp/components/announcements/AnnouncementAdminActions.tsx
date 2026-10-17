'use client'

import Link from 'next/link'
import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button, buttonVariants } from '@/components/ui/button'
import { deleteAnnouncement } from '@/app/actions/announcements'
import { useAnnouncementFixtureBlocked } from '@/components/announcements/AnnouncementFixtureBoundary'
import { Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// UI v2 A2: nút Sửa/Xóa của tác giả hoặc super (canManage ở page, khớp RLS ann_update/delete — không đổi).
// Fixture /ui-catalog/announcements-v2 bọc AnnouncementFixtureBoundary ⇒ Xóa bị chặn NGAY ĐẦU handler, trước confirm()
// và trước deleteAnnouncement (0 dialog, 0 request). Route thật: fixtureBlocked() = false ⇒ luồng cũ y nguyên.
export function AnnouncementAdminActions({ announcementId, editHref }: {
  announcementId: string
  /** Chỉ fixture truyền (vd "#fx-edit") để không điều hướng sang route sửa thật; route thật để trống. */
  editHref?: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const fixtureBlocked = useAnnouncementFixtureBlocked()

  function onDelete() {
    if (fixtureBlocked()) return
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
      <Link
        href={editHref ?? `/announcements/${announcementId}/edit`}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-[44px] md:h-8 v2:md:h-9 v2:px-3 v2:text-[13px]')}
      >
        <Pencil className="h-3.5 w-3.5 mr-1" /> Sửa
      </Link>
      <Button variant="outline" size="sm" onClick={onDelete} disabled={pending}
        data-ann-delete
        className={cn(
          'h-[44px] md:h-8 text-destructive hover:text-destructive',
          'v2:md:h-9 v2:px-3 v2:text-[13px] v2:border-status-danger/30 v2:bg-status-danger-bg v2:text-status-danger v2:hover:text-status-danger',
        )}>
        <Trash2 className="h-3.5 w-3.5 mr-1" /> {pending ? 'Đang xóa...' : 'Xóa'}
      </Button>
    </div>
  )
}
