import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import * as XLSX from 'xlsx'
import {
  CARE_ERROR_FIXES, CARE_ERROR_SHORT, CARE_IMPORT_COLUMN_RULES, CARE_IMPORT_HEADERS as CONTRACT_HEADERS, CARE_IMPORT_SHEET as CONTRACT_SHEET,
  CARE_ROW_ERROR_CODES, careColumnLetter, careOneField, type CareImportRow,
} from '../lib/care/import/contract'
import { CARE_NUMERIC_PRODUCT_ID_MAX_DIGITS, numericProductId, parseCareImportXlsx } from '../lib/care/import/parse'
import { validateCareRows } from '../lib/care/import/validate'
import { buildCarePreview, type CareExistingTask, type CareImportLookups, type CarePreviewCustomer } from '../lib/care/import/preview'
import { careAssignmentTable, careErrorCodeCounts } from '../lib/care/import/review'
import {
  CARE_PREVIEW_ERROR_LIMIT, careErrorPayload, handleCareCommit, handleCarePreview, handleCareTemplate,
  type CareFinalizeResult, type CareImportAccess, type CareImportDeps, type CareImportRepo,
} from '../lib/care/import/handler'
import { buildCareImportTemplate } from '../lib/care/import/template'
import { CARE_IMPORT_HEADERS as FIXTURE_HEADERS, CARE_IMPORT_SHEET as FIXTURE_SHEET, buildCareImportRows, buildCareImportXlsx, defaultFixtureStores } from './careImportFixture'

// CRM-CSKH B2 — lõi import THUẦN (không DB, không server): parser Excel,
// validate/gom khách, preview diff, Route Handler (deps giả: quyền, repo, đồng hồ).
// Parity với finalize SQL 114 nằm ở care-import-parity.spec.ts (PGlite).

const ROOT = path.resolve(__dirname, '..')

