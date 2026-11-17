// Fixture /ui-catalog (dữ liệu GIẢ, ProductID 9187xx / 9188xx, người dùng "Dược sĩ mẫu") cho F-A (sửa chương trình) + F-B / F-C (lỗi loại
// file, tóm tắt lỗi). Tóm tắt lỗi dẫn xuất bằng ĐÚNG hàm của server (cmsImportIssueSummary) từ nhóm lỗi giả — không tự dựng số.
// Chỉ kiểu được import từ module server (impact.ts) ⇒ an toàn cho trang fixture.
import { cmsImportIssueSummary } from '@/lib/cms/import/issueSummary'
import type { CmsPreviewGroupOk, CmsPreviewGroupRejected, CmsPreviewResult, CmsRouteError } from '@/lib/cms/importView'
import type { CmsRevisionImpact, CmsRevisionImpactPerson, CmsRevisionSourceIdentity } from './impact'
import type { CmsRevisionCommitReply, CmsRevisionDiff, CmsRevisionDiffItem, CmsRevisionTier } from './model'
import type { CmsRevisionArchivePage, CmsRevisionDetail, CmsRevisionListItem } from './history'
import type { CmsRevisionAnalysis, CmsRevisionErrorBody, CmsRevisionPreviewBody } from './view'

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T = (amount: string): CmsRevisionTier[] => [{ order: 1, from: 1, to: null, amount }]
const T2 = (a: string, b: string): CmsRevisionTier[] => [{ order: 1, from: 1, to: 9, amount: a }, { order: 2, from: 10, to: null, amount: b }]

export const CMS_FX_REV_PROGRAM = { id: uid(9187), name: 'CMS sản phẩm mẫu tháng 11 (83 SP giả)' }

// ── F-C: ca thật thu nhỏ — 83 SP, 64 ô K là công thức + 83 dòng có Loai_CMS_GMV nhưng thiếu target (cả hai cùng hiện) ──
const K_FORMULA = { column: 'base_quantity_CMS', code: 'CELL_FORMULA', message: 'Ô có công thức — không đọc được', fix: 'Nhập giá trị trực tiếp (số hoặc chữ), không dùng công thức' }
const NO_TARGET = { column: 'KPI_Target_GMV_VND', code: 'GATE_MISSING_TARGET', message: 'Có loại CMS GMV nhưng thiếu target',
  fix: 'Nếu chương trình không xét target: để trống cả hai cột KPI_Target_GMV_VND và Loai_CMS_GMV; nếu có target: nhập KPI_Target_GMV_VND hợp lệ' }
const P83 = Array.from({ length: 83 }, (_, i) => `9187${String(i + 1).padStart(2, '0')}`)
const REJ83: CmsPreviewGroupRejected[] = P83.map((pid, i) => {
  const row = i + 2
  const errors = [...(i < 64 ? [{ excelRow: row, ...K_FORMULA }] : []), { excelRow: row, ...NO_TARGET }]
  return { key: pid, excelRows: [row], errors }
})
export const CMS_FX_ISSUES_83 = cmsImportIssueSummary(REJ83)

/** fx=result-issues (wizard): file 9 cột thật thu nhỏ — 0 SP hợp lệ, tóm tắt 64 + 83 cùng hiện. */
export function cmsFxPreviewIssues(base: CmsPreviewResult): CmsPreviewResult {
  return {
    ...base, runId: uid(9190), sha256: 'c'.repeat(64), ignoredFromRow: null, catalogTarget: null, groupsOk: [], groupsRejected: REJ83,
    stats: { rowsTotal: 83, rowsOk: 0, rowsRejected: 83, productsOk: 0, productsRejected: 83, warnings: 0 }, issueSummary: CMS_FX_ISSUES_83,
  }
}
/** fx=result-issues-partial: vài SP hợp lệ + nhiều loại lỗi ⇒ ghi một phần phải tick xác nhận (không tick sẵn). */
export function cmsFxPreviewIssuesPartial(base: CmsPreviewResult): CmsPreviewResult {
  const rej = REJ83.slice(60, 70)
  return { ...base, runId: uid(9191), sha256: 'd'.repeat(64), ignoredFromRow: null, groupsRejected: [...base.groupsRejected, ...rej],
    stats: { ...base.stats, rowsTotal: base.stats.rowsTotal + rej.length, rowsRejected: base.stats.rowsRejected + rej.length, productsRejected: base.stats.productsRejected + rej.length },
    issueSummary: cmsImportIssueSummary([...base.groupsRejected, ...rej]) }
}

