import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import {
  CMS_I4_CASES, cmsI4CheckProducts, cmsI4CheckSales, cmsI4ExportSql, cmsI4N4a, cmsI4N4aMarkdown, cmsI4N4bMarkdown, cmsI4Oracle,
  cmsI4ParseContext, cmsI4ParseExpected, cmsI4ReadCsv, cmsI4Reconcile,
} from './cmsI4Offline'
import { CMS_PRODUCT_COLUMNS, CMS_SALES_COLUMNS, normalizeProductRow, normalizeSalesRow, type CmsRawRow } from '../lib/cms/source/contract'
import { buildCmsProductsQuery, buildCmsSalesQuery } from '../lib/cms/source/bigquery'
import { buildSellerIndex, type CmsStoreRef, type CmsUserRef } from '../lib/cms/mapping'
import { parseCmsEngineProgram, type CmsEngineProductInput, type CmsEngineProgramInput } from '../lib/cms/engine/config'
import { formatUtcMicros, vnProgramWindowMicros } from '../lib/cms/time'

// CMS I4 offline (PM 04/11 §I4; checklist planning/research/cms-i4-bi-checklist.md r1.1 §1–§2, §4 N4a / N4b). Spec THUẦN + CLI
// (không mạng, không DB, không BigQuery). Mọi số đi qua CHÍNH normalize / quality / mapping / engine của app; oracle N4b độc lập.

const WEBAPP = path.resolve(__dirname, '..')
const FX = path.join(__dirname, 'fixtures', 'cms-i4')
const CLI = path.join(WEBAPP, 'scripts', 'cms-i4-offline.mjs')
const B = (n: number | string | bigint) => BigInt(n)

const STORE = '00000000-0000-4000-8000-0000000000a1'
const STORE_FS = '00000000-0000-4000-8000-0000000000a2'
const STORE_OFF = '00000000-0000-4000-8000-0000000000a3'
const STORE_OUT = '00000000-0000-4000-8000-0000000000a4'
const U = {
  A: '00000000-0000-4000-8000-00000000000a', B: '00000000-0000-4000-8000-00000000000b', Q: '00000000-0000-4000-8000-00000000000c',
  ADM: '00000000-0000-4000-8000-00000000000d', FS: '00000000-0000-4000-8000-00000000000e', OFF: '00000000-0000-4000-8000-00000000000f',
  D1: '00000000-0000-4000-8000-000000000010', D2: '00000000-0000-4000-8000-000000000011', OUT: '00000000-0000-4000-8000-000000000012',
  C: '00000000-0000-4000-8000-000000000013',
}
const users: CmsUserRef[] = [
  { id: U.A, email: 'ds.a@example.test', role: 'staff', storeId: STORE },
  { id: U.B, email: 'ds.b@example.test', role: 'staff', storeId: STORE },
  { id: U.Q, email: 'qlch.x@example.test', role: 'store_manager', storeId: STORE },
  { id: U.ADM, email: 'pic@example.test', role: 'admin', storeId: null },
  { id: U.FS, email: 'ds.fs@example.test', role: 'staff', storeId: STORE_FS },
  { id: U.OFF, email: 'ds.off@example.test', role: 'staff', storeId: STORE_OFF },
  { id: U.D1, email: 'dup@example.test', role: 'staff', storeId: STORE },
  { id: U.D2, email: 'DUP@example.test ', role: 'staff', storeId: STORE },
  { id: U.OUT, email: 'ds.out@example.test', role: 'staff', storeId: STORE_OUT },
  { id: U.C, email: 'ds.c@example.test', role: 'staff', storeId: STORE },
]
const stores: CmsStoreRef[] = [
  { id: STORE, storeType: 'os', isActive: true }, { id: STORE_FS, storeType: 'fs', isActive: true },
  { id: STORE_OFF, storeType: 'os', isActive: false }, { id: STORE_OUT, storeType: 'os', isActive: true },
]
const P1: CmsEngineProductInput = { productId: '900001', gmvBasis: 'none', targetGmv: null, baseQuantityCms: '30', tiers: [{ from: 1, to: 9, amount: 10000 }, { from: 10, to: null, amount: 12000 }] }
const P2: CmsEngineProductInput = { productId: '900002', gmvBasis: 'product', targetGmv: 1000000, baseQuantityCms: '1', tiers: [{ from: 1, to: null, amount: 5000 }] }
const prog = (products: CmsEngineProductInput[], o: Partial<CmsEngineProgramInput> = {}): CmsEngineProgramInput =>
  ({ startDate: '2026-11-01', endDate: '2026-11-30', catalogTargetGmv: null, storeIds: [STORE], products, ...o })

let seq = 0
const row = (o: Partial<Record<string, string | null>> = {}): CmsRawRow => {
  seq++
  return {
    order_line_id: String(8_000_000 + seq), order_id: `O${seq}`, order_code: `SO${seq}`, product_id: '900001', seller_email: 'ds.a@example.test',
    pos_code: 'POS-T1', order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: '2026-11-05T03:00:00.000000Z', quantity_raw: '1', uom_raw: 'Hộp',
    base_quantity: '30', gmv_amount: '120000', source_updated_at: '2026-11-05T03:00:00.000000Z', ...o,
  }
}
const prow = (o: Partial<Record<string, string | null>> = {}): CmsRawRow => ({
  product_id: '900001', product_name: 'SP', image_url: null, is_active: 'true', source_updated_at: '2026-11-01T00:00:00.000000Z', reference_price: null, price_unit: null, ...o,
})
const rec = (rows: CmsRawRow[], program = prog([P1, P2]), expected?: Parameters<typeof cmsI4Reconcile>[0]['expected']) =>
  cmsI4Reconcile({ program, users, stores, rows, expected })
const pair = (r: ReturnType<typeof rec>, user: string, pid: string) => r.pairs.find((p) => p.userId === user && p.productId === pid)
const fxCsv = (name: string, cols: readonly string[], opt: readonly string[] = []) => {
  const r = cmsI4ReadCsv(new Uint8Array(fs.readFileSync(path.join(FX, name))), cols, opt)
  if (!r.ok) throw new Error(r.reason)
  return r
}
const fxCtx = () => {
  const c = cmsI4ParseContext(JSON.parse(fs.readFileSync(path.join(FX, 'context.json'), 'utf8')))
  if (!c.ok) throw new Error(c.reason)
  return c.value
}
const csvBuf = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'))
const SALES_HEADER = CMS_SALES_COLUMNS.join(',')

// Oracle từng đơn vị (ngây thơ nhất) — kiểm chéo cách cộng theo đoạn của cmsI4Oracle.
function naiveF(tiers: CmsEngineProductInput['tiers'], q: bigint): bigint {
  let s = B(0)
  for (let u = B(1); u <= q; u++) {
    const t = tiers.find((x) => u >= B(x.from) && (x.to === null || u <= B(x.to)))
    if (!t) break
    s += B(t.amount)
  }
  return s
}

