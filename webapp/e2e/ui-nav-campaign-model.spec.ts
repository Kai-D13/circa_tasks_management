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
    // Super giả (role khác admin / SM) ⇒ rỗng: chỉ role admin và SM nhận nhóm. Role so khớp CHÍNH XÁC (không 'SM' / ' sm').
    for (const role of ['store_manager', 'staff', null, undefined, 'unknown', 'SM', 'Sm', ' sm', 'sm ', 'admin ']) {
      for (const cmsAdminView of [false, true]) for (const affiliateDeptAdmin of [false, true]) {
        expect(keys({ role, cmsAdminView, affiliateDeptAdmin }), `role=${JSON.stringify(role)} cms=${cmsAdminView} dept=${affiliateDeptAdmin}`).toEqual([])
      }
    }
    // FS: không mục OS nào (kể cả nếu hồ sơ SM bị gắn cờ FS — không thể xảy ra ở layout, vẫn fail-closed).
    expect(keys({ isFsStore: true })).toEqual([])
    expect(keys({ role: 'sm', isSuper: false, isFsStore: true })).toEqual([])
    // Admin phòng KHÔNG nhận thêm Affiliate nếu đồng thời là super (super đi nhánh super, không nhân đôi).
    expect(keys({ affiliateDeptAdmin: true })).toEqual(['kpi', 'affiliate', 'cms'])
  })

  // SM-CAMPAIGN-NAV-1 (work order PM 12/11, SM-NAV-D01 thay nhánh SM của UI-NAV-D03): SM nhận nhóm theo cờ ∩ quyền hiện có.
  test('SM × 8 tổ hợp cờ: KPI theo cờ KPI; Affiliate cần KPI + Affiliate; CMS độc lập; isSuper / affiliateDeptAdmin không ảnh hưởng', () => {
    for (const kpi of [false, true]) for (const aff of [false, true]) for (const cms of [false, true]) {
      const want = [...(kpi ? ['kpi'] : []), ...(kpi && aff ? ['affiliate'] : []), ...(cms ? ['cms'] : [])]
      // isSuper luôn false với SM ở layout (isSuperAdminEmail chỉ xét role admin); true ở đây chỉ để chứng minh nhánh SM không đọc nó.
      for (const isSuper of [false, true]) for (const affiliateDeptAdmin of [false, true]) {
        const got = keys({ role: 'sm', isSuper, affiliateDeptAdmin, cmsAdminView: true, kpiCampaignEnabled: kpi, kpiAffiliateEnabled: aff, cmsProgramEnabled: cms })
        expect(got, `sm kpi=${kpi} aff=${aff} cms=${cms} super=${isSuper} dept=${affiliateDeptAdmin}`).toEqual(want)
      }
    }
    // Thứ tự / nhãn / href giống hệt nhóm của super — cùng ba route chỉ đọc, không route mới.
    const smAll = campaignNavItems({ ...base, role: 'sm', isSuper: false, cmsAdminView: true })
    expect(smAll).toEqual([CAMPAIGN_NAV_ITEMS.kpi, CAMPAIGN_NAV_ITEMS.affiliate, CAMPAIGN_NAV_ITEMS.cms])
    // Work order §2.4: link KPI không ép query trạng thái (giữ mặc định all); nút Lịch sử cũ vẫn ?status=ended ở landing.
    for (const i of smAll) expect(i.href, `${i.key}: href không kèm query / hash`).toMatch(/^\/targets\/campaigns(\/affiliate|\/cms)?$/)
    // canViewCmsAdmin=false (không xảy ra với SM) ⇒ không CMS dù cờ bật — mục CMS vẫn theo quyền, không theo role.
    expect(keys({ role: 'sm', isSuper: false, cmsAdminView: false })).toEqual(['kpi', 'affiliate'])
  })

  test('SM: hàng tab desktop chỉ ẩn khi Sidebar SM có đủ đích của trang; thiếu đích ⇒ giữ tabs', () => {
    const sm = (p: Partial<CampaignNavInput> = {}) => campaignNavItems({ ...base, role: 'sm', isSuper: false, cmsAdminView: true, ...p })
    // Đủ cờ: KPI / Affiliate / CMS (tabs có Affiliate + CMS) ⇒ ẩn ở desktop, mobile vẫn có (CampaignsTabs md:hidden).
    expect(campaignTabsReplacedBySidebar(sm(), { affiliate: true, cms: true })).toBe(true)
    // CMS tắt: trang KPI / Affiliate không có tab CMS ⇒ vẫn đủ ⇒ ẩn.
    expect(campaignTabsReplacedBySidebar(sm({ cmsProgramEnabled: false }), { affiliate: true, cms: false })).toBe(true)
    // Affiliate tắt mà hàng tab vẫn có Affiliate (không xảy ra vì tab theo cùng cờ) ⇒ giữ.
    expect(campaignTabsReplacedBySidebar(sm({ kpiAffiliateEnabled: false }), { affiliate: true, cms: true })).toBe(false)
    expect(campaignTabsReplacedBySidebar(sm({ kpiAffiliateEnabled: false }), { affiliate: false, cms: true })).toBe(true)
    // KPI tắt: trang CMS vẫn có tab "Chiến dịch" ⇒ Sidebar SM không có KPI ⇒ giữ tabs.
    expect(campaignTabsReplacedBySidebar(sm({ kpiCampaignEnabled: false }), { affiliate: false, cms: true })).toBe(false)
    // QLCH / staff: không mục ⇒ không bao giờ ẩn.
    for (const role of ['store_manager', 'staff']) expect(campaignTabsReplacedBySidebar(campaignNavItems({ ...base, role, isSuper: false }), { affiliate: true, cms: true })).toBe(false)
  })

  test('SM active: Doanh số (/targets) và mục Chiến dịch không bao giờ cùng sáng — dài nhất thắng trên tập href Sidebar SM', () => {
    // Tập href Sidebar SM: các mục vai SM (Tổng quan, Tasks, Doanh số, Người dùng, Cửa hàng, Bảng tin, Nhật ký) + nhóm Chiến dịch.
    const H = ['/dashboard', '/tasks', '/targets', '/users', '/stores', '/announcements', '/logs',
      ...campaignNavItems({ ...base, role: 'sm', isSuper: false, cmsAdminView: true }).map((i) => i.href)]
    expect(resolveActiveHref('/targets', H)).toBe('/targets')
    expect(resolveActiveHref('/targets/campaigns', H)).toBe('/targets/campaigns')
    expect(resolveActiveHref('/targets/campaigns/0b7e4c1a-2f3d-4e5a-9b8c-7d6e5f4a3b2c', H)).toBe('/targets/campaigns')
    expect(resolveActiveHref('/targets/campaigns/affiliate', H)).toBe('/targets/campaigns/affiliate')
    expect(resolveActiveHref('/targets/campaigns/cms', H)).toBe('/targets/campaigns/cms')
    expect(resolveActiveHref('/targets/campaigns/cms/942194ce-893f-4f62-a88a-bd9efa464bae', H)).toBe('/targets/campaigns/cms')
    // Cờ KPI tắt ⇒ không có href KPI ⇒ /targets/campaigns/<id> rơi về Doanh số (route 404 theo cờ — chỉ còn một mục sáng).
    const noKpi = H.filter((h) => h !== '/targets/campaigns')
    expect(resolveActiveHref('/targets/campaigns/cms', noKpi)).toBe('/targets/campaigns/cms')
    expect(resolveActiveHref('/targets/campaigns', noKpi)).toBe('/targets')
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
