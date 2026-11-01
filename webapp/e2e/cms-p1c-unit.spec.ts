import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  cmsDaysLeft, cmsDaysToStart, cmsDisplayStatus, cmsProgramActions, cmsTodayVn, CMS_STATUS_LABEL, CMS_STATUS_TONE,
} from '../lib/cms/programStatus'
import { cmsAmountPerUnit, cmsBaseQtyLine, cmsDate, cmsDateRange, cmsDateTime, cmsDecimal, cmsPrice, cmsTierRange, cmsVnd } from '../lib/cms/display'
import { cmsBuildListModel, cmsParseListFilter } from '../lib/cms/programList'
import { cmsCommitLabel } from '../lib/cms/importView'
import { CMS_FX_LIST, CMS_FX_TODAY } from '../lib/cms/fixtures'
import { expectBoundaryOnlyInCatalog, expectCatalogWrapped } from './fixtureGuard'

// CMS P1-c — phần thuần + kiểm tĩnh (không server, không mạng): trạng thái hiển thị theo ngày VN (UI §2.1, SPEC §4.7),
// định dạng tiền chuỗi bigint / thập phân (null ⇒ '—', không '0₫' giả), model A1 (đếm toàn tập, thống kê loại QA, tìm
// tên / ProductID), nhãn xác nhận ghi (U16); guard fixture cho mọi component CMS gọi action / export; cấm <img>.

const ROOT = path.join(__dirname, '..')
const P = (status: 'draft' | 'active' | 'locked', startDate: string, endDate: string) => ({ status, startDate, endDate })

test.describe('CMS P1-c · trạng thái + quyền hành động @desktop', () => {
  test('ngày VN: 17:00 UTC hôm trước = 00:00 VN hôm sau', () => {
    expect(cmsTodayVn(new Date('2026-11-14T16:59:59Z'))).toBe('2026-11-14')
    expect(cmsTodayVn(new Date('2026-11-14T17:00:00Z'))).toBe('2026-11-15')
  })
  test('trạng thái hiển thị: nháp / sắp diễn ra / đang chạy (cả hai đầu) / chờ chốt kỳ / đã chốt', () => {
    const t = '2026-11-15'
    expect(cmsDisplayStatus(P('draft', '2026-01-01', '2026-01-02'), t)).toBe('draft')
    expect(cmsDisplayStatus(P('active', '2026-11-16', '2026-11-30'), t)).toBe('upcoming')
    expect(cmsDisplayStatus(P('active', '2026-11-15', '2026-11-30'), t)).toBe('running')
    expect(cmsDisplayStatus(P('active', '2026-11-01', '2026-11-15'), t)).toBe('running')
    expect(cmsDisplayStatus(P('active', '2026-11-01', '2026-11-14'), t)).toBe('waiting_close')
    expect(cmsDisplayStatus(P('locked', '2026-11-01', '2026-11-30'), t)).toBe('locked')
    expect(Object.keys(CMS_STATUS_LABEL).sort()).toEqual(Object.keys(CMS_STATUS_TONE).sort())
    expect(CMS_STATUS_TONE).toEqual({ draft: 'neutral', upcoming: 'info', running: 'success', waiting_close: 'warning', locked: 'neutral' })
  })
  test('còn N ngày (tính cả hôm nay) chỉ khi đang chạy; bắt đầu sau N ngày chỉ khi sắp diễn ra', () => {
    const t = '2026-11-15'
    expect(cmsDaysLeft(P('active', '2026-11-01', '2026-11-15'), t)).toBe(1)
    expect(cmsDaysLeft(P('active', '2026-11-01', '2026-11-30'), t)).toBe(16)
    expect(cmsDaysLeft(P('active', '2026-11-16', '2026-11-30'), t)).toBeNull()
    expect(cmsDaysToStart(P('active', '2026-11-16', '2026-11-30'), t)).toBe(1)
    expect(cmsDaysToStart(P('draft', '2026-11-16', '2026-11-30'), t)).toBeNull()
  })
  test('quyền hành động = SPEC §4.7; SM (không quản lý) không có nút nào', () => {
    const t = '2026-11-15'
    expect(cmsProgramActions(P('draft', '2026-11-01', '2026-11-30'), t, 0, true)).toEqual({ edit: true, importMode: 'replace', activate: false })
    expect(cmsProgramActions(P('draft', '2026-11-01', '2026-11-30'), t, 3, true)).toEqual({ edit: true, importMode: 'replace', activate: true })
    expect(cmsProgramActions(P('active', '2026-11-16', '2026-11-30'), t, 3, true)).toEqual({ edit: true, importMode: 'replace', activate: false })
    expect(cmsProgramActions(P('active', '2026-11-15', '2026-11-30'), t, 3, true)).toEqual({ edit: false, importMode: 'append', activate: false })
    expect(cmsProgramActions(P('active', '2026-11-01', '2026-11-10'), t, 3, true)).toEqual({ edit: false, importMode: 'append', activate: false })
    expect(cmsProgramActions(P('locked', '2026-11-01', '2026-11-10'), t, 3, true)).toEqual({ edit: false, importMode: null, activate: false })
    expect(cmsProgramActions(P('draft', '2026-11-01', '2026-11-30'), t, 3, false)).toEqual({ edit: false, importMode: null, activate: false })
  })
})