test.describe('CMS I4 · hợp đồng nguồn theo adapter thực tế @desktop', () => {
  test('7 cột Product Master / 14 cột dòng bán — đúng tên, đúng thứ tự adapter SELECT', () => {
    expect([...CMS_PRODUCT_COLUMNS]).toEqual(['product_id', 'product_name', 'image_url', 'is_active', 'source_updated_at', 'reference_price', 'price_unit'])
    expect([...CMS_SALES_COLUMNS]).toEqual(['order_line_id', 'order_id', 'order_code', 'product_id', 'seller_email', 'pos_code', 'order_type',
      'order_status', 'completed_at', 'quantity_raw', 'uom_raw', 'base_quantity', 'gmv_amount', 'source_updated_at'])
  })

  test('NULL: dòng bán 10 cột bắt buộc / 4 cột được NULL; Product Master 4 / 3 — cột NULL được vẫn phải TỒN TẠI', () => {
    const nullableSales = ['seller_email', 'pos_code', 'quantity_raw', 'uom_raw']
    for (const c of CMS_SALES_COLUMNS) {
      const n = normalizeSalesRow({ ...row(), [c]: null })
      if (nullableSales.includes(c)) expect(n.ok, c).toBe(true)
      else expect(n.ok ? [] : n.issues, c).toEqual([{ kind: 'MISSING_FIELD', field: c }])
    }
    const nullableProducts = ['image_url', 'reference_price', 'price_unit']
    for (const c of CMS_PRODUCT_COLUMNS) {
      const n = normalizeProductRow({ ...prow(), [c]: null })
      if (nullableProducts.includes(c)) expect(n.ok, c).toBe(true)
      else expect(n.ok ? [] : n.issues, c).toEqual([{ kind: 'MISSING_FIELD', field: c }])
    }
    // Thiếu CỘT (không phải NULL) ⇒ cả file dừng như SCHEMA_MISMATCH của adapter.
    const noPos = CMS_SALES_COLUMNS.filter((c) => c !== 'pos_code').join(',')
    const r = cmsI4ReadCsv(csvBuf(`${noPos}\n`), CMS_SALES_COLUMNS)
    expect(r.ok ? '' : r.reason).toBe('SCHEMA_MISMATCH: thiếu cột pos_code')
  })

  test('trần độ dài text đúng code — gồm quantity_raw / uom_raw ≤ 50 (finding I4-F1: checklist r1.1 chưa ghi; quá trần ⇒ lỗi dòng ⇒ giữ cả lượt)', () => {
    const MAX: Record<string, number> = { order_line_id: 100, order_id: 100, order_code: 100, seller_email: 320, pos_code: 50, order_type: 30, order_status: 30, quantity_raw: 50, uom_raw: 50 }
    for (const [f, max] of Object.entries(MAX)) {
      const at = f === 'seller_email' ? `${'a'.repeat(max - 5)}@x.vn` : 'X'.repeat(max)
      expect(normalizeSalesRow({ ...row(), [f]: at }).ok, `${f} = ${max}`).toBe(true)
      const over = normalizeSalesRow({ ...row(), [f]: `a${at}` })
      expect(over.ok ? [] : over.issues, `${f} = ${max + 1}`).toContainEqual({ kind: 'BAD_TEXT', field: f })
    }
    expect(normalizeProductRow(prow({ product_name: 'N'.repeat(500), price_unit: 'U'.repeat(50) })).ok).toBe(true)
    const p = normalizeProductRow(prow({ product_name: 'N'.repeat(501), price_unit: 'U'.repeat(51) }))
    expect(p.ok ? [] : p.issues).toEqual([{ kind: 'BAD_TEXT', field: 'product_name' }, { kind: 'BAD_TEXT', field: 'price_unit' }])
    // Một dòng quantity_raw 51 ký tự ⇒ snapshot held ROW_ISSUES dù cột "chỉ để hiển thị".
    expect(cmsI4CheckSales([row(), row({ quantity_raw: '1'.repeat(51) })]).readiness).toMatchObject({ status: 'not_ready', held: ['ROW_ISSUES'], contract: [] })
  })

  test('SQL production: SELECT đủ cột + ép kiểu, cap + 1, kỳ theo UTC của ngày VN, lọc ProductID canonical THEO CHUỖI (finding I4-F2)', () => {
    const w = vnProgramWindowMicros('2026-11-01', '2026-11-30')
    const s = buildCmsSalesQuery({ table: 'bi-project.buymed_tech.cms_sales_v', fromMicros: w.fromMicros, toMicrosExclusive: w.toMicrosExclusive, productIds: ['900002', '900001', '900001'] })
    const [select, from, ...rest] = s.sql.split('\n')
    for (const c of CMS_SALES_COLUMNS) {
      expect(select).toContain(c === 'completed_at' || c === 'source_updated_at' ? `FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', ${c}, 'UTC') AS ${c}`
        : c === 'seller_email' ? 'CAST(employee_email AS STRING) AS seller_email' : `CAST(${c} AS STRING) AS ${c}`) // PM 04/11: cột vật lý employee_email
    }
    expect(from).toBe('FROM `bi-project.buymed_tech.cms_sales_v`')
    expect(rest).toEqual(['WHERE completed_at >= @from_ts AND completed_at < @to_ts', '  AND CAST(product_id AS STRING) IN UNNEST(@product_ids)', 'LIMIT @row_limit'])
    expect(s.params).toEqual([
      { name: 'from_ts', type: 'TIMESTAMP', value: '2026-10-31T17:00:00.000000Z' },
      { name: 'to_ts', type: 'TIMESTAMP', value: '2026-11-30T17:00:00.000000Z' },
      { name: 'product_ids', type: 'ARRAY', arrayType: 'STRING', values: ['900001', '900002'] },
      { name: 'row_limit', type: 'INT64', value: 200_001 },
    ])
    // Không lọc order_type / status ở SQL (app phải thấy để phát hiện thiếu trường).
    expect(rest.join(' ')).not.toMatch(/order_type|order_status/)
    const p = buildCmsProductsQuery('bi-project.buymed_tech.cms_products_v')
    // is_active là hằng tương thích (PM 04/11 `2026-11-04-cms-bi-product-master-pm.md` §2) — view vật lý 6 cột, file chuẩn 7 cột.
    expect(p.sql.split('\n')[0]).toBe(`SELECT ${CMS_PRODUCT_COLUMNS.map((c) => (c === 'is_active' ? 'CAST(TRUE AS STRING) AS is_active'
      : c === 'source_updated_at' ? `FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', ${c}, 'UTC') AS ${c}` : `CAST(${c} AS STRING) AS ${c}`)).join(', ')}`)
    expect(p.params).toEqual([{ name: 'row_limit', type: 'INT64', value: 200_001 }])
    // I4-F2: view trả product_id dạng chuỗi có số 0 đầu ⇒ SQL so CHUỖI với ID canonical ⇒ dòng bị loại Ở SQL, không lỗi.
    // Công cụ offline đếm để BI sửa view (normalize app thì vẫn nhận '000900001' = 900001 — chỉ thấy khi đọc file xuất).
    // r2 (PM 04/11 (a) — giữ contract canonical tại view): app KHÔNG held, nhưng readiness offline đỏ ở phần hợp đồng.
    const c = cmsI4CheckSales([row({ product_id: '000900001' }), row({ product_id: ' 900001' }), row()])
    expect(c.nonCanonicalProductId).toBe(2)
    expect(c.readiness).toMatchObject({ status: 'not_ready', held: [], contract: ['NON_CANONICAL_PRODUCT_ID'], noEvidence: [] })
  })

  test('SQL xuất N4a / N4b cho BI dùng NGUYÊN dòng SELECT của app, chỉ đổi điều kiện lọc', () => {
    const appSelect = buildCmsSalesQuery({ table: 'bi-project.buymed_tech.CMS_SALES_VIEW', fromMicros: B(1), toMicrosExclusive: B(2), productIds: ['1'] }).sql.split('\n')[0]
    const a = cmsI4ExportSql('n4a').split('\n')
    const b = cmsI4ExportSql('n4b').split('\n')
    expect(a[0]).toBe(appSelect)
    expect(b[0]).toBe(appSelect)
    expect(a.slice(2)).toEqual(['WHERE CAST(order_code AS STRING) IN UNNEST(@order_codes)', 'ORDER BY completed_at, order_line_id'])
    expect(b.slice(2)).toEqual(['WHERE completed_at >= @from_ts AND completed_at < @to_ts', '  AND CAST(product_id AS STRING) IN UNNEST(@product_ids)',
      '  AND LOWER(TRIM(employee_email)) IN UNNEST(@seller_emails)', 'ORDER BY completed_at, order_line_id'])
    // WHERE lọc trên view ⇒ cột vật lý; SELECT giữ alias chuẩn ⇒ header file xuất vẫn seller_email.
    expect(b[0]).toContain('CAST(employee_email AS STRING) AS seller_email')
    expect(b.join('\n')).not.toMatch(/(?<!AS )\bseller_email\b(?! IN UNNEST)/)
  })
})

test.describe('CMS I4 · đọc file BI xuất (CSV) @desktop', () => {
  test('fixture giả đọc đủ 11 dòng; email giữ nguyên dạng thô (trim / chữ thường là việc của normalize)', () => {
    const r = fxCsv('sales.csv', CMS_SALES_COLUMNS)
    expect(r.rows).toHaveLength(11)
    expect(r.rows[0].seller_email).toBe('DS.A@example.test ')
    expect(r.extraColumns).toEqual([])
  })

  test('BOM / cột thừa / ô rỗng = NULL / dòng trống cuối được nhận; lỗi cấu trúc dừng cả file', () => {
    const line = '1,O1,SO1,900001,,POS,OFFLINE,COMPLETED,2026-11-05T03:00:00.000000Z,,,30,120000,2026-11-05T03:00:00.000000Z'
    const ok = cmsI4ReadCsv(csvBuf(`﻿${SALES_HEADER},ghi_chu\n${line},x\n\n`), CMS_SALES_COLUMNS)
    expect(ok.ok && ok.rows.length).toBe(1)
    expect(ok.ok && ok.extraColumns).toEqual(['ghi_chu'])
    expect(ok.ok && ok.rows[0].seller_email).toBeNull()
    expect(ok.ok && 'ghi_chu' in ok.rows[0]).toBe(false)
    const reason = (s: string | Uint8Array) => { const r = cmsI4ReadCsv(typeof s === 'string' ? csvBuf(s) : s, CMS_SALES_COLUMNS); return r.ok ? 'ok' : r.reason }
    expect(reason('')).toBe('EMPTY_FILE')
    expect(reason(`${SALES_HEADER},order_id\n`)).toBe('DUPLICATE_HEADER')
    expect(reason(`${SALES_HEADER}\n${line},thua\n`)).toMatch(/^ROW_FIELD_COUNT: bản ghi 2 có 15 trường, header 14$/)
    expect(reason(`${SALES_HEADER}\n"${line}\n`)).toBe('CSV_MALFORMED')
    expect(reason(new Uint8Array([...Buffer.from(`${SALES_HEADER}\n`), 0xe1, 0x0a]))).toBe('ENCODING_INVALID')
  })
})

test.describe('CMS I4 · mẫu §2 qua CSV → kiểm chất lượng → đối soát @desktop', () => {
  test('Product Master §2.1: 3 dòng hợp lệ, ảnh ngoài allow-list bị bỏ (không loại dòng); is_active "1" ⇒ lỗi dòng; trùng ID ⇒ held', () => {
    const r = cmsI4CheckProducts(fxCsv('products.csv', CMS_PRODUCT_COLUMNS).rows)
    expect(r).toMatchObject({ rowsRead: 3, valid: 3, invalid: 0, active: 2, inactive: 1, imageRejected: 1, duplicateProductIds: 0, readiness: { status: 'ready', held: [], notProven: ['INCOMPLETE_PAGES'] } })
    const bad = cmsI4CheckProducts([prow({ is_active: '1' }), prow({ product_id: '900002', is_active: 'Y' }), prow({ product_id: '900003', is_active: 'TRUE' })])
    expect(bad).toMatchObject({ valid: 1, invalid: 2, issues: { 'BAD_BOOLEAN:is_active': 2 }, readiness: { status: 'not_ready', held: ['ROW_ISSUES'] } })
    expect(cmsI4CheckProducts([prow(), prow({ product_id: '0900001' })])).toMatchObject({ valid: 2, duplicateProductIds: 1, readiness: { status: 'not_ready', held: ['DUPLICATE_PRODUCT'] } })
    // I4-P1-2 (3): Product Master rỗng ⇒ held EMPTY_SOURCE ngay lần đầu (productSync), không "ok".
    expect(cmsI4CheckProducts([]).readiness).toMatchObject({ status: 'not_ready', held: ['EMPTY_SOURCE'] })
  })

  test('dòng bán §2.3: phân bố type / status, ngoài kỳ, chưa gán (engine), readiness như app; hash không phụ thuộc thứ tự dòng', () => {
    const ctx = fxCtx()
    const rows = fxCsv('sales.csv', CMS_SALES_COLUMNS).rows
    const r = cmsI4CheckSales(rows, ctx)
    expect(r).toMatchObject({
      scope: 'program', rowsRead: 11, valid: 11, invalid: 0, duplicateLineIds: 0, exponentLike: 0, nonCanonicalProductId: 0, sqlDroppedNonCanonical: 0,
      negative: 0, zeroBase: 0, noEmail: 0,
      typeStatus: { 'OFFLINE/COMPLETED': 9, 'ONLINE/COMPLETED': 1, 'OFFLINE/CANCELLED': 1 }, eligible: 9,
      window: { from: '2026-11-01', to: '2026-11-30', inWindow: 10, outOfWindow: 1 }, vnDateRange: { min: '2026-11-01', max: '2026-12-01' },
      candidates: 8, unassigned: { SHARED_ACCOUNT: 1 },
    })
    expect(r.readiness).toEqual({ status: 'ready', held: [], contract: [], noEvidence: [], notProven: ['INCOMPLETE_PAGES', 'EMPTY_AFTER_DATA', 'PERIOD_COMPLETENESS'] })
    // Không bối cảnh ⇒ chỉ hợp đồng file; ngưỡng chưa gán / OVERFLOW ghi "chưa đánh giá", không ghi là đạt.
    expect(cmsI4CheckSales(rows)).toMatchObject({ scope: 'contract', candidates: null, unassigned: null, sqlDroppedNonCanonical: null,
      readiness: { status: 'ready', notProven: ['INCOMPLETE_PAGES', 'EMPTY_AFTER_DATA', 'PERIOD_COMPLETENESS', 'UNASSIGNED_OVER_THRESHOLD', 'OVERFLOW'] } })
    expect(cmsI4CheckSales([...rows].reverse(), ctx).hash).toBe(r.hash)
    expect(cmsI4CheckSales(rows.map((x, i) => (i === 3 ? { ...x, gmv_amount: '63001' } : x)), ctx).hash).not.toBe(r.hash)
  })

  test('đối soát §2.4: tổng 60.000; từng cặp khớp bảng; engine = oracle độc lập; 4 / 4 khớp số tính tay', () => {
    const ctx = fxCtx()
    const e = cmsI4ParseExpected(fxCsv('expected.csv', ['seller_email', 'product_id', 'expected_cms_vnd'], ['expected_q', 'expected_gmv']).rows)
    if (!e.ok) throw new Error(e.reason)
    const r = cmsI4Reconcile({ ...ctx, rows: fxCsv('sales.csv', CMS_SALES_COLUMNS).rows, expected: e.value })
    expect(r.totals).toEqual({ amountVnd: B(60000), included: 7, excluded: { ORDER_NOT_ELIGIBLE: 2, 'UNASSIGNED:SHARED_ACCOUNT': 1, OUT_OF_WINDOW: 1 } })
    const pick = (u: string, p: string) => { const x = pair(r, u, p)!; return [x.lines, x.baseQuantity, x.q, x.gmv, x.met, x.potential, x.amount, x.metAtUtc] }
    expect(pick(U.A, '900001')).toEqual([3, '60', B(2), '242000', true, B(20000), B(20000), null])
    expect(pick(U.A, '900002')).toEqual([1, '3', B(3), '450000', false, B(15000), B(0), null])
    expect(pick(U.B, '900001')).toEqual([1, '15', B(0), '63000', true, B(0), B(0), null])
    expect(pick(U.B, '900002')).toEqual([2, '8', B(8), '1200000', true, B(40000), B(40000), '2026-11-12T03:00:00.000000Z'])
    expect(r.oracleMismatches).toEqual([])
    expect(r.readiness).toEqual({ status: 'ready', held: [], contract: [], noEvidence: [], notProven: ['INCOMPLETE_PAGES', 'EMPTY_AFTER_DATA', 'PERIOD_COMPLETENESS'] })
    expect(r.expected).toEqual({ compared: 4, matched: 4, matchedWithoutPair: 0, mismatches: [], missingInEngine: [], notInExpected: [] })
    expect(r.warnings).toEqual([
      '1 dòng ngoài kỳ (theo ngày VN của completed_at) — không tính',
      'export chứa dữ liệu từ 2026-11-01 tới 2026-12-01 (ngày VN); kỳ 2026-11-01 → 2026-11-30 — đối soát chỉ đúng khi export là TOÀN KỲ của các cặp đã chọn',
    ])
    // Oracle độc lập tự nó cũng ra đúng bảng (không chỉ "bằng engine").
    const lines = fxCsv('sales.csv', CMS_SALES_COLUMNS).rows.map((x) => { const n = normalizeSalesRow(x); if (!n.ok) throw new Error('fx'); return n.value })
    const o = cmsI4Oracle(parseCmsEngineProgram(ctx.program), lines, ctx.users, ctx.stores, '2026-11-01', '2026-11-30')
    expect([...o.entries()].map(([k, v]) => [k.split('|')[1], v.q, v.met, v.amount]).sort()).toEqual([
      ['900001', B(0), true, B(0)], ['900001', B(2), true, B(20000)], ['900002', B(3), false, B(0)], ['900002', B(8), true, B(40000)],
    ].sort())
    // Bảng N4b chỉ có email che + bí danh tài khoản.
    const md = cmsI4N4bMarkdown(r)
    expect(md).not.toMatch(/ds\.a@|ds\.b@|00000000-0000/)
    expect(md).toContain('| 900002 | 2 | 8 | 1 | 8 | 8 | 1200000 | 1200000 / 1000000 đạt | 2026-11-12T03:00:00.000000Z | 40000 |')
  })
})

test.describe('CMS I4 · ca biên tại ranh adapter (engine + oracle) @desktop', () => {
  test('kỳ theo ngày VN: 16:59:59.999999Z / 17:00:00Z hai đầu kỳ; định dạng timestamp xuất BigQuery', () => {
    const at = (t: string) => row({ product_id: '900002', base_quantity: '1', gmv_amount: '1', completed_at: t })
    const r = rec([at('2026-10-31T16:59:59.999999Z'), at('2026-10-31T17:00:00.000000Z'), at('2026-11-30T16:59:59.999999Z'), at('2026-11-30T17:00:00.000000Z'), at('2026-11-15 03:00:00.123456 UTC')])
    expect(pair(r, U.A, '900002')!.lines).toBe(3)
    expect(r.totals.excluded).toEqual({ OUT_OF_WINDOW: 2 })
    expect(r.oracleMismatches).toEqual([])
    for (const bad of ['2026-11-05T03:00:00+00:00', '2026-11-05 03:00:00', '2026-11-05T03:00:00.1234567Z', '2026-02-30T03:00:00Z']) {
      const n = normalizeSalesRow(row({ completed_at: bad }))
      expect(n.ok ? [] : n.issues, bad).toEqual([{ kind: 'BAD_TIMESTAMP', field: 'completed_at' }])
    }
  })

  test('số: dạng mũ / > 9 chữ số thập phân / dấu phẩy nghìn ⇒ lỗi dòng giữ cả lượt; số lẻ hợp lệ được nhận', () => {
    const c = cmsI4CheckSales([row({ base_quantity: '1e+06' }), row({ gmv_amount: '120000.0000000001' }), row({ gmv_amount: '1,000' }), row({ base_quantity: '0.5', gmv_amount: '120000.123456789' })])
    expect(c).toMatchObject({ valid: 1, invalid: 3, exponentLike: 1, issues: { 'BAD_NUMBER:base_quantity': 1, 'BAD_NUMBER:gmv_amount': 2 } })
    expect(c.readiness).toMatchObject({ status: 'not_ready', held: ['UNCONVERTED_UNITS', 'ROW_ISSUES'] })
    for (const pid of ['900001.0', '9.00001E+05', '-900001', '0']) {
      const n = normalizeSalesRow(row({ product_id: pid }))
      expect(n.ok ? [] : n.issues, pid).toEqual([{ kind: 'BAD_PRODUCT_ID', field: 'product_id' }])
    }
  })

  test('mapping người bán: trim + chữ thường; NO_EMAIL / NOT_FOUND / MULTIPLE / SHARED / NOT_STAFF / STORE_NOT_ELIGIBLE / OUT_OF_SCOPE — oracle độc lập đồng ý', () => {
    const r = rec([
      row({ seller_email: '  DS.A@Example.TEST ' }), row({ seller_email: null }), row({ seller_email: 'ai@example.test' }), row({ seller_email: 'dup@example.test' }),
      row({ seller_email: 'qlch.x@example.test' }), row({ seller_email: 'pic@example.test' }), row({ seller_email: 'ds.fs@example.test' }),
      row({ seller_email: 'ds.off@example.test' }), row({ seller_email: 'ds.out@example.test' }),
    ])
    expect(pair(r, U.A, '900001')!.lines).toBe(1)
    expect(r.totals.excluded).toEqual({
      'UNASSIGNED:NO_EMAIL': 1, 'UNASSIGNED:NOT_FOUND': 1, 'UNASSIGNED:MULTIPLE': 1, 'UNASSIGNED:SHARED_ACCOUNT': 1, 'UNASSIGNED:NOT_STAFF': 1,
      'UNASSIGNED:STORE_NOT_ELIGIBLE': 2, OUT_OF_SCOPE: 1,
    })
    expect(r.oracleMismatches).toEqual([])
  })

  test('ngưỡng chưa gán > 20 % ứng viên ⇒ held; đúng 20 % ⇒ đạt (ứng viên / chưa gán lấy từ engine như salesSync)', () => {
    const ctx = { program: prog([P1]), users, stores }
    const n = (total: number, bad: number) => [...Array(total)].map((_, i) => row({ seller_email: i < bad ? 'ai@example.test' : 'ds.a@example.test' }))
    expect(cmsI4CheckSales(n(5, 1), ctx).readiness).toMatchObject({ status: 'ready', held: [] })
    expect(cmsI4CheckSales(n(10, 2), ctx).readiness).toMatchObject({ status: 'ready', held: [] })
    expect(cmsI4CheckSales(n(9, 2), ctx).readiness).toMatchObject({ status: 'not_ready', held: ['UNASSIGNED_OVER_THRESHOLD'] })
    expect(cmsI4CheckSales(n(5, 2), ctx)).toMatchObject({ candidates: 5, unassigned: { NOT_FOUND: 2 }, readiness: { held: ['UNASSIGNED_OVER_THRESHOLD'] } })
  })

  test('bậc lũy tiến: một dòng đi qua 9 → 10; hai dòng 9 rồi 1; trần ở bậc cuối hữu hạn', () => {
    const T: CmsEngineProductInput = { productId: '900005', gmvBasis: 'none', targetGmv: null, baseQuantityCms: '1', tiers: [{ from: 1, to: 9, amount: 10000 }, { from: 10, to: null, amount: 12000 }] }
    const CAP: CmsEngineProductInput = { productId: '900006', gmvBasis: 'none', targetGmv: null, baseQuantityCms: '1', tiers: [{ from: 1, to: 5, amount: 1000 }, { from: 6, to: 10, amount: 2000 }] }
    const r1 = rec([row({ product_id: '900005', base_quantity: '12' })], prog([T]))
    expect(pair(r1, U.A, '900005')!.amount).toBe(B(9 * 10000 + 3 * 12000))
    const r2 = rec([row({ product_id: '900005', base_quantity: '9' }), row({ product_id: '900005', base_quantity: '1', completed_at: '2026-11-06T03:00:00.000000Z' })], prog([T]))
    expect(pair(r2, U.A, '900005')!.amount).toBe(B(102000))
    const r3 = rec([row({ product_id: '900006', base_quantity: '15' })], prog([CAP]))
    expect(pair(r3, U.A, '900006')).toMatchObject({ q: B(15), rewarded: B(10), cap: B(10), amount: B(15000) })
    for (const r of [r1, r2, r3]) expect(r.oracleMismatches).toEqual([])
  })

  test('gate theo SP: bằng target đạt, thiếu 0,000000001 không đạt (tiềm năng vẫn hiện)', () => {
    const at = rec([row({ product_id: '900002', base_quantity: '2', gmv_amount: '1000000' })])
    expect(pair(at, U.A, '900002')).toMatchObject({ met: true, amount: B(10000) })
    const under = rec([row({ product_id: '900002', base_quantity: '2', gmv_amount: '999999.999999999' })])
    expect(pair(under, U.A, '900002')).toMatchObject({ met: false, potential: B(10000), amount: B(0) })
    expect([...at.oracleMismatches, ...under.oracleMismatches]).toEqual([])
  })

  test('gate danh mục cộng mọi SP danh mục của dược sĩ; export thiếu SP danh mục ⇒ cảnh báo cần BI xác nhận', () => {
    const C1: CmsEngineProductInput = { productId: '910001', gmvBasis: 'catalog', targetGmv: null, baseQuantityCms: '1', tiers: [{ from: 1, to: null, amount: 1000 }] }
    const C2: CmsEngineProductInput = { productId: '910002', gmvBasis: 'catalog', targetGmv: null, baseQuantityCms: '1', tiers: [{ from: 1, to: null, amount: 2000 }] }
    const p = prog([C1, C2], { catalogTargetGmv: 500000 })
    const r = rec([
      row({ product_id: '910001', base_quantity: '2', gmv_amount: '300000' }), row({ product_id: '910002', base_quantity: '3', gmv_amount: '200000' }),
      row({ product_id: '910001', base_quantity: '1', gmv_amount: '600000', seller_email: 'ds.b@example.test' }),
    ], p)
    expect(pair(r, U.A, '910001')).toMatchObject({ met: true, gateGmv: '500000', amount: B(2000) })
    expect(pair(r, U.A, '910002')).toMatchObject({ met: true, amount: B(6000) })
    expect(pair(r, U.B, '910001')).toMatchObject({ met: true, amount: B(1000) })
    expect(r.warnings.filter((w) => w.startsWith('gate danh mục'))).toHaveLength(1)
    expect(r.oracleMismatches).toEqual([])
    const short = rec([row({ product_id: '910001', base_quantity: '2', gmv_amount: '300000' }), row({ product_id: '910002', base_quantity: '3', gmv_amount: '199999.999999999' })], p)
    expect(short.totals.amountVnd).toBe(B(0))
    expect(short.oracleMismatches).toEqual([])
  })

  test('K lẻ (2,5) và dòng âm (dạng Q-206) — cộng dồn rồi ⌊/ K⌋, không âm', () => {
    const K: CmsEngineProductInput = { productId: '900007', gmvBasis: 'none', targetGmv: null, baseQuantityCms: '2.5', tiers: [{ from: 1, to: null, amount: 1000 }] }
    const r = rec([row({ product_id: '900007', base_quantity: '7.5' }), row({ product_id: '900007', base_quantity: '7.4', seller_email: 'ds.b@example.test' })], prog([K]))
    expect(pair(r, U.A, '900007')!.q).toBe(B(3))
    expect(pair(r, U.B, '900007')!.q).toBe(B(2))
    const neg = rec([row({ product_id: '900007', base_quantity: '5' }), row({ product_id: '900007', base_quantity: '-7.5', gmv_amount: '-1', completed_at: '2026-11-06T03:00:00.000000Z' })], prog([K]))
    expect(pair(neg, U.A, '900007')).toMatchObject({ baseQuantity: '-2.5', q: B(0), amount: B(0), lines: 2 })
    expect([...r.oracleMismatches, ...neg.oracleMismatches]).toEqual([])
  })

  test('order_line_id trùng ⇒ app giữ snapshot cũ (held); công cụ đối soát cảnh báo và chỉ chạy trên bản bỏ trùng', () => {
    const a = row()
    expect(cmsI4CheckSales([a, { ...a, gmv_amount: '1' }]).readiness).toMatchObject({ status: 'not_ready', held: ['DUPLICATE_LINE_ID'] })
    const r = rec([a, { ...a, gmv_amount: '1' }])
    expect(r.normalize.duplicateLineIds).toBe(1)
    expect(r.readiness).toMatchObject({ status: 'not_ready', held: ['DUPLICATE_LINE_ID'] })
    expect(pair(r, U.A, '900001')).toMatchObject({ lines: 1, gmv: '120000' })
    expect(r.warnings[0]).toMatch(/^KHÔNG ĐẠT nghiệm thu \(DUPLICATE_LINE_ID\)/)
    expect(r.warnings[1]).toMatch(/order_line_id trùng — app thật GIỮ snapshot cũ/)
  })

  test('ngẫu nhiên (3 hạt × 600 dòng): engine = oracle độc lập ở mọi cặp; oracle theo đoạn = oracle từng đơn vị', () => {
    const C1: CmsEngineProductInput = { productId: '910001', gmvBasis: 'catalog', targetGmv: null, baseQuantityCms: '1', tiers: [{ from: 1, to: 3, amount: 1000 }, { from: 4, to: null, amount: 1500 }] }
    const C2: CmsEngineProductInput = { productId: '910002', gmvBasis: 'catalog', targetGmv: null, baseQuantityCms: '0.5', tiers: [{ from: 1, to: null, amount: 700 }] }
    const KC: CmsEngineProductInput = { productId: '900007', gmvBasis: 'none', targetGmv: null, baseQuantityCms: '2.5', tiers: [{ from: 1, to: 4, amount: 3000 }, { from: 5, to: 8, amount: 3500 }] }
    const products = [P1, P2, C1, C2, KC]
    const p = prog(products, { catalogTargetGmv: 2000000, storeIds: [STORE] })
    const emails = ['ds.a@example.test', 'DS.B@example.test ', 'qlch.x@example.test', 'ai@example.test', 'ds.fs@example.test', 'ds.out@example.test', null]
    const t0 = B(Date.UTC(2026, 9, 30)) * B(1000), span = B(33 * 86_400) * B(1_000_000)
    for (const seed of [7, 4242, 909090]) {
      let s = seed
      const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
      const pickOf = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]
      const rows: CmsRawRow[] = []
      for (let i = 0; i < 600; i++) {
        const neg = rnd() < 0.06
        const bq = (Math.floor(rnd() * 400) / 10) * (neg ? -1 : 1)
        const t = formatUtcMicros(t0 + (span * B(Math.floor(rnd() * 1e6))) / B(1e6))
        rows.push(row({
          product_id: pickOf(['900001', '900002', '910001', '910002', '900007', '999999']), seller_email: pickOf(emails),
          order_type: rnd() < 0.08 ? 'ONLINE' : 'OFFLINE', order_status: rnd() < 0.06 ? 'CANCELLED' : 'COMPLETED', completed_at: t, source_updated_at: t,
          base_quantity: String(bq), gmv_amount: String(Math.round(bq * 9000 + rnd() * 1000) * (neg ? 1 : 1)),
        }))
      }
      // Dược sĩ C bán ít ⇒ luôn có cặp gate SP và gate danh mục CHƯA đạt bên cạnh các cặp ngẫu nhiên (thường đạt).
      rows.push(row({ product_id: '900002', seller_email: 'ds.c@example.test', base_quantity: '2', gmv_amount: '1000' }), row({ product_id: '910001', seller_email: 'ds.c@example.test', base_quantity: '1', gmv_amount: '1000' }))
      const r = rec(rows, p)
      expect(r.normalize.invalid, `seed ${seed}`).toBe(0)
      expect(r.oracleMismatches, `seed ${seed}`).toEqual([])
      expect(r.pairs.length, `seed ${seed}`).toBeGreaterThan(6)
      expect(r.pairs.some((x) => x.met) && r.pairs.some((x) => !x.met), `seed ${seed} có cả đạt / chưa đạt gate`).toBe(true)
      const parsed = parseCmsEngineProgram(p)
      const lines = rows.map((x) => { const n = normalizeSalesRow(x); if (!n.ok) throw new Error('rnd'); return n.value })
      for (const [k, v] of cmsI4Oracle(parsed, lines, users, stores, p.startDate, p.endDate)) {
        const prod = products.find((x) => x.productId === k.split('|')[1])!
        expect(v.amount, `${seed} ${k}`).toBe(v.met ? naiveF(prod.tiers, v.q) : B(0))
      }
    }
  })
})

