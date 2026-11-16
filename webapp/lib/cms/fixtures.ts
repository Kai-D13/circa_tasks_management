// CMS P1-c — dữ liệu GIẢ cho fixture /ui-catalog/cms-v2 (dev-only, UI_CATALOG=1). CMS-UI-1 (PM 04/11 §6): mọi chương trình /
// SP / lần import đến từ MỘT kịch bản (lib/cms/fixtureScenario — dòng bán giả ⇒ engine thật). Danh sách A1 = chi tiết A3 = D1:
// số SP của chương trình = số SP trong danh mục, lần import khớp từng chương trình. ProductID giả 9xxxxx, không tên người /
// nhà thuốc thật, không ảnh CDN thật (ảnh dự phòng chữ cái đầu — fixture không gọi mạng ngoài).
import type { CmsProgramDetail } from '@/lib/cms/server/catalog'
import type { CmsPreviewKResult, CmsPreviewResult } from '@/lib/cms/importView'
import { CMS_FX_PG, CMS_FX_PG_SIMPLE, CMS_FX_TODAY, cmsFxDay, cmsFxDetailOf, cmsFxListItems, cmsFxProgram, cmsFxUid, type CmsFxProgram } from './fixtureScenario'

export { CMS_FX_TODAY }
const pg = (id: string): CmsFxProgram => { const p = cmsFxProgram(id); if (!p) throw new Error('fx program'); return p }

export const CMS_FX_LIST = cmsFxListItems()
/** SP của chương trình chính (PG1 — Vitamin, đang chạy). */
export const CMS_FX_PRODUCTS = pg(CMS_FX_PG.PG1).products

/**
 * A3 theo trạng thái (P1 / P3a). `running` = PG1 · `upcoming` = PG2 · `draft-empty` = PG3 · `ended` = PG8 (QA hết kỳ) · `locked` =
 * PG9 (QA đã chốt) — đều là chương trình có trong danh sách A1. `draft` / `retro` = PG1 TRƯỚC khi kích hoạt (cùng id / danh mục /
 * cấu hình, chỉ lùi trạng thái + ngày) để xem nút Sửa / Nạp lại / Kích hoạt và hộp xác nhận hồi tố.
 */
export function cmsFxDetail(kind: 'draft' | 'draft-empty' | 'running' | 'upcoming' | 'retro' | 'ended' | 'locked'): CmsProgramDetail {
  if (kind === 'upcoming') return cmsFxDetailOf(pg(CMS_FX_PG.PG2))
  if (kind === 'draft-empty') return cmsFxDetailOf(pg(CMS_FX_PG.PG3))
  if (kind === 'ended') return cmsFxDetailOf(pg(CMS_FX_PG.PG8))
  if (kind === 'locked') return cmsFxDetailOf(pg(CMS_FX_PG.PG9))
  const d = cmsFxDetailOf(pg(CMS_FX_PG.PG1))
  if (kind === 'running') return d
  return {
    ...d, storeCount: 0, storeNames: null,
    program: { ...d.program, status: 'draft', activatedAt: null, startDate: kind === 'retro' ? cmsFxDay(-3) : cmsFxDay(16), endDate: kind === 'retro' ? cmsFxDay(27) : cmsFxDay(46) },
  }
}

