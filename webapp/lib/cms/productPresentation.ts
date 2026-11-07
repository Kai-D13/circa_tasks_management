// CMS-UI-1 (PM 04/11 §5) — view-model GIẢI THÍCH số lượng + bảng "Theo sản phẩm" A3. Hàm thuần, không IO, không tính lại tiền:
// chỉ đọc snapshot (cms_results qua RPC 122) — baseQuantity B, perUnit K, cmsQuantity Q, rewardedQuantity, capQuantity, gateMet,
// amountVnd — rồi tách lượng bán thành: được CMS · chưa đạt gate · vượt trần · phần lẻ. Không đổi computeCmsProgram / công thức tiền.
//
// Với một dược sĩ × SP (B ≥ 0, K > 0, snapshot nhất quán): C = min(Q, trần) (trần null ⇒ C = Q); F = B − Q×K.
//   được CMS = gateMet ? C : 0 · chưa đạt gate = gateMet ? 0 : Q · vượt trần = gateMet ? Q − C : 0 · phần lẻ = F (đơn vị cơ sở).
// Thứ tự này không tính chồng chưa đạt gate và vượt trần. Đối soát BigInt: ΣB = (Σđược + Σchưa đạt + Σvượt trần)×K + ΣF khi K chung
// (không floor sau khi cộng nhiều người). K khác nhau / số âm / snapshot bất nhất ⇒ null ("chưa đủ dữ liệu giải thích"), tiền vẫn
// lấy snapshot. Chưa có Q-206 ⇒ không suy lý do trả hàng.
import { CMS_GATE_HUE, CMS_GATE_LABEL, cmsAmountPerUnit, cmsBaseQtyLine, cmsTierRange, cmsVnd, type CmsGmvBasis } from './display'
import type { TagHue } from '@/components/ds/TagBadge'
import type { StatusTone } from '@/components/ds/StatusBadge'
import { parseCmsDecimal } from './decimal'
import { cmsGateView, cmsHasSales, cmsProductSalesStats, cmsProductTierDistribution, cmsQtyText, cmsTierPosition, cmsTruncVnd, type CmsUiTier } from './resultUi'
import type { CmsCatalogRowDto, CmsResultRowDto, CmsResultUserDto } from './resultView'

const ZERO = BigInt(0)
const dec = (v: string): bigint | null => { const r = parseCmsDecimal(v, { allowNegative: true }); return r.ok ? r.units : null }
const big = (v: string): bigint | null => (/^-?[0-9]+$/.test(v) ? BigInt(v) : null)

// ── Giải thích lượng ────────────────────────────────────────────────────────
export interface CmsQtyExplain {
  /** K (scale 9) chung của các dòng. */
  perUnit: bigint
  /** ΣB (scale 9, đơn vị cơ sở). */
  baseUnits: bigint
  /** Σ đơn vị CMS nguyên được tính tiền (gate đạt, trong trần). */
  rewarded: bigint
  /** Σ Q của người chưa đạt gate (chưa được tính). */
  unmetGate: bigint
  /** Σ (Q − C) của người đã đạt gate nhưng vượt trần. */
  overCap: bigint
  /** Σ phần lẻ chưa đủ 1 đơn vị CMS (scale 9, đơn vị cơ sở). */
  fractionBase: bigint
  unmetStaff: number
  overCapStaff: number
  fractionStaff: number
  /** Trần chung (đơn vị CMS) khi mọi dòng cùng trần; null = không trần / khác nhau. */
  cap: bigint | null
}