test.describe('CMS I4 · phát hiện lệch so với số tính tay @desktop', () => {
  const ctxRows = () => fxCsv('sales.csv', CMS_SALES_COLUMNS).rows
  const exp = (body: string) => {
    const c = cmsI4ReadCsv(csvBuf(`seller_email,product_id,expected_cms_vnd,expected_q,expected_gmv\n${body}`), ['seller_email', 'product_id', 'expected_cms_vnd'], ['expected_q', 'expected_gmv'])
    if (!c.ok) throw new Error(c.reason)
    const e = cmsI4ParseExpected(c.rows)
    if (!e.ok) throw new Error(e.reason)
    return e.value
  }
  const run = (lines: string) => cmsI4Reconcile({ ...fxCtx(), rows: ctxRows(), expected: exp(lines) }).expected!

  test('tiền / Q / GMV lệch được phân loại; thiếu cặp hai chiều; kỳ vọng CHỈ có CMS 0 khi engine không có dòng = khớp (đếm riêng)', () => {
    const r = run('ds.a@example.test,900001,22000,,\nDS.B@example.test ,900002,40000,7,\nds.b@example.test,900001,0,0,63001\nds.a@example.test,900003,0,,\nds.b@example.test,900003,5000,,\n')
    expect(r.compared).toBe(5)
    expect(r.matched).toBe(1)
    expect(r.matchedWithoutPair).toBe(1)
    expect(r.mismatches.map((m) => [m.pair, m.fields.map((f) => f.name).join('+'), m.hint.split(' — ')[0]])).toEqual([
      ['***@example.test/900001', 'amount', 'Cùng Q và gate nhưng tiền lệch'],
      ['***@example.test/900002', 'q', 'Q lệch'],
      ['***@example.test/900001', 'gmv', 'GMV / gate lệch'],
    ])
    expect(r.missingInEngine.map((m) => [m.pair, m.fields])).toEqual([['***@example.test/900003', [{ name: 'amount', expected: '5000', actual: 'không có cặp (0)' }]]])
    expect(r.notInExpected).toEqual([])
    const missing = run('ds.a@example.test,900001,20000,2,242000\n')
    expect(missing.notInExpected).toEqual(['***@example.test/900002'])
  })

  test('file kỳ vọng sai dạng ⇒ từ chối (không so nửa vời)', () => {
    const bad = (body: string) => {
      const c = cmsI4ReadCsv(csvBuf(`seller_email,product_id,expected_cms_vnd\n${body}`), ['seller_email', 'product_id', 'expected_cms_vnd'])
      const e = c.ok ? cmsI4ParseExpected(c.rows) : { ok: false as const, reason: c.reason }
      return e.ok ? 'ok' : e.reason
    }
    expect(bad('ds.a@example.test,900001,20000\n')).toBe('ok')
    expect(bad('ds.a@example.test,900001.0,20000\n')).toMatch(/dòng kỳ vọng 2/)
    expect(bad('ds.a@example.test,900001,-1\n')).toMatch(/dòng kỳ vọng 2/)
    expect(bad('ds.a@example.test,900001,20000.5\n')).toMatch(/dòng kỳ vọng 2/)
    expect(bad(',900001,0\n')).toMatch(/dòng kỳ vọng 2/)
    expect(bad('ds.a@example.test,900001,1\nDS.A@example.test,0900001,1\n')).toBe('file kỳ vọng có cặp email × SP trùng')
  })
})

