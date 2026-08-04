import 'server-only'
import { getAccessToken, loadServiceAccount as loadSA, type ServiceAccount } from '@/lib/google/auth'

// BigQuery client for the weekly-targets feed
// (buymed_tech.tech__fact_kpi_circa_weekly). Used by the cron pull route
// (/api/cron/pull-targets) which upserts store_weekly_targets. Google auth
// (JWT→token) lives in lib/google/auth (shared with GCS). All fetches carry
// timeouts so a hung Google endpoint can never hold a handler open (the
// lag-investigation lesson).
//
// Required env (Coolify):
//   BQ_SERVICE_ACCOUNT_KEY — service-account JSON (raw or base64). The SA's
//     project_id is the billing project for the query (lakehouse-prod-394907);
//     it needs BigQuery Job User on the project + Data Viewer on buymed_tech.
//   BQ_QUERY (optional)    — override of DEFAULT_QUERY.
//
// Source moved 2026-06-23: SA buymed-tech-bigquery@lakehouse-prod-394907 +
// dataset buymed_tech (was buymed_n8n.fact_kpi_circa_weekly).

const BQ_SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly'

// ORDER BY monday_of_week DESC guarantees the latest week is within the
// maxResults cap even if the fact table accumulates history (no page-token
// handling). At this scale (~30 stores/week) the most recent weeks come first.
export const DEFAULT_QUERY = `
  SELECT monday_of_week, pos_code, pos_name, gmv, target, weekly_target, kpi_pct
  FROM \`lakehouse-prod-394907.buymed_tech.tech__fact_kpi_circa_weekly\`
  WHERE pos_code NOT IN ("POS0001")
  ORDER BY monday_of_week DESC
`

// KPI v2 — aggregate the THREE current periods (day/week/month) per store IN
// BigQuery so the cron pulls ~78 rows (26 stores × 3 grains), well under the
// 1000-row maxResults cap (runBigQuery has no page-token handling). Used by
// /api/cron/pull-kpi-targets → store_kpi_targets (migration 067).
//
// Source: lakehouse-prod-394907.buymed_tech.tech__circa_os_gmv_kpi (DAILY).
//   month/week/date DATE, pos_code/pos_name STRING, gmv/final_target FLOAT.
//
// Why this shape (verified from the BI sample 2026-06-26):
//  * The `week` column ALREADY encodes the business-week incl. the month-end
//    merge (22/06–30/06 all map to week 2026-06-22) — group by it, don't
//    recompute. current_week = MAX(week) among rows with date <= today, which is
//    robust to today's row not having landed yet (a recent past day still
//    carries the current week's value).
//  * The table holds FUTURE-dated rows with final_target pre-set, so summing by
//    week/month naturally gives the WHOLE-period target; period_end = MAX(date).
//  * `date`/`month`/`week` are backticked (column names that collide with BQ
//    date keywords).
//  * base is windowed to [current-month-start − 7 days, current-month-end] so BQ
//    scans a slice, not the whole table. The −7 day tail covers a current week
//    that leads in from the prior month (a month starting mid-week); the table's
//    future-dated rows up to month-end keep week/month targets whole.
// ⚠ Landing day/week/month GIỮ NGUYÊN nguồn `gmv` — contract 30/07 CHỈ chuyển
//   CAMPAIGN (2 hàm campaign*Query bên dưới) sang net_revenue; query này KHÔNG đổi.
export const KPI_AGGREGATE_QUERY = `
  WITH today AS (SELECT CURRENT_DATE("Asia/Ho_Chi_Minh") AS d),
  base AS (
    SELECT \`month\`, \`week\`, \`date\`, pos_code, pos_name, gmv, final_target
    FROM \`lakehouse-prod-394907.buymed_tech.tech__circa_os_gmv_kpi\`, today
    WHERE pos_code NOT IN ("POS0001")
      AND \`date\` BETWEEN DATE_SUB(DATE_TRUNC(today.d, MONTH), INTERVAL 7 DAY)
                     AND LAST_DAY(today.d)
  ),
  current_week AS (
    SELECT MAX(\`week\`) AS week_start FROM base, today WHERE \`date\` <= today.d
  ),
  current_month AS (SELECT DATE_TRUNC(d, MONTH) AS month_start FROM today)
  SELECT 'day' AS period_type, \`date\` AS period_start, \`date\` AS period_end,
         pos_code, pos_name, SUM(gmv) AS actual, SUM(final_target) AS target,
         COUNT(*) AS raw_row_count
  FROM base, today
  WHERE \`date\` = today.d
  GROUP BY \`date\`, pos_code, pos_name
  UNION ALL
  SELECT 'week' AS period_type, \`week\` AS period_start, MAX(\`date\`) AS period_end,
         pos_code, pos_name, SUM(gmv) AS actual, SUM(final_target) AS target,
         COUNT(*) AS raw_row_count
  FROM base
  WHERE \`week\` = (SELECT week_start FROM current_week)
  GROUP BY \`week\`, pos_code, pos_name
  UNION ALL
  SELECT 'month' AS period_type, \`month\` AS period_start, MAX(\`date\`) AS period_end,
         pos_code, pos_name, SUM(gmv) AS actual, SUM(final_target) AS target,
         COUNT(*) AS raw_row_count
  FROM base
  WHERE \`month\` = (SELECT month_start FROM current_month)
  GROUP BY \`month\`, pos_code, pos_name
  ORDER BY period_type, pos_code
`

