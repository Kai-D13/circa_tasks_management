import { NextRequest, NextResponse } from 'next/server'
import { cmsCalcFlagsFromEnv } from '@/lib/cms/flags'
import { handleCmsReturnsAfterClose } from '@/lib/cms/returnsAfterClose'
import { cmsReturnsAfterCloseDeps } from '@/lib/cms/server/returnsAfterCloseDeps'

// GET /api/cron/cms-returns-after-close — báo cáo trả hàng SAU CHỐT cho chương trình CMS đã chốt (CMS-CALC-RET-2 P5.5; PM D11).
// Bearer CRON_SECRET. CMS_RETURNS_ENABLED (cùng CMS_PROGRAM + CMS_EARNINGS) OFF ⇒ 200 {status:'DISABLED'}, 0 query. Báo cáo KHÔNG phải
// lệnh thu / chi; lỗi nguồn / sổ lệch ⇒ held, không ghi. Coolify Scheduled Task CHƯA tạo — lịch UTC đề xuất chỉ ở runbook, tạo theo
// lệnh operator ở mốc B. Log: số đếm + mã, không email / tên / tiền.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const r = await handleCmsReturnsAfterClose({
    authorization: request.headers.get('authorization'),
    cronSecret: process.env.CRON_SECRET,
    returnsEnabled: cmsCalcFlagsFromEnv(process.env).returns,
    makeDeps: () => cmsReturnsAfterCloseDeps(),
  })
  if (r.status !== 401) {
    const b = r.body as { status?: string; code?: string; programs?: number; pending?: string[]; results?: Array<{ programId: string; status: string; code: string | null; refs?: string[] }> }
    const counts = (b.results ?? []).reduce<Record<string, number>>((m, x) => { m[x.status] = (m[x.status] ?? 0) + 1; return m }, {})
    const codes = [...new Set((b.results ?? []).map((x) => x.code).filter(Boolean))].join(',') || '-'
    console.warn(`[cms-returns-after-close] http=${r.status} status=${b.status ?? '-'} code=${b.code ?? '-'} programs=${b.programs ?? '-'}`
      + ` pending=${b.pending?.length ?? '-'} by_status=${JSON.stringify(counts)} codes=${codes}`
      // refs = ID kỹ thuật phiếu / dòng gốc DB nêu ở DETAIL (không PII), kèm chương trình: programId:ref, tối đa 20 / dòng log.
      + ((b.results ?? []).some((x) => x.refs?.length) ? ` refs=${(b.results ?? []).flatMap((x) => (x.refs ?? []).map((ref) => `${x.programId}:${ref}`)).slice(0, 20).join(',')}` : ''))
  }
  return NextResponse.json(r.body, { status: r.status, headers: { 'Cache-Control': 'no-store' } })
}
