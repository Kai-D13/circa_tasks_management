# Handoff — RX-V2.8 + FS Approve UX (2026-07-10)

## Scope được phép sửa

Chỉ sửa đúng 2 nhóm request stakeholder đã mở quyền:

1. Module Toa thuốc (`/prescriptions`): hoàn tất batch search/RLS, xử lý lỗi `URI too long` khi search DHC, giữ rule search mới.
2. Module FS products (`/fs/products/[id]`): popup xác nhận khi duyệt item + filter `Đã duyệt`.

Không chỉnh các module khác.

## File đã thay đổi

### Toa thuốc

- `supabase/migrations/087_prescription_search_page_rpc.sql` — tạo RPC phân trang cho search, nhưng bản đầu đã lỡ tighten staff SELECT về own store.
- `supabase/migrations/088_prescription_staff_os_wide_read.sql` — sửa lại policy staff SELECT theo rule cuối: OS staff view/search toàn bộ OS-store prescriptions; FS staff vẫn bị chặn.
- `webapp/lib/prescriptions/search.ts` — thêm helper `searchPrescriptionsPage()` dùng RPC phân trang.
- `webapp/app/(dashboard)/prescriptions/page.tsx` — list search dùng RPC phân trang, không còn `.in(id, [...])`.
- `webapp/app/api/export/prescriptions/route.ts` — export khi có search cũng dùng RPC phân trang, không còn `.in(id, [...])`.

### FS products

- `webapp/app/(dashboard)/fs/products/[id]/page.tsx` — thêm filter server-side `status=approved` bằng `approved_at IS NOT NULL`.
- `webapp/components/fs/FsResultTab.tsx` — đổi icon duyệt sang `CircleCheck`, thêm confirm modal branded, thêm tab filter `Đã duyệt`.

## Permission model cuối cùng của Toa thuốc

Stakeholder chốt:

- **View/search:** OS staff được xem và tìm kiếm toa thuốc của toàn bộ OS stores.
- **Action:** chăm sóc khách / sửa lỗi DHC vẫn chỉ cho chính toa do staff đó submit (`submitted_by = auth.uid()` ở app query khi vào action filters).
- **FS staff:** không được thấy module Toa thuốc OS.
- **Admin:** giữ quyền hiện tại.
- **Store manager:** giữ scope store như trước.

## Migration cần chạy

Nếu môi trường đã chạy 085/086/087, chạy thêm:

```sql
-- supabase/migrations/088_prescription_staff_os_wide_read.sql
```

Fresh environment chạy theo thứ tự migration bình thường; 088 sẽ override policy sai từ 087.

### Verify 088

```sql
select version, name
from public.app_migrations
where version in ('087','088')
order by version;

select policyname, cmd, qual
from pg_policies
where schemaname = 'public'
  and tablename = 'prescription_submissions'
  and policyname = 'ps_select_staff';

select p.oid::regprocedure as signature, p.prosecdef
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'rpc_search_prescriptions_page';
```

Expected:

- `087 / prescription_search_page_rpc` tồn tại.
- `088 / prescription_staff_os_wide_read` tồn tại.
- `rpc_search_prescriptions_page(...)` có `prosecdef = false`.
- `ps_select_staff.qual` có `is_current_user_os_staff()` và `is_os_store(store_id)`.
- `ps_select_staff.qual` KHÔNG còn `store_id = get_user_store_id()`.

## Rule search hiện tại

Một ô search vẫn giữ UI gọn cho mobile, nhưng logic rõ hơn:

- Product ID: match exact token dạng `<product_id> - ...`, không fuzzy ID.
- Product name: fuzzy/unaccent/trigram.
- DHC: cho phép partial/near ở mức hợp lý; numeric-only DHC chỉ kích hoạt khi query có >= 6 chữ số để tránh nhập `1535` bị kéo nhầm DHC.
- Note: fuzzy/unaccent/trigram.

## Lỗi đã xử lý

### P1 — `/prescriptions?q=DHC...` bị `URI too long`

