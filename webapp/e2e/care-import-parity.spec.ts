import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import * as XLSX from 'xlsx'
import { CARE_IMPORT_HEADERS, type CareImportRow } from '../lib/care/import/contract'
import { parseCareImportXlsx } from '../lib/care/import/parse'
import { validateCareRows } from '../lib/care/import/validate'
import { buildCarePreview, type CareImportLookups, type CarePreview } from '../lib/care/import/preview'
import { buildCareImportRows } from './careImportFixture'

// CRM-CSKH B2 — PARITY preview (TS) ↔ finalize (SQL 114) trên PGlite.
// Cùng một file Excel: preview tính từ lookup đọc DB (đúng ngữ nghĩa
// lib/care/server/importRepo.ts) và finalize chạy thật trên migration 114.
// Kỳ vọng: preview có lỗi ⇔ finalize 'rejected' với CÙNG tập (dòng, mã);
// preview sạch ⇔ finalize 'committed' với CÙNG số đếm.
// Skip có lý do khi máy chưa cài PGlite (npm i --no-save @electric-sql/pglite@0.2.17).

const ROOT = path.resolve(__dirname, '..')
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any
type Lib = any

async function loadLookupsSql(db: Db, externalIds: string[], period: string, isTest: boolean): Promise<CareImportLookups> {
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as any[]
  const stores = await q(`SELECT id, code, name FROM public.stores WHERE store_type = 'os' AND is_active`)
  const staff = await q(`SELECT id, email, full_name, store_id FROM public.users WHERE role = 'staff' AND store_id = ANY($1::uuid[])`, [stores.map((s) => s.id)])
  const customers = await q(`SELECT id, external_id, is_test FROM public.care_customers WHERE external_id = ANY($1::text[])`, [externalIds])
  const cids = customers.map((c) => c.id)
  const refusals = await q(`SELECT customer_id, store_id FROM public.care_store_refusals WHERE customer_id = ANY($1::uuid[])`, [cids])
  const tasks = await q(`SELECT id, customer_id, status, store_id, assignee_id, customer_name, phone_norm, phone_raw, is_test, last_interaction_at
                         FROM public.care_tasks WHERE period_month = $1 AND customer_id = ANY($2::uuid[])`, [period, cids])
  const products = await q(`SELECT task_id, product_id, product_name, image_url, reason_type, reason_text FROM public.care_task_products
                            WHERE is_current AND task_id = ANY($1::uuid[])`, [tasks.map((t) => t.id)])
  const [{ n: cur }] = await q(`SELECT count(*)::int n FROM public.care_tasks WHERE period_month = $1 AND is_test = $2`, [period, isTest])
  const [{ n: prev }] = await q(`SELECT count(*)::int n FROM public.care_tasks WHERE status = 'open' AND period_month < $1`, [period])
  const byTask = new Map<string, any[]>()
  for (const p of products) byTask.set(p.task_id, [...(byTask.get(p.task_id) ?? []), {
    product_id: p.product_id, product_name: p.product_name, image_url: p.image_url, reason_type: p.reason_type, reason_text: p.reason_text,
  }])
  return {
    storesByCode: new Map(stores.map((s) => [s.code, { id: s.id, code: s.code, name: s.name }])),
    staff: staff.map((s) => ({ id: s.id, storeId: s.store_id, email: String(s.email).trim().toLowerCase(), fullName: s.full_name })),
    customers: new Map(customers.map((c) => [c.external_id, { id: c.id, isTest: c.is_test }])),
    refusals: new Set(refusals.map((r) => `${r.customer_id}|${r.store_id}`)),
    currentTasks: new Map(tasks.map((t) => [t.customer_id, {
      id: t.id, customerId: t.customer_id, status: t.status, storeId: t.store_id, assigneeId: t.assignee_id,
      customerName: t.customer_name, phoneNorm: t.phone_norm, phoneRaw: t.phone_raw, isTest: t.is_test,
      hasInteraction: t.last_interaction_at !== null, products: byTask.get(t.id) ?? [],
    }])),
    currentPeriodTaskCount: cur, openPreviousPeriodCount: prev,
  }
}

