# CMS theo sản phẩm — hợp đồng dữ liệu và đặc tả kỹ thuật (r2)

> Nghiệp vụ: `docs/plan-cms-product-commission.md`. Quyết định: `docs/cms/DECISIONS.md`. Kế hoạch: `docs/cms/IMPLEMENTATION_PLAN.md`. UI: `docs/ui/UI_V2_CMS.md`.
> Nguồn: spec r2 §3–§4 (chat PM, `docs/PLAN.md` ngoài Git) + review PM intake 01/11 (`planning/reviews/2026-11-01-cms-r2-dev-intake-pm.md` §2, §3, §5).
> Phần đánh dấu **[Dev đề xuất]** là thiết kế chi tiết Dev đưa ra để thực hiện r2; PM audit ở batch tương ứng, chưa phải quyết định nghiệp vụ. **[PM]** = quyết định PM ở review intake (tại các điểm review sửa r2 thì review thắng). **[r1]** = giữ từ spec r1, r2 không thay.
> Quy ước đường dẫn: `lib/…`, `app/…`, `components/…`, `e2e/…`, `scripts/…`, `public/…`, `next.config.ts`, `.env.example` nằm trong `webapp/`; `supabase/…` và `docs/…` ở gốc repo.

## 1. Hợp đồng nguồn

Hai nguồn logic:

1. Product Master.
2. Dòng đơn hàng.

JSON mẫu hiện có dùng cho phát triển và kiểm thử (chỉ để hiểu shape; fixture trong Git là dữ liệu giả). Production đọc nguồn BigQuery đã được xác nhận; **không tự chuyển sang JSON/Google Sheet khi BigQuery lỗi**.

### 1.1. Product Master

| Trường chuẩn | Yêu cầu |
|---|---|
| `product_id` | Text, duy nhất; text số nguyên (H4) |
| `product_name` | Bắt buộc |
| `image_url` | Tùy chọn |
| `is_active` | Cột chuẩn nội bộ (7 cột output / normalizer / RPC / DB không đổi). **Không còn là cột nguồn** (S-BI-3, operator 04/11): adapter tạo hằng `CAST(TRUE AS STRING) AS is_active` = "CMS không áp dụng kiểm tra trạng thái kinh doanh", **không** phải bằng chứng SP đang bán |
| `source_updated_at` | Bắt buộc |
| `reference_price`, `price_unit` | Tùy chọn, chỉ phục vụ hiển thị/ước tính; thiếu không chặn P1 |

Product Master không quyết định đơn vị hưởng CMS.

Giá từ dòng bán là giá giao dịch. Không tự lấy nó làm giá bán tham khảo hiện hành của Product Master.

**[r2.1 — S-BI-3, PM `planning/reviews/2026-11-04-cms-bi-product-master-pm.md` §2]** Operator bỏ trạng thái SP: view BI Product Master chỉ cần **6 cột vật lý** (`product_id`, `product_name`, `image_url`, `source_updated_at`, `reference_price`, `price_unit`); adapter không đọc cột `is_active` trên view (không dò / fallback hai schema) mà tạo hằng `true` (`CMS_PRODUCT_DERIVED_COLUMN`). Import **không** cảnh báo trạng thái SP (kể cả cache cũ còn `false`); ProductID phải có trong cache Master hợp lệ như cũ. UI không trình bày "đang kinh doanh" dựa vào hằng này. Normalizer / file chuẩn 7 cột vẫn chỉ nhận `true` / `false` (contract nội bộ). Không migration, không đổi 120. *(Trước r2.1: `is_active` map từ cột trạng thái nguồn, `false` ⇒ cảnh báo khi import.)*

**Mỗi `product_id` đúng một dòng** trên view: trùng ⇒ lượt đồng bộ held `DUPLICATE_PRODUCT`, 0 ghi, cache giữ nguyên — app **không** chọn MAX / MIN / dòng đầu. `reference_price` phải đi cùng đúng `price_unit`; chưa xác định được giá đúng đơn vị thì BI để cả hai NULL (không dùng tính CMS).

Bản đầu pull **đầy đủ** Product Master; P0 đo quy mô/budget để chứng minh đọc đủ, không tự đổi sang incremental.

### 1.2. Dòng đơn

FQN nguồn (operator 04/11, cấu hình qua env — Dev không sửa env prod): dòng đơn `CMS_BQ_SALES_TABLE=lakehouse-prod-394907.buymed_tech.tech__dim_circa_growth_cms_order`; Product Master `CMS_BQ_PRODUCTS_TABLE=lakehouse-prod-394907.buymed_tech.tech__dim_circa_growth_cms_product_master` (đều là VIEW). Đổi tên chỉ ở biên nguồn (`lib/cms/source/bigquery.ts` → `CMS_SALES_SOURCE_COLUMN`); view thiếu cột vật lý ⇒ lỗi nguồn, giữ snapshot cũ, không tự thử cột khác. `order_line_id` (= `item.id`) đã có trên view (probe 04/11 khuya: duy nhất, không NULL) — app không điền mặc định thay. Product Master không cần `is_active` (§1.1, S-BI-3).

| Trường chuẩn | Nguồn đã xác định |
|---|---|
| `order_line_id` | `item.id` |
| `order_id` | `o.id` |
| `order_code` | `o.code` |
| `product_id` | `item.product_id`, chuẩn hóa text số nguyên |
| `seller_email` | Email của entity ứng với `o.updated_by`. **Cột vật lý trên view BI: `employee_email`** (operator 04/11 — BI giữ tên); adapter đọc `CAST(employee_email AS STRING) AS seller_email`, mọi lớp sau dùng tên chuẩn |
| `pos_code` | `pos.code` |
| `order_type` | `o.type` |
| `order_status` | `o.status` |
| `completed_at` | `o.completed_at` |
| `quantity_raw` | `item.quantity` |
| `uom_raw` | `item.unit` |
| `base_quantity` | `item.base_quantity` |
| `gmv_amount` | `item.amount`, nguyên giá trị |
| `source_updated_at` | Phải phản ánh cả thay đổi order và item |

Không đưa thông tin khách hàng vào feed CMS.

Yêu cầu nguồn:

- Một dòng duy nhất cho mỗi `order_line_id` trong snapshot.
- JOIN Product Master không làm nhân bản dòng bán.
- Timestamp UTC thật, giữ độ chính xác microsecond.
- Không dùng lại phép sửa lệch múi giờ riêng của CRM (`CARE_N3_VIEW_LAG_HOURS`).
- Nguồn có thể đọc lại toàn kỳ.
- SA hiện hành đọc được nguồn được BI công bố trong dataset được phép.
- Nguồn thiếu trường bắt buộc ⇒ adapter production **từ chối**, không tự điền mặc định (ví dụ không gán `OFFLINE` theo tiền tố order code).

Điều kiện `item.created_date = o.created_date` trong query mẫu phải được kiểm chứng trước khi dùng cho feed thật. Không mặc nhiên giữ điều kiện này nếu nó làm mất dòng thêm muộn hoặc đơn giao ngày khác.

### 1.3. Chuẩn hóa tại biên adapter

| Dữ liệu | Quy tắc |
|---|---|
| ProductID | Canonical = text số nguyên dương chuẩn hóa (chữ số sau trim, bỏ số 0 đầu bằng phép chuẩn hóa số nguyên chính xác — BigInt, không qua float); so sánh chính xác chuỗi canonical. Nguồn trả số ⇒ chuyển sang text số nguyên an toàn. |
| Số (`base_quantity`, `gmv_amount`, giá) | Chuỗi thập phân (BigQuery NUMERIC trả chuỗi), tối đa 9 chữ số sau dấu chấm; vượt ⇒ lỗi dữ liệu, không cắt / làm tròn / clamp / thay bằng 0. |
| Timestamp | SQL adapter trả `FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', ts, 'UTC')` (mẫu CRM) ⇒ chuỗi ISO UTC 6 chữ số micro giây; app so sánh bằng chuỗi/BigInt micro giây, không qua `Date` (mất micro giây). |
| Email | trim + lowercase trước khi map; log chỉ ghi dạng che. |
| Ngày VN | `completed_at` UTC → ngày VN (UTC+7, không DST) để xét kỳ. |

