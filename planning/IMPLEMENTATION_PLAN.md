# IMPLEMENTATION_PLAN — CRM-CSKH (Dev r1.3.1)

> **r1.3.1 (07/10/2026, Dev) — dọn theo phụ lục PM audit r1.3** (`reviews/2026-10-07-crm-plan-r1.3.md`, mục "Kiểm tra plan Dev sau cập nhật Q-65–68"):
> - §4 `care_orders` theo N3 r3.2 (sáu cột, `pos_code`; bỏ `is_valid_order`/`is_deleted`/`order_status`/`store_code`/`channel`).
> - §3, §9 B2, §10.1, §12 T-07/T-09: bỏ dependency file thật/MB trước B2 (Q-63). §9 B5: bỏ tombstone/mapping trạng thái hợp lệ (Q-66–68).
> - §11 viết lại chỉ còn N3 r3.2; xoá yêu cầu 11 cột cũ.
> - §8 thay recipe Bash bằng loader `e2e/envLocal.ts` (đã làm trong B0).
> - Thêm cho gate B1: §2.8 biên `first_overdue_on` khi hẹn ngày cuối tháng (redline P1 trước B1); §5 làm rõ lịch sử sau chuyển giao (P2 B1/B3).
> - B0 đã build theo `SPEC.md` §B0 — report `reports/2026-10-07-crm-b0.md`.
>
> r1.3 (trước đó) — PM đã duyệt làm khung GĐ1 + GO B0; B1–B6 chờ SPEC từng batch.
> Sửa theo audit `reviews/2026-10-07-crm-plan-r1.2.md`:
> - P0: chặn khách vào đúng store đã từ chối.
> - P1-1: attribution theo interaction.
> - P1-2: Quá hạn lịch sử theo Q-62.
> - P1-3: diff trước upsert, snapshot khách theo task.
> - P1-4: biên quyền lịch sử + báo cáo không đọc `care_orders`.
> - P1-5: đối soát khách vừa Hoàn thành.
> - P2: contract v3, `/tasks` không count dưới RLS, nạp env Playwright, cap upload.
>
> Bảng truy vết sửa đổi → AC/test ở §13.
> Nguồn: CONTRACT v1.12, DECISIONS Q-03…Q-68, `research/crm-cskh-data-contract-v3.md` r3.2, `SPEC.md` (B0 đã duyệt).
> Ký hiệu: **[CHỐT]** = DECISIONS/CONTRACT/handoff PM. **[MĐ Q-xx]** = mặc định Dev, để ở config, comment `// TODO(Q-xx)`.

---

## 1. Phạm vi GĐ1
**Hai đầu vào duy nhất [CHỐT Q-61]:**
1. **Excel Marketing** (1 sheet `KhachHang`, 10 cột, 25 store OS): tạo khách, task và sản phẩm. Nhiều dòng sản phẩm cùng khách → **1 task khách/tháng**.
2. **Bảng/view BigQuery đơn hàng** (1 dòng/đơn): chỉ để đối chiếu **đơn phát sinh sau lượt Hoàn thành**.

**Làm:**
- Import và phân công.
- Dược sĩ xem khách, lý do, sản phẩm (Excel) và ghi lượt append-only (ảnh proof tuỳ chọn, bucket public — Q-53).
- SM và super chuyển giao kèm note; QLCH chỉ xem.
- Đóng kỳ.
- Đối chiếu đơn, báo cáo theo tháng chăm sóc, xuất Excel.

**Không làm:** lịch sử đơn cũ (Q-57), gợi ý, chia tự động, Cài đặt, gộp Toa, thông báo chủ động cho staff, gỡ từ chối (DNC).

## 2. Luồng nghiệp vụ

### 2.1 Vòng đời task (`care_tasks.status`)
```
 import commit ──▶ open ──(lượt có outcome kết thúc)──▶ completed          (chỉ đọc — Q-52)
                    │
                    └──(hết tháng VN)──▶ closed_unfinished  ("Không hoàn thành trong kỳ" — Q-58)
```
- Unique `(customer_id, period_month)`; partial unique `(customer_id) WHERE status='open'`.
- Mọi thao tác ghi đều kiểm task `open` + `period_month` = tháng VN hiện tại.
- Vì task completed chỉ đọc, **mỗi task có tối đa 1 lượt kết thúc**.

### 2.2 Outcome
| Code | Nhãn | Bắt buộc thêm | Kết thúc task? |
|---|---|---|---|
| `UNREACHABLE` | Không liên hệ được | `next_action_date` trong tháng task | Không [MĐ Q-02/03] |
| `NO_NEED` | Đã liên hệ – chưa có nhu cầu | — | Có [MĐ Q-02/03] |
| `INTERESTED` | Khách quan tâm | — | Có [CHỐT Q-03] |
| `CALLBACK` | Hẹn chăm sóc lại | `next_action_date` trong tháng task [CHỐT Q-48] | Không [CHỐT Q-03] |
| `ORDERED` | Đã đặt đơn | — | Có (chỉ là khai báo; chuyển đổi tính từ BQ) [MĐ] |
| `REFUSED` | Từ chối chăm sóc | — | Có + ghi từ chối `(customer, store của task)` [CHỐT Q-54] |

- Tập outcome kết thúc = `{NO_NEED, INTERESTED, ORDERED, REFUSED}`. Khai báo **1 chỗ**: SQL `care_is_terminal_outcome(text)` IMMUTABLE + TS `lib/care/outcome.ts`; spec ép 2 nơi khớp nhau.
- Note bắt buộc 1–500 ký tự. Proof không ảnh hưởng trạng thái.

