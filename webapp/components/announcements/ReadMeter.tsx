import { Notice } from '@/components/ds/Notice'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { readPercent } from '@/lib/announcements/feed'
import { cn } from '@/lib/utils'

// UI v2 Phase 3 · Bảng tin (A0, artboard B0 "ReadMeter" / B2 dải dưới tiêu đề) — thống kê đã xem CHỈ cho admin.
// Số do caller tính từ ĐÚNG phép đếm hiện có của trang chi tiết (người nhận staff + store_manager theo đối tượng tin ×
// announcement_reads); component không truy vấn. Bốn trạng thái phải khác nhau rõ (PM spec §3.5, P1):
//   error   — một trong các truy vấn thống kê lỗi ⇒ Notice "Không tải được thống kê đã xem", KHÔNG số, KHÔNG thanh.
//   missing — chưa có số ⇒ "—", không vẽ 0%.
//   ok + total 0 — không có đối tượng nhận thật ⇒ chữ hiện hành "Không có đối tượng nhận.", không chia cho 0.
//   ok + total > 0 — "đã xem/tổng" + thanh: tone info (đang thu thập, không phải tốt/xấu); đủ 100% mới success.
// % hiển thị làm tròn XUỐNG (readPercent) — không ghi 100% khi còn người chưa xem.

export type ReadStats = { kind: 'ok'; read: number; total: number } | { kind: 'missing' } | { kind: 'error' }

export const READ_STATS_ERROR = 'Không tải được thống kê đã xem'
export const READ_STATS_NO_AUDIENCE = 'Không có đối tượng nhận.'

export function ReadMeter({
  stats, variant = 'summary', unreadHref, className,
}: {
  stats: ReadStats
  /** summary: khối số lớn (B0) · strip: dải ngang dưới tiêu đề chi tiết (B2), kèm link "N người chưa xem ↓". */
  variant?: 'summary' | 'strip'
  /** strip: neo tới panel thống kê (vd "#da-xem"); chỉ hiện khi còn người chưa xem. */
  unreadHref?: string
  className?: string
}) {
  if (stats.kind === 'error') {
    return (
      <div data-ann-read-meter="error" className={className}>
        <Notice tone="warning" role="status" title={READ_STATS_ERROR} />
      </div>
    )
  }
  const box = cn(
    'rounded-lg border bg-card text-card-foreground v2:rounded-v2-panel',
    variant === 'strip' ? 'flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5' : 'space-y-3 p-4 v2:p-5',
    className,
  )
  // Số không hợp lệ (NaN/Infinity) = chưa có số, KHÔNG phải 0 (pm-auditor A0 P2).
  if (stats.kind === 'missing' || !Number.isFinite(stats.read) || !Number.isFinite(stats.total)) {
    return (
      <div data-ann-read-meter="missing" className={box}>
        <span className="flex flex-col gap-0.5">
          <span className="text-[12px] text-muted-foreground">Đã xem</span>
          <span className="text-[20px] font-bold tabular-nums">—</span>
        </span>
      </div>
    )
  }
  const { read, total } = stats
  if (total <= 0) {
    return (
      <div data-ann-read-meter="no-audience" className={box}>
        <p className="text-sm text-muted-foreground">{READ_STATS_NO_AUDIENCE}</p>
      </div>
    )
  }
  const done = read >= total
  const pct = readPercent(read, total)
  const unread = Math.max(0, total - read)
  const bar = (
    <ProgressBar
      value={read}
      max={total}
      tone={done ? 'success' : 'info'}
      size={8}
      ariaLabel={`${read}/${total} đã xem`}
      className={variant === 'strip' ? 'min-w-[160px] flex-[1_1_200px]' : undefined}
    />
  )
  if (variant === 'strip') {
    return (
      <div data-ann-read-meter={done ? 'complete' : 'ok'} className={box}>
        <span className="flex flex-col gap-0.5">
          <span className="text-[12px] text-muted-foreground">Đã xem</span>
          <span className="text-[20px] font-bold tabular-nums">
            {read}<span className="text-[14px] font-normal text-muted-foreground">/{total}</span>
          </span>
        </span>
        {bar}
        {unread > 0 && unreadHref && (
          <a
            href={unreadHref}
            data-ann-unread-link
            className="inline-flex min-h-[44px] items-center text-[13px] font-medium text-accent-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          >
            {unread} người chưa xem<span aria-hidden="true">&nbsp;↓</span>
          </a>
        )}
      </div>
    )
  }
  return (
    <div data-ann-read-meter={done ? 'complete' : 'ok'} className={box}>
      <div className="flex items-baseline gap-2">
        <span className="text-[28px] font-bold leading-none tabular-nums">
          {read}<span className="text-[18px] font-normal text-muted-foreground">/{total}</span>
        </span>
        <span className="text-[13px] text-muted-foreground">đã xem · {pct}%</span>
      </div>
      {bar}
    </div>
  )
}

/** Một dòng cửa hàng trong thống kê (B0/B2): tên · thanh 5px · "a/b đã xem". Đủ 100% ⇒ success, còn lại info. */
export function StoreReadBar({ name, read, total, className }: { name: string; read: number; total: number; className?: string }) {
  const done = total > 0 && read >= total
  return (
    <span data-ann-store-bar={done ? 'complete' : 'partial'} className={cn('flex min-w-0 flex-1 items-center gap-3', className)}>
      <span className="min-w-0 flex-1 truncate font-semibold" title={name}>{name}</span>
      <ProgressBar
        value={read}
        max={total}
        tone={done ? 'success' : 'info'}
        size={5}
        ariaLabel={`${name}: ${read}/${total} đã xem`}
        className="hidden w-[90px] shrink-0 sm:flex md:w-[120px]"
      />
      <span className={cn('shrink-0 text-right text-[13px] tabular-nums', done ? 'text-status-success' : 'text-muted-foreground')}>
        {read}/{total} đã xem
      </span>
    </span>
  )
}
