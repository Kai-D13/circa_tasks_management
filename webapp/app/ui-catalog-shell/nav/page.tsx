import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { DashboardShell } from '@/components/layout/DashboardShell'
import { campaignNavItems } from '@/lib/layout/campaignNav'
import { opsSidebarVisible } from '@/lib/affiliate/overview'
import { canViewCmsAdmin } from '@/lib/cms/access'
import type { UserProfile } from '@/types'

// Dev-only fixture UI-NAV r1 (PM audit planning/reviews/2026-11-08-ui-nav-candidate-pm.md §3 UINAV-P1-2). Render ĐÚNG DashboardShell
// của (dashboard)/layout.tsx — Sidebar + <main> + BottomNav thật — với hồ sơ GIẢ cho các vai không có tài khoản QA: admin phòng
// được / không được cấp quyền Affiliate, FS staff, FS QLCH (+ staff OS / QLCH OS để đối chiếu). Props tính bằng đúng hàm thuần
// layout dùng (opsSidebarVisible → campaignNavItems, canViewCmsAdmin) với cờ do query chọn; kết quả tra phòng
// (affiliate_department_access) là đầu vào giả `grant`. Trang fixture tự nó không query dữ liệu nghiệp vụ, không RPC, không action;
// NHƯNG cổng dùng phiên / hồ sơ thật (getSessionProfile) và DashboardShell giữ NotificationProvider thật — vai khác staff vẫn poll
// SELECT notifications của PHIÊN super đang đăng nhập (không phải của hồ sơ giả). Hồ sơ giả chỉ là dữ liệu trình bày, KHÔNG phải phiên
// auth có quyền server. Đây là bằng chứng TRÌNH BÀY, không phải bằng chứng auth / route guard của các vai đó. Hồ sơ / cửa hàng /
// email đều giả (`example.invalid`).
// Cổng như /ui-catalog: UI_CATALOG=1 (Coolify không đặt ⇒ prod 404) + phiên super admin thật. Nằm ngoài nhóm (dashboard) để không
// lồng vào khung của chính phiên super.
// ?as= dept-affiliate · dept-plain · fs-staff · fs-qlch · staff-os · qlch-os · sm (UI-NAV r2: SM cho reflow D07)
//   — chỉ nhận khoá RIÊNG của FX (own-key); tên lạ / thuộc prototype (`__proto__`, `constructor`…) / lặp tham số ⇒ staff-os.
//  &kpi= &aff= &cms= (1 | 0; mặc định 1 — mô phỏng KPI_CAMPAIGN_ENABLED / KPI_AFFILIATE_ENABLED / CMS_PROGRAM_ENABLED)
//  &care=1 (CARE_ENABLED) · &badge=N (badge Tasks / Bảng tin) · &rows=N (số thẻ nội dung, mặc định 24) · &collapsed=1
export const dynamic = 'force-dynamic'

type FxKey = 'dept-affiliate' | 'dept-plain' | 'fs-staff' | 'fs-qlch' | 'staff-os' | 'qlch-os' | 'sm'
const FX: Record<FxKey, { role: UserProfile['role']; name: string; storeType: 'os' | 'fs' | null; department: string | null; grant: boolean }> = {
  'dept-affiliate': { role: 'admin', name: 'Admin phòng OPS (giả)', storeType: null, department: 'fx-dept-ops', grant: true },
  'dept-plain': { role: 'admin', name: 'Admin phòng MKT (giả)', storeType: null, department: 'fx-dept-mkt', grant: false },
  'fs-staff': { role: 'staff', name: 'Dược sĩ FS (giả)', storeType: 'fs', department: null, grant: false },
  'fs-qlch': { role: 'store_manager', name: 'QLCH FS (giả)', storeType: 'fs', department: null, grant: false },
  'staff-os': { role: 'staff', name: 'Dược sĩ OS (giả)', storeType: 'os', department: null, grant: false },
  'qlch-os': { role: 'store_manager', name: 'QLCH OS (giả)', storeType: 'os', department: null, grant: false },
  'sm': { role: 'sm', name: 'SM vùng (giả)', storeType: null, department: null, grant: false },
}
const fxKey = (v: unknown): FxKey => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(FX, v) ? (v as FxKey) : 'staff-os')

