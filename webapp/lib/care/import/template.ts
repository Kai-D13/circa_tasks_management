import * as XLSX from 'xlsx'
import { CARE_IMPORT_HEADERS, CARE_IMPORT_SHEET } from './contract'

// File mẫu tải xuống của wizard (SPEC B2 §1): đúng sheet + 10 header, hai dòng
// ví dụ GIẢ (một khách hai sản phẩm). Không PII: email miền .invalid, mã QA.
// Mọi ô kiểu text để Excel không làm mất số 0 đầu SĐT/ID.
const SAMPLE: string[][] = [
  ['QA-CUST-00001', 'KH Mẫu 00001', '0390000001', 'QAOS01', 'duoc.si.mau@example.invalid', 'chronic',
    'Khách dùng thuốc định kỳ, sắp hết liều', 'QA-SKU-0001', 'Sản phẩm mẫu 0001', 'https://cdn-gcs.thuocsi.vn/qa-fixture/QA-SKU-0001.png'],
  ['QA-CUST-00001', 'KH Mẫu 00001', '0390000001', 'QAOS01', 'duoc.si.mau@example.invalid', 'promotion',
    'Sản phẩm đang có chương trình tháng', 'QA-SKU-0002', 'Sản phẩm mẫu 0002', ''],
]

export function buildCareImportTemplate(): Uint8Array<ArrayBuffer> {
  const ws = XLSX.utils.aoa_to_sheet([[...CARE_IMPORT_HEADERS], ...SAMPLE])
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith('!')) continue
    const cell = ws[addr] as XLSX.CellObject
    cell.t = 's'
    cell.z = '@'
  }
  ws['!cols'] = CARE_IMPORT_HEADERS.map((h) => ({ wch: Math.max(14, h.length + 2) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, CARE_IMPORT_SHEET)
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new Uint8Array(out)
}
