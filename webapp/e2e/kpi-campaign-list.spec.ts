import { test, expect } from '@playwright/test'
import { campaignListErrors, campaignListPct, campaignListReached, campaignListTone, campaignsLoadingKind } from '../lib/kpi/campaignList'
import { campaignOverviewValue } from '../lib/kpi/campaignDisplay'
import { kpiProgressTone } from '../lib/kpi/progressTone'

// UI v2 K-1 unit gate — luật thuần của /targets/campaigns (page.tsx dùng đúng các hàm này):
// gộp lỗi 3 truy vấn (lỗi ≠ 0), "đạt" từ số THÔ (không từ % làm tròn), tone dòng theo artboard K1.

const E = (message: string) => ({ message })
const IN = (over: Partial<Parameters<typeof campaignListReached>[0]> = {}) => ({
  metricType: 'gmv', synced: true, storeCount: 24, totalTarget: 1000, totalActual: 0, qualityPassCount: 0, ...over,
})

test.describe('kpi campaign list contract @desktop', () => {
  test('gộp lỗi: chính lỗi ⇒ chỉ lỗi chính; phụ lỗi ⇒ sideError (target trước actual); không lỗi ⇒ null', () => {
    expect(campaignListErrors(E('c'), E('t'), E('a'))).toEqual({ campaignsError: 'c', sideError: null })
    expect(campaignListErrors(E('c'), null, null)).toEqual({ campaignsError: 'c', sideError: null })
    expect(campaignListErrors(null, E('t'), E('a'))).toEqual({ campaignsError: null, sideError: 't' })
    expect(campaignListErrors(null, null, E('a'))).toEqual({ campaignsError: null, sideError: 'a' })
    expect(campaignListErrors(undefined, undefined, undefined)).toEqual({ campaignsError: null, sideError: null })
  })

  test('đạt từ số thô: 99,6% hiện "100%" nhưng KHÔNG đạt; đúng 100% thì đạt', () => {
    const near = IN({ totalTarget: 2_000_000_000, totalActual: 1_992_000_000 })
    expect(campaignOverviewValue(near).pctText).toBe('100%') // % hiển thị làm tròn
    expect(campaignListReached(near)).toBe(false)
    expect(campaignListReached(IN({ totalActual: 1000 }))).toBe(true)
    expect(campaignListReached(IN({ totalActual: 1200 }))).toBe(true)
  })

  test('đạt: chưa đồng bộ / mục tiêu 0 ⇒ không đạt; Số khách như GMV; CLBH = mọi cửa hàng đạt', () => {
    expect(campaignListReached(IN({ synced: false, totalActual: 5000 }))).toBe(false)
    expect(campaignListReached(IN({ totalTarget: 0, totalActual: 10 }))).toBe(false)
    expect(campaignListReached(IN({ metricType: 'affiliate_customer_count', totalTarget: 450, totalActual: 450 }))).toBe(true)
    expect(campaignListReached(IN({ metricType: 'affiliate_customer_count', totalTarget: 450, totalActual: 449 }))).toBe(false)
    const q = (pass: number, stores: number) => IN({ metricType: 'offline_order_aov', storeCount: stores, qualityPassCount: pass })
    expect(campaignListReached(q(7, 8))).toBe(false)
    expect(campaignListReached(q(8, 8))).toBe(true)
    expect(campaignListReached(q(0, 0))).toBe(false)
    expect(campaignListReached({ ...q(8, 8), synced: false })).toBe(false)
  })

  test('% dòng (r1.1): tỷ lệ THÔ cho thanh/ARIA, chữ 1 chữ số; chưa đạt mà làm tròn lên 100 ⇒ "<100%"', () => {
    const g = (actual: number, target: number) => campaignListPct(IN({ totalTarget: target, totalActual: actual }))
    expect(g(1_992_000_000, 2_000_000_000)).toEqual({ raw: 99.6, text: '99,6%' })
    const near = g(9_996_000_000, 10_000_000_000)
    expect(near.text).toBe('<100%')
    expect(near.raw).toBeCloseTo(99.96, 10)
    expect(g(9_994_000_000, 10_000_000_000).text).toBe('99,9%')
    expect(g(1000, 1000)).toEqual({ raw: 100, text: '100%' })
    const over = g(1120, 1000) // raw dấu phẩy động (112.00000000000001) — so gần đúng
    expect(over.text).toBe('112%')
    expect(over.raw).toBeCloseTo(112, 10)
    expect(g(3_790_116_504, 9_430_000_000).text).toBe('40,2%')
    expect(g(0, 1000)).toEqual({ raw: 0, text: '0%' }) // đã đồng bộ, doanh số 0 thật
    // Không bao giờ "100%" khi chưa đạt
    for (const [a, t] of [[999_999, 1_000_000], [99_951, 100_000], [4_499, 4_500]]) {
      const p = g(a, t)
      expect(campaignListReached(IN({ totalTarget: t, totalActual: a }))).toBe(false)
      expect(p.text, `${a}/${t}`).not.toBe('100%')
    }
  })

  test('% dòng: chưa đồng bộ / không mẫu số ⇒ "—" + raw null; Số khách và CLBH cùng luật', () => {
    expect(campaignListPct(IN({ synced: false, totalActual: 500 }))).toEqual({ raw: null, text: '—' })
    expect(campaignListPct(IN({ totalTarget: 0, totalActual: 10 }))).toEqual({ raw: null, text: '—' })
    const kh = (a: number, t: number) => campaignListPct(IN({ metricType: 'affiliate_customer_count', totalTarget: t, totalActual: a }))
    expect(kh(450, 450)).toEqual({ raw: 100, text: '100%' })
    expect(kh(449, 450).text).toBe('99,8%')
    expect(kh(4_499, 4_500).text).toBe('<100%')
    const q = (pass: number, stores: number) => campaignListPct(IN({ metricType: 'offline_order_aov', storeCount: stores, qualityPassCount: pass }))
    expect(q(3, 8)).toEqual({ raw: 37.5, text: '37,5%' })
    expect(q(8, 8)).toEqual({ raw: 100, text: '100%' })
    expect(q(0, 0)).toEqual({ raw: null, text: '—' })
    expect(campaignListPct({ ...IN({ metricType: 'offline_order_aov', storeCount: 8, qualityPassCount: 8 }), synced: false })).toEqual({ raw: null, text: '—' })
  })

  test('khung chờ theo pathname (K-2/K-4): list / chi tiết uuid / affiliate / còn lại null', () => {
    const ID = '0f3c2a1b-9d8e-4c7b-a6f5-1e2d3c4b5a69'
    expect(campaignsLoadingKind('/targets/campaigns')).toBe('list')
    expect(campaignsLoadingKind('/targets/campaigns/')).toBe('list')
    expect(campaignsLoadingKind(`/targets/campaigns/${ID}`)).toBe('detail')
    expect(campaignsLoadingKind(`/targets/campaigns/${ID.toUpperCase()}`)).toBe('detail')
    expect(campaignsLoadingKind('/targets/campaigns/affiliate')).toBe('affiliate')
    expect(campaignsLoadingKind('/targets/campaigns/affiliate/')).toBe('affiliate')
    for (const p of ['/targets/campaigns/new', '/targets/campaigns/affiliate/x', '/targets/campaigns/Affiliate', '/affiliate', `/targets/campaigns/${ID}/x`, '/targets', '/tasks', '', null, undefined]) {
      expect(campaignsLoadingKind(p), String(p)).toBeNull()
    }
  })

  test('kpiProgressTone (luật chung, PM K-1 §3): unsynced > reached > ended > series — kết thúc + đạt ⇒ ok', () => {
    expect(kpiProgressTone({ synced: false, ended: true, reached: true })).toBe('unsynced')
    expect(kpiProgressTone({ synced: true, ended: true, reached: true })).toBe('ok')
    expect(kpiProgressTone({ synced: true, ended: false, reached: true })).toBe('ok')
    expect(kpiProgressTone({ synced: true, ended: true, reached: false })).toBe('ended')
    expect(kpiProgressTone({ synced: true, ended: false, reached: false })).toBe('series')
  })

  test('tone dòng: chưa đồng bộ > đạt (kể cả đã kết thúc) > kết thúc chưa đạt > màu chuỗi', () => {
    expect(campaignListTone({ synced: false, reached: true, status: 'ended' })).toBe('unsynced')
    expect(campaignListTone({ synced: true, reached: true, status: 'ended' })).toBe('ok')
    expect(campaignListTone({ synced: true, reached: true, status: 'paused' })).toBe('ok')
    expect(campaignListTone({ synced: true, reached: false, status: 'ended' })).toBe('ended')
    expect(campaignListTone({ synced: true, reached: false, status: 'active' })).toBe('series')
    expect(campaignListTone({ synced: true, reached: false, status: 'draft' })).toBe('series')
  })
})
