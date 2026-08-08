// R1.3.1 (audit 07/08) — LÕI THUẦN của proof script, tách ra module để
// Playwright test SYNTHETIC được (không chỉ source-text marker). File .mjs
// thuần ESM vì proof script chạy node trực tiếp, không import TS được;
// Playwright/esbuild import ngược lại file này bình thường.
//
// Contract eligibility (r1.3.1 P1#1/#2): điểm ĐỦ ĐIỀU KIỆN campaign khách =
//   mapping ACTIVE + store_id non-null + store_type='os' + store ACTIVE
// — đúng tập targets mà activation/runtime cho phép (FS-store, OS inactive,
// mapping inactive đều bị LOẠI khỏi baseline/cross-store/quyết định remediation,
// nhưng được ĐẾM riêng để không mất dấu).
// Identity cross-store = pointKey 'store:<uuid>' (P2#3) — label/POS chỉ để
// hiển thị báo cáo; hai store trùng tên POS vẫn là hai điểm khác nhau.

export function pointFromMapping(m) {
  const storeId = m.store_id ?? null
  const stores = m.stores ?? null
  return {
    key: storeId ? `store:${storeId}` : `partner:${m.partner_code}`,
    storeId,
    posCode: storeId ? (stores?.code ?? storeId) : null,
    label: storeId ? (stores?.code ?? storeId) : `partner:${m.partner_code}`,
    isStore: !!storeId,
    isOs: !!storeId && stores?.store_type === 'os',
    isOsActive: m.is_active === true && !!storeId
      && stores?.store_type === 'os' && stores?.is_active === true,
  }
}

export function buildPointByCode(mapRows) {
  return new Map(mapRows.map((m) => [m.partner_code, pointFromMapping(m)]))
}

// rows đã normalize BSON: { acc, orderId, price, completedTimeMs|null, partnerCode }.
// posFilter: Set<posCode>|null — đối soát campaign SUBSET (QA_CUSTOMER_POS_CODES).
// Trả 2 tập tách bạch (r1.3.1 #3):
//   osActive       → exact baseline + cross-store in-range + quyết định remediation
//   allStorePoints → diagnostic toàn lịch sử (mọi điểm có store, kể cả FS/inactive)
/**
 * @param {Array<{acc: number, orderId: number, price: number | null, completedTimeMs: number | null, partnerCode: string}>} rows
 * @param {Map<string, ReturnType<typeof pointFromMapping>>} pointByCode
 * @param {Set<string> | null} [posFilter]
 */
export function qualifyOrders(rows, pointByCode, posFilter = null) {
  const osActive = []
  const allStorePoints = []
  const excluded = {
    non_positive: 0, no_completed_time: 0, non_store_point: 0,
    fs_or_non_os: 0, os_inactive: 0, pos_filtered: 0,
  }
  for (const r of rows) {
    if (r.price === null || r.price <= 0) { excluded.non_positive++; continue }
    if (r.completedTimeMs === null) { excluded.no_completed_time++; continue }
    const point = pointByCode.get(r.partnerCode)
    if (!point || !point.isStore) { excluded.non_store_point++; continue }
    const q = {
      acc: r.acc, orderId: r.orderId, t: r.completedTimeMs,
      pointKey: point.key, storeId: point.storeId, posCode: point.posCode,
      partnerCode: r.partnerCode,
    }
    allStorePoints.push(q)
    if (!point.isOs) { excluded.fs_or_non_os++; continue }
    if (!point.isOsActive) { excluded.os_inactive++; continue }
    if (posFilter && !posFilter.has(point.posCode)) { excluded.pos_filtered++; continue }
    osActive.push(q)
  }
  return { osActive, allStorePoints, excluded }
}

// 1 account = 1 khách tại điểm của đơn SỚM NHẤT; tie-break cùng thời điểm →
// order_id NHỎ HƠN thắng (mirror ORDER BY completed_time, order_id của RPC).
export function dedupWinners(orders) {
  const best = new Map()
  for (const o of orders) {
    const cur = best.get(o.acc)
    if (!cur || o.t < cur.t || (o.t === cur.t && o.orderId < cur.orderId)) best.set(o.acc, o)
  }
  return best
}

