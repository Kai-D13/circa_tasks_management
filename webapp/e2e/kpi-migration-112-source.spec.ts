import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Mig 112 — SOURCE-TEXT contract: thưởng thêm theo ngưỡng số đơn (campaign gmv).
//
// Migration không chạy được trong CI ⇒ khóa bằng source-text (pattern 105/106/107).
// Điểm cốt tử: thân 2 RPC được TRÍCH NGUYÊN VĂN từ 107 (targets) và 106
// (actuals) rồi CHỈ CHÈN THÊM. Test đòi mọi dòng code cũ còn nguyên VÀ ĐÚNG THỨ
// TỰ (dãy con) — "có mặt ở đâu đó" là chưa đủ, vì một guard bị dời ra sau lệnh
// ghi thì vẫn "có mặt" nhưng đã mất tác dụng.
const read = (f: string) => fs
  .readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', f), 'utf8')
  .replace(/\r\n/g, '\n')

const sql112 = read('112_kpi_campaign_order_bonus.sql')
const sql107 = read('107_kpi_campaign_optional_store_group.sql')
const sql106 = read('106_kpi_campaign_order_aov.sql')
const exec112 = sql112.slice(0, sql112.indexOf('\nCOMMIT;'))

function fnBody(sql: string, name: string): string {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(i, `không tìm thấy ${name}`).toBeGreaterThan(-1)
  const j = sql.indexOf('END $$;', i)
  expect(j).toBeGreaterThan(i)
  return sql.slice(i, j + 7)
}
const T112 = fnBody(sql112, 'rpc_replace_campaign_targets')
const T107 = fnBody(sql107, 'rpc_replace_campaign_targets')
const A112 = fnBody(sql112, 'rpc_replace_campaign_actuals')
const A106 = fnBody(sql106, 'rpc_replace_campaign_actuals')

// Dòng code thật (bỏ comment + dòng trống).
const codeLines = (s: string) => s.split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith('--'))

// Trả về dòng ĐẦU TIÊN của `a` không xuất hiện theo đúng thứ tự trong `b`
// (null = `a` là dãy con của `b` ⇒ chỉ có chèn thêm, không mất/đảo dòng nào).
function firstMissingInOrder(a: string[], b: string[]): string | null {
  let j = 0
  for (const line of a) {
    while (j < b.length && b[j] !== line) j++
    if (j === b.length) return line
    j++
  }
  return null
}

