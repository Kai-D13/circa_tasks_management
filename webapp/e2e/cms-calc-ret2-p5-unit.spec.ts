import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { CMS_IMPORT_COLUMNS, parseCmsImportXlsx } from '../lib/cms/import/parse'
import { CMS_SIMPLE_REQUIRED, parseCmsSimpleXlsx } from '../lib/cms/import/parseSimple'
import { CMS_SIMPLE_HEADER } from '../lib/cms/import/simpleColumns'
import type { CmsProductMasterLite } from '../lib/cms/import/validate'
import {
  handleCmsImportCommit, handleCmsImportPreview, type CmsImportDeps, type CmsImportPayload, type CmsImportRepo,
  type CmsImportRunRow, type CmsProgramRow,
} from '../lib/cms/import/handler'
import {
  cmsBasisConfirmed, cmsIsBasisHeader, normalizeCmsBasisInput, parseCmsProgramBasisRow, type CmsProgramBasis,
} from '../lib/cms/calc/basisUi'
import { cmsBasisSelectable, cmsPlanActivate, cmsPlanProgramSave, type CmsBasisEnv } from '../lib/cms/programBasisPlan'

// CMS-CALC-RET-2 P5.1 (PM work order P5 14/11 §4; spec §2 / §6.1 / §7 / §8.1 / §8.5; plan A/B §4) — lựa chọn cách tính cấp chương
// trình + import theo cách tính. Thuần / deps giả trong bộ nhớ; không DB, không mạng; ProductID giả 9xxxxx.

const B = (basis: CmsProgramBasis['basis'], source: CmsProgramBasis['source'], returnsPolicy: CmsProgramBasis['returnsPolicy'] = 'sales_only_v1'): CmsProgramBasis =>
  ({ basis, source, returnsPolicy })
const ENV = {
  pre130: { modesOn: false, caps: 'pre130', modesPath: false } as CmsBasisEnv,
  offDb130: { modesOn: false, caps: 'ok', modesPath: true } as CmsBasisEnv,
  on: { modesOn: true, caps: 'ok', modesPath: true } as CmsBasisEnv,
  onPre130: { modesOn: true, caps: 'pre130', modesPath: false } as CmsBasisEnv,
  onMismatch: { modesOn: true, caps: 'ok', modesPath: false } as CmsBasisEnv,
  onUnavail: { modesOn: true, caps: 'unavailable', modesPath: false } as CmsBasisEnv,
  offUnavail: { modesOn: false, caps: 'unavailable', modesPath: false } as CmsBasisEnv,
}