// ── F-B: chọn nhầm loại file (câu do server dựng — chép đúng cmsImportFormatMessage) ──
export const CMS_FX_WRONG_FORMAT_TIERS: CmsRouteError = {
  ok: false, code: 'WRONG_FORMAT', expectedFormat: 'simple', detectedFormat: 'tiers',
  message: 'File thuộc mẫu "Nhiều bậc / có target" (9 cột, sheet IMPORT_CMS) — chọn lại loại file "Nhiều bậc / có target" rồi kiểm tra lại.'
    + ' Đây là ĐỊNH DẠNG file, không phải yêu cầu chương trình có target: chương trình không xét target vẫn dùng mẫu này, để trống hai cột KPI_Target_GMV_VND và Loai_CMS_GMV.',
}
export const CMS_FX_WRONG_FORMAT_SIMPLE: CmsRouteError = {
  ok: false, code: 'WRONG_FORMAT', expectedFormat: 'tiers', detectedFormat: 'simple',
  message: 'File thuộc mẫu "Mức cố định" (7 cột: product_id · ĐV tính CMS · CMS proposal…) — chọn lại loại file "Mức cố định" rồi kiểm tra lại.',
}

// ── F-A: sửa chương trình đang chạy ──
const item = (productId: string, action: CmsRevisionDiffItem['action'], o: Partial<CmsRevisionDiffItem> = {}): CmsRevisionDiffItem => ({
  productId, action, kBefore: null, kAfter: null, tiersBefore: null, tiersAfter: null, adviceChanged: false, unitCms: 'hộp',
  name: `Sản phẩm mẫu ${productId}`, referenced: null, ...o,
})
const ITEMS: CmsRevisionDiffItem[] = [
  item('918801', 'change', { kBefore: '10', kAfter: '5', tiersBefore: T('100'), tiersAfter: T('100') }),
  item('918802', 'change', { kBefore: '20', kAfter: '20', tiersBefore: T2('10000', '15000'), tiersAfter: T2('12000', '18000'), adviceChanged: true }),
  item('918803', 'change', { kBefore: '1', kAfter: '2.5', tiersBefore: T('5000'), tiersAfter: T('5000'), unitCms: 'vỉ',
    name: 'Sản phẩm mẫu tên rất dài để kiểm xuống dòng — viên nén bao phim 500 mg hộp 10 vỉ x 10 viên (giả)' }),
  item('918804', 'add', { kAfter: '1', tiersAfter: T('3000') }),
  item('918805', 'add', { kAfter: '12', tiersAfter: T2('20000', '25000') }),
  item('918806', 'readd', { kBefore: null, kAfter: '6', tiersAfter: T('8000') }),
  item('918807', 'remove', { kBefore: '3', tiersBefore: T('4000'), referenced: true }),
  item('918808', 'remove', { kBefore: '1', tiersBefore: T('2000'), referenced: false }),
  ...Array.from({ length: 8 }, (_, i) => item(`9188${String(10 + i)}`, 'keep', { kBefore: '1', kAfter: '1', tiersBefore: T('1000'), tiersAfter: T('1000') })),
]
export const CMS_FX_REV_DIFF: CmsRevisionDiff = { add: 2, readd: 1, change: 3, keep: 8, remove: 2, removed: ['918807', '918808'], productsAfter: 14, items: ITEMS }

