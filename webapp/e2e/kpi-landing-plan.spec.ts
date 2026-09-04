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
  // 112.3: counter NULL của nguồn Offline. Thiếu field = query/schema đã đổi
  // ⇒ fixture phải phản ánh đúng query production.
  offline_revenue_null_count: '0',
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

  // ── 112.3 (audit P1#2): NULL doanh thu Offline ─────────────────────────
  // Không thể suy ra từ `actual`: SUM() của BigQuery bỏ qua NULL và coerceNum
  // coi NULL là 0đ hợp lệ (r2.1) ⇒ thiếu dữ liệu sẽ lặng lẽ thành 0đ trên màn
  // tiền. Counter là đường DUY NHẤT nhìn thấy.
  test('112.3: chỉ có row NULL (actual NULL, counter=1) → ok=false, KHÔNG ghi 0đ', () => {
    const rows = fullRows()
    rows[0] = row('day', 'POS0009', { actual: null, offline_revenue_null_count: '1' })
    const p = buildKpiUpsertPlan(rows, STORES, NOW)
    expect(p.ok, 'nguồn thiếu doanh thu mà vẫn ok = ghi 0đ oan').toBe(false)
    expect(p.rowErrors.join(' | ')).toContain('offline_revenue_null_count=1')
    // Cổng atomic nằm ở tầng IO: ok=false ⇒ aggregateAndUpsertKpi KHÔNG upsert
    // dòng nào. Ở đây chỉ cần chắc dòng hỏng không lọt vào payload dưới dạng 0đ.
    expect(p.payload.some((r) => r.store_id === 's1' && r.period_type === 'day'),
      'row NULL bị biến thành 0đ trong payload').toBe(false)
  })

  test('112.3: 1 row HỢP LỆ + 1 row NULL cùng khoá → ok=false (fail-open cũ: lọc NULL ở WHERE thì raw_row_count vẫn =1)', () => {
    // Đây chính là đường fail-open mà bản 112.2 còn hở: nếu query lọc
    // `offline_net_revenue IS NOT NULL` TRƯỚC GROUP BY thì row NULL biến mất,
    // COUNT(*) ra 1 và dữ liệu lỗi trôi qua như sạch. Giữ row NULL đến
    // aggregate ⇒ raw_row_count=2 VÀ counter=1, chặn ở cả hai lớp.
    const rows = fullRows()
    rows[0] = row('day', 'POS0009', { raw_row_count: '2', offline_revenue_null_count: '1' })
    const p = buildKpiUpsertPlan(rows, STORES, NOW)
    expect(p.ok).toBe(false)
    expect(p.payload.some((r) => r.store_id === 's1' && r.period_type === 'day')).toBe(false)
  })

  test('112.3: thiếu HẲN counter (query/schema drift) → ok=false', () => {
    const rows = fullRows()
    const broken = row('day', 'POS0009') as Record<string, unknown>
    delete broken.offline_revenue_null_count
    rows[0] = broken as typeof rows[0]
    const p = buildKpiUpsertPlan(rows, STORES, NOW)
    expect(p.ok).toBe(false)
    expect(p.rowErrors.join(' | ')).toContain('offline_revenue_null_count=undefined')
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

  test('r2.1: actual/target NULL → 0đ HỢP LỆ; non-null KHÔNG parse được → rowErrors + ok=false (không âm thầm thành 0đ)', () => {
    const okNull = buildKpiUpsertPlan(fullRows().map((r) => ({ ...r, actual: null, target: null })), STORES, NOW)
    expect(okNull.ok).toBe(true)
    expect(okNull.payload[0].actual).toBe(0)
    expect(okNull.payload[0].status).toBeNull() // target 0 → Chưa có mục tiêu
    const badActual = buildKpiUpsertPlan([...fullRows().slice(1), row('day', 'POS0009', { actual: 'abc' })], STORES, NOW)
    expect(badActual.ok).toBe(false)
    expect(badActual.rowErrors.some((e) => e.includes('actual không parse được'))).toBe(true)
    const badTarget = buildKpiUpsertPlan([...fullRows().slice(1), row('day', 'POS0009', { target: '12,5' })], STORES, NOW)
    expect(badTarget.ok).toBe(false)
    expect(badTarget.rowErrors.some((e) => e.includes('target không parse được'))).toBe(true)
  })

  test('r2.1: period_end NULL → fallback period_start hợp lệ; non-null SAI FORMAT → rowErrors + ok=false', () => {
    const nullEnd = buildKpiUpsertPlan(fullRows().map((r) => ({ ...r, period_end: null })), STORES, NOW)
    expect(nullEnd.ok).toBe(true)
    expect(nullEnd.payload[0].period_end).toBe(nullEnd.payload[0].period_start)
    const badEnd = buildKpiUpsertPlan([...fullRows().slice(1), row('day', 'POS0009', { period_end: '31/08/2026' })], STORES, NOW)
    expect(badEnd.ok).toBe(false)
    expect(badEnd.rowErrors.some((e) => e.includes('period_end không hợp lệ'))).toBe(true)
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
