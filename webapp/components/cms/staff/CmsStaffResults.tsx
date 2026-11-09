import Link from 'next/link'
import { History } from 'lucide-react'
import { Notice } from '@/components/ds/Notice'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { cn } from '@/lib/utils'
import { cmsAmountPerUnit, cmsDateTime, cmsVnd } from '@/lib/cms/display'
import { cmsHistoryHref, cmsLoadState, CMS_SALES_ONLY_NOTE, type CmsCardFilter, type CmsGateView, type CmsNearGate, type CmsResultsLoad, type CmsStaffCard, type CmsStaffSummary, type CmsStoreSummary, type CmsUiTier } from '@/lib/cms/resultUi'
import { cmsNoRunText, cmsResultState, type CmsResultHeaderDto } from '@/lib/cms/resultView'
import type { CmsDisplayStatus } from '@/lib/cms/programStatus'
import { cmsStaffAmountTitle, cmsStaffUpdatedText } from '@/lib/cms/staffView'
import { cmsQtyExplainRow } from '@/lib/cms/productPresentation'
import { cmsNavHref, type CmsNav } from '@/lib/cms/fixtureNav'

// CMS P2-c (I3) · khối số liệu D1 / D2 (UI §4.1–§4.2; U12 / U13 / U18 / U19). Chỉ TRÌNH BÀY số từ view-model
// (lib/cms/resultUi) — không tự tính tiền. null / chưa có snapshot ⇒ '—', không 0 giả. Không render nhãn trả hàng / số âm
// (trả hàng Q-206 phase sau — chương trình thật có dòng âm bị held, không công bố). Dùng chung route thật + fixture /ui-catalog/cms-v2.
// P3a r2 (PM r1 PKG-P1-1): `display` của chương trình quyết nhãn — Đang chạy "tạm tính · chưa chốt kỳ", Chờ chốt kỳ "tạm
// tính · chờ chốt", Đã chốt "đã chốt" (số của run đóng băng).

/** Thông báo trạng thái dữ liệu: lỗi tải · run vừa đổi · lần cập nhật sau lỗi (giữ số cũ) · cấu hình đổi chờ tính lại. */
export function CmsResultsNotice({ results, reloadHref }: { results: CmsResultsLoad; reloadHref: string }) {
  if (results.kind === 'error') {
    return <Notice tone="danger" role="alert" title="Chưa tải được số liệu CMS">Danh mục vẫn hiển thị bên dưới. Thử tải lại trang.</Notice>
  }
  if (results.kind === 'gone') {
    return (
      <Notice tone="info" role="status" title="Số liệu vừa được cập nhật">
        <Link href={reloadHref} className="inline-flex min-h-[44px] items-center font-medium underline underline-offset-2">Tải lại để xem số mới</Link>
      </Notice>
    )
  }
  const st = cmsLoadState(results)
  if (st === 'held_old' && results.kind === 'loaded') {
    return (
      <Notice tone="warning" role="status" title="Lần cập nhật gần nhất chưa thành công">
        Đang hiện số liệu cập nhật lúc {cmsDateTime(results.header.run?.publishedAt)} — hệ thống sẽ thử lại ở lượt sau.
      </Notice>
    )
  }
  if (st === 'config_pending') {
    return <Notice tone="info" role="status" title="Danh mục vừa thay đổi">Số liệu bên dưới theo danh mục cũ; sẽ cập nhật ở lượt tính tiếp theo.</Notice>
  }
  return null
}

/** Ghi chú sales-only (PM 06/11 §4.3) — một dòng dưới số tiền hero; chỉ khi có snapshot đã công bố và chưa chốt. */
function SalesOnlyNote({ header, display, className }: { header: CmsResultHeaderDto; display: CmsDisplayStatus | null; className: string }) {
  return header.run && display !== 'locked' ? <p data-cms-sales-only className={className}>{CMS_SALES_ONLY_NOTE}</p> : null
}

function UpdatedLine({ header, display }: { header: CmsResultHeaderDto; display: CmsDisplayStatus | null }) {
  return header.run
    ? <span data-cms-updated={display ?? 'running'}>{cmsStaffUpdatedText(display, header.run.publishedAt)}</span>
    : <span data-cms-no-run={cmsResultState(header)}>{cmsNoRunText(header)}</span>
}

