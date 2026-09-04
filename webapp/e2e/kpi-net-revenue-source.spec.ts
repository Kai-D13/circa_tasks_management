import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Contract 30/07 — KPI Campaign Offline chuyển nguồn BigQuery gmv → NET_REVENUE
// (toàn cục, không per-campaign; alias giữ nguyên nên downstream không đổi).
// lib/targets/bigquery.ts import 'server-only' (không import runtime được
// trong test) → khóa contract bằng SOURCE-TEXT assertion trên chính file:
//   1. 2 query campaign SUM net_revenue (alias actual_gmv/gmv GIỮ NGUYÊN)
//   2. KHÔNG còn SUM(COALESCE(gmv, 0)) trong file (chứng minh không sót)
//   3. KPI_AGGREGATE_QUERY (landing) — bảng V2: DAY/MONTH đọc net_revenue/TARGET
//   4. Guard ISO date (chống injection) còn nguyên ở cả 2 hàm campaign
// Test số học #5-8 của contract (offline-only / hybrid identity / null→0 /
// âm không clamp / tier-commission theo actual_value) đã được khóa sẵn bởi
// suite engine/orchestration + resultModel hiện có (không phụ thuộc nguồn).

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'targets', 'bigquery.ts'), 'utf8')

// Cắt đúng thân từng khối theo marker duy nhất trong file, BỎ các dòng
// comment (// …) — assertion âm ("không chứa net_revenue") phải soi CODE
// thật, không dính comment cảnh báo contract.
const stripComments = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
const section = (from: string, to: string) => {
  const i = src.indexOf(from)
  const j = src.indexOf(to, i + 1)
  expect(i, `không tìm thấy marker "${from}"`).toBeGreaterThan(-1)
  return stripComments(j === -1 ? src.slice(i) : src.slice(i, j))
}

