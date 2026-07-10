-- ============================================================================
-- 087_prescription_search_page_rpc.sql
-- RX-V2.7 — staff store-scope RLS + paged prescription search rows.
--
-- Why: stakeholder finalized that staff see only their own store's prescriptions.
-- Also, 086 returned relevance-ordered ids, then the app fetched rows with
-- .in('id', many uuids). Broad DHC searches can exceed PostgREST URL length.
-- This RPC returns the already-filtered page of rows + total_count, so no UUID
-- list is encoded into the URL. SECURITY INVOKER keeps prescription RLS as the
-- boundary (including the 085 OS-only staff guard).
-- ============================================================================

BEGIN;

-- 085 temporarily allowed OS staff to read all OS-store prescriptions. Final
-- stakeholder rule: staff browse/search only prescriptions of their own store;
-- FS staff remain blocked from OS prescriptions by is_current_user_os_staff().
DROP POLICY IF EXISTS ps_select_staff ON public.prescription_submissions;
CREATE POLICY ps_select_staff ON public.prescription_submissions
  FOR SELECT TO authenticated
  USING (
    (select public.is_current_user_os_staff())
    AND store_id = (select public.get_user_store_id())
  );

-- Child tables piggyback on the parent visibility, so the same store boundary
-- applies to images and legacy product rows without duplicating store logic.
DROP POLICY IF EXISTS pi_select_staff ON public.prescription_images;
CREATE POLICY pi_select_staff ON public.prescription_images
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'staff'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = prescription_images.submission_id
    )
  );

DROP POLICY IF EXISTS psp_select_staff ON public.prescription_submission_products;
CREATE POLICY psp_select_staff ON public.prescription_submission_products
  FOR SELECT TO authenticated
  USING (
    (select public.get_user_role()) = 'staff'
    AND EXISTS (
      SELECT 1 FROM public.prescription_submissions s
      WHERE s.id = prescription_submission_products.submission_id
    )
  );

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

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
  id                  uuid,
  order_code          text,
  submitted_at        timestamptz,
  status              text,
  is_chronic          boolean,
  order_sync_status   text,
  care_status         text,
  reminder_date       date,
  expected_refill_date date,
  order_created_at    date,
  days_supply         integer,
  customer_name       text,
  customer_phone      text,
  notes               text,
  order_products_raw  text,
  store_name          text,
  submitter_full_name text,
  image_count         bigint,
  image_paths         text[],
  total_count         bigint
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, extensions
AS $$
  WITH q AS (
    SELECT
      left(unaccent(lower(trim(coalesce(p_q, '')))), 100)                     AS nq,
      regexp_replace(left(trim(coalesce(p_q, '')), 100), '\D', '', 'g')       AS qdigits,
      CASE WHEN p_by IN ('order', 'product', 'note') THEN p_by ELSE 'all' END AS nby,
      least(greatest(coalesce(p_limit, 50), 1), 501)                          AS lim,
      greatest(coalesce(p_offset, 0), 0)                                      AS off
  ), c AS (
    SELECT nq, qdigits, nby, lim, off,
      replace(replace(replace(nq, '\', '\\'), '%', '\%'), '_', '\_') AS nq_like,
      (nq ~ '^[0-9]+$' AND length(nq) BETWEEN 3 AND 12)              AS is_pid,
      (nq LIKE 'dhc%')                                               AS is_dhc,
      (nq ~ '[a-z]')                                                 AS has_alpha
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
      GREATEST(
        CASE WHEN c.nby IN ('all', 'product') AND c.is_pid AND s.order_products_raw IS NOT NULL
                  AND s.order_products_raw ~ ('(^|[^0-9])' || c.qdigits || '[[:space:]]*-')
             THEN 1.0 ELSE 0 END,
        CASE WHEN c.nby IN ('all', 'order') AND (
                  (c.is_dhc AND lower(s.order_code) LIKE '%' || c.nq_like || '%')
                  OR (NOT c.has_alpha AND length(c.qdigits) >= 6
                      AND regexp_replace(s.order_code, '\D', '', 'g') LIKE '%' || c.qdigits || '%'))
             THEN 0.9 ELSE 0 END,
        CASE WHEN c.nby IN ('all', 'product') AND c.has_alpha AND NOT c.is_dhc AND s.order_products_raw IS NOT NULL
             THEN word_similarity(c.nq, unaccent(lower(s.order_products_raw))) ELSE 0 END,
        CASE WHEN c.nby IN ('all', 'note') AND c.has_alpha AND NOT c.is_dhc AND s.notes IS NOT NULL
             THEN word_similarity(c.nq, unaccent(lower(s.notes))) ELSE 0 END
      ) AS score,
      c.lim,
      c.off
    FROM public.prescription_submissions s
    CROSS JOIN c
    LEFT JOIN public.stores st ON st.id = s.store_id
    LEFT JOIN public.users u ON u.id = s.submitted_by
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
        (c.nby IN ('all', 'order') AND (
          (c.is_dhc AND lower(s.order_code) LIKE '%' || c.nq_like || '%')
          OR (NOT c.has_alpha AND length(c.qdigits) >= 6
              AND regexp_replace(s.order_code, '\D', '', 'g') LIKE '%' || c.qdigits || '%')
        ))
        OR (c.nby IN ('all', 'product') AND c.is_pid AND s.order_products_raw IS NOT NULL
            AND s.order_products_raw ~ ('(^|[^0-9])' || c.qdigits || '[[:space:]]*-'))
        OR (c.nby IN ('all', 'product') AND c.has_alpha AND NOT c.is_dhc
            AND s.order_products_raw IS NOT NULL AND (
          unaccent(lower(s.order_products_raw)) LIKE '%' || c.nq_like || '%'
          OR (length(c.nq) >= 3 AND word_similarity(c.nq, unaccent(lower(s.order_products_raw))) >= 0.35)
        ))
        OR (c.nby IN ('all', 'note') AND c.has_alpha AND NOT c.is_dhc
            AND s.notes IS NOT NULL AND (
          unaccent(lower(s.notes)) LIKE '%' || c.nq_like || '%'
          OR (length(c.nq) >= 3 AND word_similarity(c.nq, unaccent(lower(s.notes))) >= 0.35)
        ))
      )
  ), paged AS (
    SELECT scored.*, count(*) OVER()::bigint AS total_count
    FROM scored
    ORDER BY score DESC, submitted_at DESC
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
    paged.total_count
  FROM paged;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_search_prescriptions_page(text, text, integer, integer, text, uuid, text, text, boolean, date, timestamptz, timestamptz) TO authenticated;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('087', 'prescription_search_page_rpc',
        'RX-V2.7: staff prescription SELECT restored to own OS store; paged row RPC removes ids -> .in(...) URI-too-long path; SECURITY INVOKER preserves RLS.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT policyname FROM pg_policies WHERE tablename='prescription_submissions' AND policyname='ps_select_staff';
-- SELECT proname, prosecdef FROM pg_proc WHERE proname = 'rpc_search_prescriptions_page'; -- prosecdef=false
-- SELECT count(*) FROM public.rpc_search_prescriptions_page('DHC00986616','all',13,0,NULL,NULL,NULL,NULL,false,current_date,NULL,NULL);
-- SELECT version FROM public.app_migrations WHERE version = '087';