Root cause: batch cũ dùng RPC trả tối đa 500 UUID rồi gọi PostgREST `.in('id', ids)`. Khi search DHC match nhiều, URL query quá dài.

Fix: dùng RPC mới trả thẳng page data + total count. App không gửi UUID list qua URL nữa.

### P1 r2 — 087 làm staff chỉ thấy toa của store mình

Root cause: migration 087 thay `ps_select_staff` thành `store_id = get_user_store_id()`. Vì search RPC là `SECURITY INVOKER`, RLS này làm list/search chỉ thấy own store.

Fix: migration 088 restore `ps_select_staff` về OS-wide read:

```sql
(select public.is_current_user_os_staff())
AND public.is_os_store(store_id)
```

FS staff vẫn bị chặn vì `is_current_user_os_staff()` chỉ true cho staff thuộc OS store.

### FS UX — Duyệt item click phát duyệt ngay

Fix: icon đổi sang `CircleCheck`, click mở confirm modal:

- Title: `Duyệt kết quả sản phẩm?`
- Nội dung: `Bạn có muốn duyệt kết quả sản phẩm này?`
- Buttons: `Không` / `Có, duyệt`

### FS filter — thiếu `Đã duyệt`

Fix: thêm tab filter `Đã duyệt`, query bằng `approved_at IS NOT NULL`.

## Verification đã chạy local

```bash
cd webapp
npx tsc --noEmit
npm run build
```

Kết quả:

- `tsc`: pass.
- `npm run build`: pass sau khi cho phép network để Next.js tải Google Fonts (`Be Vietnam Pro`). Nếu build trong sandbox không có network sẽ fail ở `next/font`, không phải lỗi code.
- `git diff --check`: pass cho các file tracked đã sửa.

## QA checklist sau migration 088

### Toa thuốc — OS staff

1. Login OS staff Store A.
2. `/prescriptions` thấy toa từ nhiều OS stores, không chỉ Store A.
3. Search DHC của Store B vẫn trả kết quả.
4. Search DHC đầy đủ: ví dụ `DHC00986616` không còn `URI too long`.
5. Search numeric DHC dài: ví dụ `00986616` trả đúng nhóm gần nhất.
6. Search product_id exact: ví dụ `1535` chỉ match product token `1535 - ...`, không kéo DHC ngắn vô lý.
7. Search product_name fuzzy: sai dấu/sai nhẹ vẫn có kết quả liên quan.
8. Search note fuzzy: nhập biệt dược/hoạt chất trong note trả kết quả liên quan.
9. Reminder strip / care filters vẫn chỉ đếm/lọc toa của chính staff đó submit.

### Toa thuốc — Admin/export

1. Admin mở `/prescriptions`, search DHC không lỗi.
2. Export khi đang search DHC/product/note: file Excel tải được, không lỗi URI.
3. Export vẫn có cột ảnh, ngày dùng, ngày bán, ngày nhắc.

### RLS regression

1. FS staff truy cập `/prescriptions` bị redirect/chặn như trước.
2. OS staff thấy OS prescriptions toàn hệ thống.
3. OS staff không thấy FS prescriptions nếu về sau có FS data lẫn vào bảng này.
4. Admin vẫn thấy theo quyền hiện tại.
5. Store manager giữ scope store của mình.

### FS products

1. Admin Policy mở `/fs/products/[id]?tab=result`.
2. Item `Hoàn thành` chưa duyệt có icon check mới.
3. Click icon -> popup confirm hiện đúng brand style.
4. Click `Không` -> không duyệt, ở lại UI.
5. Click `Có, duyệt` -> item thành `Đã duyệt`.
6. Filter `Đã duyệt` chỉ hiện item đã duyệt.
7. Resubmit item/box đã duyệt vẫn clear approval như logic Batch E trước đó.
8. Export FS vẫn có cột duyệt như trước.

## Lưu ý deploy

- Chạy 087 nếu chưa chạy, sau đó chạy 088.
- Nếu môi trường đã chạy 087 rồi thì chỉ cần chạy 088 để sửa policy.
- Không có thay đổi schema FS trong batch này.