### 1.4. Nguồn mẫu, quyền SA và tên nguồn production

**[Operator 01/11]** Hai view/table chuẩn CMS chưa tồn tại. Nguồn thô đã dùng lấy mẫu:

- `lakehouse-prod-394907.buymed_circa_v2.order_order_item`
- `lakehouse-prod-394907.buymed_circa_v2.order_order`
- `lakehouse-prod-394907.buymed_circa_v2.entity_entity`
- `lakehouse-prod-394907.buymed_circa_v2.entity_pos_profile`
- `lakehouse-prod-394907.buymed_circa_v2.product_product` (`client_id = 1`)
- `lakehouse-prod-394907.gold_buymed_vn2.dim_product`

**[Dev đọc 01/11, dry-run không trả dữ liệu]** SA của app (`BQ_SERVICE_ACCOUNT_KEY`, scope `bigquery.readonly`) nhận **403 Access Denied trên cả 6 bảng trên**; đối chứng `buymed_tech.tech__circa_os_gmv_kpi` đọc được.

**[PM]** Tên bảng thật lấy qua `CMS_BQ_PRODUCTS_TABLE` và `CMS_BQ_SALES_TABLE` (dạng `project.dataset.table`, validate như `CARE_BQ_ORDERS_TABLE`); không hardcode nguồn thô ngoài quyền SA và không nới quyền SA trong batch này. Tên `tech__circa_product_master` / `tech__circa_order_lines` của r1 chỉ là đề xuất.

Gate:

- Product Master đọc được bằng SA hiện hành = **gate phát hành P1**.
- Feed dòng bán đọc được bằng SA = gate số đo P0 và gate P2.
- Thiếu hai nguồn này **không chặn** code bằng fixture.

**[Operator xác nhận, PM PR-0]** Operator bảo đảm sẽ cung cấp nguồn đọc được bằng SA trong `buymed_tech`. Chỉ lấy tên bảng/cấu hình và kiểm chứng khi tới bước chạy nguồn thật; không yêu cầu query, đếm catalog hoặc lặp dry-run nguồn thô ở mỗi vòng code/review. Giá tham khảo vẫn optional.

Mẫu ngoài repo (không commit, không dump log):

- `Downloads/job_p6Q1sPFwnNEYkeEkSGprNw6gwGho.json`: mẫu BigQuery mới nhất (10 dòng, 2 đơn, 8 ProductID; mọi giá trị là chuỗi; timestamp `YYYY-MM-DD HH:MM:SS.ffffff UTC`; chưa có `order_type`). Shape chính cho dòng bán.
- `Downloads/job_PhkXfiPtrr-fBhb_Q2yrEBie0f37.json`: mẫu cũ cùng tập đơn, chỉ đối chiếu.
- `Downloads/response_DHC01321584.json`, `Downloads/pos-order-sample-2026-11-01.json`: response API POS (có PII). Chỉ tham khảo nghĩa field/quy cách; **không** xây adapter production bằng cách đổi tên `total_amount` / `completed_date` của POS thành field BigQuery.

Query mẫu (chỉ đọc, chưa phải feed production; tái hiện từ operator, PM thêm `order_type` / `order_updated_at`; tham số `@from_date` / `@to_date` DATE, `@order_codes` ARRAY<STRING>):

```sql
SELECT
  ent.email AS email,
  o.code AS order_code,
  o.id AS order_id,
  o.status AS order_status,
  o.type AS order_type,
  o.completed_at AS order_completed_at,
  o.updated_at AS order_updated_at,
  item.product_id AS product_id,
  pos.name AS pos_name,
  pos.code AS pos_code,
  p.name AS product_name,
  p.volumes AS product_volumes,
  dp.product_image_url AS product_url,
  item.id AS item_id,
  item.quantity,
  item.unit,
  item.base_quantity,
  item.unit_price,
  item.amount,
  item.tax_rate,
  item.discount_amount AS item_discount_amount,
  item.sku_code,
  item.seller_code,
  item.created_at AS item_created_at,
  item.updated_at AS item_updated_at,
  item.sync_at AS item_sync_at,
  item.publish_time AS item_publish_time,
  item.created_date AS item_created_date
FROM `lakehouse-prod-394907.buymed_circa_v2.order_order_item` AS item
INNER JOIN `lakehouse-prod-394907.buymed_circa_v2.order_order` AS o
  ON item.order_id = o.id AND item.created_date = o.created_date
LEFT JOIN `lakehouse-prod-394907.buymed_circa_v2.entity_pos_profile` AS pos
  ON o.pos_id = pos.id
LEFT JOIN `lakehouse-prod-394907.buymed_circa_v2.entity_entity` AS ent
  ON o.updated_by = ent.id
LEFT JOIN `lakehouse-prod-394907.buymed_circa_v2.product_product` AS p
  ON CAST(item.product_id AS INT64) = p.product_id
  AND p.client_id = 1 AND p.unit NOT IN ('test')
LEFT JOIN `lakehouse-prod-394907.gold_buymed_vn2.dim_product` AS dp
  ON CAST(item.product_id AS INT64) = dp.product_id
WHERE item.created_date BETWEEN @from_date AND @to_date
  AND o.created_date BETWEEN @from_date AND @to_date
  AND o.code IN UNNEST(@order_codes);
```

Hợp đồng BI cuối vẫn cần `source_updated_at` phản ánh thay đổi order và item, ID không nhân bản sau JOIN và đọc được bằng SA thật.

## 2. Kiểu số và engine

Engine nằm trong `lib/cms/`, là hàm thuần, không gọi Supabase hoặc BigQuery.

Các phần chính:

- Chuẩn hóa số thập phân chính xác.
- Quy đổi số lượng.
- Xét gate.
- Tính lũy tiến và trần.
- Phân bổ theo dòng.
- Tổng hợp theo người/sản phẩm.
- Phát hiện vấn đề dữ liệu.

Quy tắc số học:

- Dữ liệu NUMERIC đi qua biên JSON dưới dạng chuỗi thập phân.
- Số lượng cơ sở, GMV và `base_quantity_CMS` dùng số học thập phân chính xác: BigInt theo cùng scale (tối đa **9** chữ số thập phân); vượt precision hỗ trợ ⇒ lỗi, không cắt số.
- Chia lượng cơ sở bằng phép chia nguyên chính xác để lấy `Q = floor(max(0, B) / K)`.
- CMS là số nguyên VND.
- Không tính bằng số đã format hoặc làm tròn trên UI.
- Giá trị vượt phạm vi hỗ trợ phải báo lỗi dữ liệu; không clamp hoặc thay bằng 0.
- Giá trị 0 hợp lệ được phân biệt với thiếu dữ liệu.

Engine chỉ có chế độ lũy tiến. `flat` không thuộc implementation r2.

Phân bổ dòng: sắp theo `completed_at` (micro giây) rồi `order_line_id`; `Tiền dòng = A(B_sau) − A(B_trước)`, `A(B) = F(floor(max(0, B) / K))`; gate cuối chưa đạt ⇒ mọi dòng 0. Tổng tiền dòng = tổng dược sĩ × sản phẩm. Cùng đầu vào, khác thứ tự nhận ⇒ kết quả giống nhau.

## 3. Mô hình dữ liệu

| Bảng | Trách nhiệm | Migration |
|---|---|---|
| `cms_product_master` | Cache thông tin sản phẩm | 120 |
| `cms_programs` | Chương trình, trạng thái, revision cấu hình (`config_version`), `is_test`; `current_result_run_id` thêm ở 122 | 120 |
| `cms_program_stores` | Danh sách nhà thuốc tham gia | 120 |
| `cms_program_products` | ProductID, gate, target, `unit_CMS`, `base_quantity_CMS`, tư vấn, snapshot thông tin sản phẩm | 120 |
| `cms_program_tiers` | Bậc số lượng và tiền trên đơn vị CMS | 120 |
| `cms_import_runs` | Preview/commit, hash, kết quả từng dòng, thống kê và người nhập | 120 (bảng) / 121 (RPC) |
| `cms_sync_runs` | Phiên lấy nguồn/tính kết quả, trạng thái, revision, số dòng, lỗi và thời gian | 120 (kind `products`) / 122 mở rộng |
| `cms_sync_run_chunks` | Sổ khối đã stage của run (retry không nhân đôi, seal kiểm đủ khối) | 122 |
| `cms_sales_lines` | Snapshot đầu vào theo phiên tính | 122 |
| `cms_results` | Kết quả dược sĩ × sản phẩm theo phiên | 122 |
| `cms_result_catalog` | Gate danh mục của từng dược sĩ theo phiên | 122 |
| `cms_result_lines` | Phân bổ tiền từng dòng của cùng phiên | 122 |
| `cms_payouts` | Một dòng / chương trình đã chốt: run đóng băng, tổng, Q-213, policy + version, nguồn đầy đủ, người / lúc chốt (bất biến) | 123 |
| `cms_payout_staff` | Tổng theo dược sĩ + định danh snapshot (tên / email / nhà thuốc lúc chốt) — mọi dược sĩ có kết quả, kể cả 0 đ | 123 |