/** `numericPid(row, i)` trả format (vd. 'General', '0') ⇒ ô product_id dòng đó ghi dạng Number (Q-97). */
type XlsxOpts = { numericPid?: (row: Record<string, string>, i: number) => string | false }
function xlsxOf(rows: Record<string, string>[], opts: XlsxOpts = {}): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([[...CARE_IMPORT_HEADERS], ...rows.map((r) => CARE_IMPORT_HEADERS.map((h) => r[h] ?? ''))])
  for (const k of Object.keys(ws)) if (!k.startsWith('!')) { (ws[k] as XLSX.CellObject).t = 's' }
  const pid = CARE_IMPORT_HEADERS.indexOf('product_id')
  rows.forEach((r, i) => {
    const fmt = opts.numericPid?.(r, i)
    if (fmt) ws[XLSX.utils.encode_cell({ r: i + 1, c: pid })] = { t: 'n', v: Number(r.product_id), z: fmt }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'KhachHang')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}

/** Chạy một file qua preview TS rồi qua finalize SQL; trả cả hai để so. */
async function runBoth(db: Db, L: Lib, rows: Record<string, string>[], today: string, actor: string, opts: XlsxOpts = {}) {
  const bytes = xlsxOf(rows, opts)
  const parsed = parseCareImportXlsx(bytes)
  if (!parsed.ok) throw new Error(parsed.fileError)
  const validated = validateCareRows(parsed.rows)
  const period = `${today.slice(0, 7)}-01`
  const lookups = await loadLookupsSql(db, validated.customers.map((c) => c.externalId), period, false)
  const preview: CarePreview = buildCarePreview({ rowCount: parsed.rows.length, validated, parseErrors: parsed.errors, lookups, period, isTest: false })

  const sha = crypto.createHash('sha256').update(bytes).digest('hex')
  const batch = (await db.query(
    `INSERT INTO public.care_import_batches (period_month, file_name, file_sha256, row_count, created_by) VALUES ($1, 'parity.xlsx', $2, $3, $4) RETURNING id`,
    [period, sha, parsed.rows.length, actor])).rows[0].id
  for (const r of parsed.rows as CareImportRow[]) {
    await db.query(`INSERT INTO public.care_import_staging (batch_id, row_no, payload) VALUES ($1, $2, $3)`,
      [batch, r.rowNo, JSON.stringify(Object.fromEntries(CARE_IMPORT_HEADERS.map((h) => [h, r[h]])))])
  }
  const result = await L.finalize(db, batch, actor, today)
  return { preview, result }
}

const sortErr = (e: { row: number; code: string }[]) => e.map((x) => `${x.row}:${x.code}`).sort()
const COUNT_KEYS = ['created', 'updated', 'unchanged', 'skipped_has_interaction', 'owner_ignored', 'absent_kept', 'closed_previous_period'] as const

function expectParity(name: string, x: { preview: CarePreview; result: any }) {
  if (x.preview.errors.length > 0) {
    expect(x.result.status, name).toBe('rejected')
    expect(sortErr(x.result.errors), name).toEqual(sortErr(x.preview.errors))
  } else {
    expect(x.result.status, name).toBe('committed')
    for (const k of COUNT_KEYS) expect(x.result[k], `${name}: ${k}`).toBe(x.preview.counts[k])
  }
}

