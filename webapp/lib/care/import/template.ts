import { CARE_IMPORT_HEADERS } from './contract'
import { toCareCsv } from './csvCore'

// File mẫu tải xuống của wizard (SPEC B2 §1; Q-124: CSV UTF-8): đúng 10 header, hai dòng ví dụ GIẢ (một khách hai
// sản phẩm). Không PII: email miền .invalid, mã QA. Có BOM để Excel mở đúng tiếng Việt; CRLF như Excel lưu.
const SAMPLE: string[][] = [
  ['QA-CUST-00001', 'KH Mẫu 00001', '0390000001', 'QAOS01', 'duoc.si.mau@example.invalid', 'chronic',
    'Khách dùng thuốc định kỳ, sắp hết liều', 'QA-SKU-0001', 'Sản phẩm mẫu 0001', 'https://cdn-gcs.thuocsi.vn/qa-fixture/QA-SKU-0001.png'],
  ['QA-CUST-00001', 'KH Mẫu 00001', '0390000001', 'QAOS01', 'duoc.si.mau@example.invalid', 'promotion',
    'Sản phẩm đang có chương trình tháng, mua 2 tặng 1', 'QA-SKU-0002', 'Sản phẩm mẫu 0002', ''],
]

export const CARE_IMPORT_TEMPLATE_FILENAME = 'care_import_mau.csv'

export function buildCareImportTemplate(): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(toCareCsv([[...CARE_IMPORT_HEADERS], ...SAMPLE]))
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  out.set(bytes)
  return out
}