### 2.3 Từ chối liên hệ theo store [CHỐT Q-54 — sửa P0]
- `REFUSED` → ghi `care_store_refusals(customer_id, store_id)` bằng store của task tại lượt đó.
- **Chặn trên server:**
  - **Preview import:** nhóm khách có `target_store_code` = store đã từ chối → **lỗi**, nêu số dòng, nút commit bị khoá.
  - **`care_import_finalize`:** kiểm lại; còn vi phạm thì huỷ cả batch.
  - **`care_transfer_tasks`:** store đích đã có từ chối → lỗi. Chuyển sang store khác vẫn được nếu SM có quyền cả 2 store.
  - Store khác (Y) vẫn import và chuyển giao được bình thường.
- GĐ1 không có luồng gỡ từ chối; nếu vận hành cần ngoại lệ thì hỏi stakeholder trước.

### 2.4 Nhãn & chỉ số
| Chỉ số | Định nghĩa | Dữ liệu |
|---|---|---|
| **Quá hạn — nhãn live** (danh sách hiện tại, Q-58) | Task `open`, `next_action_date` < hôm nay (VN), chưa có lượt mới sau khi đặt hẹn | Suy từ `care_tasks.next_action_date` (xoá về NULL khi ghi lượt kết thúc hoặc lượt mới không hẹn) |
| **Quá hạn — báo cáo kỳ** (Q-62) | Task **từng** trễ hẹn trong kỳ, kể cả sau đó Hoàn thành hoặc đóng kỳ. Mỗi task đếm 1 lần | `care_tasks.first_overdue_on` (date, ghi 1 lần, không bao giờ xoá) — §2.8 |
| **Không hoàn thành trong kỳ** | `status='closed_unfinished'` | Có thể giao với Quá hạn |
| **Đơn sau chăm sóc** | Task có ≥1 attribution | `care_order_attributions` |

### 2.5 Import tháng mới — thứ tự xử lý [sửa P1-3]
1. **Parse + validate dòng:** đủ 10 cột, text, SĐT, URL host `cdn-gcs.thuocsi.vn`.
2. **Gom theo `customer_external_id`:** kiểm nhất quán tên/SĐT/store/email; trùng `(customer, product_id)` → lỗi.
3. **Map:** store OS active, email → `staff` của đúng store.
4. **Kiểm từ chối theo store** (§2.3).
5. **Diff** với dữ liệu kỳ đó (nếu là bản sửa, §2.6).
6. Preview → commit (0 lỗi) → staging → `care_import_finalize`. Trong **1 transaction**, finalize chạy lại bước 4–5 trên DB rồi mới ghi:
   - Đóng kỳ các task `open` tháng trước (§2.8).
   - `care_customers`: chỉ **insert khách mới** (định danh). Không cập nhật tên/SĐT của khách cũ trên bảng này.
   - `care_tasks`: tạo task **kèm snapshot `customer_name`, `phone_norm`, `phone_raw`** của kỳ. UI luôn hiển thị snapshot của task, nên tháng cũ giữ nguyên tên/SĐT cũ.
   - `care_task_products`, `care_assignment_events(assigned)`.

   Nạp lại cùng hash: không tạo gì thêm.

### 2.6 Nạp file sửa cùng tháng [CHỐT Q-50]
Diff theo khách, tính **trước mọi ghi**:

| Loại | Áp dụng? |
|---|---|
| Khách mới trong kỳ | Có → tạo task |
| Không đổi | Bỏ qua |
| Đổi sản phẩm/lý do, task **chưa có lượt** | Có → thay snapshot sản phẩm (bản cũ `is_current=false`) |
| Đổi tên/SĐT, task **chưa có lượt** | Có → cập nhật snapshot của **task kỳ này** |
| Đổi bất kỳ trường nào, task **đã có lượt** | Không, liệt kê trong diff |
| Đổi store/dược sĩ | Không, gợi ý dùng Chuyển giao |
| Khách vắng ở file sửa | Không đụng, liệt kê trong diff |

Policy nằm ở `lib/care/import/diffPolicy.ts` và được kiểm lại trong finalize. Kỳ cũ không bao giờ bị revision chạm.

### 2.7 Chuyển giao
- SM hoặc super chọn 1..n task `open`, dược sĩ đích, note bắt buộc.
- RPC kiểm: SM quản lý store nguồn **và** đích; đích là `staff` của store OS active; **store đích chưa có từ chối** (§2.3).
- Khoá `FOR UPDATE`, đổi `store_id` + `assignee_id` trên task, ghi `care_assignment_events(transferred)`.

### 2.8 Đóng kỳ & đánh dấu trễ hẹn [sửa P1-2]
- `first_overdue_on` = `next_action_date + 1` được ghi **1 lần** (`COALESCE`) ở 3 chỗ:
  1. `care_record_interaction`: trước khi ghi lượt mới, nếu `next_action_date` hiện có < hôm nay.
  2. Cron `care-period-close` hằng ngày lúc 00:05 VN: quét task `open` có `next_action_date` < hôm nay.
  3. Đóng kỳ: trước khi chuyển `closed_unfinished`.