test.describe('CMS P1-c · định dạng @desktop', () => {
  test('tiền từ chuỗi bigint không mất chữ số; null / sai dạng ⇒ —', () => {
    expect(cmsVnd('15000')).toBe('15.000₫')
    expect(cmsVnd('9223372036854775807')).toBe('9.223.372.036.854.775.807₫')
    expect(cmsVnd(null)).toBe('—')
    expect(cmsVnd('1.5')).toBe('—')
    expect(cmsVnd(undefined)).toBe('—')
  })
  test('thập phân / giá / quy cách / bậc', () => {
    expect(cmsDecimal('1000.25')).toBe('1.000,25')
    expect(cmsDecimal('24')).toBe('24')
    expect(cmsDecimal('0.000000001')).toBe('0,000000001')
    expect(cmsPrice('9.5')).toBe('9,5₫')
    expect(cmsPrice(null)).toBe('—')
    expect(cmsBaseQtyLine('hộp', '24')).toBe('1 hộp = 24 đơn vị cơ sở')
    expect([cmsTierRange(1, 9), cmsTierRange(20, null), cmsTierRange(5, 5)]).toEqual(['1–9', '20+', '5'])
    expect(cmsAmountPerUnit('15000', 'hộp')).toBe('15.000₫/hộp')
  })
  test('ngày', () => {
    expect(cmsDate('2026-11-05')).toBe('05/11/2026')
    expect(cmsDateRange('2026-11-01', '2026-11-30')).toBe('01/11 – 30/11/2026')
    expect(cmsDateRange('2026-12-15', '2027-01-15')).toBe('15/12/2026 – 15/01/2027')
    expect(cmsDateTime('2026-11-10T03:05:00Z')).toBe('10/11/2026 10:05')
    expect(cmsDateTime(null)).toBe('—')
  })
  test('nhãn xác nhận ghi theo chế độ; N = 0 ⇒ ẩn', () => {
    expect(cmsCommitLabel('replace', 3)).toBe('Nạp danh mục (thay toàn bộ, 3 sản phẩm)')
    expect(cmsCommitLabel('append', 2)).toBe('Thêm 2 sản phẩm')
    expect(cmsCommitLabel('append', 0)).toBeNull()
  })
})

test.describe('CMS P1-c · model A1 @desktop', () => {
  test('đếm toàn tập; thống kê đang chạy LOẠI QA; tìm tên / ProductID; SM không có lọc Nháp', () => {
    const m = cmsBuildListModel(CMS_FX_LIST, { canManage: true, today: CMS_FX_TODAY, filter: 'all', q: '' })
    expect(m.counts).toMatchObject({ all: 6, running: 2, upcoming: 1, draft: 1, waiting_close: 1, locked: 1 })
    expect(m.stats).toEqual({ running: 1, productsRunning: 2 })
    expect(cmsBuildListModel(CMS_FX_LIST, { canManage: true, today: CMS_FX_TODAY, filter: 'all', q: '900010' }).rows.map((r) => r.name)).toEqual(['CMS Men vi sinh tháng 12'])
    expect(cmsBuildListModel(CMS_FX_LIST, { canManage: true, today: CMS_FX_TODAY, filter: 'all', q: 'khẩu TRANG' }).rows.length).toBe(1)
    expect(cmsBuildListModel(CMS_FX_LIST, { canManage: true, today: CMS_FX_TODAY, filter: 'locked', q: '' }).rows.map((r) => r.display)).toEqual(['locked'])
    expect(cmsParseListFilter('draft', false)).toBe('all')
    expect(cmsParseListFilter('draft', true)).toBe('draft')
    expect(cmsParseListFilter('xyz', true)).toBe('all')
    expect(cmsParseListFilter('locked', false)).toBe('all')
    expect(cmsParseListFilter('waiting_close', false)).toBe('waiting_close')
    expect(cmsBuildListModel(CMS_FX_LIST, { canManage: false, today: CMS_FX_TODAY, filter: 'all', q: '' }).rows.every((r) => r.lastImport === null)).toBe(true)
  })
})

