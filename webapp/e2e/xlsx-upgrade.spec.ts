import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import * as XLSX from 'xlsx'

// Batch vá thư viện `xlsx` (0.18.5 npm → 0.20.3 bản phát hành chính thức SheetJS; CVE-2023-30533 sửa ở 0.19.3,
// CVE-2024-22363 sửa ở 0.20.2). Test hồi quy THUẦN (không server, không mạng): đọc / ghi theo ĐÚNG tuỳ chọn của từng nơi
// gọi trong app, so với golden ghi bằng 0.18.5 TRƯỚC khi nâng. Fixture là dữ liệu giả:
//   regression-openpyxl.xlsx — ghi bằng openpyxl (gần file Excel thật: sharedStrings, numFmt, công thức không cache, ô gộp);
//   regression-sheetjs.xlsx  — ghi bằng SheetJS 0.18.5 (công thức có cache, ô ngày / giờ / phần trăm, header lạ).
// Ghi lại golden (chỉ khi cố ý, với thư viện CŨ): XLSX_GOLDEN_RECORD=1 npx playwright test e2e/xlsx-upgrade.spec.ts …
//
// Profile ↔ nơi gọi:
//   A  read {type:'buffer'} + sheet_to_json {defval:null}            — app/actions/{kpiCampaigns,targets,fsSessions}.ts
//   B  read {type:'array'}  + sheet_to_json {defval:'', raw:false}   — app/actions/tasks.ts, components/tasks/TaskExcelSplitPanel.tsx
//   W1 json_to_sheet → book_append_sheet(tên) → write base64 → đọc lại A — lib/export/xlsx.ts (xlsxResponse)
//   W2 json_to_sheet → 'Data' → write buffer → đọc lại B              — app/actions/tasks.ts (file cắt theo cửa hàng)
//   CMS (parse / workbooks) đã có e2e/cms-p1b-{import,route}.spec.ts chạy trên thư viện đang cài.

const DIR = path.join(__dirname, 'xlsx-fixtures')
const GOLDEN = path.join(DIR, 'golden-0.18.5.json')
const RECORD = process.env.XLSX_GOLDEN_RECORD === '1'
const FIXTURES = ['regression-openpyxl.xlsx', 'regression-sheetjs.xlsx'] as const
const CMS_TEMPLATE = path.join(__dirname, '..', 'public', 'templates', 'Circa_Import_CMS.xlsx')
// 7 tên sheet export thật (app/api/export/*): phải hợp lệ theo luật tên sheet Excel mà 0.19.3+ bắt buộc.
const EXPORT_SHEET_NAMES = ['Báo cáo CSKH', 'Sản phẩm FS', 'Kết quả chiến dịch', 'Nhật ký', 'Toa thuốc', 'Tasks', 'Data']

/** Giá trị → dạng so sánh được qua JSON (giữ -0 / NaN / ±Infinity / undefined / Date / prototype lạ). */
function enc(v: unknown): unknown {
  if (v === undefined) return { $: 'undefined' }
  if (typeof v === 'number') return Object.is(v, -0) ? { $: '-0' } : Number.isFinite(v) ? v : { $: String(v) }
  if (v instanceof Date) return { $: 'date', iso: Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString() }
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  return { $: typeof v, s: String(v) }
}
function encRows(rows: unknown[]): unknown[] {
  return rows.map((r) => {
    const o = r as Record<string, unknown>
    return { proto: Object.getPrototypeOf(o) === Object.prototype ? 'Object' : 'khác', entries: Object.entries(o).map(([k, v]) => [k, enc(v)]) }
  })
}

function profileA(buf: Buffer) {
  const wb = XLSX.read(buf, { type: 'buffer' })
  return wb.SheetNames.map((n) => {
    const ws = wb.Sheets[n]
    return { name: n, ref: ws['!ref'] ?? null, merges: (ws['!merges'] ?? []).map((m) => XLSX.utils.encode_range(m)), rows: encRows(XLSX.utils.sheet_to_json(ws, { defval: null })) }
  })
}
function profileB(buf: Buffer) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const wb = XLSX.read(ab, { type: 'array' })
  return wb.SheetNames.map((n) => ({ name: n, rows: encRows(XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[n], { defval: '', raw: false })) }))
}
function rowsOf(buf: Buffer, sheet: string, opts: XLSX.Sheet2JSONOpts) {
  const wb = XLSX.read(buf, { type: 'buffer' })
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheet], opts)
}
function roundTripW1(rows: Record<string, unknown>[], sheetName: string) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ '(không có dữ liệu)': '' }]), sheetName.slice(0, 31))
  const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string
  const back = Buffer.from(b64, 'base64')
  return { zip: back.subarray(0, 2).toString('latin1'), sheets: XLSX.read(back, { type: 'buffer' }).SheetNames, rows: encRows(rowsOf(back, sheetName.slice(0, 31), { defval: null })) }
}
function roundTripW2(rows: Record<string, unknown>[]) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Data')
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return { zip: out.subarray(0, 2).toString('latin1'), rows: encRows(rowsOf(out, 'Data', { defval: '', raw: false })) }
}

