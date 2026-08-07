import { Card, CardContent } from '@/components/ui/card'
import { performanceTone } from '@/lib/kpi/performance'
import type { CampaignResultModel } from '@/lib/kpi/resultModel'
import { metricPresentation } from '@/lib/kpi/campaignDisplay'
import { resultTableColumns } from '@/lib/kpi/resultTableLayout'
import { cn } from '@/lib/utils'
import {
  Target, TrendingUp, Percent, Wallet, Award, CalendarDays, Gauge,
  Store as StoreIcon, Link2 as LinkIcon, type LucideIcon,
} from 'lucide-react'

// SM Dashboard r1 — component KẾT QUẢ campaign dùng chung Super Admin ↔ SM.
// PRESENTATIONAL THUẦN: chỉ render CampaignResultModel (lib/kpi/resultModel —
// một nguồn công thức) + nhận `actions` slot; KHÔNG auth/query/service-role.
//   Super: actions = Đồng bộ/Export (page truyền vào), rows = toàn campaign.
//   SM: actions = undefined (read-only), rows = RLS-scoped store phân công.
// Markup summary cards + bảng store CHUYỂN NGUYÊN VĂN từ tab Kết quả của
// super (refactor giữ nguyên hành vi — không đổi label/màu/công thức).

export function CampaignResultDashboard({ model, emptyHint }: {
  model: CampaignResultModel
  emptyHint?: string
}) {
  const m = model
  // Mig 103: giá trị METRIC (target/actual/còn thiếu — khách hoặc ₫) qua
  // presentation; commission LUÔN tiền. gmv → byte-equal formatter cũ.
  const pres = metricPresentation(m.campaign.metric_type)
  const vnd = (n: number) => pres.value(n)
  const money = (n: number) => metricPresentation('gmv').value(n)
  const isCustomer = pres.kind === 'affiliate_customer_count'
  const synced = m.lastSyncedAt !== null
  return (
    <>
      {/* Summary cards — thứ tự/label/màu giữ nguyên tab Kết quả super */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {([
          { label: 'Tổng KPI target', value: vnd(m.totalTarget), icon: Target, tile: 'bg-primary/10 text-primary' },
          { label: isCustomer ? 'Tổng số khách' : 'Tổng actual GMV', value: synced ? vnd(m.totalActual) : '—', icon: TrendingUp,
            tile: synced && m.totalActual > 0 ? 'bg-green-100 text-green-600' : 'bg-muted text-muted-foreground' },
          ...(m.showBreakdown ? [
            { label: 'GMV Offline', value: synced ? vnd(m.totalOffline) : '—', icon: StoreIcon,
              tile: 'bg-primary/10 text-primary' },
            { label: 'GMV Affiliate', value: synced ? vnd(m.totalAffiliate) : '—', icon: LinkIcon,
              tile: 'bg-muted text-muted-foreground' },
          ] : []),
          { label: 'Hoàn thành', value: synced ? `${m.completionPct.toFixed(1)}%` : '—', icon: Percent,
            tile: 'bg-primary/10 text-primary', bar: true,
            valueCls: !synced ? undefined : m.completionPct >= 100 ? 'text-green-600' : 'text-primary' },
          { label: 'Tổng commission đạt', value: synced ? money(m.totalCommission) : '—', icon: Wallet,
            tile: synced && m.totalCommission > 0 ? 'bg-green-100 text-green-600' : 'bg-muted text-muted-foreground',
            valueCls: synced && m.totalCommission > 0 ? 'text-green-600' : undefined },
          { label: 'Store đạt bậc', value: synced ? `${m.reachedStoreCount}/${m.storeCount}` : '—', icon: Award, tile: 'bg-primary/10 text-primary' },
          { label: 'Nhịp độ (Performance)', value: m.performance != null ? `${m.performance.toFixed(1)}%` : '—', icon: Gauge,
            tile: 'bg-primary/10 text-primary',
            valueCls: m.performance != null ? performanceTone(m.performance) : undefined },
          { label: 'Thời hạn', value: m.deadlineLabel, icon: CalendarDays, tile: 'bg-muted text-muted-foreground' },
        ] as { label: string; value: string; icon: LucideIcon; tile: string; valueCls?: string; bar?: boolean }[]).map((card) => (
          <Card key={card.label}>
            <CardContent className="p-3">
              <div className="flex items-start gap-2.5">
                <span className={cn('h-8 w-8 rounded-full flex items-center justify-center shrink-0', card.tile)}>
                  <card.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-muted-foreground uppercase truncate">{card.label}</p>
                  <p className={cn('text-lg font-bold mt-0.5 leading-tight', card.valueCls)}>{card.value}</p>
                  {card.bar && synced && (
                    <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn('h-full rounded-full', m.completionPct >= 100 ? 'bg-green-500' : 'bg-primary')}
                        style={{ width: `${Math.min(100, Math.max(0, m.completionPct))}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Bảng kết quả từng store — cột giữ nguyên tab Kết quả super.
          r1.6 (P1 UI 29/07): MỘT scroll owner duy nhất (ngang + dọc, max-h
          theo viewport từ lg — scrollbar ngang nằm trong vùng bảng, không phải
          cuộn hết 25 store mới thấy); header sticky top + cột Cửa hàng sticky
          left (chỉ lg — mobile giữ UI cũ: overflow-x như trước, không max-h);
          width contract từ lib/kpi/resultTableLayout (min-width px literal —
          layout không đổi theo dữ liệu); body KHÔNG bao giờ scroll ngang. */}
      {m.rows.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto lg:overflow-auto lg:max-h-[70vh]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                  {/* Tier progress (28/07): mobile giữ cột gộp cũ (scope
                      'mobile'); desktop ≥1024px = N cột Bậc động theo
                      maxTierCount (không hardcode 3). Thứ tự cột trong
                      resultTableColumns PHẢI khớp thứ tự cell ở tbody. */}
                  {resultTableColumns(m.maxTierCount, m.showBreakdown, m.campaign.metric_type).map((col) => (
                    <th
                      key={col.key}
                      // r1.6.1 (audit P2): min-width qua CSS var + lg:min-w —
                      // width contract CHỈ hiệu lực từ desktop; mobile giữ
                      // nguyên 100% hành vi cột cũ (browser tự tính).
                      style={{ '--col-w': `${col.minPx}px` } as React.CSSProperties}
                      className={cn(
                        'px-4 py-2.5 lg:min-w-[var(--col-w)]',
                        col.align === 'right' ? 'text-right' : 'text-left',
                        col.scope === 'mobile' && 'lg:hidden',
                        col.scope === 'desktop' && 'hidden lg:table-cell whitespace-nowrap',
                        'lg:sticky lg:top-0 lg:z-20 lg:bg-muted',
                        col.key === 'store' && 'lg:left-0 lg:z-30',
                      )}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {m.rows.map((r) => {
                  const a = r.actual
                  const remaining = a?.remaining_target ?? null
                  return (
                    <tr key={r.targetId} className="hover:bg-muted/30">
                      {/* r1.6: sticky left CHỈ lg (mobile giữ UI cũ) — bg-card
                          opaque để nội dung cuộn khuất phía dưới cell */}
                      <td className="px-4 py-2.5 font-medium lg:sticky lg:left-0 lg:z-10 lg:bg-card">{r.storeName ?? '—'}{r.posCode ? ` · ${r.posCode}` : ''}</td>
                      <td className="px-4 py-2.5 text-xs">{r.group ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">{vnd(r.kpiTarget)}</td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">{a ? vnd(a.actual_value) : '—'}</td>
                      {m.showBreakdown && <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">{a?.actual_offline != null ? vnd(a.actual_offline) : '—'}</td>}
                      {m.showBreakdown && <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">{a?.actual_affiliate != null ? vnd(a.actual_affiliate) : '—'}</td>}
                      <td className="px-4 py-2.5">
                        {a?.run_rate != null ? (
                          <div className="flex items-center justify-end gap-2">
                            <div className="h-1.5 w-14 rounded-full bg-muted overflow-hidden shrink-0">
                              <div
                                className={cn('h-full rounded-full', a.run_rate >= 100 ? 'bg-green-500' : 'bg-primary')}
                                style={{ width: `${Math.min(100, Math.max(0, a.run_rate))}%` }}
                              />
                            </div>
                            <span className={cn('text-xs font-semibold', a.run_rate >= 100 ? 'text-green-600' : 'text-primary')}>
                              {a.run_rate.toFixed(1)}%
                            </span>
                          </div>
                        ) : <span className="block text-right">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {r.performance != null
                          ? <span className={cn('text-xs font-semibold', performanceTone(r.performance))}>{r.performance.toFixed(1)}%</span>
                          : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">{remaining != null ? vnd(remaining) : '—'}</td>
                      {/* Mobile: cột gộp cũ giữ nguyên */}
                      <td className="px-4 py-2.5 lg:hidden">
                        {a?.achieved_tier_order != null
                          ? (
                            <span className="inline-flex items-center whitespace-nowrap rounded-full bg-green-100 text-green-700 px-2 py-0.5 text-[11px] font-medium">
                              Bậc {a.achieved_tier_order} · {money(a.store_commission_pool ?? 0)}
                            </span>
                          )
                          : a ? (
                            <span className="inline-flex items-center whitespace-nowrap rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-[11px]">
                              Chưa đạt bậc
                            </span>
                          ) : '—'}
                      </td>
                      {/* Desktop ≥1024px: tiến độ từng bậc (model tierProgress —
                          Super ↔ SM cùng công thức; chưa sync → '—' không phải 0) */}
                      {Array.from({ length: m.maxTierCount }, (_, i) => {
                        const tp = r.tierProgress[i]
                        return (
                          <td key={`tier-${r.targetId}-${i}`} className="hidden lg:table-cell px-4 py-2.5 align-top">
                            {!tp ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <div className="text-xs whitespace-nowrap">
                                <p className="text-muted-foreground">{tp.threshold_pct}% · {money(tp.commission_amount)}</p>
                                {tp.remaining_amount === null ? (
                                  <p className="text-muted-foreground mt-0.5">—</p>
                                ) : tp.reached ? (
                                  <p className="font-medium text-green-600 mt-0.5">Đã đạt</p>
                                ) : (
                                  <p className="font-medium text-primary mt-0.5">Còn thiếu {vnd(tp.remaining_amount)}</p>
                                )}
                              </div>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">{emptyHint ?? 'Chưa có dữ liệu kết quả.'}</CardContent></Card>
      )}
    </>
  )
}
