import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  CMS_I4_FIELD_SET, CMS_I4_ROWS_FP_VERSION_UNIT, CMS_I4_UNIT_APP_COLUMNS, CMS_I4_UNIT_FIELDS, cmsI4CompareSource, cmsI4ScopeHash,
  cmsI4UnitFpValue, cmsI4UnitRowsFpText, cmsI4UnitSrcFromApp, cmsI4UnitSrcFromReference, type CmsI4AttestMode, type CmsI4EvidenceMeta,
} from './cmsI4CompareSource'
import { cmsI4ParseContext, cmsI4ReadCsv, type CmsI4Context } from './cmsI4Offline'
import * as A from './cmsSourceAttest'
import { CMS_SALES_COLUMNS, normalizeSalesRow, type CmsRawRow, type CmsSalesLine } from '../lib/cms/source/contract'
import { CMS_SRC_MAX, cmsCaptureSrc, cmsSrcClean } from '../lib/cms/calc/src'
import { CMS_CAPABILITY_RPCS, CMS_CAPABILITY_VERSIONS, CMS_CAPABILITY_VERSIONS_V2, parseCmsCapabilities } from '../lib/cms/calc/capabilities'

// CMS returns r2 — RET-R2-01 (PM 19/11 `planning/reviews/2026-11-19-cms-returns-r1-audit-pm.md` §4.1; Q-238 b): chứng nhận nguồn có
// version cho chương trình cms_unit — bộ decision_unit14 = decision10 + chuỗi THÔ q / u + cờ (vân tay cms-rows-fp-v2, so cms-i4-compare-v2).
// Phần THUẦN (không DB): dạng canonical + vector Unicode / ký tự ẩn / số tương đương; round-trip CSV run 18 cột; compare chế độ unit14
// bắt được đổi q / u khi B / G + decision10 giữ nguyên (COUNTED↔FRACTIONAL, COUNTED↔OTHER_UNIT); trang xuất 14 / 18 khoá; chế độ theo
// cách tính của run; payload decision_unit14; capability unit_attest. Parity byte TS ↔ SQL (PGlite / PG15) + chuỗi CLI → RPC → eval →
// preview / confirm: scripts/qa-cms-132.mjs §8d.

const FX = path.join(path.resolve(__dirname, '..'), 'e2e', 'fixtures', 'cms-i4')
const CTX: CmsI4Context = (() => {
  const c = cmsI4ParseContext(JSON.parse(fs.readFileSync(path.join(FX, 'context.json'), 'utf8')))
  if (!c.ok) throw new Error(c.reason)
  return c.value
})()
const SCOPE = { startDate: '2026-11-01', endDate: '2026-11-30', productIds: ['900001', '900002'] }
const TS = '2026-12-01T04:00:00Z'
const H_REF = 'a'.repeat(64), H_APP = 'b'.repeat(64)
const RUN = '00000000-0000-4000-8000-0000000000bb', P = '00000000-0000-4000-8000-0000000000aa'
const meta = (): CmsI4EvidenceMeta => ({
  version: 1,
  reference: { inputKind: 'reference_source', source: 'nguồn gốc giả', exportedAt: TS, asOf: TS, fileSha256: H_REF, scope: SCOPE, runId: null },
  app: { inputKind: 'published_run', source: 'rpc_cms_run_source_export', exportedAt: TS, asOf: TS, fileSha256: H_APP, scope: SCOPE, runId: RUN },
})
const row = (id: string, o: Partial<CmsRawRow> = {}): CmsRawRow => ({
  order_line_id: id, order_id: `O${id}`, order_code: `SO${id}`, product_id: '900001', seller_email: 'ds.a@example.test', pos_code: 'POS-T1',
  order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: '2026-11-15T03:00:00.000000Z', quantity_raw: '2', uom_raw: 'Hộp',
  base_quantity: '30', gmv_amount: '120000', source_updated_at: '2026-11-15T03:00:00.000000Z', ...o,
})
/** Dòng run (18 cột) như rpc_cms_run_source_export r2 trả: thô / cờ = capture ô tham chiếu; raw = làm sạch(thô). */
const toApp = (r: CmsRawRow): CmsRawRow => {
  const q = cmsCaptureSrc(r.quantity_raw ?? null), u = cmsCaptureSrc(r.uom_raw ?? null)
  return { ...r, quantity_raw: cmsSrcClean(q.src), uom_raw: cmsSrcClean(u.src), quantity_src: q.src, quantity_src_flag: q.flag, uom_src: u.src, uom_src_flag: u.flag }
}
const cmp = (ref: CmsRawRow[], app: CmsRawRow[], mode: CmsI4AttestMode) =>
  cmsI4CompareSource({ context: CTX, reference: { rows: ref, fileSha256: H_REF }, app: { rows: app, fileSha256: H_APP }, meta: meta(), mode })
