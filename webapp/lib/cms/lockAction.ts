// CMS P3a — lõi THUẦN của action chốt kỳ / preview (deps tiêm vào ⇒ test không cần Next runtime: e2e/cms-p3a-unit.spec.ts).
// Thứ tự (work order P3a §4.1): cờ program + earnings + lock → super từ SESSION (actor không lấy từ form) → chương trình tồn tại
// và thuộc namespace đọc được (QA chỉ khi có marker) → đầu vào (UUID, policy version, lý do) → RPC 123 (kiểm lại toàn bộ trong
// transaction: run / policy / mapping / Q-213 / cổng). Client KHÔNG gửi tổng tiền, ngưỡng, actor hay is_test.
// Lỗi RPC ⇒ mã cố định:
//   · message có CMS_* ⇒ đúng mã đó (từ chối xác định — transaction đã rollback);
//   · 55P03 (lock_timeout) ⇒ BUSY (chưa ghi);
//   · mất phản hồi / timeout câu lệnh / lỗi kết nối ⇒ UNKNOWN_OUTCOME — KHÔNG kết luận "chưa chốt": UI bảo tải lại để kiểm;
//     gọi lại cùng expected_run là idempotent ({already: true}).
//   · SQLSTATE khác ⇒ QUERY_FAILED (từ chối xác định, không lộ message DB).

import { cmsNormalizeAck, parseCmsLockPreview, type CmsLockPreviewDto } from './payoutView'

export type CmsAdminAccessLike =
  | { kind: 'ok'; actorId: string; qa: boolean }
  | { kind: 'anonymous' } | { kind: 'forbidden' } | { kind: 'unavailable' }

export interface CmsRpcError { code?: string; message?: string }
export interface CmsLockDeps {
  lockEnabled(): boolean
  /** Server QA chỉ đọc (CMS_QA_SERVER=1 do launcher đặt) ⇒ chốt bị từ chối trước RPC; preview không ảnh hưởng. */
  qaReadonly(): boolean
  access(): Promise<CmsAdminAccessLike>
  /** Chương trình có tồn tại + isTest — null nếu không có. Lỗi tra ⇒ throw. */
  program(id: string): Promise<{ isTest: boolean } | null>
  rpc(fn: 'rpc_cms_lock_preview' | 'rpc_cms_program_lock', args: Record<string, unknown>): Promise<{ data: unknown; error: CmsRpcError | null }>
}

export type CmsLockResult =
  | { ok: true; already: boolean; programId: string; runId: string; amountVnd: string; policyVersion: number }
  | { ok: false; code: string }
export type CmsLockPreviewResult = { ok: true; preview: CmsLockPreviewDto } | { ok: false; code: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INT_RE = /^(0|[1-9][0-9]{0,18})$/

/** Phân loại lỗi RPC chốt (xem đầu file). */
export function cmsLockRpcCode(error: CmsRpcError | null | undefined): string {
  const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(error?.message ?? ''))
  if (m) return m[0]
  const c = String(error?.code ?? '')
  if (c === '55P03') return 'BUSY'
  // PostgREST từ chối TRƯỚC khi chạy hàm (PGRST1xx request · 2xx schema cache, vd. PGRST202 chưa có hàm · 3xx JWT) ⇒ chắc chắn
  // chưa ghi. PGRST0xx (kết nối DB) giữ "không rõ" — có thể đứt sau khi câu lệnh đã gửi.
  if (/^PGRST[1-3][0-9]{2}$/.test(c)) return 'QUERY_FAILED'
  // 57014 statement timeout / 57P0x admin shutdown / 08xxx kết nối / không mã (transport, abort) ⇒ không biết đã commit chưa.
  if (c === '' || c === '57014' || /^57P/.test(c) || /^08/.test(c) || !/^[0-9A-Z]{5}$/.test(c)) return 'UNKNOWN_OUTCOME'
  return 'QUERY_FAILED'
}

