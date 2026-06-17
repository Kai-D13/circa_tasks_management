# PLAN (chiến lược) — Microsoft Teams notifications: mở rộng & tối ưu

> Trạng thái: **planning, chưa implement**. Mục tiêu: chốt phương án tối ưu cho thông báo task qua Teams + lộ trình mở rộng từ MVP (1 cửa hàng) ra toàn hệ thống.

## 1. Hiện trạng (MVP — migration 020)
- Khi tạo task → `notifyTaskCreated()` ([webapp/lib/teams/notifyTaskCreated.ts](../webapp/lib/teams/notifyTaskCreated.ts)) tra `store_teams_chats` (per-store: `chat_id`, `teams_user_id`, `tenant_id`) → **POST tới n8n webhook** (`N8N_TEAMS_TASK_WEBHOOK_URL`) → n8n đăng message Teams vào **chat của cửa hàng** kèm **@mention**.
- Log mọi lần gửi vào `teams_notification_events` (status: `pending`|`sent`|`failed`|`skipped` — *`pending` đã có trong schema nhưng CHƯA dùng*).
- Gọi tại 4 chỗ trong `app/actions/tasks.ts` (tạo task đơn / staff_all / broadcast / import) — **đồng bộ, best-effort, timeout 9s**.
- **Giới hạn hiện tại:** chỉ seed **POS0059**; chỉ event `task_created`; **không có retry**; **không có UI cấu hình** (chỉ seed bằng SQL); broadcast 26 store = 26 lần gọi n8n **trong request tạo task** (chậm + tải).

## 2. Câu hỏi: giữ n8n webhook hay phương án khác?

| Phương án | Mô tả | Ưu | Nhược | Kết luận |
|---|---|---|---|---|
| **n8n relay (hiện tại)** | app → n8n webhook → MS Graph đăng chat + @mention | n8n **giữ toàn bộ auth MS Graph** + định dạng card + xử lý throttle/retry; đổi format/route **không cần deploy app**; đã chạy ổn | thêm 1 hệ phụ thuộc (n8n phải sống) | ✅ **GIỮ** |
| Direct MS Graph từ app | app tự lấy Graph token + POST `chatMessage` | bỏ n8n | app phải quản OAuth + quyền Graph (gửi message vào chat là **protected permission**, thường cần delegated/RSC, không đơn giản với app-only); tự build adaptive card + mention + throttle | ❌ Không nên (gánh nặng auth, ít lợi) |
| Power Automate / Workflows | webhook → flow Microsoft đăng Teams | MS-native, thay được n8n | tương đương n8n, phải dựng lại flow | ⏸ Tùy chọn nếu muốn rời n8n sang MS-native |
| Teams Incoming Webhook | POST card thẳng vào **channel** | đơn giản nhất | chỉ đăng **channel**, không gửi chat 1:1/nhóm + mention như hiện tại; Microsoft đang **khai tử** O365 connector | ❌ Không hợp mô hình chat per-store |

**Kết luận:** **Giữ n8n làm tầng gửi Teams** (đúng chỗ để gói auth Graph + mention + targeting chat). **Điểm cần tối ưu KHÔNG nằm ở chọn n8n hay không — mà ở CÁCH app trigger n8n.**

## 3. Phương án tối ưu: đổi trigger từ "đồng bộ trong request" → **Outbox + cron dispatcher**

**Vấn đề của inline-sync:** gửi Teams nằm trong luồng tạo task → (a) tăng latency/tải request (broadcast 26 store = 26 call n8n nối tiếp), (b) n8n chậm/lỗi ảnh hưởng trải nghiệm tạo task, (c) không retry → mất noti khi n8n tạm lỗi.