test.describe('CMS I4 · N4a kiểm dữ liệu thô (không kết luận tiền) @desktop', () => {
  test('fixture: độ phủ ca a–i, ca e luôn là đối chiếu tay; bảng chỉ có email che', () => {
    const ctx = fxCtx()
    const r = cmsI4N4a(fxCsv('sales.csv', CMS_SALES_COLUMNS).rows, { sellers: buildSellerIndex(ctx.users, ctx.stores), program: parseCmsEngineProgram(ctx.program) })
    expect(r.coverage).toEqual({ a: 8, b: 3, c: 1, d: 0, e: null, f: 2, g: 1, h: 2, i: 0 })
    expect(r.rows.find((x) => x.orderLineId === '7000003')!.cases).toEqual(['b', 'c'])
    expect(r.rows.find((x) => x.orderLineId === '7000001')).toMatchObject({ vnDate: '2026-11-01', cases: ['a', 'f'], mapping: 'staff', sellerMasked: '***@example.test' })
    const md = cmsI4N4aMarkdown(r)
    expect(md).not.toMatch(/ds\.a@|ds\.b@|qlch\.x@/)
    expect(md).toContain('| d | Một đơn nhiều dòng | **THIẾU** |')
    expect(md).toContain('| e | Đơn có giảm giá dòng / voucher — GMV = item.amount (operator đối chiếu tay với nguồn) | CHƯA KIỂM — đối chiếu tay |')
    expect(Object.keys(CMS_I4_CASES)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
  })

  test('bộ 8 đơn phủ đủ a–d, f–i; dòng lỗi được liệt kê kèm mã lỗi; thiếu bối cảnh ⇒ a / b / g CHƯA KIỂM', () => {
    const rows = [
      row({ order_id: 'N1', order_code: 'N1' }), row({ order_id: 'N1', order_code: 'N1', product_id: '900002', base_quantity: '2', quantity_raw: '2', uom_raw: 'Tuýp' }),
      row({ order_id: 'N2', order_code: 'N2', quantity_raw: '3', uom_raw: 'Vỉ', base_quantity: '30' }),
      row({ order_id: 'N3', order_code: 'N3', quantity_raw: '7', uom_raw: 'Viên', base_quantity: '7' }),
      row({ order_id: 'N4', order_code: 'N4', completed_at: '2026-11-09T16:45:00.000000Z' }),
      row({ order_id: 'N5', order_code: 'N5', seller_email: 'qlch.x@example.test' }),
      row({ order_id: 'N6', order_code: 'N6', order_type: 'ONLINE' }),
      row({ order_id: 'N7', order_code: 'N7', base_quantity: '-30', gmv_amount: '-120000' }),
      row({ order_id: 'N8', order_code: 'N8', base_quantity: '1e+06' }),
    ]
    const r = cmsI4N4a(rows, { sellers: buildSellerIndex(users, stores), program: parseCmsEngineProgram(prog([P1, P2])) })
    expect(Object.entries(r.coverage).filter(([, v]) => v === 0)).toEqual([])
    expect(r.coverage.e).toBeNull()
    expect(r.rows.find((x) => x.orderCode === 'N8')!.issues).toEqual(['BAD_NUMBER:base_quantity'])
    const bare = cmsI4N4a(rows)
    expect([bare.coverage.a, bare.coverage.b, bare.coverage.g]).toEqual([null, null, null])
    expect(cmsI4N4aMarkdown(r)).toContain('| c | ')
    expect(cmsI4N4aMarkdown(r)).toMatch(/\| c \| [^\n]*\| 1 dòng ứng viên — cần BI xác nhận tổng dòng \|/)
  })

  test('file lệch cột: ô chứa email bị che "***", ô dài bị cắt, "|" không vỡ bảng; type / status lạ gộp "KHÁC" ở stdout', () => {
    const r = cmsI4N4a([row({ order_code: 'ds.a@example.test', base_quantity: 'x', uom_raw: `a|${'b'.repeat(45)}` })])
    expect(r.rows[0]).toMatchObject({ orderCode: '***', baseQuantity: 'x', issues: ['BAD_NUMBER:base_quantity'] })
    expect(r.rows[0].uomRaw).toBe(`a ${'b'.repeat(38)}…`)
    const ok = cmsI4N4a([row({ order_type: 'ds.b@example.test', uom_raw: 'Vỉ|Hộp' })])
    expect([ok.rows[0].orderType, ok.rows[0].uomRaw]).toEqual(['***', 'Vỉ Hộp'])
    expect(cmsI4N4aMarkdown(ok)).not.toMatch(/ds\.b@/)
    const c = cmsI4CheckSales([row({ order_type: 'ds.b@example.test' }), row({ order_status: 'Hoàn tất' }), row()])
    expect(c.typeStatus).toEqual({ 'KHÁC/COMPLETED': 1, 'OFFLINE/KHÁC': 1, 'OFFLINE/COMPLETED': 1 })
  })
})

test.describe('CMS I4 · CLI offline (đường dẫn ngoài Git, stdout chỉ số đếm) @desktop', () => {
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: WEBAPP, encoding: 'utf8', timeout: 60_000 })
    return { rc: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const fx = (n: string) => `--${n.split('.')[0]}=${path.join(FX, n)}`
  let tmp = ''
  test.beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-i4-spec-')) })
  test.afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })

  test('fixture: check-products 0 · check-sales 0 · n4a 1 (thiếu ca d / i) · reconcile + kỳ vọng 0; stdout không có email', () => {
    const p = cli('check-products', fx('products.csv'))
    expect(p.rc).toBe(0)
    const s = cli('check-sales', fx('sales.csv'), fx('context.json'))
    expect(s.rc).toBe(0)
    expect(s.out).toContain('"accepted":true')
    expect(s.out).toContain('"readiness":{"status":"ready","held":[],"contract":[],"noEvidence":[],"notProven":["INCOMPLETE_PAGES","EMPTY_AFTER_DATA","PERIOD_COMPLETENESS"]}')
    const n = cli('n4a', fx('sales.csv'), fx('context.json'), `--out=${path.join(tmp, 'n4a.md')}`)
    expect(n.rc).toBe(1)
    expect(n.out).toContain('"missing":["d","i"],"manual":["e"],"scope":"contract"')
    expect(n.out).toContain('"accepted":false,"readiness":{"status":"ready"')
    const r = cli('reconcile', fx('sales.csv'), fx('context.json'), fx('expected.csv'), `--out=${path.join(tmp, 'n4b.md')}`)
    expect(r.rc).toBe(0)
    expect(r.out).toContain('"accepted":true')
    expect(r.out).toContain('"amountVnd":"60000"')
    expect(r.out).toContain('"oracleMismatches":0,"expected":{"compared":4,"matched":4,"matchedWithoutPair":0,"mismatches":0,"missingInEngine":0,"notInExpected":0}')
    for (const o of [p.out, s.out, n.out, r.out]) expect(o).not.toMatch(/ds\.a|ds\.b|qlch|00000000-0000/)
    const md = fs.readFileSync(path.join(tmp, 'n4b.md'), 'utf8')
    expect(md).toContain('**Kết luận: ĐẠT các gate kiểm được offline.**')
    expect(md).toContain('Chưa chứng minh offline: INCOMPLETE_PAGES, EMPTY_AFTER_DATA, PERIOD_COMPLETENESS.')
    expect(md).toContain('4 / 4 khớp')
  })

  test('đường dẫn: dữ liệu ngoài Git được nhận; file trong cây Git (không phải fixture) / đầu ra trong Git / ghi đè ⇒ rc 2 trước khi đọc', () => {
    const real = path.join(tmp, 'sales-real.csv')
    fs.copyFileSync(path.join(FX, 'sales.csv'), real)
    expect(cli('check-sales', `--sales=${real}`).rc).toBe(0)
    const inRepo = cli('check-sales', `--sales=${path.join(WEBAPP, 'package.json')}`)
    expect([inRepo.rc, inRepo.out]).toEqual([2, expect.stringContaining('nằm trong một cây Git')])
    const outRepo = cli('n4a', `--sales=${real}`, `--out=${path.join(WEBAPP, 'i4-should-not-exist.md')}`)
    expect([outRepo.rc, outRepo.out]).toEqual([2, expect.stringContaining('--out: đầu ra nằm trong một cây Git')])
    expect(fs.existsSync(path.join(WEBAPP, 'i4-should-not-exist.md'))).toBe(false)
    fs.writeFileSync(path.join(tmp, 'exists.md'), 'x')
    expect(cli('n4a', `--sales=${real}`, `--out=${path.join(tmp, 'exists.md')}`).rc).toBe(2)
    expect(cli('n4a', `--sales=${real}`, `--out=${path.join(tmp, 'khong-co', 'x.md')}`).rc).toBe(2)
    expect(cli('check-sales', `--sales=${path.join(tmp, 'khong-co.csv')}`).rc).toBe(2)
  })

  test('tham số / file sai ⇒ rc 2; dữ liệu lệch ⇒ rc 1', () => {
    expect(cli('reconcile', fx('sales.csv')).out).toContain('reconcile cần --context')
    expect(cli('n4a', fx('sales.csv')).rc).toBe(2)
    expect(cli('check-products', fx('products.csv'), fx('sales.csv')).rc).toBe(2)
    expect(cli('nope').rc).toBe(2)
    const badCtx = path.join(tmp, 'ctx-bad.json')
    fs.writeFileSync(badCtx, JSON.stringify({ ...fxCtx(), program: prog([{ ...P1, tiers: [{ from: 2, to: null, amount: 1 }] }]) }))
    expect(cli('reconcile', fx('sales.csv'), `--context=${badCtx}`).out).toMatch(/--context: program: .*bậc 1: phải bắt đầu từ 1/)
    const noCol = path.join(tmp, 'nocol.csv')
    fs.writeFileSync(noCol, `${CMS_SALES_COLUMNS.filter((c) => c !== 'uom_raw').join(',')}\n`)
    expect(cli('check-sales', `--sales=${noCol}`).out).toContain('SCHEMA_MISMATCH: thiếu cột uom_raw')
    const wrong = path.join(tmp, 'expected-wrong.csv')
    fs.writeFileSync(wrong, fs.readFileSync(path.join(FX, 'expected.csv'), 'utf8').replace('ds.a@example.test,900001,20000', 'ds.a@example.test,900001,22000'))
    const w = cli('reconcile', fx('sales.csv'), fx('context.json'), `--expected=${wrong}`, `--out=${path.join(tmp, 'n4b-wrong.md')}`)
    expect(w.rc).toBe(1)
    expect(fs.readFileSync(path.join(tmp, 'n4b-wrong.md'), 'utf8')).toContain('amount kỳ vọng 22000 / thực 20000')
    const lead = path.join(tmp, 'lead.csv')
    fs.writeFileSync(lead, fs.readFileSync(path.join(FX, 'sales.csv'), 'utf8').replace('7000002,O1002,SO1002,900001', '7000002,O1002,SO1002,0900001'))
    const l = cli('check-sales', `--sales=${lead}`)
    expect([l.rc, l.out]).toEqual([1, expect.stringContaining('"nonCanonicalProductId":1')])
  })

  test('công cụ I4 / Q-206 không được app import (chỉ script offline dùng)', () => {
    const hits: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && /cmsI4Offline|cmsQ206Cases/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(WEBAPP, p).replace(/\\/g, '/'))
      }
    }
    for (const d of ['app', 'lib', 'components', 'scripts']) walk(path.join(WEBAPP, d))
    expect(hits).toEqual(['scripts/cms-i4-offline.mjs'])
  })

  test('fixture chỉ gồm 4 file GIẢ (email @example.test, UUID 00000000-…); file khác thả vào thư mục fixture vẫn bị chặn như dữ liệu trong Git', () => {
    expect(fs.readdirSync(FX).sort()).toEqual(['context.json', 'expected.csv', 'products.csv', 'sales.csv'])
    for (const f of fs.readdirSync(FX)) {
      const t = fs.readFileSync(path.join(FX, f), 'utf8')
      for (const m of t.match(/[^\s",]+@[^\s",]+/g) ?? []) expect(m.trim(), f).toMatch(/@example\.test$/i)
      for (const m of t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []) expect(m, f).toMatch(/^00000000-0000-4000-8000-/)
    }
    const stray = path.join(FX, `stray-${process.pid}.csv`)
    try {
      fs.copyFileSync(path.join(FX, 'sales.csv'), stray)
      const r = cli('check-sales', `--sales=${stray}`)
      expect([r.rc, r.out]).toEqual([2, expect.stringContaining('nằm trong một cây Git')])
    } finally {
      fs.rmSync(stray, { force: true })
    }
  })
})