const P1 = CMS_FX_PRODUCTS
/** Kết quả "Kiểm tra file" (A2) — nhóm hợp lệ là 3 SP đầu của PG1 (cùng tên / quy cách / bậc), 2 nhóm lỗi mẫu. */
export const CMS_FX_PREVIEW: CmsPreviewResult = {
  ok: true, runId: cmsFxUid(9100), sha256: 'a'.repeat(64), mode: 'replace', configVersion: 1, catalogTarget: '1500000', ignoredFromRow: 48,
  stats: { rowsTotal: 8, rowsOk: 5, rowsRejected: 3, productsOk: 3, productsRejected: 2, warnings: 2 },
  groupsOk: [
    { productId: P1[0].productId, gmvBasis: P1[0].gmvBasis, targetGmv: P1[0].targetGmv, unitCms: P1[0].unitCms, baseQuantityCms: P1[0].baseQuantityCms, nameSnapshot: P1[0].nameSnapshot, imageUrlSnapshot: null, priceSnapshot: P1[0].priceSnapshot, tiers: P1[0].tiers, excelRows: [5, 6, 7], warnings: [], advicePreview: P1[0].adviceText },
    { productId: P1[1].productId, gmvBasis: P1[1].gmvBasis, targetGmv: null, unitCms: P1[1].unitCms, baseQuantityCms: P1[1].baseQuantityCms, nameSnapshot: P1[1].nameSnapshot, imageUrlSnapshot: null, priceSnapshot: P1[1].priceSnapshot, tiers: P1[1].tiers, excelRows: [8], warnings: [{ excelRow: 8, column: 'ProductID', code: 'IMAGE_MISSING', message: 'Sản phẩm chưa có ảnh trên Product Master', fix: 'Vẫn nạp; ảnh dự phòng sẽ hiển thị' }], advicePreview: P1[1].adviceText },
    { productId: P1[2].productId, gmvBasis: P1[2].gmvBasis, targetGmv: null, unitCms: P1[2].unitCms, baseQuantityCms: P1[2].baseQuantityCms, nameSnapshot: P1[2].nameSnapshot, imageUrlSnapshot: null, priceSnapshot: P1[2].priceSnapshot, tiers: P1[2].tiers, excelRows: [9], warnings: [{ excelRow: 9, column: 'ProductID', code: 'IMAGE_NOT_ALLOWED', message: 'Ảnh sản phẩm ngoài nguồn được duyệt', fix: 'Vẫn nạp; báo operator kiểm nguồn ảnh' }], advicePreview: P1[2].adviceText },
  ],
  groupsRejected: [
    { key: '900009', excelRows: [10, 11], errors: [{ excelRow: 10, column: 'ProductID', code: 'PRODUCT_NOT_FOUND', message: 'ProductID không có trên Product Master', fix: 'Kiểm tra lại mã hoặc chờ Product Master đồng bộ' }] },
    { key: 'raw:SKU-ABC', excelRows: [12], errors: [{ excelRow: 12, column: 'ProductID', code: 'PRODUCT_ID_INVALID', message: 'ProductID phải là số nguyên dương (mã product_id trên POS)', fix: 'Nhập đúng ProductID dạng số, không dùng SKU / mã hàng' }] },
  ],
}

