import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { BigQueryError } from '../lib/bigquery/query'
import { cmsFlagsFromEnv } from '../lib/cms/flags'
import { cronBearerMatches, handlePullCmsProducts } from '../lib/cms/cronProducts'
import {
  cmsBootstrapExitCode, cmsProductSyncHttpStatus, runCmsProductSync, toCmsProductUpsertRow,
  type CmsProductSyncDeps, type CmsProductUpsertRow,
} from '../lib/cms/productSync'
import type { CmsRawRow } from '../lib/cms/source/contract'
import { normalizeProductRow } from '../lib/cms/source/contract'
import { createCmsFixtureRunner, type CmsFixtureSource } from './cmsFixtureRunner'
import { FX_PRODUCTS } from './cmsSourceFixture'

// CMS P1-a — phần app: cờ, cron Product Master (handler thuần), lõi đồng bộ dùng chung cron + bootstrap, script operator.
// THUẦN: không DB, không mạng, không BigQuery thật (runner fixture + deps giả ghi lại lời gọi).
// Map docs/cms/SPEC.md §9 + IMPLEMENTATION_PLAN §3.2 + PM PR-0 (bootstrap operator-only, cờ OFF ⇒ 0 query nguồn).

const TABLE = 'lakehouse-prod-394907.buymed_tech.fake_cms_products_view'
const GOOD_PRODUCTS: CmsRawRow[] = [
  { product_id: '910001', product_name: 'SP giả 1', image_url: 'https://cdn-gcs.thuocsi.vn/thuocsi-live/images/a.jpg', is_active: 'true', source_updated_at: '2026-10-30T01:00:00.000001Z', reference_price: '9.5', price_unit: 'viên' },
  { product_id: '910002', product_name: 'SP giả 2', image_url: 'https://cdn.example.test/x.jpg', is_active: 'false', source_updated_at: '2026-10-30T01:00:00Z', reference_price: null, price_unit: null },
  { product_id: '910003', product_name: 'SP giả 3', image_url: null, is_active: 'true', source_updated_at: '2026-10-30T01:00:00Z', reference_price: '120000', price_unit: 'hộp' },
]

interface Calls { runner: number; open: number; upsert: CmsProductUpsertRow[][]; close: { status: string; detail: Record<string, unknown> }[]; count: number }
function fakeDeps(src: CmsFixtureSource, o: {
  table?: string | null; cached?: number; openErr?: string; upsertErr?: boolean
  /** Khối upsert thứ n (1-based) ném lỗi; các khối trước thành công. */
  upsertFailAt?: number
  /** closeRun ném lỗi (mô phỏng RPC đóng phiên thất bại). */
  closeErr?: boolean
} = {}) {
  const calls: Calls = { runner: 0, open: 0, upsert: [], close: [], count: 0 }
  const fx = createCmsFixtureRunner(src)
  const deps: CmsProductSyncDeps = {
    table: o.table === undefined ? TABLE : o.table,
    runner: (sql, params, opts) => { calls.runner++; return fx(sql, params, opts) },
    countCached: async () => { calls.count++; return o.cached ?? 0 },
    openRun: async () => { calls.open++; if (o.openErr) throw new Error(o.openErr); return 'run-1' },
    upsert: async (_id, rows) => {
      if (o.upsertErr || (o.upsertFailAt !== undefined && calls.upsert.length + 1 === o.upsertFailAt)) throw new Error('UPSERT_FAILED')
      calls.upsert.push(rows); return rows.length
    },
    closeRun: async (_id, status, detail) => { calls.close.push({ status, detail }); if (o.closeErr) throw new Error('CLOSE_FAILED raw-detail') },
    now: () => 0,
  }
  return { deps, calls }
}

