import { test, expect } from '@playwright/test'
import { parseCampaignRows } from '../lib/kpi/campaignImport'

// Mig 103 — unit gate ĐẦU TIÊN cho parser import campaign (trước nay chưa có
// test). Hai mục tiêu: (1) KHÓA REGRESSION file GMV — cùng input phải ra cùng
// output y hệt trước 103 (kể cả rule ranh giới tiền); (2) contract customer:
// kpi_target integer bắt buộc + BỎ GROUP_BOUNDARIES + store_kpi_group vẫn
// bắt buộc (nhãn thuần — chốt stakeholder 06/08).

const BY_CODE = new Map([
  ['POS0001', 'store-a'],
  ['POS0002', 'store-b'],
])
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pos_code: 'POS0001', kpi_target: 450_000_000, store_kpi_group: 'Nhỏ hơn 500 triệu',
  tier_1_threshold_pct: 90, tier_1_commission_amount: 1_000_000,
  tier_2_threshold_pct: 100, tier_2_commission_amount: 2_000_000,
  note: null,
  ...over,
})
const CUSTOMER = { metricType: 'affiliate_customer_count' }

test.describe('kpi campaign import parser @desktop', () => {
  test('GMV REGRESSION: file hợp lệ → output y hệt (không truyền opts = hành vi cũ)', () => {
    const r = parseCampaignRows([row(), row({ pos_code: 'POS0002', kpi_target: 250_000_000 })], BY_CODE)
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.invalid).toEqual([])
    expect(r.unmatched).toEqual([])
    expect(r.valid).toEqual([
      {
        store_id: 'store-a', pos_code: 'POS0001', kpi_target: 450_000_000,
        store_kpi_group: 'Nhỏ hơn 500 triệu', import_row: 2, note: null,
        tiers: [
          { tier_order: 1, threshold_pct: 90, commission_amount: 1_000_000 },
          { tier_order: 2, threshold_pct: 100, commission_amount: 2_000_000 },
        ],
      },
      {
        store_id: 'store-b', pos_code: 'POS0002', kpi_target: 250_000_000,
        store_kpi_group: 'Nhỏ hơn 500 triệu', import_row: 3, note: null,
        tiers: [
          { tier_order: 1, threshold_pct: 90, commission_amount: 1_000_000 },
          { tier_order: 2, threshold_pct: 100, commission_amount: 2_000_000 },
        ],
      },
    ])
  })

  test('GMV REGRESSION: boundary 200tr/1 tỷ vẫn BỊ CHẶN; truyền metricType gmv tường minh cũng vậy', () => {
    for (const opts of [undefined, { metricType: 'gmv' }]) {
      const r = parseCampaignRows(
        [row({ kpi_target: 200_000_000 }), row({ pos_code: 'POS0002', kpi_target: 1_000_000_000 })],
        BY_CODE, opts)
      expect('error' in r).toBe(false)
      if ('error' in r) return
      expect(r.valid).toEqual([])
      expect(r.invalid).toHaveLength(2)
      expect(r.invalid[0].error).toContain('ranh giới nhóm KPI')
    }
  })

  test('GMV REGRESSION: kpi_target thập phân HỢP LỆ (hành vi cũ giữ nguyên)', () => {
    const r = parseCampaignRows([row({ kpi_target: 450_000_000.5 })], BY_CODE)
    if ('error' in r) return
    expect(r.valid).toHaveLength(1)
    expect(r.valid[0].kpi_target).toBe(450_000_000.5)
  })

  test('GMV REGRESSION: lỗi file/dòng — thiếu header, pos trùng, không match, tier sai, threshold không tăng', () => {
    expect(parseCampaignRows([], BY_CODE)).toEqual({ error: 'File không có dòng dữ liệu nào' })
    expect(parseCampaignRows([{ kpi_target: 1 }], BY_CODE)).toEqual({ error: 'Thiếu cột pos_code' })
    expect(parseCampaignRows([{ pos_code: 'POS0001', store_kpi_group: 'x' }], BY_CODE))
      .toEqual({ error: 'Thiếu cột kpi_target' })
    expect(parseCampaignRows([{ pos_code: 'POS0001', kpi_target: 1 }], BY_CODE))
      .toEqual({ error: 'Thiếu cột store_kpi_group (phân loại Store theo KPI)' })

    const r = parseCampaignRows([
      row(), row(),                                     // POS0001 trùng
      row({ pos_code: 'POS0099' }),                     // không match
      row({ pos_code: 'POS0002', tier_2_threshold_pct: 90 }), // không tăng dần
    ], BY_CODE)
    if ('error' in r) return
    expect(r.valid).toHaveLength(1)
    expect(r.unmatched).toEqual(['POS0099'])
    expect(r.invalid.map((x) => x.error)).toEqual([
      'pos_code trùng trong file',
      'pos_code không có trong hệ thống',
      'Threshold các bậc phải tăng dần',
    ])
  })

  // ── Mig 103: customer — kpi_target = SỐ KHÁCH nguyên ──────────────────────
  test('CUSTOMER: kpi_target integer hợp lệ; thập phân → lỗi rõ đơn vị khách', () => {
    const ok = parseCampaignRows([row({ kpi_target: 100 })], BY_CODE, CUSTOMER)
    if ('error' in ok) return
    expect(ok.valid).toHaveLength(1)
    expect(ok.valid[0].kpi_target).toBe(100)

    const bad = parseCampaignRows([row({ kpi_target: 12.5 })], BY_CODE, CUSTOMER)
    if ('error' in bad) return
    expect(bad.valid).toEqual([])
    expect(bad.invalid[0].error).toContain('số nguyên dương (số khách)')
  })

  test('CUSTOMER: BỎ rule ranh giới tiền — 200.000.000 khách (giá trị biên GMV) là số nguyên hợp lệ', () => {
    const r = parseCampaignRows([row({ kpi_target: 200_000_000 })], BY_CODE, CUSTOMER)
    if ('error' in r) return
    expect(r.valid).toHaveLength(1)
    expect(r.invalid).toEqual([])
  })

  test('CUSTOMER: store_kpi_group VẪN bắt buộc (nhãn import thuần); tier %/commission tiền giữ nguyên luật', () => {
    const noGroup = parseCampaignRows([row({ kpi_target: 100, store_kpi_group: '' })], BY_CODE, CUSTOMER)
    if ('error' in noGroup) return
    expect(noGroup.invalid[0].error).toContain('store_kpi_group')

    const badTier = parseCampaignRows(
      [row({ kpi_target: 100, tier_1_commission_amount: -1 })], BY_CODE, CUSTOMER)
    if ('error' in badTier) return
    expect(badTier.invalid[0].error).toContain('≥ 0')
  })
})
