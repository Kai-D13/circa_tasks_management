import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Mig 106 — SOURCE-TEXT contract cho campaign "Chất lượng bán hàng".
// CONTRACT CHỐT 12/08: completion = min(order/order_target, aov/aov_target)×100.
// Migration không chạy được trong CI ⇒ khóa bằng source-text (pattern 105).
// Trọng tâm: RPC LÀ AUTHORITY, 3 nhánh metric_type tường minh + reject loại lạ,
// kpi_target=100 do RPC ép, reverse guard 2 cột, policy ĐÚNG 1 bậc mốc 100,
// advisory lock + overlap chỉ với campaign ACTIVE, và KHÔNG còn dấu vết floor.
// CRLF-safe: worktree khác có thể checkout CRLF (core.autocrlf).
const sql = fs
  .readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations',
    '106_kpi_campaign_order_aov.sql'), 'utf8')
  .replace(/\r\n/g, '\n')
// Phần THỰC THI (trước COMMIT) — phần VERIFY được phép nhắc tên cột cũ để
// kiểm tra chúng KHÔNG tồn tại.
const exec = sql.slice(0, sql.indexOf('\nCOMMIT;'))

function fnBody(name: string): string {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(i, `không tìm thấy ${name}`).toBeGreaterThan(-1)
  const j = sql.indexOf('END $$;', i)
  expect(j, `${name} bị cắt cụt`).toBeGreaterThan(i)
  return sql.slice(i, j + 7)
}
const TARGETS = fnBody('rpc_replace_campaign_targets')
const ACTUALS = fnBody('rpc_replace_campaign_actuals')
const ACTIVATE = fnBody('rpc_activate_kpi_campaign')

