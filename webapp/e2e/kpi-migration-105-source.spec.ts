import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Mig 105 (11/08) — SOURCE-TEXT contract cho migration số đơn/AOV Offline.
// Migration không chạy được trong CI nên khóa bằng source-text (pattern
// kpi-net-revenue-source): vòng audit trước đã lọt P0 "GRANT thiếu
// TO service_role" — spec này chặn tái diễn.
// CRLF-safe: worktree/clone khác có thể checkout CRLF (core.autocrlf).
const sql = fs
  .readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations',
    '105_kpi_campaign_offline_order_metrics.sql'), 'utf8')
  .replace(/\r\n/g, '\n')

test.describe('mig 105 source contract @desktop', () => {
  test('SQL toàn vẹn: mọi GRANT/REVOKE đủ mệnh đề, transaction cân, không cụt câu', () => {
    // P0 vòng trước: 'GRANT EXECUTE ON FUNCTION ...' bị cắt mất 'TO service_role;'
    // → syntax error, cả migration rollback.
    const grants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION[\s\S]*?;/g)].map((m) => m[0])
    expect(grants.length).toBeGreaterThan(0)
    for (const g of grants) expect(g).toContain('TO service_role;')
    const revokes = [...sql.matchAll(/REVOKE ALL ON FUNCTION[\s\S]*?;/g)].map((m) => m[0])
    for (const r of revokes) expect(r).toMatch(/FROM PUBLIC, anon, authenticated;/)
    // mọi statement GRANT phải đứng NGAY trước dấu ; — không câu nào bỏ lửng
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*\n\s*\n/)
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1)
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1)
  })

  test('RPC giữ SECURITY DEFINER + search_path; revoke PUBLIC/anon/authenticated; grant DUY NHẤT service_role', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_actuals(')
    expect(sql).toContain('SECURITY DEFINER SET search_path = public')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.rpc_replace_campaign_actuals(uuid, jsonb, jsonb)')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_actuals(uuid, jsonb, jsonb)\n  TO service_role;')
    // không cấp cho role nào khác
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*TO (anon|authenticated|PUBLIC)/)
  })

  test('2 cột + 2 CHECK ≥ 0 (NULL hợp lệ = "nguồn chưa có số đơn", KHÁC 0)', () => {
    for (const t of ['kpi_campaign_store_actuals', 'kpi_campaign_store_daily_actuals']) {
      expect(sql).toContain(`ALTER TABLE public.${t}\n  ADD COLUMN IF NOT EXISTS offline_order_count bigint;`)
    }
    expect(sql).toContain('chk_ksa_offline_order_count_nonneg')
    expect(sql).toContain('chk_kcda_offline_order_count_nonneg')
    expect((sql.match(/CHECK \(offline_order_count IS NULL OR offline_order_count >= 0\)/g) ?? []).length).toBe(2)
    // KHÔNG lưu cột aov (giá trị dẫn xuất — luôn tính lại)
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS aov/)
  })

  test('RPC validate: SUM(daily) = aggregate · cấm campaign khách/affiliate-only · chặn payload nửa vời', () => {
    expect(sql).toContain('SUM(daily.offline_order_count)')
    expect(sql).toContain('campaign customer-count nhưng store % có offline_order_count')
    expect(sql).toContain('campaign tắt metric_offline nhưng store % có offline_order_count')
    expect(sql).toContain('phải đủ mọi ngày')
    expect(sql).toContain('payload nửa vời')
    expect(sql).toContain('offline_order_count âm')
  })

  test('GMV zero-touch: các guard 098/103 còn nguyên trong body (không rơi khi copy)', () => {
    for (const guard of [
      'p_actuals có store trùng lặp',
      'p_daily có (store_id, date) trùng lặp',
      'p_actuals THIẾU aggregate cho ít nhất 1 store',
      'p_daily chứa store không có aggregate trong p_actuals',
      'p_daily chứa store ngoài targets của campaign',
      'actual_value(%) <> actual_offline(%) + actual_affiliate(%)',
      'SUM(daily.affiliate_customer_count)',
      'đã lưu trữ — không ghi số liệu',
    ]) expect(sql, `guard mất: ${guard}`).toContain(guard)
    // preflight thứ tự migration
    expect(sql).toContain("WHERE version = '104'")
    expect(sql).toContain("VALUES ('105', 'kpi_campaign_offline_order_metrics'")
  })

  test('BigQuery: SUM ở NUMERIC (không cast INT64 làm tròn) + canary non_integer_order', () => {
    const bq = fs.readFileSync(path.join(__dirname, '..', 'lib', 'targets', 'bigquery.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    // 112 (04/09): BI tách Offline/Affiliate — cột `no_order` đổi thành
    // `offline_no_order`. Ý ĐỊNH của contract 105 giữ nguyên: SUM ở NUMERIC
    // (cast INT64 sẽ làm tròn ngay trong BQ, guard Number.isInteger phía app
    // không bao giờ thấy dữ liệu lẻ) + canary số lẻ vẫn còn.
    expect(bq).toContain('SUM(CAST(offline_no_order AS NUMERIC))')
    expect(bq).not.toContain('AS INT64))')
    expect(bq).toContain('offline_no_order != TRUNC(offline_no_order)')
    for (const canary of ['rev_without_order', 'order_without_rev', 'negative_order',
      'non_integer_order', 'revenue_with_zero_order']) {
      expect(bq).toContain(canary)
    }
    // KHÔNG bao giờ tổng hợp trực tiếp cột aov của BI (weighted-only). Soi
    // CODE thật — bỏ dòng comment (comment CÓ nhắc 'AVG(aov)' để cảnh báo).
    const bqCode = bq.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(bqCode).not.toMatch(/(SUM|AVG)\([^)]*\baov\b/)
  })
})
