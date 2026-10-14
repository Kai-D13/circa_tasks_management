import type { CareRowError, CareRowErrorCode } from './contract'
import type { CarePreviewCustomer } from './preview'

// CRM-CSKH B8.3 — số liệu trình bày cho wizard /care/assign, tính THUẦN từ preview thật (không số giả,
// không truy vấn thêm). Bước 3 chỉ đọc: dược sĩ = email trong file (khớp chính xác ở preview).

export interface CareAssignRow {
  email: string
  name: string
  customers: number
  created: number
  updated: number
  unchanged: number
  skipped: number
  /** Khách đã có task kỳ này với cửa hàng/dược sĩ khác file ⇒ finalize giữ người hiện tại. */
  ownerIgnored: number
}
export interface CareAssignStore { storeCode: string; storeName: string; customers: number; rows: CareAssignRow[] }
export interface CareAssignTable {
  stores: CareAssignStore[]
  totals: Omit<CareAssignRow, 'email' | 'name'>
  assignees: number
  /** Số khách lớn nhất của một dược sĩ — mốc 100% cho thanh nhỏ. */
  maxCustomers: number
}

const zero = () => ({ customers: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, ownerIgnored: 0 })

/** Bảng cửa hàng × dược sĩ. Khách lỗi / cửa hàng không hợp lệ không vào bảng (bước 3 chỉ tới được khi 0 lỗi). */
export function careAssignmentTable(customers: readonly CarePreviewCustomer[]): CareAssignTable {
  const stores = new Map<string, CareAssignStore>()
  const totals = zero()
  for (const c of customers) {
    if (c.action === 'error' || !c.storeName) continue
    const s = stores.get(c.storeCode) ?? { storeCode: c.storeCode, storeName: c.storeName, customers: 0, rows: [] }
    let r = s.rows.find((x) => x.email === c.email)
    if (!r) { r = { email: c.email, name: c.assigneeName ?? c.email, ...zero() }; s.rows.push(r) }
    for (const t of [r, totals]) {
      t.customers++
      if (c.action === 'create') t.created++
      else if (c.action === 'update') t.updated++
      else if (c.action === 'unchanged') t.unchanged++
      else if (c.action === 'skip_has_interaction') t.skipped++
      if (c.ownerIgnored) t.ownerIgnored++
    }
    s.customers++
    stores.set(c.storeCode, s)
  }
  const list = [...stores.values()].sort((a, b) => a.storeCode.localeCompare(b.storeCode))
  for (const s of list) s.rows.sort((a, b) => a.name.localeCompare(b.name, 'vi') || a.email.localeCompare(b.email))
  const rows = list.flatMap((s) => s.rows)
  return { stores: list, totals, assignees: rows.length, maxCustomers: Math.max(0, ...rows.map((r) => r.customers)) }
}

/**
 * Đếm theo mã cho chip lọc lỗi. Ưu tiên `errorCounts` của server (tính trên TOÀN BỘ lỗi). Không có (vd lỗi
 * finalize) mà danh sách bị cắt ⇒ null: KHÔNG hiện số đếm sai (Q-110).
 */
export function careErrorCodeCounts(
  errors: readonly CareRowError[], total: number, serverCounts?: Partial<Record<CareRowErrorCode, number>> | null,
): Partial<Record<CareRowErrorCode, number>> | null {
  if (serverCounts) return serverCounts
  if (total !== errors.length) return null
  const out: Partial<Record<CareRowErrorCode, number>> = {}
  for (const e of errors) out[e.code] = (out[e.code] ?? 0) + 1
  return out
}
