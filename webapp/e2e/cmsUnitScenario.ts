// CMS-UNIT — fixture DÙNG CHUNG cho e2e/cms-unit-basis.spec.ts (AC12 fuzz + snapshot / metadata) và scripts/qa-cms-unit-mutation.mjs
// (đột biến engine / khoá đơn vị / metadata trên BẢN SAO lib/ trong thư mục tạm). Chỉ dữ liệu giả (email @cms.example.test, UUID
// 00000000-…); KHÔNG import engine — đầu vào sinh ở đây được đưa vào engine thật hoặc engine đột biến như nhau.

import type { CmsEngineProductInput, CmsEngineProgramInput } from '../lib/cms/engine/config'
import type { CmsStoreRef, CmsUserRef } from '../lib/cms/mapping'
import type { CmsRawRow } from '../lib/cms/source/contract'
import { cmsUnitKey } from '../lib/cms/unitKey'
import { fxSale } from './cmsSourceFixture'
import type { OracleProgram, OracleSeller } from './cmsUnitOracle'

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const S1 = uid(11), S2 = uid(12), S3 = uid(13)
export const A = uid(21), B = uid(22), C = uid(23)
export const USERS: CmsUserRef[] = [
  { id: A, email: 'ds.a@cms.example.test', role: 'staff', storeId: S1 },
  { id: B, email: 'ds.b@cms.example.test', role: 'staff', storeId: S2 },
  { id: C, email: 'ds.c@cms.example.test', role: 'staff', storeId: S3 },
]
export const STORES: CmsStoreRef[] = [S1, S2, S3].map((id) => ({ id, storeType: 'os', isActive: true }))
export const O_SELLERS: OracleSeller[] = USERS.map((u) => ({ email: u.email!, userId: u.id, storeId: u.storeId! }))
export const SCOPE = [S1, S2] // C ⇒ ngoài phạm vi

export const TIERS3 = [{ from: 1, to: 9, amount: '1000' }, { from: 10, to: 19, amount: '2000' }, { from: 20, to: null, amount: '3000' }]
export const P = (productId: string, o: Partial<CmsEngineProductInput> = {}): CmsEngineProductInput => ({
  productId, gmvBasis: 'none', targetGmv: null, baseQuantityCms: '24', tiers: TIERS3, unitCms: 'hộp', ...o,
})
export const prog = (products: CmsEngineProductInput[], o: Partial<CmsEngineProgramInput> = {}): CmsEngineProgramInput => ({
  startDate: '2026-11-05', endDate: '2026-11-06', catalogTargetGmv: null, storeIds: SCOPE, products, quantityBasis: 'cms_unit', ...o,
})
let seq = 0
// Thời điểm tăng đơn điệu theo micro giây trong cùng một giây (≤ 999.999 dòng / lượt) ⇒ thứ tự dòng = thứ tự tạo.
export const L = (o: Partial<Record<string, string | null>> = {}): CmsRawRow => {
  seq += 1
  return fxSale({
    order_line_id: `U-${String(seq).padStart(6, '0')}`, order_id: `O-${seq}`, order_code: `TEST-U${seq}`,
    completed_at: `2026-11-05T03:00:00.${String(seq).padStart(6, '0')}Z`, ...o,
  })
}

// ── AC12: corpus ngẫu nhiên có hạt giống ─────────────────────────────────────────────────────────────────────────────────
export function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** Một kịch bản: 3 SP (đơn vị / loại GMV / bậc ngẫu nhiên), 10–39 dòng (60 % đúng ĐV, biến thể hoa-thường / NFD / khoảng trắng; lượng
 *  âm / lẻ / 0), email chưa gán, ngoài phạm vi, ONLINE, ngoài kỳ; `inject` thêm MỘT dòng nguồn hỏng (HOLD). */
