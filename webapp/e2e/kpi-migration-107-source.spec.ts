import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Mig 107 — SOURCE-TEXT contract: store_kpi_group thành TÙY CHỌN.
//
// Migration không chạy được trong CI ⇒ khóa bằng source-text (pattern 105/106).
// Điểm cốt tử của file này KHÔNG phải "có bỏ RAISE không" mà là "có VÔ TÌNH
// đánh rơi thứ gì khác khi chép lại body 106 không". Vì vậy test so SONG SONG
// hai file và đòi ĐÚNG MỘT khác biệt về mặt logic.
const read = (f: string) => fs
  .readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', f), 'utf8')
  .replace(/\r\n/g, '\n')

const sql107 = read('107_kpi_campaign_optional_store_group.sql')
const sql106 = read('106_kpi_campaign_order_aov.sql')
const exec107 = sql107.slice(0, sql107.indexOf('\nCOMMIT;'))

function fnBody(sql: string): string {
  const i = sql.indexOf('CREATE OR REPLACE FUNCTION public.rpc_replace_campaign_targets(')
  expect(i).toBeGreaterThan(-1)
  const j = sql.indexOf('END $$;', i)
  expect(j).toBeGreaterThan(i)
  return sql.slice(i, j + 7)
}
const F107 = fnBody(sql107)
const F106 = fnBody(sql106)

// Dòng code thật (bỏ comment + dòng trống) — comment khác nhau là chuyện đương nhiên.
const codeLines = (s: string) => s.split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith('--'))

test.describe('mig 107 source contract @desktop', () => {
  test('preflight đòi 106 + marker 107 + nằm trong transaction', () => {
    expect(exec107).toContain("WHERE version = '106'")
    expect(exec107).toMatch(/^BEGIN;/m)
    expect(sql107).toContain("VALUES ('107', 'kpi_campaign_optional_store_group'")
    expect(sql107).toContain('COMMIT;')
  })

  test('BỎ đúng dòng RAISE bắt buộc — và chỉ nó', () => {
    const a = codeLines(F106)
    const b = codeLines(F107)
    const removed = a.filter((l) => !b.includes(l))
    const added = b.filter((l) => !a.includes(l))
    expect(removed, `dòng bị bỏ: ${JSON.stringify(removed)}`).toEqual([
      "IF v_group IS NULL THEN RAISE EXCEPTION 'store_kpi_group là bắt buộc'; END IF;",
    ])
    expect(added, `dòng thêm mới: ${JSON.stringify(added)}`).toEqual([])
  })

  test('MỌI guard khác của 106 còn nguyên (không đánh rơi khi chép body)', () => {
    for (const guard of [
      'FOR UPDATE',                                   // row lock
      'Chiến dịch đã lưu trữ',                        // archive guard
      "v_status NOT IN ('draft', 'paused')",          // trạng thái nạp target
      "metric_type % không được hỗ trợ",              // whitelist loại
      'kpi_target do hệ thống ép = 100',              // ép điểm chuẩn hóa
      '2 cột này CHỈ dành cho Chất lượng bán hàng',   // reverse guard
      'order_target và aov_target đều bắt buộc',
      'threshold các bậc phải tăng dần',
      'Mỗi target cần ít nhất 1 bậc',
      'phải có ĐÚNG 1 bậc',                           // policy tier order_aov
      'kpi_campaign_import_runs',
      'DELETE FROM public.kpi_campaign_store_actuals',
      'DELETE FROM public.kpi_campaign_store_daily_actuals',
    ]) {
      expect(F107, `mất guard: ${guard}`).toContain(guard)
    }
  })

  test('chuẩn hóa NULL giữ nguyên: rỗng/whitespace → NULL, không phải chuỗi rỗng', () => {
    expect(F107).toContain("v_group := NULLIF(trim(coalesce(v_row->>'store_kpi_group', '')), '');")
    // và KHÔNG còn RAISE nào nhắc "bắt buộc" — xét trên DÒNG CODE, vì comment
    // trong 107 CÓ nhắc lại nguyên văn câu đó để giải thích nó đã bị bỏ.
    expect(codeLines(F107).filter((l) => l.includes('store_kpi_group là bắt buộc'))).toEqual([])
  })

  test('grants: service_role có, PUBLIC/anon/authenticated bị revoke', () => {
    expect(exec107).toContain('REVOKE ALL ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid)')
    expect(exec107).toContain('FROM PUBLIC, anon, authenticated;')
    expect(exec107).toContain('GRANT EXECUTE ON FUNCTION public.rpc_replace_campaign_targets(uuid, jsonb, text, uuid)')
    expect(exec107).toContain('TO service_role;')
    expect(F107).toContain('SECURITY DEFINER SET search_path = public')
  })

  test('KHÔNG đụng schema / bảng khác (chỉ CREATE OR REPLACE đúng 1 function)', () => {
    expect(exec107).not.toMatch(/ALTER TABLE/)
    expect(exec107).not.toMatch(/DROP (TABLE|COLUMN|CONSTRAINT)/)
    expect((exec107.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(1)
  })
})
