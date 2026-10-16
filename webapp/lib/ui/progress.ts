// Chuẩn hoá số liệu cho thanh tiến độ (components/ds/ProgressBar) — PM audit P1.0 P2:
// giá trị biên phải an toàn cho cả bề rộng lẫn ARIA.
//   - max không hợp lệ (≤0, NaN, Infinity) ⇒ không có thanh (valid=false), trang chỉ hiện nhãn chữ.
//   - value ngoài [0, max] hoặc NaN ⇒ kẹp vào khoảng; ARIA nhận đúng giá trị đã kẹp.
export type ProgressValues = { valid: boolean; value: number; max: number; pct: number }

export function normalizeProgress(value: number, max: number): ProgressValues {
  if (!Number.isFinite(max) || max <= 0) return { valid: false, value: 0, max: 0, pct: 0 }
  const v = Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0
  return { valid: true, value: v, max, pct: Math.round((v / max) * 100) }
}
