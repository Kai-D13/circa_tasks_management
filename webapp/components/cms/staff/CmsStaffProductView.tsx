import Link from 'next/link'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { TagBadge } from '@/components/ds/TagBadge'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { CmsProductImage } from '@/components/cms/CmsProductImage'
import { CmsCopyButton } from '@/components/cms/staff/CmsCopyButton'
import { CmsGateMeter, CmsResultsNotice } from '@/components/cms/staff/CmsStaffResults'
import { CmsWhatIf } from '@/components/cms/staff/CmsWhatIf'
import { cn } from '@/lib/utils'
import { CMS_GATE_HUE, CMS_GATE_LABEL, cmsAmountPerUnit, cmsBaseQtyLine, cmsDate, cmsDateRange, cmsDateTime, cmsPrice, cmsTierRange, cmsVnd } from '@/lib/cms/display'
import { CMS_STATUS_LABEL, CMS_STATUS_TONE, cmsDisplayStatus } from '@/lib/cms/programStatus'
import { cmsIsClosedDisplay, cmsProductHref, cmsStaffAmountTitle, cmsStaffHref, cmsStaffUpdatedText } from '@/lib/cms/staffView'
import {
  cmsHistoryHref, cmsLineView, cmsProductTotals, cmsQtyText, cmsStaffCard, cmsStaffRows, cmsTierBreakdown, type CmsResultsLoad,
} from '@/lib/cms/resultUi'
import type { CmsResultLineDto } from '@/lib/cms/resultView'
import type { CmsStaffProduct } from '@/lib/cms/server/staffCatalog'
import { cmsQtyExplainRow } from '@/lib/cms/productPresentation'
import { cmsNavHref, type CmsNav } from '@/lib/cms/fixtureNav'

// CMS P1-d · D2 `/targets/cms/products/[programProductId]` (UI §4.2; r2 U1 / U19). P1 CHỈ: ảnh, tên, ProductID · giá ·
// chương trình, điều kiện cấu hình (ẩn khi không target), thang chính sách `đ/unit_CMS`, quy cách, tư vấn ĐẦY ĐỦ (text
// thuần `pre-line`, không cắt — PM P1-c §4) + Sao chép. Dùng chung route thật + fixture /ui-catalog/cms-v2/product.
// P2-c (I3): `results` (mặc định 'off' ⇒ P1 nguyên trạng). Staff: CMS tạm tính + chia theo bậc (chỉ khi khớp tiền
// snapshot), số lượng thực tế / nguyên hưởng CMS / phần cộng dồn, gate + "Đạt từ", bậc hiện tại, "Nếu bán thêm" (client,
// cùng hàm bậc engine), 3 ghi nhận gần nhất. QLCH (U19): tổng SP của nhà thuốc + theo dược sĩ, không "Nếu bán thêm".
// P3a r2 (PM r1 PKG-P1-1): Chờ chốt kỳ / Đã chốt vẫn mở — nhãn theo trạng thái (Đã chốt = run đóng băng), không "Nếu bán thêm",
// thang bậc chỉ ghi kết quả đạt được.

