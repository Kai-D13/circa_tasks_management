import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  CARE_SYNC_RPC_TIMEOUT_MS, parseSyncApply, parseSyncCandidates, runCareOrdersSync,
  type CareOrdersSyncDeps, type CareOrdersSyncResult,
} from '@/lib/care/orders/sync'
import { fetchN3Orders, preflightN3 } from './n3Source'

// CRM-CSKH B5b.2 — nối deps thật cho cron care-orders-sync: 3 RPC service_role của migration 114
// (care_order_sync_candidates / _apply / _fail) + đọc VIEW N3 bằng SA app. Lỗi DB/BigQuery chỉ thành MÃ
// (sync.ts) — không log/trả message thô (có thể chứa SQL/giá trị).

class SyncDbError extends Error {}

// Mỗi RPC một trần riêng phía app (timeout DB 8 s vẫn là chốt chính — xem CARE_SYNC_DB_TIMEOUT_MS).
const rpcSignal = () => AbortSignal.timeout(CARE_SYNC_RPC_TIMEOUT_MS)

const realDeps: CareOrdersSyncDeps = {
  async candidates(cap) {
    const { data, error } = await supabaseAdmin.rpc('care_order_sync_candidates', { p_cap: cap }).abortSignal(rpcSignal())
    if (error) throw new SyncDbError('candidates')
    return parseSyncCandidates(data)
  },
  preflight: () => preflightN3(),
  fetchOrders: (windows) => fetchN3Orders(windows),
  async apply(orders, snapshotAt) {
    const { data, error } = await supabaseAdmin.rpc('care_order_sync_apply', { p_orders: orders, p_snapshot_at: snapshotAt }).abortSignal(rpcSignal())
    if (error) throw new SyncDbError('apply')
    return parseSyncApply(data)
  },
  async fail(code, snapshotAt) {
    const { data, error } = await supabaseAdmin.rpc('care_order_sync_fail', { p_code: code, p_snapshot_at: snapshotAt }).abortSignal(rpcSignal())
    if (error) throw new SyncDbError('fail')
    return data === true
  },
  now: () => Date.now(),
}

export function syncCareOrders(): Promise<CareOrdersSyncResult> {
  return runCareOrdersSync(realDeps)
}