- **Biên cuối kỳ [redline PM r1.3, P1 trước B1]:** chỉ ghi mốc khi ngày bắt đầu trễ **còn thuộc kỳ**, tức `next_action_date + 1 <= ngày cuối period_month` (⇔ `next_action_date < ngày cuối kỳ`). Hẹn đúng **ngày cuối tháng** mà không gọi ⇒ không bao giờ có mốc trễ; hôm sau task chỉ `closed_unfinished`. Điều kiện nằm trong **một** helper SQL dùng chung cho cả 3 chỗ (không lặp điều kiện), TS mirror ở `lib/care/time.ts` cho parity test.
  - AC: hẹn 30/10 không gọi → mốc 31/10, Quá hạn kỳ T10 = 1. Hẹn 31/10 không gọi → đóng kỳ 01/11, Quá hạn kỳ T10 = 0, Không hoàn thành = 1. Import kỳ T11 chạy đóng kỳ **trước** cron 00:05 → kết quả như trên (không ghi mốc 01/11 cho task T10).
- Đóng kỳ: `UPDATE … SET status='closed_unfinished', closed_at=now() WHERE status='open' AND period_month < tháng_VN` (idempotent). Commit import kỳ mới cũng chạy bước này trước.
- Nhiều lần trễ trong kỳ vẫn chỉ 1 mốc, nên đếm 1 lần.

### 2.9 Đối chiếu đơn & attribution [sửa P1-1, P1-5]
**Lượt Hoàn thành** = `care_interactions` có `care_is_terminal_outcome(outcome)`. Mỗi lượt **chụp `assignee_id` + `store_id` của task tại thời điểm ghi**.

**Attribution** (`care_recompute_attribution(customer_ids)`, hàm thuần của (lượt, đơn), tính lại không đổi kết quả):
```
với mỗi đơn o của khách (mọi đơn trong bảng N3 — Q-65…68: huỷ/hoàn vẫn là 1 chuyển đổi)
  lượt i = lượt Hoàn thành của cùng khách, i.created_at < o.ordered_at   (strict <)
           ORDER BY i.created_at DESC, i.id DESC LIMIT 1
  nếu có i → attribution(order_key PK, interaction_id=i.id, task_id, assignee_id=i.assignee_id,
                         store_id=i.store_id, period_month=task(i).period_month, net_amount=o.order_net_amount)
  huỷ/hoàn → giữ attribution, cập nhật net_amount (về 0 nếu hoàn hết); đơn bị xoá khỏi nguồn → xử lý thủ công (GĐ1 không có tombstone)
```
Báo cáo theo `period_month` của lượt (Q-59). Không phụ thuộc chủ task hiện tại.

**Đồng bộ (cron `care-orders-sync`, nhịp theo SLA BI, tối thiểu hằng ngày) — 2 luồng.** Nguồn = N3 r3.2 (§11): mọi dòng là đơn **đã đặt**; không lọc trạng thái hợp lệ, không tombstone (Q-66–68).
1. **Incremental:** cursor `(source_updated_at, order_key)` lùi 48h, lọc theo tập khách **đã đủ điều kiện ở lần sync trước**. Cursor theo `source_updated_at` nên đơn đổi tiền sau bất kỳ bao lâu vẫn được lấy **nếu** BI cập nhật cột này khi tiền đổi — điều kiện phải xác nhận trước B5 (redline P1 trước B5). Nếu BI không có `source_updated_at` hoặc có thể backdate ⇒ thay luồng 1 bằng đối soát toàn bộ đơn của tập khách đủ điều kiện từ mốc Hoàn thành sớm nhất còn hiệu lực báo cáo; chọn phương án trong SPEC B5.
2. **Đối soát khách mới đủ điều kiện (sửa P1-5):**
   - Mỗi lượt Hoàn thành ghi `care_reconcile_queue(customer_id, from_ts = interaction.created_at)` (cùng transaction với lượt).
   - Mỗi lần sync: lấy các khách trong queue, query `WHERE customer_external_id IN UNNEST(@ids) AND ordered_at >= @from_ts_min_of_batch` (**không** dùng cursor), upsert, rồi xoá khỏi queue sau khi thành công.
   - Nhờ đó đơn có `source_updated_at` cũ hơn cursor vẫn được lấy. Đây không phải backfill 3 tháng: chỉ lấy đơn từ thời điểm Hoàn thành.
3. Upsert `care_orders` (giữ bản có `source_updated_at` lớn nhất) → recompute cho các khách bị ảnh hưởng → cập nhật `care_sync_state`.
4. **Lỗi thì giữ snapshot**, queue còn nguyên để lần sau chạy lại. UI hiện "dữ liệu đơn đến …", không hiện số 0.
5. Một đối soát định kỳ (vd chủ nhật) chạy lại luồng 2 cho mọi khách có lượt Hoàn thành trong 35 ngày, làm lưới an toàn cho đơn về muộn.

## 3. Kiến trúc
```
 Excel ──POST multipart──▶ /api/care/import/{preview,commit}  (Route Handler: quyền + cap byte)
                              │ lib/care/import/* (thuần) → staging khối 2.000 → RPC care_import_finalize (1 txn)
 Postgres care_* (RLS chỉ SELECT) ◀── RPC SECDEF: record / transfer / close / orders / report / summary
 Server Components (session→RLS) · Server Actions (session→RPC) · Cron Coolify: care-period-close, care-orders-sync → BigQuery
 Web /care/* · Mobile /care/* · CTA trên /tasks · export /api/export/care
```
- **Upload [P2-4]:**
  - Thiếu `Content-Length` → 411.
  - Header > `CARE_IMPORT_MAX_BYTES` (8MB) → 413.
  - Đọc body dạng stream có đếm byte, vượt cap thì huỷ ngay (413).
  - Byte nhận được ≠ header (bị proxy cắt) → 400 "file không trọn vẹn".
  - B2 kiểm cap bằng fixture giả (`e2e/careImportFixture.ts`, nhân số khách để vượt cap). Không đợi file thật (Q-63). Chỉ sửa matcher `proxy.ts` nếu QA file thật trước bật cờ (B6) cho thấy vượt cap.
