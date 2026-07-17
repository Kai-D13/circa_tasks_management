# UI Component Contracts — Phase 1 (`webapp/components/ds/`) — r1

> 11 component. Mỗi cái BẮT BUỘC: light+dark · đủ state · touch ≥44px mobile (**PIXEL LITERAL `[44px]`** — root font-size 15px nên `h-11`/2.75rem chỉ = 41.25px thật; guardrail test đo computed height) · tái dùng primitives shadcn (`components/ui/*`) · **presentational thuần — KHÔNG fetch data, KHÔNG 'use client' trừ khi ghi rõ**.

## Quy tắc chung (áp cho cả 11)
- **className policy**: mọi component nhận `className?` và merge bằng `cn()` vào phần tử GỐC; KHÔNG cho override phần tử con (giữ visual nhất quán — cần biến thể thì thêm prop `variant`, không style xuyên).
- **State ownership**: trang (server component) quyết định state nào render — component KHÔNG tự suy luận. Trang fetch → nếu `error` → render `ErrorState`; nếu rỗng → `EmptyState`; `loading.tsx` của route → `LoadingState`. Component ds không nhận cờ `isLoading/isError`.
- **Semantics**: 1 `<h1>` duy nhất/trang (do `PageHeader`/`DetailPageShell` render). Bên trong card/section dùng `<h2>`/`<h3>` theo cấp. Vùng lặp dữ liệu = `<ul>/<li>` hoặc `<table>` đúng nghĩa; KHÔNG div-soup cho bảng.
- **Long-text**: mọi text tự do (tên SP/phiên/note/khách) `truncate` hoặc `line-clamp-2` + nơi đọc đầy đủ (pattern FS-UI-3). Mobile: wrap được, không đẩy cột hành động (2-cột: nội dung `flex-1 min-w-0`, hành động `shrink-0`).
- **Action buttons trong PageHeader/DataToolbar**: hit target mobile = `h-[44px] md:h-8` (responsive contract — desktop compact, mobile 44px thật; catalog là mẫu chuẩn để copy).
- **Acceptance mỗi component**: render đúng ở 360px + 1366px × light/dark; text 120 ký tự không vỡ; focus-visible rõ; contrast pass (token đã đo ở FOUNDATION_SPEC §2).

## Contracts

### 1. PageHeader (server)
`{ title: string; subtitle?: string; icon?: LucideIcon; actions?: ReactNode; className? }`
- Render `<h1 className="text-xl font-semibold">` + subtitle `text-sm text-muted-foreground`; `actions` dồn phải, wrap xuống dòng ở mobile. Thay h1 tự chế ở 11 route (map heading hiện có: "Danh sách Tasks", "Toa thuốc", "Danh sách cửa hàng", "Người dùng", "Nhật ký hoạt động", "Tổng quan", "Bảng tin", "Tồn kho", "Quản lý FS · Sản phẩm", "Chiến dịch KPI" — GIỮ NGUYÊN wording khi migrate).

### 2. StatCard (server)
`{ label: string; value: ReactNode; icon?: LucideIcon; tone?: 'default'|'success'|'warning'|'danger'; hint?: string; className? }`
- Card 8px radius, icon tile trái (`h-9 w-9 rounded-lg` tint theo tone), value `text-2xl font-semibold tabular-nums`. Grid do TRANG quyết (`grid-cols-2 sm:grid-cols-4`). Thay 4-card FS/users/dashboard.

### 3. StatusBadge (server)
`{ tone: 'success'|'warning'|'danger'|'neutral'|'info'; children: ReactNode; size?: 'sm'|'md'; className? }`
- `rounded` (4-6px), sm=`text-[10px] px-1.5 py-0.5`, md=`text-[11px] px-2 py-0.5`; màu CHỈ từ `--status-*` token. KHÔNG icon mặc định. Là NGUỒN DUY NHẤT màu status; route map nhãn→tone tại chỗ. `TaskStatusBadge` + `TaskPriorityBadge` GIỮ public API, ruột dùng StatusBadge (Pilot 2): todo=neutral · in_progress=info · done=success · overdue=danger · Hoàn-thành-trễ=warning · urgent=warning · normal=neutral.

### 3b. TagBadge (server — Pilot 2)
`{ hue: 'blue'|'red'|'green'|'amber'|'teal'|'indigo'|'sky'|'slate'|'gray'; children: ReactNode; className? }`
- Chip PHÂN LOẠI (taxonomy: loại task, Định kỳ/Phát sinh, Cửa hàng/Dược sĩ nộp…) — hue thuần phân biệt, KHÔNG mang nghĩa tốt/xấu ("Thu hồi" đỏ ≠ lỗi). Kết quả/tín hiệu (thành công, quá hạn, sắp hết hạn, bạn có thể nộp) BẮT BUỘC dùng StatusBadge. `text-xs px-1.5 py-0.5 rounded`, light+dark pair per hue. Raw pastel chỉ được sống trong file này (ds/) — route map giá trị domain→hue tại chỗ. Badge phòng ban (`deptBadgeClass`, màu user cấu hình) nằm NGOÀI hệ này.

