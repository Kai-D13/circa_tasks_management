import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { BigQueryError, bqQueryAll, buildQueryParameters, type BqTransport } from '../lib/bigquery/query'
import { cmsNumberToDecimalString, parseCmsDecimal } from '../lib/cms/decimal'
import { cmsBqProductsTable, cmsBqSalesTable } from '../lib/cms/config'
import { cmsSafeImageUrl } from '../lib/cms/image'
import { canonicalProductId } from '../lib/cms/productId'
import {
  formatUtcMicros, isWithinWindow, parseUtcMicros, vnDateOfMicros, vnProgramWindowMicros,
} from '../lib/cms/time'
import {
  CMS_SALES_COLUMNS, isEligibleOrder, normalizeCmsEmail, normalizeProductRow, normalizeSalesRow,
} from '../lib/cms/source/contract'
import { buildSellerIndex, mapSeller, maskCmsEmail, type CmsStoreRef, type CmsUserRef } from '../lib/cms/mapping'
import { assessSalesSnapshot, CMS_SALES_ROW_CAP, findDuplicates, type CmsSnapshotFacts } from '../lib/cms/quality'
import {
  buildCmsProductsQuery, buildCmsSalesQuery, CMS_PRODUCTS_ROW_CAP, fetchCmsProducts, fetchCmsSalesSnapshot, type CmsBqRunner,
} from '../lib/cms/source/bigquery'
import { createCmsFixtureRunner } from './cmsFixtureRunner'
import { FX_PRODUCTS, FX_SALES, fxSale } from './cmsSourceFixture'

// CMS P0-a — hợp đồng nguồn, adapter, mapping, chất lượng. THUẦN: không DB,
// không mạng, không BigQuery thật (runner fixture + transport giả). Map:
// docs/cms/SPEC.md §1 (nguồn), §1.3 (chuẩn hóa), §6 (chất lượng); plan §2.1 (mapping), §2.5 (cửa sổ kỳ).

const TABLE = 'lakehouse-prod-394907.buymed_tech.fake_cms_sales_view'
const WIN = vnProgramWindowMicros('2026-11-05', '2026-11-06')

test.describe('CMS P0-a · thời gian micro giây + ngày VN @desktop', () => {
  test('đọc ISO Z và dạng export BigQuery "… UTC", giữ đủ micro giây', () => {
    const a = parseUtcMicros('2026-11-01T04:01:32.701749Z')
    const b = parseUtcMicros('2026-11-01 04:01:32.701749 UTC')
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(formatUtcMicros(a!)).toBe('2026-11-01T04:01:32.701749Z')
    // Hai thời điểm chỉ khác 1 micro giây vẫn phân biệt được (Date sẽ mất).
    expect(parseUtcMicros('2026-11-01T04:01:32.701750Z')! - a!).toBe(BigInt(1))
    expect(parseUtcMicros('2026-11-01T04:01:32Z')).toBe(a! - BigInt(701749))
  })

  test('từ chối định dạng / ngày giờ không tồn tại', () => {
    for (const bad of ['2026-02-30T00:00:00Z', '2026-11-01T24:00:00Z', '2026-11-01T04:01:32.1234567Z',
      '2026-11-01T04:01:32+07:00', '2026-11-01', '', '1.761969692701749E9']) {
      expect(parseUtcMicros(bad), bad).toBeNull()
    }
  })

  test('cửa sổ kỳ [00:00 VN ngày đầu, 00:00 VN ngày sau ngày cuối)', () => {
    expect(formatUtcMicros(WIN.fromMicros)).toBe('2026-11-04T17:00:00.000000Z')
    expect(formatUtcMicros(WIN.toMicrosExclusive)).toBe('2026-11-06T17:00:00.000000Z')
    const at = (s: string) => parseUtcMicros(s)!
    expect(isWithinWindow(at('2026-11-04T16:59:59.999999Z'), WIN)).toBe(false)
    expect(isWithinWindow(at('2026-11-04T17:00:00Z'), WIN)).toBe(true)
    expect(isWithinWindow(at('2026-11-06T16:59:59.999999Z'), WIN)).toBe(true)
    expect(isWithinWindow(at('2026-11-06T17:00:00Z'), WIN)).toBe(false)
    expect(vnDateOfMicros(at('2026-11-04T16:59:59.999999Z'))).toBe('2026-11-04')
    expect(vnDateOfMicros(at('2026-11-04T17:00:00Z'))).toBe('2026-11-05')
    expect(() => vnProgramWindowMicros('2026-11-06', '2026-11-05')).toThrow(RangeError)
    expect(() => vnProgramWindowMicros('2026-02-30', '2026-03-01')).toThrow(RangeError)
    // Một ngày (start = end) hợp lệ, dài đúng 24 giờ.
    const one = vnProgramWindowMicros('2026-11-05', '2026-11-05')
    expect(one.toMicrosExclusive - one.fromMicros).toBe(BigInt(86400000000))
  })
})

