// Ai được xem / được quản trị dashboard Chiến dịch KPI (batch 111).
//
// Trước đây mỗi nơi tự viết lại `role === 'admin' && isSuperAdminEmail(...)`:
// list, detail, export và sidebar — bốn bản sao của cùng một luật. Mở quyền cho
// SM mà sót một bản là ra đúng hai lỗi đã gặp ở batch trước: hoặc SM thấy danh
// sách rồi bấm vào nhận 404 (sót detail), hoặc SM thấy nút quản trị mà server
// mới từ chối (sót UI). Gom về đây, một nguồn.
import { isSuperAdminEmail } from '@/lib/authz'

export type CampaignStatusFilter = 'all' | 'active' | 'paused' | 'draft' | 'ended'

// XEM dashboard: super admin + SM. SM chỉ đọc, phạm vi do RLS (mig 111) quyết
// định — hàm này KHÔNG thay thế RLS, nó chỉ quyết định có render màn hình không.
export function canViewCampaignDashboard(
  role: string | null | undefined,
  email: string | null | undefined,
): boolean {
  if (role === 'sm') return true
  return role === 'admin' && isSuperAdminEmail(email)
}

// QUẢN TRỊ: tạo, đổi trạng thái, import target, sửa chỉ số, đồng bộ thủ công.
// SM tuyệt đối KHÔNG — contract "chỉ xem".
export function canManageCampaign(
  role: string | null | undefined,
  email: string | null | undefined,
): boolean {
  return role === 'admin' && isSuperAdminEmail(email)
}

// Giá trị lạ / thiếu → 'all'. KHÔNG throw: đây là query string, người dùng sửa
// tay được, và một filter hỏng không được làm sập cả trang.
export function parseCampaignStatus(raw: string | undefined | null): CampaignStatusFilter {
  const v = (raw ?? '').trim().toLowerCase()
  return v === 'active' || v === 'paused' || v === 'draft' || v === 'ended' ? v : 'all'
}

export interface CampaignStatusTab { key: CampaignStatusFilter; label: string }

// SM chỉ đọc được 'active' + 'ended' (RLS 111) ⇒ hiện tab 'Nháp'/'Tạm dừng' cho
// họ là mời bấm vào một danh sách chắc chắn rỗng.
export function campaignStatusTabs(canManage: boolean): CampaignStatusTab[] {
  const base: CampaignStatusTab[] = [{ key: 'all', label: 'Tất cả' }]
  if (canManage) {
    return [
      ...base,
      { key: 'active', label: 'Đang chạy' },
      { key: 'paused', label: 'Tạm dừng' },
      { key: 'draft', label: 'Nháp' },
      { key: 'ended', label: 'Kết thúc' },
    ]
  }
  return [...base, { key: 'active', label: 'Đang chạy' }, { key: 'ended', label: 'Kết thúc' }]
}

// Empty-state phải nói đúng vì sao trống. Bản cũ luôn mời "Tạo chiến dịch" —
// vô nghĩa với SM (không có quyền tạo) và sai khi chỉ là bộ lọc không khớp.
export function campaignEmptyText(
  status: CampaignStatusFilter, canManage: boolean, hasAny: boolean,
): string {
  if (hasAny) {
    const label: Record<Exclude<CampaignStatusFilter, 'all'>, string> = {
      active: 'đang chạy', paused: 'tạm dừng', draft: 'nháp', ended: 'đã kết thúc',
    }
    return status === 'all'
      ? 'Không có chiến dịch nào.'
      : `Không có chiến dịch ${label[status]}.`
  }
  return canManage
    ? 'Chưa có chiến dịch nào. Bấm “Tạo chiến dịch” để bắt đầu.'
    : 'Chưa có chiến dịch nào áp dụng cho các cửa hàng bạn quản lý.'
}