const STORE = (i: number) => uid(9300 + (i % 5))
const PERSONS: CmsRevisionImpactPerson[] = Array.from({ length: 26 }, (_, i) => {
  const before = 120_000 + i * 7_500, delta = i % 3 === 0 ? -15_000 - i * 500 : i % 3 === 1 ? 22_000 + i * 300 : 0
  return { user_id: uid(9400 + i), store_id: STORE(i), published_vnd: String(before - 2_000), before_vnd: String(before), after_vnd: String(before + delta), delta_vnd: String(delta) }
}).sort((a, b) => Number(a.delta_vnd) - Number(b.delta_vnd))
const sum = (k: 'before_vnd' | 'after_vnd' | 'delta_vnd' | 'published_vnd') => String(PERSONS.reduce((s, p) => s + Number(p[k]), 0))
export const CMS_FX_REV_NAMES: Record<string, string> = Object.fromEntries(PERSONS.map((p, i) => [p.user_id, `Dược sĩ mẫu ${i + 1}${i === 3 ? ' (tên dài để kiểm xuống dòng trong bảng tác động)' : ''}`]))

export const CMS_FX_REV_IMPACT: CmsRevisionImpact = {
  version: 'cms-revision-impact-v1', status: 'ok', code: null, from_config_version: 6, path: 'legacy', computed_at: '2026-11-17T08:02:11.000Z',
  totals: {
    before_vnd: sum('before_vnd'), after_vnd: sum('after_vnd'), delta_vnd: sum('delta_vnd'), published_vnd: sum('published_vnd'), published_run_id: uid(9501),
    published_config_version: 6, published_at: '2026-11-17T06:00:00.000Z', published_current: true,
    persons: PERSONS.length, up: PERSONS.filter((p) => Number(p.delta_vnd) > 0).length, down: PERSONS.filter((p) => Number(p.delta_vnd) < 0).length,
    same: PERSONS.filter((p) => Number(p.delta_vnd) === 0).length, products_before: 13, products_after: 14, rows_read: 1726, candidates_after: 1645, unassigned_after: 81,
  },
  persons: PERSONS,
  products: [
    { product_id: '918801', before_vnd: '86000', after_vnd: '172000', delta_vnd: '86000', before_qty: '860', after_qty: '1720' },
    { product_id: '918807', before_vnd: '64000', after_vnd: '0', delta_vnd: '-64000', before_qty: '16', after_qty: '0' },
  ],
  truncated: { persons: false, products: false },
}
export const CMS_FX_REV_SOURCE: CmsRevisionSourceIdentity = {
  mapping_fp: 'e'.repeat(32), provider: 'bq', rows_read: 1726, lines_digest: 'f'.repeat(64), as_of: '2026-11-17T08:00:00.000Z',
  from_date: '2026-11-01', to_date: '2026-11-30', product_ids: 16,
}
const ANALYSIS: CmsRevisionAnalysis = {
  sha256: 'b'.repeat(64), format: 'tiers', configVersion: 6, quantityBasis: 'pos_base', ignoredFromRow: null,
  stats: { rowsTotal: 15, rowsOk: 15, rowsRejected: 0, productsOk: 14, productsRejected: 0, warnings: 0 },
  // Luồng sửa không hiển thị danh sách nhóm hợp lệ (diff DB thay thế) ⇒ để trống trong fixture.
  groupsOk: [] as CmsPreviewGroupOk[], groupsRejected: [], issueSummary: [],
}
export const CMS_FX_REV_PREVIEW: CmsRevisionPreviewBody = {
  ok: true, analysis: ANALYSIS,
  revision: { revisionId: uid(9601), programId: CMS_FX_REV_PROGRAM.id, fromConfigVersion: 6, expectedRunId: uid(9501), payloadDigest: '1'.repeat(64),
    expiresAt: '2026-11-17T08:17:11.000Z', impactOk: true, diff: CMS_FX_REV_DIFF },
  impact: CMS_FX_REV_IMPACT, source: CMS_FX_REV_SOURCE, names: CMS_FX_REV_NAMES,
}
/** fx=result-impact-error: nguồn lỗi ⇒ không có số (không 0 giả), nút ghi khoá. */
export const CMS_FX_REV_PREVIEW_IMPACT_ERROR: CmsRevisionPreviewBody = {
  ...CMS_FX_REV_PREVIEW,
  revision: { ...CMS_FX_REV_PREVIEW.revision, revisionId: uid(9602), impactOk: false },
  impact: { ...CMS_FX_REV_IMPACT, status: 'error', code: 'SOURCE_TIMEOUT', totals: null, persons: [], products: [] },
}
/** fx=result-prior (r3 P1-03): đã sửa một lần, chưa có run mới ⇒ pointer còn trỏ run của version 6 trong khi cấu hình đang v7 —
 *  số tham chiếu là "bản công bố trước thay đổi cấu hình v6" có mốc, KHÔNG gọi "đang công bố". */
