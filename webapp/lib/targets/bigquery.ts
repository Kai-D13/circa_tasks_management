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

// KPI v2 landing — the CURRENT periods per store for /targets day/week/month.
// Used by /api/cron/pull-kpi-targets → store_kpi_targets (migration 067);
// aggregateAndUpsertKpi (lib/targets/kpi.ts) reads the aliases as-is.
//
// ⚠ BQ-V2 r3 (06/08): nguồn = `buymed_tech.tech__circa_os_gmv_kpi` — BẢNG
// PRODUCTION đã mang SCHEMA V2 (BI đồng bộ 1-1 với mirror
// `gold_buymed_vn2.circa_os_gmv_kpi`; service account CHỈ có quyền dataset
// buymed_tech → trỏ gold_* là 403 → cron 502/207. KHÔNG đổi lại path nếu chưa
// đổi quyền SA). Pre-aggregated theo kỳ (1 row / date_type / start_date /
// pos): actual = offline_net_revenue (BI tách Offline/Affiliate 09/2026 —
// cột `net_revenue` cũ đã BỊ XOÁ), target = cột TARGET.
// ⚠ Landing CHỈ lấy Offline: cộng thêm Affiliate là đổi Ý NGHĨA của màn này,
// stakeholder chưa yêu cầu (contract 04/09 điểm 1-2; WEEK vẫn KHÔNG bật).
// KHÔNG lọc NULL trong WHERE (112.3, audit P1#2): lọc trước GROUP BY thì một
// khoá có 1 row hợp lệ + 1 row NULL vẫn ra raw_row_count=1 và trôi qua như dữ
// liệu sạch. Giữ row NULL đến bước aggregate rồi để kpiPlan quyết theo counter.
// Cũng KHÔNG dùng COALESCE(...,0) ở SQL — mất thông tin trước khi app kịp
// phân biệt "không phát sinh giao dịch" với "nguồn hỏng".
// ⚠ Contract A+ (112.4) cần ĐỦ CẶP counter: doanh thu và số đơn CÙNG NULL =
// không phát sinh giao dịch (0đ); CHỈ MỘT field NULL = nguồn hỏng. Vì vậy
// landing đếm cả `offline_no_order` dù không dùng số đơn — thiếu counter này
// thì landing và campaign sẽ hiểu NULL theo hai nghĩa khác nhau.
// Hai grain của landing LUÔN là kỳ ĐANG DIỄN RA (DAY = hôm nay, MONTH = tháng
// hiện tại) nên gate "toàn bộ POS cùng NULL ở ngày ĐÃ KẾT THÚC" không áp ở đây;
// 0đ lúc 00:05 là số ĐÚNG, không phải dữ liệu thiếu.
//   · day:   date_type='DAY',   start_date = hôm nay VN; period_end = start.
//   · month: date_type='MONTH', start_date = đầu tháng VN; period_end = LAST_DAY.
//   · week:  ⛔ CHƯA BẬT — schema mới không có period_end và DAY rows không
//     link tuần; chờ BI xác nhận quy tắc tuần (REQUIRED INPUT #2, plan 05/08)
//     rồi bổ sung nhánh UNION 'week'. Tab Tuần tạm hiện "Chưa có dữ liệu" cho
//     kỳ mới (row tuần cũ trong store_kpi_targets giữ nguyên lịch sử).
// Rows ~50 (25 active OS store × 2 grain), far under the 1000-row maxResults cap.
// r1 (audit P2#3): GROUP BY + COUNT(*) THẬT — nguồn kỳ vọng 1 row/(date_type,
// start_date, pos); nếu BI vô tình có 2 dòng, raw_row_count > 1 và
// aggregateAndUpsertKpi TỪ CHỐI row đó (fail-closed), không ghi đè theo thứ tự.
export const KPI_AGGREGATE_QUERY = `
  WITH today AS (SELECT CURRENT_DATE("Asia/Ho_Chi_Minh") AS d)
  SELECT 'day' AS period_type, start_date AS period_start, start_date AS period_end,
         pos_code, MAX(pos_name) AS pos_name,
         CAST(ROUND(SUM(offline_net_revenue)) AS NUMERIC) AS actual,
         CAST(SUM(COALESCE(TARGET, 0)) AS NUMERIC) AS target,
         COUNTIF(offline_net_revenue IS NULL) AS offline_revenue_null_count,
         COUNTIF(offline_no_order IS NULL)     AS offline_order_null_count,
         COUNT(*) AS raw_row_count
  FROM \`lakehouse-prod-394907.buymed_tech.tech__circa_os_gmv_kpi\`, today
  WHERE date_type = 'DAY'
    AND pos_code IS NOT NULL AND start_date IS NOT NULL
    AND pos_code NOT IN ("POS0001")
    AND start_date = today.d
  GROUP BY start_date, pos_code
  UNION ALL
  SELECT 'month' AS period_type, start_date AS period_start, LAST_DAY(start_date) AS period_end,
         pos_code, MAX(pos_name) AS pos_name,
         CAST(ROUND(SUM(offline_net_revenue)) AS NUMERIC) AS actual,
         CAST(SUM(COALESCE(TARGET, 0)) AS NUMERIC) AS target,
         COUNTIF(offline_net_revenue IS NULL) AS offline_revenue_null_count,
         COUNTIF(offline_no_order IS NULL)     AS offline_order_null_count,
         COUNT(*) AS raw_row_count
  FROM \`lakehouse-prod-394907.buymed_tech.tech__circa_os_gmv_kpi\`, today
  WHERE date_type = 'MONTH'
    AND pos_code IS NOT NULL AND start_date IS NOT NULL
    AND pos_code NOT IN ("POS0001")
    AND start_date = DATE_TRUNC(today.d, MONTH)
  GROUP BY start_date, pos_code
  ORDER BY period_type, pos_code
`