Thay đổi so với r1: thêm hai trường quy cách CMS vào sản phẩm chương trình; thêm `config_version`; kết quả tổng và kết quả dòng cùng mang `run_id`; chương trình trỏ tới `current_result_run_id`; có `is_test`; D3 đọc `cms_result_lines` (không viết lại engine bằng SQL); bỏ `tier_mode` và ô target danh mục nhập tay.

### 3.1. Cột dự kiến cho 120 **[Dev đề xuất]**

- `cms_product_master`: `product_id text PK CHECK (product_id ~ '^[1-9][0-9]*$')` (canonical dương, không số 0 đầu — §1.3), `product_name text NOT NULL`, `image_url text`, `is_active boolean NOT NULL`, `source_updated_at timestamptz NOT NULL`, `reference_price numeric`, `price_unit text`, `synced_at timestamptz NOT NULL`, `sync_run_id uuid`.
- `cms_programs`: `id uuid PK`, `name text NOT NULL`, `status text CHECK IN ('draft','active','locked')`, `start_date date`, `end_date date` (`CHECK end_date >= start_date`), `scope text CHECK IN ('all','stores')`, `catalog_target_gmv bigint CHECK > 0` (suy từ Excel), `calc_mode text DEFAULT 'progressive' CHECK = 'progressive'`, `gate_scope text DEFAULT 'pharmacist' CHECK = 'pharmacist'`, `is_test boolean NOT NULL`, `config_version int NOT NULL`, `created_by/at`, `updated_by/at`, `activated_by/at`, `locked_by/at` (P3a — RPC chốt 123 ghi; chỉ chuyển sang `locked` khi có `cms_payouts` khớp run hiện hành).
- `cms_program_stores`: `PK (program_id, store_id)`; `scope = 'all'` được ghi thành danh sách OS active lúc kích hoạt.
- `cms_program_products`: `id uuid PK`, `program_id`, `product_id text`, `gmv_basis text CHECK IN ('product','catalog','none')`, `target_gmv bigint` (bắt buộc ⇔ `gmv_basis = 'product'`), `unit_cms text NOT NULL`, `base_quantity_cms numeric NOT NULL CHECK (> 0 AND scale ≤ 9)`, `advice_text text NOT NULL CHECK (char_length ≤ 4000)`, `name_snapshot`, `image_url_snapshot`, `price_snapshot`, `import_run_id`, `added_after_start boolean`; `UNIQUE (program_id, product_id)`.
- `cms_program_tiers`: `PK (program_product_id, tier_order)`, `qty_from int ≥ 1`, `qty_to int NULL` (chỉ bậc cuối), `amount_per_unit bigint > 0`. Import kiểm `Tu_SL_ban` / `Den_SL_ban` ≤ 2.147.483.647 (giới hạn `int`) — vượt ⇒ lỗi "ngoài khoảng", không cắt.
- `cms_program_products.product_id` cùng CHECK canonical như `cms_product_master`.
- `cms_import_runs`: `id`, `program_id`, `mode ('replace','append')`, `file_name`, `file_sha256`, `file_bytes`, `config_version_at_preview`, thống kê dòng/nhóm, `result jsonb` (kết quả từng dòng + raw cells của toàn bộ nhóm bị loại để sinh file lỗi), `status ('previewed','committed')`, `created_by/at`, `committed_by/at`.
- `cms_sync_runs`: `id`, `kind ('products', …)`, `program_id NULL`, `status ('running','ok','held','error')`, `started_at`, `finished_at`, `rows`, `bytes_processed`, `error`, `detail jsonb`.

Quyền đọc **[Dev đề xuất]**:

- Bảng danh mục chương trình (`cms_programs`, `_stores`, `_products`, `_tiers`): `SELECT` cho `authenticated` qua RLS helper SECDEF; không INSERT/UPDATE/DELETE cho `authenticated`.
- `cms_product_master`, `cms_import_runs`: chỉ super admin đọc (D2 dùng snapshot trên `cms_program_products`).
- `cms_sync_runs`, bảng snapshot/kết quả P2: chỉ service role; UI đọc qua RPC đã lọc quyền.
- Supabase default privileges tự cấp quyền bảng/hàm mới cho `anon`/`authenticated` ⇒ REVOKE đích danh cả bảng và hàm rồi GRANT đúng ma trận.

Marker QA **[PM chấp thuận phương án; kiểm SQL ở P1-a]**: bảng `cms_qa_access (user_id PK, granted_by, expires_at)` chỉ service role ghi (script QA của operator), hạn ngắn; helper chỉ hiển thị chương trình `is_test` cho user có marker còn hạn — **kể cả super admin** (H9/H9b, PM xác nhận PR-0). `expires_at` bắt buộc, kiểm bằng thời gian DB; user không tự cấp/gia hạn marker. Không cấp theo tên tài khoản. Thống kê A1, cron và báo cáo thật loại `is_test`.

## 4. Import Excel

### 4.1. Định dạng

- `.xlsx`, sheet `IMPORT_CMS`.
- Tối đa 5 MiB và 2.000 dòng dữ liệu.
- Tìm header theo tên, không phụ thuộc số hàng.
- Header không phân biệt hoa thường và khoảng trắng thừa.
- Bắt đầu đọc sau header; dừng ở dòng ProductID trống đầu tiên.
- Hiện thông báo rằng nội dung sau điểm dừng không được nhập.
- Bỏ qua cột ngoài hợp đồng (kể cả cột có công thức, ví dụ cột J của mẫu r1).

Chín cột:

| Cột | Quy tắc |
|---|---|
| `ProductID` | Bắt buộc, phải tra được Product Master |
| `KPI_Target_GMV_VND` | Số nguyên dương hoặc trống |
| `Loai_CMS_GMV` | `GMV_THEO_PRODUCTID`, `GMV_TOAN_DANH_MUC` hoặc trống |
| `Tu_SL_ban` | Số nguyên ≥ 1 |
| `Den_SL_ban` | Số nguyên ≥ từ, hoặc trống ở bậc cuối |
| `CMS_VND_SP` | Số nguyên VND > 0 |
| `Noi_dung_tu_van` | Bắt buộc, tối đa 4.000 ký tự |
| `unit_CMS` | Bắt buộc |
| `base_quantity_CMS` | Số dương, cùng chuẩn cơ sở với nguồn, tối đa 9 chữ số thập phân |

### 4.2. Đọc giá trị ô

**[PM §3 H4, §5]:**

