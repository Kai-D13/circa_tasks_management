import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  CARE_ERROR_FIXES, CARE_ERROR_LABELS, CARE_ERROR_SHORT, CARE_FILE_ERROR_CODES, CARE_IMPORT_COLUMN_RULES, CARE_IMPORT_MAX_ROWS, CARE_IMPORT_HEADERS as CONTRACT_HEADERS,
  CARE_ROW_ERROR_CODES, careColumnLetter, careOneField, type CareImportRow,
} from '../lib/care/import/contract'
import { CARE_CSV_BLANK_SLACK, CARE_CSV_MAX_FIELDS, CARE_SCIENTIFIC_ID_RE, parseCareImportCsv } from '../lib/care/import/parse'
import { CARE_CSV_BOM, decodeCareCsv, parseCsvRecords, toCareCsv } from '../lib/care/import/csvCore'
import { validateCareRows } from '../lib/care/import/validate'
import { buildCarePreview, type CareExistingTask, type CareImportLookups, type CarePreviewCustomer } from '../lib/care/import/preview'
import { careAssignmentTable, careErrorCodeCounts } from '../lib/care/import/review'
import {
  CARE_PREVIEW_ERROR_LIMIT, careErrorPayload, careServerTiming, handleCareCommit, handleCarePreview, handleCareTemplate,
  type CareFinalizeResult, type CareImportAccess, type CareImportDeps, type CareImportRepo,
} from '../lib/care/import/handler'
import { CARE_IMPORT_TEMPLATE_FILENAME, buildCareImportTemplate } from '../lib/care/import/template'
import {
  CARE_IMPORT_HEADERS as FIXTURE_HEADERS, buildCareImportCsv, buildCareImportRows, careRowsToCsv, defaultFixtureStores, fixtureCsv,
} from './careImportFixture'

// CRM-CSKH B2 — lõi import THUẦN (không DB, không server): parser CSV (Q-124), validate/gom khách, preview diff,
// Route Handler (deps giả: quyền, repo, đồng hồ). Parity với finalize SQL 114 nằm ở care-import-parity.spec.ts (PGlite).

const ROOT = path.resolve(__dirname, '..')

// ── Helpers ──────────────────────────────────────────────────────────────────
type Cell = string | null
const CRLF = String.fromCharCode(13, 10)
/** Bảng ⇒ bytes CSV. Mặc định như Excel "CSV UTF-8": BOM + CRLF + dấu phẩy. */
function csv(aoa: Cell[][], opts: { bom?: boolean; eol?: string; sep?: string } = {}): Uint8Array<ArrayBuffer> {
  const sep = opts.sep ?? ','
  const field = (v: Cell) => {
    const s = v ?? ''
    return sep === ',' && /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const text = (opts.bom === false ? '' : CARE_CSV_BOM) + aoa.map((row) => row.map(field).join(sep)).join(opts.eol ?? CRLF) + (opts.eol ?? CRLF)
  const bytes = new TextEncoder().encode(text)
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  out.set(bytes)
  return out
}
/** Bytes thô (để dựng file hỏng: ANSI, UTF-16, nháy lạc…). */
const raw = (text: string) => new TextEncoder().encode(text)
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
  const p = parseCareImportCsv(bytes)
  if (!p.ok) throw new Error(p.fileError)
  return buildCarePreview({ rowCount: p.rows.length, validated: validateCareRows(p.rows), parseErrors: p.errors, lookups: lk, period: '2026-10-01', isTest })
}
const codes = (errs: { row: number; code: string }[]) => errs.map((e) => `${e.row}:${e.code}`)