test.describe('CMS P1-a · cờ + xác thực cron @desktop', () => {
  test('cờ mặc định OFF, chỉ đúng "true" mới bật', () => {
    expect(cmsFlagsFromEnv({})).toEqual({ program: false, earnings: false, lock: false })
    expect(cmsFlagsFromEnv({ CMS_PROGRAM_ENABLED: 'TRUE', CMS_EARNINGS_ENABLED: '1', CMS_LOCK_ENABLED: 'yes' })).toEqual({ program: false, earnings: false, lock: false })
    expect(cmsFlagsFromEnv({ CMS_PROGRAM_ENABLED: 'true' })).toEqual({ program: true, earnings: false, lock: false })
  })

  test('Bearer CRON_SECRET so khớp tuyệt đối', () => {
    expect(cronBearerMatches('Bearer s3cret', 's3cret')).toBe(true)
    for (const h of [null, '', 's3cret', 'Bearer s3cre', 'Bearer s3cret ', 'bearer s3cret', 'Bearer ']) expect(cronBearerMatches(h, 's3cret'), String(h)).toBe(false)
    expect(cronBearerMatches('Bearer x', undefined)).toBe(false)
    expect(cronBearerMatches('Bearer ', '')).toBe(false)
  })
})

test.describe('CMS P1-a · handler cron pull-cms-products @desktop', () => {
  const base = { authorization: 'Bearer s', cronSecret: 's', programEnabled: true }

  test('401 sai secret / 503 cờ OFF: KHÔNG dựng deps, 0 query nguồn', async () => {
    let made = 0
    const make = () => { made++; return fakeDeps({ products: GOOD_PRODUCTS }).deps }
    expect((await handlePullCmsProducts({ ...base, authorization: 'Bearer x', makeDeps: make })).status).toBe(401)
    const off = await handlePullCmsProducts({ ...base, programEnabled: false, makeDeps: make })
    expect(off).toEqual({ status: 503, body: { error: 'CMS chưa bật (CMS_PROGRAM_ENABLED)', code: 'FLAG_OFF' } })
    expect(made).toBe(0)
  })

  test('503 thiếu / sai cấu hình view: không query', async () => {
    const f = fakeDeps({ products: GOOD_PRODUCTS }, { table: null })
    const r = await handlePullCmsProducts({ ...base, makeDeps: () => f.deps })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('CONFIG_MISSING')
    expect(f.calls.runner + f.calls.open).toBe(0)
    const bad = await handlePullCmsProducts({ ...base, makeDeps: () => { throw new Error('CMS_BQ_PRODUCTS_TABLE phải dạng …') } })
    expect(bad).toEqual({ status: 503, body: { error: 'Cấu hình nguồn CMS không hợp lệ', code: 'CONFIG_INVALID' } })
  })

  test('200 ok: mở phiên → upsert → đóng ok; body chỉ số đếm', async () => {
    const f = fakeDeps({ products: GOOD_PRODUCTS })
    const r = await handlePullCmsProducts({ ...base, makeDeps: () => f.deps })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'ok', code: null, rowsRead: 3, rowsValid: 3, rowsRejected: 0, rowsWritten: 3, inactive: 1, imageRejected: 1 })
    expect(f.calls.open).toBe(1)
    expect(f.calls.upsert.flat().map((x) => x.product_id)).toEqual(['910001', '910002', '910003'])
    expect(f.calls.close).toEqual([{ status: 'ok', detail: { rows_read: 3, rows_rejected: 0, bytes_processed: null, error_code: null, inactive: 1, image_rejected: 1, source: 'cron' } }])
    expect(JSON.stringify(r.body)).not.toMatch(/SP giả|https?:|cdn/)
  })

  test('lỗi bất ngờ trong lõi ⇒ 500 INTERNAL, không lộ message', async () => {
    const f = fakeDeps({ products: GOOD_PRODUCTS })
    f.deps.now = () => { throw new Error('boom secret-detail') }
    const r = await handlePullCmsProducts({ ...base, makeDeps: () => f.deps })
    expect(r).toEqual({ status: 500, body: { error: 'Lỗi đồng bộ Product Master', code: 'INTERNAL' } })
  })

  test('cron dùng chung lõi: mã HTTP theo trạng thái', () => {
    expect([cmsProductSyncHttpStatus('ok'), cmsProductSyncHttpStatus('dry_run'), cmsProductSyncHttpStatus('held'),
      cmsProductSyncHttpStatus('busy'), cmsProductSyncHttpStatus('config_missing'), cmsProductSyncHttpStatus('error')]).toEqual([200, 200, 207, 409, 503, 500])
  })

  test('route chỉ nối deps: cờ + handler + deps thật, không logic riêng', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'api', 'cron', 'pull-cms-products', 'route.ts'), 'utf8')
    expect(src).toContain('isCmsProgramEnabled()')
    expect(src).toContain('handlePullCmsProducts(')
    expect(src).toContain("export const dynamic = 'force-dynamic'")
    expect(src).toContain("'Cache-Control': 'no-store'")
    expect(src).not.toMatch(/runBigQueryPaged|supabaseAdmin|rpc\(/)
  })
})

