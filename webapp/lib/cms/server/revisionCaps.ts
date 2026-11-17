import 'server-only'
import { cache } from 'react'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isCmsProgramEnabled, isCmsProgramRevisionEnabled } from '@/lib/cms/flags'
import { cmsRevisionGate, parseCmsRevisionCapabilities, type CmsRevisionCapState } from '@/lib/cms/revision/model'

// F-A — năng lực DB 131 (rpc_cms_revision_capabilities, chỉ service_role). Bốn trạng thái, không đoán:
//   'absent'      DB chưa có 131 (PGRST202 / 42883) ⇒ tính năng ẩn; app không đọc cột retired_at (chưa tồn tại).
//   'ok'          đúng version + đủ 6 RPC + ACL authenticated / không anon + cột retired_at.
//   'mismatch'    hàm có nhưng phản hồi lệch ⇒ tính năng ẩn (fail-closed), không lọc retired_at.
//   'unavailable' lỗi mạng / quyền ⇒ như mismatch; chỉ nhớ 10 s.
// Nhớ 60 s theo tiến trình cho kết quả xác định (cùng mẫu capabilities.ts 130). 'unavailable' nhớ ngắn (security-review 17/11 P2: route
// gọi probe trước kiểm đăng nhập để cờ OFF / DB chưa 131 luôn 404 ⇒ request lặp không được kéo theo mỗi lần một RPC service_role).

export type { CmsRevisionCapState }

const MISSING_FN = new Set(['PGRST202', '42883'])
const TTL_MS = 60_000
const TTL_UNAVAILABLE_MS = 10_000
let memo: { at: number; v: CmsRevisionCapState } | null = null

async function probe(): Promise<CmsRevisionCapState> {
  try {
    const { data, error } = await supabaseAdmin.rpc('rpc_cms_revision_capabilities')
    if (error) return MISSING_FN.has(String(error.code ?? '')) ? 'absent' : 'unavailable'
    return parseCmsRevisionCapabilities(data) ? 'ok' : 'mismatch'
  } catch {
    return 'unavailable'
  }
}

export const getCmsRevisionCapState = cache(async (): Promise<CmsRevisionCapState> => {
  const now = Date.now()
  if (memo && now - memo.at < (memo.v === 'unavailable' ? TTL_UNAVAILABLE_MS : TTL_MS)) return memo.v
  const v = await probe()
  memo = { at: now, v }
  return v
})

const flagEnv = () => ({ program: isCmsProgramEnabled(), revision: isCmsProgramRevisionEnabled() })

/** Cổng GHI (preview / commit / trang sửa / nút sửa): cờ app CMS_PROGRAM_REVISION_ENABLED + DB 131 đủ năng lực. Cờ OFF ⇒ không gọi probe. */
export function cmsRevisionEnabled(): Promise<boolean> {
  return cmsRevisionGate('write', flagEnv(), getCmsRevisionCapState)
}

/** r3 (PM P1-02) — cổng ĐỌC lịch sử đã có (trang /revisions, link Lịch sử sửa, trạng thái che số): module CMS bật + DB 131 đủ năng lực,
 *  KHÔNG phụ thuộc cờ ghi (runbook B5 tắt cờ ghi sau sự cố vẫn phải điều tra được). DB 130 ⇒ probe 'absent' ⇒ false, không gọi RPC /
 *  cột 131. Người gọi tự kiểm super (canManageCms) TRƯỚC khi gọi; RPC 131 kiểm super lại ở DB. */
export function cmsRevisionReadable(): Promise<boolean> {
  return cmsRevisionGate('read', flagEnv(), getCmsRevisionCapState)
}
