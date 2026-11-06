import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { CMS_IMPORT_COLUMNS } from '../lib/cms/import/parse'
import type { CmsProductMasterLite } from '../lib/cms/import/validate'
import {
  CMS_IMPORT_MAX_FILE_BYTES, CmsRepoError, cmsImportModeFor, cmsVnToday, handleCmsImportCommit, handleCmsImportErrors,
  handleCmsImportPreview, type CmsAdminAccess, type CmsImportDeps, type CmsImportPayload, type CmsImportRepo,
  type CmsImportRunRow, type CmsProgramRow,
} from '../lib/cms/import/handler'
import { normalizeCmsProgramInput, cmsProgramErrorLabel } from '../lib/cms/programInput'

// CMS P1-b — lõi Route Handler import (lib/cms/import/handler.ts) với deps giả trong bộ nhớ: thứ tự cờ → quyền → byte →
// multipart → parse; namespace QA (H9b); chế độ theo trạng thái × ngày VN (SPEC §4.7); commit parse lại, lệch preview
// ⇒ 409; ánh xạ mã RPC; file lỗi đủ dòng nhóm bị loại. Không DB, không mạng; ProductID giả 9xxxxx.

const NOW = new Date('2026-11-10T03:00:00Z') // VN 10/11/2026
const PID = { draft: '00000000-0000-4000-8000-000000000001', notStarted: '00000000-0000-4000-8000-000000000002',
  started: '00000000-0000-4000-8000-000000000003', locked: '00000000-0000-4000-8000-000000000004', test: '00000000-0000-4000-8000-000000000005' }
const prog = (id: string, status: CmsProgramRow['status'], startDate: string, o: Partial<CmsProgramRow> = {}): CmsProgramRow =>
  ({ id, status, startDate, endDate: '2026-12-31', isTest: false, configVersion: 1, catalogTargetGmv: null, ...o })