/** Fixture SheetJS — chỉ dựng ở chế độ RECORD với thư viện CŨ (0.18.5), sau đó là file cố định. */
function buildSheetjsFixture(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Mã CH', 'Mục tiêu', 'Tỷ lệ', 'Ngày', 'Ngày giờ', 'Văn bản số', 'Công thức', 'Lỗi'],
    ['001', 1500000, 0.125, 46327, 46327.75, '00123', 3000000, '#N/A'],
    ['002', 0, 1, 43831, 43831, '9007199254740993', 1, ''],
    ['003', -2.5, 0.0001, 73050, 73050.999988, '1e5', 0, 'x'],
  ])
  const fmt = (addr: string, z: string) => { (ws[addr] as XLSX.CellObject).z = z }
  for (const r of [2, 3, 4]) { fmt(`C${r}`, '0.00%'); fmt(`D${r}`, 'dd/mm/yyyy'); fmt(`E${r}`, 'dd/mm/yyyy hh:mm'); fmt(`B${r}`, '#,##0') }
  ws.G2 = { t: 'n', v: 3000000, f: 'B2*2' }
  ws.G3 = { t: 'n', v: 1, f: 'C3' }
  ws.G4 = { t: 'n', v: 0, f: 'IFERROR(1/0,0)' }
  ws.H2 = { t: 'e', v: 0x2a, w: '#N/A' }
  ws.A6 = { t: 's', v: 'ô gộp' }
  ws['!ref'] = 'A1:H6'
  ws['!merges'] = [XLSX.utils.decode_range('A6:C6')]
  const odd = XLSX.utils.aoa_to_sheet([['__proto__', 'constructor', 'Mã', 'Mã'], ['{"polluted":1}', 'c', '001', 'trùng tên cột']])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Data')
  XLSX.utils.book_append_sheet(wb, odd, 'Header lạ')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

function snapshot() {
  const out: Record<string, unknown> = {}
  for (const f of FIXTURES) {
    const buf = fs.readFileSync(path.join(DIR, f))
    const dataA = rowsOf(buf, 'Data', { defval: null })
    const dataB = rowsOf(buf, 'Data', { defval: '', raw: false })
    out[f] = {
      A: profileA(buf),
      B: profileB(buf),
      W1: EXPORT_SHEET_NAMES.slice(0, 3).map((n) => roundTripW1(dataA, n)),
      W1empty: roundTripW1([], 'Nhật ký'),
      W2: roundTripW2(dataB),
    }
  }
  // Template CMS chỉ có trên nhánh mang CMS; cherry-pick batch sang `main` (chưa có CMS) ⇒ bỏ mục này ở cả hai phía.
  if (fs.existsSync(CMS_TEMPLATE)) out['Circa_Import_CMS.xlsx'] = { A: profileA(fs.readFileSync(CMS_TEMPLATE)) }
  return out
}

test.describe('xlsx — hồi quy nâng thư viện @desktop', () => {
  test('golden 0.18.5: đọc A / B, ghi W1 / W2 cho 2 fixture + template CMS khớp từng giá trị', () => {
    if (RECORD) {
      expect(XLSX.version, 'chỉ ghi golden bằng thư viện CŨ').toBe('0.18.5')
      const sj = path.join(DIR, 'regression-sheetjs.xlsx')
      if (!fs.existsSync(sj)) fs.writeFileSync(sj, buildSheetjsFixture())
      fs.writeFileSync(GOLDEN, JSON.stringify({ version: XLSX.version, snapshot: snapshot() }, null, 1) + '\n')
      return
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as { version: string; snapshot: unknown }
    expect(golden.version).toBe('0.18.5')
    const cur = snapshot()
    // Phân tích lệch: XLSX_SNAPSHOT_OUT=<file ngoài repo> ghi snapshot hiện tại để so từng đường dẫn.
    if (process.env.XLSX_SNAPSHOT_OUT) fs.writeFileSync(process.env.XLSX_SNAPSHOT_OUT, JSON.stringify(cur))
    // KHÁC BIỆT DUY NHẤT được chấp nhận (đã phân tích): xuống dòng trong ô văn bản 0.18.5 đọc ra "\r\n", 0.20.3 giữ "\n"
    // như XML. Đúng 6 vị trí = ô "Ghi chú" dòng 1 của fixture openpyxl qua A / B / W1 ×3 / W2. CMS đã chuẩn hoá \r\n → \n
    // (lib/cms/import/validate.ts); KPI / target / FS đọc mã + số. Không chấp nhận lệch nào khác.
    let crlf = 0
    const accept = (v: unknown): unknown => {
      if (typeof v === 'string' && v.includes('\r\n')) { crlf++; return v.replace(/\r\n/g, '\n') }
      if (Array.isArray(v)) return v.map(accept)
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, accept(x)]))
      return v
    }
    const expected = accept(golden.snapshot) as Record<string, unknown>
    expect(crlf, 'số ô có \\r\\n trong golden').toBe(6)
    if (!fs.existsSync(CMS_TEMPLATE)) delete expected['Circa_Import_CMS.xlsx']
    expect(cur).toEqual(expected)
  })

  test('không ô nhiễm prototype khi đọc header __proto__ / constructor (CVE-2023-30533 thuộc lớp lỗi này)', () => {
    for (const f of FIXTURES) {
      const buf = fs.readFileSync(path.join(DIR, f))
      profileA(buf)
      profileB(buf)
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false)
  })

  test('7 tên sheet export thật hợp lệ khi ghi (luật tên sheet 0.19.3+)', () => {
    for (const n of EXPORT_SHEET_NAMES) {
      const wb = XLSX.utils.book_new()
      expect(() => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ a: 1 }]), n), n).not.toThrow()
      expect(n.length).toBeLessThanOrEqual(31)
    }
  })

  test('phiên bản đã vá: 0.20.3 từ bản phát hành chính thức SheetJS, lockfile ghim integrity', () => {
    test.skip(RECORD, 'chế độ ghi golden dùng thư viện cũ')
    expect(XLSX.version).toBe('0.20.3')
    const root = path.join(__dirname, '..')
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies.xlsx).toBe('https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz')
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; resolved?: string; integrity?: string }> }
    const entry = lock.packages['node_modules/xlsx']
    expect(entry.version).toBe('0.20.3')
    expect(entry.resolved).toBe('https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz')
    expect(entry.integrity).toBe('sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==')
  })
})
