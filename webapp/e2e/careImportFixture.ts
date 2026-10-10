import * as XLSX from 'xlsx'

// CRM-CSKH B0 (SPEC B0 mục 5, Q-63): fixture Excel GIẢ cho import N1 —
// đúng một sheet `KhachHang`, đúng 10 header theo data contract r3.2, 25 store,
// nhiều dòng sản phẩm trên một khách (= một task khách/tháng).
//
// KHÔNG chứa PII thật: tên "KH QA …", email miền `.invalid` (RFC 2606 — không
// bao giờ gửi được), mã khách/sản phẩm tiền tố QA, ảnh trỏ đường dẫn `qa-fixture/`
// không tồn tại. SĐT bắt buộc đúng định dạng di động VN để qua validate nên
// dùng dải 0390 000 xxx tuần tự; không dùng để gọi. Mã store mặc định là mã
// giả `QAOS01…25` — QA trên DB thật truyền `stores` (mã store + email dược sĩ
// fixture is_test) thay vì sửa file này.
//
// Tất định: cùng tham số ⇒ cùng nội dung (B2 test diff/idempotency/hash).
// Module chỉ dùng cú pháp TS xoá được (Node 24 chạy trực tiếp qua
// scripts/gen-care-import-fixture.mjs).

export const CARE_IMPORT_SHEET = 'KhachHang'

export const CARE_IMPORT_HEADERS = [
  'customer_external_id',
  'customer_name',
  'customer_phone',
  'target_store_code',
  'assignee_email',
  'reason_type',
  'reason_text',
  'product_id',
  'product_name',
  'product_url',
] as const

export type CareImportRow = Record<(typeof CARE_IMPORT_HEADERS)[number], string>

export interface FixtureStore {
  code: string
  assigneeEmails: string[]
}

export interface FixtureOptions {
  /** Mặc định 25 store giả QAOS01…QAOS25, mỗi store 2 dược sĩ giả. */
  stores?: FixtureStore[]
  /** Số khách mỗi store (mặc định 4). */
  customersPerStore?: number
  /** Khách thứ i có 1 + (i mod maxProducts) dòng sản phẩm (mặc định 3 ⇒ 1–3 dòng). */
  maxProductsPerCustomer?: number
}

const pad = (n: number, w: number) => String(n).padStart(w, '0')

export function defaultFixtureStores(count = 25): FixtureStore[] {
  return Array.from({ length: count }, (_, i) => {
    const s = pad(i + 1, 2)
    return { code: `QAOS${s}`, assigneeEmails: [`qa.care.s${s}a@example.invalid`, `qa.care.s${s}b@example.invalid`] }
  })
}

const REASONS: [string, string][] = [
  ['chronic', 'QA: khách dùng thuốc định kỳ, sắp hết liều'],
  ['promotion', 'QA: sản phẩm đang có chương trình tháng'],
  ['repurchase', 'QA: đến chu kỳ mua lại'],
]

export function buildCareImportRows(opts: FixtureOptions = {}): CareImportRow[] {
  const stores = opts.stores ?? defaultFixtureStores()
  const perStore = opts.customersPerStore ?? 4
  const maxProducts = opts.maxProductsPerCustomer ?? 3
  const rows: CareImportRow[] = []
  let customerNo = 0
  for (const store of stores) {
    if (store.assigneeEmails.length === 0) throw new Error(`store ${store.code} thiếu email dược sĩ`)
    for (let c = 0; c < perStore; c++) {
      customerNo += 1
      const cid = `QA-CUST-${pad(customerNo, 5)}`
      const email = store.assigneeEmails[c % store.assigneeEmails.length]
      const products = 1 + (customerNo % maxProducts)
      for (let p = 0; p < products; p++) {
        const [reasonType, reasonText] = REASONS[(customerNo + p) % REASONS.length]
        const pid = `QA-SKU-${pad(((customerNo * 7 + p * 13) % 997) + 1, 4)}`
        rows.push({
          customer_external_id: cid,
          customer_name: `KH QA ${pad(customerNo, 5)}`,
          customer_phone: `0390${pad(customerNo % 1_000_000, 6)}`,
          target_store_code: store.code,
          assignee_email: email,
          reason_type: reasonType,
          reason_text: `${reasonText} (${pid})`,
          product_id: pid,
          product_name: `Sản phẩm QA ${pid}`,
          // Dòng thứ 3 của khách để trống ảnh — cột không bắt buộc (placeholder).
          product_url: p === 2 ? '' : `https://cdn-gcs.thuocsi.vn/qa-fixture/${pid}.png`,
        })
      }
    }
  }
  return rows
}

/** Workbook một sheet, header đúng thứ tự, mọi ô kiểu text (giữ số 0 đầu SĐT). */
export function buildCareImportWorkbook(rows: CareImportRow[]): XLSX.WorkBook {
  const aoa: string[][] = [
    [...CARE_IMPORT_HEADERS],
    ...rows.map((r) => CARE_IMPORT_HEADERS.map((h) => r[h])),
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  // Ép kiểu chuỗi cho mọi ô có giá trị: Excel mở lại không tự đổi SĐT thành số.
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith('!')) continue
    const cell = ws[addr] as XLSX.CellObject
    cell.t = 's'
    cell.z = '@'
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, CARE_IMPORT_SHEET)
  return wb
}

export function buildCareImportXlsx(opts: FixtureOptions = {}): Buffer {
  const wb = buildCareImportWorkbook(buildCareImportRows(opts))
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
