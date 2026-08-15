# UI Change Guardrails — LUẬT CỨNG cho toàn chương trình UI

> Chương trình này là VISUAL-ONLY. App production 500+ user, KPI gắn lương thưởng.

## TUYỆT ĐỐI KHÔNG ĐỔI
1. **Query/data flow**: mọi `.select/.eq/.order/.range/RPC call` giữ nguyên từng ký tự trừ khi plan route ghi rõ. Không thêm query, không thêm profile fetch.
2. **URL contract**: param (`q, page, view, status, care, tab, search_by…`), href, redirect target — giữ nguyên (bookmark + QA script phụ thuộc).
3. **Phân quyền**: mọi gate `isSuper/isPolicy/isStaff/canX` + RLS + server action authz — không đụng.
4. **Workflow**: submit/claim/care/approve/resubmit/export — hành vi giữ nguyên 100%.
5. **DB**: KHÔNG migration, KHÔNG ENV mới trong toàn chương trình UI.
6. **Cấu trúc nav**: Sidebar/BottomNav/MobileHeader structure giữ (đổi style token OK, không đổi item/behavior).
7. Root `html font-size: 15px` giữ; mobile input dùng `text-[16px] md:text-sm`.

## ĐƯỢC ĐỔI
- className, cấu trúc JSX presentational, thay markup tự chế bằng component `components/ds/*`.
- Copy hiển thị CHỈ khi plan route ghi rõ (mặc định giữ nguyên wording tiếng Việt).

## SAU KHI ROUTE ĐÃ MIGRATE
- Cấm màu status raw (`bg-green-100 text-green-700`-style) ngoài `components/ds/` — check bằng:
  `grep -rn "bg-\(green\|red\|amber\|sky\|rose\|emerald\)-100 text-" webapp/app webapp/components --include=*.tsx | grep -v components/ds/` → PHẢI rỗng cho route đã migrate (Phase 6: rỗng toàn repo).
- Badge/stat-card mới bắt buộc dùng ds/ (review chặn nếu không).

## WIDTH POLICY (chốt 15/08/2026 — batch fluid)
Page-root (div ngoài cùng của `page.tsx`/`loading.tsx`) chỉ được **FLUID** (không `max-w-*`) hoặc **CENTERED** (`max-w-2xl|3xl|4xl` **BẮT BUỘC kèm `mx-auto`**). **CẤM `max-w-5xl|6xl|7xl|[Npx]` ở page-root**; `max-w-*` thiếu `mx-auto` ở page-root = lỗi (ghim nội dung sang trái → dải trắng khi zoom-out). Cap mức cell/inner/notice không thuộc luật này. `DetailPageShell` không còn cap mặc định — caller tự khai.
- Check:
  `grep -rn "max-w-\(5xl\|6xl\|7xl\|\[1[0-9]\{3\}px\]\)" "webapp/app/(dashboard)" --include=*.tsx`
  → chỉ được ra hit trong **comment** hoặc **`ui-catalog/page.tsx`** (ngoại lệ: đổi = phải regenerate snapshot committed). Bất kỳ hit nào khác = chặn review.
- **Trang MỚI PHẢI khai `data-layout-width="fluid"|"centered"` ngay tại page-root** (`DetailPageShell` nhận qua prop `layoutWidth`) — attribute trơ, không đổi pixel. Gate là `webapp/e2e/ui-width-contract.spec.ts`: nó ĐO hình học ở 1920/2560 (fluid phải phủ kín `<main>`, centered phải cân 2 bên + cap thật sự bind), nên screenshot không còn là gate duy nhất của width policy.

## DỮ LIỆU PRODUCTION TRONG ARTIFACTS (r2A — sự cố đã xảy ra, không lặp lại)
- **CẤM commit** screenshot/video/trace chứa dữ liệu production (PII: tên khách, SĐT, toa thuốc, email NV). `e2e/__screenshots__/`, `test-results/`, `playwright-report/` nằm trong `.gitignore` — không được gỡ.
- Visual artifact ĐƯỢC commit duy nhất = component-catalog snapshots với fixtures mock ("Nguyễn Văn A", `DHC_TEST_001`, `POS_TEST`).
- Credentials chỉ qua env local; đổi password tạm ngay sau khi dùng xong.

## Quy trình
- Branch `feat/ui-foundation` từ `1ad7089`; 1 route = 1 commit; push để audit diff; KHÔNG `git add -A`.
- KHÔNG merge main / deploy / SQL tới khi pilot được stakeholder duyệt. Main luôn deployable — hotfix chen ngang đi branch riêng từ main như thường lệ.
- Mỗi commit: tsc + build + `git diff --check` + checklist UI_VISUAL_QA.