test.describe('care B2 — parity preview TS ↔ finalize SQL 114 (PGlite) @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')

  test('đầu kỳ · lỗi dữ liệu cần DB · file sửa · sang tháng: preview khớp finalize', async () => {
    test.setTimeout(240_000)
    const { PGlite } = await import('@electric-sql/pglite')
    const L: Lib = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const db = await L.freshDb(PGlite)
    const P10 = '2026-10-01'
    const stores = L.STORES as { code: string; assigneeEmails: string[] }[]
    const EA = stores[0].assigneeEmails[0], EB = stores[0].assigneeEmails[1]

    // 1) Đầu kỳ: fixture 25 store × 12 khách, 1–3 sản phẩm/khách.
    const fixture = buildCareImportRows({ customersPerStore: 12 }) as unknown as Record<string, string>[]
    const first = await runBoth(db, L, fixture, '2026-10-01', L.U.mkt)
    expectParity('đầu kỳ', first)
    expect(first.result.created).toBe(300)

    // 2) Lỗi cần DB (store/email/DNC/is_test) + lỗi thuần, cùng một file ⇒ cùng tập (dòng, mã).
    const custA = [...new Set(fixture.filter((r) => r.assignee_email === EA).map((r) => r.customer_external_id))]
    const tRef = await L.taskOf(db, custA[0], P10)
    await L.record(db, '2026-10-05', L.U.A, tRef.id, 'REFUSED', 'QA từ chối')   // DNC ở QAOS01
    await db.query(`INSERT INTO public.users (id, email, full_name, role, store_id) VALUES ($1, $2, 'QA trùng', 'staff', $3)`,
      [L.uid(8801), stores[4].assigneeEmails[0].toUpperCase(), L.storeId(5)])                // email mơ hồ ở QAOS05
    await db.query(`INSERT INTO public.care_customers (external_id, is_test) VALUES ('QA-TESTONLY', true)`)
    const row = (ext: string, store: string, email: string, pid: string, over: Record<string, string> = {}) =>
      ({ ...L.row(ext, store, email, pid), ...over }) as Record<string, string>
    const bad = [
      row('QA-P-STORE', 'QAOS99', EA, 'P1'),
      row('QA-P-NOSTAFF', 'QAOS01', 'khong.co@example.invalid', 'P1'),
      row('QA-P-AMB', 'QAOS05', stores[4].assigneeEmails[0], 'P1'),
      row('QA-TESTONLY', 'QAOS01', EA, 'P1'),
      row('QA-P-PHONE', 'QAOS01', EA, 'P1', { customer_phone: '0201234567' }),
      row('QA-P-DUP', 'QAOS01', EA, 'P1'), row('QA-P-DUP', 'QAOS01', EA, 'P1'),
      row('QA-P-INC', 'QAOS01', EA, 'P1'), row('QA-P-INC', 'QAOS01', EB, 'P2'),
      row('QA-P-OK', 'QAOS02', stores[1].assigneeEmails[0], 'P1'),
    ]
    // Khách đã từ chối ở QAOS01 nhưng task kỳ này đã tồn tại ⇒ SQL không báo REFUSED (task không đổi store);
    // kiểm REFUSED_AT_STORE ở bước sang tháng bên dưới.
    const errs = await runBoth(db, L, bad, '2026-10-06', L.U.mkt)
    expectParity('lỗi dữ liệu', errs)
    expect(new Set(errs.preview.errors.map((e) => e.code))).toEqual(new Set(['STORE_INVALID', 'ASSIGNEE_INVALID', 'ASSIGNEE_AMBIGUOUS', 'TEST_FLAG_MISMATCH', 'PHONE_INVALID', 'DUPLICATE_PRODUCT', 'INCONSISTENT_CUSTOMER']))

    // 3) File sửa cùng tháng: đổi lý do, đổi tên, khách đã có lượt, đổi dược sĩ, khách vắng, khách mới.
    const custB = [...new Set(fixture.filter((r) => r.assignee_email === EB).map((r) => r.customer_external_id))]
    await L.record(db, '2026-10-07', L.U.B, (await L.taskOf(db, custB[0], P10)).id, 'CALLBACK', 'QA hẹn', '2026-10-20')
    const byCust = (ext: string) => fixture.filter((r) => r.customer_external_id === ext)
    const revision = [
      ...byCust(custB[0]).map((r) => ({ ...r, reason_text: 'không được áp' })),    // đã có lượt ⇒ giữ
      ...byCust(custB[1]).map((r) => ({ ...r, reason_text: `${r.reason_text} (sửa)` })), // đổi lý do ⇒ cập nhật
      ...byCust(custB[2]).map((r) => ({ ...r, customer_name: 'KH đổi tên' })),     // đổi tên ⇒ cập nhật
      ...byCust(custB[3]).map((r) => ({ ...r, assignee_email: EA })),               // đổi dược sĩ ⇒ owner_ignored
      ...byCust(custB[4]),                                                          // không đổi
      row('QA-P-NEW', 'QAOS01', EA, 'P1'),                                          // mới
    ]
    const rev = await runBoth(db, L, revision, '2026-10-08', L.U.mkt)
    expectParity('file sửa', rev)
    expect(rev.result).toMatchObject({ created: 1, updated: 2, skipped_has_interaction: 1, owner_ignored: 1 })

    // 4) Sang tháng: khách đã từ chối ở QAOS01 ⇒ REFUSED_AT_STORE (cả batch); sang QAOS02 ⇒ nhận; đóng kỳ T10.
    const nov1 = await runBoth(db, L, [row(custA[0], 'QAOS01', EA, 'P1'), row('QA-P-N2', 'QAOS01', EA, 'P1')], '2026-11-01', L.U.mkt)
    expectParity('T11 vào store đã từ chối', nov1)
    expect(nov1.preview.errors.map((e) => e.code)).toEqual(['REFUSED_AT_STORE'])
    const nov2 = await runBoth(db, L, [row(custA[0], 'QAOS02', stores[1].assigneeEmails[0], 'P1'), row('QA-P-N2', 'QAOS01', EA, 'P1')], '2026-11-01', L.U.mkt)
    expectParity('T11 store khác + đóng kỳ', nov2)
    expect(nov2.result.closed_previous_period).toBeGreaterThan(0)
    await db.close()
  })

  test('Q-97: product_id ô Number (General 4/7/12/15 chữ số, format "0") ⇒ preview = finalize, cùng chuỗi ID như Text', async () => {
    test.setTimeout(240_000)
    const { PGlite } = await import('@electric-sql/pglite')
    const L: Lib = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const db = await L.freshDb(PGlite)
    const EA = (L.STORES as { assigneeEmails: string[] }[])[0].assigneeEmails[0]
    const rows = [
      L.row('QA-N1', 'QAOS01', EA, '1234'), L.row('QA-N1', 'QAOS01', EA, '1234567'),
      L.row('QA-N2', 'QAOS01', EA, '123456789012'), L.row('QA-N3', 'QAOS01', EA, '123456789012345'),
    ] as Record<string, string>[]
    // Lần 1: mọi product_id là ô Number (dòng cuối format "0", còn lại General ⇒ hiển thị dạng mũ từ 12 chữ số).
    const num = await runBoth(db, L, rows, '2026-10-02', L.U.mkt, { numericPid: (_r, i) => (i === 3 ? '0' : 'General') })
    expect(num.preview.errors).toEqual([])
    expectParity('Number', num)
    expect(num.result.created).toBe(3)
    const ids = (await db.query(`SELECT p.product_id FROM public.care_task_products p WHERE p.is_current ORDER BY 1`)).rows.map((x: any) => x.product_id)
    expect(ids).toEqual(['1234', '1234567', '123456789012', '123456789012345'])
    // Lần 2: cùng nội dung nhưng ô Text ⇒ finalize thấy y hệt ⇒ không đổi gì (khác hash nên không phải duplicate).
    const txt = await runBoth(db, L, rows, '2026-10-03', L.U.mkt)
    expectParity('Text cùng ID', txt)
    expect(txt.result).toMatchObject({ created: 0, updated: 0, unchanged: 3 })
    // Text + Number cùng (khách, product_id) ⇒ DUPLICATE_PRODUCT ở cả preview lẫn finalize.
    const dupRows = [L.row('QA-N9', 'QAOS01', EA, '7654321'), L.row('QA-N9', 'QAOS01', EA, '7654321', { reason_text: 'khác' })] as Record<string, string>[]
    const dup = await runBoth(db, L, dupRows, '2026-10-04', L.U.mkt, { numericPid: (_r, i) => (i === 0 ? 'General' : false) })
    expectParity('Text + Number trùng', dup)
    expect(dup.preview.errors.map((e) => e.code)).toEqual(['DUPLICATE_PRODUCT', 'DUPLICATE_PRODUCT'])
    // Q-104: Text "0"/"00" và Number 0 ⇒ PRODUCT_ID_INVALID ở CẢ preview lẫn finalize (cùng tập dòng/mã).
    const zeroRows = [L.row('QA-Z1', 'QAOS01', EA, '0'), L.row('QA-Z2', 'QAOS01', EA, '00'), L.row('QA-Z3', 'QAOS01', EA, '0'),
      L.row('QA-Z4', 'QAOS01', EA, '0042')] as Record<string, string>[]
    const zero = await runBoth(db, L, zeroRows, '2026-10-05', L.U.mkt, { numericPid: (_r, i) => (i === 2 ? 'General' : false) })
    expectParity('Q-104 product_id toàn số 0', zero)
    expect(zero.preview.errors.map((e) => `${e.row}:${e.code}`)).toEqual(['2:PRODUCT_ID_INVALID', '3:PRODUCT_ID_INVALID', '4:PRODUCT_ID_INVALID'])
    await db.close()
  })
})
