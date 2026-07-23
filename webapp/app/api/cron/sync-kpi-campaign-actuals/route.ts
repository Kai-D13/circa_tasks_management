import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { syncCampaign } from '@/lib/kpi/actuals'
import { runSyncBatch } from '@/lib/kpi/syncBatch'

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
    if (endErr) console.error('[sync-kpi-campaign] auto-end failed:', endErr.message)

    // Active + recently-ended (≤3 days) campaigns to sync.
    const cutoff = new Date(Date.parse(vnTodayISO) - 3 * 86400_000).toISOString().slice(0, 10)
    const { data: campaigns, error: cErr } = await supabaseAdmin
      .from('kpi_campaigns')
      .select('id, name')
      .or(`status.eq.active,and(status.eq.ended,end_date.gte.${cutoff})`)
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })

    // P3-C: toàn bộ contract batch (200/207/500 + body + log lines) nằm trong
    // runSyncBatch THUẦN (lib/kpi/syncBatch.ts — có test riêng); route chỉ IO.
    // Một campaign preserve/failed không chặn campaign kế; offline-only vẫn
    // sync khi nguồn affiliate stale.
    const outcome = await runSyncBatch(campaigns ?? [], syncCampaign)
    for (const line of outcome.logLines) console.warn(line)

    // Chỉ revalidate khi có snapshot MỚI được ghi (preserved/failed giữ số cũ).
    if (outcome.anySuccess) {
      revalidatePath('/targets')
      revalidatePath('/targets/campaigns')
    }
    return NextResponse.json(
      { ...outcome.body, endedTransitioned: (endedRows ?? []).length },
      { status: outcome.httpStatus },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = msg.includes('BigQuery') || msg.includes('Google token') ? 502 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
