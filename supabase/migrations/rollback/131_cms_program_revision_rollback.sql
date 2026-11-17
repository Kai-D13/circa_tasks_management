-- ============================================================================
-- rollback/131_cms_program_revision_rollback.sql  (CANDIDATE — sinh bằng webapp/scripts/gen-cms-131.mjs; KHÔNG sửa tay)
-- Gỡ 131 về đúng nền 130. Thứ tự: tắt cờ CMS_PROGRAM_REVISION_ENABLED → app về bản không gọi RPC revision → file này. DỪNG (không xoá
-- gì) nếu đã có revision COMMITTED / lưu trữ số trước sửa / SP retire: dữ liệu đó là lịch sử tài chính — sửa sai bằng revision bù, không
-- gỡ. Preview chưa ghi (previewed) bị bỏ cùng bảng. Khôi phục NGUYÊN VĂN 4 hàm thay (121 / 122 / 124 / 130) + policy đọc SP nền 120.
-- Gồm DELETE FROM app_migrations WHERE version = '131'. READ COMMITTED; đúng role owner; giữ LF.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.cms_programs, public.cms_program_products, public.cms_program_tiers, public.cms_sync_runs,
           public.cms_program_revisions, public.cms_program_revision_results IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_name text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'rollback 131: cần READ COMMITTED';
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '131';
  IF v_name IS DISTINCT FROM 'cms_program_revision' THEN
    RAISE EXCEPTION 'rollback 131: không có marker 131 cms_program_revision (name = %)', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 131) THEN
    RAISE EXCEPTION 'rollback 131: DB đã có migration số > 131 — gỡ bản sau trước';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r0 WHERE r0.rolname = current_user AND (r0.rolsuper OR r0.rolbypassrls)) THEN
    RAISE EXCEPTION 'rollback 131: role chạy (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE status = 'running') THEN
    RAISE EXCEPTION 'rollback 131: còn run đang chạy';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_program_revisions WHERE status = 'committed')
     OR EXISTS (SELECT 1 FROM public.cms_program_revision_results)
     OR EXISTS (SELECT 1 FROM public.cms_program_products WHERE retired_at IS NOT NULL OR retired_revision_id IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback 131: đã có revision committed / lưu trữ / SP retire — DỪNG, xử lý tiến (revision bù), không gỡ';
  END IF;
END $$;

-- Khôi phục NGUYÊN VĂN 4 hàm thay (thân gốc của migration đã chạy).
CREATE OR REPLACE FUNCTION public.cms__sales_snapshot(p_program_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'program_id', p.id,
    'status', p.status,
    'is_test', p.is_test,
    'config_version', p.config_version,
    'start_date', to_char(p.start_date, 'YYYY-MM-DD'),
    'end_date', to_char(p.end_date, 'YYYY-MM-DD'),
    'catalog_target_gmv', p.catalog_target_gmv::text,
    'today_vn', to_char(public.cms__vn_today(), 'YYYY-MM-DD'),
    'current_result_run_id', p.current_result_run_id,
    'previous_rows_read', (SELECT r.rows_read FROM public.cms_sync_runs r WHERE r.id = p.current_result_run_id),
    'store_ids', COALESCE((SELECT jsonb_agg(ps.store_id ORDER BY ps.store_id) FROM public.cms_program_stores ps
                            WHERE ps.program_id = p.id), '[]'::jsonb),
    'products', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', pp.id, 'product_id', pp.product_id, 'gmv_basis', pp.gmv_basis, 'target_gmv', pp.target_gmv::text,
        'base_quantity_cms', pp.base_quantity_cms::text, 'unit_cms', pp.unit_cms,
        'tiers', COALESCE((SELECT jsonb_agg(jsonb_build_object('order', t.tier_order, 'from', t.qty_from, 'to', t.qty_to,
                                                               'amount', t.amount_per_unit::text) ORDER BY t.tier_order)
                             FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id), '[]'::jsonb))
        ORDER BY pp.product_id) FROM public.cms_program_products pp WHERE pp.program_id = p.id), '[]'::jsonb),
    'sellers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'role', u.role, 'store_id', u.store_id)
                                          ORDER BY u.id) FROM public.users u), '[]'::jsonb),
    'stores', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'store_type', s.store_type, 'is_active', s.is_active)
                                         ORDER BY s.id) FROM public.stores s), '[]'::jsonb),
    'mapping_fp', public.cms__mapping_fp(),
    -- 130: chế độ của CHƯƠNG TRÌNH (run ghim riêng ở open); app cũ bỏ qua khoá lạ.
    'quantity_basis', p.quantity_basis, 'returns_policy', p.returns_policy)
  FROM public.cms_programs p WHERE p.id = p_program_id
$$;

CREATE OR REPLACE FUNCTION public.cms__conflicts(p_program_id uuid, p_is_test boolean, p_start date, p_end date, p_ids text[])
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT pp.product_id ORDER BY pp.product_id), '{}'::text[])
    FROM public.cms_program_products pp
    JOIN public.cms_programs o ON o.id = pp.program_id
   WHERE o.id <> p_program_id
     AND o.status IN ('active', 'locked')
     AND o.is_test = p_is_test
     AND o.start_date <= p_end AND o.end_date >= p_start
     AND pp.product_id = ANY (COALESCE(p_ids, '{}'::text[]))
$$;