export const CMS_FX_REV_PREVIEW_PRIOR: CmsRevisionPreviewBody = {
  ...CMS_FX_REV_PREVIEW,
  analysis: { ...ANALYSIS, configVersion: 7 },
  revision: { ...CMS_FX_REV_PREVIEW.revision, revisionId: uid(9604), fromConfigVersion: 7 },
  impact: { ...CMS_FX_REV_IMPACT, from_config_version: 7, totals: { ...CMS_FX_REV_IMPACT.totals!, published_current: false } },
}
/** fx=result-many-removed: bỏ 15 SP (danh sách mã dài ⇒ kiểm xuống dòng ở 360). */
const REMOVED15 = Array.from({ length: 15 }, (_, i) => `9189${String(10 + i)}`)
export const CMS_FX_REV_PREVIEW_MANY_REMOVED: CmsRevisionPreviewBody = {
  ...CMS_FX_REV_PREVIEW,
  revision: { ...CMS_FX_REV_PREVIEW.revision, revisionId: uid(9603), diff: { ...CMS_FX_REV_DIFF, remove: 15, removed: REMOVED15, productsAfter: 1,
    items: [ITEMS[0], ...REMOVED15.map((p) => item(p, 'remove', { kBefore: '1', tiersBefore: T('1000'), referenced: true }))] } },
}
/** fx=file-errors: file còn lỗi ⇒ tóm tắt + bảng lỗi, không lập revision. */
export const CMS_FX_REV_FILE_ERROR: CmsRevisionErrorBody = {
  ok: false, code: 'FILE_HAS_ERRORS', message: 'File còn lỗi — file sửa phải là toàn bộ danh mục mong muốn, không bỏ dòng lỗi',
  analysis: { ...ANALYSIS, sha256: 'c'.repeat(64), groupsRejected: REJ83, issueSummary: CMS_FX_ISSUES_83,
    stats: { rowsTotal: 83, rowsOk: 0, rowsRejected: 83, productsOk: 0, productsRejected: 83, warnings: 0 } },
}
export const CMS_FX_REV_DONE: CmsRevisionCommitReply = {
  already: false, revisionId: uid(9601), fromConfigVersion: 6, toConfigVersion: 7, archiveMode: 'copied', archiveRows: 868, retired: 1, deleted: 1,
}

// ── Lịch sử sửa ──
const totalsView = { beforeVnd: sum('before_vnd'), afterVnd: sum('after_vnd'), deltaVnd: sum('delta_vnd'), publishedVnd: sum('published_vnd'),
  publishedRunId: uid(9501), persons: 26, up: 9, down: 9, same: 8, productsBefore: 13, productsAfter: 14 }
