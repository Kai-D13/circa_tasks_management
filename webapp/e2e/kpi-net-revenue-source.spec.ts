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
    expect(rangeFn).toContain('SUM(COALESCE(net_revenue, 0)) AS actual_gmv')
    expect(dailyFn).toContain('SUM(COALESCE(net_revenue, 0)) AS gmv')
  })

  test('2. KHÔNG còn SUM(COALESCE(gmv, 0)) ở bất kỳ đâu trong file — không sót query campaign nào', () => {
    expect(src).not.toContain('SUM(COALESCE(gmv, 0))')
  })

  test('3. KPI_AGGREGATE_QUERY (landing ngày/tuần/tháng) VẪN dùng gmv — không bị đổi theo', () => {
    expect(aggQuery).toContain('SUM(gmv) AS actual')
    expect(aggQuery).not.toContain('net_revenue')
    // DEFAULT_QUERY (weekly legacy) cũng không đụng
    expect(section('export const DEFAULT_QUERY', 'export const KPI_AGGREGATE_QUERY')).not.toContain('net_revenue')
  })

  test('4. Guard ISO date (chống injection khi interpolate) còn nguyên ở CẢ 2 hàm campaign', () => {
    for (const fn of [rangeFn, dailyFn]) {
      expect(fn).toContain('/^\\d{4}-\\d{2}-\\d{2}$/')
      expect(fn).toContain('ngày không hợp lệ')
    }
  })
})
