import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import v8 from 'node:v8'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { CARE_IMPORT_HEADERS, CARE_IMPORT_MAX_ROWS } from '../lib/care/import/contract'
import { parseCareImportCsv } from '../lib/care/import/parse'
import { validateCareRows } from '../lib/care/import/validate'
import { buildCarePreview, type CareImportLookups } from '../lib/care/import/preview'
import { handleCarePreview } from '../lib/care/import/handler'
import { buildCareImportRows, defaultFixtureStores, fixtureCsv } from './careImportFixture'

// CRM-CSKH — đo file lớn (B2, đo lại Q-121 ở 20.000 dòng; Q-124: file CSV UTF-8). Chỉ chạy khi CARE_BENCH=1:
//   cd webapp; $env:CARE_BENCH='1'; npx playwright test e2e/care-import-bench.spec.ts --project=desktop-chromium --no-deps
// Kết quả: qa-artifacts/care-q121-bench.json (gitignored). Số đo TRÊN MÁY DEV, dữ liệu giả tất định (seed = công thức
// trong rowsQ121), 1 lượt làm nóng + 3 lượt đo (min/median/max). KHÔNG thay được đo trên DB thật (gate Q-121 bước 3).
//
// PGlite 0.2.17 khởi động với enable_seqscan=off (prod: on): planner tránh seq scan trên bảng tạm không index ⇒ nested
// loop bậc hai trong finalize. Bench đo CẢ HAI chế độ; phần `explain_10k` tái hiện vì sao hai mốc cũ lệch nhau
// (B2 08/10: 5,3 s · 15/10: 14,6 s): cùng seqscan=off, dòng rộng hơn làm Materialize vượt work_mem 4 MB ⇒ ghi đĩa tạm.

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'qa-artifacts', 'care-q121-bench.json')
const STORES = defaultFixtureStores(25)
const pad = (n: number, w: number) => String(n).padStart(w, '0')

/** 8.000 khách × (lẻ 3 / chẵn 2 sản phẩm) = 20.000 dòng, độ rộng gần dữ liệu vận hành; `noise` ⇒ văn bản khó nén (file sát 8 MiB). */
function rowsQ121(customers = 8000, noise = 0) {
  const rnd = (n: number) => crypto.randomBytes(n).toString('base64').slice(0, n)
  const out: Record<string, string>[] = []
  for (let c = 1; c <= customers; c++) {
    const st = STORES[(c - 1) % 25]
    for (let p = 0; p < (c % 2 ? 3 : 2); p++) {
      const k = pad(((c * 37 + p * 101) % 1500) + 1, 4)
      out.push({
        customer_external_id: `QA-BN-${pad(c, 5)}`, customer_name: `Khách QA ${pad(c, 5)}`, customer_phone: `03900${pad(c, 5)}`,
        target_store_code: st.code, assignee_email: st.assigneeEmails[c % 2], reason_type: 'chronic',
        reason_text: noise ? `QA ${rnd(noise)}` : `Khách dùng định kỳ, dự kiến hết thuốc trong tháng; nhắc mua lại và tư vấn liều dùng (${k})`,
        product_id: `QABN${k}`, product_name: `Thuốc giả lập QA ${k} hộp 10 vỉ x 10 viên nén bao phim 500mg`,
        product_url: `https://cdn-gcs.thuocsi.vn/qa-fixture/QABN${k}a1b2c3d4e5f60718293a4b5c.png`,
      })
    }
  }
  return out
}
function lookups(): CareImportLookups {
  return {
    storesByCode: new Map(STORES.map((s, i) => [s.code, { id: `s${i}`, code: s.code, name: `QA ${i}` }])),
    staff: STORES.flatMap((s, i) => s.assigneeEmails.map((e) => ({ id: e, storeId: `s${i}`, email: e, fullName: e }))),
    customers: new Map(), refusals: new Set(), currentTasks: new Map(), currentPeriodTaskCount: 0, openPreviousPeriodCount: 0,
  }
}
/** File CSV như Excel "CSV UTF-8" (BOM, CRLF). CSV không nén ⇒ kích thước gần trần 8 MiB hơn .xlsx nhiều. */
function toCsv(rows: Record<string, string>[]): Uint8Array {
  return new TextEncoder().encode(fixtureCsv([[...CARE_IMPORT_HEADERS], ...rows.map((r) => CARE_IMPORT_HEADERS.map((h) => r[h]))]))
}
// GC tay để đo phần heap TĂNG do một lần parse (không lẫn rác của lượt trước / dữ liệu sinh file).
v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void
const ms = (t0: number) => Math.round(performance.now() - t0)
const mb = (n: number) => Math.round((n / 1048576) * 100) / 100
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] } }