- File Excel không lưu storage. Staging bị xoá sau finalize.
- `lib/bigquery/{query,client}.ts` (**đã có ở B0**): phân trang `pageToken`, tham số NAMED (gồm mảng), poll job chưa xong, hạn tổng + timeout từng request, all-or-nothing (`BigQueryError`). Không sửa `lib/targets/bigquery.ts`. Caller B5 chỉ log `kind`/`status`, không đưa `err.message` ra response/log/Teams (security B0 P2).

## 4. Data model (migration 114; tên cuối cùng theo SPEC PM)
| Bảng | Cột chính | Ràng buộc / index |
|---|---|---|
| `care_access` | `department_id PK`, `can_import`, `can_view_all`, `granted_by`, `created_at` | Seed Marketing `80cb84b5…` sau preflight |
| `care_import_batches` | `id`, `period_month`, `file_name`, `file_sha256`, `kind`, `status`, `row_count`, `customer_count`, `store_count`, `summary jsonb` (không PII), `created_by`, `is_test` | unique `(period_month, file_sha256)` WHERE committed |
| `care_import_staging` | `batch_id`, `row_no`, `payload jsonb` | Xoá sau finalize/fail |
| `care_customers` | `id`, `external_id UNIQUE`, `created_at` | Chỉ định danh; tên/SĐT nằm ở snapshot task |
| `care_tasks` | `id`, `customer_id`, `period_month`, `batch_id`, `store_id`, `assignee_id`, **`customer_name`, `phone_norm`, `phone_raw`**, `status`, `due_date`, `last_outcome`, `last_interaction_at`, `next_action_date`, **`first_overdue_on`**, `completed_at`, `closed_at`, `is_test` | unique `(customer_id, period_month)`; partial unique open; index `(assignee_id, status)`, `(store_id, period_month)`, `(customer_id, period_month desc)` |
| `care_task_products` | `task_id`, `batch_id`, `product_id`, `product_name`, `image_url`, `reason_type`, `reason_text`, `is_current` | unique `(task_id, product_id) WHERE is_current` |
| `care_interactions` | `id`, `task_id`, `customer_id`, `actor_id`, **`assignee_id`, `store_id`** (chụp), `outcome`, `note`, `next_action_date`, `proof jsonb`, `created_at` | Append-only; index `(customer_id, created_at desc, id desc)` WHERE terminal |
| `care_assignment_events` | `task_id`, `kind`, `from/to store/user`, `note`, `actor_id`, `batch_id`, `created_at` | Append-only |
| `care_store_refusals` | `customer_id`, `store_id`, `interaction_id`, `created_at` | unique `(customer_id, store_id)`; **dùng để chặn** |
| `care_reconcile_queue` | `customer_id PK`, `from_ts`, `enqueued_at` | `from_ts` = MIN khi gộp |
| `care_orders` | `order_key PK`, `customer_external_id`, `ordered_at`, `source_updated_at`, `net_amount` (= `order_net_amount`), `pos_code NULL` (store bán; NULL = online), `synced_at` | Theo N3 r3.2 (§11). Mỗi dòng = đơn **đã đặt**, kể cả huỷ/hoàn sau đó (Q-66/67). Không có `is_valid_order`/`is_deleted`/tombstone (Q-68). `pos_code` chỉ để đối soát, **không** quyết định ghi công. Chỉ care admin/super đọc |
| `care_order_attributions` | `order_key PK`, `interaction_id`, `task_id`, `assignee_id`, `store_id`, `period_month`, `net_amount`, `computed_at` | Báo cáo chỉ đọc bảng này, không đọc `care_orders` |
| `care_sync_state` | `source PK`, `cursor_ts`, `cursor_key`, `last_success_at`, `bi_complete_through`, `last_error` | |

## 5. Phân quyền [sửa P1-4]
**Đồ thị tham chiếu** (không policy nào đọc trực tiếp bảng RLS khác):
```
care_tasks ─ cột + helper: is_super_admin(), care_is_admin(), get_user_role(), get_user_store_id(), is_sm_for_store()
care_task_products, care_assignment_events ─ care_can_read_task(task_id)                      [SECDEF STABLE]
care_interactions ─ care_can_read_task(task_id) OR care_can_read_customer_history(customer_id)  [SECDEF]
care_order_attributions ─ care_can_read_task(task_id)
care_customers, care_store_refusals ─ care_can_read_customer_history(customer_id)
care_orders, care_import_*, care_access, care_sync_state, care_reconcile_queue ─ care_is_admin() OR is_super_admin()
```
| Vai trò | `care_can_read_task` | `care_can_read_customer_history` (đọc lịch sử lượt mọi kỳ của khách) |
|---|---|---|
| staff | `assignee_id = uid` (mọi kỳ: task của chính mình) | Khách có task **kỳ hiện tại** giao cho mình. Nhờ vậy dược sĩ mới thấy lịch sử sau chuyển giao hoặc qua kỳ, không mở cả chuỗi |
| store_manager | `store_id` = store mình | Khách có task kỳ hiện tại thuộc store mình |
| sm | `is_sm_for_store(store_id)` | Khách có task kỳ hiện tại trong store SM quản lý |
| care admin / super | Tất cả | Tất cả |

