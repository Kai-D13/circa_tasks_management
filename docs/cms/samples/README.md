# Mẫu import CMS

| File | Vai trò |
|---|---|
| `Circa_Import_CMS_Phase_2_.xlsx` | File mẫu **r1** của stakeholder (sheet `IMPORT_CMS` + `HUONG_DAN`), dữ liệu ví dụ, không phải chính sách thật. **Lịch sử / fixture lỗi**: chỉ có 7 cột (thiếu `unit_CMS`, `base_quantity_CMS`) nên theo r2 bị báo thiếu cột; nhóm `SKU002` (`GMV_TOAN_DANH_MUC`) để trống target; ProductID dạng `SKU001` không phải ID thật (ID thật là `item.product_id` số nguyên). |

Template r2 (9 cột, ProductID số giả) do batch P1-b sinh tại `webapp/public/templates/Circa_Import_CMS.xlsx`. Đặc tả cột: `docs/cms/SPEC.md` §4.
