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
