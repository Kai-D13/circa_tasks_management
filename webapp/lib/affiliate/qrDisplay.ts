// P3-H r1 — contract hiển thị QR Affiliate (THUẦN, test khóa ở
// e2e/affiliate-qr-display.spec.ts): page /targets + AffiliateQrCard chỉ tiêu
// thụ — mọi quyết định query/render/trạng thái nằm ở đây.

// Filter mapping BẮT BUỘC khi query QR (audit P1 #2: inactive không trả QR;
// chỉ os). Page dùng .match(AFFILIATE_QR_FILTER) — test khóa cả 2 điều kiện.
export const AFFILIATE_QR_FILTER = { partner_type: 'os', is_active: true } as const

// Slice C (audit 24/07): role được thấy QR = CHỈ staff + store_manager (own
// OS store). SM BỊ LOẠI — app không query/render (double-enforce với RLS 097
// bỏ nhánh sm khỏi apm_select_store_qr); SM vẫn giữ Affiliate Overview.
export function qrEligibleRole(role: string | null | undefined): boolean {
  return role === 'staff' || role === 'store_manager'
}

// Có query + render card hay không: flag bật + role hợp lệ (qrEligibleRole)
// + đã resolve store + KHÔNG ở campaign detail (?campaign=).
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

// ── Step 3.1: disclosure compact trên mobile ────────────────────────────────
// Ảnh QR 220–240px chiếm gần trọn first viewport ở 360px, đẩy danh sách chiến
// dịch xuống dưới màn. Dưới `md` chỉ hiện một hàng compact; ảnh CHỈ mount sau
// khi người dùng mở. Từ `md` trở lên giữ nguyên hình thức đã duyệt.
//
// Vì sao là quyết định THẬT chứ không phải `hidden md:block`: ẩn bằng CSS vẫn
// để <img> trong DOM, trình duyệt vẫn có thể tải ảnh và mục tiêu "không chiếm
// first viewport" chỉ đúng một nửa. Hàm này là chỗ duy nhất quyết định.
export function qrImageMounted(p: { isDesktop: boolean; expanded: boolean }): boolean {
  return p.isDesktop || p.expanded
}

// Bấm nút thu gọn/mở: thu gọn PHẢI đóng luôn modal đang mở, nếu không ảnh
// phóng to vẫn đè màn hình trong khi hàng compact đã báo "đã đóng".
//
// Vì sao là hàm thuần chứ không test qua UI: khi modal mở, backdrop (và lớp
// inert) của base-ui nuốt mọi pointer event ở dưới — kể cả force-click của
// Playwright cũng không tới được nút thu gọn. Nhánh này KHÔNG chạm tới được
// bằng chuột thật, nên chỗ duy nhất khoá được nó là ở đây.
export function qrToggleState(p: { expanded: boolean }): { expanded: boolean; closeModal: boolean } {
  const expanded = !p.expanded
  return { expanded, closeModal: !expanded }
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
