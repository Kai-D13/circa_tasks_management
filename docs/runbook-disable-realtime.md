# Runbook — Tắt/giảm Supabase Realtime (cắt tải DB vô ích)

**Mục tiêu:** App **không dùng Realtime** ở bất kỳ đâu (`NotificationProvider` đã chuyển sang polling; không có `.channel()`/`.subscribe()` nào trong code). Nhưng `realtime.list_changes` vẫn chiếm ~98% thời gian DB (WAL polling của dịch vụ Realtime). Tắt phần này = thắng lớn cho hạ tầng, **gần như 0 rủi ro** vì không gì trong app phụ thuộc nó.

**Nguyên tắc:** làm lúc traffic thấp; mọi bước đều **reversible**; chẩn đoán trước/sau bằng SQL.

---

## Bước 0 — Xác nhận app không dùng realtime (đã xong)
Đã grep toàn repo: chỉ còn comment, không có subscription. ✅ An toàn để tắt.

## Bước 1 — Chẩn đoán hiện trạng (chạy trong Supabase SQL editor)

```sql
-- 1a. Realtime đang theo dõi bảng nào?
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY 1,2;

-- 1b. Replication slot của realtime + lượng WAL đang giữ (quan trọng cho Bước 3):
SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;

-- 1c. Xác nhận list_changes là thủ phạm (nếu có pg_stat_statements):
SELECT calls, round(total_exec_time::numeric,0) AS total_ms, round(mean_exec_time::numeric,2) AS mean_ms, query
FROM pg_stat_statements
WHERE query ILIKE '%list_changes%' OR query ILIKE '%realtime.%'
ORDER BY total_exec_time DESC
LIMIT 10;
```

Ghi lại kết quả 1a (danh sách bảng) để có thể khôi phục, và 1c để so sánh sau.

---

## Bước 2 — Hành động chính (KHUYẾN NGHỊ): gỡ bảng khỏi publication

> **BẮT BUỘC chạy Bước 1 trước và LƯU danh sách bảng (1a)** — đó là cách duy nhất để khôi phục chính xác cấu hình cũ.

Realtime chỉ stream thay đổi cho các bảng nằm trong publication `supabase_realtime`. Bỏ hết bảng → `list_changes` không còn gì để decode → tải gần như về 0. **Không đụng container, không đụng slot → an toàn nhất.**

**Cách ưu tiên (ít rủi ro nhất): gỡ từng bảng theo danh sách 1a** — giữ nguyên publication, dễ khôi phục:
```sql
ALTER PUBLICATION supabase_realtime DROP TABLE public.<ten_bang>;
-- lặp lại cho mọi bảng liệt kê ở 1a
```

> Cách thay thế (chỉ khi 1a rất nhiều bảng và bạn chấp nhận drop/create): bỏ trống bằng cách tạo lại publication rỗng. **Lưu danh sách 1a trước** vì lệnh này xoá toàn bộ cấu hình publication:
> ```sql
> DROP PUBLICATION IF EXISTS supabase_realtime;
> CREATE PUBLICATION supabase_realtime;
> ```

### Verify (sau 2–5 phút)
```sql
-- publication rỗng:
SELECT count(*) FROM pg_publication_tables WHERE pubname='supabase_realtime';  -- kỳ vọng 0

-- reset thống kê rồi quan sát lại vài phút:
SELECT pg_stat_statements_reset();
-- ... đợi 3-5 phút lưu lượng thật ...
SELECT calls, round(total_exec_time::numeric,0) AS total_ms, query
FROM pg_stat_statements
WHERE query ILIKE '%list_changes%'
ORDER BY total_exec_time DESC LIMIT 5;   -- kỳ vọng total_ms giảm mạnh
```
Kiểm tra thêm: CPU/DB time trên dashboard Supabase/Coolify giảm; app vẫn hoạt động bình thường (đăng nhập, /tasks, /users, thông báo vẫn về theo poll 60s).

### Rollback (nếu cần realtime lại sau này)
```sql
-- chỉ thêm lại bảng nào THỰC SỰ cần realtime (hiện tại: không có):
ALTER PUBLICATION supabase_realtime ADD TABLE public.<ten_bang>;
```

---

## Bước 3 — (THỰC TẾ LÀ BƯỚC CHÍNH) dừng hẳn dịch vụ Realtime