export default async function NavShellFixturePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile: viewer } = await getSessionProfile()
  if (!user || !viewer) redirect('/login')
  if (!(viewer.role === 'admin' && isSuperAdminEmail(user.email))) notFound()

  const q = await searchParams
  const key = fxKey(q.as)
  const fx = FX[key]
  const on = (v: string | undefined) => v !== '0'
  const kpiCampaignEnabled = on(q.kpi), kpiAffiliateEnabled = on(q.aff), cmsProgramEnabled = on(q.cms)
  const careEnabled = q.care === '1'
  const badge = Math.max(0, Math.min(999, Number(q.badge ?? 0) || 0))
  const rows = Math.max(1, Math.min(80, Number(q.rows ?? 24) || 24))

  const email = `${key}@example.invalid`
  const profile = {
    id: `00000000-0000-4000-8000-0000000000${String(Object.keys(FX).indexOf(key)).padStart(2, '0')}`,
    email, full_name: fx.name, role: fx.role, store_id: fx.storeType ? 'fx-store' : null,
    department_id: fx.department, created_at: '2026-11-08T00:00:00Z',
    stores: fx.storeType ? { id: 'fx-store', name: fx.storeType === 'fs' ? 'FS_TEST Nhà thuốc' : 'POS_TEST Nhà thuốc', code: 'FX01', address: null, region: null, created_at: '2026-11-08T00:00:00Z', store_type: fx.storeType } : undefined,
  } as UserProfile

  // Cùng phép suy như (dashboard)/layout.tsx — hồ sơ giả không bao giờ là super (email ngoài allowlist).
  const isFsStore = (fx.role === 'staff' || fx.role === 'store_manager') && fx.storeType === 'fs'
  const isStaff = fx.role === 'staff'
  const isSuper = fx.role === 'admin' && isSuperAdminEmail(email)
  const affiliateDeptAdmin = opsSidebarVisible({
    flagEnabled: kpiAffiliateEnabled && kpiCampaignEnabled,
    role: fx.role, isSuper,
    isDeptAdmin: fx.role === 'admin' && !isSuper && !!fx.department && fx.grant,
  })
  const campaignNav = campaignNavItems({
    role: fx.role, isSuper, isFsStore, kpiCampaignEnabled, kpiAffiliateEnabled, cmsProgramEnabled,
    affiliateDeptAdmin, cmsAdminView: canViewCmsAdmin(fx.role, email),
  })

  return (
    <DashboardShell
      profile={profile}
      isFsStore={isFsStore}
      announcementsUnread={fx.role !== 'admin' && !isFsStore ? badge : 0}
      tasksPending={isStaff && !isFsStore ? badge : 0}
      referralEnabled={false}
      campaignNav={campaignNav}
      sidebarCollapsed={q.collapsed === '1'}
      careNav={[]}
      careEnabled={careEnabled}
    >
      <div data-testid="nav-shell-fixture" data-fixture-as={key} className="space-y-3 p-4">
        <h1 className="text-lg font-semibold">Fixture khung điều hướng · {fx.name}</h1>
        <p className="text-sm text-muted-foreground">Hồ sơ giả — trang không truy vấn dữ liệu nghiệp vụ, không ghi (thông báo vẫn poll theo phiên đang đăng nhập). Chỉ để kiểm Sidebar / BottomNav / đệm đáy theo vai.</p>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} data-fixture-row={i + 1} className="rounded-lg border bg-card p-4 text-sm">Thẻ nội dung giả #{i + 1}</div>
        ))}
      </div>
    </DashboardShell>
  )
}