// No-arg wrapper preserved for the cron route — reads BQ_SERVICE_ACCOUNT_KEY.
export function loadServiceAccount(): ServiceAccount | null {
  return loadSA('BQ_SERVICE_ACCOUNT_KEY')
}

// KPI Campaign OFFLINE actual over an arbitrary date range (campaign start→end).
// ⚠ BQ-V2 r3 (06/08): nguồn = `buymed_tech.tech__circa_os_gmv_kpi` — bảng
// PRODUCTION schema V2 (SA chỉ có quyền dataset buymed_tech; mirror
// gold_buymed_vn2 đồng bộ 1-1 nhưng KHÔNG được cấp quyền → 403). Campaign CHỈ
// đọc `date_type='DAY'` + `offline_net_revenue` (DAY-authoritative;
// MONTH/WEEK/TARGET KHÔNG tham gia). Table HARD-CODE trong Git (quyết
// định 30/07: không ENV — số commission phải có commit audit).
// Alias GIỮ NGUYÊN `actual_gmv` để downstream (engine/DB payload/UI/export)
// không đổi — "gmv" trong pipeline campaign = Net Revenue Offline.
// runBigQuery has no query-parameter support, so the dates are interpolated —
// both values come from DB `date` columns; the regex guard makes injection
// impossible even if a caller passes something else. Schema mới NULLABLE →
// loại row pos_code/start_date NULL ngay trong WHERE; doanh thu NULL KHÔNG bị
// COALESCE mà được đếm riêng (fail-closed); giá trị ÂM giữ nguyên.
// ⚠ Hàm này hiện KHÔNG có caller (campaign đọc daily rồi cộng app-side) —
// giữ lại cho đối soát tay, nên vẫn phải đúng schema.
// ~25 active OS stores → one row per pos_code, far under the 1000-row cap.
export function campaignRangeQuery(startDate: string, endDate: string): string {
  const ISO = /^\d{4}-\d{2}-\d{2}$/
  if (!ISO.test(startDate) || !ISO.test(endDate)) {
    throw new Error(`campaignRangeQuery: ngày không hợp lệ (${startDate} – ${endDate})`)
  }
  return `
    SELECT pos_code, ROUND(SUM(CAST(offline_net_revenue AS NUMERIC))) AS actual_gmv,
           COUNTIF(offline_net_revenue IS NULL) AS offline_revenue_null_count,
           COUNTIF(offline_no_order IS NULL)    AS offline_order_null_count,
           COUNT(*) AS row_count
    FROM \`lakehouse-prod-394907.buymed_tech.tech__circa_os_gmv_kpi\`
    WHERE date_type = 'DAY'
      AND pos_code IS NOT NULL AND start_date IS NOT NULL
      AND pos_code NOT IN ("POS0001")
      AND start_date BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY pos_code
    ORDER BY pos_code
  `
}

