-- ============================================================================
-- rollback/119_rx_search_page_stable_order_rollback.sql
-- Hoàn tác 119: khôi phục ĐÚNG thân 089 của public.rpc_search_prescriptions_page (md5 thân LF dd242f265d5f2ee8ecc7d291a4472f34), xoá marker 119.
-- Chỉ chạy khi PM quyết rollback (app EXP-1 vẫn chạy được trên thân 089 — export Toa có từ khoá có thể trả 409 khi trùng khoá ở
-- ranh trang). Không GRANT / REVOKE; hậu kiểm ACL + quyền gọi không đổi. Chạy bởi supabase_admin, dán NGUYÊN FILE.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ── 0. Preflight ───────────────────────────────────────────────────────────
DO $pre$
DECLARE
  f oid := to_regprocedure('public.rpc_search_prescriptions_page(text,text,integer,integer,text,uuid,text,text,boolean,date,timestamp with time zone,timestamp with time zone)');
BEGIN
  IF NOT (current_user = 'supabase_admin' OR (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)) THEN
    RAISE EXCEPTION '119rb: role chạy (%) không phải supabase_admin / superuser', current_user;
  END IF;
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION '119rb: sai database (%), kỳ vọng postgres', current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '119') THEN
    RAISE EXCEPTION '119rb: chưa có marker 119 — không có gì để hoàn tác';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE CASE WHEN version ~ '^[0-9]+$' THEN version::int END > 119) THEN
    RAISE EXCEPTION '119rb: DB đã có migration > 119 — dừng, báo PM';
  END IF;
  IF f IS NULL THEN
    RAISE EXCEPTION '119rb: không thấy public.rpc_search_prescriptions_page(text,text,integer,integer,text,uuid,text,text,boolean,date,timestamp with time zone,timestamp with time zone)';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rpc_search_prescriptions_page') <> 1 THEN
    RAISE EXCEPTION '119rb: rpc_search_prescriptions_page có overload — dừng';
  END IF;
  IF (SELECT p.prosecdef OR p.provolatile <> 's' OR pg_catalog.pg_get_userbyid(p.proowner) <> 'supabase_admin'
             OR p.proconfig::text IS DISTINCT FROM '{"search_path=public, extensions"}'
        FROM pg_catalog.pg_proc p WHERE p.oid = f) THEN
    RAISE EXCEPTION '119rb: thuộc tính hàm lệch hồ sơ (kỳ vọng SECURITY INVOKER, STABLE, owner supabase_admin, search_path=public, extensions)';
  END IF;
  -- So thân hàm sau khi bỏ \r (Studio có thể lưu CRLF): lệch ⇒ prod không còn là bản hồ sơ — dừng, báo PM.
  IF (SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_catalog.pg_proc p WHERE p.oid = f) <> '1721d857a5edc466611418b738e8d4c5' THEN
    RAISE EXCEPTION '119rb: thân hàm hiện tại lệch hồ sơ (md5 kỳ vọng 1721d857a5edc466611418b738e8d4c5) — dừng, báo PM';
  END IF;
  -- ACL + chữ ký đầy đủ + thuộc tính phải đúng hồ sơ — lệch ⇒ không tự sửa, dừng, báo PM.
  IF (SELECT p.proacl::text FROM pg_catalog.pg_proc p WHERE p.oid = f) IS DISTINCT FROM '{=X/supabase_admin,supabase_admin=X/supabase_admin,postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}' THEN
    RAISE EXCEPTION '119rb: ACL hiện tại lệch hồ sơ — dừng, báo PM';
  END IF;
  IF (SELECT md5(pg_catalog.pg_get_function_arguments(p.oid)) <> '86b5648a53b033cdc0be56b4f5b4097e'
             OR md5(pg_catalog.pg_get_function_result(p.oid)) <> 'cee6cc2ab4fd14e8265fe821a0326337'
             OR p.procost <> 100 OR p.prorows <> 1000 OR p.proparallel <> 'u' OR p.proisstrict OR p.proleakproof
             OR NOT p.proretset OR p.prokind <> 'f'
        FROM pg_catalog.pg_proc p WHERE p.oid = f) THEN
    RAISE EXCEPTION '119rb: chữ ký (đối số / DEFAULT / kiểu trả về) hoặc COST / ROWS / PARALLEL / STRICT / LEAKPROOF lệch hồ sơ — dừng, báo PM';
  END IF;
