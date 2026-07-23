import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { xlsxResponse, stampVN, fmtVN } from '@/lib/export/xlsx'
import { campaignPerformance } from '@/lib/kpi/performance'

// GET /api/export/kpi-campaigns?campaign_id=... — Excel of a campaign's per-store
// result (super admin only; mirrors the /targets/campaigns/[id] Result tab).

interface TargetRow {
  store_id: string; pos_code: string | null; kpi_target: number; store_kpi_group: string | null
  stores: { name: string } | null
}
interface ActualRow {
  store_id: string; actual_value: number; run_rate: number | null; remaining_target: number | null
  achieved_tier_order: number | null; store_commission_pool: number | null; synced_at: string
  actual_offline: number | null; actual_affiliate: number | null
  offline_synced_at: string | null; affiliate_synced_at: string | null
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email) && isKpiCampaignEnabled()))
    return NextResponse.json({ error: 'Không có quyền xuất dữ liệu' }, { status: 403 })

  const campaignId = request.nextUrl.searchParams.get('campaign_id')
  if (!campaignId) return NextResponse.json({ error: 'Thiếu campaign_id' }, { status: 400 })

  const { data: c } = await supabase
    .from('kpi_campaigns').select('id, name, start_date, end_date, metric_offline, metric_affiliate').eq('id', campaignId).single()
  if (!c) return NextResponse.json({ error: 'Không tìm thấy chiến dịch' }, { status: 404 })

  const [{ data: targetsRaw, error: tErr }, { data: actualsRaw, error: aErr }] = await Promise.all([
    supabase.from('kpi_campaign_store_targets')
      .select('store_id, pos_code, kpi_target, store_kpi_group, stores(name)')
      .eq('campaign_id', campaignId).order('pos_code'),
    supabase.from('kpi_campaign_store_actuals')
      .select('store_id, actual_value, actual_offline, actual_affiliate, run_rate, remaining_target, achieved_tier_order, store_commission_pool, offline_synced_at, affiliate_synced_at, synced_at')
      .eq('campaign_id', campaignId),
  ])
  if (tErr || aErr) return NextResponse.json({ error: (tErr ?? aErr)!.message }, { status: 500 })

  const targets = (targetsRaw ?? []) as unknown as TargetRow[]
  const actuals = (actualsRaw ?? []) as ActualRow[]
  const actualByStore = new Map(actuals.map((a) => [a.store_id, a]))
  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)

  // P3-F: breakdown 2 nguồn + timestamp từng nguồn + trạng thái nguồn Affiliate
  // (chỉ số vẫn theo RLS/role gate sẵn có — route này super-admin only).
  const metricAffiliate = c.metric_affiliate === true
  const affiliateStatus = (a: ActualRow | undefined): string => {
    if (!metricAffiliate) return 'Không áp dụng'
    if (!a || a.affiliate_synced_at === null) return 'Chưa đồng bộ'
    return 'Đã đồng bộ'
  }
  const rows = targets.map((t) => {
    const a = actualByStore.get(t.store_id)
    const perf = campaignPerformance(t.kpi_target, a?.actual_value ?? null, c.start_date, c.end_date, vnTodayISO)
    return {
      'Chiến dịch':   c.name as string,
      'Từ ngày':      c.start_date as string,
      'Đến ngày':     c.end_date as string,
      'POS':          t.pos_code ?? '',
      'Cửa hàng':     t.stores?.name ?? '',
      'Phân loại':    t.store_kpi_group ?? '',
      'KPI target':   Number(t.kpi_target) || 0,
      'GMV Offline':  a?.actual_offline != null ? Number(a.actual_offline) || 0 : '',
      'GMV Affiliate': a?.actual_affiliate != null ? Number(a.actual_affiliate) || 0 : '',
      'GMV Total':    a ? Number(a.actual_value) || 0 : '',
      'Run rate %':   a?.run_rate != null ? Number(a.run_rate.toFixed(1)) : '',
      'Performance %': perf != null ? Number(perf.toFixed(1)) : '',
      'Còn thiếu':    a?.remaining_target != null ? Number(a.remaining_target) || 0 : '',
      'Bậc đạt':      a?.achieved_tier_order ?? '',
      'Commission pool': a?.store_commission_pool != null ? Number(a.store_commission_pool) || 0 : '',
      'Offline Synced At':   a?.offline_synced_at ? fmtVN(a.offline_synced_at) : '',
      'Affiliate Synced At': a?.affiliate_synced_at ? fmtVN(a.affiliate_synced_at) : '',
      'Affiliate Data Status': affiliateStatus(a),
      'Đồng bộ lúc':  a ? fmtVN(a.synced_at) : '',
    }
  })

  return xlsxResponse(rows, 'Kết quả chiến dịch', `campaign_${(c.name as string).slice(0, 20)}_${stampVN()}`)
}