/** Một dòng kết quả ⇒ phần tách; null khi dữ liệu âm / bất nhất (không bịa breakdown). */
export function cmsQtyExplainRow(r: Pick<CmsResultRowDto, 'baseQuantity' | 'perUnit' | 'cmsQuantity' | 'rewardedQuantity' | 'capQuantity' | 'gateMet'>): CmsQtyExplain | null {
  const b = dec(r.baseQuantity), k = dec(r.perUnit), q = big(r.cmsQuantity), rq = big(r.rewardedQuantity)
  const cap = r.capQuantity === null ? null : big(r.capQuantity)
  if (b === null || k === null || q === null || rq === null || (r.capQuantity !== null && cap === null)) return null
  if (b < ZERO || k <= ZERO || q < ZERO || (cap !== null && cap < ZERO)) return null
  if (q !== b / k) return null // Q = floor(B / K) (B ≥ 0)
  const c = cap === null || q < cap ? q : cap
  if (rq !== c) return null
  const f = b - q * k
  return {
    perUnit: k, baseUnits: b, rewarded: r.gateMet ? c : ZERO, unmetGate: r.gateMet ? ZERO : q, overCap: r.gateMet ? q - c : ZERO, fractionBase: f,
    unmetStaff: !r.gateMet && q > ZERO ? 1 : 0, overCapStaff: r.gateMet && q > c ? 1 : 0, fractionStaff: f > ZERO ? 1 : 0, cap,
  }
}

/** Cộng nhiều dòng CÙNG K (một SP). Một dòng bất nhất / K khác ⇒ null. Bất biến ΣB đã kiểm. */
export function cmsQtyExplain(rows: readonly Pick<CmsResultRowDto, 'baseQuantity' | 'perUnit' | 'cmsQuantity' | 'rewardedQuantity' | 'capQuantity' | 'gateMet'>[]): CmsQtyExplain | null {
  let acc: CmsQtyExplain | null = null
  let capSame = true
  for (const r of rows) {
    const e = cmsQtyExplainRow(r)
    if (!e) return null
    if (!acc) { acc = { ...e }; continue }
    if (e.perUnit !== acc.perUnit) return null
    if (e.cap !== acc.cap) capSame = false
    acc.baseUnits += e.baseUnits; acc.rewarded += e.rewarded; acc.unmetGate += e.unmetGate; acc.overCap += e.overCap; acc.fractionBase += e.fractionBase
    acc.unmetStaff += e.unmetStaff; acc.overCapStaff += e.overCapStaff; acc.fractionStaff += e.fractionStaff
  }
  if (!acc) return null
  if (!capSame) acc.cap = null
  if (acc.baseUnits !== (acc.rewarded + acc.unmetGate + acc.overCap) * acc.perUnit + acc.fractionBase) return null
  return acc
}

/** Lượng không tính CMS (đơn vị cơ sở, scale 9). */
export const cmsQtyExcludedBase = (e: CmsQtyExplain): bigint => (e.unmetGate + e.overCap) * e.perUnit + e.fractionBase

/** Câu lý do phần không tính (theo đơn vị CMS); rỗng khi mọi lượng đều được tính. */
export function cmsQtyReasons(e: CmsQtyExplain, unit: string, gate: CmsGmvBasis): string[] {
  const out: string[] = []
  if (e.unmetGate > ZERO) out.push(`${e.unmetGate.toString()} ${unit} chưa đạt ${gate === 'catalog' ? 'target nhóm danh mục' : 'target'} (${e.unmetStaff} dược sĩ)`)
  if (e.overCap > ZERO) out.push(`${e.overCap.toString()} ${unit} vượt trần${e.cap !== null ? ` ${e.cap.toString()} ${unit}/dược sĩ` : ''} (${e.overCapStaff} dược sĩ)`)
  if (e.fractionBase > ZERO) out.push(`${cmsQtyText(e.fractionBase, e.perUnit)} ${unit} phần lẻ chưa đủ 1 ${unit} (${e.fractionStaff} dược sĩ)`)
  return out
}

// ── Phân bố lượng theo bậc + đoạn "Không tính CMS" ───────────────────────────
export interface CmsDistSegment { key: string; kind: 'tier' | 'excluded'; order: number | null; /** % độ rộng (0…100, 2 chữ số). */ pct: number; text: string }
export interface CmsProductDist { segments: CmsDistSegment[]; legend: string; aria: string }

