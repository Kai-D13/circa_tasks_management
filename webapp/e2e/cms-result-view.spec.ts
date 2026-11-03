import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  cmsActualQuantityText, cmsAggregateByProduct, cmsAggregateByStaff, cmsFractionUnits, cmsResultState, cmsResultSummary,
  cmsTotalAmount, cmsWhatIf, parseCmsResultHeader, parseCmsResultLines, parseCmsResultRows, CmsResultDtoError,
} from '../lib/cms/resultView'
import { formatCmsDecimal } from '../lib/cms/decimal'

// CMS P2-c — DTO đọc kết quả (RPC 122) + view-model (lib/cms/resultView.ts): parse fail-closed, tổng hợp cộng số engine
// (không áp lại bậc), "Nếu bán thêm" dùng hàm bậc engine, trạng thái dữ liệu cho UI. Không DB.

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = uid(1), B = uid(2), C = uid(3), S1 = uid(11), S2 = uid(12), PP1 = uid(21), PP2 = uid(22), RUN = uid(31), PROG = uid(41)
const row = (o: Record<string, unknown>) => ({
  user_id: A, store_id: S1, program_product_id: PP1, product_id: '900001', gmv_basis: 'none', base_quantity: '120', per_unit: '24',
  cms_quantity: '5', rewarded_quantity: '4', cap_quantity: '4', at_cap: true, gmv_amount: '120000', gate_gmv: null, target_gmv: null,
  gate_met: true, gate_met_at: null, potential_amount: '70000', amount_vnd: '70000', line_count: 3, ...o,
})
const ROWS = {
  run_id: RUN,
  results: [
    row({}),
    row({ user_id: B, base_quantity: '30', cms_quantity: '1', rewarded_quantity: '1', at_cap: false, potential_amount: '15000', amount_vnd: '15000', line_count: 1 }),
    row({ user_id: C, store_id: S2, program_product_id: PP2, product_id: '900002', gmv_basis: 'product', base_quantity: '2', per_unit: '1',
      cms_quantity: '2', rewarded_quantity: '2', cap_quantity: null, at_cap: false, gmv_amount: '60000', gate_gmv: '60000', target_gmv: '100000',
      gate_met: false, potential_amount: '10000', amount_vnd: '0', line_count: 2 }),
  ],
  catalog: [],
  users: [{ id: A, full_name: 'Dược sĩ A', store_id: S1 }, { id: B, full_name: 'Dược sĩ B', store_id: S1 }, { id: C, full_name: 'Dược sĩ C', store_id: S2 }],
}

