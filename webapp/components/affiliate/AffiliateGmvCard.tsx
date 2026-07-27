import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { formatDateTime } from '@/lib/dateUtils'
import { Link2 } from 'lucide-react'

// P3-I — GMV Affiliate tháng hiện tại cho SM / Store Manager (own OS store),
// trên landing /targets (ẩn trong ?campaign=). Server-render thuần, CHỈ ĐỌC
// snapshot Supabase — KHÔNG nút đồng bộ (quyết định user 24/07). Staff không
// thấy card này (overviewVisibleFor = 'none').

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`

export function AffiliateGmvCard({ monthLabel, gmv, orders, syncedAt, error = false, sourceWarning = null, detailHref = null, regional = false }: {
  monthLabel: string          // vd "Tháng 07/2026"
  gmv: number
  orders: number
  syncedAt: string | null     // health lastSuccessAt — null = chưa có sync thành công
  error?: boolean             // RPC lỗi (kể cả fail-closed thiếu completed_time)
  sourceWarning?: string | null // r1.1: health không READY → chặn số, reason nổi lên card
  detailHref?: string | null  // P3-I.2: link màn tổng hợp (SM/QLCH — user chốt 24/07)
  regional?: boolean          // SM r5 (audit 27/07): copy đa cửa hàng cho tổng vùng
}) {
  return (
    <Card className="rounded-lg">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-semibold text-sm">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#a3b2bf]/20 text-[#5b6b7a] dark:text-[#a3b2bf]">
              <Link2 className="h-3.5 w-3.5" />
            </span>
            GMV Affiliate — Circa Online
          </p>
          <span className="text-xs text-muted-foreground shrink-0">{monthLabel}</span>
        </div>

        {error ? (
          <p className="text-sm text-muted-foreground">Không tải được dữ liệu Affiliate. Vui lòng thử lại sau hoặc báo Admin.</p>
        ) : sourceWarning ? (
          // r1.1 HEALTH FAIL-CLOSED: nguồn chưa READY → KHÔNG hiện số (0 giả
          // trên màn hình tiền) — chỉ '—' + lý do + lần sync thành công gần nhất.
          <>
            <div className="flex items-baseline gap-3 flex-wrap">
              <p className="text-2xl font-bold tabular-nums leading-none">—</p>
              <p className="text-sm text-muted-foreground">số liệu tạm ẩn</p>
            </div>
            <p className="text-[11px] text-status-warning">Nguồn dữ liệu chưa sẵn sàng: {sourceWarning}</p>
            <p className="text-[11px] text-muted-foreground">
              {syncedAt ? `Sync thành công gần nhất ${formatDateTime(syncedAt)}` : 'Chưa có lần sync thành công nào'}
            </p>
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-3 flex-wrap">
              <p className="text-2xl font-bold tabular-nums leading-none">{vnd(gmv)}</p>
              <p className="text-sm text-muted-foreground">{orders} đơn giao thành công</p>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {/* SM r5 (audit 27/07): copy regional — tổng NHIỀU cửa hàng, không
                  phải "mã đối tác của cửa hàng" số ít */}
              {regional
                ? 'Chỉ tính đơn giao thành công (DELIVERED) · tổng các cửa hàng bạn quản lý, ghi nhận theo mã đối tác từng cửa hàng'
                : 'Chỉ tính đơn giao thành công (DELIVERED) · ghi nhận theo mã đối tác của cửa hàng'}
              {syncedAt ? ` · đồng bộ ${formatDateTime(syncedAt)}` : ' · chưa đồng bộ'}
            </p>
          </>
        )}

        {detailHref && (
          <Link
            href={detailHref}
            className="inline-flex items-center text-xs font-medium text-primary hover:underline min-h-[44px] md:min-h-0"
          >
            Xem chi tiết Affiliate →
          </Link>
        )}
      </CardContent>
    </Card>
  )
}