> **Bài học 2026-06-27 (đã thực chiến):** Khi chạy thật, publication **đã rỗng sẵn** (`pg_publication_tables` trả 0 dòng, `puballtables=false`) mà `wal->>` (chính là `realtime.list_changes`) **vẫn chiếm ~96% thời gian DB** — tức tải đến từ **bản thân nhịp poll/decode WAL của container realtime**, KHÔNG phải từ bảng trong publication. ⇒ **Bước 2 (bỏ trống publication) là no-op trong trường hợp này; phải làm Bước 3 (dừng container) mới hết tải.** Vẫn chạy Bước 1+2 trước để loại trừ, nhưng đừng kỳ vọng Bước 2 tự đủ.

Dừng container `realtime` trong Coolify (stack Supabase) → loại bỏ hoàn toàn việc poll.

### ⚠ Bài học 1 — Slot của realtime là TEMPORARY → tự dọn, KHÔNG drop tay
Slot `cainophile_*` (tên ngẫu nhiên, đổi mỗi lần container khởi động) là **temporary replication slot**: nó **tự biến mất ngay khi consumer (container realtime) ngắt kết nối**. Hệ quả:
- **KHÔNG** cần `pg_drop_replication_slot(...)`. Nếu thử drop sau khi đã ngắt → lỗi `slot does not exist` (vì nó đã tự xoá). WAL được giải phóng theo.
- Nếu container đã `Exited` nhưng slot vẫn `active=true` + giữ WAL → đó là **walsender treo** (Postgres chưa nhận ra TCP đã ngắt). Kill nó để slot tự dọn ngay:
  ```sql
  SELECT slot_name, active, active_pid FROM pg_replication_slots WHERE slot_name LIKE 'cainophile%';
  SELECT pg_terminate_backend(active_pid)
  FROM pg_replication_slots WHERE slot_name LIKE 'cainophile%' AND active_pid IS NOT NULL;
  -- slot temporary biến mất ngay sau khi terminate; KHÔNG cần pg_drop_replication_slot.
  ```
- (Lưu ý cũ chỉ đúng cho slot *persistent*: slot inactive mới giữ WAL phình đĩa. Slot temporary của realtime không rơi vào trường hợp đó vì tự xoá khi ngắt.)

### ⚠ Bài học 2 — Coolify TỰ DỰNG LẠI container → `docker stop` không đủ
`docker stop realtime-dev-...` (hoặc `docker update --restart=no` rồi stop) **KHÔNG bền**: Coolify reconcile/redeploy sẽ **bật lại** container → nó tạo **slot mới** (`cainophile_<id-khác>`) và poll lại → tải 96% quay về. Phải tắt ở **tầng Coolify**:

1. Coolify → resource **Supabase** → mở phần **Docker Compose / Compose file** (KHÔNG phải tab "General" — đó chỉ là dòng version/trạng thái, không tắt được).
2. **Comment/xoá khối service `realtime:`** (image `supabase/realtime`).
3. **Xoá `realtime` khỏi MỌI `depends_on:`** của service khác (vd `kong`, `analytics`) — không thì deploy fail.
4. Save → **Redeploy** stack Supabase (cả stack restart ~30–60s → **làm lúc khuya**).
5. Verify: `docker ps -a | grep realtime-dev` → không còn; `SELECT slot_name FROM pg_replication_slots;` → hết `cainophile`; `pg_stat_statements WHERE query ILIKE '%wal->>%'` → no rows / không tăng.

> Mức tối thiểu (nếu không muốn sửa compose ngay): để container `Exited`. Nó chỉ bị dựng lại khi **redeploy chính resource Supabase** — **redeploy app Circa KHÔNG đụng** tới stack Supabase (2 resource riêng). Nên thực tế nó nằm im tới lần redeploy Supabase kế; sửa compose khi có maintenance window để chốt vĩnh viễn.

- Rollback: bỏ comment service `realtime` (+ `depends_on`) → redeploy; nó tự tạo slot mới khi chạy.
- Route `/realtime/*` qua Kong trỏ tới container đã tắt → ai gọi sẽ nhận 502; **app không gọi realtime nên vô hại**, không cần sửa Kong.

---

## Tóm tắt khuyến nghị (cập nhật sau thực chiến 2026-06-27)
1. Chạy **Bước 1** (chẩn đoán) → lưu kết quả.
2. **Bước 2** (bỏ trống publication) lúc traffic thấp → **verify**. Nếu publication đã rỗng sẵn mà `wal->>` vẫn đắt → đi thẳng Bước 3.
3. **Bước 3** (thực tế là bước quyết định): **sửa compose Coolify để gỡ service realtime + redeploy khuya**. Slot temporary tự dọn (kill walsender treo nếu cần); KHÔNG drop slot tay.

Không có thay đổi code/deploy app nào ở đây — đây là cấu hình DB/hạ tầng, thực hiện trên Supabase/Coolify; reversible toàn bộ.
