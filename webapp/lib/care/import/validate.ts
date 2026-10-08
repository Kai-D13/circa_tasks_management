import { normalizeVnPhone } from '@/lib/affiliate/phone'
import {
  CARE_FIELD_MAX_LENGTH, CARE_IMAGE_URL_RE, CARE_IMPORT_HEADERS,
  type CareImportRow, type CareRowError,
} from './contract'

// CRM-CSKH B2 — kiểm từng dòng + gom theo khách (SPEC B2 §1). THUẦN.
// MIRROR các mã lỗi không cần DB của finalize 114: FIELD_REQUIRED, TOO_LONG,
// PHONE_INVALID, IMAGE_URL_HOST, DUPLICATE_PRODUCT, INCONSISTENT_CUSTOMER — cùng
// điều kiện, cùng cách so (trim; email lowercase; SĐT so sau chuẩn hoá). Mã cần DB
// (store/staff/DNC/is_test) nằm ở preview.ts. Spec parity chạy cả hai trên cùng dữ liệu.

export interface CareImportProduct {
  product_id: string
  product_name: string
  image_url: string | null
  reason_type: string
  reason_text: string
}

export interface CareImportCustomer {
  externalId: string
  name: string
  phoneNorm: string
  /** Chuỗi gốc nhỏ nhất (như min(phone_raw) của SQL) — chỉ để hiển thị. */
  phoneRaw: string
  storeCode: string
  email: string
  rows: number[]
  products: CareImportProduct[]
}

export interface CareValidateResult {
  errors: CareRowError[]
  /** Chỉ khách có đủ khoá (external_id) — dùng cho preview; có lỗi thì không commit. */
  customers: CareImportCustomer[]
}

const REQUIRED = CARE_IMPORT_HEADERS.filter((h) => h !== 'product_url')

export function validateCareRows(rows: CareImportRow[]): CareValidateResult {
  const errors: CareRowError[] = []
  const email = (r: CareImportRow) => r.assignee_email.toLowerCase()
  const phoneNorm = (r: CareImportRow) => (r.customer_phone ? normalizeVnPhone(r.customer_phone) : null)

  for (const r of rows) {
    if (REQUIRED.some((f) => r[f] === '')) errors.push({ row: r.rowNo, code: 'FIELD_REQUIRED' })
    if (CARE_IMPORT_HEADERS.some((f) => {
      const max = CARE_FIELD_MAX_LENGTH[f]
      return max !== null && r[f].length > max
    })) errors.push({ row: r.rowNo, code: 'TOO_LONG' })
    if (r.customer_phone !== '' && phoneNorm(r) === null) errors.push({ row: r.rowNo, code: 'PHONE_INVALID' })
    if (r.product_url !== '' && !CARE_IMAGE_URL_RE.test(r.product_url)) errors.push({ row: r.rowNo, code: 'IMAGE_URL_HOST' })
  }

  // Trùng (khách, sản phẩm): mọi dòng của cặp trùng đều lỗi (như COUNT OVER PARTITION).
  const byPair = new Map<string, number[]>()
  for (const r of rows) {
    if (!r.customer_external_id || !r.product_id) continue
    const k = `${r.customer_external_id}\u0000${r.product_id}`
    byPair.set(k, [...(byPair.get(k) ?? []), r.rowNo])
  }
  for (const list of byPair.values()) if (list.length > 1) for (const row of list) errors.push({ row, code: 'DUPLICATE_PRODUCT' })

  // Gom theo khách; nhất quán tên / SĐT chuẩn hoá (hoặc chuỗi gốc nếu không chuẩn hoá được) / store / email.
  const groups = new Map<string, CareImportRow[]>()
  for (const r of rows) {
    if (!r.customer_external_id) continue
    groups.set(r.customer_external_id, [...(groups.get(r.customer_external_id) ?? []), r])
  }
  const customers: CareImportCustomer[] = []
  for (const [externalId, list] of groups) {
    const distinct = (f: (r: CareImportRow) => string) => new Set(list.map(f)).size
    const inconsistent =
      distinct((r) => r.customer_name) > 1 ||
      distinct((r) => phoneNorm(r) ?? r.customer_phone) > 1 ||
      distinct((r) => r.target_store_code) > 1 ||
      distinct(email) > 1
    if (inconsistent) for (const r of list) errors.push({ row: r.rowNo, code: 'INCONSISTENT_CUSTOMER' })
    const first = list[0]
    customers.push({
      externalId,
      name: first.customer_name,
      phoneNorm: phoneNorm(first) ?? '',
      phoneRaw: list.map((r) => r.customer_phone).sort()[0] ?? '',
      storeCode: first.target_store_code,
      email: email(first),
      rows: list.map((r) => r.rowNo),
      products: list
        .map((r) => ({
          product_id: r.product_id,
          product_name: r.product_name,
          image_url: r.product_url === '' ? null : r.product_url,
          reason_type: r.reason_type,
          reason_text: r.reason_text,
        }))
        .sort((a, b) => (a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0)),
    })
  }
  return { errors: dedupeErrors(errors), customers }
}

export function dedupeErrors(errors: CareRowError[]): CareRowError[] {
  const seen = new Set<string>()
  const out: CareRowError[] = []
  for (const e of errors) {
    const k = `${e.row}|${e.code}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out.sort((a, b) => a.row - b.row || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}
