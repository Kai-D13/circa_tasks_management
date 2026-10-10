import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { CareFilters, CarePermissions, CareReportRow } from '@/lib/care/browse'
import {
  careOrderDataState, careReportLines, careReportSummary, careStoreFilterInScope,
  type CareOrderDataState, type CareReportLine, type CareReportTotals,
} from '@/lib/care/reports'
import { loadCareQaReportRows, loadScopeStores, type CareStoreOption } from './browse'
import { careDataScope } from './qaUi'

// CRM-CSKH B5a r1.1 — dữ liệu báo cáo /care/reports + export. Đọc bằng SESSION người xem:
// care_report (DEFINER, scope theo auth.uid) + care_order_sync_status (DEFINER, chỉ người xem báo
// cáo). Không service role, không đọc care_sync_state/care_orders thô.

export interface CareReportData {
  stores: CareStoreOption[]
  /** Dược sĩ có trong kết quả kỳ (cho bộ lọc) — không gửi email. */
  staff: { id: string; fullName: string; storeCode: string }[]
  lines: CareReportLine[]
  totals: CareReportTotals
  orderState: CareOrderDataState
  /** storeId sau khi kiểm scope (ngoài scope ⇒ null). */
  storeId: string | null
  /**
   * Filter cửa hàng KHÔNG thuộc scope người xem ⇒ true + kết quả RỖNG (không âm thầm nới thành toàn
   * scope — SPEC §B5a r1.1). UI hiện thông báo, export trả lỗi filter.
   */
  storeOutOfScope: boolean
}

/** Trạng thái dữ liệu đơn cho dashboard /care (cùng nguồn với báo cáo). */
export async function loadOrderDataState(): Promise<CareOrderDataState> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('care_order_sync_status')
  if (error) throw new Error('care_sync_status_failed')
  return careOrderDataState((Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null)
}

export async function loadCareReport(perms: CarePermissions, f: Pick<CareFilters, 'month' | 'storeId' | 'assigneeId'>): Promise<CareReportData> {
  const supabase = await createClient()
  const stores = await loadScopeStores(perms)
  if (!careStoreFilterInScope(f.storeId, stores)) {
    return { stores, staff: [], lines: [], totals: careReportSummary([]), orderState: { kind: 'none' }, storeId: null, storeOutOfScope: true }
  }
  const storeId = f.storeId
  // QA local: care_report loại is_test với Marketing/SM ⇒ tính từ task qua RLS + batch QA (đường QA, không production).
  const qa = careDataScope().kind === 'qa'
  const [rep, st] = await Promise.all([
    qa ? loadCareQaReportRows({ month: f.month, storeId }).then((data) => ({ data, error: null }), () => ({ data: null, error: true }))
      : supabase.rpc('care_report', { p_month: f.month, p_store_ids: storeId ? [storeId] : null, p_include_test: false }),
    supabase.rpc('care_order_sync_status'),
  ])
  if (rep.error) throw new Error('care_report_failed')
  if (st.error) throw new Error('care_sync_status_failed')
  const rows = (rep.data ?? []) as CareReportRow[]

  // Tên store/dược sĩ theo id có trong kết quả (gồm store đã ngừng/assignee đã đổi role).
  const storeIds = [...new Set(rows.map((r) => r.store_id))]
  const userIds = [...new Set(rows.map((r) => r.assignee_id))]
  const [s2, u2] = await Promise.all([
    storeIds.length ? supabase.from('stores').select('id, code, name').in('id', storeIds) : Promise.resolve({ data: [], error: null }),
    userIds.length ? supabase.from('users').select('id, full_name').in('id', userIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (s2.error || u2.error) throw new Error('care_report_names_failed')
  const storeMap = new Map(((s2.data ?? []) as { id: string; code: string; name: string }[]).map((s) => [s.id, { code: s.code, name: s.name }]))
  const names = new Map(((u2.data ?? []) as { id: string; full_name: string }[]).map((u) => [u.id, u.full_name]))

  const all = careReportLines(rows, { stores: storeMap, names })
  const lines = f.assigneeId ? all.filter((l) => l.assigneeId === f.assigneeId) : all
  const staff = [...new Map(all.map((l) => [l.assigneeId, { id: l.assigneeId, fullName: l.assigneeName, storeCode: l.storeCode }])).values()]
  const row = Array.isArray(st.data) ? st.data[0] : st.data
  return { stores, staff, lines, totals: careReportSummary(lines), orderState: careOrderDataState(row as Record<string, unknown> | null), storeId, storeOutOfScope: false }
}
