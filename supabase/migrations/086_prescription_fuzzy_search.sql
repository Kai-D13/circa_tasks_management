-- ============================================================================
-- 086_prescription_fuzzy_search.sql  (r2 — review round 2026-07-10)
-- RX-V2.6 — smart search for the Toa thuốc list: ONE search box, the function
-- classifies the query server-side (stakeholder rules, no UI mode chips):
--
--   · pure digits 3-8  → product_id EXACT token ("1535 - …") + DHC digit-partial.
--     An identifier is NEVER fuzzy — '153'/'15355' must not match '1535'.
--   · starts with DHC  → DHC search only (partial + light fuzzy):
--     'DHC989296' / '989296' / '00989296' all find DHC00989296 (digit-tail).
--   · has letters      → product NAME + note fuzzy (unaccent + trigram):
--     'panadl', 'khau trang', 'hoat chat' → typo/diacritics tolerant.
--
-- SECURITY INVOKER (the default — deliberately NOT DEFINER): RLS on
-- prescription_submissions applies to the CALLER, so staff/store_manager/admin
-- each get their own scope for free. Returns ids relevance-ordered (exact
-- product hit > DHC hit > fuzzy similarity); the app preserves this order.
--
-- Schema-robust (review P1): extensions may live in `public` OR `extensions`
-- (Supabase convention) — the function sets search_path over both and calls
-- unaccent()/word_similarity() unqualified. A search_path entry for a schema
-- that doesn't exist is silently ignored, so this is safe on any environment.
--
-- No expression indexes: the table is small (seq scan fine); revisit with
-- immutable-unaccent wrappers + GIN if it ever grows.
--
-- Idempotent. Records app_migrations '086'. Rollback: DROP FUNCTION (leave the
-- extensions — harmless, possibly shared).
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION public.rpc_search_prescription_ids(
  p_q     text,
  p_by    text DEFAULT 'all',    -- all (smart) | order | product | note
  p_limit int  DEFAULT 300
) RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SET search_path = public, extensions
AS $$
  WITH q AS (
    SELECT
      left(unaccent(lower(trim(coalesce(p_q, '')))), 100)                    AS nq,
      regexp_replace(left(trim(coalesce(p_q, '')), 100), '\D', '', 'g')      AS qdigits,
      CASE WHEN p_by IN ('order', 'product', 'note') THEN p_by ELSE 'all' END AS nby
  ), c AS (
    SELECT nq, qdigits, nby,
      replace(replace(replace(nq, '\', '\\'), '%', '\%'), '_', '\_') AS nq_like,
      (nq ~ '^[0-9]+$' AND length(nq) BETWEEN 3 AND 8)               AS is_pid,   -- bare product-id shape
      (nq LIKE 'dhc%')                                               AS is_dhc,
      (nq ~ '[a-z]')                                                 AS has_alpha
    FROM q
  )
  SELECT s.id
  FROM public.prescription_submissions s, c
  WHERE length(c.nq) >= 1
    AND (
      -- DHC (order_code) — numeric or DHC-prefixed queries only; text substring,
      -- digit-tail partial ('989296' → DHC00989296), light fuzzy for near-full codes
      (c.nby IN ('all', 'order') AND (c.is_dhc OR NOT c.has_alpha) AND (
        lower(s.order_code) LIKE '%' || c.nq_like || '%'
        OR (length(c.qdigits) >= 4
            AND regexp_replace(s.order_code, '\D', '', 'g') LIKE '%' || c.qdigits || '%')
        OR (c.is_dhc AND length(c.nq) >= 5
            AND word_similarity(c.nq, lower(s.order_code)) >= 0.45)
      ))
      -- product_id — EXACT token "<id> -" (an identifier is never fuzzy);
      -- boundary = start or any non-digit, so '1535' can't match '91535 - …'
      OR (c.nby IN ('all', 'product') AND c.is_pid AND s.order_products_raw IS NOT NULL
          AND s.order_products_raw ~ ('(^|[^0-9])' || c.nq || '\s*-'))
      -- product NAME — fuzzy for text queries (unaccented substring or trigram)
      OR (c.nby IN ('all', 'product') AND c.has_alpha AND NOT c.is_dhc
          AND s.order_products_raw IS NOT NULL AND (
        unaccent(lower(s.order_products_raw)) LIKE '%' || c.nq_like || '%'
        OR (length(c.nq) >= 3
            AND word_similarity(c.nq, unaccent(lower(s.order_products_raw))) >= 0.35)
      ))
      -- notes — fuzzy for text queries
      OR (c.nby IN ('all', 'note') AND c.has_alpha AND NOT c.is_dhc
          AND s.notes IS NOT NULL AND (
        unaccent(lower(s.notes)) LIKE '%' || c.nq_like || '%'
        OR (length(c.nq) >= 3
            AND word_similarity(c.nq, unaccent(lower(s.notes))) >= 0.35)
      ))
    )
  ORDER BY GREATEST(
      -- exact product-id token is the strongest signal
      CASE WHEN c.nby IN ('all', 'product') AND c.is_pid AND s.order_products_raw IS NOT NULL
                AND s.order_products_raw ~ ('(^|[^0-9])' || c.nq || '\s*-')
           THEN 1.0 ELSE 0 END,
      -- a DHC text/digit hit outranks fuzzy text matches
      CASE WHEN c.nby IN ('all', 'order') AND (c.is_dhc OR NOT c.has_alpha) AND (
                lower(s.order_code) LIKE '%' || c.nq_like || '%'
                OR (length(c.qdigits) >= 4
                    AND regexp_replace(s.order_code, '\D', '', 'g') LIKE '%' || c.qdigits || '%'))
           THEN 0.9 ELSE 0 END,
      CASE WHEN c.nby IN ('all', 'order') AND c.is_dhc AND length(c.nq) >= 5
           THEN word_similarity(c.nq, lower(s.order_code)) ELSE 0 END,
      CASE WHEN c.nby IN ('all', 'product') AND c.has_alpha AND NOT c.is_dhc AND s.order_products_raw IS NOT NULL
           THEN word_similarity(c.nq, unaccent(lower(s.order_products_raw))) ELSE 0 END,
      CASE WHEN c.nby IN ('all', 'note') AND c.has_alpha AND NOT c.is_dhc AND s.notes IS NOT NULL
           THEN word_similarity(c.nq, unaccent(lower(s.notes))) ELSE 0 END
    ) DESC, s.submitted_at DESC
  LIMIT least(greatest(coalesce(p_limit, 300), 1), 500)
$$;

GRANT EXECUTE ON FUNCTION public.rpc_search_prescription_ids(text, text, int) TO authenticated;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('086', 'prescription_fuzzy_search',
        'RX-V2.6 r2: pg_trgm + unaccent (search_path public,extensions); rpc_search_prescription_ids (SECURITY INVOKER) — smart classify: product_id EXACT token, DHC partial/digit-tail, name/note fuzzy unaccented; relevance-ordered, capped 500.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT extname, nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
--   WHERE extname IN ('pg_trgm','unaccent');
-- SELECT prosecdef FROM pg_proc WHERE proname='rpc_search_prescription_ids';  -- false (INVOKER)
-- SELECT * FROM public.rpc_search_prescription_ids('1591', 'all', 10);       -- exact product token
-- SELECT * FROM public.rpc_search_prescription_ids('DHC989296', 'all', 10);  -- digit-tail → DHC00989296
-- SELECT * FROM public.rpc_search_prescription_ids('hoat chat', 'all', 10);  -- diacritics-tolerant
-- SELECT version FROM public.app_migrations WHERE version = '086';