// ── Helpers ──────────────────────────────────────────────────────────────────
type Cell = string | number | boolean | { f: string } | null
function xlsx(aoa: Cell[][], opts: { sheets?: string[] } = {}): Uint8Array<ArrayBuffer> {
  const wb = XLSX.utils.book_new()
  for (const name of opts.sheets ?? [CONTRACT_SHEET]) {
    const ws = XLSX.utils.aoa_to_sheet(aoa.map((r) => r.map((c) => (c !== null && typeof c === 'object' ? null : c))))
    aoa.forEach((r, ri) => r.forEach((c, ci) => {
      if (c !== null && typeof c === 'object') ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = { t: 's', v: '', f: c.f }
    }))
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}
const H = [...CONTRACT_HEADERS] as Cell[]
const r = (ext: string, store: string, email: string, pid: string, over: Partial<Record<(typeof CONTRACT_HEADERS)[number], Cell>> = {}): Cell[] => {
  const base: Record<string, Cell> = {
    customer_external_id: ext, customer_name: `KH ${ext}`, customer_phone: '0390000999', target_store_code: store,
    assignee_email: email, reason_type: 'chronic', reason_text: `QA ${pid}`, product_id: pid, product_name: `SP ${pid}`,
    product_url: `https://cdn-gcs.thuocsi.vn/qa-fixture/${pid}.png`, ...over,
  }
  return CONTRACT_HEADERS.map((h) => base[h])
}
const STORES = defaultFixtureStores(25)
const EA = STORES[0].assigneeEmails[0], EB = STORES[0].assigneeEmails[1]
const sid = (i: number) => `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`
const uidOf = (email: string) => `00000000-0000-4000-9000-${crypto.createHash('md5').update(email).digest('hex').slice(0, 12)}`

function lookups(over: Partial<CareImportLookups> = {}): CareImportLookups {
  return {
    storesByCode: new Map(STORES.map((s, i) => [s.code, { id: sid(i + 1), code: s.code, name: `QA store ${i + 1}` }])),
    staff: STORES.flatMap((s, i) => s.assigneeEmails.map((e) => ({ id: uidOf(e), storeId: sid(i + 1), email: e, fullName: `QA ${e.slice(8, 12)}` }))),
    customers: new Map(), refusals: new Set(), currentTasks: new Map(),
    currentPeriodTaskCount: 0, openPreviousPeriodCount: 0, ...over,
  }
}
const previewOf = (bytes: Uint8Array, lk = lookups(), isTest = false) => {
  const p = parseCareImportXlsx(bytes)
  if (!p.ok) throw new Error(p.fileError)
  return buildCarePreview({ rowCount: p.rows.length, validated: validateCareRows(p.rows), parseErrors: p.errors, lookups: lk, period: '2026-10-01', isTest })
}
const codes = (errs: { row: number; code: string }[]) => errs.map((e) => `${e.row}:${e.code}`)

test.describe('care B2 — contract & parser Excel @desktop', () => {
  test('hợp đồng: header/sheet của lib trùng fixture B0 (một nguồn)', () => {
    expect([...CONTRACT_HEADERS]).toEqual([...FIXTURE_HEADERS])
    expect(CONTRACT_SHEET).toBe(FIXTURE_SHEET)
  })

  test('fixture B0 25 store / 100 khách: đọc đủ, không lỗi, dòng Excel gốc', () => {
    const p = parseCareImportXlsx(buildCareImportXlsx())
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.errors).toEqual([])
    expect(p.rows.length).toBe(buildCareImportRows().length)
    expect(p.rows[0].rowNo).toBe(2)
    expect(p.rows.at(-1)!.rowNo).toBe(p.rows.length + 1)
    expect(p.rows.every((x) => /^0\d{9}$/.test(x.customer_phone))).toBe(true)
  })

  test('lỗi cả file: không phải xlsx, zip hỏng, sai sheet, nhiều sheet, header sai/thiếu/dư, không dòng, vượt trần', () => {
    expect(parseCareImportXlsx(new TextEncoder().encode('customer_external_id,customer_name\nX,Y'))).toEqual({ ok: false, fileError: 'WORKBOOK_INVALID' })
    expect(parseCareImportXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]))).toEqual({ ok: false, fileError: 'WORKBOOK_INVALID' })
    expect(parseCareImportXlsx(xlsx([H, r('A', 'QAOS01', EA, 'P1')], { sheets: ['Sheet1'] }))).toEqual({ ok: false, fileError: 'SHEET_INVALID' })
    expect(parseCareImportXlsx(xlsx([H, r('A', 'QAOS01', EA, 'P1')], { sheets: ['KhachHang', 'Ghi chu'] }))).toEqual({ ok: false, fileError: 'SHEET_INVALID' })
    const swapped = [...H]; [swapped[0], swapped[1]] = [swapped[1], swapped[0]]
    expect(parseCareImportXlsx(xlsx([swapped, r('A', 'QAOS01', EA, 'P1')]))).toEqual({ ok: false, fileError: 'HEADER_INVALID' })
    expect(parseCareImportXlsx(xlsx([H.slice(0, 9), r('A', 'QAOS01', EA, 'P1').slice(0, 9)]))).toEqual({ ok: false, fileError: 'HEADER_INVALID' })
    expect(parseCareImportXlsx(xlsx([[...H, 'due_date'], [...r('A', 'QAOS01', EA, 'P1'), '2026-10-31']]))).toEqual({ ok: false, fileError: 'HEADER_INVALID' })
    expect(parseCareImportXlsx(xlsx([H]))).toEqual({ ok: false, fileError: 'NO_ROWS' })
    const six = [H, ...Array.from({ length: 6 }, (_, i) => r(`A${i}`, 'QAOS01', EA, 'P1'))]
    expect(parseCareImportXlsx(xlsx(six), 5)).toEqual({ ok: false, fileError: 'TOO_MANY_ROWS' })
    expect(parseCareImportXlsx(xlsx(six), 6).ok).toBe(true)
  })

  test('trần thật 10.000 dòng: 10.001 dòng ⇒ TOO_MANY_ROWS', () => {
    const big = [H, ...Array.from({ length: 10_001 }, (_, i) => r(`C${i}`, 'QAOS01', EA, 'P1'))]
    expect(parseCareImportXlsx(xlsx(big))).toEqual({ ok: false, fileError: 'TOO_MANY_ROWS' })
  })

  test('ô công thức, kiểu lạ ⇒ lỗi dòng; customer_external_id dạng SỐ ⇒ CELL_NOT_TEXT (Q-73); product_id số nguyên ⇒ nhận (Q-97); SĐT dạng số vẫn nhận', () => {
    const p = parseCareImportXlsx(xlsx([
      H,
      r('A', 'QAOS01', EA, 'P1', { reason_text: { f: '"QA "&"lý do"' } }),
      r('B', 'QAOS01', EA, 'P1', { customer_name: true }),
      r('C', 'QAOS01', EA, 'P1', { product_id: 12.5 }),
      r('D', 'QAOS01', EA, 'P1', { customer_external_id: 123456 }),
      r('E', 'QAOS01', EA, 'P1', { product_id: 1001 }),
      r('F', 'QAOS01', EA, 'P1', { customer_phone: 901234567, reason_type: 2026 }),
    ]))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(codes(p.errors)).toEqual(['2:FORMULA_NOT_ALLOWED', '3:CELL_NOT_TEXT', '4:CELL_NOT_TEXT', '5:CELL_NOT_TEXT'])
    expect(p.rows.find((x) => x.rowNo === 6)!.product_id).toBe('1001') // Q-97: ô Number General hợp lệ
    const f = p.rows.find((x) => x.rowNo === 7)!
    expect(f.customer_phone).toBe('901234567')
    expect(f.reason_type).toBe('2026') // cột không phải ID nhận số như chuỗi
    expect(validateCareRows([f]).customers[0].phoneNorm).toBe('0901234567')
    // ID dạng text giữ nguyên số 0 đầu.
    const t = parseCareImportXlsx(xlsx([H, r('007', 'QAOS01', EA, '0042')]))
    expect(t.ok && t.errors.length === 0 && t.rows[0].customer_external_id === '007' && t.rows[0].product_id === '0042').toBe(true)
  })

  test('Q-97: product_id ô Number — General 4/7/12/15 chữ số (kể cả hiển thị dạng mũ), format "0"; từ chối đệm số 0/#,##0/phân số/âm/16 chữ số/unsafe; luôn String(v)', () => {
    const PID = CONTRACT_HEADERS.indexOf('product_id')
    type PidCell = string | { v: number; z?: string } | { f: string }
    const cases: [PidCell, string | null][] = [
      [{ v: 1234 }, '1234'],                                        // 2: không format ⇒ General
      [{ v: 1234567, z: 'General' }, '1234567'],                    // 3
      [{ v: 123456789012 }, '123456789012'],                        // 4: 12 chữ số — w = "1.23457E+11"
      [{ v: 123456789012345 }, '123456789012345'],                  // 5: 15 chữ số — w = "1.23457E+14"
      [{ v: 123456789012345, z: '0' }, '123456789012345'],          // 6: format "0" — w === String(v)
      [{ v: 0 }, '0'],                                              // 7: biên dưới
      [{ v: 1234567, z: '000000000' }, null],                       // 8: đệm số 0 ⇒ hiển thị "001234567"
      [{ v: 1234567, z: '#,##0' }, null],                           // 9: dấu phân cách ⇒ "1,234,567"
      [{ v: 12.5 }, null],                                          // 10: phân số
      [{ v: -5 }, null],                                            // 11: âm
      [{ v: 1234567890123456 }, null],                              // 12: 16 chữ số (vẫn safe)
      [{ v: 2 ** 53 + 2 }, null],                                   // 13: không an toàn
      [{ f: '1000+1' }, null],                                      // 14: công thức
      ['0042', '0042'],                                             // 15: Text giữ nguyên số 0 đầu
    ]
    const ws = XLSX.utils.aoa_to_sheet([H, ...cases.map((_, i) => r(`Q97-${i}`, 'QAOS01', EA, 'X'))].map((row) => row.map((c) => (c !== null && typeof c === 'object' ? null : c))))
    cases.forEach(([cell], i) => {
      const ref = XLSX.utils.encode_cell({ r: i + 1, c: PID })
      if (typeof cell === 'string') ws[ref] = { t: 's', v: cell }
      else if ('f' in cell) ws[ref] = { t: 's', v: '', f: cell.f }
      else ws[ref] = { t: 'n', v: cell.v, ...(cell.z ? { z: cell.z } : {}) }
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, CONTRACT_SHEET)
    const p = parseCareImportXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(codes(p.errors)).toEqual(['8:CELL_NOT_TEXT', '9:CELL_NOT_TEXT', '10:CELL_NOT_TEXT', '11:CELL_NOT_TEXT', '12:CELL_NOT_TEXT', '13:CELL_NOT_TEXT', '14:FORMULA_NOT_ALLOWED'])
    cases.forEach(([, want], i) => { if (want !== null) expect(p.rows.find((x) => x.rowNo === i + 2)!.product_id, `dòng ${i + 2}`).toBe(want) })
    // Hàm thuần: format khác General chỉ nhận khi w === String(v); không bao giờ lấy w làm giá trị.
    expect(numericProductId({ v: 1234567, z: '@', w: '1234567' })).toBe('1234567')
    expect(numericProductId({ v: 1234567, z: '0.00', w: '1234567.00' })).toBeNull()
    expect(numericProductId({ v: 1234567, z: '"SP"0', w: 'SP1234567' })).toBeNull()
    expect(numericProductId({ v: 123456789012345, z: 'General', w: '1.23457E+14' })).toBe('123456789012345')
    expect(numericProductId({ v: -0 })).toBe('0')
    expect(numericProductId({ v: '1234' as unknown as number })).toBeNull()
    expect(CARE_NUMERIC_PRODUCT_ID_MAX_DIGITS).toBe(15)
  })

  test('Q-97: Text "7654321" và Number 7654321 cùng khách ⇒ cùng ID ⇒ DUPLICATE_PRODUCT; preview Number = preview Text', () => {
    const PID = CONTRACT_HEADERS.indexOf('product_id')
    const build = (numericRows: number[], rows: Cell[][]) => {
      const ws = XLSX.utils.aoa_to_sheet([H, ...rows])
      for (const i of numericRows) ws[XLSX.utils.encode_cell({ r: i + 1, c: PID })] = { t: 'n', v: Number(rows[i][PID]) }
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, CONTRACT_SHEET)
      return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    }
    const dup = previewOf(build([1], [r('D', 'QAOS01', EA, '7654321'), r('D', 'QAOS01', EA, '7654321', { reason_text: 'khác' })]))
    expect(codes(dup.errors)).toEqual(['2:DUPLICATE_PRODUCT', '3:DUPLICATE_PRODUCT'])
    const rows = [r('N', 'QAOS01', EA, '1234'), r('N', 'QAOS01', EA, '123456789012345'), r('M', 'QAOS01', EB, '1234567')]
    const asText = previewOf(build([], rows))
    const asNumber = previewOf(build([0, 1, 2], rows))
    expect(asNumber.errors).toEqual([])
    expect(JSON.stringify(asNumber.customers)).toBe(JSON.stringify(asText.customers))
    expect(asNumber.counts).toEqual(asText.counts)
    // Cùng chuỗi ID tới tận dữ liệu gom khách (thứ được stage cho finalize).
    const parsedIds = (bytes: Uint8Array) => {
      const p = parseCareImportXlsx(bytes)
      if (!p.ok) throw new Error(p.fileError)
      return validateCareRows(p.rows).customers.map((c) => [c.externalId, c.products.map((x) => x.product_id)])
    }
    expect(parsedIds(build([0, 1, 2], rows))).toEqual([['N', ['1234', '123456789012345']], ['M', ['1234567']]])
    expect(parsedIds(build([0, 1, 2], rows))).toEqual(parsedIds(build([], rows)))
  })

  test('Q-104: product_id toàn số 0 (Number 0, Text "0"/"00") ⇒ PRODUCT_ID_INVALID; "0042"/"10" hợp lệ', () => {
    const PID = CONTRACT_HEADERS.indexOf('product_id')
    const rows = [r('Z1', 'QAOS01', EA, '0'), r('Z2', 'QAOS01', EA, '00'), r('Z3', 'QAOS01', EA, '0'), r('Z4', 'QAOS01', EA, '0042'), r('Z5', 'QAOS01', EA, '10')]
    const ws = XLSX.utils.aoa_to_sheet([H, ...rows])
    ws[XLSX.utils.encode_cell({ r: 3, c: PID })] = { t: 'n', v: 0 } // dòng 4 (Z3): ô Number 0
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, CONTRACT_SHEET)
    const p = previewOf(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer))
    expect(codes(p.errors)).toEqual(['2:PRODUCT_ID_INVALID', '3:PRODUCT_ID_INVALID', '4:PRODUCT_ID_INVALID'])
    // Hàm validate thuần: cùng luật cho mọi đường (không phụ thuộc parser).
    const one: CareImportRow = {
      rowNo: 9, customer_external_id: 'Z9', customer_name: 'KH Z9', customer_phone: '0390000999', target_store_code: 'QAOS01',
      assignee_email: EA, reason_type: 'chronic', reason_text: 'QA', product_id: '000', product_name: 'SP', product_url: '',
    }
    expect(codes(validateCareRows([one]).errors)).toEqual(['9:PRODUCT_ID_INVALID'])
    expect(validateCareRows([{ ...one, product_id: '100' }]).errors).toEqual([])
  })

  test('dòng trống xen giữa ⇒ BLANK_ROW; dòng trống cuối bỏ qua', () => {
    const blank = Array(10).fill(null) as Cell[]
    const p = parseCareImportXlsx(xlsx([H, r('A', 'QAOS01', EA, 'P1'), blank, r('B', 'QAOS01', EA, 'P1'), blank, blank]))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(codes(p.errors)).toEqual(['3:BLANK_ROW'])
    expect(p.rows.map((x) => x.rowNo)).toEqual([2, 4])
  })
})

