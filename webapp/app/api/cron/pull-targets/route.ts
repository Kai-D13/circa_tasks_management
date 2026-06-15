import { NextRequest, NextResponse } from 'next/server'
import { normalizeRow, type TargetRow } from '@/lib/targets/parse'
import { upsertTargetRows } from '@/lib/targets/ingest'
import { DEFAULT_QUERY, loadServiceAccount, runBigQuery } from '@/lib/targets/bigquery'

// GET /api/cron/pull-targets — pulls weekly KPI rows from BigQuery
// (buymed_n8n.fact_kpi_circa_weekly) and upserts store_weekly_targets.
// (This replaced the abandoned Power BI service-principal pull on 2026-06-13.)
//
// NOTE (2026-06-15): staff + super-admin /targets now read BigQuery LIVE
// (lib/targets/bigquery.ts getWeeklyTargetsLive, cached 1h), so this cron is no
// longer required for reads. It's kept harmless to keep store_weekly_targets
// warm for the manual-upload fallback; the Coolify schedule can be disabled.
//
// Column mapping (BQ → store_weekly_targets):
//   monday_of_week → week_start        pos_code → stores.code (exact match)
//   gmv → actual                       target → target
//   weekly_target → min_weekly_target  kpi_pct → run_rate (fraction, vs MIN)

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
    const rawRows = await runBigQuery(sa, process.env.BQ_QUERY || DEFAULT_QUERY)
    if (rawRows.length === 0) {
      return NextResponse.json({ error: 'Query returned 0 rows' }, { status: 422 })
    }

    const rows: TargetRow[] = []
    const rowErrors: string[] = []
    for (const raw of rawRows) {
      // kpi_pct is a fraction vs the MIN target; the normalizer's scale check
      // converts it to percent.
      const r = normalizeRow(raw, { runRateIsFraction: true })
      if ('error' in r) rowErrors.push(r.error)
      else rows.push(r)
    }
    if (rows.length === 0) {
      return NextResponse.json({ error: 'No valid rows after normalize', rowErrors }, { status: 422 })
    }

    const { upserted, unmatched, duplicates } = await upsertTargetRows(rows, 'api', null)
    return NextResponse.json({ ok: true, pulled: rawRows.length, upserted, unmatched, duplicates, rowErrors })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // BQ query/token errors surface as 502; everything else 500.
    const status = msg.includes('BigQuery') || msg.includes('Google token') ? 502 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