// ── CMS đơn giản S1 / S2 (PM r1 08/11 §4–§5) — kết quả kiểm file MỨC CỐ ĐỊNH + kiểm K đủ trạng thái (dữ liệu giả, SP của PG10) ──
const S = pg(CMS_FX_PG_SIMPLE.PG10).products
const ok = (i: number, rows: number[], warnings: CmsPreviewResult['groupsOk'][number]['warnings'] = []): CmsPreviewResult['groupsOk'][number] => ({
  productId: S[i].productId, gmvBasis: 'none', targetGmv: null, unitCms: S[i].unitCms, baseQuantityCms: S[i].baseQuantityCms, nameSnapshot: S[i].nameSnapshot,
  imageUrlSnapshot: null, priceSnapshot: S[i].priceSnapshot, tiers: S[i].tiers, excelRows: rows, warnings, advicePreview: S[i].adviceText,
})
const kr = (i: number, status: CmsPreviewKResult['status'], o: Partial<CmsPreviewKResult> = {}): CmsPreviewKResult => ({
  productId: S[i].productId, unit: 'hộp', k: S[i].baseQuantityCms, status, proposedK: null, seen: [], note: '', ack: null,
  ok: status === 'MATCH', ...o,
})
const KIS = (row: number, code: string, message: string, fix: string) => ({ excelRow: row, column: 'base_quantity_CMS', code, message, fix })
/** fx=result-simple: 2 SP ghi được (KHỚP · đã xác nhận tay), 4 SP chặn (đề xuất K · lệch · chưa có bằng chứng · nguồn lỗi). */
export const CMS_FX_PREVIEW_SIMPLE: CmsPreviewResult = {
  ok: true, runId: cmsFxUid(9101), sha256: 'b'.repeat(64), mode: 'replace', configVersion: 1, catalogTarget: null, ignoredFromRow: null, format: 'simple',
  supplement: { baseQuantity: true, advice: true },
  stats: { rowsTotal: 6, rowsOk: 2, rowsRejected: 4, productsOk: 2, productsRejected: 4, warnings: 1 },
  groupsOk: [
    ok(0, [2]),
    ok(5, [7], [{ excelRow: 7, column: 'ProductID', code: 'NAME_DIFFERS_MASTER', message: 'Tên trong file khác tên trên Product Master', fix: 'Vẫn nạp; tên / ảnh / giá hiển thị theo Product Master — kiểm lại ProductID' }]),
  ],
  groupsRejected: [
    { key: S[1].productId, excelRows: [3], errors: [
      { excelRow: 3, column: 'base_quantity_CMS', code: 'BASE_QTY_REQUIRED', message: 'Thiếu base_quantity_CMS', fix: 'Nhập số đơn vị cơ sở tương ứng 1 đơn vị CMS' },
      KIS(3, 'K_PROPOSED', 'Kiểm K — ĐỀ XUẤT K: Theo 6 dòng bán "hộp": 1 hộp = 1 · đề xuất K = 1', 'Nếu đúng, nhập K đề xuất vào base_quantity_CMS rồi kiểm tra lại (hệ thống không tự điền)'),
    ] },
    { key: S[2].productId, excelRows: [4], errors: [KIS(4, 'K_MISMATCH', 'Kiểm K — LỆCH: POS: 1 hộp = 10; file K = 12', 'Sửa base_quantity_CMS theo quy đổi POS hoặc kiểm lại đơn vị CMS — không xác nhận tay được')] },
    { key: S[3].productId, excelRows: [5], errors: [KIS(5, 'K_NO_EVIDENCE', 'Kiểm K — CHƯA CÓ BẰNG CHỨNG: Chưa có dòng bán', 'Super xác nhận K kèm nguồn căn cứ (vd. quy cách nhà cung cấp) ở bước kiểm tra')] },
    { key: S[4].productId, excelRows: [6], errors: [KIS(6, 'K_SOURCE_ERROR', 'Kiểm K — NGUỒN LỖI: "hộp" có dòng không tính được tỷ lệ', 'Nguồn bán có dòng lỗi — làm việc với BI; không xác nhận tay được')] },
  ],
  kCheck: {
    asOf: '2026-11-15T02:00:00.000Z', available: true, reason: null,
    products: [
      kr(0, 'MATCH', { note: 'Theo 9 dòng bán "hộp"', seen: [{ unit: 'hộp', ratio: '30', lines: 9 }] }),
      kr(1, 'PROPOSED', { k: null, proposedK: '1', note: 'Theo 6 dòng bán "hộp": 1 hộp = 1', seen: [{ unit: 'hộp', ratio: '1', lines: 6 }] }),
      kr(2, 'MISMATCH', { k: '12', note: 'POS: 1 hộp = 10; file K = 12', seen: [{ unit: 'hộp', ratio: '10', lines: 4 }] }),
      kr(3, 'NO_EVIDENCE', { note: 'Chưa có dòng bán' }),
      kr(4, 'SOURCE_ERROR', { note: '"hộp" có dòng không tính được tỷ lệ', seen: [{ unit: 'hộp', ratio: null, lines: 3 }] }),
      kr(5, 'NO_EVIDENCE', { note: 'Chưa bán theo "hộp" (đã bán: lon)', seen: [{ unit: 'lon', ratio: '1', lines: 2 }], ack: { source: 'Quy cách nhà cung cấp (mẫu)', at: '2026-11-15T02:01:00.000Z' }, ok: true }),
    ],
  },
}
/** fx=result-simple-unavailable: không đọc được dữ liệu bán ⇒ mọi SP KHÔNG KIỂM ĐƯỢC (có K ⇒ được xác nhận tay), 0 ghi được. */
export const CMS_FX_PREVIEW_SIMPLE_UNAVAILABLE: CmsPreviewResult = {
  ...CMS_FX_PREVIEW_SIMPLE, runId: cmsFxUid(9102), groupsOk: [],
  stats: { rowsTotal: 2, rowsOk: 0, rowsRejected: 2, productsOk: 0, productsRejected: 2, warnings: 0 },
  groupsRejected: [0, 5].map((i) => ({ key: S[i].productId, excelRows: [i + 2], errors: [KIS(i + 2, 'K_UNAVAILABLE', 'Kiểm K — KHÔNG KIỂM ĐƯỢC: Không đọc được nguồn bán để đối chiếu K', 'Thử kiểm tra lại sau, hoặc super xác nhận K kèm nguồn căn cứ')] })),
  kCheck: { asOf: null, available: false, reason: 'SOURCE_TIMEOUT', products: [0, 5].map((i) => kr(i, 'UNAVAILABLE', { note: 'Không đọc được nguồn bán để đối chiếu K' })) },
}
// ── UX-KACK-1 (PM 15/11 §4) — file mức cố định 83 SP GIẢ (ProductID 9183xx, không tên / tiền / PII thật) ───────────────────────
// 48 KHỚP + 2 đã xác nhận tay (ghi được) · 18 CHƯA CÓ BẰNG CHỨNG chỉ lỗi K (xác nhận tay được) · 6 LỆCH + 4 NGUỒN LỖI (không xác nhận
// được) · 3 ĐỀ XUẤT K (thiếu K ⇒ lỗi file) · 2 CHƯA CÓ BẰNG CHỨNG kèm lỗi tư vấn (xác nhận K chưa đủ để ghi).
const K83_N = 83
const k83Id = (i: number) => `9183${String(i).padStart(2, '0')}`
type K83Kind = 'MATCH' | 'ACKED' | 'NO_EVIDENCE' | 'MISMATCH' | 'SOURCE_ERROR' | 'PROPOSED' | 'NO_EVIDENCE_FILE' | 'ACKED_FILE'
const k83Kind = (i: number): K83Kind =>
  i < 48 ? 'MATCH' : i < 50 ? 'ACKED' : i < 68 ? 'NO_EVIDENCE' : i < 74 ? 'MISMATCH' : i < 78 ? 'SOURCE_ERROR' : i < 81 ? 'PROPOSED' : 'NO_EVIDENCE_FILE'
