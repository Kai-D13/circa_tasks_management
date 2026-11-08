import { test, expect } from '@playwright/test'
import { campaignNavItems, campaignTabsReplacedBySidebar, CAMPAIGN_NAV_ITEMS, type CampaignNavInput } from '../lib/layout/campaignNav'
import { opsSidebarVisible } from '../lib/affiliate/overview'
import { resolveActiveHref } from '../lib/layout/sidebarNav'

// UI-NAV U1 (PM spec planning/research/ui-nav-spec-implementation-2026-11-08.md §3.1, AC01 / AC02): bảng chân trị của mô hình
// trình bày nhóm Sidebar "Chiến dịch" — hàm thuần, chạy như unit test. Không mở quyền mới: mỗi mục = giao của quyền + cờ hiện có.

const base: CampaignNavInput = {
  role: 'admin', isSuper: true, isFsStore: false,
  kpiCampaignEnabled: true, kpiAffiliateEnabled: true, cmsProgramEnabled: true,
  affiliateDeptAdmin: false, cmsAdminView: true,
}
const keys = (p: Partial<CampaignNavInput>) => campaignNavItems({ ...base, ...p }).map((i) => i.key)

test.describe('UI-NAV campaignNav — bảng chân trị @desktop', () => {
  test('super × 8 tổ hợp cờ KPI / Affiliate / CMS: CMS độc lập; Affiliate cần cả KPI + Affiliate', () => {
    for (const kpi of [false, true]) for (const aff of [false, true]) for (const cms of [false, true]) {
      const got = keys({ kpiCampaignEnabled: kpi, kpiAffiliateEnabled: aff, cmsProgramEnabled: cms })
      const want = [...(kpi ? ['kpi'] : []), ...(kpi && aff ? ['affiliate'] : []), ...(cms ? ['cms'] : [])]
      expect(got, `kpi=${kpi} aff=${aff} cms=${cms}`).toEqual(want)
    }
  })

  test('thứ tự KPI → Affiliate → CMS, nhãn / href cố định', () => {
    expect(campaignNavItems(base)).toEqual([CAMPAIGN_NAV_ITEMS.kpi, CAMPAIGN_NAV_ITEMS.affiliate, CAMPAIGN_NAV_ITEMS.cms])
    expect(CAMPAIGN_NAV_ITEMS).toEqual({
      kpi: { key: 'kpi', label: 'Chiến dịch KPI', href: '/targets/campaigns' },
      affiliate: { key: 'affiliate', label: 'Affiliate', href: '/targets/campaigns/affiliate' },
      cms: { key: 'cms', label: 'CMS sản phẩm', href: '/targets/campaigns/cms' },
    })
  })

  test('admin phòng: chỉ Affiliate khi phòng được cấp quyền (opsSidebarVisible đã gồm cờ); không cấp ⇒ rỗng', () => {
    const dept = (granted: boolean, kpi = true, aff = true) => {
      const ops = opsSidebarVisible({ flagEnabled: aff && kpi, role: 'admin', isSuper: false, isDeptAdmin: granted })
      return keys({ isSuper: false, cmsAdminView: false, affiliateDeptAdmin: ops, kpiCampaignEnabled: kpi, kpiAffiliateEnabled: aff })
    }
    expect(dept(true)).toEqual(['affiliate'])
    expect(dept(false)).toEqual([])
    expect(dept(true, true, false)).toEqual([])
    expect(dept(true, false, true)).toEqual([])
    // Admin thường (không phòng Affiliate, không super) với mọi cờ bật: không mục nào — CMS không mở cho admin thường.
    expect(keys({ isSuper: false, cmsAdminView: false, affiliateDeptAdmin: false })).toEqual([])
  })

  test('fail-closed: không thể có mục nếu quyền không cho, dù boolean khác bật', () => {
    // isSuper=false nhưng cờ KPI bật ⇒ không KPI; cmsAdminView=false ⇒ không CMS dù cờ CMS bật.
    expect(keys({ isSuper: false, cmsAdminView: false })).toEqual([])
    // Super giả (role khác admin) ⇒ rỗng: chỉ role admin nhận nhóm.
    for (const role of ['sm', 'store_manager', 'staff', null, undefined, 'unknown']) {
      expect(keys({ role, cmsAdminView: role === 'sm' }), `role=${role}`).toEqual([])
    }
    // FS: không mục OS nào.
    expect(keys({ isFsStore: true })).toEqual([])
    // Admin phòng KHÔNG nhận thêm Affiliate nếu đồng thời là super (super đi nhánh super, không nhân đôi).
    expect(keys({ affiliateDeptAdmin: true })).toEqual(['kpi', 'affiliate', 'cms'])
  })

  test('SM: canViewCmsAdmin=true nhưng KHÔNG nhóm Sidebar (giữ điều hướng hiện tại) ⇒ tabs không bị ẩn', () => {
    const sm = campaignNavItems({ ...base, role: 'sm', isSuper: false, cmsAdminView: true })
    expect(sm).toEqual([])
    expect(campaignTabsReplacedBySidebar(sm, { affiliate: true, cms: true })).toBe(false)
  })

  test('ẩn tabs desktop CHỈ khi Sidebar có đủ mọi đích của hàng tab', () => {
    const all = campaignNavItems(base)
    expect(campaignTabsReplacedBySidebar(all, { affiliate: true, cms: true })).toBe(true)
    expect(campaignTabsReplacedBySidebar(all, { affiliate: false, cms: true })).toBe(true)
    // Thiếu đích Affiliate trong Sidebar (cờ KPI Affiliate tắt) mà hàng tab vẫn có Affiliate ⇒ giữ tabs.
    const noAff = campaignNavItems({ ...base, kpiAffiliateEnabled: false })
    expect(campaignTabsReplacedBySidebar(noAff, { affiliate: true, cms: true })).toBe(false)
    expect(campaignTabsReplacedBySidebar(noAff, { affiliate: false, cms: true })).toBe(true)
    // Cờ KPI tắt (trang CMS vẫn có tab "Chiến dịch") ⇒ Sidebar không có KPI ⇒ giữ tabs.
    const noKpi = campaignNavItems({ ...base, kpiCampaignEnabled: false })
    expect(campaignTabsReplacedBySidebar(noKpi, { affiliate: true, cms: true })).toBe(false)
    expect(campaignTabsReplacedBySidebar(noKpi, { affiliate: false, cms: true })).toBe(false)
    // Thiếu CMS mà hàng tab có CMS ⇒ giữ.
    const noCms = campaignNavItems({ ...base, cmsProgramEnabled: false })
    expect(campaignTabsReplacedBySidebar(noCms, { affiliate: true, cms: true })).toBe(false)
    expect(campaignTabsReplacedBySidebar([], { affiliate: false, cms: false })).toBe(false)
  })

  test('active trong tập href nhóm: dài nhất thắng, ranh giới "/", chi tiết không làm KPI cùng sáng', () => {
    const H = campaignNavItems(base).map((i) => i.href)
    expect(resolveActiveHref('/targets/campaigns', H)).toBe('/targets/campaigns')
    expect(resolveActiveHref('/targets/campaigns/abc-123', H)).toBe('/targets/campaigns')
    expect(resolveActiveHref('/targets/campaigns/affiliate', H)).toBe('/targets/campaigns/affiliate')
    expect(resolveActiveHref('/targets/campaigns/cms', H)).toBe('/targets/campaigns/cms')
    expect(resolveActiveHref('/targets/campaigns/cms/942194ce-893f-4f62-a88a-bd9efa464bae', H)).toBe('/targets/campaigns/cms')
    expect(resolveActiveHref('/targets/campaigns/cms/x/import', H)).toBe('/targets/campaigns/cms')
    expect(resolveActiveHref('/targets/campaigns-old', H)).toBeNull()
    expect(resolveActiveHref('/targets', H)).toBeNull()
  })
})
