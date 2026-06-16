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

## Bước 3 — (TÙY CHỌN, mạnh tay hơn) dừng hẳn dịch vụ Realtime

Chỉ làm nếu sau Bước 2, `list_changes` **vẫn** tốn đáng kể (do bản thân nhịp poll). Dừng container `realtime` trong Coolify (stack Supabase) → loại bỏ hoàn toàn việc poll.

**⚠ Lưu ý WAL slot:** nếu dừng realtime mà **không** xử lý replication slot của nó, slot ở trạng thái `active=false` sẽ **giữ WAL → đĩa phình dần**. Sau khi dừng container, xử lý slot:

```sql
-- Xem lại slot (Bước 1b) rồi drop slot của realtime (chỉ khi đã dừng container):
SELECT pg_drop_replication_slot('<slot_name_tu_buoc_1b>');
```
- Rollback: start lại container `realtime` trong Coolify (nó tự tạo lại slot khi cần).
- Vì Bước 2 đã reversible và đủ an toàn, **ưu tiên Bước 2**; chỉ tới Bước 3 nếu cần.

---

## Tóm tắt khuyến nghị
1. Chạy **Bước 1** (chẩn đoán) → lưu kết quả.
2. Làm **Bước 2** (bỏ trống publication) lúc traffic thấp → **verify** → quan sát 1 ngày.
3. Nếu vẫn còn tải realtime đáng kể → cân nhắc **Bước 3** (dừng container + drop slot, để ý WAL).

Không có thay đổi code/deploy nào ở đây — đây là cấu hình DB/hạ tầng, bạn thực hiện trên Supabase/Coolify; reversible toàn bộ.
