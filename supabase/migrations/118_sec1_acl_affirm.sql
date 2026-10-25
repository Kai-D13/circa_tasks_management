-- ============================================================================
-- 118_sec1_acl_affirm.sql
-- Chạy SAU 117. Batch SEC-1 r2 (PM brief `planning/reviews/2026-10-25-t1-smoke-result-sec1-118-brief-pm.md`).
--
-- Mục đích: ghi vào chuỗi migration trạng thái quyền đã vá khẩn cấp ngày 25/10/2026 bằng script ngoài chuỗi SEC-1
-- (`planning/research/sec1-revoke-runbook.md`, SHA-256 `475a6c35…fe7ac7`): 16 hàm SECURITY DEFINER chỉ dành cho service_role
-- KHÔNG được để PUBLIC / anon / authenticated EXECUTE. Nguyên nhân gốc: default privileges của supabase_admin / postgres trên
-- schema public tự cấp EXECUTE cho anon / authenticated khi tạo hàm; migration gốc (059/061, 064, 065, 068, 077–083) chỉ
-- `REVOKE … FROM public` hoặc không revoke. Mọi call site app dùng supabaseAdmin (service_role).
--
-- Phạm vi: CHỈ `REVOKE EXECUTE` tường minh trên đúng 16 chữ ký dưới đây, từ PUBLIC, anon, authenticated. KHÔNG đổi body hàm,
-- owner, search_path, bảng, dữ liệu, RLS / policy, cron, app hay default privileges; KHÔNG gỡ quyền service_role / postgres /
-- supabase_admin; KHÔNG GRANT gì. Không dùng vòng "thu hồi mọi grantee" của 117 (vòng đó gỡ cả postgres).
--
-- Contract hậu kiểm (trong transaction, đỏ ⇒ RAISE ⇒ rollback toàn bộ, không ghi marker):
--   · 16/16 hàm có mặt, SECURITY DEFINER, owner supabase_admin, không overload cùng tên.
--   · anon / authenticated KHÔNG EXECUTE được (has_function_privilege), kể cả qua membership NOINHERIT (pg_has_role MEMBER tới
--     service_role / postgres / supabase_admin = false); service_role EXECUTE được.
--   · Người giữ EXECUTE của mỗi hàm đúng tập {postgres, service_role, supabase_admin}.
--   · ACL mọi hàm public KHÁC 16 hàm không đổi so với ảnh chụp đầu transaction.
--
-- Prod (đã chạy script SEC-1 25/10): 16 REVOKE là no-op, hậu kiểm đạt, chỉ thêm marker 118. DB chưa chạy SEC-1: 16 REVOKE thu
-- hồi quyền thật, cùng hậu kiểm. Preflight RAISE (không sửa, không nới) nếu service_role / postgres / supabase_admin đang THIẾU
-- EXECUTE trên hàm nào ⇒ ACL đã lệch hồ sơ — dừng, báo PM.
--
-- Chạy bởi: supabase_admin (owner + grantor ACL hiện có; Studio SQL editor / pg-meta), DB `postgres`. Role không phải superuser /
-- owner ⇒ RAISE. Trong Studio: DÁN NGUYÊN FILE, KHÔNG bôi chọn một đoạn (Studio chỉ chạy phần được chọn — chọn riêng dòng INSERT
-- marker sẽ ghi 118 mà không qua preflight / hậu kiểm); để role / impersonation mặc định.
-- Idempotency: REVOKE idempotent; nhưng preflight chặn khi đã có marker 118 hoặc migration > 118 (chạy lại ⇒ RAISE, không đổi gì).
-- Vì vậy INSERT marker cố ý KHÔNG có `ON CONFLICT DO NOTHING` (khác 117): trùng marker phải lỗi rõ, không lặng lẽ bỏ qua.
-- Lỗi / timeout trong Studio: pg-meta tự rollback (mỗi request một kết nối) — KHÔNG chạy lại; chạy VERIFY dưới để phân biệt
-- đã commit (có marker 118) hay chưa.
--
-- ROLLBACK (chỉ xoá marker — TUYỆT ĐỐI không cấp lại EXECUTE cho PUBLIC / anon / authenticated; mọi việc nới quyền cần biên bản
-- sự cố + quyết định PM riêng):
--   BEGIN;
--   DELETE FROM public.app_migrations WHERE version = '118';
--   COMMIT;
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- Danh sách khoá 16 chữ ký (catalog prod 25/10 = CREATE mới nhất trong migrations; runbook SEC-1 §2).
CREATE TEMP TABLE m118_target (sig text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO m118_target (sig) VALUES
  ('public.replace_staff_referrals(jsonb,uuid)'),                                    -- 059 / 061
  ('public.replace_announcement_audience_assets(uuid,uuid[],text,text[])'),           -- 064
  ('public.rpc_update_announcement(uuid,text,text,text,text,timestamp with time zone,uuid[],text,text[])'), -- 064
  ('public.rpc_bulk_request_resubmit(uuid[],text,uuid,text)'),                        -- 065
  ('public.rpc_create_inventory_trf_items(jsonb,uuid,integer,uuid)'),                 -- 068
  ('public.rpc_create_fs_session(uuid,text,uuid,jsonb,text,text)'),                   -- 077
  ('public.rpc_fs_claim_session(uuid,uuid)'),                                         -- 081
  ('public.rpc_fs_release_claim(uuid,uuid)'),                                         -- 081
  ('public.rpc_fs_release_claim_self(uuid,uuid)'),                                    -- 081
  ('public.rpc_fs_remove_item(uuid,uuid,text,uuid)'),                                 -- 082
  ('public.rpc_fs_update_item(uuid,text,text,uuid)'),                                 -- 082
  ('public.rpc_fs_approve_item(uuid,uuid)'),                                          -- 083
  ('public.rpc_fs_close_session(uuid,text,uuid,text)'),                               -- 083
  ('public.rpc_fs_resubmit_box(uuid,integer,text,uuid)'),                             -- 083
  ('public.rpc_fs_resubmit_items(uuid,uuid[],text,uuid)'),                            -- 083
  ('public.rpc_fs_submit_item(uuid,uuid,integer,integer,integer,jsonb)');             -- 083

-- ── 0. Preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
  v_oid oid;
  v_n int;
BEGIN
  -- Kiểm role TRƯỚC (role thiếu quyền đọc app_migrations sẽ báo đúng nguyên nhân thay vì "permission denied").
  IF NOT (current_user = 'supabase_admin' OR (SELECT r2.rolsuper FROM pg_catalog.pg_roles r2 WHERE r2.rolname = current_user)) THEN
    RAISE EXCEPTION '118: role chạy migration (%) không phải supabase_admin / superuser — REVOKE sẽ không có hiệu lực', current_user;
  END IF;
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION '118: sai database (%), kỳ vọng postgres', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '117') THEN
    RAISE EXCEPTION '118: thiếu migration nền 117 — chạy đúng thứ tự';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '118') THEN
    RAISE EXCEPTION '118: đã có marker 118 — không chạy lại';
  END IF;
  -- CASE: Postgres không bảo đảm thứ tự tính hai vế AND ⇒ không để version không phải số bị cast.
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE CASE WHEN version ~ '^[0-9]+$' THEN version::int END > 118) THEN
    RAISE EXCEPTION '118: DB đã có migration > 118 — dừng';
  END IF;
  SELECT count(*) INTO v_n FROM m118_target;
  IF v_n <> 16 THEN
    RAISE EXCEPTION '118: danh sách khoá có % chữ ký, kỳ vọng 16', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN (SELECT split_part(substr(sig, 8), '(', 1) FROM m118_target);
  IF v_n <> 16 THEN
    RAISE EXCEPTION '118: % hàm public mang 16 tên mục tiêu, kỳ vọng 16 (thiếu hàm hoặc có overload)', v_n;
  END IF;
  FOR r IN SELECT sig FROM m118_target ORDER BY sig LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION '118: không thấy hàm %', r.sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) THEN
      RAISE EXCEPTION '118: % không phải SECURITY DEFINER', r.sig;
    END IF;
    IF (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) <> 'supabase_admin' THEN
      RAISE EXCEPTION '118: owner của % lệch hồ sơ (kỳ vọng supabase_admin)', r.sig;
    END IF;
    -- Không nới quyền: service_role / postgres / supabase_admin phải ĐANG giữ EXECUTE; thiếu ⇒ ACL lệch hồ sơ — báo PM.
    IF (SELECT count(DISTINCT x.grantee) FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
         WHERE p.oid = v_oid AND x.privilege_type = 'EXECUTE'
           AND x.grantee IN ('service_role'::regrole::oid, 'postgres'::regrole::oid, 'supabase_admin'::regrole::oid)) <> 3 THEN
      RAISE EXCEPTION '118: ACL của % lệch hồ sơ — service_role / postgres / supabase_admin thiếu EXECUTE; dừng, báo PM (118 không cấp quyền)', r.sig;
    END IF;
  END LOOP;
