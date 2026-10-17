# UI v2 — Phase 3 "Bảng tin" (ngoại lệ circa-ui CÓ PHẠM VI)

> PM GO 17/10/2026: spec `planning/research/ui-v2-announcements-phase3-spec-2026-10-17.md`; quyết định Q-136–Q-146 trong
> `planning/reviews/2026-10-17-ui-v2-announcements-dev-review-pm.md`. Nhánh `feat/ui-v2-announcements` từ `main` @ `77bbe45`.
> Nguồn design: canvas Claude Design Phase 3 Bảng tin (B0 component · B1–B3 desktop admin · M1–M3 mobile). **Kế thừa nguyên
> Foundation v2 của Tasks:** `docs/ui/UI_V2_TASKS.md` §1–§3 (cơ chế `data-ui-v2`, variant `v2:`, token nền, bán kính).
> Không thêm token màu mới: chưa đọc dùng `--status-info`, đủ 100% dùng `--status-success` (ds `StatusBadge` / `ProgressBar`).

## 1. Phạm vi
- Route (bật theo lát, `data-ui-v2="page"` ở page-root từng route): `/announcements` (A1), `/announcements/[id]` (A2),
  `/announcements/new` · `/announcements/[id]/edit` (A3). Catalog: **`/ui-catalog/announcements-v2`** (`UI_CATALOG=1` + super).
- **Visual-only:** giữ truy vấn, action, RLS, quyền, URL, giới hạn 100 tin, luồng gửi/sửa/xoá/ghi nhận đọc, upload, schema,
  env, cron. BottomNav giữ nguyên (staff 5 tab + `Newspaper` + badge; QLCH `Megaphone`).
- Bề ngang page-root: list `max-w-3xl mx-auto` (giữ); chi tiết + form nâng lên `max-w-3xl mx-auto` (PM GO).

## 2. Component dùng chung (`components/announcements/`, A0)
| Component | Vai trò | Luật |
|---|---|---|
| `AnnouncementCard` | thẻ một tin (B0/B1/M1) | 3 trục tách rời: **đọc** (`unread`/`read` chỉ khi có kết quả `announcement_reads` hợp lệ; `untracked` = admin hoặc đọc lỗi ⇒ không chấm, không "Mới") · **theo cửa hàng** (`TagBadge` indigo "Theo cửa hàng") · **hết hạn** (chỉ khi vai được thấy theo RLS; badge neutral "Hết hạn"). Chưa đọc = chấm `status-info` + tiêu đề 700 + badge info "Mới" có chữ; nền/viền thẻ trung tính (Q-144). Hết hạn KHÔNG làm mờ chữ — chỉ ảnh bìa `opacity .6` (Q-141, AA). Tiêu đề `line-clamp-2`; thời điểm `formatDateTime` đầy đủ (Q-142). Ảnh bìa 72px (≥ md 88px). |
| `AnnouncementFeed` | nhóm Hôm nay · Tuần này · Trước đó | `lib/announcements/feed.ts`: ngày theo giờ VN (UTC+7), tuần bắt đầu thứ Hai, tin tương lai vào Hôm nay, ngày lỗi vào Trước đó; chỉ nhóm có dữ liệu; giữ thứ tự gốc. Chỉ trên mảng đã tải (≤ 100). |
| `ReadMeter` · `StoreReadBar` | thống kê đã xem (admin) | 4 trạng thái khác nhau: **lỗi** ⇒ "Không tải được thống kê đã xem" (không số/thanh) · **chưa có số** ⇒ "—" · **0 đối tượng** ⇒ "Không có đối tượng nhận." (không chia 0) · **có số** ⇒ `đã xem/tổng` + thanh info, đủ 100% mới success. % làm tròn XUỐNG (`readPercent`): 119/120 = 99%. Biến thể `strip` (B2) có link "N người chưa xem ↓" tới panel thống kê. |
| `AnnouncementImageTile` · `…UploadingTile` · `…AddTile` | ô ảnh form (B0/B3) | Chỉ trình bày; logic upload vẫn ở `AnnouncementImageUpload`. Nút xoá **luôn hiện** (sửa lỗi hover-only), vùng bấm 44×44, aria-label riêng từng ảnh. |
| `AnnouncementsEmpty` · `AnnouncementsError` · `ReadStateErrorNotice` | rỗng / lỗi / đọc lỗi | Chữ hiện hành. Rỗng chỉ khi truy vấn chính thành công và trả 0 dòng. Đọc lỗi ⇒ Notice warning "Không tải được trạng thái đã xem." và ẩn số/badge chưa đọc (Q-146). |
| `AnnouncementFixtureBoundary` | safety gate fixture | Cùng cơ chế `KpiFixtureBoundary` (file riêng): handler ghi/upload hỏi `useAnnouncementFixtureBlocked()` NGAY TRƯỚC lời gọi; trong fixture ⇒ chặn + đếm `[data-ann-fixture-blocked]`; route thật ⇒ không đổi. |

## 3. Chữ (PM §2 + Q-136–Q-146)
- Mới được phép: nhãn nhóm `Hôm nay / Tuần này / Trước đó`, `Mới`, đếm có ghi `trong danh sách`, tóm tắt đọc/chưa xem admin
  (`N người chưa xem`), nhãn khối form + tóm tắt sticky bar theo state, hướng dẫn/bộ đếm B3 khớp validation, `Theo cửa hàng`,
  `Không tải được trạng thái đã xem.`, `Không tải được thống kê đã xem`, `Bảng tin` (link đầu chi tiết).
- KHÔNG thêm: phụ đề B1 (Q-136), vai người nhận (Q-138), "Đã đánh dấu là đã xem" (spec §2), chấm vị trí carousel (Q-145).
- Không đổi chữ lỗi do server action trả về, chữ nút gửi/xoá hiện hành. Không dùng số giả của artboard.
