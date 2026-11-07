import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import {
  CMS_I4_COMPARE_STEPS, CMS_I4_DECISION_FIELDS, CMS_I4_ROWS_FP_VERSION, cmsI4CompareMarkdown, cmsI4CompareSource, cmsI4CompareSummary,
  cmsI4LinesById, cmsI4ParseEvidenceMeta, cmsI4RowsFp, cmsI4RowsFpText, cmsI4ScopeHash, type CmsI4CompareSteps, type CmsI4EvidenceMeta,
} from './cmsI4CompareSource'
import { cmsI4ExportSql, cmsI4ParseContext, cmsI4ReadCsv, type CmsI4Context } from './cmsI4Offline'
import { CMS_SALES_COLUMNS, normalizeSalesRow, type CmsRawRow, type CmsSalesLine } from '../lib/cms/source/contract'
import { buildCmsSalesQuery } from '../lib/cms/source/bigquery'

// CMS I4-FINAL — compare-source (PM work order `planning/research/cms-i4-final-work-order-2026-11-04.md` §3.3 AC 1–10; review
// `planning/reviews/2026-11-04-cms-dee938a-i4-final-pm.md` §3). THUẦN + CLI tiến trình con: dữ liệu GIẢ (@example.test, ID 9xxxxx),
// file tạm NGOÀI Git, không mạng, không DB.

const WEBAPP = path.resolve(__dirname, '..')
const FX = path.join(WEBAPP, 'e2e', 'fixtures', 'cms-i4')
const CLI = path.join(WEBAPP, 'scripts', 'cms-i4-offline.mjs')
const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const readFx = (n: string) => fs.readFileSync(path.join(FX, n))
const fxRows = (n: string): CmsRawRow[] => {
  const c = cmsI4ReadCsv(new Uint8Array(readFx(n)), CMS_SALES_COLUMNS)
  if (!c.ok) throw new Error(c.reason)
  return c.rows
}
const CTX: CmsI4Context = (() => { const c = cmsI4ParseContext(JSON.parse(readFx('context.json').toString('utf8'))); if (!c.ok) throw new Error(c.reason); return c.value })()
const SCOPE = { startDate: '2026-11-01', endDate: '2026-11-30', productIds: ['900001', '900002'] }
const AS_OF = '2026-12-01T03:00:00Z'
const meta = (refSha: string, appSha: string, o: { ref?: Partial<CmsI4EvidenceMeta['reference']>; app?: Partial<CmsI4EvidenceMeta['app']> } = {}): CmsI4EvidenceMeta => ({
  version: 1,
  reference: { inputKind: 'reference_source', source: 'nguồn gốc giả', exportedAt: '2026-12-01T04:00:00Z', asOf: AS_OF, fileSha256: refSha, scope: SCOPE, runId: null, ...o.ref },
  app: { inputKind: 'bi_view', source: 'view CMS giả', exportedAt: '2026-12-01T04:05:00Z', asOf: AS_OF, fileSha256: appSha, scope: SCOPE, runId: null, ...o.app },
})
const H_REF = 'a'.repeat(64), H_APP = 'b'.repeat(64)
/** So với metadata hợp lệ (hash giả khớp) — để từng ca chỉ đổi đúng một yếu tố. */
const cmp = (ref: CmsRawRow[], app: CmsRawRow[], steps?: CmsI4CompareSteps, m: CmsI4EvidenceMeta | null = meta(H_REF, H_APP)) =>
  cmsI4CompareSource({ context: CTX, reference: { rows: ref, fileSha256: H_REF }, app: { rows: app, fileSha256: H_APP }, meta: m }, steps)
const REF = fxRows('reference.csv')
const APP = fxRows('sales.csv')
const set = (rows: CmsRawRow[], id: string, o: Partial<CmsRawRow>) => rows.map((r) => (r.order_line_id === id ? { ...r, ...o } : r))
const row = (o: Partial<CmsRawRow>): CmsRawRow => ({
  order_line_id: '7100001', order_id: 'O7100001', order_code: 'SO7100001', product_id: '900001', seller_email: 'ds.a@example.test', pos_code: 'POS-T1',
  order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: '2026-11-15T03:00:00.000000Z', quantity_raw: '1', uom_raw: 'Hộp',
  base_quantity: '30', gmv_amount: '120000', source_updated_at: '2026-11-15T03:00:00.000000Z', ...o,
})

