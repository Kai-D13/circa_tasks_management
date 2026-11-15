// CMS P2-c (I3) — XLSX kết quả (kế hoạch PM 02/11 §6 / §6.1; SPEC §7 "Export (P2)"). Lõi THUẦN + handler có deps tiêm vào
// (route thật: app/api/export/cms/route.ts; test: deps giả, không DB):
//  · Ghim run: run trên màn (`run=`) phải là run hiện hành lúc xuất — khác / đã dọn ⇒ 409 "dữ liệu đã thay đổi" (không trộn
//    hai phiên). Mọi trang dòng phải cùng run.
//  · Đủ dòng: đọc hết mọi trang; vượt trần ⇒ 413 (không xuất thiếu); trước khi trả file kiểm Σ line_count = số dòng và
//    Σ tiền dòng = Σ tiền dược sĩ × SP (lệch 0đ) — lệch ⇒ 500, không file.
//  · Q-206: có dòng ADJUSTMENT mà hợp đồng trả hàng chưa chốt ⇒ 409 (không thể ẩn dòng mà vẫn khớp tổng — U18).
//  · Ô: chuỗi ghi kiểu text (không công thức); số nguyên trong miền an toàn ⇒ số, ngoài miền / thập phân ⇒ text (không mất chữ số).
//  · Quyền: cờ program + earnings, super hoặc SM; phạm vi dòng do RPC 122 (session). Sheet "Chua gan" (email người bán nguồn để
//    sửa mapping) chỉ super — RPC excluded cũng chỉ trả cho super.
import * as XLSX from 'xlsx'
import { formatCmsDecimal, parseCmsDecimal } from './decimal'
import { CMS_LINE_LABEL, CMS_QUANTITY_CLASS_LABEL, cmsLockedScopeNote, cmsNetSummary, cmsProductSalesStats, cmsQtyText, cmsResultScopeNote } from './resultUi'
import { CMS_QUANTITY_BASIS_LABEL } from './calc/policy'
import { CMS_RETURNS_POLICY_LABEL } from './calc/basisUi'
import { cmsRunHasLegacyCap, type CmsResultHeaderDto, type CmsResultLineDto, type CmsResultRowsDto } from './resultView'

export const CMS_EXPORT_MAX_LINES = 50_000
export const CMS_EXPORT_MAX_EXCLUDED = 50_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INT_RE = /^-?(0|[1-9][0-9]*)$/
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const DEC_RE = /^-?[0-9]{1,35}(\.[0-9]{1,9})?$/

// ── Dòng bị loại (rpc_cms_result_excluded) ──────────────────────────────────
export interface CmsExcludedLineDto {
  seq: number; orderLineId: string; orderCode: string; productId: string; programProductId: string | null
  disposition: string; unassignedReason: string | null; sellerEmail: string | null; userId: string | null; storeId: string | null
  posCode: string | null; completedAt: string; baseQuantity: string; gmvAmount: string
  /** P5.4 (reader v2): lớp lượng + B đủ của dòng; SL / ĐVT gốc. Reader 122 không có ⇒ undefined. */
  quantityClass?: string | null; eligibleBase?: string | null; quantityRaw?: string | null; uomRaw?: string | null
}
export interface CmsExcludedPage { runId: string; rows: CmsExcludedLineDto[]; nextAfterSeq: number | null }

export class CmsExportDtoError extends Error {
  constructor(k: string) { super(`CMS export DTO: ${k}`); this.name = 'CmsExportDtoError' }
}
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (o: Obj, k: string, re?: RegExp): string => { const v = o[k]; if (typeof v !== 'string' || (re && !re.test(v))) throw new CmsExportDtoError(k); return v }
const strN = (o: Obj, k: string, re?: RegExp): string | null => (o[k] === null || o[k] === undefined ? null : str(o, k, re))

