import { Card, CardContent } from '@/components/ui/card'
import { performanceTone } from '@/lib/kpi/performance'
import type { CampaignResultModel } from '@/lib/kpi/resultModel'
import { metricPresentation, offlineOrderLine, REVENUE_LABELS } from '@/lib/kpi/campaignDisplay'
import type { OrderAovMetricView } from '@/lib/kpi/orderAov'
import { resultTableColumns } from '@/lib/kpi/resultTableLayout'
import { cn } from '@/lib/utils'
import {
  Target, TrendingUp, Percent, Wallet, Award, CalendarDays, Gauge,
  Store as StoreIcon, Link2 as LinkIcon, Gift, type LucideIcon,
} from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { campaignListPct, campaignListReached, campaignListTone } from '@/lib/kpi/campaignList'

// SM Dashboard r1 — component KẾT QUẢ campaign dùng chung Super Admin ↔ SM.
// PRESENTATIONAL THUẦN: chỉ render CampaignResultModel (lib/kpi/resultModel —
// một nguồn công thức) + nhận `actions` slot; KHÔNG auth/query/service-role.
//   Super: actions = Đồng bộ/Export (page truyền vào), rows = toàn campaign.
//   SM: actions = undefined (read-only), rows = RLS-scoped store phân công.
// Markup summary cards + bảng store CHUYỂN NGUYÊN VĂN từ tab Kết quả của
// super (refactor giữ nguyên hành vi — không đổi label/màu/công thức).

// Commit 5 — ô bảng của MỘT chỉ số Chất lượng bán hàng (Số đơn hoặc AOV).
// Dòng trên: 'thực tế / mục tiêu'. Dòng dưới: thanh + % RIÊNG của chỉ số đó,
// không cap 100 ở phần chữ (thanh thì clamp vì thanh không vẽ quá khung).
// Mọi định dạng/đạt-chưa đến từ contract orderAovDualView — ô này không tự tính.
function MetricCell({ mv }: { mv: OrderAovMetricView | null }) {
  if (!mv) return <td className="px-4 py-2.5 text-xs text-muted-foreground">—</td>
  return (
    <td className="px-4 py-2.5 text-xs">
      <span className="block whitespace-nowrap font-medium tabular-nums">{mv.valueText}</span>
      <span className="mt-1 flex items-center gap-2">
        <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-muted">
          <span
            className={cn('block h-full rounded-full', mv.pass ? 'bg-status-success v2:bg-v2-ok' : 'bg-primary v2:bg-v2-series')}
            style={{ width: `${Math.min(100, Math.max(0, mv.pctRaw ?? 0))}%` }}
          />
        </span>
        <span className={cn('font-semibold tabular-nums v2:text-foreground', mv.pass ? 'text-status-success' : 'text-primary')}>
          {mv.pctText}
        </span>
      </span>
    </td>
  )
}

