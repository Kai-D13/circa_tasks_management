# Affiliate Partner Manifest (cập nhật 22/07/2026 — nguồn: snapshot Mongo cùng ngày, 153 đơn)

Quy tắc audit: **mọi** `affiliate_partner_code` distinct trong nguồn phải có mặt ở đây; tổng `source_order_count` phải = 153; migration seed theo `target_store_code` (stores.code — KHÔNG seed theo tên) và `RAISE` nếu code không tồn tại hoặc sai `store_type`.

**Contract attribution (chốt 22/07):** store ghi nhận Affiliate = `affiliate_partner_code` → mapping → store. **`assigned_store_id` là cửa hàng XỬ LÝ đơn, tuyệt đối không dùng để map/fallback.**

| partner_code | source_order_count | mapping_type | target_store_code | display_name |
|---|---|---|---|---|
| `CIRCA-ONG-CHU-5` | 74 | external | — | Đối tác ngoài: CIRCA-ONG-CHU-5 |
| `NT-NGOC-VY` | 18 | external | — | Đối tác ngoài: NT-NGOC-VY |
| `CIRCA-MYHANH` | 10 | external | — | Đối tác ngoài: CIRCA-MYHANH |
| `CIRCA-HOABINH2` | 8 | fs | POS0088 | FS Hòa Bình 2 |
| `CIRCA-CENTRAL` | 8 | os | POS0009 | CIRCA CENTRAL |
| `HOTEL-DN-LDH` | 5 | external | — | Đối tác ngoài: HOTEL-DN-LDH |
| `CIRCA-LUMINA` | 3 | os | POS0012 | CIRCA LUMINA |
| `CIRCA-MEDLY` | 3 | os | POS0063 | CIRCA MEDLY |
| `CIRCA-CELADON` | 3 | os | POS0067 | CIRCA CELADON |
| `CIRCA-ECOGREEN` | 3 | os | POS0073 | CIRCA ECO GREEN |
| `CIRCA-AKARI` | 2 | os | POS0080 | CIRCA AKARI |
| `CIRCA-FLORITA` | 2 | os | POS0068 | CIRCA FLORITA |
| `CIRCA-SUNRISE` | 2 | os | POS0014 | CIRCA SUNRISE |
| `CIRCA-SYMPHONY` | 2 | os | POS0065 | CIRCA SYMPHONY |
| `CIRCA-TAMVIET` | 2 | os | POS0059 | CIRCA TAM VIET |
| `CIRCA-YENMAI-TAYNINH` | 1 | external | — | Đối tác ngoài: CIRCA-YENMAI-TAYNINH |
| `NT-BAO-TRAN` | 1 | external | — | Đối tác ngoài: NT-BAO-TRAN |
| `NT THIÊN` | 1 | external | — | Đối tác ngoài: NT THIÊN |
| `CIRCA-PHARMAONE` | 1 | os | POS0066 | CIRCA PHARMA ONE |
| `CIRCA-BEVERLY` | 1 | os | POS0058 | CIRCA BEVERLY |
| `CIRCA-ELARA` | 1 | os | POS0015 | CIRCA ELANA — QA tay đơn DH023275/POS DHC01024385 (21/07, user xác nhận) |
| `CIRCA-MIRA` | 1 | os | POS0019 | CIRCA MIRA |
| `CIRCA-MIZUKI` | 1 | os | POS0013 | CIRCA MIZUKI — **MỚI 22/07, chưa có trong migration 090; seed ở migration kế tiếp** (đã verify POS0013 os + active) |

**Checksum**: 23 code = 15 os + 1 fs + 7 external · Σ source_order_count = **153** ✓ (khớp tổng đơn affiliate trong nguồn tại snapshot 22/07).

**Baseline KPI (chỉ đơn DELIVERED, contract 22/07 — verify độc lập khớp audit):** tổng 109 đơn / 36.836.230₫ · OS-eligible **31 đơn / 8.522.800₫** · FS 5 / 2.124.100₫ · External 73 / 26.189.330₫ (FS + external không vào campaign OS).

Ghi chú: code mới xuất hiện sau này (chưa có trong manifest) sẽ được cron ghi nhận `unmatched` vào `affiliate_sync_runs` (canary) và đơn vẫn được lưu với `store_id NULL` (chỉ super thấy) — bổ sung mapping bằng SQL INSERT/migration, không map theo tên, **không bao giờ map theo `assigned_store_id`**.