### 4. FilterTabs (server)
`{ tabs: { key: string; label: string; count?: number; href: string }[]; activeKey?: string; className? }`
- Pill outline server `<Link>`; active = coral (bg-primary text-primary-foreground); count in nhãn `Tất cả (123)`; cuộn ngang mobile (`overflow-x-auto no-scrollbar`), touch ≥44px. KHÔNG client JS.

### 5. DataToolbar (server)
`{ search?: ReactNode; filters?: ReactNode; actions?: ReactNode; className? }`
- Layout chuẩn: `flex flex-wrap gap-2 items-end`; search+filters trái, `actions` khối `ml-auto`. KHÔNG own form logic — trang giữ nguyên `<form method="GET">` hiện có, chỉ bọc layout.

### 6. DataTableShell (server)
`{ children: ReactNode; className? }` — children = `<Table>` shadcn nguyên bản.
- **Scroll ownership thuộc `Table`** (r2): `components/ui/table.tsx` ĐÃ có container `data-slot="table-container"` với `overflow-x-auto` — shell **KHÔNG** thêm wrapper cuộn thứ hai (tránh double horizontal scroll).
- Shell chỉ = `Card p-0` (surface) + **CSS descendant styling**: `[&_thead]:bg-muted/50 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:py-3`. Không sửa table.tsx, không data-attribute mới.

### 7. Pagination (nâng cấp `components/common/Pagination.tsx` — GIỮ path)
- **API hiện tại (đã đọc file, r2) GIỮ NGUYÊN 100%**: `{ page: number; totalPages: number; totalRows: number; pageSize: number; hrefForPage: (p: number) => string }` — render range label `X–Y / N` + prev/next + windowed page numbers; `totalPages <= 1` → render null. Caller hiện có KHÔNG đổi render.
- Type = **discriminated union** (r2.1) — `full` giữ nguyên API, `simple` không cần totals:
```ts
type PaginationProps =
  | { mode?: 'full'; page: number; totalPages: number; totalRows: number;
      pageSize: number; hrefForPage: (p: number) => string }
  | { mode: 'simple'; page: number; hasNext: boolean;   // hasNext BẮT BUỘC
      hrefForPage: (p: number) => string }
```
  - `simple` (staff, không exact count): render "Trang N" + Trước/Tiếp; `hasNext` bắt buộc (không optional — thiếu nó component không thể quyết định nút Tiếp).
- Các trang đang tự render pager (prescriptions, fs) chuyển sang component này TRONG wave của route đó, không gộp trước.

### 8. EmptyState (server)
`{ icon?: LucideIcon; title: string; hint?: string; action?: ReactNode; className? }`
- Căn giữa `py-10`, title `text-sm font-medium`, hint `text-xs text-muted-foreground`.

### 9. ErrorState (server)
`{ message: string; hint?: string; className? }` — **KHÔNG `retryAction`** phase này (retry = reload trang server-component; nút retry client sẽ thêm khi có nhu cầu thật, tránh 'use client' lan). Chuẩn hóa banner đỏ AlertTriangle hiện có (fs, prescriptions): `border-destructive/30 bg-destructive/5` + message + hint (giữ các hint nghiệp vụ như "migration 073 chưa chạy?").

### 10. LoadingState (server)
`{ variant: 'list'|'table'|'cards'; rows?: number; className? }` — bọc `Skeleton` theo 3 khuôn; dùng trong `loading.tsx` các route (thay 4 file lặp code).

### 11. DetailPageShell (server)
`{ backHref: string; backLabel: string; title: string; badges?: ReactNode; meta?: ReactNode; children; className? }`
- Back-link (ChevronLeft + label) → `<h1>` + badges hàng ngang wrap → meta (`text-sm text-muted-foreground`) → children. Thay header tự chế ở tasks/[id], fs/[id], prescriptions/[id].

## Catalog dev-only (r1 — implementation thực tế)
`app/(dashboard)/ui-catalog/page.tsx` — route là **`/ui-catalog`** (KHÔNG phải `/__ui`: App Router coi folder bắt đầu `_` là private, loại khỏi routing). Gate = **`UI_CATALOG=1` env** (Coolify không bao giờ set → production 404) + **super admin** (role khác 404). Render 11 component đủ tone/size/state × 2 theme; fixtures giả 100%; snapshot catalog được COMMIT (`e2e/__screenshots__/ui-catalog.spec.ts/`). Storybook = backlog sau khi API ổn.
