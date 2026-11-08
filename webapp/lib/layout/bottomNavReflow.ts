// UI-NAV-D07 (PM 08/11/2026 — planning/reviews/2026-11-08-ui-nav-r1-pm.md §5, spec ui-nav-spec-implementation-2026-11-08 §9):
// bố cục BottomNav OS ở khung CSS rất hẹp (reflow / zoom trang của trình duyệt). Theo BỀ RỘNG CSS của viewport — media query đã
// phản ánh zoom, KHÔNG suy từ devicePixelRatio. Đây là NGUỒN TS của các mốc: globals.css (khối "UI-NAV-D07") khai đúng các mốc
// này bằng `max-width: <mốc − 0.02>px`; e2e/ui-nav-shell-fixture.spec.ts so bố cục render thật với hàm dưới ở hai phía từng mốc.
// Runtime KHÔNG import file này (bố cục là CSS thuần ⇒ không có state JS dính lại sau resize / đổi route).

/** Vùng chạm tối thiểu theo hợp đồng dự án — CSS px, không nhân DPR. */
export const NAV_MIN_TARGET_PX = 44
/** `px-3` của <nav> (0.75rem × root 15px) mỗi bên. */
export const NAV_SIDE_PADDING_PX = 11.25
/** `border` của pill mỗi bên (box-sizing border-box). */
export const NAV_PILL_BORDER_PX = 1
/** Pill một hàng (`--bottom-nav-h` gốc). */
export const NAV_PILL_H_PX = 60
/** Một hàng của lưới reflow (`--bottom-nav-row-h`). */
export const NAV_ROW_H_PX = 48
/** Thanh OS luôn có 5 ô: staff 5 tab; QLCH / SM / admin 4 tab chính (MAX_PRIMARY) + nút "Thêm". FS: 1 tab, không reflow. */
export const NAV_OS_CONTROLS = 5

export const BOTTOM_NAV_BREAKPOINTS = {
  /** Dưới mốc: ẩn nhãn (icon-only; Link / nút Thêm giữ aria-label ⇒ tên accessible không đổi). Đo thật 08/11 (Be Vietnam Pro 10px,
   *  font-semibold, ô = nhãn + px-1.5): thanh SM (Tổng quan · Doanh số · Users · Cửa hàng · Thêm) cần ≥ 293,2px để MỌI ô có nhãn
   *  còn ≥ 44px; staff 291,2 · QLCH 290,5 · staff CSKH 284,1 · admin 281,9 ⇒ chốt 300 (có dư cho chữ đậm của tab đang chọn). */
  labels: 300,
  /** Dưới mốc: 5 ô một hàng không còn đủ 44px (5 × 44 + 24,5 = 244,5) ⇒ lưới 3 + 2. */
  oneRow: 246,
  /** Dưới mốc: 3 cột không còn đủ 44px (3 × 44 + 24,5 = 156,5) ⇒ lưới 2 cột (2 + 2 + 1). Dưới 112,5px (2 × 44 + 24,5) không còn
   *  đủ 44px — ngoài phạm vi (≈ máy 320px ở zoom > 280 %). */
  threeCols: 158,
} as const

export type BottomNavLayout = { labels: boolean; cols: number; rows: number }

/** Bề rộng trong pill dành cho các ô (trừ padding nav + border pill). */
export const usableWidth = (vw: number) => vw - 2 * (NAV_SIDE_PADDING_PX + NAV_PILL_BORDER_PX)

/** Bố cục mong đợi của thanh `kind` ở viewport `vw` CSS px. */
export function bottomNavLayout(vw: number, kind: 'os' | 'fs'): BottomNavLayout {
  if (kind === 'fs') return { labels: true, cols: 1, rows: 1 }
  const b = BOTTOM_NAV_BREAKPOINTS
  const cols = vw >= b.oneRow ? NAV_OS_CONTROLS : vw >= b.threeCols ? 3 : 2
  return { labels: vw >= b.labels, cols, rows: Math.ceil(NAV_OS_CONTROLS / cols) }
}

/** Chiều cao pill theo số hàng (= `--bottom-nav-h` sau reflow). */
export const pillHeight = (rows: number) => (rows <= 1 ? NAV_PILL_H_PX : rows * NAV_ROW_H_PX + 2 * NAV_PILL_BORDER_PX)
