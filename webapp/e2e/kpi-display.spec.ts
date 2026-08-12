import { test, expect } from '@playwright/test'
import { breakdownModel, campaignFootnote, metricEditorState, metricPresentation, syncedSubjectLabel } from '../lib/kpi/campaignDisplay'
import { affiliateDataStatus, buildCampaignExportRows, buildCustomerCampaignExportRows, buildOrderAovCampaignExportRows, type ExportActual } from '../lib/kpi/exportRows'

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
      'GMV Offline',
      // 105 (11/08): 2 cột MỚI ngay sau GMV Offline — contract export đổi CÓ
      // CHỦ Ý (stakeholder request); các cột còn lại giữ nguyên thứ tự.
      'Số đơn Offline', 'AOV Offline',
      'GMV Affiliate', 'Offline Synced At', 'Affiliate Synced At', 'Affiliate Data Status',
    ]))
    expect(r['Actual GMV']).toBe(500)             // ngữ nghĩa cũ = tổng
    expect(r['GMV Offline']).toBe(300)
    expect(r['GMV Affiliate']).toBe(200)
    expect(r['Affiliate Data Status']).toBe('Đã đồng bộ')
    expect(r['Offline Synced At']).toBe('2026-07-23T09:58:00Z')
  })

  // (test smSelectorVisible đã gỡ 27/07 cùng contract — SM Dashboard r2 dùng
  // smScopeState trong kpi-result-model.spec thay thế.)

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