- **ProductID:** ô numeric chỉ nhận nếu là số nguyên an toàn; text nhận chuỗi chữ số sau trim. Từ chối phân số, text số mũ hoặc ô đã mất độ chính xác. Không dùng giá trị hiển thị số mũ của Excel để kết luận một ô numeric nguyên an toàn bị sai.
- **Số tiền / số nguyên** (`KPI_Target_GMV_VND`, `Tu_SL_ban`, `Den_SL_ban`, `CMS_VND_SP`): ô numeric nguyên an toàn hoặc text chỉ có chữ số sau trim. **Không** strip dấu chấm/phẩy/khoảng trắng trong text để đoán giá trị. Ô numeric có number format phân cách nghìn vẫn đọc underlying value (hợp lệ).
- **Ô công thức** trong cột hợp đồng ⇒ lỗi; công thức ở cột thừa bị bỏ qua. **[PM review P1-b]** Công thức có hoặc không có giá trị cache (kể cả cache trống) **không** phải điểm dừng: dòng đó lỗi `CELL_FORMULA`, các dòng sau vẫn đọc; chỉ ProductID thật sự trống mới là điểm dừng.
- **[PM review P1-b] Ô ngày / giờ** (kể cả ô số mang định dạng ngày / giờ) trong cột hợp đồng ⇒ lỗi kiểu; không coi serial ngày là tiền, mã hay số lượng. Ô số có định dạng phân cách nghìn / thập phân vẫn hợp lệ.
- **[PM review P1-b] Miền số chung validator ↔ RPC:** tiền (`CMS_VND_SP`, target sản phẩm, target danh mục) là bigint dương PG (≤ 9.223.372.036.854.775.807, chuỗi chính xác); quy cách ≤ 29 chữ số nguyên / 9 chữ số thập phân; ô số quy cách ngoài miền nguyên an toàn của JS ⇒ lỗi (nhập dạng text chính xác). Ngoài miền ⇒ loại đúng nhóm ngay preview; đây là kiểm kiểu dữ liệu, không phải trần ngân sách.
- **`base_quantity_CMS`:** decimal chính xác tối đa 9 chữ số sau dấu chấm; vượt ⇒ lỗi, không cắt / làm tròn.

**[Dev đề xuất]** cách hiện thực cho `base_quantity_CMS`:

- Text: dạng `^[0-9]+(\.[0-9]{1,9})?$` (dấu chấm thập phân, không phân cách nghìn), > 0.
- Ô numeric: đọc giá trị hữu hạn dương; chuyển biểu diễn ngắn nhất sang decimal bằng xử lý chữ số, kể cả khi JS trả dạng số mũ (ví dụ `1e-9` → `0.000000001`), rồi kiểm precision và scale tối đa 9. Numeric nguyên ngoài giới hạn an toàn hoặc giá trị không thể biểu diễn theo contract ⇒ lỗi; không cắt/làm tròn. Text số mũ vẫn không hợp lệ. Không từ chối một ô numeric hợp lệ chỉ vì JS/Excel hiển thị dạng số mũ.
- Text tư vấn giữ xuống dòng; hiển thị text thuần.

### 4.3. Suy gate

- Target và loại đều trống → không target.
- Có target, loại ProductID → target sản phẩm.
- Có target, loại danh mục → target danh mục.
- Có loại nhưng thiếu target, hoặc có target nhưng thiếu loại → lỗi.

Mọi dòng danh mục phải khai báo cùng một target của chương trình.

### 4.4. Kiểm tra nhóm

Các dòng cùng ProductID là một nhóm. Một dòng lỗi làm loại cả nhóm.

Loại nhóm khi:

- Không tìm thấy sản phẩm.
- Target, loại, đơn vị, quy cách hoặc tư vấn không thống nhất.
- Bậc không bắt đầu từ 1, hở hoặc chồng.
- Cận trên trống ở bậc chưa phải cuối.
- Sai kiểu hoặc ngoài khoảng.
- Xung đột chương trình đã kích hoạt (cùng namespace `is_test`).
- Nạp lại sản phẩm đã có khi chương trình đã bắt đầu.

Nếu các nhóm danh mục khai báo target khác nhau, loại các nhóm danh mục liên quan; nhóm không thuộc danh mục vẫn có thể hợp lệ.

Cảnh báo vẫn cho nhập:

- Thiếu ảnh (hoặc URL ảnh ngoài prefix được duyệt, §8.2).
- ~~Sản phẩm ngừng hoạt động~~ — bỏ từ r2.1 (S-BI-3, operator 04/11).
- Mức CMS > 500.000đ.
- Bậc cuối hữu hạn rất lớn (`Den_SL_ban` ≥ 10.000, theo r1).

Không tự ép mức thưởng các bậc phải tăng dần.

### 4.5. Luồng server

1. Tạo/lưu chương trình nháp để có `program_id`.
2. Client giữ file; gọi preview qua Route Handler có giới hạn byte.
3. Server parse, tra nguồn, kiểm tra nhóm và lưu import run.
4. UI hiển thị đầy đủ nhóm hợp lệ, nhóm bị loại và cảnh báo.
5. Khi xác nhận, client gửi lại file cùng `run_id`.
6. Server kiểm tra hash, parse và validate lại theo cấu hình/nguồn hiện tại.
7. RPC ghi dữ liệu và audit atomic.

Đây là file phân tích tạm trong request, theo mẫu import hiện có (`app/api/care/import/*`); không bổ sung đường lưu file đính kèm mới. Route Handler (r2 §3.4; Server Action giới hạn 1 MB). **[Dev đề xuất]** thứ tự kiểm theo `lib/care/import/handler.ts`: cờ → quyền session super admin → giới hạn byte (thiếu Content-Length 411, quá 413) → multipart đúng một `.xlsx` (415) → parse; commit lệch hash/kết quả preview ⇒ 409.

RPC không parse XLSX và không tin các dòng do client gửi.

Nếu kết quả kiểm tra thay đổi sau preview, trả xung đột và yêu cầu xem preview mới; không tự commit một tập khác.

### 4.6. Chế độ ghi

- Nháp hoặc active chưa bắt đầu: thay thế toàn bộ danh mục bằng các nhóm hợp lệ đã xác nhận.
- Active đã bắt đầu: chỉ thêm sản phẩm mới.
- Target danh mục hiện hữu không được thay đổi giữa kỳ.
- Nếu bổ sung nhóm danh mục đầu tiên, được thiết lập target cho nhóm mới đó.
- Commit lại một run đã committed không ghi thêm dữ liệu.

File lỗi xuất lại toàn bộ nhóm bị loại cùng cột lý do, sinh từ raw cells lưu trong import run, để không tạo thang bậc thiếu khi nhập lại.

Template mới có thêm hai cột quy cách và dùng ProductID số giả nhất quán (**[Dev đề xuất]** file tĩnh `public/templates/Circa_Import_CMS.xlsx` sinh bằng script). File mẫu r1 (`docs/cms/samples/Circa_Import_CMS_Phase_2_.xlsx`) thiếu các cột này phải được báo thiếu cột; không tự mặc định hệ số bằng 1. Mẫu r1 giữ làm fixture lỗi / tài liệu lịch sử.

### 4.7. Trạng thái × hành động (P1)

Nguồn: r2 §2.3, §2.4, §3.4, §3.7 + H7/H8/H9. Mọi hành động chỉ super admin, qua server action / Route Handler kiểm quyền rồi gọi RPC service role; kiểm lại trạng thái và ngày VN **trong transaction** của RPC (không tin trạng thái client đã xem).

| Hành động | Nháp | Đã kích hoạt, chưa bắt đầu | Đã bắt đầu (Đang chạy / Chờ chốt kỳ) | Đã chốt |
|---|---|---|---|---|
| Tạo chương trình (nháp) | — | — | — | — |
| Sửa thông tin (tên, ngày, phạm vi) | Có | Có — kiểm trùng ProductID lại với khoảng ngày / phạm vi mới; **ngày bắt đầu mới phải sau hôm nay VN** (Q-214 — hồi tố chỉ qua nháp + kích hoạt có xác nhận) | Không | Không |
| Nạp lại toàn bộ danh mục (`replace`) | Có | Có — kiểm trùng trong transaction | Không | Không |
| Thêm sản phẩm mới (`append`, hồi tố) | — (dùng nạp lại) | — (dùng nạp lại) | Có — chỉ ProductID chưa có; target danh mục hiện hữu không đổi; nhóm danh mục đầu tiên được đặt target | Không |
| Sửa / nạp lại sản phẩm đã có | Có (qua nạp lại) | Có (qua nạp lại) | Không — nhóm bị loại | Không |
| Kích hoạt (`draft → active`) | Có | — | — | — |
| Xóa / hủy / về nháp / tạm dừng / mở khóa | Không (H8) | Không | Không | Không |
| Chốt (`active → locked`) | — | — | P3a: chỉ khi **đã hết kỳ** (`end_date < hôm nay VN`), super, cờ `CMS_LOCK_ENABLED`; preview → xác nhận; RPC 123 kiểm lại run / policy / mapping / Q-213 / cổng. Chương trình thật bị chặn tới Q-206 / Q-213 / Q-216 | — |