test.describe('CMS-CALC-RET-2 P5.1 · cách tính cấp chương trình @desktop', () => {
  test('đọc dòng DB: cặp (basis, source) phải nhất quán; giá trị lạ ⇒ null (không giả cộng dồn)', () => {
    expect(parseCmsProgramBasisRow({ quantity_basis: 'pos_base', quantity_basis_source: 'legacy_migration', returns_policy: 'sales_only_v1' }))
      .toEqual(B('pos_base', 'legacy_migration'))
    expect(parseCmsProgramBasisRow({ quantity_basis: 'cms_unit', quantity_basis_source: 'admin', returns_policy: 'net_returns_v1' }))
      .toEqual(B('cms_unit', 'admin', 'net_returns_v1'))
    expect(parseCmsProgramBasisRow({ quantity_basis: null, quantity_basis_source: 'pending', returns_policy: 'sales_only_v1' })).toEqual(B(null, 'pending'))
    for (const bad of [
      { quantity_basis: null, quantity_basis_source: 'admin', returns_policy: 'sales_only_v1' },
      { quantity_basis: 'pos_base', quantity_basis_source: 'pending', returns_policy: 'sales_only_v1' },
      { quantity_basis: 'POS_BASE', quantity_basis_source: 'admin', returns_policy: 'sales_only_v1' },
      { quantity_basis: 'pos_base', quantity_basis_source: 'x', returns_policy: 'sales_only_v1' },
      { quantity_basis: 'pos_base', quantity_basis_source: 'admin', returns_policy: 'net' },
      { quantity_basis: 'pos_base', quantity_basis_source: 'admin' },
    ]) expect(parseCmsProgramBasisRow(bad), JSON.stringify(bad)).toBeNull()
  })

  test('đầu vào form: chỉ hai định danh, trống / lạ / pending ⇒ lỗi; xác nhận chỉ khi admin chọn', () => {
    expect(normalizeCmsBasisInput('pos_base')).toEqual({ ok: true, value: 'pos_base' })
    expect(normalizeCmsBasisInput('cms_unit')).toEqual({ ok: true, value: 'cms_unit' })
    for (const x of [undefined, null, '', 'pending', ' cms_unit', 'CMS_UNIT', 1]) expect(normalizeCmsBasisInput(x).ok, String(x)).toBe(false)
    expect(cmsBasisConfirmed(B('pos_base', 'admin'))).toBe(true)
    for (const s of ['legacy_migration', 'legacy_compat'] as const) expect(cmsBasisConfirmed(B('pos_base', s))).toBe(false)
    expect(cmsBasisConfirmed(B(null, 'pending'))).toBe(false)
  })

  test('lưu: ma trận cờ × năng lực DB (app mới + DB cũ, cờ OFF, cờ ON, lệch / lỗi năng lực)', () => {
    // Cờ OFF hoặc DB trước 130 ⇒ RPC 121 như cũ; gửi cách tính khi không được hỗ trợ ⇒ từ chối, không tạo pos_base thầm.
    expect(cmsPlanProgramSave(ENV.pre130, { inputBasis: undefined })).toEqual({ kind: 'legacy' })
    expect(cmsPlanProgramSave(ENV.offDb130, { inputBasis: undefined })).toEqual({ kind: 'legacy' })
    expect(cmsPlanProgramSave(ENV.offDb130, { inputBasis: 'cms_unit' })).toEqual({ kind: 'error', code: 'CMS_MODES_OFF' })
    expect(cmsPlanProgramSave(ENV.onPre130, { inputBasis: undefined })).toEqual({ kind: 'legacy' })
    expect(cmsPlanProgramSave(ENV.onPre130, { inputBasis: 'pos_base' })).toEqual({ kind: 'error', code: 'CMS_MODES_UNSUPPORTED' })
    expect(cmsPlanProgramSave(ENV.onMismatch, { inputBasis: 'pos_base' })).toEqual({ kind: 'error', code: 'CMS_MODES_UNSUPPORTED' })
    expect(cmsPlanProgramSave(ENV.onUnavail, { inputBasis: 'pos_base' })).toEqual({ kind: 'error', code: 'CMS_CAPS_UNAVAILABLE' })
    // Cờ ON + DB hỗ trợ ⇒ save_v2 bắt buộc chọn (tạo + sửa nháp), chương trình đã kích hoạt không đổi được.
    expect(cmsPlanProgramSave(ENV.on, { inputBasis: undefined })).toEqual({ kind: 'error', code: 'CMS_BASIS_REQUIRED' })
    expect(cmsPlanProgramSave(ENV.on, { inputBasis: 'cms_unit' })).toEqual({ kind: 'v2', basis: 'cms_unit' })
    expect(cmsPlanProgramSave(ENV.on, { inputBasis: 'cms_unit', current: B('pos_base', 'legacy_compat'), status: 'draft' })).toEqual({ kind: 'v2', basis: 'cms_unit' })
    expect(cmsPlanProgramSave(ENV.on, { inputBasis: 'cms_unit', current: B('pos_base', 'legacy_migration'), status: 'active' }))
      .toEqual({ kind: 'error', code: 'CMS_BASIS_IMMUTABLE' })
    expect(cmsPlanProgramSave(ENV.on, { inputBasis: 'pos_base', current: B('pos_base', 'legacy_migration'), status: 'active' })).toEqual({ kind: 'v2', basis: 'pos_base' })
    expect(cmsPlanProgramSave(ENV.on, { inputBasis: 'pos_base', current: null, status: 'active' })).toEqual({ kind: 'error', code: 'CMS_BASIS_IMMUTABLE' })
    expect(cmsBasisSelectable(ENV.on)).toBe(true)
    for (const e of [ENV.pre130, ENV.offDb130, ENV.onPre130, ENV.onMismatch, ENV.onUnavail]) expect(cmsBasisSelectable(e)).toBe(false)
  })

  test('kích hoạt: nháp chưa xác nhận / pending chặn; cờ OFF không kích hoạt tính nguyên; DB cũ như cũ; không đọc được ⇒ dừng', () => {
    expect(cmsPlanActivate(ENV.pre130, { status: 'draft' })).toEqual({ ok: true })
    expect(cmsPlanActivate(ENV.onPre130, { status: 'draft' })).toEqual({ ok: true })
    expect(cmsPlanActivate(ENV.offDb130, { status: 'draft', current: B('pos_base', 'legacy_compat') })).toEqual({ ok: true })
    expect(cmsPlanActivate(ENV.offDb130, { status: 'draft', current: B('cms_unit', 'admin') })).toEqual({ ok: false, code: 'CMS_MODES_OFF_CMS_UNIT' })
    expect(cmsPlanActivate(ENV.offDb130, { status: 'draft', current: B(null, 'pending') })).toEqual({ ok: false, code: 'CMS_BASIS_NOT_SET' })
    expect(cmsPlanActivate(ENV.on, { status: 'draft', current: B('pos_base', 'legacy_compat') })).toEqual({ ok: false, code: 'CMS_BASIS_NOT_CONFIRMED' })
    expect(cmsPlanActivate(ENV.on, { status: 'draft', current: B('pos_base', 'legacy_migration') })).toEqual({ ok: false, code: 'CMS_BASIS_NOT_CONFIRMED' })
    expect(cmsPlanActivate(ENV.on, { status: 'draft', current: B(null, 'pending') })).toEqual({ ok: false, code: 'CMS_BASIS_NOT_SET' })
    expect(cmsPlanActivate(ENV.on, { status: 'draft', current: B('cms_unit', 'admin') })).toEqual({ ok: true })
    expect(cmsPlanActivate(ENV.on, { status: 'draft', current: null })).toEqual({ ok: false, code: 'CMS_CAPS_UNAVAILABLE' })
    expect(cmsPlanActivate(ENV.onMismatch, { status: 'draft', current: undefined })).toEqual({ ok: false, code: 'CMS_CAPS_UNAVAILABLE' })
    expect(cmsPlanActivate(ENV.offUnavail, { status: 'draft' })).toEqual({ ok: false, code: 'CMS_CAPS_UNAVAILABLE' })
  })

  test('tiêu đề cột "Cách tính" nhận diện không phân biệt dấu / hoa thường; cột hợp đồng không bị nhầm', () => {
    for (const h of ['Cách tính', 'CÁCH TÍNH', 'cach_tinh', 'Cach tinh luong', 'quantity_basis', 'Quantity Basis', 'Tính nguyên', 'tinh-le', 'Chế độ tính', '  Cách  tính  '])
      expect(cmsIsBasisHeader(h), h).toBe(true)
    for (const h of [...CMS_IMPORT_COLUMNS, ...CMS_SIMPLE_REQUIRED.map((f) => CMS_SIMPLE_HEADER[f]), 'Cách tính bậc', 'Ghi chú', 'unit_CMS', '', 'x'.repeat(200)])
      expect(cmsIsBasisHeader(h), h).toBe(false)
  })
})

