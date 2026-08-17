import 'server-only'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { getAffiliateSyncHealth, supabaseAffiliateHealthDb } from '@/lib/affiliate/health'
import type { CampaignDailyRow } from '@/lib/kpi/campaignRangeModel'
import type { CustomerRangeRows, RangeReadDeps } from '@/lib/kpi/campaignRangeServer'

// Adapter PRODUCTION cho tầng đọc range (17/08) — server-only.
//
// Ranh giới quyền, đây là điểm mấu chốt của cả tính năng:
//   · targets + daily đọc bằng SESSION client ⇒ RLS của chính người đang xem
//     quyết định phạm vi. Super thấy mọi store; SM chỉ store được phân công
//     (is_sm_for_store); QLCH/staff chỉ store mình. Không có nhánh nào nhận
//     store_id từ query string.
//   · service-role CHỈ dùng cho RPC số khách và health Affiliate — hai thứ
//     grant service_role-only. Chúng chạy SAU khi storeIds đã derive từ targets
//     dưới RLS, nên không mở rộng được phạm vi.

// Client tối thiểu — tránh phụ thuộc kiểu Supabase generic ở tầng này.
interface QueryClient {
  from: (table: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function createRangeReadDeps(session: QueryClient): RangeReadDeps {
  return {
    loadTargetStoreIds: async (campaignId) => {
      const { data, error } = await session
        .from('kpi_campaign_store_targets')
        .select('store_id')
        .eq('campaign_id', campaignId)
      if (error) return { data: null, error }
      if (!Array.isArray(data)) return { data: null, error: null }
      // Dedupe + loại giá trị rỗng: một store xuất hiện hai lần sẽ nhân đôi
      // mẫu số "X/Y cửa hàng" và làm seed của model sai.
      const ids = [...new Set(
        (data as { store_id: string | null }[])
          .map((r) => r.store_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      )]
      return { data: ids, error: null }
    },

    loadDaily: async (campaignId, storeIds, from, to) => {
      const { data, error } = await session
        .from('kpi_campaign_store_daily_actuals')
        .select('store_id, date, gmv, gmv_affiliate, offline_order_count')
        .eq('campaign_id', campaignId)
        .in('store_id', storeIds)
        .gte('date', from)
        .lte('date', to)
      if (error) return { data: null, error }
      if (!Array.isArray(data)) return { data: null, error: null }
      // Supabase trả numeric dạng string ⇒ ép số NGAY tại biên, để model thuần
      // không phải đoán kiểu. Giá trị không parse được giữ null (model phân
      // biệt null với 0).
      const rows: CampaignDailyRow[] = (data as Record<string, unknown>[]).map((r) => ({
        store_id: String(r.store_id),
        date: String(r.date),
        gmv: toNum(r.gmv),
        gmv_affiliate: toNum(r.gmv_affiliate),
        offline_order_count: toInt(r.offline_order_count),
      }))
      return { data: rows, error: null }
    },

    aggregateCustomers: async (storeIds, fromTs, toTs) => {
      const { data, error } = await supabaseAdmin
        .rpc('rpc_aggregate_affiliate_customers', { p_store_ids: storeIds, p_from: fromTs, p_to: toTs })
      return { data: (data ?? null) as CustomerRangeRows | null, error }
    },

    getAffiliateHealth: async (storeIds) => {
      const h = await getAffiliateSyncHealth(supabaseAffiliateHealthDb(supabaseAdmin), storeIds)
      return { ready: h.ready, reason: h.reason ?? undefined, runId: h.runId }
    },
  }
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}