test.describe('CMS P0-a · ô numeric ⇒ decimal bằng chữ số (SPEC §4.2) @desktop', () => {
  test('mở rộng số mũ của JS rồi mới kiểm precision', () => {
    expect(cmsNumberToDecimalString(1e-9)).toBe('0.000000001')
    expect(parseCmsDecimal(cmsNumberToDecimalString(1e-9)!)).toEqual({ ok: true, units: BigInt(1) })
    expect(cmsNumberToDecimalString(1.5e-10)).toBe('0.00000000015')
    expect(parseCmsDecimal(cmsNumberToDecimalString(1.5e-10)!)).toEqual({ ok: false, error: 'SCALE' })
    expect(cmsNumberToDecimalString(1e21)).toBe('1000000000000000000000')
    expect(cmsNumberToDecimalString(1.2345e21)).toBe('1234500000000000000000')
    expect(cmsNumberToDecimalString(24)).toBe('24')
    expect(cmsNumberToDecimalString(2.5)).toBe('2.5')
    expect(cmsNumberToDecimalString(0.1)).toBe('0.1')
    expect(cmsNumberToDecimalString(-3e-7)).toBe('-0.0000003')
    expect(cmsNumberToDecimalString(Number.NaN)).toBeNull()
    expect(cmsNumberToDecimalString(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

test.describe('CMS P0-a · hợp đồng dòng đơn + Product Master @desktop', () => {
  test('dòng hợp lệ: chuẩn hóa ProductID, số scale 9, email, micro giây', () => {
    const r = normalizeSalesRow(fxSale({
      product_id: ' 0900001 ', seller_email: '  DS.A@CMS.Example.Test ', base_quantity: '12', gmv_amount: '19000.5',
      completed_at: '2026-11-05 03:00:00.123456 UTC',
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.productId).toBe('900001')
    expect(r.value.sellerEmail).toBe('ds.a@cms.example.test')
    expect(r.value.baseQuantityUnits).toBe(BigInt(12000000000))
    expect(r.value.gmvUnits).toBe(BigInt(19000500000000))
    expect(formatUtcMicros(r.value.completedAtMicros)).toBe('2026-11-05T03:00:00.123456Z')
    expect(isEligibleOrder(r.value)).toBe(true)
    expect(isEligibleOrder({ orderType: 'ONLINE', orderStatus: 'COMPLETED' })).toBe(false)
    expect(isEligibleOrder({ orderType: 'OFFLINE', orderStatus: 'CANCELLED' })).toBe(false)
  })

  test('thiếu trường bắt buộc ⇒ từ chối, KHÔNG tự điền OFFLINE / 0', () => {
    for (const f of ['order_type', 'order_status', 'completed_at', 'base_quantity', 'gmv_amount', 'source_updated_at', 'product_id', 'order_line_id']) {
      const r = normalizeSalesRow(fxSale({ [f]: null }))
      expect(r.ok, f).toBe(false)
      if (!r.ok) expect(r.issues).toContainEqual({ kind: 'MISSING_FIELD', field: f })
    }
    // seller_email trống KHÔNG làm hỏng dòng — dòng vào nhóm "Chưa gán" ở bước mapping.
    const noEmail = normalizeSalesRow(fxSale({ seller_email: '  ' }))
    expect(noEmail.ok && noEmail.value.sellerEmail).toBeNull()
  })

  test('sai kiểu ⇒ lỗi dòng có tên trường', () => {
    const r = normalizeSalesRow(fxSale({ product_id: 'SKU001', base_quantity: '1.0000000001', gmv_amount: '1e5', completed_at: '2026-13-01T00:00:00Z' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues).toEqual(expect.arrayContaining([
      { kind: 'BAD_PRODUCT_ID', field: 'product_id' },
      { kind: 'BAD_NUMBER', field: 'base_quantity', error: 'SCALE' },
      { kind: 'BAD_NUMBER', field: 'gmv_amount', error: 'FORMAT' },
      { kind: 'BAD_TIMESTAMP', field: 'completed_at' },
    ]))
  })

  test('số âm được đọc nguyên trạng (không clamp) — quy thuộc trả hàng HOLD Q-206', () => {
    const r = normalizeSalesRow(fxSale({ base_quantity: '-6', gmv_amount: '-45000' }))
    expect(r.ok && r.value.baseQuantityUnits).toBe(-BigInt(6000000000))
    expect(r.ok && r.value.gmvUnits).toBe(-BigInt(45000000000000))
  })

  test('Product Master: is_active bắt buộc true/false, giá tùy chọn', () => {
    const ok = FX_PRODUCTS.map(normalizeProductRow)
    expect(ok.every((r) => r.ok)).toBe(true)
    expect(ok[1].ok && ok[1].value.isActive).toBe(false)
    // URL ảnh ngoài allow-list ⇒ null + cờ cảnh báo, KHÔNG loại dòng.
    expect(ok[0].ok && ok[0].value.imageUrl).toBeNull()
    expect(ok[0].ok && ok[0].value.imageRejected).toBe(true)
    expect(ok[1].ok && ok[1].value.imageRejected).toBe(false)
    expect(ok[1].ok && ok[1].value.referencePriceUnits).toBeNull()
    expect(ok[2].ok && ok[2].value.referencePriceUnits).toBe(BigInt(9500000000))
    const bad = normalizeProductRow({ ...FX_PRODUCTS[0], is_active: 'yes', product_name: 'x', reference_price: '1,5' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues.map((i) => i.kind)).toEqual(['BAD_BOOLEAN', 'BAD_NUMBER'])
    // Trần giá khớp CHECK DB (< 1e15): vượt ⇒ lỗi dòng RANGE (held ở lõi đồng bộ, không vỡ RPC giữa lượt).
    const big = normalizeProductRow({ ...FX_PRODUCTS[1], reference_price: '1000000000000000' })
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.issues).toEqual([{ kind: 'BAD_NUMBER', field: 'reference_price', error: 'RANGE' }])
    expect(normalizeProductRow({ ...FX_PRODUCTS[1], reference_price: '999999999999999.999999999' }).ok).toBe(true)
    const missing = normalizeProductRow({ ...FX_PRODUCTS[0], product_name: '' })
    expect(missing.ok).toBe(false)
  })
})

test.describe('CMS P0-a · allow-list ảnh + trần text + ProductID dài @desktop', () => {
  test('ảnh: chỉ https cdn-gcs.thuocsi.vn/thuocsi-live/images/', () => {
    const okUrl = 'https://cdn-gcs.thuocsi.vn/thuocsi-live/images/abc.jpg'
    expect(cmsSafeImageUrl(' ' + okUrl + ' ')).toBe(okUrl)
    const bads: (string | null)[] = [
      'http://cdn-gcs.thuocsi.vn/thuocsi-live/images/a.jpg', 'https://evil.example/thuocsi-live/images/a.jpg',
      'https://cdn-gcs.thuocsi.vn.evil.example/thuocsi-live/images/a.jpg', 'https://cdn-gcs.thuocsi.vn/other/a.jpg',
      'https://cdn-gcs.thuocsi.vn:8443/thuocsi-live/images/a.jpg', 'https://u:p@cdn-gcs.thuocsi.vn/thuocsi-live/images/a.jpg',
      'javascript:alert(1)', 'data:image/png;base64,AAAA', '//cdn-gcs.thuocsi.vn/thuocsi-live/images/a.jpg',
      'https://cdn-gcs.thuocsi.vn/thuocsi-live/images/' + 'a'.repeat(2000) + '.jpg', '', null,
    ]
    for (const bad of bads) expect(cmsSafeImageUrl(bad), String(bad).slice(0, 60)).toBeNull()
  })

  test('text: ký tự điều khiển thành khoảng trắng; quá trần ⇒ BAD_TEXT (không cắt)', () => {
    const ctl = 'h' + String.fromCharCode(0) + 'ộp' + String.fromCharCode(7)
    const r = normalizeSalesRow(fxSale({ uom_raw: ctl, order_code: 'X'.repeat(101) }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues).toEqual([{ kind: 'BAD_TEXT', field: 'order_code' }])
    const good = normalizeSalesRow(fxSale({ uom_raw: ctl }))
    expect(good.ok && good.value.uomRaw).toBe('h ộp')
    const p = normalizeProductRow({ ...FX_PRODUCTS[1], product_name: 'x'.repeat(501) })
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.issues).toEqual([{ kind: 'BAD_TEXT', field: 'product_name' }])
  })

  test('ProductID: chặn độ dài trước BigInt; số 0 đầu được chuẩn hóa', () => {
    expect(canonicalProductId('9'.repeat(5000))).toEqual({ ok: false, error: 'OUT_OF_RANGE' })
    expect(canonicalProductId('0'.repeat(30) + '12345')).toEqual({ ok: true, id: '12345' })
  })

  test('fixture runner chỉ ở e2e/: không file nào trong app / lib / components import nó', () => {
    const root = path.resolve(__dirname, '..')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p) }
        // Chỉ bắt lệnh import / require thật (comment nhắc tên file không tính).
        else if (/[.](ts|tsx|js|mjs)$/.test(ent.name)
          && /(from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*(cmsFixtureRunner|source[/]fixture)['"]/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p))
      }
    }
    for (const d of ['app', 'lib', 'components']) walk(path.join(root, d))
    expect(hits).toEqual([])
    expect(fs.existsSync(path.join(root, 'lib', 'cms', 'source', 'fixture.ts'))).toBe(false)
  })
})

test.describe('CMS P0-a · mapping email → staff (Q-207) @desktop', () => {
  const stores: CmsStoreRef[] = [
    { id: 'S-OS', storeType: 'os', isActive: true },
    { id: 'S-OFF', storeType: 'os', isActive: false },
    { id: 'S-FS', storeType: 'fs', isActive: true },
  ]
  const users: CmsUserRef[] = [
    { id: 'U-A', email: 'DS.A@cms.example.test', role: 'staff', storeId: 'S-OS' },
    { id: 'U-DUP1', email: 'dup@cms.example.test', role: 'staff', storeId: 'S-OS' },
    { id: 'U-DUP2', email: ' Dup@cms.example.test ', role: 'staff', storeId: 'S-OS' },
    { id: 'U-QLCH', email: 'qlch@cms.example.test', role: 'store_manager', storeId: 'S-OS' },
    { id: 'U-ADM', email: 'admin@cms.example.test', role: 'admin', storeId: null },
    { id: 'U-SM', email: 'sm@cms.example.test', role: 'sm', storeId: null },
    { id: 'U-FS', email: 'fs@cms.example.test', role: 'staff', storeId: 'S-FS' },
    { id: 'U-OFF', email: 'off@cms.example.test', role: 'staff', storeId: 'S-OFF' },
    { id: 'U-NOSTORE', email: 'nostore@cms.example.test', role: 'staff', storeId: null },
    { id: 'U-NULL', email: null, role: 'staff', storeId: 'S-OS' },
  ]
  const idx = buildSellerIndex(users, stores)

  test('khớp đúng một staff OS active, không phân biệt hoa thường / khoảng trắng', () => {
    expect(mapSeller('  ds.a@CMS.example.test ', idx)).toEqual({ ok: true, userId: 'U-A', storeId: 'S-OS' })
  })

  test('đủ lý do "Chưa gán dược sĩ"', () => {
    const reason = (e: string | null) => {
      const m = mapSeller(e, idx)
      return m.ok ? 'OK' : m.reason
    }
    expect(reason(null)).toBe('NO_EMAIL')
    expect(reason('   ')).toBe('NO_EMAIL')
    expect(reason('nobody@cms.example.test')).toBe('NOT_FOUND')
    expect(reason('dup@cms.example.test')).toBe('MULTIPLE')
    expect(reason('qlch@cms.example.test')).toBe('SHARED_ACCOUNT')
    expect(reason('admin@cms.example.test')).toBe('NOT_STAFF')
    expect(reason('sm@cms.example.test')).toBe('NOT_STAFF')
    expect(reason('fs@cms.example.test')).toBe('STORE_NOT_ELIGIBLE')
    expect(reason('off@cms.example.test')).toBe('STORE_NOT_ELIGIBLE')
    expect(reason('nostore@cms.example.test')).toBe('STORE_NOT_ELIGIBLE')
  })

  test('không fallback seller_code / số điện thoại; email che khi log', () => {
    // API không nhận seller_code/phone — chỉ email. Email trùng số điện thoại cũng không khớp.
    expect(mapSeller('0901234567', idx)).toEqual({ ok: false, reason: 'NOT_FOUND' })
    expect(maskCmsEmail('DS.A@cms.example.test')).toBe('***@cms.example.test')
    expect(maskCmsEmail('ab@x.test')).toBe('***@x.test')
    expect(maskCmsEmail('khong-co-at')).toBe('***')
    expect(maskCmsEmail(null)).toBe('—')
    expect(normalizeCmsEmail(' X@Y.Z ')).toBe('x@y.z')
  })
})

test.describe('CMS P0-a · chất lượng snapshot (SPEC §6) @desktop', () => {
  const base: CmsSnapshotFacts = {
    rowsRead: 100, totalRowsReported: 100, pagesComplete: true, rowIssues: [], lineIds: ['a', 'b'],
    candidates: 100, unassigned: 0, previousPublishedRows: 50,
  }
  const reasons = (o: Partial<CmsSnapshotFacts>) => assessSalesSnapshot({ ...base, ...o }).reasons

  test('snapshot sạch ⇒ ok', () => {
    expect(assessSalesSnapshot(base)).toEqual({ status: 'ok', reasons: [], duplicateLineIds: [], unassignedRatio: 0 })
  })

  test('đủ 7 lý do held', () => {
    expect(reasons({ pagesComplete: false })).toEqual(['INCOMPLETE_PAGES'])
    expect(reasons({ totalRowsReported: 101 })).toEqual(['INCOMPLETE_PAGES'])
    expect(reasons({ rowsRead: CMS_SALES_ROW_CAP + 1, totalRowsReported: CMS_SALES_ROW_CAP + 1, candidates: 0 })).toEqual(['OVER_CAP'])
    expect(reasons({ lineIds: ['a', 'b', 'a'] })).toEqual(['DUPLICATE_LINE_ID'])
    expect(reasons({ rowIssues: [[{ kind: 'BAD_TIMESTAMP', field: 'completed_at' }]] })).toEqual(['ROW_ISSUES'])
    expect(reasons({ rowIssues: [[{ kind: 'MISSING_FIELD', field: 'base_quantity' }]] })).toEqual(['UNCONVERTED_UNITS'])
    expect(reasons({ rowsRead: 0, totalRowsReported: 0, candidates: 0, lineIds: [] })).toEqual(['EMPTY_AFTER_DATA'])
    expect(reasons({ unassigned: 21 })).toEqual(['UNASSIGNED_OVER_THRESHOLD'])
  })

  test('ngưỡng chưa gán: đúng 20% vẫn ok, > 20% held; rỗng lần đầu không held', () => {
    expect(reasons({ unassigned: 20 })).toEqual([])
    expect(assessSalesSnapshot({ ...base, unassigned: 20 }).unassignedRatio).toBe(0.2)
    expect(reasons({ rowsRead: 0, totalRowsReported: 0, candidates: 0, lineIds: [], previousPublishedRows: null })).toEqual([])
    expect(findDuplicates(['x', 'y', 'x', 'z', 'y'])).toEqual(['x', 'y'])
  })
})

test.describe('CMS P0-a · cấu hình nguồn + SQL builder @desktop', () => {
  test('env: trống ⇒ null (không query); sai định dạng ⇒ throw', () => {
    expect(cmsBqProductsTable({})).toBeNull()
    expect(cmsBqSalesTable({ CMS_BQ_SALES_TABLE: '  ' })).toBeNull()
    expect(cmsBqProductsTable({ CMS_BQ_PRODUCTS_TABLE: ' lakehouse-prod-394907.buymed_tech.v_cms_products ' })).toBe('lakehouse-prod-394907.buymed_tech.v_cms_products')
    for (const bad of ['buymed_tech.v', '`p.d.t`', 'lakehouse-prod-394907.buymed_tech.t; DROP', 'p.d.t$20260101', 'lakehouse-prod-394907.d.t x']) {
      expect(() => cmsBqSalesTable({ CMS_BQ_SALES_TABLE: bad }), bad).toThrow()
    }
  })

  test('SQL chỉ nội suy tên view đã validate; giá trị đi bằng tham số NAMED', () => {
    const q = buildCmsSalesQuery({ table: TABLE, ...WIN, productIds: ['900002', '900001', '900001'] })
    expect(q.sql).toContain(`FROM \`${TABLE}\``)
    for (const p of ['@from_ts', '@to_ts', '@product_ids', '@row_limit']) expect(q.sql).toContain(p)
    expect(q.sql).not.toContain('2026-11')
    expect(q.sql).not.toContain('900001')
    expect(q.sql).not.toMatch(/order_type\s*=|order_status\s*=/)
    expect(q.sql).toContain("FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', completed_at, 'UTC')")
    for (const c of CMS_SALES_COLUMNS) expect(q.sql).toContain(` AS ${c}`)
    const ids = q.params.find((p) => p.name === 'product_ids')
    expect(ids && 'values' in ids ? ids.values : null).toEqual(['900001', '900002'])
    expect(q.params.find((p) => p.name === 'row_limit')).toEqual({ name: 'row_limit', type: 'INT64', value: CMS_SALES_ROW_CAP + 1 })
    expect(() => buildQueryParameters(q.params)).not.toThrow()
    expect(() => buildCmsSalesQuery({ table: 'x', ...WIN, productIds: ['1'] })).toThrow(BigQueryError)
    expect(() => buildCmsSalesQuery({ table: TABLE, ...WIN, productIds: [] })).toThrow(BigQueryError)
    const pq = buildCmsProductsQuery(TABLE)
    expect(pq.sql).toContain('FROM `' + TABLE + '`')
    expect(pq.sql).toContain('LIMIT @row_limit')
    expect(pq.params).toEqual([{ name: 'row_limit', type: 'INT64', value: CMS_PRODUCTS_ROW_CAP + 1 }])
    // Lỗi cấu hình không mang tên view (hạ tầng nội bộ).
    try { buildCmsSalesQuery({ table: 'p.d.t x', ...WIN, productIds: ['1'] }) } catch (e) { expect(String((e as Error).message)).not.toContain('p.d.t') }
  })
})

test.describe('CMS P0-a · adapter end-to-end với runner fixture (dữ liệu giả) @desktop', () => {
  test('Product Master: đọc đủ, dòng lỗi tách riêng theo chỉ số', async () => {
    const run = createCmsFixtureRunner({ products: [...FX_PRODUCTS, { ...FX_PRODUCTS[0], product_id: 'SKU9' }] })
    const r = await fetchCmsProducts(run, TABLE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.map((x) => x.productId)).toEqual(['900001', '900002', '900003'])
    expect(r.rowIssues).toEqual([{ index: 3, issues: [{ kind: 'BAD_PRODUCT_ID', field: 'product_id' }] }])
  })

  test('dòng đơn: lọc đúng biên kỳ + ProductID; thiếu trường bị tách, không tự điền', async () => {
    const run = createCmsFixtureRunner({ sales: FX_SALES })
    const r = await fetchCmsSalesSnapshot(run, { table: TABLE, ...WIN, productIds: ['900001', '900002'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // L-01/L-04 ngoài biên, L-05 ngoài ProductID; L-07 thiếu order_type + L-08 sai quy cách ⇒ rowIssues.
    expect(r.lines.map((l) => l.orderLineId)).toEqual(['L-02', 'L-03', 'L-06'])
    expect(r.rowIssues.map((x) => x.issues[0])).toEqual([
      { kind: 'MISSING_FIELD', field: 'order_type' },
      { kind: 'BAD_NUMBER', field: 'base_quantity', error: 'SCALE' },
    ])
    expect(r.lines.filter(isEligibleOrder).map((l) => l.orderLineId)).toEqual(['L-02', 'L-03'])
    const verdict = assessSalesSnapshot({
      rowsRead: r.rowsRead, totalRowsReported: r.totalRowsReported, pagesComplete: true,
      rowIssues: r.rowIssues.map((x) => x.issues), lineIds: r.lines.map((l) => l.orderLineId),
      candidates: 2, unassigned: 0, previousPublishedRows: null,
    })
    expect(verdict.status).toBe('held')
    expect(verdict.reasons).toEqual(['UNCONVERTED_UNITS', 'ROW_ISSUES'])
  })

  test('fail-closed: vượt trần / thiếu cột / thiếu trang / lỗi nguồn', async () => {
    const many = Array.from({ length: 6 }, (_, i) => fxSale({ order_line_id: `L-C${i}` }))
    const over = await fetchCmsSalesSnapshot(createCmsFixtureRunner({ sales: many }), { table: TABLE, ...WIN, productIds: ['900001'], cap: 5 })
    expect(over).toEqual({ ok: false, reason: 'OVER_CAP', cap: 5 })
    const exact = await fetchCmsSalesSnapshot(createCmsFixtureRunner({ sales: many.slice(0, 5) }), { table: TABLE, ...WIN, productIds: ['900001'], cap: 5 })
    expect(exact.ok).toBe(true)
    const schema = await fetchCmsSalesSnapshot(createCmsFixtureRunner({ sales: many, dropFields: ['order_type'] }), { table: TABLE, ...WIN, productIds: ['900001'] })
    expect(schema).toEqual({ ok: false, reason: 'SCHEMA_MISMATCH', missing: ['order_type'] })
    const pages = await fetchCmsProducts(createCmsFixtureRunner({ products: FX_PRODUCTS, totalRowsDelta: 2 }), TABLE)
    expect(pages.ok === false && pages.reason).toBe('INCOMPLETE_PAGES')
    const err = await fetchCmsProducts(createCmsFixtureRunner({ fail: new BigQueryError('http', '403 Access Denied', 403) }), TABLE)
    expect(err).toEqual({ ok: false, reason: 'SOURCE_ERROR', kind: 'http', status: 403 })
    // Message thô của BigQuery (có thể chứa giá trị dòng nguồn / email) KHÔNG lọt ra kết quả.
    const leak = await fetchCmsSalesSnapshot(createCmsFixtureRunner({ fail: new BigQueryError('http', "BigQuery HTTP 400: Bad cast 'ds.a@cms.example.test' TEST-0001", 400) }), { table: TABLE, ...WIN, productIds: ['900001'] })
    expect(JSON.stringify(leak)).not.toMatch(/@|TEST-0001|Bad cast/)
    expect(leak).toEqual({ ok: false, reason: 'SOURCE_ERROR', kind: 'http', status: 400 })
    const unk = await fetchCmsProducts(createCmsFixtureRunner({ fail: new Error('fetch https://bigquery.googleapis.com/x?token=abc failed') }), TABLE)
    expect(unk).toEqual({ ok: false, reason: 'SOURCE_ERROR', kind: 'unknown', status: null })
    const cfg = await fetchCmsProducts(createCmsFixtureRunner({ products: FX_PRODUCTS }), 'không hợp lệ')
    expect(cfg).toEqual({ ok: false, reason: 'CONFIG' })
    const lim = await fetchCmsProducts(createCmsFixtureRunner({ products: FX_PRODUCTS }), TABLE, { cap: 2 })
    expect(lim.ok === false && lim.reason).toBe('OVER_CAP')
  })

  test('fixture runner bị cấm ở production (không fallback JSON)', () => {
    const prev = process.env.NODE_ENV
    try {
      ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
      expect(() => createCmsFixtureRunner({ products: FX_PRODUCTS })).toThrow(/production/)
    } finally {
      ;(process.env as Record<string, string | undefined>).NODE_ENV = prev
    }
  })
})

test.describe('CMS P0-a · adapter qua bqQueryAll thật với transport giả (nhiều trang, job chưa xong) @desktop', () => {
  test('đọc đủ 2 trang sau 1 lần poll, ánh xạ cột theo schema', async () => {
    const fields = CMS_SALES_COLUMNS.map((name) => ({ name }))
    const toRow = (r: Record<string, string | null | undefined>) => ({ f: CMS_SALES_COLUMNS.map((c) => ({ v: r[c] ?? null })) })
    const JOB = { projectId: 'p', jobId: 'job_cms', location: 'asia-southeast1' }
    const steps = [
      { jobReference: JOB, jobComplete: false },
      { jobReference: JOB, jobComplete: true, schema: { fields }, totalRows: '3', rows: [toRow(fxSale({ order_line_id: 'P1' })), toRow(fxSale({ order_line_id: 'P2' }))], pageToken: 't2', totalBytesProcessed: '2048' },
      { jobReference: JOB, jobComplete: true, schema: { fields }, totalRows: '3', rows: [toRow(fxSale({ order_line_id: 'P3' }))] },
    ]
    const calls: string[] = []
    const transport: BqTransport = {
      fetch: (async (url: string | URL | Request) => {
        calls.push(String(url))
        const body = steps.shift()
        if (!body) throw new Error('hết bước')
        return new Response(JSON.stringify(body), { status: 200 })
      }) as typeof fetch,
      getToken: async () => 'tok', now: () => 0, sleep: async () => {},
    }
    const run: CmsBqRunner = (sql, params, opts) => bqQueryAll(transport, { projectId: 'p', sql, params, maxRows: opts.maxRows })
    const r = await fetchCmsSalesSnapshot(run, { table: TABLE, ...WIN, productIds: ['900001'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines.map((l) => l.orderLineId)).toEqual(['P1', 'P2', 'P3'])
    expect(r.totalRowsReported).toBe(3)
    expect(calls.some((u) => u.includes('pageToken=t2'))).toBe(true)
  })
})
