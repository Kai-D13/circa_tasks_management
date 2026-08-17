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

export interface RangeStoreActual {
  store_id: string
  offline: number
  affiliate: number
  actual: number                      // offline + affiliate
  // null = nguồn CHƯA có số đơn cho khoảng này (khác hẳn 0 đơn thật).
  orders: number | null
  // AOV weighted = tổng net / tổng đơn. null khi chưa có số đơn hoặc 0 đơn.
  aov: number | null
  dayCount: number                    // số ngày CÓ dòng dữ liệu trong range
}

export interface RangeTotals {
  offline: number
  affiliate: number
  actual: number
  orders: number | null
  aov: number | null
  storeCount: number
}

const num = (v: number | null | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Gộp theo store. KHÔNG lọc ngày ở đây — caller đã query đúng range; lọc lại
// bằng string compare sẽ âm thầm khác đi nếu ai đó đổi định dạng date.
export function buildRangeStoreActuals(rows: CampaignDailyRow[]): RangeStoreActual[] {
  const byStore = new Map<string, { offline: number; affiliate: number; orders: number | null; days: number }>()

  for (const r of rows) {
    const cur = byStore.get(r.store_id) ?? { offline: 0, affiliate: 0, orders: null, days: 0 }
    cur.offline += num(r.gmv)
    cur.affiliate += num(r.gmv_affiliate)
    cur.days += 1
    // Số đơn: chỉ cộng khi nguồn THẬT SỰ có giá trị. Nếu mọi ngày đều null thì
    // giữ null — "chưa có dữ liệu" và "0 đơn" là hai chuyện khác nhau trên màn
    // hoa hồng, gộp lại là bịa ra một sự thật.
    if (r.offline_order_count !== null && r.offline_order_count !== undefined) {
      cur.orders = (cur.orders ?? 0) + num(r.offline_order_count)
    }
    byStore.set(r.store_id, cur)
  }

  return [...byStore.entries()].map(([store_id, v]) => ({
    store_id,
    offline: v.offline,
    affiliate: v.affiliate,
    actual: v.offline + v.affiliate,
    orders: v.orders,
    aov: weightedAov(v.offline, v.orders),
    dayCount: v.days,
  }))
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
  let orders: number | null = null

  for (const s of stores) {
    offline += s.offline
    affiliate += s.affiliate
    if (s.orders !== null) orders = (orders ?? 0) + s.orders
  }

  return {
    offline,
    affiliate,
    actual: offline + affiliate,
    orders,
    aov: weightedAov(offline, orders),
    storeCount: stores.length,
  }
}

// Trung bình/ngày TRONG KHOẢNG — thay cho "Trung bình/ngày cần đạt" của chế độ
// toàn kỳ. Chia cho số ngày CỦA KHOẢNG (range.days), không phải số ngày có dữ
// liệu: ngày không phát sinh doanh thu vẫn là một ngày bán.
export function rangeAveragePerDay(actual: number, rangeDays: number): number | null {
  if (rangeDays <= 0) return null
  return actual / rangeDays
}
