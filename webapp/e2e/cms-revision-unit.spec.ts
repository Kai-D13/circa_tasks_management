import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { BigQueryError } from '../lib/bigquery/query'
import { CMS_IMPORT_COLUMNS } from '../lib/cms/import/parse'
import type { CmsAdminAccess, CmsImportDeps, CmsImportRepo, CmsProgramRow } from '../lib/cms/import/handler'
import type { CmsProductMasterLite } from '../lib/cms/import/validate'
import { cmsProgramRevisionFromEnv } from '../lib/cms/flags'
import {
  CMS_REVISION_IMPACT_LIST_MAX, CMS_REVISION_NO_PUBLISHED, cmsRevisionAggregate, computeCmsRevisionImpact, type CmsRevisionDesiredProduct,
  type CmsRevisionImpactDeps, type CmsRevisionImpactResult,
} from '../lib/cms/revision/impact'
import {
  CmsRevisionRpcError, cmsRevisionRpcErrorFrom, handleCmsRevisionCommit, handleCmsRevisionPreview, type CmsRevisionDeps,
} from '../lib/cms/revision/handler'
import {
  cmsRevisionDetailLinks, cmsRevisionGate, cmsRevisionPublishedView, cmsRevisionReasonOk, parseCmsRevisionCapabilities, parseCmsRevisionPreviewReply, type CmsRevisionCapState,
} from '../lib/cms/revision/model'
import { CmsPublishedUnavailable, cmsLoadPublished, type CmsPublishedReader } from '../lib/cms/revision/published'
import { cmsDeltaVnd, cmsRevisionCommitGate, cmsRevisionTiersText } from '../lib/cms/revision/view'
import type { CmsRawRow } from '../lib/cms/source/contract'
import { createCmsContractFixtureProvider } from './cmsContractFixture'
import { createCmsFixtureRunner } from './cmsFixtureRunner'
import { fxSale } from './cmsSourceFixture'

// F-A (PM spec 17/11) — lõi app của sửa chương trình có version, không DB / không mạng (DB 131: scripts/qa-cms-131.mjs PGlite + PG15):
//   REV05 tiền trên cùng nguồn (K10 / mức 100 / B 25 ⇒ Q2 · 200; K5 ⇒ Q5 · 500; K20 ⇒ Q1 · 100; không floor từng đơn) ở dự toán;
//   REV06 nguồn (trước / sau cùng một lần đọc + mapping ghim; thêm SP ⇒ đọc hợp danh mục; nguồn lỗi / HOLD ⇒ impact lỗi, KHÔNG số 0 giả;
//   số đang công bố tách riêng); REV01 cổng route (cờ / quyền / file lỗi / map mã DB / commit shape); cờ + capability + cổng nút ghi.

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROG = uid(1), S1 = uid(11), S2 = uid(12), A = uid(21), B = uid(22), RUN = uid(90)
const NOW = new Date('2026-11-07T03:00:00Z')
const PUB_AT = '2026-11-06T20:00:00.000Z'

