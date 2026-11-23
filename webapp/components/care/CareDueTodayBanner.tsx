import Link from 'next/link'
import { BellRing } from 'lucide-react'
import { myFilterHref } from '@/lib/care/my'
import { getCareStaffAccess, loadMyDueTodayCount } from '@/lib/care/server/my'

/** Phần hiển thị thuần (cũng dùng ở /ui-catalog/care-my với số giả) — chỉ số đếm, không dữ liệu khách. */
export function CareDueTodayLink({ n }: { n: number }) {
  return (
    <Link href={myFilterHref('due_today')} prefetch={false} data-testid="care-due-today"
      className="flex min-h-[44px] items-center gap-2.5 rounded-v2-panel border border-status-warning/40 bg-status-warning-bg px-3.5 py-2 text-sm font-semibold text-status-warning active:opacity-80">
      <BellRing className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 break-words">Hôm nay có {n} khách hẹn liên hệ lại →</span>
    </Link>
  )
}

/**
 * PM 22/11/2026 — lời nhắc trên trang mở app của dược sĩ (/tasks): "Hôm nay có N khách hẹn liên hệ lại".
 * Component server TỰ đọc (bọc <Suspense fallback={null}> ở nơi dùng) ⇒ không nằm trên đường render nóng của /tasks và
 * page không import truy vấn CRM. Số đếm dùng CHUNG điều kiện với danh sách /care/my?filter=due_today (applyMyTaskFilters).
 * N = 0, không phải dược sĩ OS, hoặc lỗi đọc ⇒ không render gì (không hiện số 0 giả). Mỗi lần mở / quay lại trang đọc số mới.
 */
export async function CareDueTodayBanner() {
  const a = await getCareStaffAccess().catch(() => null)
  if (!a || a.kind !== 'ok') return null
  const n = await loadMyDueTodayCount(a)
  if (!n || n < 1) return null
  return <CareDueTodayLink n={n} />
}
