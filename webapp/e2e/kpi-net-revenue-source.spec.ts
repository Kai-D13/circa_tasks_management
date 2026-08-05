import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Contract 30/07 — KPI Campaign Offline chuyển nguồn BigQuery gmv → NET_REVENUE
// (toàn cục, không per-campaign; alias giữ nguyên nên downstream không đổi).
// lib/targets/bigquery.ts import 'server-only' (không import runtime được
// trong test) → khóa contract bằng SOURCE-TEXT assertion trên chính file:
//   1. 2 query campaign SUM net_revenue (alias actual_gmv/gmv GIỮ NGUYÊN)
//   2. KHÔNG còn SUM(COALESCE(gmv, 0)) trong file (chứng minh không sót)
//   3. KPI_AGGREGATE_QUERY (landing day/week/month) VẪN dùng gmv — không đổi
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

  test('1. campaignRangeQuery + campaignDailyQuery SUM NET_REVENUE, alias GIỮ NGUYÊN (downstream không đổi)', () => {
    expect(rangeFn).toContain('SUM(CAST(COALESCE(net_revenue, 0) AS NUMERIC)) AS actual_gmv')
    expect(dailyFn).toContain('SUM(CAST(COALESCE(net_revenue, 0) AS NUMERIC)) AS gmv')
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
    expect(aggQuery).toContain('CAST(SUM(COALESCE(net_revenue, 0)) AS NUMERIC) AS actual')
    expect(aggQuery).toContain('CAST(SUM(COALESCE(TARGET, 0)) AS NUMERIC) AS target')
    expect(aggQuery).toContain('COUNT(*) AS raw_row_count')
    expect(aggQuery).toContain('GROUP BY start_date, pos_code')
    expect(aggQuery).toContain('LAST_DAY(start_date) AS period_end')
    // DEFAULT_QUERY (weekly legacy — pipeline store_weekly_targets riêng) không đụng
    expect(section('export const DEFAULT_QUERY', 'export const KPI_AGGREGATE_QUERY')).not.toContain('net_revenue')
  })

  test('4. Guard ISO date (chống injection khi interpolate) còn nguyên ở CẢ 2 hàm campaign', () => {
    for (const fn of [rangeFn, dailyFn]) {
      expect(fn).toContain('/^\\d{4}-\\d{2}-\\d{2}$/')
      expect(fn).toContain('ngày không hợp lệ')
    }
  })
})
