// CMS P1-c — dữ liệu GIẢ cho fixture /ui-catalog/cms-v2 (dev-only, UI_CATALOG=1). ProductID giả 9xxxxx, không tên người
// / nhà thuốc thật, không ảnh CDN thật (ảnh dự phòng chữ cái đầu — fixture không gọi mạng ngoài). Ngày tương đối theo
// "hôm nay" của fixture để trạng thái hiển thị ổn định.
import type { CmsAdminListItem, CmsProductView, CmsProgramDetail, CmsImportRunView } from '@/lib/cms/server/catalog'
import type { CmsPreviewResult } from '@/lib/cms/importView'

export const CMS_FX_TODAY = '2026-11-15'
const day = (n: number) => { const d = new Date(`${CMS_FX_TODAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const LONG = 'Chương trình CMS Vitamin & khoáng chất mùa lạnh — tăng tư vấn sản phẩm tăng đề kháng cho khách gia đình (đợt 2)'
const ADVICE = 'Tư vấn mẫu cho fixture: hỏi nhu cầu, đối tượng dùng, liều theo hướng dẫn trên nhãn.\nNhắc khách đọc kỹ hướng dẫn sử dụng trước khi dùng.'

const run = (n: number, o: Partial<CmsImportRunView> = {}): CmsImportRunView => ({
  id: uid(9000 + n), mode: 'replace', status: 'committed', rowsTotal: 42, rowsOk: 40, rowsError: 2, rowsWarning: 1,
  productsOk: 14, productsRejected: 1, createdAt: '2026-11-10T03:05:00Z', committedAt: '2026-11-10T03:06:00Z', ...o,
})

const base = { scope: 'all' as const, isTest: false, catalogTargetGmv: null, configVersion: 3, activatedAt: '2026-11-01T02:00:00Z', createdAt: '2026-10-28T02:00:00Z' }
export const CMS_FX_LIST: CmsAdminListItem[] = [
  { ...base, id: uid(1), name: LONG, status: 'active', startDate: day(-14), endDate: day(15), productCount: 14, productIds: ['900001', '900002'], lastImport: run(1) },
  { ...base, id: uid(2), name: 'CMS Men vi sinh tháng 12', status: 'active', startDate: day(16), endDate: day(46), productCount: 6, productIds: ['900010'], lastImport: run(2, { rowsError: 0, productsRejected: 0, productsOk: 6 }) },
  { ...base, id: uid(3), name: 'CMS Chăm sóc da (nháp)', status: 'draft', startDate: day(20), endDate: day(50), activatedAt: null, productCount: 0, productIds: [], lastImport: null },
  { ...base, id: uid(4), name: 'CMS Khẩu trang tháng 10', status: 'active', startDate: day(-45), endDate: day(-15), productCount: 9, productIds: ['900020'], lastImport: run(3, { productsRejected: 0, rowsError: 0 }) },
  { ...base, id: uid(5), name: 'CMS Thực phẩm chức năng Q3', status: 'locked', startDate: day(-120), endDate: day(-60), productCount: 22, productIds: ['900030'], lastImport: run(4, { productsRejected: 0, rowsError: 0 }) },
  { ...base, id: uid(6), name: 'QA — chương trình kiểm thử', status: 'active', isTest: true, startDate: day(-5), endDate: day(25), productCount: 2, productIds: ['900040'], lastImport: run(5, { productsRejected: 0, rowsError: 0 }) },
]

const tiers3 = [{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: 19, amount: '20000' }, { order: 3, from: 20, to: null, amount: '25000' }]
const prod = (n: number, o: Partial<CmsProductView>): CmsProductView => ({
  id: uid(5000 + n), programId: uid(1), productId: String(900000 + n), gmvBasis: 'none', targetGmv: null, unitCms: 'hộp', baseQuantityCms: '1',
  adviceText: ADVICE, nameSnapshot: `Sản phẩm mẫu ${n}`, imageUrlSnapshot: null, priceSnapshot: '120000', addedAfterStart: false, tiers: tiers3, ...o,
})
export const CMS_FX_PRODUCTS: CmsProductView[] = [
  prod(1, { gmvBasis: 'product', targetGmv: '10000000', nameSnapshot: 'Viên uống vitamin C 1000mg hộp 30 viên — tên rất dài để kiểm tra xuống dòng trong khung', baseQuantityCms: '30', unitCms: 'hộp' }),
  prod(2, { gmvBasis: 'catalog', unitCms: 'chai', baseQuantityCms: '1', tiers: [{ order: 1, from: 1, to: null, amount: '8000' }] }),
  prod(3, { gmvBasis: 'none', unitCms: 'vỉ', baseQuantityCms: '10', priceSnapshot: null, tiers: [{ order: 1, from: 1, to: 50, amount: '5000' }] }),
  prod(4, { gmvBasis: 'product', targetGmv: '5000000', addedAfterStart: true, imageUrlSnapshot: 'http://example.invalid/anh.png', baseQuantityCms: '0.5', unitCms: 'gói' }),
]

/** P3a: `ended` = đang active nhưng đã hết kỳ (chờ chốt) · `locked` = đã chốt (chương trình QA của fixture). */
export function cmsFxDetail(kind: 'draft' | 'draft-empty' | 'running' | 'upcoming' | 'retro' | 'ended' | 'locked'): CmsProgramDetail {
  const live = kind === 'running' || kind === 'upcoming' || kind === 'ended' || kind === 'locked'
  const past = kind === 'ended' || kind === 'locked'
  const program = {
    ...base, id: uid(1), name: LONG, catalogTargetGmv: '50000000', isTest: past,
    status: kind === 'locked' ? 'locked' as const : live ? 'active' as const : 'draft' as const,
    startDate: kind === 'running' ? day(-14) : past ? day(-30) : kind === 'retro' ? day(-3) : day(16),
    endDate: kind === 'running' ? day(15) : past ? day(-1) : kind === 'retro' ? day(27) : day(46),
    activatedAt: live ? '2026-11-01T02:00:00Z' : null,
  }
  return {
    program,
    products: kind === 'draft-empty' ? [] : CMS_FX_PRODUCTS,
    storeCount: live ? 25 : 0,
    storeNames: null,
    storeIds: [],
    runs: kind === 'draft-empty' ? [] : [run(1), run(2, { status: 'previewed', committedAt: null, createdAt: '2026-11-09T08:00:00Z' })],
  }
}

export const CMS_FX_PREVIEW: CmsPreviewResult = {
  ok: true, runId: uid(9100), sha256: 'a'.repeat(64), mode: 'replace', configVersion: 1, catalogTarget: '50000000', ignoredFromRow: 48,
  stats: { rowsTotal: 9, rowsOk: 6, rowsRejected: 3, productsOk: 3, productsRejected: 2, warnings: 2 },
  groupsOk: [
    { productId: '900001', gmvBasis: 'product', targetGmv: '10000000', unitCms: 'hộp', baseQuantityCms: '30', nameSnapshot: 'Viên uống vitamin C 1000mg hộp 30 viên', imageUrlSnapshot: null, priceSnapshot: '120000', tiers: tiers3, excelRows: [5, 6, 7], warnings: [], advicePreview: ADVICE },
    { productId: '900002', gmvBasis: 'catalog', targetGmv: null, unitCms: 'chai', baseQuantityCms: '1', nameSnapshot: 'Siro ho thảo dược 100ml', imageUrlSnapshot: null, priceSnapshot: null, tiers: [{ order: 1, from: 1, to: null, amount: '8000' }], excelRows: [8], warnings: [{ excelRow: 8, column: 'ProductID', code: 'IMAGE_MISSING', message: 'Sản phẩm chưa có ảnh trên Product Master', fix: 'Vẫn nạp; ảnh dự phòng sẽ hiển thị' }], advicePreview: ADVICE },
    { productId: '900003', gmvBasis: 'none', targetGmv: null, unitCms: 'vỉ', baseQuantityCms: '10', nameSnapshot: 'Men vi sinh dạng gói', imageUrlSnapshot: null, priceSnapshot: '9.5', tiers: [{ order: 1, from: 1, to: 50, amount: '5000' }], excelRows: [9], warnings: [{ excelRow: 9, column: 'ProductID', code: 'PRODUCT_INACTIVE', message: 'Sản phẩm đang ngừng hoạt động', fix: 'Vẫn nạp; kiểm lại nếu không chủ ý' }], advicePreview: ADVICE },
  ],
  groupsRejected: [
    { key: '900009', excelRows: [10, 11], errors: [{ excelRow: 10, column: 'ProductID', code: 'PRODUCT_NOT_FOUND', message: 'ProductID không có trên Product Master', fix: 'Kiểm tra lại mã hoặc chờ Product Master đồng bộ' }] },
    { key: 'raw:SKU-ABC', excelRows: [12], errors: [{ excelRow: 12, column: 'ProductID', code: 'PRODUCT_ID_INVALID', message: 'ProductID phải là số nguyên dương (mã product_id trên POS)', fix: 'Nhập đúng ProductID dạng số, không dùng SKU / mã hàng' }] },
  ],
}
