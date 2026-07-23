import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { syncCampaign } from '@/lib/kpi/actuals'

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

    // P3-B/C contract: engine tự đọc cấu hình theo id; response phân biệt
    // success / snapshot_preserved / failed. Offline-only campaign vẫn sync
    // bình thường khi nguồn affiliate stale (độc lập từng campaign).
    let upserted = 0
    const errors: string[] = []
    const unmatched: string[] = []
    const preserved: { campaign: string; reason: string }[] = []
    for (const c of campaigns ?? []) {
      const r = await syncCampaign(c.id)
      if (r.status === 'failed') {
        errors.push(`${c.name ?? c.id}: ${r.error}`)
      } else if (r.status === 'snapshot_preserved') {
        // Log rõ campaign + lý do giữ snapshot (audit P3-C) — không phải lỗi.
        console.warn(`[sync-kpi-campaign] snapshot_preserved campaign=${c.id} (${c.name}):`, r.reason)
        preserved.push({ campaign: c.name ?? c.id, reason: r.reason })
      } else {
        upserted += r.upserted
        unmatched.push(...r.unmatched)
      }
    }

    revalidatePath('/targets')
    revalidatePath('/targets/campaigns')
    // HTTP: lỗi thật → 500; có snapshot_preserved → 207; sạch → 200.
    return NextResponse.json({
      ok: errors.length === 0,
      campaigns: (campaigns ?? []).length,
      upserted,
      endedTransitioned: (endedRows ?? []).length,
      unmatched: [...new Set(unmatched)],
      preserved,
      errors,
    }, { status: errors.length ? 500 : preserved.length ? 207 : 200 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = msg.includes('BigQuery') || msg.includes('Google token') ? 502 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