test.describe('mig 106 source contract @desktop', () => {
  test('SQL toàn vẹn: 3 GRANT đủ mệnh đề, REVOKE đích danh, transaction cân', () => {
    // P0 vòng 105: 'GRANT EXECUTE ON FUNCTION ...' bị cắt mất 'TO service_role;'
    // → syntax error, cả migration rollback.
    const grants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION[\s\S]*?;/g)].map((m) => m[0])
    expect(grants.length).toBe(3)
    for (const g of grants) expect(g).toContain('TO service_role;')
    const revokes = [...sql.matchAll(/REVOKE ALL ON FUNCTION[\s\S]*?;/g)].map((m) => m[0])
    expect(revokes.length).toBe(3)
    for (const r of revokes) expect(r).toMatch(/FROM PUBLIC, anon, authenticated;/)
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*\n\s*\n/)
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*TO (anon|authenticated|PUBLIC)/)
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1)
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1)
    expect((sql.match(/SECURITY DEFINER SET search_path = public/g) ?? []).length).toBe(3)
    expect(sql).toContain("WHERE version = '105'")            // preflight thứ tự
    expect(sql).toContain("VALUES ('106', 'kpi_campaign_order_aov'")
  })

  test('KHÔNG còn dấu vết contract cũ (floor / 90-10 / quality_floor_pass)', () => {
    for (const dead of ['order_floor', 'aov_floor', 'quality_floor_pass',
      'target_score', '0.90 *', '0.10 *']) {
      expect(exec, `còn sót ${dead}`).not.toContain(dead)
    }
  })

  test('DDL: metric_type 3 giá trị + contract cột + ĐÚNG 2 cột target', () => {
    expect(sql).toContain("CHECK (metric_type IN ('gmv', 'affiliate_customer_count', 'offline_order_aov'))")
    expect(sql).toContain('chk_kpi_campaigns_order_aov_contract')
    expect(sql).toContain("metric_type <> 'offline_order_aov'\n             OR (metric_offline = true AND metric_affiliate = false AND order_type = 'all')")
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS order_target bigint')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS aov_target   numeric')
    // cùng NULL hoặc cùng có · dương · AOV nguyên VNĐ
    expect(sql).toContain('num_nonnulls(order_target, aov_target) IN (0, 2)')
    expect(sql).toContain('aov_target = trunc(aov_target)')
    // AOV/kpi_pass là DẪN XUẤT — tuyệt đối không lưu thành cột
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS (actual_)?aov\b/)
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS \w*kpi_pass/)
  })

  test('targets RPC: ÉP kpi_target=100 · 2 mục tiêu nguyên dương · reverse guard · policy 1 bậc 100', () => {
    expect(TARGETS).toContain("v_is_aov := (v_metric_type = 'offline_order_aov')")
    expect(TARGETS).toContain("v_metric_type NOT IN ('gmv', 'affiliate_customer_count', 'offline_order_aov')")
    expect(TARGETS).toContain('v_kt := 100;')
    expect(TARGETS).toContain('kpi_target do hệ thống ép = 100')
    expect(TARGETS).toContain('order_target và aov_target đều bắt buộc')
    expect(TARGETS).toContain('IF v_ot <> floor(v_ot) THEN')     // số đơn nguyên
    expect(TARGETS).toContain('IF v_at <> floor(v_at) THEN')     // AOV nguyên VNĐ
    // reverse guard: gmv/customer KHÔNG được mang 2 cột
    expect(TARGETS).toContain('2 cột này CHỈ dành cho Chất lượng bán hàng')
    expect(TARGETS).toContain('order_target, aov_target)')       // INSERT
    // policy tier hiện tại
    expect(TARGETS).toContain('IF v_tiers <> 1 THEN')
    expect(TARGETS).toContain('v_prev_th IS DISTINCT FROM 100')
    // guard 103 còn nguyên
    expect(TARGETS).toContain('kpi_target phải là số nguyên dương (số khách)')
    expect(TARGETS).toContain('store_kpi_group là bắt buộc')
    expect(TARGETS).toContain('Mỗi target cần ít nhất 1 bậc')
  })

  test('actuals RPC LÀ AUTHORITY: min 2 tỉ lệ, không cap, commission chỉ khi đạt KPI', () => {
    expect(ACTUALS).toContain("v_row ?| array['actual_value', 'run_rate', 'remaining_target',")
    expect(ACTUALS).toContain('RPC tự tính, payload chỉ được gửi actual_offline + offline_order_count')
    // actual_offline BẮT BUỘC có VÀ không null (không chỉ kiểm tra key tồn tại)
    expect(ACTUALS).toContain("NOT (v_row ? 'actual_offline') OR v_row->>'actual_offline' IS NULL")
    // công thức: min của 2 tỉ lệ so với TARGET
    expect(ACTUALS).toContain('v_o_ratio := v_ord::numeric / v_t.order_target;')
    expect(ACTUALS).toContain('v_a_ratio := CASE WHEN v_aov IS NOT NULL THEN v_aov / v_t.aov_target END;')
    expect(ACTUALS).toContain('round(least(v_o_ratio, v_a_ratio) * 100, 4)')
    expect(ACTUALS).toContain('v_aov     := CASE WHEN v_ord > 0 THEN v_offline / v_ord END;')
    // kpi_pass = đạt CẢ HAI mục tiêu (>=)
    expect(ACTUALS).toContain('v_kpi_pass := (v_ord >= v_t.order_target')
    expect(ACTUALS).toContain('AND v_aov IS NOT NULL AND v_aov >= v_t.aov_target)')
    // INVARIANT TIỀN: completion không được chạm 100 khi chưa đạt
    expect(ACTUALS).toContain('IF NOT v_kpi_pass AND v_completion >= 100 THEN')
    expect(ACTUALS).toContain('v_completion := 99.9999;')
    // commission CHỈ khi đạt KPI
    expect(ACTUALS).toMatch(/IF v_kpi_pass THEN\n\s+SELECT ti\.tier_order, ti\.commission_amount/)
    // ghi đúng ô
    expect(ACTUALS).toContain("'actual_value',          v_completion")
    expect(ACTUALS).toContain("'run_rate',              v_completion")
    expect(ACTUALS).toContain("'remaining_target',      greatest(100 - v_completion, 0)")
    // guard nguồn
    expect(ACTUALS).toContain('số đơn LÀ KPI, không được để trống')
    expect(ACTUALS).toContain('có 0 đơn nhưng Net Revenue = %')
    expect(ACTUALS).toContain('dòng daily thiếu gmv')
    expect(ACTUALS).toContain('Net Revenue ÂM là HỢP LỆ')       // không clamp
    expect(ACTUALS).toContain('IF v_t.kpi_target <> 100 THEN')
  })

  test('actuals RPC: 3 nhánh metric_type TƯỜNG MINH + reject loại lạ + zero-touch 2 loại cũ', () => {
    expect(ACTUALS).toContain("IF v_metric_type = 'affiliate_customer_count' THEN")
    expect(ACTUALS).toContain("ELSIF v_metric_type = 'offline_order_aov' THEN")
    expect(ACTUALS).toContain("ELSIF v_metric_type = 'gmv' THEN")
    expect(ACTUALS).toContain('metric_type % không được hỗ trợ — không ghi số liệu')
    expect(ACTUALS).not.toContain('ELSE\n      -- Nhánh GMV')
    expect(ACTUALS).toContain("v_calc      := '{}'::jsonb;")
    expect(ACTUALS).toContain('v_out := v_out || jsonb_build_array(v_row || v_calc);')
    expect(ACTUALS).toContain('FOR v_row IN SELECT * FROM jsonb_array_elements(v_out)')
  })

  test('activate RPC: advisory lock TRƯỚC pre-check, overlap PER-STORE chỉ với ACTIVE, policy tier', () => {
    expect(ACTIVATE).toContain("PERFORM pg_advisory_xact_lock(hashtext('kpi_order_aov_activate'));")
    const i = ACTIVATE.indexOf('106: nhánh Chất lượng bán hàng')
    const j = ACTIVATE.indexOf('IF v_c.metric_affiliate IS TRUE THEN')
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    const block = ACTIVATE.slice(i, j)
    expect(block.indexOf('pg_advisory_xact_lock')).toBeLessThan(block.indexOf('SELECT count(*) INTO v_bad'))
    expect(block).toContain("AND c2.status = 'active'")
    expect(block).not.toContain("c2.status IN ('active', 'paused')")
    expect(block).toContain('JOIN public.kpi_campaign_store_targets t2 ON t2.campaign_id = c2.id')
    expect(block).toContain('AND t2.store_id IN (SELECT t.store_id FROM public.kpi_campaign_store_targets t')
    expect(block).toContain('daterange(c2.start_date, c2.end_date')
    // fail-closed cấu hình: 2 mục tiêu + kpi_target 100 + ĐÚNG 1 bậc mốc 100
    expect(block).toContain('t.order_target IS NULL OR t.aov_target IS NULL')
    expect(block).toContain('t.kpi_target IS DISTINCT FROM 100')
    expect(block).toContain('ti.threshold_pct = 100')
    expect(ACTIVATE).toContain("v_c.metric_type NOT IN ('gmv', 'affiliate_customer_count', 'offline_order_aov')")
  })

  test('ZERO-TOUCH: guard 098/103/104/105 của GMV + Số khách còn nguyên', () => {
    for (const guard of [
      'p_actuals có store trùng lặp',
      'p_daily có (store_id, date) trùng lặp',
      'p_actuals THIẾU aggregate cho ít nhất 1 store',
      'p_daily chứa store không có aggregate trong p_actuals',
      'p_daily chứa store ngoài targets của campaign',
      'actual_value(%) <> actual_offline(%) + actual_affiliate(%)',
      'SUM(daily.affiliate_customer_count)',
      'SUM(daily.offline_order_count)',
      'đã lưu trữ — không ghi số liệu',
    ]) expect(ACTUALS, `guard mất: ${guard}`).toContain(guard)
    expect(ACTIVATE).toContain('không được 2 chiến dịch khách overlap')
    expect(ACTIVATE).toContain('thiếu số điện thoại khách hợp lệ (identity)')
    expect(ACTIVATE).toContain('target không phải OS store active')
    expect(ACTIVATE).toContain('Thiếu run id nguồn affiliate')
  })
})
