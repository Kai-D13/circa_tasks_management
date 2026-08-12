import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Mig 106 (11/08) — SOURCE-TEXT contract cho campaign "Chất lượng bán hàng".
// Migration không chạy được trong CI ⇒ khóa bằng source-text (pattern 105).
// Trọng tâm: RPC LÀ AUTHORITY (không tin payload), 3 nhánh metric_type tường
// minh + reject loại lạ, kpi_target=100 do RPC ép, reverse guard 4 cột,
// advisory lock + overlap CHỈ với campaign đang active.
// CRLF-safe: worktree khác có thể checkout CRLF (core.autocrlf).
const sql = fs
  .readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations',
    '106_kpi_campaign_order_aov.sql'), 'utf8')
  .replace(/\r\n/g, '\n')

// Cắt riêng thân từng RPC để assert đúng phạm vi (tránh "khớp nhầm" ở RPC khác).
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
    // 3 RPC đều giữ SECURITY DEFINER + search_path cố định
    expect((sql.match(/SECURITY DEFINER SET search_path = public/g) ?? []).length).toBe(3)
    expect(sql).toContain("WHERE version = '105'")            // preflight thứ tự
    expect(sql).toContain("VALUES ('106', 'kpi_campaign_order_aov'")
  })

  test('DDL: metric_type 3 giá trị + contract cột, 4 cột target + 3 CHECK, quality_floor_pass', () => {
    expect(sql).toContain("CHECK (metric_type IN ('gmv', 'affiliate_customer_count', 'offline_order_aov'))")
    expect(sql).toContain('chk_kpi_campaigns_order_aov_contract')
    expect(sql).toContain("metric_type <> 'offline_order_aov'\n             OR (metric_offline = true AND metric_affiliate = false AND order_type = 'all')")
    for (const col of ['order_floor  bigint', 'aov_floor    numeric',
      'order_target bigint', 'aov_target   numeric']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`)
    }
    for (const c of ['chk_kcst_order_aov_positive', 'chk_kcst_order_aov_all_or_none',
      'chk_kcst_order_aov_target_ge_floor']) expect(sql).toContain(c)
    // đủ-4-hoặc-không-cột-nào: chặn target nửa cấu hình
    expect(sql).toContain('num_nonnulls(order_floor, aov_floor, order_target, aov_target) IN (0, 4)')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS quality_floor_pass boolean')
    // AOV là giá trị DẪN XUẤT — tuyệt đối không lưu thành cột
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS (actual_)?aov\b/)
  })

  test('targets RPC: ÉP kpi_target=100 · validate 4 chỉ số · reverse guard 2 loại cũ', () => {
    expect(TARGETS).toContain("v_is_aov := (v_metric_type = 'offline_order_aov')")
    // whitelist tường minh (loại lạ không nạp được target)
    expect(TARGETS).toContain("v_metric_type NOT IN ('gmv', 'affiliate_customer_count', 'offline_order_aov')")
    expect(TARGETS).toContain('v_kt := 100;')
    expect(TARGETS).toContain('kpi_target do hệ thống ép = 100')
    // 4 chỉ số bắt buộc + nguyên + thứ tự
    expect(TARGETS).toContain('order_floor/aov_floor/order_target/aov_target đều bắt buộc')
    expect(TARGETS).toContain('v_of <> floor(v_of) OR v_ot <> floor(v_ot)')   // số đơn nguyên
    expect(TARGETS).toContain('v_af <> floor(v_af) OR v_at <> floor(v_at)')   // AOV nguyên VNĐ
    expect(TARGETS).toContain('IF v_ot < v_of THEN')
    expect(TARGETS).toContain('IF v_at < v_af THEN')
    // reverse guard: gmv/customer KHÔNG được mang 4 cột
    expect(TARGETS).toContain('4 cột này CHỈ dành cho Chất lượng bán hàng')
    expect(TARGETS).toContain('order_floor, aov_floor, order_target, aov_target)')  // INSERT
    // guard 103 còn nguyên
    expect(TARGETS).toContain('kpi_target phải là số nguyên dương (số khách)')
    expect(TARGETS).toContain('store_kpi_group là bắt buộc')
    expect(TARGETS).toContain('Mỗi target cần ít nhất 1 bậc')
  })

  test('actuals RPC LÀ AUTHORITY: từ chối số dẫn xuất, tự tính 90/10, floor gác tier', () => {
    // payload chỉ được mang số THÔ
    expect(ACTUALS).toContain("v_row ?| array['actual_value', 'run_rate', 'remaining_target',")
    expect(ACTUALS).toContain('RPC tự tính, payload chỉ được gửi actual_offline + offline_order_count')
    expect(ACTUALS).toContain("NOT (v_row ? 'actual_offline')")
    // công thức chốt — trọng số 90/10 so với FLOOR
    expect(ACTUALS).toContain('0.90 * (v_ord::numeric / v_t.order_floor)')
    expect(ACTUALS).toContain('0.10 * (coalesce(v_aov, 0) / v_t.aov_floor)')
    expect(ACTUALS).toContain('0.90 * (v_t.order_target::numeric / v_t.order_floor)')
    expect(ACTUALS).toContain('0.10 * (v_t.aov_target / v_t.aov_floor)')
    expect(ACTUALS).toContain('round(v_actual_sc / v_target_sc * 100, 4)')
    // AOV weighted, NULL khi 0 đơn; 0 đơn → completion 0
    expect(ACTUALS).toContain('v_aov := CASE WHEN v_ord > 0 THEN v_offline / v_ord END;')
    expect(ACTUALS).toContain('CASE WHEN v_ord = 0 THEN 0')
    // floor: BẰNG floor là PASS (>=), và là ĐIỀU KIỆN CẦN của tier
    expect(ACTUALS).toContain('v_floor_pass := (v_ord >= v_t.order_floor')
    expect(ACTUALS).toContain('AND v_aov IS NOT NULL AND v_aov >= v_t.aov_floor)')
    expect(ACTUALS).toMatch(/IF v_floor_pass THEN\n\s+SELECT ti\.tier_order, ti\.commission_amount/)
    // kpi_target chuẩn hóa + target phải đủ chỉ số
    expect(ACTUALS).toContain('IF v_t.kpi_target <> 100 THEN')
    expect(ACTUALS).toContain('chưa cấu hình đủ 4 chỉ số Order/AOV')
    // số đơn LÀ KPI ⇒ thiếu = fail-closed (KHÁC degrade của campaign GMV)
    expect(ACTUALS).toContain('số đơn LÀ KPI, không được để trống')
    // ghi đúng ô: actual_value = run_rate = completion, remaining = 100 - completion
    expect(ACTUALS).toContain("'actual_value',          v_completion")
    expect(ACTUALS).toContain("'run_rate',              v_completion")
    expect(ACTUALS).toContain("'remaining_target',      greatest(100 - v_completion, 0)")
    expect(ACTUALS).toContain("'quality_floor_pass',    v_floor_pass")
  })

  test('actuals RPC: 3 nhánh metric_type TƯỜNG MINH + reject loại lạ + reverse guard', () => {
    expect(ACTUALS).toContain("IF v_metric_type = 'affiliate_customer_count' THEN")
    expect(ACTUALS).toContain("ELSIF v_metric_type = 'offline_order_aov' THEN")
    expect(ACTUALS).toContain("ELSIF v_metric_type = 'gmv' THEN")
    expect(ACTUALS).toContain('metric_type % không được hỗ trợ — không ghi số liệu')
    // KHÔNG còn nhánh mặc định nuốt loại lạ
    expect(ACTUALS).not.toContain('ELSE\n      -- Nhánh GMV')
    // quality_floor_pass không được lọt vào 2 loại cũ
    expect((ACTUALS.match(/v_row \? 'quality_floor_pass'/g) ?? []).length).toBe(2)
    // payload ghi = gốc + số tự tính (2 loại cũ: v_calc rỗng ⇒ zero-touch)
    expect(ACTUALS).toContain("v_calc      := '{}'::jsonb;")
    expect(ACTUALS).toContain('v_out := v_out || jsonb_build_array(v_row || v_calc);')
    expect(ACTUALS).toContain('FOR v_row IN SELECT * FROM jsonb_array_elements(v_out)')
    expect(ACTUALS).toContain('quality_floor_pass    = EXCLUDED.quality_floor_pass,')
  })

  test('activate RPC: advisory lock TRƯỚC pre-check, overlap PER-STORE chỉ với ACTIVE', () => {
    expect(ACTIVATE).toContain("PERFORM pg_advisory_xact_lock(hashtext('kpi_order_aov_activate'));")
    const i = ACTIVATE.indexOf('106: nhánh Chất lượng bán hàng')
    const j = ACTIVATE.indexOf('IF v_c.metric_affiliate IS TRUE THEN')
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    const block = ACTIVATE.slice(i, j)
    // khoá phải đứng TRƯỚC mọi truy vấn pre-check của nhánh này
    expect(block.indexOf('pg_advisory_xact_lock')).toBeLessThan(block.indexOf('SELECT count(*) INTO v_bad'))
    // overlap: CHỈ active (paused được phép chuẩn bị chiến dịch kế tiếp)
    expect(block).toContain("AND c2.status = 'active'")
    expect(block).not.toContain("c2.status IN ('active', 'paused')")
    // per-store: phải JOIN targets + giao với store của campaign đang kích hoạt
    expect(block).toContain('JOIN public.kpi_campaign_store_targets t2 ON t2.campaign_id = c2.id')
    expect(block).toContain('AND t2.store_id IN (SELECT t.store_id FROM public.kpi_campaign_store_targets t')
    expect(block).toContain('daterange(c2.start_date, c2.end_date')
    // fail-closed cấu hình trước khi cho chạy
    expect(block).toContain('t.order_floor IS NULL OR t.aov_floor IS NULL')
    expect(block).toContain('t.kpi_target IS DISTINCT FROM 100')
    // whitelist loại campaign
    expect(ACTIVATE).toContain("v_c.metric_type NOT IN ('gmv', 'affiliate_customer_count', 'offline_order_aov')")
  })

  test('ZERO-TOUCH: guard 098/103/104/105 của GMV + Số khách còn nguyên trong body mới', () => {
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
    // 103/104: overlap campaign khách + identity phone vẫn nguyên
    expect(ACTIVATE).toContain('không được 2 chiến dịch khách overlap')
    expect(ACTIVATE).toContain('thiếu số điện thoại khách hợp lệ (identity)')
    expect(ACTIVATE).toContain('target không phải OS store active')
    expect(ACTIVATE).toContain('Thiếu run id nguồn affiliate')
  })

  test('r1.1: Net âm HỢP LỆ · actual_offline/daily null bị chặn · AOV VNĐ nguyên khóa ở DB', () => {
    // P1#1 — guard chặn Net Revenue âm đã BỎ (hoàn/điều chỉnh là hợp lệ)
    expect(ACTUALS).not.toContain('có Net Revenue âm')
    expect(ACTUALS).toContain('Net Revenue ÂM là HỢP LỆ')
    // P1#2 — thiếu key HOẶC null đều bị từ chối (chỉ check key thì null → 0)
    expect(ACTUALS).toContain("NOT (v_row ? 'actual_offline') OR v_row->>'actual_offline' IS NULL")
    expect(ACTUALS).toContain("count(*) FILTER (WHERE e->>'gmv' IS NULL OR e->>'offline_order_count' IS NULL)")
    expect(ACTUALS).toContain('dòng daily thiếu gmv hoặc offline_order_count (null)')
    // P1#3 — AOV nguyên VNĐ khóa ở BẢNG, không chỉ ở RPC import
    expect(sql).toContain('chk_kcst_aov_vnd_integer')
    expect(sql).toContain('aov_floor  = trunc(aov_floor)')
    expect(sql).toContain('aov_target = trunc(aov_target)')
  })
})
