'use client'

import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { TagBadge } from '@/components/ds/TagBadge'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { CmsProductImage } from '@/components/cms/CmsProductImage'
import { cn } from '@/lib/utils'
import { CMS_A3_STAFF_PREVIEW, type CmsA3ProductVM, type CmsA3StaffVM, type CmsProductDist } from '@/lib/cms/productPresentation'

// CMS-UI-1 (PM 04/11 §4.2–§4.4) · A3 tab "Theo sản phẩm". MỘT DOM, bảng ARIA (role table / row / cell) bố cục bằng CSS grid và
// container query theo CHIỀU RỘNG VÙNG NỘI DUNG (sidebar mở / thu tự đổi container — không theo viewport, không ResizeObserver):
//  · container ≥ 984px (= tổng bề rộng tối thiểu 8 cột + khoảng cách + lề): hàng SP 8 cột (Sản phẩm · Điều kiện · SL bán · GMV · Dược sĩ đạt/có bán · Phân bố lượng · CMS · Mở rộng);
//  · hẹp hơn: mỗi SP thành card (tên + CMS, điều kiện, 3 ô SL / GMV / dược sĩ, phân bố, nút full width "Xem N dược sĩ").
// Phần mở rộng là MỘT HÀNG RIÊNG chiếm toàn chiều ngang (không nằm trong ô CMS); bảng dược sĩ 5 cột theo container của chính phần
// mở rộng (≥ 820px = cột tối thiểu 714 + 4 khe + lề + viền, dư ~32px — UI1-P1-1), hẹp hơn thành danh sách. Chỉ trình bày view-model đã tính ở server (lib/cms/productPresentation) — không tính
// tiền ở client. Không có thanh cuộn ngang: không cột nào cần kéo để đọc tiền.

const TIER_FILL = ['bg-status-neutral v2:bg-v2-series-soft', 'bg-primary v2:bg-v2-series', 'bg-foreground v2:bg-v2-series-strong']
const STRIPES = { backgroundImage: 'repeating-linear-gradient(135deg, var(--muted-foreground) 0 2px, transparent 2px 5px)' }

/** Thanh phân bố lượng theo bậc + đoạn "Không tính CMS" (sọc). Chữ dưới thanh liệt kê ĐỦ mọi bậc (không chỉ dựa vào màu). */
export function CmsDistBar({ dist, unit }: { dist: CmsProductDist | null; unit: string }) {
  if (!dist) return <span data-cms-dist="unknown" className="text-[12px] text-muted-foreground">Chưa đủ dữ liệu giải thích</span>
  let tier = 0
  return (
    <span data-cms-dist className="flex min-w-0 flex-col gap-1">
      <span role="img" aria-label={dist.aria} className="flex h-[10px] w-full gap-[2px] overflow-hidden rounded-full bg-muted">
        {dist.segments.map((s) => {
          if (s.pct <= 0) { if (s.kind === 'tier') tier += 1; return null }
          const cls = s.kind === 'tier' ? TIER_FILL[(tier++) % TIER_FILL.length] : 'bg-muted'
          return <span key={s.key} data-cms-dist-seg={s.kind === 'tier' ? `B${s.order}` : 'excluded'} className={cn('h-full shrink-0', cls)} style={{ width: `${s.pct}%`, ...(s.kind === 'excluded' ? STRIPES : null) }} />
        })}
      </span>
      <span data-cms-dist-legend className="text-[12px] leading-snug text-muted-foreground tabular-nums break-words">{dist.legend} {unit}</span>
    </span>
  )
}

/** Chú giải màu (đặt cạnh tab): Bậc 1 / 2 / 3 · Không tính CMS (sọc). Thang > 3 bậc lặp màu — số từng bậc luôn ghi dưới thanh. */
export function CmsDistLegend() {
  return (
    <ul aria-label="Chú giải phân bố lượng" data-cms-dist-key className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
      {['Bậc 1', 'Bậc 2', 'Bậc 3'].map((t, i) => (
        <li key={t} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className={cn('h-[10px] w-[14px] rounded-[3px]', TIER_FILL[i])} />{t}</li>
      ))}
      <li className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-[10px] w-[14px] rounded-[3px] bg-muted" style={STRIPES} />Không tính CMS</li>
      <li>· &gt; 3 bậc: xem số dưới thanh</li>
    </ul>
  )
}