const k83Ok = (i: number): CmsPreviewResult['groupsOk'][number] => ({
  productId: k83Id(i), gmvBasis: 'none', targetGmv: null, unitCms: 'hộp', baseQuantityCms: '10', nameSnapshot: `Sản phẩm mẫu K83 số ${i + 1}`,
  imageUrlSnapshot: null, priceSnapshot: null, tiers: [{ order: 1, from: 1, to: null, amount: '5000' }], excelRows: [i + 2], warnings: [],
  advicePreview: 'Nội dung tư vấn mẫu',
})
const K83_ACK_AT = '2026-11-16T02:00:00.000Z'
function k83Row(i: number, kind: K83Kind, ackSource: string | null = null): CmsPreviewKResult {
  const base: CmsPreviewKResult = { productId: k83Id(i), unit: 'hộp', k: '10', status: 'MATCH', proposedK: null, seen: [], note: '', ack: null, ok: false }
  if (kind === 'MATCH') return { ...base, note: 'Theo 4 dòng bán "hộp" (từng cặp lượng gốc)', seen: [{ unit: 'hộp', ratio: '10', lines: 4 }], ok: true }
  if (kind === 'ACKED' || kind === 'ACKED_FILE') return { ...base, status: 'NO_EVIDENCE', note: 'Chưa có dòng bán', ack: { source: ackSource ?? 'Quy cách nhà cung cấp (mẫu)', at: K83_ACK_AT }, ok: true }
  if (kind === 'NO_EVIDENCE' || kind === 'NO_EVIDENCE_FILE') return { ...base, status: 'NO_EVIDENCE', note: i % 2 ? 'Chưa có dòng bán' : 'Chưa bán theo "hộp" (đã bán: vỉ)' }
  if (kind === 'MISMATCH') return { ...base, status: 'MISMATCH', k: '12', note: 'POS: 1 hộp = 10; file K = 12', seen: [{ unit: 'hộp', ratio: '10', lines: 3 }] }
  if (kind === 'SOURCE_ERROR') return { ...base, status: 'SOURCE_ERROR', note: '"hộp" có 1 dòng không tính được tỷ lệ', seen: [{ unit: 'hộp', ratio: null, lines: 2 }] }
  return { ...base, status: 'PROPOSED', k: null, proposedK: '10', note: 'Theo 5 dòng bán "hộp": 1 hộp = 10', seen: [{ unit: 'hộp', ratio: '10', lines: 5 }] }
}
const k83Rejected = (i: number, kind: K83Kind): CmsPreviewResult['groupsRejected'][number] => {
  const r = i + 2
  const errors = kind === 'NO_EVIDENCE' ? [KIS(r, 'K_NO_EVIDENCE', 'Kiểm K — CHƯA CÓ BẰNG CHỨNG: Chưa có dòng bán', 'Super xác nhận K kèm nguồn căn cứ (vd. quy cách nhà cung cấp) ở bước kiểm tra')]
    : kind === 'MISMATCH' ? [KIS(r, 'K_MISMATCH', 'Kiểm K — LỆCH: POS: 1 hộp = 10; file K = 12', 'Sửa base_quantity_CMS theo quy đổi POS hoặc kiểm lại đơn vị CMS — không xác nhận tay được')]
    : kind === 'SOURCE_ERROR' ? [KIS(r, 'K_SOURCE_ERROR', 'Kiểm K — NGUỒN LỖI: "hộp" có 1 dòng không tính được tỷ lệ', 'Nguồn bán có dòng lỗi — làm việc với BI; không xác nhận tay được')]
    : kind === 'PROPOSED' ? [
      { excelRow: r, column: 'base_quantity_CMS', code: 'BASE_QTY_REQUIRED', message: 'Thiếu base_quantity_CMS', fix: 'Nhập số đơn vị cơ sở tương ứng 1 đơn vị CMS' },
      KIS(r, 'K_PROPOSED', 'Kiểm K — ĐỀ XUẤT K: Theo 5 dòng bán "hộp": 1 hộp = 10 · đề xuất K = 10', 'Nếu đúng, nhập K đề xuất vào base_quantity_CMS rồi kiểm tra lại (hệ thống không tự điền)')]
    : kind === 'ACKED_FILE' ? [{ excelRow: r, column: 'Noi_dung_tu_van', code: 'ADVICE_REQUIRED', message: 'Thiếu nội dung tư vấn', fix: 'Nhập nội dung tư vấn đã kiểm duyệt' }]
    : [
      { excelRow: r, column: 'Noi_dung_tu_van', code: 'ADVICE_REQUIRED', message: 'Thiếu nội dung tư vấn', fix: 'Nhập nội dung tư vấn đã kiểm duyệt' },
      KIS(r, 'K_NO_EVIDENCE', 'Kiểm K — CHƯA CÓ BẰNG CHỨNG: Chưa có dòng bán', 'Super xác nhận K kèm nguồn căn cứ (vd. quy cách nhà cung cấp) ở bước kiểm tra')]
  return { key: k83Id(i), excelRows: [r], errors }
}
function k83Preview(runNo: number, kinds: (i: number) => K83Kind, ackSource: string | null = null): CmsPreviewResult {
  const idx = Array.from({ length: K83_N }, (_, i) => i)
  const okIdx = idx.filter((i) => kinds(i) === 'MATCH' || kinds(i) === 'ACKED')
  const rej = idx.filter((i) => !okIdx.includes(i))
  return {
    ok: true, runId: cmsFxUid(runNo), sha256: 'c'.repeat(64), mode: 'replace', configVersion: 1, catalogTarget: null, ignoredFromRow: null, format: 'simple',
    supplement: { baseQuantity: true, advice: true },
    stats: { rowsTotal: K83_N, rowsOk: okIdx.length, rowsRejected: rej.length, productsOk: okIdx.length, productsRejected: rej.length, warnings: 0 },
    groupsOk: okIdx.map(k83Ok),
    groupsRejected: rej.map((i) => k83Rejected(i, kinds(i))),
    kCheck: { asOf: '2026-11-16T01:55:00.000Z', available: true, reason: null, products: idx.map((i) => k83Row(i, kinds(i), (kinds(i) === 'ACKED' || kinds(i) === 'ACKED_FILE') && i >= 50 ? ackSource : null)) },
  }
}
/** fx=result-k83*: kết quả kiểm 83 SP (xem chú thích trên). */
export const CMS_FX_PREVIEW_K83: CmsPreviewResult = k83Preview(9183, k83Kind)
/**
 * Kết quả MÔ PHỎNG sau "Kiểm tra lại với xác nhận" thành công (chọn cả 20): 17 / 18 SP chỉ lỗi K được gắn xác nhận ⇒ ghi được; SP 918367
 * đổi sang LỆCH ở lần kiểm này ⇒ không áp; 918381 / 918382 được gắn xác nhận nhưng vẫn bị loại vì thiếu nội dung tư vấn.
 */