## Rollback nhanh

Nếu cần rollback app code: revert các file app/helper ở commit batch này.

Nếu cần rollback DB phần search: có thể `DROP FUNCTION public.rpc_search_prescriptions_page(...)`.

Không khuyến nghị rollback 088 vì 088 là permission model cuối cùng stakeholder vừa chốt.

## Future backlog không build trong batch này

- Tách UI search Toa thuốc thành nhiều input riêng nếu stakeholder vẫn thấy một ô search chưa đủ rõ.
- Tối ưu index trigram nếu dữ liệu toa thuốc tăng lớn.
- Nâng care workflow từ submitter-only sang store-level nếu vận hành muốn mọi staff cùng store cùng chăm sóc toa.
## Addendum RX-V2.9 — Search precision r3 (2026-07-11)

### Ly do them r3

QA sau 087/088 cho thay DHC va product_id da on, nhung search theo `product_name` / `note` van tra qua nhieu toa khong co dau hieu vi sao match. Vi du `Bioprolol` co ket qua dau dung, nhung cac dong sau khong hien product/note lien quan nen Staff khong biet chon DHC nao.

### Thay doi ky thuat

- Them migration `supabase/migrations/089_prescription_search_precision.sql`.
- 089 thay the lai RPC `rpc_search_prescriptions_page(...)`, khong doi RLS.
- RPC moi tra them metadata:
  - `match_source`: `order` | `product_id` | `product` | `note`
  - `match_quality`: `exact` | `token` | `fuzzy`
  - `match_text`: noi dung dung de giai thich ket qua
  - `match_score`: diem sap xep relevance
- `webapp/lib/prescriptions/search.ts` cap nhat type row theo metadata moi.
- `webapp/app/(dashboard)/prescriptions/page.tsx` hien snippet giai thich match tren mobile card.

### Rule search sau r3

- DHC: cho phep partial/gan dung hop ly de tra cuu ma don.
- Product ID: bat buoc exact token dang `<product_id> - ...`, khong fuzzy product_id.
- Product name:
  - uu tien exact phrase / token match.
  - fuzzy chi bat khi confidence cao (`strict_word_similarity >= 0.72`).
- Note:
  - uu tien exact phrase / token match.
  - fuzzy con chat hon product (`strict_word_similarity >= 0.78`).
- UI hien label nhu:
  - `Khớp mã DHC`
  - `Khớp mã SP`
  - `Khớp sản phẩm`
  - `Gợi ý gần đúng sản phẩm`
  - `Khớp ghi chú`
  - `Gợi ý gần đúng ghi chú`

### Migration can chay them

```sql
-- supabase/migrations/089_prescription_search_precision.sql
```

### Verify 089

```sql
select version, name
from public.app_migrations
where version in ('087','088','089')
order by version;

select p.oid::regprocedure as signature, p.prosecdef
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'rpc_search_prescriptions_page';

select order_code, match_source, match_quality, match_text, match_score
from public.rpc_search_prescriptions_page(
  'Bioprolol','all',12,0,null,null,null,null,false,current_date,null,null
);
```

Expected:

- 087, 088, 089 deu co trong `app_migrations`.
- `rpc_search_prescriptions_page(...)` co `prosecdef = false`.
- Search `Bioprolol` uu tien dong co `match_source = note` hoac `product`, `match_quality = exact/token`; cac fuzzy neu co phai co `match_text` de Staff hieu ly do.

### QA r3

1. OS staff search DHC: khong URI too long, ket qua van dung.
2. OS staff search product_id exact: chi match product token, khong fuzzy ID.
3. OS staff search `Bioprolol`: dong dung co snippet `Khớp ghi chú` / `Gợi ý...` va text lien quan.
4. Thu mot ten san pham co dau/sai dau: ket qua it hon truoc, dong nao fuzzy phai co label `Gợi ý gần đúng...`.
5. FS staff van bi chan `/prescriptions`.
6. Care/error action cua staff van own-submission only.
7. Export khi co search van tai duoc file, khong loi URI.
