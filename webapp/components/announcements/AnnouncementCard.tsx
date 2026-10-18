import Link from 'next/link'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { TagBadge } from '@/components/ds/TagBadge'
import { formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'

// UI v2 Phase 3 · Bảng tin (A0, artboard B0/B1/M1) — thẻ một tin, dùng CHUNG cho route /announcements và fixture
// /ui-catalog/announcements-v2. Chỉ trình bày: dữ liệu do caller truyền (route lấy từ truy vấn hiện có).
// Ba trục KHÔNG gộp (PM spec §2): trạng thái đọc · gửi theo cửa hàng · hết hạn.
//   read: 'unread' | 'read' — CHỈ khi caller có kết quả announcement_reads hợp lệ; 'untracked' — admin (list admin không
//         tải read receipt) hoặc truy vấn đọc lỗi ⇒ không chấm, không "Mới" (Q-144/Q-146: không bao giờ suy ra chưa đọc).
//   Chưa đọc = chấm xanh (status-info) + tiêu đề đậm + badge "Mới" có chữ; nền/viền thẻ TRUNG TÍNH (Q-144).
//   expired: caller chỉ truyền true khi vai được thấy tin hết hạn (admin, theo RLS) — chữ GIỮ tương phản, chỉ giảm nhấn
//            ảnh bìa + badge "Hết hạn" (Q-141, không opacity cả thẻ).
// Tiêu đề tối đa 2 dòng (xem toàn văn ở chi tiết); thời điểm giữ formatDateTime đầy đủ (Q-142).

export type AnnouncementReadState = 'unread' | 'read' | 'untracked'

export interface AnnouncementCardData {
  id: string
  href: string
  title: string
  excerpt: string | null
  creatorName: string
  /** ISO thời điểm đăng (published_at) — dùng cả để nhóm theo ngày. */
  publishedAt: string
  byStore: boolean
  expired: boolean
  read: AnnouncementReadState
  coverUrl: string | null
}

export function AnnouncementCard({ a }: { a: AnnouncementCardData }) {
  const tracked = a.read !== 'untracked'
  const unread = a.read === 'unread'
  return (
    <Link
      href={a.href}
      data-ann-card={a.id}
      data-published-at={a.publishedAt}
      data-read={a.read}
      data-expired={a.expired ? '' : undefined}
      data-by-store={a.byStore ? '' : undefined}
      className={cn(
        'flex min-h-[44px] gap-3 rounded-lg border bg-card p-4 text-card-foreground transition-colors',
        'hover:bg-muted/40 active:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'v2:rounded-v2-panel v2:gap-3.5 v2:px-4 v2:py-3.5 md:v2:gap-4 md:v2:px-[18px] md:v2:py-4',
      )}
    >
      {tracked && (
        <span aria-hidden="true" className="w-2 shrink-0 pt-[7px]">
          <span data-ann-unread-dot={unread ? '' : undefined} className={cn('block size-2 rounded-full', unread ? 'bg-status-info' : 'bg-transparent')} />
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start gap-2">
          <span
            data-ann-title
            className={cn(
              'line-clamp-2 min-w-0 flex-1 break-words text-[15px] leading-[1.4]',
              unread ? 'font-bold' : a.read === 'read' ? 'font-medium' : 'font-semibold',
            )}
          >
            {a.title}
          </span>
          {(unread || a.expired) && (
            <span className="flex shrink-0 items-center gap-1">
              {a.expired && <StatusBadge tone="neutral" size="sm">Hết hạn</StatusBadge>}
              {unread && <StatusBadge tone="info" size="sm">Mới</StatusBadge>}
            </span>
          )}
        </div>
        {a.excerpt && <p className="line-clamp-2 break-words text-[13px] leading-[1.5] text-muted-foreground">{a.excerpt}</p>}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground v2:text-v2-text-3">
          <span className="min-w-0 break-words">{a.creatorName} · {formatDateTime(a.publishedAt)}</span>
          {a.byStore && <TagBadge hue="indigo">Theo cửa hàng</TagBadge>}
        </div>
      </div>
      {a.coverUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={a.coverUrl}
          alt=""
          loading="lazy"
          data-ann-cover
          className={cn(
            'size-[72px] shrink-0 rounded-lg border object-cover v2:rounded-[10px] md:size-[88px]',
            a.expired && 'opacity-60',
          )}
        />
      )}
    </Link>
  )
}
