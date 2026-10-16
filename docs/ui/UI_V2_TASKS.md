# UI v2 — module Tasks (ngoại lệ circa-ui CÓ PHẠM VI)

> PM GO có điều kiện 16/10/2026 · nhánh `feat/ui-v2-tasks` (worktree riêng từ `main`) · PM audit từng bước, operator quyết commit.
> Nguồn design: canvas Claude Design "Circa Tasks — Redesign v2 · Phase 1 Tasks" (artboard 00–10). Giá trị dưới đây COPY từ canvas, không tự chỉnh.
> Artboard light 07/08 export đang render thành dark ⇒ **chưa dùng làm chuẩn nghiệm thu light** cho tới khi design xuất lại; giá trị light lấy từ palette trong mã artboard.

## 1. Phạm vi và cơ chế
- **Bật**: `data-ui-v2="page"` trên div gốc `page.tsx`/`loading.tsx` của route Tasks đã chuyển (danh sách §6). Không đặt ở layout/shell. Catalog demo: `/ui-catalog/tasks-v2`.
- **Token chỉ tồn tại trong phạm vi**: `globals.css` khai báo dưới `[data-ui-v2]` và `main:has([data-ui-v2="page"])`. Ngoài phạm vi biến rỗng ⇒ class `v2:*` vô hiệu, giao diện toàn app giữ nguyên.
- **Variant `v2:`** = `&:where([data-ui-v2], [data-ui-v2] *)` (specificity như class thường; utility có variant sinh sau nên thắng utility mặc định cùng thuộc tính). Component `ds/` và `ui/` mang sẵn class `v2:` ⇒ trang KHÔNG truyền prop, wrapper dùng chung (TaskStatusBadge…) tự đổi khi nằm trong trang v2 và giữ nguyên ở trang khác (vd `/inventory/trf`).
- **Không alias, không dùng `--care-*`**, không sửa `components/care` (dark khác giá trị đang chạy ⇒ alias sẽ đổi pixel CSKH).
- **Portal** (Dialog, popup Select, Popover, Tooltip, Toast) render ngoài `<main>` ⇒ giữ giao diện mặc định trong Phase 1.
- **Shell** (Sidebar, MobileHeader, BottomNav) ngoài phạm vi — giữ nguyên cấu trúc lẫn style.

## 2. Token
| Token | Light | Dark | Trỏ token ngữ nghĩa trong phạm vi |
|---|---|---|---|
| `--v2-canvas` | `#F7F6F4` | `#121110` | `--background` (+ nền `<main>`) |
| `--v2-panel` | `#FFFFFF` | `#1A1817` | `--card` |
| `--v2-muted` | `#F1F0EE` | `#24211F` | `--muted` |
| `--v2-line` | `#E7E5E4` | `#2E2A27` | `--border` |
| `--v2-line-strong` | `#D6D3D1` | `#3D3833` | `--input` |
| `--v2-text` | `#1C1917` | `#F5F5F4` | `--foreground`, `--card-foreground` |
| `--v2-text-2` | `#57534E` | `#A8A29E` | `--muted-foreground` |
| `--v2-text-3` | `#6F6964` | `#8A8480` | class `text-v2-text-3` / `bg-v2-text-3` (meta, hint) |
| `--v2-action` / `-fg` | `#C94A16` / `#FFFFFF` (≈5,5:1) | `#F3743F` / `#141210` | `--primary` / `--primary-foreground`, `--ring` |
| `--v2-selected` | `#FFF1EA` | `#2A1E17` | `--accent` |
| `--v2-selected-line` | `#F3C2A8` | `#7A3E20` | class `border-v2-selected-line` |
| `--v2-accent-text` | `#B8440F` | `#F7A57E` | `--accent-foreground` |

- `--status-*` **giữ nguyên** (cặp đã đo ≥6,48:1). Badge v2 = chấm + chữ.
- Bán kính: panel **12px** (`rounded-v2-panel`) · control **10px** (`rounded-v2-control`) · chip **6px** (`rounded-v2-chip`). PM duyệt card 12px **chỉ trong v2**; luật ≤8px vẫn áp ngoài v2.
- Chữ (px literal, root 15px giữ): h1 trang 22/700, h1 chi tiết 24/700, tiêu đề khối 15/600, nhãn eyebrow 12/600 in hoa, nội dung 14, meta 12–13, số KPI 30/700.
- Nhịp: padding trang `p-4 md:p-6`; khối cách 16–24. Touch mobile `h-[44px]`/`min-h-[44px]`; control desktop `md:h-[36px]`. Input mobile `text-[16px]`.

