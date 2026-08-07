// R1.3.1 (audit 07/08) — LÕI THUẦN của proof script, tách ra module để
// Playwright test SYNTHETIC được (không chỉ source-text marker). File .mjs
// thuần ESM vì proof script chạy node trực tiếp, không import TS được;
// Playwright/esbuild import ngược lại file này bình thường.
//
// Contract eligibility (r1.3.1 P1#1/#2): điểm ĐỦ ĐIỀU KIỆN campaign khách =
//   mapping ACTIVE + store_id non-null + store_type='os' + store ACTIVE
// — đúng tập targets mà activation/runtime cho phép (FS-store, OS inactive,
// mapping inactive đều bị LOẠI khỏi baseline/cross-store/quyết định 104,
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
//   osActive       → exact baseline + cross-store in-range + quyết định 104
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
