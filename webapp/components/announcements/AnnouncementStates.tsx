import { Megaphone } from 'lucide-react'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { Notice } from '@/components/ds/Notice'
import { cn } from '@/lib/utils'

// UI v2 Phase 3 · Bảng tin (A0, artboard B0) — trạng thái rỗng / lỗi dùng chung route + fixture. Chữ giữ nguyên bản
// đang chạy (chỉ tách câu "Không tải được bảng tin. Vui lòng thử lại sau hoặc báo Admin." thành tiêu đề + gợi ý).
// Rỗng CHỈ khi truy vấn chính thành công và trả 0 dòng; truy vấn chính lỗi ⇒ ErrorState (không đọc lỗi thành "rỗng").

export function AnnouncementsEmpty({ className }: { className?: string }) {
  return (
    <div data-ann-state="empty" className={cn('rounded-lg border bg-card v2:rounded-v2-panel', className)}>
      <EmptyState icon={Megaphone} title="Chưa có thông báo nào." className="py-12 v2:py-7" />
    </div>
  )
}

export function AnnouncementsError({ className }: { className?: string }) {
  return (
    <div data-ann-state="error" className={className}>
      <ErrorState message="Không tải được bảng tin." hint="Vui lòng thử lại sau hoặc báo Admin." />
    </div>
  )
}

/** Q-146 (PM 17/10): truy vấn announcement_reads lỗi ⇒ ẩn số tin mới + mọi badge "Mới", hiện câu này. */
export const READ_STATE_ERROR = 'Không tải được trạng thái đã xem.'

export function ReadStateErrorNotice({ className }: { className?: string }) {
  return (
    <div data-ann-state="read-error" className={className}>
      <Notice tone="warning" role="status" title={READ_STATE_ERROR} />
    </div>
  )
}
