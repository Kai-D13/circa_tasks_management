import Link from 'next/link'
import { ChevronDown, Users } from 'lucide-react'
import { StatCard } from '@/components/ds/StatCard'
import { Notice } from '@/components/ds/Notice'
import { EmptyState } from '@/components/ds/EmptyState'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { cn } from '@/lib/utils'
import { cmsDateTime, cmsVnd } from '@/lib/cms/display'
import {
  cmsGateView, cmsProductSalesStats, cmsProductTierDistribution, cmsQtyText, cmsStaffRows, cmsTierPosition, cmsTruncVnd,
  type CmsA3Stats, type CmsStaffRowView, type CmsUiTier, type CmsUnassignedSummary,
} from '@/lib/cms/resultUi'
import type { CmsCatalogRowDto, CmsResultHeaderDto, CmsResultRowDto, CmsResultUserDto } from '@/lib/cms/resultView'
import { parseCmsDecimal } from '@/lib/cms/decimal'

// CMS P2-c (I3) · khối kết quả A3 /targets/campaigns/cms/[id] (UI §3.3; U11 / U12 / U20; Q-212). Chỉ TRÌNH BÀY số đã cộng
// từ snapshot (lib/cms/resultUi) — mỗi dược sĩ đã áp gate / bậc riêng, tổng không áp lại bậc. Chưa có snapshot ⇒ '—'.

export function CmsA3StatCards({ stats }: { stats: CmsA3Stats | null }) {
  const v = (x: React.ReactNode) => <span className="tabular-nums">{stats ? x : '—'}</span>
  return (
    <div data-cms-detail-results className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      <StatCard label="CMS tạm tính" value={v(stats && cmsVnd(stats.amountVnd))} />
      <StatCard label="GMV SP trong chương trình" value={v(stats && cmsVnd(stats.gmvVnd))} />
      <StatCard label="Dược sĩ có CMS" value={v(stats && (stats.pharmacistDenominator === null ? stats.pharmacistsWithCms : `${stats.pharmacistsWithCms}/${stats.pharmacistDenominator}`))}
        hint={stats && stats.pharmacistDenominator !== null ? 'Trên số dược sĩ hiện thuộc phạm vi' : undefined} />
      <StatCard label="Lượt đạt điều kiện" value={v(stats && `${stats.turnsAchieved}/${stats.turnsWithSales}`)} hint="Lượt = dược sĩ × SP đã bán đủ ≥ 1 đơn vị CMS" hintLines={2} />
    </div>
  )
}

/** Dòng cập nhật + trạng thái lần đồng bộ gần nhất (super thấy mã lỗi cố định để xử lý nguồn / mapping). */
export function CmsA3SyncLine({ header, isSuper }: { header: CmsResultHeaderDto; isSuper: boolean }) {
  const last = header.lastAttempt
  return (
    <div className="space-y-2">
      <p data-cms-synced className="text-[13px] text-muted-foreground">
        {header.run ? <>Số liệu cập nhật {cmsDateTime(header.run.publishedAt)} · tạm tính, chưa chốt kỳ · Xuất Excel: toàn chương trình trong phạm vi của bạn</> : <>Chưa có số liệu đã công bố</>}
      </p>
      {last && !last.isCurrent && (last.status === 'held' || last.status === 'error') && (
        <Notice tone="warning" role="status" title="Lần đồng bộ gần nhất chưa công bố">
          {header.run ? 'Đang giữ số liệu của lần công bố trước.' : 'Chưa có lần công bố nào.'}
          {isSuper && last.errorCode ? <> Mã: <code className="tabular-nums">{last.errorCode}</code>{last.finishedAt ? ` · ${cmsDateTime(last.finishedAt)}` : ''}.</> : null}
        </Notice>
      )}
      {header.run && header.configVersion !== header.run.configVersion && (
        <Notice tone="info" role="status" title="Danh mục đã đổi sau lần tính gần nhất">Số liệu theo danh mục cũ; sẽ cập nhật ở lượt đồng bộ tiếp theo.</Notice>
      )}
    </div>
  )
}

const TIER_FILL = ['bg-status-neutral v2:bg-v2-series-soft', 'bg-primary v2:bg-v2-series', 'bg-foreground v2:bg-v2-series-strong']

/** Thanh xếp chồng số đơn vị được tính CMS theo bậc (cộng từng dược sĩ). Lệch tiền snapshot ⇒ không vẽ (null). */
export function CmsTierDistribution({ dist, tiers, unit }: { dist: bigint[] | null; tiers: CmsUiTier[]; unit: string }) {
  if (!dist) return <span className="text-[12px] text-muted-foreground">—</span>
  const total = dist.reduce((s, x) => s + x, BigInt(0))
  const label = tiers.map((t, i) => `B${t.order}: ${dist[i].toString()}`).join(' · ') + ` ${unit}`
  if (total === BigInt(0)) return <span className="text-[12px] text-muted-foreground">{label}</span>
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span role="img" aria-label={label} className="flex h-[8px] w-full overflow-hidden rounded-full bg-muted">
        {dist.map((x, i) => x > BigInt(0) && (
          <span key={i} className={cn('h-full', TIER_FILL[i % TIER_FILL.length])} style={{ width: `${Number((x * BigInt(10000)) / total) / 100}%` }} />
        ))}
      </span>
      <span className="text-[12px] text-muted-foreground tabular-nums">{label}</span>
    </span>
  )
}

