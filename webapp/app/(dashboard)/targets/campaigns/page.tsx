import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import {
  canManageCampaign, canViewCampaignDashboard,
  parseCampaignStatus,
} from '@/lib/kpi/campaignAccess'

import { isKpiCampaignEnabled, isKpiAffiliateEnabled } from '@/lib/kpi/flags'
import { qualityKpiPass } from '@/lib/kpi/orderAov'
import { campaignOverviewValue } from '@/lib/kpi/campaignDisplay'
import { campaignListErrors, campaignListPct, campaignListReached } from '@/lib/kpi/campaignList'
import { CampaignListView } from '@/components/kpi/CampaignListView'

// Super-admin campaign dashboard (mockup "Các chiến dịch KPI đang áp dụng"):
// each campaign row shows Mục tiêu (SUM kpi_target) / Đã đạt (SUM actual_value)
// / % + progress bar / store count / last sync. Aggregates are computed
// app-side from two light queries (few campaigns × ≤26 stores).

// Mig 103: 'Mục tiêu/Đã đạt' theo đơn vị metric của TỪNG campaign (khách/₫)
// qua metricPresentation — gmv byte-equal formatter cũ.
// UI v2 Phase 2 · K-1: phần trình bày ở components/kpi/CampaignListView (dùng chung fixture catalog);
// page giữ cổng quyền, 3 truy vấn, phần gộp số — không đổi.

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const { status: statusParam } = await searchParams
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  // 111: SM xem được dashboard (chỉ đọc). Phạm vi dữ liệu KHÔNG do trang này
  // quyết định — cả ba query dưới đây dùng SESSION client nên RLS (mig 075+111)
  // đã thu hẹp sẵn: SM chỉ nhận campaign active/ended có target thuộc cửa hàng
  // mình, không thấy draft/paused/test/archived.
  if (!(isKpiCampaignEnabled() && canViewCampaignDashboard(profile?.role, user.email))) notFound()
  const canManage = canManageCampaign(profile?.role, user.email)
  // Chuẩn hoá theo QUYỀN: SM gõ ?status=draft/paused sẽ về 'all' (RLS không
  // cho họ đọc hai trạng thái đó ⇒ tab tương ứng cũng không tồn tại).
  const statusFilter = parseCampaignStatus(statusParam, canManage)

  const supabase = await createClient()
  const [
    { data: campaigns, error: campaignsErr },
    { data: targets, error: targetsErr },
    { data: actuals, error: actualsErr },
  ] = await Promise.all([
    supabase.from('kpi_campaigns')
      .select('id, name, start_date, end_date, status, is_test, updated_at, metric_type')
      .is('archived_at', null) // Archive (098): campaign lưu trữ biến mất khỏi list
      .order('created_at', { ascending: false }),
    supabase.from('kpi_campaign_store_targets').select('campaign_id, kpi_target'),
    supabase.from('kpi_campaign_store_actuals').select('campaign_id, actual_value, synced_at'),
  ])
  // A failed side-query must NOT render as "0đ / chưa đồng bộ" — that reads as
  // real data on a money screen. Surface it like the detail page does.
  const queryError = campaignsErr?.message ?? targetsErr?.message ?? actualsErr?.message ?? null
  if (queryError) console.error('[campaigns-list] query failed:', queryError)

  const agg = new Map<string, { stores: number; target: number; actual: number; pass: number; lastSync: string | null }>()
  const blank = () => ({ stores: 0, target: 0, actual: 0, pass: 0, lastSync: null as string | null })
  for (const t of (targets ?? [])) {
    const a = agg.get(t.campaign_id as string) ?? blank()
    a.stores += 1
    a.target += Number(t.kpi_target) || 0
    agg.set(t.campaign_id as string, a)
  }
  for (const r of (actuals ?? [])) {
    const a = agg.get(r.campaign_id as string) ?? blank()
    a.actual += Number(r.actual_value) || 0
    // 106: đạt KPI = completion >= 100 ⟺ đạt CẢ HAI mục tiêu (KHÔNG suy từ bậc).
    if (qualityKpiPass(r.actual_value as number | null)) a.pass += 1
    if (!a.lastSync || (r.synced_at as string) > a.lastSync) a.lastSync = r.synced_at as string
    agg.set(r.campaign_id as string, a)
  }

  const list = (campaigns ?? []) as { id: string; name: string; start_date: string; end_date: string; status: string; is_test: boolean; updated_at: string; metric_type?: string }[]
  // Thống kê tính trên TOÀN TẬP người xem được, KHÔNG theo tab đang chọn — nếu
  // đếm theo tab thì mọi ô sẽ bằng nhau và cả dải mất hết ý nghĩa.
  const counts = {
    total: list.length,
    active: list.filter((c) => c.status === 'active').length,
    paused: list.filter((c) => c.status === 'paused').length,
    draft: list.filter((c) => c.status === 'draft').length,
    ended: list.filter((c) => c.status === 'ended').length,
  }
  const shown = statusFilter === 'all' ? list : list.filter((c) => c.status === statusFilter)
  // Truy vấn chính lỗi ⇒ chỉ ErrorState; target/actual lỗi ⇒ danh sách KHÔNG số (spec PM: lỗi ≠ 0).
  const { campaignsError, sideError } = campaignListErrors(campaignsErr, targetsErr, actualsErr)

  return (
    <CampaignListView
      canManage={canManage}
      affiliateEnabled={isKpiAffiliateEnabled()}
      statusFilter={statusFilter}
      counts={counts}
      hasAny={list.length > 0}
      campaignsError={campaignsError}
      sideError={sideError}
      rows={shown.map((c) => {
        const a = agg.get(c.id) ?? blank()
        // Step 5.1: dòng giá trị + % lấy TỪ CONTRACT dùng chung (campaignOverviewValue) — một nguồn với màn SM;
        // tự lo ca 106 (Chất lượng bán hàng ⇒ số cửa hàng ĐẠT KPI thay vì tiền).
        const input = {
          metricType: c.metric_type,
          synced: a.lastSync !== null,
          storeCount: a.stores,
          totalTarget: a.target,
          totalActual: a.actual,
          qualityPassCount: a.pass,
        }
        // Màu "đạt" và % (chữ/thanh/ARIA) từ số THÔ (campaignList*), không từ % đã làm tròn của ov.
        return {
          ...c, stores: a.stores, lastSync: a.lastSync, ov: campaignOverviewValue(input),
          reached: campaignListReached(input), progress: campaignListPct(input),
        }
      })}
    />
  )
}
