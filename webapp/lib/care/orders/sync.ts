// CRM-CSKH B5b.2 — điều phối MỘT lượt đồng bộ đơn N3 (THUẦN, IO tiêm qua deps) theo SPEC §B5b.
//   1. candidates (RPC service_role, một jsonb): chụp tập khoảng + snapshot_at của DB. Số khoảng > trần ⇒
//      CANDIDATES_OVER_CAP (Q-98: báo riêng số khoảng / số khách).
//   2. Không khoảng nào ⇒ bỏ qua BigQuery, apply lô rỗng (đã đọc đủ phạm vi ⇒ thành công).
//   3. preflight VIEW: có mốc hoàn tất ở tương lai ⇒ SOURCE_TIME_FUTURE (Q-100; không tự đổi múi giờ).
//   4. đọc + kiểm TOÀN BỘ các lô (collectN3Orders) ⇒ lỗi bất kỳ ⇒ SOURCE_<mã>, KHÔNG gọi apply.
//   5. apply (RPC, một transaction): ghi đơn + tính lại + dọn queue + đánh dấu thành công; lỗi ⇒ DB_APPLY_FAILED.
// Mọi thất bại ⇒ fail(mã, snapshot) chỉ ghi MÃ (CHECK DB), giữ dữ liệu cũ; lỗi khi ghi mã cũng không ném.
// Kết quả chỉ có số đếm/mã — KHÔNG ID khách, DHC, timestamp đơn, message thô.
import type { CareN3Order } from './n3'
import {
  CARE_N3_MAX_WINDOWS, careN3ErrorCode,
  type CareN3FetchResult, type CareN3Preflight, type CareN3SourceCode, type CareN3Window,
} from './source'

/** Prod: `authenticator` statement_timeout = lock_timeout = 8 s (service_role không có setting riêng) ⇒ RPC
 *  quá hạn bị PostgREST huỷ (57014/55P03) ⇒ rollback cả lượt ⇒ DB_*_FAILED, giữ dữ liệu cũ. Đo RPC thật ở B6
 *  (SPEC §B5b); chậm ⇒ giảm trần lô, không nới timeout âm thầm. */
export const CARE_SYNC_DB_TIMEOUT_MS = 8_000
/** Trần phía app cho mỗi RPC (chống treo mạng/Kong) — lớn hơn timeout DB để không cắt RPC đang chạy hợp lệ. */
export const CARE_SYNC_RPC_TIMEOUT_MS = 30_000
/** = biên `p_snapshot_at >= now() - interval '2 hours'` của care_order_sync_apply/fail (spec ép khớp SQL). Một
 *  lượt tối đa ≈ preflight + 2 job BigQuery × 120 s + 3 RPC × 30 s ≪ 2 giờ. */
export const CARE_SYNC_SNAPSHOT_MAX_AGE_MS = 2 * 3600_000

export interface CareSyncCandidates { snapshotAt: string; windows: number; customers: number; items: CareN3Window[] }
export interface CareSyncAttribution { scope: number; upserted: number; deleted: number }
export interface CareSyncApplyResult { orders: number; ordersWritten: number; attribution: CareSyncAttribution; queueDrained: number }

export type CareSyncFailCode =
  | 'DB_CANDIDATES_FAILED' | 'CANDIDATES_OVER_CAP' | 'SOURCE_TIME_FUTURE' | 'DB_APPLY_FAILED'
  | `SOURCE_${Uppercase<CareN3SourceCode>}`

/** Mã nguồn N3 ⇒ mã lưu DB (khớp CHECK `^[A-Z][A-Z0-9_]{0,63}$`). */
export function careSyncSourceCode(code: CareN3SourceCode): CareSyncFailCode {
  return `SOURCE_${code.toUpperCase()}` as CareSyncFailCode
}

export interface CareOrdersSyncDeps {
  candidates(cap: number): Promise<CareSyncCandidates>
  preflight(): Promise<CareN3Preflight>
  fetchOrders(windows: CareN3Window[]): Promise<CareN3FetchResult>
  apply(orders: CareN3Order[], snapshotAt: string): Promise<CareSyncApplyResult>
  fail(code: CareSyncFailCode, snapshotAt: string): Promise<boolean>
  now(): number
}

export interface CareOrdersSyncResult {
  ok: boolean
  code?: CareSyncFailCode
  snapshotAt: string | null
  /** Q-98: số khoảng terminal chưa Có đơn và số khách duy nhất — báo riêng. */
  windows: number | null
  customers: number | null
  emptyWindows: number
  orders: number
  ordersWritten: number
  jobs: number
  pages: number
  bytesProcessed: number | null
  preflight: { futureCount: number; maxAgeMinutes: number | null } | null
  attribution: CareSyncAttribution | null
  queueDrained: number
  /** Chỉ khi thất bại: mã đã được ghi vào care_sync_state chưa (false = lượt cũ hơn/ghi lỗi). */
  failRecorded: boolean | null
  elapsedMs: number
}

