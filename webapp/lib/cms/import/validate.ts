// CMS P1-b — kiểm import theo NHÓM ProductID (docs/cms/SPEC.md §4.2–§4.6). Thuần, tất định.
//  · Một dòng lỗi ⇒ loại CẢ nhóm (không nạp thang bậc thiếu). Nhóm danh mục khác target ⇒ loại mọi nhóm danh mục.
//  · Không tự ép mức thưởng tăng dần; cảnh báo vẫn cho nạp.
//  · Kết quả có chuỗi chuẩn hoá (canonicalCmsImport) để server so preview ↔ commit (digest sha256 ở route).
//  · CMS-Q-220 (bỏ trần — thay Q-210a): bậc cuối luôn không giới hạn. File cũ có cận cuối hữu hạn HỢP LỆ được chuẩn hoá
//    (chỉ cận cuối → null) kèm cảnh báo LAST_TIER_UNBOUNDED_NORMALIZED; KHÔNG chữa lỗi khác (gap / overlap / kiểu / range…).

import { cmsNumberToDecimalString, formatCmsDecimal, parseCmsDecimal } from '../decimal'
import { cmsSafeImageUrl } from '../image'
import { canonicalProductId } from '../productId'
import type { CmsQuantityBasis } from '../unitBasis'
import { CMS_UNIT_KEY_VERSION } from '../unitKey'
import type { CmsCell, CmsImportColumn, CmsImportRawRow } from './parse'

export const CMS_INT_MAX = BigInt(2147483647)
/** Miền tiền (CMS_VND_SP, target sản phẩm / danh mục) = bigint dương của PG — cùng contract với RPC 121 (PM P1-b P1-1). */
export const CMS_BIGINT_MAX = BigInt('9223372036854775807')
export const CMS_AMOUNT_WARN = BigInt(500000)
/** Định danh chính sách bậc (CMS-Q-220) — nằm trong chuỗi canonical ⇒ digest preview cũ (trước chính sách) không còn khớp ⇒ 409. */
export const CMS_TIER_POLICY = 'uncapped_last_v1' as const
const ADVICE_MAX = 4000
const UNIT_MAX = 50

export type CmsGmvBasis = 'product' | 'catalog' | 'none'
export type CmsImportMode = 'replace' | 'append'

export interface CmsImportIssue {
  excelRow: number | null
  column: CmsImportColumn | null
  code: string
  message: string
  fix: string
}

export interface CmsImportTier { order: number; from: number; to: number | null; amount: string }

export interface CmsImportGroupOk {
  productId: string
  gmvBasis: CmsGmvBasis
  /** Số nguyên VND dạng chuỗi; null khi không phải gate theo sản phẩm. */
  targetGmv: string | null
  unitCms: string
  /** Chuỗi decimal chuẩn (≤ 9 chữ số thập phân). */
  baseQuantityCms: string
  adviceText: string
  nameSnapshot: string
  imageUrlSnapshot: string | null
  priceSnapshot: string | null
  /** Bậc canonical đã chuẩn hoá: bậc cuối LUÔN to = null (CMS-Q-220). */
  tiers: CmsImportTier[]
  /** Cận cuối hữu hạn trong file đã được bỏ (null = file vốn để trống). Chỉ để hiển thị / audit — không vào canonical. */
  normalizedLastTo: number | null
  excelRows: number[]
  warnings: CmsImportIssue[]
}

export interface CmsImportGroupRejected {
  key: string
  rows: CmsImportRawRow[]
  errors: CmsImportIssue[]
}

export interface CmsProductMasterLite {
  productName: string
  imageUrl: string | null
  /** Cột cache (mig 120) — import KHÔNG dùng để cảnh báo / chặn (operator bỏ trạng thái SP 04/11). */
  isActive: boolean
  referencePrice: string | null
}

export interface CmsImportContext {
  mode: CmsImportMode
  productMaster: ReadonlyMap<string, CmsProductMasterLite>
  /** append: ProductID đã có trong chương trình. */
  existingProductIds: ReadonlySet<string>
  /** ProductID thuộc chương trình đã kích hoạt / đã chốt khác, giao ngày, cùng namespace is_test. */
  conflictProductIds: ReadonlySet<string>
  /** append: target danh mục hiện hữu của chương trình (chuỗi số nguyên) hoặc null. */
  currentCatalogTarget: string | null
}