const LBL = 'text-[12px] text-muted-foreground'
// Lớp theo chế độ: card (mặc định) ⇄ hàng bảng (container ≥ 984px = tổng tối thiểu 8 cột + 7 khe + lề). Viết đủ tên lớp để Tailwind sinh CSS.
const ROW_RESULTS = 'grid grid-cols-6 gap-x-3 gap-y-2.5 p-3 @min-[984px]:grid-cols-[minmax(200px,2.4fr)_minmax(92px,1.1fr)_96px_116px_80px_minmax(160px,1.6fr)_116px_44px] @min-[984px]:items-center @min-[984px]:gap-x-2 @min-[984px]:gap-y-0 @min-[984px]:px-3 @min-[984px]:py-2.5'
const ROW_CATALOG = 'grid grid-cols-6 gap-x-3 gap-y-2.5 p-3 @min-[880px]:grid-cols-[minmax(220px,2fr)_minmax(140px,1.2fr)_minmax(220px,2.4fr)_minmax(150px,1fr)_44px] @min-[880px]:items-center @min-[880px]:gap-x-3 @min-[880px]:gap-y-0 @min-[880px]:px-3 @min-[880px]:py-2.5'
const HEAD_RESULTS = 'hidden @min-[984px]:grid grid-cols-[minmax(200px,2.4fr)_minmax(92px,1.1fr)_96px_116px_80px_minmax(160px,1.6fr)_116px_44px] gap-x-2 px-3 py-2'
const HEAD_CATALOG = 'hidden @min-[880px]:grid grid-cols-[minmax(220px,2fr)_minmax(140px,1.2fr)_minmax(220px,2.4fr)_minmax(150px,1fr)_44px] gap-x-3 px-3 py-2'

export function CmsA3ProductTable({ products, amountLabel, staffTabHref }: {
  products: CmsA3ProductVM[]
  /** "CMS tạm tính" / "CMS đã chốt" (theo trạng thái chương trình). */
  amountLabel: string
  /** Link tab Theo dược sĩ (không lọc SP — URL hiện không có tham số lọc). */
  staffTabHref?: string | null
}) {
  const results = products.some((p) => p.results !== null)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const head = results
    ? ['Sản phẩm', 'Điều kiện', 'SL bán', 'GMV', 'Đạt/có bán', 'Phân bố lượng', amountLabel, '']
    : ['Sản phẩm', 'Điều kiện', 'Thang CMS', 'Quy cách', '']
  return (
    // P2 PM 04/11: bề mặt bảng theo DS (DataTableShell — panel, viền, bo góc); bên trong là bảng ARIA grid (ngoại lệ có ghi ở
    // UI_V2_CMS §6 R3): tên truy cập 'Sản phẩm trong chương trình', nút mở là <button> (Tab / Enter / Space), không có vùng cuộn ngang.
    <DataTableShell>
      <div data-cms-products={results ? 'results' : 'catalog'} className="@container">
      <div role="table" aria-label="Sản phẩm trong chương trình">
        <div role="rowgroup" className="bg-muted text-[12px] font-medium text-muted-foreground">
          <div role="row" className={results ? HEAD_RESULTS : HEAD_CATALOG}>
            {head.map((h, i) => (
              <span key={i} role="columnheader" className={cn(results && i >= 2 && i <= 4 && 'text-right', results && i === 6 && 'text-right')}>
                {h === 'Đạt/có bán' ? <><span className="sr-only">Dược sĩ </span>{h}</> : h || <span className="sr-only">Mở rộng</span>}
              </span>
            ))}
          </div>
        </div>
        <div role="rowgroup" className="divide-y">
          {products.map((p) => (
            <ProductRows key={p.id} p={p} results={results} open={open.has(p.id)} onToggle={() => toggle(p.id)} amountLabel={amountLabel} staffTabHref={staffTabHref ?? null} />
          ))}
        </div>
      </div>
      </div>
    </DataTableShell>
  )
}

