import { test, expect } from '@playwright/test'
import { buildKpiUpsertPlan, REQUIRED_GRAINS, type KpiStoreRef } from '../lib/targets/kpiPlan'

// BQ-V2 r2 (audit P1#1+#2) — unit gate ATOMIC LANDING PLAN: mọi active OS
// store phải đủ ĐÚNG 1 row DAY + 1 row MONTH; thiếu/trùng/unmatched/hỏng bất
// kỳ → ok=false (caller không ghi row nào, cron 422 — hết "xanh một phần").
// WEEK vắng dữ liệu KHÔNG phải lỗi (grain chưa bật).

const STORES: KpiStoreRef[] = [
  { id: 's1', name: 'CIRCA CENTRAL', code: 'POS0009' },
  { id: 's2', name: 'CIRCA URBAN', code: 'POS0011' },
  { id: 's3', name: 'CIRCA AKARI', code: 'POS0080' },
]
const NOW = '2026-08-05T10:00:00.000Z'

const row = (grain: string, pos: string, over: Record<string, unknown> = {}) => ({
  period_type: grain,
  period_start: grain === 'month' ? '2026-08-01' : '2026-08-05',
  period_end: grain === 'month' ? '2026-08-31' : '2026-08-05',
  pos_code: pos,
  pos_name: null,
  actual: '1000000',
  target: '2000000',
  raw_row_count: '1',
  ...over,
})
const fullRows = () => STORES.flatMap((s) => [row('day', s.code!), row('month', s.code!)])

test.describe('kpi landing atomic plan @desktop', () => {
  test('ĐỦ N store × (DAY + MONTH) → ok=true, payload đủ, week=0 KHÔNG phải lỗi, run_rate/status đúng', () => {
    const p = buildKpiUpsertPlan(fullRows(), STORES, NOW)
    expect(p.ok).toBe(true)
    expect(p.payload).toHaveLength(6)
    expect(p.periods).toEqual({ day: 3, week: 0, month: 3 })
    expect(p.missing).toEqual([])
    expect(p.duplicates).toEqual([])
    const r0 = p.payload[0]
    expect(r0.run_rate).toBe(50)
    expect(r0.status).toBe('Not Achieved')
    expect(r0.remaining_target).toBe(1_000_000)
    expect(REQUIRED_GRAINS).toEqual(['day', 'month']) // week thêm khi BI có dữ liệu
  })

  test('P1#2: thiếu 1 row DAY của 1 store → ok=false, missing nêu đích danh, các store khác KHÔNG được ghi lẻ', () => {
    const p = buildKpiUpsertPlan(fullRows().filter((r) => !(r.pos_code === 'POS0011' && r.period_type === 'day')), STORES, NOW)
    expect(p.ok).toBe(false)
    expect(p.missing).toEqual(['POS0011/day'])
  })

  test('P1#2: thiếu 1 row MONTH → ok=false; store BIẾN MẤT hoàn toàn → missing đủ cả 2 grain', () => {
    const missMonth = buildKpiUpsertPlan(fullRows().filter((r) => !(r.pos_code === 'POS0080' && r.period_type === 'month')), STORES, NOW)
    expect(missMonth.ok).toBe(false)
    expect(missMonth.missing).toEqual(['POS0080/month'])
    const missStore = buildKpiUpsertPlan(fullRows().filter((r) => r.pos_code !== 'POS0009'), STORES, NOW)
    expect(missStore.ok).toBe(false)
    expect(missStore.missing).toEqual(expect.arrayContaining(['POS0009/day', 'POS0009/month']))
  })

  test('P1#1: nguồn TRÙNG dòng (raw_row_count=2) → ok=false, duplicates nêu rõ — không ghi đè theo thứ tự', () => {
    const rows = fullRows()
    rows[0] = row('day', 'POS0009', { raw_row_count: '2' })
    const p = buildKpiUpsertPlan(rows, STORES, NOW)
    expect(p.ok).toBe(false)
    expect(p.duplicates.some((d) => d.includes('POS0009') && d.includes('2 dòng nguồn'))).toBe(true)
    // row bị loại → store đó cũng thiếu coverage (2 tín hiệu cùng chặn)
    expect(p.missing).toContain('POS0009/day')
  })

  test('2 POS khác nhau map về CÙNG store (pos_name fallback) → duplicates, ok=false', () => {
    const rows = [...fullRows(), row('day', null as unknown as string, { pos_code: null, pos_name: 'CIRCA CENTRAL' })]
    const p = buildKpiUpsertPlan(rows, STORES, NOW)
    expect(p.ok).toBe(false)
    expect(p.duplicates.some((d) => d.includes('cùng store'))).toBe(true)
  })

  test('row UNMATCHED (store lạ/không active) → ok=false — store ngoài tập active OS không được lọt im lặng', () => {
    const p = buildKpiUpsertPlan([...fullRows(), row('day', 'POS9999', { pos_name: 'STORE LẠ' })], STORES, NOW)
    expect(p.ok).toBe(false)
    expect(p.unmatched).toEqual(['STORE LẠ (POS9999)'])
  })

  test('row HỎNG (period_start sai) → rowErrors + ok=false; target=0 hợp lệ → status null "Chưa có mục tiêu"', () => {
    const bad = buildKpiUpsertPlan([...fullRows(), row('day', 'POS0009', { period_start: 'not-a-date' })], STORES, NOW)
    expect(bad.ok).toBe(false)
    expect(bad.rowErrors.length).toBeGreaterThan(0)
    const zeroTarget = buildKpiUpsertPlan(
      fullRows().map((r) => ({ ...r, target: '0' })), STORES, NOW)
    expect(zeroTarget.ok).toBe(true)
    expect(zeroTarget.payload[0].status).toBeNull()
    expect(zeroTarget.payload[0].run_rate).toBeNull()
  })
})