export interface CmsImportValidation {
  mode: CmsImportMode
  groupsOk: CmsImportGroupOk[]
  groupsRejected: CmsImportGroupRejected[]
  /** Target danh mục sau import (replace: từ file; append: hiện hữu hoặc từ nhóm danh mục đầu tiên). */
  catalogTarget: string | null
  stats: { rowsTotal: number; rowsOk: number; rowsRejected: number; productsOk: number; productsRejected: number; warnings: number }
}

/** Số nguyên dạng VN có dấu chấm ngăn nghìn (10.000) — tất định, không phụ thuộc locale máy. */
const vnInt = (n: bigint): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')

const ISSUE = (excelRow: number | null, column: CmsImportColumn | null, code: string, message: string, fix: string): CmsImportIssue =>
  ({ excelRow, column, code, message, fix })

// ── đọc ô ──────────────────────────────────────────────────────────────────
type Read<T> = { ok: true; value: T } | { ok: false; code: string; message: string; fix: string }
const BAD_CELL: Record<string, string> = {
  FORMULA: 'Ô có công thức', BOOLEAN: 'Ô kiểu đúng/sai', DATE: 'Ô kiểu ngày', ERROR: 'Ô lỗi Excel',
}

function badCell(cell: CmsCell): Read<never> | null {
  if (cell.kind !== 'bad') return null
  return { ok: false, code: cell.reason === 'FORMULA' ? 'CELL_FORMULA' : 'CELL_TYPE', message: `${BAD_CELL[cell.reason]} — không đọc được`, fix: 'Nhập giá trị trực tiếp (số hoặc chữ), không dùng công thức' }
}

/** Số nguyên: ô numeric nguyên an toàn hoặc text chỉ chữ số (không đoán dấu phân cách). null = ô trống. */
function readInt(cell: CmsCell, label: string): Read<bigint | null> {
  if (cell.kind === 'bad') return badCell(cell)!
  if (cell.kind === 'empty') return { ok: true, value: null }
  if (cell.kind === 'number') {
    if (!Number.isSafeInteger(cell.value)) return { ok: false, code: 'NOT_INTEGER', message: `${label} phải là số nguyên`, fix: 'Nhập số nguyên, không có phần thập phân' }
    return { ok: true, value: BigInt(cell.value) }
  }
  const s = cell.value.trim()
  if (!/^[0-9]+$/.test(s)) return { ok: false, code: 'NOT_INTEGER', message: `${label} không phải số nguyên hợp lệ ("${s.slice(0, 30)}")`, fix: 'Nhập số dạng ô số, hoặc chỉ gồm chữ số, không dấu chấm / phẩy / khoảng trắng' }
  return { ok: true, value: BigInt(s.replace(/^0+(?=[0-9])/, '')) }
}

