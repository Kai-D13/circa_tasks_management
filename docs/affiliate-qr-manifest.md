# Affiliate QR Manifest — P3-H (DRAFT chờ stakeholder audit, 24/07/2026)

Nguồn: folder user cung cấp `C:\webapp_management\QR_code_affiliate` (25 file PNG gốc 1536×1536 RGBA — không collage/screenshot). Toàn bộ cột dưới đây là **dữ liệu trích xuất thật**, không suy đoán:
- `partner_code` + `destination_url`: **decode trực tiếp từ ảnh QR** (jsQR, scratchpad script, 25/25 decode OK).
- `store_code`/`store_name`: tra read-only bảng `stores` theo tên (thử cả biến thể có dấu/không dấu — bài học LONG TAM); cả 8 tên mới đều match **duy nhất**, os + active.

## Kết quả audit tự động (theo checklist stakeholder bước 4)

| Tiêu chí | Kết quả |
|---|---|
| QR decode đúng domain Circa Online | ✅ 25/25 đều `https://circa.vn/?ref=<PARTNER_CODE>` — không domain lạ |
| Không trùng partner_code | ✅ 25 code duy nhất |
| Không trùng store | ✅ 25 store_code duy nhất (map 1-1) |
| Đủ store | ✅ 25 QR = **toàn bộ 25 OS store active** trong DB — không OS store nào thiếu QR, không QR nào trỏ store non-OS/inactive |

## Bảng mapping (theo số thứ tự file)

| qr_filename | store_code | store_name (DB) | partner_code (decode) | destination_url (decode) | mapping hiện tại |
|---|---|---|---|---|---|
| `1. Circa Urban.png` | POS0011 | CIRCA URBAN | `CIRCA-URBAN` | https://circa.vn/?ref=CIRCA-URBAN | **MỚI** — chưa có |
| `2. Circa Mizuki.png` | POS0013 | CIRCA MIZUKI | `CIRCA-MIZUKI` | https://circa.vn/?ref=CIRCA-MIZUKI | có (092) |
| `3. Circa Lumina.png` | POS0012 | CIRCA LUMINA | `CIRCA-LUMINA` | https://circa.vn/?ref=CIRCA-LUMINA | có (090) |
| `4. Circa Sunrise.png` | POS0014 | CIRCA SUNRISE | `CIRCA-SUNRISE` | https://circa.vn/?ref=CIRCA-SUNRISE | có (090) |
| `5. Circa Elara.png` | POS0015 | CIRCA ELANA | `CIRCA-ELARA` | https://circa.vn/?ref=CIRCA-ELARA | có (090) |
| `6. Circa Mora.png` | POS0017 | CIRCA MORA | `CIRCA-MORA` | https://circa.vn/?ref=CIRCA-MORA | **MỚI** — chưa có |
| `7. Circa Thống Nhất.png` | POS0016 | CIRCA THỐNG NHẤT | `CIRCA-THONGNHAT` | https://circa.vn/?ref=CIRCA-THONGNHAT | **MỚI** — chưa có |
| `8. Circa Signature.png` | POS0018 | CIRCA SIGNATURE | `CIRCA-SIGNATURE` | https://circa.vn/?ref=CIRCA-SIGNATURE | **MỚI** — chưa có |
| `9. Circa Beverly.png` | POS0058 | CIRCA BEVERLY | `CIRCA-BEVERLY` | https://circa.vn/?ref=CIRCA-BEVERLY | có (090) |
| `10. Circa Astoria.png` | POS0062 | CIRCA ASTORIA | `CIRCA-ASTORIA` | https://circa.vn/?ref=CIRCA-ASTORIA | **MỚI** — chưa có |
| `11. Circa Tâm Việt.png` | POS0059 | CIRCA TAM VIET | `CIRCA-TAMVIET` | https://circa.vn/?ref=CIRCA-TAMVIET | có (090) |
| `12. Circa Cityland.png` | POS0070 | CIRCA CITYLAND | `CIRCA-CITYLAND` | https://circa.vn/?ref=CIRCA-CITYLAND | **MỚI** — chưa có |
| `13. Circa Tâm An.png` | POS0060 | CIRCA TAM AN | `CIRCA-TAMAN` | https://circa.vn/?ref=CIRCA-TAMAN | **MỚI** — chưa có |
| `14. Circa Mira.png` | POS0019 | CIRCA MIRA | `CIRCA-MIRA` | https://circa.vn/?ref=CIRCA-MIRA | có (090) |
| `15. Circa Medly.png` | POS0063 | CIRCA MEDLY | `CIRCA-MEDLY` | https://circa.vn/?ref=CIRCA-MEDLY | có (090) |
| `16. Circa Symphony.png` | POS0065 | CIRCA SYMPHONY | `CIRCA-SYMPHONY` | https://circa.vn/?ref=CIRCA-SYMPHONY | có (090) |
| `17. Circa Florita.png` | POS0068 | CIRCA FLORITA | `CIRCA-FLORITA` | https://circa.vn/?ref=CIRCA-FLORITA | có (090) |
| `18. Circa Pharmaone.png` | POS0066 | CIRCA PHARMA ONE | `CIRCA-PHARMAONE` | https://circa.vn/?ref=CIRCA-PHARMAONE | có (090) |
| `19. Circa Central.png` | POS0009 | CIRCA CENTRAL | `CIRCA-CENTRAL` | https://circa.vn/?ref=CIRCA-CENTRAL | có (090) |
| `20. Circa Ecogreen.png` | POS0073 | CIRCA ECO GREEN | `CIRCA-ECOGREEN` | https://circa.vn/?ref=CIRCA-ECOGREEN | có (090) |
| `21. Circa Rainbow.png` | POS0069 | CIRCA RAINBOW | `CIRCA-RAINBOW` | https://circa.vn/?ref=CIRCA-RAINBOW | **MỚI** — chưa có |
| `22. Circa Celadon.png` | POS0067 | CIRCA CELADON | `CIRCA-CELADON` | https://circa.vn/?ref=CIRCA-CELADON | có (090) |
| `23. Circa EHome.png` | POS0079 | CIRCA EHOME | `CIRCA-EHOME` | https://circa.vn/?ref=CIRCA-EHOME | có (insert 23/07; version hóa 094 DRAFT) |
| `24. Circa Nam Việt.png` | POS0077 | CIRCA NAM VIET | `CIRCA-NAMVIET` | https://circa.vn/?ref=CIRCA-NAMVIET | có (092) |
| `25. Circa Akari.png` | POS0080 | CIRCA AKARI | `CIRCA-AKARI` | https://circa.vn/?ref=CIRCA-AKARI | có (090) |