const dec = (v: string) => { const r = parseCmsDecimal(v, { allowNegative: true }); return r.ok ? r.units : BigInt(0) }

/** Cột kết quả của một SP trên tab Theo sản phẩm + bảng con theo dược sĩ (mở rộng). */
export function CmsA3ProductResult({ rows, catalog, users, tiers, unit, perUnit, storeNames }: {
  rows: CmsResultRowDto[]
  catalog: CmsCatalogRowDto[]
  users: CmsResultUserDto[]
  tiers: CmsUiTier[]
  unit: string
  perUnit: string
  storeNames: Map<string, string>
}) {
  // Cùng helper với QLCH / D3 / XLSX (PM P1-I3-1): người có bán = lượng cơ sở thuần > 0.
  const st = rows.length ? [...cmsProductSalesStats(rows).values()][0] : null
  const amount = st?.amountVnd ?? BigInt(0), base = st?.baseUnits ?? BigInt(0), gmv = st?.gmvUnits ?? BigInt(0)
  const sold = st?.staffWithSales ?? 0, achieved = st?.staffAchieved ?? 0
  const names = new Map(users.map((u) => [u.id, u.fullName]))
  const sorted = [...rows].sort((a, b) => (BigInt(a.amountVnd) === BigInt(b.amountVnd) ? (names.get(a.userId) ?? '').localeCompare(names.get(b.userId) ?? '', 'vi') : BigInt(a.amountVnd) > BigInt(b.amountVnd) ? -1 : 1))
  return (
    <div data-cms-product-result className="space-y-1.5 text-[13px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground">CMS tạm tính</span>
        <b className="tabular-nums">{cmsVnd(amount)}</b>
      </div>
      <p className="text-[12px] text-muted-foreground tabular-nums">
        SL {cmsQtyText(base, dec(perUnit))} {unit} · GMV {cmsVnd(cmsTruncVnd(gmv))} · {achieved}/{sold} dược sĩ đạt / có bán
      </p>
      <CmsTierDistribution dist={cmsProductTierDistribution(rows, tiers)} tiers={tiers} unit={unit} />
      {rows.length > 0 && (
        <details data-cms-product-staff className="group">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1 text-[12px] font-medium [&::-webkit-details-marker]:hidden">
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" /> Theo dược sĩ ({rows.length})
          </summary>
          <DataTableShell className="mt-1">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[12px]">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr className="whitespace-nowrap">
                  <th className="px-2.5 py-2 font-medium">Dược sĩ</th>
                  <th className="px-2.5 py-2 font-medium">Nhà thuốc</th>
                  <th className="px-2.5 py-2 text-right font-medium">SL</th>
                  <th className="px-2.5 py-2 font-medium">GMV / target</th>
                  <th className="px-2.5 py-2 font-medium">Bậc</th>
                  <th className="px-2.5 py-2 text-right font-medium">CMS</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const g = cmsGateView(r, catalog)
                  const pos = cmsTierPosition(BigInt(r.cmsQuantity), tiers)
                  return (
                    <tr key={r.userId} className="border-t align-middle">
                      <td className="px-2.5 py-2">{names.get(r.userId) ?? '—'}</td>
                      <td className="px-2.5 py-2 text-muted-foreground">{storeNames.get(r.storeId) ?? '—'}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums">{cmsQtyText(dec(r.baseQuantity), dec(r.perUnit))}</td>
                      <td className="px-2.5 py-2 min-w-[140px]">
                        {g ? <ProgressBar value={g.pct ?? 0} max={100} tone={g.met ? 'ok' : 'series'} size={5} ariaLabel={`GMV ${cmsVnd(g.gmvVnd)} trên ${cmsVnd(g.targetVnd)}`}
                          label={<span className="text-[11px] font-normal text-muted-foreground">{cmsVnd(g.gmvVnd)} / {cmsVnd(g.targetVnd)}</span>} /> : <span className="text-muted-foreground">Không target</span>}
                      </td>
                      <td className="px-2.5 py-2">
                        {g && !g.met ? <StatusBadge tone="neutral" size="sm">Chưa đạt target</StatusBadge>
                          : pos.index !== null ? <StatusBadge tone={pos.atCap ? 'info' : 'success'} size="sm">{pos.atCap ? 'Đã đạt trần' : `Bậc ${tiers[pos.index].order}`}</StatusBadge>
                            : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-2.5 py-2 text-right font-semibold tabular-nums">{cmsVnd(BigInt(r.amountVnd))}</td>
                    </tr>
                  )
                })}
                <tr className="border-t bg-muted/50 font-semibold">
                  <td className="px-2.5 py-2" colSpan={5}>Tổng</td>
                  <td className="px-2.5 py-2 text-right tabular-nums">{cmsVnd(amount)}</td>
                </tr>
              </tbody>
            </table>
            </div>
          </DataTableShell>
        </details>
      )}
    </div>
  )
}