export async function runCareOrdersSync(deps: CareOrdersSyncDeps, cap = CARE_N3_MAX_WINDOWS): Promise<CareOrdersSyncResult> {
  const t0 = deps.now()
  const res: CareOrdersSyncResult = {
    ok: false, snapshotAt: null, windows: null, customers: null, emptyWindows: 0, orders: 0, ordersWritten: 0,
    jobs: 0, pages: 0, bytesProcessed: null, preflight: null, attribution: null, queueDrained: 0, failRecorded: null, elapsedMs: 0,
  }
  const finish = () => { res.elapsedMs = deps.now() - t0; return res }
  const failWith = async (code: CareSyncFailCode, snapshotAt: string) => {
    res.ok = false
    res.code = code
    try { res.failRecorded = await deps.fail(code, snapshotAt) } catch { res.failRecorded = false }
    return finish()
  }

  let cand: CareSyncCandidates
  try {
    cand = await deps.candidates(cap)
  } catch {
    // Chưa có snapshot của DB ⇒ dùng đồng hồ app (RPC fail tự kiểm biên).
    return failWith('DB_CANDIDATES_FAILED', new Date(deps.now()).toISOString())
  }
  res.snapshotAt = cand.snapshotAt
  res.windows = cand.windows
  res.customers = cand.customers
  if (cand.windows > cap || cand.items.length > cap) return failWith('CANDIDATES_OVER_CAP', cand.snapshotAt)

  let orders: CareN3Order[] = []
  if (cand.items.length > 0) {
    try {
      const pre = await deps.preflight()
      res.preflight = { futureCount: pre.futureCount, maxAgeMinutes: pre.maxAgeMinutes }
      if (pre.futureCount > 0) return failWith('SOURCE_TIME_FUTURE', cand.snapshotAt)
    } catch (err) {
      return failWith(careSyncSourceCode(careN3ErrorCode(err)), cand.snapshotAt)
    }
    try {
      const fetched = await deps.fetchOrders(cand.items)
      orders = fetched.orders
      res.emptyWindows = fetched.stats.emptyWindows
      res.jobs = fetched.stats.jobs
      res.pages = fetched.stats.pages
      res.bytesProcessed = fetched.stats.bytesProcessed
    } catch (err) {
      return failWith(careSyncSourceCode(careN3ErrorCode(err)), cand.snapshotAt)
    }
  }
  res.orders = orders.length

  try {
    const applied = await deps.apply(orders, cand.snapshotAt)
    res.ordersWritten = applied.ordersWritten
    res.attribution = applied.attribution
    res.queueDrained = applied.queueDrained
  } catch {
    return failWith('DB_APPLY_FAILED', cand.snapshotAt)
  }
  res.ok = true
  return finish()
}

// ── Kiểm dạng dữ liệu RPC (server deps dùng; thuần để test) ───────────────────
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** jsonb của care_order_sync_candidates ⇒ CareSyncCandidates; sai dạng ⇒ throw (fail-closed). */
export function parseSyncCandidates(raw: unknown): CareSyncCandidates {
  const r = raw as { snapshot_at?: unknown; windows?: unknown; customers?: unknown; items?: unknown } | null
  if (!r || typeof r !== 'object' || typeof r.snapshot_at !== 'string' || !ISO_UTC.test(r.snapshot_at)
      || !isCount(r.windows) || !isCount(r.customers) || !Array.isArray(r.items)) {
    throw new Error('care_sync_candidates_malformed')
  }
  const items: CareN3Window[] = r.items.map((x) => {
    if (!Array.isArray(x) || x.length !== 3 || typeof x[0] !== 'string' || typeof x[1] !== 'string' || (x[2] !== null && typeof x[2] !== 'string')) {
      throw new Error('care_sync_candidates_malformed')
    }
    return { customerExternalId: x[0], lo: x[1], hi: x[2] }
  })
  return { snapshotAt: r.snapshot_at, windows: r.windows, customers: r.customers, items }
}

/** jsonb của care_order_sync_apply ⇒ CareSyncApplyResult; sai dạng ⇒ throw. */
export function parseSyncApply(raw: unknown): CareSyncApplyResult {
  const r = raw as { orders?: unknown; orders_written?: unknown; attribution?: { scope?: unknown; upserted?: unknown; deleted?: unknown }; queue_drained?: unknown } | null
  if (!r || !isCount(r.orders) || !isCount(r.orders_written) || !isCount(r.queue_drained) || !r.attribution
      || !isCount(r.attribution.scope) || !isCount(r.attribution.upserted) || !isCount(r.attribution.deleted)) {
    throw new Error('care_sync_apply_malformed')
  }
  return {
    orders: r.orders, ordersWritten: r.orders_written, queueDrained: r.queue_drained,
    attribution: { scope: r.attribution.scope, upserted: r.attribution.upserted, deleted: r.attribution.deleted },
  }
}