- **Sau chuyển giao A→B [làm rõ P2 audit r1.3]:**
  - A mất quyền đọc **task được chuyển** (task kỳ hiện tại, giờ `assignee_id = B`) và mọi lượt/sản phẩm/sự kiện của task đó.
  - A vẫn đọc được **các task kỳ trước mà chính A là assignee** (`care_can_read_task`: `assignee_id = uid`), kèm lượt của chính task đó.
  - A **không** còn đọc lịch sử lượt các kỳ khác của khách qua `care_can_read_customer_history`, vì khách không còn task kỳ hiện tại giao cho A. Không mở PII cả chuỗi.
  - Test RLS B1: chuyển giao trong cùng kỳ và qua kỳ, gồm task kỳ cũ của A.
- **Báo cáo:** `care_report(p_month, p_store_ids)` và `care_my_summary()` là **SECURITY DEFINER**, tự tính scope từ `auth.uid()` theo đúng bảng trên. Chỉ đọc `care_tasks` + `care_order_attributions` (đã có `net_amount`), **không đọc `care_orders`**. Có test đối chiếu kết quả với truy vấn qua session client của từng role.
- Chỉ số task (được giao, hoàn thành, quá hạn kỳ, không hoàn thành) tính theo **chủ hiện tại** của task. Chỉ số đơn tính theo **chủ tại lượt Hoàn thành** (attribution).

**RPC.** Mỗi function: REVOKE đích danh, rồi GRANT đúng role, verify bằng `has_function_privilege`.

| RPC | Role | |
|---|---|---|
| `care_import_finalize(batch_id, actor)` | service_role | §2.5/2.6, chặn từ chối |
| `care_record_interaction(task_id, outcome, note, next_action_date, proof)` | authenticated | assignee = uid, open, đúng kỳ, ngày trong tháng; ghi chụp assignee/store, `first_overdue_on`, refusal, reconcile queue; `FOR UPDATE` |
| `care_transfer_tasks(task_ids[], to_user, note)` | authenticated | scope SM/super, chặn store đích có từ chối |
| `care_close_period(p_month)`, `care_stamp_overdue()` | service_role | |
| `care_upsert_orders(rows)`, `care_recompute_attribution(ids)` | service_role | |
| `care_report(...)`, `care_my_summary()` | authenticated (DEFINER, scope trong hàm) | |

## 6. Backend (file dự kiến)
- `lib/care/{config,flags,access,time,outcome,labels,metrics,attribution}.ts`
- `lib/care/import/{parse,group,validate,diff,diffPolicy}.ts`
- `lib/care/server/{queries,importService,ordersSync}.ts`, `lib/bigquery/{query,client}.ts` (B0 ✅)
- `app/api/care/import/{preview,commit}/route.ts`, `app/actions/care.ts` (record, transfer)
- `app/api/cron/{care-period-close,care-orders-sync}/route.ts` (bearer + cờ `CARE_SYNC_ENABLED`)
- `app/api/export/care/route.ts`; `app/actions/uploads.ts` thêm purpose `care_proof`

## 7. Frontend (load skill `circa-ui` trước `.tsx`)
| Route | Ai | Nội dung |
|---|---|---|
| `/care` | admin/SM/QLCH/super → **Khách hàng**; staff → **CSKH của tôi** | Web: thẻ tổng + chart theo store + donut outcome, filter tháng/store. Staff: 4 thẻ (Được giao / Chưa chăm sóc / Hoàn thành / Quá hạn) từ `care_my_summary()`, "Việc hôm nay", danh sách phân trang |
| `/care/assign` | care admin, super | Wizard Tải file → Kiểm tra (store/dược sĩ, lỗi, từ chối, diff) → Xác nhận → Kết quả; lịch sử import |
| `/care/assign/transfer` | SM, super | Chuyển giao + note |
| `/care/tasks` | web | `DataTableShell`, filter 3 trục, tìm, phân trang server |
| `/care/tasks/[id]` | theo RLS | Mobile 3 tab: Tổng quan (snapshot khách, dược sĩ, store, hạn, lý do, nhãn đơn) · Sản phẩm (ảnh/tên/lý do Excel, chạm xem lớn) · Lịch sử (lượt + chuyển giao, mọi kỳ theo §5) |
| `/care/tasks/[id]/update` | assignee | 6 outcome + note + ngày hẹn trong tháng + ảnh tuỳ chọn |
| `/care/reports` | web | Theo tháng chăm sóc: Hoàn thành, Quá hạn kỳ, Không hoàn thành, chuyển đổi, doanh thu, "dữ liệu đơn đến …", xuất Excel |

- **Entry trên `/tasks` [sửa P2-2]:** `/tasks` staff cố ý bỏ exact count (aggregate dưới RLS tốn kém), nên CTA **không count dưới RLS**.
  - Mặc định: **CTA tĩnh** "Chăm sóc khách hàng →", chỉ hiện khi cờ bật.
  - Số "X chưa chăm sóc · Y quá hạn" chỉ thêm khi `care_my_summary()` (DEFINER, index `(assignee_id, status)`) đo được ≤ 20ms p95 trên dữ liệu QA. Gọi song song với query tasks, không chặn render (Suspense).
  - B4 ghi số đo trước/sau vào report.
