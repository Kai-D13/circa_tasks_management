import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canViewCampaignDashboard } from '@/lib/kpi/campaignAccess'
import { isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { xlsxResponse, stampVN, fmtVN } from '@/lib/export/xlsx'
import { buildCampaignExportRows, buildCustomerCampaignExportRows, buildOrderAovCampaignExportRows } from '@/lib/kpi/exportRows'

// GET /api/export/kpi-campaigns?campaign_id=... — Excel of a campaign's per-store
// result (mirrors the /targets/campaigns/[id] Result tab).
//
// 111: super admin VÀ SM (SM chỉ-đọc, chốt 30/08). Phạm vi dữ liệu do RLS quyết
// định vì mọi truy vấn dưới đây dùng SESSION client — SM chỉ nhận campaign
// active/ended của vùng mình và chỉ những dòng store mình quản lý.

interface TargetRow {
  store_id: string; pos_code: string | null; kpi_target: number; store_kpi_group: string | null
  stores: { name: string } | null
}
interface ActualRow {
  store_id: string; actual_value: number; run_rate: number | null; remaining_target: number | null
  achieved_tier_order: number | null; store_commission_pool: number | null; synced_at: string
  actual_offline: number | null; actual_affiliate: number | null
  offline_synced_at: string | null; affiliate_synced_at: string | null
  actual_customer_count: number | null
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  // 111: SM tải được Excel (chốt 30/08). An toàn vì mọi truy vấn dưới đây dùng
  // SESSION client — RLS tự giới hạn campaign lẫn dòng target/actual về đúng
  // cửa hàng SM quản lý. KHÔNG cần lọc thêm ở đây, và cũng không được đổi sang
  // supabaseAdmin: làm vậy là xuất toàn hệ thống cho một SM.
  if (!(isKpiCampaignEnabled() && canViewCampaignDashboard(profile?.role, user.email)))
    return NextResponse.json({ error: 'Không có quyền xuất dữ liệu' }, { status: 403 })

  const campaignId = request.nextUrl.searchParams.get('campaign_id')
  if (!campaignId) return NextResponse.json({ error: 'Thiếu campaign_id' }, { status: 400 })

  const { data: c } = await supabase
    .from('kpi_campaigns').select('id, name, start_date, end_date, archived_at, metric_type, metric_offline, metric_affiliate').eq('id', campaignId).single()
  if (!c) return NextResponse.json({ error: 'Không tìm thấy chiến dịch' }, { status: 404 })
  // Archive (098): export archived không hoạt động qua UI/route.
  if (c.archived_at !== null) return NextResponse.json({ error: 'Chiến dịch đã lưu trữ' }, { status: 404 })

  const [{ data: targetsRaw, error: tErr }, { data: actualsRaw, error: aErr }] = await Promise.all([
    supabase.from('kpi_campaign_store_targets')
      .select('store_id, pos_code, kpi_target, store_kpi_group, order_target, aov_target, stores(name)')
      .eq('campaign_id', campaignId).order('pos_code'),
    supabase.from('kpi_campaign_store_actuals')
      .select('store_id, actual_value, actual_offline, actual_affiliate, offline_order_count, actual_customer_count, run_rate, remaining_target, achieved_tier_order, store_commission_pool, offline_synced_at, affiliate_synced_at, synced_at')
      .eq('campaign_id', campaignId),
  ])
  if (tErr || aErr) return NextResponse.json({ error: (tErr ?? aErr)!.message }, { status: 500 })

  const targets = (targetsRaw ?? []) as unknown as TargetRow[]
  const actuals = (actualsRaw ?? []) as ActualRow[]
  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)

  // P3-F r1: contract cột nằm trong builder THUẦN (có test khóa) — campaign
  // GMV GIỮ tên cột cũ 'Actual GMV' (Power Query); mig 103: campaign Số khách
  // dùng builder RIÊNG (cột đơn vị khách), branch theo metric_type từ DB.
  const exportCampaign = {
    name: c.name as string, start_date: c.start_date as string, end_date: c.end_date as string,
    metric_offline: c.metric_offline === true, metric_affiliate: c.metric_affiliate === true,
  }
  const rows = c.metric_type === 'affiliate_customer_count'
    ? buildCustomerCampaignExportRows(exportCampaign, targets, actuals, vnTodayISO, fmtVN)
    : c.metric_type === 'offline_order_aov'
      // Mig 106: builder riêng — cấu hình 2 sàn/2 mục tiêu + số đơn/AOV thực tế.
      ? buildOrderAovCampaignExportRows(exportCampaign, targets, actuals, vnTodayISO, fmtVN)
      : buildCampaignExportRows(exportCampaign, targets, actuals, vnTodayISO, fmtVN)

  return xlsxResponse(rows, 'Kết quả chiến dịch', `campaign_${(c.name as string).slice(0, 20)}_${stampVN()}`)
}