// Cross-store theo pointKey (identity thật) — account có đơn tại ≥2 điểm.
export function crossStoreCases(orders) {
  const byAcc = new Map()
  for (const q of orders) {
    if (!byAcc.has(q.acc)) byAcc.set(q.acc, [])
    byAcc.get(q.acc).push(q)
  }
  const cases = []
  for (const [acc, os] of byAcc) {
    const keys = new Set(os.map((x) => x.pointKey))
    if (keys.size > 1) {
      const winner = [...dedupWinners(os).values()][0]
      cases.push({
        account: acc,
        orders: [...os].sort((a, b) => a.t - b.t || a.orderId - b.orderId),
        winner,
      })
    }
  }
  return cases
}

// ── r1.3.2 (audit 07/08 tối) ────────────────────────────────────────────────

// Tập điểm TRONG SCOPE quyết định: OS active → áp posFilter → UNIQUE theo
// store_id (2 partner code cùng store = 1 điểm — P2#3 metadata).
/** @param {Map<string, ReturnType<typeof pointFromMapping>>} pointByCode
 *  @param {Set<string> | null} [posFilter] */
export function scopePoints(pointByCode, posFilter = null) {
  const seen = new Map()
  for (const pt of pointByCode.values()) {
    if (!pt.isOsActive) continue
    if (posFilter && !posFilter.has(pt.posCode)) continue
    if (!seen.has(pt.storeId)) seen.set(pt.storeId, pt)
  }
  return [...seen.values()]
}

// PHÂN LOẠI đơn DELIVERED thiếu account_id — bucket RỜI NHAU, precedence:
//   non_os_point → os_inactive_point → os_outside_pos_filter (r1.3.2 P1#1 —
//   OS active nhưng NGOÀI subset: KHÔNG được block release scoped)
//   → disqualified_price_or_time → os_range_unknown/os_in_range/os_out_of_range.
// Bucket quyết định bước kế (source remediation/backfill nguồn) = os_in_range_qualifying —
// CHỈ điểm OS active TRONG posFilter, trong exact range, giá dương, có
// completed_time.
/** @typedef {{order_id: number | string, partner_code: string, point: string, completed_time: string | null, total_price: number | null}} MissEntry */
/** @param {Array<{orderId: number | string, price: number | null, completedTimeMs: number | null, partnerCode: string}>} rows
 *  @param {Map<string, ReturnType<typeof pointFromMapping>>} pointByCode
 *  @param {{from: number, to: number} | null} [rangeMs]
 *  @param {Set<string> | null} [posFilter]
 *  @returns {Record<'os_in_range_qualifying' | 'os_out_of_range' | 'os_range_unknown' | 'os_outside_pos_filter' | 'os_inactive_point' | 'non_os_point' | 'disqualified_price_or_time', MissEntry[]>} */
export function classifyMissingAccount(rows, pointByCode, rangeMs = null, posFilter = null) {
  const buckets = {
    os_in_range_qualifying: [], os_out_of_range: [], os_range_unknown: [],
    os_outside_pos_filter: [], os_inactive_point: [], non_os_point: [],
    disqualified_price_or_time: [],
  }
  for (const r of rows) {
    const point = pointByCode.get(r.partnerCode)
    const entry = {
      order_id: r.orderId,
      partner_code: r.partnerCode,
      point: point ? point.label : `unmapped:${r.partnerCode}`,
      completed_time: r.completedTimeMs !== null ? new Date(r.completedTimeMs).toISOString() : null,
      total_price: r.price,
    }
    if (!point || !point.isOs) buckets.non_os_point.push(entry)
    else if (!point.isOsActive) buckets.os_inactive_point.push(entry)
    else if (posFilter && !posFilter.has(point.posCode)) buckets.os_outside_pos_filter.push(entry)
    else if (r.price === null || r.price <= 0 || r.completedTimeMs === null) buckets.disqualified_price_or_time.push(entry)
    else if (!rangeMs) buckets.os_range_unknown.push(entry)
    else if (r.completedTimeMs >= rangeMs.from && r.completedTimeMs < rangeMs.to) buckets.os_in_range_qualifying.push(entry)
    else buckets.os_out_of_range.push(entry)
  }
  return buckets
}