**8 partner code MỚI** (chưa từng xuất hiện trong luồng đơn, chưa có row `affiliate_partner_mappings`): CIRCA-URBAN, CIRCA-MORA, CIRCA-THONGNHAT, CIRCA-SIGNATURE, CIRCA-ASTORIA, CIRCA-CITYLAND, CIRCA-TAMAN, CIRCA-RAINBOW — tất cả trỏ OS store active duy nhất theo bảng trên.

**Đề xuất dev-team (chờ duyệt):** seed 8 mapping mới (partner_type `os`, preflight code/type/active như pattern 092/094) trong **migration 095** cùng đợt với cột QR — nếu không seed, đơn đầu tiên quét các QR này sẽ rơi `unmatched` (store_id NULL) cho tới khi bổ sung tay.

## Kế hoạch GCS (theo kiến trúc stakeholder đã chốt)

- Key: `affiliate-qr/<store_code>/<partner_code>.png` (vd `affiliate-qr/POS0011/CIRCA-URBAN.png`).
- Migration 095: `affiliate_partner_mappings` + `qr_image_url`, `qr_destination_url`, `qr_updated_at`; RLS SELECT store-scoped riêng cho staff/store_manager/SM (KHÔNG mở toàn bảng — bảng hiện super-only), FS/khác store không đọc được.
- UI: section "Mã QR Circa Online" trên landing `/targets` (không hiện trong `?campaign=`), QR 220–240px mobile, modal 300–320px, nút mở Circa Online (`destination_url`), empty-state "Chưa cấu hình mã QR cho cửa hàng"; `loading="lazy"` + cache dài hạn, không proxy qua Next.js.

## Câu hỏi mở (cần user/stakeholder chốt trước khi build)

1. Duyệt bảng mapping trên (đặc biệt 8 store mới — match tên duy nhất nhưng cần xác nhận nghiệp vụ).
2. Seed 8 mapping mới trong 095? (khuyến nghị: CÓ).
3. Phạm vi role thấy QR: chỉ Staff hay Staff + Store Manager + SM (khuyến nghị: cả ba, scoped theo store).
4. QR hiển thị cả khi store không có campaign active? (khuyến nghị: CÓ).
5. Flag: dùng chung `KPI_AFFILIATE_ENABLED` hay flag riêng? (khuyến nghị: dùng chung nếu rollout cùng đợt).
