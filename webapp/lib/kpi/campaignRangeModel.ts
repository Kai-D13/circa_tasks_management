// Cộng dồn số liệu campaign theo KHOẢNG NGÀY (17/08) — THUẦN, test khoá.
//
// Nguồn: kpi_campaign_store_daily_actuals. Lưu ý tên cột: `gmv` ở bảng daily
// mang nghĩa OFFLINE (mig 092 giữ nguyên tên cũ khi tách affiliate) — không
// phải tổng. Tổng = gmv + gmv_affiliate.
//
// Đây CHỈ là số liệu để XEM. Target, tier, commission và trạng thái thưởng
// chính thức luôn lấy từ snapshot toàn kỳ, KHÔNG bao giờ prorate theo range.

export interface CampaignDailyRow {
  store_id: string
  date: string
  gmv: number | null                  // doanh thu thuần tại cửa hàng (offline)
  gmv_affiliate: number | null
  offline_order_count: number | null
}

// Mức phủ của SỐ ĐƠN trong khoảng — quyết định có được tính AOV hay không.
//   full    — mọi dòng daily của store đều có count ⇒ mẫu số đáng tin
//   none    — không dòng nào có count (kể cả store không có dòng nào)
//   partial — có dòng có, có dòng không ⇒ mẫu số KHÔNG phủ hết tử số
export type OrderCoverage = 'full' | 'none' | 'partial'

export interface RangeStoreActual {
  store_id: string
  offline: number
  affiliate: number
  actual: number                      // offline + affiliate
  orders: number | null               // null khi coverage ≠ 'full'
  aov: number | null
  ordersCoverage: OrderCoverage
  dayCount: number                    // số ngày CÓ dòng dữ liệu trong range
}

export interface RangeTotals {
  offline: number
  affiliate: number
  actual: number
  orders: number | null
  aov: number | null
  ordersCoverage: OrderCoverage
  storeCount: number                  // = số store ĐƯỢC TARGET, không phải số store có dữ liệu
}

const num = (v: number | null | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Gộp theo store.
 *
 * `targetStoreIds` là danh sách store CỦA CAMPAIGN đã được RLS scope — BẮT
 * BUỘC truyền. Nếu chỉ dựng store từ rows nguồn thì store không phát sinh giao
 * dịch sẽ BIẾN MẤT khỏi bảng kết quả, và `storeCount` biến thành "số store có
 * dữ liệu" thay vì "số store được giao chỉ tiêu" — sai cả bảng lẫn mẫu số
 * "X/Y cửa hàng đạt". Nhánh customer-rpc càng dễ dính vì RPC chỉ trả store/ngày
 * CÓ khách.
 */
export function buildRangeStoreActuals(
  rows: CampaignDailyRow[],
  targetStoreIds: string[],
): RangeStoreActual[] {
  type Acc = { offline: number; affiliate: number; orders: number; withCount: number; days: number }
  const seed = (): Acc => ({ offline: 0, affiliate: 0, orders: 0, withCount: 0, days: 0 })

  const byStore = new Map<string, Acc>()
  for (const id of targetStoreIds) byStore.set(id, seed())

  for (const r of rows) {
    // Rows ngoài tập target bị bỏ qua: scope là việc của tầng query, model
    // không được âm thầm mở rộng phạm vi dữ liệu người dùng đang xem.
    const cur = byStore.get(r.store_id)
    if (!cur) continue
    cur.offline += num(r.gmv)
    cur.affiliate += num(r.gmv_affiliate)
    cur.days += 1
    if (r.offline_order_count !== null && r.offline_order_count !== undefined) {
      cur.orders += num(r.offline_order_count)
      cur.withCount += 1
    }
  }

  return [...byStore.entries()].map(([store_id, v]) => {
    const coverage: OrderCoverage =
      v.days > 0 && v.withCount === v.days ? 'full'
      : v.withCount === 0 ? 'none'
      : 'partial'
    // CHỈ 'full' mới được ra số. 'partial' là ca nguy hiểm nhất: tử số (net) lấy
    // TRỌN khoảng còn mẫu số (đơn) chỉ phủ một phần ⇒ AOV trông hợp lệ mà sai.
    // Mig 105 đã cấm payload nửa vời ở tầng ghi; tầng đọc phải giữ cùng kỷ luật.
    const orders = coverage === 'full' ? v.orders : null
    return {
      store_id,
      offline: v.offline,
      affiliate: v.affiliate,
      actual: v.offline + v.affiliate,
      orders,
      aov: weightedAov(v.offline, orders),
      ordersCoverage: coverage,
      dayCount: v.days,
    }
  })
}

// AOV luôn WEIGHTED: tổng net chia tổng đơn.
// ⚠ TUYỆT ĐỐI không lấy trung bình của AOV từng ngày/từng store — ngày ít đơn
// sẽ có trọng số ngang ngày nhiều đơn và ra một con số không tồn tại trong thực
// tế. Đây là màn xét thưởng, sai kiểu này rất khó phát hiện bằng mắt.
export function weightedAov(net: number, orders: number | null): number | null {
  if (orders === null || orders <= 0) return null
  return net / orders
}

export function buildRangeTotals(stores: RangeStoreActual[]): RangeTotals {
  let offline = 0
  let affiliate = 0
  let orders = 0
  let fullCount = 0

  for (const s of stores) {
    offline += s.offline
    affiliate += s.affiliate
    if (s.ordersCoverage === 'full') {
      orders += s.orders ?? 0
      fullCount += 1
    }
  }

  // Tổng vùng chỉ có nghĩa khi MỌI store đều đủ số đơn. Thiếu một store là
  // thiếu một phần mẫu số, trong khi tử số vẫn cộng đủ ⇒ AOV toàn vùng sẽ cao
  // giả. Thà hiện '—' kèm lý do còn hơn một con số sai trên màn hoa hồng.
  const coverage: OrderCoverage =
    stores.length > 0 && fullCount === stores.length ? 'full'
    : fullCount === 0 ? 'none'
    : 'partial'
  const totalOrders = coverage === 'full' ? orders : null

  return {
    offline,
    affiliate,
    actual: offline + affiliate,
    orders: totalOrders,
    aov: weightedAov(offline, totalOrders),
    ordersCoverage: coverage,
    storeCount: stores.length,
  }
}

// Trung bình THỰC TẾ mỗi ngày trong khoảng đang xem.
// ⚠ KHÁC HẲN "Trung bình/ngày cần đạt" của chế độ toàn kỳ (phần CÒN THIẾU chia
// số ngày CÒN LẠI). Đây là số đã đạt chia số ngày đã chọn — nối giá trị này vào
// nhãn cũ là đổi nghĩa mà không đổi chữ. Chốt stakeholder 17/08: khi filter
// active, nhãn là "Trung bình thực tế/ngày".
export const RANGE_AVERAGE_LABEL = 'Trung bình thực tế/ngày'

export function rangeActualAveragePerDay(actual: number, rangeDays: number): number | null {
  // Chia theo số ngày CỦA KHOẢNG, không phải số ngày có dữ liệu: ngày không
  // phát sinh doanh thu vẫn là một ngày bán trong kỳ.
  if (rangeDays <= 0) return null
  return actual / rangeDays
}