function ProductRows({ p, results, open, onToggle, amountLabel, staffTabHref }: {
  p: CmsA3ProductVM; results: boolean; open: boolean; onToggle: () => void; amountLabel: string; staffTabHref: string | null
}) {
  const expId = useId()
  const r = p.results
  const staffCount = r?.totals.count ?? 0
  const btnText = results ? (staffCount > 0 ? `Xem ${staffCount} dược sĩ` : 'Xem cấu hình') : 'Xem chi tiết'
  const product = (
    <span className="flex min-w-0 items-start gap-2.5">
      <CmsProductImage url={p.imageUrl} name={p.name} size={40} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span data-cms-product-name className="font-semibold leading-snug line-clamp-2 break-words">{p.name}</span>
        <span className="block text-[12px] text-muted-foreground tabular-nums">{p.productId} · tính theo {p.unit}</span>
        {p.addedAfterStart && <span><StatusBadge tone="info" size="sm">Bổ sung giữa kỳ</StatusBadge></span>}
      </span>
    </span>
  )
  const condition = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] @min-[984px]:flex-col @min-[984px]:items-start">
      <TagBadge hue={p.gateHue}>{p.gateLabel}</TagBadge>
      {p.targetText && <span className="text-muted-foreground tabular-nums">{p.targetText}</span>}
    </span>
  )
  const button = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? expId : undefined}
      onClick={onToggle}
      data-cms-expand={p.productId}
      className={cn(
        'inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-v2-control border bg-card px-3 text-[13px] font-medium',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring',
        results ? '@min-[984px]:h-[44px] @min-[984px]:w-[44px] @min-[984px]:border-0 @min-[984px]:px-0' : '@min-[880px]:h-[44px] @min-[880px]:w-[44px] @min-[880px]:border-0 @min-[880px]:px-0',
      )}
    >
      <span className={results ? '@min-[984px]:sr-only' : '@min-[880px]:sr-only'}>{open ? 'Thu gọn' : btnText}<span className="sr-only"> — {p.name}</span></span>
      <ChevronDown aria-hidden="true" className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} />
    </button>
  )
  return (
    <>
      {results ? (
        <div role="row" data-cms-product={p.productId} className={cn(ROW_RESULTS, 'text-[13px]')}>
          <span role="cell" className="order-1 col-span-4 @max-[340px]:col-span-6 @min-[984px]:order-none @min-[984px]:col-span-1">{product}</span>
          <span role="cell" className="order-3 col-span-6 @min-[984px]:order-none @min-[984px]:col-span-1">{condition}</span>
          <span role="cell" data-cms-sold className="order-4 col-span-2 @min-[984px]:order-none @min-[984px]:col-span-1 @min-[984px]:text-right">
            <span className={cn(LBL, 'block @min-[984px]:hidden')}>SL bán</span>
            {r ? <><span className="block font-semibold tabular-nums">{r.soldText} {p.unit}</span>{r.countedText && <span className="block text-[12px] text-muted-foreground tabular-nums">{r.countedText}</span>}</> : <span className="text-muted-foreground">—</span>}
          </span>
          <span role="cell" className="order-5 col-span-2 @min-[984px]:order-none @min-[984px]:col-span-1 @min-[984px]:text-right">
            <span className={cn(LBL, 'block @min-[984px]:hidden')}>GMV</span>
            <span className="block tabular-nums [overflow-wrap:anywhere]">{r ? r.gmvText : '—'}</span>
          </span>
          <span role="cell" className="order-6 col-span-2 @min-[984px]:order-none @min-[984px]:col-span-1 @min-[984px]:text-right">
            <span className={cn(LBL, 'block @min-[984px]:hidden')}>Đạt / có bán</span>
            <span className="block tabular-nums">{r ? `${r.staffAchieved}/${r.staffWithSales}` : '—'}</span>
          </span>
          <span role="cell" className="order-7 col-span-6 @min-[984px]:order-none @min-[984px]:col-span-1">
            {r ? (r.staffWithSales > 0 || r.dist ? <CmsDistBar dist={r.dist} unit={p.unit} /> : <span className="text-[12px] text-muted-foreground">Chưa có dòng bán</span>) : <span className="text-muted-foreground">—</span>}
          </span>
          <span role="cell" data-cms-product-amount className="order-2 col-span-2 text-right @max-[340px]:col-span-6 @max-[340px]:text-left @min-[984px]:order-none @min-[984px]:col-span-1">
            <span className={cn(LBL, 'block @min-[984px]:hidden')}>{amountLabel}</span>
            <b className={cn('block text-[15px] tabular-nums [overflow-wrap:anywhere] @min-[984px]:text-[14px]', r?.amountZero && 'font-semibold text-muted-foreground')}>{r ? r.amountText : '—'}</b>
          </span>
          <span role="cell" className="order-8 col-span-6 @min-[984px]:order-none @min-[984px]:col-span-1 @min-[984px]:flex @min-[984px]:justify-end">{button}</span>
        </div>
      ) : (
        <div role="row" data-cms-product={p.productId} className={cn(ROW_CATALOG, 'text-[13px]')}>
          <span role="cell" className="col-span-6 @min-[880px]:col-span-1">{product}</span>
          <span role="cell" className="col-span-6 @min-[880px]:col-span-1">{condition}</span>
          <span role="cell" className="col-span-6 @min-[880px]:col-span-1"><TierChips p={p} /></span>
          <span role="cell" className="col-span-6 text-[12px] text-muted-foreground @min-[880px]:col-span-1">
            <span className="block">{p.perUnitText}</span>
            {p.priceText && <span className="block tabular-nums">Giá tham khảo {p.priceText}</span>}
          </span>
          <span role="cell" className="col-span-6 @min-[880px]:col-span-1 @min-[880px]:flex @min-[880px]:justify-end">{button}</span>
        </div>
      )}
      {open && (
        <div role="row" id={expId} data-cms-product-expansion={p.productId} className="bg-muted/30 v2:bg-v2-canvas/40">
          <div role="cell" aria-colspan={results ? 8 : 5} className="@container block px-3 py-3 @min-[760px]:pl-[64px] @min-[760px]:pr-4">
            <Expansion p={p} staffTabHref={staffTabHref} amountLabel={amountLabel} />
          </div>
        </div>
      )}
    </>
  )
}