Khoảng ngày mọi chương trình: 2020-01-01…2100-12-31 và `end_date ≥ start_date`; **không có trần độ dài kỳ** (Q-215). Phạm vi `stores` khi kích hoạt có nhà thuốc ngừng / FS ⇒ từ chối `STORE_INVALID`, super admin sửa phạm vi (không tự loại).

Điều kiện kích hoạt (kiểm trong transaction, sau khi giữ **khoá danh mục toàn cục** — PM chấp thuận review P1-b thay khoá theo ProductID; READ COMMITTED, `lock_timeout` 5 s):

1. Trạng thái hiện tại là `draft`; `end_date ≥ start_date`.
2. Có ≥ 1 sản phẩm hợp lệ đã ghi; mọi sản phẩm `catalog` có target danh mục chương trình.
3. Không xung đột ProductID với chương trình đã kích hoạt / đã chốt có khoảng ngày giao nhau, **cùng namespace `is_test`**.
4. Ngày bắt đầu đã qua vẫn được kích hoạt (H7): màn xác nhận nói rõ áp dụng hồi tố từ ngày bắt đầu và sau kích hoạt chỉ còn thêm sản phẩm; ngày kết thúc đã qua ⇒ hiển thị Chờ chốt kỳ, không cấp quyền chốt hay bật tiền.
5. Phạm vi `all` ⇒ ghi danh sách nhà thuốc OS đang hoạt động tại thời điểm kích hoạt; tăng `config_version`.

## 5. Công bố kết quả atomic (P2-b — giao 02/11 theo kế hoạch tích hợp PM; hiện thực 122 ở §5.1, chờ audit DDL)

Chọn một phiên bản kết quả làm nguồn chung cho UI và export.

Luồng một chương trình:

1. RPC bắt đầu run, ghi nhận `config_version` và khóa chống run đồng thời.
2. Lấy đầy đủ dữ liệu nguồn, có phân trang và kiểm tra số dòng.
3. Map người bán, xác định phạm vi và chạy engine.
4. Stage đầu vào, kết quả tổng và kết quả dòng theo `run_id`.
5. RPC công bố kiểm tra revision, trạng thái run, số dòng và các tổng đối chiếu.
6. Transaction cập nhật `current_result_run_id`.
7. Revalidate các route liên quan.

Không giữ transaction DB mở trong lúc gọi BigQuery hoặc chạy TypeScript.

Khi cấu hình thay đổi trong lúc tính, run cũ không được công bố.

Khi nguồn hoặc tính toán lỗi:

- Giữ pointer về phiên thành công trước.
- Có số cũ thì hiện số cũ và thời điểm cập nhật.
- Chưa từng có snapshot thì hiện `—`.
- Không ghi số 0 thay cho lỗi.

Staging của run chưa công bố không được xuất hiện qua RLS/RPC đọc.

Giữ phiên hiện hành và phiên thành công trước để đối soát; dọn staging lỗi quá 24 giờ bằng batch có điều kiện. Metadata run được giữ phục vụ audit.

**[PM 03/11 §4 — đã duyệt]** Retention cụ thể: giữ dữ liệu của run hiện hành + run công bố liền trước; dữ liệu nặng (khối stage, dòng bán, kết quả) của run `held` / `error` giữ **tối đa 2 run gần nhất mỗi chương trình VÀ không quá 24 giờ** (thứ tự `finished_at DESC, id DESC` — tất định khi trùng thời điểm); run `ok` cũ hơn liền trước bị dọn. Dòng `cms_sync_runs` (metadata) không xoá. Dọn theo lô có trần dòng / lần gọi; run đang dọn dở đọc ra `CMS_RESULT_RUN_GONE`, không thấy dữ liệu cụt.

**[PM 03/11 r2.2 §3.3 — đã chốt]** "2 run gần nhất" đếm **mọi** run sales `held` / `error` của chương trình, kể cả run đã dọn hoặc chưa từng stage dữ liệu (thứ tự `finished_at DESC, id DESC`); 24 giờ vẫn là trần bổ sung; run hiện hành / công bố liền trước / đang chạy không thuộc tập này. Đây là giới hạn **tối đa**, không cam kết luôn còn hai snapshot lỗi đủ dữ liệu chẩn đoán: hai lỗi nguồn mới có thể làm run seal cũ bị dọn (metadata vẫn còn). Cần giữ bằng chứng đặc biệt ⇒ operator thu bản đã che định danh theo quy trình trước khi dọn; không tự sửa retention SQL hay giữ raw data vô hạn.

### 5.1. Hiện thực migration 122 **[Dev đề xuất — chờ db-reviewer + PM audit DDL]**

- `cms_sync_runs`: kind `sales`; cột `config_version`, `is_test`, `mapping_fp` (vân tay users + stores lúc open), `sealed_at`, `published_at`, `purged_at` (bắt đầu dọn), `cleared_at` (dọn xong), `seal_expect` / `seal_step` (seal tách bước), `source_max_updated_at`, `amount_vnd`.
- `cms_program_tiers`: index **UNIQUE** `(program_product_id, qty_from)` để seal tra bậc chứa Q bằng `LIMIT 1` **[PM 03/11 §5 — đã duyệt]**; preflight 122 dừng cả migration nếu dữ liệu bậc hiện có trùng mốc (không tự xoá / gộp); hậu kiểm index UNIQUE, hợp lệ, đúng cột. Không thay kiểm bậc liên tục / không chồng của 121 / engine. Ràng buộc: run sales `ok` ⇔ đã công bố (cần seal + tổng tiền) — `rpc_cms_sync_run_close` của 120 không đóng được run sales thành `ok`.
- `cms_programs.current_result_run_id` + FK kép (run, chương trình) + trigger: chỉ trỏ run sales `ok` chưa dọn của chính chương trình, cùng `config_version` / `is_test`; chỉ đổi khi `active`; đã chốt thì bất biến.
- Bảng (RLS bật, không policy, chỉ service_role): `cms_sync_run_chunks` (sổ khối đã stage), `cms_sales_lines` (chỉ dòng **ứng viên** INCLUDED / UNASSIGNED / OUT_OF_SCOPE, `seq` = thứ tự engine; dòng không ứng viên chỉ đếm theo lý do), `cms_results`, `cms_result_catalog`, `cms_result_lines`.
- Luồng ghi (service_role): `rpc_cms_sales_run_open` (khoá dòng chương trình, chỉ `active` đã bắt đầu theo ngày VN, một run / chương trình, treo > 30′ ⇒ STALE; trả snapshot cấu hình + users / stores để map) → `rpc_cms_sales_run_stage` (khối ≤ 5.000 dòng có số; gửi lại cùng digest không nhân đôi) → `rpc_cms_sales_run_seal_begin` + `rpc_cms_sales_run_seal_step` bước 1…10 (mỗi bước một câu lệnh ngắn < 8 s `statement_timeout` của PostgREST; đối chiếu độc lập: đủ khối, thứ tự, kỳ / phạm vi, người bán, cấu hình, tổng nhóm, Q, F(Q), gate + "đạt từ", phân bổ + trạng thái dòng, tổng tiền; đầu mỗi bước kiểm lại cấu hình / mapping / chương trình chốt ⇒ held; gọi lại bước đã qua ⇒ already) → `rpc_cms_sales_run_publish` (khoá chương trình → run; lỗi thời / đã chốt ⇒ held, gọi lại ⇒ already) → `rpc_cms_sales_run_finish` / `rpc_cms_sales_run_cleanup`. SQL không tính tiền thay engine.
- Đọc (authenticated, SECDEF): `rpc_cms_result_header`, `rpc_cms_result_rows`, `rpc_cms_result_lines` (D3 / XLSX, con trỏ `seq`), `rpc_cms_result_excluded` (chỉ super — có email nguồn để sửa mapping). Phạm vi **hiện tại** theo §4.3 kế hoạch PM; `run_id` không thuộc chương trình / chưa công bố / đã dọn ⇒ `CMS_RESULT_RUN_GONE`.
- Q-206: hai lớp. App: lõi đồng bộ (`lib/cms/releaseGate.ts`, hằng trong mã) dừng chương trình thật ở held `RESULTS_RELEASE_GATE` sau seal; cron bỏ qua chương trình thật khi cổng đóng. DB: `cms__results_release_open()` = false ⇒ `rpc_cms_sales_run_publish` từ chối run không `is_test`. Mở cổng = migration riêng sau khi Q-206 chốt. Chương trình QA (`is_test`) công bố được.

