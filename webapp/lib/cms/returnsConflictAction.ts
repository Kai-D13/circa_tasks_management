// CMS-CALC-RET-2 P5.5 — lõi action "Xác nhận nguồn đã phục hồi" (super) cho conflict trả hàng (thiết kế r2 §6.4 bước 4 / §14.1–14.2;
// migration 130 rpc_cms_return_conflicts_confirm_restored). Thứ tự: cờ (program + earnings + returns) → server QA chỉ đọc → super SESSION
// → đầu vào → chương trình (QA không marker ⇒ NOT_FOUND) → RPC bằng SESSION client (RPC tự kiểm auth.uid() + is_super_admin() + khoá
// chương trình + proof MỚI NHẤT + open_set_hash + idem). KHÔNG có "nhận số mới" / ACCEPT_NEW: xác nhận chỉ ghi vết phục hồi khi nguồn đã
// khớp lại baseline cũ — không đổi tiền, fp, baseline, pointer.

import type { CmsAdminAccessLike, CmsRpcError } from './lockAction'

export interface CmsConfirmRestoredDeps {
  enabled(): boolean
  qaReadonly(): boolean
  access(): Promise<CmsAdminAccessLike>
  program(id: string): Promise<{ isTest: boolean } | null>
  /** SESSION client (authenticated) — không service role. */
  rpc(fn: 'rpc_cms_return_conflicts_confirm_restored', args: Record<string, unknown>): Promise<{ data: unknown; error: CmsRpcError | null }>
}

export type CmsConfirmRestoredResult =
  | { ok: true; already: boolean; restorationId: string; conflicts: number; proofEvalSeq: number }
  | { ok: false; code: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX_RE = /^[0-9a-f]{64}$/
// Cùng luật RPC: lý do 10–1000 ký tự sau trim, không ký tự điều khiển.
const CTRL_RE = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/

/** Mã RPC ⇒ mã app (thông báo ở UI). Không lộ message thô. */
export function cmsConfirmRpcCode(e: CmsRpcError | null | undefined): string {
  const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(e?.message ?? ''))
  switch (m?.[0]) {
    case 'CMS_RETURN_OPEN_SET_STALE': return 'STALE'
    case 'CMS_RETURN_PROOF_NOT_LATEST': case 'CMS_RETURN_PROOF_STALE': case 'CMS_RETURN_PROOF_NOT_MATCH': return 'PROOF_INVALID'
    case 'CMS_RETURN_NO_OPEN_CONFLICT': return 'NO_OPEN_CONFLICT'
    case 'CMS_IDEM_REUSED': return 'IDEM_REUSED'
    case 'CMS_RETURN_CONFIRM_FORBIDDEN': return 'FORBIDDEN'
    case 'CMS_RETURN_CONFIRM_BAD_INPUT': return 'BAD_INPUT'
    case 'CMS_PROGRAM_NOT_FOUND': return 'NOT_FOUND'
    default: break
  }
  const c = String(e?.code ?? '')
  if (c === '55P03') return 'BUSY'
  if (/^PGRST[1-3][0-9]{2}$/.test(c)) return 'QUERY_FAILED'
  // Không rõ đã commit chưa (timeout / đứt kết nối) ⇒ tải lại để thấy trạng thái thật; gửi lại cùng idem là an toàn.
  if (c === '' || c === '57014' || /^57P/.test(c) || /^08/.test(c)) return 'UNKNOWN_OUTCOME'
  return 'QUERY_FAILED'
}

export const CMS_CONFIRM_CODE_LABEL: Record<string, string> = {
  RETURNS_DISABLED: 'Pipeline trả hàng đang tắt.',
  QA_SERVER_READONLY: 'Server QA chỉ đọc.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết.', FORBIDDEN: 'Chỉ super admin được xác nhận.', UNAVAILABLE: 'Không kiểm được quyền — thử lại.',
  BAD_INPUT: 'Lý do cần 10–1.000 ký tự, không ký tự điều khiển.', NOT_FOUND: 'Không tìm thấy chương trình.',
  STALE: 'Danh sách conflict vừa đổi — tải lại trang rồi xác nhận lại.',
  PROOF_INVALID: 'Bằng chứng không còn là lần kiểm mới nhất / còn phiếu lệch — chờ lần kiểm tiếp theo.',
  NO_OPEN_CONFLICT: 'Không còn conflict mở.', IDEM_REUSED: 'Yêu cầu trùng khoá với nội dung khác — tải lại trang.',
  BUSY: 'Chương trình đang được xử lý — thử lại sau ít phút.', UNKNOWN_OUTCOME: 'Chưa rõ kết quả — tải lại trang để kiểm.',
  QUERY_FAILED: 'Không xác nhận được — thử lại.',
}

export async function runCmsConfirmRestored(deps: CmsConfirmRestoredDeps, input: unknown): Promise<CmsConfirmRestoredResult> {
  if (!deps.enabled()) return { ok: false, code: 'RETURNS_DISABLED' }
  if (deps.qaReadonly()) return { ok: false, code: 'QA_SERVER_READONLY' }
  let a: CmsAdminAccessLike
  try { a = await deps.access() } catch { return { ok: false, code: 'UNAVAILABLE' } }
  if (a.kind === 'anonymous') return { ok: false, code: 'UNAUTHENTICATED' }
  if (a.kind === 'forbidden') return { ok: false, code: 'FORBIDDEN' }
  if (a.kind !== 'ok') return { ok: false, code: 'UNAVAILABLE' }
  if (typeof input !== 'object' || input === null) return { ok: false, code: 'BAD_INPUT' }
  const i = input as Record<string, unknown>
  const programId = i.programId, hash = i.openSetHash, seq = i.proofEvalSeq, idem = i.idem, reason = i.reason
  if (typeof programId !== 'string' || !UUID_RE.test(programId) || typeof hash !== 'string' || !HEX_RE.test(hash)
      || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || typeof idem !== 'string' || !UUID_RE.test(idem)
      || typeof reason !== 'string' || CTRL_RE.test(reason)) {
    return { ok: false, code: 'BAD_INPUT' }
  }
  const r = reason.trim()
  // Đếm theo code point như SQL char_length (emoji / ký tự ngoài BMP = 1) — db-reviewer 14/11 P2-8.
  const cp = [...r].length
  if (cp < 10 || cp > 1000) return { ok: false, code: 'BAD_INPUT' }
  let p: { isTest: boolean } | null
  try { p = await deps.program(programId) } catch { return { ok: false, code: 'QUERY_FAILED' } }
  if (!p || (p.isTest && !a.qa)) return { ok: false, code: 'NOT_FOUND' }
  let res: { data: unknown; error: CmsRpcError | null }
  try {
    res = await deps.rpc('rpc_cms_return_conflicts_confirm_restored', {
      p_program_id: programId, p_expected_open_set_hash: hash, p_proof_eval_seq: seq, p_reason: r, p_idem: idem,
    })
  } catch {
    return { ok: false, code: 'UNKNOWN_OUTCOME' }
  }
  if (res.error) return { ok: false, code: cmsConfirmRpcCode(res.error) }
  const d = res.data as Record<string, unknown> | null
  if (!d || d.confirmed !== true || typeof d.id !== 'string' || typeof d.conflicts !== 'number' || typeof d.proof_eval_seq !== 'number') {
    return { ok: false, code: 'UNKNOWN_OUTCOME' }
  }
  return { ok: true, already: d.already === true, restorationId: d.id, conflicts: d.conflicts, proofEvalSeq: d.proof_eval_seq }
}
