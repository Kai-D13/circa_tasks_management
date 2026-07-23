# Affiliate Partner Manifest (snapshot dry-run 22/07/2026 chiều — 157 đơn / 24 code)

Quy tắc audit: **mọi** `affiliate_partner_code` distinct trong nguồn phải có mặt ở đây; tổng `source_order_count` phải khớp snapshot; migration seed theo `target_store_code` (stores.code — KHÔNG seed theo tên) và `RAISE` nếu code không tồn tại hoặc sai `store_type`. Data sống tăng liên tục — số cuối cùng đối soát tại thời điểm backfill.

**Contract attribution (chốt 22/07):** store ghi nhận Affiliate = `affiliate_partner_code` → mapping → store. **`assigned_store_id` là cửa hàng XỬ LÝ đơn, tuyệt đối không dùng để map/fallback.**

| partner_code | source_order_count | mapping_type | target_store_code | display_name |
|---|---|---|---|---|
| `CIRCA-ONG-CHU-5` | 74 | external | — | Đối tác ngoài: CIRCA-ONG-CHU-5 |
| `NT-NGOC-VY` | 18 | external | — | Đối tác ngoài: NT-NGOC-VY |
| `CIRCA-MYHANH` | 10 | external | — | Đối tác ngoài: CIRCA-MYHANH |
| `CIRCA-HOABINH2` | 8 | fs | POS0088 | FS Hòa Bình 2 |
| `CIRCA-CENTRAL` | 8 | os | POS0009 | CIRCA CENTRAL |
| `HOTEL-DN-LDH` | 5 | external | — | Đối tác ngoài: HOTEL-DN-LDH |
| `CIRCA-MEDLY` | 4 | os | POS0063 | CIRCA MEDLY |
| `CIRCA-LUMINA` | 3 | os | POS0012 | CIRCA LUMINA |
| `CIRCA-CELADON` | 3 | os | POS0067 | CIRCA CELADON |
| `CIRCA-ECOGREEN` | 3 | os | POS0073 | CIRCA ECO GREEN |
| `CIRCA-SYMPHONY` | 3 | os | POS0065 | CIRCA SYMPHONY |
| `CIRCA-AKARI` | 2 | os | POS0080 | CIRCA AKARI |
| `CIRCA-FLORITA` | 2 | os | POS0068 | CIRCA FLORITA |
| `CIRCA-SUNRISE` | 2 | os | POS0014 | CIRCA SUNRISE |
| `CIRCA-TAMVIET` | 2 | os | POS0059 | CIRCA TAM VIET |
| `CIRCA-ELARA` | 2 | os | POS0015 | CIRCA ELANA — QA tay đơn DH023275/POS DHC01024385 (21/07, user xác nhận) |
| `CIRCA-YENMAI-TAYNINH` | 1 | external | — | Đối tác ngoài: CIRCA-YENMAI-TAYNINH |
| `NT-BAO-TRAN` | 1 | external | — | Đối tác ngoài: NT-BAO-TRAN |
| `NT THIÊN` | 1 | external | — | Đối tác ngoài: NT THIÊN |
| `CIRCA-PHARMAONE` | 1 | os | POS0066 | CIRCA PHARMA ONE |
| `CIRCA-BEVERLY` | 1 | os | POS0058 | CIRCA BEVERLY |
| `CIRCA-MIRA` | 1 | os | POS0019 | CIRCA MIRA |
| `CIRCA-MIZUKI` | 1 | os | POS0013 | CIRCA MIZUKI — mới 22/07 sáng, **đã duyệt qua audit**, seed trong migration 092 (verify POS0013 os + active) |
| `CIRCA-NAMVIET` | 1 | os | POS0077 | CIRCA NAM VIET — mới 22/07 chiều (dry-run), **ĐÃ DUYỆT 22/07**, seed trong migration 092 (verify POS0077 os + active; 1 đơn DELIVERED) |
| `CIRCA-EHOME` | 1 | os | POS0079 | CIRCA EHOME — mới 23/07, **ĐÃ DUYỆT 23/07** (user), INSERT service role sau preflight os+active (1 đơn DELIVERED 205.000₫); version hóa trong **migration 094** |
| `CIRCA-LONG TAM` | 3 | fs | POS1089 | FS Long Tâm — mới 23/07. Ban đầu duyệt tạm `external` (23/07) vì tra cứu store theo tên KHÔNG DẤU trượt "Long Tâm" (bài học: search store phải thử cả có dấu). **Bằng chứng Mongo 23/07 tối** (đọc tối thiểu theo chỉ định audit, KHÔNG lưu system_note): cả 3 đơn (DH023397/DH023421/DH023422, đều CANCELED) có `system_note` PHARMACY_ROUTING `storeName "FC Circa – NT Long Tâm – Hà Nội"`, partnerID 42/storeID 75 nhất quán → theo rule audit: **fs → POS1089** (như HOABINH2: chỉ super thấy, KHÔNG vào campaign OS). Đối chiếu: các code external đã biết (NT THIÊN sid 74) cũng có assigned_store_id → assigned_store_id/routing KHÔNG dùng để map; quyết định dựa trên routing storeName trỏ đích danh store FS của hệ thống. Sửa mapping qua **migration 094** (DRAFT — chờ stakeholder audit, chưa chạy). 3 đơn CANCELED → 0₫ GMV bị ảnh hưởng |

**Checksum**: **26 code = 17 os + 2 fs + 7 external** (sau khi 094 chạy; trạng thái DB hiện tại vẫn 17 os + 1 fs + 8 external) · snapshot mới nhất 23/07 tối = **167 đơn**, sync `success`, unmatched `[]`, canary completed_time = 0. Số đơn từng code drift liên tục theo data sống (bảng trên giữ count tại thời điểm code xuất hiện) — đối soát cuối cùng thực hiện tại rollout.

**Baseline KPI (chỉ đơn DELIVERED — snapshot sáng 22/07, 153 đơn; đối soát lại chính thức lúc backfill):** tổng 109 đơn / 36.836.230₫ · OS-eligible 31 / 8.522.800₫ · FS 5 / 2.124.100₫ · External 73 / 26.189.330₫. Dry-run chiều: DELIVERED đã lên 111, status distribution CANCELED 43 · FAIL_TO_DELIVER 2 · DELIVERING 1.

Ghi chú: code mới xuất hiện sau này (chưa có trong manifest) sẽ được cron ghi nhận `unmatched` vào `affiliate_sync_runs` (canary) và đơn vẫn được lưu với `store_id NULL` (chỉ super thấy) — bổ sung mapping bằng SQL INSERT/migration SAU khi duyệt, không map theo tên, **không bao giờ map theo `assigned_store_id`**.