function Tile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-[8px] bg-card px-2.5 py-2">
      <p className="text-[11px] leading-tight text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[15px] font-bold tabular-nums leading-tight [overflow-wrap:anywhere]">{value}</p>
    </div>
  )
}

/** Hero staff "CMS tạm tính của bạn". CMS đơn giản S3 (PM r1 08/11 §6 — thay "thẻ đen" UI §4.1): nền selected nhạt `bg-accent`
 *  (v2 #FFF1EA / tối #2A1E17) + viền `border-v2-selected-line`, chữ `text-foreground`, nhãn `text-accent-foreground`; ô con `bg-card`. */
export function CmsStaffHero({ summary, header, programId, display = null, nav }: { summary: CmsStaffSummary | null; header: CmsResultHeaderDto; programId: string; display?: CmsDisplayStatus | null; nav?: CmsNav }) {
  const has = header.run !== null && summary !== null
  return (
    <section data-cms-hero={has ? 'ok' : 'none'} className="space-y-3 rounded-v2-panel border border-v2-selected-line bg-accent p-4 text-foreground">
      <div>
        <p data-cms-hero-title className="text-[13px] font-medium text-accent-foreground">{cmsStaffAmountTitle(display, 'own')}</p>
        <p data-cms-hero-amount className="text-[30px] font-bold leading-tight tabular-nums [overflow-wrap:anywhere]">{has ? cmsVnd(summary.amountVnd) : '—'}</p>
        <SalesOnlyNote header={header} display={display} className="text-[12px] text-muted-foreground" />
      </div>
      {/* Ô GMV rộng hơn (số tiền dài nhất) — số lớn không gãy giữa chữ số ở 360 / 390. */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)] gap-2">
        <Tile label="SP có CMS" value={has ? `${summary.productsWithCms}/${summary.productCount}` : '—'} />
        <Tile label="SP có bán" value={has ? summary.productsSold : '—'} />
        <Tile label="GMV" value={has ? cmsVnd(summary.gmvVnd) : '—'} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        <span><UpdatedLine header={header} display={display} /></span>
        {has && (
          <Link href={cmsNavHref(nav, cmsHistoryHref(programId))} className="inline-flex min-h-[44px] items-center gap-1 font-semibold text-foreground underline-offset-2 hover:underline">
            <History className="h-4 w-4" aria-hidden="true" /> Xem ghi nhận
          </Link>
        )}
      </div>
    </section>
  )
}

/** QLCH (U19): tổng nhà thuốc = cộng kết quả cá nhân của staff HIỆN thuộc nhà thuốc; không "của bạn", không gợi ý.
 *  CMS đơn giản S3: cùng kiểu nền selected nhạt + viền như hero staff; `simple` (mọi SP mức cố định) ⇒ bỏ câu "tính bậc riêng". */