END
$pre$;

-- Ảnh ACL mọi hàm public, quyền hiệu lực 4 role và chữ ký + thuộc tính của hàm — hậu kiểm phải giống hệt (chỉ thân hàm đổi).
CREATE TEMP TABLE m119rb_acl_before ON COMMIT DROP AS
  SELECT p.oid, p.proacl::text AS acl FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
CREATE TEMP TABLE m119rb_priv_before ON COMMIT DROP AS
  SELECT r.rolname, has_function_privilege(r.rolname, to_regprocedure('public.rpc_search_prescriptions_page(text,text,integer,integer,text,uuid,text,text,boolean,date,timestamp with time zone,timestamp with time zone)'), 'EXECUTE') AS x
    FROM (VALUES ('anon'), ('authenticated'), ('service_role'), ('postgres')) r(rolname);
CREATE TEMP TABLE m119rb_sig_before ON COMMIT DROP AS
  SELECT pg_catalog.pg_get_function_arguments(p.oid) AS args, pg_catalog.pg_get_function_result(p.oid) AS res, p.procost, p.prorows,
         p.proparallel, p.proisstrict, p.proleakproof, p.proretset, p.prokind, p.prosecdef, p.provolatile, p.proconfig::text AS cfg, p.proowner
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.rpc_search_prescriptions_page(text,text,integer,integer,text,uuid,text,text,boolean,date,timestamp with time zone,timestamp with time zone)');

