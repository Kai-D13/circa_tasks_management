// Mig 112 — THƯỞNG THÊM THEO NGƯỠNG SỐ ĐƠN (campaign Doanh số, tuỳ chọn).
//
// NGUỒN DUY NHẤT cho mọi màn (Staff, QLCH, SM, Super) + export. Module thuần.
//
// ⚠ CỐ Ý KHÔNG NHẬN actual_value / kpi_target. Bộ lọc khoảng ngày ghi đè
// actual_value và offline_order_count bằng số của khoảng lọc ở cả 3 nhánh
// trang; nếu helper tự tính "doanh thu >= target" thì trạng thái thưởng sẽ đổi
// theo bộ lọc. Vì vậy mọi thứ ở đây đọc từ 4 field SNAPSHOT TOÀN KỲ mà RPC 112
// tự tính lúc ghi — code lọc khoảng không bao giờ ghi đè chúng:
//   minimum_order_target · order_bonus_per_staff  (cấu hình target)
//   bonus_order_count    · order_bonus_achieved   (RPC tự tính)
//
// Khoản này TÁCH HẲN khỏi Commission Store (store_commission_pool). Không đếm
// dược sĩ, không tính tổng quỹ — chỉ hiển thị mức cho MỖI dược sĩ.

import type { StatusTone } from '@/components/ds/StatusBadge'

export interface OrderBonusInput {
  minimum_order_target?: number | null
  order_bonus_per_staff?: number | null
  bonus_order_count?: number | null
  order_bonus_achieved?: boolean | null
  /** false = store chưa có snapshot (chưa đồng bộ / vừa nạp lại target). */
  synced?: boolean
}

export type OrderBonusStatus = 'achieved' | 'not_achieved' | 'unknown' | 'not_synced'

export interface OrderBonusView {
  threshold: number
  perStaff: number
  /** Tổng số đơn RPC đã dùng để xét (Offline + Affiliate, toàn kỳ). */
  orders: number | null
  /** Số đơn còn thiếu (0 khi đã đủ); null khi chưa biết số đơn. */
  shortfall: number | null
  /** orders / threshold × 100 — KHÔNG cap (vượt ngưỡng hiện > 100%). */
  pct: number | null
  /** Đã đủ số đơn chưa (null khi chưa biết). */
  ordersMet: boolean | null
  status: OrderBonusStatus
  tone: StatusTone
  /** '720 / 710 đơn' · '— / 710 đơn' */
  ordersLine: string
  /** '200.000₫/dược sĩ' */
  perStaffLabel: string
  /** '200.000₫' — riêng số tiền, cho ô đã có tiêu đề "…/dược sĩ". */
  perStaffAmountLabel: string
  /** Nhãn trạng thái ngắn cho badge. */
  statusLabel: string
  /** Gợi ý bước kế tiếp; null khi đã đạt. Suy HOÀN TOÀN từ field snapshot. */
  hint: string | null
}

const nf = new Intl.NumberFormat('vi-VN')

export function orderBonusView(i: OrderBonusInput): OrderBonusView | null {
  const threshold = i.minimum_order_target
  const perStaff = i.order_bonus_per_staff
  // Không áp dụng — campaign không có 2 cột cấu hình (mọi campaign cũ).
  if (threshold === null || threshold === undefined || perStaff === null || perStaff === undefined) return null

  const orders = i.bonus_order_count ?? null
  const ordersMet = orders === null ? null : orders >= threshold
  const shortfall = orders === null ? null : Math.max(threshold - orders, 0)
  const pct = orders === null || threshold <= 0 ? null : (orders / threshold) * 100
  const perStaffAmountLabel = `${nf.format(Math.round(perStaff))}₫`
  const perStaffLabel = `${perStaffAmountLabel}/dược sĩ`
  const ordersLine = `${orders === null ? '—' : nf.format(orders)} / ${nf.format(threshold)} đơn`

  let status: OrderBonusStatus
  if (i.synced === false) status = 'not_synced'
  else if (i.order_bonus_achieved === true) status = 'achieved'
  else if (i.order_bonus_achieved === false) status = 'not_achieved'
  else status = 'unknown'

  const tone: StatusTone = status === 'achieved' ? 'success'
    : status === 'unknown' ? 'warning'
    : 'neutral'
  const statusLabel = status === 'achieved' ? `Đã đạt ${perStaffLabel}`
    : status === 'not_achieved' ? 'Chưa đạt thưởng thêm'
    : status === 'not_synced' ? 'Chưa đồng bộ'
    : 'Chưa đủ dữ liệu số đơn'

  let hint: string | null = null
  if (status === 'not_achieved') {
    // RPC chỉ ra "chưa đạt" khi thiếu ÍT NHẤT MỘT điều kiện. Đủ số đơn mà vẫn
    // chưa đạt ⇒ điều kiện còn lại (doanh thu) là thứ đang thiếu — suy được
    // mà không cần actual_value (vốn bị bộ lọc khoảng ghi đè).
    hint = ordersMet ? 'Đã đủ số đơn — còn cần đạt KPI doanh thu'
      : `Còn thiếu ${nf.format(shortfall ?? 0)} đơn`
  } else if (status === 'unknown') {
    hint = 'Số đơn chưa đầy đủ ở lần đồng bộ này — hệ thống tự cập nhật ở lần kế tiếp'
  } else if (status === 'not_synced') {
    hint = 'Kết quả sẽ có sau lần đồng bộ doanh số kế tiếp'
  }

  return {
    threshold, perStaff, orders, shortfall, pct, ordersMet, status, tone,
    ordersLine, perStaffLabel, perStaffAmountLabel, statusLabel, hint,
  }
}

/** Nhãn cột "Đạt thưởng thêm" của export Excel (Finance đối soát). */
export function orderBonusExportLabel(v: OrderBonusView | null): string {
  if (!v) return ''
  return v.status === 'achieved' ? 'Đạt'
    : v.status === 'not_achieved' ? 'Chưa đạt'
    : v.status === 'not_synced' ? 'Chưa đồng bộ'
    : 'Chưa đủ dữ liệu'
}
