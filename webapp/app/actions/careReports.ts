'use server'

import { isCareEnabled } from '@/lib/care/flags'
import { parseCareFilters, type CareOutcomeKey } from '@/lib/care/browse'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { getCareViewAccess, loadCareContactedCount, loadCareReportOutcomes, loadScopeStores } from '@/lib/care/server/browse'
import { CARE_REPORT_STORE_OUT_OF_SCOPE, careStoreFilterInScope } from '@/lib/care/reports'

// CRM-CSKH B8.2 — số liệu phụ /care/reports tải SAU khi trang hiện (đo 14/10: 7 count chạy trong lúc server
// còn render khung trang tranh pool PostgREST với layout ⇒ trang chậm ~100–130 ms; tải ở client thì khung nhanh
// như cũ). Một action, đọc bằng SESSION (RLS + careDataScope quyết phạm vi; filter URL chỉ thu hẹp):
// "Đã liên hệ" (Q-113: last_interaction_at kể cả kỳ cũ) + phân bố last_outcome mỗi task (Q-117). Không PII.

export type CareReportExtrasResult =
  | { ok: true; contacted: number; outcomes: Partial<Record<CareOutcomeKey, number>> }
  | { ok: false; message: string }

export async function loadCareReportExtras(input: { month: string; store: string | null; assignee: string | null }): Promise<CareReportExtrasResult> {
  if (!isCareEnabled()) return { ok: false, message: 'Chức năng chưa được bật.' }
  const v = await getCareViewAccess()
  if (v.kind !== 'ok' || !v.perms.canView) return { ok: false, message: 'Không có quyền xem.' }
  // Cùng parser với trang: tháng sai/tương lai ⇒ kỳ hiện tại; store/dược sĩ không phải uuid ⇒ bỏ (chỉ thu hẹp).
  const f = parseCareFilters({ month: String(input?.month ?? ''), store: String(input?.store ?? ''), assignee: String(input?.assignee ?? '') }, carePeriodOf(new Date()))
  const rf = { month: f.month, storeId: f.storeId, assigneeId: f.assigneeId }
  try {
    // Cùng luật trang/export: store ngoài phạm vi ⇒ báo lỗi, KHÔNG trả 0 (security B8.2 r2 P2 — tránh số 0 giả).
    if (f.storeId && !careStoreFilterInScope(f.storeId, await loadScopeStores(v.perms))) return { ok: false, message: CARE_REPORT_STORE_OUT_OF_SCOPE }
    const today = vnDateISO(new Date())
    const [contacted, outcomes] = await Promise.all([loadCareContactedCount(rf, today), loadCareReportOutcomes(rf, today)])
    return { ok: true, contacted, outcomes }
  } catch {
    return { ok: false, message: 'Không tải được — thử tải lại trang.' }
  }
}
