import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Mig 111 — SOURCE-TEXT contract: SM đọc được campaign 'ended'.
//
// Rủi ro thật của migration này KHÔNG phải "SM có đọc được ended không" mà là
// "có vô tình nới cho staff/QLCH không". Trong 075, `c.status = 'active'` nằm
// NGOÀI khối OR nên nới ở đó là mở luôn cho hai vai trò kia. Test so SONG SONG
// hai file và đòi đúng phần status thay đổi, mọi guard khác còn nguyên.
const read = (f: string) => fs
  .readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', f), 'utf8')
  .replace(/\r\n/g, '\n')

const sql111 = read('111_kpi_campaign_sm_read_ended.sql')
const sql075 = read('075_kpi_campaign_sm_access.sql')
const exec111 = sql111.slice(0, sql111.indexOf('\nCOMMIT;'))

function fnBody(sql: string): string {
  const i = sql.indexOf('CREATE OR REPLACE FUNCTION public.can_read_kpi_campaign')
  expect(i).toBeGreaterThan(-1)
  const j = sql.indexOf('$$;', i)
  expect(j).toBeGreaterThan(i)
  return sql.slice(i, j + 3)
}
const F111 = fnBody(sql111)
const F075 = fnBody(sql075)
const codeLines = (s: string) => s.split('\n').map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith('--'))

test.describe('mig 111 source contract @desktop', () => {
  test('preflight đòi 075 + marker 111 + trong transaction', () => {
    expect(exec111).toContain("WHERE version = '075'")
    expect(exec111).toMatch(/^BEGIN;/m)
    expect(sql111).toContain("VALUES ('111', 'kpi_campaign_sm_read_ended'")
    expect(sql111).toContain('COMMIT;')
  })

  test('CHỈ phần status đổi — không thêm/bớt guard nào khác', () => {
    const a = codeLines(F075)
    const b = codeLines(F111)
    // So theo SỐ LẦN xuất hiện, không theo tập hợp: dòng "AND c.status =
    // 'active'" bị DỜI CHỖ (ngoài → trong nhánh staff) chứ không bị xoá, nên
    // phép trừ tập hợp sẽ báo "không có gì đổi" và test thành vô dụng.
    const tally = (arr: string[]) => arr.reduce<Record<string, number>>(
      (m, l) => ({ ...m, [l]: (m[l] ?? 0) + 1 }), {})
    const ta = tally(a)
    const tb = tally(b)
    const delta = Object.fromEntries(
      [...new Set([...Object.keys(ta), ...Object.keys(tb)])]
        .map((k) => [k, (tb[k] ?? 0) - (ta[k] ?? 0)] as const)
        .filter(([, d]) => d !== 0))
    // ĐÚNG hai dòng mới, không dòng nào biến mất (delta âm).
    expect(delta, `thay đổi so với 075: ${JSON.stringify(delta)}`).toEqual({
      "AND c.status IN ('active', 'ended')": 1,
      'AND c.archived_at IS NULL': 1,
    })
    // Dòng status cũ vẫn tồn tại ĐÚNG MỘT lần (nó chuyển vào nhánh staff —
    // hai test dưới chứng minh nó nằm đúng chỗ).
    expect(b.filter((l) => l === "AND c.status = 'active'")).toHaveLength(1)
  })

  test('STAFF/QLCH vẫn active-only (điều kiện nằm TRONG nhánh của họ)', () => {
    // Cắt trên CODE ĐÃ BỎ COMMENT: comment giải thích nhánh SM nằm ngay trước
    // dòng `= 'sm'` và có chứa chữ "ended" — cắt trên bản thô sẽ bắt nhầm.
    const F111code = codeLines(F111).join(' | ')
    const i = F111code.indexOf("IN ('staff', 'store_manager')")
    const j = F111code.indexOf("= 'sm'")
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    const staffBranch = F111code.slice(i, j)
    expect(staffBranch, 'nhánh staff mất điều kiện active ⇒ họ đọc được ended').toContain("c.status = 'active'")
    expect(staffBranch, 'nhánh staff KHÔNG được có ended').not.toContain('ended')
  })

  test('SM: ended + chặn archived + vẫn bị giới hạn phạm vi cửa hàng', () => {
    const F111code = codeLines(F111).join(' | ')
    const smBranch = F111code.slice(F111code.indexOf("= 'sm'"))
    expect(smBranch).toContain("c.status IN ('active', 'ended')")
    expect(smBranch).toContain('c.archived_at IS NULL')
    expect(smBranch, 'mất is_sm_for_store ⇒ SM đọc được TOÀN HỆ').toContain('is_sm_for_store(t.store_id)')
  })

  test('guard chung còn nguyên; KHÔNG cấp quyền ghi, KHÔNG đổi schema', () => {
    expect(F111, 'mất is_test ⇒ campaign TEST lọt ra ngoài').toContain('c.is_test = false')
    expect(F111).toContain('SECURITY DEFINER')
    expect(F111).toContain('SET search_path = public')
    expect(F111).toContain('JOIN public.kpi_campaign_store_targets')
    expect(exec111).toContain('GRANT EXECUTE ON FUNCTION public.can_read_kpi_campaign(uuid) TO authenticated')
    for (const forbidden of ['CREATE POLICY', 'ALTER TABLE', 'DROP TABLE', 'DROP COLUMN']) {
      expect(exec111, `111 không được ${forbidden}`).not.toContain(forbidden)
    }
    expect((exec111.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(1)
  })
})