test.describe('CMS P1-a · lõi đồng bộ Product Master (fail-closed) @desktop', () => {
  test('chia khối upsert, kiểm số dòng trả về', async () => {
    const f = fakeDeps({ products: GOOD_PRODUCTS })
    const r = await runCmsProductSync(f.deps, { dryRun: false, source: 'bootstrap', chunkSize: 2 })
    expect(r.status).toBe('ok')
    expect(f.calls.upsert.map((c) => c.length)).toEqual([2, 1])
    expect(f.calls.close[0].detail.source).toBe('bootstrap')
  })

  test('dòng lỗi / trùng ProductID ⇒ held, KHÔNG ghi', async () => {
    const f1 = fakeDeps({ products: [...GOOD_PRODUCTS, { ...GOOD_PRODUCTS[0], product_id: 'SKU9' }] })
    const r1 = await runCmsProductSync(f1.deps, { dryRun: false, source: 'cron' })
    expect([r1.status, r1.code, r1.rowsRejected]).toEqual(['held', 'ROW_ISSUES', 1])
    expect(f1.calls.upsert).toEqual([])
    expect(f1.calls.close[0]).toMatchObject({ status: 'held', detail: { error_code: 'ROW_ISSUES', rows_rejected: 1 } })
    const f2 = fakeDeps({ products: [...GOOD_PRODUCTS, { ...GOOD_PRODUCTS[0] }] })
    const r2 = await runCmsProductSync(f2.deps, { dryRun: false, source: 'cron' })
    expect([r2.status, r2.code]).toEqual(['held', 'DUPLICATE_PRODUCT'])
    expect(f2.calls.upsert).toEqual([])
  })

  test('nguồn rỗng ⇒ held (đã có cache: EMPTY_AFTER_DATA; lần đầu: EMPTY_SOURCE)', async () => {
    const a = fakeDeps({ products: [] }, { cached: 5 })
    expect((await runCmsProductSync(a.deps, { dryRun: false, source: 'cron' })).code).toBe('EMPTY_AFTER_DATA')
    const b = fakeDeps({ products: [] }, { cached: 0 })
    const rb = await runCmsProductSync(b.deps, { dryRun: false, source: 'bootstrap' })
    expect([rb.status, rb.code]).toEqual(['held', 'EMPTY_SOURCE'])
    expect(a.calls.upsert.length + b.calls.upsert.length).toBe(0)
  })

  test('lỗi nguồn ⇒ error; vượt trần / thiếu trang ⇒ held; lỗi upsert ⇒ error (đóng phiên đúng mã)', async () => {
    const e = fakeDeps({ fail: new BigQueryError('http', '403 Access Denied: secret-view', 403) })
    const re = await runCmsProductSync(e.deps, { dryRun: false, source: 'cron' })
    expect([re.status, re.code]).toEqual(['error', 'SOURCE_SOURCE_ERROR'])
    expect(e.calls.close).toEqual([{ status: 'error', detail: { error_code: 'SOURCE_SOURCE_ERROR' } }])
    expect(JSON.stringify(re)).not.toContain('secret-view')
    const pg = fakeDeps({ products: GOOD_PRODUCTS, totalRowsDelta: 1 })
    expect((await runCmsProductSync(pg.deps, { dryRun: false, source: 'cron' })).status).toBe('held')
    const up = fakeDeps({ products: GOOD_PRODUCTS }, { upsertErr: true })
    const ru = await runCmsProductSync(up.deps, { dryRun: false, source: 'cron' })
    expect([ru.status, ru.code]).toEqual(['error', 'UPSERT_FAILED'])
    expect(up.calls.close[0].status).toBe('error')
  })

  test('PM P1-a §3: đóng phiên thất bại SAU upsert thành công ⇒ error CLOSE_FAILED, giữ rowsWritten + runId; cron 500; bootstrap exit 1', async () => {
    const f = fakeDeps({ products: GOOD_PRODUCTS }, { closeErr: true })
    const r = await runCmsProductSync(f.deps, { dryRun: false, source: 'bootstrap' })
    expect(r).toMatchObject({ status: 'error', code: 'CLOSE_FAILED', runId: 'run-1', rowsWritten: 3, cause: { status: 'ok', code: null } })
    expect(f.calls.close).toHaveLength(1)
    expect(JSON.stringify(r)).not.toContain('raw-detail')
    expect(cmsBootstrapExitCode(r)).toBe(1)
    const g = fakeDeps({ products: GOOD_PRODUCTS }, { closeErr: true })
    const h = await handlePullCmsProducts({ authorization: 'Bearer s', cronSecret: 's', programEnabled: true, makeDeps: () => g.deps })
    expect(h.status).toBe(500)
    expect(h.body).toMatchObject({ status: 'error', code: 'CLOSE_FAILED', rowsWritten: 3, cause: { status: 'ok', code: null } })
  })

  test('PM P1-a §3: đóng phiên thất bại ở nhánh held / lỗi nguồn / lỗi ghi ⇒ CLOSE_FAILED + giữ nguyên nhân gốc', async () => {
    const held = fakeDeps({ products: [...GOOD_PRODUCTS, { ...GOOD_PRODUCTS[0], product_id: 'SKU9' }] }, { closeErr: true })
    const rh = await runCmsProductSync(held.deps, { dryRun: false, source: 'cron' })
    expect(rh).toMatchObject({ status: 'error', code: 'CLOSE_FAILED', cause: { status: 'held', code: 'ROW_ISSUES' }, rowsWritten: 0 })
    expect(held.calls.upsert).toEqual([])
    expect(cmsProductSyncHttpStatus(rh.status)).toBe(500)
    const src = fakeDeps({ fail: new BigQueryError('http', 'x', 403) }, { closeErr: true })
    const rs = await runCmsProductSync(src.deps, { dryRun: false, source: 'cron' })
    expect(rs).toMatchObject({ status: 'error', code: 'CLOSE_FAILED', cause: { status: 'error', code: 'SOURCE_SOURCE_ERROR' } })
    const up = fakeDeps({ products: GOOD_PRODUCTS }, { upsertFailAt: 2, closeErr: true })
    const ru = await runCmsProductSync(up.deps, { dryRun: false, source: 'cron', chunkSize: 2 })
    expect(ru).toMatchObject({ status: 'error', code: 'CLOSE_FAILED', cause: { status: 'error', code: 'UPSERT_FAILED' }, rowsWritten: 2 })
  })

  test('PM P1-a §3.5: khối thứ hai lỗi sau khi khối đầu ghi ⇒ error UPSERT_FAILED, rowsWritten = khối đã xác nhận (không atomic toàn lượt)', async () => {
    const f = fakeDeps({ products: GOOD_PRODUCTS }, { upsertFailAt: 2 })
    const r = await runCmsProductSync(f.deps, { dryRun: false, source: 'cron', chunkSize: 2 })
    expect(r).toMatchObject({ status: 'error', code: 'UPSERT_FAILED', rowsWritten: 2, cause: null })
    expect(f.calls.upsert.map((c) => c.length)).toEqual([2])
    expect(f.calls.close).toEqual([{ status: 'error', detail: expect.objectContaining({ error_code: 'UPSERT_FAILED' }) }])
    expect(cmsBootstrapExitCode(r)).toBe(1)
  })

  test('mã thoát bootstrap: chỉ ok / dry-run sạch = 0; thiếu cấu hình = 2', () => {
    expect(cmsBootstrapExitCode({ status: 'ok', code: null })).toBe(0)
    expect(cmsBootstrapExitCode({ status: 'dry_run', code: null })).toBe(0)
    expect(cmsBootstrapExitCode({ status: 'dry_run', code: 'ROW_ISSUES' })).toBe(1)
    for (const s of ['held', 'busy', 'error'] as const) expect(cmsBootstrapExitCode({ status: s, code: 'X' })).toBe(1)
    expect(cmsBootstrapExitCode({ status: 'config_missing', code: 'CONFIG_MISSING' })).toBe(2)
  })

  test('đang có phiên chạy ⇒ busy, không query nguồn', async () => {
    const f = fakeDeps({ products: GOOD_PRODUCTS }, { openErr: 'CMS_SYNC_BUSY' })
    const r = await runCmsProductSync(f.deps, { dryRun: false, source: 'cron' })
    expect([r.status, r.code]).toEqual(['busy', 'CMS_SYNC_BUSY'])
    expect(f.calls.runner).toBe(0)
    const g = fakeDeps({ products: GOOD_PRODUCTS }, { openErr: 'boom' })
    expect((await runCmsProductSync(g.deps, { dryRun: false, source: 'cron' })).code).toBe('OPEN_FAILED')
  })

  test('dry-run: đọc + kiểm, KHÔNG mở phiên / ghi / đóng', async () => {
    const f = fakeDeps({ products: GOOD_PRODUCTS })
    const r = await runCmsProductSync(f.deps, { dryRun: true, source: 'bootstrap' })
    expect([r.status, r.code, r.rowsValid]).toEqual(['dry_run', null, 3])
    expect(f.calls.open + f.calls.upsert.length + f.calls.close.length).toBe(0)
    const g = fakeDeps({ products: [...GOOD_PRODUCTS, { ...GOOD_PRODUCTS[0], product_name: '' }] })
    const rg = await runCmsProductSync(g.deps, { dryRun: true, source: 'bootstrap' })
    expect([rg.status, rg.code]).toEqual(['dry_run', 'ROW_ISSUES'])
  })

  test('payload upsert: timestamp ISO micro giây, giá decimal chuỗi, ảnh ngoài allow-list = null', () => {
    const rows = FX_PRODUCTS.map((r) => normalizeProductRow(r)).map((n) => (n.ok ? toCmsProductUpsertRow(n.value) : null))
    expect(rows[0]).toEqual({ product_id: '900001', product_name: 'Sản phẩm giả A 500mg', image_url: null, is_active: true,
      source_updated_at: '2026-10-30T01:00:00.000000Z', reference_price: '120000', price_unit: 'hộp' })
    expect(rows[2]?.reference_price).toBe('9.5')
    expect(rows[1]?.source_updated_at).toBe('2026-10-30T01:00:00.000001Z')
  })
})

