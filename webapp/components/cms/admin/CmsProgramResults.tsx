import Link from 'next/link'
import { Users } from 'lucide-react'
import { StatCard } from '@/components/ds/StatCard'
import { Notice } from '@/components/ds/Notice'
import { EmptyState } from '@/components/ds/EmptyState'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { cmsDateTime, cmsVnd } from '@/lib/cms/display'
import { cmsStaffRows, type CmsA3Stats, type CmsStaffRowView, type CmsUnassignedSummary } from '@/lib/cms/resultUi'
import type { CmsCatalogRowDto, CmsResultHeaderDto, CmsResultRowDto, CmsResultUserDto } from '@/lib/cms/resultView'
import type { CmsDisplayStatus } from '@/lib/cms/programStatus'

// CMS P2-c (I3) · khối kết quả A3 /targets/campaigns/cms/[id] (UI §3.3; U11 / U12 / U20; Q-212). Chỉ TRÌNH BÀY số đã cộng
// từ snapshot (lib/cms/resultUi) — mỗi dược sĩ đã áp gate / bậc riêng, tổng không áp lại bậc. Chưa có snapshot ⇒ '—'.
// CMS-UI-1: bảng "Theo sản phẩm" chuyển sang CmsA3ProductTable (lib/cms/productPresentation dùng cmsProductSalesStats); nhãn
// theo trạng thái chương trình (Đã chốt ⇒ "CMS đã chốt", không "tạm tính / chưa chốt kỳ"); số tiền không bị cắt (cỡ chữ theo
// độ rộng ô — container query, xuống dòng ở dấu chấm khi vẫn thiếu chỗ).

const MONEY = 'tabular-nums [overflow-wrap:anywhere] text-[length:clamp(20px,11cqi,30px)]'

export function CmsA3StatCards({ stats, display = 'running' }: { stats: CmsA3Stats | null; display?: CmsDisplayStatus }) {
  const v = (x: React.ReactNode, money = false) => <span className={money ? MONEY : 'tabular-nums'}>{stats ? x : '—'}</span>
  const locked = display === 'locked'
  return (
    <div data-cms-detail-results className="@container">
      <div className="grid grid-cols-1 gap-2.5 @min-[340px]:grid-cols-2 @min-[960px]:grid-cols-4">
        <StatCard className="@container" label={locked ? 'CMS đã chốt' : 'CMS tạm tính'} value={v(stats && cmsVnd(stats.amountVnd), true)} />
        <StatCard className="@container" label="GMV chương trình" value={v(stats && cmsVnd(stats.gmvVnd), true)} />
        <StatCard label="Dược sĩ có CMS" value={v(stats && (stats.pharmacistDenominator === null ? stats.pharmacistsWithCms : `${stats.pharmacistsWithCms}/${stats.pharmacistDenominator}`))}
          hint={stats && stats.pharmacistDenominator !== null ? `trên ${stats.pharmacistDenominator} dược sĩ hiện thuộc phạm vi` : undefined} hintLines={2} />
        <StatCard label="Lượt đạt điều kiện" value={v(stats && `${stats.turnsAchieved}/${stats.turnsWithSales}`)} hint="Lượt = dược sĩ × SP đã bán đủ ≥ 1 đơn vị CMS" hintLines={2} />
      </div>
    </div>
  )
}

/** Dòng cập nhật + trạng thái lần đồng bộ gần nhất (super thấy mã lỗi cố định để xử lý nguồn / mapping). */
export function CmsA3SyncLine({ header, isSuper, display = 'running' }: { header: CmsResultHeaderDto; isSuper: boolean; display?: CmsDisplayStatus }) {
  const last = header.lastAttempt
  const at = header.run ? cmsDateTime(header.run.publishedAt) : null
  return (
    <div className="space-y-2">
      <p data-cms-synced={display} className="text-[13px] text-muted-foreground">
        {!header.run ? <>Chưa có số liệu đã công bố</>
          : display === 'locked' ? <>Số đã chốt · theo lần tính {at} (không đổi sau chốt) · Xuất Excel: toàn chương trình trong phạm vi của bạn</>
            : display === 'waiting_close' ? <>Số liệu cập nhật {at} · tạm tính, chờ chốt kỳ · Xuất Excel: toàn chương trình trong phạm vi của bạn</>
              : <>Số liệu cập nhật {at} · tạm tính, chưa chốt kỳ · Xuất Excel: toàn chương trình trong phạm vi của bạn</>}
      </p>
      {display !== 'locked' && last && !last.isCurrent && (last.status === 'held' || last.status === 'error') && (
        <Notice tone="warning" role="status" title="Lần đồng bộ gần nhất chưa công bố">
          {header.run ? 'Đang giữ số liệu của lần công bố trước.' : 'Chưa có lần công bố nào.'}
          {isSuper && last.errorCode ? <> Mã: <code className="tabular-nums">{last.errorCode}</code>{last.finishedAt ? ` · ${cmsDateTime(last.finishedAt)}` : ''}.</> : null}
        </Notice>
      )}
      {display !== 'locked' && header.run && header.configVersion !== header.run.configVersion && (
        <Notice tone="info" role="status" title="Danh mục đã đổi sau lần tính gần nhất">Số liệu theo danh mục cũ; sẽ cập nhật ở lượt đồng bộ tiếp theo.</Notice>
      )}
    </div>
  )
}

export const CMS_A3_STAFF_PAGE = 50

/** Tab Theo dược sĩ: sắp CMS giảm dần, 50 dòng / trang (`?view=staff&page=`). */
export function CmsA3StaffTab({ rows, users, storeNames, page, pageHref, unassigned, amountLabel = 'CMS tạm tính' }: {
  rows: CmsResultRowDto[]
  users: CmsResultUserDto[]
  storeNames: Map<string, string>
  page: number
  pageHref: (page: number) => string
  /** Chỉ super (totals của run); null ⇒ không hiện khối. */
  unassigned: CmsUnassignedSummary | null
  /** "CMS tạm tính" / "CMS đã chốt" theo trạng thái chương trình (một nhãn ở đầu cột — không lặp badge từng hàng). */
  amountLabel?: string
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
                  <th className="pl-3 pr-4 py-2.5 text-right">{amountLabel}</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((s) => (
                  <tr key={s.userId} data-cms-staff-row className="border-t align-middle">
                    <td className="pl-4 pr-3"><span className="block max-w-[260px] break-words">{s.fullName ?? '—'}</span></td>
                    <td className="px-3 text-muted-foreground"><span className="block max-w-[260px] break-words">{s.storeId ? storeNames.get(s.storeId) ?? '—' : '—'}</span></td>
                    <td className="px-3 text-right tabular-nums">{s.productsSold}</td>
                    <td className="px-3 text-right tabular-nums">{s.productsAchieved}</td>
                    <td className="px-3 text-right tabular-nums">{s.lineCount}</td>
                    <td className="px-3 text-right tabular-nums">{cmsVnd(s.gmvVnd)}</td>
                    <td className="pl-3 pr-4 text-right font-semibold tabular-nums">
                      {cmsVnd(s.amountVnd)}
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
