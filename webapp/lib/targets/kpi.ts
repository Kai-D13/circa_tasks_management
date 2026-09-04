import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { buildKpiUpsertPlan, type KpiGrain, type KpiUpsertPlan } from './kpiPlan'

// KPI v2 ingest — BQ-V2 r2 (audit P1#1+#2): IO MỎNG quanh planner THUẦN
// (lib/targets/kpiPlan — có test khóa). Nguồn schema V2 — bảng buymed_tech
// pre-aggregated (112 04/09: actual = offline_net_revenue, cột net_revenue cũ
// đã bị BI xoá; target = cột TARGET; WEEK chưa bật).
//
// ATOMIC GATE: plan.ok=false (thiếu store×grain / nguồn trùng dòng / unmatched
// / row hỏng) → KHÔNG upsert BẤT KỲ row nào — không bao giờ đồng bộ một phần
// (store này số mới, store kia snapshot cũ trong khi cron báo xanh).
// Coverage kỳ vọng = tập ACTIVE OS stores (store biến mất khỏi nguồn bị bắt).
// Service-role writes — the table has no write RLS by design. Caller (cron)
// handles auth + trả 422 khi ok=false.

export interface KpiAggregateResult extends Omit<KpiUpsertPlan, 'payload'> {
  upserted: number
  periods: Record<KpiGrain, number>
}

export async function aggregateAndUpsertKpi(
  rawRows: Record<string, unknown>[],
): Promise<KpiAggregateResult> {
  // ACTIVE OS stores only — FS (mig 076) và store soft-deactivate (mig 074)
  // không thuộc tập coverage kỳ vọng của landing KPI.
  const { data: stores, error } = await supabaseAdmin
    .from('stores').select('id, name, code')
    .eq('store_type', 'os').eq('is_active', true)
  if (error) throw new Error(error.message)

  const plan = buildKpiUpsertPlan(rawRows, stores ?? [], new Date().toISOString())
  const { payload, ...rest } = plan

  if (!plan.ok) {
    // Fail-closed toàn phần — caller (route) trả 422 kèm chi tiết.
    return { ...rest, upserted: 0 }
  }

  if (payload.length) {
    const { error: upErr } = await supabaseAdmin
      .from('store_kpi_targets')
      .upsert(payload, { onConflict: 'store_id,period_type,period_start' })
    if (upErr) throw new Error(upErr.message)
  }

  return { ...rest, upserted: payload.length }
}