- Tab CSKH thay Tồn kho trên `BottomNav` (Q-26). Sidebar có mục cha "Chăm sóc KH" + 4 mục con (cập nhật `sidebarNav` + spec).
- **Hiệu năng:**
  - Danh sách không tải ảnh; ảnh chỉ tải khi mở tab Sản phẩm (`loading="lazy"`, khung cố định); chạm xem lớn bằng dialog có sẵn.
  - Không thêm thư viện; phân trang 20–30 dòng; trang staff gọi `redirectIfFsStaff`.

## 8. Setup (B0 — đã build, chờ PM audit; report `reports/2026-10-07-crm-b0.md`)
| Hạng mục | Việc |
|---|---|
| Cờ / env | `CARE_ENABLED`, `CARE_SYNC_ENABLED` (OFF), `CARE_BQ_ORDERS_TABLE` (trống tới B5), `CARE_IMPORT_MAX_BYTES` (8MB, khoảng 64KB–10MB) → `.env.example`; đọc thuần ở `lib/care/config.ts`, wrapper server-only `lib/care/flags.ts` |
| **Nạp tài khoản test [P2-3, redline P1 B0]** | `playwright.config.ts` không đọc `.env.local` và **không dùng recipe Bash `set -a`** cho spec CRM. `e2e/envLocal.ts` parse `.env.local` ngay trong tiến trình Playwright (không expand `$`, không cắt `#`, không ghi `process.env`, không log), ưu tiên biến process. Chạy thẳng trên PowerShell. `e2e/care-qa-preflight.spec.ts`: đăng nhập anon, kiểm `role='admin'` + `department_id` Marketing + không thuộc allowlist super; thiếu biến ⇒ skip nêu **tên** biến. B2+ thêm `storageState` Marketing vào `auth.setup.ts` qua cùng loader |
| Test | `e2e/care-b0.spec.ts` (thuần: thời gian, outcome, cờ, BQ mock, fixture, loader, gate); `care-migration-114-source.spec.ts` + PGlite `scripts/qa-care-114.mjs` (B1); fixture `e2e/careImportFixture.ts` + CLI `scripts/gen-care-import-fixture.mjs` (xlsx giả 25 store); `careWriteGate` trong `writeQaGates.ts` + marker `.qa-care.json` gitignored |
| Reviewer | `security-reviewer` thêm checklist CRM (SĐT, lý do/sản phẩm, proof, export) |
| Phối hợp | Report Dev `planning/reports/`, audit PM `planning/reviews/`; Dev `T-xx`, PM `Q-xx`; reviewer 1 lần/batch |

**Gate mỗi batch:** `npx tsc --noEmit` → spec liên quan → full Playwright → `npm run build` → `git diff --check`. Không commit hay merge khi user chưa yêu cầu.

## 9. Batch
| Batch | Nội dung | Phụ thuộc | Cỡ |
|---|---|---|---|
| B0 | Setup §8, `lib/bigquery/{query,client}.ts` (mock), `lib/care/{time,outcome,config,flags}.ts` | ✅ PM GO có điều kiện (audit `reviews/2026-10-07-crm-b0.md`); chưa commit | S |
| B1 | Migration 114 (bảng, RLS, helper, RPC trừ sync) + PGlite QA + `db-reviewer`. Gồm biên `first_overdue_on` (§2.8), RLS sau chuyển giao (§5), `care_orders` theo r3.2 (§4) | ✅ r1.1 sửa P0/P1 audit PM (report `reports/2026-10-07-crm-b1.md`), chờ PM nghiệm thu; race test dời B6; migration chưa chạy prod | L |
| B2 | Import 25 store + từ chối + diff + wizard + lịch sử. Test bằng **fixture giả** (cap byte, diff, atomicity) | PM duyệt SPEC B2. **Không** cần file thật/MB (Q-63) | L |
| B3 | Web Chăm sóc + Chuyển giao | PM duyệt SPEC B3 | L |
| B4 | Mobile staff + nav + CTA `/tasks` (đo) + form + proof | PM duyệt SPEC B4 | M |
| B5 | Đồng bộ đơn (2 luồng) + attribution + báo cáo + export | PM duyệt SPEC B5 + BI/operator xác nhận N3 r3.2 (checklist §11) | L |
| B6 | Rollout: deploy cờ OFF → migration + VERIFY → **dry-run N3 ×2** (đối soát app ↔ BQ) → fixture `is_test` → **QA thủ công file Excel thật** (kênh riêng, không Git/log/bucket public — Q-63) → bật cờ → smoke 5 vai trò | Coolify thêm 2 cron | M |

Toàn bộ nằm trên `feat/crm-cskh`, merge `main` sau B6.

