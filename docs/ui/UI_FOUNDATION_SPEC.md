# UI Foundation Spec — Circa Tasks (đồng bộ visual language admin.v2)

> Phase 0 deliverable. Nguồn tham chiếu: 3 screenshot admin.v2 (docs/UI_app/UI_circa_admin*.jpg).
> Nguyên tắc: đồng bộ NGÔN NGỮ thị giác, không pixel-match. Không đổi business logic. Không migration.

## 1. Token hiện có (GIỮ NGUYÊN — đã đúng hướng, globals.css)
| Token | Light | Dark | Ghi chú |
|---|---|---|---|
| `--primary` | `oklch(0.70 0.17 42)` coral | `oklch(0.73 0.16 42)` | Primary action + active nav (khớp admin.v2) |
| `--secondary` | tint cam rất nhạt | `oklch(0.20 0.015 44)` | Nền nhấn nhẹ |
| `--muted` / `--muted-foreground` | `0.96` / `0.52` | `0.21` / `0.64` | Canvas phụ, text phụ |
| `--border` / `--input` | `0.87` / `0.80` | `0.28` / `0.33` | Input đậm hơn border (form rõ trên nền trắng) |
| `--radius` | `0.5rem` (8px) | — | Card TỐI ĐA lg (8px); chip/badge dùng `rounded` (4-6px) |
| `--sidebar-accent` | `#FEF8ED` cream | dark riêng | Active nav item |
| Font | Be Vietnam Pro (body) · Quicksand (heading) | | GIỮ |
| Root font-size | **15px** | | GIỮ — mobile input bắt buộc `text-[16px] md:text-sm` (chống iOS zoom) |

## 2. Token MỚI cần thêm (Phase 1, globals.css @theme + :root/.dark)
Nhóm STATUS — thay 24 file hand-roll. **ĐÃ ĐO WCAG bằng script OKLCH→sRGB (r1): cả 10 cặp ≥4.5:1** — giá trị dưới là FINAL, không tự chỉnh khi implement:

| Tone | Light fg / bg | Ratio | Dark fg / bg | Ratio |
|---|---|---|---|---|
| success | `oklch(0.44 0.11 150)` / `oklch(0.96 0.04 150)` | **6.66** | `oklch(0.80 0.11 150)` / `oklch(0.25 0.04 150)` | **8.82** |
| warning | `oklch(0.42 0.10 70)` / `oklch(0.97 0.05 85)` | **7.82** | `oklch(0.82 0.11 80)` / `oklch(0.25 0.04 80)` | **9.11** |
| danger | `oklch(0.47 0.17 25)` / `oklch(0.96 0.03 20)` | **6.48** | `oklch(0.78 0.13 25)` / `oklch(0.25 0.05 25)` | **7.69** |
| neutral | `oklch(0.45 0 0)` / `oklch(0.96 0 0)` | **6.62** | `oklch(0.78 0 0)` / `oklch(0.25 0 0)` | **7.99** |
| info | `oklch(0.44 0.10 240)` / `oklch(0.95 0.03 235)` | **6.66** | `oklch(0.80 0.09 240)` / `oklch(0.25 0.04 240)` | **8.64** |

CSS var: `--status-<tone>` (fg) + `--status-<tone>-bg`; `.dark` override đủ 10 var — KHÔNG đảo máy móc.
Mapping ngữ nghĩa (chốt Decision Record):
- **success** (xanh): hoàn thành · đã duyệt · đã đồng bộ · active-tốt
- **warning** (cam): đang xử lý · cần chú ý · chờ duyệt · redo
- **danger** (đỏ): lỗi · quá hạn · đã hủy · nguy hiểm
- **neutral** (xám): nháp · chưa xử lý · ngừng hoạt động
- **info** (xanh dương): trạng thái thông tin (đang được xử lý bởi X, sắp đến kỳ)

## 3. Visual language rút từ admin.v2 (áp dụng)
1. **Surface**: canvas `bg-muted/30`, nội dung trên card trắng/tối phẳng — shadow rất nhẹ (`shadow-sm` tối đa), giảm border cứng, ưu tiên divider (`divide-y`).
2. **Bảng**: header band `bg-muted/50` chữ `text-xs font-medium text-muted-foreground`, hàng cao thoáng (`py-3`), divider mảnh, KHÔNG viền dọc body, khối bảng cuộn ngang riêng (`overflow-x-auto`).
3. **Toolbar filter**: 1 hàng — search input icon-prefix + selects; nút hành động DỒN PHẢI (primary coral filled; phụ = outline/ghost).
4. **Tab đếm số** (FilterTabs): pill outline `Tất cả (123)`, active = coral (border+text hoặc filled) — server `<Link>` giữ URL param.
5. **Chip status** (StatusBadge): pastel bg + text đậm cùng hue, `rounded` nhỏ, `text-[11px] px-2 py-0.5`, không icon mặc định.
6. **Heading**: PageHeader nhỏ gọn — title `text-xl font-semibold` + subtitle `text-sm text-muted-foreground`; không hero to.
7. **Pagination**: phải-dưới `1–10 / 3189 ‹ ›` (+ page-size chỉ khi có nhu cầu thật); staff mobile giữ Prev/Next không exact-count (perf).
8. **KHÔNG**: floating nav mới, animation trang trí, sidebar collapse/desktop header mới (batch sau), đổi bottom-nav structure.

## 4. Accessibility & mobile bắt buộc
Touch target ≥44px THẬT = **pixel literal `min-h-[44px]`/`h-[44px]`** (root font-size 15px nên `h-11` = 2.75rem chỉ ra 41.25px — guardrail test đo computed height sẽ fail); focus ring `--ring` rõ; contrast text-trên-pastel ≥4.5:1 (dark dùng token riêng mục 2); mobile input 16px thật (`text-[16px] md:text-sm`); bảng rộng cuộn trong container, body không cuộn ngang.
