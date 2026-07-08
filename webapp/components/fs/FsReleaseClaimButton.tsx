'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { releaseFsClaim } from '@/app/actions/fsSessions'
import { Button } from '@/components/ui/button'
import { UserX } from 'lucide-react'

// Policy/super force-release: unstick a list held by a staff who stepped away.
export function FsReleaseClaimButton({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function doRelease() {
    if (!window.confirm('Gỡ người đang xử lý khỏi danh sách này? Sau đó nhân viên khác có thể nhận.')) return
    startTransition(async () => {
      const r = await releaseFsClaim(sessionId)
      if (r.error) { toast.error(r.error); return }
      toast.success('Đã gỡ người xử lý')
      router.refresh()
    })
  }

  return (
    <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs" onClick={doRelease} disabled={pending}>
      <UserX className="h-3.5 w-3.5" /> Gỡ người xử lý
    </Button>
  )
}
