import { test, expect } from '@playwright/test'
import {
  buildCmsProductsQuery, buildCmsSalesQuery, CMS_PRODUCT_DERIVED_COLUMN, CMS_PRODUCT_SOURCE_COLUMNS, CMS_SALES_SOURCE_COLUMN, cmsSalesSourceColumn,
  fetchCmsProducts, fetchCmsSalesSnapshot,
} from '../lib/cms/source/bigquery'
import { CMS_PRODUCT_COLUMNS, CMS_SALES_COLUMNS, normalizeProductRow, type CmsRawRow } from '../lib/cms/source/contract'
import { computeCmsProgram, CmsEngineInputError } from '../lib/cms/engine/compute'
import { buildSellerIndex } from '../lib/cms/mapping'
import { assessSalesSnapshot } from '../lib/cms/quality'
import { runCmsProductSync, type CmsProductSyncDeps, type CmsProductUpsertRow } from '../lib/cms/productSync'
import { vnProgramWindowMicros } from '../lib/cms/time'
import { cmsI4ExportSql } from './cmsI4Offline'
import { CMS_FX_VIEW_PRODUCT_COLUMNS, CMS_FX_VIEW_SALES_COLUMNS, createCmsViewRunner } from './cmsFixtureRunner'

// CMS — work order tích hợp nguồn BI (PM 04/11 §4 B1–B4). Hợp đồng VẬT LÝ hai view BI:
//   lakehouse-prod-394907.buymed_tech.tech__dim_circa_growth_cms_order (BI giữ `employee_email` — app đọc AS seller_email)
//   lakehouse-prod-394907.buymed_tech.tech__dim_circa_growth_cms_product_master (6 cột vật lý — KHÔNG có is_active: operator bỏ trạng thái SP
//   04/11, adapter tạo hằng `CAST(TRUE AS STRING) AS is_active` — PM `2026-11-04-cms-bi-product-master-pm.md` §2)
// THUẦN: runner giả lập VIEW theo schema vật lý (giải nghĩa danh sách SELECT như BigQuery: cột không có ⇒ lỗi "Unrecognized name"),
// không mạng, không BigQuery thật — tên view giả không phải cơ chế chặn gọi mạng; runner tiêm vào mới là.

const SALES = 'lakehouse-prod-394907.buymed_tech.tech__dim_circa_growth_cms_order'
const PRODUCTS = 'lakehouse-prod-394907.buymed_tech.tech__dim_circa_growth_cms_product_master'
const WIN = vnProgramWindowMicros('2026-10-01', '2026-10-31')

const viewRunner = createCmsViewRunner
const VIEW_SALES_COLS: string[] = [...CMS_FX_VIEW_SALES_COLUMNS]
const VIEW_PRODUCT_COLS: string[] = [...CMS_FX_VIEW_PRODUCT_COLUMNS]
const sale = (o: Partial<CmsRawRow> = {}): CmsRawRow => ({
  order_line_id: '9007199254740993123', order_id: '700001', order_code: 'HDMAU001', product_id: '900001', employee_email: ' DS.A@Example.Test ',
  pos_code: 'POS01', order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: '2026-10-05T03:00:00.123456Z', quantity_raw: '2',
  uom_raw: 'hộp', base_quantity: '60', gmv_amount: '360000', source_updated_at: '2026-10-05T03:00:01.000000Z', ...o,
})