function book(rows: (string | number | null)[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([[...CMS_IMPORT_COLUMNS], ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'IMPORT_CMS')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
const row = (pid: number, tu: number, den: number | null, cms: number, o: { tgt?: number | null; loai?: string | null } = {}) =>
  [pid, o.tgt ?? null, o.loai ?? null, tu, den, cms, 'Tư vấn đã duyệt', 'hộp', 24]
const GOOD = book([row(900001, 1, 9, 15000), row(900001, 10, null, 20000), row(900002, 1, null, 5000, { tgt: 1000000, loai: 'GMV_THEO_PRODUCTID' })])
// 900009 không có trên Product Master ⇒ nhóm bị loại (2 dòng); 900001 hợp lệ.
const MIXED = book([row(900001, 1, null, 15000), row(900009, 1, 9, 1000), row(900009, 10, null, 2000)])

class FakeRepo implements CmsImportRepo {
  programs = new Map<string, CmsProgramRow>()
  runs = new Map<string, CmsImportRunRow>()
  pm = new Map<string, CmsProductMasterLite>([
    ['900001', { productName: 'SP giả 1', imageUrl: null, isActive: true, referencePrice: null }],
    ['900002', { productName: 'SP giả 2', imageUrl: null, isActive: true, referencePrice: '1000' }],
  ])
  existing = new Set<string>()
  conflicts = new Set<string>()
  calls: string[] = []
  commits: CmsImportPayload[] = []
  commitError: string | null = null
  private seq = 0
  constructor() {
    this.programs.set(PID.draft, prog(PID.draft, 'draft', '2026-11-20'))
    this.programs.set(PID.notStarted, prog(PID.notStarted, 'active', '2026-11-11'))
    this.programs.set(PID.started, prog(PID.started, 'active', '2026-11-10', { catalogTargetGmv: '50000000' }))
    this.programs.set(PID.locked, prog(PID.locked, 'locked', '2026-10-01'))
    this.programs.set(PID.test, prog(PID.test, 'draft', '2026-11-20', { isTest: true }))
  }
  async getProgram(id: string) { this.calls.push('getProgram'); return this.programs.get(id) ?? null }
  async loadContext() { this.calls.push('loadContext'); return { productMaster: this.pm, existingProductIds: this.existing, conflictProductIds: this.conflicts } }
  async savePreview(i: Parameters<CmsImportRepo['savePreview']>[0]) {
    this.calls.push('savePreview')
    const id = `00000000-0000-4000-9000-${String(++this.seq).padStart(12, '0')}`
    this.runs.set(id, { id, programId: i.programId, mode: i.mode, status: 'previewed', fileSha256: i.sha256,
      configVersionAtPreview: this.programs.get(i.programId)!.configVersion, result: JSON.parse(JSON.stringify(i.result)) })
    return id
  }
  async commit(i: Parameters<CmsImportRepo['commit']>[0]) {
    this.calls.push('commit')
    if (this.commitError) throw new CmsRepoError(this.commitError)
    const run = this.runs.get(i.runId)!
    if (run.result.digest !== i.digest) throw new CmsRepoError('CMS_IMPORT_CONFLICT')
    run.status = 'committed'
    this.commits.push(i.payload)
    return { already: false, mode: run.mode, products: i.payload.products.length }
  }
  async getRun(id: string) { this.calls.push('getRun'); return this.runs.get(id) ?? null }
}

function deps(o: { enabled?: boolean; access?: CmsAdminAccess; repo?: FakeRepo } = {}): CmsImportDeps & { repo: FakeRepo; accessCalls: number } {
  const d = {
    enabled: o.enabled ?? true,
    accessCalls: 0,
    repo: o.repo ?? new FakeRepo(),
    now: () => NOW,
    async getAccess() { d.accessCalls++; return o.access ?? { kind: 'ok', actorId: '00000000-0000-4000-8000-0000000000aa', qa: false } as CmsAdminAccess },
  }
  return d
}

async function mp(url: string, fields: Record<string, string>, file: { name?: string; type?: string; bytes: Uint8Array } | null, o: { extraFile?: boolean; dropLength?: boolean; lengthDelta?: number } = {}) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  if (file) fd.append('file', new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.type ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), file.name ?? 'danh-muc.xlsx')
  if (o.extraFile) fd.append('file2', new Blob([new Uint8Array([1])]), 'x.xlsx')
  const tmp = new Response(fd)
  const body = new Uint8Array(await tmp.arrayBuffer())
  const headers: Record<string, string> = { 'content-type': tmp.headers.get('content-type')! }
  if (!o.dropLength) headers['content-length'] = String(body.byteLength + (o.lengthDelta ?? 0))
  return new Request(url, { method: 'POST', body, headers })
}
const preview = (d: CmsImportDeps, programId: string, bytes = GOOD, o = {}) => mp('http://x/api/cms/import/preview', { program_id: programId }, { bytes }, o).then((r) => handleCmsImportPreview(r, d))
async function sha(bytes: Uint8Array) {
  const h = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const commit = async (d: CmsImportDeps, runId: string, bytes = GOOD, shaOverride?: string) =>
  handleCmsImportCommit(await mp('http://x/api/cms/import/commit', { run_id: runId, sha256: shaOverride ?? await sha(bytes) }, { bytes }), d)
const body = async (r: Response) => r.json() as Promise<Record<string, unknown> & { code?: string }>

test.describe('CMS P1-b · route import — cổng @desktop', () => {
  test('cờ OFF ⇒ 404 và KHÔNG tra quyền / đọc body', async () => {
    const d = deps({ enabled: false })
    const r = await preview(d, PID.draft)
    expect(r.status).toBe(404)
    expect(d.accessCalls).toBe(0)
    expect(d.repo.calls).toEqual([])
  })
  for (const [kind, status] of [['anonymous', 401], ['forbidden', 403], ['unavailable', 503]] as const) {
    test(`quyền ${kind} ⇒ ${status}, không chạm repo`, async () => {
      const d = deps({ access: { kind } })
      for (const res of [await preview(d, PID.draft), await commit(d, PID.draft),
        await handleCmsImportErrors(new Request(`http://x/api/cms/import/errors?run_id=${PID.draft}`), d)]) expect(res.status).toBe(status)
      expect(d.repo.calls).toEqual([])
    })
  }
  test('byte-cap trước parse: thiếu Content-Length 411; vượt trần 413; body hụt 400', async () => {
    const d = deps()
    expect((await preview(d, PID.draft, GOOD, { dropLength: true })).status).toBe(411)
    const big = new Uint8Array(CMS_IMPORT_MAX_FILE_BYTES + 70 * 1024)
    expect((await preview(d, PID.draft, big)).status).toBe(413)
    expect((await preview(d, PID.draft, GOOD, { lengthDelta: 10 })).status).toBe(400)
    expect(d.repo.calls).toEqual([])
  })
  test('multipart: hai file ⇒ 400; .csv ⇒ 415; không phải ZIP ⇒ 422 NOT_XLSX; mẫu r1 thiếu cột ⇒ 422 MISSING_COLUMNS', async () => {
    const d = deps()
    expect((await preview(d, PID.draft, GOOD, { extraFile: true })).status).toBe(400)
    const csv = await handleCmsImportPreview(await mp('http://x', { program_id: PID.draft }, { bytes: GOOD, name: 'a.csv', type: 'text/csv' }), d)
    expect(csv.status).toBe(415)
    const notZip = await preview(d, PID.draft, new TextEncoder().encode('ProductID,KPI\n1,2'))
    expect([notZip.status, (await body(notZip)).code]).toEqual([422, 'NOT_XLSX'])
    const ws = XLSX.utils.aoa_to_sheet([CMS_IMPORT_COLUMNS.slice(0, 7), [900001, null, null, 1, null, 1000, 'x']])
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'IMPORT_CMS')
    const r1 = await preview(d, PID.draft, new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer))
    const b = await body(r1)
    expect([r1.status, b.code]).toEqual([422, 'MISSING_COLUMNS'])
    expect(b.missing).toEqual(['unit_CMS', 'base_quantity_CMS'])
  })
  test('namespace QA (H9b): chương trình test ⇒ 404 khi không marker; có marker ⇒ được', async () => {
    expect((await preview(deps(), PID.test)).status).toBe(404)
    const d = deps({ access: { kind: 'ok', actorId: '00000000-0000-4000-8000-0000000000aa', qa: true } })
    expect((await preview(d, PID.test)).status).toBe(200)
  })
  test('program_id sai dạng / không tồn tại ⇒ 404; đã chốt ⇒ 409 NOT_EDITABLE', async () => {
    expect((await preview(deps(), 'abc')).status).toBe(404)
    expect((await preview(deps(), '00000000-0000-4000-8000-0000000000ff')).status).toBe(404)
    const r = await preview(deps(), PID.locked)
    expect([r.status, (await body(r)).code]).toEqual([409, 'NOT_EDITABLE'])
  })
})