test.describe('CMS I4-FINAL compare-source · AC 1–8 (lõi thuần) @desktop', () => {
  test('AC1: hai tập khớp đủ scope ⇒ MATCH; đảo thứ tự dòng ⇒ cùng kết quả / cùng vân tay; khác mốc nạp chỉ là khác trường audit', () => {
    const r = cmp(REF, APP)
    expect([r.verdict, r.dataIssues, r.notProven]).toEqual(['MATCH', [], []])
    expect(r.compare).toMatchObject({ matched: 10, missing: 0, extra: 0, changed: 0, infoDiffByField: { source_updated_at_us: 1 } })
    expect([r.reference.inScope, r.app.inScope, r.app.outOfScope, r.reference.candidates]).toEqual([10, 10, 1, 8])
    expect(r.reference.decisionFp).toBe(r.app.decisionFp)
    expect(r.reference.rowsFp).not.toBe(r.app.rowsFp) // 14 trường gồm mốc nạp — không đồng nhất với phép so quyết định
    const shuffled = cmp([...REF].reverse(), [...APP].sort((a, b) => String(b.gmv_amount).localeCompare(String(a.gmv_amount))))
    expect(cmsI4CompareSummary(shuffled)).toEqual(cmsI4CompareSummary(r))
    expect(r.limits).toEqual(['SOURCE_HISTORY_NOT_VERIFIED', 'BIGQUERY_PAGES_NOT_VERIFIED', 'RUN_BINDING_NOT_PROVEN'])
    expect(r.runBinding).toEqual({ claimedRunId: null, verifiedAgainstDb: false })
  })

  test('AC2: thiếu 1 ID / thừa 1 ID / cùng số dòng nhưng khác ID ⇒ MISMATCH (đếm bằng nhau không đủ)', () => {
    const miss = cmp(REF, APP.filter((x) => x.order_line_id !== '7000004'))
    expect([miss.verdict, miss.dataIssues, miss.details.missing]).toEqual(['MISMATCH', ['MISSING_LINES'], ['7000004']])
    const extra = cmp(REF, [...APP, row({})])
    expect([extra.verdict, extra.dataIssues, extra.details.extra]).toEqual(['MISMATCH', ['EXTRA_LINES'], ['7100001']])
    const swapId = cmp(REF, set(APP, '7000004', { order_line_id: '7000099' }))
    expect([swapId.reference.inScope, swapId.app.inScope]).toEqual([10, 10])
    expect(swapId.totals.all.equal).toBe(true)
    expect([swapId.verdict, swapId.details.missing, swapId.details.extra]).toEqual(['MISMATCH', ['7000004'], ['7000099']])
  })

  test('AC3: cùng ID khác người bán / SP / GMV / lượng / thời gian / trạng thái ⇒ lệch; hai lệch bù nhau làm tổng bằng vẫn bị bắt', () => {
    const cases: [Partial<CmsRawRow>, string][] = [
      [{ seller_email: 'ds.b@example.test' }, 'seller_email'], [{ product_id: '900002' }, 'product_id'], [{ gmv_amount: '120001' }, 'gmv_amount_e9'],
      [{ base_quantity: '31' }, 'base_quantity_e9'], [{ completed_at: '2026-11-07T03:00:00.000001Z' }, 'completed_at_us'],
      [{ order_status: 'CANCELLED' }, 'order_status'], [{ order_type: 'OFFLINE_X' }, 'order_type'], [{ order_id: 'O9' }, 'order_id'], [{ order_code: 'SO9' }, 'order_code'],
    ]
    for (const [o, f] of cases) {
      const r = cmp(REF, set(APP, '7000005', o))
      expect([r.verdict, r.details.changed], f).toEqual(['MISMATCH', [{ orderLineId: '7000005', fields: [f] }]])
    }
    // Đổi GMV giữa hai dòng cùng SP: tổng theo SP / toàn tập vẫn bằng, từng dòng lệch.
    const swap = cmp(REF, set(set(APP, '7000009', { gmv_amount: '450000' }), '7000010', { gmv_amount: '750000' }))
    expect(swap.totals.all.equal).toBe(true)
    expect(swap.totals.byProduct.every((x) => x.equal)).toBe(true)
    expect([swap.verdict, swap.compare.changed, swap.compare.changedByField]).toEqual(['MISMATCH', 2, { gmv_amount_e9: 2 }])
    // Trạng thái lệch không bị che bằng lọc ứng viên một phía: ứng viên khác nhau và vẫn là lệch trường.
    const st = cmp(REF, set(APP, '7000011', { order_status: 'COMPLETED' }))
    expect([st.verdict, st.reference.candidates, st.app.candidates, st.compare.changedByField]).toEqual(['MISMATCH', 8, 9, { order_status: 1 }])
  })

  test('AC4: trùng order_line_id ở một bên ⇒ MISMATCH, không DISTINCT; hai dòng cùng đơn + SP khác ID đều giữ', () => {
    const dup = cmp(REF, [...APP, APP[3]])
    expect(dup.verdict).toBe('MISMATCH')
    expect(dup.dataIssues).toContain('DUPLICATE_LINE_ID:app')
    expect(dup.details.duplicates).toEqual([{ side: 'app', orderLineId: '7000004' }])
    const twin = (rows: CmsRawRow[]) => [...rows, row({ order_line_id: '7100001', order_id: 'O77' }), row({ order_line_id: '7100002', order_id: 'O77' })]
    const ok = cmp(twin(REF), twin(APP))
    expect([ok.verdict, ok.compare.matched, ok.reference.inScope]).toEqual(['MATCH', 12, 12])
  })

  test('AC5: ID 19 chữ số, số lẻ 9 chữ số, micro giây, ranh ngày VN giữ chính xác (BigInt, không float)', () => {
    const big = (o: Partial<CmsRawRow>) => row({ order_line_id: '9007199254740993123', ...o })
    expect(cmp([...REF, big({})], [...APP, big({ order_line_id: '9007199254740993124' })]).details.missing).toEqual(['9007199254740993123'])
    const dec = cmp([...REF, big({ base_quantity: '10.123456789' })], [...APP, big({ base_quantity: '10.123456788' })])
    expect([dec.verdict, dec.compare.changedByField]).toEqual(['MISMATCH', { base_quantity_e9: 1 }])
    expect(cmp([...REF, big({ gmv_amount: '120000.000000000' })], [...APP, big({ gmv_amount: '120000' })]).verdict).toBe('MATCH')
    const us = cmp([...REF, big({ completed_at: '2026-11-15T03:00:00.000001Z' })], [...APP, big({ completed_at: '2026-11-15T03:00:00.000002Z' })])
    expect(us.compare.changedByField).toEqual({ completed_at_us: 1 })
    // Ranh kỳ VN: 31/10 23:59:59,999999 VN ngoài; 01/11 00:00 VN trong; 30/11 23:59:59,999999 VN trong; 01/12 00:00 VN ngoài.
    const edges = [['E1', '2026-10-31T16:59:59.999999Z'], ['E2', '2026-10-31T17:00:00.000000Z'], ['E3', '2026-11-30T16:59:59.999999Z'], ['E4', '2026-11-30T17:00:00.000000Z']]
    const e = cmp(REF, [...APP, ...edges.map(([id, t]) => row({ order_line_id: id, completed_at: t }))])
    expect(e.details.extra).toEqual(['E2', 'E3'])
    expect(e.app.outOfScope).toBe(3) // 7000007 + E1 + E4
  })

  test('AC6: email chỉ khác hoa / thường / khoảng trắng ⇒ khớp (đúng normalize app); khác người ⇒ lệch', () => {
    expect(cmp(REF, set(APP, '7000004', { seller_email: '  DS.B@Example.TEST ' })).verdict).toBe('MATCH')
    expect(cmp(REF, set(APP, '7000004', { seller_email: 'ds.b2@example.test' })).details.changed).toEqual([{ orderLineId: '7000004', fields: ['seller_email'] }])
    expect(cmp(REF, set(APP, '7000004', { seller_email: null })).details.changed).toEqual([{ orderLineId: '7000004', fields: ['seller_email'] }])
  })

  test('AC7: rỗng / 0 ứng viên ⇒ NOT_PROVEN (0 = 0 không là chứng nhận); lỗi dòng / ProductID không canonical ⇒ MISMATCH', () => {
    const empty = cmp([], [])
    expect([empty.verdict, empty.notProven]).toEqual(['NOT_PROVEN', ['EMPTY_REFERENCE', 'EMPTY_APP', 'NO_CANDIDATES']])
    expect(cmsI4CompareSummary(empty).compare).toMatchObject({ matched: 0, missing: 0, extra: 0, changed: 0 })
    const online = (rows: CmsRawRow[]) => rows.map((r) => ({ ...r, order_type: 'ONLINE' }))
    const noCand = cmp(online(REF), online(APP))
    expect([noCand.verdict, noCand.notProven]).toEqual(['NOT_PROVEN', ['NO_CANDIDATES']])
    const bad = cmp(set(REF, '7000004', { gmv_amount: null }), APP)
    expect(bad.verdict).toBe('MISMATCH')
    expect(bad.dataIssues).toEqual(['ROW_ISSUES:reference', 'EXTRA_LINES']) // dòng tham chiếu hỏng không vào so ⇒ app thấy "thừa"
    expect(bad.reference.issues).toEqual({ 'MISSING_FIELD:gmv_amount': 1 })
    const lead = cmp(set(REF, '7000004', { product_id: '0900001' }), APP)
    expect([lead.verdict, lead.dataIssues]).toEqual(['MISMATCH', ['NON_CANONICAL_PRODUCT_ID:reference']])
    const exp = cmp(set(REF, '7000004', { base_quantity: '1.5e1' }), APP)
    expect(exp.dataIssues).toEqual(['UNCONVERTED_UNITS:reference', 'EXTRA_LINES']) // số dạng mũ ở base_quantity — cùng mã held của quality.ts
  })

  test('AC8: thiếu metadata / khác scope / khác mốc / xuất trước mốc / hash byte khác ⇒ NOT_PROVEN, tách khỏi lỗi dữ liệu; published_run chưa xác minh run', () => {
    expect(cmp(REF, APP, undefined, null)).toMatchObject({ verdict: 'NOT_PROVEN', notProven: ['NO_EVIDENCE_META'] })
    const one = { ...SCOPE, productIds: ['900001'] }
    expect(cmp(REF, APP, undefined, meta(H_REF, H_APP, { app: { scope: one } })).notProven).toEqual(['SCOPE_MISMATCH:app'])
    expect(cmp(REF, APP, undefined, meta(H_REF, H_APP, { ref: { scope: { ...SCOPE, endDate: '2026-11-29' } } })).notProven).toEqual(['SCOPE_MISMATCH:reference'])
    expect(cmp(REF, APP, undefined, meta(H_REF, H_APP, { app: { asOf: '2026-12-01T03:00:01Z' } })).notProven).toEqual(['AS_OF_MISMATCH'])
    expect(cmp(REF, APP, undefined, meta(H_REF, H_APP, { app: { asOf: '2026-12-01T03:00:00.000001Z' } })).notProven).toEqual(['AS_OF_MISMATCH']) // khác micro giây
    expect(cmp(REF, APP, undefined, meta(H_REF, H_APP, { ref: { exportedAt: '2026-12-01T02:59:59Z' } })).notProven).toEqual(['EXPORTED_BEFORE_AS_OF:reference'])
    expect(cmp(REF, APP, undefined, meta('c'.repeat(64), H_APP)).notProven).toEqual(['FILE_SHA_MISMATCH:reference'])
    // Thứ tự ProductID trong metadata không quan trọng; mốc ISO tương đương (có / không phần lẻ) coi là cùng mốc.
    expect(cmp(REF, APP, undefined, meta(H_REF, H_APP, { app: { scope: { ...SCOPE, productIds: ['900002', '900001'] }, asOf: '2026-12-01T03:00:00.000000Z' } })).verdict).toBe('MATCH')
    // Lỗi dữ liệu + metadata lệch ⇒ MISMATCH (dữ liệu ưu tiên), vẫn liệt kê phần chưa chứng minh.
    const both = cmp(REF, APP.slice(1), undefined, meta(H_REF, H_APP, { app: { asOf: '2026-12-01T02:00:00Z' } }))
    expect([both.verdict, both.notProven]).toEqual(['MISMATCH', ['AS_OF_MISMATCH']])
    const run = cmp(REF, APP, undefined, meta(H_REF, H_APP, { app: { inputKind: 'published_run', runId: '00000000-0000-4000-8000-000000000123' } }))
    expect([run.verdict, run.runBinding, run.limits[2]]).toEqual(['MATCH', { claimedRunId: '00000000-0000-4000-8000-000000000123', verifiedAgainstDb: false }, 'RUN_BINDING_UNVERIFIED'])
    expect(cmsI4ScopeHash(SCOPE)).toBe(cmsI4ScopeHash({ ...SCOPE, productIds: ['900002', '900001', '900001'] }))
  })

  test('metadata: sai dạng bị từ chối với lý do (CLI ⇒ rc 2); inputKind phân biệt nguồn độc lập / view / run', () => {
    const good = JSON.parse(readFx('evidence-meta.json').toString('utf8'))
    expect(cmsI4ParseEvidenceMeta(good).ok).toBe(true)
    const bad: [unknown, RegExp][] = [
      [null, /object/], [{ ...good, version: 2 }, /version/],
      [{ ...good, reference: { ...good.reference, inputKind: 'bi_view' } }, /reference\.inputKind/],
      [{ ...good, app: { ...good.app, inputKind: 'reference_source' } }, /app\.inputKind/],
      [{ ...good, app: { ...good.app, fileSha256: 'ABC' } }, /fileSha256/],
      [{ ...good, app: { ...good.app, asOf: '2026-12-01 03:00' } }, /asOf/],
      [{ ...good, app: { ...good.app, scope: { ...good.app.scope, productIds: ['SKU1'] } } }, /scope/],
      [{ ...good, app: { ...good.app, inputKind: 'published_run' } }, /runId/],
      [{ ...good, app: { ...good.app, runId: '00000000-0000-4000-8000-000000000123' } }, /runId/],
      [{ ...good, reference: { ...good.reference, source: ' ' } }, /source/],
    ]
    for (const [j, re] of bad) {
      const r = cmsI4ParseEvidenceMeta(j)
      expect(r.ok, JSON.stringify(j)?.slice(0, 80)).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(re)
    }
  })
})

