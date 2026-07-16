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
9. Component mới thuộc bộ khung (header/stat/badge/tabs/toolbar/table/pagination/empty/error/loading/detail) → dùng/mở rộng `components/ds/`, KHÔNG tự chế tại route.

## Khi migrate 1 route
Chỉ đổi className/JSX → ds/. Sau đó: tsc + build + `git diff --check`; grep guardrail (xem UI_CHANGE_GUARDRAILS §sau-migrate) phải sạch cho route đó; check 8 viewport × light/dark + loading/empty/error/long-text; số query không tăng. 1 route = 1 commit trên branch UI, không merge main tới khi được duyệt.