test.describe('care B2 — validate & gom khách (mirror finalize 114) @desktop', () => {
  const row = (rowNo: number, over: Partial<CareImportRow> = {}): CareImportRow => ({
    rowNo, customer_external_id: 'K1', customer_name: 'KH 1', customer_phone: '0390000001', target_store_code: 'QAOS01',
    assignee_email: EA, reason_type: 'chronic', reason_text: 'QA', product_id: `P${rowNo}`, product_name: 'SP',
    product_url: '', ...over,
  })

  test('nhiều dòng sản phẩm cùng khách ⇒ MỘT khách, lý do giữ theo sản phẩm, sắp theo product_id', () => {
    const v = validateCareRows([row(2, { product_id: 'P9', reason_text: 'lý do 9' }), row(3, { product_id: 'P1', reason_text: 'lý do 1' })])
    expect(v.errors).toEqual([])
    expect(v.customers).toHaveLength(1)
    expect(v.customers[0].products.map((p) => [p.product_id, p.reason_text, p.image_url])).toEqual([['P1', 'lý do 1', null], ['P9', 'lý do 9', null]])
    expect(v.customers[0].rows).toEqual([2, 3])
  })

  test('mã lỗi theo dòng giống SQL: thiếu cột, quá dài, SĐT, link ảnh, trùng sản phẩm, khách không nhất quán', () => {
    const v = validateCareRows([
      row(2, { customer_name: '' }),
      row(3, { customer_external_id: 'K'.repeat(101) }),
      row(4, { customer_external_id: 'K4', customer_phone: '0201234567' }),
      row(5, { customer_external_id: 'K5', product_url: 'https://storage.googleapis.com/x.png' }),
      row(6, { customer_external_id: 'K6', product_id: 'PX' }), row(7, { customer_external_id: 'K6', product_id: 'PX', reason_text: 'khác' }),
      row(8, { customer_external_id: 'K8' }), row(9, { customer_external_id: 'K8', customer_name: 'Tên khác' }),
    ])
    expect(codes(v.errors)).toEqual([
      '2:FIELD_REQUIRED', '3:TOO_LONG', '4:PHONE_INVALID', '5:IMAGE_URL_HOST',
      '6:DUPLICATE_PRODUCT', '7:DUPLICATE_PRODUCT', '8:INCONSISTENT_CUSTOMER', '9:INCONSISTENT_CUSTOMER',
    ])
  })

  test('so sau chuẩn hoá: SĐT khác định dạng, email khác hoa/thường vẫn là cùng khách', () => {
    const v = validateCareRows([row(2, { customer_phone: '0390 000 001' }), row(3, { customer_phone: '+84390000001', assignee_email: EA.toUpperCase() })])
    expect(v.errors).toEqual([])
    expect(v.customers[0].phoneNorm).toBe('0390000001')
    expect(v.customers[0].email).toBe(EA)
  })
})

test.describe('care B2 — preview diff (mirror finalize 114) @desktop', () => {
  test('fixture 25 store: tạo 100 task, nhóm phân công đủ 25 store, kỳ/hạn VN', () => {
    const p = previewOf(buildCareImportXlsx())
    expect(p.errors).toEqual([])
    expect(p.customerCount).toBe(100)
    expect(p.counts.created).toBe(100)
    expect(p.storeCodesInFile).toBe(25)
    expect(p.activeOsStoreCount).toBe(25)
    expect(p.activeOsStoresMissing).toEqual([])
    expect(p.assignments).toHaveLength(25)
    expect(p.assignments.reduce((s, g) => s + g.customers, 0)).toBe(100)
    expect(p.period).toBe('2026-10-01')
    expect(p.dueDate).toBe('2026-10-31')
  })

  test('store/email/DNC/is_test ⇒ đúng mã của finalize; lỗi ở một khách đánh dấu mọi dòng khách đó', () => {
    const lk = lookups()
    lk.staff.push({ id: 'dup', storeId: sid(1), email: EB, fullName: 'QA trùng email' }) // EB có 2 ứng viên ở QAOS01
    lk.customers.set('K-REF', { id: 'c-ref', isTest: false })
    lk.refusals.add(`c-ref|${sid(1)}`)
    lk.customers.set('K-REF-OTHER', { id: 'c-ref2', isTest: false })
    lk.refusals.add(`c-ref2|${sid(2)}`)
    lk.customers.set('K-TEST', { id: 'c-test', isTest: true })
    const p = previewOf(xlsx([
      H,
      r('K-STORE', 'QAOS99', EA, 'P1'),
      r('K-NOSTAFF', 'QAOS01', 'khong.co@example.invalid', 'P1'),
      r('K-AMB', 'QAOS01', EB, 'P1'), r('K-AMB', 'QAOS01', EB, 'P2'),
      r('K-REF', 'QAOS01', EA, 'P1'),
      r('K-REF-OTHER', 'QAOS01', EA, 'P1'),
      r('K-TEST', 'QAOS01', EA, 'P1'),
    ]), lk)
    expect(codes(p.errors)).toEqual(['2:STORE_INVALID', '3:ASSIGNEE_INVALID', '4:ASSIGNEE_AMBIGUOUS', '5:ASSIGNEE_AMBIGUOUS', '6:REFUSED_AT_STORE', '8:TEST_FLAG_MISMATCH'])
    // Độ phủ chỉ đếm store OS active (QAOS99 sai mã không được tính) — không bao giờ "x/y" với x > y.
    expect(p.storeCodesInFile).toBe(1)
    expect(p.storeCodesInFile).toBeLessThanOrEqual(p.activeOsStoreCount)
    expect(p.customers.find((c) => c.externalId === 'K-REF-OTHER')!.action).toBe('create') // từ chối store khác ⇒ vẫn nhận
    expect(p.counts.created).toBe(1)
  })

  test('file sửa cùng tháng: cập nhật / không đổi / giữ (đã có lượt) / owner bỏ qua / khách vắng / kỳ trước sẽ đóng', () => {
    const base: Omit<CareExistingTask, 'id' | 'customerId'> = {
      status: 'open', storeId: sid(1), assigneeId: uidOf(EA), customerName: 'KH K1', phoneNorm: '0390000999', phoneRaw: '0390000999',
      isTest: false, hasInteraction: false,
      products: [{ product_id: 'P1', product_name: 'SP P1', image_url: 'https://cdn-gcs.thuocsi.vn/qa-fixture/P1.png', reason_type: 'chronic', reason_text: 'QA P1' }],
    }
    const lk = lookups({ currentPeriodTaskCount: 6, openPreviousPeriodCount: 3 })
    const add = (ext: string, over: Partial<CareExistingTask> = {}) => {
      lk.customers.set(ext, { id: `c-${ext}`, isTest: false })
      lk.currentTasks.set(`c-${ext}`, { ...base, id: `t-${ext}`, customerId: `c-${ext}`, customerName: `KH ${ext}`, ...over })
    }
    add('K-SAME'); add('K-REASON'); add('K-NAME'); add('K-LOCK', { hasInteraction: true }); add('K-OWNER', { assigneeId: uidOf(EB) }); add('K-ABSENT')
    const p = previewOf(xlsx([
      H,
      r('K-SAME', 'QAOS01', EA, 'P1'),
      r('K-REASON', 'QAOS01', EA, 'P1', { reason_text: 'lý do mới' }),
      r('K-NAME', 'QAOS01', EA, 'P1', { customer_name: 'Tên đổi' }),
      r('K-LOCK', 'QAOS01', EA, 'P1', { reason_text: 'không áp' }),
      r('K-OWNER', 'QAOS01', EA, 'P1'),
      r('K-NEW', 'QAOS01', EA, 'P1'),
    ]), lk)
    expect(p.errors).toEqual([])
    expect(p.counts).toEqual({ created: 1, updated: 2, unchanged: 2, skipped_has_interaction: 1, owner_ignored: 1, absent_kept: 1, closed_previous_period: 3 })
    expect(p.customers.find((c) => c.externalId === 'K-OWNER')).toMatchObject({ action: 'unchanged', ownerIgnored: true })
  })

  test('store OS active vắng trong file được liệt kê (không hardcode 25)', () => {
    const p = previewOf(xlsx([H, r('K1', 'QAOS01', EA, 'P1')]))
    expect(p.storeCodesInFile).toBe(1)
    expect(p.activeOsStoresMissing.map((s) => s.code)).toEqual(STORES.slice(1).map((s) => s.code))
  })
})

