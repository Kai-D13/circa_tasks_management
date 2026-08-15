import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { formatDateTime } from '@/lib/dateUtils'
import { Link2 } from 'lucide-react'

// P3-I — GMV Affiliate tháng hiện tại cho SM / Store Manager (own OS store),
// trên landing /targets (ẩn trong ?campaign=). Server-render thuần, CHỈ ĐỌC
// snapshot Supabase — KHÔNG nút đồng bộ (quyết định user 24/07). Staff không
// thấy card này (overviewVisibleFor = 'none').

const nf = new Intl.NumberFormat('vi-VN')
const vnd = (n: number) => `${nf.format(Math.round(n))}₫`

export function AffiliateGmvCard({
  monthLabel, gmv, orders, syncedAt, error = false, sourceWarning = null, detailHref = null,
  regional = false, variant = 'card', storesWithSales = null, storeCount = null,
}: {
  monthLabel: string          // vd "Tháng 07/2026"
  gmv: number
  orders: number
  syncedAt: string | null     // health lastSuccessAt — null = chưa có sync thành công
  error?: boolean             // RPC lỗi (kể cả fail-closed thiếu completed_time)
  sourceWarning?: string | null // r1.1: health không READY → chặn số, reason nổi lên card
  detailHref?: string | null  // P3-I.2: link màn tổng hợp (SM/QLCH — user chốt 24/07)
  regional?: boolean          // SM r5 (audit 27/07): copy đa cửa hàng cho tổng vùng
  // r2.4 (audit P2#4): SM landing đổi cột phải → DẢI NGANG trên danh sách
  // campaign. Prop THÊM VÀO, default 'card' — QLCH/staff giữ nguyên từng pixel.
  variant?: 'card' | 'strip'
  storesWithSales?: number | null  // strip: reduceAffiliateAgg().totals.storesWithSales
  storeCount?: number | null       // strip: mẫu số "X/Y" (số store trong phạm vi)
}) {
  // Fail-closed dùng CHUNG cho cả 2 biến thể: lỗi RPC hoặc nguồn chưa READY thì
  // KHÔNG có con số nào được hiện (0 giả trên màn tiền).
  const blocked = error || sourceWarning !== null
  const syncLine = syncedAt
    ? `Sync thành công gần nhất ${formatDateTime(syncedAt)}`
    : 'Chưa có lần sync thành công nào'

  if (variant === 'strip') {
    const stats: { label: string; value: string }[] = [
      { label: 'GMV Affiliate', value: blocked ? '—' : vnd(gmv) },
      { label: 'Đơn thành công', value: blocked ? '—' : nf.format(orders) },
      {
        // Nhãn OS-only — SM/QLCH luôn ở phạm vi store OS (FS chỉ super, xem
        // salesPointsLabel ở màn tổng hợp).
        label: 'Store có doanh số',
        value: blocked || storesWithSales === null ? '—'
          : storeCount !== null ? `${storesWithSales}/${storeCount}` : `${storesWithSales}`,
      },
    ]
    return (
      <Card className="rounded-lg">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-start gap-3 flex-wrap md:items-center">
            <p className="flex items-center gap-1.5 font-semibold text-sm shrink-0">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Link2 className="h-3.5 w-3.5" />
              </span>
              GMV Affiliate — Circa Online
            </p>
            <span className="text-xs text-muted-foreground shrink-0">{monthLabel}</span>
            {/* r2.6 (audit P2): chống số GMV dài đè cột. Cell đã có `min-w-0`
                (không có nó thì ô grid lấy min-content = cả con số, đẩy tràn),
                thêm `truncate` cho GIÁ TRỊ — nhãn vốn đã truncate. Dưới 640px
                xếp DỌC 1 cột: 3 cột trong 240px chỉ còn ~70px/ô, con số hàng tỉ
                sẽ cụt còn vài chữ số đầu, vô nghĩa. Từ sm trở lên vẫn 3 cột nên
                hình dạng ở >=1024px (bố cục stakeholder đã duyệt) KHÔNG đổi. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-8 flex-1 min-w-[240px] md:justify-items-center">
              {stats.map((s) => (
                <div key={s.label} className="min-w-0">
                  <p className="text-[11px] text-muted-foreground truncate">{s.label}</p>
                  <p className="text-xl font-bold tabular-nums leading-none mt-1 truncate">{s.value}</p>
                </div>
              ))}
            </div>
            {detailHref && (
              <Link
                href={detailHref}
                className="inline-flex items-center text-xs font-medium text-primary hover:underline min-h-[44px] md:min-h-0 shrink-0"
              >
                Xem chi tiết Affiliate →
              </Link>
            )}
          </div>
          {error ? (
            <p className="text-[11px] text-muted-foreground">Không tải được dữ liệu Affiliate. Vui lòng thử lại sau hoặc báo Admin.</p>
          ) : sourceWarning ? (
            <>
              <p className="text-[11px] text-status-warning">Nguồn dữ liệu chưa sẵn sàng: {sourceWarning} — số liệu tạm ẩn</p>
              <p className="text-[11px] text-muted-foreground">{syncLine}</p>
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Chỉ tính đơn giao thành công (DELIVERED) · tổng các cửa hàng bạn quản lý, ghi nhận theo mã đối tác từng cửa hàng
              {syncedAt ? ` · đồng bộ ${formatDateTime(syncedAt)}` : ' · chưa đồng bộ'}
            </p>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="rounded-lg">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-semibold text-sm">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
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
            <p className="text-[11px] text-muted-foreground">{syncLine}</p>
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