export function CampaignResultDashboard({ model, emptyHint, layout = 'legacy' }: {
  model: CampaignResultModel
  emptyHint?: string
  /** UI v2 Phase 2 (K-2): 'v2' = phần tóm tắt theo canvas K2 (hero Hoàn thành + ô + 2 thẻ nguồn) — CHỈ trang đã
   *  gắn data-ui-v2 truyền. 'legacy' (mặc định) giữ nguyên DOM cũ cho route chưa chuyển (SM/QLCH /targets). */
  layout?: 'legacy' | 'v2'
}) {
  const m = model
  // Mig 103: giá trị METRIC (target/actual/còn thiếu — khách hoặc ₫) qua
  // presentation; commission LUÔN tiền. gmv → byte-equal formatter cũ.
  const pres = metricPresentation(m.campaign.metric_type)
  const vnd = (n: number) => pres.value(n)
  const money = (n: number) => metricPresentation('gmv').value(n)
  const isCustomer = pres.kind === 'affiliate_customer_count'
  // Mig 106: Chất lượng bán hàng — bộ card RIÊNG (KPI target 100% không có
  // nghĩa khi cộng dồn) + 2 cell gộp Order/AOV trong bảng.
  const isOrderAov = pres.kind === 'offline_order_aov'
  const nfInt = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n))
  const synced = m.lastSyncedAt !== null
  return (
    <>
      {layout === 'v2' ? <ResultSummaryV2 m={m} /> : (
      /* Summary cards — thứ tự/label/màu giữ nguyên tab Kết quả super */
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {((isOrderAov ? [
          // "X/Y cửa hàng đạt" theo KPI PASS (completion >= 100%), KHÔNG theo bậc.
          { label: 'Cửa hàng đạt KPI', value: synced ? `${m.qualityPassCount}/${m.storeCount}` : '—', icon: Award,
            tile: synced && m.qualityPassCount > 0 ? 'bg-status-success-bg text-status-success' : 'bg-primary/10 text-primary',
            valueCls: synced && m.qualityPassCount > 0 ? 'text-status-success' : undefined },
          { label: 'Tổng số đơn', value: synced && m.totalOfflineOrders != null ? `${nfInt(m.totalOfflineOrders)} đơn` : '—',
            icon: TrendingUp, tile: 'bg-primary/10 text-primary' },
          { label: 'AOV bình quân', value: synced && m.totalOfflineAov != null ? money(m.totalOfflineAov) : '—',
            icon: StoreIcon, tile: 'bg-primary/10 text-primary' },
          { label: 'Net Revenue (tham khảo)', value: synced ? money(m.totalOffline) : '—', icon: Wallet,
            tile: 'bg-muted text-muted-foreground' },
          { label: 'Tổng commission đạt', value: synced ? money(m.totalCommission) : '—', icon: Wallet,
            tile: synced && m.totalCommission > 0 ? 'bg-status-success-bg text-status-success' : 'bg-muted text-muted-foreground',
            valueCls: synced && m.totalCommission > 0 ? 'text-status-success' : undefined },
          // r1.1 (audit P2): BỎ 'Store đạt bậc' — với policy đúng 1 bậc mốc 100
          // nó trùng nghĩa 'Cửa hàng đạt KPI' ở trên.
          { label: 'Thời hạn', value: m.deadlineLabel, icon: CalendarDays, tile: 'bg-muted text-muted-foreground' },
        ] : [
          { label: 'Tổng KPI target', value: vnd(m.totalTarget), icon: Target, tile: 'bg-primary/10 text-primary' },
          { label: isCustomer ? 'Tổng số khách' : REVENUE_LABELS.total, value: synced ? vnd(m.totalActual) : '—', icon: TrendingUp,
            // 105: campaign offline-only (không breakdown) → dòng phụ đặt ở
            // card này; hybrid có card GMV Offline riêng bên dưới.
            sub: !m.showBreakdown && !isCustomer && !isOrderAov && synced
              ? offlineOrderLine(m.totalOffline, m.totalOfflineOrders) : null,
            tile: synced && m.totalActual > 0 ? 'bg-status-success-bg text-status-success' : 'bg-muted text-muted-foreground' },
          ...(m.showBreakdown ? [
            { label: REVENUE_LABELS.offline, value: synced ? vnd(m.totalOffline) : '—', icon: StoreIcon,
              // 105: dòng phụ tổng — AOV WEIGHTED (totalOffline/totalOrders),
              // '—' khi bất kỳ store nào thiếu count (model đã trả null).
              sub: synced ? offlineOrderLine(m.totalOffline, m.totalOfflineOrders) : null,
              tile: 'bg-primary/10 text-primary' },
            { label: REVENUE_LABELS.affiliate, value: synced ? vnd(m.totalAffiliate) : '—', icon: LinkIcon,
              tile: 'bg-muted text-muted-foreground' },
          ] : []),
          { label: 'Hoàn thành', value: synced ? `${m.completionPct.toFixed(1)}%` : '—', icon: Percent,
            tile: 'bg-primary/10 text-primary', bar: true,
            valueCls: !synced ? undefined : m.completionPct >= 100 ? 'text-status-success' : 'text-primary' },
          { label: 'Tổng commission đạt', value: synced ? money(m.totalCommission) : '—', icon: Wallet,
            tile: synced && m.totalCommission > 0 ? 'bg-status-success-bg text-status-success' : 'bg-muted text-muted-foreground',
            valueCls: synced && m.totalCommission > 0 ? 'text-status-success' : undefined },
          // Mig 112: card RIÊNG ngay sau commission — không cộng gộp hai khoản.
          ...(m.showOrderBonus ? [
            { label: 'Đạt thưởng thêm', value: synced ? `${m.bonusAchievedCount}/${m.storeCount} cửa hàng` : '—', icon: Gift,
              sub: m.bonusPerStaffLabel,
              tile: synced && m.bonusAchievedCount > 0 ? 'bg-status-success-bg text-status-success' : 'bg-muted text-muted-foreground',
              valueCls: synced && m.bonusAchievedCount > 0 ? 'text-status-success' : undefined },
          ] : []),
          { label: 'Store đạt bậc', value: synced ? `${m.reachedStoreCount}/${m.storeCount}` : '—', icon: Award, tile: 'bg-primary/10 text-primary' },
          { label: 'Nhịp độ (Performance)', value: m.performance != null ? `${m.performance.toFixed(1)}%` : '—', icon: Gauge,
            tile: 'bg-primary/10 text-primary',
            valueCls: m.performance != null ? performanceTone(m.performance) : undefined },
          { label: 'Thời hạn', value: m.deadlineLabel, icon: CalendarDays, tile: 'bg-muted text-muted-foreground' },
        ]) as { label: string; value: string; icon: LucideIcon; tile: string; valueCls?: string; bar?: boolean; sub?: string | null }[]).map((card) => (
          <Card key={card.label}>
            <CardContent className="p-3">
              <div className="flex items-start gap-2.5">
                <span className={cn('h-8 w-8 rounded-full flex items-center justify-center shrink-0', card.tile)}>
                  <card.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-muted-foreground uppercase truncate">{card.label}</p>
                  <p className={cn('text-lg font-bold mt-0.5 leading-tight', card.valueCls)}>{card.value}</p>
                  {/* 105: dòng phụ số đơn · AOV (chỉ card GMV Offline / Actual
                      GMV của campaign offline-only) */}
                  {card.sub && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{card.sub}</p>}
                  {card.bar && synced && (
                    <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn('h-full rounded-full', m.completionPct >= 100 ? 'bg-status-success' : 'bg-primary')}
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
      )}

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
                <tr className="border-b bg-muted/40 text-xs text-muted-foreground v2:bg-muted v2:text-[12px]">
                  {/* Tier progress (28/07): mobile giữ cột gộp cũ (scope
                      'mobile'); desktop ≥1024px = N cột Bậc động theo
                      maxTierCount (không hardcode 3). Thứ tự cột trong
                      resultTableColumns PHẢI khớp thứ tự cell ở tbody. */}
                  {resultTableColumns(m.maxTierCount, m.showBreakdown, m.campaign.metric_type, m.showGroup, m.showOrderBonus).map((col) => (
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
                  // 105: dòng phụ theo store — null ⇒ không render (snapshot
                  // cũ/campaign khách/affiliate-only).
                  const orderLine = () => (isCustomer || isOrderAov)
                    ? null : offlineOrderLine(r.actual?.actual_offline ?? 0, r.offlineOrderCount)
                  const a = r.actual
                  return (
                    <tr key={r.targetId} className="hover:bg-muted/30">
                      {/* r1.6: sticky left CHỈ lg (mobile giữ UI cũ) — bg-card
                          opaque để nội dung cuộn khuất phía dưới cell */}
                      <td className="px-4 py-2.5 font-medium lg:sticky lg:left-0 lg:z-10 lg:bg-card">{r.storeName ?? '—'}{r.posCode ? ` · ${r.posCode}` : ''}</td>
                      {/* 107: cùng cờ m.showGroup với header — MỘT nguồn, không
                          bao giờ lệch cột. Dữ liệu hỗn hợp thì giữ cột và hiện
                          '—' cho store chưa phân loại. */}
                      {m.showGroup && <td className="px-4 py-2.5 text-xs">{r.group ?? '—'}</td>}
                      {!isOrderAov && (
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">{vnd(r.kpiTarget)}</td>
                      )}
                      {/* Commit 5: Chất lượng bán hàng KHÔNG còn cột điểm gộp. */}
                      {!isOrderAov && (
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        {a ? vnd(a.actual_value) : '—'}
                        {/* 105: offline-only → dòng phụ nằm ngay dưới Actual GMV
                            (hybrid đã có cột GMV Offline riêng) */}
                        {!m.showBreakdown && orderLine() && (
                          <span className="block text-[11px] text-muted-foreground/80">{orderLine()}</span>
                        )}
                      </td>
                      )}
                      {/* Commit 5: HAI cột độc lập — mỗi chỉ số có % RIÊNG,
                          không cap 100. Cột nào chưa đạt thì tự nó nói ra, thay
                          vì bị min() nuốt vào một con số duy nhất. */}
                      {isOrderAov && <MetricCell mv={r.orderAovView?.order ?? null} />}
                      {isOrderAov && <MetricCell mv={r.orderAovView?.aov ?? null} />}
                      {isOrderAov && (
                        <td className="px-4 py-2.5 text-xs">
                          {r.qualityStatusLabel ? (
                            <span className={cn(
                              'inline-block px-2 py-0.5 rounded-full font-medium',
                              r.qualityKpiPass ? 'bg-status-success-bg text-status-success' : 'bg-status-warning-bg text-status-warning',
                            )}>
                              {r.qualityStatusLabel}
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      )}
                      {m.showBreakdown && (
                        <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">
                          {a?.actual_offline != null ? vnd(a.actual_offline) : '—'}
                          {/* 105: dòng phụ số đơn · AOV — KHÔNG thêm cột mới */}
                          {orderLine() && <span className="block text-[11px] text-muted-foreground/80">{orderLine()}</span>}
                        </td>
                      )}
                      {m.showBreakdown && <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">{a?.actual_affiliate != null ? vnd(a.actual_affiliate) : '—'}</td>}
                      {!isOrderAov && (
                      <td className="px-4 py-2.5">
                        {a?.run_rate != null ? (
                          <div className="flex items-center justify-end gap-2">
                            <div className="h-1.5 w-14 rounded-full bg-muted overflow-hidden shrink-0">
                              <div
                                className={cn('h-full rounded-full', a.run_rate >= 100 ? 'bg-status-success v2:bg-v2-ok' : 'bg-primary v2:bg-v2-series')}
                                style={{ width: `${Math.min(100, Math.max(0, a.run_rate))}%` }}
                              />
                            </div>
                            <span className={cn('text-xs font-semibold tabular-nums v2:text-foreground', a.run_rate >= 100 ? 'text-status-success' : 'text-primary')}>
                              {a.run_rate.toFixed(1)}%
                            </span>
                          </div>
                        ) : <span className="block text-right">—</span>}
                      </td>
                      )}
                      {/* Commit 5: 'Nhịp độ' là run_rate của ĐIỂM GỘP ⇒ bỏ
                          cùng lúc với điểm gộp. Cell phải mất theo HEADER —
                          giữ lại là lệch một cột và mọi giá trị bên phải bị
                          đọc dưới tên cột khác. */}
                      {!isOrderAov && (
                      <td className="px-4 py-2.5 text-right">
                        {r.performance != null
                          ? <span className={cn('text-xs font-semibold', performanceTone(r.performance))}>{r.performance.toFixed(1)}%</span>
                          : '—'}
                      </td>
                      )}
                      {/* 10/08: 'Trung bình/ngày' thay 'Còn thiếu' — cùng
                          công thức card Staff (requiredPerDay); đơn vị theo
                          metric (VNĐ / khách) qua metricPresentation. */}
                      {/* r1.1: Chất lượng bán hàng ẩn cột này (điểm %/ngày
                          không tương đương số đơn/ngày hay AOV/ngày). */}
                      {!isOrderAov && (
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">{r.requiredPerDay != null ? vnd(r.requiredPerDay) : '—'}</td>
                      )}
                      {/* Mig 112: thưởng thêm theo số đơn — CÙNG cờ m.showOrderBonus
                          với header (một nguồn, không lệch cột). Thứ tự khớp
                          resultTableColumns: bonusOrders · bonus (desktop) ·
                          bonusCombined (mobile). Đọc r.orderBonus = snapshot toàn
                          kỳ, không bao giờ từ actual_value (bị lọc khoảng ghi đè). */}
                      {m.showOrderBonus && (
                        <td className="hidden lg:table-cell px-4 py-2.5 text-right whitespace-nowrap tabular-nums">
                          {r.orderBonus?.ordersLine ?? '—'}
                          {r.orderBonus?.hint && r.orderBonus.status === 'not_achieved' && (
                            <span className="block text-[11px] text-muted-foreground/80">{r.orderBonus.hint}</span>
                          )}
                        </td>
                      )}
                      {m.showOrderBonus && (
                        <td className="hidden lg:table-cell px-4 py-2.5">
                          {r.orderBonus
                            ? <StatusBadge tone={r.orderBonus.tone}>{r.orderBonus.status === 'achieved' ? `Đạt · ${r.orderBonus.perStaffAmountLabel}` : r.orderBonus.statusLabel}</StatusBadge>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                      )}
                      {m.showOrderBonus && (
                        <td className="px-4 py-2.5 lg:hidden">
                          {r.orderBonus ? (
                            <>
                              <span className="block text-xs tabular-nums whitespace-nowrap">{r.orderBonus.ordersLine}</span>
                              <StatusBadge tone={r.orderBonus.tone} className="mt-1">
                                {r.orderBonus.status === 'achieved' ? `Đạt · ${r.orderBonus.perStaffAmountLabel}` : r.orderBonus.statusLabel}
                              </StatusBadge>
                            </>
                          ) : '—'}
                        </td>
                      )}
                      {/* Mobile: cột gộp cũ giữ nguyên */}
                      <td className="px-4 py-2.5 lg:hidden">
                        {a?.achieved_tier_order != null
                          ? (
                            <span className="inline-flex items-center whitespace-nowrap rounded-full bg-status-success-bg text-status-success px-2 py-0.5 text-[11px] font-medium">
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
                                  <p className="font-medium text-status-success mt-0.5">Đã đạt</p>
                                ) : isOrderAov ? null : (
                                  // Commit 5: order_aov KHÔNG hiện dòng này —
                                  // "còn thiếu tới bậc" là khoảng cách điểm gộp
                                  // tới 100, tức con số vừa bỏ khỏi UI đổi tên.
                                  <p className="font-medium text-primary mt-0.5 v2:text-foreground">
                                    Còn thiếu {vnd(tp.remaining_amount)}
                                  </p>
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

// ── UI v2 (canvas K2) — phần tóm tắt. CHỈ trình bày lại số của CampaignResultModel; nhãn giữ wording hiện có
// (Hoàn thành / Tổng KPI target / Nhịp độ (Performance) / Store đạt bậc / Tổng commission đạt / Thời hạn …).
// % hero = campaignListPct (tỷ lệ THÔ, 1 chữ số, chưa đạt mà làm tròn lên 100 ⇒ "<100%") — cùng luật danh sách K-1;
// màu "đạt" từ số thô (campaignListReached). Chưa đồng bộ ⇒ '—' + thanh nét đứt, không 0 giả.
function ResultTile({ id, label, value, valueCls, hint }: {
  id: string; label: string; value: string; valueCls?: string; hint?: string | null
}) {
  return (
    <div data-result-tile={id} className="min-w-0 rounded-v2-panel border bg-card px-[18px] py-4">
      <p className="text-[13px] leading-[1.4] text-v2-text-3">{label}</p>
      <p className={cn('mt-1.5 text-[24px] font-bold leading-[1.1] tabular-nums', valueCls)}>{value}</p>
      {hint && <p className="mt-1.5 text-[12px] text-v2-text-3">{hint}</p>}
    </div>
  )
}

function ResultSummaryV2({ m }: { m: CampaignResultModel }) {
  const pres = metricPresentation(m.campaign.metric_type)
  const vnd = (n: number) => pres.value(n)
  const money = (n: number) => metricPresentation('gmv').value(n)
  const nfInt = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n))
  const isCustomer = pres.kind === 'affiliate_customer_count'
  const synced = m.lastSyncedAt !== null
  const commissionTone = synced && m.totalCommission > 0 ? 'text-status-success' : undefined
  const deadline = <ResultTile id="deadline" label="Thời hạn" value={m.deadlineLabel} />

  if (pres.kind === 'offline_order_aov') {
    // Chất lượng bán hàng: GIỮ bộ ô riêng (không hero Hoàn thành — điểm gộp không hiển thị, commit 5).
    return (
      <div data-result-summary="quality" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <ResultTile id="quality-pass" label="Cửa hàng đạt KPI" value={synced ? `${m.qualityPassCount}/${m.storeCount}` : '—'}
          valueCls={synced && m.qualityPassCount > 0 ? 'text-status-success' : undefined} />
        <ResultTile id="orders" label="Tổng số đơn" value={synced && m.totalOfflineOrders != null ? `${nfInt(m.totalOfflineOrders)} đơn` : '—'} />
        <ResultTile id="aov" label="AOV bình quân" value={synced && m.totalOfflineAov != null ? money(m.totalOfflineAov) : '—'} />
        <ResultTile id="net" label="Net Revenue (tham khảo)" value={synced ? money(m.totalOffline) : '—'} />
        <ResultTile id="commission" label="Tổng commission đạt" value={synced ? money(m.totalCommission) : '—'} valueCls={commissionTone} />
        {deadline}
      </div>
    )
  }

  const input = {
    metricType: m.campaign.metric_type, synced, storeCount: m.storeCount,
    totalTarget: m.totalTarget, totalActual: m.totalActual, qualityPassCount: m.qualityPassCount,
  }
  const pct = campaignListPct(input)
  const tone = synced && pct.raw !== null
    ? campaignListTone({ synced, reached: campaignListReached(input), status: m.campaign.status })
    : 'unsynced'
  // 105: campaign offline-only (không breakdown) ⇒ dòng số đơn · AOV nằm dưới tổng thực đạt (như card cũ).
  const totalSub = !m.showBreakdown && !isCustomer && synced ? offlineOrderLine(m.totalOffline, m.totalOfflineOrders) : null
  const offlineSub = synced ? offlineOrderLine(m.totalOffline, m.totalOfflineOrders) : null

  return (
    <div data-result-summary={pres.kind} className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <section data-result-hero className="min-w-0 rounded-v2-panel border bg-card px-5 py-[18px] lg:px-6 lg:py-5">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-[13px] text-v2-text-3">Hoàn thành</p>
              <p data-result-completion={tone} className={cn('mt-1 text-[40px] font-bold leading-none tabular-nums', tone === 'unsynced' && 'text-v2-text-3')}>
                {pct.text}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[13px] text-v2-text-3">{isCustomer ? 'Tổng số khách' : REVENUE_LABELS.total}</p>
              <p data-result-actual className="mt-1 text-[18px] font-bold tabular-nums">{synced ? vnd(m.totalActual) : '—'}</p>
              {totalSub && <p className="text-[12px] text-v2-text-3">{totalSub}</p>}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] text-v2-text-3">Tổng KPI target</p>
              <p data-result-target className="mt-1 text-[18px] font-bold tabular-nums text-muted-foreground">{vnd(m.totalTarget)}</p>
            </div>
          </div>
          <div className="mt-5">
            {tone === 'unsynced' ? (
              <div aria-hidden="true" className="h-[12px] rounded-full border border-dashed border-input bg-muted" />
            ) : (
              <ProgressBar value={pct.raw ?? 0} max={100} tone={tone} size={12} ariaLabel={`Hoàn thành ${pct.text}`} />
            )}
          </div>
        </section>
        <div className="grid grid-cols-2 gap-3">
          {/* Định dạng giữ như bản cũ và như cột "Nhịp độ" của bảng (toFixed(1)) — không đổi số trong batch UI (Q-129). */}
          <ResultTile id="pace" label="Nhịp độ (Performance)" value={m.performance != null ? `${m.performance.toFixed(1)}%` : '—'}
            valueCls={m.performance != null ? performanceTone(m.performance) : undefined} />
          <ResultTile id="reached" label="Store đạt bậc" value={synced ? `${m.reachedStoreCount}/${m.storeCount}` : '—'} />
          <ResultTile id="commission" label="Tổng commission đạt" value={synced ? money(m.totalCommission) : '—'} valueCls={commissionTone} />
          {/* Mig 112: ô RIÊNG ngay sau commission — không cộng gộp hai khoản. */}
          {m.showOrderBonus && (
            <ResultTile id="bonus" label="Đạt thưởng thêm" value={synced ? `${m.bonusAchievedCount}/${m.storeCount} cửa hàng` : '—'}
              valueCls={synced && m.bonusAchievedCount > 0 ? 'text-status-success' : undefined} hint={m.bonusPerStaffLabel} />
          )}
          {deadline}
        </div>
      </div>
      {m.showBreakdown && (
        <div data-result-breakdown className="grid gap-3 md:grid-cols-2">
          <div className="flex min-w-0 items-end justify-between gap-3 rounded-v2-panel border bg-card px-5 py-4">
            <div className="min-w-0">
              <p className="text-[13px] text-v2-text-3">{REVENUE_LABELS.offline}</p>
              <p className="mt-1 text-[18px] font-bold tabular-nums">{synced ? vnd(m.totalOffline) : '—'}</p>
            </div>
            {offlineSub && <p className="shrink-0 text-right text-[12px] text-v2-text-3">{offlineSub}</p>}
          </div>
          <div className="min-w-0 rounded-v2-panel border bg-card px-5 py-4">
            <p className="text-[13px] text-v2-text-3">{REVENUE_LABELS.affiliate}</p>
            <p className="mt-1 text-[18px] font-bold tabular-nums">{synced ? vnd(m.totalAffiliate) : '—'}</p>
          </div>
        </div>
      )}
    </div>
  )
}