// ── Handler (deps giả) ───────────────────────────────────────────────────────
type Spy = { calls: { fn: string; args: unknown[] }[] }
function fakeRepo(spy: Spy, over: Partial<CareImportRepo> = {}, lk: () => CareImportLookups = () => lookups()): CareImportRepo {
  const rec = (fn: string, args: unknown[]) => spy.calls.push({ fn, args })
  return {
    loadLookups: async (i) => { rec('loadLookups', [i]); return lk() },
    createBatch: async (i) => { rec('createBatch', [i]); return 'batch-1' },
    stageRows: async (b, rows) => { rec('stageRows', [b, rows]) },
    finalize: async (b, a) => { rec('finalize', [b, a]); return { status: 'committed', batch_id: b, created: 100 } as CareFinalizeResult },
    discardBatch: async (b) => { rec('discardBatch', [b]) },
    purgeStaleStaging: async () => { rec('purgeStaleStaging', []) },
    ...over,
  }
}
function deps(spy: Spy, over: Partial<CareImportDeps> = {}, access: CareImportAccess = { kind: 'ok', actorId: 'actor-mkt' }): CareImportDeps {
  return {
    enabled: true, maxBytes: 8 * 1024 * 1024,
    getAccess: async () => { spy.calls.push({ fn: 'getAccess', args: [] }); return access },
    repo: fakeRepo(spy), now: () => new Date('2026-10-10T03:00:00Z'), stageChunk: 50, ...over,
  }
}
async function multipart(fields: Record<string, string | { name: string; type?: string; bytes: Uint8Array }>, extraFiles = 0) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') fd.append(k, v)
    else fd.append(k, new File([new Uint8Array(v.bytes)], v.name, { type: v.type ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  }
  for (let i = 0; i < extraFiles; i++) fd.append(`extra${i}`, new File([new Uint8Array([1])], 'x.xlsx'))
  const tmp = new Request('http://local/x', { method: 'POST', body: fd })
  return { body: new Uint8Array(await tmp.arrayBuffer()), contentType: tmp.headers.get('content-type')! }
}
function req(body: Uint8Array, contentType: string, opts: { length?: string | null } = {}) {
  const headers = new Headers({ 'content-type': contentType })
  const len = opts.length === undefined ? String(body.byteLength) : opts.length
  if (len !== null) headers.set('content-length', len)
  return new Request('http://local/api/care/import/preview', { method: 'POST', headers, body, duplex: 'half' } as RequestInit)
}
const fixtureBytes = buildCareImportXlsx()
const fileField = { name: 'care_T10.xlsx', bytes: fixtureBytes }
const sha = crypto.createHash('sha256').update(fixtureBytes).digest('hex')
const writes = (s: Spy) => s.calls.filter((c) => ['createBatch', 'stageRows', 'finalize', 'discardBatch'].includes(c.fn))

test.describe('care B2 — Route Handler (deps giả) @desktop', () => {
  test('cờ OFF ⇒ 404 và không chạm quyền/DB', async () => {
    const s: Spy = { calls: [] }
    const m = await multipart({ file: fileField })
    const res = await handleCarePreview(req(m.body, m.contentType), deps(s, { enabled: false }))
    expect(res.status).toBe(404)
    expect(s.calls).toEqual([])
  })

  test('quyền: anonymous 401 · không quyền 403 · DB chưa sẵn 503 — không đọc body, không gọi repo', async () => {
    for (const [access, status] of [[{ kind: 'anonymous' }, 401], [{ kind: 'forbidden' }, 403], [{ kind: 'unavailable' }, 503]] as const) {
      const s: Spy = { calls: [] }
      const m = await multipart({ file: fileField })
      expect((await handleCarePreview(req(m.body, m.contentType), deps(s, {}, access))).status).toBe(status)
      expect((await handleCareCommit(req(m.body, m.contentType), deps(s, {}, access))).status).toBe(status)
      expect(s.calls.every((c) => c.fn === 'getAccess')).toBe(true)
    }
  })

  test('byte-cap: thiếu Content-Length 411 · header vượt 413 · thân vượt 413 · thân hụt/thừa 400', async () => {
    const s: Spy = { calls: [] }
    const m = await multipart({ file: fileField })
    expect((await handleCarePreview(req(m.body, m.contentType, { length: null }), deps(s))).status).toBe(411)
    expect((await handleCarePreview(req(m.body, m.contentType, { length: String(9 * 1024 * 1024) }), deps(s))).status).toBe(413)
    expect((await handleCarePreview(req(m.body, m.contentType), deps(s, { maxBytes: 4096 }))).status).toBe(413)
    expect((await handleCarePreview(req(m.body.slice(0, 1000), m.contentType, { length: String(m.body.byteLength) }), deps(s))).status).toBe(400)
    expect((await handleCarePreview(req(m.body, m.contentType, { length: '100' }), deps(s))).status).toBe(400)
    expect((await handleCarePreview(req(m.body, m.contentType, { length: 'abc' }), deps(s))).status).toBe(400)
    expect(s.calls.filter((c) => c.fn !== 'getAccess')).toEqual([])
  })

  test('multipart/kiểu file: không multipart 400 · hai file 400 · đuôi/MIME sai 415 · CSV đổi tên .xlsx 422', async () => {
    const s: Spy = { calls: [] }
    const raw = new TextEncoder().encode('not multipart')
    expect((await handleCarePreview(req(raw, 'application/json'), deps(s))).status).toBe(400)
    const two = await multipart({ file: fileField }, 1)
    expect((await (await handleCarePreview(req(two.body, two.contentType), deps(s))).json()).code).toBe('FILE_REQUIRED')
    const csv = await multipart({ file: { name: 'care.csv', type: 'text/csv', bytes: fixtureBytes } })
    expect((await handleCarePreview(req(csv.body, csv.contentType), deps(s))).status).toBe(415)
    const mime = await multipart({ file: { name: 'care.xlsx', type: 'text/html', bytes: fixtureBytes } })
    expect((await handleCarePreview(req(mime.body, mime.contentType), deps(s))).status).toBe(415)
    const fake = await multipart({ file: { name: 'care.xlsx', bytes: new TextEncoder().encode('a,b\n1,2') } })
    const res = await handleCarePreview(req(fake.body, fake.contentType), deps(s))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('WORKBOOK_INVALID')
  })

  test('preview OK: sha256 server, đếm, phân công — và KHÔNG ghi gì', async () => {
    const s: Spy = { calls: [] }
    const m = await multipart({ file: fileField })
    const res = await handleCarePreview(req(m.body, m.contentType), deps(s))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sha256).toBe(sha)
    expect(body.preview).toMatchObject({ period: '2026-10-01', dueDate: '2026-10-31', customerCount: 100, errorCount: 0, storeCodesInFile: 25 })
    expect(body.preview.counts.created).toBe(100)
    expect(writes(s)).toEqual([])
    expect(s.calls.find((c) => c.fn === 'loadLookups')!.args[0]).toMatchObject({ isTest: false, period: '2026-10-01' })
  })

  test('commit: sha lệch 409 · kỳ lệch 409 · qua nửa đêm cuối tháng VN ⇒ PERIOD_CHANGED — không ghi', async () => {
    const s: Spy = { calls: [] }
    const bad = await multipart({ file: fileField, sha256: 'f'.repeat(64), period: '2026-10-01' })
    expect((await (await handleCareCommit(req(bad.body, bad.contentType), deps(s))).json()).code).toBe('SHA_MISMATCH')
    const wrongP = await multipart({ file: fileField, sha256: sha, period: '2026-09-01' })
    expect((await handleCareCommit(req(wrongP.body, wrongP.contentType), deps(s))).status).toBe(409)
    // Preview 23:59 VN 31/10 (kỳ 10) → commit 00:00 VN 01/11 (kỳ 11).
    const late = await multipart({ file: fileField, sha256: sha, period: '2026-10-01' })
    const res = await handleCareCommit(req(late.body, late.contentType), deps(s, { now: () => new Date('2026-10-31T17:00:00Z') }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'PERIOD_CHANGED', period: '2026-11-01' })
    expect(writes(s)).toEqual([])
  })

  test('commit có lỗi dữ liệu ⇒ 422 HAS_ERRORS, không tạo batch; phản hồi chỉ có mã + dòng', async () => {
    const s: Spy = { calls: [] }
    const bytes = xlsx([H, r('K1', 'QAOS99', EA, 'P1')])
    const m = await multipart({ file: { name: 'x.xlsx', bytes }, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), period: '2026-10-01' })
    const res = await handleCareCommit(req(m.body, m.contentType), deps(s))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'HAS_ERRORS', errorCount: 1, errors: [{ row: 2, code: 'STORE_INVALID' }] })
    expect(JSON.stringify(body)).not.toContain('KH K1')
    expect(writes(s)).toEqual([])
  })

  test('commit OK: actor/is_test/kỳ do server quyết; tên file kỹ thuật; staging liên tục theo khối rồi finalize', async () => {
    const s: Spy = { calls: [] }
    const m = await multipart({ file: fileField, sha256: sha, period: '2026-10-01', is_test: 'true', actor: 'hacker', created: '999' })
    const res = await handleCareCommit(req(m.body, m.contentType), deps(s))
    expect(res.status).toBe(200)
    expect((await res.json()).result).toMatchObject({ status: 'committed', batch_id: 'batch-1' })
    const create = s.calls.find((c) => c.fn === 'createBatch')!.args[0] as Record<string, unknown>
    expect(create).toMatchObject({ period: '2026-10-01', isTest: false, actorId: 'actor-mkt', sha256: sha, rowCount: buildCareImportRows().length })
    expect(create.fileName).toBe(`care-import-2026-10-${sha.slice(0, 12)}.xlsx`)
    const stages = s.calls.filter((c) => c.fn === 'stageRows').map((c) => c.args[1] as { row_no: number; payload: Record<string, string> }[])
    expect(stages.length).toBe(Math.ceil(buildCareImportRows().length / 50))
    const rowNos = stages.flat().map((x) => x.row_no)
    expect(rowNos).toEqual(Array.from({ length: rowNos.length }, (_, i) => i + 2))
    expect(Object.keys(stages[0][0].payload)).toEqual([...CONTRACT_HEADERS])
    expect(s.calls.find((c) => c.fn === 'finalize')!.args).toEqual(['batch-1', 'actor-mkt'])
    expect(s.calls.some((c) => c.fn === 'discardBatch')).toBe(false)
  })

  test('lỗi staging giữa chừng ⇒ dọn batch, KHÔNG finalize; finalize lỗi ⇒ dọn batch, 500', async () => {
    const s: Spy = { calls: [] }
    let n = 0
    const failStage = deps(s, { repo: fakeRepo(s, { stageRows: async () => { if (++n === 2) throw new Error('boom') } }) })
    const m = await multipart({ file: fileField, sha256: sha, period: '2026-10-01' })
    const res = await handleCareCommit(req(m.body, m.contentType), failStage)
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('STAGING_FAILED')
    expect(s.calls.some((c) => c.fn === 'finalize')).toBe(false)
    expect(s.calls.filter((c) => c.fn === 'discardBatch').map((c) => c.args[0])).toEqual(['batch-1'])

    const s2: Spy = { calls: [] }
    const failFin = deps(s2, { repo: fakeRepo(s2, { finalize: async () => { throw new Error('care_import_finalize: actor không có quyền import CRM') } }) })
    const m2 = await multipart({ file: fileField, sha256: sha, period: '2026-10-01' })
    const res2 = await handleCareCommit(req(m2.body, m2.contentType), failFin)
    expect(res2.status).toBe(500)
    const body2 = await res2.json()
    expect(body2.code).toBe('FINALIZE_FAILED')
    expect(JSON.stringify(body2)).not.toContain('actor không có quyền') // không lộ message DB
    expect(s2.calls.some((c) => c.fn === 'discardBatch')).toBe(true)
  })

  test('kết quả rejected/duplicate của finalize đi thẳng ra client (không biến thành thành công)', async () => {
    for (const result of [
      { status: 'rejected', batch_id: 'b', error_count: 1, errors: [{ row: 5, code: 'REFUSED_AT_STORE' }] },
      { status: 'duplicate', batch_id: 'b', duplicate_of: 'b0' },
    ] as CareFinalizeResult[]) {
      const s: Spy = { calls: [] }
      const m = await multipart({ file: fileField, sha256: sha, period: '2026-10-01' })
      const res = await handleCareCommit(req(m.body, m.contentType), deps(s, { repo: fakeRepo(s, { finalize: async () => result }) }))
      expect((await res.json()).result).toEqual(result)
    }
  })

  test('file mẫu: cổng cờ + quyền; tải về đọc lại hợp lệ (1 khách / 2 sản phẩm, dữ liệu giả)', async () => {
    const s: Spy = { calls: [] }
    expect((await handleCareTemplate(deps(s, { enabled: false }), buildCareImportTemplate)).status).toBe(404)
    expect((await handleCareTemplate(deps(s, {}, { kind: 'forbidden' }), buildCareImportTemplate)).status).toBe(403)
    const res = await handleCareTemplate(deps(s), buildCareImportTemplate)
    expect(res.status).toBe(200)
    const p = parseCareImportXlsx(new Uint8Array(await res.arrayBuffer()))
    expect(p.ok && p.errors.length === 0 && p.rows.length === 2).toBe(true)
    if (p.ok) expect(validateCareRows(p.rows).customers).toHaveLength(1)
    if (p.ok) expect(p.rows.every((x) => x.assignee_email.endsWith('@example.invalid'))).toBe(true)
  })
})

