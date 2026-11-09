// CMS-UI-1 (PM 04/11 §6.1–6.3) — MỘT nguồn dữ liệu giả cho mọi fixture CMS (/ui-catalog/cms-v2: A1 · A3 · A2 · D1 · D2 · D3 ·
// chốt kỳ). Chương trình, SP, bậc, nhà thuốc, tài khoản và DÒNG BÁN giả ⇒ engine thật (computeCmsProgram) ⇒ JSON có hình dạng
// RPC 122 ⇒ parser DTO thật (parseCmsResultHeader / parseCmsResultRows / parseCmsResultLines). KHÔNG gán tay số kết quả (GMV nhóm
// danh mục, gate, tiền, bậc, số SP): sửa số demo = sửa dòng bán. Số SP của chương trình = số SP trong danh mục (A1 = A3 = D1).
// Không IO, không gọi mạng; id / tên / email / nhà thuốc đều giả (example.invalid). Không dùng ở route thật.
//
// Chương trình (hôm nay của fixture = 15/11/2026):
//  PG1 Vitamin mùa lạnh — đang chạy, 4 SP (target SP · nhóm danh mục · theo số lượng một bậc · SP bổ sung, quy cách 0,5), 12 dược
//      sĩ có bán / 3 nhà thuốc + dòng chưa gán (4 lý do). SP 900001 có 11 dược sĩ bán (> 10 ⇒ "Đang hiện 10/11").
//  PG2 Chăm sóc da tháng 12 — sắp diễn ra, 1 SP · PG3 Nhỏ mắt — nháp, 0 SP · PG4 Khẩu trang tháng 10 — chờ chốt kỳ, 2 SP
//  PG5 Thực phẩm chức năng quý 3 — đã chốt (run đóng băng), 14 SP (4 bậc, 2 bậc, 1 bậc, tư vấn ~4.000 ký tự, tên dài)
// CMS-Q-220: mọi bậc cuối không giới hạn (to = null) — engine từ chối bậc cuối hữu hạn; hiển thị run lịch sử có trần chỉ kiểm bằng DTO
// dựng tay trong spec (cms-ui1-unit / cms-p2c-unit), không đưa vào fixture tính bằng engine.
//  PG6 QA — đang chạy, 2 SP · PG7 Men vi sinh — đang chạy, phạm vi 2 nhà thuốc, 1 SP (có dòng ngoài phạm vi)
//  PG8 QA — Vitamin đã hết kỳ (khối Chốt kỳ) · PG9 QA — Vitamin đã chốt (khối Số đã chốt) — cùng 4 SP / dòng bán như PG1.
//  PG13 (CMS-UNIT, spec PM 09/11 §4) — đang chạy, cơ sở cms_unit: chỉ đơn bán đúng ĐV tính CMS được tính; dòng bán GIẢ có cả đơn
//      khác ĐV (viên / vỉ / lọ) — engine thật tính Q = Σ lượng đúng ĐV; DTO dựng theo hình dạng RPC 128 (cơ sở / phiên bản, ĐV snapshot,
//      unit_match / counted_quantity). Các chương trình khác giữ DTO dạng DB trước 128 (không khoá cơ sở) — giao diện pos_base không đổi.
import { compareCmsLineId, computeCmsProgram, type CmsEngineOutput } from './engine/compute'
import type { CmsEngineProgramInput } from './engine/config'
import { buildSellerIndex, type CmsStoreRef, type CmsUserRef } from './mapping'
import { CMS_DEC_FACTOR, formatCmsDecimal, parseCmsDecimal } from './decimal'
import { formatUtcMicros } from './time'
import type { CmsSalesLine } from './source/contract'
import type { CmsGmvBasis } from './display'
import {
  parseCmsResultHeader, parseCmsResultLines, parseCmsResultRows,
  type CmsResultHeaderDto, type CmsResultLineDto, type CmsResultRowsDto,
} from './resultView'
import type { CmsAdminListItem, CmsImportRunView, CmsProductView, CmsProgramDetail, CmsProgramRowView, CmsTierView } from './server/catalog'