export const CMS_FX_REV_LIST: CmsRevisionListItem[] = [
  { id: uid(9611), fromConfigVersion: 7, toConfigVersion: 8, committedAt: '2026-11-18T03:10:00.000Z', committedByName: 'Super admin mẫu',
    reason: 'Bù lại K của 918803 về 1 theo xác nhận NCC ngày 18/11 (lần sửa trước nhập nhầm đơn vị vỉ thay vì hộp).',
    counts: { add: 0, readd: 0, change: 1, keep: 13, remove: 0, productsAfter: 14 }, impact: { ...totalsView, deltaVnd: '42000' },
    archive: { mode: 'copied', runId: uid(9502), runConfigVersion: 7, rows: 870, amountVnd: '1530000' } },
  { id: uid(9601), fromConfigVersion: 6, toConfigVersion: 7, committedAt: '2026-11-17T08:05:00.000Z', committedByName: 'Super admin mẫu',
    reason: 'Cập nhật K theo quy cách mới của NCC (MKT duyệt 17/11), thêm 2 SP mới và bỏ 2 SP ngừng kinh doanh — áp dụng lại cả kỳ tháng 11.',
    counts: { add: 2, readd: 1, change: 3, keep: 8, remove: 2, productsAfter: 14 }, impact: totalsView,
    archive: { mode: 'copied', runId: uid(9501), runConfigVersion: 6, rows: 868, amountVnd: '1521782' } },
  { id: uid(9591), fromConfigVersion: 5, toConfigVersion: 6, committedAt: '2026-11-16T02:00:00.000Z', committedByName: null,
    reason: 'Sửa mức bậc 2 trước khi có lượt công bố.', counts: { add: 0, readd: 0, change: 1, keep: 12, remove: 0, productsAfter: 13 }, impact: null,
    archive: { mode: 'none', runId: null, runConfigVersion: null, rows: null, amountVnd: null } },
]
export const CMS_FX_REV_DETAIL: CmsRevisionDetail = {
  id: uid(9601), programId: CMS_FX_REV_PROGRAM.id, fromConfigVersion: 6, toConfigVersion: 7, committedAt: '2026-11-17T08:05:00.000Z',
  committedByName: 'Super admin mẫu', reason: CMS_FX_REV_LIST[1].reason, fileSha256: 'b'.repeat(64), diff: CMS_FX_REV_DIFF,
  impact: { status: 'ok', code: null, path: 'legacy', computedAt: '2026-11-17T08:02:11.000Z', totals: totalsView, truncated: false },
  source: { provider: 'bq', rowsRead: 1726, asOf: '2026-11-17T08:00:00.000Z', fromDate: '2026-11-01', toDate: '2026-11-30', productIds: 16, linesDigest: 'f'.repeat(64) },
  archive: { mode: 'copied', runId: uid(9501), runConfigVersion: 6, rows: 868, amountVnd: '1521782' },
}
export const CMS_FX_REV_ARCHIVE: CmsRevisionArchivePage = {
  mode: 'copied', runId: uid(9501), runConfigVersion: 6, total: 868, amountVnd: '1521782',
  rows: Array.from({ length: 24 }, (_, i) => ({
    userId: uid(9400 + (i % 8)), fullName: i % 8 === 3 ? 'Dược sĩ mẫu 4 (tên dài để kiểm cắt chữ trong bảng)' : `Dược sĩ mẫu ${(i % 8) + 1}`,
    storeId: STORE(i), productId: ['918801', '918802', '918807'][i % 3], perUnit: ['10', '20', '3'][i % 3], unitCms: 'hộp',
    configBasis: (['exact', 'unchanged_since_run', 'unknown'] as const)[i % 3],
    tiers: i % 3 === 1 ? T2('10000', '15000') : T(['100', '', '4000'][i % 3]), cmsQuantity: String(2 + i), amountVnd: String((2 + i) * (i % 3 === 0 ? 100 : 4000)),
    gateMet: true,
  })),
}
