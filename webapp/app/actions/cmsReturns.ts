'use server'

import { revalidatePath } from 'next/cache'
import { cmsConfirmRestoredDeps } from '@/lib/cms/server/returnsLoad'
import { runCmsConfirmRestored, type CmsConfirmRestoredResult } from '@/lib/cms/returnsConflictAction'
import { runCmsManualCloseReport, type CmsManualReportResult } from '@/lib/cms/returnsAfterClose'
import { cmsManualCloseReportDeps } from '@/lib/cms/server/returnsAfterCloseDeps'

// CMS-CALC-RET-2 P5.5 — super xác nhận nguồn trả hàng đã phục hồi đúng baseline (lõi lib/cms/returnsConflictAction; RPC 130 kiểm lại
// proof mới nhất / open_set_hash / idem dưới khoá chương trình). Không có hành động "nhận số mới".

export async function confirmCmsReturnsRestored(input: unknown): Promise<CmsConfirmRestoredResult> {
  const r = await runCmsConfirmRestored(cmsConfirmRestoredDeps, input)
  if (r.ok || r.code === 'UNKNOWN_OUTCOME') {
    try { revalidatePath('/targets/campaigns/cms', 'layout') } catch { console.error('[cms-returns] revalidatePath FAILED_AFTER_CONFIRM') }
  }
  return r
}

// Q-233 đường thủ công ngày 31 — super lập báo cáo trả sau chốt cho MỘT chương trình bằng PHIÊN của chính mình (PM 18/11 audit r0
// P1-04): actor = auth.uid() ở DB, lý do + khoá yêu cầu lưu cùng báo cáo. Không có đường Bearer + UUID khai báo. Log chỉ mã + id.
export async function runCmsManualCloseReportAction(input: unknown): Promise<CmsManualReportResult> {
  const r = await runCmsManualCloseReport(cmsManualCloseReportDeps(), input)
  // security-reviewer r1 P2-1: input chưa xác thực (endpoint action công khai) ⇒ chỉ ghi programId khi đúng dạng UUID (chống chèn dòng log).
  const raw = typeof input === 'object' && input !== null ? (input as { programId?: unknown }).programId : null
  const pid = typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw) ? raw : '-'
  console.warn(`[cms-returns-after-close manual] ok=${r.ok} ${r.ok ? `status=${r.status} report=${r.reportId ?? '-'}` : `code=${r.code}`} program=${pid}`)
  if (r.ok) {
    try { revalidatePath('/targets/campaigns/cms', 'layout') } catch { console.error('[cms-returns] revalidatePath FAILED_AFTER_MANUAL_REPORT') }
  }
  return r
}
