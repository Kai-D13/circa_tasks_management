import { periodLastDay } from '@/lib/care/time'
import type { CareRowError } from './contract'
import { dedupeErrors, type CareImportCustomer, type CareImportProduct, type CareValidateResult } from './validate'

// CRM-CSKH B2 — preview CHỈ ĐỌC (SPEC B2 §2): map store/dược sĩ, DNC, is_test và
// diff với task kỳ hiện tại. THUẦN: dữ liệu DB đi vào qua `CareImportLookups`
// (server/importRepo.ts nạp bằng service role SAU khi kiểm quyền).
//
// MIRROR finalize 114 (`care__import_finalize_at`):
//   · STORE_INVALID: mã không khớp store OS đang hoạt động.
//   · Email: đếm staff (role staff, đúng store đích, lower(trim(email))) — 0 ⇒
//     ASSIGNEE_INVALID, >1 ⇒ ASSIGNEE_AMBIGUOUS (audit PM B1 P0).
//   · REFUSED_AT_STORE: khách đã có từ chối ở đúng store đích VÀ chưa có task kỳ này.
//   · TEST_FLAG_MISMATCH: khách/task kỳ này có is_test khác batch.
//   · Phân loại: created / updated / unchanged / skipped_has_interaction /
//     owner_ignored (giao với nhóm khác) / absent_kept / closed_previous_period.
// Preview KHÔNG phải cam kết: dữ liệu có thể đổi trước khi commit; finalize
// kiểm lại và là nguồn quyết định.

export interface CareStoreRef { id: string; code: string; name: string }
export interface CareStaffRef { id: string; storeId: string; email: string; fullName: string }
export interface CareExistingTask {
  id: string
  customerId: string
  status: 'open' | 'completed' | 'closed_unfinished'
  storeId: string
  assigneeId: string
  customerName: string
  phoneNorm: string
  phoneRaw: string
  isTest: boolean
  hasInteraction: boolean
  products: CareImportProduct[]
}

export interface CareImportLookups {
  /** Store OS đang hoạt động, theo mã. */
  storesByCode: Map<string, CareStoreRef>
  /** Staff thuộc các store OS đang hoạt động (email đã lower+trim). */
  staff: CareStaffRef[]
  /** Khách đã có theo external_id. */
  customers: Map<string, { id: string; isTest: boolean }>
  /** `${customerId}|${storeId}` đã từ chối. */
  refusals: Set<string>
  /** Task kỳ đang import, theo customer_id. */
  currentTasks: Map<string, CareExistingTask>
  /** Tổng task kỳ này cùng loại is_test (để tính absent_kept). */
  currentPeriodTaskCount: number
  /** Task còn mở của các kỳ trước (finalize sẽ đóng). */
  openPreviousPeriodCount: number
}

export type CareCustomerAction = 'create' | 'update' | 'unchanged' | 'skip_has_interaction' | 'error'

export interface CarePreviewCustomer {
  externalId: string
  name: string
  phoneRaw: string
  storeCode: string
  storeName: string | null
  email: string
  assigneeName: string | null
  productCount: number
  rows: number[]
  action: CareCustomerAction
  ownerIgnored: boolean
}

export interface CarePreviewCounts {
  created: number
  updated: number
  unchanged: number
  skipped_has_interaction: number
  owner_ignored: number
  absent_kept: number
  closed_previous_period: number
}

export interface CareAssignmentGroup {
  storeCode: string
  storeName: string
  assignees: { email: string; name: string; customers: number; products: number }[]
  customers: number
}

export interface CarePreview {
  period: string
  dueDate: string
  rowCount: number
  customerCount: number
  storeCodesInFile: number
  activeOsStoreCount: number
  activeOsStoresMissing: { code: string; name: string }[]
  errors: CareRowError[]
  counts: CarePreviewCounts
  assignments: CareAssignmentGroup[]
  customers: CarePreviewCustomer[]
}

const sameProducts = (a: CareImportProduct[], b: CareImportProduct[]) => {
  if (a.length !== b.length) return false
  const key = (p: CareImportProduct) =>
    JSON.stringify([p.product_id, p.product_name, p.image_url, p.reason_type, p.reason_text])
  const set = new Set(a.map(key))
  return b.every((p) => set.has(key(p)))
}