/**
 * Thanh phân bố một SP: mỗi bậc = Σ đơn vị được CMS rơi vào bậc (cộng từng dược sĩ, khớp tiền snapshot) + đoạn "Không tính CMS".
 * Mẫu số = ΣB (lượng cùng đơn vị), không phải số người. Σ đoạn bậc = Σ được CMS; Σ đoạn × mức = Σ tiền. Lệch ⇒ null.
 */
export function cmsProductDistribution(rows: readonly CmsResultRowDto[], tiers: readonly CmsUiTier[], unit: string): CmsProductDist | null {
  const e = cmsQtyExplain(rows)
  const dist = cmsProductTierDistribution(rows, tiers)
  if (!e || !dist) return null
  const sumTiers = dist.reduce((a, x) => a + x, ZERO)
  if (sumTiers !== e.rewarded) return null
  let money = ZERO
  dist.forEach((u, i) => { money += u * BigInt(tiers[i].amount) })
  if (money !== rows.reduce((a, r) => a + BigInt(r.amountVnd), ZERO)) return null
  const total = e.baseUnits
  const pct = (base: bigint) => (total > ZERO ? Number((base * BigInt(10000)) / total) / 100 : 0)
  const excluded = cmsQtyExcludedBase(e)
  const segments: CmsDistSegment[] = tiers.map((t, i) => ({ key: `t${t.order}`, kind: 'tier' as const, order: t.order, pct: pct(dist[i] * e.perUnit), text: `B${t.order} ${dist[i].toString()}` }))
  segments.push({ key: 'x', kind: 'excluded', order: null, pct: pct(excluded), text: `không tính ${cmsQtyText(excluded, e.perUnit)}` })
  const legend = segments.map((s) => s.text).join(' · ')
  return { segments, legend, aria: `Phân bố ${cmsQtyText(total, e.perUnit)} ${unit} đã bán: ${tiers.map((t, i) => `bậc ${t.order} ${dist[i].toString()}`).join(', ')}, không tính CMS ${cmsQtyText(excluded, e.perUnit)} ${unit}` }
}

// ── Dòng dược sĩ (A3 mở rộng) ──────────────────────────────────────────────
export interface CmsA3StaffVM {
  name: string
  store: string
  soldText: string
  /** "tính 50" (chạm trần) · "tính 12" (phần lẻ) · "chưa tính" (chưa đạt gate) · null khi tính đủ. */
  qtyNote: string | null
  gmvText: string
  /** Gate cá nhân: SP ⇒ GMV SP / target; danh mục ⇒ GMV NHÓM / target (khác GMV SP); none ⇒ null. */
  gate: { basis: 'product' | 'catalog'; met: boolean; pct: number | null; text: string; shortText: string | null } | null
  status: { tone: StatusTone; label: string }
  amountText: string
  amountZero: boolean
}

export function cmsA3StaffStatus(r: CmsResultRowDto, tiers: readonly CmsUiTier[], unit: string, catalog: readonly CmsCatalogRowDto[]): { tone: StatusTone; label: string } {
  const g = cmsGateView(r, catalog)
  if (g && !g.met) return { tone: 'neutral', label: g.basis === 'catalog' ? 'Chưa đạt nhóm' : 'Chưa đạt target' }
  const q = BigInt(r.cmsQuantity)
  const pos = cmsTierPosition(q, tiers)
  if (pos.atCap) return { tone: 'info', label: `Đã đạt trần ${tiers[tiers.length - 1].to} ${unit}` }
  if (pos.index === null) return { tone: 'neutral', label: q === ZERO ? `Chưa đủ 1 ${unit}` : 'Chưa vào bậc' }
  return { tone: 'success', label: `Bậc ${tiers[pos.index].order} · ${cmsAmountPerUnit(tiers[pos.index].amount, unit)}` }
}