function readText(cell: CmsCell): Read<string | null> {
  if (cell.kind === 'bad') return badCell(cell)!
  if (cell.kind === 'empty') return { ok: true, value: null }
  // eslint-disable-next-line no-control-regex
  const v = (cell.kind === 'number' ? String(cell.value) : cell.value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
  return { ok: true, value: v.trim() === '' ? null : v.trim() }
}

function readDecimal9(cell: CmsCell): Read<bigint | null> {
  if (cell.kind === 'bad') return badCell(cell)!
  if (cell.kind === 'empty') return { ok: true, value: null }
  // Ô số ngoài miền nguyên an toàn của JS có thể đã mất chữ số trước khi tới đây ⇒ từ chối (SPEC §4.2; PM P1-b P1-2).
  // Text decimal chính xác (tới 29 chữ số nguyên) vẫn nhận qua nhánh text.
  if (cell.kind === 'number' && !(Math.abs(cell.value) <= Number.MAX_SAFE_INTEGER)) {
    return { ok: false, code: 'BASE_QTY_INVALID', message: 'base_quantity_CMS dạng ô số vượt miền chính xác', fix: 'Nhập dạng text chỉ gồm chữ số (và dấu chấm thập phân)' }
  }
  const str = cell.kind === 'number' ? cmsNumberToDecimalString(cell.value) : cell.value.trim()
  if (str === null) return { ok: false, code: 'BASE_QTY_INVALID', message: 'base_quantity_CMS không hợp lệ', fix: 'Nhập số dương, dấu chấm thập phân, tối đa 9 chữ số sau dấu chấm' }
  const p = parseCmsDecimal(str)
  if (!p.ok) {
    const msg = p.error === 'SCALE' ? 'base_quantity_CMS quá 9 chữ số thập phân' : 'base_quantity_CMS không phải số dương hợp lệ'
    return { ok: false, code: 'BASE_QTY_INVALID', message: msg, fix: 'Nhập số dương, dấu chấm thập phân, tối đa 9 chữ số sau dấu chấm' }
  }
  if (p.units <= BigInt(0)) return { ok: false, code: 'BASE_QTY_INVALID', message: 'base_quantity_CMS phải > 0', fix: 'Nhập số đơn vị cơ sở tương ứng 1 đơn vị CMS (> 0)' }
  return { ok: true, value: p.units }
}

// ── dòng ───────────────────────────────────────────────────────────────────
interface ParsedRow {
  row: CmsImportRawRow
  productId: string | null
  target: bigint | null
  type: 'GMV_THEO_PRODUCTID' | 'GMV_TOAN_DANH_MUC' | null
  from: bigint | null
  to: bigint | null
  amount: bigint | null
  advice: string | null
  unit: string | null
  baseQty: bigint | null
  errors: CmsImportIssue[]
}

function parseRow(row: CmsImportRawRow): ParsedRow {
  const errors: CmsImportIssue[] = []
  const at = row.excelRow
  const take = <T>(r: Read<T>, col: CmsImportColumn): T | null => {
    if (r.ok) return r.value
    errors.push(ISSUE(at, col, r.code, r.message, r.fix))
    return null
  }
  // ProductID
  let productId: string | null = null
  const pc = row.cells.ProductID
  const pb = badCell(pc)
  if (pb && !pb.ok) errors.push(ISSUE(at, 'ProductID', pb.code, pb.message, pb.fix))
  else {
    const v = pc.kind === 'number' ? pc.value : pc.kind === 'text' ? pc.value : null
    const c = canonicalProductId(v)
    if (c.ok) productId = c.id
    else errors.push(ISSUE(at, 'ProductID', 'PRODUCT_ID_INVALID', 'ProductID phải là số nguyên dương (mã product_id trên POS)', 'Nhập đúng ProductID dạng số, không dùng SKU / mã hàng'))
  }
  const target = take(readInt(row.cells.KPI_Target_GMV_VND, 'KPI_Target_GMV_VND'), 'KPI_Target_GMV_VND')
  if (target !== null && (target <= BigInt(0) || target > CMS_BIGINT_MAX)) errors.push(ISSUE(at, 'KPI_Target_GMV_VND', 'TARGET_INVALID', 'Target GMV phải > 0 và ≤ 9.223.372.036.854.775.807', 'Nhập số nguyên dương hoặc để trống'))
  const typeText = take(readText(row.cells.Loai_CMS_GMV), 'Loai_CMS_GMV')
  let type: ParsedRow['type'] = null
  if (typeText !== null) {
    const t = typeText.toUpperCase()
    if (t === 'GMV_THEO_PRODUCTID' || t === 'GMV_TOAN_DANH_MUC') type = t
    else errors.push(ISSUE(at, 'Loai_CMS_GMV', 'TYPE_INVALID', `Loại CMS GMV không hợp lệ ("${typeText.slice(0, 30)}")`, 'Dùng GMV_THEO_PRODUCTID, GMV_TOAN_DANH_MUC hoặc để trống'))
  }
  const from = take(readInt(row.cells.Tu_SL_ban, 'Tu_SL_ban'), 'Tu_SL_ban')
  if (from === null && !errors.some((e) => e.column === 'Tu_SL_ban')) errors.push(ISSUE(at, 'Tu_SL_ban', 'TIER_FROM_REQUIRED', 'Thiếu Tu_SL_ban', 'Nhập số nguyên ≥ 1'))
  if (from !== null && (from < BigInt(1) || from > CMS_INT_MAX)) errors.push(ISSUE(at, 'Tu_SL_ban', 'TIER_FROM_INVALID', 'Tu_SL_ban phải từ 1 đến 2.147.483.647', 'Nhập số nguyên ≥ 1'))
  const to = take(readInt(row.cells.Den_SL_ban, 'Den_SL_ban'), 'Den_SL_ban')
  if (to !== null && (to < BigInt(1) || to > CMS_INT_MAX)) errors.push(ISSUE(at, 'Den_SL_ban', 'TIER_TO_INVALID', 'Den_SL_ban phải từ 1 đến 2.147.483.647', 'Nhập số nguyên hoặc để trống ở bậc cuối'))
  if (from !== null && to !== null && to < from) errors.push(ISSUE(at, 'Den_SL_ban', 'TIER_TO_LT_FROM', 'Den_SL_ban nhỏ hơn Tu_SL_ban', 'Sửa Den_SL_ban ≥ Tu_SL_ban'))
  const amount = take(readInt(row.cells.CMS_VND_SP, 'CMS_VND_SP'), 'CMS_VND_SP')
  if (amount === null && !errors.some((e) => e.column === 'CMS_VND_SP')) errors.push(ISSUE(at, 'CMS_VND_SP', 'AMOUNT_REQUIRED', 'Thiếu CMS_VND_SP', 'Nhập số nguyên VND > 0'))
  if (amount !== null && (amount <= BigInt(0) || amount > CMS_BIGINT_MAX)) errors.push(ISSUE(at, 'CMS_VND_SP', 'AMOUNT_INVALID', 'CMS_VND_SP phải > 0 và ≤ 9.223.372.036.854.775.807', 'Nhập số nguyên VND > 0'))
  const advice = take(readText(row.cells.Noi_dung_tu_van), 'Noi_dung_tu_van')
  if (advice === null && !errors.some((e) => e.column === 'Noi_dung_tu_van')) errors.push(ISSUE(at, 'Noi_dung_tu_van', 'ADVICE_REQUIRED', 'Thiếu nội dung tư vấn', 'Nhập nội dung tư vấn đã kiểm duyệt'))
  if (advice !== null && advice.length > ADVICE_MAX) errors.push(ISSUE(at, 'Noi_dung_tu_van', 'ADVICE_TOO_LONG', `Nội dung tư vấn quá ${ADVICE_MAX} ký tự`, 'Rút gọn nội dung'))
  const unit = take(readText(row.cells.unit_CMS), 'unit_CMS')
  if (unit === null && !errors.some((e) => e.column === 'unit_CMS')) errors.push(ISSUE(at, 'unit_CMS', 'UNIT_REQUIRED', 'Thiếu unit_CMS', 'Nhập đơn vị hưởng CMS (vd. hộp, chai)'))
  if (unit !== null && unit.length > UNIT_MAX) errors.push(ISSUE(at, 'unit_CMS', 'UNIT_TOO_LONG', `unit_CMS quá ${UNIT_MAX} ký tự`, 'Rút gọn tên đơn vị'))
  const baseQty = take(readDecimal9(row.cells.base_quantity_CMS), 'base_quantity_CMS')
  if (baseQty === null && !errors.some((e) => e.column === 'base_quantity_CMS')) errors.push(ISSUE(at, 'base_quantity_CMS', 'BASE_QTY_REQUIRED', 'Thiếu base_quantity_CMS', 'Nhập số đơn vị cơ sở tương ứng 1 đơn vị CMS'))
  return { row, productId, target, type, from, to, amount, advice, unit, baseQty, errors }
}

// ── nhóm ───────────────────────────────────────────────────────────────────
const sameAll = <T>(xs: T[]) => xs.every((x) => x === xs[0])

export function validateCmsImport(rows: readonly CmsImportRawRow[], ctx: CmsImportContext): CmsImportValidation {
  const parsed = rows.map(parseRow)
  // Nhóm theo ProductID canonical; dòng ProductID hỏng nhóm theo raw (vẫn bị loại).
  const groups = new Map<string, ParsedRow[]>()
  for (const p of parsed) {
    const key = p.productId ?? `raw:${String(p.row.raw.ProductID ?? '').trim()}`
    const g = groups.get(key)
    if (g) g.push(p); else groups.set(key, [p])
  }

  type Pending = { key: string; items: ParsedRow[]; errors: CmsImportIssue[]; ok?: Omit<CmsImportGroupOk, 'warnings'> & { warnings: CmsImportIssue[]; catalogTarget: bigint | null } }
  const pend: Pending[] = []
  for (const [key, items] of groups) {
    const errors = items.flatMap((i) => i.errors)
    const pRow = items[0].row.excelRow
    const p: Pending = { key, items, errors }
    pend.push(p)
    if (errors.length) continue
    // Nhất quán trong nhóm.
    const checks: [CmsImportColumn, unknown[]][] = [
      ['KPI_Target_GMV_VND', items.map((i) => i.target?.toString() ?? null)],
      ['Loai_CMS_GMV', items.map((i) => i.type)],
      ['unit_CMS', items.map((i) => i.unit)],
      ['base_quantity_CMS', items.map((i) => i.baseQty?.toString() ?? null)],
      ['Noi_dung_tu_van', items.map((i) => i.advice)],
    ]
    for (const [col, vals] of checks) {
      if (!sameAll(vals)) errors.push(ISSUE(pRow, col, 'GROUP_INCONSISTENT', `Các dòng cùng ProductID khác nhau ở cột ${col}`, `Thống nhất ${col} cho mọi bậc của sản phẩm`))
    }
    // Gate.
    const { target, type } = items[0]
    let gmvBasis: CmsGmvBasis = 'none'
    if (target !== null && type === 'GMV_THEO_PRODUCTID') gmvBasis = 'product'
    else if (target !== null && type === 'GMV_TOAN_DANH_MUC') gmvBasis = 'catalog'
    else if (target === null && type !== null) errors.push(ISSUE(pRow, 'KPI_Target_GMV_VND', 'GATE_MISSING_TARGET', 'Có loại CMS GMV nhưng thiếu target', 'Nhập KPI_Target_GMV_VND hoặc để trống cả hai cột'))
    else if (target !== null && type === null) errors.push(ISSUE(pRow, 'Loai_CMS_GMV', 'GATE_MISSING_TYPE', 'Có target nhưng thiếu loại CMS GMV', 'Chọn GMV_THEO_PRODUCTID hoặc GMV_TOAN_DANH_MUC'))
    // Bậc.
    const tiers = [...items].sort((a, b) => (a.from! < b.from! ? -1 : a.from! > b.from! ? 1 : 0))
    if (tiers[0].from !== BigInt(1)) errors.push(ISSUE(tiers[0].row.excelRow, 'Tu_SL_ban', 'TIER_NOT_FROM_ONE', 'Bậc đầu phải bắt đầu từ 1', 'Sửa Tu_SL_ban của bậc đầu = 1'))
    tiers.forEach((t, i) => {
      const last = i === tiers.length - 1
      if (!last && t.to === null) errors.push(ISSUE(t.row.excelRow, 'Den_SL_ban', 'TIER_OPEN_NOT_LAST', 'Chỉ bậc cuối được để trống Den_SL_ban', 'Nhập Den_SL_ban cho bậc này'))
      if (!last && t.to !== null) {
        const next = tiers[i + 1].from!
        if (next <= t.to) errors.push(ISSUE(tiers[i + 1].row.excelRow, 'Tu_SL_ban', 'TIER_OVERLAP', 'Bậc chồng lên bậc trước', `Sửa Tu_SL_ban = ${t.to + BigInt(1)}`))
        else if (next > t.to + BigInt(1)) errors.push(ISSUE(tiers[i + 1].row.excelRow, 'Tu_SL_ban', 'TIER_GAP', 'Bậc bị hở so với bậc trước', `Sửa Tu_SL_ban = ${t.to + BigInt(1)}`))
      }
    })
    // Nguồn / phạm vi.
    const pid = items[0].productId!
    const pm = ctx.productMaster.get(pid)
    if (!pm) errors.push(ISSUE(pRow, 'ProductID', 'PRODUCT_NOT_FOUND', 'ProductID không có trên Product Master', 'Kiểm tra lại mã hoặc chờ Product Master đồng bộ'))
    if (ctx.conflictProductIds.has(pid)) errors.push(ISSUE(pRow, 'ProductID', 'PRODUCT_CONFLICT', 'ProductID đã thuộc chương trình khác đã kích hoạt có ngày giao nhau', 'Bỏ sản phẩm này hoặc đổi khoảng ngày chương trình'))
    if (ctx.mode === 'append' && ctx.existingProductIds.has(pid)) errors.push(ISSUE(pRow, 'ProductID', 'PRODUCT_EXISTS_STARTED', 'Chương trình đã bắt đầu: không sửa / nạp lại sản phẩm đã có', 'Chỉ thêm ProductID mới'))
    if (errors.length || !pm) continue
    // Cảnh báo.
    const warnings: CmsImportIssue[] = []
    const img = cmsSafeImageUrl(pm.imageUrl)
    if (!pm.imageUrl) warnings.push(ISSUE(pRow, 'ProductID', 'IMAGE_MISSING', 'Sản phẩm chưa có ảnh', 'Vẫn nạp; ảnh dự phòng sẽ hiển thị'))
    else if (!img) warnings.push(ISSUE(pRow, 'ProductID', 'IMAGE_NOT_ALLOWED', 'Ảnh sản phẩm ngoài nguồn được duyệt', 'Vẫn nạp; báo operator kiểm nguồn ảnh'))
    // Không cảnh báo trạng thái SP (operator bỏ 04/11 — PM `2026-11-04-cms-bi-product-master-pm.md` §2.2): kể cả cache cũ còn
    // is_active=false cũng không sinh PRODUCT_INACTIVE. ProductID không có trên Master vẫn bị từ chối (PRODUCT_NOT_FOUND ở trên).
    for (const t of tiers) if (t.amount! > CMS_AMOUNT_WARN) warnings.push(ISSUE(t.row.excelRow, 'CMS_VND_SP', 'AMOUNT_HIGH', 'Mức CMS > 500.000đ', 'Vẫn nạp; kiểm lại mức thưởng'))
    // CMS-Q-220: chỉ tới đây khi MỌI kiểm kiểu / range / liên tục đã đạt ⇒ chuẩn hoá đúng một chỗ: cận trên bậc cuối → null.
    const lastTier = tiers[tiers.length - 1]
    const normalizedLastTo = lastTier.to
    if (normalizedLastTo !== null) {
      warnings.push(ISSUE(lastTier.row.excelRow, 'Den_SL_ban', 'LAST_TIER_UNBOUNDED_NORMALIZED',
        `Đã bỏ giới hạn ${vnInt(normalizedLastTo)} của bậc cuối theo chính sách CMS mới; từ ${vnInt(lastTier.from!)} trở lên đều được xét bậc này.`,
        'Vẫn nạp; lần sau để trống Den_SL_ban ở bậc cuối'))
    }
    p.ok = {
      productId: pid,
      gmvBasis,
      targetGmv: gmvBasis === 'product' ? target!.toString() : null,
      catalogTarget: gmvBasis === 'catalog' ? target : null,
      unitCms: items[0].unit!,
      baseQuantityCms: formatCmsDecimal(items[0].baseQty!),
      adviceText: items[0].advice!,
      nameSnapshot: pm.productName,
      imageUrlSnapshot: img,
      priceSnapshot: pm.referencePrice,
      tiers: tiers.map((t, i) => ({
        order: i + 1, from: Number(t.from!), to: i === tiers.length - 1 || t.to === null ? null : Number(t.to), amount: t.amount!.toString(),
      })),
      normalizedLastTo: normalizedLastTo === null ? null : Number(normalizedLastTo),
      excelRows: items.map((i) => i.row.excelRow).sort((a, b) => a - b),
      warnings,
    }
  }

  // Danh mục: các nhóm catalog phải cùng target; append không được đổi target hiện hữu.
  const catalogOk = pend.filter((p) => p.ok?.gmvBasis === 'catalog')
  const targets = new Set(catalogOk.map((p) => p.ok!.catalogTarget!.toString()))
  let catalogTarget: string | null = ctx.mode === 'append' ? ctx.currentCatalogTarget : null
  if (targets.size > 1) {
    for (const p of catalogOk) { p.errors.push(ISSUE(p.items[0].row.excelRow, 'KPI_Target_GMV_VND', 'CATALOG_TARGET_MISMATCH', 'Các sản phẩm GMV_TOAN_DANH_MUC khai báo target khác nhau', 'Dùng cùng một target danh mục cho mọi dòng GMV_TOAN_DANH_MUC')); p.ok = undefined }
  } else if (targets.size === 1) {
    const t = [...targets][0]
    if (ctx.mode === 'append' && ctx.currentCatalogTarget !== null && ctx.currentCatalogTarget !== t) {
      for (const p of catalogOk) { p.errors.push(ISSUE(p.items[0].row.excelRow, 'KPI_Target_GMV_VND', 'CATALOG_TARGET_CHANGED', `Target danh mục hiện hữu (${ctx.currentCatalogTarget}) không được đổi giữa kỳ`, 'Dùng đúng target danh mục hiện hữu')); p.ok = undefined }
    } else catalogTarget = t
  }

  const groupsOk: CmsImportGroupOk[] = []
  const groupsRejected: CmsImportGroupRejected[] = []
  for (const p of pend) {
    if (p.ok && p.errors.length === 0) {
      const { catalogTarget: _ct, ...g } = p.ok
      void _ct
      groupsOk.push(g)
    } else {
      groupsRejected.push({ key: p.key, rows: p.items.map((i) => i.row), errors: p.errors })
    }
  }
  groupsOk.sort((a, b) => (a.productId.length - b.productId.length) || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
  const rowsOk = groupsOk.reduce((s, g) => s + g.excelRows.length, 0)
  return {
    mode: ctx.mode,
    groupsOk,
    groupsRejected,
    catalogTarget: groupsOk.some((g) => g.gmvBasis === 'catalog') || ctx.mode === 'append' ? catalogTarget : null,
    stats: {
      rowsTotal: rows.length, rowsOk, rowsRejected: rows.length - rowsOk,
      productsOk: groupsOk.length, productsRejected: groupsRejected.length,
      warnings: groupsOk.reduce((s, g) => s + g.warnings.length, 0),
    },
  }
}

/** Chuỗi chuẩn hoá payload sẽ ghi (để so preview ↔ commit). Không gồm cảnh báo / số dòng Excel / cận cuối gốc đã bỏ.
 *  Có định danh chính sách bậc (CMS_TIER_POLICY): preview lập trước CMS-Q-220 ⇒ digest khác ⇒ commit 409 PREVIEW_STALE.
 *  CMS đơn giản S1: file mức cố định gắn thêm `format: 'simple_v1'` (mẫu 9 cột giữ NGUYÊN chuỗi cũ ⇒ digest cũ không đổi).
 *  CMS-UNIT: chương trình cms_unit gắn thêm cơ sở + phiên bản khoá đơn vị (pos_base giữ NGUYÊN chuỗi cũ) ⇒ cơ sở / hợp đồng khoá đơn
 *  vị đổi giữa preview và commit ⇒ digest khác ⇒ 409. */
export function canonicalCmsImport(v: Pick<CmsImportValidation, 'mode' | 'groupsOk' | 'catalogTarget'>, format: 'tiers' | 'simple' = 'tiers',
  basis: CmsQuantityBasis = 'pos_base'): string {
  return JSON.stringify({
    policy: CMS_TIER_POLICY,
    ...(format === 'simple' ? { format: 'simple_v1' } : {}),
    ...(basis === 'cms_unit' ? { quantityBasis: 'cms_unit', unitKeyVersion: CMS_UNIT_KEY_VERSION } : {}),
    mode: v.mode,
    catalogTarget: v.catalogTarget,
    groups: v.groupsOk.map((g) => [g.productId, g.gmvBasis, g.targetGmv, g.unitCms, g.baseQuantityCms, g.adviceText,
      g.nameSnapshot, g.imageUrlSnapshot, g.priceSnapshot, g.tiers.map((t) => [t.from, t.to, t.amount])]),
  })
}
