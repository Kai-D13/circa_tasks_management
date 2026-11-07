# Mockup CMS theo sản phẩm (nguồn canvas Claude Design)

File `.dc.html` là mã nguồn artboard của canvas, chỉ để tham chiếu layout, chữ, trạng thái.
Không chạy độc lập (cần runtime của canvas), không import vào app, không copy số mẫu trong `renderVals()`.

| File | Màn | Route |
|---|---|---|
| Main.dc.html | 00 · Mô hình CMS & luật tính | — |
| AdminPrograms.dc.html | A1 · Danh sách chương trình | /targets/campaigns/cms |
| AdminImport.dc.html | A2 · Tạo & Import | /targets/campaigns/cms/new |
| AdminProgramDetail.dc.html | A3 · Hiệu quả chương trình | /targets/campaigns/cms/[id] |
| StaffHome.dc.html | D1 · CMS của tôi | /targets?tab=cms |
| StaffProduct.dc.html | D2 · Chi tiết sản phẩm | /targets/cms/products/[programProductId] |
| StaffHistory.dc.html | D3 · Ghi nhận & hiệu quả tư vấn | /targets/cms/history |

Đặc tả: `docs/ui/UI_V2_CMS.md`. Nghiệp vụ: `docs/plan-cms-product-commission.md`.

## CMS-UI-1 (04/11/2026) — tham chiếu, KHÔNG phải bản chốt

| File | Màn | Ghi chú |
|---|---|---|
| AdminProgramProducts.dc.html | A3 · tab Theo sản phẩm (desktop) | Mockup operator cung cấp 04/11 — **reference**, áp theo redline PM |
| AdminProgramProductsMobile.dc.html | A3 · tab Theo sản phẩm (390px) | Wrapper 390px nhập component desktop qua `dc-import` — không phải app độc lập |

Nhãn "bản chốt" trong mockup **không** có hiệu lực. Quyết định PM (`planning/research/cms-ui-enhancement-plan-2026-11-04.md` §3,
ghi lại ở `docs/ui/UI_V2_CMS.md` §6) thắng mockup: không `max-w-[1320px]` ở page-root (giữ fluid), đổi bảng ⇄ card theo container
chứ không theo viewport 900px, SP bổ sung giữa kỳ vẫn hồi tố (không `effective_from`), không "Chốt sau 2 ngày", không màn "Gán người
bán", tiền chính đọc đủ bằng mắt (không rút gọn chỉ còn ARIA), không link tab dược sĩ "đã lọc SP".
