// Contract active-state của Sidebar — THUẦN (không import React) để e2e gọi
// trực tiếp như một unit test, cùng idiom với các lib contract khác của repo
// (lib/affiliate/normalize, lib/ops/sanitize…). Sidebar chỉ tiêu thụ.
//
// Vì sao tách ra (audit UI-fluid-sidebar-r1, P1#1): rule active nằm inline
// trong component nên không khoá được bằng test, và mục CHA accordion còn tự
// tính tint bằng `startsWith(section)` → tại /inventory/trf hay /fs/products cả
// cha lẫn con cùng sáng NỀN active, trái contract "đúng 1 nền active".

/**
 * Longest-match ĐƠN NHẤT: trong tập href đang HIỂN THỊ trên sidebar, trả về
 * href khớp `pathname` theo RANH GIỚI '/' và DÀI NHẤT — hoặc `null` nếu không
 * href nào khớp.
 *
 * - So khớp theo ranh giới (`=== h` hoặc `startsWith(h + '/')`) nên
 *   `/tasks-abc` KHÔNG khớp `/tasks` (cùng predicate với BottomNav).
 * - Dài nhất thắng nên `/tasks/schedules` thắng `/tasks`, và
 *   `/targets/campaigns/affiliate` thắng `/targets/campaigns` thắng `/targets`.
 * - Kiểu trả về là string đơn ⇒ về mặt kiểu KHÔNG THỂ có 2 mục cùng active;
 *   đây chính là contract mà Sidebar dựa vào để tô đúng 1 nền + đặt đúng 1
 *   `aria-current="page"`.
 */
export function resolveActiveHref(pathname: string, hrefs: string[]): string | null {
  return hrefs
    .filter((h) => pathname === h || pathname.startsWith(h + '/'))
    .sort((a, b) => b.length - a.length)[0] ?? null
}