function TierChips({ p }: { p: CmsA3ProductVM }) {
  return (
    <ul aria-label="Thang CMS theo số lượng" className="flex flex-wrap gap-1.5">
      {p.tiers.map((t) => (
        <li key={t.order} data-cms-tier={t.order} className="inline-flex items-center gap-1 rounded-[6px] border bg-card px-2 py-1 text-[12px] leading-tight whitespace-nowrap">
          <span className="text-muted-foreground tabular-nums">{t.range}</span><span aria-hidden="true" className="text-muted-foreground">·</span><span className="font-semibold tabular-nums">{t.amountText}</span>
        </li>
      ))}
    </ul>
  )
}

function Expansion({ p, staffTabHref, amountLabel }: { p: CmsA3ProductVM; staffTabHref: string | null; amountLabel: string }) {
  const [advice, setAdvice] = useState(false)
  const [all, setAll] = useState(false)
  const adviceId = useId()
  const r = p.results
  const staff = r ? (all ? r.staff : r.staff.slice(0, CMS_A3_STAFF_PREVIEW)) : []
  return (
    <div className="space-y-3 text-[13px]">
      <p className="font-semibold leading-snug break-words">{p.name}</p>
      <div data-cms-config-strip className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-muted-foreground">
        <TierChips p={p} />
        {p.capText && <span data-cms-cap className="rounded-[6px] border border-dashed px-2 py-1 text-foreground">{p.capText}</span>}
        {p.targetText && <span className="tabular-nums">Target {p.targetText}</span>}
        <span>Quy đổi: {p.perUnitText}</span>
        {p.priceText && <span className="tabular-nums">Giá tham khảo {p.priceText}</span>}
        {p.addedAfterStart && <span data-cms-added>Bổ sung giữa kỳ · tính từ ngày bắt đầu chương trình</span>}
        <button type="button" aria-expanded={advice} aria-controls={advice ? adviceId : undefined} onClick={() => setAdvice((v) => !v)} data-cms-advice-toggle
          className="inline-flex min-h-[44px] items-center gap-1 font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring @min-[760px]:min-h-[36px]">
          {advice ? 'Ẩn nội dung tư vấn' : 'Nội dung tư vấn'}
          <ChevronDown aria-hidden="true" className={cn('h-3.5 w-3.5 transition-transform', advice && 'rotate-180')} />
        </button>
      </div>
      {advice && <p id={adviceId} data-cms-advice className="max-w-[72ch] whitespace-pre-line break-words rounded-v2-control border bg-card p-3 text-[13px] leading-relaxed">{p.advice}</p>}

      {r && (r.staff.length === 0 ? (
        <p className="text-muted-foreground">Chưa có dược sĩ nào có dòng bán SP này trong phạm vi.</p>
      ) : (
        <div data-cms-product-staff className="overflow-hidden rounded-v2-control border bg-card">
          <div role="table" aria-label={`Dược sĩ bán ${p.name}`}>
            <div role="rowgroup" className="hidden bg-muted text-[12px] font-medium text-muted-foreground @min-[820px]:block">
              <div role="row" className="grid grid-cols-[minmax(170px,1.8fr)_84px_minmax(190px,2fr)_minmax(150px,1.2fr)_120px] gap-x-3 px-3 py-2">
                <span role="columnheader">Dược sĩ · nhà thuốc</span><span role="columnheader" className="text-right">SL ({p.unit})</span>
                <span role="columnheader">GMV / điều kiện</span><span role="columnheader">Trạng thái</span><span role="columnheader" className="text-right">{amountLabel}</span>
              </div>
            </div>
            <div role="rowgroup" className="divide-y">
              {staff.map((s, i) => <StaffRow key={i} s={s} unit={p.unit} />)}
            </div>
            <div role="rowgroup" className="border-t bg-muted/60 font-semibold">
              <div role="row" data-cms-staff-total className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 py-2 @min-[820px]:grid-cols-[minmax(170px,1.8fr)_84px_minmax(190px,2fr)_minmax(150px,1.2fr)_120px]">
                <span role="cell">Tổng · {r.totals.count} dược sĩ</span>
                <span role="cell" className="hidden text-right tabular-nums @min-[820px]:block">{r.totals.soldText}</span>
                <span role="cell" className="hidden tabular-nums @min-[820px]:block">{r.totals.gmvText}</span>
                <span role="cell" className="hidden @min-[820px]:block" />
                <span role="cell" className="text-right tabular-nums">{r.totals.amountText}</span>
                <span role="cell" className="col-span-2 text-[12px] font-normal text-muted-foreground tabular-nums @min-[820px]:hidden">{r.totals.soldText} {p.unit} · GMV {r.totals.gmvText}</span>
              </div>
            </div>
          </div>
        </div>
      ))}

      {r && r.staff.length > CMS_A3_STAFF_PREVIEW && (
        <div className="flex flex-wrap items-center gap-3">
          <span data-cms-staff-shown className="text-[12px] text-muted-foreground tabular-nums">Đang hiện {staff.length}/{r.staff.length} dược sĩ · tổng tính trên cả {r.staff.length}</span>
          <button type="button" onClick={() => setAll((v) => !v)} data-cms-staff-more
            className="inline-flex min-h-[44px] items-center rounded-v2-control border bg-card px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {all ? 'Thu gọn' : `Xem thêm ${r.staff.length - CMS_A3_STAFF_PREVIEW} dược sĩ`}
          </button>
        </div>
      )}

      {r && r.staff.length > 0 && (
        <div data-cms-qty-reasons className="space-y-1 text-[12px] text-muted-foreground">
          {r.reasons === null ? <p>Chưa đủ dữ liệu giải thích phần không tính CMS — số tiền vẫn theo snapshot.</p>
            : r.reasons.length === 0 ? <p>Toàn bộ lượng bán đủ đơn vị đã được tính CMS.</p>
              : <p><span className="inline-block h-[10px] w-[14px] rounded-[3px] bg-muted align-middle" style={STRIPES} aria-hidden="true" /> Không tính CMS: {r.reasons.join(' · ')}.</p>}
          {staffTabHref && <p><a href={staffTabHref} className="inline-flex min-h-[44px] items-center font-medium text-foreground underline underline-offset-2 @min-[760px]:min-h-0">Xem tất cả dược sĩ ở tab Theo dược sĩ</a></p>}
        </div>
      )}
    </div>
  )
}

