'use server'

import { revalidatePath } from 'next/cache'
import { cmsConfirmRestoredDeps } from '@/lib/cms/server/returnsLoad'
import { runCmsConfirmRestored, type CmsConfirmRestoredResult } from '@/lib/cms/returnsConflictAction'

// CMS-CALC-RET-2 P5.5 — super xác nhận nguồn trả hàng đã phục hồi đúng baseline (lõi lib/cms/returnsConflictAction; RPC 130 kiểm lại
// proof mới nhất / open_set_hash / idem dưới khoá chương trình). Không có hành động "nhận số mới".

export async function confirmCmsReturnsRestored(input: unknown): Promise<CmsConfirmRestoredResult> {
  const r = await runCmsConfirmRestored(cmsConfirmRestoredDeps, input)
  if (r.ok || r.code === 'UNKNOWN_OUTCOME') {
    try { revalidatePath('/targets/campaigns/cms', 'layout') } catch { console.error('[cms-returns] revalidatePath FAILED_AFTER_CONFIRM') }
  }
  return r
}
