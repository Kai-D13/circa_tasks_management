-- ============================================================================
-- 089_prescription_search_precision.sql
-- RX-V2.9 - precision-first prescription search + match metadata.
--
-- Why: broad trigram search in 087 returned many "near" rows with no visible
-- reason. Staff could not tell which DHC actually contained the searched
-- product/note term. This replaces the paged RPC with:
--   - product_id: exact token only (<id> - ...)
--   - DHC: partial/near enough for order lookup
--   - product_name/note: exact/token first, fuzzy only at stricter thresholds
--   - match metadata so the UI can explain why a row appeared
--
-- RLS is unchanged here. 088 remains the permission boundary:
-- OS staff can view/search OS prescriptions; FS staff are blocked.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

DROP FUNCTION IF EXISTS public.rpc_search_prescriptions_page(
  text, text, integer, integer, text, uuid, text, text, boolean, date, timestamptz, timestamptz
);

CREATE FUNCTION public.rpc_search_prescriptions_page(
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

GRANT EXECUTE ON FUNCTION public.rpc_search_prescriptions_page(
  text, text, integer, integer, text, uuid, text, text, boolean, date, timestamptz, timestamptz
) TO authenticated;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('089', 'prescription_search_precision',
        'RX-V2.9: precision-first paged prescription search with match metadata; product_id exact, DHC partial, product/note stricter fuzzy.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT version, name FROM public.app_migrations WHERE version IN ('087','088','089') ORDER BY version;
-- SELECT p.oid::regprocedure AS signature, p.prosecdef
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname = 'rpc_search_prescriptions_page';
-- SELECT order_code, match_source, match_quality, match_text, match_score
-- FROM public.rpc_search_prescriptions_page('Bioprolol','all',12,0,NULL,NULL,NULL,NULL,false,current_date,NULL,NULL);
