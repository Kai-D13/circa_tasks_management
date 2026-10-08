import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import * as XLSX from 'xlsx'
import { CARE_IMPORT_HEADERS } from '../lib/care/import/contract'
import { parseCareImportXlsx } from '../lib/care/import/parse'
import { validateCareRows } from '../lib/care/import/validate'
import { buildCarePreview, type CareImportLookups } from '../lib/care/import/preview'
import { handleCarePreview } from '../lib/care/import/handler'
import { buildCareImportRows, defaultFixtureStores } from './careImportFixture'

// CRM-CSKH B2 — đo file lớn (SPEC B2 §4.4). Chỉ chạy khi CARE_BENCH=1:
//   cd webapp; $env:CARE_BENCH='1'; npx playwright test e2e/care-import-bench.spec.ts --project=desktop-chromium --no-deps
// Kết quả ghi qa-artifacts/care-b2-bench.json (gitignored). Đây là số đo TRÊN MÁY DEV:
// không thay được kiểm tra statement_timeout=8s trên DB thật (gate B6).

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'qa-artifacts', 'care-b2-bench.json')
const STORES = defaultFixtureStores(25)
const MAX_ROWS = 10_000

function lookups(): CareImportLookups {
  return {
    storesByCode: new Map(STORES.map((s, i) => [s.code, { id: `s${i}`, code: s.code, name: `QA ${i}` }])),
    staff: STORES.flatMap((s, i) => s.assigneeEmails.map((e) => ({ id: e, storeId: `s${i}`, email: e, fullName: e }))),
    customers: new Map(), refusals: new Set(), currentTasks: new Map(), currentPeriodTaskCount: 0, openPreviousPeriodCount: 0,
  }
}
function rows10k(noise: boolean) {
  const rows = buildCareImportRows({ customersPerStore: 210 }).slice(0, MAX_ROWS)
  if (!noise) return rows
  // Văn bản ngẫu nhiên (base64) để ZIP không nén được ⇒ file tiến sát trần byte.
  const rnd = (n: number) => crypto.randomBytes(n).toString('base64').slice(0, n)
  return rows.map((r) => ({ ...r, product_name: `SP ${rnd(280)}`, reason_text: `QA ${rnd(330)}` }))
}
function toXlsx(rows: Record<string, string>[]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([[...CARE_IMPORT_HEADERS], ...rows.map((r) => CARE_IMPORT_HEADERS.map((h) => r[h]))])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'KhachHang')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer)
}
const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6
const mb = (n: number) => Math.round((n / 1048576) * 10) / 10

test.describe('care B2 — benchmark file lớn @desktop', () => {
  test.skip(process.env.CARE_BENCH !== '1', 'chỉ chạy khi CARE_BENCH=1')

  test('10.000 dòng: thường và gần trần 8 MiB — parse/validate/preview/handler + finalize PGlite', async () => {
    test.setTimeout(600_000)
    const report: Record<string, unknown> = { node: process.version, platform: process.platform, at: new Date().toISOString() }
    for (const [name, noise] of [['typical', false], ['near_cap', true]] as const) {
      const bytes = toXlsx(rows10k(noise) as unknown as Record<string, string>[])
      global.gc?.()
      const rss0 = process.memoryUsage().rss
      let t = process.hrtime.bigint()
      const parsed = parseCareImportXlsx(bytes)
      const parseMs = ms(t)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      t = process.hrtime.bigint()
      const validated = validateCareRows(parsed.rows)
      const validateMs = ms(t)
      t = process.hrtime.bigint()
      const preview = buildCarePreview({ rowCount: parsed.rows.length, validated, parseErrors: parsed.errors, lookups: lookups(), period: '2026-10-01', isTest: false })
      const previewMs = ms(t)
      const rssPeak = process.memoryUsage().rss

      // Toàn handler (multipart + sha + parse + preview), repo giả.
      const fd = new FormData()
      fd.append('file', new File([new Uint8Array(bytes)], 'big.xlsx'))
      const tmp = new Request('http://x/', { method: 'POST', body: fd })
      const body = new Uint8Array(await tmp.arrayBuffer())
      t = process.hrtime.bigint()
      const res = await handleCarePreview(new Request('http://x/', {
        method: 'POST', body, headers: { 'content-type': tmp.headers.get('content-type')!, 'content-length': String(body.byteLength) },
      }), {
        enabled: true, maxBytes: 8 * 1024 * 1024, getAccess: async () => ({ kind: 'ok', actorId: 'a' }), now: () => new Date('2026-10-10T03:00:00Z'),
        repo: { loadLookups: async () => lookups(), createBatch: async () => 'b', stageRows: async () => {}, finalize: async () => { throw new Error('x') }, discardBatch: async () => {}, purgeStaleStaging: async () => {} },
      })
      const handlerMs = ms(t)
      const json = await res.json()
      report[name] = {
        rows: parsed.rows.length, customers: preview.customerCount, file_mb: mb(bytes.byteLength), multipart_mb: mb(body.byteLength),
        handler_status: res.status, handler_code: json.code ?? null, response_json_mb: mb(JSON.stringify(json).length),
        parse_ms: Math.round(parseMs), validate_ms: Math.round(validateMs), preview_ms: Math.round(previewMs), handler_total_ms: Math.round(handlerMs),
        rss_before_mb: mb(rss0), rss_after_parse_preview_mb: mb(rssPeak),
      }
      expect(preview.errors).toEqual([])
    }

    // Finalize SQL thật trên PGlite (một session, WASM) — chỉ để biết bậc độ lớn.
    if (fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))) {
      const { PGlite } = await import('@electric-sql/pglite')
      const L = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
      const db = await L.freshDb(PGlite)
      const rows = rows10k(false)
      const batch = (await db.query(`INSERT INTO public.care_import_batches (period_month, file_name, file_sha256, row_count, created_by) VALUES ('2026-10-01', 'b.xlsx', $1, $2, $3) RETURNING id`,
        ['a'.repeat(64), rows.length, L.U.mkt])).rows[0].id
      let t = process.hrtime.bigint()
      for (let i = 0; i < rows.length; i += 2000) {
        const chunk = rows.slice(i, i + 2000)
        await db.query(`INSERT INTO public.care_import_staging (batch_id, row_no, payload) SELECT $1, (x->>'n')::int, x->'p' FROM jsonb_array_elements($2::jsonb) x`,
          [batch, JSON.stringify(chunk.map((r, j) => ({ n: i + j + 2, p: Object.fromEntries(CARE_IMPORT_HEADERS.map((h) => [h, (r as Record<string, string>)[h]])) })))])
      }
      const stageMs = ms(t)
      t = process.hrtime.bigint()
      const result = (await db.query(`SELECT public.care__import_finalize_at($1, $2, '2026-10-01') r`, [batch, L.U.mkt])).rows[0].r
      report.pglite_finalize = { rows: rows.length, stage_ms: Math.round(stageMs), finalize_ms: Math.round(ms(t)), status: result.status, created: result.created }
      expect(result.status).toBe('committed')
      await db.close()
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    console.log('CARE_BENCH ' + JSON.stringify(report))
  })
})