// 105 (11/08): trả thêm `order_count` = SUM(offline_no_order) + canary
// (null-mismatch 2 chiều · âm · không nguyên · doanh thu mà 0 đơn) và, từ
// 112.3, đếm NULL riêng từng nguồn.
// AOV KHÔNG lấy từ cột `offline_aov` của BI (giá trị dẫn xuất) — app luôn tính
// SUM(offline_net_revenue)/SUM(offline_no_order) (weighted; đo thật 08/2026
// lệch 1.445đ so với AVG(aov)).
// Per-DAY OFFLINE actual per store over a range — drives the staff "Tiến độ
// theo ngày" chart AND the aggregate snapshot (summed app-side so they always
// agree). ⚠ BQ-V2 (05/08): nguồn `buymed_tech.tech__circa_os_gmv_kpi`,
// `date_type='DAY'` + `offline_net_revenue` (xem campaignRangeQuery); alias
// GIỮ NGUYÊN `gmv` — cột `gmv` của kpi_campaign_store_daily_actuals = Net
// Revenue Offline. `source_row_count` đi kèm để orchestrator guard: bảng mới
// pre-aggregated 1 row/store/ngày — >1 nghĩa nguồn sai → preserve snapshot.
// Caller must chunk long ranges by month: 25 stores × 31 days ≈ 775 rows per
// chunk, under the 1000-row cap; a 2-month range in one call would exceed it.
export function campaignDailyQuery(startDate: string, endDate: string): string {
  const ISO = /^\d{4}-\d{2}-\d{2}$/
  if (!ISO.test(startDate) || !ISO.test(endDate)) {
    throw new Error(`campaignDailyQuery: ngày không hợp lệ (${startDate} – ${endDate})`)
  }
  return `
    SELECT pos_code, start_date AS \`date\`,
           -- 112.3: trả giá trị THÔ (KHÔNG làm tròn ở đây) — app snap về đồng
           -- nguyên khi đọc (snapRevenue, lib/kpi/revenueSource). Nguồn không
           -- có phần lẻ VND thật (đo 04/09: lệch tối đa 9,3e-10đ / 7.139 dòng)
           -- nên SUM của MỌI khoảng con đều bằng ROUND(SUM(raw)) của khoảng đó.
           -- KHÔNG COALESCE: NULL phải chảy xuống nguyên trạng để app quyết
           -- (counter offline_revenue_null_count), không được hoá 0đ ở SQL.
           SUM(CAST(offline_net_revenue AS NUMERIC)) AS gmv,
           -- 105: số đơn Offline (BI thêm 11/08). CHỦ Ý dùng
           -- COUNTIF(... IS NOT NULL) thay COALESCE: NULL_MISMATCH cho biết
           -- row có doanh thu nhưng THIẾU số đơn (hoặc ngược lại) → engine
           -- fail-closed, KHÔNG âm thầm coi là 0 đơn (AOV sẽ sai).
           -- r1 (audit P1): SUM ở dạng NUMERIC — CAST INT64 sẽ LÀM TRÒN số lẻ
           -- ngay trong BQ khiến guard Number.isInteger() phía app không bao
           -- giờ thấy dữ liệu sai. Số lẻ được bắt riêng bằng non_integer_order.
           SUM(CAST(offline_no_order AS NUMERIC))                          AS order_count,
           COUNTIF(offline_no_order IS NULL AND offline_net_revenue IS NOT NULL) AS rev_without_order,
           COUNTIF(offline_no_order IS NOT NULL AND offline_net_revenue IS NULL) AS order_without_rev,
           COUNTIF(offline_no_order < 0)                                   AS negative_order,
           COUNTIF(offline_no_order IS NOT NULL
                   AND offline_no_order != TRUNC(offline_no_order))        AS non_integer_order,
           -- r1.2 (audit): có doanh thu nhưng KHÔNG đơn nào ⇒ AOV không xác
           -- định mà vẫn có tiền → fail-closed. (Ngược lại: order > 0 với
           -- net = 0 VẪN hợp lệ; net ÂM không tự reject — BI cho phép hoàn/
           -- điều chỉnh.)
           COUNTIF(offline_no_order = 0
                   AND COALESCE(offline_net_revenue, 0) != 0)              AS revenue_with_zero_order,
           -- 112: đếm NULL RIÊNG từng nguồn. Hai canary lệch-cặp ở trên KHÔNG
           -- bắt được ca CẢ HAI field cùng NULL, mà SUM() của BigQuery thì bỏ
           -- qua NULL — dữ liệu thiếu có thể ra một tổng trông rất hợp lệ.
           COUNTIF(offline_net_revenue IS NULL)                            AS offline_revenue_null_count,
           COUNTIF(offline_no_order IS NULL)                               AS offline_order_null_count,
           COUNT(*) AS source_row_count
    FROM \`lakehouse-prod-394907.buymed_tech.tech__circa_os_gmv_kpi\`
    WHERE date_type = 'DAY'
      AND pos_code IS NOT NULL AND start_date IS NOT NULL
      AND pos_code NOT IN ("POS0001")
      AND start_date BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY pos_code, start_date
    ORDER BY pos_code, start_date
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