test.describe('CMS I4-FINAL compare-source · vân tay chuẩn + đột biến bộ so (AC 10) @desktop', () => {
  const line = (o: Partial<CmsRawRow>): CmsSalesLine => { const n = normalizeSalesRow(row(o)); if (!n.ok) throw new Error(JSON.stringify(n.issues)); return n.value }

  test(`vector byte / hash cố định (${CMS_I4_ROWS_FP_VERSION}): scale 9 nguyên, micro giây nguyên, null rõ ràng, sắp theo byte`, () => {
    const a = line({ order_line_id: '9007199254740993123', seller_email: null, base_quantity: '10.5', gmv_amount: '42000', completed_at: '2026-11-03T02:15:30.123456Z' })
    const b = line({ order_line_id: '10', order_id: 'O"10', order_code: 'SO,10', product_id: '900002', seller_email: ' DS.B@Example.Test', base_quantity: '3', gmv_amount: '450000.000000001', completed_at: '2026-11-05T08:00:00Z' })
    const text = cmsI4RowsFpText([a, b], CMS_I4_DECISION_FIELDS)
    expect(text).toBe([
      'cms-rows-fp-v1',
      'order_line_id,order_id,order_code,product_id,seller_email,order_type,order_status,completed_at_us,base_quantity_e9,gmv_amount_e9',
      '["10","O\\"10","SO,10","900002","ds.b@example.test","OFFLINE","COMPLETED","1793865600000000","3000000000","450000000000001"]',
      '["9007199254740993123","O7100001","SO7100001","900001",null,"OFFLINE","COMPLETED","1793672130123456","10500000000","42000000000000"]',
      '',
    ].join('\n'))
    // Đối chiếu độc lập phần thời gian (không dùng parser của app).
    expect(BigInt(Date.UTC(2026, 10, 5, 8)) * BigInt(1000)).toBe(BigInt('1793865600000000'))
    expect(BigInt(Date.UTC(2026, 10, 3, 2, 15, 30)) * BigInt(1000) + BigInt(123456)).toBe(BigInt('1793672130123456'))
    expect(cmsI4RowsFp([a, b], CMS_I4_DECISION_FIELDS)).toBe(sha(Buffer.from(text, 'utf8')))
    expect(cmsI4RowsFp([a, b], CMS_I4_DECISION_FIELDS)).toBe('627e130a7056fda21fcc93eb2774eb92bc2086734afe07ebc05f76697745bc44')
    expect(cmsI4RowsFp([b, a], CMS_I4_DECISION_FIELDS)).toBe(cmsI4RowsFp([a, b], CMS_I4_DECISION_FIELDS))
    // Phân cách không va chạm: dấu phẩy / nháy trong giá trị không trộn trường.
    const c1 = line({ order_line_id: 'X', order_id: 'A,B', order_code: 'C' }), c2 = line({ order_line_id: 'X', order_id: 'A', order_code: 'B,C' })
    expect(cmsI4RowsFp([c1], CMS_I4_DECISION_FIELDS)).not.toBe(cmsI4RowsFp([c2], CMS_I4_DECISION_FIELDS))
    // Sắp theo BYTE UTF-8, không localeCompare / UTF-16: 'B' (0x42) < 'a' (0x61) < 'é' (0xC3…) < '𝟘' (0xF0…); locale sẽ xếp a < B.
    expect(['a', 'B'].sort((x, y) => x.localeCompare(y))).toEqual(['a', 'B'])
    const order = cmsI4RowsFpText(['𝟘', 'é', 'a', 'B'].map((id) => line({ order_line_id: id })), ['order_line_id']).split('\n').slice(2, 6)
    expect(order).toEqual(['["B"]', '["a"]', '["é"]', '["𝟘"]'])
    // Số âm giữ dấu, nguyên scale 9 (dòng trả / điều chỉnh tương lai).
    expect(cmsI4RowsFpText([line({ base_quantity: '-1.5', gmv_amount: '-0.000000001' })], ['base_quantity_e9', 'gmv_amount_e9'])).toContain('["-1500000000","-1"]')
    // null ≠ chuỗi rỗng sau normalize (app đổi rỗng thành null — cả hai bên cùng null).
    expect(cmsI4RowsFpText([line({ seller_email: '' })], ['seller_email'])).toContain('[null]')
  })

  // Bộ ca phải bắt: mỗi đột biến PHẢI làm ít nhất một ca lệch thành MATCH (chứng minh test không xanh oan).
  const scenarios: [string, CmsRawRow[], CmsRawRow[]][] = [
    ['thiếu 1 dòng', REF, APP.filter((x) => x.order_line_id !== '7000004')],
    ['khác ID cùng số dòng', REF, set(APP, '7000004', { order_line_id: '7000099' })],
    ['sai người bán', REF, set(APP, '7000004', { seller_email: 'ds.a@example.test' })],
    ['đổi GMV bù tổng', REF, set(set(APP, '7000009', { gmv_amount: '450000' }), '7000010', { gmv_amount: '750000' })],
    ['lệch số lẻ', [...REF, row({ base_quantity: '10.4' })], [...APP, row({ base_quantity: '10.1' })]],
    ['lệch dòng không eligible (CANCELLED)', REF, set(APP, '7000011', { gmv_amount: '1' })],
    ['trùng ID trong scope', [...REF, row({}), row({ gmv_amount: '1' })], [...APP, row({})]],
  ]
  const mutants: [string, CmsI4CompareSteps][] = [
    ['bỏ anti-join', { ...CMS_I4_COMPARE_STEPS, antiJoin: () => ({ missing: [], extra: [] }) }],
    ['chỉ so số dòng', { ...CMS_I4_COMPARE_STEPS, antiJoin: (r, a) => (r.size === a.size ? { missing: [], extra: [] } : CMS_I4_COMPARE_STEPS.antiJoin(r, a)) }],
    ['bỏ so người bán', { ...CMS_I4_COMPARE_STEPS, diff: (a, b) => CMS_I4_COMPARE_STEPS.diff(a, b).filter((f) => f !== 'seller_email') }],
    ['chỉ so tổng', { ...CMS_I4_COMPARE_STEPS, antiJoin: (r, a) => (r.size === a.size ? { missing: [], extra: [] } : CMS_I4_COMPARE_STEPS.antiJoin(r, a)), diff: () => [] }],
    ['làm tròn số', { ...CMS_I4_COMPARE_STEPS, num: (u) => (u / BigInt(1_000_000_000)).toString() }],
    ['lọc ứng viên trước khi so', { ...CMS_I4_COMPARE_STEPS, select: (ls) => ls.filter((l) => l.orderType === 'OFFLINE' && l.orderStatus === 'COMPLETED') }],
  ]
  test('mỗi ca lệch ⇒ bộ so thật MISMATCH', () => {
    for (const [name, r, a] of scenarios) expect(cmp(r, a).verdict, name).toBe('MISMATCH')
  })
  for (const [name, steps] of mutants) {
    test(`đột biến "${name}" bị bắt (ít nhất một ca lệch thành MATCH)`, () => {
      const escaped = scenarios.filter(([, r, a]) => cmp(r, a, steps).verdict === 'MATCH').map(([n]) => n)
      expect(escaped.length, name).toBeGreaterThan(0)
    })
  }
  test('đột biến "DISTINCT ID trùng" ở bộ so KHÔNG lọt: gate I4 (cmsI4CheckSales) vẫn báo DUPLICATE_LINE_ID — hai lớp độc lập', () => {
    const distinct: CmsI4CompareSteps = { ...CMS_I4_COMPARE_STEPS, index: (ls) => ({ byId: new Map(ls.map((l) => [l.orderLineId, l] as const)), dupIds: [] }) }
    const r = cmp([...REF, row({}), row({})], [...APP, row({})], distinct) // trùng y hệt ⇒ không còn lệch trường để che
    expect([r.verdict, r.dataIssues]).toEqual(['MISMATCH', ['DUPLICATE_LINE_ID:reference']])
    expect(r.reference.duplicateLineIds).toBe(0) // lớp bộ so đã bị đột biến tắt — lớp gate vẫn chặn
  })
})