END $$;

-- Ảnh ACL mọi hàm public KHÁC 16 mục tiêu, để hậu kiểm chứng minh không đụng tới.
CREATE TEMP TABLE m118_acl_before ON COMMIT DROP AS
  SELECT p.oid, p.proacl::text AS acl
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.oid NOT IN (SELECT to_regprocedure(sig)::oid FROM m118_target);

-- ── 1. REVOKE ×16 (tường minh, idempotent) ───────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.replace_staff_referrals(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.replace_announcement_audience_assets(uuid, uuid[], text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_update_announcement(uuid, text, text, text, text, timestamp with time zone, uuid[], text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_bulk_request_resubmit(uuid[], text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_create_inventory_trf_items(jsonb, uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_create_fs_session(uuid, text, uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_fs_claim_session(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_fs_release_claim(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_fs_release_claim_self(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_fs_remove_item(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_fs_update_item(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_fs_approve_item(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_fs_close_session(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_fs_resubmit_box(uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_fs_resubmit_items(uuid, uuid[], text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_fs_submit_item(uuid, uuid, integer, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;

-- ── 2. Hậu kiểm trong transaction ───────────────────────────────────────────
DO $$
DECLARE
  r record;
  v_oid oid;
  v_bad text := '';
  v_n int;
  v_holders text;
BEGIN
  FOR r IN SELECT sig FROM m118_target ORDER BY sig LOOP
    v_oid := to_regprocedure(r.sig);
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN v_bad := v_bad || ' | anon còn quyền: ' || r.sig; END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN v_bad := v_bad || ' | authenticated còn quyền: ' || r.sig; END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN v_bad := v_bad || ' | service_role mất quyền: ' || r.sig; END IF;
    IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) THEN v_bad := v_bad || ' | mất SECDEF: ' || r.sig; END IF;
    SELECT string_agg(h.g, ',' ORDER BY h.g) INTO v_holders
      FROM (SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee)::text END AS g
              FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
             WHERE p.oid = v_oid AND x.privilege_type = 'EXECUTE') h;
    IF v_holders IS DISTINCT FROM 'postgres,service_role,supabase_admin' THEN
      v_bad := v_bad || ' | người giữ EXECUTE lệch (' || coalesce(v_holders, 'NULL') || '): ' || r.sig;
    END IF;
  END LOOP;
  -- has_function_privilege bỏ qua membership NOINHERIT ⇒ kiểm riêng.
  IF pg_has_role('anon', 'service_role', 'MEMBER') OR pg_has_role('anon', 'postgres', 'MEMBER')
     OR pg_has_role('anon', 'supabase_admin', 'MEMBER') OR pg_has_role('authenticated', 'service_role', 'MEMBER')
     OR pg_has_role('authenticated', 'postgres', 'MEMBER') OR pg_has_role('authenticated', 'supabase_admin', 'MEMBER') THEN
    v_bad := v_bad || ' | anon / authenticated là thành viên của role còn giữ EXECUTE';
  END IF;
  SELECT count(*) INTO v_n
    FROM m118_acl_before b JOIN pg_catalog.pg_proc p ON p.oid = b.oid
   WHERE p.proacl::text IS DISTINCT FROM b.acl;
  IF v_n <> 0 THEN v_bad := v_bad || ' | ' || v_n || ' hàm KHÁC bị đổi ACL'; END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '118: hậu kiểm ĐỎ — rollback toàn bộ:%', v_bad;
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('118', 'sec1_acl_affirm', 'SEC-1 r2: khẳng định REVOKE EXECUTE PUBLIC/anon/authenticated trên 16 hàm SECDEF dành service_role (vá khẩn cấp 25/10 ngoài chuỗi)');

COMMIT;

-- ── VERIFY (chạy sau COMMIT, chỉ đọc) ───────────────────────────────────────
-- 1) Marker:  SELECT version, name FROM public.app_migrations WHERE version = '118';   -- 1 dòng
-- 2) Quyền 16 hàm: chạy `planning/research/dev-tools/sec1/sec1-verify.sql` (nhánh feat/crm-cskh) — 17 dòng, mọi ok = true,
--    dòng TỔNG `16/16 có mặt, 16/16 ok, 16 hàm mang 16 tên, membership xấu=false`.
-- 3) Tại chỗ (file trên `main`, không cần planning/):
--    SELECT p.oid::regprocedure AS fn,
--           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_bad,
--           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_bad,
--           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_ok,
--           (SELECT string_agg(g, ',' ORDER BY g) FROM (
--              SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END AS g
--                FROM aclexplode(p.proacl) x WHERE x.privilege_type = 'EXECUTE') s) AS holders
--      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--       AND p.proname IN ('replace_staff_referrals','replace_announcement_audience_assets','rpc_update_announcement',
--                         'rpc_bulk_request_resubmit','rpc_create_inventory_trf_items','rpc_create_fs_session',
--                         'rpc_fs_claim_session','rpc_fs_release_claim','rpc_fs_release_claim_self','rpc_fs_remove_item',
--                         'rpc_fs_update_item','rpc_fs_approve_item','rpc_fs_close_session','rpc_fs_resubmit_box',
--                         'rpc_fs_resubmit_items','rpc_fs_submit_item');
--    kỳ vọng đúng 16 dòng: false / false / true, holders = 'postgres,service_role,supabase_admin'.
-- 4) Membership (kỳ vọng mọi cột false):
--    SELECT pg_has_role('anon', 'service_role', 'MEMBER') AS a_svc, pg_has_role('anon', 'postgres', 'MEMBER') AS a_pg,
--           pg_has_role('anon', 'supabase_admin', 'MEMBER') AS a_adm, pg_has_role('authenticated', 'service_role', 'MEMBER') AS u_svc,
--           pg_has_role('authenticated', 'postgres', 'MEMBER') AS u_pg, pg_has_role('authenticated', 'supabase_admin', 'MEMBER') AS u_adm;
