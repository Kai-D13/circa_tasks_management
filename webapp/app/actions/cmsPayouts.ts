'use server'

import { revalidatePath } from 'next/cache'
import { cmsLockDeps } from '@/lib/cms/server/payouts'
import { runCmsLock, runCmsLockPreview, type CmsLockPreviewResult, type CmsLockResult } from '@/lib/cms/lockAction'

// CMS P3a — chốt kỳ (SPEC §4.7 / blueprint P3 §2–§3). Lõi thuần ở lib/cms/lockAction (thứ tự cờ → super session → namespace QA →
// đầu vào → RPC 123 kiểm lại trong transaction). Preview luôn đọc lại DB (không tin số client); chốt gửi expected_run_id +
// policy_version từ preview vừa xem. Không có mở lại / huỷ chốt (H8).

export async function previewCmsLock(programId: unknown): Promise<CmsLockPreviewResult> {
  return runCmsLockPreview(cmsLockDeps, programId)
}

export async function lockCmsProgram(input: unknown): Promise<CmsLockResult> {
  const r = await runCmsLock(cmsLockDeps, input)
  // Chốt đã commit (kể cả already) ⇒ làm mới A1 / A3. Kết quả không rõ cũng làm mới để lần tải lại thấy trạng thái thật.
  // Làm mới cache lỗi SAU commit KHÔNG được biến kết quả đã chốt thành lỗi (PM r1 PKG-P1-3) — nuốt lỗi, trả nguyên r.
  if (r.ok || r.code === 'UNKNOWN_OUTCOME') {
    try { revalidatePath('/targets/campaigns/cms', 'layout') } catch { console.error('[cms-lock] revalidatePath FAILED_AFTER_LOCK') }
  }
  return r
}