## 6. Đồng bộ và kiểm soát nguồn

Bản đầu **đọc lại toàn kỳ của từng chương trình** thay vì phụ thuộc hoàn toàn vào watermark tăng dần — bắt đơn đến muộn và chỉnh sửa cũ; tự xử lý danh mục bổ sung hồi tố; tính lại sau khi mapping tài khoản được sửa; tránh đánh mất thay đổi do chỉ nhìn `item.updated_at`.

Query có tham số, giới hạn kỳ và ProductID. Dùng BigQuery client có sẵn (`lib/bigquery/client.ts` → `bqQueryAll`), đọc đủ mọi trang.

Mặc định kỹ thuật:

- Trần 200.000 dòng/chương trình/lượt; vượt thì held, không lấy một phần.
- Thứ tự xử lý ưu tiên chương trình có lần thành công cũ nhất.
- Deadline toàn lượt; hết budget thì để chương trình chưa xử lý cho lượt sau. **[PM 03/11 P1-I2-1]** Deadline phủ cả stage, từng bước seal, publish và cleanup: timeout mỗi RPC lấy từ ngân sách còn lại (kẹp 1…60 s), giữ dự trữ 15 s để đóng run (finish) và báo cáo; một RPC làm việc / một lô cleanup chỉ **bắt đầu** khi còn ≥ 10 s trước mốc của nó (statement_timeout 8 s + mạng — không tự huỷ RPC hợp lệ); hết ngân sách giữa chừng ⇒ đóng run `held DEADLINE`, không chạy tiếp bước sau; RPC bị huỷ không mã khi ngân sách đã hết cũng là `DEADLINE`, có mã `CMS_*` là lỗi đúng mã. Publish: DB trả mã `CMS_*` = từ chối xác định (đã rollback) ⇒ báo mã; không nhận được phản hồi ⇒ gọi lại một lần (idempotent), vẫn không rõ ⇒ `PUBLISH_UNKNOWN`, không tự đánh held / rollback. Cleanup chạy theo lô trong ngân sách còn lại, tóm tắt cron báo `cleanupMore` / `cleanupStoppedBy`; `elapsedMs` đo sau cleanup; truy vấn chọn chương trình cũng theo ngân sách cron. Rủi ro đã biết: cleanup của chương trình trước (≤ 20 lô) dùng chung ngân sách ⇒ chương trình sau có thể `pending` — theo dõi qua cảnh báo cron, đo ở I4. Script operator (`cms-sales-sync.mjs`) chạy tay, không có hạn tổng: mỗi RPC ≤ 60 s, cleanup ≤ 20 lô.
- Chương trình lỗi không chặn những chương trình khác.
- Chương trình `is_test` không vào cron/báo cáo thật.

Gate P0 phải đo số dòng, thời gian và lượng dữ liệu query. Nếu vượt budget, Dev báo PM để sửa thiết kế nguồn trước khi bật P2; không tự chuyển sang đọc thiếu.

Chất lượng nguồn:

- Trùng `order_line_id`, sai số hoặc timestamp, thiếu trang → held.
- Snapshot rỗng bất thường sau snapshot có dữ liệu → held để kiểm tra.
- Mapping chưa gán > 20% dòng ứng viên → held theo r1.
- Dưới ngưỡng, kết quả tính thử phải kèm danh sách và số liệu bị loại.
- Thiếu `base_quantity` hoặc sai quy cách: ghi nhóm “Chưa quy đổi đơn vị”; giữ snapshot công bố trước, không công bố số thiếu như kết quả hoàn chỉnh.

Điều kiện công bố tiền thật được kiểm lại khi đóng Q-206.

## 7. API, RPC và bảo mật

| Nhóm | Giao diện |
|---|---|
| Chương trình | Server actions tạo/sửa/kích hoạt |
| Import | POST preview, POST commit, GET file lỗi; template tĩnh `public/templates/Circa_Import_CMS.xlsx` |
| Đọc danh mục (P1) | Bảng danh mục qua RLS |
| Đọc kết quả (P2) | RPC `rpc_cms_result_header` / `_rows` / `_lines` / `_excluded` (122, §5.1) |
| Export (P2) | GET export CMS theo chương trình, bộ lọc và `run_id` của màn hình |
| Cron | Pull Product Master (P1); `/api/cron/sync-cms-sales` (P2, cần `CMS_PROGRAM_ENABLED` + `CMS_EARNINGS_ENABLED`); script operator `scripts/cms-sales-sync.mjs` cùng lõi, dry-run mặc định |

Quy tắc:

- Check session, vai trò, phạm vi và cờ ở server.
- Super admin phải có role admin và email trong allowlist hiện hành (`lib/authz.ts` + `public.is_super_admin()`); không định nghĩa lại allowlist trong migration CMS.
- RPC ghi chỉ cấp EXECUTE cho service role; server action xác thực quyền trước khi gọi.
- RPC đọc và RLS lọc quyền độc lập với UI.
- Không cấp authenticated quyền đọc raw sales hoặc ghi trực tiếp bảng CMS.
- Các helper RLS dùng SECDEF/STABLE/`search_path` cố định, viết dạng `(select …)`, tránh tham chiếu vòng bảng RLS (vẽ đồ thị tham chiếu trước).
- REVOKE đích danh PUBLIC/anon/authenticated trước khi GRANT đúng ma trận.
- Kiểm ACL sau migration bằng `has_function_privilege` / `has_table_privilege` theo ma trận tường minh.
- `is_test` do server/QA gate quyết định; client không được gửi cờ này để đổi namespace (H9). User thật (kể cả super admin) không thấy chương trình QA qua route, RPC, RLS, export nếu không có marker QA hợp lệ.
- Nội dung tư vấn là text thuần (`white-space: pre-line`), không render HTML.
- Response cá nhân và export không được cache công khai.
- Log không chứa email đầy đủ, thông tin khách hàng hoặc response POS.
- Sub-agent reviewer chỉ đọc source/diff và DB kiểm thử local/PG15; không truy cập prod. VERIFY prod do Dev/operator làm qua wrapper chỉ đọc của dự án.
- `UPDATE`/`DELETE` trong SQL luôn có `WHERE` (`pg_safeupdate`).

## 8. Route, UI và ảnh

### 8.1. Route

| Màn | Route | Nội dung |
|---|---|---|
| A1 | `/targets/campaigns/cms` | Danh sách và thống kê chương trình |
| A2 | `/targets/campaigns/cms/new` | Wizard tạo và import |
| A2 bổ sung | `/targets/campaigns/cms/[id]/import` | Nạp thêm/nạp lại theo trạng thái |
| A3 | `/targets/campaigns/cms/[id]` | Danh mục, kết quả và import run |
| D1 | `/targets?tab=cms&program=` | Danh mục/CMS cá nhân hoặc tổng QLCH |
| D2 | `/targets/cms/products/[programProductId]` | Sản phẩm, chính sách, tư vấn và kết quả |
| D3 | `/targets/cms/history?program=&product=` | Lịch sử dòng (P2) |

Yêu cầu P1:

- Hiện danh mục, target, các bậc và `đồng/unit_CMS`.
- Ẩn CMS đã kiếm được, lượng đã bán, tiến độ thực tế và lịch sử giao dịch.
- Không hiển thị 0 giả cho phần chưa được bật.
- Wizard bỏ ô nhập target danh mục riêng.
- Preview có thêm đơn vị CMS và hệ số cơ sở.
- Ẩn chức năng chốt kỳ (P1 / P2). P3a: khối Chốt kỳ chỉ hiện khi cờ `CMS_LOCK_ENABLED` (cùng `CMS_PROGRAM_ENABLED` + `CMS_EARNINGS_ENABLED`) bật — xem §P3a.
- P1 ẩn các **kết quả thực tế** (CMS đã kiếm, GMV thực tế, SL bán, tiến độ/lượt/người đạt), không ẩn số cấu hình: số chương trình/SP, target, mốc bậc, mức CMS/đơn vị, quy cách và thống kê import vẫn hiện.