// ── Import theo cách tính ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const NOW = new Date('2026-11-10T03:00:00Z')
const PID = '00000000-0000-4000-8000-000000000001'
const prog = (o: Partial<CmsProgramRow> = {}): CmsProgramRow =>
  ({ id: PID, status: 'draft', startDate: '2026-11-20', endDate: '2026-12-31', isTest: false, configVersion: 1, catalogTargetGmv: null, ...o })
function book(rows: (string | number | null)[][], header: string[] = [...CMS_IMPORT_COLUMNS]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'IMPORT_CMS')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
// [ProductID, Target, Loai, Tu, Den, CMS, TuVan, unit, baseQty]
const row = (pid: number, unit: string) => [pid, null, null, 1, null, 15000, 'Tư vấn đã duyệt', unit, 100]
const FILE = book([row(900001, 'Hộp'), row(900002, 'Hộp​'), row(900003, '  ')])

class FakeRepo implements CmsImportRepo {
  program = prog()
  runs = new Map<string, CmsImportRunRow>()
  pm = new Map<string, CmsProductMasterLite>([1, 2, 3].map((i) => [`90000${i}`, { productName: `SP giả ${i}`, imageUrl: null, isActive: true, referencePrice: null }]))
  commits: CmsImportPayload[] = []
  private seq = 0
  async getProgram(id: string) { return id === PID ? this.program : null }
  async loadContext() { return { productMaster: this.pm, existingProductIds: new Set<string>(), conflictProductIds: new Set<string>() } }
  async savePreview(i: Parameters<CmsImportRepo['savePreview']>[0]) {
    const id = `00000000-0000-4000-9000-${String(++this.seq).padStart(12, '0')}`
    this.runs.set(id, { id, programId: i.programId, mode: i.mode, status: 'previewed', fileSha256: i.sha256, configVersionAtPreview: this.program.configVersion,
      result: JSON.parse(JSON.stringify(i.result)) })
    return id
  }
  async commit(i: Parameters<CmsImportRepo['commit']>[0]) {
    this.runs.get(i.runId)!.status = 'committed'
    this.commits.push(i.payload)
    return { already: false, mode: 'replace' as const, products: i.payload.products.length }
  }
  async getRun(id: string) { return this.runs.get(id) ?? null }
}
function deps(basis: () => CmsProgramBasis | null | undefined, repo = new FakeRepo()): CmsImportDeps & { repo: FakeRepo; basisCalls: number } {
  const d = {
    enabled: true, repo, now: () => NOW, basisCalls: 0,
    async getAccess() { return { kind: 'ok' as const, actorId: '00000000-0000-4000-8000-0000000000aa', qa: false } },
    async getBasis() { d.basisCalls++; return basis() },
  }
  return d
}
async function mp(url: string, fields: Record<string, string>, bytes: Uint8Array) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'danh-muc.xlsx')
  const tmp = new Response(fd)
  const body = new Uint8Array(await tmp.arrayBuffer())
  return new Request(url, { method: 'POST', body, headers: { 'content-type': tmp.headers.get('content-type')!, 'content-length': String(body.byteLength) } })
}
async function sha(bytes: Uint8Array) {
  const h = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const preview = async (d: CmsImportDeps, bytes = FILE) => handleCmsImportPreview(await mp('http://x/api/cms/import/preview', { program_id: PID }, bytes), d)
const commit = async (d: CmsImportDeps, runId: string, bytes = FILE) =>
  handleCmsImportCommit(await mp('http://x/api/cms/import/commit', { run_id: runId, sha256: await sha(bytes) }, bytes), d)
type Body = Record<string, unknown> & { code?: string; runId?: string; quantityBasis?: unknown; groupsOk?: { productId: string }[]; groupsRejected?: { key: string; errors: { code: string }[] }[]; column?: string }
const body = async (r: Response) => r.json() as Promise<Body>

test.describe('CMS-CALC-RET-2 P5.1 · import theo cách tính chương trình @desktop', () => {
  test('DB trước 130 (getBasis undefined): như cũ — không kiểm khoá đơn vị, không ghim cách tính, quantityBasis null', async () => {
    const d = deps(() => undefined)
    const r = await preview(d)
    const j = await body(r)
    expect(r.status).toBe(200)
    // Ô unit_CMS toàn khoảng trắng bị validator hiện hành loại; ký tự ẩn KHÔNG bị loại ở đường cũ (luật cũ không đổi).
    expect(j.groupsOk?.map((g) => g.productId)).toEqual(['900001', '900002'])
    expect(j.quantityBasis).toBeNull()
    expect(d.repo.runs.get(j.runId!)!.result.basis).toBeUndefined()
  })

  test('cộng dồn (pos_base): không thêm ràng buộc đơn vị; ghim basis vào run', async () => {
    const d = deps(() => ({ basis: 'pos_base', source: 'admin', returnsPolicy: 'sales_only_v1' }))
    const j = await body(await preview(d))
    expect(j.groupsOk?.map((g) => g.productId)).toEqual(['900001', '900002'])
    expect(j.quantityBasis).toBe('pos_base')
    expect(d.repo.runs.get(j.runId!)!.result.basis).toBe('pos_base')
  })

  test('tính nguyên (cms_unit): nhóm có unit_CMS không có khoá hợp lệ (ký tự ẩn) bị loại có mã + cột, nhóm hợp lệ vẫn ghi', async () => {
    const d = deps(() => ({ basis: 'cms_unit', source: 'admin', returnsPolicy: 'sales_only_v1' }))
    const j = await body(await preview(d))
    expect(j.groupsOk?.map((g) => g.productId)).toEqual(['900001'])
    expect(j.groupsRejected?.find((g) => g.key === '900002')?.errors.map((e) => e.code)).toEqual(['UNIT_CMS_INVALID_FOR_CMS_UNIT'])
    const c = await commit(d, j.runId!)
    expect(c.status).toBe(200)
    expect(d.repo.commits[0].products.map((p) => [p.product_id, p.unit_cms])).toEqual([['900001', 'Hộp']])
  })

  test('nháp chưa chọn cách tính ⇒ 409 BASIS_NOT_SET; không đọc được ⇒ 503 BASIS_UNAVAILABLE; cả hai 0 run', async () => {
    const p = deps(() => ({ basis: null, source: 'pending', returnsPolicy: 'sales_only_v1' }))
    const r1 = await preview(p)
    expect([r1.status, (await body(r1)).code]).toEqual([409, 'BASIS_NOT_SET'])
    expect(p.repo.runs.size).toBe(0)
    const u = deps(() => null)
    const r2 = await preview(u)
    expect([r2.status, (await body(r2)).code]).toEqual([503, 'BASIS_UNAVAILABLE'])
    expect(u.repo.runs.size).toBe(0)
    const t = deps(() => { throw new Error('mạng') })
    expect((await preview(t)).status).toBe(503)
  })

  test('đổi cách tính giữa preview và commit ⇒ 409 PREVIEW_STALE, 0 ghi (kể cả khi config_version giả như không đổi)', async () => {
    let cur: CmsProgramBasis = { basis: 'pos_base', source: 'admin', returnsPolicy: 'sales_only_v1' }
    const d = deps(() => cur)
    const j = await body(await preview(d))
    cur = { basis: 'cms_unit', source: 'admin', returnsPolicy: 'sales_only_v1' }
    const c = await commit(d, j.runId!)
    expect([c.status, (await body(c)).code]).toEqual([409, 'PREVIEW_STALE'])
    expect(d.repo.commits).toEqual([])
    // Chương trình về pending sau preview ⇒ 409 BASIS_NOT_SET, 0 ghi.
    cur = { basis: null, source: 'pending', returnsPolicy: 'sales_only_v1' }
    const c2 = await commit(d, j.runId!)
    expect([c2.status, (await body(c2)).code]).toEqual([409, 'BASIS_NOT_SET'])
    expect(d.repo.commits).toEqual([])
  })

  test('cột "Cách tính" tự thêm ⇒ 422 BASIS_COLUMN cả file (mẫu 9 cột và mẫu mức cố định), không bỏ qua im lặng', async () => {
    const withCol = book([[...row(900001, 'Hộp'), 'cms_unit']], [...CMS_IMPORT_COLUMNS, 'Cách tính'])
    expect(parseCmsImportXlsx(withCol)).toMatchObject({ ok: false, error: 'BASIS_COLUMN', column: 'Cách tính' })
    const r = await preview(deps(() => undefined), withCol)
    const j = await body(r)
    expect([r.status, j.code, j.column]).toEqual([422, 'BASIS_COLUMN', 'Cách tính'])
    const simpleHeader = [...CMS_SIMPLE_REQUIRED.map((f) => CMS_SIMPLE_HEADER[f]), 'quantity_basis']
    const ws = XLSX.utils.aoa_to_sheet([simpleHeader])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const simple = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    expect(parseCmsSimpleXlsx(simple)).toMatchObject({ ok: false, error: 'BASIS_COLUMN', column: 'quantity_basis' })
  })
})
