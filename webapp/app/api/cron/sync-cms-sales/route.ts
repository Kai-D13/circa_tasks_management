import { NextRequest, NextResponse } from 'next/server'
import { cmsFlagsFromEnv } from '@/lib/cms/flags'
import { handleSyncCmsSales } from '@/lib/cms/cronSales'
import { cmsSalesSyncDeps } from '@/lib/cms/server/salesSyncDeps'

// GET /api/cron/sync-cms-sales — đồng bộ bán + tính + công bố CMS theo chương trình (kế hoạch PM 02/11 §5; SPEC §6, §9).
// Bearer CRON_SECRET; CMS_PROGRAM_ENABLED hoặc CMS_EARNINGS_ENABLED tắt ⇒ 503, 0 query nguồn. Coolify Scheduled Task chỉ
// tạo ở cửa sổ phát hành gộp theo lệnh operator (lịch UTC đề xuất SPEC §9). Chương trình thật: CMS tạm tính theo dòng bán
// (cổng SALES_ONLY_V1 — lib/cms/releaseGate.ts + migration 126); có dòng âm / điều chỉnh ⇒ held RETURNS_NOT_SUPPORTED_THIS_PHASE
// (trả hàng phase sau). Response / log: số đếm + mã, không số tiền / email.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const flags = cmsFlagsFromEnv(process.env)
  const r = await handleSyncCmsSales({
    authorization: request.headers.get('authorization'),
    cronSecret: process.env.CRON_SECRET,
    programEnabled: flags.program,
    earningsEnabled: flags.earnings,
    makeDeps: () => cmsSalesSyncDeps(),
  })
  if (r.status !== 401) {
    const b = r.body as { status?: string; code?: string; programs?: number; pending?: string[]; warnings?: string[]; elapsedMs?: number
      results?: Array<{ status: string; code: string | null }> }
    const counts = (b.results ?? []).reduce<Record<string, number>>((m, x) => { m[x.status] = (m[x.status] ?? 0) + 1; return m }, {})
    const codes = [...new Set((b.results ?? []).map((x) => x.code).filter(Boolean))].join(',') || '-'
    console.warn(`[sync-cms-sales] http=${r.status} status=${b.status ?? '-'} code=${b.code ?? '-'} programs=${b.programs ?? '-'}`
      + ` pending=${b.pending?.length ?? '-'} by_status=${JSON.stringify(counts)} codes=${codes}`
      + ` warnings=${b.warnings?.join(',') || '-'} ms=${b.elapsedMs ?? '-'}`)
  }
  return NextResponse.json(r.body, { status: r.status, headers: { 'Cache-Control': 'no-store' } })
}