test.describe('mig 112 source contract @desktop', () => {
  test('preflight đòi 111 + marker 112 + nằm trong transaction', () => {
    expect(exec112).toContain("WHERE version = '111'")
    expect(exec112).toMatch(/^BEGIN;/m)
    expect(sql112).toContain("VALUES ('112', 'kpi_campaign_order_bonus'")
    expect(sql112).toContain('COMMIT;')
  })

  test('targets: thân 107 còn NGUYÊN VĂN và đúng thứ tự — chỉ có chèn thêm', () => {
    const miss = firstMissingInOrder(codeLines(T107), codeLines(T112))
    expect(miss, `dòng 107 bị mất/đảo thứ tự: ${miss}`).toBeNull()
  })

  test('actuals: thân 106 còn NGUYÊN VĂN và đúng thứ tự — chỉ có chèn thêm', () => {
    const miss = firstMissingInOrder(codeLines(A106), codeLines(A112))
    expect(miss, `dòng 106 bị mất/đảo thứ tự: ${miss}`).toBeNull()
  })

  test('targets: đọc 2 cột mới, chỉ cho campaign gmv, đủ cặp, kiểu hợp lệ', () => {
    for (const s of [
      "v_mot := NULLIF(v_row->>'minimum_order_target', '')::numeric;",
      "v_bps := NULLIF(v_row->>'order_bonus_per_staff', '')::numeric;",
      "IF v_metric_type <> 'gmv' THEN",
      'thưởng thêm theo số đơn CHỈ dành cho campaign Doanh số',
      'phải có ĐỦ minimum_order_target và order_bonus_per_staff',
      'IF v_mot <= 0 OR v_mot <> floor(v_mot) THEN',
    ]) expect(T112, `thiếu: ${s}`).toContain(s)
  })

  test('113.5 (P1#2): mức thưởng KHOÁ CỨNG 200000 — mọi giá trị khác bị RAISE', () => {
    expect(T112).toContain('IF v_bps <> 200000 THEN')
    expect(T112).toContain('cố định 200000')
    // Không còn kiểm "nguyên > 0" lỏng lẻo cho tiền thưởng.
    expect(T112).not.toContain('IF v_bps <= 0 OR v_bps <> floor(v_bps) THEN')
  })

  test('113.5 (P1#3): nạp ngưỡng đòi campaign bật CẢ Offline lẫn Affiliate; cờ đọc bằng SELECT riêng', () => {
    expect(T112).toContain('SELECT metric_offline, metric_affiliate INTO v_m_offline, v_m_affiliate')
    expect(T112).toContain('IF NOT (coalesce(v_m_offline, false) AND coalesce(v_m_affiliate, false)) THEN')
    expect(T112).toContain('bật CẢ Doanh thu thuần tại cửa hàng lẫn Doanh thu Affiliate')
    // Guard đứng TRONG khối "có ô thưởng" (sau check đủ cặp), TRƯỚC INSERT.
    const g = T112.indexOf('IF NOT (coalesce(v_m_offline, false)')
    expect(g).toBeGreaterThan(T112.indexOf('phải có ĐỦ minimum_order_target'))
    expect(g).toBeLessThan(T112.indexOf('INSERT INTO public.kpi_campaign_store_targets'))
  })

  test('targets: file lẫn lộn (có dòng có, có dòng trống) → RAISE cả file', () => {
    expect(T112).toContain('IF v_bonus_rows > 0 AND v_bonus_rows <> v_count THEN')
    expect(T112).toContain('phải áp dụng cho MỌI cửa hàng trong file')
    // Kiểm SAU vòng lặp (khi đã đếm đủ), TRƯỚC khi ghi import_runs.
    const guard = T112.indexOf('IF v_bonus_rows > 0 AND v_bonus_rows <> v_count THEN')
    expect(guard).toBeGreaterThan(T112.lastIndexOf('END LOOP;'))
    expect(guard).toBeLessThan(T112.indexOf('INSERT INTO public.kpi_campaign_import_runs'))
  })

  test('targets: INSERT ghi 2 cột mới, cột và giá trị cùng thứ tự', () => {
    // Chèn TRƯỚC order_target: chèn sau sẽ phải sửa dòng đóng ")" và dấu phẩy
    // rơi vào trong comment "-- 106: ..." ⇒ INSERT hỏng cú pháp (đã xảy ra ở
    // bản nháp đầu — chính test dãy con ở trên bắt được).
    const cols = T112.indexOf('minimum_order_target, order_bonus_per_staff,')
    expect(cols).toBeGreaterThan(-1)
    expect(cols).toBeLessThan(T112.indexOf('order_target, aov_target)'))
    const vals = T112.indexOf('v_mot::integer, v_bps,')
    expect(vals).toBeGreaterThan(-1)
    expect(vals).toBeLessThan(T112.indexOf('v_ot::bigint, v_at'))
    // Chữ ký của lỗi đã gặp: phần CODE thiếu dấu phẩy mà comment cuối dòng lại
    // kết thúc bằng dấu phẩy (dấu phẩy bị nuốt vào comment). CHỈ soi DÒNG MỚI
    // CHÈN: dòng cũ đã được test dãy con chứng minh giống hệt SQL đang chạy
    // production (và 106 có comment tự nhiên kết thúc bằng dấu phẩy, hợp lệ).
    const swallowed = (l: string) => {
      const c = l.indexOf('--')
      const code = c > 0 ? l.slice(0, c).trim() : ''
      return code.length > 0 && l.slice(c).trimEnd().endsWith(',') && !/[,(]$/.test(code)
    }
    // Tự kiểm: heuristic PHẢI bắt được đúng dòng lỗi của bản nháp đầu.
    expect(swallowed('      v_ot::bigint, v_at   -- 106: NULL cho gmv/customer,')).toBe(true)
    const oldT = new Set(T107.split('\n').map((l) => l.trim()))
    const oldA = new Set(A106.split('\n').map((l) => l.trim()))
    const added = [
      ...T112.split('\n').filter((l) => !oldT.has(l.trim())),
      ...A112.split('\n').filter((l) => !oldA.has(l.trim())),
    ]
    expect(added.length).toBeGreaterThan(0)
    for (const l of added) expect(swallowed(l), `dấu phẩy bị nuốt vào comment: ${l}`).toBe(false)
  })

  test('actuals: 2 số thưởng thêm do RPC TỰ TÍNH — payload mang lên bị từ chối', () => {
    expect(A112).toContain("IF v_row ?| array['bonus_order_count', 'order_bonus_achieved'] THEN")
    expect(A112).toContain('2 số này RPC tự tính từ target, payload không được mang')
    // Chặn phải đứng TRƯỚC khi nhánh theo loại campaign bắt đầu.
    expect(A112.indexOf("array['bonus_order_count', 'order_bonus_achieved']"))
      .toBeLessThan(A112.indexOf("IF v_metric_type = 'affiliate_customer_count' THEN"))
  })

  test('actuals: số đơn Affiliate chỉ campaign gmv có metric Affiliate bật, không âm', () => {
    expect(A112).toContain("v_aff_ord   := (v_row->>'affiliate_order_count')::bigint;")
    expect(A112).toContain("IF v_metric_type <> 'gmv' AND v_aff_ord IS NOT NULL THEN")
    expect(A112).toContain('IF NOT v_m_affiliate AND v_aff_ord IS NOT NULL THEN')
    expect(A112).toContain('IF v_aff_ord IS NOT NULL AND v_aff_ord < 0 THEN')
  })

  test('actuals: công thức thưởng = doanh thu >= target VÀ tổng đơn >= ngưỡng; thiếu dữ liệu → NULL', () => {
    // 113.5: cả hai metric BẮT BUỘC bật ⇒ tổng = Offline + Affiliate thẳng
    // (NULL lan truyền qua phép cộng); thiếu metric → RAISE, không tính nửa số.
    expect(A112).toContain('IF NOT (v_m_offline AND v_m_affiliate) THEN')
    expect(A112).toContain('tổng đơn phải gồm CẢ Offline + Affiliate')
    expect(A112).toContain('v_bonus_cnt := v_ord + v_aff_ord;')
    expect(A112).not.toContain('CASE WHEN v_m_offline   THEN v_ord     ELSE 0 END')
    expect(A112).toContain("'order_bonus_achieved', CASE WHEN v_bonus_cnt IS NULL THEN NULL")
    expect(A112).toContain('ELSE (v_value >= v_bonus_t.kpi_target')
    expect(A112).toContain('AND v_bonus_cnt >= v_bonus_t.minimum_order_target) END')
    // Tính TRONG nhánh gmv — sau check tổng tiền của nhánh đó, trước nhánh fail-closed.
    const calc = A112.indexOf('v_bonus_cnt := v_ord + v_aff_ord;')
    expect(calc).toBeGreaterThan(A112.indexOf("ELSIF v_metric_type = 'gmv' THEN"))
    expect(calc).toBeLessThan(A112.indexOf('-- 106: FAIL-CLOSED'))
  })

  test('actuals: INSERT + ON CONFLICT ghi đủ 3 cột mới', () => {
    expect(A112).toContain('affiliate_order_count, bonus_order_count, order_bonus_achieved,')
    expect(A112).toContain("(v_row->>'affiliate_order_count')::integer,")
    expect(A112).toContain("(v_row->>'bonus_order_count')::integer,")
    expect(A112).toContain("(v_row->>'order_bonus_achieved')::boolean,")
    for (const c of ['affiliate_order_count', 'bonus_order_count', 'order_bonus_achieved']) {
      expect(A112).toMatch(new RegExp(`${c}\\s+= EXCLUDED\\.${c},`))
    }
  })

  test('schema: 5 cột ADD IF NOT EXISTS + 2 CHECK có tên, idempotent', () => {
    expect(exec112).toContain('ADD COLUMN IF NOT EXISTS minimum_order_target  integer')
    expect(exec112).toContain('ADD COLUMN IF NOT EXISTS order_bonus_per_staff numeric')
    expect(exec112).toContain('ADD COLUMN IF NOT EXISTS affiliate_order_count integer')
    expect(exec112).toContain('ADD COLUMN IF NOT EXISTS bonus_order_count     integer')
    expect(exec112).toContain('ADD COLUMN IF NOT EXISTS order_bonus_achieved  boolean')
    expect(exec112).toContain("conname = 'chk_kcst_order_bonus'")
    expect(exec112).toContain('num_nonnulls(minimum_order_target, order_bonus_per_staff) IN (0, 2)')
    expect(exec112).toContain("conname = 'chk_kcsa_order_bonus'")
    expect(exec112).toContain('order_bonus_achieved IS NULL OR bonus_order_count IS NOT NULL')
    // Phần chạy KHÔNG xoá gì (rollback chỉ nằm trong comment đầu file).
    expect(exec112.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'))
      .not.toMatch(/DROP (TABLE|COLUMN|CONSTRAINT)/)
  })

  test('grants: service_role có, PUBLIC/anon/authenticated bị revoke — CẢ 2 RPC', () => {
    for (const sig of [
      'public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid)',
      'public.rpc_replace_campaign_actuals(uuid, jsonb, jsonb)',
    ]) {
      expect(exec112).toContain(`REVOKE ALL ON FUNCTION ${sig}`)
      expect(exec112).toContain(`GRANT EXECUTE ON FUNCTION ${sig}`)
    }
    expect((exec112.match(/FROM PUBLIC, anon, authenticated;/g) ?? []).length).toBe(2)
    expect((exec112.match(/TO service_role;/g) ?? []).length).toBe(2)
    expect(T112).toContain('SECURITY DEFINER SET search_path = public')
    expect(A112).toContain('SECURITY DEFINER SET search_path = public')
    expect((exec112.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(2)
  })
})