**Ghi chú B1 cho batch sau** (từ db-reviewer/security-reviewer):
- B2: preview map dược sĩ theo **đúng quy tắc finalize**: email (lower+trim) khớp đúng 1 staff của store đích; 0 ⇒ `ASSIGNEE_INVALID`, >1 ⇒ `ASSIGNEE_AMBIGUOUS` (audit PM B1 P0); staff nghỉ = đã tháo store (Q-71).
- B2: route gọi `care_import_finalize(batch, actor)` bằng service role **sau** khi kiểm quyền app; `row_no` = số dòng Excel liền mạch; benchmark finalize ~10k dòng dưới `statement_timeout=8s` của prod; `file_name` có thể chứa tên người (chỉ hiển thị cho care admin).
- B2–B4: embed PostgREST phải ghi FK: `users!care_interactions_actor_id_fkey` / `!care_interactions_assignee_id_fkey`; `care_assignment_events` có 3 FK tới users (from/to/actor) và 2 FK tới stores.
- B4: `proof` ép host/prefix GCS theo task (hiện chỉ https, ≤5 ảnh, ≤4KB); quyết định staff có thấy tiền attribution không (câu hỏi PM report B1 §6).
- B5: cron gọi thêm `care_purge_stale_staging()`; `last_error` không chứa PII; chỉ log `kind/status` của BigQueryError.
- B6: race hai lượt/chuyển giao thật qua pg-meta sau khi user áp 114; ghi runbook: FK RESTRICT tới users/stores ⇒ xoá user có dữ liệu CRM sẽ lỗi.

## 10. Rủi ro kỹ thuật
1. **Upload lớn:** §3. B2 kiểm cap/stream bằng fixture giả; file thật chỉ QA thủ công trước bật cờ (B6, Q-63). Vượt cap hoặc mapping lỗi ⇒ sửa trước rollout.
2. **PII:** RLS theo §5, log `maskVnPhone`, export che số, proof public theo Q-53 (nợ kỹ thuật).
3. **Đệ quy RLS:** chỉ dùng helper; `db-reviewer` mỗi migration.
4. **Không có staging env:** gate `care` + `is_test`, báo cáo và export loại `is_test`.
5. **BQ:** nguồn là logical view thì không có partition. Luồng đối soát lọc theo `customer_external_id`, cần BI xác nhận chi phí.
6. **Nhánh sống lâu:** rebase `main` định kỳ.

## 11. Nguồn BigQuery N3 — theo `research/crm-cskh-data-contract-v3.md` r3.2
Một bảng/view, **một dòng mới nhất cho mỗi đơn đã đặt** (POS + online), kể cả đơn về sau huỷ/hoàn. Chỉ dùng để đối chiếu đơn **sau** lượt Hoàn thành. Không có N2/lịch sử mua (Q-57/Q-61).

| Cột | Kiểu BQ | Dùng trong app |
|---|---|---|
| `customer_external_id` | STRING NOT NULL | Join với khách N1 (`care_customers.external_id`) |
| `order_key` | STRING NOT NULL, unique | PK `care_orders` / `care_order_attributions` |
| `ordered_at` | TIMESTAMP NOT NULL (UTC) | So với `care_interactions.created_at` (strict `<`) |
| `source_updated_at` | TIMESTAMP NOT NULL | Cursor incremental (§2.9 luồng 1) |
| `order_net_amount` | NUMERIC NOT NULL | `net_amount`; huỷ/hoàn hết = 0, vẫn là 1 chuyển đổi (Q-66/67) |
| `pos_code` | STRING NULL | Store bán, NULL = online; chỉ đối soát, không quyết định ghi công (Q-65) |

- Tuỳ chọn, không chặn B5: `order_status`, `order_code` (audit/hiển thị).
- Không yêu cầu: `is_valid_order`, `is_deleted`/tombstone (Q-68 — đơn bị xoá cứng ở nguồn do Marketing/operator xử lý thủ công). Partition/cluster là tối ưu vật lý do bên tạo bảng chọn.
- Operator/user tạo bảng theo pattern cron KPI (Q-64). App đọc bằng `BQ_SERVICE_ACCOUNT_KEY` hiện có qua `lib/bigquery/client.ts`; tên bảng ở `CARE_BQ_ORDERS_TABLE`.

**Checklist xác nhận trước B5 (T-10):**
1. Tên bảng đầy đủ `project.dataset.table`, SA app đọc được (dataset `buymed_tech` hoặc cấp `dataViewer`).
2. Sáu cột + kiểu thực, hoặc tên tương đương để map.
3. Một dòng mới nhất/`order_key`, chung POS + online; chỉ đơn đã đặt.
4. Cách cập nhật `order_net_amount` khi huỷ/hoàn (toàn phần/một phần).
5. `source_updated_at` có đổi mỗi khi tiền đổi không, có thể backdate không. Nếu không có/không tin được ⇒ B5 dùng đối soát toàn bộ thay cursor (§2.9).
6. Độ trễ dữ liệu ⇒ chốt nhịp cron `care-orders-sync` (tối thiểu hằng ngày).
7. Dev chạy thử query thật trên số dòng nhỏ an toàn trước khi bật sync.

## 12. Trạng thái câu hỏi
| Mã | Trạng thái |
|---|---|
| T-01…T-06, T-08, T-11 | ✅ (Q-52…Q-62) |
| T-07 / T-09 | ✅ Q-63: không cần file thật/MB trước B2; fixture giả (B0 đã có), file thật QA thủ công trước bật cờ B6 |
| T-10 | ⏳ BI/operator xác nhận N3 r3.2 theo checklist §11, trước B5 |
| Q-02/03 (UNREACHABLE, NO_NEED, ORDERED), Q-30, Q-33 | ⏳ mặc định có `TODO(Q-xx)` (B0: `lib/care/outcome.ts`) |