export const CMS_A3_STAFF_PAGE = 50

/** Tab Theo dược sĩ: sắp CMS giảm dần, 50 dòng / trang (`?view=staff&page=`). */
export function CmsA3StaffTab({ rows, users, storeNames, page, pageHref, unassigned }: {
  rows: CmsResultRowDto[]
  users: CmsResultUserDto[]
  storeNames: Map<string, string>
  page: number
  pageHref: (page: number) => string
  /** Chỉ super (totals của run); null ⇒ không hiện khối. */
  unassigned: CmsUnassignedSummary | null
}) {
  const all: CmsStaffRowView[] = cmsStaffRows(rows, users)
  const pages = Math.max(1, Math.ceil(all.length / CMS_A3_STAFF_PAGE))
  const cur = Math.min(Math.max(1, page), pages)
  const slice = all.slice((cur - 1) * CMS_A3_STAFF_PAGE, cur * CMS_A3_STAFF_PAGE)
  return (
    <div className="space-y-3">
      {unassigned && unassigned.count > 0 && (
        <Notice tone="warning" title={`${unassigned.count} dòng đơn chưa map được người bán`}>
          <span data-cms-unassigned className="block space-y-0.5">
            {unassigned.gmvVnd !== null && <span className="block tabular-nums">GMV chưa gán: {cmsVnd(unassigned.gmvVnd)}</span>}
            {unassigned.reasons.map((r) => <span key={r.reason} className="block tabular-nums">{r.label}: {r.count}</span>)}
          </span>
        </Notice>
      )}
      {all.length === 0 ? (
        <EmptyState className="py-10 rounded-v2-panel border border-dashed border-input bg-card" icon={Users} title="Chưa có dược sĩ nào có dòng bán trong phạm vi" />
      ) : (
        <DataTableShell>
          <div className="overflow-x-auto">
            <table data-cms-staff-table className="w-full min-w-[820px] text-[13px]">
              <thead>
                <tr className="text-left whitespace-nowrap">
                  <th className="pl-4 pr-3 py-2.5">Dược sĩ</th>
                  <th className="px-3 py-2.5">Nhà thuốc hiện tại</th>
                  <th className="px-3 py-2.5 text-right">SP có bán</th>
                  <th className="px-3 py-2.5 text-right">SP đạt điều kiện</th>
                  <th className="px-3 py-2.5 text-right">Dòng đơn</th>
                  <th className="px-3 py-2.5 text-right">GMV</th>
                  <th className="pl-3 pr-4 py-2.5 text-right">CMS tạm tính</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((s) => (
                  <tr key={s.userId} data-cms-staff-row className="border-t align-middle">
                    <td className="pl-4 pr-3">{s.fullName ?? '—'}</td>
                    <td className="px-3 text-muted-foreground">{s.storeId ? storeNames.get(s.storeId) ?? '—' : '—'}</td>
                    <td className="px-3 text-right tabular-nums">{s.productsSold}</td>
                    <td className="px-3 text-right tabular-nums">{s.productsAchieved}</td>
                    <td className="px-3 text-right tabular-nums">{s.lineCount}</td>
                    <td className="px-3 text-right tabular-nums">{cmsVnd(s.gmvVnd)}</td>
                    <td className="pl-3 pr-4 text-right font-semibold tabular-nums">
                      {cmsVnd(s.amountVnd)} <StatusBadge tone="info" size="sm">Tạm tính</StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataTableShell>
      )}
      {pages > 1 && (
        <nav aria-label="Trang" className="flex items-center gap-2 text-[13px]">
          {cur > 1 && <Link href={pageHref(cur - 1)} className="inline-flex min-h-[44px] items-center rounded-v2-control border bg-card px-3">Trang trước</Link>}
          <span className="tabular-nums text-muted-foreground">Trang {cur}/{pages} · {all.length} dược sĩ</span>
          {cur < pages && <Link href={pageHref(cur + 1)} className="inline-flex min-h-[44px] items-center rounded-v2-control border bg-card px-3">Trang sau</Link>}
        </nav>
      )}
    </div>
  )
}

/** Khối "Nhóm theo danh mục": x / y dược sĩ có bán đã đạt target danh mục. */
export function CmsA3CatalogBlock({ catalog, target }: { catalog: CmsCatalogRowDto[]; target: string | null }) {
  const met = catalog.filter((k) => k.met).length
  return (
    <div data-cms-detail-catalog className="space-y-1.5 rounded-v2-panel border bg-card px-4 py-3 text-[13px]">
      <p className="font-semibold">Nhóm theo danh mục · target <span className="tabular-nums">{cmsVnd(target)}</span></p>
      <ProgressBar value={met} max={Math.max(1, catalog.length)} tone="ok" size={8} ariaLabel={`${met}/${catalog.length} dược sĩ có bán đã đạt target danh mục`}
        label={<span className="text-[13px] font-normal">{met}/{catalog.length} dược sĩ có bán đã đạt</span>} />
    </div>
  )
}