export function scenario(seed: number, inject: boolean) {
  const r = prng(seed)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]
  const units = ['hộp', 'Hộp', 'viên', 'Chai']
  const tierSets = [TIERS3, [{ from: 1, to: null, amount: '700' }], [{ from: 1, to: 4, amount: '100' }, { from: 5, to: null, amount: '250' }]]
  const basis = ['none', 'product', 'catalog'] as const
  const products = ['900001', '900002', '900003'].map((productId) => {
    const g = pick(basis)
    return { productId, unitCms: pick(units), gmvBasis: g, target: g === 'product' ? String(pick([50000, 200000, 1000000])) : null, tiers: pick(tierSets) }
  })
  const catalogTarget = products.some((p) => p.gmvBasis === 'catalog') ? String(pick([100000, 400000])) : null
  const variants: Record<string, string[]> = {
    hộp: ['hộp', 'HỘP', 'Hộp'.normalize('NFD'), ' hộp', 'hộp\u3000'], viên: ['viên', 'VIÊN', 'Viên'], chai: ['chai', 'CHAI', 'Chai '],
  }
  const other = ['vỉ', 'gói', 'box', 'h', 'tuýp']
  const emails = ['ds.a@cms.example.test', 'DS.B@cms.example.test', 'ds.c@cms.example.test', 'nobody@cms.example.test']
  const rows: CmsRawRow[] = []
  const n = 10 + Math.floor(r() * 30)
  for (let i = 0; i < n; i++) {
    const pid = pick(['900001', '900002', '900003', '900004'])
    const p = products.find((x) => x.productId === pid)
    const key = p ? (cmsUnitKey(p.unitCms) as string) : 'hộp'
    const matched = r() < 0.6
    const uom = matched ? pick(variants[key] ?? [p?.unitCms ?? 'hộp']) : pick(other)
    const q = matched ? pick(['1', '2', '3', '10', '0', '1.000000000', '15', '-1']) : pick(['1', '2', '0.5', '12', '1.25', '-2'])
    const neg = q.startsWith('-')
    rows.push(L({
      product_id: pid, seller_email: pick(emails), uom_raw: uom, quantity_raw: q,
      base_quantity: neg ? '-5' : String(1 + Math.floor(r() * 50)), gmv_amount: neg ? '-1000' : String(1000 * (1 + Math.floor(r() * 200))),
      order_type: r() < 0.1 ? 'ONLINE' : 'OFFLINE', completed_at: r() < 0.05 ? '2026-11-07T05:00:00.000000Z' : `2026-11-0${5 + Math.floor(r() * 2)}T0${Math.floor(r() * 9)}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00.000000Z`,
    }))
  }
  if (inject) {
    const pid = products[0].productId
    rows.push(L({ product_id: pid, uom_raw: pick([null, 'hộp\t', products[0].unitCms]), quantity_raw: pick(['0.5', '1.000000001', null, '1e2']), seller_email: pick(emails) }))
  }
  const oprog: OracleProgram = { start: '2026-11-05', end: '2026-11-06', storeIds: SCOPE, catalogTarget, products }
  const eprog = prog(products.map((p) => P(p.productId, { unitCms: p.unitCms, gmvBasis: p.gmvBasis, targetGmv: p.target, tiers: p.tiers })), { catalogTargetGmv: catalogTarget })
  return { rows, oprog, eprog }
}

// ── Snapshot / metadata run (dạng rpc_cms_sales_snapshot / run_open của DB 128) ─────────────────────────────────────────────
export const PROG = uid(1), PP1 = uid(31)
export function snap128(o: Record<string, unknown> = {}, prod: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    program_id: PROG, status: 'active', is_test: true, config_version: 5, start_date: '2026-11-05', end_date: '2026-11-06',
    catalog_target_gmv: null, today_vn: '2026-11-07', current_result_run_id: null, previous_rows_read: null, store_ids: SCOPE,
    quantity_basis: 'cms_unit', calculation_policy_version: 'cms_unit_v1', unit_key_version: 'cms-unit-key-v2',
    products: [{ id: PP1, product_id: '900001', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '24', unit_cms: 'Hộp',
      tiers: [{ order: 1, from: 1, to: null, amount: '1000' }], ...prod }],
    sellers: USERS.map((u) => ({ id: u.id, email: u.email, role: u.role, store_id: u.storeId })),
    stores: STORES.map((s) => ({ id: s.id, store_type: s.storeType, is_active: s.isActive })),
    mapping_fp: 'a'.repeat(32),
    ...o,
  }
}
export function calcOf(s: Record<string, unknown>, o: Record<string, unknown> = {}, prod: Record<string, unknown> = {}): Record<string, unknown> {
  const ps = s.products as Record<string, unknown>[]
  return {
    schema: 'cms-calc-snapshot-v1', quantity_basis: s.quantity_basis, calculation_policy_version: s.calculation_policy_version,
    unit_key_version: s.unit_key_version, quantity_policy: 'x', gmv_policy: 'candidate_lines_all_units_v1', config_version: s.config_version,
    config_fp: 'b'.repeat(32), start_date: s.start_date, end_date: s.end_date, catalog_target_gmv: s.catalog_target_gmv,
    products: ps.map((p) => ({ id: p.id, product_id: p.product_id, unit_cms: p.unit_cms, unit_key: 'hộp', base_quantity_cms: p.base_quantity_cms,
      gmv_basis: p.gmv_basis, target_gmv: p.target_gmv, tiers: p.tiers, ...prod })),
    ...o,
  }
}
export const legacySnap = () => {
  const s = snap128()
  delete s.quantity_basis; delete s.calculation_policy_version; delete s.unit_key_version
  for (const p of s.products as Record<string, unknown>[]) delete p.unit_cms
  return s
}
// calc = null ⇒ run_open KHÔNG trả calculation_snapshot (DB legacy / ca thiếu). Không dùng undefined: tham số mặc định vẫn áp.
export const openOf = (s: Record<string, unknown>, calc: Record<string, unknown> | null = calcOf(s)) =>
  ({ ...s, run_id: uid(99), source_schema: 1, ...(calc === null ? {} : { calculation_snapshot: calc }) })
