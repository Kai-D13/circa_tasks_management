// NAV-1 (PM 26/10/2026 — planning/reviews/2026-10-26-kpi-nav-pk1-audit-pm.md §1): bảo vệ điều hướng client bị treo.
// Next 16.2.6 / React 19.2: chạm <Link> → RSC đã về đủ nhưng transition có lúc treo vô hạn (URL không đổi, không lỗi) —
// nhất là khi phiên vừa hết hạn. Đây là cách THOÁT TREO (tải cứng trang đích), không phải lời giải nguyên nhân gốc.

/** Link còn pending quá mốc này (trang đang hiển thị) ⇒ tải cứng trang đích một lần. Một nơi duy nhất để chỉnh. */
export const NAV_WATCHDOG_MS = 6000

/**
 * Đích nội bộ cùng origin của một href do app sinh ra (`/duong-dan?...`), hoặc null nếu không phải
 * (link ngoài, `//host`, `tel:` / `mailto:` / `zalo:`…) — watchdog bỏ qua các link đó.
 */
export function internalTarget(href: string, origin: string): URL | null {
  if (!href.startsWith('/') || href.startsWith('//')) return null
  try {
    const url = new URL(href, origin)
    // `/.//evil.com` cùng origin nhưng pathname `//evil.com` — ghép lại thành URL không scheme sẽ trỏ sang host khác ⇒ loại.
    if (url.origin !== origin || url.pathname.startsWith('//')) return null
    return url
  } catch {
    return null
  }
}

/** Trang hiện tại đã ở đúng đích (đường dẫn + query) — điều hướng mềm đã commit, không cần tải cứng. */
export function isAtTarget(target: URL, location: { pathname: string; search: string }): boolean {
  return location.pathname === target.pathname && location.search === target.search
}