// ── Mig 103: presentation + footnote + editor + export customer ─────────────
test.describe('kpi display customer metric (mig 103) @desktop', () => {
  test('metricPresentation(gmv): value BYTE-EQUAL vnd cũ; compact BYTE-EQUAL compactVnd cũ (kể cả .0 giữ nguyên)', () => {
    const p = metricPresentation('gmv')
    const oldVnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`
    const oldCompact = (v: number) =>
      v >= 1_000_000_000 ? `${(v / 1_000_000_000).toFixed(1)}tỷ`
      : v >= 1_000_000 ? `${Math.round(v / 1_000_000)}tr`
      : v >= 1_000 ? `${Math.round(v / 1_000)}k`
      : `${Math.round(v)}`
    for (const n of [0, 1, 999, 1_000, 126_000.5, 5_500_000, 450_000_000, 1_000_000_000, 1_250_000_000]) {
      expect(p.value(n)).toBe(oldVnd(n))
      expect(p.compact(n)).toBe(oldCompact(n))
    }
    expect(p.value(null)).toBe('—')
    expect(p.value(undefined)).toBe('—')
    expect(p.zero).toBe('0₫')
    expect(p.actualColumnLabel).toBe('Actual GMV')
  })

  test('metricPresentation(customer): đơn vị khách; default gmv cho giá trị lạ/thiếu (an toàn hiển thị)', () => {
    const p = metricPresentation('affiliate_customer_count')
    expect(p.value(1234)).toBe('1.234 khách')
    expect(p.value(0)).toBe('0 khách')
    expect(p.value(null)).toBe('—')
    expect(p.zero).toBe('0 khách')
    expect(p.targetLabel).toBe('Mục tiêu số khách')
    expect(p.todayLabel).toBe('Khách hôm nay')
    expect(p.actualColumnLabel).toBe('Số khách')
    expect(metricPresentation(undefined).kind).toBe('gmv')
    expect(metricPresentation('bogus').kind).toBe('gmv')
  })

  test('footnote customer: câu riêng mỗi-khách-1-lần; caller cũ (không metric_type) giữ câu cũ', () => {
    expect(campaignFootnote({ metric_offline: false, metric_affiliate: true, metric_type: 'affiliate_customer_count' }))
      .toContain('mỗi khách tính 1 lần')
    expect(campaignFootnote({ metric_offline: true, metric_affiliate: false }))
      .toBe('Nguồn: báo cáo BI · * Không bao gồm đơn online')
  })

  test('metricEditorState customer: khóa hẳn editor bất kể status/flag', () => {
    for (const status of ['draft', 'paused', 'active', 'ended']) {
      const st = metricEditorState({ status, affiliateEnabled: true, metricAffiliate: true, metricType: 'affiliate_customer_count' })
      expect(st.editable).toBe(false)
      expect(st.showAffiliateControl).toBe(false)
    }
    // gmv không đổi hành vi khi truyền metricType='gmv'
    expect(metricEditorState({ status: 'draft', affiliateEnabled: true, metricAffiliate: false, metricType: 'gmv' }).editable).toBe(true)
  })

  test('EXPORT REGRESSION: mảng key GMV builder BẤT BIẾN (có Actual GMV — Power Query)', () => {
    const rows = buildCampaignExportRows(
      { name: 'C', start_date: '2026-08-01', end_date: '2026-08-31', metric_offline: true, metric_affiliate: false },
      [{ store_id: 's-1', pos_code: 'POS0001', kpi_target: 1000, store_kpi_group: 'G', stores: { name: 'S1' } }],
      [], '2026-08-06', (iso) => iso,
    )
    expect(Object.keys(rows[0])).toEqual([
      'Chiến dịch', 'Từ ngày', 'Đến ngày', 'POS', 'Cửa hàng', 'Phân loại', 'KPI target',
      'Actual GMV', 'GMV Offline',
      // 105 (11/08): 2 cột MỚI ngay sau 'GMV Offline' — contract export đổi CÓ
      // CHỦ Ý (stakeholder request); mọi cột cũ giữ nguyên tên + thứ tự tương đối.
      'Số đơn Offline', 'AOV Offline',
      'GMV Affiliate', 'Run rate %', 'Performance %',
      'Còn thiếu', 'Bậc đạt', 'Commission pool', 'Offline Synced At', 'Affiliate Synced At',
      'Affiliate Data Status', 'Đồng bộ lúc',
    ])
  })

  test('EXPORT customer: builder riêng — cột đơn vị khách, giá trị đúng', () => {
    const rows = buildCustomerCampaignExportRows(
      { name: 'Khách T8', start_date: '2026-08-01', end_date: '2026-08-31', metric_offline: false, metric_affiliate: true },
      [{ store_id: 's-1', pos_code: 'POS0001', kpi_target: 100, store_kpi_group: 'G', stores: { name: 'S1' } }],
      [{
        store_id: 's-1', actual_value: 37, run_rate: 37, remaining_target: 63,
        achieved_tier_order: null, store_commission_pool: null, synced_at: '2026-08-06T10:00:00Z',
        actual_offline: 0, actual_affiliate: 0, offline_synced_at: null,
        affiliate_synced_at: '2026-08-06T09:00:00Z', actual_customer_count: 37,
      }], '2026-08-06', (iso) => iso,
    )
    expect(Object.keys(rows[0])).toEqual([
      'Chiến dịch', 'Loại chỉ số', 'Từ ngày', 'Đến ngày', 'POS', 'Cửa hàng', 'Phân loại',
      'KPI target (khách)', 'Số khách Affiliate', 'Run rate %', 'Performance %',
      'Còn thiếu (khách)', 'Bậc đạt', 'Commission pool', 'Affiliate Synced At', 'Đồng bộ lúc',
    ])
    expect(rows[0]['KPI target (khách)']).toBe(100)
    expect(rows[0]['Số khách Affiliate']).toBe(37)
    expect(rows[0]['Còn thiếu (khách)']).toBe(63)
    expect(rows[0]['Loại chỉ số']).toBe('Số khách Affiliate')
  })

  // 106 r1.1 (audit P2): toast "đã đồng bộ" phải nói ĐÚNG loại chiến dịch —
  // trước đây hard-code "GMV đã đồng bộ" cho cả campaign Số khách.
  test('syncedSubjectLabel theo metric_type; loại lạ/thiếu → doanh số (an toàn)', () => {
    expect(syncedSubjectLabel('gmv')).toBe('Doanh số đã đồng bộ')
    expect(syncedSubjectLabel('affiliate_customer_count')).toBe('Số khách đã đồng bộ')
    expect(syncedSubjectLabel('offline_order_aov')).toBe('Chất lượng bán hàng đã đồng bộ')
    expect(syncedSubjectLabel(undefined)).toBe('Doanh số đã đồng bộ')
    expect(syncedSubjectLabel('loai_la')).toBe('Doanh số đã đồng bộ')
  })

  // ── Mig 106: export campaign Chất lượng bán hàng (contract 12/08) ─────────
  const AOV_CAMP = {
    name: 'CLBH T8', start_date: '2026-08-01', end_date: '2026-08-31',
    metric_offline: true, metric_affiliate: false,
  }
  // Fixture Finance SIGNATURE: mục tiêu 1.046 đơn × 194.046đ, net tham chiếu.
  const AOV_TARGET = {
    store_id: 's-1', pos_code: 'POS0018', kpi_target: 100, store_kpi_group: 'Nhóm A',
    stores: { name: 'CIRCA SIGNATURE' }, order_target: 1046, aov_target: 194_046,
  }

  test('EXPORT order/aov: mục tiêu + thực tế + TỈ LỆ cho cả 2 chỉ số, không cột floor', () => {
    const rows = buildOrderAovCampaignExportRows(AOV_CAMP, [AOV_TARGET], [{
      store_id: 's-1', actual_value: 100, run_rate: 100, remaining_target: 0,
      achieved_tier_order: 1, store_commission_pool: 20_800_000, synced_at: '2026-08-12T10:00:00Z',
      actual_offline: 203_039_424, actual_affiliate: 0, offline_order_count: 1046,
      offline_synced_at: '2026-08-12T10:00:00Z', affiliate_synced_at: null,
    }], '2026-08-12', (iso) => iso)
    expect(Object.keys(rows[0])).toEqual([
      'Chiến dịch', 'Loại chỉ số', 'Từ ngày', 'Đến ngày', 'POS', 'Cửa hàng', 'Phân loại',
      'Mục tiêu số đơn', 'Số đơn thực tế', 'Tỉ lệ số đơn %',
      'Mục tiêu AOV', 'AOV thực tế', 'Tỉ lệ AOV %', 'Net Revenue (tham khảo)',
      'Hoàn thành %', 'Đạt KPI', 'Bậc đạt', 'Commission pool', 'Đồng bộ lúc',
    ])
    expect(rows[0]['Số đơn thực tế']).toBe(1046)
    expect(rows[0]['Tỉ lệ số đơn %']).toBe(100)
    expect(rows[0]['AOV thực tế']).toBe(Math.round(203_039_424 / 1046))
    expect(rows[0]['Tỉ lệ AOV %']).toBe(100.03)
    expect(rows[0]['Hoàn thành %']).toBe(100)
    expect(rows[0]['Đạt KPI']).toBe('Đạt')
    expect(rows[0]['Commission pool']).toBe(20_800_000)
    // KHÔNG còn cột của contract cũ / của campaign GMV
    for (const dead of ['Sàn số đơn', 'Sàn AOV', 'Đạt 2 sàn', 'KPI target', 'Actual GMV']) {
      expect(Object.keys(rows[0])).not.toContain(dead)
    }
  })

  test('EXPORT order/aov: chưa đạt (completion < 100) → Đạt KPI = Chưa đạt, không bậc', () => {
    const rows = buildOrderAovCampaignExportRows(AOV_CAMP, [AOV_TARGET], [{
      store_id: 's-1', actual_value: 66.9216, run_rate: 66.9216, remaining_target: 33.0784,
      achieved_tier_order: null, store_commission_pool: null, synced_at: '2026-08-12T10:00:00Z',
      actual_offline: 100_000_000, actual_affiliate: 0, offline_order_count: 700,
      offline_synced_at: null, affiliate_synced_at: null,
    }], '2026-08-12', (iso) => iso)
    expect(rows[0]['Đạt KPI']).toBe('Chưa đạt')
    expect(rows[0]['Bậc đạt']).toBe('')
    expect(rows[0]['Hoàn thành %']).toBe(66.9216)     // giữ 4 chữ số, không làm tròn về 1

    const notSynced = buildOrderAovCampaignExportRows(AOV_CAMP, [AOV_TARGET], [], '2026-08-12', (iso) => iso)
    expect(notSynced[0]['Số đơn thực tế']).toBe('')
    expect(notSynced[0]['AOV thực tế']).toBe('')
    expect(notSynced[0]['Hoàn thành %']).toBe('')
    expect(notSynced[0]['Đạt KPI']).toBe('')
    // cấu hình vẫn hiện đủ để đối soát trước khi sync
    expect(notSynced[0]['Mục tiêu số đơn']).toBe(1046)
    expect(notSynced[0]['Mục tiêu AOV']).toBe(194_046)
  })
})
