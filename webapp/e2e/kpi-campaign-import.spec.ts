import { test, expect } from '@playwright/test'
import { parseCampaignRows } from '../lib/kpi/campaignImport'
import { campaignImportGuide } from '../lib/kpi/campaignImportGuide'

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

// ── r1 (audit P1#2): guide/template import theo LOẠI chiến dịch ─────────────
test.describe('kpi campaign import guide (mig 103 r1) @desktop', () => {
  test('GMV guide BYTE-INVARIANT: sample CSV + header + boundary warning y hệt production cũ (Power Query/ops)', () => {
    for (const g of [campaignImportGuide(), campaignImportGuide('gmv'), campaignImportGuide('bogus')]) {
      expect(g.sampleCsv).toBe([
        'pos_code,kpi_target,store_kpi_group,tier_1_threshold_pct,tier_1_commission_amount,tier_2_threshold_pct,tier_2_commission_amount,tier_3_threshold_pct,tier_3_commission_amount,pos_name,note',
        'POS0059,450000000,Nhỏ hơn 500 triệu,90,15000000,100,20800000,105,26300000,CIRCA TAM VIET,Demo',
        'POS0009,250000000,Nhỏ hơn 300 triệu,90,10600000,100,14700000,105,18500000,CIRCA CENTRAL,Demo',
      ].join(String.fromCharCode(10)))
      expect(g.sampleFileName).toBe('mau-chien-dich-kpi.csv')
      expect(g.boundaryWarning).toContain('200/300/500/800 triệu')
      expect(g.targetHeaderLabel).toBe('KPI target')
      expect(g.formatTarget(450000000)).toBe('450.000.000') // preview cũ KHÔNG có ₫
      expect(g.commitToast(25)).toContain('Đồng bộ doanh số')
    }
  })

  test('CUSTOMER guide: KHÔNG chứa target tiền — sample là SỐ KHÁCH; không boundary warning; đơn vị khách', () => {
    const g = campaignImportGuide('affiliate_customer_count')
    expect(g.sampleCsv).not.toContain('450000000')
    expect(g.sampleCsv).not.toContain('250000000')
    expect(g.sampleCsv).toContain('POS0059,100,')
    expect(g.sampleCsv).toContain('POS0009,50,')
    expect(g.boundaryWarning).toBeNull()
    expect(g.targetHeaderLabel).toBe('KPI target (khách)')
    expect(g.formatTarget(100)).toBe('100 khách')
    expect(g.sampleFileName).toBe('mau-chien-dich-so-khach.csv')
    expect(g.commitToast(25)).toContain('Đồng bộ số khách')
    // Cột target ghi rõ SỐ NGUYÊN đơn vị khách; commission vẫn VNĐ
    const target = g.columns.find((c) => c.col === 'kpi_target')!
    expect(target.meaning).toContain('SỐ NGUYÊN')
    expect(target.example).toBe('100')
    expect(g.columns.find((c) => c.col === 'tier_1_commission_amount')!.meaning).toContain('VNĐ')
  })
})