const line = (r: CmsRawRow): CmsSalesLine => { const n = normalizeSalesRow(r); if (!n.ok) throw new Error(JSON.stringify(n.issues)); return n.value }

// Vector chuỗi thô (≤ 50 ký tự — SALES_TEXT_MAX của quantity_raw / uom_raw lớp nguồn): Unicode tổ hợp / dựng sẵn, ký tự ẩn, điều khiển,
// số tương đương, khoảng trắng đầu / cuối, nháy / phẩy / xuống dòng (CSV phải bọc nháy và đọc lại nguyên văn).
const VECTORS: readonly string[] = [
  '2', '2.0', '2.000000000', '02', ' 2', '2 ', '\t2\t', '2\r\n', '2,5', '"2"', '1e2', '٢', '２',
  'Hộp', 'Hộp', 'hộp', 'HỘP', 'Hộp​', ' Hộp', 'Hộp ', '﻿Hộp', 'Vỉ 10 viên', 'Viên\u0085', 'Gói\u0007', '🧪', 'a"b', 'x,y',
]

test.describe('CMS returns r2 · chứng nhận decision_unit14 (thuần) @desktop', () => {
  test('canonical: chỉ thô rỗng ⇒ null; không trim / lower / NFC / đổi số — mỗi vector khác nhau cho vân tay khác nhau', () => {
    const u = (q: string | null) => ({ quantitySrc: q, quantitySrcFlag: null, uomSrc: null, uomSrcFlag: null })
    expect(cmsI4UnitFpValue(u(''), 'quantity_src')).toBeNull()
    expect(cmsI4UnitFpValue(u(null), 'quantity_src')).toBeNull()
    for (const v of VECTORS) expect(cmsI4UnitFpValue(u(v), 'quantity_src'), JSON.stringify(v)).toBe(v)
    const base = line(row('7100001'))
    const fps = new Set(VECTORS.map((v) => cmsI4UnitRowsFpText([base], () => u(v))))
    expect(fps.size).toBe(VECTORS.length)
    // '' và null cùng một dạng (CSV không phân biệt; classify / seal coi '' = MISSING).
    expect(cmsI4UnitRowsFpText([base], () => u(''))).toBe(cmsI4UnitRowsFpText([base], () => u(null)))
  })

  test('văn bản vân tay v2: header + tên 14 trường; dòng JSON mảng không khoảng trắng; thứ tự theo byte order_line_id', () => {
    const ls = [line(row('7100002')), line(row('7100001'))]
    const t = cmsI4UnitRowsFpText(ls, (l) => ({ quantitySrc: l.orderLineId === '7100001' ? '2' : ' 3', quantitySrcFlag: null, uomSrc: 'Hộp', uomSrcFlag: null }))
    const [h1, h2, r1, r2, end] = t.split('\n')
    expect([h1, h2, end]).toEqual([CMS_I4_ROWS_FP_VERSION_UNIT, CMS_I4_UNIT_FIELDS.join(','), ''])
    expect(CMS_I4_UNIT_FIELDS.slice(-4)).toEqual(['quantity_src', 'quantity_src_flag', 'uom_src', 'uom_src_flag'])
    expect(r1).toBe(`["7100001","O7100001","SO7100001","900001","ds.a@example.test","OFFLINE","COMPLETED","${Date.UTC(2026, 10, 15, 3) * 1000}","30000000000","120000000000000","2",null,"Hộp",null]`)
    expect(r2.startsWith('["7100002"')).toBe(true)
    expect(r2.endsWith('," 3",null,"Hộp",null]')).toBe(true)
    // Ký tự điều khiển: JSON.stringify escape giống to_json của PG (\t \n \r \b \f + \u00XX chữ thường); U+0085 / U+00A0 giữ nguyên.
    const esc = cmsI4UnitRowsFpText([ls[1]], () => ({ quantitySrc: '\u0001\t\n\u001f\u007f\u0085"\\', quantitySrcFlag: null, uomSrc: null, uomSrcFlag: 'OVERSIZE' }))
    expect(esc.split('\n')[2].endsWith(',"\\u0001\\t\\n\\u001f\u007f\u0085\\"\\\\",null,null,"OVERSIZE"]')).toBe(true)
  })

  test('capture phía tham chiếu + kiểm dẫn xuất phía run: cờ ⇒ thô / raw null; raw = làm sạch(thô); lệch ⇒ null (lỗi dữ liệu)', () => {
    expect(cmsI4UnitSrcFromReference(row('1', { quantity_raw: ' 2 ', uom_raw: null }))).toEqual({ quantitySrc: ' 2 ', quantitySrcFlag: null, uomSrc: null, uomSrcFlag: null })
    expect(cmsI4UnitSrcFromReference(row('1', { quantity_raw: 'x'.repeat(CMS_SRC_MAX + 1) }))).toMatchObject({ quantitySrc: null, quantitySrcFlag: 'OVERSIZE' })
    expect(cmsI4UnitSrcFromReference(row('1', { quantity_raw: '2\u0000' }))).toMatchObject({ quantitySrc: null, quantitySrcFlag: 'NUL' })
    for (const v of VECTORS) expect(cmsI4UnitSrcFromApp(toApp(row('1', { quantity_raw: v, uom_raw: v }))), JSON.stringify(v)).toEqual(cmsI4UnitSrcFromReference(row('1', { quantity_raw: v, uom_raw: v })))
    const app = toApp(row('1', { quantity_raw: ' 2 ' }))
    const bad: [string, Partial<CmsRawRow>][] = [
      ['raw ≠ làm sạch(thô)', { quantity_raw: ' 2 ' }],
      ['raw ≠ làm sạch(thô) (số khác)', { quantity_raw: '3' }],
      ['cờ kèm thô', { quantity_src_flag: 'OVERSIZE' }],
      ['cờ kèm raw', { quantity_src: null, quantity_src_flag: 'NUL', quantity_raw: '2' }],
      ['cờ lạ', { quantity_src: null, quantity_src_flag: 'X', quantity_raw: null }],
      ['thô chứa NUL', { quantity_src: '2\u0000', quantity_raw: '2' }],
      ['thô quá trần', { quantity_src: 'x'.repeat(CMS_SRC_MAX + 1), quantity_raw: 'x'.repeat(CMS_SRC_MAX + 1) }],
      ['thiếu thô nhưng có raw', { quantity_src: null }],
    ]
    for (const [why, o] of bad) expect(cmsI4UnitSrcFromApp({ ...app, ...o }), why).toBeNull()
    expect(cmsI4UnitSrcFromApp({ ...app, quantity_src: null, quantity_src_flag: 'OVERSIZE', quantity_raw: null })).toMatchObject({ quantitySrcFlag: 'OVERSIZE' })
  })

  test('CSV run 18 cột: đọc lại NGUYÊN VĂN mọi vector (khoảng trắng đầu / cuối, CR LF, nháy, phẩy, ký tự ẩn); 14 cột không đủ cho unit14', () => {
    const rows = VECTORS.map((v, i) => toApp(row(String(7200000 + i), { quantity_raw: v, uom_raw: v })))
    const csv = A.cmsAttestExportCsv(rows, true)
    expect(csv.split('\r\n')[0]).toBe([...CMS_SALES_COLUMNS, ...CMS_I4_UNIT_APP_COLUMNS].join(','))
    const back = cmsI4ReadCsv(new TextEncoder().encode(csv), [...CMS_SALES_COLUMNS, ...CMS_I4_UNIT_APP_COLUMNS])
    expect(back.ok).toBe(true)
    if (!back.ok) return
    for (let i = 0; i < rows.length; i++) {
      for (const k of ['quantity_src', 'uom_src', 'quantity_raw', 'uom_raw', 'quantity_src_flag']) expect(back.rows[i][k] ?? null, `${i}:${k}`).toBe(rows[i][k] ?? null)
    }
    const csv14 = A.cmsAttestExportCsv(rows)
    expect(cmsI4ReadCsv(new TextEncoder().encode(csv14), [...CMS_SALES_COLUMNS, ...CMS_I4_UNIT_APP_COLUMNS])).toMatchObject({ ok: false })
  })

  test('compare unit14: chỉ đổi q / u (B / G + decision10 giữ nguyên) ⇒ decision10 vẫn MATCH nhưng unit14 bắt lệch (COUNTED↔FRACTIONAL / OTHER_UNIT)', () => {
    const ref = [row('7100001', { quantity_raw: '2', uom_raw: 'Hộp' }), row('7100002', { quantity_raw: ' 1 ', uom_raw: 'Hộp​' }), row('7100003', { quantity_raw: null, uom_raw: null })]
    const app = ref.map(toApp)
    const ok = cmp(ref, app, 'unit14')
    expect([ok.verdict, ok.dataIssues, ok.mode, ok.version, ok.fpVersion]).toEqual(['MATCH', [], 'unit14', 'cms-i4-compare-v2', 'cms-rows-fp-v2'])
    expect(ok.reference.unitFp).toBe(ok.app.unitFp)
    expect(ok.reference.unitFp).toMatch(/^[0-9a-f]{64}$/)
    expect(cmp(ref, app, 'decision10').reference.unitFp).toBeNull()
    const flips: [string, Partial<CmsRawRow>, string][] = [
      ['COUNTED→FRACTIONAL', { quantity_raw: '2.5' }, 'quantity_src'],
      ['COUNTED→OTHER_UNIT', { uom_raw: 'Viên' }, 'uom_src'],
      ['số tương đương "2.0"', { quantity_raw: '2.0' }, 'quantity_src'],
      ['khoảng trắng', { quantity_raw: ' 2' }, 'quantity_src'],
      ['ký tự ẩn', { uom_raw: 'Hộp​' }, 'uom_src'],
      ['NFD', { uom_raw: 'Hộp' }, 'uom_src'],
    ]
    for (const [why, o, field] of flips) {
      const app2 = [toApp({ ...ref[0], ...o }), ...app.slice(1)]
      const d10 = cmp(ref, app2, 'decision10')
      expect(d10.verdict, `${why} decision10`).toBe('MATCH')
      const u = cmp(ref, app2, 'unit14')
      expect([u.verdict, u.compare.changed], why).toEqual(['MISMATCH', 1])
      expect(u.compare.changedByField, why).toMatchObject({ [field]: 1 })
      expect(u.reference.unitFp, why).not.toBe(u.app.unitFp)
    }
    // File run 18 cột không nhất quán (raw ≠ làm sạch(thô)) ⇒ lỗi dữ liệu, không MATCH.
    const incons = cmp(ref, [{ ...app[0], quantity_raw: '3' }, ...app.slice(1)], 'unit14')
    expect(incons.verdict).not.toBe('MATCH')
    expect(incons.dataIssues).toContain('UNIT_SRC_INCONSISTENT:app')
    // Thiếu cột thô / cờ (file 14 cột) ⇒ mọi dòng lỗi dữ liệu.
    const no18 = cmp(ref, ref, 'unit14')
    expect(no18.dataIssues).toContain('UNIT_SRC_INCONSISTENT:app')
  })

  test('OVERSIZE (db-reviewer r2 P2-1): ô thô > 64 code point nhưng làm sạch ≤ 50 ⇒ MATCH (cờ hai phía, thô / raw null); làm sạch > 50 ⇒ fail-closed như sync app', () => {
    // Sync app (contractSync.ts) chạy normalizeSalesRow trên dòng THÔ trước srcCols ⇒ cùng trần 50 ký tự sau làm sạch với phía tham chiếu.
    const big = '2' + ' '.repeat(CMS_SRC_MAX + 5)
    expect([cmsCaptureSrc(big).flag, cmsSrcClean(big)]).toEqual(['OVERSIZE', '2'])
    const ref = [row('7200001', { quantity_raw: big }), row('7200002', { uom_raw: 'Hộp' + ' '.repeat(CMS_SRC_MAX) })]
    const app = ref.map(toApp)
    expect(app.map((r) => [r.quantity_src_flag, r.quantity_raw, r.uom_src_flag, r.uom_raw])).toEqual([['OVERSIZE', null, null, 'Hộp'], [null, '2', 'OVERSIZE', null]])
    const ok = cmp(ref, app, 'unit14')
    expect([ok.verdict, ok.dataIssues]).toEqual(['MATCH', []])
    expect(ok.reference.unitFp).toBe(ok.app.unitFp)
    // Cờ là một phần vân tay: phía run mất cờ (thô "2") ⇒ lệch.
    const noFlag = cmp(ref, [toApp({ ...ref[0], quantity_raw: '2' }), app[1]], 'unit14')
    expect(noFlag.verdict).toBe('MISMATCH')
    expect(noFlag.compare.changedByField).toMatchObject({ quantity_src_flag: 1 })
    // Làm sạch > 50 ⇒ dòng tham chiếu BAD_TEXT (sync app cùng dòng này HOLD ROW_ISSUES ⇒ không có run công bố để chứng nhận).
    const long = row('7200003', { quantity_raw: 'x'.repeat(CMS_SRC_MAX + 1) })
    expect(normalizeSalesRow(long).ok).toBe(false)
    expect(cmp([long], [toApp(long)], 'unit14').verdict).not.toBe('MATCH')
  })

  test('trang xuất: 14 hoặc 18 khoá, mọi trang cùng dạng; 17 khoá / trộn ⇒ EXPORT_SHAPE', () => {
    const r18 = (id: string) => ({ ...Object.fromEntries([...CMS_SALES_COLUMNS, ...CMS_I4_UNIT_APP_COLUMNS].map((k) => [k, null])), ...toApp(row(id)) })
    const r14 = (id: string) => row(id)
    const st0 = A.newCmsAttestExportState(P, RUN)
    const p1 = A.cmsAttestExportPage(st0, { run_id: RUN, source_schema: 1, rows: [r18('7100001')], next_after: '7100001', total: 2 }, 1)
    expect(p1).toMatchObject({ ok: true, done: false })
    if (!p1.ok) return
    expect(p1.state.unitCols).toBe(true)
    expect(p1.state.rows[0].quantity_src).toBe('2')
    expect(A.cmsAttestExportPage(p1.state, { run_id: RUN, source_schema: 1, rows: [r14('7100002')], next_after: null }, 2)).toMatchObject({ ok: false, code: 'EXPORT_SHAPE' })
    expect(A.cmsAttestExportPage(p1.state, { run_id: RUN, source_schema: 1, rows: [r18('7100002')], next_after: null }, 2)).toMatchObject({ ok: true, done: true })
    const r17 = r18('7100001') as Record<string, unknown>
    delete r17.uom_src_flag
    expect(A.cmsAttestExportPage(st0, { run_id: RUN, source_schema: 1, rows: [r17], next_after: null, total: 1 }, 1)).toMatchObject({ ok: false, code: 'EXPORT_SHAPE' })
    const p14 = A.cmsAttestExportPage(st0, { run_id: RUN, source_schema: 1, rows: [r14('7100001')], next_after: null, total: 1 }, 2)
    expect(p14.ok && p14.state.unitCols).toBe(false)
  })

  const prog = (o: Partial<A.CmsAttestProgram> = {}): A.CmsAttestProgram => ({ id: P, isTest: true, status: 'active', startDate: SCOPE.startDate, endDate: SCOPE.endDate,
    productIds: [...SCOPE.productIds].sort(), currentRunId: RUN, quantityBasis: 'cms_unit', runQuantityBasis: 'cms_unit', runContractVersion: 'cms-calc-ret2-v2', ...o })
  test('chế độ theo cách tính của RUN hiện hành: cms_unit ⇒ unit14; pos_base / legacy ⇒ decision10; lệch chương trình ↔ run ⇒ không chứng nhận', () => {
    expect(A.cmsAttestModeOf(prog())).toEqual({ ok: true, mode: 'unit14' })
    expect(A.cmsAttestModeOf(prog({ quantityBasis: 'pos_base', runQuantityBasis: 'pos_base' }))).toEqual({ ok: true, mode: 'decision10' })
    expect(A.cmsAttestModeOf(prog({ quantityBasis: 'pos_base', runQuantityBasis: null, runContractVersion: null }))).toEqual({ ok: true, mode: 'decision10' })
    expect(A.cmsAttestModeOf(prog({ runQuantityBasis: 'pos_base' })).ok).toBe(false)
    expect(A.cmsAttestModeOf(prog({ quantityBasis: 'pos_base' })).ok).toBe(false)
    expect(A.cmsAttestModeOf(prog({ runContractVersion: null })).ok).toBe(false)
    expect(A.cmsAttestModeOf(prog({ runQuantityBasis: 'x' })).ok).toBe(false)
    expect(A.parseCmsAttestProgram({ id: P, is_test: true, status: 'active', start_date: '2026-11-01', end_date: '2026-11-30', product_ids: ['900001'], current_run_id: RUN,
      quantity_basis: 'cms_unit', run_quantity_basis: 'cms_unit', run_contract_version: 'cms-calc-ret2-v2' })).toMatchObject({ quantityBasis: 'cms_unit', runQuantityBasis: 'cms_unit' })
    expect(A.parseCmsAttestProgram({ id: P, is_test: true, status: 'active', start_date: '2026-11-01', end_date: '2026-11-30', product_ids: [], quantity_basis: 'x' })).toBeNull()
    // DB trước 130 (không có cột) ⇒ pos_base.
    expect(A.parseCmsAttestProgram({ id: P, is_test: true, status: 'active', start_date: '2026-11-01', end_date: '2026-11-30', product_ids: [] })).toMatchObject({ quantityBasis: 'pos_base', runQuantityBasis: null })
  })

  test('payload decision_unit14: bộ / version / vân tay v2; compare sai chế độ hoặc vân tay unit lệch ⇒ từ chối trước DB', () => {
    const ref = [row('7100001'), row('7100002', { quantity_raw: '1', uom_raw: 'Vỉ' })]
    const app = ref.map(toApp)
    const c = cmp(ref, app, 'unit14')
    const sh = cmsI4ScopeHash(SCOPE)
    expect(c.scope.scopeHash).toBe(sh)
    const base = { program: prog(), runId: RUN, compare: c, meta: meta(), refSha: H_REF, appSha: H_APP, ack: 'Đã đối soát nguồn QA r2' }
    const ok = A.cmsAttestBuildPayload(base)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.payload).toMatchObject({ field_set: CMS_I4_FIELD_SET.unit14, fp_version: 'cms-rows-fp-v2', tool_version: 'cms-i4-compare-v2',
        run_rows_fp: c.app.unitFp, reference_rows_fp: c.reference.unitFp, lines_compared: '2' })
      expect(ok.payload.run_rows_fp).not.toBe(c.app.decisionFp)
    }
    const bad: [Parameters<typeof A.cmsAttestBuildPayload>[0], RegExp][] = [
      [{ ...base, compare: cmp(ref, app, 'decision10') }, /chế độ decision10/],
      [{ ...base, compare: { ...c, reference: { ...c.reference, unitFp: 'c'.repeat(64) } } }, /decision_unit14 .*khác nhau/],
      [{ ...base, compare: { ...c, version: 'cms-i4-compare-v1' } }, /phiên bản/],
      [{ ...base, program: prog({ runQuantityBasis: 'pos_base' }) }, /đổi cách tính/],
    ]
    for (const [i, re] of bad) {
      const r = A.cmsAttestBuildPayload(i)
      expect(r.ok, String(re)).toBe(false)
      if (!r.ok) expect(r.reasons.join(' | ')).toMatch(re)
    }
    // pos_base giữ nguyên payload 124 (decision10 / v1).
    const d = cmp(ref, ref, 'decision10')
    const pb = A.cmsAttestBuildPayload({ ...base, program: prog({ quantityBasis: 'pos_base', runQuantityBasis: 'pos_base' }), compare: d })
    expect(pb.ok && pb.payload).toMatchObject({ field_set: 'decision10', fp_version: 'cms-rows-fp-v1', tool_version: 'cms-i4-compare-v1', run_rows_fp: d.app.decisionFp })
  })

  test('capability unit_attest: đúng danh sách RPC + khoá v2 ⇒ bật; thiếu (DB r1) ⇒ MISSING; khoá v2 lệch ⇒ VERSION; đường cũ không đổi', () => {
    const all = (o: Record<string, unknown> = {}) => ({ ...CMS_CAPABILITY_VERSIONS, ...CMS_CAPABILITY_VERSIONS_V2,
      paths: Object.fromEntries(Object.entries(CMS_CAPABILITY_RPCS).map(([p, rpcs]) => [p, { ok: true, rpcs: [...rpcs] }])), ...o })
    expect(parseCmsCapabilities(all()).paths.unit_attest).toBe(true)
    const r1 = all()
    delete (r1.paths as Record<string, unknown>).unit_attest
    const c1 = parseCmsCapabilities(r1)
    expect([c1.paths.unit_attest, c1.off.unit_attest, c1.paths.lock_contract, c1.paths.full_line]).toEqual([false, 'MISSING', true, true])
    const c2 = parseCmsCapabilities(all({ close_report_v2: 'x' }))
    expect([c2.paths.unit_attest, c2.off.unit_attest, c2.paths.contract_run]).toEqual([false, 'VERSION', true])
  })
})