export function cmsA3StaffRows(rows: readonly CmsResultRowDto[], o: { tiers: readonly CmsUiTier[]; unit: string; catalog: readonly CmsCatalogRowDto[]; users: readonly CmsResultUserDto[]; storeNames: ReadonlyMap<string, string> }): CmsA3StaffVM[] {
  const names = new Map(o.users.map((u) => [u.id, u]))
  const sorted = [...rows].sort((a, b) => {
    const x = BigInt(a.amountVnd), y = BigInt(b.amountVnd)
    if (x !== y) return x > y ? -1 : 1
    return (names.get(a.userId)?.fullName ?? '').localeCompare(names.get(b.userId)?.fullName ?? '', 'vi') || a.userId.localeCompare(b.userId)
  })
  return sorted.map((r) => {
    const e = cmsQtyExplainRow(r)
    const k = dec(r.perUnit) ?? ZERO
    const b = dec(r.baseQuantity) ?? ZERO
    const g = cmsGateView(r, o.catalog)
    const qtyNote = !e ? null
      : !r.gateMet && BigInt(r.cmsQuantity) > ZERO ? 'chưa tính'
        : e.overCap > ZERO || e.fractionBase > ZERO ? `tính ${e.rewarded.toString()}` : null
    const u = names.get(r.userId)
    const store = u?.storeId ?? r.storeId
    return {
      name: u?.fullName ?? '—', store: o.storeNames.get(store) ?? '—',
      soldText: cmsQtyText(b, k), qtyNote, gmvText: cmsVnd(cmsTruncVnd(dec(r.gmvAmount) ?? ZERO)),
      gate: g ? {
        basis: g.basis, met: g.met, pct: g.pct,
        text: `${g.basis === 'catalog' ? 'Nhóm DM ' : ''}${cmsVnd(g.gmvVnd)} / ${cmsVnd(g.targetVnd)}`,
        shortText: g.met ? null : `thiếu ${cmsVnd(g.shortVnd)}`,
      } : null,
      status: cmsA3StaffStatus(r, o.tiers, o.unit, o.catalog),
      amountText: cmsVnd(BigInt(r.amountVnd)), amountZero: BigInt(r.amountVnd) === ZERO,
    }
  })
}

// ── Hàng SP (A3 tab Theo sản phẩm) ──────────────────────────────────────────
export interface CmsA3ProductVM {
  id: string
  productId: string
  name: string
  imageUrl: string | null
  unit: string
  basis: CmsGmvBasis
  gateLabel: string
  gateHue: TagHue
  /** "3.000.000₫ / dược sĩ" · "Nhóm DM 1.500.000₫ / dược sĩ" · null. */
  targetText: string | null
  priceText: string | null
  perUnitText: string
  tiers: { order: number; range: string; amountText: string }[]
  /** "Trần 50 vỉ / dược sĩ" khi bậc cuối hữu hạn. */
  capText: string | null
  advice: string
  addedAfterStart: boolean
  results: CmsA3ProductResultsVM | null
}
export interface CmsA3ProductResultsVM {
  soldText: string
  /** "159 tính CMS"; null khi không giải thích được. */
  countedText: string | null
  gmvText: string
  staffAchieved: number
  staffWithSales: number
  amountText: string
  amountZero: boolean
  dist: CmsProductDist | null
  /** Lý do phần không tính; null ⇒ "Chưa đủ dữ liệu giải thích". */
  reasons: string[] | null
  staff: CmsA3StaffVM[]
  totals: { count: number; soldText: string; gmvText: string; amountText: string }
}