test.describe('care B2 — nguồn route/page @desktop', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  test('route chỉ nối deps thật; page kiểm cờ trước, quyền sau; repo service role tách khỏi handler', () => {
    for (const r of ['app/api/care/import/preview/route.ts', 'app/api/care/import/commit/route.ts', 'app/api/care/import/template/route.ts']) {
      const src = read(r)
      expect(src, r).toContain('careImportDeps()')
      expect(src, r).not.toMatch(/supabaseAdmin|createClient/)
    }
    const page = read('app/(dashboard)/care/assign/page.tsx')
    expect(page.indexOf('if (!isCareEnabled()) notFound()')).toBeGreaterThan(-1)
    expect(page.indexOf('if (!isCareEnabled()) notFound()')).toBeLessThan(page.indexOf('getCareImportAccess()'))
    expect(page).not.toContain('supabaseAdmin')
    expect(read('lib/care/import/handler.ts')).not.toMatch(/supabase|next\//)
    expect(read('lib/care/server/importRepo.ts')).toMatch(/^import 'server-only'/)
    // Không ghi thẳng bảng nghiệp vụ — chỉ batch/staging + RPC finalize.
    expect(read('lib/care/server/importRepo.ts')).not.toMatch(/from\('care_(tasks|customers|task_products)'\)\s*\.(insert|update|upsert|delete)/)
  })
})