export function CmsStoreHero({ summary, header, programId, display = null, simple = false, nav }: { summary: CmsStoreSummary | null; header: CmsResultHeaderDto; programId: string; display?: CmsDisplayStatus | null; simple?: boolean; nav?: CmsNav }) {
  const has = header.run !== null && summary !== null
  return (
    <section data-cms-store-hero={has ? 'ok' : 'none'} className="space-y-3 rounded-v2-panel border border-v2-selected-line bg-accent p-4 text-foreground">
      <div>
        <p data-cms-store-title className="text-[13px] font-medium text-accent-foreground">{cmsStaffAmountTitle(display, 'store')}</p>
        <p data-cms-store-amount className="text-[26px] font-bold leading-tight tabular-nums [overflow-wrap:anywhere]">{has ? cmsVnd(summary.amountVnd) : '—'}</p>
        <p data-cms-store-note className="text-[12px] text-muted-foreground">{simple ? 'Cộng CMS từng dược sĩ hiện thuộc nhà thuốc.' : 'Cộng CMS từng dược sĩ hiện thuộc nhà thuốc — mỗi người tính bậc riêng.'}</p>
        <SalesOnlyNote header={header} display={display} className="text-[12px] text-muted-foreground" />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)] gap-2 text-[12px]">
        {/* Mẫu số ở đây là dược sĩ CÓ BÁN (RPC chỉ trả người có dòng kết quả) — ghi rõ, không lẫn mẫu số Q-212 (mọi staff). */}
        <div className="rounded-[8px] bg-card px-2.5 py-2"><p className="text-muted-foreground">Dược sĩ có CMS</p><p className="text-[15px] font-bold tabular-nums">{has ? summary.staffWithCms : '—'}</p>{has && <p data-cms-store-staff-sales className="text-[11px] text-muted-foreground tabular-nums">/ {summary.staffWithSales} người có bán</p>}</div>
        <div className="rounded-[8px] bg-card px-2.5 py-2"><p className="text-muted-foreground">SP có CMS</p><p className="text-[15px] font-bold tabular-nums">{has ? `${summary.productsWithCms}/${summary.productCount}` : '—'}</p></div>
        <div className="rounded-[8px] bg-card px-2.5 py-2"><p className="text-muted-foreground">GMV</p><p className="text-[15px] font-bold tabular-nums">{has ? cmsVnd(summary.gmvVnd) : '—'}</p></div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        <span><UpdatedLine header={header} display={display} /></span>
        {has && (
          <Link href={cmsNavHref(nav, cmsHistoryHref(programId))} className="inline-flex min-h-[44px] items-center gap-1 font-semibold text-foreground underline-offset-2 hover:underline">
            <History className="h-4 w-4" aria-hidden="true" /> Xem ghi nhận
          </Link>
        )}
      </div>
    </section>
  )
}

/** "Gợi ý gần đạt" — chỉ staff; không có câu ước tính theo giá (snapshot không có đơn vị giá — U13). */
export function CmsNearGateCard({ near, productName, unit }: { near: CmsNearGate; productName: string; unit: string }) {
  return (
    <section data-cms-near-gate className="space-y-1 rounded-v2-panel border border-v2-selected-line bg-accent p-4 text-[13px]">
      <p className="font-semibold">Còn <span className="tabular-nums">{cmsVnd(near.shortVnd)}</span> GMV để mở CMS <span className="break-words">{productName}</span></p>
      {near.potentialVnd > BigInt(0) && (
        <p className="text-muted-foreground">Đạt target sẽ được tính CMS cho cả <span className="tabular-nums">{near.cmsQuantity.toString()}</span> {unit} đã bán, ước ≈ <b className="tabular-nums text-foreground">{cmsVnd(near.potentialVnd)}</b>.</p>
      )}
    </section>
  )
}

/** Thanh gate (product / catalog): GMV / target; "Đạt từ" chỉ khi đang đạt (Q-211); thiếu ⇒ còn thiếu.
 *  CMS-UI-1 (PM §6.6): nhãn và số GMV / target tự xuống hàng (số giữ nguyên một hàng) — không ép hai cột hẹp làm số gãy dòng. */
export function CmsGateMeter({ gate, label, size = 8 }: { gate: CmsGateView; label: string; size?: 5 | 8 }) {
  return (
    <div data-cms-gate={gate.met ? 'met' : 'unmet'} className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-[12px]">
        <span className="text-muted-foreground">{label}</span>
        <span data-cms-gate-value className="tabular-nums font-semibold whitespace-nowrap">{cmsVnd(gate.gmvVnd)} / {cmsVnd(gate.targetVnd)}</span>
      </div>
      {gate.pct !== null && (
        <ProgressBar value={gate.pct} max={100} tone={gate.met ? 'ok' : 'series'} size={size} ariaLabel={`${label}: ${cmsVnd(gate.gmvVnd)} trên ${cmsVnd(gate.targetVnd)}`} />
      )}
      <p className="text-[12px] text-muted-foreground">
        {gate.met
          ? (gate.metAt ? <>Đạt từ {cmsDateTime(gate.metAt).slice(0, 5)}</> : <>Đã đạt</>)
          : <>Còn thiếu <span className="tabular-nums">{cmsVnd(gate.shortVnd)}</span></>}
      </p>
    </div>
  )
}

