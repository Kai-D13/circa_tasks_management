import { test, expect } from '@playwright/test'
import {
  campaignEmptyText, campaignStatusTabs, canManageCampaign, canViewCampaignDashboard,
  parseCampaignStatus,
} from '../lib/kpi/campaignAccess'

// Contract quyền + bộ lọc của dashboard Chiến dịch KPI (batch 111).
// Đây là màn LƯƠNG THƯỞNG: sai một nhánh là SM đọc được chiến dịch ngoài vùng
// hoặc bấm được nút quản trị. Khoá bằng test, không bằng đọc lại code.

const SUPER = 'hoangvudn96@gmail.com'
const NOT_SUPER = 'nguoi.la@buymed.com'

test.describe('campaign access contract @desktop', () => {
  test('XEM: super admin + SM; mọi vai trò khác KHÔNG', () => {
    expect(canViewCampaignDashboard('admin', SUPER)).toBe(true)
    expect(canViewCampaignDashboard('sm', 'bat.ky@buymed.com')).toBe(true)
    // admin thường (không trong allowlist) vẫn KHÔNG được — giữ nguyên luật cũ
    expect(canViewCampaignDashboard('admin', NOT_SUPER)).toBe(false)
    for (const r of ['staff', 'store_manager', null, undefined, 'khong_ton_tai']) {
      expect(canViewCampaignDashboard(r, SUPER), `role=${r}`).toBe(false)
    }
  })

  test('QUẢN TRỊ: chỉ super admin — SM tuyệt đối không', () => {
    expect(canManageCampaign('admin', SUPER)).toBe(true)
    expect(canManageCampaign('sm', SUPER), 'SM dù trùng email allowlist vẫn không quản trị').toBe(false)
    expect(canManageCampaign('sm', 'sm@buymed.com')).toBe(false)
    expect(canManageCampaign('admin', NOT_SUPER)).toBe(false)
    expect(canManageCampaign('staff', SUPER)).toBe(false)
  })

  test('parse status: allowlist, giá trị lạ → all (không throw)', () => {
    for (const v of ['active', 'paused', 'draft', 'ended']) {
      expect(parseCampaignStatus(v)).toBe(v)
    }
    expect(parseCampaignStatus('ENDED')).toBe('ended')      // hoa/thường
    expect(parseCampaignStatus('  ended ')).toBe('ended')   // khoảng trắng
    for (const v of ['all', '', '  ', undefined, null, 'archived', 'xxx', 'ended;drop']) {
      expect(parseCampaignStatus(v as string | undefined), `raw=${JSON.stringify(v)}`).toBe('all')
    }
  })

  test('tab: super 5, SM 3 — SM KHÔNG có Nháp/Tạm dừng (RLS không cho đọc)', () => {
    expect(campaignStatusTabs(true).map((t) => t.key))
      .toEqual(['all', 'active', 'paused', 'draft', 'ended'])
    const sm = campaignStatusTabs(false)
    expect(sm.map((t) => t.key)).toEqual(['all', 'active', 'ended'])
    for (const dead of ['draft', 'paused']) {
      expect(sm.map((t) => t.key), `SM không được có tab ${dead}`).not.toContain(dead)
    }
  })

  test('empty-state nói ĐÚNG lý do trống', () => {
    // có dữ liệu nhưng tab không khớp → nói về bộ lọc
    expect(campaignEmptyText('ended', true, true)).toBe('Không có chiến dịch đã kết thúc.')
    expect(campaignEmptyText('all', true, true)).toBe('Không có chiến dịch nào.')
    // hoàn toàn trống: super được mời tạo, SM thì không (không có quyền tạo)
    expect(campaignEmptyText('all', true, false)).toContain('Tạo chiến dịch')
    const smText = campaignEmptyText('all', false, false)
    expect(smText).not.toContain('Tạo chiến dịch')
    expect(smText).toContain('cửa hàng bạn quản lý')
  })
})
