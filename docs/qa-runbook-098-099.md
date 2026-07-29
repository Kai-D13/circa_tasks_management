# QA Runbook — Migration 098 (Campaign Archive) + 099 (Affiliate Orders Drill-down)

> Batch `feat/kpi-archive-orders-tiers` (r1.2 @ audit 28/07). Thứ tự BẮT BUỘC:
> **preflight → 098 → verify 098 → QA 098 → gửi output audit → 099 → verify 099
> → QA 099 → QA browser → gates → merge → deploy code**. KHÔNG chạy 099 cùng
> lúc với 098 (khoanh vùng lỗi). Script chạy từ thư mục `webapp/`.
>
> **XÁC NHẬN MÔI TRƯỜNG (câu hỏi audit r1.1):** `.env.local` của 2 QA script
> trỏ vào **Supabase PRODUCTION** (project không có Supabase QA riêng — QA
> từ trước đến nay đều trên prod DB bằng fixture/is_test). Vì vậy r1.2 đã
> cứng hóa cô lập: fixture id ĐỘNG + marker-first + preflight baseline-0 +
> cleanup chỉ-theo-marker + cửa sổ RETRO 02/2024 + yêu cầu tạm dừng cron.

## 0. Preflight

- [x] Dung lượng `affiliate_orders`: **230 rows / 336 kB** (28/07) → CREATE INDEX
  thường trong transaction OK, không cần CONCURRENTLY. Nếu chạy lại sau này khi
  bảng đã lớn: tách index sang `CREATE INDEX CONCURRENTLY` ngoài transaction.
- [ ] Không có Affiliate sync đang chạy (chạy lệch giờ cron `5 */2`):

```sql
SELECT count(*) AS running FROM public.affiliate_sync_runs WHERE status = 'running';
-- KỲ VỌNG: 0
```

## 1. Chạy migration 098 (Supabase SQL editor, nguyên file)

## 2. Verify 098 — SQL (gửi toàn bộ output cho audit)

```sql
-- 2.1 Migration record (KỲ VỌNG: 1 row)
SELECT version, name FROM public.app_migrations WHERE version = '098';

-- 2.2 Ba cột archive (KỲ VỌNG: 3 rows)
SELECT column_name FROM information_schema.columns
WHERE table_name = 'kpi_campaigns' AND column_name LIKE 'archived%';

-- 2.3 Bốn RPC SECURITY DEFINER (KỲ VỌNG: 4 rows, prosecdef = t)
SELECT proname, prosecdef FROM pg_proc WHERE proname IN
('rpc_archive_kpi_campaign','rpc_replace_campaign_targets',
 'rpc_activate_kpi_campaign','rpc_replace_campaign_actuals');

-- 2.4 Grant matrix (KỲ VỌNG: anon=f, authenticated=f, service_role=t — cả 4 hàm)
SELECT p.fn,
  has_function_privilege('anon', p.fn, 'EXECUTE')          AS anon,
  has_function_privilege('authenticated', p.fn, 'EXECUTE') AS authenticated,
  has_function_privilege('service_role', p.fn, 'EXECUTE')  AS service_role
FROM (VALUES
  ('public.rpc_archive_kpi_campaign(uuid,uuid,text)'),
  ('public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)'),
  ('public.rpc_activate_kpi_campaign(uuid,timestamptz,uuid)'),
  ('public.rpc_replace_campaign_actuals(uuid,jsonb,jsonb)')
) AS p(fn);

-- 2.5 Function definition: row lock + archived guard + giữ nguyên hành vi cũ
-- (KỲ VỌNG: tất cả cột = true)
WITH t AS (SELECT lower(pg_get_functiondef('public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)'::regprocedure)) b),
     a AS (SELECT lower(pg_get_functiondef('public.rpc_replace_campaign_actuals(uuid,jsonb,jsonb)'::regprocedure)) b),
     v AS (SELECT lower(pg_get_functiondef('public.rpc_activate_kpi_campaign(uuid,timestamptz,uuid)'::regprocedure)) b)
SELECT
  (SELECT position('for update' in b) > 0 FROM t)  AS targets_lock,
  (SELECT position('đã lưu trữ' in b) > 0 FROM t)  AS targets_arch_guard,
  (SELECT position('delete from public.kpi_campaign_store_actuals' in b) > 0 FROM t) AS targets_clears_actuals,
  (SELECT position('for update' in b) > 0 FROM a)  AS actuals_lock,
  (SELECT position('đã lưu trữ' in b) > 0 FROM a)  AS actuals_arch_guard,
  (SELECT position('p_actuals có store trùng lặp' in b) > 0 FROM a) AS actuals_keeps_validation,
  (SELECT position('on conflict (campaign_id, store_id)' in b) > 0 FROM a) AS actuals_keeps_upsert,
  (SELECT position('đã lưu trữ' in b) > 0 FROM v)  AS activate_arch_guard;
```