// GATE REPORT tách 3 tầng (r1.3.2 P1#2 + r1.3.3 P1#1/#2):
//   runtime_readiness — mirror canary RPC 103 (TOÀN LỊCH SỬ DELIVERED trên
//     scoped OS stores, KHÔNG lọc range/giá): metric scoped có sạch mấy mà
//     tầng này fail thì activation/sync production vẫn fail-closed.
//   release_decision — SCOPED (exact range + OS active + posFilter): metric
//     đúng campaign range.
//   diagnostic — TOÀN HỆ THỐNG: chỉ CẢNH BÁO, không đổi exit code.
// Exit code = 0 CHỈ khi runtime_readiness PASS **VÀ** release_decision PASS.
/** @param {{rangeProvided: boolean, eligibleMissingAccount: number,
 *   eligibleMissingCustomer: number, eligibleCrossStore: number,
 *   runtimeMissingAccount: number, runtimeMissingCompleted: number,
 *   globalMissingAccount: number, globalMissingCustomer: number,
 *   globalCrossStore: number}} p */
export function buildGateReport(p) {
  const runtime = [
    ['runtime_missing_account_id (toàn lịch sử, scoped OS stores) = 0', p.runtimeMissingAccount === 0],
    ['runtime_missing_completed_time (toàn lịch sử, scoped OS stores) = 0', p.runtimeMissingCompleted === 0],
  ]
  const release = [
    ['exact_range_provided (QA_CUSTOMER_FROM/TO)', p.rangeProvided],
    ['eligible_missing_account_id = 0', p.eligibleMissingAccount === 0],
    ['eligible_missing_customer = 0', p.eligibleMissingCustomer === 0],
    ['eligible_cross_store_accounts = 0', p.eligibleCrossStore === 0],
  ]
  const diagnostic = [
    ['missing_account_id (toàn lịch sử) = 0', p.globalMissingAccount === 0],
    ['missing_customer (toàn lịch sử) = 0', p.globalMissingCustomer === 0],
    ['cross_store_accounts (toàn lịch sử) = 0', p.globalCrossStore === 0],
  ]
  const pass = runtime.every(([, ok]) => ok) && release.every(([, ok]) => ok)
  return { runtime, release, diagnostic, exitCode: pass ? 0 : 1 }
}

// ── r1.3.3 (audit 07/08 khuya) ──────────────────────────────────────────────

// RUNTIME READINESS — mirror ĐÚNG canary của RPC 103 (rpc_aggregate_affiliate_
// customers + activation identity-gate): quét TOÀN LỊCH SỬ đơn DELIVERED
// (source hiện hành) trên các store TRONG SCOPE (OS active + posFilter),
// KHÔNG lọc date range, KHÔNG lọc total_price — RPC fail-closed khi bất kỳ
// đơn nào thiếu account_id hoặc completed_time, nên proof PASS metric scoped
// mà bỏ 2 canary này vẫn có thể activation/sync fail (r1.3.3 P1#1/#2).
// rows: TOÀN BỘ đơn DELIVERED đã normalize {orderId, partnerCode, hasAccount,
// hasCompleted} (không cần price/acc).
/** @param {Array<{orderId: number | string, partnerCode: string, hasAccount: boolean, hasCompleted: boolean}>} rows
 *  @param {Map<string, ReturnType<typeof pointFromMapping>>} pointByCode
 *  @param {Set<string> | null} [posFilter] */
export function runtimeReadiness(rows, pointByCode, posFilter = null) {
  const missingAccount = []
  const missingCompleted = []
  for (const r of rows) {
    const point = pointByCode.get(r.partnerCode)
    if (!point || !point.isOsActive) continue
    if (posFilter && !posFilter.has(point.posCode)) continue
    const entry = { order_id: r.orderId, partner_code: r.partnerCode, point: point.label }
    if (!r.hasAccount) missingAccount.push(entry)
    if (!r.hasCompleted) missingCompleted.push(entry)
  }
  return { missingAccount, missingCompleted }
}
