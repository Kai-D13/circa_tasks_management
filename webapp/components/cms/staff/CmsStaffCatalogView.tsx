import Link from 'next/link'
import { Boxes, ChevronRight, Store } from 'lucide-react'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { TagBadge } from '@/components/ds/TagBadge'
import { CmsProductImage } from '@/components/cms/CmsProductImage'
import { CmsTargetsSegment } from '@/components/cms/staff/CmsTargetsSegment'
import { CmsProgramPicker } from '@/components/cms/staff/CmsProgramPicker'
import {
  CmsAmountBadge, CmsCardFilterTabs, CmsGateMeter, CmsNearGateCard, CmsResultsNotice, CmsStaffHero, CmsStoreHero, cmsCardCountedNote, cmsCardTierText,
} from '@/components/cms/staff/CmsStaffResults'
import { CMS_GATE_HUE, CMS_GATE_LABEL, cmsDate, cmsVnd } from '@/lib/cms/display'
import { cmsDaysLeft, cmsDisplayStatus } from '@/lib/cms/programStatus'
import { cmsIsClosedDisplay, cmsProductHref, cmsStaffHref, cmsTierSummary } from '@/lib/cms/staffView'
import {
  CMS_UNIT_RULE_NOTE, cmsCardMatches, cmsCatalogGateView, cmsNearestGate, cmsProductTotals, cmsScreenBasis, cmsSoldPhrase, cmsStaffCard,
  cmsStaffSummary, cmsStoreSummary, type CmsCardFilter, type CmsResultsLoad,
} from '@/lib/cms/resultUi'
import { cmsRowsBasis, cmsRunUnitOf, type CmsResultRowDto } from '@/lib/cms/resultView'
import type { CmsProductView, CmsProgramRowView } from '@/lib/cms/server/catalog'
import { cmsNavHref, type CmsNav } from '@/lib/cms/fixtureNav'
import { cmsFlatRate, cmsFlatRateText, cmsIsSimpleProgram } from '@/lib/cms/flat'

// CMS P1-d · D1 `/targets?tab=cms` (UI §4.1; r2 U1 / U9 / U19; H5). Staff + QLCH xem DANH MỤC chương trình Sắp diễn ra /
// Đang chạy của nhà thuốc hiện tại: SP, loại điều kiện, target cấu hình, thang `đ/unit_CMS`. Dùng chung route thật +
// fixture /ui-catalog/cms-v2/staff.
// P2-c (I3): `results` (mặc định 'off' ⇒ giữ NGUYÊN giao diện P1, không số) — khi cờ CMS_EARNINGS_ENABLED bật và chương
// trình đã bắt đầu: staff có hero "CMS tạm tính của bạn", gợi ý gần đạt, target danh mục, số liệu trên thẻ + bộ lọc;
// QLCH (U19) có khối tổng nhà thuốc, không hero cá nhân / gợi ý. Chưa có snapshot ⇒ '—' (không 0 giả); lỗi ⇒ thông báo,
// danh mục vẫn hiện.
// P3a r2 (PM r1 PKG-P1-1): bộ chọn có nhóm "Đã kết thúc" (Chờ chốt kỳ / Đã chốt); chương trình đã kết thúc vẫn xem được số
// (Đã chốt = run đóng băng, nhãn "đã chốt"), không gợi ý gần đạt / gợi ý bán thêm.
// CMS đơn giản S3 (PM r1 08/11 §6): SP mức cố định (cmsFlatRate — 1 bậc từ 1 không giới hạn, không target) ⇒ thẻ "Mức CMS X₫/hộp",
// "Đã bán N hộp · tính Q hộp" + tổng CMS; không badge "Theo số lượng", không dòng bậc / "Bậc cao nhất". SP có bậc / target giữ nguyên.
// CMS-UNIT (spec PM 09/11 §4): số trên thẻ theo cơ sở của RUN ("Đã bán N hộp đúng ĐV" — Q, không B / K / phần lẻ); câu nhắc "Chỉ tính
// đơn bán đúng ĐV tính CMS" theo cơ sở màn (run, hoặc cấu hình chương trình khi chưa có run / cờ kết quả tắt).

export type CmsStaffKind = 'ok' | 'empty' | 'error' | 'no-store'