export const CMS_FX_PREVIEW_K83_ACKED: CmsPreviewResult = k83Preview(9184,
  (i) => (i >= 50 && i < 67 ? 'ACKED' : i === 67 ? 'MISMATCH' : i >= 81 ? 'ACKED_FILE' : k83Kind(i)), 'Quy cách NCC (mẫu, nguồn chung)')
export const CMS_FX_K83_ID = k83Id

// ── KACK-LAYOUT-01 (PM 16/11 run3) — chỉ dòng ĐÃ XÁC NHẬN TAY (ProductID 9185xx giả): nguồn ngắn · nguồn dài có khoảng trắng · chuỗi liền
// không khoảng trắng; một bản CHƯA CÓ BẰNG CHỨNG (đọc được dữ liệu bán) + một bản KHÔNG KIỂM ĐƯỢC (không đọc được). Kiểm nhãn trạng thái
// + nguồn hiển thị đủ, không bị cắt / chồng ở thẻ mobile và lưới desktop. Nguồn ≤ CMS_K_ACK_SOURCE_MAX_CLIENT (200).
export const CMS_FX_K_ACK_LONG_SOURCES = [
  'Quy cách nhà cung cấp (mẫu)',
  'Quy cách nhà cung cấp theo hợp đồng mẫu số 01/2026: 1 hộp = 10 vỉ, đối chiếu cột SL quy đổi trên POS và phiếu nhập kho mẫu tháng 11 (dữ liệu giả)',
  `https://ncc-mau.example.invalid/quy-cach/${'HOP10VI-'.repeat(19)}END-200`, // chuỗi liền ĐÚNG 200 ký tự (trần client)
] as const
const kAckLongId = (i: number) => `9185${String(i).padStart(2, '0')}`
function kAckLongPreview(runNo: number, status: 'NO_EVIDENCE' | 'UNAVAILABLE'): CmsPreviewResult {
  const idx = CMS_FX_K_ACK_LONG_SOURCES.map((_, i) => i)
  const unavailable = status === 'UNAVAILABLE'
  return {
    ok: true, runId: cmsFxUid(runNo), sha256: 'd'.repeat(64), mode: 'replace', configVersion: 1, catalogTarget: null, ignoredFromRow: null, format: 'simple',
    supplement: { baseQuantity: true, advice: true },
    stats: { rowsTotal: idx.length, rowsOk: idx.length, rowsRejected: 0, productsOk: idx.length, productsRejected: 0, warnings: 0 },
    groupsOk: idx.map((i) => ({ ...k83Ok(i), productId: kAckLongId(i), nameSnapshot: `Sản phẩm mẫu xác nhận tay số ${i + 1}` })),
    groupsRejected: [],
    kCheck: {
      asOf: unavailable ? null : '2026-11-16T01:55:00.000Z', available: !unavailable, reason: unavailable ? 'SOURCE_TIMEOUT' : null,
      products: idx.map((i) => ({
        productId: kAckLongId(i), unit: 'hộp', k: '10', status, proposedK: null, seen: [],
        note: unavailable ? 'Không đọc được nguồn bán để đối chiếu K' : 'Chưa có dòng bán', ack: { source: CMS_FX_K_ACK_LONG_SOURCES[i], at: K83_ACK_AT }, ok: true,
      })),
    },
  }
}
/** fx=result-k-ack-long: 3 SP CHƯA CÓ BẰNG CHỨNG · ĐÃ XÁC NHẬN TAY (nguồn ngắn / dài / chuỗi liền). */
export const CMS_FX_PREVIEW_K_ACK_LONG: CmsPreviewResult = kAckLongPreview(9185, 'NO_EVIDENCE')
/** fx=result-k-ack-long-unavailable: như trên nhưng KHÔNG KIỂM ĐƯỢC · ĐÃ XÁC NHẬN TAY (không đọc được dữ liệu bán). */
export const CMS_FX_PREVIEW_K_ACK_LONG_UNAVAILABLE: CmsPreviewResult = kAckLongPreview(9186, 'UNAVAILABLE')
export const CMS_FX_K_ACK_LONG_ID = kAckLongId