// ── r2 — PM audit 04/11 (`planning/reviews/2026-11-04-cms-i4-offline-pm.md`): I4-P1-1 / I4-P1-2 ─────────────────────────────

const fxText = (name: string) => fs.readFileSync(path.join(FX, name), 'utf8')
const EXP_HEADER = 'seller_email,product_id,expected_cms_vnd,expected_q,expected_gmv'
const parseExp = (body: string) => {
  const c = cmsI4ReadCsv(csvBuf(`${EXP_HEADER}\n${body}`), ['seller_email', 'product_id', 'expected_cms_vnd'], ['expected_q', 'expected_gmv'])
  if (!c.ok) throw new Error(c.reason)
  const e = cmsI4ParseExpected(c.rows)
  if (!e.ok) throw new Error(e.reason)
  return e.value
}
/** CSV đúng 14 cột từ bản ghi (NULL ⇒ ô rỗng; giá trị giữ nguyên kể cả khoảng trắng / số 0 đầu). */
const salesCsv = (rows: CmsRawRow[]) => [SALES_HEADER, ...rows.map((r) => CMS_SALES_COLUMNS.map((c) => {
  const v = r[c]
  return v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`
}).join(','))].join('\n') + '\n'
const runCli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: WEBAPP, encoding: 'utf8', timeout: 60_000 })
  return { rc: r.status, out: `${r.stdout}${r.stderr}` }
}
/** JSON một dòng `I4 <lệnh> {...}` của stdout. */
const cliJson = (out: string, cmd: string) => {
  const line = out.split(/\r?\n/).find((l) => l.startsWith(`I4 ${cmd} `))
  if (!line) throw new Error(`không có dòng I4 ${cmd}: ${out}`)
  return JSON.parse(line.slice(`I4 ${cmd} `.length))
}
const fxArg = (n: string) => `--${n.split('.')[0]}=${path.join(FX, n)}`
const NOT_PROVEN = ['INCOMPLETE_PAGES', 'EMPTY_AFTER_DATA', 'PERIOD_COMPLETENESS']
/** Ba cặp còn lại của fixture khi bỏ dòng A/900002 (7000008) — số tính tay §2.4. */
const BASE_EXP = 'ds.a@example.test,900001,20000,2,242000\nds.b@example.test,900001,0,0,63000\nds.b@example.test,900002,40000,8,1200000\n'

test.describe('CMS I4 r2 · I4-P1-1 — thiếu cặp không được che bằng CMS 0 @desktop', () => {
  let tmp = ''
  test.beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-i4-r2a-')) })
  test.afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })
  const salesNo8 = () => fxCsv('sales.csv', CMS_SALES_COLUMNS).rows.filter((r) => r.order_line_id !== '7000008')
  const run = (body: string) => cmsI4Reconcile({ ...fxCtx(), rows: salesNo8(), expected: parseExp(body) }).expected!
  const none = 'không có cặp (0)'

  test('engine không có cặp: CMS 0 nhưng Q ≠ 0 và / hoặc GMV ≠ 0 ⇒ thiếu; chỉ khớp khi MỌI chỉ số đã cung cấp = 0', () => {
    const pm = run(`${BASE_EXP}ds.a@example.test,900002,0,3,450000\n`) // đúng ca PM: CMS 0, Q 3, GMV 450.000
    expect([pm.compared, pm.matched, pm.matchedWithoutPair, pm.mismatches.length]).toEqual([4, 3, 0, 0])
    expect(pm.missingInEngine.map((m) => [m.pair, m.fields])).toEqual([['***@example.test/900002',
      [{ name: 'q', expected: '3', actual: none }, { name: 'gmv', expected: '450000', actual: none }]]])
    expect(run(`${BASE_EXP}ds.a@example.test,900002,0,0,450000\n`).missingInEngine.map((m) => m.fields.map((f) => f.name))).toEqual([['gmv']])
    expect(run(`${BASE_EXP}ds.a@example.test,900002,0,3,0\n`).missingInEngine.map((m) => m.fields.map((f) => f.name))).toEqual([['q']])
    expect(run(`${BASE_EXP}ds.a@example.test,900002,10000,0,0\n`).missingInEngine.map((m) => m.fields.map((f) => f.name))).toEqual([['amount']])
    for (const z of ['0,0,0', '0,,', '0,0,', '0,,0', '0,0,0.000000000']) {
      const r = run(`${BASE_EXP}ds.a@example.test,900002,${z}\n`)
      expect([r.matched, r.matchedWithoutPair, r.missingInEngine.length], z).toEqual([4, 1, 0])
    }
    // Cặp CÓ ở engine: Q / GMV kỳ vọng vẫn được so như trước (không bị nới bởi sửa trên).
    expect(run('ds.b@example.test,900001,0,0,0\n').mismatches.map((m) => m.fields.map((f) => f.name))).toEqual([['gmv']])
  })

  test('CLI đúng ca PM: bỏ dòng A/900002, giữ nguyên expected.csv ⇒ rc 1, 3 / 4 khớp, thiếu 1 (không còn "4 / 4 khớp"); ca zero hợp lệ ⇒ rc 0', () => {
    const sales = path.join(tmp, 'p11-sales.csv')
    fs.writeFileSync(sales, fxText('sales.csv').split(/\r?\n/).filter((l) => !l.startsWith('7000008,')).join('\n'))
    const r = runCli('reconcile', `--sales=${sales}`, fxArg('context.json'), fxArg('expected.csv'), `--out=${path.join(tmp, 'p11.md')}`)
    expect(r.rc).toBe(1)
    const j = cliJson(r.out, 'reconcile')
    expect([j.accepted, j.readiness.status, j.pairs, j.totals.included]).toEqual([false, 'ready', 3, 6])
    expect(j.expected).toEqual({ compared: 4, matched: 3, matchedWithoutPair: 0, mismatches: 0, missingInEngine: 1, notInExpected: 0 })
    const md = fs.readFileSync(path.join(tmp, 'p11.md'), 'utf8')
    expect(md).toContain('**Kết luận: KHÔNG ĐẠT — lệch engine / oracle / số tính tay (chi tiết dưới).**')
    expect(md).toContain(`q kỳ vọng 3 / thực ${none}; gmv kỳ vọng 450000 / thực ${none}`)
    expect(md).not.toContain('4 / 4 khớp')
    const zero = path.join(tmp, 'p11-zero.csv')
    fs.writeFileSync(zero, `${EXP_HEADER}\n${BASE_EXP}ds.a@example.test,900002,0,0,0\n`)
    const z = runCli('reconcile', `--sales=${sales}`, fxArg('context.json'), `--expected=${zero}`, `--out=${path.join(tmp, 'p11-zero.md')}`)
    expect(z.rc).toBe(0)
    expect(cliJson(z.out, 'reconcile').expected).toEqual({ compared: 4, matched: 4, matchedWithoutPair: 1, mismatches: 0, missingInEngine: 0, notInExpected: 0 })
    expect(fs.readFileSync(path.join(tmp, 'p11-zero.md'), 'utf8')).toContain('1 cặp kỳ vọng 0 được tính khớp vì engine KHÔNG có dòng nào của cặp')
  })
})

test.describe('CMS I4 r2 · I4-P1-2 — một kết luận readiness cho mọi lệnh @desktop', () => {
  let tmp = ''
  test.beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-i4-r2b-')) })
  test.afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })
  const fxRows = () => fxCsv('sales.csv', CMS_SALES_COLUMNS).rows
  const lead = () => fxRows().map((r) => (r.order_line_id === '7000002' ? { ...r, product_id: '0900001' } : r))
  const ctxA = () => fxCtx()
  const write = (name: string, text: string) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p }
  const writeCtx = (name: string, c: object) => write(name, JSON.stringify(c))
  /** n dòng ứng viên SP 900001 trong kỳ, `bad` dòng người bán không có tài khoản. */
  const nRows = (n: number, bad: number) => [...Array(n)].map((_, i) => row({ seller_email: i < bad ? 'ai@example.test' : 'ds.a@example.test' }))

  test('lõi: check-sales(rows, bối cảnh).readiness ≡ reconcile(rows).readiness trên mọi biến thể', () => {
    const c = ctxA()
    const noUsers = { ...c, users: [] as CmsUserRef[] }
    const cases: [string, CmsRawRow[], typeof c, Partial<ReturnType<typeof cmsI4CheckSales>['readiness']>][] = [
      ['fixture', fxRows(), c, { status: 'ready', held: [], contract: [], noEvidence: [] }],
      ['ProductID 0900001', lead(), c, { status: 'not_ready', held: [], contract: ['NON_CANONICAL_PRODUCT_ID'], noEvidence: [] }],
      ['users = []', fxRows(), noUsers, { status: 'not_ready', held: ['UNASSIGNED_OVER_THRESHOLD'], contract: [], noEvidence: [] }],
      ['rỗng', [], c, { status: 'not_ready', held: [], contract: [], noEvidence: ['EMPTY_EXPORT', 'NO_CANDIDATES'] }],
      ['chỉ ONLINE', [row({ order_type: 'ONLINE' })], c, { status: 'not_ready', held: [], noEvidence: ['NO_CANDIDATES'] }],
      ['chỉ ngoài kỳ', [row({ completed_at: '2026-12-02T03:00:00.000000Z' })], c, { status: 'not_ready', noEvidence: ['NO_CANDIDATES'] }],
      ['trùng dòng', [...fxRows(), fxRows()[1]], c, { status: 'not_ready', held: ['DUPLICATE_LINE_ID'] }],
      ['lỗi dòng', [...fxRows(), row({ gmv_amount: '1e5' })], c, { status: 'not_ready', held: ['ROW_ISSUES'] }],
      ['chưa gán 2 / 10', nRows(10, 2), c, { status: 'ready', held: [] }],
      ['chưa gán 2 / 9', nRows(9, 2), c, { status: 'not_ready', held: ['UNASSIGNED_OVER_THRESHOLD'] }],
      ['OVERFLOW', [row({ gmv_amount: `1${'0'.repeat(20)}` })], c, { status: 'not_ready', held: ['OVERFLOW'] }],
    ]
    for (const [name, rows, ctx, want] of cases) {
      const a = cmsI4CheckSales(rows, ctx).readiness
      const b = cmsI4Reconcile({ ...ctx, rows }).readiness
      expect(a, name).toMatchObject({ ...want, notProven: NOT_PROVEN })
      expect(b, name).toEqual(a)
    }
  })

  test('ca PM 1 — ProductID 0900001: check-sales VÀ reconcile cùng rc 1 / cùng readiness; bảng tính đúng tập app (SQL lọc mất dòng đó)', () => {
    const sales = write('lead.csv', fxText('sales.csv').replace('7000002,O1002,SO1002,900001', '7000002,O1002,SO1002,0900001'))
    const s = runCli('check-sales', `--sales=${sales}`, fxArg('context.json'))
    const r = runCli('reconcile', `--sales=${sales}`, fxArg('context.json'), fxArg('expected.csv'), `--out=${path.join(tmp, 'lead.md')}`)
    expect([s.rc, r.rc]).toEqual([1, 1])
    const sj = cliJson(s.out, 'check-sales')
    const rj = cliJson(r.out, 'reconcile')
    expect(sj.readiness).toEqual({ status: 'not_ready', held: [], contract: ['NON_CANONICAL_PRODUCT_ID'], noEvidence: [], notProven: NOT_PROVEN })
    expect(rj.readiness).toEqual(sj.readiness)
    expect([sj.accepted, rj.accepted, sj.sqlDroppedNonCanonical, rj.totals.excluded.SQL_NON_CANONICAL]).toEqual([false, false, 1, 1])
    const md = fs.readFileSync(path.join(tmp, 'lead.md'), 'utf8')
    expect(md).toContain('**Kết luận: KHÔNG ĐẠT — snapshot không sẵn sàng (held: — · hợp đồng: NON_CANONICAL_PRODUCT_ID · không có bằng chứng: —).')
    expect(md).toContain('1 dòng SP chương trình có product_id sai dạng chuẩn — SQL production lọc theo CHUỖI nên app thật KHÔNG đọc (I4-F2)')
    // App thật chỉ đọc 7000001 + 7000003 của A/900001 ⇒ 50 viên ⇒ Q 1 ⇒ 10.000 (không phải 20.000 như khi tính cả dòng sai dạng).
    const u = cmsI4Reconcile({ ...ctxA(), rows: lead() })
    expect(pair(u, U.A, '900001')).toMatchObject({ lines: 2, baseQuantity: '50', q: B(1), amount: B(10000) })
    expect(u.oracleMismatches).toEqual([])
  })

  test('ca PM 2 — users = []: check-sales held UNASSIGNED_OVER_THRESHOLD ⇒ reconcile cũng rc 1, không chứng nhận "0 cặp / 0 tiền"', () => {
    const ctx = writeCtx('ctx-nousers.json', { ...ctxA(), users: [] })
    const s = runCli('check-sales', fxArg('sales.csv'), `--context=${ctx}`)
    const r = runCli('reconcile', fxArg('sales.csv'), `--context=${ctx}`, `--out=${path.join(tmp, 'nousers.md')}`)
    expect([s.rc, r.rc]).toEqual([1, 1])
    const sj = cliJson(s.out, 'check-sales')
    const rj = cliJson(r.out, 'reconcile')
    expect(sj.readiness.held).toEqual(['UNASSIGNED_OVER_THRESHOLD'])
    expect(rj.readiness).toEqual(sj.readiness)
    expect([rj.accepted, rj.pairs, rj.totals.amountVnd, rj.oracleMismatches]).toEqual([false, 0, '0', 0])
    expect(fs.readFileSync(path.join(tmp, 'nousers.md'), 'utf8')).toContain('held: UNASSIGNED_OVER_THRESHOLD')
  })

  test('ca PM 3 — Product Master chỉ header ⇒ check-products rc 1, held EMPTY_SOURCE', () => {
    const p = write('products-empty.csv', `${CMS_PRODUCT_COLUMNS.join(',')}\n`)
    const r = runCli('check-products', `--products=${p}`)
    expect(r.rc).toBe(1)
    expect(cliJson(r.out, 'check-products')).toMatchObject({ accepted: false, rowsRead: 0, readiness: { status: 'not_ready', held: ['EMPTY_SOURCE'] } })
  })

  test('biên chưa gán qua CLI: đúng 20 % (2 / 10) ⇒ check-sales + reconcile rc 0; 2 / 9 (22 %) ⇒ cả hai rc 1', () => {
    for (const [n, want] of [[10, 0], [9, 1]] as const) {
      const sales = write(`unassigned-${n}.csv`, salesCsv(nRows(n, 2)))
      const s = runCli('check-sales', `--sales=${sales}`, fxArg('context.json'))
      const r = runCli('reconcile', `--sales=${sales}`, fxArg('context.json'))
      expect([s.rc, r.rc], `${n}`).toEqual([want, want])
      expect(cliJson(r.out, 'reconcile').readiness, `${n}`).toEqual(cliJson(s.out, 'check-sales').readiness)
      expect(cliJson(s.out, 'check-sales'), `${n}`).toMatchObject({ candidates: n, unassigned: { NOT_FOUND: 2 } })
    }
  })

  test('rỗng / 0 ứng viên không tạo chứng nhận: check-sales, reconcile (kể cả kỳ vọng toàn 0) và n4a đều rc 1', () => {
    const empty = write('sales-empty.csv', `${SALES_HEADER}\n`)
    const s = runCli('check-sales', `--sales=${empty}`, fxArg('context.json'))
    expect(s.rc).toBe(1)
    expect(cliJson(s.out, 'check-sales').readiness).toMatchObject({ status: 'not_ready', noEvidence: ['EMPTY_EXPORT', 'NO_CANDIDATES'] })
    expect(cliJson(runCli('check-sales', `--sales=${empty}`).out, 'check-sales').readiness.noEvidence).toEqual(['EMPTY_EXPORT'])
    const zero = write('exp-zero.csv', `${EXP_HEADER}\nds.a@example.test,900001,0,0,0\n`)
    const r = runCli('reconcile', `--sales=${empty}`, fxArg('context.json'), `--expected=${zero}`, `--out=${path.join(tmp, 'empty.md')}`)
    expect(r.rc).toBe(1)
    const rj = cliJson(r.out, 'reconcile')
    expect([rj.accepted, rj.expected.matched, rj.readiness.noEvidence]).toEqual([false, 1, ['EMPTY_EXPORT', 'NO_CANDIDATES']])
    expect(fs.readFileSync(path.join(tmp, 'empty.md'), 'utf8')).toContain('không có bằng chứng: EMPTY_EXPORT, NO_CANDIDATES). Bảng và so khớp dưới CHỈ để chẩn đoán')
    const online = write('sales-online.csv', salesCsv([row({ order_type: 'ONLINE' }), row({ order_status: 'CANCELLED' })]))
    expect(cliJson(runCli('check-sales', `--sales=${online}`, fxArg('context.json')).out, 'check-sales').readiness.noEvidence).toEqual(['NO_CANDIDATES'])
    const n = runCli('n4a', `--sales=${empty}`, `--out=${path.join(tmp, 'n4a-empty.md')}`)
    expect([n.rc, cliJson(n.out, 'n4a').readiness.noEvidence]).toEqual([1, ['EMPTY_EXPORT']])
  })

  test('n4a: ProductID sai dạng ⇒ bảng hiện giá trị THÔ + mã lỗi hợp đồng; bộ đơn đủ ca a–d, f–i: rc 0, thêm đúng một ProductID sai dạng ⇒ rc 1', () => {
    const t = cmsI4N4a([row({ product_id: '0900001' }), row({ product_id: ' 900001' }), row()])
    expect(t.rows.map((x) => [x.productId, x.issues])).toEqual([['"0900001"', ['NON_CANONICAL_PRODUCT_ID']], ['" 900001"', ['NON_CANONICAL_PRODUCT_ID']], ['900001', []]])
    const set = (n2Pid: string) => [
      row({ order_id: 'N1', order_code: 'N1' }), row({ order_id: 'N1', order_code: 'N1', product_id: '900002', base_quantity: '2', quantity_raw: '2', uom_raw: 'Tuýp' }),
      row({ order_id: 'N2', order_code: 'N2', product_id: n2Pid, quantity_raw: '3', uom_raw: 'Vỉ', base_quantity: '30' }),
      row({ order_id: 'N3', order_code: 'N3', quantity_raw: '7', uom_raw: 'Viên', base_quantity: '7' }),
      row({ order_id: 'N4', order_code: 'N4', completed_at: '2026-11-09T16:45:00.000000Z' }),
      row({ order_id: 'N5', order_code: 'N5', seller_email: 'qlch.x@example.test' }),
      row({ order_id: 'N6', order_code: 'N6', order_type: 'ONLINE' }),
      row({ order_id: 'N7', order_code: 'N7', base_quantity: '-30', gmv_amount: '-120000' }),
    ]
    const ok = runCli('n4a', `--sales=${write('n4a-ok.csv', salesCsv(set('900001')))}`, fxArg('context.json'), `--out=${path.join(tmp, 'n4a-ok.md')}`)
    expect([ok.rc, cliJson(ok.out, 'n4a').missing, cliJson(ok.out, 'n4a').accepted]).toEqual([0, [], true])
    const bad = runCli('n4a', `--sales=${write('n4a-lead.csv', salesCsv(set('0900001')))}`, fxArg('context.json'), `--out=${path.join(tmp, 'n4a-lead.md')}`)
    expect(bad.rc).toBe(1)
    expect(cliJson(bad.out, 'n4a')).toMatchObject({ accepted: false, missing: [], invalidRows: 1, readiness: { status: 'not_ready', held: [], contract: ['NON_CANONICAL_PRODUCT_ID'] } })
    expect(fs.readFileSync(path.join(tmp, 'n4a-lead.md'), 'utf8')).toContain('| "0900001" |')
  })
})