export function CmsStaffCatalogView({ kind, programs, selected, products, today, manager, kpiTab, results = { kind: 'off' }, filter = 'all', nav }: {
  kind: CmsStaffKind
  programs: CmsProgramRowView[]
  selected: CmsProgramRowView | null
  products: CmsProductView[]
  today: string
  manager: boolean
  /** Có tab KPI để quay lại không. QLCH + cờ KPI campaign OFF ⇒ `/targets` chuyển về /tasks ⇒ false: không segmented. */
  kpiTab: boolean
  results?: CmsResultsLoad
  filter?: CmsCardFilter
  /** Fixture: điều hướng trong /ui-catalog (route thật bỏ trống). */
  nav?: CmsNav
}) {
  const display = selected ? cmsDisplayStatus(selected, today) : null
  const left = selected ? cmsDaysLeft(selected, today) : null
  const closed = cmsIsClosedDisplay(display)
  const catalog = products.filter((p) => p.gmvBasis === 'catalog')

  // ── P2: số liệu (chỉ khi đã tải được và có snapshot đã công bố) ──
  const loaded = results.kind === 'loaded' ? results : null
  const withNumbers = loaded !== null && loaded.header.run !== null
  const rows = loaded ? loaded.rows.results : []
  const byPp = new Map<string, CmsResultRowDto[]>()
  for (const r of rows) { const l = byPp.get(r.programProductId); if (l) l.push(r); else byPp.set(r.programProductId, [r]) }
  const runBasis = loaded ? cmsRowsBasis(loaded.rows) : 'pos_base'
  const screenBasis = cmsScreenBasis(results, selected?.quantityBasis)
  const unitOf = (p: CmsProductView) => cmsRunUnitOf(loaded?.rows, p.id, p.unitCms)
  const cards = withNumbers && !manager
    ? new Map(products.map((p) => [p.id, cmsStaffCard({ programProductId: p.id, perUnit: p.baseQuantityCms, tiers: p.tiers, row: byPp.get(p.id)?.[0] ?? null, catalog: loaded.rows.catalog, basis: runBasis })]))
    : null
  const totals = withNumbers && manager ? cmsProductTotals(rows, new Map(products.map((p) => [p.id, p.baseQuantityCms])), runBasis) : null
  const counts = { all: products.length, met: 0, unmet: 0 }
  if (cards) for (const c of cards.values()) { if (cmsCardMatches(c, 'met')) counts.met += 1; else counts.unmet += 1 }
  const visible = cards ? products.filter((p) => cmsCardMatches(cards.get(p.id)!, filter)) : products
  const near = cards && display === 'running' ? cmsNearestGate(rows) : null
  const nearProduct = near ? products.find((p) => p.id === near.programProductId) : undefined
  const ownCatalog = withNumbers && !manager && loaded.rows.catalog.length > 0 ? cmsCatalogGateView(loaded.rows.catalog[0]) : null
  const storeCatalog = withNumbers && manager ? loaded.rows.catalog : null
  const hrefFor = (f: CmsCardFilter) => cmsNavHref(nav, `${cmsStaffHref(selected?.id)}${f === 'all' ? '' : `&f=${f}`}`)

  return (
    <div data-ui-v2="page" data-layout-width="centered" data-cms-staff={kind} data-cms-results={results.kind} className="mx-auto max-w-2xl p-4 space-y-4 v2:space-y-3">
      <div className="space-y-3">
        <h1 className="text-[20px] font-bold leading-tight">{kpiTab ? 'Mục tiêu' : 'CMS sản phẩm'}</h1>
        {kpiTab && <CmsTargetsSegment active="cms" nav={nav} />}
      </div>

      {kind === 'error' ? (
        <ErrorState message="Không tải được danh mục CMS" hint="Thử tải lại trang." />
      ) : kind === 'no-store' ? (
        <EmptyState className="py-12 rounded-v2-panel border border-dashed border-input bg-card" icon={Store} title="Tài khoản chưa được gán nhà thuốc" hint="Liên hệ quản lý để được gán nhà thuốc." />
      ) : kind === 'empty' || !selected ? (
        <EmptyState className="py-12 rounded-v2-panel border border-dashed border-input bg-card" icon={Boxes} title="Hiện chưa có chương trình CMS cho nhà thuốc của bạn" />
      ) : (
        <>
          <CmsProgramPicker programs={programs} selectedId={selected.id} today={today} nav={nav} />
          <p data-cms-staff-note className="text-[13px] text-muted-foreground">
            {display === 'upcoming'
              ? <>Chương trình bắt đầu {cmsDate(selected.startDate)} — xem trước danh mục để chuẩn bị tư vấn.</>
              : display === 'locked'
                ? <>Đã chốt kỳ — số bên dưới là số đã chốt (không đổi sau chốt).</>
                : display === 'waiting_close'
                  ? <>Đã kết thúc ngày {cmsDate(selected.endDate)} — số tạm tính, chờ chốt kỳ.</>
                  : <>{left !== null ? `Còn ${left} ngày. ` : ''}CMS tính theo số lượng từng dược sĩ bán trong kỳ.</>}
            {screenBasis === 'cms_unit' && <span data-cms-unit-rule> {CMS_UNIT_RULE_NOTE} — bán theo đơn vị khác (vd. viên, vỉ) không được quy đổi.</span>}
            {manager && !loaded && ' Tài khoản cửa hàng chỉ xem danh mục.'}
          </p>

          <CmsResultsNotice results={results} reloadHref={cmsNavHref(nav, cmsStaffHref(selected.id))} />
          {loaded && !manager && <CmsStaffHero summary={withNumbers ? cmsStaffSummary(rows, products.length) : null} header={loaded.header} programId={selected.id} display={display} nav={nav} />}
          {loaded && manager && <CmsStoreHero summary={withNumbers ? cmsStoreSummary(rows, products.length) : null} header={loaded.header} programId={selected.id} display={display} simple={cmsIsSimpleProgram(products)} nav={nav} />}
          {near && nearProduct && <CmsNearGateCard near={near} productName={nearProduct.nameSnapshot} unit={nearProduct.unitCms} />}

          {catalog.length > 0 && (
            <div data-cms-staff-catalog-target className="space-y-2 rounded-v2-panel border bg-card px-4 py-3 text-[13px]">
              <p className="font-semibold">Target GMV toàn danh mục: <span className="tabular-nums">{cmsVnd(selected.catalogTargetGmv)}</span></p>
              {ownCatalog ? (
                <CmsGateMeter gate={ownCatalog} label="GMV nhóm danh mục của bạn" />
              ) : storeCatalog && storeCatalog.length > 0 ? (
                <p data-cms-store-catalog className="tabular-nums">{storeCatalog.filter((k) => k.met).length} / {storeCatalog.length} dược sĩ có bán đã đạt target danh mục</p>
              ) : null}
              <p className="text-muted-foreground break-words">Cộng GMV {catalog.length} sản phẩm trong nhóm danh mục{withNumbers ? `: ${catalog.map((p) => p.nameSnapshot).join(', ')}` : ''}.</p>
            </div>
          )}

          {cards && products.length > 0 && <CmsCardFilterTabs filter={filter} counts={counts} href={hrefFor} />}

          {products.length === 0 ? (
            <EmptyState className="py-10 rounded-v2-panel border border-dashed border-input bg-card" icon={Boxes} title="Chương trình chưa có sản phẩm" />
          ) : visible.length === 0 ? (
            <EmptyState className="py-10 rounded-v2-panel border border-dashed border-input bg-card" icon={Boxes} title={filter === 'met' ? 'Chưa có sản phẩm nào có CMS' : 'Mọi sản phẩm đều đã có CMS'} />
          ) : (
            <ul data-cms-staff-products className="space-y-2.5">
              {visible.map((p) => {
                const card = cards?.get(p.id) ?? null
                const tot = totals?.get(p.id) ?? null
                const rate = cmsFlatRate(p)
                return (
                  <li key={p.id}>
                    <Link href={cmsNavHref(nav, cmsProductHref(p.id))} data-cms-staff-product={p.productId} data-cms-card-tone={card?.tone} data-cms-flat={rate ? '' : undefined} className="flex min-h-[44px] gap-3 rounded-v2-panel border bg-card p-3">
                      <CmsProductImage url={p.imageUrlSnapshot} name={p.nameSnapshot} size={48} />
                      <div className="min-w-0 flex-1 space-y-1">
                        <span className="flex items-start justify-between gap-2">
                          <span className="font-semibold leading-snug line-clamp-2 break-words">{p.nameSnapshot}</span>
                          {card && <CmsAmountBadge amount={card.amountVnd} />}
                          {tot && <CmsAmountBadge amount={tot.amountVnd} />}
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                          {!rate && <TagBadge hue={CMS_GATE_HUE[p.gmvBasis]}>{CMS_GATE_LABEL[p.gmvBasis]}</TagBadge>}
                          {card && rate && <span className="tabular-nums" data-cms-sold>{cmsSoldPhrase(card.soldText, unitOf(p), card.quantityBasis)}{card.row && card.quantityBasis !== 'cms_unit' ? ` · tính ${card.cmsQuantity.toLocaleString('vi-VN')} ${unitOf(p)}` : ''}</span>}
                          {card && !rate && <span className="tabular-nums" data-cms-sold>{cmsSoldPhrase(card.soldText, unitOf(p), card.quantityBasis)}{cmsCardCountedNote(card) ? ` (${cmsCardCountedNote(card)})` : ''}</span>}
                          {tot && <span className="tabular-nums" data-cms-sold>{cmsSoldPhrase(tot.soldText, unitOf(p), tot.quantityBasis)} · {tot.staffWithSales} dược sĩ</span>}
                          {!card && !tot && p.gmvBasis === 'product' && <span className="tabular-nums">Target {cmsVnd(p.targetGmv)}</span>}
                          {!card && !tot && p.gmvBasis === 'catalog' && <span>Theo target danh mục</span>}
                        </span>
                        {card?.gate && card.gate.basis === 'product' && <CmsGateMeter gate={card.gate} label="GMV / target" size={5} />}
                        {rate ? (
                          <span data-cms-flat-rate className="block w-fit max-w-full rounded-[6px] bg-muted px-2 py-1 text-[12px] font-semibold leading-snug tabular-nums break-words">
                            {cmsFlatRateText(rate, p.unitCms)}
                          </span>
                        ) : (
                          <span data-cms-tier-line className="block rounded-[6px] bg-muted px-2 py-1 text-[12px] leading-snug tabular-nums break-words">
                            {card ? cmsCardTierText(card, p.tiers, p.unitCms, closed) || cmsTierSummary(p.tiers, p.unitCms) : cmsTierSummary(p.tiers, p.unitCms)}
                          </span>
                        )}
                      </div>
                      <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 self-center text-muted-foreground" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