test.describe('kpi net_revenue source contract @desktop', () => {
  const rangeFn = section('export function campaignRangeQuery', 'export function campaignDailyQuery')
  const dailyFn = section('export function campaignDailyQuery', 'export async function runBigQuery')
  const aggQuery = section('export const KPI_AGGREGATE_QUERY', 'export function loadServiceAccount')

  test('1. campaignRangeQuery + campaignDailyQuery đọc OFFLINE_NET_REVENUE, alias GIỮ NGUYÊN (downstream không đổi)', () => {
    // 112 (04/09): BI tách Offline/Affiliate — cột net_revenue đã bị xoá khỏi
    // view. Alias actual_gmv/gmv GIỮ NGUYÊN nên engine/DB/UI/export không đổi.
    expect(rangeFn).toContain('ROUND(SUM(CAST(offline_net_revenue AS NUMERIC))) AS actual_gmv')
    // 112.3: daily trả giá trị THÔ — làm tròn theo TOÀN KHOẢNG là việc của
    // allocateRoundedDaily (ROUND từng ngày rồi cộng ra số khác contract).
    expect(dailyFn).toContain('SUM(CAST(offline_net_revenue AS NUMERIC)) AS gmv')
    expect(dailyFn).not.toContain('ROUND(SUM(CAST(offline_net_revenue AS NUMERIC))) AS gmv')
    // KHÔNG COALESCE quanh doanh thu: NULL phải chảy xuống thành lỗi nguồn.
    expect(dailyFn).not.toContain('COALESCE(offline_net_revenue, 0)) AS gmv')
  })

  test('5. BQ-V2 r3: 2 hàm campaign đọc bảng PRODUCTION buymed_tech (schema V2, SA có quyền — KHÔNG gold_buymed_vn2) + CHỈ date_type DAY + loại NULL keys + source_row_count', () => {
    for (const fn of [rangeFn, dailyFn]) {
      expect(fn).toContain('buymed_tech.tech__circa_os_gmv_kpi')
      expect(fn).not.toContain('gold_buymed_vn2') // r3: SA không có quyền dataset mirror
      expect(fn).toContain("date_type = 'DAY'")
      expect(fn).toContain('pos_code IS NOT NULL AND start_date IS NOT NULL')
      expect(fn).toContain('start_date BETWEEN')
    }
    expect(dailyFn).toContain('COUNT(*) AS source_row_count')
    expect(dailyFn).toContain('start_date AS')
  })

  test('2. KHÔNG còn SUM(COALESCE(gmv, 0)) trong 2 hàm campaign (audit P2: scope hẹp — landing sau này dùng lại pattern này vẫn hợp lệ, không fail oan)', () => {
    expect(rangeFn).not.toContain('SUM(COALESCE(gmv, 0))')
    expect(dailyFn).not.toContain('SUM(COALESCE(gmv, 0))')
  })

  test('3. Landing KPI_AGGREGATE_QUERY (BQ-V2 1b): bảng mới, DAY/MONTH đọc trực tiếp net_revenue/TARGET; WEEK CHƯA bật (chờ BI input #2); DEFAULT_QUERY legacy không đụng', () => {
    expect(aggQuery).toContain('buymed_tech.tech__circa_os_gmv_kpi')
    expect(aggQuery).not.toContain('gold_buymed_vn2') // r3: SA không có quyền dataset mirror
    expect(aggQuery).toContain("date_type = 'DAY'")
    expect(aggQuery).toContain("date_type = 'MONTH'")
    expect(aggQuery).not.toContain("'week'") // chưa bật — BI chưa có dữ liệu WEEK
    // r1 (audit P2#3): GROUP BY + COUNT thật — dòng nguồn trùng bị kpi.ts từ chối
    expect(aggQuery).toContain('CAST(ROUND(SUM(offline_net_revenue)) AS NUMERIC) AS actual')
    // 112.3 (audit P1#2): KHÔNG lọc NULL trước GROUP BY — lọc thì một khoá có
    // 1 row hợp lệ + 1 row NULL vẫn ra raw_row_count=1 và trôi qua như sạch.
    // Giữ row NULL đến aggregate rồi để kpiPlan từ chối theo counter.
    expect(aggQuery).not.toContain('offline_net_revenue IS NOT NULL')
    expect(aggQuery).toContain('COUNTIF(offline_net_revenue IS NULL) AS offline_revenue_null_count')
    // Landing CHỈ Offline — cộng Affiliate là đổi ý nghĩa màn này.
    expect(aggQuery).not.toContain('affiliate_net_revenue')
    expect(aggQuery).toContain('CAST(SUM(COALESCE(TARGET, 0)) AS NUMERIC) AS target')
    expect(aggQuery).toContain('COUNT(*) AS raw_row_count')
    expect(aggQuery).toContain('GROUP BY start_date, pos_code')
    expect(aggQuery).toContain('LAST_DAY(start_date) AS period_end')
    // DEFAULT_QUERY (weekly legacy — pipeline store_weekly_targets riêng) không đụng
    expect(section('export const DEFAULT_QUERY', 'export const KPI_AGGREGATE_QUERY')).not.toContain('net_revenue')
  })

  // ── 112: canary identifier ĐÃ KHAI TỬ ──────────────────────────────────
  // `offline_net_revenue` CHỨA `net_revenue` như chuỗi con, nên grep ngây thơ
  // sẽ báo động giả. Loại hết TÊN MỚI trước rồi mới tìm tên cũ — dùng
  // split/join, KHÔNG regex: escape trong tay tôi từng biến \b thành byte
  // 0x08 và làm canary luôn xanh (sự cố 5.1/6).
  const retiredTokens = (sql: string): string[] => {
    const stripped = ['offline_net_revenue', 'affiliate_net_revenue',
      'offline_no_order', 'affiliate_no_order']
      .reduce((s, name) => s.split(name).join('#'), sql)
    return ['net_revenue', 'no_order'].filter((t) => stripped.includes(t))
  }

  test('6. KHÔNG còn identifier đã khai tử (net_revenue / no_order) trong SQL', () => {
    // Tự kiểm canary: nếu logic strip sai thì hai dòng này đã đỏ.
    expect(retiredTokens('SELECT offline_net_revenue, offline_no_order')).toEqual([])
    expect(retiredTokens('SELECT net_revenue')).toEqual(['net_revenue'])

    for (const [name, fn] of [['range', rangeFn], ['daily', dailyFn], ['landing', aggQuery]] as const) {
      expect(retiredTokens(fn), `${name} còn đọc cột BI đã xoá`).toEqual([])
    }
  })

  test('7. Đếm NULL RIÊNG từng nguồn — SUM() của BigQuery bỏ qua NULL', () => {
    expect(dailyFn).toContain('AS offline_revenue_null_count')
    expect(dailyFn).toContain('AS offline_order_null_count')
    // Range dùng cho đối soát tay cũng phải có counter (SUM bỏ qua NULL).
    expect(rangeFn).toContain('AS offline_revenue_null_count')
    // Landing: counter là đường DUY NHẤT thấy NULL (coerceNum coi NULL là 0đ).
    expect(aggQuery).toContain('AS offline_revenue_null_count')
  })

  test('4. Guard ISO date (chống injection khi interpolate) còn nguyên ở CẢ 2 hàm campaign', () => {
    for (const fn of [rangeFn, dailyFn]) {
      expect(fn).toContain('/^\\d{4}-\\d{2}-\\d{2}$/')
      expect(fn).toContain('ngày không hợp lệ')
    }
  })
})
