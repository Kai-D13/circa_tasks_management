# Affiliate Partner Manifest (chốt 21/07/2026 — nguồn: snapshot Mongo cùng ngày, 148 đơn)

Quy tắc audit: **mọi** `affiliate_partner_code` distinct trong nguồn phải có mặt ở đây; tổng `source_order_count` phải = 148; migration seed theo `target_store_code` (stores.code — KHÔNG seed theo tên) và `RAISE` nếu code không tồn tại hoặc sai `store_type`.

| partner_code | source_order_count | mapping_type | target_store_code | display_name |
|---|---|---|---|---|
| `CIRCA-ONG-CHU-5` | 74 | external | — | Đối tác ngoài: CIRCA-ONG-CHU-5 |
| `NT-NGOC-VY` | 16 | external | — | Đối tác ngoài: NT-NGOC-VY |
| `CIRCA-MYHANH` | 10 | external | — | Đối tác ngoài: CIRCA-MYHANH |
| `CIRCA-HOABINH2` | 8 | fs | POS0088 | FS Hòa Bình 2 |
| `CIRCA-CENTRAL` | 7 | os | POS0009 | CIRCA CENTRAL |
| `HOTEL-DN-LDH` | 5 | external | — | Đối tác ngoài: HOTEL-DN-LDH |
| `CIRCA-LUMINA` | 3 | os | POS0012 | CIRCA LUMINA |
| `CIRCA-MEDLY` | 3 | os | POS0063 | CIRCA MEDLY |
| `CIRCA-CELADON` | 3 | os | POS0067 | CIRCA CELADON |
| `CIRCA-AKARI` | 2 | os | POS0080 | CIRCA AKARI |
| `CIRCA-FLORITA` | 2 | os | POS0068 | CIRCA FLORITA |
| `CIRCA-SUNRISE` | 2 | os | POS0014 | CIRCA SUNRISE |
| `CIRCA-ECOGREEN` | 2 | os | POS0073 | CIRCA ECO GREEN |
| `CIRCA-SYMPHONY` | 2 | os | POS0065 | CIRCA SYMPHONY |
| `CIRCA-TAMVIET` | 2 | os | POS0059 | CIRCA TAM VIET |
| `CIRCA-YENMAI-TAYNINH` | 1 | external | — | Đối tác ngoài: CIRCA-YENMAI-TAYNINH |
| `NT-BAO-TRAN` | 1 | external | — | Đối tác ngoài: NT-BAO-TRAN |
| `NT THIÊN` | 1 | external | — | Đối tác ngoài: NT THIÊN |
| `CIRCA-PHARMAONE` | 1 | os | POS0066 | CIRCA PHARMA ONE |
| `CIRCA-BEVERLY` | 1 | os | POS0058 | CIRCA BEVERLY |
| `CIRCA-ELARA` | 1 | os | POS0015 | CIRCA ELANA — QA tay đơn DH023275/POS DHC01024385 (21/07, user xác nhận) |
| `CIRCA-MIRA` | 1 | os | POS0019 | CIRCA MIRA |

**Checksum**: 22 code = 14 os + 1 fs + 7 external · Σ source_order_count = **148** ✓ (khớp tổng đơn affiliate trong nguồn tại thời điểm snapshot).

Ghi chú: code mới xuất hiện sau này (chưa có trong manifest) sẽ được cron ghi nhận `unmatched` vào `affiliate_sync_runs` (canary) và đơn vẫn được lưu với `store_id NULL` (chỉ super thấy) — bổ sung mapping bằng SQL INSERT, không cần deploy.