export function CmsStaffProductView({ data, today, results = { kind: 'off' }, manager = false, recent = null, returnsApproved = false, nav }: {
  data: CmsStaffProduct
  today: string
  results?: CmsResultsLoad
  manager?: boolean
  /** 3 dòng gần nhất của SP (staff) — chỉ khi đã đọc ĐỦ mọi dòng của SP (≤ 500); null ⇒ không liệt kê (chưa tải / > 500 dòng ⇒ chỉ link D3,
   *  không trình bày phần đầu như "gần nhất" — PM I3 §5). */
  recent?: CmsResultLineDto[] | null
  returnsApproved?: boolean
  /** Fixture: điều hướng trong /ui-catalog (route thật bỏ trống). */
  nav?: CmsNav
}) {
  const { program, product: p } = data
  const display = cmsDisplayStatus(program, today)
  const closed = cmsIsClosedDisplay(display)
  const loaded = results.kind === 'loaded' ? results : null
  const withNumbers = loaded !== null && loaded.header.run !== null
  const rows = loaded ? loaded.rows.results.filter((r) => r.programProductId === p.id) : []
  const card = withNumbers && !manager
    ? cmsStaffCard({ programProductId: p.id, perUnit: p.baseQuantityCms, tiers: p.tiers, row: rows[0] ?? null, catalog: loaded.rows.catalog })
    : null
  const gateOpen = card ? !card.gate || card.gate.met : true
  const expected = card?.row ? (gateOpen ? BigInt(card.row.amountVnd) : BigInt(card.row.potentialAmount)) : BigInt(0)
  const slices = card ? cmsTierBreakdown(card.cmsQuantity, p.tiers, expected) : null
  const storeTot = withNumbers && manager ? cmsProductTotals(rows, new Map([[p.id, p.baseQuantityCms]])).get(p.id) ?? null : null
  const storeStaff = withNumbers && manager ? cmsStaffRows(rows, loaded.rows.users) : []
  const tierUnitsDone = (i: number) => (slices ? slices[i].units : BigInt(0))
  const qty = card?.row ? cmsQtyExplainRow(card.row) : null

  return (
    <div data-ui-v2="page" data-layout-width="centered" data-cms-staff-product-detail={p.gmvBasis} data-cms-results={results.kind} className="mx-auto max-w-2xl p-4 space-y-4 v2:space-y-3">
      <Link href={cmsNavHref(nav, cmsStaffHref(program.id))} className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> CMS sản phẩm
      </Link>

      <div className="flex justify-center rounded-v2-panel bg-muted p-3">
        <CmsProductImage url={p.imageUrlSnapshot} name={p.nameSnapshot} size={180} />
      </div>

      <div className="space-y-1.5">
        <h1 className="text-[20px] font-bold leading-snug break-words">{p.nameSnapshot}</h1>
        <p className="text-[13px] text-muted-foreground break-words">
          <span className="tabular-nums">{p.productId}</span>
          {p.priceSnapshot ? <> · <span className="tabular-nums">{cmsPrice(p.priceSnapshot)}</span></> : null}
          {' · '}{program.name}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          <StatusBadge tone={CMS_STATUS_TONE[display]} size="sm">{CMS_STATUS_LABEL[display]}</StatusBadge>
          <span className="tabular-nums">{display === 'upcoming' ? `Bắt đầu ${cmsDate(program.startDate)}` : cmsDateRange(program.startDate, program.endDate)}</span>
        </div>
      </div>

      <CmsResultsNotice results={results} reloadHref={cmsNavHref(nav, cmsProductHref(p.id))} />

      {loaded && !manager && (
        <section data-cms-product-amount={card?.tone ?? 'none'} className="space-y-2 rounded-v2-panel border bg-card p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[14px] font-semibold" data-cms-product-title>{gateOpen ? cmsStaffAmountTitle(display, 'product') : closed ? 'Chưa đạt target trong kỳ' : 'CMS khi đạt target'}</h2>
            <b data-cms-product-cms className="text-[22px] tabular-nums">{card ? cmsVnd(expected) : '—'}</b>
          </div>
          {card ? (
            <>
              <p className="text-[13px] text-muted-foreground tabular-nums" data-cms-qty-line>
                Đã bán {card.soldText} {p.unitCms} · {gateOpen ? <>được tính CMS {(qty?.rewarded ?? card.cmsQuantity).toString()} {p.unitCms}</> : <>chưa tính CMS {card.cmsQuantity.toString()} {p.unitCms} (chờ đạt target)</>}
              </p>
              {qty && (qty.overCap > BigInt(0) || qty.fractionBase > BigInt(0)) && (
                <ul data-cms-qty-explain className="space-y-0.5 text-[12px] text-muted-foreground tabular-nums">
                  {qty.overCap > BigInt(0) && <li>Vượt trần {qty.cap?.toString()} {p.unitCms}: {qty.overCap.toString()} {p.unitCms} không thêm CMS (vẫn tính vào số đã bán).</li>}
                  {qty.fractionBase > BigInt(0) && <li>Phần lẻ {cmsQtyText(qty.fractionBase, qty.perUnit)} {p.unitCms} chưa đủ 1 {p.unitCms} — đang cộng dồn ({card.fraction}).</li>}
                </ul>
              )}
              {card.position.atCap && !(qty && qty.overCap > BigInt(0)) && <p className="text-[12px] text-muted-foreground">Đã đạt mức trần {p.tiers[p.tiers.length - 1]?.to} {p.unitCms} — bán thêm không thêm CMS.</p>}
              {slices && card.cmsQuantity > BigInt(0) && (
                <ul data-cms-tier-breakdown className="space-y-1 border-t pt-2 text-[13px]">
                  {slices.filter((s) => s.units > BigInt(0)).map((s) => (
                    <li key={s.order} className="flex justify-between gap-3 tabular-nums">
                      <span className="text-muted-foreground">Bậc {s.order} · {s.units.toString()} {p.unitCms} × {cmsVnd(s.amount)}</span>
                      <span>{cmsVnd(s.amountVnd)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[12px] text-muted-foreground" data-cms-updated={display}>{cmsStaffUpdatedText(display, loaded.header.run?.publishedAt)}</p>
            </>
          ) : (
            <p className="text-[13px] text-muted-foreground">Chưa có số liệu — hệ thống chưa tính lần nào.</p>
          )}
        </section>
      )}

      {loaded && manager && (
        <section data-cms-store-product className="space-y-2 rounded-v2-panel border bg-card p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[14px] font-semibold" data-cms-store-title>{cmsStaffAmountTitle(display, 'store')}</h2>
            <b className="text-[22px] tabular-nums">{storeTot ? cmsVnd(storeTot.amountVnd) : '—'}</b>
          </div>
          {storeTot ? (
            <>
              <p className="text-[13px] text-muted-foreground tabular-nums">Đã bán {storeTot.soldText} {p.unitCms} · {storeTot.staffAchieved}/{storeTot.staffWithSales} dược sĩ có bán đã có CMS</p>
              {storeStaff.length > 0 && (
                <ul data-cms-store-staff className="divide-y border-t text-[13px]">
                  {storeStaff.map((s) => (
                    <li key={s.userId} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0 truncate">{s.fullName ?? '—'}</span>
                      <span className="shrink-0 tabular-nums font-semibold">{cmsVnd(s.amountVnd)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[12px] text-muted-foreground" data-cms-updated={display}>Mỗi dược sĩ tính bậc riêng · {cmsStaffUpdatedText(display, loaded.header.run?.publishedAt)}</p>
            </>
          ) : (
            <p className="text-[13px] text-muted-foreground">Chưa có số liệu — hệ thống chưa tính lần nào.</p>
          )}
        </section>
      )}

      {p.gmvBasis !== 'none' && (
        <section data-cms-staff-gate className="space-y-1.5 rounded-v2-panel border bg-card p-4">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold">
            Điều kiện <TagBadge hue={CMS_GATE_HUE[p.gmvBasis]}>{CMS_GATE_LABEL[p.gmvBasis]}</TagBadge>
          </h2>
          {p.gmvBasis === 'product'
            ? <p className="text-[13px]">Mỗi dược sĩ có GMV sản phẩm này trong kỳ đạt <b className="tabular-nums">{cmsVnd(p.targetGmv)}</b> thì CMS được tính cho toàn bộ số lượng dược sĩ đó đã bán trong kỳ.</p>
            : <p className="text-[13px]">Mỗi dược sĩ có tổng GMV các sản phẩm trong nhóm danh mục đạt <b className="tabular-nums">{cmsVnd(program.catalogTargetGmv)}</b> thì CMS được tính cho toàn bộ số lượng dược sĩ đó đã bán trong kỳ.</p>}
          {card?.gate && <CmsGateMeter gate={card.gate} label={p.gmvBasis === 'product' ? 'GMV sản phẩm của bạn' : 'GMV nhóm danh mục của bạn'} />}
        </section>
      )}

      <section data-cms-staff-tiers className="space-y-2 rounded-v2-panel border bg-card p-4">
        <h2 className="text-[14px] font-semibold">Thang CMS theo số lượng</h2>
        {p.tiers.length === 1 ? (
          <p className="text-[13px]">CMS <b className="tabular-nums">{cmsAmountPerUnit(p.tiers[0].amount, p.unitCms)}</b>{p.tiers[0].to !== null ? <> · tối đa {p.tiers[0].to} {p.unitCms}</> : null}</p>
        ) : (
          <ol className="space-y-1.5">
            {p.tiers.map((t, i) => {
              const current = card !== null && card.position.index === i
              const done = card !== null && card.position.index !== null && i < card.position.index
              const span = t.to === null ? null : t.to - t.from + 1
              return (
                <li key={t.order} data-cms-staff-tier={t.order} data-cms-tier-state={card ? (current ? 'current' : done ? 'done' : 'ahead') : undefined}
                  className={cn('space-y-1 rounded-[8px] border px-3 py-2 text-[13px]', current && 'border-primary bg-accent')}>
                  <span className="flex items-center justify-between gap-3">
                    <span><span className="text-muted-foreground">Bậc {t.order} · </span><span className="tabular-nums">{cmsTierRange(t.from, t.to)} {p.unitCms}</span></span>
                    <b className="tabular-nums">{cmsAmountPerUnit(t.amount, p.unitCms)}</b>
                  </span>
                  {card && (
                    <span className="block text-[12px] text-muted-foreground tabular-nums">
                      {done ? 'Đã hoàn thành'
                        : current ? `Bạn đang ở đây · ${tierUnitsDone(i).toString()}${span !== null ? `/${span}` : ''} ${p.unitCms}`
                          : closed ? 'Chưa tới bậc này trong kỳ' : `Còn ${(BigInt(t.from) - card.cmsQuantity).toString()} ${p.unitCms} để lên bậc này`}
                    </span>
                  )}
                  {card && current && span !== null && slices && (
                    <ProgressBar value={Number(tierUnitsDone(i))} max={span} tone="series" size={5} ariaLabel={`Tiến độ bậc ${t.order}`} />
                  )}
                </li>
              )
            })}
          </ol>
        )}
        <p className="text-[12px] text-muted-foreground">Lũy tiến: mỗi {p.unitCms} tính theo bậc nó rơi vào. {cmsBaseQtyLine(p.unitCms, p.baseQuantityCms)}.</p>
      </section>

      {card?.row && !card.position.atCap && display === 'running' && (
        <CmsWhatIf
          baseQuantity={card.row.baseQuantity}
          perUnit={card.row.perUnit}
          tiers={p.tiers}
          unit={p.unitCms}
          gateMet={gateOpen}
          defaultExtra={card.position.next ? Number(card.position.next.unitsToNext) : 1}
        />
      )}

      <section data-cms-staff-advice className="space-y-2 rounded-v2-panel border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold">
            Nội dung tư vấn <StatusBadge tone="success" size="sm"><ShieldCheck className="mr-0.5 inline h-3 w-3" aria-hidden="true" />Đã kiểm duyệt</StatusBadge>
          </h2>
          <CmsCopyButton text={p.adviceText} />
        </div>
        <p className="whitespace-pre-line break-words text-[14px] leading-relaxed">{p.adviceText}</p>
      </section>

      {withNumbers && !manager && (
        <section data-cms-recent className="space-y-2 rounded-v2-panel border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold">Ghi nhận gần đây</h2>
            <Link href={cmsNavHref(nav, cmsHistoryHref(program.id, p.id))} className="inline-flex min-h-[44px] items-center text-[13px] font-medium underline-offset-2 hover:underline">Xem tất cả</Link>
          </div>
          {recent && recent.length > 0 ? (
            <ul className="divide-y text-[13px]">
              {recent.map((l) => {
                const v = cmsLineView(l, p.baseQuantityCms, p.unitCms, returnsApproved)
                return (
                  <li key={l.seq} data-cms-line={l.status} className="flex items-start justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block tabular-nums">Đơn #{l.orderCode} · {cmsDateTime(l.completedAt)}</span>
                      <span className="block text-[12px] text-muted-foreground tabular-nums">{v.qtyText} {p.unitCms}{v.note ? ` · ${v.note}` : ''}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <StatusBadge tone={v.tone} size="sm">{v.label}</StatusBadge>
                      <span className="mt-0.5 block font-semibold tabular-nums">{v.amountVnd === null ? '—' : cmsVnd(v.amountVnd)}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">{recent === null && (card?.row?.lineCount ?? 0) > 0 ? 'Nhiều dòng đơn — xem đầy đủ và mới nhất ở trang ghi nhận.' : 'Chưa có dòng đơn nào được tính.'}</p>
          )}
        </section>
      )}
    </div>
  )
}