CREATE OR REPLACE FUNCTION public.cms__program_scope_hash(p_program_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(sha256(convert_to(
           '[' || public.cms__fp_j('cms-rows-fp-v1') || ',' || public.cms__fp_j('scope') || ','
           || public.cms__fp_j(to_char(p.start_date, 'YYYY-MM-DD')) || ',' || public.cms__fp_j(to_char(p.end_date, 'YYYY-MM-DD')) || ',['
           || COALESCE((SELECT string_agg(public.cms__fp_j(x.product_id), ',' ORDER BY convert_to(x.product_id, 'UTF8'))
                          FROM (SELECT DISTINCT pp.product_id FROM public.cms_program_products pp WHERE pp.program_id = p.id) x), '')
           || ']]', 'UTF8')), 'hex')
    FROM public.cms_programs p WHERE p.id = p_program_id
$$;

CREATE OR REPLACE FUNCTION public.cms__result_run(p_program_id uuid, p_run_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cur uuid;
  v_run uuid;
BEGIN
  IF auth.uid() IS NULL OR p_program_id IS NULL OR NOT (p_program_id = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT current_result_run_id INTO v_cur FROM public.cms_programs WHERE id = p_program_id;
  v_run := COALESCE(p_run_id, v_cur);
  IF v_run IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM public.cms_sync_runs r
   WHERE r.id = v_run AND r.program_id = p_program_id AND r.kind = 'sales' AND r.status = 'ok' AND r.purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CMS_RESULT_RUN_GONE' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_run;
END;
$$;

DROP TRIGGER cms_revision_policy_guard ON public.cms_programs;
DROP FUNCTION public.cms__revision_policy_guard();
DROP FUNCTION public.rpc_cms_revision_capabilities();
DROP FUNCTION public.rpc_cms_program_revision_archive(uuid,integer,integer);
DROP FUNCTION public.rpc_cms_program_revision(uuid);
DROP FUNCTION public.rpc_cms_program_revisions(uuid);
DROP FUNCTION public.rpc_cms_program_revision_state(uuid);
DROP FUNCTION public.rpc_cms_program_revision_commit(uuid,integer,text,uuid,text,jsonb);
DROP FUNCTION public.rpc_cms_program_revision_preview(jsonb);
DROP FUNCTION public.cms__revision_diff(uuid,jsonb);
DROP FUNCTION public.cms__revision_norm(jsonb,jsonb);
DROP FUNCTION public.cms__revision_blocker(uuid);
DROP FUNCTION public.cms__revision_config(uuid);
DROP FUNCTION public.cms__revision_tiers(uuid);
ALTER POLICY cms_program_products_select ON public.cms_program_products
  USING (program_id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]));
ALTER TABLE public.cms_program_products DROP CONSTRAINT cms_program_products_retired;
ALTER TABLE public.cms_program_products DROP COLUMN retired_revision_id, DROP COLUMN retired_at;
DROP TABLE public.cms_program_revision_results;
DROP TABLE public.cms_program_revisions;
DROP FUNCTION public.cms__revision_results_guard();
DROP FUNCTION public.cms__revision_guard();
-- ACL 4 hàm khôi phục: chỉ owner (OR REPLACE giữ ACL — thu hồi lại cho chắc).
REVOKE ALL ON FUNCTION public.cms__sales_snapshot(uuid), public.cms__conflicts(uuid,boolean,date,date,text[]), public.cms__program_scope_hash(uuid), public.cms__result_run(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__sales_snapshot(uuid)')) IS DISTINCT FROM 'b8fc8150ff3d733f4a73b8a19dc22daa'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__conflicts(uuid,boolean,date,date,text[])')) IS DISTINCT FROM '216655ef1643470997c122c8b07452b6'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__program_scope_hash(uuid)')) IS DISTINCT FROM '8a4abd995e0a14fb55cb827a5c668a5e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__result_run(uuid,uuid)')) IS DISTINCT FROM '25bb3fdec9ac322765beaa0abdcd9686' THEN
    RAISE EXCEPTION 'rollback 131 hậu kiểm: thân 4 hàm khôi phục khác nền 120–130 (md5)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('cms__revision_guard', 'cms__revision_results_guard', 'cms__revision_policy_guard', 'cms__revision_tiers', 'cms__revision_config', 'cms__revision_blocker', 'cms__revision_norm', 'cms__revision_diff', 'rpc_cms_program_revision_preview', 'rpc_cms_program_revision_commit', 'rpc_cms_program_revision_state', 'rpc_cms_program_revisions', 'rpc_cms_program_revision', 'rpc_cms_program_revision_archive', 'rpc_cms_revision_capabilities'))
     OR to_regclass('public.cms_program_revisions') IS NOT NULL OR to_regclass('public.cms_program_revision_results') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = 'public.cms_program_products'::regclass
                  AND attname IN ('retired_at', 'retired_revision_id') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'rollback 131 hậu kiểm: còn đối tượng 131';
  END IF;
  IF (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_catalog.pg_policy p WHERE p.polrelid = 'public.cms_program_products'::regclass
        AND p.polname = 'cms_program_products_select')
     IS DISTINCT FROM '(program_id = ANY (( SELECT cms_readable_program_ids() AS cms_readable_program_ids)::uuid[]))' THEN
    RAISE EXCEPTION 'rollback 131 hậu kiểm: policy đọc SP khác nền 120';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
              WHERE p.oid IN (to_regprocedure('public.cms__sales_snapshot(uuid)'), to_regprocedure('public.cms__conflicts(uuid,boolean,date,date,text[])'), to_regprocedure('public.cms__program_scope_hash(uuid)'), to_regprocedure('public.cms__result_run(uuid,uuid)')) AND a.grantee <> p.proowner) THEN
    RAISE EXCEPTION 'rollback 131 hậu kiểm: 4 hàm khôi phục có grant ngoài owner';
  END IF;
END $$;

DELETE FROM public.app_migrations WHERE version = '131';

COMMIT;