test.describe('care Q-124 — contract & parser CSV @desktop', () => {
  test('hợp đồng: header của lib trùng fixture B0 (một nguồn); fixture ghi CSV giống hệt toCareCsv của app', () => {
    expect([...CONTRACT_HEADERS]).toEqual([...FIXTURE_HEADERS])
    const sample = [[...CONTRACT_HEADERS], ['a,b', 'nháy "kép"', ' đầu', 'cuối ', `dòng${CRLF}hai`, '=1+1', '', 'x', 'y', 'z']]
    expect(fixtureCsv(sample)).toBe(toCareCsv(sample))
    expect(CARE_FILE_ERROR_CODES).toEqual(['FILE_NOT_CSV', 'ENCODING_INVALID', 'DELIMITER_INVALID', 'CSV_MALFORMED', 'HEADER_INVALID', 'NO_ROWS', 'TOO_MANY_ROWS'])
    for (const c of CARE_FILE_ERROR_CODES) expect(CARE_ERROR_LABELS[c], c).toBeTruthy()
  })

  test('fixture B0 25 store / 100 khách: đọc đủ, không lỗi, số bản ghi gốc', () => {
    const p = parseCareImportCsv(buildCareImportCsv())
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.errors).toEqual([])
    expect(p.rows.length).toBe(buildCareImportRows().length)
    expect(p.rows[0].rowNo).toBe(2)
    expect(p.rows.at(-1)!.rowNo).toBe(p.rows.length + 1)
    expect(p.rows.every((x) => /^0\d{9}$/.test(x.customer_phone))).toBe(true)
  })

  test('lỗi cả file: nhị phân/.xlsx đổi đuôi, UTF-16, ANSI, dấu ; / tab, header sai/thiếu/dư, nháy hỏng, không dòng, vượt trần', () => {
    const one = [H, r('A', 'QAOS01', EA, 'P1')]
    const ok = csv(one)
    expect(parseCareImportCsv(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toEqual({ ok: false, fileError: 'FILE_NOT_CSV' }) // ZIP (.xlsx)
    expect(parseCareImportCsv(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2]))).toEqual({ ok: false, fileError: 'FILE_NOT_CSV' }) // .xls OLE
    expect(parseCareImportCsv(new Uint8Array([...raw('customer_external_id'), 0, 0x41]))).toEqual({ ok: false, fileError: 'FILE_NOT_CSV' }) // byte NUL
    expect(parseCareImportCsv(new Uint8Array([0xff, 0xfe, 0x63, 0x00]))).toEqual({ ok: false, fileError: 'ENCODING_INVALID' }) // UTF-16 LE
    // "CSV (Comma delimited)" ANSI Windows-1258: "Nguyễn" có byte 0xE3/0xF2… không hợp lệ UTF-8.
    const ansi = new Uint8Array([...raw(`${CONTRACT_HEADERS.join(',')}${CRLF}A,Nguy`), 0xf2, 0x6e, ...raw(`,0390000999,QAOS01,${EA},c,r,P1,SP,${CRLF}`)])
    expect(parseCareImportCsv(ansi)).toEqual({ ok: false, fileError: 'ENCODING_INVALID' })
    expect(parseCareImportCsv(csv(one, { sep: ';' }))).toEqual({ ok: false, fileError: 'DELIMITER_INVALID' })
    expect(parseCareImportCsv(csv(one, { sep: '\t' }))).toEqual({ ok: false, fileError: 'DELIMITER_INVALID' })
    const swapped = [...H]; [swapped[0], swapped[1]] = [swapped[1], swapped[0]]
    expect(parseCareImportCsv(csv([swapped, r('A', 'QAOS01', EA, 'P1')]))).toEqual({ ok: false, fileError: 'HEADER_INVALID' })
    expect(parseCareImportCsv(csv([H.slice(0, 9), r('A', 'QAOS01', EA, 'P1').slice(0, 9)]))).toEqual({ ok: false, fileError: 'HEADER_INVALID' })
    expect(parseCareImportCsv(csv([[...H, 'due_date'], [...r('A', 'QAOS01', EA, 'P1'), '2026-10-31']]))).toEqual({ ok: false, fileError: 'HEADER_INVALID' })
    expect(parseCareImportCsv(csv([[...H, ''], [...r('A', 'QAOS01', EA, 'P1'), '']])).ok).toBe(true) // cột trống thừa ở cuối: bỏ qua
    expect(parseCareImportCsv(raw(`${CONTRACT_HEADERS.join(',')}${CRLF}"A,0390000999${CRLF}`))).toEqual({ ok: false, fileError: 'CSV_MALFORMED' }) // nháy không đóng
    expect(parseCareImportCsv(raw(`${CONTRACT_HEADERS.join(',')}${CRLF}A"B,x,x,x,x,x,x,x,x,x${CRLF}`))).toEqual({ ok: false, fileError: 'CSV_MALFORMED' }) // nháy lạc
    expect(parseCareImportCsv(raw(`${CONTRACT_HEADERS.join(',')}${CRLF}"A"B,x,x,x,x,x,x,x,x,x${CRLF}`))).toEqual({ ok: false, fileError: 'CSV_MALFORMED' }) // chữ sau nháy đóng
    expect(parseCareImportCsv(csv([H]))).toEqual({ ok: false, fileError: 'NO_ROWS' })
    expect(parseCareImportCsv(new Uint8Array())).toEqual({ ok: false, fileError: 'NO_ROWS' })
    expect(parseCareImportCsv(raw(CARE_CSV_BOM + CRLF + CRLF))).toEqual({ ok: false, fileError: 'NO_ROWS' })
    const six = [H, ...Array.from({ length: 6 }, (_, i) => r(`A${i}`, 'QAOS01', EA, 'P1'))]
    expect(parseCareImportCsv(csv(six), 5)).toEqual({ ok: false, fileError: 'TOO_MANY_ROWS' })
    expect(parseCareImportCsv(csv(six), 6).ok).toBe(true)
    expect(parseCareImportCsv(ok).ok).toBe(true)
    // UTF-16 LE KHÔNG BOM (chữ Latin ⇒ nửa số byte là 0) ⇒ sai mã hoá, không phải "file nhị phân".
    const u16 = new Uint8Array([...raw('customer_external_id,customer_name')].flatMap((x) => [x, 0]))
    expect(parseCareImportCsv(u16)).toEqual({ ok: false, fileError: 'ENCODING_INVALID' })
  })

  test('security Q-124 P1: dừng đọc sớm — quá nhiều bản ghi (kể cả dòng trống) ⇒ TOO_MANY_ROWS; một dòng quá nhiều trường ⇒ CSV_MALFORMED', () => {
    const head = CONTRACT_HEADERS.join(',') + CRLF
    const line = r('A', 'QAOS01', EA, 'P1').join(',') + CRLF
    // trần 5 dòng: 5 dữ liệu + đúng CARE_CSV_BLANK_SLACK dòng trống cuối ⇒ còn đọc được; thêm 1 dòng trống ⇒ dừng.
    expect(parseCareImportCsv(raw(head + line.repeat(5) + CRLF.repeat(CARE_CSV_BLANK_SLACK)), 5).ok).toBe(true)
    expect(parseCareImportCsv(raw(head + line.repeat(5) + CRLF.repeat(CARE_CSV_BLANK_SLACK + 1)), 5)).toEqual({ ok: false, fileError: 'TOO_MANY_ROWS' })
    // file ~4 MB toàn dòng trống ⇒ dừng ngay (không dựng hàng triệu bản ghi).
    const t0 = performance.now()
    expect(parseCareImportCsv(raw(head + CRLF.repeat(2_000_000) + line))).toEqual({ ok: false, fileError: 'TOO_MANY_ROWS' })
    expect(performance.now() - t0).toBeLessThan(2000)
    // một dòng nhiều dấu phẩy ⇒ dừng ở CARE_CSV_MAX_FIELDS trường.
    expect(parseCareImportCsv(raw(head + ','.repeat(CARE_CSV_MAX_FIELDS) + CRLF))).toEqual({ ok: false, fileError: 'CSV_MALFORMED' })
    expect(parseCsvRecords('a,b,c', { maxFields: 2 })).toEqual({ ok: false, reason: 'TOO_MANY_FIELDS' })
    expect(parseCsvRecords('a' + CRLF + 'b' + CRLF + 'c', { maxRecords: 2 })).toEqual({ ok: false, reason: 'TOO_MANY_RECORDS' })
    expect(parseCsvRecords('"a', {})).toEqual({ ok: false, reason: 'MALFORMED' })
  })

  test('trần dòng phát hành N = 10.000 (PM 15/10): N−1 và N nhận, N+1 ⇒ TOO_MANY_ROWS; thông báo đọc cùng hằng số; parser đọc được 20.000 khi nâng trần (Q-121)', () => {
    const N = CARE_IMPORT_MAX_ROWS
    expect(N).toBe(10_000)
    expect(CARE_ERROR_LABELS.TOO_MANY_ROWS).toBe(`File vượt ${N.toLocaleString('vi-VN')} dòng dữ liệu`)
    const big = (n: number) => csv([H, ...Array.from({ length: n }, (_, i) => r(`C${i}`, 'QAOS01', EA, 'P1'))])
    for (const n of [N - 1, N]) {
      const p = parseCareImportCsv(big(n))
      expect(p.ok, String(n)).toBe(true)
      if (p.ok) expect([p.rows.length, p.rows[0].rowNo, p.rows[n - 1].rowNo]).toEqual([n, 2, n + 1])
    }
    expect(parseCareImportCsv(big(N + 1))).toEqual({ ok: false, fileError: 'TOO_MANY_ROWS' })
    expect(parseCareImportCsv(big(20_000), 20_000).ok).toBe(true)
    expect(parseCareImportCsv(big(20_001), 20_000)).toEqual({ ok: false, fileError: 'TOO_MANY_ROWS' })
  })

  test('RFC 4180: BOM tuỳ chọn, CRLF/LF; dấu phẩy/nháy kép/xuống dòng trong ô; số bản ghi theo BẢN GHI; giữ số 0 đầu; trim; "=" chỉ là chữ', () => {
    const rows = [
      H,
      r('007', 'QAOS01', EA, '0042', { reason_text: 'Mua 2, tặng 1', product_name: 'SP "đặc biệt"' }),
      r('008', 'QAOS01', EA, 'P2', { reason_text: `Dòng 1${CRLF}Dòng 2`, customer_phone: '901234567' }),
      r('009', 'QAOS01', EA, 'P3', { customer_name: '  KH có khoảng trắng  ', reason_text: '=HYPERLINK("x")' }),
    ]
    const base = parseCareImportCsv(csv(rows))
    expect(base.ok).toBe(true)
    if (!base.ok) return
    expect(base.errors).toEqual([])
    expect(base.rows.map((x) => x.rowNo)).toEqual([2, 3, 4]) // ô 3 có xuống dòng vẫn là bản ghi 3; bản ghi sau là 4
    const [a, b, c] = base.rows
    expect([a.customer_external_id, a.product_id, a.reason_text, a.product_name]).toEqual(['007', '0042', 'Mua 2, tặng 1', 'SP "đặc biệt"'])
    expect(b.reason_text).toBe(`Dòng 1${CRLF}Dòng 2`)
    expect(validateCareRows([b]).customers[0].phoneNorm).toBe('0901234567') // thiếu số 0 đầu vẫn chuẩn hoá
    expect([c.customer_name, c.reason_text]).toEqual(['KH có khoảng trắng', '=HYPERLINK("x")'])
    // Không BOM, LF thay CRLF ⇒ cùng kết quả.
    const lf = parseCareImportCsv(csv(rows, { bom: false, eol: String.fromCharCode(10) }))
    expect(lf.ok && JSON.stringify(lf.rows)).toBe(JSON.stringify(base.rows))
  })

  test('COLUMN_COUNT: bản ghi thiếu/thừa trường có dữ liệu ⇒ lỗi (không field); trường TRỐNG thừa ở cuối bỏ qua', () => {
    const p = parseCareImportCsv(csv([
      H,
      r('A', 'QAOS01', EA, 'P1').slice(0, 9),
      [...r('B', 'QAOS01', EA, 'P2'), 'thừa'],
      [...r('C', 'QAOS01', EA, 'P3'), '', ''],
    ]))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.errors.filter((e) => e.code === 'COLUMN_COUNT')).toEqual([{ row: 2, code: 'COLUMN_COUNT' }, { row: 3, code: 'COLUMN_COUNT' }])
    expect(p.rows.find((x) => x.rowNo === 4)!.product_id).toBe('P3')
  })

  test('ID_NOT_TEXT: mã khách/mã sản phẩm dạng số mũ của Excel ⇒ lỗi; đúng một cột ⇒ field', () => {
    for (const v of ['1.23457E+14', '1,23457E+14', '1E+15', '9.99999e+11']) expect(CARE_SCIENTIFIC_ID_RE.test(v), v).toBe(true)
    for (const v of ['123456789012345', 'QA-1E+5', '1.5', 'E+14', '1,5']) expect(CARE_SCIENTIFIC_ID_RE.test(v), v).toBe(false)
    const p = parseCareImportCsv(csv([
      H,
      r('1.23457E+14', 'QAOS01', EA, 'P1'),
      r('K2', 'QAOS01', EA, '1.23457E+14'),
      r('1E+15', 'QAOS01', EA, '2E+15'),
      r('K4', 'QAOS01', EA, '123456789012345'),
      r('1,23457E+14', 'QAOS01', EA, 'P6'), // Excel vùng VN: dấu phẩy thập phân, ô được bọc nháy trong CSV
    ]))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.errors).toEqual([
      { row: 2, code: 'ID_NOT_TEXT', field: 'customer_external_id' },
      { row: 3, code: 'ID_NOT_TEXT', field: 'product_id' },
      { row: 4, code: 'ID_NOT_TEXT' },
      { row: 6, code: 'ID_NOT_TEXT', field: 'customer_external_id' },
    ])
  })

  test('Q-104: product_id toàn số 0 ("0"/"00") ⇒ PRODUCT_ID_INVALID; "0042"/"10" hợp lệ', () => {
    const p = previewOf(csv([H, r('Z1', 'QAOS01', EA, '0'), r('Z2', 'QAOS01', EA, '00'), r('Z4', 'QAOS01', EA, '0042'), r('Z5', 'QAOS01', EA, '10')]))
    expect(codes(p.errors)).toEqual(['2:PRODUCT_ID_INVALID', '3:PRODUCT_ID_INVALID'])
    const one: CareImportRow = {
      rowNo: 9, customer_external_id: 'Z9', customer_name: 'KH Z9', customer_phone: '0390000999', target_store_code: 'QAOS01',
      assignee_email: EA, reason_type: 'chronic', reason_text: 'QA', product_id: '000', product_name: 'SP', product_url: '',
    }
    expect(codes(validateCareRows([one]).errors)).toEqual(['9:PRODUCT_ID_INVALID'])
    expect(validateCareRows([{ ...one, product_id: '100' }]).errors).toEqual([])
  })

  test('bản ghi trống xen giữa ⇒ BLANK_ROW (cả dòng chỉ dấu phẩy và dòng rỗng); trống cuối bỏ qua; trần không đếm dòng trống', () => {
    const blank: Cell[] = CONTRACT_HEADERS.map(() => null)
    const bytes = csv([H, r('A', 'QAOS01', EA, 'P1'), blank, r('B', 'QAOS01', EA, 'P1'), blank, blank])
    const p = parseCareImportCsv(bytes)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(codes(p.errors)).toEqual(['3:BLANK_ROW'])
    expect(p.rows.map((x) => x.rowNo)).toEqual([2, 4])
    const emptyLine = parseCareImportCsv(raw(`${CONTRACT_HEADERS.join(',')}${CRLF}${r('A', 'QAOS01', EA, 'P1').join(',')}${CRLF}${CRLF}${r('B', 'QAOS01', EA, 'P2').join(',')}${CRLF}`))
    expect(emptyLine.ok && codes(emptyLine.errors)).toEqual(['3:BLANK_ROW'])
    expect(parseCareImportCsv(bytes, 2).ok).toBe(true) // 2 bản ghi có dữ liệu + 1 trống ⇒ không vượt trần 2
  })

  test('csvCore: giải mã UTF-8/BOM; tách bản ghi; ghi rồi đọc lại khứ hồi ổn định với ký tự đặc biệt', () => {
    expect(decodeCareCsv(raw(`${CARE_CSV_BOM}a`))).toEqual({ ok: true, text: 'a', bom: true })
    expect(decodeCareCsv(raw('a'))).toEqual({ ok: true, text: 'a', bom: false })
    expect(parseCsvRecords('a,b' + CRLF + 'c,"d' + CRLF + 'e"' + CRLF)).toEqual({ ok: true, records: [['a', 'b'], ['c', `d${CRLF}e`]] })
    expect(parseCsvRecords('a,,')).toEqual({ ok: true, records: [['a', '', '']] })
    expect(parseCsvRecords('"a""b"')).toEqual({ ok: true, records: [['a"b']] })
    const tricky = [['x,y', 'nháy "a"', ' cách', 'cuối ', `n${CRLF}m`, '', 'Tiếng Việt có dấu ễ ỗ ữ', '"', ',', '=SUM(A1)']]
    const back = parseCsvRecords(toCareCsv(tricky, false))
    expect(back).toEqual({ ok: true, records: tricky })
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
    const p = previewOf(buildCareImportCsv())
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
    const p = previewOf(csv([
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
    const p = previewOf(csv([
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
    const p = previewOf(csv([H, r('K1', 'QAOS01', EA, 'P1')]))
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
    else fd.append(k, new File([new Uint8Array(v.bytes)], v.name, { type: v.type ?? 'text/csv' }))
  }
  for (let i = 0; i < extraFiles; i++) fd.append(`extra${i}`, new File([new Uint8Array([1])], 'x.csv'))
  const tmp = new Request('http://local/x', { method: 'POST', body: fd })
  return { body: new Uint8Array(await tmp.arrayBuffer()), contentType: tmp.headers.get('content-type')! }
}
function req(body: Uint8Array, contentType: string, opts: { length?: string | null } = {}) {
  const headers = new Headers({ 'content-type': contentType })
  const len = opts.length === undefined ? String(body.byteLength) : opts.length
  if (len !== null) headers.set('content-length', len)
  return new Request('http://local/api/care/import/preview', { method: 'POST', headers, body, duplex: 'half' } as RequestInit)
}
const fixtureBytes = buildCareImportCsv()
const fileField = { name: 'care_T10.csv', bytes: fixtureBytes }
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

  test('multipart/kiểu file (Q-124): không multipart 400 · hai file 400 · .xlsx/MIME lạ 415 · .xlsx đổi tên .csv 422 FILE_NOT_CSV · MIME Windows nhận', async () => {
    const s: Spy = { calls: [] }
    const notMultipart = new TextEncoder().encode('not multipart')
    expect((await handleCarePreview(req(notMultipart, 'application/json'), deps(s))).status).toBe(400)
    const two = await multipart({ file: fileField }, 1)
    expect((await (await handleCarePreview(req(two.body, two.contentType), deps(s))).json()).code).toBe('FILE_REQUIRED')
    const xlsxName = await multipart({ file: { name: 'care.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: fixtureBytes } })
    expect((await handleCarePreview(req(xlsxName.body, xlsxName.contentType), deps(s))).status).toBe(415)
    const mime = await multipart({ file: { name: 'care.csv', type: 'text/html', bytes: fixtureBytes } })
    expect((await handleCarePreview(req(mime.body, mime.contentType), deps(s))).status).toBe(415)
    expect(s.calls.filter((c) => c.fn !== 'getAccess')).toEqual([])
    const zip = await multipart({ file: { name: 'care.csv', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]) } })
    const res = await handleCarePreview(req(zip.body, zip.contentType), deps(s))
    expect([res.status, (await res.json()).code]).toEqual([422, 'FILE_NOT_CSV'])
    expect(s.calls.filter((c) => c.fn === 'loadLookups')).toEqual([]) // lỗi file ⇒ không đọc DB
    // commit dùng cùng readForm/parser ⇒ cùng kết luận, không đọc DB, không ghi.
    const cs = { calls: [] } as Spy
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])
    const cx = await multipart({ file: { name: 'care.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: zipBytes }, sha256: crypto.createHash('sha256').update(zipBytes).digest('hex'), period: '2026-10-01' })
    expect((await handleCareCommit(req(cx.body, cx.contentType), deps(cs))).status).toBe(415)
    const cz = await multipart({ file: { name: 'care.csv', bytes: zipBytes }, sha256: crypto.createHash('sha256').update(zipBytes).digest('hex'), period: '2026-10-01' })
    const rz = await handleCareCommit(req(cz.body, cz.contentType), deps(cs))
    expect([rz.status, (await rz.json()).code]).toEqual([422, 'FILE_NOT_CSV'])
    expect(cs.calls.filter((c) => c.fn !== 'getAccess')).toEqual([])
    for (const type of ['application/vnd.ms-excel', 'text/plain', 'application/octet-stream', 'TEXT/CSV']) {
      const m = await multipart({ file: { name: 'Care_T10.CSV', type, bytes: fixtureBytes } })
      expect((await handleCarePreview(req(m.body, m.contentType), deps({ calls: [] }))).status, type).toBe(200)
    }
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
    const bytes = csv([H, r('K1', 'QAOS99', EA, 'P1')])
    const m = await multipart({ file: { name: 'x.csv', bytes }, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), period: '2026-10-01' })
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
    expect(create.fileName).toBe(`care-import-2026-10-${sha.slice(0, 12)}.csv`)
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
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${CARE_IMPORT_TEMPLATE_FILENAME}"`)
    expect(CARE_IMPORT_TEMPLATE_FILENAME).toBe('care_import_mau.csv')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]) // BOM ⇒ Excel mở đúng tiếng Việt
    const p = parseCareImportCsv(bytes)
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

test.describe('care B2 — sửa sau review (staging kẹt, kỳ đổi lúc finalize) @desktop', () => {
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

test.describe('care Q-121/Q-124 — trần dòng N qua route preview/commit (deps giả) @desktop', () => {
  test.setTimeout(120_000)
  const N = CARE_IMPORT_MAX_ROWS
  /** Kích thước các khối staging 2.000 dòng của n dòng. */
  const chunks = (n: number) => Array.from({ length: Math.ceil(n / 2000) }, (_, i) => Math.min(2000, n - i * 2000))
  // Fixture 25 store: 401 khách/store × 1–3 sản phẩm ⇒ > 20.001 dòng; cắt đúng số dòng cần (khách cuối có thể bớt sản phẩm — vẫn hợp lệ).
  let pool: Record<string, string>[] | null = null
  const rowsN = (n: number) => (pool ??= buildCareImportRows({ customersPerStore: 401 }) as unknown as Record<string, string>[]).slice(0, n)
  // CSV không nén (Q-124): 10.000–20.000 dòng fixture ~1,5–3 MB — dưới trần 8 MiB.
  const fileOf = (rows: Record<string, string>[]) => careRowsToCsv(rows as unknown as CareImportRow[])
  const commitForm = (bytes: Uint8Array) =>
    multipart({ file: { name: 'n1.csv', bytes }, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), period: '2026-10-01' })
  const nonAccess = (s: Spy) => s.calls.filter((c) => c.fn !== 'getAccess')

  test('N+1 dòng ⇒ 422 TOO_MANY_ROWS ở preview và commit — không đọc DB, không tạo batch/task', async () => {
    const s: Spy = { calls: [] }
    const bytes = fileOf(rowsN(N + 1))
    const pv = await multipart({ file: { name: 'n1.csv', bytes } })
    const r1 = await handleCarePreview(req(pv.body, pv.contentType), deps(s))
    expect([r1.status, (await r1.json()).code]).toEqual([422, 'TOO_MANY_ROWS'])
    const cm = await commitForm(bytes)
    const r2 = await handleCareCommit(req(cm.body, cm.contentType), deps(s))
    expect([r2.status, (await r2.json()).code]).toEqual([422, 'TOO_MANY_ROWS'])
    expect(nonAccess(s)).toEqual([])
  })

  test('N dòng hợp lệ: preview 0 lỗi; commit đúng 1 batch rowCount N, staging khối 2.000 liên tục, finalize một lần', async () => {
    const s: Spy = { calls: [] }
    const rows = rowsN(N)
    const bytes = fileOf(rows)
    const pv = await multipart({ file: { name: 'n1.csv', bytes } })
    const r1 = await handleCarePreview(req(pv.body, pv.contentType), deps(s, { stageChunk: undefined }))
    expect(r1.status).toBe(200)
    expect(r1.headers.get('server-timing')).toBeNull() // production không gửi thời gian từng pha
    const p = (await r1.json()).preview
    expect([p.rowCount, p.customerCount, p.errorCount]).toEqual([N, new Set(rows.map((x) => x.customer_external_id)).size, 0])
    expect(writes(s)).toEqual([])
    const cm = await commitForm(bytes)
    const r2 = await handleCareCommit(req(cm.body, cm.contentType), deps(s, { stageChunk: undefined }))
    expect(r2.status, await r2.clone().text()).toBe(200)
    expect(s.calls.filter((c) => c.fn === 'createBatch').map((c) => (c.args[0] as { rowCount: number }).rowCount)).toEqual([N])
    const stages = s.calls.filter((c) => c.fn === 'stageRows').map((c) => c.args[1] as { row_no: number }[])
    expect(stages.map((x) => x.length)).toEqual(chunks(N))
    expect(stages.flat().map((x) => x.row_no)).toEqual(Array.from({ length: N }, (_, i) => i + 2))
    expect(s.calls.filter((c) => c.fn === 'finalize').length).toBe(1)
    expect(s.calls.some((c) => c.fn === 'discardBatch')).toBe(false)
  })

  test('N−1 dòng qua route: preview 200, commit staging đủ N−1 dòng (khối cuối 1.999)', async () => {
    const s: Spy = { calls: [] }
    const bytes = fileOf(rowsN(N - 1))
    const pv = await multipart({ file: { name: 'n1.csv', bytes } })
    const r1 = await handleCarePreview(req(pv.body, pv.contentType), deps(s, { stageChunk: undefined }))
    expect([r1.status, (await r1.json()).preview.rowCount]).toEqual([200, N - 1])
    const cm = await commitForm(bytes)
    expect((await handleCareCommit(req(cm.body, cm.contentType), deps(s, { stageChunk: undefined }))).status).toBe(200)
    const stages = s.calls.filter((c) => c.fn === 'stageRows').map((c) => (c.args[1] as unknown[]).length)
    expect(stages).toEqual(chunks(N - 1))
  })

  test('N dòng, lỗi chỉ ở dòng cuối ⇒ preview báo đúng bản ghi N+1; commit 422 HAS_ERRORS chặn cả file, không ghi', async () => {
    const s: Spy = { calls: [] }
    const rows = rowsN(N).map((x, i) => (i === N - 1 ? { ...x, product_url: 'https://evil.example/a.png' } : x))
    const bytes = fileOf(rows)
    const pv = await multipart({ file: { name: 'n1.csv', bytes } })
    const p = (await (await handleCarePreview(req(pv.body, pv.contentType), deps(s))).json()).preview
    expect([p.errorCount, p.errors]).toEqual([1, [{ row: N + 1, code: 'IMAGE_URL_HOST', field: 'product_url' }]])
    const cm = await commitForm(bytes)
    const r2 = await handleCareCommit(req(cm.body, cm.contentType), deps(s))
    expect(r2.status).toBe(422)
    expect(await r2.json()).toMatchObject({ code: 'HAS_ERRORS', errorCount: 1 })
    expect(writes(s)).toEqual([])
  })

  test('đủ N dòng nhưng file > 8 MiB ⇒ 413 PAYLOAD_TOO_LARGE trước khi đọc/parse — không đọc DB', async () => {
    const s: Spy = { calls: [] }
    const rnd = (n: number) => crypto.randomBytes(n).toString('base64').slice(0, n) // khó nén ⇒ file lớn thật
    const bytes = fileOf(rowsN(N).map((x) => ({ ...x, product_name: `SP ${rnd(290)}`, reason_text: `QA ${rnd(700)}` })))
    expect(bytes.byteLength).toBeGreaterThan(8 * 1024 * 1024)
    const parsed = parseCareImportCsv(bytes)
    expect(parsed.ok && parsed.rows.length).toBe(N) // file hợp lệ về dòng — chỉ bị chặn vì byte
    const pv = await multipart({ file: { name: 'n1.csv', bytes } })
    const r1 = await handleCarePreview(req(pv.body, pv.contentType), deps(s))
    expect([r1.status, (await r1.json()).code]).toEqual([413, 'PAYLOAD_TOO_LARGE'])
    const cm = await commitForm(bytes)
    const r2 = await handleCareCommit(req(cm.body, cm.contentType), deps(s))
    expect([r2.status, (await r2.json()).code]).toEqual([413, 'PAYLOAD_TOO_LARGE'])
    expect(nonAccess(s)).toEqual([])
  })

  test('Server-Timing (chỉ chế độ QA): ms từng pha 1 chữ số thập phân + RSS; bỏ giá trị không hữu hạn', () => {
    expect(careServerTiming({ parse: 12.34, lookups: 5, stage: Number.NaN }, { rssMb: 300, peakRssMb: 450 }))
      .toBe('parse;dur=12.3, lookups;dur=5.0, rss;desc="300", rss_peak;desc="450"')
    expect(careServerTiming({})).toBe('')
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

  test('parser: lỗi đúng MỘT cột ⇒ field (ID dạng mũ); sai số cột / hai cột / dòng trống ⇒ không field', () => {
    const blank: Cell[] = CONTRACT_HEADERS.map(() => null)
    const p = parseCareImportCsv(csv([
      H,
      r('1.23457E+14', 'QAOS01', EA, 'P1'),
      r('B', 'QAOS01', EA, '1E+15', { customer_external_id: '2E+14' }),
      r('C', 'QAOS01', EA, 'P3').slice(0, 8),
      blank,
      r('E', 'QAOS01', EA, '3.5E+12'),
    ]))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.errors).toEqual([
      { row: 2, code: 'ID_NOT_TEXT', field: 'customer_external_id' },
      { row: 3, code: 'ID_NOT_TEXT' },
      { row: 4, code: 'COLUMN_COUNT' },
      { row: 5, code: 'BLANK_ROW' },
      { row: 6, code: 'ID_NOT_TEXT', field: 'product_id' },
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
    const p = previewOf(csv([
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
    const bytes = csv(rows)
    const m = await multipart({ file: { name: 'care.csv', bytes } })
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
    const c = await multipart({ file: { name: 'care.csv', bytes }, sha256: sha700, period: '2026-10-01' })
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
