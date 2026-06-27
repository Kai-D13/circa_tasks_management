import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { KPI_AGGREGATE_QUERY, loadServiceAccount, runBigQuery } from '@/lib/targets/bigquery'
import { aggregateAndUpsertKpi } from '@/lib/targets/kpi'

// GET /api/cron/pull-kpi-targets — KPI v2. Pulls the three current periods
// (day/week/month) per store, pre-aggregated IN BigQuery
// (buymed_tech.tech__circa_os_gmv_kpi), and upserts store_kpi_targets
// (migration 067). The new daily source replaced the weekly table.
//
// ⚠ OPERATIONAL: this is a NEW route, run side-by-side with /api/cron/pull-targets
// (the old weekly feed → store_weekly_targets). Add a NEW Coolify Scheduled Task
// "Pull KPI targets (BigQuery)" hitting THIS route (e.g. `0 */2 * * *`) with the
// Bearer CRON_SECRET. Keep the OLD task + table running until KPI v2 is signed
// off (rollback path), then retire it.
//
// The aggregate query returns ~78 rows (26 stores × 3 grains) — well under the
// 1000-row maxResults cap, so no pagination concern.

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sa = loadServiceAccount()
  if (!sa) {
    return NextResponse.json(
      { error: 'Pull disabled — BQ_SERVICE_ACCOUNT_KEY chưa hợp lệ (cần client_email/private_key/project_id, raw JSON hoặc base64)' },
      { status: 503 },
    )
  }

  try {
    const rawRows = await runBigQuery(sa, process.env.BQ_KPI_QUERY || KPI_AGGREGATE_QUERY)
    if (rawRows.length === 0) {
      return NextResponse.json({ error: 'Query returned 0 rows' }, { status: 422 })
    }
    // ~78 expected; a flood means the query lost its grain — surface it.
    if (rawRows.length >= 1000) {
      console.warn(`[pull-kpi-targets] unexpected ${rawRows.length} rows (>=1000) — check query grain / maxResults cap`)
    }

    const { upserted, periods, unmatched, rowErrors } = await aggregateAndUpsertKpi(rawRows)
    if (upserted === 0) {
      return NextResponse.json({ error: 'No valid rows after aggregate', unmatched, rowErrors }, { status: 422 })
    }

    revalidatePath('/targets')
    return NextResponse.json({ ok: true, pulled: rawRows.length, upserted, periods, unmatched, rowErrors })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // BQ query/token errors surface as 502; everything else 500.
    const status = msg.includes('BigQuery') || msg.includes('Google token') ? 502 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
