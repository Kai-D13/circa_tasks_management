import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { ErrorState } from '@/components/ds/ErrorState'

// UI v2 Phase 3 · Bảng tin (A3, artboard B3) — khung trang /announcements/new và /announcements/[id]/edit, dùng CHUNG
// route thật và fixture ?fx=form-*: gốc v2 + centered `max-w-3xl mx-auto` (PM GO), link quay lại + h1 (chữ hiện hành:
// "Bảng tin"/"Tạo thông báo" ở new, "Quay lại"/"Sửa thông báo" ở edit). `error` ⇒ ErrorState thay cho form — dùng khi
// truy vấn của chính trang lỗi (PM P1: không biến lỗi thành 404 hay form trống giả).
export function AnnouncementFormView({
  heading, backHref, backLabel, error = false, children,
}: {
  heading: string
  backHref: string
  backLabel: string
  error?: boolean
  children?: React.ReactNode
}) {
  return (
    <div data-ui-v2="page" data-layout-width="centered" data-ann-form-page={error ? 'error' : 'ok'}
      className="mx-auto max-w-3xl space-y-4 p-4 md:p-6 v2:space-y-[18px]">
      <div className="space-y-1">
        <Link href={backHref} data-ann-back
          className="-ml-1 inline-flex min-h-[44px] items-center gap-1 rounded-sm px-1 text-[13px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0">
          <ChevronLeft aria-hidden="true" className="size-4" /> {backLabel}
        </Link>
        <h1 className="text-[22px] font-bold leading-[1.3] tracking-[-0.01em]">{heading}</h1>
      </div>
      {error ? <ErrorState message="Không tải được thông báo." hint="Vui lòng thử lại sau hoặc báo Admin." /> : children}
    </div>
  )
}
