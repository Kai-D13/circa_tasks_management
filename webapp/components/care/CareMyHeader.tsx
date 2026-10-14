'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, FlaskConical, X } from 'lucide-react'
import { MobileScreenHeader } from '@/components/ds/MobileScreenHeader'
import { AccountMenu } from '@/components/layout/AccountMenu'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { careBackMode } from '@/lib/care/my'
import { CareQaNoticeText } from './CareQaNotice'

// Header riêng của 3 màn dược sĩ CSKH (B7-ui r2, artboard 08/09/10) — MobileHeader chung ẩn ở các
// route này (layout truyền careOwnHeader). Danh sách = màn gốc tab (không quay lại); chi tiết = ‹ về
// danh sách; ghi nhận = ✕ về chi tiết. Đích cố định do trang truyền (careMyBackTarget). Mục lịch sử
// ngay trước ĐÚNG là màn cha ⇒ history.back() (giữ bộ lọc/trang/vị trí cuộn); còn lại ⇒ push.
// Chip "QA" chỉ khi chế độ QA local: mở sheet cùng nội dung banner CareLayout (Q-107).

type Screen = 'list' | 'detail' | 'update'
const TITLES: Record<Screen, string> = { list: 'Khách hàng của tôi', detail: 'Chăm sóc khách', update: 'Ghi nhận chăm sóc' }

/** URL mục lịch sử ngay trước (Navigation API — Chrome/Edge; trình duyệt không có ⇒ null ⇒ push). */
function previousEntryUrl(): string | null {
  const nav = (window as unknown as { navigation?: { currentEntry?: { index: number } | null; entries?: () => { url: string | null }[] } }).navigation
  const i = nav?.currentEntry?.index
  if (!nav?.entries || typeof i !== 'number' || i < 1) return null
  return nav.entries()[i - 1]?.url ?? null
}

function QaChip() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Chế độ QA — xem chi tiết"
        data-testid="care-qa-chip" className="flex h-[44px] min-w-[44px] items-center justify-center px-1">
        <span className="inline-flex h-[26px] items-center rounded-full border border-status-warning/40 bg-status-warning-bg px-2.5 text-xs font-semibold text-status-warning">QA</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false}
          className="top-auto bottom-0 left-0 right-0 max-w-full translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl pb-[calc(1rem_+_env(safe-area-inset-bottom))] md:hidden">
          <DialogTitle className="flex items-center gap-2 text-status-warning"><FlaskConical className="size-4" aria-hidden /> Chế độ QA · dữ liệu giả (is_test)</DialogTitle>
          <p className="text-sm" data-testid="care-qa-sheet-text"><CareQaNoticeText /></p>
          <Button type="button" variant="outline" className="min-h-[44px] w-full" onClick={() => setOpen(false)}>Đã hiểu</Button>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function CareMyHeader({ screen, subtitle, back, qa = false }: {
  screen: Screen
  subtitle?: string
  /** Màn con: đích quay lại cố định (careMyBackTarget) — màn danh sách không có. */
  back?: { href: string; label: string }
  qa?: boolean
}) {
  const router = useRouter()
  const leading = back && screen !== 'list' ? (
    <Link href={back.href} prefetch={false}
      aria-label={screen === 'update' ? `Huỷ, quay lại ${back.label}` : `Quay lại ${back.label}`}
      className="flex size-[44px] shrink-0 items-center justify-center rounded-full text-foreground active:bg-muted"
      onClick={(e) => {
        if (careBackMode(previousEntryUrl(), back.href, window.location.origin) === 'back') { e.preventDefault(); router.back() }
      }}>
      {screen === 'update' ? <X className="size-[22px]" aria-hidden /> : <ChevronLeft className="size-[22px]" aria-hidden />}
    </Link>
  ) : undefined
  return (
    <MobileScreenHeader root={screen === 'list'} title={TITLES[screen]} subtitle={subtitle} leading={leading}
      className={screen === 'list' ? 'bg-care-surface/95' : 'border-care-line bg-care-surface/95'}
      trailing={<>{qa && <QaChip />}<AccountMenu tone="onSurface" /></>} />
  )
}
