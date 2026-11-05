// CMS P3a r2 (PM r1 PKG-P1-3) — luồng xử lý của hộp "Chốt kỳ" phía trình duyệt, tách khỏi React để test được ranh giới
// browser → Server Action. Server Action có thể REJECT (mất kết nối, RSC lỗi, server khởi động lại) SAU khi server đã commit
// ⇒ không bao giờ kết luận "chưa chốt" từ một lần gọi không có phản hồi:
//   · chốt: reject / UNKNOWN_OUTCOME ⇒ `unknown` (đóng hộp, báo chưa xác định, làm mới trang, KHOÁ nút tới khi kiểm tra lại
//     thành công — không tự gửi lại);
//   · run / quy tắc / mapping đổi (RECHECK) ⇒ tải preview mới; tải lỗi / reject ⇒ `stale` (nút khoá, không giữ trạng thái sẵn
//     sàng giả);
//   · mã khác ⇒ lỗi xác định (DB từ chối / cổng) — giữ hộp mở với câu lỗi;
//   · "Kiểm tra lại": lỗi / reject ⇒ lỗi đọc + stale.
// Không fallback / bypass: chỉ ánh xạ kết quả action sang trạng thái UI.

import type { CmsLockPreviewResult, CmsLockResult } from './lockAction'
import { cmsLockActionLabel, cmsLockCodeLabel, type CmsLockPreviewDto } from './payoutView'

// 124: chứng nhận đổi / không còn khớp giữa preview và chốt ⇒ cũng phải tải preview mới (không giữ trạng thái sẵn sàng cũ).
export const CMS_LOCK_RECHECK_CODES: ReadonlySet<string> = new Set(['CMS_LOCK_RUN_CHANGED', 'CMS_LOCK_POLICY_CHANGED', 'CMS_LOCK_STALE_MAPPING', 'CMS_LOCK_STALE_RUN',
  'CMS_LOCK_EVIDENCE_CHANGED', 'CMS_LOCK_ATTEST_INVALID'])

export interface CmsLockIo {
  lock(input: { programId: string; expectedRunId: string; expectedPolicyVersion: number; ackReason: string | null; expectedAttestationId?: string | null }): Promise<CmsLockResult>
  preview(programId: string): Promise<CmsLockPreviewResult>
}

export type CmsLockReload = { preview: CmsLockPreviewDto; error: null } | { preview: null; error: string }

export type CmsLockUiOutcome =
  | { kind: 'locked'; already: boolean }
  | { kind: 'unknown'; notice: string }
  | { kind: 'recheck'; notice: string; reload: CmsLockReload }
  | { kind: 'error'; error: string }

/** "Kiểm tra lại" / tải preview sau RECHECK: lỗi hoặc Promise reject ⇒ không có preview (UI phải khoá nút chốt). */
export async function cmsLockReloadFlow(io: Pick<CmsLockIo, 'preview'>, programId: string): Promise<CmsLockReload> {
  try {
    const r = await io.preview(programId)
    return r.ok ? { preview: r.preview, error: null } : { preview: null, error: cmsLockActionLabel(r.code) }
  } catch {
    return { preview: null, error: cmsLockActionLabel('QUERY_FAILED') }
  }
}

/** Xác nhận chốt: mọi đường đều trả kết quả (không ném) — reject của Server Action ⇒ `unknown`, không bao giờ "chưa chốt". */
export async function cmsLockConfirmFlow(io: CmsLockIo, input: Parameters<CmsLockIo['lock']>[0]): Promise<CmsLockUiOutcome> {
  let r: CmsLockResult
  try {
    r = await io.lock(input)
  } catch {
    return { kind: 'unknown', notice: cmsLockActionLabel('UNKNOWN_OUTCOME') }
  }
  if (r.ok) return { kind: 'locked', already: r.already }
  if (r.code === 'UNKNOWN_OUTCOME') return { kind: 'unknown', notice: cmsLockActionLabel('UNKNOWN_OUTCOME') }
  if (CMS_LOCK_RECHECK_CODES.has(r.code)) {
    return { kind: 'recheck', notice: cmsLockCodeLabel(r.code), reload: await cmsLockReloadFlow(io, input.programId) }
  }
  return { kind: 'error', error: cmsLockActionLabel(r.code) }
}