## 3. QA 098 functional — script (fixture is_test tự tạo + tự cleanup)

**TRƯỚC khi run (r1.3):** tạm dừng Coolify cron `sync-kpi-campaign-actuals`
(hoặc chạy lệch phút `:20` chẵn giờ) — fixture có giai đoạn ACTIVE ngắn; script
BẮT BUỘC xác nhận qua env, thiếu là abort.

```powershell
cd C:\webapp_management\webapp
node scripts/qa-kpi-archive-098.mjs verify
$env:QA_KPI_CRON_PAUSED='YES'; node scripts/qa-kpi-archive-098.mjs run
# KỲ VỌNG: "PASS TOÀN BỘ 10 bước" (draft/active chặn · paused OK · lần 2 chặn ·
# bảng con NGUYÊN VẸN NỘI DUNG — deep-compare select(*) canonical-sort 5 nhóm ·
# import/activate/ghi-actuals trên archived đều RAISE · cleanup 3-ĐIỀU-KIỆN:
# delete OK + verify OK + count=0 → mới gỡ marker; DB chưa sạch → marker GIỮ
# NGUYÊN + exit ≠ 0, không bao giờ 'PASS TOÀN BỘ' giả).
# Flow run KHÔNG process.exit giữa chừng (throw) → cleanup finally luôn chạy.

# NEGATIVE QA (r1.3 điểm 11 — chạy 1 lần để chứng minh cleanup):
$env:QA_KPI_CRON_PAUSED='YES'; $env:QA_BREAK_STEP='yes'; node scripts/qa-kpi-archive-098.mjs run
# KỲ VỌNG: FAIL 'QA_BREAK_STEP' NHƯNG cleanup vẫn chạy đủ 3 điều kiện, marker
# được gỡ (DB sạch), exit code = 1. Sau đó bỏ env: Remove-Item Env:QA_BREAK_STEP

# Fixture sót (nếu run đứt kiểu mất mạng): node scripts/qa-kpi-archive-098.mjs cleanup
```

Sau đó QA UI nhanh (localhost hoặc chờ deploy): campaign archived biến mất
khỏi list `/targets/campaigns` + detail 404 + export 404.

## 4. QA 098 race 2-session (nếu có thể — cần psql, SQL editor không giữ được tx)

```text
Session A (psql):                       Session B (psql):
BEGIN;
SELECT public.rpc_replace_campaign_actuals('<id-campaign-test-paused>', '[]', '[]');
-- (giữ tx MỞ — lệnh trên sẽ RAISE validation
--  nếu payload rỗng: dùng payload hợp lệ như
--  bước 3b của script, hoặc chỉ cần:
--  SELECT ... FROM kpi_campaigns WHERE id='<id>' FOR UPDATE;)
                                        SELECT public.rpc_archive_kpi_campaign('<id>', NULL);
                                        -- KỲ VỌNG: TREO (chờ lock)
COMMIT;
                                        -- KỲ VỌNG: hoàn tất archive ngay sau COMMIT
-- Chiều ngược: archive commit TRƯỚC → gọi rpc_replace_campaign_actuals
-- KỲ VỌNG: RAISE 'đã lưu trữ — không ghi số liệu'
```

**GỬI OUTPUT MỤC 2 + 3 (+ 4 nếu chạy) CHO AUDIT — PASS MỚI SANG 099.**

## 5. Chạy migration 099 (khung ít traffic, lệch giờ cron)

## 6. Verify 099 — SQL (gửi toàn bộ output cho audit)

```sql
-- 6.1 Migration record (KỲ VỌNG: 1 row)
SELECT version, name FROM public.app_migrations WHERE version = '099';

-- 6.2 RLS: policy direct select CHỈ CÒN super (KỲ VỌNG: qual chỉ chứa
-- is_super_admin, KHÔNG còn is_sm_for_store / get_user_store_id)
SELECT polname, pg_get_expr(polqual, polrelid) AS qual
FROM pg_policy WHERE polrelid = 'public.affiliate_orders'::regclass;

-- 6.3 RPC list + grants (KỲ VỌNG: prosecdef=t; anon=f, authenticated=t, service_role=t)
SELECT proname, prosecdef FROM pg_proc WHERE proname = 'rpc_list_affiliate_orders';
SELECT
  has_function_privilege('anon',          'public.rpc_list_affiliate_orders(uuid,timestamptz,timestamptz,integer,timestamptz,uuid)', 'EXECUTE') AS anon,
  has_function_privilege('authenticated', 'public.rpc_list_affiliate_orders(uuid,timestamptz,timestamptz,integer,timestamptz,uuid)', 'EXECUTE') AS authenticated,
  has_function_privilege('service_role',  'public.rpc_list_affiliate_orders(uuid,timestamptz,timestamptz,integer,timestamptz,uuid)', 'EXECUTE') AS service_role;

-- 6.4 Index (KỲ VỌNG: CÓ ...store_completed_id, KHÔNG CÒN ...store_completed)
SELECT indexname FROM pg_indexes WHERE tablename = 'affiliate_orders' ORDER BY 1;
```