// No-arg wrapper preserved for the cron route — reads BQ_SERVICE_ACCOUNT_KEY.
export function loadServiceAccount(): ServiceAccount | null {
  return loadSA('BQ_SERVICE_ACCOUNT_KEY')
}

// KPI Campaign OFFLINE actual over an arbitrary date range (campaign start→end).
// ⚠ NGUỒN = NET_REVENUE (contract stakeholder 30/07 — chuyển toàn cục từ gmv;
// không có campaign active lúc chuyển; campaign ended/archived giữ snapshot cũ).
// Alias GIỮ NGUYÊN `actual_gmv` để downstream (engine/DB payload/UI/export)
// không đổi — từ đây "gmv" trong pipeline campaign NGHĨA LÀ Net Revenue Offline.
// runBigQuery has no query-parameter support, so the dates are interpolated —
// both values come from DB `date` columns; the regex guard makes injection
// impossible even if a caller passes something else. Future days have
// net_revenue NULL → COALESCE 0, so a running campaign naturally sums only
// realized sales; giá trị ÂM giữ nguyên, cộng bình thường.
// ~26 stores → one row per pos_code, far under the 1000-row cap.
export function campaignRangeQuery(startDate: string, endDate: string): string {
  const ISO = /^\d{4}-\d{2}-\d{2}$/
  if (!ISO.test(startDate) || !ISO.test(endDate)) {
    throw new Error(`campaignRangeQuery: ngày không hợp lệ (${startDate} – ${endDate})`)
  }
  return `
    SELECT pos_code, SUM(COALESCE(net_revenue, 0)) AS actual_gmv, COUNT(*) AS row_count
    FROM \`lakehouse-prod-394907.buymed_tech.tech__circa_os_gmv_kpi\`
    WHERE pos_code NOT IN ("POS0001")
      AND \`date\` BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY pos_code
    ORDER BY pos_code
  `
}

// Per-DAY OFFLINE actual per store over a range — drives the staff "Tiến độ
// theo ngày" chart AND the aggregate snapshot (summed app-side so they always
// agree). ⚠ NGUỒN = NET_REVENUE (contract 30/07); alias GIỮ NGUYÊN `gmv` để
// downstream không đổi — cột `gmv` của kpi_campaign_store_daily_actuals từ
// đây chứa Net Revenue Offline.
// Caller must chunk long ranges by month: 26 stores × 31 days ≈ 806 rows per
// chunk, under the 1000-row cap; a 2-month range in one call would exceed it.
export function campaignDailyQuery(startDate: string, endDate: string): string {
  const ISO = /^\d{4}-\d{2}-\d{2}$/
  if (!ISO.test(startDate) || !ISO.test(endDate)) {
    throw new Error(`campaignDailyQuery: ngày không hợp lệ (${startDate} – ${endDate})`)
  }
  return `
    SELECT pos_code, \`date\`, SUM(COALESCE(net_revenue, 0)) AS gmv
    FROM \`lakehouse-prod-394907.buymed_tech.tech__circa_os_gmv_kpi\`
    WHERE pos_code NOT IN ("POS0001")
      AND \`date\` BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY pos_code, \`date\`
    ORDER BY pos_code, \`date\`
  `
}

// Runs a query and returns raw rows as { columnName: value } objects.
export async function runBigQuery(sa: ServiceAccount, sql: string): Promise<Record<string, unknown>[]> {
  const token = await getAccessToken(sa, BQ_SCOPE)
  const queryRes = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${sa.project_id}/queries`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30_000, maxResults: 1000 }),
      signal: AbortSignal.timeout(45_000),
    },
  )
  if (!queryRes.ok) {
    throw new Error(`BigQuery query failed (${queryRes.status}): ${(await queryRes.text()).slice(0, 300)}`)
  }
  const data = (await queryRes.json()) as {
    jobComplete?: boolean
    schema?: { fields?: { name: string }[] }
    rows?: { f: { v: unknown }[] }[]
  }
  if (!data.jobComplete) throw new Error('BigQuery job did not complete within 30s')
  const fields = (data.schema?.fields ?? []).map((f) => f.name)
  return (data.rows ?? []).map((r) =>
    Object.fromEntries(fields.map((name, i) => [name, r.f[i]?.v ?? null])),
  )
}
