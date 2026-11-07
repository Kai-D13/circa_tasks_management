
-- ── 2. ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — áp cả hàm OR REPLACE) ──
REVOKE ALL ON FUNCTION public.cms__results_release_open(), public.rpc_cms_sales_run_publish(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_publish(uuid) TO service_role;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1 / 091 / 117 / 120–125).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.oid IN ('public.cms__results_release_open()'::regprocedure, 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure)
       AND x.grantee <> p.proowner
       AND NOT (p.proname = 'rpc_cms_sales_run_publish' AND x.grantee = 'service_role'::regrole::oid)
     GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 3. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  r   record;
  v_n integer;
BEGIN
  v_n := 0;
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig, p.provolatile,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ','
                              ORDER BY CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END, x.privilege_type)
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl,
           has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
           has_function_privilege('service_role', p.oid, 'EXECUTE') s
      FROM pg_catalog.pg_proc p
     WHERE p.oid IN ('public.cms__results_release_open()'::regprocedure, 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure)
  LOOP
    v_n := v_n + 1;
    IF r.a OR r.u OR NOT r.prosecdef OR NOT ('search_path=public' = ANY (COALESCE(r.proconfig, '{}')))
       OR r.acl IS DISTINCT FROM (CASE WHEN r.proname LIKE 'rpc\_%' THEN 'service_role:EXECUTE' END)
       OR r.s IS DISTINCT FROM (r.proname LIKE 'rpc\_%')
       OR (r.proname LIKE 'rpc\_%' AND (NOT ('lock_timeout=5s' = ANY (COALESCE(r.proconfig, '{}'))) OR r.provolatile <> 'v'))
       OR (r.proname = 'cms__results_release_open' AND (r.provolatile <> 'i' OR cardinality(r.proconfig) <> 1)) THEN
      RAISE EXCEPTION '126 hậu kiểm: ACL / SECDEF / search_path / lock_timeout / volatility hàm % sai (acl %, config %)', r.proname, r.acl, r.proconfig;
    END IF;
  END LOOP;
  IF v_n <> 2 THEN RAISE EXCEPTION '126 hậu kiểm: cần đúng 2 hàm thay OR REPLACE, có %', v_n; END IF;
  -- Tổng hàm CMS không đổi: 68 như sau 125 (126 chỉ thay thân).
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\_%' OR proname LIKE 'rpc\_cms\_%');
  IF v_n <> 68 THEN RAISE EXCEPTION '126 hậu kiểm: tổng hàm CMS phải 68 (như 125), có %', v_n; END IF;
  -- Cổng kết quả bán mở; policy chốt thật VẪN đóng (126 không mở chốt / chi trả thật).
  IF public.cms__results_release_open() IS DISTINCT FROM true THEN
    RAISE EXCEPTION '126 hậu kiểm: cổng cms__results_release_open() chưa mở';
  END IF;
  IF (public.cms__lock_policy() -> 'real' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION '126 hậu kiểm: policy chốt thật không được mở';
  END IF;
END $$;
-- Thân 2 hàm thay phải đúng bản sinh (md5) — khối sinh bởi gen-cms-126.mjs.
-- @@POST_MD5@@

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('126', 'cms_sales_only_results_release', 'PM 06/11 sales-only: cổng kết quả bán tạm tính mở (cms__results_release_open = true); '
  || 'publish chương trình thật chặn điều chỉnh / ứng viên âm (RETURNS_NOT_SUPPORTED_THIS_PHASE) + đóng dấu results_basis sales_only_v1; '
  || 'trả hàng (Q-206) phase sau; policy chốt thật giữ false · inventory ' || current_setting('cms126.inventory'));

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — `node scripts/cms-verify.mjs post --phase=126 --pre=<PRE chụp NGAY TRƯỚC 126>`) ──
-- Sau 126, cms-verify phase 125 ĐỎ đúng thiết kế (md5 2 hàm 122 thay, cổng mở) ⇒ manifest VERIFY phase 126 (CMS_FN_SRC_126 sinh bằng
-- scripts/gen-cms-verify-fp-126.mjs từ file migration).
-- V1 marker:
--   SELECT version, name, notes FROM public.app_migrations WHERE version IN ('125', '126') ORDER BY 1;
--   -- 125 cms_uncapped_last_tier · 126 cms_sales_only_results_release (notes: inventory số đếm)
-- V2 ACL 2 hàm:
--   SELECT p.oid::regprocedure fn, p.prosecdef, p.provolatile, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') authn, has_function_privilege('service_role', p.oid, 'EXECUTE') svc
--     FROM pg_proc p WHERE p.oid IN ('public.cms__results_release_open()'::regprocedure, 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure);
--   -- 2 dòng; anon / authn f; svc f helper, t publish; prosecdef t; helper i, publish v + lock_timeout=5s; search_path=public
-- V3 cổng + policy:
--   SELECT public.cms__results_release_open() AS release_open, public.cms__lock_policy() -> 'real' ->> 'ready' AS real_ready;  -- t · false
-- V4 run thật đã công bố sau 126 mang căn cứ (kỳ vọng 0 dòng thiếu dấu):
--   SELECT r.id FROM public.cms_sync_runs r JOIN public.app_migrations m ON m.version = '126'
--    WHERE r.kind = 'sales' AND NOT r.is_test AND r.published_at > m.applied_at
--      AND (r.detail ->> 'results_basis') IS DISTINCT FROM 'sales_only_v1';
-- V5 thân hàm / định nghĩa / bảng / trigger: `node scripts/cms-verify.mjs post --phase=126`.
