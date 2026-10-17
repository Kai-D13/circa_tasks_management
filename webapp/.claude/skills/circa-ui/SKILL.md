---
name: circa-ui
description: Circa Tasks design system — load BEFORE writing/altering any UI (className, JSX layout, badge/status colors, tables, filters, mobile screens) in webapp/. Ensures visual language matches admin.v2 and the ds/ component contracts.
---

# Circa UI Design System (visual language: admin.v2)

Đọc đủ 3 nguồn khi làm UI: docs/ui/UI_FOUNDATION_SPEC.md (token) · UI_COMPONENT_CONTRACTS.md (ds/ components) · UI_CHANGE_GUARDRAILS.md (luật cứng). Bản này là bản chưng cất thao tác nhanh.

## Luật cứng (không ngoại lệ)
1. **Visual-only**: không đổi query/URL param/authz/workflow/DB. Không migration, không ENV.
2. **Status màu = StatusBadge** (`components/ds/StatusBadge`): tone `success|warning|danger|neutral|info`. CẤM viết `bg-green-100 text-green-700`-style mới ngoài `components/ds/`.
   - success=hoàn thành/đã duyệt/đồng bộ · warning=đang xử lý/chờ duyệt/redo · danger=lỗi/quá hạn/hủy · neutral=nháp/chưa xử lý/ngừng · info=thông tin (đang xử lý bởi X, sắp đến kỳ)
3. **Root font-size = 15px → rem lừa**: mobile input `text-[16px] md:text-sm` (text-base = 15px → iOS zoom); touch target `min-h-[44px]`/`h-[44px]` PIXEL LITERAL (`h-11` = 41.25px thật, guardrail test sẽ fail). Input `h-10` ok cho khung, nhưng hit target nút/link phải [44px].
4. **Card radius tối đa 8px** (`rounded-lg`); chip `rounded`; không bo tròn to (`rounded-2xl+` chỉ nơi đã có, không thêm mới).
5. **Bảng**: bọc `DataTableShell` (header band `bg-muted/50 text-xs`, hàng `py-3`, divider mảnh, `overflow-x-auto` riêng — body không bao giờ cuộn ngang).
6. **Toolbar**: search icon-prefix + filters trái, actions DỒN PHẢI (primary coral filled, phụ outline/ghost). Tab đếm số dùng `FilterTabs` (server Link).
7. **Dark mode**: dùng semantic token (`--status-*`, `bg-card`, `text-muted-foreground`…); cấm hardcode màu chỉ-light.
8. **Long text**: `truncate`/`line-clamp-2` + nơi xem đầy đủ (pattern FS-UI-3). Không tooltip trên mobile.
9. **Width page-root**: FLUID (không `max-w-*`) là mặc định; muốn hẹp thì CHỈ `max-w-2xl|3xl|4xl` và BẮT BUỘC kèm `mx-auto`. Cấm `max-w-5xl|6xl|7xl|[Npx]` ở page-root (grep gate trong UI_CHANGE_GUARDRAILS § Width policy); `DetailPageShell` không có cap mặc định — caller tự khai.
10. Component mới thuộc bộ khung (header/stat/badge/tabs/toolbar/table/pagination/empty/error/loading/detail) → dùng/mở rộng `components/ds/`, KHÔNG tự chế tại route.

## Ngoại lệ có phạm vi: UI v2 Tasks (PM duyệt 16/10/2026)
Chỉ trong trang có gốc `data-ui-v2="page"` (module Tasks — danh sách + chi tiết luật ở docs/ui/UI_V2_TASKS.md, ĐỌC trước khi làm):
- Token v2 (canvas đá ấm, action `#C94A16`/`#F3743F`) trỏ thay token ngữ nghĩa; panel 12px / control 10px / chip 6px (thay luật 4 TRONG v2); tab đang chọn trung tính (thay "primary coral" của luật 6 TRONG v2).
- Class `v2:` chỉ dùng trong `components/ds`, `components/ui`, `components/kpi` (Phase 2) và code route Tasks/KPI v2. KHÔNG dùng/alias `--care-*`, không sửa `components/care`.
- Ngoài phạm vi mọi luật trên giữ nguyên; snapshot `/ui-catalog` phải không đổi.
- **Phase 2 "Chiến dịch KPI"** (PM GO 16/10/2026, docs/ui/UI_V2_KPI.md — ĐỌC trước khi làm): cùng cơ chế v2, áp dụng cho `/targets/campaigns/*` và `/targets` khi route đã gắn `data-ui-v2="page"`. Token thêm `--v2-series`/`--v2-series-soft`/`--v2-ok` (chỉ trong v2, luôn kèm màu mặc định ngoài v2); component KPI dùng chung ở `components/kpi/` (KpiProgressMeter, TierTrack, PaceBadge, CampaignDailyChart), khung ở `components/ds/`. Visual-only: không đổi công thức KPI/tiền thưởng, null ≠ 0, Số đơn + AOV không gộp, commission store không gọi là thưởng cá nhân.
- **Phase 3 "Bảng tin"** (PM GO 17/10/2026, docs/ui/UI_V2_ANNOUNCEMENTS.md — ĐỌC trước khi làm): cùng cơ chế v2 cho `/announcements` (list · `[id]` · new/edit) khi route đã gắn `data-ui-v2="page"`; class `v2:` thêm phạm vi `components/announcements`. Không token màu mới (chưa đọc = `status-info`, đủ = `status-success`). Visual-only: giữ query/action/RLS/URL/cap 100 tin/upload/BottomNav; không suy ra "chưa đọc" khi không có kết quả `announcement_reads` hợp lệ; thống kê đọc lỗi ≠ 0/0; fixture `/ui-catalog/announcements-v2` bọc `AnnouncementFixtureBoundary` (0 ghi/upload).

## Khi migrate 1 route
Chỉ đổi className/JSX → ds/. Sau đó: tsc + build + `git diff --check`; grep guardrail (xem UI_CHANGE_GUARDRAILS §sau-migrate) phải sạch cho route đó; check 8 viewport × light/dark + loading/empty/error/long-text; số query không tăng. 1 route = 1 commit trên branch UI, không merge main tới khi được duyệt.

## Ngoại lệ có phạm vi: UI v2 Login (PM duyệt 16/10/2026)
Chỉ màn `/login` (gốc `data-ui-v2="page" data-login`; luật ở docs/ui/UI_V2_LOGIN.md): token v2 như Tasks + màu panel cam `--login-*` CHỈ trong `[data-login]` (cuối globals.css). Không sửa `app/actions/auth.ts`, `proxy.ts`, cookie hay hard navigation; chữ lỗi credential khoá qua `lib/auth/loginCopy.ts`. Số đo px literal (root 15px). Fixture `/login/ui-catalog` chỉ khi `UI_CATALOG=1`.
