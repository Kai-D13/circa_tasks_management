import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { cmsPickStaffProgram, cmsProductHref, cmsStaffHref, cmsTierSummary } from '../lib/cms/staffView'
import { CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY } from '../lib/cms/fixturesStaff'
import { expectBoundaryOnlyInCatalog, expectCatalogWrapped } from './fixtureGuard'

// CMS P1-d — thuần + kiểm tĩnh (không server, không mạng): chọn chương trình mặc định (H5), thang bậc rút gọn `đ/unit_CMS`,
// nhánh /targets?tab=cms nằm TRƯỚC mọi query KPI và chỉ khi cờ CMS bật + staff / QLCH (SPEC §8.1, U15), cổng D2 (cờ / vai
// trò / FS), P1 không hero / gợi ý / "Nếu bán thêm" (U1 / U19), không <img>, BottomNav không đổi, fixture bọc boundary.

const ROOT = path.join(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

test.describe('CMS P1-d · thuần @desktop', () => {
  test('chương trình mặc định: ?program= hợp lệ > đang chạy kết thúc sớm nhất > sắp diễn ra gần nhất', () => {
    const [p1, p2, p3] = CMS_FX_STAFF_PROGRAMS
    expect(cmsPickStaffProgram(CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY, null)?.id).toBe(p1.id) // kết thúc +15 < +40
    expect(cmsPickStaffProgram(CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY, p3.id)?.id).toBe(p3.id)
    expect(cmsPickStaffProgram(CMS_FX_STAFF_PROGRAMS, CMS_FX_TODAY, 'khong-co')?.id).toBe(p1.id)
    expect(cmsPickStaffProgram([p3], CMS_FX_TODAY, null)?.id).toBe(p3.id)
    expect(cmsPickStaffProgram([p2, p3], CMS_FX_TODAY, null)?.id).toBe(p2.id)
    expect(cmsPickStaffProgram([], CMS_FX_TODAY, null)).toBeNull()
  })
  test('thang bậc rút gọn đ/unit_CMS; href giữ chương trình', () => {
    expect(cmsTierSummary([{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: null, amount: '20000' }], 'hộp'))
      .toBe('1–9: 15.000₫/hộp · 10+: 20.000₫/hộp')
    expect(cmsStaffHref('abc')).toBe('/targets?tab=cms&program=abc')
    expect(cmsStaffHref(null)).toBe('/targets?tab=cms')
    expect(cmsProductHref('x-1')).toBe('/targets/cms/products/x-1')
  })
})

test.describe('CMS P1-d · kiểm tĩnh @desktop', () => {
  test('/targets: nhánh tab=cms sau auth / FS / vai trò, TRƯỚC mọi query KPI; chỉ cờ CMS + staff / QLCH', () => {
    const s = read('app/(dashboard)/targets/page.tsx')
    const branch = s.indexOf("if (cmsStaff && params.tab === 'cms')")
    expect(branch).toBeGreaterThan(0)
    expect(s).toContain('const cmsStaff = isCmsProgramEnabled() && (isStaff || isStoreMgr)')
    for (const marker of ['await redirectIfFsStaff(', 'const isStoreMgr =', 'const campaignEnabled =']) expect(s.indexOf(marker), marker).toBeLessThan(branch)
    // QLCH + cờ KPI campaign OFF ⇒ /targets chuyển /tasks ⇒ D1 không segmented (pm-auditor P1.4).
    expect(s).toContain('kpiTab={isStaff || campaignEnabled}')
    for (const marker of ['await fetchSmStores(', 'await fetchCampaignViews(', ".from('store_kpi_targets')", 'loadCampaignRangeActuals(']) {
      const i = s.indexOf(marker)
      expect(i, marker).toBeGreaterThan(branch)
    }
  })
  test('D2: cổng đăng nhập → FS → cờ CMS → staff / QLCH → RLS; không service role', () => {
    const s = read('app/(dashboard)/targets/cms/products/[programProductId]/page.tsx')
    const order = ["redirect('/login')", 'await redirectIfFsStaff(', 'if (!isCmsProgramEnabled()) notFound()', "profile?.role === 'staff' || profile?.role === 'store_manager'", 'cmsLoadStaffProduct(']
    let last = -1
    for (const m of order) { const i = s.indexOf(m); expect(i, m).toBeGreaterThan(last); last = i }
    expect(s).not.toContain('supabaseAdmin')
    const sc = read('lib/cms/server/staffCatalog.ts')
    expect(sc).not.toContain('supabaseAdmin')
    // D2 lọc trạng thái / hạn ngay ở truy vấn chương trình (phòng thủ chiều sâu, security-reviewer P2) + kiểm lại ở app.
    expect(sc).toContain(".eq('status', 'active').gte('end_date', today).maybeSingle()")
    expect(sc).toContain("program.status !== 'active' || program.endDate < today")
  })
  test('màn staff: không <img>; không gọi action; số liệu P2 chỉ khi `results` được truyền (mặc định off = P1)', () => {
    const dir = path.join(ROOT, 'components/cms/staff')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tsx'))) {
      const s = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      expect(s, f).not.toMatch(/<img[\s>]/)
      expect(s, f).not.toContain("from '@/app/actions/")
    }
    // P2-c (I3): chốt P1 "không hero / gợi ý / Nếu bán thêm / số thực tế / 0₫ giả" giữ ở RUNTIME — fixture không `p2` render
    // ĐÚNG view với results mặc định 'off' (ui-v2-cms-staff.spec FORBIDDEN); cờ CMS_EARNINGS_ENABLED OFF ⇒ loader trả 'off'
    // trước mọi RPC (cms-p2c-unit). U19 (QLCH không "của bạn") kiểm runtime ở ui-v2-cms-p2c.spec (fixture manager).
    for (const f of ['components/cms/staff/CmsStaffCatalogView.tsx', 'components/cms/staff/CmsStaffProductView.tsx']) {
      expect(read(f), f).toContain("results = { kind: 'off' }")
    }
  })
  test('BottomNav không đổi; fixture staff / product bọc boundary, route D2 không', () => {
    expect(read('components/layout/BottomNav.tsx')).not.toContain('tab=cms')
    for (const f of ['staff', 'product']) expectCatalogWrapped(`app/(dashboard)/ui-catalog/cms-v2/${f}/page.tsx`)
    expectBoundaryOnlyInCatalog(['app/(dashboard)/targets/cms/products/[programProductId]/page.tsx', 'app/(dashboard)/targets/page.tsx'])
  })
  test('view staff KPI: segment là prop tuỳ chọn (fixture KPI không truyền ⇒ không render)', () => {
    const s = read('components/kpi/StaffTargetsView.tsx')
    expect(s).toContain('segment?: React.ReactNode')
    expect((s.match(/segment=\{segment\}/g) ?? []).length).toBe(3)
  })
})
