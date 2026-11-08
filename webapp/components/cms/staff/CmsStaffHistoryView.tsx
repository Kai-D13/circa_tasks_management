import Link from 'next/link'
import { ArrowLeft, ListX } from 'lucide-react'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { Notice } from '@/components/ds/Notice'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { CmsResultsNotice } from '@/components/cms/staff/CmsStaffResults'
import { cn } from '@/lib/utils'
import { cmsDateTime, cmsVnd } from '@/lib/cms/display'
import { CMS_STATUS_LABEL, CMS_STATUS_TONE, cmsDisplayStatus } from '@/lib/cms/programStatus'
import { cmsStaffHref } from '@/lib/cms/staffView'
import {
  CMS_HISTORY_MAX_N, cmsHistoryMore, cmsHistoryUrl, cmsLineView, cmsProductTotals, cmsStaffCard, cmsStaffSummary, cmsStoreSummary,
  type CmsHistoryParams, type CmsResultsLoad,
} from '@/lib/cms/resultUi'
import { CMS_NO_RUN_TEXT, cmsNoRunText, type CmsResultLineDto } from '@/lib/cms/resultView'
import type { CmsProductView, CmsProgramRowView } from '@/lib/cms/server/catalog'
import { cmsNavHref, type CmsNav } from '@/lib/cms/fixtureNav'
import { cmsIsFlatProduct } from '@/lib/cms/flat'

// CMS P2-c (I3) · D3 `/targets/cms/history?program=&product=` (UI §4.3; U12 / U14 / U18; kế hoạch PM §6.1). Staff xem dòng của
// mình, QLCH xem dòng của staff hiện thuộc nhà thuốc (RPC 122 lọc). Dòng đọc từ cms_result_lines của run ĐÃ GHIM (`run=` trong
// URL); run hiện hành đổi giữa các trang ⇒ báo "dữ liệu đã thay đổi", không nối hai phiên. Thứ tự = seq của engine (ổn định),
// 20 dòng / lần. Tiền dòng lấy nguyên từ snapshot — không tự tính lại. P3a r2 (PM r1 PKG-P1-1): chương trình Đã chốt vẫn ở danh
// sách — dòng / tổng của run ĐÓNG BĂNG (cùng số đã chốt), ghi chú "Đã chốt kỳ".

export type CmsHistoryLines =
  | { kind: 'ok'; rows: CmsResultLineDto[]; nextAfterSeq: number | null }
  | { kind: 'error' }
  | { kind: 'stale' }
  | { kind: 'none' }

const SEG = 'inline-flex min-h-[44px] items-center whitespace-nowrap rounded-[8px] px-3 text-[13px]'