**Outbox pattern (tận dụng đúng status `pending` đã có sẵn):**
1. **Enqueue:** khi tạo task, thay vì gọi n8n, **INSERT 1 dòng `pending`** vào `teams_notification_events` (task_id, store_id, event_type) rồi trả về ngay. Broadcast = 1 batch insert N dòng.
2. **Dispatcher cron** `/api/cron/teams-dispatch` (mỗi 1 phút): lấy các dòng `pending` (+ `failed` đủ điều kiện retry) → build payload (tra store + chat) → POST n8n → cập nhật `sent`/`failed` (+`attempts++`, `next_attempt_at` backoff). Tái dùng logic gửi trong `notifyTaskCreated` (refactor để nhận 1 row hàng đợi).

**Lợi:** task creation **nhanh + nhẹ** (rời Teams khỏi request); **retry** tự động khi n8n lỗi; **gom batch** cho broadcast (kiểm soát rate-limit); near-realtime (cron 1 phút). Không phụ thuộc thứ tự/độ trễ n8n.

## 4. Nút thắt thật khi mở rộng ra toàn hệ thống = **dữ liệu cấu hình per-store** (việc vận hành, không phải code)
Mỗi cửa hàng cần `chat_id` + `teams_user_id` (người được @mention) + `tenant_id` của **chat Teams tương ứng**. App **không tự lấy được** nếu không có quyền Graph. ⇒ cần **quy trình thu thập** các định danh này cho ~26 cửa hàng (qua IT/Graph Explorer hoặc tạo chat chuẩn rồi lấy id). Đây là **dependency gating** chính của batch.

→ App cần một **cách nạp cấu hình**: (a) **UI admin** "Cấu hình Teams theo cửa hàng" (CRUD `store_teams_chats`), hoặc (b) **import CSV/seed SQL** để bootstrap nhanh. Khuyến nghị làm UI admin (bền vững, super-admin tự quản).

## 5. Lộ trình đề xuất (phased — deploy theo đợt)
- **P1 — Scale cấu hình:** UI admin CRUD `store_teams_chats` (super-admin) + nút bật/tắt per store. (Song song: ops thu thập chat_id/teams_user_id cho từng cửa hàng.) → bật Teams cho nhiều cửa hàng.
- **P2 — Outbox + dispatcher:** migration thêm `attempts int default 0`, `next_attempt_at timestamptz` vào `teams_notification_events`; đổi 4 call site sang **enqueue**; thêm cron `/api/cron/teams-dispatch` + retry/backoff. (Bỏ gửi inline.)
- **P3 — Quan sát:** trang admin xem `teams_notification_events` (sent/failed/skipped) + nút gửi lại thủ công. (RLS select admin đã có.)
- **P4 (tùy chọn) — Thêm event:** nhắc deadline/quá hạn/đã nộp… (tái dùng cùng outbox + n8n route, thêm `event_type`).

## 6. Yêu cầu phía n8n / DevOps (để đối thoại)
- Webhook n8n **ổn định** (URL = `N8N_TEAMS_TASK_WEBHOOK_URL`), trả `{ ok: true }` khi gửi thành công (app dựa vào cờ này).
- n8n giữ **xác thực MS Graph** (app registration / delegated token) + xử lý đăng chat + @mention.
- Xác nhận n8n chịu được **burst** (broadcast nhiều store) — outbox phía app sẽ rải theo cron, nhưng nên có rate-limit ở n8n.
- (Nếu chọn Power Automate thay n8n: dựng flow tương đương nhận cùng JSON payload.)

## 7. Verify
- Tạo task (đơn/broadcast) → có dòng `pending` → trong ≤1 phút cron gửi → `sent`; Teams nhận message + đúng @mention. n8n tắt → `failed` rồi **retry** khi bật lại. Store chưa cấu hình → `skipped`. Tạo task **không bị chậm** vì Teams. Admin xem được log + gửi lại.

## 8. Khuyến nghị 1 dòng
**Giữ n8n làm tầng gửi; tối ưu bằng outbox + cron dispatcher + UI cấu hình per-store + retry.** Không chuyển sang direct MS Graph (gánh nặng auth, ít lợi). Việc quyết định tiến độ thật sự là **thu thập định danh chat Teams cho từng cửa hàng** (ops).