export function parseCmsExcludedPage(raw: unknown): CmsExcludedPage {
  if (!isObj(raw) || !Array.isArray(raw.rows)) throw new CmsExportDtoError('excluded')
  const next = raw.next_after_seq
  if (next !== null && next !== undefined && (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0)) throw new CmsExportDtoError('next_after_seq')
  return {
    runId: str(raw, 'run_id', UUID_RE),
    nextAfterSeq: (next ?? null) as number | null,
    rows: raw.rows.map((x) => {
      if (!isObj(x) || typeof x.seq !== 'number' || !Number.isSafeInteger(x.seq)) throw new CmsExportDtoError('rows[]')
      return {
        seq: x.seq, orderLineId: str(x, 'order_line_id'), orderCode: str(x, 'order_code'), productId: str(x, 'product_id'),
        programProductId: strN(x, 'program_product_id', UUID_RE), disposition: str(x, 'disposition'), unassignedReason: strN(x, 'unassigned_reason'),
        sellerEmail: strN(x, 'seller_email'), userId: strN(x, 'user_id', UUID_RE), storeId: strN(x, 'store_id', UUID_RE), posCode: strN(x, 'pos_code'),
        completedAt: str(x, 'completed_at', TS_RE), baseQuantity: str(x, 'base_quantity', DEC_RE), gmvAmount: str(x, 'gmv_amount', DEC_RE),
        ...('quantity_class' in x ? {
          quantityClass: strN(x, 'quantity_class'), eligibleBase: strN(x, 'eligible_base', DEC_RE), quantityRaw: strN(x, 'quantity_raw'), uomRaw: strN(x, 'uom_raw'),
        } : {}),
      }
    }),
  }
}