export function cmsA3ProductVM(p: {
  id: string; productId: string; nameSnapshot: string; imageUrlSnapshot: string | null; unitCms: string; baseQuantityCms: string; gmvBasis: CmsGmvBasis
  targetGmv: string | null; priceSnapshot: string | null; adviceText: string; addedAfterStart: boolean; tiers: CmsUiTier[]
}, o: { catalogTargetGmv: string | null; results: null | { rows: readonly CmsResultRowDto[]; catalog: readonly CmsCatalogRowDto[]; users: readonly CmsResultUserDto[]; storeNames: ReadonlyMap<string, string> }; priceText: (v: string | null) => string }): CmsA3ProductVM {
  const last = p.tiers[p.tiers.length - 1]
  const k = dec(p.baseQuantityCms) ?? ZERO
  let results: CmsA3ProductResultsVM | null = null
  if (o.results) {
    const rows = o.results.rows
    const st = rows.length ? [...cmsProductSalesStats(rows).values()][0] : null
    const e = rows.length ? cmsQtyExplain(rows) : null
    const amount = st?.amountVnd ?? ZERO
    const reasons = rows.length === 0 ? [] : e ? cmsQtyReasons(e, p.unitCms, p.gmvBasis) : null
    results = {
      soldText: cmsQtyText(st?.baseUnits ?? ZERO, st?.perUnitUnits ?? k),
      countedText: rows.length === 0 ? null : e ? `${e.rewarded.toString()} tính CMS` : null,
      gmvText: cmsVnd(cmsTruncVnd(st?.gmvUnits ?? ZERO)),
      staffAchieved: st?.staffAchieved ?? 0, staffWithSales: st?.staffWithSales ?? 0,
      amountText: cmsVnd(amount), amountZero: amount === ZERO,
      dist: rows.length ? cmsProductDistribution(rows, p.tiers, p.unitCms) : null,
      reasons,
      staff: cmsA3StaffRows(rows.filter(cmsHasSalesOrAmount), { tiers: p.tiers, unit: p.unitCms, catalog: o.results.catalog, users: o.results.users, storeNames: o.results.storeNames }),
      totals: {
        count: rows.filter(cmsHasSalesOrAmount).length, soldText: cmsQtyText(st?.baseUnits ?? ZERO, st?.perUnitUnits ?? k),
        gmvText: cmsVnd(cmsTruncVnd(st?.gmvUnits ?? ZERO)), amountText: cmsVnd(amount),
      },
    }
  }
  return {
    id: p.id, productId: p.productId, name: p.nameSnapshot, imageUrl: p.imageUrlSnapshot, unit: p.unitCms, basis: p.gmvBasis,
    gateLabel: CMS_GATE_LABEL[p.gmvBasis], gateHue: CMS_GATE_HUE[p.gmvBasis],
    targetText: p.gmvBasis === 'product' ? `${cmsVnd(p.targetGmv)} / dược sĩ` : p.gmvBasis === 'catalog' ? `Nhóm DM ${cmsVnd(o.catalogTargetGmv)} / dược sĩ` : null,
    priceText: p.priceSnapshot ? o.priceText(p.priceSnapshot) : null,
    perUnitText: cmsBaseQtyLine(p.unitCms, p.baseQuantityCms),
    tiers: p.tiers.map((t) => ({ order: t.order, range: cmsTierRange(t.from, t.to), amountText: cmsAmountPerUnit(t.amount, p.unitCms) })),
    capText: last && last.to !== null ? `Trần ${last.to} ${p.unitCms} / dược sĩ` : null,
    advice: p.adviceText, addedAfterStart: p.addedAfterStart, results,
  }
}

/** Dòng hiển thị trong bảng dược sĩ: có bán (B > 0) hoặc có tiền (phòng dữ liệu điều chỉnh). */
const cmsHasSalesOrAmount = (r: CmsResultRowDto) => cmsHasSales(r) || BigInt(r.amountVnd) !== ZERO

/** Số dòng dược sĩ hiện mặc định trong phần mở rộng (còn lại: "Xem thêm"). */
export const CMS_A3_STAFF_PREVIEW = 10