## 7. QA 099 role matrix + đối soát — script

**TRƯỚC fixture-up:** tạm dừng Coolify Scheduled Task `pull-affiliate-orders`
(Disable) — full-snapshot reconciliation sẽ đánh dấu `source_active=false`
các đơn fixture không có trong nguồn Mongo. Bật lại NGAY sau `fixture-down`.
r1.3: script ENFORCE bằng env `QA_AFFILIATE_CRON_PAUSED=YES` + kiểm
`affiliate_sync_runs` không có run 'running' — thiếu là abort trước insert.

Cơ chế an toàn của script (tự động, abort nếu vi phạm): id động mỗi run +
marker `.qa-drill-fixture.json` (kind/schemaVersion, VALIDATE đủ trước khi
dùng: UUID store, đúng 55 id, safe-integer, nằm trong vùng ID QA) ghi TRƯỚC
insert; preflight dải id trống + baseline 0 đơn delivered-active của POS0059
trong cửa sổ RETRO 02/2024; verify đủ 55 id sau insert; `fixture-down` contract
3 điều kiện (delete OK + verify OK + count=0) mới gỡ marker.

```powershell
cd C:\webapp_management\webapp
node scripts/qa-affiliate-orders-099.mjs verify
$env:QA_AFFILIATE_CRON_PAUSED='YES'; node scripts/qa-affiliate-orders-099.mjs fixture-up   # preflight + 55 đơn QA (54 dương + 1 ÂM)

# Chạy CHECK cho TỪNG account (Super lấy từ session RPC is_super_admin();
# role bị từ chối phải đúng message 'Không có quyền'; có thêm check FS scope):
$env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email-super>
$env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email-admin-OPS>
$env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email-SM-có-POS0059>
$env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email-SM-KHÔNG-có-POS0059>
$env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email-QLCH-POS0059>
$env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email-QLCH-store-khác>
$env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email-staff>

node scripts/qa-affiliate-orders-099.mjs fixture-down   # BẮT BUỘC sau khi xong (chỉ xóa id trong marker)
# → Bật lại cron pull-affiliate-orders trên Coolify.
```

Mỗi lần `check` phủ: (a) direct PII = 0 row trừ super · (b) RPC đúng scope ·
(c) walk 2 trang không trùng/sót + COUNT/SUM khớp aggregate tuyệt đối (gồm đơn
âm) · (d) range guard from>to và >366 ngày. Store nhiều mapping (nếu có trên
prod — chạy câu SQL của audit) kiểm bằng browser ở mục 8.

```sql
-- Store có >1 mapping active (để biết case P2#4 có dữ liệu thật hay không)
SELECT store_id, count(*) AS mappings, array_agg(partner_code)
FROM public.affiliate_partner_mappings
WHERE is_active AND store_id IS NOT NULL
GROUP BY store_id HAVING count(*) > 1;
```

## 8. QA browser (sau deploy code hoặc localhost flag bật)

- Overview `/targets/campaigns/affiliate`: store nhiều partner code chỉ MỘT
  dòng (codes liệt kê dưới tên); chevron lazy-load (mở mới gọi, Network không
  preload); "Tải thêm" sau 50 đơn; dòng đối soát "Khớp ✓"; đổi ngày/store →
  state đóng + reset; nguồn !READY → số '—' và KHÔNG có chevron.
- Archive: paused/ended có icon Lưu trữ + dialog; active không có; sau archive
  biến mất list/detail/export; `/targets` Staff/QLCH/SM không hiện.
- Tier Progress desktop ≥1024px (Super + SM bảng, QLCH Mốc thưởng): campaign
  1 / 3 / 5 tier; mobile + Staff giữ nguyên UI cũ.

## 9. Gates cuối + release

`npx tsc --noEmit` → full Playwright → production build (Node 22.17.1, tắt dev
server, xóa `.next`) → merge `--no-ff` vào main → verify tree → **deploy MỘT
lần**. Thứ tự bắt buộc: **098 → 099 → code deployment** (code drill-down thiếu
RPC/policy mới sẽ lỗi expand + Staff còn đường PII cũ).

## Rollback nhanh

- 098/099: khối ROLLBACK đầy đủ trong header từng file migration.
- Restore 1 campaign đã lưu trữ (SQL tay): xem header 098.