test.describe('CMS P1-a · script bootstrap operator (không mạng) @desktop', () => {
  const script = path.resolve(__dirname, '..', 'scripts', 'cms-bootstrap-products.mjs')
  // Env tối thiểu, KHÔNG mang credential thật; CMS_BOOTSTRAP_ENV_FILE=none để không đọc .env.local.
  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '',
    CMS_BOOTSTRAP_ENV_FILE: 'none', ...extra,
  }) as unknown as NodeJS.ProcessEnv
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, ...args], { env: env(extra), encoding: 'utf8', timeout: 60_000 })

  test('self-check nạp lõi + deps qua jiti (không mạng / DB)', () => {
    const r = run(['--self-check'])
    expect(r.stdout).toContain('self-check: nạp lõi + deps ĐẠT')
    expect(r.status).toBe(0)
  })

  test('thiếu cấu hình view ⇒ exit 2, không query; tham số lạ ⇒ exit 2', () => {
    const r = run([])
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('chưa cấu hình CMS_BQ_PRODUCTS_TABLE')
    expect(run(['--force']).status).toBe(2)
    const bad = run([], { CMS_BQ_PRODUCTS_TABLE: 'không hợp lệ' })
    expect(bad.status).toBe(2)
    expect(bad.stdout).not.toContain('không hợp lệ.')
  })

  test('--confirm bắt buộc --expect-host khớp host đích (chống ghi nhầm DB), dừng trước mọi IO', () => {
    const cfg = { CMS_BQ_PRODUCTS_TABLE: TABLE, NEXT_PUBLIC_SUPABASE_URL: 'https://db.cms.example.test', SUPABASE_SERVICE_ROLE_KEY: 'x', BQ_SERVICE_ACCOUNT_KEY: 'x' }
    const r = run(['--confirm'], cfg)
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('--expect-host=db.cms.example.test')
    const w = run(['--confirm', '--expect-host=khac.example.test'], cfg)
    expect(w.status).toBe(2)
    // Cùng hostname khác port ⇒ phải ghi đủ host:port.
    const p = run(['--confirm', '--expect-host=localhost'], { ...cfg, NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' })
    expect(p.status).toBe(2)
    expect(p.stdout).toContain('--expect-host=localhost:54321')
  })
})
