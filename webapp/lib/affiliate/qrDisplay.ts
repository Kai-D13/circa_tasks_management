// P3-H r1 — contract hiển thị QR Affiliate (THUẦN, test khóa ở
// e2e/affiliate-qr-display.spec.ts): page /targets + AffiliateQrCard chỉ tiêu
// thụ — mọi quyết định query/render/trạng thái nằm ở đây.

// Filter mapping BẮT BUỘC khi query QR (audit P1 #2: inactive không trả QR;
// chỉ os). Page dùng .match(AFFILIATE_QR_FILTER) — test khóa cả 2 điều kiện.
export const AFFILIATE_QR_FILTER = { partner_type: 'os', is_active: true } as const

// Có query + render card hay không: flag bật + role hợp lệ (staff/
// store_manager/sm) + đã resolve store + KHÔNG ở campaign detail (?campaign=).
export function qrCardVisible(p: {
  flagEnabled: boolean
  eligibleRole: boolean
  storeResolved: boolean
  inCampaignDetail: boolean
}): boolean {
  return p.flagEnabled && p.eligibleRole && p.storeResolved && !p.inCampaignDetail
}

// r1.1 (audit P2): state client gắn THEO URL ảnh — trạng thái ảnh-lỗi/modal
// của store A không được "dính" sang store B khi SM đổi store. Component lưu
// URL đã đánh dấu (failedUrl/openUrl); state chỉ active khi vẫn là ảnh hiện
// tại — đổi imageUrl ⇒ tự reset, không cần effect.
export function urlStateActive(markedUrl: string | null, currentUrl: string | null): boolean {
  return markedUrl !== null && markedUrl === currentUrl
}

// r1.2 (audit P2 — vòng A→B→A): page gắn key này cho AffiliateQrCard. Key đổi
// ⇒ React DISCARD instance cũ + mount instance MỚI (state failedUrl/openUrl
// sạch, browser retry tải ảnh). Quan trọng: React không "cache" state theo
// key qua các lần unmount — quay lại A sau khi qua B vẫn là instance mới,
// lỗi/modal cũ của A không sống lại. urlStateActive giữ làm phòng thủ trong
// đời một instance (nếu parent nào quên gắn key).
export function qrCardKey(storeId: string | null, imageUrl: string | null): string {
  return `${storeId ?? 'none'}|${imageUrl ?? 'none'}`
}

// Trạng thái card (audit P2 #3): lỗi query ≠ chưa cấu hình — lỗi DB/RLS/
// migration phải hiện "Không tải được", không được giả dạng "chưa cấu hình".
export type QrCardState = 'qr' | 'missing' | 'error'
export function qrCardState(
  queryError: boolean,
  row: { qr_image_url: string | null } | null,
): QrCardState {
  if (queryError) return 'error'
  if (!row || !row.qr_image_url) return 'missing'
  return 'qr'
}