async function gate(deps: CmsLockDeps, programId: unknown): Promise<{ ok: true; actorId: string } | { ok: false; code: string }> {
  if (!deps.lockEnabled()) return { ok: false, code: 'LOCK_DISABLED' }
  let a: CmsAdminAccessLike
  try { a = await deps.access() } catch { return { ok: false, code: 'UNAVAILABLE' } }
  if (a.kind === 'anonymous') return { ok: false, code: 'UNAUTHENTICATED' }
  if (a.kind === 'forbidden') return { ok: false, code: 'FORBIDDEN' }
  if (a.kind !== 'ok') return { ok: false, code: 'UNAVAILABLE' }
  if (typeof programId !== 'string' || !UUID_RE.test(programId)) return { ok: false, code: 'BAD_INPUT' }
  let p: { isTest: boolean } | null
  try { p = await deps.program(programId) } catch { return { ok: false, code: 'QUERY_FAILED' } }
  // QA không marker ⇒ như không tồn tại (H9b) — không lộ chương trình test.
  if (!p || (p.isTest && !a.qa)) return { ok: false, code: 'NOT_FOUND' }
  return { ok: true, actorId: a.actorId }
}

export async function runCmsLockPreview(deps: CmsLockDeps, programId: unknown): Promise<CmsLockPreviewResult> {
  const g = await gate(deps, programId)
  if (!g.ok) return g
  let res: { data: unknown; error: CmsRpcError | null }
  try { res = await deps.rpc('rpc_cms_lock_preview', { p_program_id: programId }) } catch { return { ok: false, code: 'QUERY_FAILED' } }
  if (res.error) {
    const c = cmsLockRpcCode(res.error)
    return { ok: false, code: c === 'UNKNOWN_OUTCOME' ? 'QUERY_FAILED' : c } // preview chỉ đọc ⇒ không có "kết quả không rõ"
  }
  try { return { ok: true, preview: parseCmsLockPreview(res.data) } } catch { return { ok: false, code: 'QUERY_FAILED' } }
}

export async function runCmsLock(deps: CmsLockDeps, input: unknown): Promise<CmsLockResult> {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const g = await gate(deps, i.programId)
  if (!g.ok) return g
  // PM r1 PKG-P1-2: server QA không ghi chốt từ UI — chặn TRƯỚC mọi RPC (đường chốt QA duy nhất là CLI có gate + sổ ý định).
  if (deps.qaReadonly()) return { ok: false, code: 'QA_SERVER_READONLY' }
  const runId = i.expectedRunId
  const pv = i.expectedPolicyVersion
  if (typeof runId !== 'string' || !UUID_RE.test(runId) || typeof pv !== 'number' || !Number.isSafeInteger(pv) || pv < 1) {
    return { ok: false, code: 'BAD_INPUT' }
  }
  // Lý do: rỗng ⇒ null (DB quyết có bắt buộc không — CMS_LOCK_ACK_REQUIRED); có nội dung thì phải hợp lệ.
  let ack: string | null = null
  if (typeof i.ackReason === 'string' && i.ackReason.trim() !== '') {
    ack = cmsNormalizeAck(i.ackReason)
    if (ack === null) return { ok: false, code: 'CMS_LOCK_ACK_REQUIRED' }
  } else if (i.ackReason !== undefined && i.ackReason !== null && typeof i.ackReason !== 'string') {
    return { ok: false, code: 'BAD_INPUT' }
  }
  let res: { data: unknown; error: CmsRpcError | null }
  try {
    res = await deps.rpc('rpc_cms_program_lock', {
      p_program_id: i.programId, p_expected_run_id: runId, p_expected_policy_version: pv, p_actor: g.actorId, p_ack_reason: ack,
    })
  } catch {
    return { ok: false, code: 'UNKNOWN_OUTCOME' }
  }
  if (res.error) return { ok: false, code: cmsLockRpcCode(res.error) }
  const d = res.data
  if (typeof d !== 'object' || d === null) return { ok: false, code: 'UNKNOWN_OUTCOME' }
  const o = d as Record<string, unknown>
  // Phản hồi phải nói ĐÚNG chương trình / run vừa yêu cầu đã chốt; lệch ⇒ không kết luận thành công.
  if (o.locked !== true || o.program_id !== i.programId || o.run_id !== runId || typeof o.amount_vnd !== 'string' || !INT_RE.test(o.amount_vnd)
      || typeof o.policy_version !== 'number') {
    return { ok: false, code: 'UNKNOWN_OUTCOME' }
  }
  return { ok: true, already: o.already === true, programId: i.programId as string, runId, amountVnd: o.amount_vnd, policyVersion: o.policy_version }
}
