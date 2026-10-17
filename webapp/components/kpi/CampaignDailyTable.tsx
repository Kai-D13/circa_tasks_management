import { metricPresentation, REVENUE_LABELS } from '@/lib/kpi/campaignDisplay'
import { dailyPointValue, dailyValueFormatter, type DailySeriesKey, type DailySeriesPoint } from '@/lib/kpi/dailySeries'
import { formatDate } from '@/lib/dateUtils'

// UI v2 Phase 2 · K-6 (PM K-2: "biểu đồ ngày phải có bảng số liệu mở được bằng bàn phím/chạm; chưa đồng bộ hiện —").
// Bảng đi kèm CampaignDailyChart: <details>/<summary> gốc của trình duyệt ⇒ Enter/Space/chạm đều mở, không JS. Giá trị
// lấy từ CHÍNH dailyPointValue/dailyValueFormatter của biểu đồ (một nguồn). Hàng = ngày từ đầu kỳ tới min(hôm nay,
// hết kỳ) — ngày tương lai không có số; kỳ dài giữ ĐỦ ngày (giới hạn an toàn 366 ngày GẦN NHẤT, không bao giờ cắt
// mất hôm nay — pm-auditor K-6 P1). Ngày không có điểm / giá trị null ⇒ '—' (null ≠ 0). Server component.
const MAX_ROWS = 366
export function CampaignDailyTable({ start, end, daily, todayISO, metricType, series = 'orders', breakdown = false }: {
  start: string
  end: string
  daily: DailySeriesPoint[]
  todayISO: string
  metricType?: string
  series?: DailySeriesKey
  /** Chiến dịch bật CẢ 2 nguồn ⇒ thêm cột Offline / Affiliate (như tooltip breakdown của biểu đồ). */
  breakdown?: boolean
}) {
  const pres = metricPresentation(metricType)
  const isOrderAov = pres.kind === 'offline_order_aov'
  const fmt = dailyValueFormatter(metricType, series)
  const money = metricPresentation('gmv').value
  const last = todayISO < end ? todayISO : end
  const byDate = new Map(daily.map((d) => [d.date, d]))
  const days: string[] = []
  const DAY = 86400_000
  const stop = Date.parse(`${last}T00:00:00Z`)
  for (let t = Math.max(Date.parse(`${start}T00:00:00Z`), stop - (MAX_ROWS - 1) * DAY); t <= stop; t += DAY) {
    days.push(new Date(t).toISOString().slice(0, 10))
  }
  if (days.length === 0) return null
  const valueHeader = isOrderAov ? (series === 'aov' ? 'AOV' : 'Số đơn') : pres.kind === 'affiliate_customer_count' ? 'Số khách' : 'Doanh thu'
  const showBreakdown = breakdown && !isOrderAov && pres.kind === 'gmv'

  return (
    <details data-daily-table className="group mt-3 rounded-v2-control border">
      <summary className="flex min-h-[44px] cursor-pointer select-none items-center px-3 text-[13px] font-medium md:min-h-[36px]">
        Xem số liệu theo ngày
      </summary>
      <div className="max-h-72 overflow-auto border-t">
        <table className="w-full text-[13px] tabular-nums">
          <thead className="sticky top-0 bg-muted">
            <tr className="text-left">
              <th scope="col" className="px-3 py-2 text-[12px] font-medium text-muted-foreground">Ngày</th>
              <th scope="col" className="px-3 py-2 text-right text-[12px] font-medium text-muted-foreground">{valueHeader}</th>
              {showBreakdown && <th scope="col" className="px-3 py-2 text-right text-[12px] font-medium text-muted-foreground">{REVENUE_LABELS.offline}</th>}
              {showBreakdown && <th scope="col" className="px-3 py-2 text-right text-[12px] font-medium text-muted-foreground">{REVENUE_LABELS.affiliate}</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {days.map((day) => {
              const p = byDate.get(day)
              const v = p ? dailyPointValue(p, metricType, series) : null
              return (
                <tr key={day} data-daily-row={day} aria-current={day === todayISO ? 'date' : undefined} className={day === todayISO ? 'font-semibold' : undefined}>
                  <td className="px-3 py-1.5">{formatDate(day)}</td>
                  <td className="px-3 py-1.5 text-right">{v === null ? '—' : fmt(v)}</td>
                  {showBreakdown && <td className="px-3 py-1.5 text-right">{p ? money(p.gmv) : '—'}</td>}
                  {showBreakdown && <td className="px-3 py-1.5 text-right">{p ? money(p.gmv_affiliate) : '—'}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </details>
  )
}
