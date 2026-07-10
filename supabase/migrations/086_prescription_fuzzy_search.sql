-- ============================================================================
-- 086_prescription_fuzzy_search.sql
-- RX-V2.6 — fuzzy search for the Toa thuốc list: one search box matching
-- DHC (order_code) / products (order_products_raw) / notes, tolerant of
-- partial input, small typos and missing Vietnamese diacritics
-- ('hoat chat' → 'hoạt chất', 'fosamx' → 'Fosamax', '989296' → DHC00989296).
--
-- Design: a SECURITY INVOKER function (the default — deliberately NOT
-- DEFINER) returning matching ids ordered by relevance. RLS on
-- prescription_submissions applies to the CALLER, so staff/store_manager/
-- admin each get their own scope for free. The app then feeds the ids into
-- its normal list query (.in('id', ids)) keeping every existing filter,
-- count and pagination untouched.
--
-- No expression indexes: the table is small (seq scan is fine at this
-- scale); revisit with immutable-unaccent wrappers + GIN if it ever grows.
--
-- Idempotent. Records app_migrations '086'. Rollback: DROP FUNCTION (leave
-- the extensions — harmless, may be shared).
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm   WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent  WITH SCHEMA public;

CREATE OR REPLACE FUNCTION public.rpc_search_prescription_ids(
  p_q     text,
  p_by    text DEFAULT 'all',    -- all | order | product | note
  p_limit int  DEFAULT 300
) RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SET search_path = public
AS $$
  WITH q AS (
    SELECT
      -- normalized query: lowercase + diacritics stripped, capped at 100 chars
      left(public.unaccent(lower(trim(coalesce(p_q, '')))), 100) AS nq,
      CASE WHEN p_by IN ('order', 'product', 'note') THEN p_by ELSE 'all' END AS nby
  ), ql AS (
    -- LIKE-safe form: escape the wildcard chars so a literal % / _ in the
    -- query doesn't silently broaden the match
    SELECT nq, nby,
           replace(replace(replace(nq, '\', '\\'), '%', '\%'), '_', '\_') AS nq_like
    FROM q
  )
  SELECT s.id
  FROM public.prescription_submissions s, ql
  WHERE length(ql.nq) >= 1
    AND (
      (ql.nby IN ('all', 'order') AND (
        public.unaccent(lower(s.order_code)) LIKE '%' || ql.nq_like || '%'
        OR (length(ql.nq) >= 3
            AND public.word_similarity(ql.nq, public.unaccent(lower(s.order_code))) >= 0.35)
      ))
      OR (ql.nby IN ('all', 'product') AND s.order_products_raw IS NOT NULL AND (
        public.unaccent(lower(s.order_products_raw)) LIKE '%' || ql.nq_like || '%'
        OR (length(ql.nq) >= 3
            AND public.word_similarity(ql.nq, public.unaccent(lower(s.order_products_raw))) >= 0.35)
      ))
      OR (ql.nby IN ('all', 'note') AND s.notes IS NOT NULL AND (
        public.unaccent(lower(s.notes)) LIKE '%' || ql.nq_like || '%'
        OR (length(ql.nq) >= 3
            AND public.word_similarity(ql.nq, public.unaccent(lower(s.notes))) >= 0.35)
      ))
    )
  ORDER BY GREATEST(
      CASE WHEN ql.nby IN ('all', 'order')
           THEN public.word_similarity(ql.nq, public.unaccent(lower(s.order_code))) ELSE 0 END,
      CASE WHEN ql.nby IN ('all', 'product') AND s.order_products_raw IS NOT NULL
           THEN public.word_similarity(ql.nq, public.unaccent(lower(s.order_products_raw))) ELSE 0 END,
      CASE WHEN ql.nby IN ('all', 'note') AND s.notes IS NOT NULL
           THEN public.word_similarity(ql.nq, public.unaccent(lower(s.notes))) ELSE 0 END
    ) DESC, s.submitted_at DESC
  LIMIT least(greatest(coalesce(p_limit, 300), 1), 500)
$$;

GRANT EXECUTE ON FUNCTION public.rpc_search_prescription_ids(text, text, int) TO authenticated;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('086', 'prescription_fuzzy_search',
        'RX-V2.6: pg_trgm + unaccent; rpc_search_prescription_ids (SECURITY INVOKER — caller RLS scopes results) matching order_code/products/notes via unaccented ILIKE + word_similarity, relevance-ordered, capped 500.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm','unaccent');
-- SELECT prosecdef FROM pg_proc WHERE proname='rpc_search_prescription_ids';  -- false (INVOKER)
-- SELECT * FROM public.rpc_search_prescription_ids('hoat chat', 'note', 10);
-- SELECT version FROM public.app_migrations WHERE version = '086';