export function CmsStaffHistoryView({ programs, selected, products, results, lines, params, manager, today, returnsApproved, userNames, nav }: {
  programs: CmsProgramRowView[]
  selected: CmsProgramRowView | null
  products: CmsProductView[] | null
  results: CmsResultsLoad
  lines: CmsHistoryLines
  params: CmsHistoryParams
  manager: boolean
  today: string
  returnsApproved: boolean
  /** QLCH: tên dược sĩ theo id (từ rows của cùng run). */
  userNames: Map<string, string>
  /** Fixture: điều hướng trong /ui-catalog (route thật bỏ trống). */
  nav?: CmsNav
}) {
  const loaded = results.kind === 'loaded' ? results : null
  const run = loaded?.header.run ?? null
  const byId = new Map((products ?? []).map((p) => [p.id, p]))
  const rows = loaded ? loaded.rows.results : []
  const scoped = params.productId ? rows.filter((r) => r.programProductId === params.productId) : rows
  const display = selected ? cmsDisplayStatus(selected, today) : null
  const recent = programs.slice(0, 3)
  const others = programs.slice(3)
  const effects = products && run
    ? (manager
      ? [...cmsProductTotals(rows, new Map(products.map((p) => [p.id, p.baseQuantityCms]))).entries()].map(([id, t]) => ({ id, amount: t.amountVnd, note: `${t.soldText} ${byId.get(id)?.unitCms ?? ''} · ${t.staffWithSales} dược sĩ` }))
      : products.map((p) => {
        const c = cmsStaffCard({ programProductId: p.id, perUnit: p.baseQuantityCms, tiers: p.tiers, row: rows.find((r) => r.programProductId === p.id) ?? null, catalog: loaded!.rows.catalog })
        // CMS đơn giản (PM r1 §6): SP mức cố định không có "bậc".
        const tier = c.position.index !== null && !cmsIsFlatProduct(p) ? ` · bậc ${p.tiers[c.position.index].order}` : ''
        return { id: p.id, amount: c.amountVnd, note: c.gate && !c.gate.met ? `${c.soldText} ${p.unitCms} · chưa đạt target` : `${c.soldText} ${p.unitCms}${tier}` }
      })).filter((e) => byId.has(e.id)).sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1))
    : []
  const maxEffect = effects.reduce((m, e) => (e.amount > m ? e.amount : m), BigInt(0))
  const moreHref = lines.kind === 'ok' && run ? cmsHistoryMore({ ...params, programId: selected?.id ?? null, run: run.id }, lines.nextAfterSeq) : null

  return (
    <div data-ui-v2="page" data-layout-width="centered" data-cms-history={lines.kind} className="mx-auto max-w-2xl p-4 space-y-4 v2:space-y-3">
      <Link href={cmsNavHref(nav, cmsStaffHref(selected?.id))} className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> CMS sản phẩm
      </Link>
      <h1 className="text-[20px] font-bold leading-tight">Ghi nhận CMS</h1>

      {programs.length === 0 || !selected ? (
        <EmptyState className="py-12 rounded-v2-panel border border-dashed border-input bg-card" icon={ListX} title="Chưa có chương trình CMS nào đang tính" />
      ) : (
        <>
          <nav aria-label="Chương trình" className="flex max-w-full flex-wrap gap-1 rounded-v2-control border bg-card p-1">
            {recent.map((p) => (
              <Link key={p.id} href={cmsNavHref(nav, cmsHistoryUrl({ programId: p.id }))} aria-current={p.id === selected.id ? 'page' : undefined}
                className={cn(SEG, 'max-w-full', p.id === selected.id ? 'bg-primary font-semibold text-primary-foreground' : 'font-medium text-foreground hover:bg-muted')}>
                <span className="truncate">{p.name}</span>
              </Link>
            ))}
            {others.length > 0 && (
              <details className="relative">
                <summary className={cn(SEG, 'cursor-pointer list-none font-medium text-foreground hover:bg-muted [&::-webkit-details-marker]:hidden')}>Khác ({others.length})</summary>
                <ul className="mt-1 space-y-1 rounded-v2-panel border bg-card p-1">
                  {others.map((p) => (
                    <li key={p.id}><Link href={cmsNavHref(nav, cmsHistoryUrl({ programId: p.id }))} className={cn(SEG, 'w-full')}><span className="truncate">{p.name}</span></Link></li>
                  ))}
                </ul>
              </details>
            )}
          </nav>

          <CmsResultsNotice results={results} reloadHref={cmsNavHref(nav, cmsHistoryUrl({ programId: selected.id, productId: params.productId }))} />

          {loaded && (
            <section data-cms-history-total className="space-y-3 rounded-v2-panel border bg-card p-4">
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                <span className="min-w-0 truncate">{selected.name}</span>
                {display && <StatusBadge tone={CMS_STATUS_TONE[display]} size="sm">{CMS_STATUS_LABEL[display]}</StatusBadge>}
              </div>
              <p className="text-[28px] font-bold leading-tight tabular-nums" data-cms-history-amount>
                {run ? cmsVnd((manager ? cmsStoreSummary(scoped, 0) : cmsStaffSummary(scoped, 0)).amountVnd) : '—'}
              </p>
              <div className="grid grid-cols-3 gap-2 text-[12px]">
                <div className="rounded-[8px] bg-muted px-2.5 py-2"><p className="text-muted-foreground">Dòng đơn được tính</p><p className="text-[15px] font-bold tabular-nums">{run ? scoped.reduce((s, r) => s + r.lineCount, 0) : '—'}</p></div>
                <div className="rounded-[8px] bg-muted px-2.5 py-2"><p className="text-muted-foreground">SP đã bán</p><p className="text-[15px] font-bold tabular-nums">{run ? cmsStaffSummary(scoped, 0).productsSold : '—'}</p></div>
                <div className="rounded-[8px] bg-muted px-2.5 py-2"><p className="text-muted-foreground">GMV</p><p className="text-[15px] font-bold tabular-nums">{run ? cmsVnd(cmsStaffSummary(scoped, 0).gmvVnd) : '—'}</p></div>
              </div>
              <p className="text-[12px] text-muted-foreground">
                {run
                  ? <span data-cms-history-note={display ?? 'running'}>{display === 'locked' ? `Đã chốt kỳ — số đã chốt, theo lần tính ${cmsDateTime(run.publishedAt)} (không đổi sau chốt).` : <>{display === 'waiting_close' ? 'Chờ chốt kỳ — số tạm tính, có thể đổi khi chốt.' : 'Tạm tính — chưa chốt kỳ.'} Cập nhật {cmsDateTime(run.publishedAt)}.</>}</span>
                  : loaded ? `${cmsNoRunText(loaded.header)}.` : `${CMS_NO_RUN_TEXT}.`}
              </p>
            </section>
          )}

          {effects.length > 0 && !params.productId && (
            <section data-cms-history-effects className="space-y-2 rounded-v2-panel border bg-card p-4">
              <h2 className="text-[14px] font-semibold">Hiệu quả tư vấn theo sản phẩm</h2>
              <ul className="space-y-2.5">
                {effects.map((e) => (
                  <li key={e.id} className="space-y-1">
                    <Link href={cmsNavHref(nav, cmsHistoryUrl({ programId: selected.id, productId: e.id }))} className="flex min-h-[44px] items-center justify-between gap-3 text-[13px]">
                      <span className="min-w-0 line-clamp-2 break-words font-medium">{byId.get(e.id)?.nameSnapshot}</span>
                      <span className={cn('shrink-0 font-semibold tabular-nums', e.amount === BigInt(0) && 'text-muted-foreground')}>{cmsVnd(e.amount)}</span>
                    </Link>
                    {maxEffect > BigInt(0) && <ProgressBar value={Number((e.amount * BigInt(1000)) / maxEffect)} max={1000} tone="series" size={5} ariaLabel={`CMS ${byId.get(e.id)?.nameSnapshot ?? ''} so với sản phẩm cao nhất`} />}
                    <p className="text-[12px] text-muted-foreground tabular-nums">{e.note}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {params.productId && byId.has(params.productId) && (
            <Notice tone="neutral" title={`Đang lọc: ${byId.get(params.productId)!.nameSnapshot}`}>
              <Link href={cmsNavHref(nav, cmsHistoryUrl({ programId: selected.id }))} className="inline-flex min-h-[44px] items-center font-medium underline underline-offset-2">Xem mọi sản phẩm</Link>
            </Notice>
          )}

          {products === null ? (
            <ErrorState message="Không tải được danh mục chương trình" hint="Thử tải lại trang." />
          ) : lines.kind === 'stale' ? (
            <Notice tone="info" role="status" title="Dữ liệu đã thay đổi">
              Có lượt cập nhật mới trong lúc bạn xem.{' '}
              <Link href={cmsNavHref(nav, cmsHistoryUrl({ programId: selected.id, productId: params.productId }))} className="inline-flex min-h-[44px] items-center font-medium underline underline-offset-2">Tải lại từ đầu</Link>
            </Notice>
          ) : lines.kind === 'error' ? (
            <ErrorState message="Không tải được dòng ghi nhận" hint="Thử tải lại trang." />
          ) : lines.kind === 'ok' ? (
            <section data-cms-history-lines className="space-y-2">
              <h2 className="text-[14px] font-semibold">Dòng đơn được tính{params.after !== null ? ' (tiếp)' : ''}</h2>
              {lines.rows.length === 0 ? (
                <EmptyState className="py-10 rounded-v2-panel border border-dashed border-input bg-card" icon={ListX} title="Chưa có dòng đơn nào được tính" />
              ) : (
                <ul className="space-y-2">
                  {lines.rows.map((l) => {
                    const p = byId.get(l.programProductId)
                    const unit = p?.unitCms ?? ''
                    const v = cmsLineView(l, p?.baseQuantityCms ?? '1', unit, returnsApproved)
                    return (
                      <li key={l.seq} data-cms-line={l.status} className="flex items-start justify-between gap-3 rounded-v2-panel border bg-card p-3 text-[13px]">
                        <span className="min-w-0 space-y-0.5">
                          <span className="block font-medium leading-snug break-words">{p?.nameSnapshot ?? l.productId} × <span className="tabular-nums">{v.qtyText}</span> {unit}</span>
                          <span className="block text-[12px] text-muted-foreground tabular-nums">Đơn #{l.orderCode} · {cmsDateTime(l.completedAt)}</span>
                          {manager && <span className="block text-[12px] text-muted-foreground">{userNames.get(l.userId) ?? '—'}</span>}
                          {v.note && <span className="block text-[12px] text-muted-foreground">{v.note}</span>}
                        </span>
                        <span className="shrink-0 space-y-1 text-right">
                          <StatusBadge tone={v.tone} size="sm">{v.label}</StatusBadge>
                          <span className={cn('block font-semibold tabular-nums', v.amountVnd === BigInt(0) && 'text-muted-foreground')}>{v.amountVnd === null ? '—' : cmsVnd(v.amountVnd)}</span>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                {moreHref && <Link href={cmsNavHref(nav, moreHref)} scroll={false} data-cms-history-more className="inline-flex min-h-[44px] items-center rounded-v2-control border bg-card px-4 text-[13px] font-semibold">{params.n >= CMS_HISTORY_MAX_N ? 'Xem 20 dòng tiếp' : 'Xem thêm 20 dòng'}</Link>}
                {params.after !== null && run && (
                  <Link href={cmsNavHref(nav, cmsHistoryUrl({ programId: selected.id, productId: params.productId, run: run.id }))} className="inline-flex min-h-[44px] items-center px-2 text-[13px] text-muted-foreground underline-offset-2 hover:underline">Về đầu danh sách</Link>
                )}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
