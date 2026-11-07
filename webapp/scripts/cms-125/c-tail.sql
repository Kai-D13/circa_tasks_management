
-- ── 3. Chuyển đổi cấu hình CHƯA CHỐT có bậc cuối hữu hạn ───────────────────
-- Guard ở §2 đã tồn tại ⇒ chính câu chuyển đổi cũng bị guard kiểm lúc COMMIT. 'locked' không đụng (guard 123 cũng chặn).
DO $$
DECLARE
  v_ids   uuid[];
  v_tiers integer := 0;
  v_progs integer := 0;
  v_ptr   integer := 0;
BEGIN
  SELECT COALESCE(array_agg(g.id ORDER BY g.id), '{}'::uuid[]) INTO v_ids
    FROM public.cms_programs g
   WHERE g.status IN ('draft', 'active')
     AND EXISTS (SELECT 1 FROM public.cms_program_products pp
                  WHERE pp.program_id = g.id
                    AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                          ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL);
  IF cardinality(v_ids) > 0 THEN
    -- Khoá dòng chương trình theo thứ tự id (RPC 121 / 123 cũng khoá dòng chương trình trước khi ghi bậc / chốt).
    PERFORM 1 FROM public.cms_programs WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
    -- Kiểm lại sau khoá (câu lệnh mới ⇒ bản mới nhất): không run bán đang chạy của chương trình bị đổi.
    IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND status = 'running' AND program_id = ANY (v_ids)) THEN
      RAISE EXCEPTION '125: run bán đang chạy trên chương trình cần chuyển đổi — dừng';
    END IF;
    -- Chỉ cận trên của bậc CUỐI → NULL; bậc trước / mức tiền / số bậc giữ nguyên.
    UPDATE public.cms_program_tiers t SET qty_to = NULL
      FROM (SELECT DISTINCT ON (x.program_product_id) x.program_product_id, x.tier_order, x.qty_to
              FROM public.cms_program_tiers x WHERE x.program_id = ANY (v_ids)
             ORDER BY x.program_product_id, x.tier_order DESC) l
     WHERE t.program_product_id = l.program_product_id AND t.tier_order = l.tier_order AND l.qty_to IS NOT NULL;
    GET DIAGNOSTICS v_tiers = ROW_COUNT;
    SELECT count(*) INTO v_ptr FROM public.cms_programs WHERE id = ANY (v_ids) AND current_result_run_id IS NOT NULL;
    -- Trigger pointer 122 cấm pointer NULL ⇒ tắt TẠM đúng một câu (đang giữ SHARE ROW EXCLUSIVE bảng chương trình từ đầu).
    ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard;
    UPDATE public.cms_programs
       SET config_version = config_version + 1, current_result_run_id = NULL, updated_at = now(), updated_by = NULL
     WHERE id = ANY (v_ids);
    GET DIAGNOSTICS v_progs = ROW_COUNT;
    ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard;
  END IF;
  PERFORM set_config('cms125.converted', jsonb_build_object('programs', v_progs, 'last_tiers', v_tiers, 'pointers_cleared', v_ptr)::text, true);
  RAISE NOTICE '125 chuyển đổi: %', current_setting('cms125.converted');
END $$;

