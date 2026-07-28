import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { syncCampaign } from '@/lib/kpi/actuals'
import { runSyncBatch, shouldRevalidateAfterBatch } from '@/lib/kpi/syncBatch'
import { sanitizeOpsText } from '@/lib/ops/sanitize'

// GET /api/cron/sync-kpi-campaign-actuals — KPI Campaign actual-GMV sync.
// 1. Auto-transition: active campaigns past end_date → 'ended'.
// 2. Sync actuals for every ACTIVE campaign + campaigns ended within the last
//    3 days (locks in the final numbers).
// Bearer CRON_SECRET. Coolify Scheduled Task "Sync KPI campaign actuals"
// (`0 */2 * * *`, same cadence as Pull KPI targets) — add at final deploy.

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isKpiCampaignEnabled()) {
    return NextResponse.json({ error: 'KPI Campaign chưa được bật (KPI_CAMPAIGN_ENABLED)' }, { status: 503 })
  }

  try {
    const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)

    // Auto-end past-due campaigns (has WHERE → pg_safeupdate-safe).
    const { data: endedRows, error: endErr } = await supabaseAdmin
      .from('kpi_campaigns')
      .update({ status: 'ended', updated_at: new Date().toISOString() })
      .eq('status', 'active')
      .lt('end_date', vnTodayISO)
      .select('id')
    if (endErr) console.error('[sync-kpi-campaign] auto-end failed:', sanitizeOpsText(endErr.message))

    // Active + recently-ended (≤3 days) campaigns to sync. Archive (098):
    // ended-đã-lưu-trữ trong cửa sổ 3 ngày cũng bị loại — archived đóng băng.
    const cutoff = new Date(Date.parse(vnTodayISO) - 3 * 86400_000).toISOString().slice(0, 10)
    const { data: campaigns, error: cErr } = await supabaseAdmin
      .from('kpi_campaigns')
      .select('id, name')
      .or(`status.eq.active,and(status.eq.ended,end_date.gte.${cutoff})`)
      .is('archived_at', null)
    if (cErr) return NextResponse.json({ error: sanitizeOpsText(cErr.message) }, { status: 500 })

    // P3-C: toàn bộ contract batch (200/207/500 + body + log lines) nằm trong
    // runSyncBatch THUẦN (lib/kpi/syncBatch.ts — có test riêng); route chỉ IO.
    // Một campaign preserve/failed không chặn campaign kế; offline-only vẫn
    // sync khi nguồn affiliate stale.
    const outcome = await runSyncBatch(campaigns ?? [], syncCampaign)
    for (const line of outcome.logLines) console.warn(line)

    // Revalidate khi có snapshot MỚI hoặc có campaign vừa auto-end (DB đã đổi
    // status dù sync bị preserve/fail — audit r1 P2).
    if (shouldRevalidateAfterBatch(outcome.anySuccess, (endedRows ?? []).length)) {
      revalidatePath('/targets')
      revalidatePath('/targets/campaigns')
    }
    return NextResponse.json(
      { ...outcome.body, endedTransitioned: (endedRows ?? []).length },
      { status: outcome.httpStatus },
    )
  } catch (err) {
    // Outer catch cũng phải sanitize — exception driver có thể chứa URI/token.
    const msg = sanitizeOpsText(err instanceof Error ? err.message : String(err))
    const status = msg.includes('BigQuery') || msg.includes('Google token') ? 502 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