export const CMS_FX_TODAY = '2026-11-15'
export const cmsFxUid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const cmsFxDay = (n: number) => { const d = new Date(`${CMS_FX_TODAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

// ── Nhà thuốc / tài khoản ──────────────────────────────────────────────────
/** 25 nhà thuốc OS trong phạm vi "Tất cả" (chỉ 3 nhà thuốc đầu có dòng bán) + 1 nhà thuốc FS (dòng bán ⇒ chưa gán). */
export const CMS_FX_STORES = { S1: cmsFxUid(8001), S2: cmsFxUid(8002), S3: cmsFxUid(8003), FS: cmsFxUid(8099) }
const OS_STORE_IDS = Array.from({ length: 25 }, (_, i) => cmsFxUid(8001 + i))
export const CMS_FX_STORE_NAMES = new Map<string, string>([
  [CMS_FX_STORES.S1, 'Nhà thuốc mẫu 01'],
  [CMS_FX_STORES.S2, 'Nhà thuốc mẫu 02 — tên dài để kiểm tra cắt dòng trong bảng dược sĩ'],
  [CMS_FX_STORES.S3, 'Nhà thuốc mẫu 03'],
  ...OS_STORE_IDS.slice(3).map((id, i) => [id, `Nhà thuốc mẫu ${String(i + 4).padStart(2, '0')}`] as [string, string]),
  [CMS_FX_STORES.FS, 'Nhà thuốc mẫu FS'],
])

type UserKey = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
const USER_DEFS: { key: UserKey; store: string; name: string }[] = [
  { key: 'A', store: CMS_FX_STORES.S1, name: 'Dược sĩ mẫu A' },
  { key: 'B', store: CMS_FX_STORES.S1, name: 'Dược sĩ mẫu B' },
  { key: 'C', store: CMS_FX_STORES.S1, name: 'Dược sĩ mẫu C — tên rất dài để kiểm tra cắt dòng và xem đầy đủ' },
  { key: 'J', store: CMS_FX_STORES.S1, name: 'Dược sĩ mẫu J' },
  { key: 'D', store: CMS_FX_STORES.S2, name: 'Dược sĩ mẫu D' },
  { key: 'E', store: CMS_FX_STORES.S2, name: 'Dược sĩ mẫu E' },
  { key: 'F', store: CMS_FX_STORES.S2, name: 'Dược sĩ mẫu F' },
  { key: 'G', store: CMS_FX_STORES.S2, name: 'Dược sĩ mẫu G' },
  { key: 'H', store: CMS_FX_STORES.S3, name: 'Dược sĩ mẫu H' },
  { key: 'I', store: CMS_FX_STORES.S3, name: 'Dược sĩ mẫu I' },
  { key: 'K', store: CMS_FX_STORES.S3, name: 'Dược sĩ mẫu K' },
  { key: 'L', store: CMS_FX_STORES.S3, name: 'Dược sĩ mẫu L' },
  { key: 'M', store: CMS_FX_STORES.S3, name: 'Dược sĩ mẫu M (chưa bán)' },
]
const KEY_NUM: Record<UserKey, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10, K: 11, L: 12, M: 13 }
export const CMS_FX_USERS = Object.fromEntries(USER_DEFS.map((u) => [u.key, cmsFxUid(7000 + KEY_NUM[u.key])])) as Record<UserKey, string>
const USER_BY_ID = new Map(USER_DEFS.map((u) => [CMS_FX_USERS[u.key], u]))
const email = (k: string) => `duoc.si.${k.toLowerCase()}@example.invalid`
const QLCH_S1 = { id: cmsFxUid(7101), email: 'qlch.mau.01@example.invalid' }
const FS_STAFF = { id: cmsFxUid(7301), email: 'duoc.si.fs@example.invalid' }
/** SM của fixture được phân công S1 + S2 (đọc kết quả theo nhà thuốc HIỆN TẠI của dược sĩ — như RPC 122). */
export const CMS_FX_SM_STORES = [CMS_FX_STORES.S1, CMS_FX_STORES.S2]

const SELLERS = buildSellerIndex(
  [
    ...USER_DEFS.map((u): CmsUserRef => ({ id: CMS_FX_USERS[u.key], email: email(u.key), role: 'staff', storeId: u.store })),
    { id: QLCH_S1.id, email: QLCH_S1.email, role: 'store_manager', storeId: CMS_FX_STORES.S1 },
    { id: FS_STAFF.id, email: FS_STAFF.email, role: 'staff', storeId: CMS_FX_STORES.FS },
  ],
  [
    ...OS_STORE_IDS.map((id): CmsStoreRef => ({ id, storeType: 'os', isActive: true })),
    { id: CMS_FX_STORES.FS, storeType: 'fs', isActive: true },
  ],
)

/** Mẫu số Q-212 của fixture: staff hiện thuộc phạm vi chương trình ∩ phạm vi người xem (gồm M — chưa bán). SM: S1 + S2. */
export function cmsFxEligibleStaff(viewer: 'super' | 'sm', programStoreIds?: readonly string[]): string[] {
  return USER_DEFS.filter((u) => (viewer === 'super' || CMS_FX_SM_STORES.includes(u.store)) && (!programStoreIds || programStoreIds.includes(u.store))).map((u) => CMS_FX_USERS[u.key])
}

// ── Định nghĩa chương trình ─────────────────────────────────────────────────
interface ProductDef {
  productId: string
  name: string
  gmvBasis: CmsGmvBasis
  targetGmv: string | null
  unit: string
  k: string
  tiers: CmsTierView[]
  /** Giá tham khảo trên Product Master (hiển thị); null = thiếu giá. */
  price: string | null
  /** GMV mỗi đơn vị CMS dùng để sinh dòng bán (gần giá tham khảo; không là bất biến — PM §3). */
  unitGmv: number
  addedAfterStart?: boolean
  image?: string | null
  advice?: string
}
/** [dược sĩ, chỉ số SP, số lượng từng dòng theo đơn vị CMS] + (CMS-UNIT) [đơn vị bán khác ĐV CMS, lượng cơ sở / 1 đơn vị đó]. */
type SaleSpec = [UserKey, number, string[]] | [UserKey, number, string[], string, string]
interface ProgramDef {
  n: number
  name: string
  status: 'draft' | 'active' | 'locked'
  startDate: string
  endDate: string
  scope: 'all' | 'stores'
  storeIds: string[]
  isTest: boolean
  catalogTargetGmv: string | null
  configVersion: number
  products: ProductDef[]
  sales: SaleSpec[]
  unassigned: boolean
  /** Lần công bố kết quả (null ⇒ chưa có snapshot). */
  publishedAt: string | null
  runs: CmsImportRunView[]
  createdAt: string
  activatedAt: string | null
  /** CMS-UNIT: cơ sở tính (thiếu ⇒ fixture dạng DB trước 128, luật pos_base). */
  basis?: 'cms_unit'
}

const T3 = (a: number, b: number, c: number): CmsTierView[] => [
  { order: 1, from: 1, to: 9, amount: String(a) }, { order: 2, from: 10, to: 19, amount: String(b) }, { order: 3, from: 20, to: null, amount: String(c) },
]
const ADVICE = 'Hỏi nhu cầu, đối tượng dùng và liều theo hướng dẫn trên nhãn.\nNhắc khách đọc kỹ hướng dẫn sử dụng trước khi dùng; không thay thế thuốc chữa bệnh.'
/** Tư vấn dài ~4.000 ký tự (kiểm cắt dòng / mở đầy đủ / không đẩy cao hàng đóng). */
export const CMS_FX_ADVICE_4000 = Array.from({ length: 24 }, (_, i) =>
  `${i + 1}. Nội dung tư vấn mẫu dòng ${i + 1}: hỏi đối tượng dùng, tiền sử dị ứng, thuốc đang dùng; liều theo nhãn, không dùng quá liều.`).join('\n')
  + '\n' + 'Ghi chú thêm cho fixture — đoạn văn dài liên tục không xuống dòng để kiểm tra bẻ chữ trong khung hẹp 360px. '.repeat(14)

const VITAMIN_PRODUCTS: ProductDef[] = [
  { productId: '900001', name: 'Viên uống vitamin C 1000mg hộp 30 viên — tên rất dài để kiểm tra xuống dòng trong khung', gmvBasis: 'product', targetGmv: '3000000',
    unit: 'hộp', k: '30', tiers: T3(15000, 20000, 25000), price: '180000', unitGmv: 180000 },
  { productId: '900002', name: 'Siro ho thảo dược chai 100ml', gmvBasis: 'catalog', targetGmv: null,
    unit: 'chai', k: '1', tiers: [{ order: 1, from: 1, to: null, amount: '8000' }], price: '85000', unitGmv: 85000 },
  { productId: '900003', name: 'Men tiêu hoá vỉ 10 viên', gmvBasis: 'none', targetGmv: null,
    unit: 'vỉ', k: '10', tiers: [{ order: 1, from: 1, to: null, amount: '5000' }], price: null, unitGmv: 50000 },
  { productId: '900004', name: 'Cốm bổ sung kẽm gói 2g', gmvBasis: 'product', targetGmv: '600000',
    unit: 'gói', k: '0.5', tiers: T3(15000, 20000, 25000), price: '30000', unitGmv: 30000, addedAfterStart: true, image: 'http://example.invalid/anh.png' },
]
const VITAMIN_SALES: SaleSpec[] = [
  ['A', 0, ['5', '5', '8']], ['B', 0, ['10', '10', '8']], ['C', 0, ['6', '6.5']], ['D', 0, ['12', '13']], ['E', 0, ['7', '7', '7']],
  ['F', 0, ['4', '5']], ['G', 0, ['9', '8']], ['H', 0, ['10', '10', '10']], ['I', 0, ['3']], ['J', 0, ['8', '8']], ['K', 0, ['10', '10']],
  ['A', 1, ['6', '6']], ['B', 1, ['10', '10']], ['D', 1, ['12', '10']], ['E', 1, ['5']], ['L', 1, ['15', '15']],
  ['A', 2, ['5', '7.5']], ['B', 2, ['30', '30']], ['C', 2, ['8']], ['H', 2, ['25', '25']],
  ['A', 3, ['3', '4']], ['D', 3, ['12', '12']], ['F', 3, ['2']],
]
const run = (n: number, o: Partial<CmsImportRunView> & Pick<CmsImportRunView, 'createdAt'>): CmsImportRunView => ({
  id: cmsFxUid(9000 + n), mode: 'replace', status: 'committed', rowsTotal: 0, rowsOk: 0, rowsError: 0, rowsWarning: 0,
  productsOk: 0, productsRejected: 0, committedAt: o.createdAt, ...o,
})
/** Lần import khớp danh mục: mỗi bậc = 1 dòng Excel (dòng hợp lệ = Σ bậc), số SP hợp lệ = số SP. */
function importRun(n: number, products: ProductDef[], at: string, extra: Partial<CmsImportRunView> = {}): CmsImportRunView {
  const ok = products.reduce((a, p) => a + p.tiers.length, 0)
  return run(n, { createdAt: at, rowsTotal: ok + (extra.rowsError ?? 0), rowsOk: ok, productsOk: products.length, ...extra })
}

const PG5_PRODUCTS: ProductDef[] = Array.from({ length: 14 }, (_, i): ProductDef => {
  const basis: CmsGmvBasis = i % 3 === 0 ? 'product' : i % 3 === 1 ? 'catalog' : 'none'
  const tiers: CmsTierView[] = i % 4 === 0
    ? [{ order: 1, from: 1, to: 4, amount: '5000' }, { order: 2, from: 5, to: 9, amount: '7000' }, { order: 3, from: 10, to: 19, amount: '9000' }, { order: 4, from: 20, to: null, amount: '12000' }]
    : i % 4 === 1 ? [{ order: 1, from: 1, to: null, amount: '6000' }]
      : i % 4 === 2 ? [{ order: 1, from: 1, to: 12, amount: '4000' }, { order: 2, from: 13, to: null, amount: '5000' }]
        : T3(3000, 4000, 6000)
  return {
    productId: String(900030 + i),
    name: i === 1 ? 'Viên uống bổ sung canxi và vitamin D3 cho người lớn tuổi hộp 60 viên — tên dài hai dòng kiểm tra cắt' : `Thực phẩm chức năng mẫu ${String(i + 1).padStart(2, '0')}`,
    gmvBasis: basis, targetGmv: basis === 'product' ? '400000' : null, unit: i % 2 ? 'hộp' : 'lọ', k: '1', tiers,
    price: String(40000 + i * 5000), unitGmv: 40000 + i * 5000, advice: i === 2 ? CMS_FX_ADVICE_4000 : undefined,
  }
})
const PG5_SALES: SaleSpec[] = PG5_PRODUCTS.flatMap((_, i) =>
  (['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as UserKey[]).flatMap((u, j): SaleSpec[] =>
    (i + j) % 3 === 0 ? [[u, i, [String(2 + ((i * 7 + j * 3) % 9)), String(1 + ((i + j * 5) % 6))]]] : []))

const PROGRAM_DEFS: ProgramDef[] = [
  {
    n: 1, name: 'Chương trình CMS Vitamin & khoáng chất mùa lạnh — tăng tư vấn sản phẩm tăng đề kháng cho khách gia đình (đợt 2)',
    status: 'active', startDate: cmsFxDay(-14), endDate: cmsFxDay(15), scope: 'all', storeIds: OS_STORE_IDS, isTest: false,
    catalogTargetGmv: '1500000', configVersion: 3, products: VITAMIN_PRODUCTS, sales: VITAMIN_SALES, unassigned: true,
    publishedAt: '2026-11-15T01:05:00.000000Z', createdAt: '2026-10-28T02:00:00Z', activatedAt: '2026-10-31T02:00:00Z',
    runs: [
      importRun(11, VITAMIN_PRODUCTS.slice(0, 3), '2026-10-30T03:05:00Z', { rowsError: 2, rowsWarning: 1, productsRejected: 1 }),
      importRun(12, VITAMIN_PRODUCTS.slice(3), '2026-11-06T04:10:00Z', { mode: 'append', rowsError: 1, productsRejected: 1 }),
      importRun(13, VITAMIN_PRODUCTS.slice(3), '2026-11-06T04:08:00Z', { mode: 'append', status: 'previewed', committedAt: null }),
    ],
  },
  {
    n: 2, name: 'CMS Chăm sóc da tháng 12', status: 'active', startDate: cmsFxDay(16), endDate: cmsFxDay(46), scope: 'all', storeIds: OS_STORE_IDS,
    isTest: false, catalogTargetGmv: null, configVersion: 1, sales: [], unassigned: false, publishedAt: null,
    products: [{ productId: '900010', name: 'Kem dưỡng ẩm da khô tuýp 50ml', gmvBasis: 'none', targetGmv: null, unit: 'tuýp', k: '1', tiers: T3(10000, 12000, 15000), price: '145000', unitGmv: 145000 }],
    createdAt: '2026-11-10T02:00:00Z', activatedAt: '2026-11-12T02:00:00Z', runs: [],
  },
  {
    n: 3, name: 'CMS Nhỏ mắt (nháp)', status: 'draft', startDate: cmsFxDay(20), endDate: cmsFxDay(50), scope: 'all', storeIds: [], isTest: false,
    catalogTargetGmv: null, configVersion: 1, products: [], sales: [], unassigned: false, publishedAt: null,
    createdAt: '2026-11-14T02:00:00Z', activatedAt: null, runs: [],
  },
  {
    n: 4, name: 'CMS Khẩu trang tháng 10', status: 'active', startDate: cmsFxDay(-45), endDate: cmsFxDay(-15), scope: 'all', storeIds: OS_STORE_IDS,
    isTest: false, catalogTargetGmv: null, configVersion: 2, unassigned: false, publishedAt: '2026-11-01T01:05:00.000000Z',
    products: [
      { productId: '900020', name: 'Khẩu trang y tế 4 lớp hộp 50 cái', gmvBasis: 'product', targetGmv: '1000000', unit: 'hộp', k: '1',
        tiers: [{ order: 1, from: 1, to: 9, amount: '3000' }, { order: 2, from: 10, to: null, amount: '5000' }], price: '60000', unitGmv: 60000 },
      { productId: '900021', name: 'Khẩu trang trẻ em gói 10 cái', gmvBasis: 'none', targetGmv: null, unit: 'gói', k: '1',
        tiers: [{ order: 1, from: 1, to: null, amount: '2000' }], price: '25000', unitGmv: 25000 },
    ],
    sales: [['A', 0, ['6', '8']], ['B', 0, ['10', '12']], ['D', 0, ['5']], ['C', 0, ['3']], ['A', 1, ['10']], ['D', 1, ['20', '5']]],
    createdAt: '2026-09-25T02:00:00Z', activatedAt: '2026-09-28T02:00:00Z', runs: [],
  },
  {
    n: 5, name: 'CMS Thực phẩm chức năng quý 3', status: 'locked', startDate: '2026-07-01', endDate: '2026-09-30', scope: 'all', storeIds: OS_STORE_IDS,
    isTest: false, catalogTargetGmv: '2000000', configVersion: 4, products: PG5_PRODUCTS, sales: PG5_SALES, unassigned: false,
    publishedAt: '2026-10-02T01:05:00.000000Z', createdAt: '2026-06-20T02:00:00Z', activatedAt: '2026-06-28T02:00:00Z', runs: [],
  },
  {
    n: 6, name: 'QA — chương trình kiểm thử', status: 'active', startDate: cmsFxDay(-5), endDate: cmsFxDay(25), scope: 'stores', storeIds: [CMS_FX_STORES.S1],
    isTest: true, catalogTargetGmv: null, configVersion: 1, unassigned: false, publishedAt: '2026-11-15T01:06:00.000000Z',
    products: [
      { productId: '900050', name: 'Sản phẩm QA 1', gmvBasis: 'none', targetGmv: null, unit: 'hộp', k: '1', tiers: [{ order: 1, from: 1, to: null, amount: '1000' }], price: '10000', unitGmv: 10000 },
      { productId: '900051', name: 'Sản phẩm QA 2', gmvBasis: 'product', targetGmv: '100000', unit: 'hộp', k: '1', tiers: T3(1000, 2000, 3000), price: '20000', unitGmv: 20000 },
    ],
    sales: [['A', 0, ['2', '3']], ['A', 1, ['1']]],
    createdAt: '2026-11-08T02:00:00Z', activatedAt: '2026-11-09T02:00:00Z', runs: [],
  },
  {
    n: 7, name: 'CMS Men vi sinh', status: 'active', startDate: cmsFxDay(-3), endDate: cmsFxDay(40), scope: 'stores', storeIds: [CMS_FX_STORES.S1, CMS_FX_STORES.S2],
    isTest: false, catalogTargetGmv: null, configVersion: 1, unassigned: false, publishedAt: '2026-11-15T01:05:30.000000Z',
    products: [{ productId: '900060', name: 'Men vi sinh hộp 20 gói', gmvBasis: 'none', targetGmv: null, unit: 'hộp', k: '20',
      tiers: [{ order: 1, from: 1, to: 19, amount: '10000' }, { order: 2, from: 20, to: null, amount: '12000' }], price: '210000', unitGmv: 210000 }],
    sales: [['A', 0, ['2', '1.5']], ['B', 0, ['5']], ['D', 0, ['8', '7']], ['G', 0, ['12', '9']], ['H', 0, ['3']]],
    createdAt: '2026-11-05T02:00:00Z', activatedAt: '2026-11-07T02:00:00Z', runs: [],
  },
  {
    n: 8, name: 'QA — Vitamin mùa lạnh (đã hết kỳ)', status: 'active', startDate: '2026-10-15', endDate: cmsFxDay(-1), scope: 'all', storeIds: OS_STORE_IDS,
    isTest: true, catalogTargetGmv: '1500000', configVersion: 3, products: VITAMIN_PRODUCTS, sales: VITAMIN_SALES, unassigned: true,
    publishedAt: '2026-11-15T02:10:00.000000Z', createdAt: '2026-10-10T02:00:00Z', activatedAt: '2026-10-12T02:00:00Z', runs: [],
  },
  {
    n: 9, name: 'QA — Vitamin mùa lạnh (đã chốt)', status: 'locked', startDate: '2026-10-01', endDate: '2026-10-31', scope: 'all', storeIds: OS_STORE_IDS,
    isTest: true, catalogTargetGmv: '1500000', configVersion: 3, products: VITAMIN_PRODUCTS, sales: VITAMIN_SALES, unassigned: true,
    publishedAt: '2026-11-02T02:10:00.000000Z', createdAt: '2026-09-25T02:00:00Z', activatedAt: '2026-09-28T02:00:00Z', runs: [],
  },
]
// ── CMS đơn giản (PM spec r1 08/11 §6) — mỗi SP MỘT mức CMS cố định / đơn vị, không target, không bậc ─────────────────────────
// Mức và SP đều GIẢ (không phải bảng T11, không doanh số thật). Dòng bán giả ⇒ engine thật như các chương trình trên. Không nằm trong
// danh sách A1 (cmsFxListItems giữ 9 chương trình); mở bằng ?program= / &pp= / fx=simple. Ca phủ: có CMS · phần lẻ (K 10, bán 2,5
// hộp) · không giá tham khảo · SP chưa bán (0) · số lớn (1.250 hộp) · sắp diễn ra (PG11) · đã hết kỳ chờ chốt (PG12).
const FLAT = (amount: number): CmsTierView[] => [{ order: 1, from: 1, to: null, amount: String(amount) }]
const flat = (productId: string, name: string, k: string, amount: number, price: string | null, unitGmv: number): ProductDef =>
  ({ productId, name, gmvBasis: 'none', targetGmv: null, unit: 'hộp', k, tiers: FLAT(amount), price, unitGmv })
const SIMPLE_PRODUCTS: ProductDef[] = [
  flat('900101', 'Viên uống bổ sung sắt hộp 30 viên', '30', 58000, '320000', 320000),
  flat('900102', 'Siro bổ sung kẽm trẻ em chai 100ml', '1', 24000, '95000', 95000),
  flat('900103', 'Men vi sinh dạng gói hộp 10 gói', '10', 31500, '185000', 185000),
  flat('900104', 'Dung dịch vệ sinh mũi chai 70ml — tên rất dài để kiểm tra xuống dòng trong thẻ trên màn hình hẹp', '1', 17000, null, 70000),
  flat('900105', 'Viên ngậm thảo dược hộp 24 viên', '24', 18000, '60000', 60000),
  flat('900106', 'Sữa bột dinh dưỡng lon 900g', '1', 42800, '650000', 650000),
]
const SIMPLE_SALES: SaleSpec[] = [
  ['A', 0, ['2', '1']], ['A', 1, ['1']], ['A', 2, ['1.5', '1']], ['A', 3, ['3']], ['A', 5, ['600', '650']],
  ['B', 0, ['5', '4']], ['B', 1, ['2', '2']], ['B', 2, ['0.5']], ['C', 3, ['1']],
  ['D', 0, ['3']], ['D', 2, ['4', '2']], ['E', 1, ['6']], ['H', 0, ['2']], ['H', 3, ['2', '2']],
]
const SIMPLE_DEFS: ProgramDef[] = [
  {
    n: 10, name: 'CMS mẫu mức cố định — mỗi sản phẩm một mức / hộp', status: 'active', startDate: cmsFxDay(-14), endDate: cmsFxDay(15),
    scope: 'all', storeIds: OS_STORE_IDS, isTest: false, catalogTargetGmv: null, configVersion: 2, products: SIMPLE_PRODUCTS, sales: SIMPLE_SALES,
    unassigned: false, publishedAt: '2026-11-15T01:05:00.000000Z', createdAt: '2026-10-28T02:00:00Z', activatedAt: '2026-10-31T02:00:00Z', runs: [],
  },
  {
    n: 11, name: 'CMS mẫu mức cố định tháng 12', status: 'active', startDate: cmsFxDay(16), endDate: cmsFxDay(46), scope: 'all', storeIds: OS_STORE_IDS,
    isTest: false, catalogTargetGmv: null, configVersion: 1, products: SIMPLE_PRODUCTS.slice(0, 2), sales: [], unassigned: false, publishedAt: null,
    createdAt: '2026-11-10T02:00:00Z', activatedAt: '2026-11-12T02:00:00Z', runs: [],
  },
  {
    n: 12, name: 'CMS mẫu mức cố định tháng 10', status: 'active', startDate: cmsFxDay(-45), endDate: cmsFxDay(-15), scope: 'all', storeIds: OS_STORE_IDS,
    isTest: false, catalogTargetGmv: null, configVersion: 1, products: SIMPLE_PRODUCTS.slice(0, 3), sales: [['A', 0, ['4']], ['A', 2, ['2.5']], ['B', 1, ['3']]],
    unassigned: false, publishedAt: '2026-11-01T01:05:00.000000Z', createdAt: '2026-09-25T02:00:00Z', activatedAt: '2026-09-28T02:00:00Z', runs: [],
  },
]

// ── CMS-UNIT (spec PM 09/11 §4) — chương trình cơ sở cms_unit. SP / mức / dòng bán đều GIẢ (không phải bảng T11). Ca phủ: đúng ĐV
// nhiều bậc · đơn khác ĐV đủ K vẫn 0 (A bán 5 viên + 10 vỉ = đủ 1 hộp theo K — luật cũ Q 4, luật mới Q 3) · chỉ bán khác ĐV ⇒ Q 0 (D) · mức cố định theo chai · target SP mà
// GMV đơn khác ĐV giúp đạt target (A 900203) · bậc 2 (B 12 hộp).
const UNIT_PRODUCTS: ProductDef[] = [
  { productId: '900201', name: 'Viên uống vitamin C hộp 10 vỉ x 10 viên', gmvBasis: 'none', targetGmv: null, unit: 'hộp', k: '100', tiers: T3(12000, 15000, 18000), price: '150000', unitGmv: 150000 },
  { productId: '900202', name: 'Siro ho thảo dược chai 100ml', gmvBasis: 'none', targetGmv: null, unit: 'chai', k: '1', tiers: FLAT(20000), price: '85000', unitGmv: 85000 },
  { productId: '900203', name: 'Viên kẽm hộp 3 vỉ x 10 viên', gmvBasis: 'product', targetGmv: '600000', unit: 'hộp', k: '30', tiers: T3(9000, 11000, 13000), price: '120000', unitGmv: 120000 },
]
const UNIT_SALES: SaleSpec[] = [
  ['A', 0, ['2', '1']], ['A', 0, ['5'], 'viên', '1'], ['A', 0, ['10'], 'vỉ', '10'], ['A', 1, ['3']], ['A', 2, ['4']], ['A', 2, ['30'], 'viên', '1'],
  ['B', 0, ['12']], ['B', 2, ['1']], ['D', 0, ['20'], 'viên', '1'], ['H', 1, ['1']], ['H', 1, ['2'], 'lọ', '1'],
]
const UNIT_DEFS: ProgramDef[] = [
  {
    n: 13, name: 'CMS mẫu theo ĐV tính CMS — chỉ tính đơn bán đúng đơn vị', status: 'active', startDate: cmsFxDay(-14), endDate: cmsFxDay(15),
    scope: 'all', storeIds: OS_STORE_IDS, isTest: false, catalogTargetGmv: null, configVersion: 3, products: UNIT_PRODUCTS, sales: UNIT_SALES,
    unassigned: false, publishedAt: '2026-11-15T01:05:00.000000Z', createdAt: '2026-10-28T02:00:00Z', activatedAt: '2026-10-31T02:00:00Z', runs: [], basis: 'cms_unit',
  },
  // PG14: mức CỐ ĐỊNH / hộp theo ĐV tính CMS (dạng chương trình T11 sau chuyển — mức / SP GIẢ, không phải bảng T11). Ca phủ (ảnh guide):
  // hộp được tính · gói / viên đủ quy cách vẫn 0 (A 900103: 2 + 1 hộp tính 3, 15 gói không tính — luật cũ 4; A 900101: 1 hộp tính 1,
  // 10 viên không tính) · chỉ bán gói ⇒ 0 (B 900103) · SP K 1 (900102) như cũ.
  {
    n: 14, name: 'CMS mẫu mức cố định — chỉ tính đơn bán đúng ĐV tính CMS', status: 'active', startDate: cmsFxDay(-14), endDate: cmsFxDay(15),
    scope: 'all', storeIds: OS_STORE_IDS, isTest: false, catalogTargetGmv: null, configVersion: 3, products: SIMPLE_PRODUCTS.slice(0, 3),
    sales: [['A', 2, ['2', '1']], ['A', 2, ['15'], 'gói', '1'], ['A', 0, ['1']], ['A', 0, ['10'], 'viên', '1'], ['A', 1, ['2']],
      ['B', 2, ['5'], 'gói', '1'], ['B', 1, ['1']], ['D', 0, ['3']]],
    unassigned: false, publishedAt: '2026-11-15T01:05:00.000000Z', createdAt: '2026-10-28T02:00:00Z', activatedAt: '2026-10-31T02:00:00Z', runs: [], basis: 'cms_unit',
  },
]

for (const d of [...PROGRAM_DEFS, ...SIMPLE_DEFS, ...UNIT_DEFS]) {
  if (d.runs.length === 0 && d.products.length > 0) d.runs.push(importRun(d.n * 10, d.products, `${d.createdAt.slice(0, 10)}T05:00:00Z`))
}

// ── Sinh dòng bán + chạy engine ─────────────────────────────────────────────
const units = (v: string) => { const r = parseCmsDecimal(v); if (!r.ok) throw new Error(`fx decimal ${v}`); return r.units }
const HOUR = BigInt(3_600_000_000)
const vnMicros = (date: string, h: number, m: number) => BigInt(Date.parse(`${date}T00:00:00Z`)) * BigInt(1000) + BigInt(h) * HOUR + BigInt(m) * BigInt(60_000_000) - BigInt(7) * HOUR
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

function salesLines(d: ProgramDef): CmsSalesLine[] {
  // Bán trong kỳ, trước "hôm nay" của fixture (chương trình đang chạy chỉ có dòng tới hôm qua).
  const span = Math.max(1, Math.min(daysBetween(d.startDate, d.endDate) + 1, daysBetween(d.startDate, CMS_FX_TODAY)))
  const out: CmsSalesLine[] = []
  let seq = 0
  // uom / per: đơn vị bán + lượng cơ sở mỗi đơn vị đó (mặc định = ĐV CMS / K). GMV tỷ lệ theo lượng cơ sở.
  const push = (email: string | null, p: ProductDef, qty: string, day: number, h: number, m: number, store: string, uom: string = p.unit, per: string = p.k) => {
    seq += 1
    const id = String(d.n * 100_000 + seq)
    const at = vnMicros(addDays(d.startDate, day % span), 8 + (h % 12), m % 60)
    const base = (units(qty) * units(per)) / CMS_DEC_FACTOR
    out.push({
      orderLineId: id, orderId: `HD${id}`, orderCode: `HD${id}`, productId: p.productId, sellerEmail: email, posCode: `POS-${store.slice(-2)}`,
      orderType: 'OFFLINE', orderStatus: 'COMPLETED', completedAtMicros: at, quantityRaw: qty, uomRaw: uom,
      baseQuantityUnits: base, gmvUnits: per === p.k ? units(qty) * BigInt(p.unitGmv) : (base * BigInt(p.unitGmv) * CMS_DEC_FACTOR) / units(p.k), sourceUpdatedAtMicros: at + HOUR,
    })
  }
  for (const [u, pi, qtys, uom, per] of d.sales) {
    const p = d.products[pi]
    const def = USER_DEFS.find((x) => x.key === u)!
    qtys.forEach((q, k) => push(email(u), p, q, KEY_NUM[u] * 5 + pi * 3 + k * 4 + (uom ? 2 : 0), KEY_NUM[u] + k * 3 + pi, KEY_NUM[u] * 7 + k * 13 + pi * 17 + (uom ? 5 : 0), def.store, uom, per))
  }
  if (d.unassigned) {
    const p = (i: number) => d.products[Math.min(i, d.products.length - 1)]
    // 8 dòng chưa gán, 4 lý do; GMV chưa gán ≈ 1% ứng viên (dưới ngưỡng QA 2% ⇒ khối Chốt kỳ "ack" cần lý do, không bị chặn).
    for (let i = 0; i < 4; i++) push(`khong.khop.${i + 1}@example.invalid`, p(2), '1', 2 + i * 3, i, i * 11, CMS_FX_STORES.S1)
    for (let i = 0; i < 2; i++) push(QLCH_S1.email, p(1), '1', 4 + i * 5, 3 + i, 20 + i, CMS_FX_STORES.S1)
    push(null, p(2), '1', 6, 2, 45, CMS_FX_STORES.S2)
    push(FS_STAFF.email, p(1), '1', 8, 5, 5, CMS_FX_STORES.FS)
  }
  return out
}

export interface CmsFxProgram {
  row: CmsAdminListItem
  products: CmsProductView[]
  storeIds: string[]
  runs: CmsImportRunView[]
  /** Phiên kết quả đã công bố (null ⇒ chưa có snapshot / chưa bắt đầu). */
  run: { id: string; publishedAt: string; configVersion: number } | null
  out: CmsEngineOutput | null
  lines: CmsSalesLine[]
  /** product_id ⇒ program_product_id. */
  pp: Map<string, string>
  /** CMS-UNIT: cơ sở cms_unit ⇒ DTO dạng 128; null ⇒ DTO dạng DB trước 128 (pos_base legacy). */
  basis: 'cms_unit' | null
}

function build(d: ProgramDef): CmsFxProgram {
  const products: CmsProductView[] = d.products.map((p, i) => ({
    id: cmsFxUid(d.n * 100 + 5000 + i + 1), programId: cmsFxUid(d.n), productId: p.productId, gmvBasis: p.gmvBasis, targetGmv: p.targetGmv,
    unitCms: p.unit, baseQuantityCms: p.k, adviceText: p.advice ?? ADVICE, nameSnapshot: p.name, imageUrlSnapshot: p.image ?? null,
    priceSnapshot: p.price, addedAfterStart: p.addedAfterStart === true, tiers: p.tiers,
  }))
  const pp = new Map(products.map((p) => [p.productId, p.id]))
  const committed = d.runs.filter((r) => r.status === 'committed')
  const row: CmsAdminListItem = {
    id: cmsFxUid(d.n), name: d.name, status: d.status, startDate: d.startDate, endDate: d.endDate, scope: d.scope, isTest: d.isTest,
    catalogTargetGmv: d.catalogTargetGmv, configVersion: d.configVersion, activatedAt: d.activatedAt, createdAt: d.createdAt,
    ...(d.basis ? { quantityBasis: d.basis } : {}),
    productCount: products.length, productIds: products.map((p) => p.productId),
    lastImport: committed.length ? committed.reduce((a, b) => ((b.committedAt ?? '') > (a.committedAt ?? '') ? b : a)) : null,
  }
  const lines = salesLines(d)
  let out: CmsEngineOutput | null = null
  if (d.publishedAt && d.products.length > 0) {
    const input: CmsEngineProgramInput = {
      startDate: d.startDate, endDate: d.endDate, catalogTargetGmv: d.catalogTargetGmv, storeIds: d.storeIds,
      products: d.products.map((p) => ({ productId: p.productId, gmvBasis: p.gmvBasis, targetGmv: p.targetGmv, baseQuantityCms: p.k, tiers: p.tiers.map((t) => ({ from: t.from, to: t.to, amount: t.amount })), ...(d.basis ? { unitCms: p.unit } : {}) })),
      ...(d.basis ? { quantityBasis: d.basis } : {}),
    }
    out = computeCmsProgram({ program: input, lines, sellers: SELLERS })
  }
  return {
    row, products, storeIds: d.storeIds, runs: d.runs, lines, pp, out, basis: d.basis ?? null,
    run: d.publishedAt && out ? { id: cmsFxUid(9500 + (d.n - 1) * 10), publishedAt: d.publishedAt, configVersion: d.configVersion } : null,
  }
}

export const CMS_FX_PROGRAMS: readonly CmsFxProgram[] = PROGRAM_DEFS.map(build)
export const CMS_FX_PG = Object.fromEntries(CMS_FX_PROGRAMS.map((p, i) => [`PG${PROGRAM_DEFS[i].n}`, p.row.id])) as Record<'PG1' | 'PG2' | 'PG3' | 'PG4' | 'PG5' | 'PG6' | 'PG7' | 'PG8' | 'PG9', string>
/** CMS đơn giản (PM r1 §6): PG10 đang chạy · PG11 sắp diễn ra · PG12 hết kỳ chờ chốt — ngoài danh sách A1. */
export const CMS_FX_SIMPLE_PROGRAMS: readonly CmsFxProgram[] = SIMPLE_DEFS.map(build)
export const CMS_FX_PG_SIMPLE = Object.fromEntries(CMS_FX_SIMPLE_PROGRAMS.map((p, i) => [`PG${SIMPLE_DEFS[i].n}`, p.row.id])) as Record<'PG10' | 'PG11' | 'PG12', string>
/** CMS-UNIT: PG13 (có bậc / target) và PG14 (mức cố định / hộp) đang chạy, cơ sở cms_unit — ngoài danh sách A1; mở bằng ?program= / &pp= /
 *  fx=unit (PG13) · fx=unit-flat (PG14). */
export const CMS_FX_UNIT_PROGRAMS: readonly CmsFxProgram[] = UNIT_DEFS.map(build)
export const CMS_FX_PG_UNIT = { PG13: CMS_FX_UNIT_PROGRAMS[0].row.id, PG14: CMS_FX_UNIT_PROGRAMS[1].row.id }
const ALL_FX: readonly CmsFxProgram[] = [...CMS_FX_PROGRAMS, ...CMS_FX_SIMPLE_PROGRAMS, ...CMS_FX_UNIT_PROGRAMS]
export const cmsFxProgram = (id: string | null | undefined): CmsFxProgram | null => ALL_FX.find((p) => p.row.id === id) ?? null
/** Tìm chương trình chứa program_product (D2). */
export const cmsFxProgramOfProduct = (ppId: string | null | undefined): CmsFxProgram | null => ALL_FX.find((p) => p.products.some((x) => x.id === ppId)) ?? null

export function cmsFxListItems(): CmsAdminListItem[] {
  return CMS_FX_PROGRAMS.map((p) => p.row)
}

export function cmsFxDetailOf(p: CmsFxProgram, o: { sm?: boolean } = {}): CmsProgramDetail {
  const live = p.row.status !== 'draft'
  const names = p.row.scope === 'stores' ? p.storeIds.map((id) => CMS_FX_STORE_NAMES.get(id) ?? '—') : null
  return {
    program: { ...rowView(p.row) }, products: p.products, storeCount: live ? p.storeIds.length : 0, storeNames: names,
    storeIds: p.storeIds, runs: o.sm ? [] : [...p.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }
}
const rowView = (r: CmsAdminListItem): CmsProgramRowView => ({
  id: r.id, name: r.name, status: r.status, startDate: r.startDate, endDate: r.endDate, scope: r.scope, isTest: r.isTest,
  catalogTargetGmv: r.catalogTargetGmv, configVersion: r.configVersion, activatedAt: r.activatedAt, createdAt: r.createdAt,
  ...(r.quantityBasis ? { quantityBasis: r.quantityBasis } : {}),
})
export const cmsFxRowView = rowView

// ── Kết quả theo người xem (giả lập phạm vi RPC 122) ────────────────────────
export type CmsFxViewer = { kind: 'super' } | { kind: 'sm' } | { kind: 'store_manager'; storeId: string } | { kind: 'staff'; userId: string }
const fmt = formatCmsDecimal
const ts = (m: bigint | null) => (m === null ? null : formatUtcMicros(m))
const storeOf = (userId: string) => USER_BY_ID.get(userId)?.store ?? null

function visibleUser(v: CmsFxViewer, userId: string): boolean {
  if (v.kind === 'super') return true
  if (v.kind === 'staff') return v.userId === userId
  const s = storeOf(userId)
  return v.kind === 'sm' ? s !== null && CMS_FX_SM_STORES.includes(s) : s === v.storeId
}
const viewerName = (v: CmsFxViewer): CmsResultHeaderDto['viewer'] => (v.kind === 'store_manager' ? 'store_manager' : v.kind)

export interface CmsFxHeaderOpts { held?: boolean; configChanged?: boolean; /** config_reset (mig 125 / 127): pointer NULL sau đổi cấu hình, đã từng công bố. */ reset?: boolean }

export function cmsFxHeader(p: CmsFxProgram, v: CmsFxViewer, o: CmsFxHeaderOpts = {}): CmsResultHeaderDto {
  const r = o.reset ? null : p.run
  const out = o.reset ? null : p.out
  const totals = v.kind === 'super' && out ? {
    lines_read: out.totals.linesRead, candidates: out.totals.candidates, included: out.totals.included, unassigned: out.totals.unassigned,
    out_of_scope: out.totals.outOfScope, adjustment_lines: out.totals.adjustmentLines, candidate_gmv: fmt(out.totals.candidateGmvUnits),
    unassigned_gmv: fmt(out.totals.unassignedGmvUnits), amount_vnd: out.totals.amountVnd.toString(), unassigned_by_reason: { ...out.totals.unassignedByReason },
  } : null
  const startedAt = r ? new Date(Date.parse(r.publishedAt) - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, '.000000Z') : null
  // CMS-UNIT: chương trình cms_unit ⇒ khoá cơ sở dạng 128. reset ⇒ "vừa chuyển cơ sở": lần ok trước theo pos_base_v1, pointer NULL,
  // lượt theo luật mới đang HOLD (cờ tắt) ⇒ basis_pending.
  const u = p.basis === 'cms_unit'
  const meta = (b: 'pos_base' | 'cms_unit') => (u ? { quantity_basis: b, calculation_policy_version: b === 'cms_unit' ? 'cms_unit_v1' : 'pos_base_v1' } : {})
  return parseCmsResultHeader({
    program_id: p.row.id, config_version: o.configChanged ? p.row.configVersion + 1 : p.row.configVersion, viewer: viewerName(v),
    ...(u ? { quantity_basis: 'cms_unit' } : {}),
    run: r ? {
      id: r.id, config_version: r.configVersion, published_at: r.publishedAt, source_max_updated_at: startedAt, started_at: startedAt,
      amount_vnd: v.kind === 'super' && out ? out.totals.amountVnd.toString() : null, rows_read: v.kind === 'super' && out ? out.totals.linesRead : null, totals,
      ...meta('cms_unit'),
    } : null,
    last_attempt: o.reset && p.run && u
      ? { status: 'held', started_at: '2026-11-15T03:00:00.000000Z', finished_at: '2026-11-15T03:00:05.000000Z', is_current: false, error_code: 'UNIT_BASIS_DISABLED', ...meta('cms_unit') }
      : o.reset && p.run
      ? { status: 'ok', started_at: '2026-11-15T01:00:00.000000Z', finished_at: p.run.publishedAt, is_current: false, error_code: null }
      : o.held && r
      ? { status: 'held', started_at: '2026-11-15T03:00:00.000000Z', finished_at: '2026-11-15T03:01:10.000000Z', is_current: false, error_code: u ? 'UNIT_QUANTITY_FRACTION' : 'SOURCE_TIMEOUT', ...meta('cms_unit') }
      : r ? { status: 'ok', started_at: startedAt, finished_at: r.publishedAt, is_current: true, error_code: null, ...meta('cms_unit') } : null,
    recent_runs: null,
  })
}

export function cmsFxRows(p: CmsFxProgram, v: CmsFxViewer): CmsResultRowsDto {
  const out = p.out
  if (!p.run || !out) return { runId: null, results: [], catalog: [], users: [] }
  const results = out.results.filter((r) => visibleUser(v, r.userId))
  const catalog = out.catalog.filter((c) => visibleUser(v, c.userId))
  const userIds = [...new Set(results.map((r) => r.userId))]
  const u = p.basis === 'cms_unit'
  return parseCmsResultRows({
    run_id: p.run.id,
    ...(u ? {
      quantity_basis: 'cms_unit', calculation_policy_version: 'cms_unit_v1',
      units: p.products.map((x) => ({ program_product_id: x.id, product_id: x.productId, unit_cms: x.unitCms, base_quantity_cms: x.baseQuantityCms })),
    } : {}),
    results: results.map((r) => ({
      user_id: r.userId, store_id: r.storeId, program_product_id: p.pp.get(r.productId), product_id: r.productId, gmv_basis: r.gmvBasis,
      base_quantity: fmt(r.baseQuantityUnits), per_unit: fmt(r.perUnitUnits), cms_quantity: r.cmsQuantity.toString(), rewarded_quantity: r.rewardedQuantity.toString(),
      cap_quantity: r.capQuantity === null ? null : r.capQuantity.toString(), at_cap: r.atCap, gmv_amount: fmt(r.gmvUnits),
      gate_gmv: r.gate.gateGmvUnits === null ? null : fmt(r.gate.gateGmvUnits), target_gmv: r.gate.targetVnd === null ? null : r.gate.targetVnd.toString(),
      gate_met: r.gate.met, gate_met_at: ts(r.gate.metAtMicros), potential_amount: r.potentialAmountVnd.toString(), amount_vnd: r.amountVnd.toString(), line_count: r.lineCount,
    })),
    catalog: catalog.map((c) => ({ user_id: c.userId, store_id: c.storeId, catalog_gmv: fmt(c.catalogGmvUnits), target_gmv: c.targetVnd.toString(), met: c.met, met_at: ts(c.metAtMicros), line_count: c.lineCount })),
    users: userIds.map((id) => ({ id, full_name: USER_BY_ID.get(id)?.name ?? 'Dược sĩ mẫu', store_id: storeOf(id) })),
  })
}

/**
 * Dòng D3 / XLSX của run: seq = thứ tự engine trên TOÀN BỘ ứng viên (đã tính + chưa gán + ngoài phạm vi), như cms_sales_lines.
 * `pairs` (user × program_product) giới hạn tập dòng theo các dòng kết quả người xem đọc được.
 */
export function cmsFxLinesOf(p: CmsFxProgram, pairs?: ReadonlySet<string>): CmsResultLineDto[] {
  const out = p.out
  if (!p.run || !out) return []
  const cands = [...out.lines.map((l) => ({ id: l.orderLineId, at: l.completedAtMicros })),
    ...out.excluded.filter((x) => x.reason === 'UNASSIGNED' || x.reason === 'OUT_OF_SCOPE').map((x) => ({ id: x.orderLineId, at: x.completedAtMicros }))]
  cands.sort((a, b) => (a.at === b.at ? compareCmsLineId(a.id, b.id) : a.at < b.at ? -1 : 1))
  const seq = new Map(cands.map((c, i) => [c.id, i]))
  const src = new Map(p.lines.map((l) => [l.orderLineId, l]))
  const rows = out.lines
    .filter((l) => !pairs || pairs.has(`${l.userId}|${p.pp.get(l.productId)}`))
    .map((l) => ({
      seq: seq.get(l.orderLineId)!, order_line_id: l.orderLineId, order_code: l.orderCode, product_id: l.productId, program_product_id: p.pp.get(l.productId),
      user_id: l.userId, store_id: l.storeId, pos_code: l.posCode, completed_at: formatUtcMicros(l.completedAtMicros),
      quantity_raw: src.get(l.orderLineId)?.quantityRaw ?? null, uom_raw: src.get(l.orderLineId)?.uomRaw ?? null,
      base_quantity: fmt(l.baseQuantityUnits), gmv_amount: fmt(l.gmvUnits), base_before: fmt(l.baseBeforeUnits), base_after: fmt(l.baseAfterUnits),
      qty_before: l.qtyBefore.toString(), qty_after: l.qtyAfter.toString(), amount_vnd: l.amountVnd.toString(), status: l.status,
      ...(p.basis === 'cms_unit' ? { unit_match: l.unitMatch === true, counted_quantity: (l.countedQuantity ?? BigInt(0)).toString() } : {}),
    }))
    .sort((a, b) => a.seq - b.seq)
  return parseCmsResultLines({
    run_id: p.run.id, next_after_seq: null, rows,
    ...(p.basis === 'cms_unit' ? { quantity_basis: 'cms_unit', calculation_policy_version: 'cms_unit_v1' } : {}),
  }).rows
}
