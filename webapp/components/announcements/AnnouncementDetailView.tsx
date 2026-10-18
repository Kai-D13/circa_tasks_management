import Link from 'next/link'
import { ChevronLeft, Megaphone } from 'lucide-react'
import { ErrorState } from '@/components/ds/ErrorState'
import { Panel } from '@/components/ds/Panel'
import { RichText } from '@/components/tasks/RichText'
import { ReadMeter, type ReadStats } from '@/components/announcements/ReadMeter'
import { ReadStatsPanel, type ReadStatsData } from '@/components/announcements/ReadStatsPanel'
import { READ_STATS_ANCHOR } from '@/lib/announcements/readStats'
import { formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'

// UI v2 Phase 3 · Bảng tin (A2, artboard B2 admin desktop / M2 dược sĩ mobile) — trang chi tiết /announcements/[id],
// dùng CHUNG route thật và fixture /ui-catalog/announcements-v2?fx=detail-*. Chỉ trình bày (dữ liệu = truy vấn hiện có).
//   · page-root centered `max-w-3xl mx-auto` (PM GO) + gốc data-ui-v2; một link "Bảng tin" ở đầu (Q-143).
//   · Tiêu đề hiện ĐẦY ĐỦ (danh sách chỉ 2 dòng); thời điểm formatDateTime đầy đủ (Q-142).
//   · Admin: dải ReadMeter dưới tiêu đề (+ link "N người chưa xem ↓" tới panel #da-xem) và ReadStatsPanel; vai khác KHÔNG
//     có thống kê/đích gửi. Không có dòng "Đã đánh dấu là đã xem" (PM spec §2) — ghi nhận đọc vẫn chạy ngầm ở page.
//   · Ảnh carousel cuộn ngang có snap, KHÔNG chấm vị trí (Q-145).

export type AnnouncementDetailData =
  | { kind: 'error' }
  | {
      kind: 'ok'
      title: string
      creatorName: string
      publishedAt: string
      body: string | null
      coverUrl: string | null
      carousel: string[]
    }

function toMeter(stats: ReadStatsData): ReadStats {
  return stats.kind === 'error' ? { kind: 'error' } : { kind: 'ok', read: stats.read, total: stats.total }
}

export function AnnouncementDetailView({
  data, actions, stats, backHref = '/announcements',
}: {
  data: AnnouncementDetailData
  /** Nút Sửa/Xóa (chỉ khi canManage). */
  actions?: React.ReactNode
  /** Thống kê đã xem — CHỈ admin; null/undefined ⇒ không hiện gì. */
  stats?: ReadStatsData | null
  backHref?: string
}) {
  return (
    <div
      data-ui-v2="page"
      data-layout-width="centered"
      data-ann-detail={data.kind}
      className="mx-auto max-w-3xl space-y-4 p-4 md:p-6 v2:space-y-[18px]"
    >
      <Link
        href={backHref}
        data-ann-back
        className="-ml-1 inline-flex min-h-[44px] items-center gap-1 rounded-sm px-1 text-[13px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0"
      >
        <ChevronLeft aria-hidden="true" className="size-4" /> Bảng tin
      </Link>

      {data.kind === 'error' ? (
        <ErrorState message="Không tải được thông báo." hint="Vui lòng thử lại sau hoặc báo Admin." />
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <div className="min-w-0 flex-[1_1_420px] space-y-2">
              <span className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                <Megaphone aria-hidden="true" className="size-4 text-primary" /> Thông báo
              </span>
              <h1 data-ann-detail-title className="break-words text-[22px] font-bold leading-[1.3] md:text-[26px]">{data.title}</h1>
              <p className="text-[13px] text-muted-foreground">{data.creatorName} · {formatDateTime(data.publishedAt)}</p>
            </div>
            {actions}
          </div>

          {stats && <ReadMeter variant="strip" stats={toMeter(stats)} unreadHref={`#${READ_STATS_ANCHOR}`} />}

          {data.coverUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.coverUrl} alt="" data-ann-detail-cover className="max-h-72 w-full rounded-lg border object-cover v2:rounded-v2-panel" />
          )}

          {(data.body || data.carousel.length > 0) && (
            <Panel bodyClassName="space-y-3.5">
              {data.body && <RichText value={data.body} className="text-[15px] leading-[1.7]" />}
              {data.carousel.length > 0 && (
                <div data-ann-carousel className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1">
                  {data.carousel.map((url) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={url} src={url} alt="" className={cn('h-40 shrink-0 snap-start rounded-lg border object-cover v2:rounded-[10px]')} />
                  ))}
                </div>
              )}
            </Panel>
          )}

          {stats && <ReadStatsPanel stats={stats} />}
        </>
      )}
    </div>
  )
}