Yêu cầu P2:

- D1/D2 hiển thị số lượng thực tế, số lượng nguyên hưởng CMS và phần đang cộng dồn.
- D3 phân trang 20 dòng, giữ thứ tự ổn định.
- A3 có các tab sản phẩm, dược sĩ và lịch sử import.
- QLCH/SM chỉ nhận tổng và chi tiết trong phạm vi của mình.
- Export sử dụng đúng bộ lọc và `run_id` của màn hình.

Ước tính “Nếu bán thêm” dùng cùng engine. Chỉ ước tính GMV khi có giá tham khảo xác định đúng theo `unit_CMS`; thiếu giá phù hợp thì bỏ phần ước tính cần giá.

**Hiện thực P2-c (I3) [Dev — chờ PM audit]:**

- Cờ: mọi số liệu chỉ khi `CMS_PROGRAM_ENABLED` + `CMS_EARNINGS_ENABLED` (`isCmsEarningsEnabled`); OFF ⇒ loader `lib/cms/server/resultLoad.ts` trả `off` TRƯỚC mọi RPC, view giữ nguyên P1; D3 và `GET /api/export/cms` ⇒ 404 / 403. Đọc bằng session client qua 4 RPC 122 (không service role).
- Nhất quán: header rồi rows **ghim `run_id` của header** (run đổi giữa hai lần gọi ⇒ đọc lại một lần, vẫn đổi ⇒ "dữ liệu đã thay đổi"); D3 ghim `run=` trong URL, 20 dòng / lần theo `seq` của engine (tăng `n` tới 200 trên cùng con trỏ, sau đó chuyển con trỏ `after=`); run trong URL khác run hiện hành ⇒ báo thay đổi, không nối hai phiên. Export chỉ nhận đúng run hiện hành của màn.
- Trình bày (`lib/cms/resultUi.ts`, thuần): chỉ cộng số engine trong snapshot; tổng QLCH / SM / A1 / A3 cộng tiền cá nhân, không áp lại bậc. Bảng chia theo bậc / thanh phân bố bậc chỉ hiện khi tổng lát (cùng hàm bậc engine) khớp tiền / tiềm năng của snapshot — lệch (danh mục đổi sau run) ⇒ ẩn, không tự sửa số. Chưa có snapshot ⇒ `—`; 0₫ chỉ khi run đã công bố và người xem thật sự chưa có CMS.
- U13: snapshot danh mục (`price_snapshot`) không mang đơn vị của giá tham khảo ⇒ chưa xác định được "giá đúng theo `unit_CMS`" ⇒ bản này **không** có câu ước tính GMV / số đơn vị cần bán theo giá (gợi ý gần đạt chỉ nêu GMV còn thiếu + CMS khi đạt từ `potential_amount`).
- U18 / Q-206: dòng `ADJUSTMENT` khi hợp đồng trả hàng chưa chốt ⇒ UI hiện "Chờ xác nhận", tiền `—`; export từ chối (409) thay vì ẩn dòng mà vẫn khớp tổng. Chương trình thật không có snapshot công bố khi cổng Q-206 đóng ⇒ trên prod các ô kết quả hiện `—`.
- XLSX (`lib/cms/exportResults.ts`): sheet Thông tin (run_id, thời điểm công bố / dữ liệu bán, config_version) · Theo sản phẩm · Theo dược sĩ · Chi tiết dòng · Chưa gán (chỉ super, có email người bán nguồn để sửa mapping); đọc đủ mọi trang (trần 50.000 dòng ⇒ 413, không xuất thiếu); trước khi trả kiểm số dòng = Σ `line_count` và Σ tiền dòng = Σ tiền dược sĩ × SP; chuỗi ghi kiểu text, số nguyên ngoài miền an toàn / số lẻ ⇒ ô text.
- Mẫu số Q-212 (A3 "Dược sĩ có CMS x / y"): staff hiện thuộc nhà thuốc OS đang hoạt động trong phạm vi chương trình ∩ phạm vi người xem (SM ∩ nhà thuốc được phân công) — cùng định nghĩa `cms__visible_result_users`; lỗi đọc ⇒ không hiện "/y". Khối tổng QLCH ở D1 ghi "Dược sĩ có CMS" kèm "/ N người có bán" (RPC chỉ trả người có dòng kết quả) — không phải mẫu số Q-212.
- Bộ lọc export: A3 không có bộ lọc dữ liệu (chỉ tab / trang) ⇒ export là **toàn bộ run** trong phạm vi người xem (super: cả chương trình + sheet Chưa gán; SM: nhà thuốc được phân công). Có bộ lọc ở màn sau này thì export phải nhận đúng tham số đó.
- A1: đọc kết quả tối đa 30 chương trình đang chạy / chờ chốt mỗi lượt xem (chương trình thật trước QA); vượt ⇒ cả 3 ô tổng `—` + cảnh báo, không cộng thiếu.
- D3: "Xem thêm" tăng số dòng hiện thêm 20 trên cùng con trỏ (mỗi lần đọc lại ≤ 200 dòng / request); tới 200 thì chuyển sang con trỏ kế (dòng trước không còn trên màn, có "Về đầu danh sách"). Phiên hết hạn: D1 / D2 / D3 chuyển `/login`, export 401 — không có trạng thái UI riêng.
- Dòng `ADJUSTMENT` chỉ có thể có ở chương trình QA khi Q-206 HOLD: tổng D1 / D2 / A1 / A3 vẫn là tiền snapshot (đã gồm điều chỉnh) trong khi dòng đó hiện `—`; export từ chối. Không ảnh hưởng chương trình thật (không công bố được khi HOLD).
- Export ghi một dòng log kiểm toán không PII: `[cms-export] OK user=<uuid> program=<uuid> run=<uuid> scope=super|sm lines=N excluded=N`. Chưa giới hạn tần suất (mỗi lượt ≤ ~100 RPC đọc tuần tự) — theo dõi ở I4 nếu cần.

UI dùng `data-ui-v2="page"`, khai báo width, component DS, touch target 44px và input mobile 16px.

Mở rộng tab CMS độc lập với cờ Affiliate (hiện `CampaignsTabs` trả `null` khi tắt Affiliate — phải tách). Khi chọn CMS (`/targets?tab=cms`), rẽ nhánh trước mọi query KPI cũ. Khi cờ CMS OFF, hành vi KPI cũ được giữ (bỏ qua `tab=cms`).

Fixture dùng component thật, có boundary chặn action/export và trap request ghi (**[r1 §9]** route `/ui-catalog/cms-v2?fx=`, theo cơ chế `KpiFixtureBoundary` + `e2e/fixtureGuard.ts`).

Sửa thông tin chương trình: `/targets/campaigns/cms/[id]/edit` (**[Dev đề xuất]**, theo §4.7 và UI U17).

### 8.2. Ảnh sản phẩm **[PM §2]**

- Dùng **Next Image**, thêm `remotePatterns` HTTPS đúng host `cdn-gcs.thuocsi.vn`, pathname `/thuocsi-live/images/**` (mọi URL ảnh trong mẫu BigQuery đều thuộc prefix này).
- URL khác host/prefix chưa được xác nhận ⇒ hiển thị ảnh dự phòng (ô chữ cái đầu) và báo operator kiểm nguồn (cảnh báo import); không mở wildcard host, không chuyển sang `<img>` để né allowlist.
- Ghi chú hiện trạng (Dev đọc 01/11): app chưa có component nào dùng `next/image`; CRM hiện render ảnh cùng CDN bằng `<img>` + allow-list prefix `careSafeImageUrl` (`lib/care/browse.ts`). CMS là nơi đầu tiên dùng Next Image theo quyết định PM; ảnh đi qua Image Optimizer của server Next (server tải ảnh từ CDN).

## 9. Flags, env và cron