// ── Ô ──────────────────────────────────────────────────────────────────────
type Cell = string | number | null
/** Số nguyên (chuỗi / bigint) trong miền an toàn ⇒ number; ngoài miền ⇒ text giữ đủ chữ số. */
export function cmsIntCell(v: string | bigint | null): Cell {
  if (v === null) return null
  const s = typeof v === 'bigint' ? v.toString() : v
  if (!INT_RE.test(s)) return s
  const b = BigInt(s)
  return b <= BigInt(Number.MAX_SAFE_INTEGER) && b >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : s
}
/** Thập phân: nguyên ⇒ như cmsIntCell; có phần lẻ ⇒ text "1234.5" (giữ chính xác, không float). */
export function cmsDecCell(v: string | null): Cell {
  if (v === null) return null
  const r = parseCmsDecimal(v, { allowNegative: true })
  if (!r.ok) return v
  const s = formatCmsDecimal(r.units)
  return s.includes('.') ? s : cmsIntCell(s)
}
const vnTime = (iso: string | null): string => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = new Date(t + 7 * 3600_000).toISOString()
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${d.slice(11, 19)}`
}
const units = (v: string) => { const r = parseCmsDecimal(v, { allowNegative: true }); if (!r.ok) throw new CmsExportDtoError('decimal'); return r.units }

// ── Workbook ────────────────────────────────────────────────────────────────
export interface CmsExportProduct { id: string; productId: string; nameSnapshot: string; unitCms: string; baseQuantityCms: string; gmvBasis: string }
export interface CmsExportInput {
  program: { id: string; name: string; startDate: string; endDate: string; configVersion: number; status?: string }
  header: CmsResultHeaderDto
  rows: CmsResultRowsDto
  lines: CmsResultLineDto[]
  excluded: CmsExcludedLineDto[] | null
  /** P5.4: dòng INCLUDED không vào lượng (run contract, super) — reader v2 kind 'quantity'. */
  excludedQty?: CmsExcludedLineDto[] | null
  products: CmsExportProduct[]
  storeNames: Map<string, string>
  exportedAt: Date
  scope: 'super' | 'sm'
  returnsApproved: boolean
}
export type CmsExportBuild = { ok: true; bytes: Uint8Array<ArrayBuffer>; lineCount: number; amountVnd: bigint }
  | { ok: false; error: 'RUN_MISMATCH' | 'COUNT_MISMATCH' | 'TOTAL_MISMATCH' | 'RETURNS_HOLD' }

const GATE_LABEL: Record<string, string> = { product: 'Target SP', catalog: 'Theo danh mục', none: 'Theo số lượng' }
const DISPOSITION_LABEL: Record<string, string> = { UNASSIGNED: 'Chưa gán dược sĩ', OUT_OF_SCOPE: 'Ngoài phạm vi nhà thuốc' }

export function buildCmsResultWorkbook(i: CmsExportInput): CmsExportBuild {
  const run = i.header.run
  if (!run || i.rows.runId !== run.id) return { ok: false, error: 'RUN_MISMATCH' }
  // P5.4: hợp đồng GHIM từ run; header và rows phải cùng hợp đồng (khác ⇒ không trộn hai cách diễn giải).
  const c = run.contract
  if (i.rows.contract && JSON.stringify(i.rows.contract) !== JSON.stringify(c)) return { ok: false, error: 'RUN_MISMATCH' }
  const contractRun = !c.legacy
  // PM RC r2 SALES-RC-03: bố cục theo CHÍNH SÁCH TRẢ GHIM của run (không theo cờ hiện tại, không theo `!legacy` hay object net):
  //   · legacy — như cũ · contract net_returns_v1 — cột ròng / trả / sự kiện bán + trả như P5.4
  //   · contract sales_only_v1 (DB: chỉ cms_unit) — "SL bán / GMV", KHÔNG cột / dòng trả; giữ K + lượng đủ điều kiện + lớp lượng.
  const netRun = contractRun && c.returnsPolicy === 'net_returns_v1'
  const salesContract = contractRun && !netRun
  // Run contract: line_count = số sự kiện BÁN, return_count = số DÒNG trả (sự kiện theo item — không phải số chứng từ; seal 130
  // SEAL_RESULT_SUMS) ⇒ đủ dòng = bán + trả.
  const expectLines = i.rows.results.reduce((s, r) => s + r.lineCount + (contractRun ? r.net?.returnCount ?? 0 : 0), 0)
  if (expectLines !== i.lines.length) return { ok: false, error: 'COUNT_MISMATCH' }
  // Run sales-only không có sự kiện trả (seal 130) — có ⇒ dữ liệu lệch hợp đồng, không xuất file.
  if (salesContract && i.lines.some((l) => l.kind === 'RETURN')) return { ok: false, error: 'COUNT_MISMATCH' }
  const sumRows = i.rows.results.reduce((s, r) => s + BigInt(r.amountVnd), BigInt(0))
  const sumLines = i.lines.reduce((s, l) => s + BigInt(l.amountVnd), BigInt(0))
  if (sumRows !== sumLines) return { ok: false, error: 'TOTAL_MISMATCH' }
  if (!i.returnsApproved && i.lines.some((l) => l.status === 'ADJUSTMENT')) return { ok: false, error: 'RETURNS_HOLD' }

  const prod = new Map(i.products.map((p) => [p.id, p]))
  const names = new Map(i.rows.users.map((u) => [u.id, u]))
  const store = (id: string | null) => (id ? i.storeNames.get(id) ?? '' : '')
  const wb = XLSX.utils.book_new()
  const add = (name: string, aoa: Cell[][]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)

  const legacyCap = cmsRunHasLegacyCap(i.rows.results, i.lines)
  // PM P5-04: nhãn theo TRẠNG THÁI chương trình, chung legacy / contract (đã chốt ⇒ "Số đã chốt", không còn "Tạm tính"); không đổi số.
  const locked = i.program.status === 'locked'
  const kindNote = locked ? 'Số đã chốt — phiên đóng băng' : 'Tạm tính — chưa chốt kỳ'
  const amtHead = locked ? 'CMS đã chốt (VND)' : 'CMS tạm tính (VND)'
  const nSale = i.lines.filter((l) => l.kind === 'SALE').length
  add('Thong tin', [
    ['Mục', 'Giá trị'],
    ['Chương trình', i.program.name],
    ['ID chương trình', i.program.id],
    ['Kỳ', `${i.program.startDate} → ${i.program.endDate}`],
    ['run_id (phiên kết quả)', run.id],
    ['Công bố lúc (VN)', vnTime(run.publishedAt)],
    ['Dữ liệu bán đến (VN)', vnTime(run.sourceMaxUpdatedAt)],
    ['Phạm vi số liệu', locked ? cmsLockedScopeNote(c) : cmsResultScopeNote(c)],
    ...(contractRun ? [
      ['Cách tính lượng (ghim theo phiên)', CMS_QUANTITY_BASIS_LABEL[c.quantityBasis]],
      ['Chính sách trả hàng (ghim theo phiên)', CMS_RETURNS_POLICY_LABEL[c.returnsPolicy]],
      ...(c.returnsAsOf ? [['Dữ liệu trả đến (VN)', vnTime(c.returnsAsOf)]] : []),
      ['Hợp đồng tính', `${c.calcContractVersion} · ${c.quantityPolicyVersion}${c.unitKeyVersion ? ` · ${c.unitKeyVersion}` : ''}`],
      ['Loại số liệu', locked && c.returnsPolicy === 'net_returns_v1' ? `${kindNote} (phiếu trả sau chốt xem ở báo cáo sau chốt, không sửa số này)` : kindNote],
      ['Định nghĩa lượng', c.quantityBasis === 'cms_unit'
        ? `SL tính CMS = floor(lượng cơ sở ĐỦ ĐIỀU KIỆN${netRun ? ' ròng' : ''} / K). Chỉ dòng bán đúng đơn vị CMS, số lượng nguyên được tính lượng; dòng khác đơn vị / số lẻ vẫn vào GMV.`
        : 'SL tính CMS = floor(lượng cơ sở ròng cộng dồn / K).'],
    ] as Cell[][] : []),
    ['config_version của phiên', run.configVersion],
    ['config_version hiện tại', i.header.configVersion],
    ['Phạm vi người xuất', i.scope === 'super' ? 'Toàn chương trình (super)' : 'Toàn chương trình trong phạm vi của bạn — nhà thuốc được phân công (SM)'],
    ['Định nghĩa', 'Dược sĩ có bán = lượng cơ sở thuần > 0 (kể cả chưa đủ 1 đơn vị CMS); SL tính CMS = số đơn vị CMS nguyên.'],
    ['Xuất lúc (VN)', vnTime(i.exportedAt.toISOString())],
    [`Tổng ${amtHead}`, cmsIntCell(sumRows)],
    // Run net: chi tiết là SỰ KIỆN (bán + trả, gồm dòng không tính lượng). Run sales-only: chỉ dòng BÁN ghi nhận (gồm dòng không tính
    // lượng) — không "bán + trả", không hàng trả 0. Legacy giữ nhãn cũ.
    ...(netRun
      ? [['Số sự kiện ghi nhận (dòng bán + dòng trả, gồm dòng không tính lượng)', i.lines.length], ['Trong đó dòng bán', nSale], ['Trong đó dòng trả hàng', i.lines.length - nSale]]
      : salesContract
        ? [['Số dòng bán ghi nhận (gồm dòng không tính lượng)', i.lines.length]]
        : [['Số dòng đơn được tính', i.lines.length]]) as Cell[][],
    ['Ghi chú', legacyCap
      ? `${kindNote}. Mỗi dược sĩ tính gate / bậc riêng; tổng không áp lại bậc. Phiên này theo cấu hình CŨ có trần số lượng (trước CMS-Q-220) — giữ đúng snapshot.`
      : `${kindNote}. Mỗi dược sĩ tính gate / bậc riêng; tổng không áp lại bậc. Bậc cuối không giới hạn số lượng.`],
  ])

  // Cùng helper với A3 / QLCH / D3 (PM P1-I3-1): dược sĩ có bán = lượng cơ sở thuần > 0 (nửa đơn vị CMS vẫn tính).
  const byPp = new Map([...cmsProductSalesStats(i.rows.results)].map(([k, x]) => [k, { base: x.baseUnits, q: x.cmsQuantity, gmv: x.gmvUnits, sold: x.staffWithSales, achieved: x.staffAchieved, amount: x.amountVnd }]))
  // P5.4: run NET thêm cột CUỐI (cột cũ giữ vị trí): K, đủ điều kiện, gộp / trả / số dòng trả. SL bán / GMV ở cột cũ = RÒNG.
  // Run sales-only (RC r2 SALES-RC-03): cột cũ là "SL bán / GMV" (chưa trừ trả), cột cuối chỉ K + đủ điều kiện.
  // "Dòng trả hàng" = số sự kiện trả theo item (PM P5-04) — một phiếu nhiều item là nhiều dòng; không gọi là số phiếu.
  const NET_PROD_COLS = ['K (cơ sở / 1 đv CMS)', 'SL đủ điều kiện (đv CMS)', 'SL bán gộp (đv CMS)', 'SL trả (đv CMS)', 'GMV bán gộp (VND)', 'GMV trả (VND)', 'Dòng trả hàng']
  // Sales-only: chỉ K + lượng đủ điều kiện (căn cứ Q tính nguyên); "gộp" / trả trùng hoặc bằng 0 ⇒ không xuất.
  const SALES_PROD_COLS = ['K (cơ sở / 1 đv CMS)', 'SL đủ điều kiện (đv CMS)']
  const extraProd = netRun ? NET_PROD_COLS : salesContract ? SALES_PROD_COLS : []
  const prodSheet: Cell[][] = [['ProductID', 'Tên sản phẩm', 'Loại điều kiện', 'Đơn vị CMS', netRun ? 'SL bán ròng (đv CMS)' : 'SL bán (đv CMS)', 'SL tính CMS', netRun ? 'GMV ròng (VND)' : 'GMV (VND)', 'Dược sĩ có bán', 'Dược sĩ đạt', amtHead,
    ...extraProd]]
  for (const p of i.products) {
    const a = byPp.get(p.id)
    const k = units(p.baseQuantityCms)
    const pr = i.rows.results.filter((r) => r.programProductId === p.id)
    const ns = netRun ? cmsNetSummary(pr) : null
    const elig = pr.reduce((s, r) => s + units(r.eligibleBase), BigInt(0))
    prodSheet.push([p.productId, p.nameSnapshot, GATE_LABEL[p.gmvBasis] ?? p.gmvBasis, p.unitCms,
      a ? cmsQtyText(a.base, k) : '0', a ? cmsIntCell(a.q) : 0, a ? cmsDecCell(formatCmsDecimal(a.gmv)) : 0,
      a?.sold ?? 0, a?.achieved ?? 0, a ? cmsIntCell(a.amount) : 0,
      ...(netRun ? [cmsDecCell(p.baseQuantityCms), cmsQtyText(elig, k), cmsQtyText(ns?.saleBase ?? BigInt(0), k), cmsQtyText(ns?.returnBase ?? BigInt(0), k),
        cmsDecCell(formatCmsDecimal(ns?.saleGmv ?? BigInt(0))), cmsDecCell(formatCmsDecimal(ns?.returnGmv ?? BigInt(0))), ns?.returnCount ?? 0]
        : salesContract ? [cmsDecCell(p.baseQuantityCms), cmsQtyText(elig, k)] : [])])
  }
  prodSheet.push(['Tổng', '', '', '', '', '', '', '', '', cmsIntCell(sumRows), ...extraProd.map(() => '')])
  add('Theo san pham', prodSheet)

  // CMS-Q-220: run mới không có trần ⇒ KHÔNG quảng bá cột "SL hưởng (sau trần)" / "Trần" / "Đạt trần". Chỉ phiên LỊCH SỬ có trần
  // (snapshot cũ đã đóng băng — legacyCap) mới xuất 3 cột đó để thể hiện đúng cấu hình của run, không tô lại thành luật mới.
  const staffSheet: Cell[][] = [['Dược sĩ', 'user_id', 'Nhà thuốc hiện tại', 'Nhà thuốc lúc bán', 'ProductID', 'Tên sản phẩm', netRun ? 'SL bán ròng (đv CMS)' : 'SL bán (đv CMS)', 'SL tính CMS',
    ...(legacyCap ? ['SL hưởng (sau trần)', 'Trần', 'Đạt trần'] : []),
    netRun ? 'GMV ròng (VND)' : 'GMV (VND)', 'Target (VND)', 'Đạt target', 'Đạt từ (VN)', 'CMS khi đạt (VND)', amtHead, contractRun ? 'Số dòng bán' : 'Số dòng',
    ...(netRun ? ['SL đủ điều kiện (đv CMS)', 'SL bán gộp (đv CMS)', 'SL trả (đv CMS)', 'GMV trả (VND)', 'Dòng trả hàng'] : salesContract ? ['SL đủ điều kiện (đv CMS)'] : [])]]
  const sorted = [...i.rows.results].sort((a, b) => (names.get(a.userId)?.fullName ?? '').localeCompare(names.get(b.userId)?.fullName ?? '', 'vi')
    || a.userId.localeCompare(b.userId) || (prod.get(a.programProductId)?.productId ?? '').localeCompare(prod.get(b.programProductId)?.productId ?? ''))
  for (const r of sorted) {
    const p = prod.get(r.programProductId)
    staffSheet.push([names.get(r.userId)?.fullName ?? '', r.userId, store(names.get(r.userId)?.storeId ?? null), store(r.storeId), r.productId, p?.nameSnapshot ?? '',
      cmsQtyText(units(r.baseQuantity), units(r.perUnit)), cmsIntCell(r.cmsQuantity),
      ...(legacyCap ? [cmsIntCell(r.rewardedQuantity), cmsIntCell(r.capQuantity), r.atCap ? 'Có' : 'Không'] : []),
      cmsDecCell(r.gmvAmount), cmsIntCell(r.targetGmv), r.gmvBasis === 'none' ? '' : r.gateMet ? 'Đạt' : 'Chưa đạt', vnTime(r.gateMetAt),
      cmsIntCell(r.potentialAmount), cmsIntCell(r.amountVnd), r.lineCount,
      ...(netRun ? [cmsQtyText(units(r.eligibleBase), units(r.perUnit)), cmsQtyText(units(r.net?.saleBase ?? '0'), units(r.perUnit)),
        cmsQtyText(units(r.net?.returnBase ?? '0'), units(r.perUnit)), cmsDecCell(r.net?.returnGmv ?? '0'), r.net?.returnCount ?? 0]
        : salesContract ? [cmsQtyText(units(r.eligibleBase), units(r.perUnit))] : [])])
  }
  add('Theo duoc si', staffSheet)

  // P5.4: run NET — mỗi dòng là SỰ KIỆN (bán / phiếu trả); lũy kế là lượng cơ sở ĐỦ ĐIỀU KIỆN; dòng trả mang số âm (CMS tính lại,
  // không phải tiền hoàn khách); thêm cột cuối Loại / Lớp lượng / Mã phiếu trả / Thay đổi đủ điều kiện.
  // Sales-only: mỗi dòng là một dòng BÁN ⇒ nhãn như legacy (Mã đơn / Hoàn tất / SL cơ sở / GMV / CMS dòng), giữ lũy kế ĐỦ ĐK + lớp lượng
  // + lượng cơ sở đủ ĐK của dòng (căn cứ tính nguyên); KHÔNG cột Loại / Mã phiếu trả (luôn "Bán" / rỗng).
  const lineSheet: Cell[][] = [[netRun ? 'seq sự kiện' : 'seq', netRun ? 'Mã đơn (gốc)' : 'Mã đơn', 'order_line_id', 'ProductID', 'Tên sản phẩm', 'Dược sĩ', 'Nhà thuốc lúc bán', 'POS', netRun ? 'Thời điểm (VN)' : 'Hoàn tất (VN)',
    'SL gốc', 'ĐVT gốc', netRun ? 'Thay đổi cơ sở' : 'SL cơ sở', netRun ? 'Thay đổi GMV (VND)' : 'GMV (VND)',
    contractRun ? 'Lũy kế cơ sở đủ ĐK trước' : 'Lũy kế cơ sở trước', contractRun ? 'Lũy kế cơ sở đủ ĐK sau' : 'Lũy kế cơ sở sau', 'SL CMS trước', 'SL CMS sau', 'Trạng thái', netRun ? 'Thay đổi CMS (VND)' : 'CMS dòng (VND)',
    ...(netRun ? ['Loại', 'Lớp lượng', 'Mã phiếu trả', 'Thay đổi cơ sở đủ ĐK'] : salesContract ? ['Lớp lượng', 'SL cơ sở đủ ĐK'] : [])]]
  for (const l of i.lines) {
    const p = prod.get(l.programProductId)
    lineSheet.push([l.seq, l.orderCode, l.orderLineId, l.productId, p?.nameSnapshot ?? '', names.get(l.userId)?.fullName ?? '', store(l.storeId), l.posCode,
      vnTime(l.completedAt), l.quantityRaw, l.uomRaw, cmsDecCell(l.baseQuantity), cmsDecCell(l.gmvAmount), cmsDecCell(l.baseBefore), cmsDecCell(l.baseAfter),
      cmsIntCell(l.qtyBefore), cmsIntCell(l.qtyAfter), CMS_LINE_LABEL[l.status], cmsIntCell(l.amountVnd),
      ...(netRun ? [l.kind === 'RETURN' ? 'Trả hàng' : 'Bán', CMS_QUANTITY_CLASS_LABEL[l.quantityClass], l.returnCode, cmsDecCell(l.eligibleDelta)]
        : salesContract ? [CMS_QUANTITY_CLASS_LABEL[l.quantityClass], cmsDecCell(l.eligibleDelta)] : [])])
  }
  add('Chi tiet dong', lineSheet)

  if (i.scope === 'super' && i.excluded) {
    const ex: Cell[][] = [['seq', 'Mã đơn', 'order_line_id', 'ProductID', 'Phân loại', 'Lý do', 'Email người bán (nguồn)', 'Nhà thuốc', 'POS', 'Hoàn tất (VN)', 'SL cơ sở', 'GMV (VND)']]
    for (const x of i.excluded) {
      ex.push([x.seq, x.orderCode, x.orderLineId, x.productId, DISPOSITION_LABEL[x.disposition] ?? x.disposition, x.unassignedReason, x.sellerEmail, store(x.storeId),
        x.posCode, vnTime(x.completedAt), cmsDecCell(x.baseQuantity), cmsDecCell(x.gmvAmount)])
    }
    add('Chua gan', ex)
  }
  if (i.scope === 'super' && contractRun && i.excludedQty) {
    const qx: Cell[][] = [['seq', 'Mã đơn', 'order_line_id', 'ProductID', 'Lớp lượng', 'SL gốc', 'ĐVT gốc', 'Nhà thuốc', 'POS', 'Hoàn tất (VN)', 'SL cơ sở', 'GMV (VND)']]
    for (const x of i.excludedQty) {
      const qc = x.quantityClass as keyof typeof CMS_QUANTITY_CLASS_LABEL | null | undefined
      qx.push([x.seq, x.orderCode, x.orderLineId, x.productId, qc && qc in CMS_QUANTITY_CLASS_LABEL ? CMS_QUANTITY_CLASS_LABEL[qc] : (x.quantityClass ?? ''),
        x.quantityRaw ?? null, x.uomRaw ?? null, store(x.storeId), x.posCode, vnTime(x.completedAt), cmsDecCell(x.baseQuantity), cmsDecCell(x.gmvAmount)])
    }
    add('Khong tinh luong', qx)
  }
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer)
  return { ok: true, bytes, lineCount: i.lines.length, amountVnd: sumRows }
}

// ── Handler (deps tiêm vào) ─────────────────────────────────────────────────
export type CmsReadErr = 'FORBIDDEN' | 'RUN_GONE' | 'TOO_LARGE' | 'BAD_INPUT' | 'QUERY_FAILED'
type Read<T> = { ok: true; data: T } | { ok: false; error: CmsReadErr }
export interface CmsExportDeps {
  session(): Promise<{ userId: string; role: string | null; email: string | null } | null>
  flags(): { program: boolean; earnings: boolean }
  access(role: string | null, email: string | null): { view: boolean; manage: boolean }
  program(id: string, manage: boolean): Promise<{ ok: true; data: { program: CmsExportInput['program'] & { status: string }; products: CmsExportProduct[] } | null } | { ok: false }>
  header(programId: string): Promise<Read<CmsResultHeaderDto>>
  rows(programId: string, runId: string): Promise<Read<CmsResultRowsDto>>
  lines(programId: string, runId: string, maxRows: number): Promise<Read<CmsResultLineDto[]>>
  /** kind 'quantity' (P5.4) chỉ gọi cho run contract (reader v2). */
  excluded(programId: string, runId: string, afterSeq: number | null, kind?: 'disposition' | 'quantity'): Promise<Read<CmsExcludedPage>>
  storeNames(ids: string[]): Promise<Map<string, string>>
  now(): Date
  returnsApproved: boolean
}

const json = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: code, message }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
const readFail = (e: CmsReadErr): Response =>
  e === 'RUN_GONE' ? json(409, 'RUN_CHANGED', 'Dữ liệu đã thay đổi — tải lại trang rồi xuất lại.')
    : e === 'FORBIDDEN' ? json(404, 'NOT_FOUND', 'Không tìm thấy chương trình.')
      : e === 'TOO_LARGE' ? json(413, 'TOO_LARGE', 'Kết quả vượt giới hạn xuất — không xuất thiếu dòng.')
        : e === 'BAD_INPUT' ? json(400, 'BAD_REQUEST', 'Tham số không hợp lệ.')
          : json(500, 'QUERY_FAILED', 'Không tải được số liệu CMS.')

export async function handleCmsResultExport(req: Request, deps: CmsExportDeps): Promise<Response> {
  const s = await deps.session()
  if (!s) return json(401, 'UNAUTHENTICATED', 'Chưa đăng nhập.')
  const f = deps.flags()
  const acc = deps.access(s.role, s.email)
  if (!f.program || !f.earnings || !acc.view) return json(403, 'FORBIDDEN', 'Không có quyền xuất dữ liệu.')
  const url = new URL(req.url)
  const programId = url.searchParams.get('program') ?? ''
  const runId = url.searchParams.get('run') ?? ''
  if (!UUID_RE.test(programId) || !UUID_RE.test(runId)) return json(400, 'BAD_REQUEST', 'Tham số không hợp lệ.')
  const prog = await deps.program(programId, acc.manage)
  if (!prog.ok) return json(500, 'QUERY_FAILED', 'Không tải được chương trình.')
  if (!prog.data) return json(404, 'NOT_FOUND', 'Không tìm thấy chương trình.')
  const header = await deps.header(programId)
  if (!header.ok) return readFail(header.error)
  if (!header.data.run || header.data.run.id !== runId) return readFail('RUN_GONE')
  const rows = await deps.rows(programId, runId)
  if (!rows.ok) return readFail(rows.error)
  if (rows.data.runId !== runId) return readFail('RUN_GONE')
  const lines = await deps.lines(programId, runId, CMS_EXPORT_MAX_LINES)
  if (!lines.ok) return readFail(lines.error)
  let excluded: CmsExcludedLineDto[] | null = null
  let excludedQty: CmsExcludedLineDto[] | null = null
  const readAllExcluded = async (kind: 'disposition' | 'quantity'): Promise<CmsExcludedLineDto[] | Response> => {
    const out: CmsExcludedLineDto[] = []
    let after: number | null = null
    for (;;) {
      const page = await deps.excluded(programId, runId, after, kind)
      if (!page.ok) return readFail(page.error)
      if (page.data.runId !== runId) return readFail('RUN_GONE')
      out.push(...page.data.rows)
      if (out.length > CMS_EXPORT_MAX_EXCLUDED) return readFail('TOO_LARGE')
      if (page.data.nextAfterSeq === null) return out
      after = page.data.nextAfterSeq
    }
  }
  if (acc.manage) {
    const ex = await readAllExcluded('disposition')
    if (ex instanceof Response) return ex
    excluded = ex
    if (!header.data.run.contract.legacy) {
      const qx = await readAllExcluded('quantity')
      if (qx instanceof Response) return qx
      excludedQty = qx
    }
  }
  const storeIds = [...rows.data.results.map((r) => r.storeId), ...rows.data.users.flatMap((u) => (u.storeId ? [u.storeId] : [])),
    ...lines.data.map((l) => l.storeId), ...[...(excluded ?? []), ...(excludedQty ?? [])].flatMap((x) => (x.storeId ? [x.storeId] : []))]
  const built = buildCmsResultWorkbook({
    program: prog.data.program, header: header.data, rows: rows.data, lines: lines.data, excluded, excludedQty, products: prog.data.products,
    storeNames: await deps.storeNames([...new Set(storeIds)]), exportedAt: deps.now(), scope: acc.manage ? 'super' : 'sm', returnsApproved: deps.returnsApproved,
  })
  if (!built.ok) {
    if (built.error === 'RUN_MISMATCH') return readFail('RUN_GONE')
    if (built.error === 'RETURNS_HOLD') return json(409, 'RETURNS_HOLD', 'Có dòng điều chỉnh trả hàng chưa được công bố (trả hàng phase sau — Q-206) — không xuất.')
    return json(500, built.error, 'Số dòng / tổng tiền không khớp — không xuất file thiếu.')
  }
  // Vết kiểm toán (security review I3 P2-1): ai xuất phiên nào, bao nhiêu dòng — chỉ id / số đếm, không email / tên / tiền.
  console.info(`[cms-export] OK user=${s.userId} program=${programId} run=${runId} scope=${acc.manage ? 'super' : 'sm'} lines=${built.lineCount} excluded=${excluded?.length ?? 0}${excludedQty ? ` excluded_qty=${excludedQty.length}` : ''}`)
  const stamp = new Date(deps.now().getTime() + 7 * 3600_000).toISOString().slice(0, 16).replace(/[-:T]/g, '')
  return new Response(built.bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cms-ket-qua-${programId.slice(0, 8)}-${stamp}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