## 3. Component trong v2
| Component | Trong `[data-ui-v2]` | Ngoài phạm vi |
|---|---|---|
| `StatusBadge` | chip 6px, chấm `bg-current` + chữ 12px (sm 11px) | y hệt cũ (chấm `hidden`) |
| `TagBadge` | chip 6px; hue giữ nguyên | y hệt cũ |
| `PageHeader` | ô icon 40px nền selected trái khối tiêu đề + phụ đề; h1 22/700 | y hệt cũ (wrapper `contents`) |
| `StatCard` | panel 12px, chấm tone + nhãn 13px, số 30/700, hint 12px; ẩn ô icon; tone `danger` tô màu số. Tone mới `info` (cộng thêm) | y hệt cũ |
| `FilterTabs` (pill) | segmented: rãnh muted, tab đang chọn **trung tính** (PM duyệt trong v2) | pill cam như cũ |
| `DataTableShell` | panel 12px sát bảng, band header đặc, th 12px | y hệt cũ |
| `EmptyState` / `ErrorState` / `LoadingState` / `DetailPageShell` | ô icon muted / panel danger 12px / skeleton 12px / h1 24px + vạch dưới header | y hệt cũ |
| `ui/button`, `ui/input`, `ui/textarea`, `ui/select` (trigger) | bo 10px; màu theo token ngữ nghĩa đã trỏ | y hệt cũ |

Mới (dùng được cả ngoài v2 với bo 8px):
- `Panel` — bề mặt khối (`title`, `titleStyle="eyebrow"`, `actions`, `flush`).
- `Notice` — banner trong trang theo tone status (thay banner amber tự chế). Không tự gắn `role`.
- `ProgressBar` — chỉ vẽ lại x/y trang đã có; `role="progressbar"`.
- `BulkActionBar` + `BULK_ACTION_BUTTON` — khung nổi đảo màu cho nút hàng loạt có sẵn; không giữ state. `shadow-lg` chỉ trong v2 (phần tử nổi).
- `FILTER_ACTIVE` (`ds/DataToolbar`) — class cho control lọc đang có giá trị.

## 4. Luật nội dung (PM 16/10)
- Giữ query, URL, quyền, hành vi nộp/xuất và **chữ hiện tại**. Chữ mới chỉ dùng khi đã có dữ liệu chính xác **và** stakeholder duyệt (đang chờ: phụ đề trang, chú thích KPI, "còn N giờ", "Sẽ tạo N task…", "Chia sẻ task", "Tải về", "Đã lưu nháp HH:MM", "+N cửa hàng").
- Không thêm: badge kết quả ở danh sách lịch (cần query mới), chuông cho dược sĩ, nút editor mới, "Chọn tất cả" cửa hàng, ô tìm kiếm, số đếm trên tab.
- Không dựng nút minh họa bấm không có tác dụng trên route thật.
- Mobile dược sĩ: không đổi BottomNav (tab cuối = **CSKH** khi CRM bật, như prod).

## 5. Gate mỗi bước
1. `npx tsc --noEmit` → spec liên quan → full Playwright → `npm run build` → `git diff --check`.
2. `e2e/ui-catalog.spec.ts` **không cập nhật snapshot** (chứng minh mặc định toàn app không đổi); `e2e/ui-catalog-v2.spec.ts` cập nhật có chủ đích.
3. Grep: `data-ui-v2` chỉ ở route §6 + `/ui-catalog/tasks-v2`; class `v2:` chỉ trong `components/ds`, `components/ui` và file thuộc route Tasks v2; không token/class `care-` mới ngoài `components/care`.
4. Số lời gọi `.from(`/`.rpc(` trong file route không tăng.
5. Kiểm 1366 + 360/390 × light/dark × loading/empty/error/long-text; so ảnh với artboard (light 07–08 chờ export sửa).
6. Trước khi xét merge: hồi quy CSKH (`/ui-catalog/care-*`, `care-*-ui`) và các trang đang dùng `ds/`.

## 6. Thứ tự (1 route = 1 commit)
P1.0 nền tảng (token, variant, ds, catalog, tài liệu) → P1.1 `/dashboard` → P1.2 `/tasks` (+ mobile dược sĩ) → P1.3 `/tasks/[id]` → P1.4 `/tasks/new` + `/tasks/[id]/edit` → P1.5 `/tasks/schedules` (+`[id]`).