function StaffRow({ s, unit }: { s: CmsA3StaffVM; unit: string }) {
  const [full, setFull] = useState(false)
  const gate = s.gate ? (
    <span className="flex min-w-0 flex-col gap-1">
      {s.gate.pct !== null && <ProgressBar value={s.gate.pct} max={100} tone={s.gate.met ? 'ok' : 'series'} size={5} ariaLabel={`${s.gate.basis === 'catalog' ? 'GMV nhóm danh mục' : 'GMV sản phẩm'} ${s.gate.text}`} />}
      <span className="text-[12px] text-muted-foreground tabular-nums [overflow-wrap:anywhere]">{s.gate.text}{s.gate.shortText ? ` · ${s.gate.shortText}` : ''}</span>
    </span>
  ) : <span className="text-[12px] text-muted-foreground">Không target</span>
  return (
    <div role="row" data-cms-staff-line className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-3 py-2.5 @min-[820px]:grid-cols-[minmax(170px,1.8fr)_84px_minmax(190px,2fr)_minmax(150px,1.2fr)_120px] @min-[820px]:items-center @min-[820px]:gap-y-0">
      <span role="cell" className="min-w-0">
        <button type="button" aria-expanded={full} onClick={() => setFull((v) => !v)} data-cms-staff-name
          className="block w-full min-h-[44px] min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring @min-[820px]:min-h-[36px]">
          <span className={cn('block font-medium', full ? 'whitespace-normal break-words' : 'truncate')}>{s.name}</span>
          <span className={cn('block text-[12px] text-muted-foreground', full ? 'whitespace-normal break-words' : 'truncate')}>{s.store}</span>
        </button>
      </span>
      <span role="cell" data-cms-staff-qty className="order-last col-span-2 text-[12px] text-muted-foreground tabular-nums @min-[820px]:order-none @min-[820px]:col-span-1 @min-[820px]:text-right">
        <span className="hidden text-[13px] text-foreground @min-[820px]:block">{s.soldText}</span>
        {s.qtyNote && <span className="hidden @min-[820px]:block">{s.qtyNote}</span>}
        <span className="@min-[820px]:hidden">{[`${s.soldText} ${unit}`, s.qtyNote, `GMV ${s.gmvText}`].filter(Boolean).join(' · ')}</span>
      </span>
      <span role="cell" className="order-last col-span-2 @min-[820px]:order-none @min-[820px]:col-span-1">
        {s.gate?.basis !== 'product' && <span className="hidden tabular-nums @min-[820px]:block">{s.gmvText}</span>}
        {gate}
      </span>
      <span role="cell" className="order-last col-span-2 @min-[820px]:order-none @min-[820px]:col-span-1">
        <StatusBadge tone={s.status.tone} size="sm">{s.status.label}</StatusBadge>
      </span>
      <span role="cell" className={cn('row-start-1 col-start-2 text-right font-semibold tabular-nums @min-[820px]:row-auto @min-[820px]:col-auto', s.amountZero && 'text-muted-foreground')}>{s.amountText}</span>
    </div>
  )
}