-- ── 4. ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — áp cả hàm OR REPLACE) ──
REVOKE ALL ON FUNCTION public.cms__tiers_last_open_guard(), public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid),
  public.rpc_cms_program_activate(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid), public.rpc_cms_program_activate(uuid, uuid)
  TO service_role;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120–124).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__tiers_last_open_guard', 'rpc_cms_import_commit', 'rpc_cms_program_activate')
       AND x.grantee <> p.proowner
       AND NOT (p.proname IN ('rpc_cms_import_commit', 'rpc_cms_program_activate') AND x.grantee = 'service_role'::regrole::oid)
     GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 5. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  v_n := 0;
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ','
                              ORDER BY CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END, x.privilege_type)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
           has_function_privilege('service_role', p.oid, 'EXECUTE') s
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__tiers_last_open_guard', 'rpc_cms_import_commit', 'rpc_cms_program_activate')
  LOOP
    v_n := v_n + 1;
    IF r.a OR r.u OR NOT r.prosecdef OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.acl IS DISTINCT FROM (CASE WHEN r.proname LIKE 'rpc\_%' THEN 'service_role:EXECUTE' END)
       OR r.s IS DISTINCT FROM (r.proname LIKE 'rpc\_%')
       OR (r.proname LIKE 'rpc\_%' AND NOT ('lock_timeout=5s' = ANY (COALESCE(r.proconfig, '{}')))) THEN
      RAISE EXCEPTION '125 hậu kiểm: ACL / SECDEF / search_path / lock_timeout hàm % sai (acl %, config %)', r.proname, r.acl, r.proconfig;
    END IF;
  END LOOP;
  IF v_n <> 3 THEN RAISE EXCEPTION '125 hậu kiểm: cần đúng 3 hàm 125 (1 mới + 2 thay OR REPLACE), có %', v_n; END IF;
  -- Tổng hàm CMS: 67 sau 124 + 1 (guard).
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 68 THEN RAISE EXCEPTION '125 hậu kiểm: tổng hàm CMS phải 68, có %', v_n; END IF;
  -- Guard: đúng 1 constraint trigger, hàm, DEFERRABLE INITIALLY DEFERRED, ENABLE ALWAYS, AFTER ROW INSERT / UPDATE / DELETE
  -- (tgtype = ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16 = 29).
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_program_tiers'::regclass AND t.tgname = 'cms_tiers_last_open' AND NOT t.tgisinternal
         AND t.tgenabled = 'A' AND t.tgdeferrable AND t.tginitdeferred AND t.tgconstraint <> 0 AND t.tgtype = 29
         AND t.tgfoid = 'public.cms__tiers_last_open_guard()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '125 hậu kiểm: constraint trigger cms_tiers_last_open sai (hàm / deferred / ALWAYS / sự kiện)';
  END IF;
  -- Trigger pointer 122 đã bật lại đúng chế độ origin.
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_programs_result_guard' AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.cms__programs_result_guard()'::regprocedure) <> 1 THEN
    RAISE EXCEPTION '125 hậu kiểm: trigger pointer cms_programs_result_guard chưa bật lại đúng chế độ 122';
  END IF;
  -- Bất biến: cấu hình CHƯA CHỐT không còn bậc cuối hữu hạn.
  IF EXISTS (SELECT 1 FROM public.cms_programs g JOIN public.cms_program_products pp ON pp.program_id = g.id
              WHERE g.status IN ('draft', 'active')
                AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                      ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL) THEN
    RAISE EXCEPTION '125 hậu kiểm: còn cấu hình chưa chốt có bậc cuối hữu hạn';
  END IF;
  -- Bất biến: run HIỆN HÀNH của chương trình chưa chốt không mang trần (chương trình bị đổi đã mất pointer; còn lại vốn cuối NULL).
  IF EXISTS (SELECT 1 FROM public.cms_programs g JOIN public.cms_results res ON res.run_id = g.current_result_run_id
              WHERE g.status IN ('draft', 'active') AND (res.cap_quantity IS NOT NULL OR res.at_cap))
     OR EXISTS (SELECT 1 FROM public.cms_programs g JOIN public.cms_result_lines rl ON rl.run_id = g.current_result_run_id
                 WHERE g.status IN ('draft', 'active') AND rl.status = 'AT_CAP') THEN
    RAISE EXCEPTION '125 hậu kiểm: run hiện hành của chương trình chưa chốt còn trần / AT_CAP';
  END IF;
  -- Cổng thật vẫn đóng (125 không mở cổng / policy).
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false OR public.cms__results_release_open() THEN
    RAISE EXCEPTION '125 hậu kiểm: policy thật / cổng Q-206 không được mở';
  END IF;
END $$;
-- Thân 2 RPC thay phải đúng bản sinh (md5) — khối sinh bởi gen-cms-125.mjs.
-- @@POST_MD5@@

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('125', 'cms_uncapped_last_tier', 'CMS-Q-220 (thay Q-210a): bỏ trần — bậc cuối không giới hạn; import / kích hoạt + constraint trigger cms_tiers_last_open; chuyển đổi chưa chốt '
  || current_setting('cms125.converted') || ' · inventory trước chuyển đổi ' || current_setting('cms125.inventory'));

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — `node scripts/cms-verify.mjs post --phase=125 --pre=<PRE chụp NGAY TRƯỚC 125>`) ──
-- Sau 125, cms-verify phase 124 ĐỎ đúng thiết kế (md5 2 RPC 121 thay, +1 hàm, +1 trigger, ràng buộc trigger trên cms_program_tiers)
-- ⇒ manifest VERIFY phase 125 (CMS_FN_SRC_125 / CMS_TRIGGERS_125 / shape tiers sinh bằng scripts/gen-cms-verify-fp-125.mjs).
-- V1 marker:
--   SELECT version, name, notes FROM public.app_migrations WHERE version IN ('124', '125') ORDER BY 1;
--   -- 124 cms_source_attestation · 125 cms_uncapped_last_tier (notes: số chương trình / bậc / pointer đã chuyển đổi)
-- V2 ACL 3 hàm:
--   SELECT p.oid::regprocedure fn, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') authn, has_function_privilege('service_role', p.oid, 'EXECUTE') svc
--     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('cms__tiers_last_open_guard', 'rpc_cms_import_commit', 'rpc_cms_program_activate') ORDER BY 1;
--   -- 3 dòng; anon / authn f; svc t đúng 2 RPC; prosecdef t; search_path=public; RPC ∋ lock_timeout=5s
-- V3 guard + pointer trigger:
--   SELECT t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred, pg_get_triggerdef(t.oid) FROM pg_trigger t
--    WHERE t.tgrelid IN ('public.cms_program_tiers'::regclass, 'public.cms_programs'::regclass)
--      AND t.tgname IN ('cms_tiers_last_open', 'cms_programs_result_guard') ORDER BY 1;   -- A t t · O f f
-- V4 bất biến (kỳ vọng 0 dòng):
--   SELECT g.id FROM public.cms_programs g JOIN public.cms_program_products pp ON pp.program_id = g.id
--    WHERE g.status IN ('draft', 'active')
--      AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL;
--   SELECT g.id FROM public.cms_programs g JOIN public.cms_results r ON r.run_id = g.current_result_run_id
--    WHERE g.status IN ('draft', 'active') AND (r.cap_quantity IS NOT NULL OR r.at_cap);
-- V5 thân hàm / định nghĩa / bảng / trigger: `node scripts/cms-verify.mjs post --phase=125` (CMS_FN_MATRIX + CMS_FN_SRC_125 sinh
--   từ file migration bằng scripts/gen-cms-verify-fp-125.mjs — không bao giờ từ DB cần kiểm).
