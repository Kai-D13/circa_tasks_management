import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { KPI_AGGREGATE_QUERY, loadServiceAccount, runBigQuery } from '@/lib/targets/bigquery'
import { aggregateAndUpsertKpi } from '@/lib/targets/kpi'

// GET /api/cron/pull-kpi-targets — KPI v2 landing (day/month; week chờ BI).
// BQ-V2 (05/08) + 112 (04/09): nguồn buymed_tech.tech__circa_os_gmv_kpi
// pre-aggregated — actual = offline_net_revenue (cột net_revenue cũ đã bị BI
// xoá), target = cột TARGET; upsert store_kpi_targets (067).
//
// r2 (audit P1#1+#2) — ATOMIC GATE: aggregateAndUpsertKpi chỉ ghi khi ĐỦ
// coverage (mỗi active OS store đúng 1 row DAY + 1 row MONTH) và KHÔNG có
// duplicate/unmatched/rowError. Bất kỳ sai lệch nào → 0 write + HTTP 422 với
// chi tiết {missing, duplicates, unmatched, rowErrors} — Coolify đỏ thay vì
// "cron xanh một phần". WEEK vắng dữ liệu KHÔNG phải lỗi (grain chưa bật).
//
// r2 (audit P2#4): BỎ override env BQ_KPI_QUERY — query là contract
// version-control bằng Git (nhất quán quyết định 30/07); env cũ nếu còn trên
// Coolify sẽ bị bỏ qua.

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
    const rawRows = await runBigQuery(sa, KPI_AGGREGATE_QUERY)
    if (rawRows.length === 0) {
      return NextResponse.json({ error: 'Query returned 0 rows' }, { status: 422 })
    }
    // ~52 expected (26 store × 2 grain); a flood means the query lost its grain.
    if (rawRows.length >= 1000) {
      console.warn(`[pull-kpi-targets] unexpected ${rawRows.length} rows (>=1000) — check query grain / maxResults cap`)
    }

    const result = await aggregateAndUpsertKpi(rawRows)
    if (!result.ok) {
      // Fail-closed toàn phần — không có row nào được ghi.
      return NextResponse.json(
        {
          error: 'Nguồn KPI không đủ/không sạch — KHÔNG ghi row nào (atomic gate)',
          missing: result.missing,
          duplicates: result.duplicates,
          unmatched: result.unmatched,
          rowErrors: result.rowErrors,
        },
        { status: 422 },
      )
    }

    revalidatePath('/targets')
    return NextResponse.json({
      ok: true,
      pulled: rawRows.length,
      upserted: result.upserted,
      periods: result.periods,
      unmatched: result.unmatched,
      rowErrors: result.rowErrors,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // BQ query/token errors surface as 502; everything else 500.
    const status = msg.includes('BigQuery') || msg.includes('Google token') ? 502 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