## 13. Truy vết sửa đổi audit r1.2 → AC/test
| Finding | Sửa ở | AC / test (batch) |
|---|---|---|
| **P0 từ chối** | §2.3, §2.5 b4, §2.7, `care_import_finalize`, `care_transfer_tasks` | (a) Import tháng sau khách đã từ chối ở X vào X → preview lỗi + finalize từ chối (B2, PGlite B1). (b) Cùng khách vào Y → OK. (c) SM chuyển sang X → lỗi; sang Y → OK (B1/B3). (d) Gọi RPC trực tiếp bỏ qua UI vẫn bị chặn (PGlite) |
| **P1-1 attribution** | §2.9, cột chụp ở `care_interactions` | PGlite + spec đối chiếu TS↔SQL: (1) UNREACHABLE → INTERESTED: đơn sau chỉ gán cho INTERESTED; (2) chuyển giao trước lượt Hoàn thành → attribution ghi chủ mới (người làm lượt); chuyển giao sau → vẫn chủ cũ; (3) đơn `ordered_at` = `created_at` → không gán cho lượt đó; 2 lượt cùng `created_at` → chọn `id` lớn hơn; (4) lượt tháng 10, đơn tháng 11 → `period_month` = 10; (5) huỷ/hoàn hết → attribution giữ, `net_amount`=0; hoàn một phần → cập nhật `net_amount` (Q-65…68); (6) recompute 2 lần → không đổi |
| **P1-2 Quá hạn kỳ** | §2.4, §2.8 `first_overdue_on` | (1) Trễ hẹn rồi Hoàn thành → báo cáo kỳ đếm 1, nhãn live hết; (2) trễ rồi đóng kỳ → Quá hạn 1 + Không hoàn thành 1; (3) trễ 2 lần → đếm 1; (4) không hẹn, không xử lý → Quá hạn 0, Không hoàn thành 1; (5) mốc giờ VN 23:59/00:00 |
| **P1-3 revision** | §2.5, §2.6, snapshot tên/SĐT trên task | (1) Revision đổi SĐT, task chưa có lượt → snapshot kỳ này đổi; (2) task đã có lượt → không đổi, diff liệt kê; (3) task tháng cũ không bao giờ đổi; (4) khách vắng → giữ nguyên; (5) đổi dược sĩ → không áp, gợi ý chuyển giao |
| **P1-4 RLS / báo cáo** | §5 | e2e + PGlite theo role: (1) sau A→B: B thấy lượt cũ của khách, A mất task; (2) qua kỳ: dược sĩ kỳ mới thấy lượt kỳ trước; (3) staff không thấy khách store khác; (4) QLCH/SM chỉ thấy store mình; (5) `care_report` của từng role = số đếm qua session client; (6) role không đọc được `care_orders` nhưng báo cáo vẫn có doanh thu |
| **P1-5 cursor** | §2.9 luồng 2 + `care_reconcile_queue` | Mock BQ: (1) đơn có `source_updated_at` < cursor, khách vừa Hoàn thành → vẫn lấy qua queue; (2) đơn về muộn, đổi trạng thái/tiền → cập nhật; (3) đơn đổi tiền về 0 vẫn đếm 1 chuyển đổi; (4) cron chạy 2 lần / lỗi giữa chừng → idempotent, queue giữ nguyên |
| P2 BI v3 → r3.2 | §4, §11 | Checklist 7 điểm §11 xác nhận trước B5; migration B1 không có cột `is_valid_order`/`is_deleted` (source spec 114) |
| P2 `/tasks` | §7 | Đo p95 trang `/tasks` staff trước/sau (B4 report); CTA tĩnh nếu không đạt |
| P2 env Playwright | §8 | ✅ B0: `e2e/envLocal.ts` + `care-qa-preflight.spec.ts` chạy trên PowerShell; preflight thật đạt; chạy âm (tài khoản staff) đỏ; thiếu biến → skip có tên biến; log không chứa email/mật khẩu |
| P2 upload cap | §3 | Route test: thiếu header 411, vượt cap 413 (header và stream), body bị cắt 400 |

### 13.1 Redline audit r1.3 → nơi xử lý
| Redline | Sửa ở | AC / test (batch) |
|---|---|---|
| P1 trước B1 — biên `first_overdue_on` hẹn ngày cuối tháng | §2.8 | PGlite B1: hẹn 30/10 không gọi → mốc 31/10, Quá hạn T10 = 1; hẹn 31/10 không gọi → Quá hạn T10 = 0, Không hoàn thành = 1; import T11 đóng kỳ trước cron 00:05 cho cùng kết quả; parity helper SQL ↔ TS |
| P1 trong B0 — loader Windows, preflight thật | §8 | ✅ B0 (report `reports/2026-10-07-crm-b0.md`) |
| P1 trước B5 — update/late feed > 35 ngày | §2.9 luồng 1, §11 checklist 5 | Mock BQ B5: đơn đổi tiền sau 40 ngày có `source_updated_at` mới → incremental lấy được; nếu BI không bảo đảm `source_updated_at` → SPEC B5 chọn đối soát toàn bộ + test tương ứng |
| P2 B1/B3 — lịch sử sau chuyển giao | §5 | RLS B1: chuyển A→B cùng kỳ và qua kỳ; A vẫn đọc task kỳ cũ của mình, không đọc task đã chuyển và lịch sử khách kỳ khác |
| P2 B5 — client BQ mới, không sửa cron KPI | §3 | ✅ B0: `lib/bigquery/{query,client}.ts`, mock >1 trang/job chưa xong/timeout/lỗi giữ snapshot; `lib/targets/bigquery.ts` không đổi |