const T = (amount: string) => [{ order: 1, from: 1, to: null, amount }]
function snapshot(o: Record<string, unknown> = {}, products?: unknown[]): Record<string, unknown> {
  return {
    program_id: PROG, status: 'active', is_test: true, config_version: 4, start_date: '2026-11-05', end_date: '2026-11-06',
    catalog_target_gmv: null, today_vn: '2026-11-07', current_result_run_id: null, previous_rows_read: null, store_ids: [S1, S2],
    products: products ?? [
      { id: uid(31), product_id: '900001', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '10', unit_cms: 'hộp', tiers: T('100') },
      { id: uid(32), product_id: '900002', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', unit_cms: 'hộp', tiers: T('50') },
    ],
    sellers: [
      { id: A, email: 'ds.a@cms.example.test', role: 'staff', store_id: S1 },
      { id: B, email: 'ds.b@cms.example.test', role: 'staff', store_id: S2 },
    ],
    stores: [S1, S2].map((id) => ({ id, store_type: 'os', is_active: true })),
    mapping_fp: 'b'.repeat(32),
    ...o,
  }
}
const L = (n: number, o: Partial<Record<string, string | null>>) => fxSale({ order_line_id: `R-${n}`, completed_at: `2026-11-05T0${n % 10}:00:00.000000Z`, ...o })
// 900001: B = 7 + 8 + 10 = 25 (dược sĩ A) · 900002: B = 3 (dược sĩ B) · 900003 (chỉ có sau khi thêm): B = 30 (A).
const SALES: CmsRawRow[] = [
  L(1, { base_quantity: '7' }), L(2, { base_quantity: '8' }), L(3, { base_quantity: '10' }),
  L(4, { product_id: '900002', base_quantity: '3', seller_email: 'ds.b@cms.example.test' }),
  L(5, { product_id: '900003', base_quantity: '30' }),
]
const want = (pid: string, k: string, amount: string, o: Partial<CmsRevisionDesiredProduct> = {}): CmsRevisionDesiredProduct =>
  ({ product_id: pid, gmv_basis: 'none', target_gmv: null, unit_cms: 'hộp', base_quantity_cms: k, tiers: T(amount), ...o })

// r3 (P1-03): reader giả cùng hợp đồng reader thật (header cms_sync_runs + trang cms_results xếp user_id, program_product_id).
const pubHeader = (o: Record<string, unknown> = {}) => ({ id: RUN, program_id: PROG, kind: 'sales', status: 'ok', published_at: PUB_AT, purged_at: null,
  amount_vnd: '250', config_version: 4, results_expected: '2', ...o })
const pubRow = (user: string, pp: number, amount: string) => ({ user_id: user, program_product_id: uid(pp), amount_vnd: amount })
function fakeReader(header: unknown, rows: unknown[], o: { pages?: (from: number, to: number) => unknown[]; headers?: unknown[]; fail?: 'header' | 'page' } = {}) {
  const log = { header: 0, pages: [] as [number, number][] }
  const hs = o.headers ?? []
  const reader: CmsPublishedReader = {
    header: async () => { log.header++; if (o.fail === 'header') throw new Error('net'); return log.header > 1 && hs.length ? hs[Math.min(log.header - 2, hs.length - 1)] : header },
    page: async (_run, from, to) => { log.pages.push([from, to]); if (o.fail === 'page') throw new Error('net'); return o.pages ? o.pages(from, to) : rows.slice(from, to + 1) },
  }
  return Object.assign(reader, { log })
}

function impactDeps(o: Partial<CmsRevisionImpactDeps> & { snap?: Record<string, unknown>; sales?: CmsRawRow[]; fail?: Error } = {}) {
  const calls = { snapshot: 0, published: 0, runner: 0, ids: [] as string[][] }
  const inner = createCmsFixtureRunner({ sales: o.sales ?? SALES, fail: o.fail })
  const d: CmsRevisionImpactDeps = {
    table: 'qa-project.dataset.cms_sales',
    runner: async (sql, params, opts) => {
      calls.runner++
      const p = params.find((x) => x.name === 'product_ids')
      calls.ids.push(p && 'values' in p ? p.values.map(String) : [])
      return inner(sql, params, opts)
    },
    loadSnapshot: async () => { calls.snapshot++; return o.snap ?? snapshot() },
    loadPublished: async () => { calls.published++; return { amountVnd: '250', byUser: new Map([[A, BigInt(200)], [B, BigInt(50)]]), configVersion: 4, publishedAt: PUB_AT, rows: 2 } },
    calcModes: true, deadlineMs: 5_000, now: () => NOW,
    ...o,
  }
  return { d, calls }
}
const okImpact = (r: CmsRevisionImpactResult) => { if (!r.ok) throw new Error(`impact lỗi ${r.code}`); return r }
const person = (r: CmsRevisionImpactResult, u: string) => okImpact(r).impact.persons.find((p) => p.user_id === u)

test.describe('F-A · dự toán tác động (REV05 / REV06) @desktop', () => {
  test('REV05: cùng nguồn B 25 — K10 / 100 ⇒ Q2 · 200; K5 ⇒ Q5 · 500 (+300); K20 ⇒ Q1 · 100 (−100); Q theo TỔNG, không floor từng đơn', async () => {
    const k5 = okImpact(await computeCmsRevisionImpact(impactDeps().d, PROG, [want('900001', '5', '100'), want('900002', '1', '50')]))
    expect(k5.impact.status).toBe('ok')
    expect(k5.impact.path).toBe('legacy')
    const pa = k5.impact.products.find((p) => p.product_id === '900001')!
    expect([pa.before_qty, pa.before_vnd, pa.after_qty, pa.after_vnd, pa.delta_vnd]).toEqual(['2', '200', '5', '500', '300'])
    expect(person(k5, A)).toMatchObject({ before_vnd: '200', after_vnd: '500', delta_vnd: '300' })
    expect(k5.impact.totals).toMatchObject({ before_vnd: '350', after_vnd: '650', delta_vnd: '300', up: 1, down: 0, same: 1 })
    const k20 = okImpact(await computeCmsRevisionImpact(impactDeps().d, PROG, [want('900001', '20', '100'), want('900002', '1', '50')]))
    expect(k20.impact.products.find((p) => p.product_id === '900001')).toMatchObject({ after_qty: '1', after_vnd: '100', delta_vnd: '-100' })
    expect(k20.impact.totals).toMatchObject({ delta_vnd: '-100', up: 0, down: 1, same: 1 })
    // Giảm được phép (không ép mới ≥ cũ) — người giảm đứng đầu danh sách.
    expect(k20.impact.persons[0]).toMatchObject({ user_id: A, delta_vnd: '-100' })
    // Đổi mức thưởng (K giữ) cũng tính lại đúng.
    const t = okImpact(await computeCmsRevisionImpact(impactDeps().d, PROG, [want('900001', '10', '150'), want('900002', '1', '50')]))
    expect(person(t, A)).toMatchObject({ before_vnd: '200', after_vnd: '300' })
  })

  test('REV06: MỘT lần đọc nguồn cho hợp danh mục trước ∪ sau; SP thêm có số thật (không 0 giả); SP bỏ ⇒ về 0 ở phía sau', async () => {
    const { d, calls } = impactDeps()
    const add = okImpact(await computeCmsRevisionImpact(d, PROG, [want('900001', '10', '100'), want('900003', '10', '50')]))
    expect(calls.runner).toBe(1)
    expect(calls.ids[0]).toEqual(['900001', '900002', '900003'])
    const p3 = add.impact.products.find((p) => p.product_id === '900003')!
    expect([p3.before_vnd, p3.after_qty, p3.after_vnd]).toEqual(['0', '3', '150'])
    const p2 = add.impact.products.find((p) => p.product_id === '900002')!
    expect([p2.before_vnd, p2.after_vnd]).toEqual(['150', '0'])
    expect(person(add, B)).toMatchObject({ before_vnd: '150', after_vnd: '0', delta_vnd: '-150' })
    expect(add.impact.totals).toMatchObject({ products_before: 2, products_after: 2, rows_read: 5 })
    // Nguồn ghim: mapping của snapshot + digest dòng ổn định khi đổi thứ tự nguồn.
    expect(add.source).toMatchObject({ mapping_fp: 'b'.repeat(32), provider: 'bq', rows_read: 5, product_ids: 3 })
    const again = okImpact(await computeCmsRevisionImpact(impactDeps({ sales: [...SALES].reverse() }).d, PROG, [want('900001', '10', '100'), want('900003', '10', '50')]))
    expect(again.source.lines_digest).toBe(add.source.lines_digest)
    expect(add.impact.from_config_version).toBe(4)
  })

  test('REV06: số đang công bố đi RIÊNG (run + theo người), không trộn vào chênh lệch cấu hình', async () => {
    const { d, calls } = impactDeps({ snap: snapshot({ current_result_run_id: RUN }) })
    const r = okImpact(await computeCmsRevisionImpact(d, PROG, [want('900001', '5', '100'), want('900002', '1', '50')]))
    expect(calls.published).toBe(1)
    expect(r.impact.totals).toMatchObject({ published_vnd: '250', published_run_id: RUN, published_config_version: 4, published_at: PUB_AT, published_current: true,
      before_vnd: '350', delta_vnd: '300' })
    expect(person(r, A)?.published_vnd).toBe('200')
    expect(cmsRevisionPublishedView(r.impact.totals!)).toMatchObject({ kind: 'current', column: 'Đang công bố' })
    const bad = await computeCmsRevisionImpact(impactDeps({ snap: snapshot({ current_result_run_id: RUN }), loadPublished: async () => { throw new Error('x') } }).d, PROG, [want('900001', '5', '100')])
    expect(okImpact(bad).impact).toMatchObject({ status: 'error', code: 'PUBLISHED_UNAVAILABLE', totals: null })
  })

  test('r3 P1-03: chưa có run ⇒ số đã công bố NULL (không 0); sửa liền hai lần chưa có run mới ⇒ "bản công bố trước" có version, không "đang công bố"', async () => {
    const none = okImpact(await computeCmsRevisionImpact(impactDeps().d, PROG, [want('900001', '5', '100'), want('900002', '1', '50')]))
    expect(none.impact.totals).toMatchObject({ published_vnd: null, published_run_id: null, published_config_version: null, published_at: null, published_current: null })
    expect(none.impact.persons.every((p) => p.published_vnd === null)).toBe(true)
    expect(cmsRevisionPublishedView(none.impact.totals!)).toMatchObject({ kind: 'none' })
    // Cấu hình v6 (đã sửa v4→v5→v6), pointer vẫn trỏ run v4 (chưa có lượt tính mới).
    const prior = okImpact(await computeCmsRevisionImpact(impactDeps({ snap: snapshot({ current_result_run_id: RUN, config_version: 6 }) }).d, PROG, [want('900001', '5', '100'), want('900002', '1', '50')]))
    expect(prior.impact.totals).toMatchObject({ published_run_id: RUN, published_config_version: 4, published_current: false, published_vnd: '250' })
    expect(prior.impact.from_config_version).toBe(6)
    expect(cmsRevisionPublishedView(prior.impact.totals!)).toEqual({ kind: 'prior', label: 'Bản công bố trước thay đổi cấu hình v4', column: 'Bản công bố trước v4' })
    // Không rõ trạng thái hiện hành ⇒ KHÔNG gọi "đang công bố" (bảo thủ).
    expect(cmsRevisionPublishedView({ published_run_id: RUN, published_current: null, published_config_version: null }).kind).toBe('prior')
  })

  test('r3 P1-03: path đọc THẬT (cmsLoadPublished + reader) nối vào dự toán — run bị dọn / tổng lệch ⇒ PUBLISHED_UNAVAILABLE, không ghi được', async () => {
    const goodRows = [pubRow(A, 31, '200'), pubRow(B, 32, '50')]
    const ok = okImpact(await computeCmsRevisionImpact(impactDeps({ snap: snapshot({ current_result_run_id: RUN }),
      loadPublished: (p, r) => cmsLoadPublished(fakeReader(pubHeader(), goodRows), p, r) }).d, PROG, [want('900001', '5', '100'), want('900002', '1', '50')]))
    expect(ok.impact.totals).toMatchObject({ published_vnd: '250', published_current: true })
    expect(person(ok, A)?.published_vnd).toBe('200')
    for (const reader of [fakeReader(pubHeader({ purged_at: '2026-11-07T01:00:00Z' }), goodRows), fakeReader(pubHeader(), [goodRows[0]]),
      fakeReader(pubHeader({ amount_vnd: '999' }), goodRows)]) {
      const r = okImpact(await computeCmsRevisionImpact(impactDeps({ snap: snapshot({ current_result_run_id: RUN }), loadPublished: (p, x) => cmsLoadPublished(reader, p, x) }).d,
        PROG, [want('900001', '5', '100'), want('900002', '1', '50')]))
      expect(r.impact).toMatchObject({ status: 'error', code: 'PUBLISHED_UNAVAILABLE', totals: null, persons: [] })
    }
  })

  test('REV06: nguồn lỗi / HOLD chất lượng / dòng âm chương trình thật ⇒ status error + mã, totals null (không 0 giả)', async () => {
    const src = okImpact(await computeCmsRevisionImpact(impactDeps({ fail: new BigQueryError('timeout', 'x') }).d, PROG, [want('900001', '5', '100')]))
    expect(src.impact).toMatchObject({ status: 'error', totals: null, persons: [], products: [] })
    expect(src.impact.code).toMatch(/^SOURCE_/)
    const unassigned = SALES.map((x) => ({ ...x, seller_email: 'la@cms.example.test' }))
    const held = okImpact(await computeCmsRevisionImpact(impactDeps({ sales: unassigned }).d, PROG, [want('900001', '5', '100'), want('900002', '1', '50')]))
    expect(held.impact).toMatchObject({ status: 'error', code: 'UNASSIGNED_OVER_THRESHOLD', totals: null })
    const neg = [...SALES, L(6, { base_quantity: '-2', gmv_amount: '-20000' })]
    const real = okImpact(await computeCmsRevisionImpact(impactDeps({ sales: neg, snap: snapshot({ is_test: false }) }).d, PROG, [want('900001', '5', '100'), want('900002', '1', '50')]))
    expect(real.impact).toMatchObject({ status: 'error', code: 'RETURNS_NOT_SUPPORTED' })
    const unconv = [...SALES, L(7, { product_id: '900003', base_quantity: '1.0000000001' })]
    const conv = okImpact(await computeCmsRevisionImpact(impactDeps({ sales: unconv }).d, PROG, [want('900001', '5', '100'), want('900003', '10', '50')]))
    expect(conv.impact).toMatchObject({ status: 'error', code: 'UNCONVERTED_UNITS' })
    // Dòng lỗi chỉ của SP KHÔNG thuộc phía nào ⇒ không ảnh hưởng (nguồn chỉ đọc hợp danh mục).
    const other = okImpact(await computeCmsRevisionImpact(impactDeps({ sales: unconv }).d, PROG, [want('900001', '5', '100'), want('900002', '1', '50')]))
    expect(other.impact.status).toBe('ok')
    expect(await computeCmsRevisionImpact(impactDeps({ loadSnapshot: async () => { throw new Error('x') } }).d, PROG, [])).toEqual({ ok: false, code: 'SNAPSHOT_FAILED' })
    expect(await computeCmsRevisionImpact(impactDeps({ snap: snapshot({ program_id: uid(2) }) }).d, PROG, [])).toEqual({ ok: false, code: 'SNAPSHOT_INVALID' })
    const noTable = okImpact(await computeCmsRevisionImpact(impactDeps({ table: null }).d, PROG, [want('900001', '5', '100')]))
    expect(noTable.impact).toMatchObject({ status: 'error', code: 'SOURCE_CONFIG_MISSING' })
  })

  test('nháp / chưa tới ngày bắt đầu ⇒ ok với 0 THẬT, không đọc nguồn / không đọc số công bố', async () => {
    for (const snap of [snapshot({ status: 'draft' }), snapshot({ today_vn: '2026-11-04' })]) {
      const { d, calls } = impactDeps({ snap })
      const r = okImpact(await computeCmsRevisionImpact(d, PROG, [want('900001', '5', '100')]))
      expect(r.impact).toMatchObject({ status: 'ok', path: 'not_started', totals: { before_vnd: '0', after_vnd: '0', persons: 0, published_run_id: null } })
      expect([calls.runner, calls.published]).toEqual([0, 0])
    }
    // r3 (P1-01/03): chưa tới ngày bắt đầu nhưng ĐÃ có run ⇒ vẫn đọc + ghim run đó (DB preview đối chiếu published_run_id = pointer).
    const pre = impactDeps({ snap: snapshot({ today_vn: '2026-11-04', current_result_run_id: RUN }) })
    const rp = okImpact(await computeCmsRevisionImpact(pre.d, PROG, [want('900001', '5', '100')]))
    expect(rp.impact).toMatchObject({ status: 'ok', path: 'not_started', totals: { published_run_id: RUN, published_vnd: '250' } })
    expect([pre.calls.runner, pre.calls.published]).toEqual([0, 1])
    const preBad = okImpact(await computeCmsRevisionImpact(impactDeps({ snap: snapshot({ today_vn: '2026-11-04', current_result_run_id: RUN }), loadPublished: async () => { throw new Error('x') } }).d,
      PROG, [want('900001', '5', '100')]))
    expect(preBad.impact).toMatchObject({ status: 'error', code: 'PUBLISHED_UNAVAILABLE', path: 'not_started', totals: null })
  })

  test('contract cms_unit (sales_only): tính bằng computeCmsNet, đơn vị / số nguyên; cờ OFF / net / fixture chương trình thật ⇒ lỗi', async () => {
    const cu = (q: string, n: number, pid = '900001') => L(n, { product_id: pid, quantity_raw: q, uom_raw: 'Hộp', base_quantity: q })
    const products = [{ id: uid(31), product_id: '900001', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', unit_cms: 'Hộp', tiers: T('100') }]
    const snap = snapshot({ quantity_basis: 'cms_unit', returns_policy: 'sales_only_v1' }, products)
    const provider = createCmsContractFixtureProvider({ sales: [cu('2', 1), cu('3', 2)] })
    const r = okImpact(await computeCmsRevisionImpact(impactDeps({ snap, contractProvider: provider, asOfMicros: () => BigInt(Date.parse('2026-11-07T00:00:00Z')) * BigInt(1000) }).d,
      PROG, [want('900001', '1', '150', { unit_cms: 'Hộp' })]))
    expect(r.impact).toMatchObject({ status: 'ok', path: 'contract' })
    expect(r.impact.products[0]).toMatchObject({ before_qty: '5', before_vnd: '500', after_qty: '5', after_vnd: '750', delta_vnd: '250' })
    expect(r.source.provider).toBe('fixture')
    const off = okImpact(await computeCmsRevisionImpact(impactDeps({ snap, contractProvider: provider, calcModes: false }).d, PROG, [want('900001', '1', '150')]))
    expect(off.impact.code).toBe('CALC_MODES_DISABLED')
    const net = okImpact(await computeCmsRevisionImpact(impactDeps({ snap: { ...snap, returns_policy: 'net_returns_v1' }, contractProvider: provider }).d, PROG, [want('900001', '1', '150')]))
    expect(net.impact.code).toBe('NET_UNSUPPORTED')
    const real = okImpact(await computeCmsRevisionImpact(impactDeps({ snap: { ...snap, is_test: false }, contractProvider: provider }).d, PROG, [want('900001', '1', '150')]))
    expect(real.impact.code).toBe('FIXTURE_REAL_PROGRAM')
  })

  test('gộp: người giảm nhiều nhất trước; danh sách cắt ở trần nhưng TỔNG đủ', () => {
    const n = CMS_REVISION_IMPACT_LIST_MAX + 5
    const before = { results: Array.from({ length: n }, (_, i) => ({ userId: uid(1000 + i), storeId: S1, productId: '900001', amountVnd: BigInt(100), cmsQuantity: BigInt(1) })), total: BigInt(100 * n), candidates: n, unassigned: 0 }
    const after = { ...before, results: before.results.map((x, i) => ({ ...x, amountVnd: BigInt(i % 2 ? 50 : 150) })), total: BigInt(0) }
    after.total = after.results.reduce((s, x) => s + x.amountVnd, BigInt(0))
    const g = cmsRevisionAggregate(before, after, CMS_REVISION_NO_PUBLISHED, { productsBefore: 1, productsAfter: 1, rowsRead: n })
    expect(g.persons.length).toBe(CMS_REVISION_IMPACT_LIST_MAX)
    expect(g.truncated.persons).toBe(true)
    expect(g.persons[0].delta_vnd).toBe('-50')
    expect(g.totals.persons).toBe(n)
    expect(g.totals.up + g.totals.down + g.totals.same).toBe(n)
  })
})

// ── r3 (PM P1-03) bộ đọc số đã công bố — fail-closed ───────────────────────────
test.describe('F-A r3 · cmsLoadPublished (P1-03) @desktop', () => {
  const reason = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e) { return e instanceof CmsPublishedUnavailable ? e.reason : `KHÁC:${String(e)}` } }
  const rowsN = (n: number) => Array.from({ length: n }, (_, i) => pubRow(uid(2000 + Math.floor(i / 3)), 3000 + i, '10'))

  test('hợp lệ: đủ trang (biên trang đúng PAGE), Σ = header, số dòng = niêm phong; header 0 + 0 dòng ⇒ 0 THẬT', async () => {
    const rows = rowsN(7)
    const rd = fakeReader(pubHeader({ amount_vnd: '70', results_expected: '7' }), rows)
    const r = await cmsLoadPublished(rd, PROG, RUN, { pageSize: 3 })
    expect([r.amountVnd, r.rows, r.configVersion, r.publishedAt]).toEqual(['70', 7, 4, PUB_AT])
    expect(rd.log.pages).toEqual([[0, 2], [3, 5], [6, 8]])
    expect(rd.log.header).toBe(2)
    // Đúng bội số trang: phải đọc thêm một trang rỗng mới kết thúc.
    const six = fakeReader(pubHeader({ amount_vnd: '60', results_expected: 6 }), rowsN(6))
    expect((await cmsLoadPublished(six, PROG, RUN, { pageSize: 3 })).rows).toBe(6)
    expect(six.log.pages.length).toBe(3)
    const empty = await cmsLoadPublished(fakeReader(pubHeader({ amount_vnd: '0', results_expected: '0' }), []), PROG, RUN)
    expect([empty.amountVnd, empty.byUser.size, empty.rows]).toEqual(['0', 0, 0])
  })

  test('header: thiếu / khác chương trình / kind / chưa công bố / held / purge / tổng hoặc số niêm phong lạ ⇒ từ chối', async () => {
    const rows = [pubRow(A, 31, '200'), pubRow(B, 32, '50')]
    const cases: [unknown, string][] = [
      [null, 'RUN_MISSING'], [pubHeader({ program_id: uid(2) }), 'RUN_PROGRAM_MISMATCH'], [pubHeader({ kind: 'products' }), 'RUN_KIND'],
      [pubHeader({ status: 'held' }), 'RUN_NOT_PUBLISHED'], [pubHeader({ status: 'error' }), 'RUN_NOT_PUBLISHED'], [pubHeader({ published_at: null }), 'RUN_NOT_PUBLISHED'],
      [pubHeader({ purged_at: '2026-11-07T00:00:00Z' }), 'RUN_PURGED'], [pubHeader({ amount_vnd: null }), 'RUN_HEADER_INVALID'], [pubHeader({ amount_vnd: '-1' }), 'RUN_HEADER_INVALID'],
      [pubHeader({ amount_vnd: '2.5' }), 'RUN_HEADER_INVALID'], [pubHeader({ results_expected: null }), 'RUN_HEADER_INVALID'], [pubHeader({ config_version: 0 }), 'RUN_HEADER_INVALID'],
      [pubHeader({ id: uid(91) }), 'RUN_HEADER_INVALID'],
    ]
    for (const [h, want] of cases) expect(await reason(cmsLoadPublished(fakeReader(h, rows), PROG, RUN)), JSON.stringify(h)).toBe(want)
  })

  test('trang: thiếu trang / trang lặp / chồng / đảo thứ tự / dòng lạ / Σ lệch / vượt trần / lỗi mạng ⇒ từ chối (không số 0 giả)', async () => {
    const rows = rowsN(7)
    const H = pubHeader({ amount_vnd: '70', results_expected: '7' })
    // Thiếu trang: trang 2 trả rỗng.
    expect(await reason(cmsLoadPublished(fakeReader(H, rows, { pages: (f, t) => (f === 3 ? [] : rows.slice(f, t + 1)) }), PROG, RUN, { pageSize: 3 }))).toBe('ROWS_COUNT_MISMATCH')
    // Trang lặp (offset trôi do dữ liệu đổi): trang 2 = trang 1.
    expect(await reason(cmsLoadPublished(fakeReader(H, rows, { pages: (f, t) => (f === 3 ? rows.slice(0, 3) : rows.slice(f, t + 1)) }), PROG, RUN, { pageSize: 3 }))).toBe('ROWS_ORDER')
    // Chồng một dòng giữa hai trang.
    expect(await reason(cmsLoadPublished(fakeReader(H, rows, { pages: (f) => rows.slice(Math.max(0, f - 1), Math.max(0, f - 1) + 3) }), PROG, RUN, { pageSize: 3 }))).toBe('ROWS_ORDER')
    // Đảo thứ tự trong trang.
    expect(await reason(cmsLoadPublished(fakeReader(H, [...rows].reverse()), PROG, RUN))).toBe('ROWS_ORDER')
    // Dòng thừa so với niêm phong / thiếu.
    expect(await reason(cmsLoadPublished(fakeReader(pubHeader({ amount_vnd: '70', results_expected: '6' }), rows), PROG, RUN))).toBe('ROWS_COUNT_MISMATCH')
    expect(await reason(cmsLoadPublished(fakeReader(pubHeader({ amount_vnd: '70', results_expected: '8' }), rows), PROG, RUN))).toBe('ROWS_COUNT_MISMATCH')
    // Σ lệch header.
    expect(await reason(cmsLoadPublished(fakeReader(pubHeader({ amount_vnd: '71', results_expected: '7' }), rows), PROG, RUN))).toBe('ROWS_SUM_MISMATCH')
    // Dòng lạ.
    for (const bad of [{ ...rows[0], amount_vnd: '-5' }, { ...rows[0], amount_vnd: '1.5' }, { ...rows[0], user_id: 'x' }, { ...rows[0], program_product_id: null }, 'row']) {
      expect(await reason(cmsLoadPublished(fakeReader(H, [bad, ...rows.slice(1)]), PROG, RUN))).toBe('ROW_INVALID')
    }
    // Vượt trần trang.
    expect(await reason(cmsLoadPublished(fakeReader(H, rows), PROG, RUN, { pageSize: 2, maxPages: 3 }))).toBe('ROWS_TOO_MANY')
    // Reader trả nhiều hơn trang yêu cầu / không phải mảng / lỗi mạng.
    expect(await reason(cmsLoadPublished(fakeReader(H, rows, { pages: () => rows }), PROG, RUN, { pageSize: 3 }))).toBe('READ_FAILED')
    expect(await reason(cmsLoadPublished(fakeReader(H, rows, { pages: () => null as unknown as unknown[] }), PROG, RUN))).toBe('READ_FAILED')
    expect(await reason(cmsLoadPublished(fakeReader(H, rows, { fail: 'page' }), PROG, RUN))).toBe('READ_FAILED')
    expect(await reason(cmsLoadPublished(fakeReader(H, rows, { fail: 'header' }), PROG, RUN))).toBe('READ_FAILED')
  })

  test('purge bắt đầu TRONG lúc đọc (header lần 2 có purged_at) / header đổi ⇒ từ chối dù số dòng tình cờ khớp', async () => {
    const rows = [pubRow(A, 31, '200'), pubRow(B, 32, '50')]
    expect(await reason(cmsLoadPublished(fakeReader(pubHeader(), rows, { headers: [pubHeader({ purged_at: '2026-11-07T00:00:01Z' })] }), PROG, RUN))).toBe('RUN_PURGED')
    expect(await reason(cmsLoadPublished(fakeReader(pubHeader(), rows, { headers: [pubHeader({ published_at: '2026-11-07T00:00:02.000Z' })] }), PROG, RUN))).toBe('RUN_HEADER_INVALID')
    const ok = await cmsLoadPublished(fakeReader(pubHeader(), rows), PROG, RUN)
    expect([ok.byUser.get(A), ok.byUser.get(B)]).toEqual([BigInt(200), BigInt(50)])
  })
})

// ── Route ────────────────────────────────────────────────────────────────────

const PID = { active: uid(101), locked: uid(102), draft: uid(103) }
const prog = (id: string, status: CmsProgramRow['status']): CmsProgramRow =>
  ({ id, status, startDate: '2026-11-05', endDate: '2026-11-30', isTest: false, configVersion: 4, catalogTargetGmv: null })
function book(rows: (string | number | null)[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([[...CMS_IMPORT_COLUMNS], ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'IMPORT_CMS')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
const row = (pid: number, k: number, cms: number) => [pid, null, null, 1, null, cms, 'Tư vấn đã duyệt', 'hộp', k]
const GOOD = book([row(900001, 5, 100), row(900002, 1, 50)])
const BAD = book([row(900001, 5, 100), row(900009, 1, 50)]) // 900009 không có trên Product Master ⇒ nhóm lỗi

class Repo implements CmsImportRepo {
  pm = new Map<string, CmsProductMasterLite>([
    ['900001', { productName: 'SP giả 1', imageUrl: null, isActive: true, referencePrice: null }],
    ['900002', { productName: 'SP giả 2', imageUrl: null, isActive: true, referencePrice: null }],
  ])
  programs = new Map([[PID.active, prog(PID.active, 'active')], [PID.locked, prog(PID.locked, 'locked')], [PID.draft, prog(PID.draft, 'draft')]])
  async getProgram(id: string) { return this.programs.get(id) ?? null }
  async loadContext() { return { productMaster: this.pm, existingProductIds: new Set(['900001', '900002']), conflictProductIds: new Set<string>() } }
  async savePreview(): Promise<string> { throw new Error('revision không được lưu import run') }
  async commit(): Promise<never> { throw new Error('revision không được gọi commit import') }
  async getRun() { return null }
}

const REPLY = {
  revision_id: uid(500), program_id: PID.active, from_config_version: 4, expected_run_id: null, payload_digest: 'c'.repeat(64),
  expires_at: '2026-11-07T03:15:00.000000Z', impact_ok: true,
  diff: { add: 0, readd: 0, change: 1, keep: 1, remove: 0, removed: [], products_after: 2, items: [
    { product_id: '900001', action: 'change', k_before: '10', k_after: '5', tiers_before: T('100'), tiers_after: T('100'), advice_changed: false, unit_cms: 'hộp', name: 'SP giả 1' },
    { product_id: '900002', action: 'keep', k_before: '1', k_after: '1', tiers_before: T('50'), tiers_after: T('50'), advice_changed: false, unit_cms: 'hộp', name: 'SP giả 2' },
  ] },
}

function rdeps(o: { enabled?: boolean; access?: CmsAdminAccess; impact?: CmsRevisionDeps['impact']; preview?: CmsRevisionDeps['rpcPreview']; commit?: CmsRevisionDeps['rpcCommit'] } = {}) {
  const log = { access: 0, impact: [] as CmsRevisionDesiredProduct[][], preview: [] as Record<string, unknown>[], commit: [] as Parameters<CmsRevisionDeps['rpcCommit']>[0][] }
  const importDeps: CmsImportDeps = { enabled: true, getAccess: async () => ({ kind: 'forbidden' }), repo: new Repo(), now: () => NOW }
  const d: CmsRevisionDeps = {
    enabled: async () => o.enabled ?? true,
    getAccess: async () => { log.access++; return o.access ?? { kind: 'ok', actorId: uid(700), qa: false } },
    importDeps,
    impact: o.impact ?? (async (pid, desired) => {
      log.impact.push(desired)
      return computeCmsRevisionImpact(impactDeps({ snap: snapshot({ program_id: pid }) }).d, pid, desired)
    }),
    rpcPreview: async (p) => { log.preview.push(p); return o.preview ? o.preview(p) : { ...REPLY, program_id: p.program_id } },
    rpcCommit: async (a) => { log.commit.push(a); return o.commit ? o.commit(a) : { already: false, revision_id: a.revisionId, program_id: PID.active, from_config_version: 4, to_config_version: 5, archive_mode: 'copied', archive_rows: 3, retired: 0, deleted: 0 } },
    loadNames: async (ids) => Object.fromEntries(ids.map((x) => [x, `Tên ${x.slice(-2)}`])),
    now: () => NOW,
  }
  return { d, log }
}

async function mpPreview(d: CmsRevisionDeps, programId: string, bytes: Uint8Array, headers: Record<string, string> = {}) {
  const fd = new FormData()
  fd.append('program_id', programId)
  fd.append('file', new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'sua.xlsx')
  const tmp = new Response(fd)
  const body = new Uint8Array(await tmp.arrayBuffer())
  return handleCmsRevisionPreview(new Request('http://x/api/cms/revision/preview', {
    method: 'POST', body, headers: { 'content-type': tmp.headers.get('content-type')!, 'content-length': String(body.byteLength), ...headers },
  }), d)
}
const COMMIT = { revision_id: uid(500), expected_config_version: 4, payload_digest: 'c'.repeat(64), idempotency_key: uid(600), reason: '  Cập nhật K theo quy cách mới  ', ack: { whole_period: true, may_decrease: true, removed: ['900002', '900001'] } }
const commitReq = (d: CmsRevisionDeps, b: unknown = COMMIT, headers: Record<string, string> = {}) =>
  handleCmsRevisionCommit(new Request('http://x/api/cms/revision/commit', { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b), headers: { 'content-type': 'application/json', ...headers } }), d)
const json = async (r: Response) => r.json() as Promise<Record<string, unknown> & { code?: string }>

test.describe('F-A · route sửa chương trình (REV01 / REV07) @desktop', () => {
  test('cờ / năng lực OFF ⇒ 404 trước mọi tra quyền; ma trận quyền 401 / 403 / 503 cho cả preview và commit', async () => {
    const off = rdeps({ enabled: false })
    expect((await mpPreview(off.d, PID.active, GOOD)).status).toBe(404)
    expect((await commitReq(off.d)).status).toBe(404)
    expect(off.log.access).toBe(0)
    for (const [access, status] of [[{ kind: 'anonymous' }, 401], [{ kind: 'forbidden' }, 403], [{ kind: 'unavailable' }, 503]] as const) {
      const x = rdeps({ access })
      expect((await mpPreview(x.d, PID.active, GOOD)).status).toBe(status)
      expect((await commitReq(x.d)).status).toBe(status)
      expect([x.log.impact.length, x.log.preview.length, x.log.commit.length]).toEqual([0, 0, 0])
    }
  })

  test('preview: chương trình đã chốt ⇒ 409 LOCKED; file còn nhóm lỗi ⇒ 422 FILE_HAS_ERRORS kèm tóm tắt, KHÔNG dự toán / RPC', async () => {
    const x = rdeps()
    const locked = await mpPreview(x.d, PID.locked, GOOD)
    expect([locked.status, (await json(locked)).code]).toEqual([409, 'LOCKED'])
    const bad = await mpPreview(x.d, PID.active, BAD)
    const b = await json(bad)
    expect([bad.status, b.code]).toEqual([422, 'FILE_HAS_ERRORS'])
    const an = b.analysis as { groupsRejected: { key: string }[]; issueSummary: unknown[]; groupsOk: unknown[] }
    expect(an.groupsRejected.map((g) => g.key)).toEqual(['900009'])
    expect(an.issueSummary.length).toBeGreaterThan(0)
    expect([x.log.impact.length, x.log.preview.length]).toEqual([0, 0])
    expect((await mpPreview(x.d, uid(999), GOOD)).status).toBe(404)
  })

  test('preview hợp lệ: dự toán trên danh mục mong muốn của file ⇒ RPC (session) nhận payload + impact + nguồn ghim; trả diff + tên', async () => {
    const x = rdeps()
    const r = await mpPreview(x.d, PID.active, GOOD)
    const b = await json(r)
    expect(r.status).toBe(200)
    expect(x.log.impact[0].map((p) => [p.product_id, p.base_quantity_cms, p.tiers[0].amount])).toEqual([['900001', '5', '100'], ['900002', '1', '50']])
    const p = x.log.preview[0] as { program_id: string; file_sha256: string; products: unknown[]; impact: { status: string; from_config_version: number }; source: { mapping_fp: string } }
    expect([p.program_id, p.products.length, p.impact.status, p.impact.from_config_version, p.source.mapping_fp]).toEqual([PID.active, 2, 'ok', 4, 'b'.repeat(32)])
    expect(p.file_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(p).not.toHaveProperty('actor')
    expect((b.revision as { revisionId: string; diff: { items: unknown[] } }).revisionId).toBe(uid(500))
    expect((b.revision as { diff: { items: unknown[] } }).diff.items.length).toBe(2)
    expect(Object.keys(b.names as object).length).toBeGreaterThan(0)
  })

  test('r3 P1-01: preview gửi expected_run_id = pointer snapshot ĐÃ dự toán (null có nghĩa, luôn có trường); impact tham chiếu cùng run; reply lệch ⇒ 500', async () => {
    const none = rdeps()
    expect((await mpPreview(none.d, PID.active, GOOD)).status).toBe(200)
    const p0 = none.log.preview[0] as { expected_run_id?: unknown; impact: { totals: { published_run_id: unknown } } }
    expect('expected_run_id' in p0 && p0.expected_run_id === null && p0.impact.totals.published_run_id === null).toBe(true)
    const echo = (p: Record<string, unknown>) => ({ ...REPLY, program_id: p.program_id, expected_run_id: p.expected_run_id })
    const withRun = rdeps({
      impact: async (pid, desired) => computeCmsRevisionImpact(impactDeps({ snap: snapshot({ program_id: pid, current_result_run_id: RUN }) }).d, pid, desired),
      preview: async (p) => echo(p),
    })
    const r = await mpPreview(withRun.d, PID.active, GOOD)
    expect(r.status).toBe(200)
    const p1 = withRun.log.preview[0] as { expected_run_id: unknown; impact: { totals: { published_run_id: unknown } } }
    expect([p1.expected_run_id, p1.impact.totals.published_run_id]).toEqual([RUN, RUN])
    // DB trả pointer / version khác cái đã gửi ⇒ không tin phản hồi.
    for (const bad of [{ expected_run_id: uid(91) }, { expected_run_id: null }, { from_config_version: 5 }]) {
      const x = rdeps({
        impact: async (pid, desired) => computeCmsRevisionImpact(impactDeps({ snap: snapshot({ program_id: pid, current_result_run_id: RUN }) }).d, pid, desired),
        preview: async (p) => ({ ...echo(p), ...bad }),
      })
      const res = await mpPreview(x.d, PID.active, GOOD)
      expect([res.status, (await json(res)).code], JSON.stringify(bad)).toEqual([500, 'PREVIEW_FAILED'])
    }
    // Phân loại lỗi RPC (dùng ở deps thật): 55P03 lock_timeout ⇒ BUSY (503, thử lại) — không 500; CMS_* + ProductID số; message lạ ⇒ ''.
    expect(cmsRevisionRpcErrorFrom({ code: '55P03', message: 'canceling statement due to lock timeout' })).toMatchObject({ code: 'CMS_SYNC_BUSY', detail: null })
    expect(cmsRevisionRpcErrorFrom({ code: 'P0001', message: 'CMS_REVISION_REMOVE_UNSUPPORTED', details: '948001' })).toMatchObject({ code: 'CMS_REVISION_REMOVE_UNSUPPORTED', detail: '948001' })
    expect(cmsRevisionRpcErrorFrom({ code: 'P0001', message: 'x', details: 'a@b.c' })).toMatchObject({ code: '', detail: null })
    const busy = rdeps({ preview: async () => { throw cmsRevisionRpcErrorFrom({ code: '55P03', message: 'lock timeout' }) } })
    const bz = await mpPreview(busy.d, PID.active, GOOD)
    expect([bz.status, (await json(bz)).code]).toEqual([503, 'BUSY'])
    // DB từ chối vì run đổi giữa dự toán và lưu preview ⇒ 409 PREVIEW_STALE (mã route, không message DB).
    const stale = rdeps({ preview: async () => { throw new CmsRevisionRpcError('CMS_REVISION_PREVIEW_STALE') } })
    const s = await mpPreview(stale.d, PID.active, GOOD)
    expect([s.status, (await json(s)).code]).toEqual([409, 'PREVIEW_STALE'])
  })

  test('preview: lỗi DB ⇒ mã route + ProductID (không message DB); snapshot lỗi / version lệch ⇒ không gọi RPC', async () => {
    for (const [code, status, route] of [
      ['CMS_REVISION_FIELD_LOCKED', 422, 'FIELD_LOCKED'], ['CMS_REVISION_PREVIEW_STALE', 409, 'PREVIEW_STALE'],
      ['CMS_REVISION_PAYOUT_EXISTS', 409, 'PAYOUT_EXISTS'], ['CMS_REVISION_FORBIDDEN', 403, 'FORBIDDEN'], ['', 500, 'PREVIEW_FAILED'],
    ] as const) {
      const x = rdeps({ preview: async () => { throw new CmsRevisionRpcError(code, '900001') } })
      const r = await mpPreview(x.d, PID.active, GOOD)
      const b = await json(r)
      expect([r.status, b.code]).toEqual([status, route])
      expect(JSON.stringify(b)).not.toContain('CMS_REVISION_')
    }
    const snapFail = rdeps({ impact: async () => ({ ok: false, code: 'SNAPSHOT_FAILED' }) })
    expect((await mpPreview(snapFail.d, PID.active, GOOD)).status).toBe(503)
    expect(snapFail.log.preview.length).toBe(0)
    const stale = rdeps({ impact: async (pid, desired) => computeCmsRevisionImpact(impactDeps({ snap: snapshot({ program_id: pid, config_version: 5 }) }).d, pid, desired) })
    const s = await mpPreview(stale.d, PID.active, GOOD)
    expect([s.status, (await json(s)).code]).toEqual([409, 'PREVIEW_STALE'])
    expect(stale.log.preview.length).toBe(0)
  })

  test('commit: same-origin + JSON + shape; lý do 10–1.000 (trim); tick tường minh; danh sách SP bỏ sắp xếp; map lỗi DB', async () => {
    const x = rdeps()
    expect((await commitReq(x.d, COMMIT, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await commitReq(x.d, '{nope')).status).toBe(400)
    expect((await commitReq(x.d, { ...COMMIT, idempotency_key: 'x' })).status).toBe(400)
    expect((await commitReq(x.d, { ...COMMIT, ack: { ...COMMIT.ack, removed: ['abc'] } })).status).toBe(400)
    const short = await commitReq(x.d, { ...COMMIT, reason: '  ngắn  ' })
    expect([short.status, (await json(short)).code]).toEqual([422, 'REASON_REQUIRED'])
    for (const ack of [{ ...COMMIT.ack, whole_period: false }, { ...COMMIT.ack, may_decrease: 'true' }]) {
      const r = await commitReq(x.d, { ...COMMIT, ack })
      expect([r.status, (await json(r)).code]).toEqual([422, 'ACK_REQUIRED'])
    }
    expect(x.log.commit.length).toBe(0)
    const ok = await commitReq(x.d)
    expect(ok.status).toBe(200)
    expect(x.log.commit[0]).toMatchObject({ revisionId: uid(500), expectedConfigVersion: 4, reason: 'Cập nhật K theo quy cách mới', ack: { whole_period: true, may_decrease: true, removed: ['900001', '900002'] } })
    expect(((await json(ok)).result as { toConfigVersion: number }).toConfigVersion).toBe(5)
    for (const [code, status, route] of [
      ['CMS_SYNC_BUSY', 503, 'BUSY'], ['CMS_REVISION_PREVIEW_EXPIRED', 409, 'EXPIRED'], ['CMS_REVISION_NOT_OWNER', 403, 'NOT_OWNER'],
      ['CMS_REVISION_IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT'], ['CMS_REVISION_ACK_REQUIRED', 422, 'ACK_REQUIRED'],
      ['CMS_REVISION_IMPACT_INVALID', 409, 'IMPACT_INVALID'], ['CMS_REVISION_ARCHIVE_MISMATCH', 500, 'ARCHIVE_FAILED'], ['', 500, 'COMMIT_FAILED'],
    ] as const) {
      const y = rdeps({ commit: async () => { throw new CmsRevisionRpcError(code) } })
      const r = await commitReq(y.d)
      expect([r.status, (await json(r)).code]).toEqual([status, route])
    }
  })
})

test.describe('F-A · cờ / năng lực / cổng nút ghi @desktop', () => {
  test('cờ CMS_PROGRAM_REVISION_ENABLED mặc định OFF, chỉ "true" + CMS_PROGRAM_ENABLED', () => {
    expect(cmsProgramRevisionFromEnv({})).toBe(false)
    expect(cmsProgramRevisionFromEnv({ CMS_PROGRAM_REVISION_ENABLED: 'true' })).toBe(false)
    expect(cmsProgramRevisionFromEnv({ CMS_PROGRAM_ENABLED: 'true', CMS_PROGRAM_REVISION_ENABLED: 'TRUE' })).toBe(false)
    expect(cmsProgramRevisionFromEnv({ CMS_PROGRAM_ENABLED: 'true', CMS_PROGRAM_REVISION_ENABLED: 'true' })).toBe(true)
  })

  test('r3 P1-02: cổng ĐỌC lịch sử không phụ thuộc cờ ghi; cổng GHI cần cờ; DB 130 / năng lực lệch ⇒ cả hai tắt; probe chỉ khi cần', async () => {
    const probe = (v: CmsRevisionCapState) => { const f = Object.assign(async () => { f.calls++; return v }, { calls: 0 }); return f }
    // Đã có revision, operator TẮT cờ ghi (runbook B5): đọc vẫn được, ghi tắt.
    const ok = probe('ok')
    expect(await cmsRevisionGate('read', { program: true, revision: false }, ok)).toBe(true)
    expect(await cmsRevisionGate('write', { program: true, revision: false }, ok)).toBe(false)
    // Bật lại cờ ghi: cả hai bật (lịch sử là dữ liệu DB, cờ app không xoá / reset gì).
    expect(await cmsRevisionGate('read', { program: true, revision: true }, ok)).toBe(true)
    expect(await cmsRevisionGate('write', { program: true, revision: true }, ok)).toBe(true)
    // DB 130 ('absent') / lệch / lỗi mạng ⇒ tắt cả hai (trang 404, không gọi RPC 131).
    for (const s of ['absent', 'mismatch', 'unavailable'] as const) {
      for (const revision of [false, true]) {
        expect(await cmsRevisionGate('read', { program: true, revision }, probe(s)), s).toBe(false)
        expect(await cmsRevisionGate('write', { program: true, revision }, probe(s)), s).toBe(false)
      }
    }
    // Module CMS tắt ⇒ không probe; ghi với cờ ghi tắt ⇒ không probe.
    const p1 = probe('ok'), p2 = probe('ok')
    expect(await cmsRevisionGate('read', { program: false, revision: true }, p1)).toBe(false)
    expect(await cmsRevisionGate('write', { program: true, revision: false }, p2)).toBe(false)
    expect([p1.calls, p2.calls]).toEqual([0, 0])
    // Link trang chi tiết (dùng chung route thật + fixture): Sửa chỉ khi ghi mở + nháp / đang chạy; Lịch sử khi đã sửa hoặc lỗi trạng thái.
    const st = (revised: boolean) => ({ ok: true as const, data: { revised, masked: revised, lastRevisedAt: revised ? '2026-11-17T08:05:00.000Z' : null } })
    expect(cmsRevisionDetailLinks({ programId: PROG, status: 'active', writable: false, state: st(true) })).toMatchObject({ editHref: null, state: { revised: true }, stateError: false })
    expect(cmsRevisionDetailLinks({ programId: PROG, status: 'active', writable: true, state: st(false) }).editHref).toBe(`/targets/campaigns/cms/${PROG}/revision`)
    expect(cmsRevisionDetailLinks({ programId: PROG, status: 'locked', writable: true, state: st(true) }).editHref).toBeNull()
    expect(cmsRevisionDetailLinks({ programId: PROG, status: 'active', writable: false, state: { ok: false } })).toMatchObject({ state: null, stateError: true,
      historyHref: `/targets/campaigns/cms/${PROG}/revisions` })
  })

  test('năng lực DB: đúng version + đủ 6 RPC + ok; lệch ⇒ tắt', () => {
    const rpcs = ['rpc_cms_program_revision', 'rpc_cms_program_revision_archive', 'rpc_cms_program_revision_commit', 'rpc_cms_program_revision_preview', 'rpc_cms_program_revision_state', 'rpc_cms_program_revisions']
    expect(parseCmsRevisionCapabilities({ version: 'cms-revision-v1', rpcs, ok: true })).toBe(true)
    expect(parseCmsRevisionCapabilities({ version: 'cms-revision-v1', rpcs, ok: false })).toBe(false)
    expect(parseCmsRevisionCapabilities({ version: 'cms-revision-v2', rpcs, ok: true })).toBe(false)
    expect(parseCmsRevisionCapabilities({ version: 'cms-revision-v1', rpcs: rpcs.slice(1), ok: true })).toBe(false)
    expect(parseCmsRevisionCapabilities(null)).toBe(false)
  })

  test('phản hồi preview lạ ⇒ null; lý do; cổng nút ghi theo thứ tự (không tick sẵn); chuỗi bậc / chênh lệch', () => {
    expect(parseCmsRevisionPreviewReply(REPLY)?.diff.items[0]).toMatchObject({ productId: '900001', action: 'change', kBefore: '10', kAfter: '5' })
    expect(parseCmsRevisionPreviewReply({ ...REPLY, payload_digest: 'x' })).toBeNull()
    expect(parseCmsRevisionPreviewReply({ ...REPLY, diff: { ...REPLY.diff, items: [{ product_id: '1', action: 'nuke' }] } })).toBeNull()
    expect(cmsRevisionReasonOk('  123456789 ')).toBe(false)
    expect(cmsRevisionReasonOk('1234567890')).toBe(true)
    expect(cmsRevisionReasonOk(`abcdefghij${String.fromCharCode(7)}`)).toBe(false)
    const base = { done: false, busy: false, impactOk: true, dirty: false, reasonOk: true, wholePeriod: true, mayDecrease: true, removedCount: 0, removedAck: false }
    expect(cmsRevisionCommitGate(base)).toBe('NONE')
    expect(cmsRevisionCommitGate({ ...base, impactOk: false })).toBe('IMPACT')
    expect(cmsRevisionCommitGate({ ...base, dirty: true })).toBe('DIRTY')
    expect(cmsRevisionCommitGate({ ...base, reasonOk: false })).toBe('REASON')
    expect(cmsRevisionCommitGate({ ...base, mayDecrease: false })).toBe('ACK')
    expect(cmsRevisionCommitGate({ ...base, removedCount: 2 })).toBe('REMOVED')
    expect(cmsRevisionCommitGate({ ...base, removedCount: 2, removedAck: true })).toBe('NONE')
    expect(cmsRevisionCommitGate({ ...base, done: true })).toBe('DONE')
    expect(cmsRevisionTiersText(T('15000'), 'hộp')).toBe('15.000₫/hộp')
    expect(cmsRevisionTiersText([{ order: 1, from: 1, to: 9, amount: '1000' }, { order: 2, from: 10, to: null, amount: '2000' }], 'hộp')).toBe('1–9 hộp: 1.000₫ · Từ 10 hộp trở lên: 2.000₫')
    expect([cmsDeltaVnd('300'), cmsDeltaVnd('-100'), cmsDeltaVnd('0')]).toEqual(['+300₫', '−100₫', '0₫'])
  })
})
