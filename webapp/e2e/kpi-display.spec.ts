import { test, expect } from '@playwright/test'
import { breakdownModel, campaignFootnote, metricEditorState, smSelectorVisible } from '../lib/kpi/campaignDisplay'
import { affiliateDataStatus, buildCampaignExportRows, type ExportActual } from '../lib/kpi/exportRows'

// P3-E/F r1 unit gate (audit P2#3) — khóa contract render breakdown, footnote,
// trạng thái metric editor và cột export.

const VIEW = (over: Record<string, unknown> = {}) => ({
  metric_offline: true, metric_affiliate: false, kpi_target: 1000,
  actual_offline: 300 as number | null, actual_affiliate: 200 as number | null, ...over,
}) as Parameters<typeof breakdownModel>[0]

test.describe('kpi display contract @desktop', () => {
  test('OFFLINE-ONLY: KHÔNG breakdown; footnote giữ nguyên câu production cũ', () => {
    expect(breakdownModel(VIEW()).show).toBe(false)
    expect(campaignFootnote({ metric_offline: true, metric_affiliate: false }))
      .toBe('Nguồn: báo cáo BI · * Không bao gồm đơn online')
  })

  test('AFFILIATE-ONLY: KHÔNG breakdown 2 nguồn; footnote DELIVERED-only', () => {
    expect(breakdownModel(VIEW({ metric_offline: false, metric_affiliate: true })).show).toBe(false)
    expect(campaignFootnote({ metric_offline: false, metric_affiliate: true }))
      .toContain('Circa Online · chỉ tính đơn giao thành công')
  })

  test('BOTH: breakdown hiện, offline có %; affiliate KHÔNG có % (stakeholder 24/07); target=0 → null', () => {
    const bd = breakdownModel(VIEW({ metric_affiliate: true }))
    // toEqual khóa TOÀN BỘ contract — affiliatePct không được quay lại.
    expect(bd).toEqual({ show: true, offlinePct: 30 }) // 300/1000; affiliate chỉ hiện số tiền
    expect(campaignFootnote({ metric_offline: true, metric_affiliate: true })).toContain('BI + Circa Online')

    const zero = breakdownModel(VIEW({ metric_affiliate: true, kpi_target: 0 }))
    expect(zero.offlinePct).toBeNull()
    const noSync = breakdownModel(VIEW({ metric_affiliate: true, actual_offline: null, actual_affiliate: null }))
    expect(noSync.offlinePct).toBeNull()
  })

  test('metricEditorState: draft+flag on sửa được; active read-only; FLAG OFF + affiliate → khóa TOÀN BỘ (r1 P2#1)', () => {
    expect(metricEditorState({ status: 'draft', affiliateEnabled: true, metricAffiliate: true }))
      .toEqual({ editable: true, metricsLocked: false, showAffiliateControl: true })
    expect(metricEditorState({ status: 'active', affiliateEnabled: true, metricAffiliate: false }).editable).toBe(false)
    // flag tắt + campaign affiliate: khóa cả 2 checkbox lẫn nút lưu, vẫn HIỂN THỊ dòng affiliate để đọc
    const locked = metricEditorState({ status: 'draft', affiliateEnabled: false, metricAffiliate: true })
    expect(locked).toEqual({ editable: false, metricsLocked: true, showAffiliateControl: true })
    // flag tắt + campaign offline-only: sửa bình thường, KHÔNG hiện control affiliate
    const offlineOnly = metricEditorState({ status: 'paused', affiliateEnabled: false, metricAffiliate: false })
    expect(offlineOnly).toEqual({ editable: true, metricsLocked: false, showAffiliateControl: false })
  })

  test('export r1 P2#2: GIỮ cột cũ Actual GMV (không GMV Total); cột mới bổ sung; giá trị đúng', () => {
    const actual: ExportActual = {
      store_id: 's-1', actual_value: 500, run_rate: 50, remaining_target: 500,
      achieved_tier_order: 1, store_commission_pool: 111, synced_at: '2026-07-23T10:00:00Z',
      actual_offline: 300, actual_affiliate: 200,
      offline_synced_at: '2026-07-23T09:58:00Z', affiliate_synced_at: '2026-07-23T09:00:00Z',
    }
    const rows = buildCampaignExportRows(
      { name: 'C1', start_date: '2026-07-01', end_date: '2026-07-31', metric_offline: true, metric_affiliate: true },
      [{ store_id: 's-1', pos_code: 'POS0001', kpi_target: 1000, store_kpi_group: 'G', stores: { name: 'Store 1' } }],
      [actual], '2026-07-23', (iso) => iso,
    )
    const r = rows[0]
    const cols = Object.keys(r)
    expect(cols).toContain('Actual GMV')          // tên cột CŨ giữ nguyên
    expect(cols).not.toContain('GMV Total')       // KHÔNG đổi tên (breaking change)
    expect(cols).toEqual(expect.arrayContaining([
      'GMV Offline', 'GMV Affiliate', 'Offline Synced At', 'Affiliate Synced At', 'Affiliate Data Status',
    ]))
    expect(r['Actual GMV']).toBe(500)             // ngữ nghĩa cũ = tổng
    expect(r['GMV Offline']).toBe(300)
    expect(r['GMV Affiliate']).toBe(200)
    expect(r['Affiliate Data Status']).toBe('Đã đồng bộ')
    expect(r['Offline Synced At']).toBe('2026-07-23T09:58:00Z')
  })

  test('H1.2 smSelectorVisible: LUÔN hiện trên landing kể cả 0 campaign (SM không bao giờ kẹt ở store rỗng); ẩn trong ?campaign= và khi chỉ 1 store', () => {
    expect(smSelectorVisible(4, false)).toBe(true)   // landing, nhiều store — KỂ CẢ store đang chọn 0 campaign
    expect(smSelectorVisible(2, false)).toBe(true)
    expect(smSelectorVisible(4, true)).toBe(false)   // campaign detail — store cố định
    expect(smSelectorVisible(1, false)).toBe(false)  // 1 store — không có gì để chọn
    expect(smSelectorVisible(0, false)).toBe(false)
  })

  test('affiliateDataStatus: Không áp dụng / Chưa đồng bộ / Đã đồng bộ', () => {
    expect(affiliateDataStatus(false, undefined)).toBe('Không áp dụng')
    expect(affiliateDataStatus(true, undefined)).toBe('Chưa đồng bộ')
    expect(affiliateDataStatus(true, { affiliate_synced_at: null } as ExportActual)).toBe('Chưa đồng bộ')
    expect(affiliateDataStatus(true, { affiliate_synced_at: '2026-07-23T09:00:00Z' } as ExportActual)).toBe('Đã đồng bộ')
  })

  test('export: campaign offline-only → cột mới rỗng/Không áp dụng, cột cũ nguyên vẹn', () => {
    const rows = buildCampaignExportRows(
      { name: 'C2', start_date: '2026-07-01', end_date: '2026-07-31', metric_offline: true, metric_affiliate: false },
      [{ store_id: 's-1', pos_code: 'POS0001', kpi_target: 1000, store_kpi_group: 'G', stores: { name: 'Store 1' } }],
      [{
        store_id: 's-1', actual_value: 400, run_rate: 40, remaining_target: 600,
        achieved_tier_order: null, store_commission_pool: null, synced_at: '2026-07-23T10:00:00Z',
        actual_offline: 400, actual_affiliate: 0, offline_synced_at: '2026-07-23T09:58:00Z', affiliate_synced_at: null,
      }], '2026-07-23', (iso) => iso,
    )
    expect(rows[0]['Actual GMV']).toBe(400)
    expect(rows[0]['Affiliate Data Status']).toBe('Không áp dụng')
    expect(rows[0]['Affiliate Synced At']).toBe('')
  })
})