test.describe('CMS P1-c · kiểm tĩnh @desktop', () => {
  const walk = (d: string): string[] => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  const cmsFiles = walk('components/cms').filter((f) => f.endsWith('.tsx'))

  test('mọi component CMS gọi server action / fetch ghi / link export đều qua useFixtureActionBlocked()', () => {
    const risky = cmsFiles.filter((f) => {
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8')
      return s.includes("from '@/app/actions/") || /fetch\(['"`]\/api\/cms/.test(s) || s.includes('/api/cms/import/errors')
    })
    expect(risky.length).toBeGreaterThan(0)
    for (const f of risky) expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).toContain('useFixtureActionBlocked()')
  })
  test('H8 / U7: không có nút / action xoá, huỷ chương trình, về nháp, tạm dừng', () => {
    for (const f of cmsFiles) {
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8')
      expect(s, f).not.toMatch(/(Xoá|Xóa|Huỷ|Hủy) chương trình|Về nháp|Tạm dừng|deleteCms|cancelCms|revertCms|pauseCms/)
    }
    const actions = fs.readFileSync(path.join(ROOT, 'app/actions/cmsPrograms.ts'), 'utf8')
    expect(actions.match(/export async function (\w+)/g)).toEqual(['export async function createCmsProgram', 'export async function updateCmsProgram', 'export async function activateCmsProgram'])
  })
  test('không dùng <img> trong components/cms (ảnh qua next/image + allowlist — U10)', () => {
    for (const f of cmsFiles) expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).not.toMatch(/<img[\s>]/)
  })
  test('route thật không bọc boundary fixture; fixture cms-v2 bọc đủ', () => {
    const routes = walk('app/(dashboard)/targets/campaigns/cms').filter((f) => f.endsWith('page.tsx'))
    expect(routes.length).toBe(5)
    expectBoundaryOnlyInCatalog(routes)
    for (const f of ['list', 'wizard', 'detail']) expectCatalogWrapped(`app/(dashboard)/ui-catalog/cms-v2/${f}/page.tsx`)
  })
  test('mọi route CMS chặn bởi cờ CMS_PROGRAM_ENABLED + quyền; trang quản lý chỉ super', () => {
    const dir = 'app/(dashboard)/targets/campaigns/cms'
    for (const f of ['page.tsx', '[id]/page.tsx']) {
      const s = fs.readFileSync(path.join(ROOT, dir, f), 'utf8')
      expect(s, f).toContain('isCmsProgramEnabled() && canViewCmsAdmin(')
    }
    for (const f of ['new/page.tsx', '[id]/edit/page.tsx', '[id]/import/page.tsx']) {
      const s = fs.readFileSync(path.join(ROOT, dir, f), 'utf8')
      expect(s, f).toContain('isCmsProgramEnabled() && canManageCms(')
    }
  })
  test('remotePatterns ảnh CMS đúng host + prefix, không wildcard host', () => {
    const s = fs.readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8')
    expect(s).toMatch(/hostname: 'cdn-gcs\.thuocsi\.vn',\s*pathname: '\/thuocsi-live\/images\/\*\*'/)
    expect(s).not.toMatch(/hostname: '\*\*?'/)
  })
  test('CampaignsTabs: tab CMS độc lập cờ Affiliate; không cờ nào ⇒ null như cũ', () => {
    const s = fs.readFileSync(path.join(ROOT, 'components/kpi/CampaignsTabs.tsx'), 'utf8')
    expect(s).toContain('if (!affiliateEnabled && !cmsEnabled) return null')
    expect(s).toContain("...(cmsEnabled ? [{ key: 'cms' as const, label: 'CMS sản phẩm', href: '/targets/campaigns/cms' }] : [])")
  })
})