test.describe('care B2 — sửa sau review (zip bomb, staging kẹt, kỳ đổi lúc finalize) @desktop', () => {
  test('zip bomb: kích thước giải nén khai báo vượt trần / quá nhiều entry ⇒ WORKBOOK_INVALID trước khi SheetJS inflate', async () => {
    const { zipWithinLimits, CARE_XLSX_MAX_UNCOMPRESSED } = await import('../lib/care/import/parse')
    expect(zipWithinLimits(fixtureBytes)).toBe(true)
    // Vá central directory của file thật: khai báo uncompressed = trần + 1 cho entry đầu.
    const bomb = new Uint8Array(fixtureBytes)
    const dv = new DataView(bomb.buffer)
    let eocd = -1
    for (let i = bomb.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
    const cd = dv.getUint32(eocd + 16, true)
    dv.setUint32(cd + 24, CARE_XLSX_MAX_UNCOMPRESSED + 1, true)
    expect(zipWithinLimits(bomb)).toBe(false)
    expect(parseCareImportXlsx(bomb)).toEqual({ ok: false, fileError: 'WORKBOOK_INVALID' })
    expect(zipWithinLimits(fixtureBytes, CARE_XLSX_MAX_UNCOMPRESSED, 2)).toBe(false)
    // EOCD hỏng / thiếu ⇒ từ chối.
    expect(zipWithinLimits(fixtureBytes.slice(0, fixtureBytes.length - 30))).toBe(false)
  })

  test('commit dọn batch staged kẹt trước khi tạo batch mới; lỗi dọn không chặn import', async () => {
    const s: Spy = { calls: [] }
    const m = await multipart({ file: fileField, sha256: sha, period: '2026-10-01' })
    const failingPurge = deps(s, { repo: fakeRepo(s, { purgeStaleStaging: async () => { s.calls.push({ fn: 'purgeStaleStaging', args: [] }); throw new Error('x') } }) })
    const res = await handleCareCommit(req(m.body, m.contentType), failingPurge)
    expect(res.status).toBe(200)
    const order = s.calls.map((c) => c.fn).filter((f) => ['purgeStaleStaging', 'createBatch'].includes(f))
    expect(order).toEqual(['purgeStaleStaging', 'createBatch'])
  })

  test('finalize RAISE kỳ lệch (qua nửa đêm giữa stage và finalize) ⇒ 409 PERIOD_CHANGED + dọn batch, không phải 500', async () => {
    const { CARE_PERIOD_CHANGED } = await import('../lib/care/import/handler')
    const s: Spy = { calls: [] }
    const m = await multipart({ file: fileField, sha256: sha, period: '2026-10-01' })
    const res = await handleCareCommit(req(m.body, m.contentType), deps(s, { repo: fakeRepo(s, { finalize: async () => { throw new Error(CARE_PERIOD_CHANGED) } }) }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PERIOD_CHANGED')
    expect(s.calls.some((c) => c.fn === 'discardBatch')).toBe(true)
    // Repo map đúng chuỗi RAISE của 114 sang mã này.
    expect(fs.readFileSync(path.join(ROOT, 'lib/care/server/importRepo.ts'), 'utf8')).toContain('/khác tháng hiện tại/')
    expect(fs.readFileSync(path.join(ROOT, '..', 'supabase/migrations/114_care_crm_foundation.sql'), 'utf8')).toContain('khác tháng hiện tại theo giờ VN')
  })

  test('lỗi bất ngờ trong phân tích ⇒ 500 PREVIEW_FAILED (mã ổn định, không lộ chi tiết)', async () => {
    const s: Spy = { calls: [] }
    const m = await multipart({ file: fileField })
    // Lookup trả dữ liệu hỏng ⇒ buildCarePreview ném TypeError bên trong analyze.
    const broken = { ...lookups(), storesByCode: undefined } as unknown as CareImportLookups
    const res = await handleCarePreview(req(m.body, m.contentType), deps(s, { repo: fakeRepo(s, {}, () => broken) }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('PREVIEW_FAILED')
    expect(JSON.stringify(body)).not.toMatch(/TypeError|undefined|storesByCode/)
    // loadLookups ném ⇒ 503 LOOKUP_FAILED (không lộ message).
    const res2 = await handleCarePreview(req(m.body, m.contentType), deps(s, { repo: fakeRepo(s, {}, () => { throw new Error('secret 0390000001') }) }))
    expect(res2.status).toBe(503)
    expect(JSON.stringify(await res2.json())).not.toContain('secret')
  })
})

test.describe('care B2 r1.1 — fetchExact lookup fail-closed (audit PM B2 P1-1) @desktop', () => {
  type P = { data: { id: number }[] | null; error: { message: string } | null; count: number | null }
  const rows = (from: number, to: number, total: number) => Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => ({ id: from + i }))
  const adapter = (total: number, opts: { maxRows?: number; count?: (call: number) => number | null; dropAt?: number; error?: boolean } = {}) => {
    let call = 0
    return (from: number, to: number): Promise<P> => {
      call++
      const end = Math.min(to, from + (opts.maxRows ?? 1e9) - 1)
      const data = opts.dropAt !== undefined && from >= opts.dropAt ? [] : rows(from, end, total)
      return Promise.resolve({ data, error: opts.error ? { message: 'x' } : null, count: opts.count ? opts.count(call) : total })
    }
  }
  test('đủ dữ liệu qua nhiều trang, kể cả khi max-rows PostgREST nhỏ hơn trang yêu cầu', async () => {
    const { fetchExact } = await import('../lib/care/import/fetchExact')
    expect((await fetchExact(adapter(2500))).length).toBe(2500)
    expect((await fetchExact(adapter(2500, { maxRows: 300 }))).map((r) => r.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i))
    expect(await fetchExact(adapter(0))).toEqual([])
  })
  test('count=null / count đổi giữa trang / thiếu trang / lỗi truy vấn ⇒ ném lỗi', async () => {
    const { fetchExact, CareLookupError } = await import('../lib/care/import/fetchExact')
    const reason = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return e instanceof CareLookupError ? e.reason : 'other' } }
    expect(await reason(fetchExact(adapter(10, { count: () => null })))).toBe('count_missing')
    expect(await reason(fetchExact(adapter(2500, { count: (c) => (c === 1 ? 2500 : 2400) })))).toBe('count_changed')
    expect(await reason(fetchExact(adapter(2500, { dropAt: 1000 })))).toBe('incomplete')
    expect(await reason(fetchExact(adapter(10, { error: true })))).toBe('query_error')
    expect(await reason(fetchExact(adapter(50, { count: () => 10 })))).toBe('too_many')
  })
  test('lookup thiếu ⇒ handler 503 LOOKUP_FAILED, không trả preview để xác nhận', async () => {
    const { fetchExact } = await import('../lib/care/import/fetchExact')
    const s: Spy = { calls: [] }
    const m = await multipart({ file: fileField })
    const res = await handleCarePreview(req(m.body, m.contentType), deps(s, {
      repo: fakeRepo(s, { loadLookups: async () => { await fetchExact(adapter(10, { count: () => null })); return lookups() } }),
    }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toMatchObject({ ok: false, code: 'LOOKUP_FAILED' })
    expect(body.preview).toBeUndefined()
  })
  test('repo service role chỉ dùng fetchExact (không còn bản cho qua count=null)', () => {
    const repo = fs.readFileSync(path.join(ROOT, 'lib/care/server/importRepo.ts'), 'utf8')
    expect(repo).toContain("from '@/lib/care/import/fetchExact'")
    expect(repo).not.toMatch(/async function fetchExact/)
    expect((repo.match(/count: 'exact'/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })
})

// ── B8.3 (Q-110): cột lỗi CHỈ khi chắc chắn + đếm lỗi đủ khi danh sách bị cắt ─────────────────────────────
test.describe('care B8.3 — Q-110 cột lỗi chắc chắn, tổng lỗi không sai khi cắt @desktop', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const vrow = (rowNo: number, over: Partial<CareImportRow> = {}): CareImportRow => ({
    rowNo, customer_external_id: `K${rowNo}`, customer_name: 'KH', customer_phone: '0390000001', target_store_code: 'QAOS01',
    assignee_email: EA, reason_type: 'chronic', reason_text: 'QA', product_id: `P${rowNo}`, product_name: 'SP', product_url: '', ...over,
  })

  test('hợp đồng: chữ cột A..J theo đúng thứ tự header; mọi mã có nhãn ngắn + hướng sửa; mọi cột có yêu cầu', () => {
    expect(CONTRACT_HEADERS.map((h) => careColumnLetter(h)).join('')).toBe('ABCDEFGHIJ')
    expect(careColumnLetter('product_id')).toBe('H')
    expect(careOneField(['customer_name'])).toEqual({ field: 'customer_name' })
    expect(careOneField(['customer_name', 'reason_text'])).toEqual({})
    expect(careOneField([])).toEqual({})
    for (const c of CARE_ROW_ERROR_CODES) {
      expect(CARE_ERROR_SHORT[c], c).toBeTruthy()
      expect(CARE_ERROR_FIXES[c], c).toBeTruthy()
    }
    expect(Object.keys(CARE_IMPORT_COLUMN_RULES)).toEqual([...CONTRACT_HEADERS])
    // Hướng sửa/nhãn không gợi ý import một phần (Q-110: lỗi chặn CẢ file).
    expect(JSON.stringify([CARE_ERROR_FIXES, CARE_ERROR_SHORT])).not.toMatch(/bỏ qua dòng|dòng hợp lệ|tiếp tục với/i)
  })

  test('parser: công thức / ô sai kiểu đúng MỘT cột ⇒ field; hai cột ⇒ không field; dòng trống ⇒ không field', () => {
    const blank: Cell[] = CONTRACT_HEADERS.map(() => null)
    const p = parseCareImportXlsx(xlsx([
      H,
      r('A', 'QAOS01', EA, 'P1', { reason_text: { f: '"QA "&"x"' } }),
      r('B', 'QAOS01', EA, 'P2', { reason_text: { f: '"x"' }, product_name: { f: '"y"' } }),
      r('C', 'QAOS01', EA, 'P3', { customer_external_id: 123456 }),
      r('D', 'QAOS01', EA, 'P4', { customer_name: true, product_id: 12.5 }),
      blank,
      r('E', 'QAOS01', EA, 'P5', { product_id: { f: '1000+1' } }),
    ]))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.errors).toEqual([
      { row: 2, code: 'FORMULA_NOT_ALLOWED', field: 'reason_text' },
      { row: 3, code: 'FORMULA_NOT_ALLOWED' },
      { row: 4, code: 'CELL_NOT_TEXT', field: 'customer_external_id' },
      { row: 5, code: 'CELL_NOT_TEXT' },
      { row: 6, code: 'BLANK_ROW' },
      { row: 7, code: 'FORMULA_NOT_ALLOWED', field: 'product_id' },
    ])
  })

  test('validator: thiếu/quá dài đúng một cột ⇒ field, nhiều cột ⇒ không; SĐT/product_id/link ảnh cột cố định; trùng/không nhất quán không field', () => {
    const v = validateCareRows([
      vrow(2, { customer_name: '' }),
      vrow(3, { customer_name: '', reason_text: '' }),
      vrow(4, { reason_type: 'x'.repeat(51) }),
      vrow(5, { reason_type: 'x'.repeat(51), product_name: 'y'.repeat(301) }),
      vrow(6, { customer_phone: '0201234567' }),
      vrow(7, { product_id: '00' }),
      vrow(8, { product_url: 'https://storage.googleapis.com/x.png' }),
      vrow(9, { customer_external_id: 'K-INC' }), vrow(10, { customer_external_id: 'K-INC', customer_name: 'Tên khác' }),
      vrow(11, { customer_external_id: 'K-DUP', product_id: 'PX' }), vrow(12, { customer_external_id: 'K-DUP', product_id: 'PX' }),
    ])
    expect(v.errors).toEqual([
      { row: 2, code: 'FIELD_REQUIRED', field: 'customer_name' },
      { row: 3, code: 'FIELD_REQUIRED' },
      { row: 4, code: 'TOO_LONG', field: 'reason_type' },
      { row: 5, code: 'TOO_LONG' },
      { row: 6, code: 'PHONE_INVALID', field: 'customer_phone' },
      { row: 7, code: 'PRODUCT_ID_INVALID', field: 'product_id' },
      { row: 8, code: 'IMAGE_URL_HOST', field: 'product_url' },
      { row: 9, code: 'INCONSISTENT_CUSTOMER' },
      { row: 10, code: 'INCONSISTENT_CUSTOMER' },
      { row: 11, code: 'DUPLICATE_PRODUCT' },
      { row: 12, code: 'DUPLICATE_PRODUCT' },
    ])
  })

  test('preview: STORE_INVALID ⇒ target_store_code chỉ khi các dòng của khách nhất quán; lỗi email × cửa hàng / từ chối / QA không field', () => {
    const lk = lookups()
    lk.staff.push({ id: 'dup', storeId: sid(1), email: EB, fullName: 'QA trùng email' })
    lk.customers.set('K-REF', { id: 'c-ref', isTest: false })
    lk.refusals.add(`c-ref|${sid(1)}`)
    lk.customers.set('K-TEST', { id: 'c-test', isTest: true })
    const p = previewOf(xlsx([
      H,
      r('K-STORE', 'QAOS99', EA, 'P1'),
      r('K-MIX', 'QAOS98', EA, 'P1'), r('K-MIX', 'QAOS01', EA, 'P2'),
      r('K-NOSTAFF', 'QAOS01', 'khong.co@example.invalid', 'P1'),
      r('K-AMB', 'QAOS01', EB, 'P1'),
      r('K-REF', 'QAOS01', EA, 'P1'),
      r('K-TEST', 'QAOS01', EA, 'P1'),
    ]), lk)
    expect(p.errors).toEqual([
      { row: 2, code: 'STORE_INVALID', field: 'target_store_code' },
      { row: 3, code: 'INCONSISTENT_CUSTOMER' }, { row: 3, code: 'STORE_INVALID' },
      { row: 4, code: 'INCONSISTENT_CUSTOMER' }, { row: 4, code: 'STORE_INVALID' },
      { row: 5, code: 'ASSIGNEE_INVALID' },
      { row: 6, code: 'ASSIGNEE_AMBIGUOUS' },
      { row: 7, code: 'REFUSED_AT_STORE' },
      { row: 8, code: 'TEST_FLAG_MISMATCH' },
    ])
  })

  test('route preview: > 500 lỗi ⇒ errorCount + errorCounts tính trên TOÀN BỘ, chi tiết cắt 500; lỗi chỉ {row, code, field?}; commit HAS_ERRORS cùng dạng', async () => {
    const rows = [H, ...Array.from({ length: 600 }, (_, i) => r(`S${i}`, 'QAOS99', EA, 'P1')),
      ...Array.from({ length: 100 }, (_, i) => r(`F${i}`, 'QAOS01', EA, 'P1', { customer_phone: '0201234567' }))]
    const bytes = xlsx(rows)
    const m = await multipart({ file: { name: 'care.xlsx', bytes } })
    const s: Spy = { calls: [] }
    const body = await (await handleCarePreview(req(m.body, m.contentType), deps(s))).json()
    expect(body.preview.errorCount).toBe(700)
    expect(body.preview.errors).toHaveLength(CARE_PREVIEW_ERROR_LIMIT)
    expect(body.preview.errorCounts).toEqual({ STORE_INVALID: 600, PHONE_INVALID: 100 })
    // Danh sách cắt không chứa lỗi SĐT nào ⇒ đếm từ danh sách sẽ sai; server đếm đúng.
    expect(body.preview.errors.some((e: { code: string }) => e.code === 'PHONE_INVALID')).toBe(false)
    for (const e of body.preview.errors) expect(Object.keys(e).every((k) => ['row', 'code', 'field'].includes(k))).toBe(true)
    expect(JSON.stringify(body.preview.errors)).not.toMatch(/0201234567|QAOS99|"S\d+|example\.invalid/)
    const sha700 = crypto.createHash('sha256').update(bytes).digest('hex')
    const c = await multipart({ file: { name: 'care.xlsx', bytes }, sha256: sha700, period: '2026-10-01' })
    const commit = await (await handleCareCommit(req(c.body, c.contentType), deps(s))).json()
    expect(commit).toMatchObject({ code: 'HAS_ERRORS', errorCount: 700, errorCounts: { STORE_INVALID: 600, PHONE_INVALID: 100 } })
    expect(commit.errors).toHaveLength(CARE_PREVIEW_ERROR_LIMIT)
    expect(writes(s)).toEqual([])
    expect(careErrorPayload([{ row: 2, code: 'BLANK_ROW' }])).toEqual({ errorCount: 1, errorCounts: { BLANK_ROW: 1 }, errors: [{ row: 2, code: 'BLANK_ROW' }] })
  })

  test('UI thuần: đếm theo mã — ưu tiên server; không có mà danh sách bị cắt ⇒ null (không hiện số sai)', () => {
    const errs = [{ row: 2, code: 'STORE_INVALID' as const }, { row: 3, code: 'STORE_INVALID' as const }, { row: 4, code: 'BLANK_ROW' as const }]
    expect(careErrorCodeCounts(errs, 3)).toEqual({ STORE_INVALID: 2, BLANK_ROW: 1 })
    expect(careErrorCodeCounts(errs, 900)).toBeNull()
    expect(careErrorCodeCounts(errs, 900, { STORE_INVALID: 899, BLANK_ROW: 1 })).toEqual({ STORE_INVALID: 899, BLANK_ROW: 1 })
  })

  test('bảng phân công (bước 3, chỉ đọc) tính từ preview thật: cửa hàng × email, đếm theo kết quả, owner giữ người cũ, bỏ khách lỗi', () => {
    const c = (o: Partial<CarePreviewCustomer>): CarePreviewCustomer => ({
      externalId: 'X', name: 'KH', phoneRaw: '0390000001', storeCode: 'QAOS01', storeName: 'QA 1', email: EA, assigneeName: 'An',
      productCount: 1, rows: [2], action: 'create', ownerIgnored: false, ...o,
    })
    const t = careAssignmentTable([
      c({ externalId: 'A' }), c({ externalId: 'B', action: 'update' }), c({ externalId: 'C', action: 'unchanged', ownerIgnored: true }),
      c({ externalId: 'D', email: EB, assigneeName: 'Bình', action: 'skip_has_interaction' }),
      c({ externalId: 'E', storeCode: 'QAOS02', storeName: 'QA 2', email: EB, assigneeName: 'Bình' }),
      c({ externalId: 'F', action: 'error' }), c({ externalId: 'G', storeCode: 'QAOS99', storeName: null }),
    ])
    expect(t.stores.map((s) => [s.storeCode, s.customers, s.rows.map((x) => `${x.name}:${x.customers}/${x.created}/${x.updated}/${x.unchanged}/${x.skipped}/${x.ownerIgnored}`)])).toEqual([
      ['QAOS01', 4, ['An:3/1/1/1/0/1', 'Bình:1/0/0/0/1/0']],
      ['QAOS02', 1, ['Bình:1/1/0/0/0/0']],
    ])
    expect(t.totals).toEqual({ customers: 5, created: 2, updated: 1, unchanged: 1, skipped: 1, ownerIgnored: 1 })
    expect(t.assignees).toBe(3)
    expect(t.maxCustomers).toBe(3)
    expect(careAssignmentTable([]).maxCustomers).toBe(0)
  })

  test('nguồn: wizard không import một phần / không khớp gần đúng / không ghi chú lần import; nút xác nhận khoá khi có lỗi; quyền link danh sách từ cùng RPC', () => {
    const wiz = read('components/care/CareImportWizard.tsx') + read('components/care/CareImportPanels.tsx')
    expect(wiz).not.toMatch(/Tiếp tục với|Gần đúng|gần đúng tên|Ghi chú lần import|<select/)
    expect(wiz).toContain('disabled={busy || hasErrors || qaBlocked} onClick={runCommit}')
    expect(wiz).toContain('if (!file || !preview || committing.current || preview.errorCount > 0 || (qa && !qa.commitAllowed)) return')
    expect(wiz).toContain('<Button className={BTN} disabled={hasErrors} onClick={() => setStep(2)}>')
    // PM B8.3 R1-01: phản hồi preview cũ (đã đổi/bỏ file) không được áp vào màn hiện tại.
    const run = /async function runPreview\(\) \{([\s\S]*?)\n {2}\}/.exec(wiz)![1]
    expect(run.match(/if \(my !== gen\.current\) return/g)).toHaveLength(2)
    expect(run).toContain('if (my === gen.current) { inflight.current = null; setBusy(false) }')
    expect(run.indexOf('if (my !== gen.current) return')).toBeLessThan(run.indexOf('setPreview(body.preview)'))
    expect(wiz).toMatch(/const reset = \(\) => \{\s*invalidate\(\)/)
    expect(wiz).toMatch(/const choose = \(f: File \| null\) => \{\s*invalidate\(\)/)
    // Bảng lỗi: chỉ dòng/cột/mã/nhãn/hướng sửa — không cột giá trị ô.
    expect(wiz).not.toMatch(/Giá trị/)
    const acc = read('lib/care/server/importAccess.ts')
    expect(acc).toContain("? { kind: 'ok', actorId: user.id, canView: carePermissions(access).canView }")
    expect(acc.match(/supabase\.rpc\(/g)).toHaveLength(1)
    const page = read('app/(dashboard)/care/assign/page.tsx')
    expect(page).toContain("tasksHref={access.canView ? '/care/tasks' : null}")
    expect(page).toMatch(/export default async function[\s\S]*?\{\s*if \(!isCareEnabled\(\)\) notFound\(\)/)
  })
})