test.describe('CMS nguồn BI — projection employee_email ⇒ seller_email (B1) @desktop', () => {
  test('SELECT đọc cột vật lý employee_email AS seller_email; không SELECT cột seller_email không tồn tại; mọi cột khác giữ nguyên', () => {
    expect(CMS_SALES_SOURCE_COLUMN).toEqual({ seller_email: 'employee_email' })
    expect(cmsSalesSourceColumn('seller_email')).toBe('employee_email')
    expect(cmsSalesSourceColumn('order_line_id')).toBe('order_line_id')
    const q = buildCmsSalesQuery({ table: SALES, ...WIN, productIds: ['900001'] })
    const select = q.sql.split('\n')[0]
    expect(select).toContain('CAST(employee_email AS STRING) AS seller_email')
    expect(select).not.toContain('CAST(seller_email AS STRING)')
    expect(q.sql).not.toMatch(/(?<!AS )\bseller_email\b/)
    for (const c of CMS_SALES_COLUMNS) expect(select).toContain(` AS ${c}`)
    expect(select).toContain('CAST(order_line_id AS STRING) AS order_line_id')
    expect(q.sql.split('\n').slice(1)).toEqual([`FROM \`${SALES}\``, 'WHERE completed_at >= @from_ts AND completed_at < @to_ts', '  AND CAST(product_id AS STRING) IN UNNEST(@product_ids)', 'LIMIT @row_limit'])
    // Product Master: 6 cột vật lý + is_active là HẰNG (không đọc cột is_active trên view, không dò / fallback hai schema).
    expect(CMS_PRODUCT_DERIVED_COLUMN).toEqual({ is_active: 'CAST(TRUE AS STRING)' })
    expect([...CMS_PRODUCT_SOURCE_COLUMNS]).toEqual(['product_id', 'product_name', 'image_url', 'source_updated_at', 'reference_price', 'price_unit'])
    expect([...CMS_PRODUCT_SOURCE_COLUMNS]).toEqual(VIEW_PRODUCT_COLS)
    const pm = buildCmsProductsQuery(PRODUCTS).sql.split('\n')
    expect(pm[0]).toBe(`SELECT ${CMS_PRODUCT_COLUMNS.map((c) => (c === 'is_active' ? 'CAST(TRUE AS STRING) AS is_active'
      : c === 'source_updated_at' ? `FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', ${c}, 'UTC') AS ${c}` : `CAST(${c} AS STRING) AS ${c}`)).join(', ')}`)
    expect(pm[0]).not.toContain('CAST(is_active AS STRING)')
    expect(pm.slice(1)).toEqual([`FROM \`${PRODUCTS}\``, 'LIMIT @row_limit'])
  })

  test('view đúng schema vật lý ⇒ dòng ra mang tên chuẩn seller_email (trim + chữ thường); ID 19 chữ số / ProductID INT64 giữ chính xác dạng chuỗi', async () => {
    const r = await fetchCmsSalesSnapshot(viewRunner([sale(), sale({ order_line_id: '2', product_id: 900002 as unknown as string })], VIEW_SALES_COLS), { table: SALES, ...WIN, productIds: ['900001', '900002'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rowIssues).toEqual([])
    expect(r.lines.map((l) => [l.orderLineId, l.productId, l.sellerEmail])).toEqual([['9007199254740993123', '900001', 'ds.a@example.test'], ['2', '900002', 'ds.a@example.test']])
    expect(r.lines[0].completedAtMicros % BigInt(1_000_000)).toBe(BigInt(123456))
  })

  test('view THIẾU cột vật lý (employee_email / order_line_id / cột Product Master còn bắt buộc) ⇒ lỗi nguồn, giữ snapshot cũ; KHÔNG tự thử seller_email; message thô không lọt ra', async () => {
    const noEmail = VIEW_SALES_COLS.filter((c) => c !== 'employee_email').concat('seller_email')
    const calls: string[] = []
    const a = await fetchCmsSalesSnapshot(viewRunner([sale({ seller_email: 'ds.a@example.test' })], noEmail, calls), { table: SALES, ...WIN, productIds: ['900001'] })
    expect(a).toEqual({ ok: false, reason: 'SOURCE_ERROR', kind: 'http', status: 400 })
    expect(calls).toHaveLength(1) // một truy vấn, không thử lại bằng tên khác
    const noLine = await fetchCmsSalesSnapshot(viewRunner([sale()], VIEW_SALES_COLS.filter((c) => c !== 'order_line_id')), { table: SALES, ...WIN, productIds: ['900001'] })
    expect(noLine).toEqual({ ok: false, reason: 'SOURCE_ERROR', kind: 'http', status: 400 })
    expect(JSON.stringify([a, noLine])).not.toMatch(/Unrecognized|employee_email|order_line_id/)
    // Product Master thiếu MỘT trong 6 cột vật lý (kể cả cột nullable) ⇒ lỗi nguồn; hằng is_active KHÔNG tạo output giả để bỏ qua.
    const pmRow = { product_id: '900001', product_name: 'SP', image_url: null, source_updated_at: '2026-11-04T00:00:00.000000Z', reference_price: '1000', price_unit: 'Hộp' }
    for (const miss of CMS_PRODUCT_SOURCE_COLUMNS) {
      const pmCalls: string[] = []
      const pm = await fetchCmsProducts(viewRunner([pmRow], VIEW_PRODUCT_COLS.filter((c) => c !== miss), pmCalls), PRODUCTS)
      expect(pm, miss).toEqual({ ok: false, reason: 'SOURCE_ERROR', kind: 'http', status: 400 })
      expect(pmCalls, miss).toHaveLength(1)
    }
  })
})

test.describe('CMS nguồn BI — SQL xuất đối soát N4a / N4b / Product Master (B2) @desktop', () => {
  test('N4b lọc email trên CỘT VẬT LÝ employee_email (cùng trim + chữ thường), tham số giữ nguyên, không nhúng email; header file vẫn seller_email', () => {
    const b = cmsI4ExportSql('n4b', SALES)
    expect(b).toContain('  AND LOWER(TRIM(employee_email)) IN UNNEST(@seller_emails)')
    expect(b.split('\n')[0]).toBe(buildCmsSalesQuery({ table: SALES, ...WIN, productIds: ['1'] }).sql.split('\n')[0])
    expect(b).not.toMatch(/@[a-z0-9.-]+\.(?:vn|com|test)/i) // không có email nhúng
    expect(b).not.toMatch(/(?<!AS )\bseller_email\b/)
    // Chạy được trên view vật lý (không "Unrecognized name").
    const physicalWhere = b.split('\n').filter((l) => /UNNEST\(@seller_emails\)/.test(l))[0]
    expect(physicalWhere).toMatch(/LOWER\(TRIM\(employee_email\)\)/)
    const a = cmsI4ExportSql('n4a', SALES).split('\n')
    expect(a[0]).toContain('CAST(employee_email AS STRING) AS seller_email')
    expect(a.slice(2)).toEqual(['WHERE CAST(order_code AS STRING) IN UNNEST(@order_codes)', 'ORDER BY completed_at, order_line_id'])
  })
  test('SQL xuất Product Master: NGUYÊN dòng SELECT của app — đọc 6 cột vật lý, file chuẩn 7 cột (is_active hằng); chạy được trên view không có is_active', async () => {
    const p = cmsI4ExportSql('products', PRODUCTS).split('\n')
    expect(p).toEqual([buildCmsProductsQuery(PRODUCTS).sql.split('\n')[0], `FROM \`${PRODUCTS}\``, 'ORDER BY product_id'])
    expect(p[0]).toContain('CAST(TRUE AS STRING) AS is_active')
    for (const c of CMS_PRODUCT_COLUMNS) expect(p[0]).toContain(` AS ${c}`)
    // Runner giả schema vật lý 6 cột (không mạng) nhận câu SELECT này; dòng ra đủ 7 cột chuẩn theo đúng thứ tự header CSV.
    const out = await viewRunner([{ product_id: 900001 as unknown as string, product_name: 'SP', image_url: null, source_updated_at: '2026-11-04T00:00:00.000000Z', reference_price: null, price_unit: null }], VIEW_PRODUCT_COLS)(p.slice(0, 2).join('\n'), [], { maxRows: 10 })
    expect(out.fields).toEqual([...CMS_PRODUCT_COLUMNS])
    expect(out.rows).toEqual([{ product_id: '900001', product_name: 'SP', image_url: null, is_active: 'true', source_updated_at: '2026-11-04T00:00:00.000000Z', reference_price: null, price_unit: null }])
  })
})

test.describe('CMS nguồn BI — khoá dòng, Product Master (B4.5 / B4.6) @desktop', () => {
  const program = {
    startDate: '2026-10-01', endDate: '2026-10-31', catalogTargetGmv: null, storeIds: ['00000000-0000-4000-8000-000000008001'],
    products: [{ productId: '900001', gmvBasis: 'none' as const, targetGmv: null, baseQuantityCms: '30', tiers: [{ from: 1, to: null, amount: '1000' }] }],
  }
  const sellers = buildSellerIndex([{ id: '00000000-0000-4000-8000-000000007001', email: 'ds.a@example.test', role: 'staff', storeId: '00000000-0000-4000-8000-000000008001' }],
    [{ id: '00000000-0000-4000-8000-000000008001', storeType: 'os', isActive: true }])

  test('hai dòng CÙNG đơn + SP nhưng KHÁC order_line_id đều được tính (không DISTINCT đơn + SP); line ID trùng bị phát hiện', async () => {
    const r = await fetchCmsSalesSnapshot(viewRunner([sale({ order_line_id: 'L1' }), sale({ order_line_id: 'L2', completed_at: '2026-10-05T03:00:00.123457Z' })], VIEW_SALES_COLS), { table: SALES, ...WIN, productIds: ['900001'] })
    if (!r.ok) throw new Error(r.reason)
    expect(r.lines.map((l) => [l.orderId, l.productId, l.orderLineId])).toEqual([['700001', '900001', 'L1'], ['700001', '900001', 'L2']])
    const out = computeCmsProgram({ program, lines: r.lines, sellers })
    expect(out.results[0].baseQuantityUnits).toBe(BigInt(120) * BigInt(1_000_000_000)) // 60 + 60 đơn vị cơ sở
    expect(out.results[0].cmsQuantity).toBe(BigInt(4))
    expect(out.results[0].amountVnd).toBe(BigInt(4000))
    // Trùng line ID: nhận diện ở cổng chất lượng + engine từ chối (không tự khử trùng).
    const dup = [...r.lines, { ...r.lines[0] }]
    expect(() => computeCmsProgram({ program, lines: dup, sellers })).toThrow(CmsEngineInputError)
    const v = assessSalesSnapshot({ rowsRead: 3, totalRowsReported: 3, pagesComplete: true, rowIssues: [], lineIds: dup.map((l) => l.orderLineId), candidates: 3, unassigned: 0, previousPublishedRows: null })
    expect(v.status).toBe('held')
    expect(v.reasons).toContain('DUPLICATE_LINE_ID')
  })

  test('Product Master: view KHÔNG có is_active vẫn đọc được — output chuẩn is_active = "true" (chuỗi); cột is_active còn sót trên view bị bỏ qua; normalizer nội bộ vẫn chặt; ảnh ngoài allowlist ⇒ fallback; giá / đơn vị NULL được nhận', async () => {
    const base = { product_id: '900001', product_name: 'SP mẫu', image_url: 'https://cdn-gcs.thuocsi.vn/thuocsi-live/images/a.png', source_updated_at: '2026-11-04T00:00:00.000000Z', reference_price: '30000', price_unit: 'Hộp' }
    const rows = [base, { ...base, product_id: 900002 as unknown as string, image_url: 'https://cdn-gcs.thuocsi.vn/duocsi-circa-vn/b.png', reference_price: null, price_unit: null }]
    // (1) Output thô của adapter: is_active là chuỗi 'true' (như BigQuery CAST(TRUE AS STRING)), không phải boolean / null.
    const q = buildCmsProductsQuery(PRODUCTS)
    const raw = await viewRunner(rows, VIEW_PRODUCT_COLS)(q.sql, q.params, { maxRows: 10 })
    expect(raw.rows.map((x) => x.is_active)).toEqual(['true', 'true'])
    // (2) Qua adapter + normalizer: mọi dòng isActive=true; giá / đơn vị NULL ⇒ null (không suy, không lỗi); ảnh lạ ⇒ fallback, không loại dòng.
    const r = await fetchCmsProducts(viewRunner(rows, VIEW_PRODUCT_COLS), PRODUCTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rowIssues).toEqual([])
    expect(r.rows.map((x) => [x.productId, x.isActive, x.imageRejected, x.referencePriceUnits === null, x.priceUnit])).toEqual([['900001', true, false, false, 'Hộp'], ['900002', true, true, true, null]])
    // (3) View còn sót cột is_active=false: KHÔNG đọc (không dò hai schema) ⇒ vẫn true.
    const stale = await fetchCmsProducts(viewRunner([{ ...base, is_active: 'false' }], [...VIEW_PRODUCT_COLS, 'is_active']), PRODUCTS)
    expect(stale.ok && stale.rows.map((x) => x.isActive)).toEqual([true])
    // (4) Giá có giá trị nhưng sai miền vẫn là lỗi dòng (không bỏ kiểm giá vì giá chỉ tham khảo).
    const badPrice = await fetchCmsProducts(viewRunner([{ ...base, reference_price: '-1' }, { ...base, product_id: '900003', reference_price: '1,5' }], VIEW_PRODUCT_COLS), PRODUCTS)
    expect(badPrice.ok && badPrice.rowIssues.map((x) => x.issues.map((i) => `${i.field}:${i.kind}`))).toEqual([['reference_price:BAD_NUMBER'], ['reference_price:BAD_NUMBER']])
    // (5) Contract nội bộ (normalizer / file chuẩn 7 cột) giữ nguyên: false hợp lệ; thiếu / 1 / Y KHÔNG thành true.
    const off = normalizeProductRow({ ...base, is_active: 'false' })
    expect(off.ok && off.value.isActive).toBe(false)
    expect(normalizeProductRow({ ...base, is_active: null })).toEqual({ ok: false, issues: [{ kind: 'MISSING_FIELD', field: 'is_active' }] })
    for (const bad of ['1', 'Y', 'yes']) expect(normalizeProductRow({ ...base, is_active: bad }).ok, bad).toBe(false)
  })

  test('Product Master trùng product_id (chỉ khác giá — như probe 04/11) ⇒ held DUPLICATE_PRODUCT, 0 upsert, cache giữ nguyên; KHÔNG chọn MAX / MIN / dòng đầu', async () => {
    const base = { product_id: '900001', product_name: 'SP mẫu', image_url: null, source_updated_at: '2026-11-04T00:00:00.000000Z', reference_price: '30000', price_unit: 'Hộp' }
    const dupRows: CmsRawRow[] = [base, { ...base, reference_price: '3000' }, { ...base, product_id: '900002' }]
    const mk = (rows: CmsRawRow[]) => {
      const seen = { upserted: [] as CmsProductUpsertRow[], close: [] as { status: string; detail: Record<string, unknown> }[] }
      const deps: CmsProductSyncDeps = {
        table: PRODUCTS, runner: viewRunner(rows, VIEW_PRODUCT_COLS), countCached: async () => 5, openRun: async () => 'run-fx-1',
        upsert: async (_id, chunk) => { seen.upserted.push(...chunk); return chunk.length },
        closeRun: async (_id, status, detail) => { seen.close.push({ status, detail }) }, now: () => 0,
      }
      return { deps, seen }
    }
    const held = mk(dupRows)
    const r = await runCmsProductSync(held.deps, { dryRun: false, source: 'cron' })
    expect(r).toMatchObject({ status: 'held', code: 'DUPLICATE_PRODUCT', rowsRead: 3, rowsValid: 3, rowsRejected: 0, rowsWritten: 0 })
    expect(held.seen.upserted).toEqual([]) // không ghi khối nào ⇒ cache cũ giữ nguyên
    expect(held.seen.close).toEqual([{ status: 'held', detail: expect.objectContaining({ error_code: 'DUPLICATE_PRODUCT', rows_read: 3 }) }])
    const dry = await runCmsProductSync(mk(dupRows).deps, { dryRun: true, source: 'bootstrap' })
    expect([dry.status, dry.code]).toEqual(['dry_run', 'DUPLICATE_PRODUCT'])
    // Đường thành công (BI đã 1 dòng / SP): ghi đủ, is_active = true (hằng), giá NULL đi nguyên.
    const ok = mk([base, { ...base, product_id: '900002', reference_price: null, price_unit: null }])
    const s2 = await runCmsProductSync(ok.deps, { dryRun: false, source: 'cron' })
    expect(s2).toMatchObject({ status: 'ok', code: null, rowsWritten: 2, inactive: 0 })
    expect(ok.seen.upserted.map((x) => [x.product_id, x.is_active, x.reference_price, x.price_unit])).toEqual([['900001', true, '30000', 'Hộp'], ['900002', true, null, null]])
  })
})