test.describe('CMS P2-c — resultView @desktop', () => {
  test('parse rows: đúng shape; số phải là chuỗi (float / thiếu / sai dạng ⇒ lỗi, không 0 giả)', () => {
    const r = parseCmsResultRows(ROWS)
    expect(r.runId).toBe(RUN)
    expect(r.results).toHaveLength(3)
    for (const bad of [
      { ...ROWS, results: [row({ amount_vnd: 70000 })] }, { ...ROWS, results: [row({ amount_vnd: '7e4' })] },
      { ...ROWS, results: [row({ base_quantity: '1.0000000001' })] }, { ...ROWS, results: [row({ gmv_basis: 'flat' })] },
      { ...ROWS, results: [row({ gate_met_at: '2026-11-01T00:00:00Z' })] }, { ...ROWS, results: 'x' }, null,
    ]) expect(() => parseCmsResultRows(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow(CmsResultDtoError)
    expect(parseCmsResultRows({ run_id: null, results: [], catalog: [], users: [] }).runId).toBeNull()
  })

  test('tổng hợp: Σ theo SP = Σ theo dược sĩ = tổng (lệch 0đ); QLCH / SM cộng cá nhân, không áp lại bậc', () => {
    const r = parseCmsResultRows(ROWS)
    const total = cmsTotalAmount(r.results)
    expect(total).toBe(BigInt(85000))
    const byP = cmsAggregateByProduct(r.results)
    const byS = cmsAggregateByStaff(r.results, r.users)
    expect(byP.reduce((s, x) => s + x.amountVnd, BigInt(0))).toBe(total)
    expect(byS.reduce((s, x) => s + x.amountVnd, BigInt(0))).toBe(total)
    const p1 = byP.find((x) => x.programProductId === PP1)!
    // A 120 + B 30 = 150 viên; nếu áp lại bậc trên tổng: Q=6 ⇒ trần 4 ⇒ 70.000 ≠ 85.000 — phải giữ 85.000 (CMS-Q1).
    expect([formatCmsDecimal(p1.baseUnits), p1.cmsQuantity, p1.amountVnd, p1.staffWithSales, p1.staffAchieved]).toEqual(['150', BigInt(6), BigInt(85000), 2, 2])
    expect(byS.map((x) => x.userId)).toEqual([A, B, C])          // xếp theo tiền giảm dần
    expect(byS.find((x) => x.userId === C)!.productsWithCms).toBe(0)
    const sum = cmsResultSummary(r.results, { productIds: ['900001', '900002', '900003'], eligibleStaffIds: [A, B, C, uid(4)] })
    expect(sum).toMatchObject({ amountVnd: BigInt(85000), productsWithCms: 1, productCount: 3, pharmacistsWithCms: 2, pharmacistDenominator: 4, turnsWithSales: 3, turnsAchieved: 2 })
  })

  test('phần lẻ đang cộng dồn + số lượng thực tế hiển thị', () => {
    expect(formatCmsDecimal(cmsFractionUnits({ baseQuantity: '130', perUnit: '24', cmsQuantity: '5' }))).toBe('10')
    expect(formatCmsDecimal(cmsFractionUnits({ baseQuantity: '-3', perUnit: '24', cmsQuantity: '0' }))).toBe('0')
    expect(cmsActualQuantityText('130', '24')).toBe('5,41')
    expect(cmsActualQuantityText('48', '24')).toBe('2')
    expect(cmsActualQuantityText('1.5', '0.5')).toBe('3')
  })

  test('"Nếu bán thêm": cùng hàm bậc engine, vượt trần không thêm CMS', () => {
    const tiers = [{ from: 1, to: 2, amount: '15000' }, { from: 3, to: 4, amount: '20000' }]
    expect(cmsWhatIf({ baseQuantity: '30', perUnit: '24', tiers, extraUnits: 1 })).toEqual({ amountNowVnd: BigInt(15000), amountAfterVnd: BigInt(30000), deltaVnd: BigInt(15000) })
    expect(cmsWhatIf({ baseQuantity: '48', perUnit: '24', tiers, extraUnits: 5 }).deltaVnd).toBe(BigInt(40000))   // 2 → 7 nhưng trần 4
    expect(cmsWhatIf({ baseQuantity: '96', perUnit: '24', tiers, extraUnits: 3 }).deltaVnd).toBe(BigInt(0))
    expect(cmsWhatIf({ baseQuantity: '0', perUnit: '24', tiers: [{ from: 1, to: null, amount: '10000' }], extraUnits: 2 }).deltaVnd).toBe(BigInt(20000))
  })

  test('header: trạng thái dữ liệu (chưa có / ok / giữ bản cũ / cấu hình đổi)', () => {
    const base = { program_id: PROG, config_version: 4, viewer: 'staff', recent_runs: null,
      run: { id: RUN, config_version: 4, published_at: '2026-11-02T01:00:00.000000Z', source_max_updated_at: null, started_at: '2026-11-02T00:59:00.000000Z' },
      last_attempt: { status: 'ok', started_at: '2026-11-02T00:59:00.000000Z', finished_at: '2026-11-02T01:00:00.000000Z', is_current: true } }
    expect(cmsResultState(parseCmsResultHeader(base))).toBe('ok')
    expect(cmsResultState(parseCmsResultHeader({ ...base, run: null, last_attempt: null }))).toBe('none')
    expect(cmsResultState(parseCmsResultHeader({ ...base, last_attempt: { ...base.last_attempt, status: 'held', is_current: false } }))).toBe('held_old')
    expect(cmsResultState(parseCmsResultHeader({ ...base, config_version: 5 }))).toBe('config_pending')
    expect(() => parseCmsResultHeader({ ...base, viewer: 'root' })).toThrow(CmsResultDtoError)
    expect(parseCmsResultHeader(base).run!.amountVnd).toBeNull()   // staff: không có tổng chương trình
  })

  test('lines: con trỏ seq; trạng thái lạ / tiền dạng số ⇒ lỗi', () => {
    const line = { seq: 3, order_line_id: 'L1', order_code: 'C1', product_id: '900001', program_product_id: PP1, user_id: A, store_id: S1,
      pos_code: null, completed_at: '2026-11-01T01:00:00.000001Z', quantity_raw: '1', uom_raw: 'Hộp', base_quantity: '-1', gmv_amount: '-20000',
      base_before: '3', base_after: '2', qty_before: '3', qty_after: '2', amount_vnd: '-5000', status: 'ADJUSTMENT' }
    const p = parseCmsResultLines({ run_id: RUN, rows: [line], next_after_seq: 3 })
    expect([p.nextAfterSeq, p.rows[0].amountVnd, p.rows[0].status]).toEqual([3, '-5000', 'ADJUSTMENT'])
    expect(() => parseCmsResultLines({ run_id: RUN, rows: [{ ...line, status: 'PAID' }], next_after_seq: null })).toThrow(CmsResultDtoError)
    expect(() => parseCmsResultLines({ run_id: RUN, rows: [{ ...line, amount_vnd: -5000 }], next_after_seq: null })).toThrow(CmsResultDtoError)
    expect(() => parseCmsResultLines({ run_id: RUN, rows: [], next_after_seq: -1 })).toThrow(CmsResultDtoError)
  })

  test('server/results.ts: log chỉ mã cố định — không message DB / transport / parse (PM 03/11 R3)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'cms', 'server', 'results.ts'), 'utf8').replace(/\r\n/g, '\n')
    const logs = src.split('\n').filter((l) => /console\.(error|warn|log|info|debug)\(/.test(l))
      .map((l) => l.trim().replace(/^if \(code === 'QUERY_FAILED'\) /, ''))
    // Đúng 3 dòng log, mỗi dòng là một chuỗi mẫu cố định (tên hàm RPC là hằng trong code); không đối số thứ hai.
    expect(logs).toEqual([
      'console.error(`[cms-results] ${fn} QUERY_FAILED sqlstate=${cmsSafeErrorCode(error.code)}`)',
      'console.error(`[cms-results] ${fn} TRANSPORT_FAILED`)',
      'console.error(`[cms-results] ${fn} DTO_INVALID`)',
    ])
    // message DB chỉ dùng để ánh xạ mã (mapError), không đi vào log; không giữ đối tượng lỗi transport / parse.
    expect(src.match(/\.message\b/g)?.length).toBe(1)
    expect(src).toContain('const code = mapError(error.message)')
    expect(src).not.toMatch(/catch \(e\)|e instanceof Error/)
    // Mã an toàn: chỉ SQLSTATE 5 ký tự / PGRST + 3 số.
    const re = /const SAFE_CODE_RE = \/(.+)\/\n/.exec(src)
    expect(re, 'SAFE_CODE_RE').not.toBeNull()
    const safe = new RegExp(re![1])
    expect(['42501', 'P0001', '57014', 'PGRST116'].every((c) => safe.test(c))).toBe(true)
    expect(['permission denied for table users', 'a@b.vn', '4250', 'PGRST1166', '42501 x', ''].some((c) => safe.test(c))).toBe(false)
  })
})