export function buildCarePreview(input: {
  rowCount: number
  validated: CareValidateResult
  parseErrors: CareRowError[]
  lookups: CareImportLookups
  period: string
  isTest: boolean
}): CarePreview {
  const { validated, lookups, period, isTest } = input
  const errors: CareRowError[] = [...input.parseErrors, ...validated.errors]
  const staffByStore = new Map<string, CareStaffRef[]>()
  for (const s of lookups.staff) staffByStore.set(s.storeId, [...(staffByStore.get(s.storeId) ?? []), s])

  const counts: CarePreviewCounts = {
    created: 0, updated: 0, unchanged: 0, skipped_has_interaction: 0, owner_ignored: 0,
    absent_kept: 0, closed_previous_period: lookups.openPreviousPeriodCount,
  }
  const out: CarePreviewCustomer[] = []
  const matchedTaskIds = new Set<string>()

  for (const c of validated.customers) {
    const rowErr = (code: CareRowError['code']) => { for (const row of c.rows) errors.push({ row, code }) }
    const store = c.storeCode ? lookups.storesByCode.get(c.storeCode) ?? null : null
    if (c.storeCode && !store) rowErr('STORE_INVALID')
    let assignee: CareStaffRef | null = null
    if (store && c.email) {
      const candidates = (staffByStore.get(store.id) ?? []).filter((s) => s.email === c.email)
      if (candidates.length === 0) rowErr('ASSIGNEE_INVALID')
      else if (candidates.length > 1) rowErr('ASSIGNEE_AMBIGUOUS')
      else assignee = candidates[0]
    }
    const existing = lookups.customers.get(c.externalId) ?? null
    const task = existing ? lookups.currentTasks.get(existing.id) ?? null : null
    if (existing && store && !task && lookups.refusals.has(`${existing.id}|${store.id}`)) rowErr('REFUSED_AT_STORE')
    if (existing && (existing.isTest !== isTest || (task && task.isTest !== isTest))) rowErr('TEST_FLAG_MISMATCH')

    let action: CareCustomerAction
    let ownerIgnored = false
    if (!task) {
      action = 'create'
    } else {
      if (task.isTest === isTest) matchedTaskIds.add(task.id)
      const locked = task.status !== 'open' || task.hasInteraction
      ownerIgnored = !!store && !!assignee && (task.storeId !== store.id || task.assigneeId !== assignee.id)
      const productsDiff = !sameProducts(task.products, c.products)
      const snapshotDiff = task.customerName !== c.name || task.phoneNorm !== c.phoneNorm || task.phoneRaw !== c.phoneRaw
      action = locked ? 'skip_has_interaction' : productsDiff || snapshotDiff ? 'update' : 'unchanged'
    }
    out.push({
      externalId: c.externalId, name: c.name, phoneRaw: c.phoneRaw, storeCode: c.storeCode,
      storeName: store?.name ?? null, email: c.email, assigneeName: assignee?.fullName ?? null,
      productCount: c.products.length, rows: c.rows, action, ownerIgnored,
    })
  }

  const finalErrors = dedupeErrors(errors)
  const errorRows = new Set(finalErrors.map((e) => e.row))
  for (const c of out) {
    if (c.rows.some((r) => errorRows.has(r))) c.action = 'error'
    else if (c.action === 'create') counts.created++
    else if (c.action === 'update') counts.updated++
    else if (c.action === 'unchanged') counts.unchanged++
    else if (c.action === 'skip_has_interaction') counts.skipped_has_interaction++
    if (c.ownerIgnored && c.action !== 'error') counts.owner_ignored++
  }
  counts.absent_kept = Math.max(0, lookups.currentPeriodTaskCount - matchedTaskIds.size)

  // Bước 3 "Phân công" CHỈ XEM: email trong file đã quyết định owner.
  const groups = new Map<string, CareAssignmentGroup>()
  for (const c of out) {
    if (!c.storeName) continue
    const g = groups.get(c.storeCode) ?? { storeCode: c.storeCode, storeName: c.storeName, assignees: [], customers: 0 }
    g.customers++
    const a = g.assignees.find((x) => x.email === c.email)
    if (a) { a.customers++; a.products += c.productCount }
    else g.assignees.push({ email: c.email, name: c.assigneeName ?? c.email, customers: 1, products: c.productCount })
    groups.set(c.storeCode, g)
  }
  // Độ phủ = số store OS ĐANG HOẠT ĐỘNG có khách trong file (mã sai đã là STORE_INVALID,
  // không đếm vào — tránh hiển thị kiểu "25/24").
  const fileCodes = new Set(validated.customers.map((c) => c.storeCode).filter((code) => lookups.storesByCode.has(code)))
  const missing = [...lookups.storesByCode.values()]
    .filter((s) => !fileCodes.has(s.code))
    .map((s) => ({ code: s.code, name: s.name }))
    .sort((a, b) => a.code.localeCompare(b.code))

  return {
    period,
    dueDate: periodLastDay(period),
    rowCount: input.rowCount,
    customerCount: validated.customers.length,
    storeCodesInFile: fileCodes.size,
    activeOsStoreCount: lookups.storesByCode.size,
    activeOsStoresMissing: missing,
    errors: finalErrors,
    counts,
    assignments: [...groups.values()].sort((a, b) => a.storeCode.localeCompare(b.storeCode)),
    customers: out,
  }
}

export type { CareImportCustomer }