test.describe('CMS I4-FINAL compare-source · SQL xuất + CLI harness (AC 9) @desktop', () => {
  let tmp = ''
  test.beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-i4-cmp-')) })
  test.afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: WEBAPP, encoding: 'utf8', timeout: 60_000 })
    return { rc: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const json = (out: string) => {
    const l = out.split(/\r?\n/).find((x) => x.startsWith('I4 compare-source '))
    if (!l) throw new Error(out)
    return JSON.parse(l.slice('I4 compare-source '.length))
  }
  const fx = (flag: string, n: string) => `--${flag}=${path.join(FX, n)}`
  const csv = (rows: CmsRawRow[]) => [CMS_SALES_COLUMNS.join(','), ...rows.map((r) => CMS_SALES_COLUMNS.map((c) => (r[c] === null || r[c] === undefined ? '' : `"${String(r[c]).replace(/"/g, '""')}"`)).join(','))].join('\n') + '\n'
  const put = (name: string, body: string | Buffer) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p }

  test('SQL xuất phía view (scope): NGUYÊN SELECT + WHERE kỳ / SP của app, không lọc email / trạng thái, không LIMIT', () => {
    const s = cmsI4ExportSql('scope').split('\n')
    const app = buildCmsSalesQuery({ table: 'bi-project.buymed_tech.CMS_SALES_VIEW', fromMicros: BigInt(1), toMicrosExclusive: BigInt(2), productIds: ['1'] }).sql.split('\n')
    expect(s).toEqual([app[0], app[1], app[2], app[3], 'ORDER BY completed_at, order_line_id'])
    expect(s.join('\n')).not.toMatch(/seller_emails|employee_email\)\)|order_status\s*=|order_type\s*=|LIMIT/)
  })

  test('fixture giả: KHỚP + metadata ⇒ rc 0; không metadata ⇒ rc 1 NOT_PROVEN; stdout không email / không chi tiết dòng', () => {
    const ok = cli('compare-source', fx('reference', 'reference.csv'), fx('app', 'sales.csv'), fx('context', 'context.json'), fx('evidence-meta', 'evidence-meta.json'))
    expect(ok.rc).toBe(0)
    const j = json(ok.out)
    expect(j).toMatchObject({ accepted: true, verdict: 'MATCH', notProven: [], dataIssues: [] })
    expect([j.reference.fileSha256, j.app.fileSha256]).toEqual([sha(readFx('reference.csv')), sha(readFx('sales.csv'))])
    expect(j.details).toBeUndefined()
    const noMeta = cli('compare-source', fx('reference', 'reference.csv'), fx('app', 'sales.csv'), fx('context', 'context.json'))
    expect([noMeta.rc, json(noMeta.out).verdict, json(noMeta.out).notProven]).toEqual([1, 'NOT_PROVEN', ['NO_EVIDENCE_META']])
    for (const o of [ok.out, noMeta.out]) expect(o).not.toMatch(/@example\.test|ds\.a|ds\.b|qlch/i)
  })

  test('lệch dữ liệu ⇒ rc 1; --out ngoài Git có chi tiết, email đã che; không ghi đè file có sẵn', () => {
    const ref = put('ref.csv', csv(REF))
    const app = put('app.csv', csv(set(APP.filter((x) => x.order_line_id !== '7000008'), '7000004', { seller_email: 'ds.a@example.test' })))
    const m = put('meta.json', JSON.stringify(meta(sha(fs.readFileSync(ref)), sha(fs.readFileSync(app)))))
    const out = path.join(tmp, 'cmp.md')
    const r = cli('compare-source', `--reference=${ref}`, `--app=${app}`, fx('context', 'context.json'), `--evidence-meta=${m}`, `--out=${out}`)
    expect(r.rc).toBe(1)
    expect(json(r.out)).toMatchObject({ verdict: 'MISMATCH', dataIssues: ['MISSING_LINES', 'CHANGED_LINES'], notProven: [] })
    expect(r.out).not.toMatch(/@example\.test/)
    const md = fs.readFileSync(out, 'utf8')
    expect(md).toContain('**Kết luận: LỆCH DỮ LIỆU — MISSING_LINES, CHANGED_LINES.**')
    expect(md).toContain('- 7000008')
    expect(md).toContain('- 7000004 (***@example.test): seller_email') // email tham chiếu đã che (maskCmsEmail)
    expect(md).not.toMatch(/ds\.b@example\.test/)
    const again = cli('compare-source', `--reference=${ref}`, `--app=${app}`, fx('context', 'context.json'), `--out=${out}`)
    expect([again.rc, again.out]).toEqual([2, expect.stringContaining('không ghi đè')])
  })

  test('tham số / file / JSON sai ⇒ rc 2 trước khi so; đầu vào hoặc đầu ra trong cây Git ⇒ rc 2', () => {
    const base = [fx('reference', 'reference.csv'), fx('app', 'sales.csv'), fx('context', 'context.json')]
    expect(cli('compare-source', base[0], base[1]).rc).toBe(2) // thiếu --context
    expect(cli('compare-source', ...base, `--evidence-meta=${put('broken.json', '{')}`)).toMatchObject({ rc: 2, out: expect.stringContaining('JSON không hợp lệ') })
    expect(cli('compare-source', ...base, `--evidence-meta=${put('v2.json', JSON.stringify({ version: 2 }))}`)).toMatchObject({ rc: 2, out: expect.stringContaining('version') })
    const noCol = put('nocol.csv', csv(REF).replace('gmv_amount,', 'gmv,'))
    expect(cli('compare-source', `--reference=${noCol}`, base[1], base[2])).toMatchObject({ rc: 2, out: expect.stringContaining('SCHEMA_MISMATCH') })
    expect(cli('compare-source', ...base, '--bogus=1').rc).toBe(2)
    expect(cli('compare-source', ...base, `--out=${path.join(WEBAPP, 'cmp-in-git.md')}`)).toMatchObject({ rc: 2, out: expect.stringContaining('cây Git') })
    expect(fs.existsSync(path.join(WEBAPP, 'cmp-in-git.md'))).toBe(false)
    const stray = path.join(FX, `stray-cmp-${process.pid}.csv`)
    try {
      fs.copyFileSync(path.join(FX, 'reference.csv'), stray)
      expect(cli('compare-source', `--reference=${stray}`, base[1], base[2])).toMatchObject({ rc: 2, out: expect.stringContaining('cây Git') })
    } finally { fs.rmSync(stray, { force: true }) }
  })

  test('lõi không gọi mạng / DB / BigQuery và không được app import; fixture metadata khớp hash byte fixture', () => {
    const src = fs.readFileSync(path.join(WEBAPP, 'e2e', 'cmsI4CompareSource.ts'), 'utf8')
    expect(src).not.toMatch(/\bfetch\(|node:https?|from ['"]https?|bigqueryRunner|supabase|createClient/)
    const m = JSON.parse(readFx('evidence-meta.json').toString('utf8'))
    expect([m.reference.fileSha256, m.app.fileSha256]).toEqual([sha(readFx('reference.csv')), sha(readFx('sales.csv'))])
    // Báo cáo markdown che email (cùng hàm mask của app) và không in email nguyên.
    const md = cmsI4CompareMarkdown(cmp(REF, set(APP, '7000004', { seller_email: 'ds.a@example.test' })), cmsI4LinesById(REF))
    expect(md).not.toMatch(/ds\.[ab]@example\.test/)
  })
})

// ── r2 — PM audit I4-FINAL (`planning/reviews/2026-11-04-cms-i4-final-pm.md` §3): I4F-P1-1 / I4F-P1-2 ───────────────────

test.describe('CMS I4-FINAL r2 · I4F-P1-1 — metadata tự mâu thuẫn với dữ liệu ⇒ không MATCH @desktop', () => {
  const at = (asOf: string, exportedAt: string) => meta(H_REF, H_APP, { ref: { asOf, exportedAt }, app: { asOf, exportedAt } })

  test('ca tái hiện PM: khai xuất 01/11 nhưng file có đơn hoàn tất tới 13/11 ⇒ NOT_PROVEN, đếm theo từng bên', () => {
    const r = cmp(REF, APP, undefined, at('2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z'))
    expect(r.verdict).toBe('NOT_PROVEN')
    expect(r.notProven).toEqual(['ROWS_AFTER_AS_OF:reference', 'ROWS_AFTER_EXPORT:reference', 'ROWS_AFTER_AS_OF:app', 'ROWS_AFTER_EXPORT:app'])
    // 10 dòng trong scope; chỉ 7000001 (31/10 17:30 UTC) không sau mốc ⇒ 9 / 9 mỗi bên. Không loại / kẹp dòng: vẫn so đủ 10.
    expect([r.reference.afterAsOf, r.reference.afterExportedAt, r.app.afterAsOf, r.app.afterExportedAt]).toEqual([9, 9, 9, 9])
    expect(r.compare.matched).toBe(10)
  })

  test('ranh micro giây: bằng mốc ⇒ nhận; mốc sớm hơn 1 µs ⇒ bắt; chỉ sau mốc M (không sau lúc xuất) ⇒ một mã', () => {
    const last = '2026-11-13T03:00:00.000000Z' // completed_at lớn nhất trong scope (7000011)
    expect(cmp(REF, APP, undefined, at(last, last)).verdict).toBe('MATCH')
    const r = cmp(REF, APP, undefined, at('2026-11-13T02:59:59.999999Z', last))
    expect([r.verdict, r.notProven, r.reference.afterAsOf, r.app.afterExportedAt]).toEqual(['NOT_PROVEN', ['ROWS_AFTER_AS_OF:reference', 'ROWS_AFTER_AS_OF:app'], 1, 0])
  })

  test('mâu thuẫn ở MỘT bên ⇒ NOT_PROVEN; dữ liệu lệch đồng thời ⇒ MISMATCH vẫn liệt kê', () => {
    const last = '2026-11-13T03:00:00Z'
    const one = cmp(REF, APP, undefined, meta(H_REF, H_APP, { ref: { asOf: last, exportedAt: last }, app: { asOf: last, exportedAt: '2026-11-13T02:00:00Z' } }))
    expect([one.verdict, one.notProven]).toEqual(['NOT_PROVEN', ['EXPORTED_BEFORE_AS_OF:app', 'ROWS_AFTER_EXPORT:app']])
    expect([one.reference.afterExportedAt, one.app.afterExportedAt]).toEqual([0, 1])
    const both = cmp(REF, APP.filter((x) => x.order_line_id !== '7000004'), undefined, at('2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'))
    expect(both.verdict).toBe('MISMATCH')
    expect(both.dataIssues).toEqual(['MISSING_LINES'])
    expect(both.notProven).toEqual(expect.arrayContaining(['ROWS_AFTER_AS_OF:reference', 'ROWS_AFTER_AS_OF:app']))
  })

  test('chỉ xét dòng TRONG scope; source_updated_at (mốc nạp) không bị cắt theo M', () => {
    // sales.csv có 7000007 hoàn tất 30/11 17:00 UTC (= 01/12 VN, ngoài kỳ): mốc trước dòng đó vẫn MATCH, dòng ngoài kỳ chỉ đếm outOfScope.
    const r = cmp(REF, APP, undefined, at('2026-11-30T16:00:00Z', '2026-11-30T16:05:00Z'))
    expect([r.verdict, r.app.outOfScope, r.app.afterAsOf]).toEqual(['MATCH', 1, 0])
    const late = (rows: CmsRawRow[]) => set(rows, '7000004', { source_updated_at: '2026-12-05T00:00:00.000000Z' })
    expect(cmp(late(REF), late(APP), undefined, at('2026-11-30T16:00:00Z', '2026-11-30T16:05:00Z')).verdict).toBe('MATCH')
    // Không có metadata ⇒ không tính (null), vẫn NO_EVIDENCE_META như cũ.
    expect([cmp(REF, APP, undefined, null).reference.afterAsOf]).toEqual([null])
  })
})

test.describe('CMS I4-FINAL r2 · I4F-P1-2 — lỗi bất ngờ ở CLI ⇒ mã cố định, không lộ message @desktop', () => {
  let tmp = ''
  test.beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-i4-fault-')) })
  test.afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })
  const MARK_EMAIL = 'ds.secret@example.test'
  const MARK_TOKEN = 'TOKEN-sk_fake_I4F_123'
  // Preload GIẢ (ngoài Git): tiêm lỗi vào readFileSync / writeFileSync cho đúng file của lượt test — không đổi ACL / file thật, không mạng.
  const preload = () => {
    const p = path.join(tmp, 'fault-preload.mjs')
    if (!fs.existsSync(p)) fs.writeFileSync(p, [
      "import fs from 'node:fs'",
      `const MARK = ${JSON.stringify(`${MARK_EMAIL} ${MARK_TOKEN}`)}`,
      'const mode = process.env.CMS_I4_FAULT',
      'const read = fs.readFileSync, write = fs.writeFileSync',
      'fs.readFileSync = function (p, ...a) {',
      "  if (String(p).endsWith('fault-ref.csv') && mode === 'read-error') { const e = new Error(`EACCES: ${MARK} '${p}'`); e.code = 'EACCES'; e.cause = MARK; throw e }",
      "  if (String(p).endsWith('fault-ref.csv') && mode === 'read-string') throw `${MARK} ${p}`",
      "  if (String(p).endsWith('fault-ref.csv') && mode === 'read-object') throw { secret: MARK, path: String(p) }",
      '  return read.call(this, p, ...a)',
      '}',
      'fs.writeFileSync = function (p, ...a) {',
      "  if (String(p).endsWith('fault-out.md') && mode === 'write') throw new Error(`ENOSPC ${MARK} ${p}`)",
      '  return write.call(this, p, ...a)',
      '}',
      '',
    ].join('\n'))
    return p
  }
  const run = (mode: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload()).href, CLI, ...args], { cwd: WEBAPP, encoding: 'utf8', timeout: 60_000, env: { ...process.env, CMS_I4_FAULT: mode } })
    return { rc: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const ctx = `--context=${path.join(FX, 'context.json')}`
  const app = `--app=${path.join(FX, 'sales.csv')}`

  test('lỗi đọc file đối soát (Error / chuỗi / object) ⇒ rc 1 + CMS_I4_INTERNAL; không marker email / token / đường dẫn', () => {
    const ref = path.join(tmp, 'fault-ref.csv')
    fs.copyFileSync(path.join(FX, 'reference.csv'), ref)
    for (const mode of ['read-error', 'read-string', 'read-object']) {
      const r = run(mode, 'compare-source', `--reference=${ref}`, app, ctx)
      expect(r.rc, mode).toBe(1)
      expect(r.out, mode).toContain('CMS_I4_INTERNAL')
      expect(r.out, mode).not.toMatch(/ds\.secret|TOKEN-sk_fake|fault-ref|EACCES|\[object Object\]/)
    }
    // Không tiêm lỗi ⇒ hành vi cũ giữ nguyên (MATCH không meta ⇒ NOT_PROVEN rc 1; tham số sai ⇒ rc 2).
    expect(run('none', 'compare-source', `--reference=${ref}`, app, ctx)).toMatchObject({ rc: 1, out: expect.stringContaining('"verdict":"NOT_PROVEN"') })
    expect(run('read-error', 'compare-source', `--reference=${ref}`, app).rc).toBe(2)
  })

  test('lỗi ghi --out ⇒ rc 1 + CMS_I4_INTERNAL, không marker; mã MATCH 0 / MISMATCH 1 qua biên lỗi vẫn đúng', () => {
    const w = run('write', 'compare-source', `--reference=${path.join(FX, 'reference.csv')}`, app, ctx, `--evidence-meta=${path.join(FX, 'evidence-meta.json')}`, `--out=${path.join(tmp, 'fault-out.md')}`)
    expect([w.rc, w.out.includes('CMS_I4_INTERNAL')]).toEqual([1, true])
    expect(w.out).not.toMatch(/ds\.secret|TOKEN-sk_fake|fault-out|ENOSPC/)
    expect(run('none', 'compare-source', `--reference=${path.join(FX, 'reference.csv')}`, app, ctx, `--evidence-meta=${path.join(FX, 'evidence-meta.json')}`).rc).toBe(0)
    const bad = path.join(tmp, 'mismatch-ref.csv')
    fs.writeFileSync(bad, fs.readFileSync(path.join(FX, 'reference.csv'), 'utf8').replace('7000004,O1004,SO1004,900001,ds.b@example.test', '7000004,O1004,SO1004,900001,ds.a@example.test'))
    expect(run('none', 'compare-source', `--reference=${bad}`, app, ctx).out).toContain('"verdict":"MISMATCH"')
  })

  test('CLI ca tái hiện PM I4F-P1-1: metadata mốc 01/11 trên dữ liệu tới 13/11 ⇒ rc 1 NOT_PROVEN', () => {
    const m = JSON.parse(fs.readFileSync(path.join(FX, 'evidence-meta.json'), 'utf8'))
    for (const s of [m.reference, m.app]) { s.asOf = '2026-11-01T00:00:00Z'; s.exportedAt = '2026-11-01T00:01:00Z' }
    const mp = path.join(tmp, 'meta-early.json')
    fs.writeFileSync(mp, JSON.stringify(m))
    const r = run('none', 'compare-source', `--reference=${path.join(FX, 'reference.csv')}`, app, ctx, `--evidence-meta=${mp}`)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('"verdict":"NOT_PROVEN"')
    expect(r.out).toContain('"notProven":["ROWS_AFTER_AS_OF:reference","ROWS_AFTER_EXPORT:reference","ROWS_AFTER_AS_OF:app","ROWS_AFTER_EXPORT:app"]')
  })
})
