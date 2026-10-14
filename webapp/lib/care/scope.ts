// CRM-CSKH B6-qa-ui — phạm vi dữ liệu của MỌI truy vấn task CRM theo session (THUẦN).
//
//   · production (mặc định, mọi build production): chỉ task thật — `is_test = false`.
//   · qa: CHỈ task `is_test = true` của đúng batch QA trong marker (server QA local, lib/care/server/qaUi.ts).
//
// Chỉ THÊM điều kiện lên query PostgREST: RLS 114 của vai đang đăng nhập vẫn là ranh giới quyền.

export type CareDataScope =
  | { kind: 'production' }
  | { kind: 'qa'; batchId: string }

export const CARE_PRODUCTION_SCOPE: CareDataScope = { kind: 'production' }

export function applyCareScope<Q extends { eq(col: string, v: unknown): Q }>(q: Q, scope: CareDataScope): Q {
  return scope.kind === 'qa' ? q.eq('is_test', true).eq('batch_id', scope.batchId) : q.eq('is_test', false)
}

/** Như applyCareScope cho builder PostgREST thật (kiểu lồng quá sâu cho generic) — trả lại đúng kiểu gốc. */
export function withCareScope<T>(q: T, scope: CareDataScope): T {
  type B = { eq(col: string, v: unknown): B }
  return applyCareScope(q as unknown as B, scope) as unknown as T
}