/** Dòng bậc trên thẻ D1: "Bậc k · mức" + còn N lên bậc kế / bậc cao nhất / đạt trần / cần đạt target trước.
 *  `closed` (Chờ chốt kỳ / Đã chốt — P3a r2): chỉ kết quả đạt được, không gợi ý bán thêm. */
export function cmsCardTierText(card: CmsStaffCard, tiers: readonly CmsUiTier[], unit: string, closed = false): string {
  if (tiers.length === 0) return ''
  if (card.gate && !card.gate.met) return closed ? 'Chưa đạt target trong kỳ' : 'Cần đạt target trước'
  const pos = card.position
  const last = tiers[tiers.length - 1]
  if (pos.atCap) return `Đã đạt mức trần ${last.to} ${unit}`
  if (pos.index === null) return closed ? 'Chưa đạt bậc 1 trong kỳ' : pos.next ? `Bán ${pos.next.unitsToNext.toString()} ${unit} để có ${cmsAmountPerUnit(tiers[pos.next.index].amount, unit)}` : ''
  const cur = `Bậc ${tiers[pos.index].order} · ${cmsAmountPerUnit(tiers[pos.index].amount, unit)}`
  if (closed) return cur
  if (pos.next) return `${cur} · Còn ${pos.next.unitsToNext.toString()} ${unit} lên ${cmsAmountPerUnit(tiers[pos.next.index].amount, unit)}`
  // CMS-Q-220: bậc cuối không giới hạn ⇒ "Bậc cao nhất" (mỗi đơn vị đủ thêm vẫn cộng đúng mức bậc cuối). Hai nhánh trần (atCap ở
  // trên + "Tối đa" dưới đây) chỉ còn cho run LỊCH SỬ đã đóng băng có cấu hình cũ (Q-210a, đã bị thay) — cấu hình tính mới không có.
  if (last.to !== null) return `${cur} · Tối đa ${last.to} ${unit} · còn ${(BigInt(last.to) - card.cmsQuantity).toString()} ${unit}`
  return `${cur} · Bậc cao nhất`
}

/** "tính 12" khi lượng bán có phần lẻ / vượt trần (gate đã mở) — số nguyên được xét khác số đã bán. cms_unit: đã bán = số tính ⇒ null. */
export function cmsCardCountedNote(card: CmsStaffCard): string | null {
  if (!card.row || (card.gate && !card.gate.met) || card.quantityBasis === 'cms_unit') return null
  const e = cmsQtyExplainRow(card.row)
  if (!e || (e.fractionBase === BigInt(0) && e.overCap === BigInt(0))) return null
  return `tính ${e.rewarded.toString()}`
}

export function CmsCardFilterTabs({ filter, counts, href }: { filter: CmsCardFilter; counts: Record<CmsCardFilter, number>; href: (f: CmsCardFilter) => string }) {
  const items: { f: CmsCardFilter; label: string }[] = [{ f: 'all', label: 'Tất cả' }, { f: 'met', label: 'Có CMS' }, { f: 'unmet', label: 'Chưa có CMS' }]
  return (
    <nav aria-label="Lọc sản phẩm" data-cms-card-filter={filter} className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-v2-control bg-muted p-1">
      {items.map((x) => (
        <Link
          key={x.f}
          href={href(x.f)}
          scroll={false}
          aria-current={x.f === filter ? 'page' : undefined}
          className={cn('inline-flex min-h-[44px] items-center whitespace-nowrap rounded-[8px] px-3 text-[13px]',
            x.f === filter ? 'border border-input bg-card font-semibold text-foreground' : 'text-muted-foreground')}
        >
          {x.label} <span className="ml-1 tabular-nums">({counts[x.f]})</span>
        </Link>
      ))}
    </nav>
  )
}

export function CmsAmountBadge({ amount }: { amount: bigint }) {
  return <span className={cn('shrink-0 text-[15px] font-bold tabular-nums', amount === BigInt(0) && 'text-muted-foreground')}>{cmsVnd(amount)}</span>
}