test.describe('CMS P1-b · route import — preview / commit @desktop', () => {
  test('chế độ theo trạng thái × ngày VN (SPEC §4.7)', () => {
    expect(cmsVnToday(new Date('2026-11-09T17:00:00Z'))).toBe('2026-11-10')
    expect(cmsVnToday(new Date('2026-11-09T16:59:59Z'))).toBe('2026-11-09')
    expect(cmsImportModeFor({ status: 'draft', startDate: '2026-01-01' }, '2026-11-10')).toBe('replace')
    expect(cmsImportModeFor({ status: 'active', startDate: '2026-11-11' }, '2026-11-10')).toBe('replace')
    expect(cmsImportModeFor({ status: 'active', startDate: '2026-11-10' }, '2026-11-10')).toBe('append')
    expect(cmsImportModeFor({ status: 'locked', startDate: '2026-11-11' }, '2026-11-10')).toBeNull()
  })
  test('preview: run + mode + nhóm hợp lệ / bị loại; client không quyết mode', async () => {
    const d = deps()
    const r = await mp('http://x', { program_id: PID.notStarted, mode: 'append', is_test: 'true' }, { bytes: MIXED }).then((q) => handleCmsImportPreview(q, d))
    const b = await body(r)
    expect(r.status).toBe(200)
    expect(b.mode).toBe('replace')
    expect((b.stats as { productsOk: number; productsRejected: number })).toMatchObject({ productsOk: 1, productsRejected: 1 })
    const run = d.repo.runs.get(String(b.runId))!
    expect(run.result.rejected[0].rows.map((x) => x.excelRow)).toEqual([3, 4])
    expect(Object.keys(run.result.rejected[0].rows[0])).toEqual(['excelRow', 'raw'])
    expect((await preview(d, PID.started)).status).toBe(200)
    expect([...d.repo.runs.values()].at(-1)!.mode).toBe('append')
  })
  test('commit: parse lại, ghi đúng payload; commit lặp ⇒ already, không ghi thêm', async () => {
    const d = deps()
    const runId = String((await body(await preview(d, PID.draft))).runId)
    const r = await commit(d, runId)
    const b = await body(r)
    expect(r.status).toBe(200)
    expect(b.result).toMatchObject({ already: false, mode: 'replace', products: 2 })
    const p = d.repo.commits[0]
    expect(p.mode).toBe('replace')
    expect(p.catalog_target).toBeNull()
    expect(p.products.map((x) => x.product_id)).toEqual(['900001', '900002'])
    expect(p.products[0].tiers).toEqual([{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: null, amount: '20000' }])
    expect(p.products[1]).toMatchObject({ gmv_basis: 'product', target_gmv: '1000000', base_quantity_cms: '24', price_snapshot: '1000' })
    const again = await commit(d, runId)
    expect([again.status, (await body(again)).result]).toEqual([200, { already: true }])
    expect(d.repo.commits.length).toBe(1)
  })
  test('CMS-Q-220: file cũ có cận cuối hữu hạn ⇒ preview chuẩn hoá + cảnh báo + lưu policy / cận đã bỏ; commit ghi cuối NULL; preview trước chính sách ⇒ 409', async () => {
    const OLD = book([row(900001, 1, 9, 15000), row(900001, 10, 19, 20000), row(900001, 20, 50, 25000), row(900002, 1, 100, 5000, { tgt: 1000000, loai: 'GMV_THEO_PRODUCTID' })])
    const d = deps()
    const r = await preview(d, PID.draft, OLD)
    const b = await body(r)
    expect(r.status).toBe(200)
    expect(b.tierPolicy).toBe('uncapped_last_v1')
    const g = b.groupsOk as { productId: string; tiers: { to: number | null }[]; normalizedLastTo: number | null; warnings: { code: string; message: string }[] }[]
    expect(g.map((x) => [x.productId, x.tiers.map((t) => t.to), x.normalizedLastTo])).toEqual([['900001', [9, 19, null], 50], ['900002', [null], 100]])
    expect(g[0].warnings.find((w) => w.code === 'LAST_TIER_UNBOUNDED_NORMALIZED')?.message).toBe('Đã bỏ giới hạn 50 của bậc cuối theo chính sách CMS mới; từ 20 trở lên đều được xét bậc này.')
    const run = d.repo.runs.get(String(b.runId))!
    // Audit trong metadata preview (file gốc / SHA / raw KHÔNG đổi: file_sha256 = SHA của byte gốc).
    expect(run.result.tierPolicy).toBe('uncapped_last_v1')
    expect(run.result.normalizedLastTiers).toEqual([{ productId: '900001', excelRow: 4, from: 20, originalTo: 50 }, { productId: '900002', excelRow: 5, from: 1, originalTo: 100 }])
    expect(run.fileSha256).toBe(await sha(OLD))
    const c = await commit(d, String(b.runId), OLD)
    expect(c.status).toBe(200)
    expect(d.repo.commits[0].products.map((x) => x.tiers.at(-1)!.to)).toEqual([null, null])
    expect(d.repo.commits[0].products[0].tiers.map((t) => t.to)).toEqual([9, 19, null])
    // Preview lập TRƯỚC chính sách (digest không có định danh policy) ⇒ commit 409 PREVIEW_STALE, không ghi.
    const d2 = deps()
    const b2 = await body(await preview(d2, PID.draft, OLD))
    const stale = d2.repo.runs.get(String(b2.runId))!
    stale.result.digest = 'f'.repeat(64)
    delete stale.result.tierPolicy
    const c2 = await commit(d2, String(b2.runId), OLD)
    expect([c2.status, (await body(c2)).code]).toEqual([409, 'PREVIEW_STALE'])
    expect(d2.repo.commits.length).toBe(0)
  })
  test('commit: hash client ≠ file ⇒ 409; file khác file đã preview ⇒ 409 SHA_MISMATCH', async () => {
    const d = deps()
    const runId = String((await body(await preview(d, PID.draft))).runId)
    expect((await body(await commit(d, runId, GOOD, 'a'.repeat(64)))).code).toBe('SHA_MISMATCH')
    expect((await body(await commit(d, runId, MIXED))).code).toBe('SHA_MISMATCH')
    expect(d.repo.commits.length).toBe(0)
  })
  test('nguồn đổi sau preview (Product Master / trùng / cấu hình / qua ngày) ⇒ 409 PREVIEW_STALE, không ghi', async () => {
    const cases: [string, (d: ReturnType<typeof deps>) => void, string][] = [
      ['đổi tên Product Master', (d) => d.repo.pm.set('900001', { ...d.repo.pm.get('900001')!, productName: 'Tên mới' }), PID.draft],
      ['SP vừa thuộc chương trình khác', (d) => d.repo.conflicts.add('900002'), PID.draft],
      ['config_version đổi', (d) => { d.repo.programs.get(PID.draft)!.configVersion = 2 }, PID.draft],
      ['qua ngày bắt đầu (replace ⇒ append)', (d) => { d.repo.programs.get(PID.notStarted)!.startDate = '2026-11-10' }, PID.notStarted],
    ]
    for (const [name, mutate, pid] of cases) {
      const d = deps()
      const runId = String((await body(await preview(d, pid))).runId)
      mutate(d)
      const r = await commit(d, runId)
      expect([name, r.status, (await body(r)).code]).toEqual([name, 409, 'PREVIEW_STALE'])
      expect(d.repo.commits.length).toBe(0)
    }
  })
  test('0 nhóm hợp lệ ⇒ 422 NOTHING_TO_COMMIT; run không tồn tại ⇒ 404; run_id sai dạng ⇒ 400', async () => {
    const d = deps()
    const bad = book([row(900009, 1, null, 1000)])
    const runId = String((await body(await preview(d, PID.draft, bad))).runId)
    expect((await body(await commit(d, runId, bad))).code).toBe('NOTHING_TO_COMMIT')
    expect((await commit(d, '00000000-0000-4000-9000-0000000000ff')).status).toBe(404)
    expect((await commit(d, 'xyz')).status).toBe(400)
  })
  test('commit run của chương trình test khi không có marker ⇒ 404', async () => {
    const qa = deps({ access: { kind: 'ok', actorId: '00000000-0000-4000-8000-0000000000aa', qa: true } })
    const runId = String((await body(await preview(qa, PID.test))).runId)
    const plain = deps({ repo: qa.repo })
    expect((await commit(plain, runId)).status).toBe(404)
    expect((await handleCmsImportErrors(new Request(`http://x/e?run_id=${runId}`), plain)).status).toBe(404)
  })
  test('ánh xạ mã RPC ⇒ HTTP (không lộ message DB)', async () => {
    for (const [code, status, mapped] of [
      ['CMS_IMPORT_PRODUCT_CONFLICT', 409, 'PRODUCT_CONFLICT'], ['CMS_IMPORT_PRODUCT_EXISTS', 409, 'PRODUCT_EXISTS'],
      ['CMS_IMPORT_CATALOG_TARGET_CHANGED', 409, 'CATALOG_TARGET_CHANGED'], ['CMS_PROGRAM_NOT_EDITABLE', 409, 'NOT_EDITABLE'],
      ['CMS_IMPORT_CONFLICT', 409, 'PREVIEW_STALE'], ['CMS_IMPORT_PRODUCT_UNKNOWN', 409, 'PREVIEW_STALE'], ['BUSY', 503, 'BUSY'],
      // CMS-Q-220 (125): DB từ chối bậc cuối hữu hạn — chỉ preview / app trước chính sách ⇒ kiểm lại file.
      ['CMS_IMPORT_TIER_LAST_FINITE', 409, 'PREVIEW_STALE'], ['CMS_TIER_LAST_FINITE', 409, 'PREVIEW_STALE'],
      ['CMS_IMPORT_BAD_PAYLOAD', 500, 'COMMIT_FAILED'], ['COMMIT_FAILED', 500, 'COMMIT_FAILED'],
    ] as const) {
      const d = deps()
      const runId = String((await body(await preview(d, PID.draft))).runId)
      d.repo.commitError = code
      const r = await commit(d, runId)
      const b = await body(r)
      expect([code, r.status, b.code]).toEqual([code, status, mapped])
      expect(JSON.stringify(b)).not.toContain('CMS_IMPORT')
    }
  })
  test('file lỗi: TOÀN BỘ dòng nhóm bị loại + cột Loi, sheet IMPORT_CMS; không có nhóm lỗi ⇒ 404 NO_ERRORS', async () => {
    const d = deps()
    const runId = String((await body(await preview(d, PID.draft, MIXED))).runId)
    const r = await handleCmsImportErrors(new Request(`http://x/api/cms/import/errors?run_id=${runId}`), d)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-disposition')).toContain('.xlsx')
    const wb = XLSX.read(new Uint8Array(await r.arrayBuffer()), { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets.IMPORT_CMS, { header: 1 })
    expect(rows[0]).toEqual([...CMS_IMPORT_COLUMNS, 'Loi'])
    expect(rows.slice(1).map((x) => x[0])).toEqual([900009, 900009])
    expect(String(rows[1][9])).toContain('Product Master')
    const okRun = String((await body(await preview(d, PID.draft))).runId)
    const none = await handleCmsImportErrors(new Request(`http://x/e?run_id=${okRun}`), d)
    expect([none.status, (await body(none)).code]).toEqual([404, 'NO_ERRORS'])
  })
})

test.describe('CMS P1-b · đầu vào chương trình (server action) @desktop', () => {
  test('chuẩn hoá: không nhận is_test / status / actor; ngày thật; phạm vi', () => {
    const ok = normalizeCmsProgramInput({ name: '  CMS T11 ', start_date: '2026-11-01', end_date: '2026-11-30', scope: 'all', is_test: true, status: 'active', actor: 'x' })
    expect(ok).toEqual({ ok: true, value: { name: 'CMS T11', start_date: '2026-11-01', end_date: '2026-11-30', scope: 'all', store_ids: [] } })
    const st = normalizeCmsProgramInput({ name: 'x', start_date: '2026-11-01', end_date: '2026-11-01', scope: 'stores',
      store_ids: ['00000000-0000-4000-8000-00000000000A', '00000000-0000-4000-8000-00000000000a'] })
    expect(st.ok && st.value.store_ids).toEqual(['00000000-0000-4000-8000-00000000000a'])
    for (const bad of [
      null, {}, { name: ' ', start_date: '2026-11-01', end_date: '2026-11-02', scope: 'all' },
      { name: 'x', start_date: '2026-02-30', end_date: '2026-03-02', scope: 'all' },
      { name: 'x', start_date: '2026-11-02', end_date: '2026-11-01', scope: 'all' },
      { name: 'x', start_date: '2026-11-01', end_date: '2026-11-02', scope: 'region' },
      { name: 'x', start_date: '2026-11-01', end_date: '2026-11-02', scope: 'stores', store_ids: [] },
      { name: 'x', start_date: '2026-11-01', end_date: '2026-11-02', scope: 'stores', store_ids: ['abc'] },
      { name: 'x'.repeat(201), start_date: '2026-11-01', end_date: '2026-11-02', scope: 'all' },
      // Q-215: khoảng ngày kỹ thuật 2020-01-01…2100-12-31 (cùng RPC 121), không trần độ dài kỳ.
      { name: 'x', start_date: '2019-12-31', end_date: '2026-11-02', scope: 'all' },
      { name: 'x', start_date: '2026-11-01', end_date: '2101-01-01', scope: 'all' },
    ]) expect(normalizeCmsProgramInput(bad).ok).toBe(false)
    expect(normalizeCmsProgramInput({ name: 'x', start_date: '2020-01-01', end_date: '2100-12-31', scope: 'all' }).ok).toBe(true)
  })
  test('nhãn lỗi RPC: mã đã biết có nhãn riêng, mã lạ ⇒ nhãn chung', () => {
    expect(cmsProgramErrorLabel('CMS_ACTIVATE_CONFLICT')).toContain('chương trình khác')
    expect(cmsProgramErrorLabel('CMS_PROGRAM_EMPTY')).toContain('nạp danh mục')
    expect(cmsProgramErrorLabel('CMS_PROGRAM_START_PAST')).toContain('sau hôm nay')
    expect(cmsProgramErrorLabel('CMS_PROGRAM_TIER_LAST_FINITE')).toContain('để trống Đến SL bán ở bậc cuối')
    expect(cmsProgramErrorLabel('BUSY')).toContain('thử lại')
    expect(cmsProgramErrorLabel('XYZ')).toBe('Không lưu được — thử lại sau')
  })
})

test.describe('CMS P1-b · chống lạm dụng file (security review) @desktop', () => {
  // Sửa kích thước giải nén khai báo của entry đầu trong central directory (không giải nén thật).
  function withDeclaredSize(bytes: Uint8Array, size: number): Uint8Array {
    const out = bytes.slice()
    const dv = new DataView(out.buffer)
    let eocd = -1
    for (let i = out.byteLength - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
    const cdOff = dv.getUint32(eocd + 16, true)
    dv.setUint32(cdOff + 24, size, true)
    return out
  }
  test('zip bomb: tổng giải nén khai báo > 40 MiB ⇒ 422 FILE_TOO_COMPLEX, không parse / không tra repo', async () => {
    const z = await import('../lib/cms/import/zipGuard')
    expect(z.cmsZipGuard(GOOD)).toMatchObject({ ok: true })
    expect(z.cmsZipGuard(withDeclaredSize(GOOD, 41 * 1024 * 1024))).toEqual({ ok: false, reason: 'TOO_LARGE' })
    expect(z.cmsZipGuard(withDeclaredSize(GOOD, 0xffffffff))).toEqual({ ok: false, reason: 'ZIP64' })
    expect(z.cmsZipGuard(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toEqual({ ok: false, reason: 'NOT_ZIP' })
    const d = deps()
    const r = await preview(d, PID.draft, withDeclaredSize(GOOD, 41 * 1024 * 1024))
    expect([r.status, (await body(r)).code]).toEqual([422, 'FILE_TOO_COMPLEX'])
    expect(d.repo.calls).toEqual(['getProgram'])
  })
  test('quá nhiều entry trong ZIP ⇒ FILE_TOO_COMPLEX', async () => {
    const z = await import('../lib/cms/import/zipGuard')
    const out = GOOD.slice()
    const dv = new DataView(out.buffer)
    let eocd = -1
    for (let i = out.byteLength - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
    dv.setUint16(eocd + 10, z.CMS_ZIP_MAX_ENTRIES + 1, true)
    expect(z.cmsZipGuard(out)).toEqual({ ok: false, reason: 'TOO_MANY_ENTRIES' })
  })
  test('POST cross-site (Sec-Fetch-Site ≠ same-origin) ⇒ 403 trước khi đọc body', async () => {
    const d = deps()
    for (const site of ['cross-site', 'same-site']) {
      const q = await mp('http://x/api/cms/import/preview', { program_id: PID.draft }, { bytes: GOOD })
      const r = await handleCmsImportPreview(new Request(q, { headers: { ...Object.fromEntries(q.headers), 'sec-fetch-site': site } }), d)
      expect([site, r.status, (await body(r)).code]).toEqual([site, 403, 'CROSS_SITE'])
    }
    expect(d.repo.calls).toEqual([])
    const q = await mp('http://x/api/cms/import/preview', { program_id: PID.draft }, { bytes: GOOD })
    expect((await handleCmsImportPreview(new Request(q, { headers: { ...Object.fromEntries(q.headers), 'sec-fetch-site': 'same-origin' } }), d)).status).toBe(200)
  })
  test('raw lưu trong run có trần độ dài ô (tư vấn 4.100, cột khác 200)', async () => {
    const d = deps()
    const long = book([[900009, 'x'.repeat(5000), null, 1, null, 1000, 'y'.repeat(9000), 'hộp', 24]])
    const runId = String((await body(await preview(d, PID.draft, long))).runId)
    const raw = d.repo.runs.get(runId)!.result.rejected[0].rows[0].raw
    expect(String(raw.KPI_Target_GMV_VND).length).toBe(201)
    expect(String(raw.Noi_dung_tu_van).length).toBe(4101)
    expect(raw.ProductID).toBe(900009)
  })
})