| Flag | Vai trò |
|---|---|
| `CMS_PROGRAM_ENABLED` | Chương trình, danh mục, import, đọc tư vấn và Product Master cron |
| `CMS_EARNINGS_ENABLED` | Sync/tính và hiển thị số CMS thực tế |
| `CMS_LOCK_ENABLED` | Chốt và chi trả (P3a); chỉ hiệu lực khi CẢ `CMS_PROGRAM_ENABLED` + `CMS_EARNINGS_ENABLED` bật; giữ OFF đến khi phát hành P3a được duyệt |

Mặc định tất cả OFF (`lib/cms/flags.ts`, server-only, khai báo trong `webapp/.env.example`). Cờ OFF ⇒ cron/route không query nguồn.

Env nguồn: `CMS_BQ_PRODUCTS_TABLE`, `CMS_BQ_SALES_TABLE` (`project.dataset.table`, validate; trống ⇒ cron báo cấu hình thiếu, không query).

Fixture/catalog không phụ thuộc bật cờ production. JSON mẫu không trở thành fallback production.

Lịch đề xuất (VN → UTC trong Coolify, Coolify hiểu expression theo UTC):

| Cron | VN | UTC (Coolify) | Khi tạo |
|---|---|---|---|
| `/api/cron/pull-cms-products` | 05:30 hằng ngày | `30 22 * * *` | Rollout P1 |
| `/api/cron/sync-cms-sales` | 06:00 → 22:00 mỗi 2 giờ | `0 23,1,3,5,7,9,11,13,15 * * *` | Chỉ khi rollout P2 |

Các cron dùng `Bearer CRON_SECRET`.

**Bootstrap trước khi bật cờ [PM PR-0]:** P1-a bổ sung script operator-only `scripts/cms-bootstrap-products.mjs`, dùng cùng contract, core đồng bộ, validation và RPC upsert với cron. Mặc định dry-run; chỉ ghi khi operator gọi rõ `--confirm`. Script kiểm target cấu hình, không in key/email/dữ liệu nguồn thô và không đổi cờ môi trường. Đây là thao tác bootstrap được operator vận hành tại rollout, không phải endpoint công khai hoặc tham số bypass cờ cho cron. Public cron khi cờ OFF vẫn trả sớm, không query nguồn. Test dry-run không ghi, cron OFF không query, xác nhận ghi dùng đúng core/RPC. Đồng bộ lần đầu không thể gọi public cron đang OFF.

Theo dõi: lần thành công cuối theo chương trình; thời gian, số dòng và chi phí query; dòng chưa gán/chưa quy đổi; run held/error hoặc không công bố được do revision đổi; chênh lệch tổng dòng với kết quả; độ trễ nguồn.

## P3a — Chốt kỳ và chi trả (migration 123; local, cờ OFF)

Nguồn: blueprint `planning/research/cms-i5-p3-blueprint.md` r3 + §7 r3.2; work order P3a 03/11. Chốt **thật** chưa mở (Q-206 / Q-213 / Q-216 / hợp đồng nguồn đầy đủ / P3b).

- **Đóng băng run, không sao chép dòng.** Chốt ghi `cms_payouts` + `cms_payout_staff` từ run hiện hành; DB cấm mọi thay đổi run đã chốt, cấu hình chương trình đã chốt, payout (UPDATE / DELETE / TRUNCATE); trạng thái `locked` không mở lại (H8).
- **Preview → xác nhận.** Super xem preview (`rpc_cms_lock_preview`): run, tổng, dược sĩ có tiền / có kết quả, dòng chưa gán so ngưỡng, quy tắc, blocker. Xác nhận gửi `expected_run_id` + `policy_version` (+ lý do 10–1.000 ký tự khi còn dòng chưa gán dưới ngưỡng). Server kiểm cờ + super từ session + namespace QA; actor lấy từ session. RPC chốt kiểm lại toàn bộ trong một transaction; run / policy / mapping đổi ⇒ báo xem lại. Mất phản hồi ⇒ "chưa xác định" (tải lại để xem trạng thái thật); gọi lại cùng run là idempotent.
- **Policy ở DB** (`cms__lock_policy` + version): nhánh thật `ready = false` (pending Q-206 / Q-213 / Q-216 / nguồn đầy đủ / P3b) ⇒ `CMS_LOCK_POLICY_PENDING`; nhánh QA là giả định có nhãn `QA_ONLY_ASSUMPTION` (2 % GMV / 20 dòng, chờ 0 giờ) — không phải mặc định chi trả thật.
- **Chỉ đường RPC được ghi.** Cấu hình chương trình, dữ liệu run và payout chỉ ghi được khi người ghi là owner bảng (RPC SECDEF 121 / 122 / 123); `service_role` / role quản trị ghi trực tiếp ⇒ `CMS_CONFIG_RPC_ONLY` / `CMS_RUN_RPC_ONLY` / `CMS_PAYOUT_RPC_ONLY`. Owner / superuser (chạy migration) là ranh giới tin cậy. Ghi dữ liệu run / TRUNCATE yêu cầu READ COMMITTED.
- **Đọc số đã chốt** (`rpc_cms_payout`, session): phạm vi **hiện tại** (Q-208, Q-217): super mọi dòng + tổng toàn chương trình + email; SM / QLCH chỉ staff hiện thuộc phạm vi, chỉ tổng trong phạm vi, không email; staff chỉ dòng của mình; ra ngoài chương trình ⇒ không đọc. Định danh trong số chốt là ảnh chụp lúc chốt.
- **XLSX chi trả** `GET /api/export/cms/payout?program=[&run=]`: super + SM, cùng run đã chốt, đủ dòng (kể cả 0 đ), Σ = tổng trả về; email chỉ super; nhãn phạm vi cho SM; chương trình QA ghi "không chi trả"; chưa chốt ⇒ 409. Không phải lệnh chuyển tiền.
- **A3:** khối "Chốt kỳ" (super, chương trình active đã hết kỳ) và "Số đã chốt" (super + SM, chương trình locked); A3 của chương trình đã chốt đọc kết quả của run đóng băng (run hiện hành, RPC 122). Hộp xác nhận: checkbox "Tôi đã kiểm tra số liệu" bắt buộc (UI_V2_CMS §3.4). Server Action lỗi / mất phản hồi ⇒ "chưa xác định" + làm mới, nút khoá tới khi kiểm tra lại (không tự gửi lại); `revalidatePath` lỗi sau commit không đổi kết quả đã chốt. A1: SM có lọc Đã chốt (Q-219).
- **Server QA chỉ đọc (PM r1 PKG-P1-2):** launcher `scripts/cms-qa-run.mjs` luôn đặt `CMS_QA_SERVER=1` cho server QA ⇒ `lockCmsProgram` trả `QA_SERVER_READONLY` **trước RPC** (preview / số đã chốt / XLSX vẫn chạy); chốt QA chỉ qua `cms-qa-results.mjs lock` (gate + sổ ý định). App thật không đặt biến này.
- **Dược sĩ / QLCH (D1 / D2 / D3) — lối đọc sau hết kỳ / đã chốt (P3a r2, PM r1 PKG-P1-1; blueprint §3):** loader đọc chương trình `active` (mọi ngày) + `locked` qua RLS phiên (không nới vai / RLS): D1 bộ chọn có nhóm "Đã kết thúc"; D2 deep link mở được (RLS kiểm nhà thuốc hiện tại, QA marker, FS bị chuyển module); D3 gồm chương trình đã chốt. Số của chương trình đã chốt = kết quả run đóng băng (RPC 122 — cùng phạm vi hiện tại Q-208 / Q-217; Σ từng dược sĩ = payout, V5); nhãn "Đã chốt kỳ", không gợi ý gần đạt / "Nếu bán thêm". Chuyển ra ngoài chương trình ⇒ không đọc (Q-217). Quyền **đọc** (DB) tách khỏi **lối vào** (UI); định danh snapshot chỉ ở số đã chốt A3 / XLSX.
- **Tắt cờ `CMS_LOCK_ENABLED`** (R-flag): ẩn khối Chốt kỳ / Số đã chốt trên A3 và XLSX chi trả trả 403; dữ liệu payout giữ nguyên ở DB. `rpc_cms_payout` vẫn là RPC `authenticated` (phạm vi do DB lọc) — cờ là lớp app, không phải lớp DB.
