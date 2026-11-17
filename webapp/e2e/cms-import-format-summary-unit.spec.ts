import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { CMS_IMPORT_COLUMNS, parseCmsImportXlsx } from '../lib/cms/import/parse'
import { parseCmsSimpleXlsx } from '../lib/cms/import/parseSimple'
import { detectCmsImportFormat } from '../lib/cms/import/detectFormat'
import { canonicalCmsImport, validateCmsImport, type CmsProductMasterLite } from '../lib/cms/import/validate'
import { cmsImportIssueSummary } from '../lib/cms/import/issueSummary'
import {
  handleCmsImportPreview, type CmsImportDeps, type CmsImportRepo, type CmsImportRunRow, type CmsProgramRow,
} from '../lib/cms/import/handler'

// F-B / F-C (PM spec 17/11 §4–§5; IMP01 / IMP02) — thuần, không DB / mạng. ProductID giả 9xxxxx.

type Cell = string | number | null | { f: string; v?: number | string }
function sheet(rows: Cell[][]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map((c) => (c !== null && typeof c === 'object' ? null : c))))
  rows.forEach((r, ri) => r.forEach((c, ci) => {
    if (c !== null && typeof c === 'object') ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = { t: typeof c.v === 'string' ? 's' : 'n', f: c.f, v: c.v }
  }))
  return ws
}
function book(sheets: [string, Cell[][]][]): Uint8Array {
  const b = XLSX.utils.book_new()
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(b, sheet(rows), name)
  return new Uint8Array(XLSX.write(b, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
const H9 = [...CMS_IMPORT_COLUMNS] as string[]
const H7 = ['product_id', 'product_name', 'brand_name', 'ĐV tính CMS (1 item)', 'Giá bán / item (đ)', 'CMS proposal', 'CTKM']
const ADV = 'Tư vấn đã duyệt (mẫu)'
const row9 = (pid: number | string, o: Partial<Record<string, Cell>> = {}): Cell[] =>
  H9.map((h) => (h in o ? o[h]! : ({ ProductID: pid, KPI_Target_GMV_VND: null, Loai_CMS_GMV: null, Tu_SL_ban: 1, Den_SL_ban: null, CMS_VND_SP: 15000,
    Noi_dung_tu_van: ADV, unit_CMS: 'hộp', base_quantity_CMS: 1 } as Record<string, Cell>)[h]))
const NINE = book([['IMPORT_CMS', [H9, row9(900101), row9(900102)]]])
const SEVEN = book([['Sheet1', [H7, [900101, 'SP', 'B', 'hộp', 100000, 15000, 0]]]])

test.describe('F-B — nhận diện mẫu file (chữ ký tiêu đề) @desktop', () => {
  test('9 cột ở sheet IMPORT_CMS ⇒ tiers; 7 cột sheet đầu ⇒ simple', () => {
    expect(detectCmsImportFormat(NINE)).toBe('tiers')
    expect(detectCmsImportFormat(SEVEN)).toBe('simple')
  })
  test('tên sheet IMPORT_CMS một mình KHÔNG đủ: file 7 cột đặt tên sheet IMPORT_CMS ⇒ simple (parser 9 cột vẫn MISSING_COLUMNS)', () => {
    const f = book([['IMPORT_CMS', [H7, [900101, 'SP', 'B', 'hộp', 100000, 15000, 0]]]])
    expect(detectCmsImportFormat(f)).toBe('simple')
    expect(parseCmsImportXlsx(f)).toMatchObject({ ok: false, error: 'MISSING_COLUMNS' })
  })
  test('9 cột nhưng không ở sheet IMPORT_CMS ⇒ unknown (không đoán)', () => {
    expect(detectCmsImportFormat(book([['Sheet1', [H9, row9(900101)]]]))).toBe('unknown')
  })
  test('tiêu đề alias / NBSP / hoa thường vẫn khớp đúng chuẩn hoá của parser', () => {
    const h9 = H9.map((h) => `  ${h.toUpperCase()}  `)
    expect(detectCmsImportFormat(book([['IMPORT_CMS', [h9, row9(900101)]]]))).toBe('tiers')
    const h7 = ['ProductID', 'Tên sản phẩm', 'Thương hiệu', 'ĐV tính CMS', 'Giá bán/item', 'CMS proposal ', 'CTKM tháng 11']
    expect(detectCmsImportFormat(book([['Sheet1', [h7, [900101, 'SP', 'B', 'hộp', 1, 1, 0]]]]))).toBe('simple')
  })
  test('lẫn / mơ hồ / hỏng ⇒ không kết luận', () => {
    expect(detectCmsImportFormat(book([['IMPORT_CMS', [[...H9, 'product_name'], row9(900101)]]]))).toBe('unknown')
    expect(detectCmsImportFormat(book([['Sheet1', [[...H7, 'Tu_SL_ban'], [900101, 'SP', 'B', 'hộp', 1, 1, 0, 1]]]]))).toBe('unknown')
    // Sheet đầu là mẫu 7 cột, sheet IMPORT_CMS là mẫu 9 cột ⇒ ambiguous.
    expect(detectCmsImportFormat(book([['Sheet1', [H7, [900101, 'SP', 'B', 'hộp', 1, 1, 0]]], ['IMPORT_CMS', [H9, row9(900101)]]]))).toBe('ambiguous')
    // Mẫu r1 (thiếu unit_CMS / base_quantity_CMS) ⇒ không đủ chữ ký 9 cột.
    const r1 = H9.filter((h) => h !== 'unit_CMS' && h !== 'base_quantity_CMS')
    expect(detectCmsImportFormat(book([['IMPORT_CMS', [r1, [900101, null, null, 1, null, 15000, ADV]]]]))).toBe('unknown')
    expect(detectCmsImportFormat(new TextEncoder().encode('ProductID,CMS proposal\n1,2'))).toBe('unknown')
    expect(detectCmsImportFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('unknown')
  })
})

// ── route ─────────────────────────────────────────────────────────────────
const PROG = '00000000-0000-4000-8000-000000000001'
const PM = new Map<string, CmsProductMasterLite>([
  ['900101', { productName: 'SP mẫu 1', imageUrl: null, isActive: true, referencePrice: null }],
  ['900102', { productName: 'SP mẫu 2', imageUrl: null, isActive: true, referencePrice: null }],
  ['900103', { productName: 'SP mẫu 3', imageUrl: null, isActive: true, referencePrice: null }],
])
class Repo implements CmsImportRepo {
  program: CmsProgramRow = { id: PROG, status: 'draft', startDate: '2026-11-20', endDate: '2026-12-31', isTest: false, configVersion: 1, catalogTargetGmv: null }
  saved = 0
  async getProgram(id: string) { return id === PROG ? this.program : null }
  async loadContext() { return { productMaster: PM, existingProductIds: new Set<string>(), conflictProductIds: new Set<string>() } }
  async savePreview() { this.saved++; return '00000000-0000-4000-9000-000000000001' }
  async commit(): Promise<{ already: boolean }> { throw new Error('không gọi') }
  async getRun(): Promise<CmsImportRunRow | null> { return null }
}
function deps(v2: boolean) {
  const repo = new Repo()
  const d: CmsImportDeps & { repo: Repo } = {
    enabled: true, v2, repo, now: () => new Date('2026-11-10T03:00:00Z'),
    async getAccess() { return { kind: 'ok', actorId: '00000000-0000-4000-8000-0000000000aa', qa: false } },
    kProbe: async () => ({ ok: false, reason: 'CONFIG' }),
  }
  return d
}
async function preview(d: CmsImportDeps, bytes: Uint8Array, format?: string) {
  const fd = new FormData()
  fd.append('program_id', PROG)
  if (format) fd.append('format', format)
  fd.append('file', new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'f.xlsx')
  const tmp = new Response(fd)
  const body = new Uint8Array(await tmp.arrayBuffer())
  const r = await handleCmsImportPreview(new Request('http://x/api/cms/import/preview', { method: 'POST', body, headers: { 'content-type': tmp.headers.get('content-type')!, 'content-length': String(body.byteLength) } }), d)
  return { status: r.status, body: await r.json() as Record<string, any> }
}

test.describe('F-B — route báo đúng loại file, không tự đổi parser @desktop', () => {
  test('chọn "Mức cố định" cho file 9 cột ⇒ 422 WRONG_FORMAT (tiers), câu nói rõ định dạng ≠ yêu cầu target; không lưu preview', async () => {
    const d = deps(true)
    const r = await preview(d, NINE, 'simple')
    expect([r.status, r.body.code, r.body.expectedFormat, r.body.detectedFormat]).toEqual([422, 'WRONG_FORMAT', 'simple', 'tiers'])
    expect(r.body.message).toContain('Nhiều bậc / có target')
    expect(r.body.message).toContain('không phải yêu cầu chương trình có target')
    expect(r.body.message).not.toContain('product_name')
    expect((d.repo as Repo).saved).toBe(0)
  })
  test('chọn "Nhiều bậc / có target" cho file 7 cột ⇒ WRONG_FORMAT (simple); cờ v2 OFF ⇒ giữ FORMAT_UNAVAILABLE', async () => {
    const on = await preview(deps(true), SEVEN, 'tiers')
    expect([on.status, on.body.code, on.body.detectedFormat]).toEqual([422, 'WRONG_FORMAT', 'simple'])
    expect(on.body.message).toContain('Mức cố định')
    const off = await preview(deps(false), SEVEN)
    expect([off.status, off.body.code, off.body.detectedFormat]).toEqual([400, 'FORMAT_UNAVAILABLE', 'simple'])
  })
  test('không nhận diện chắc ⇒ giữ lỗi gốc, câu theo loại đã chọn', async () => {
    const r1 = H9.filter((h) => h !== 'unit_CMS' && h !== 'base_quantity_CMS')
    const old = await preview(deps(true), book([['IMPORT_CMS', [r1, [900101, null, null, 1, null, 15000, ADV]]]]), 'tiers')
    expect([old.status, old.body.code, old.body.expectedFormat]).toEqual([422, 'MISSING_COLUMNS', 'tiers'])
    expect(old.body.message).toContain('Nhiều bậc / có target')
    expect(old.body.missing).toEqual(['unit_CMS', 'base_quantity_CMS'])
    const s = await preview(deps(true), book([['Sheet1', [['product_id', 'CMS proposal'], [900101, 1]]]]), 'simple')
    expect([s.body.code, s.body.expectedFormat]).toEqual(['MISSING_COLUMNS', 'simple'])
    expect(s.body.message).toContain('Mức cố định')
    expect(s.body.message).not.toContain('unit_CMS')
    // Cả hai sheet đều thiếu cột ⇒ không chữ ký nào ⇒ giữ MISSING_COLUMNS của loại đã chọn (không đoán).
    const amb = await preview(deps(true), book([['Sheet1', [['product_id', 'CMS proposal'], [900101, 1]]], ['IMPORT_CMS', [['ProductID'], [900101]]]]), 'simple')
    expect([amb.body.code, amb.body.expectedFormat, amb.body.detectedFormat]).toEqual(['MISSING_COLUMNS', 'simple', undefined])
  })
  test('chọn nhầm loại + zip bomb / không phải ZIP / quá trần ⇒ giữ ĐÚNG lỗi file gốc, không nhận diện mẫu, không lưu preview (IMP01)', async () => {
    // Sửa kích thước giải nén khai báo của entry đầu trong central directory (như cms-p1b-route) — không giải nén thật.
    const declared = (bytes: Uint8Array, size: number) => {
      const out = bytes.slice()
      const dv = new DataView(out.buffer)
      let eocd = -1
      for (let i = out.byteLength - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
      dv.setUint32(dv.getUint32(eocd + 16, true) + 24, size, true)
      return out
    }
    const d = deps(true)
    const bomb = await preview(d, declared(NINE, 41 * 1024 * 1024), 'simple')
    expect([bomb.status, bomb.body.code, bomb.body.detectedFormat]).toEqual([422, 'FILE_TOO_COMPLEX', undefined])
    const notZip = await preview(d, new TextEncoder().encode('ProductID,CMS proposal\n1,2'), 'simple')
    expect([notZip.status, notZip.body.code, notZip.body.detectedFormat]).toEqual([422, 'NOT_XLSX', undefined])
    const big = new Uint8Array(5 * 1024 * 1024 + 1)
    big.set(SEVEN)
    const over = await preview(d, big, 'tiers')
    expect(over.status).toBe(413)
    expect(['FILE_TOO_LARGE', 'PAYLOAD_TOO_LARGE']).toContain(over.body.code)
    expect(over.body.detectedFormat).toBeUndefined()
    expect((d.repo as Repo).saved).toBe(0)
  })
  test('file đúng loại ⇒ không chạy nhận diện, phản hồi preview như cũ + issueSummary rỗng', async () => {
    const d = deps(false)
    const r = await preview(d, NINE)
    expect([r.status, r.body.ok, r.body.stats.productsOk, r.body.issueSummary]).toEqual([200, true, 2, []])
  })
})

// ── F-C ───────────────────────────────────────────────────────────────────
const ctx = { mode: 'replace' as const, productMaster: PM, existingProductIds: new Set<string>(), conflictProductIds: new Set<string>(), currentCatalogTarget: null }
const rowsOf = (bytes: Uint8Array) => { const p = parseCmsImportXlsx(bytes); if (!p.ok) throw new Error(p.error); return p.rows }

test.describe('F-C — tóm tắt lỗi theo mã + cột @desktop', () => {
  test('ô K công thức VÀ loại GMV thiếu target cùng hiện (kiểm độc lập vẫn chạy khi ô khác lỗi); nhóm vẫn loại', () => {
    const f = book([['IMPORT_CMS', [H9,
      row9(900101, { base_quantity_CMS: { f: "VLOOKUP(A2,'[x.xlsx]S'!A:B,2,0)", v: 10 }, Loai_CMS_GMV: 'GMV_THEO_PRODUCTID' }),
      row9(900102, { Loai_CMS_GMV: 'GMV_THEO_PRODUCTID' }),
      row9(900103)]]])
    const v = validateCmsImport(rowsOf(f), ctx)
    expect(v.groupsOk.map((g) => g.productId)).toEqual(['900103'])
    const by = Object.fromEntries(v.groupsRejected.map((g) => [g.key, g.errors.map((e) => `${e.code}@${e.column}`).sort()]))
    expect(by).toEqual({ 900101: ['CELL_FORMULA@base_quantity_CMS', 'GATE_MISSING_TARGET@KPI_Target_GMV_VND'], 900102: ['GATE_MISSING_TARGET@KPI_Target_GMV_VND'] })
    const s = cmsImportIssueSummary(v.groupsRejected)
    expect(s.map((x) => [x.code, x.column, x.cellCount, x.rowCount, x.productCount, x.exampleRows])).toEqual([
      ['GATE_MISSING_TARGET', 'KPI_Target_GMV_VND', 2, 2, 2, [2, 3]],
      ['CELL_FORMULA', 'base_quantity_CMS', 1, 1, 1, [2]],
    ])
    expect(s[0].fix).toContain('Nếu chương trình không xét target')
    expect(s[0].fix).toContain('nếu có target')
    // Không tự sửa: ô công thức không thành giá trị, loại GMV không bị bỏ.
    expect(v.stats).toEqual({ rowsTotal: 3, rowsOk: 1, rowsRejected: 2, productsOk: 1, productsRejected: 2, warnings: 1 })
  })

  test('ca thật thu nhỏ: 83 SP một dòng, 64 ô K công thức, 83 dòng loại GMV không target ⇒ tóm tắt 64 + 83', () => {
    const pm = new Map<string, CmsProductMasterLite>()
    const rows: Cell[][] = [H9]
    for (let i = 0; i < 83; i++) {
      const pid = 910001 + i
      pm.set(String(pid), { productName: `SP ${pid}`, imageUrl: null, isActive: true, referencePrice: null })
      rows.push(row9(pid, { Loai_CMS_GMV: 'GMV_THEO_PRODUCTID', ...(i < 64 ? { base_quantity_CMS: { f: 'VLOOKUP(A1,X!A:B,2,0)', v: 1 } } : {}) }))
    }
    const v = validateCmsImport(rowsOf(book([['IMPORT_CMS', rows]])), { ...ctx, productMaster: pm })
    const s = cmsImportIssueSummary(v.groupsRejected)
    expect(s.map((x) => [x.code, x.cellCount, x.rowCount, x.productCount])).toEqual([['GATE_MISSING_TARGET', 83, 83, 83], ['CELL_FORMULA', 64, 64, 64]])
    expect(s[0].exampleRows).toEqual([2, 3, 4, 5, 6])
    expect(v.stats.productsRejected).toBe(83)
  })

  test('nhiều lỗi cùng SP / cùng dòng không nhân số SP; nhóm nhiều bậc đếm dòng duy nhất', () => {
    const f = book([['IMPORT_CMS', [H9,
      row9(900101, { Tu_SL_ban: 1, Den_SL_ban: 9, base_quantity_CMS: { f: 'A1', v: 1 }, CMS_VND_SP: { f: 'B1', v: 1 } }),
      row9(900101, { Tu_SL_ban: 10, base_quantity_CMS: { f: 'A1', v: 1 } })]]])
    const s = cmsImportIssueSummary(validateCmsImport(rowsOf(f), ctx).groupsRejected)
    const k = s.find((x) => x.code === 'CELL_FORMULA' && x.column === 'base_quantity_CMS')!
    expect([k.cellCount, k.rowCount, k.productCount]).toEqual([2, 2, 1])
    expect(s.every((x) => x.productCount === 1)).toBe(true)
  })

  test('cột có lỗi ô không chạy kiểm phụ thuộc cột đó (không báo trùng); ProductID lỗi ⇒ không tra Master', () => {
    const f = book([['IMPORT_CMS', [H9, row9('abc', { KPI_Target_GMV_VND: { f: 'X', v: 1 }, Loai_CMS_GMV: 'GMV_THEO_PRODUCTID' })]]])
    const v = validateCmsImport(rowsOf(f), ctx)
    expect(v.groupsRejected[0].errors.map((e) => e.code).sort()).toEqual(['CELL_FORMULA', 'PRODUCT_ID_INVALID'])
  })

  test('file hợp lệ: payload / digest / stats không đổi so với chuỗi chuẩn đã ghim', () => {
    const v = validateCmsImport(rowsOf(NINE), ctx)
    expect(v.groupsRejected).toEqual([])
    expect(cmsImportIssueSummary(v.groupsRejected)).toEqual([])
    expect(canonicalCmsImport(v)).toBe(JSON.stringify({ policy: 'uncapped_last_v1', mode: 'replace', catalogTarget: null, groups: [
      ['900101', 'none', null, 'hộp', '1', ADV, 'SP mẫu 1', null, null, [[1, null, '15000']]],
      ['900102', 'none', null, 'hộp', '1', ADV, 'SP mẫu 2', null, null, [[1, null, '15000']]],
    ] }))
  })

  test('dừng ở ProductID trống + trùng cột tiêu đề mẫu đơn giản giữ luật cũ', () => {
    const p = parseCmsImportXlsx(book([['IMPORT_CMS', [H9, row9(900101), row9(''), row9(900102)]]]))
    expect(p.ok && p.rows.length === 1 && p.ignoredFromRow === 3).toBe(true)
    expect(parseCmsSimpleXlsx(book([['Sheet1', [[...H7, 'productid'], [900101, 'SP', 'B', 'hộp', 1, 1, 0, 900101]]]]))).toMatchObject({ ok: false, error: 'DUPLICATE_COLUMNS' })
  })
})