test.describe('care Q-121 — benchmark 20.000 dòng @desktop', () => {
  test.skip(process.env.CARE_BENCH !== '1', 'chỉ chạy khi CARE_BENCH=1')

  test('app (parse/validate/preview/handler) + finalize PGlite seqscan on/off + giải thích mốc 10k cũ', async () => {
    test.setTimeout(1_800_000)
    const report: Record<string, any> = { node: process.version, platform: process.platform, at: new Date().toISOString(), runs: '1 làm nóng + 3 đo' }

    // ── Phía app ───────────────────────────────────────────────────────────────
    // near_8mib: thêm văn bản ngẫu nhiên vào reason_text ⇒ file CSV sát (dưới) trần byte 8 MiB.
    for (const [name, rows] of [['typical_20k', rowsQ121()], ['near_8mib_20k', rowsQ121(8000, 150)]] as const) {
      expect(rows.length).toBe(20_000) // khả năng đọc của parser (Q-121); handler đo ở đúng trần phát hành
      const bytes = toCsv(rows)
      expect(bytes.byteLength).toBeLessThan(8 * 1024 * 1024)
      const capBytes = toCsv(rows.slice(0, CARE_IMPORT_MAX_ROWS))
      const runs: Record<string, number[]> = { parse: [], validate: [], preview: [], handler: [], heap: [] }
      for (let r = 0; r < 4; r++) {
        gc()
        const heap0 = process.memoryUsage().heapUsed
        let t = performance.now()
        const parsed = parseCareImportCsv(bytes, rows.length) // đo khả năng đọc 20.000 dòng (trần phát hành có thể thấp hơn)
        const parseMs = ms(t)
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) return
        const heapDelta = process.memoryUsage().heapUsed - heap0 // gồm cả rác chưa thu ⇒ cận trên
        t = performance.now()
        const validated = validateCareRows(parsed.rows)
        const validateMs = ms(t)
        t = performance.now()
        const preview = buildCarePreview({ rowCount: parsed.rows.length, validated, parseErrors: parsed.errors, lookups: lookups(), period: '2026-10-01', isTest: false })
        const previewMs = ms(t)
        expect(preview.errors).toEqual([])
        const fd = new FormData()
        fd.append('file', new File([new Uint8Array(capBytes)], 'big.csv', { type: 'text/csv' }))
        const tmp = new Request('http://x/', { method: 'POST', body: fd })
        const body = new Uint8Array(await tmp.arrayBuffer())
        t = performance.now()
        const res = await handleCarePreview(new Request('http://x/', {
          method: 'POST', body, headers: { 'content-type': tmp.headers.get('content-type')!, 'content-length': String(body.byteLength) },
        }), {
          enabled: true, maxBytes: 8 * 1024 * 1024, getAccess: async () => ({ kind: 'ok', actorId: 'a' }), now: () => new Date('2026-10-10T03:00:00Z'),
          repo: { loadLookups: async () => lookups(), createBatch: async () => 'b', stageRows: async () => {}, finalize: async () => { throw new Error('x') }, discardBatch: async () => {}, purgeStaleStaging: async () => {} },
        })
        const handlerMs = ms(t)
        expect(res.status).toBe(200)
        if (r === 0) { report[`${name}_response_json_mb`] = mb((await res.text()).length); continue } // làm nóng
        runs.parse.push(parseMs); runs.validate.push(validateMs); runs.preview.push(previewMs); runs.handler.push(handlerMs); runs.heap.push(Math.round(heapDelta / 1048576))
      }
      report[name] = {
        rows: rows.length, customers: new Set(rows.map((x) => x.customer_external_id)).size, csv_mb: mb(bytes.byteLength), csv_bytes_per_row: Math.round(bytes.byteLength / rows.length),
        parse_ms: stats(runs.parse), validate_ms: stats(runs.validate), preview_ms: stats(runs.preview),
        handler_rows: CARE_IMPORT_MAX_ROWS, handler_total_ms: stats(runs.handler),
        heap_increase_by_parse_mb: stats(runs.heap), worker_rss_peak_mb: mb(process.resourceUsage().maxRSS * 1024),
      }
    }

    // ── Finalize SQL thật trên PGlite ──────────────────────────────────────────
    if (fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))) {
      const { PGlite } = await import('@electric-sql/pglite')
      const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
      report.pglite = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite', 'package.json'), 'utf8')).version
      const once = async (rows: Record<string, string>[], settings: string) => {
        const db: any = await L.freshDb(PGlite)
        await db.exec(settings)
        const batch = (await db.query(`INSERT INTO public.care_import_batches (period_month, file_name, file_sha256, row_count, created_by) VALUES ('2026-10-01', 'b.csv', $1, $2, $3) RETURNING id`,
          ['a'.repeat(64), rows.length, L.U.mkt])).rows[0].id
        let t = performance.now()
        for (let i = 0; i < rows.length; i += 2000) {
          await db.query(`INSERT INTO public.care_import_staging (batch_id, row_no, payload) SELECT $1, (x->>'n')::int, x->'p' FROM jsonb_array_elements($2::jsonb) x`,
            [batch, JSON.stringify(rows.slice(i, i + 2000).map((r, j) => ({ n: i + j + 2, p: Object.fromEntries(CARE_IMPORT_HEADERS.map((h) => [h, r[h]])) })))])
        }
        const stageMs = ms(t)
        t = performance.now()
        const r = (await db.query(`SELECT public.care__import_finalize_at($1, $2, '2026-10-01') r`, [batch, L.U.mkt])).rows[0].r
        const finalizeMs = ms(t)
        await db.close()
        expect(r.status).toBe('committed')
        return { stageMs, finalizeMs, customers: r.customers, created: r.created }
      }
      const rows = rowsQ121()
      const on = []
      for (let k = 0; k < 4; k++) on.push(await once(rows, 'SET enable_seqscan = on'))
      report.pglite_finalize_20k_seqscan_on = {
        rows: rows.length, customers: on[0].customers, stage_ms: stats(on.slice(1).map((x) => x.stageMs)), finalize_ms: stats(on.slice(1).map((x) => x.finalizeMs)),
      }
      const off = await once(rows, 'SET enable_seqscan = off')
      report.pglite_finalize_20k_seqscan_off_1run = { stage_ms: off.stageMs, finalize_ms: off.finalizeMs }
      // Mốc cũ 10k: fixture B2 (dòng hẹp, 5.000 khách) vs dữ liệu 15/10 (dòng rộng, 4.000 khách) — seqscan=off như PGlite mặc định.
      const b2 = buildCareImportRows({ customersPerStore: 210 }).slice(0, 10_000) as unknown as Record<string, string>[]
      const wide = rowsQ121(4000)
      report.explain_10k = {}
      for (const [name, rs] of [['b2_narrow', b2], ['wide_15_10', wide]] as const) {
        report.explain_10k[name] = {
          avg_row_json_bytes: Math.round(rs.reduce((s, r) => s + JSON.stringify(r).length, 0) / rs.length),
          seqscan_off_work_mem_4mb_ms: (await once(rs, `SET enable_seqscan = off; SET work_mem = '4MB'`)).finalizeMs,
          seqscan_off_work_mem_64mb_ms: (await once(rs, `SET enable_seqscan = off; SET work_mem = '64MB'`)).finalizeMs,
          seqscan_on_ms: (await once(rs, 'SET enable_seqscan = on')).finalizeMs,
        }
      }
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    console.log('CARE_BENCH ' + JSON.stringify(report))
  })
})