/** fx=result-simple-nok: file 7 cột chưa có cột K / tư vấn ⇒ đọc được, 0 ghi được. */
export const CMS_FX_PREVIEW_SIMPLE_NOSUPP: CmsPreviewResult = {
  ...CMS_FX_PREVIEW_SIMPLE, runId: cmsFxUid(9103), groupsOk: [], supplement: { baseQuantity: false, advice: false },
  stats: { rowsTotal: 2, rowsOk: 0, rowsRejected: 2, productsOk: 0, productsRejected: 2, warnings: 0 },
  groupsRejected: [0, 1].map((i) => ({ key: S[i].productId, excelRows: [i + 2], errors: [
    { excelRow: i + 2, column: 'Noi_dung_tu_van', code: 'ADVICE_REQUIRED', message: 'Thiếu nội dung tư vấn', fix: 'Nhập nội dung tư vấn đã kiểm duyệt' },
    { excelRow: i + 2, column: 'base_quantity_CMS', code: 'BASE_QTY_REQUIRED', message: 'Thiếu base_quantity_CMS', fix: 'Nhập số đơn vị cơ sở tương ứng 1 đơn vị CMS' },
  ] })),
  kCheck: { asOf: '2026-11-15T02:00:00.000Z', available: true, reason: null, products: [kr(0, 'PROPOSED', { k: null, proposedK: '30', note: 'Theo 9 dòng bán "hộp": 1 hộp = 30' }), kr(1, 'PROPOSED', { k: null, proposedK: '1', note: 'Theo 6 dòng bán "hộp": 1 hộp = 1' })] },
}