-- ── 1. Khôi phục thân 089 ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_search_prescriptions_page(
  p_q          text,
  p_by         text        DEFAULT 'all',
  p_limit      integer     DEFAULT 50,
  p_offset     integer     DEFAULT 0,
  p_order_sync text        DEFAULT NULL,
  p_store_id   uuid        DEFAULT NULL,
  p_care       text        DEFAULT NULL,
  p_care_state text        DEFAULT NULL,
  p_owner_only boolean     DEFAULT false,
  p_today      date        DEFAULT CURRENT_DATE,
  p_date_from  timestamptz DEFAULT NULL,
  p_date_to    timestamptz DEFAULT NULL
) RETURNS TABLE (
  id                   uuid,
  order_code           text,
  submitted_at         timestamptz,
  status               text,
  is_chronic           boolean,
  order_sync_status    text,
  care_status          text,
  reminder_date        date,
  expected_refill_date date,
  order_created_at     date,
  days_supply          integer,
  customer_name        text,
  customer_phone       text,
  notes                text,
  order_products_raw   text,
  store_name           text,
  submitter_full_name  text,
  image_count          bigint,
  image_paths          text[],
  total_count          bigint,
  match_source         text,
  match_quality        text,
  match_text           text,
  match_score          numeric
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, extensions
AS $$
  WITH q AS (
    SELECT
      left(unaccent(lower(trim(coalesce(p_q, '')))), 100)               AS nq,
      regexp_replace(left(trim(coalesce(p_q, '')), 100), '\D', '', 'g') AS qdigits,
      CASE WHEN p_by IN ('order', 'product', 'note') THEN p_by ELSE 'all' END AS nby,
      least(greatest(coalesce(p_limit, 50), 1), 501)                    AS lim,
      greatest(coalesce(p_offset, 0), 0)                                AS off
  ), c AS (
    SELECT
      q.nq,
      q.qdigits,
      q.nby,
      q.lim,
      q.off,
      replace(replace(replace(q.nq, '\', '\\'), '%', '\%'), '_', '\_') AS nq_like,
      (q.nq ~ '^[0-9]+$' AND length(q.nq) BETWEEN 3 AND 12)            AS is_pid,
      (q.nq LIKE 'dhc%')                                                AS is_dhc,
      (q.nq ~ '[a-z]')                                                  AS has_alpha,
      ARRAY(
        SELECT tok
        FROM regexp_split_to_table(q.nq, '[^[:alnum:]]+') AS tok
        WHERE length(tok) >= 3
      ) AS tokens
    FROM q
  ), scored AS (
    SELECT
      s.id,
      s.order_code,
      s.submitted_at,
      s.status,
      s.is_chronic,
      s.order_sync_status,
      s.care_status,
      s.reminder_date,
      s.expected_refill_date,
      s.order_created_at,
      s.days_supply,
      s.customer_name,
      s.customer_phone,
      s.notes,
      s.order_products_raw,
      st.name AS store_name,
      u.full_name AS submitter_full_name,
      COALESCE((
        SELECT count(*)::bigint
        FROM public.prescription_images pi
        WHERE pi.submission_id = s.id
      ), 0) AS image_count,
      COALESCE((
        SELECT array_agg(pi.storage_path ORDER BY pi.created_at)
        FROM public.prescription_images pi
        WHERE pi.submission_id = s.id
      ), ARRAY[]::text[]) AS image_paths,
      r.match_source,
      r.match_quality,
      r.match_text,
      r.match_score,
      c.lim,
      c.off
    FROM public.prescription_submissions s
    CROSS JOIN c
    LEFT JOIN public.stores st ON st.id = s.store_id
    LEFT JOIN public.users u ON u.id = s.submitted_by
    CROSS JOIN LATERAL (
      SELECT
        unaccent(lower(coalesce(s.order_products_raw, ''))) AS products_norm,
        unaccent(lower(coalesce(s.notes, '')))              AS notes_norm
    ) norm
    CROSS JOIN LATERAL (
      SELECT
        (c.nby IN ('all', 'order') AND (
          (c.is_dhc AND lower(s.order_code) LIKE '%' || c.nq_like || '%' ESCAPE '\')
          OR (NOT c.has_alpha AND length(c.qdigits) >= 6
              AND regexp_replace(s.order_code, '\D', '', 'g') LIKE '%' || c.qdigits || '%')
        )) AS order_match,
        (c.nby IN ('all', 'product') AND c.is_pid
          AND s.order_products_raw IS NOT NULL
          AND s.order_products_raw ~ ('(^|[^0-9])' || c.qdigits || '[[:space:]]*-')
        ) AS product_id_match,
        (c.nby IN ('all', 'product') AND c.has_alpha AND NOT c.is_dhc
          AND s.order_products_raw IS NOT NULL
          AND norm.products_norm LIKE '%' || c.nq_like || '%' ESCAPE '\'
        ) AS product_exact_match,
        (c.nby IN ('all', 'product') AND c.has_alpha AND NOT c.is_dhc
          AND s.order_products_raw IS NOT NULL
          AND cardinality(c.tokens) > 0
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(c.tokens) AS tok
            WHERE norm.products_norm NOT LIKE '%' || tok || '%'
          )
        ) AS product_token_match,
        (c.nby IN ('all', 'product') AND c.has_alpha AND NOT c.is_dhc
          AND s.order_products_raw IS NOT NULL
          AND length(c.nq) >= 5
          AND cardinality(c.tokens) BETWEEN 1 AND 3
          AND strict_word_similarity(c.nq, norm.products_norm) >= 0.72
        ) AS product_fuzzy_match,
        (c.nby IN ('all', 'note') AND c.has_alpha AND NOT c.is_dhc
          AND s.notes IS NOT NULL
          AND norm.notes_norm LIKE '%' || c.nq_like || '%' ESCAPE '\'
        ) AS note_exact_match,
        (c.nby IN ('all', 'note') AND c.has_alpha AND NOT c.is_dhc
          AND s.notes IS NOT NULL
          AND cardinality(c.tokens) > 0
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(c.tokens) AS tok
            WHERE norm.notes_norm NOT LIKE '%' || tok || '%'
          )
        ) AS note_token_match,
        (c.nby IN ('all', 'note') AND c.has_alpha AND NOT c.is_dhc
          AND s.notes IS NOT NULL
          AND length(c.nq) >= 6
          AND cardinality(c.tokens) BETWEEN 1 AND 3
          AND strict_word_similarity(c.nq, norm.notes_norm) >= 0.78
        ) AS note_fuzzy_match
    ) m
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN m.product_id_match THEN 'product_id'
          WHEN m.order_match THEN 'order'
          WHEN m.product_exact_match OR m.product_token_match OR m.product_fuzzy_match THEN 'product'
          WHEN m.note_exact_match OR m.note_token_match OR m.note_fuzzy_match THEN 'note'
          ELSE NULL
        END AS match_source,
        CASE
          WHEN m.product_id_match OR m.order_match OR m.product_exact_match OR m.note_exact_match THEN 'exact'
          WHEN m.product_token_match OR m.note_token_match THEN 'token'
          WHEN m.product_fuzzy_match OR m.note_fuzzy_match THEN 'fuzzy'
          ELSE NULL
        END AS match_quality,
        CASE
          WHEN m.order_match THEN s.order_code
          WHEN m.product_id_match OR m.product_exact_match OR m.product_token_match OR m.product_fuzzy_match
            THEN left(regexp_replace(coalesce(s.order_products_raw, ''), '\s+', ' ', 'g'), 260)
          WHEN m.note_exact_match OR m.note_token_match OR m.note_fuzzy_match
            THEN left(regexp_replace(coalesce(s.notes, ''), '\s+', ' ', 'g'), 260)
          ELSE NULL
        END AS match_text,
        GREATEST(
          CASE WHEN m.product_id_match THEN 0.98::numeric ELSE 0 END,
          CASE WHEN m.order_match THEN 0.92::numeric ELSE 0 END,
          CASE WHEN m.product_exact_match THEN 0.86::numeric ELSE 0 END,
          CASE WHEN m.note_exact_match THEN 0.80::numeric ELSE 0 END,
          CASE WHEN m.product_token_match THEN 0.74::numeric ELSE 0 END,
          CASE WHEN m.note_token_match THEN 0.68::numeric ELSE 0 END,
          CASE WHEN m.product_fuzzy_match THEN 0.56::numeric ELSE 0 END,
          CASE WHEN m.note_fuzzy_match THEN 0.48::numeric ELSE 0 END
        ) AS match_score
    ) r
    WHERE length(c.nq) >= 1
      AND (p_order_sync IS NULL OR p_order_sync NOT IN ('pending','synced','error') OR s.order_sync_status = p_order_sync)
      AND (p_store_id IS NULL OR s.store_id = p_store_id)
      AND (p_date_from IS NULL OR s.submitted_at >= p_date_from)
      AND (p_date_to IS NULL OR s.submitted_at <= p_date_to)
      AND (NOT p_owner_only OR s.submitted_by = auth.uid())
      AND (p_care IS DISTINCT FROM 'chronic' OR s.is_chronic = true)
      AND (
        p_care_state IS NULL
        OR p_care_state NOT IN ('due','done')
        OR (p_care_state = 'due'  AND s.is_chronic = true AND s.order_sync_status = 'synced' AND s.care_status = 'none' AND s.reminder_date <= coalesce(p_today, CURRENT_DATE))
        OR (p_care_state = 'done' AND s.is_chronic = true AND s.care_status = 'done')
      )
      AND (
        m.order_match
        OR m.product_id_match
        OR m.product_exact_match
        OR m.product_token_match
        OR m.product_fuzzy_match
        OR m.note_exact_match
        OR m.note_token_match
        OR m.note_fuzzy_match
      )
  ), paged AS (
    SELECT scored.*, count(*) OVER()::bigint AS total_count
    FROM scored
    ORDER BY match_score DESC, submitted_at DESC
    LIMIT (SELECT lim FROM c)
    OFFSET (SELECT off FROM c)
  )
  SELECT
    paged.id,
    paged.order_code,
    paged.submitted_at,
    paged.status,
    paged.is_chronic,
    paged.order_sync_status,
    paged.care_status,
    paged.reminder_date,
    paged.expected_refill_date,
    paged.order_created_at,
    paged.days_supply,
    paged.customer_name,
    paged.customer_phone,
    paged.notes,
    paged.order_products_raw,
    paged.store_name,
    paged.submitter_full_name,
    paged.image_count,
    paged.image_paths,
    paged.total_count,
    paged.match_source,
    paged.match_quality,
    paged.match_text,
    paged.match_score
  FROM paged;
$$;

-- ── 2. Hậu kiểm trong transaction ───────────────────────────────────────────
DO $post$
DECLARE
  f oid := to_regprocedure('public.rpc_search_prescriptions_page(text,text,integer,integer,text,uuid,text,text,boolean,date,timestamp with time zone,timestamp with time zone)');
  v_bad text := '';
  v_n int;
BEGIN
  IF f IS NULL THEN RAISE EXCEPTION '119rb: hậu kiểm — mất hàm'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rpc_search_prescriptions_page') <> 1 THEN
    v_bad := v_bad || ' | có overload';
  END IF;
  IF (SELECT p.prosecdef OR p.provolatile <> 's' OR pg_catalog.pg_get_userbyid(p.proowner) <> 'supabase_admin'
             OR p.proconfig::text IS DISTINCT FROM '{"search_path=public, extensions"}'
        FROM pg_catalog.pg_proc p WHERE p.oid = f) THEN
    v_bad := v_bad || ' | thuộc tính hàm đổi';
  END IF;
  IF (SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_catalog.pg_proc p WHERE p.oid = f) <> 'dd242f265d5f2ee8ecc7d291a4472f34' THEN
    v_bad := v_bad || ' | thân hàm không đúng bản kỳ vọng (md5 dd242f265d5f2ee8ecc7d291a4472f34)';
  END IF;
  SELECT count(*) INTO v_n FROM m119rb_acl_before b JOIN pg_catalog.pg_proc p ON p.oid = b.oid WHERE p.proacl::text IS DISTINCT FROM b.acl;
  IF v_n <> 0 THEN v_bad := v_bad || ' | ' || v_n || ' hàm đổi ACL'; END IF;
  SELECT count(*) INTO v_n FROM m119rb_priv_before b WHERE has_function_privilege(b.rolname, f, 'EXECUTE') IS DISTINCT FROM b.x;
  IF v_n <> 0 THEN v_bad := v_bad || ' | quyền gọi hiệu lực đổi ở ' || v_n || ' role'; END IF;
  IF EXISTS (SELECT 1 FROM m119rb_sig_before b, pg_catalog.pg_proc p WHERE p.oid = f AND (
        b.args IS DISTINCT FROM pg_catalog.pg_get_function_arguments(p.oid) OR b.res IS DISTINCT FROM pg_catalog.pg_get_function_result(p.oid)
        OR b.procost IS DISTINCT FROM p.procost OR b.prorows IS DISTINCT FROM p.prorows OR b.proparallel IS DISTINCT FROM p.proparallel
        OR b.proisstrict IS DISTINCT FROM p.proisstrict OR b.proleakproof IS DISTINCT FROM p.proleakproof OR b.proretset IS DISTINCT FROM p.proretset
        OR b.prokind IS DISTINCT FROM p.prokind OR b.prosecdef IS DISTINCT FROM p.prosecdef OR b.provolatile IS DISTINCT FROM p.provolatile
        OR b.cfg IS DISTINCT FROM p.proconfig::text OR b.proowner IS DISTINCT FROM p.proowner)) THEN
    v_bad := v_bad || ' | chữ ký / thuộc tính hàm đổi (đối số, DEFAULT, kiểu trả về, COST, ROWS, PARALLEL, STRICT, LEAKPROOF, owner …)';
  END IF;
  IF v_bad <> '' THEN RAISE EXCEPTION '119rb: hậu kiểm ĐỎ — rollback toàn bộ:%', v_bad; END IF;
END
$post$;

DELETE FROM public.app_migrations WHERE version = '119';

COMMIT;

-- ── VERIFY (chạy sau COMMIT, chỉ đọc) ───────────────────────────────────────
-- 1) Marker:  SELECT count(*) FROM public.app_migrations WHERE version = '119';   -- 0
-- 2) Thân + chữ ký + thuộc tính + quyền:
--    SELECT md5(replace(p.prosrc, E'\r', '')) AS body_md5, md5(pg_get_function_arguments(p.oid)) AS args_md5,
--           md5(pg_get_function_result(p.oid)) AS res_md5, p.prosecdef, p.provolatile, p.proconfig, p.procost, p.prorows,
--           p.proparallel, p.proisstrict, p.proleakproof, p.proretset, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
--           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
--           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x, has_function_privilege('postgres', p.oid, 'EXECUTE') AS pg_x
--      FROM pg_proc p WHERE p.oid = 'public.rpc_search_prescriptions_page(text,text,integer,integer,text,uuid,text,text,boolean,date,timestamp with time zone,timestamp with time zone)'::regprocedure;
--    kỳ vọng body_md5 = dd242f265d5f2ee8ecc7d291a4472f34 (089), args_md5 = 86b5648a53b033cdc0be56b4f5b4097e, res_md5 = cee6cc2ab4fd14e8265fe821a0326337, prosecdef = false, provolatile = 's',
--    procost = 100, prorows = 1000, proparallel = 'u', proisstrict = false, proleakproof = false, proretset = true,
--    owner = supabase_admin, acl + 4 quyền giống hệt trước rollback (lưu 4 cột *_x vào report — AGENTS §4.2).
--    Rollback ghi thân dạng LF (prod trước đó lưu CRLF) ⇒ chỉ so md5 sau replace(prosrc, E'\r', ''), KHÔNG so md5 thô.
