-- ============================================================
-- Migration 064: announcement media (cover + carousel images)
-- ============================================================
-- Images for the Bảng tin (announcements, migration 063): one optional cover +
-- up to N carousel images. URLs are public (GCS or the public task-uploads
-- bucket); visibility is governed by the parent announcement. Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.announcement_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'carousel' CHECK (kind IN ('cover','carousel')),
  url             text NOT NULL,
  position        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_announcement_assets_ann ON public.announcement_assets (announcement_id, position);
ALTER TABLE public.announcement_assets ENABLE ROW LEVEL SECURITY;

-- SELECT: visible only for an announcement the user can see (EXISTS runs under the
-- announcements ann_select RLS). announcements never reference assets → no recursion.
DROP POLICY IF EXISTS anna_select ON public.announcement_assets;
CREATE POLICY anna_select ON public.announcement_assets FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.announcements a WHERE a.id = announcement_id));

-- Writes go through the server action (service role); keep a super-admin guard.
DROP POLICY IF EXISTS anna_write ON public.announcement_assets;
CREATE POLICY anna_write ON public.announcement_assets FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

-- ── storage.objects: allow admin to upload announcement images (Supabase
--    fallback when GCS is off) under announcement_assets/. Recreates the
--    task_uploads_insert policy from migration 039 + a 4th admin branch.
DROP POLICY IF EXISTS task_uploads_insert ON storage.objects;
CREATE POLICY task_uploads_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'task-uploads'
    AND (
      (
        (storage.foldername(name))[1] = 'tasks'
        AND EXISTS (
          SELECT 1 FROM public.tasks t JOIN public.users u ON u.id = (select auth.uid())
          WHERE t.id::text = (storage.foldername(name))[2]
            AND t.archived_at IS NULL
            AND (
              t.assigned_to = (select auth.uid())
              OR (
                t.assigned_to IS NULL
                AND t.assignment_mode = 'store'
                AND t.store_id IS NOT NULL
                AND t.store_id = u.store_id
                AND u.role IN ('staff', 'store_manager')
              )
            )
        )
      )
      OR (
        (storage.foldername(name))[1] = 'task-inputs'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (select auth.uid()) AND u.role = 'admin')
      )
      OR (
        (storage.foldername(name))[1] = 'prescriptions'
        AND EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = (select auth.uid())
            AND u.store_id::text = (storage.foldername(name))[2]
            AND u.role = ANY (ARRAY['staff', 'store_manager'])
        )
      )
      OR (
        (storage.foldername(name))[1] = 'announcement_assets'
        AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (select auth.uid()) AND u.role = 'admin')
      )
    )
  );

-- Atomic replace of an announcement's audience + assets (one transaction → no
-- partial write). Service-role only (the action is the trusted boundary; it has
-- already authorized the admin). DELETEs carry WHERE (pg_safeupdate).
CREATE OR REPLACE FUNCTION public.replace_announcement_audience_assets(
  p_announcement_id uuid, p_store_ids uuid[], p_cover text, p_carousel text[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.announcement_stores WHERE announcement_id = p_announcement_id;
  IF array_length(p_store_ids, 1) IS NOT NULL THEN
    INSERT INTO public.announcement_stores (announcement_id, store_id)
    SELECT p_announcement_id, unnest(p_store_ids);
  END IF;

  DELETE FROM public.announcement_assets WHERE announcement_id = p_announcement_id;
  IF p_cover IS NOT NULL AND p_cover <> '' THEN
    INSERT INTO public.announcement_assets (announcement_id, kind, url, position)
    VALUES (p_announcement_id, 'cover', p_cover, 0);
  END IF;
  IF array_length(p_carousel, 1) IS NOT NULL THEN
    INSERT INTO public.announcement_assets (announcement_id, kind, url, position)
    SELECT p_announcement_id, 'carousel', u.url, (u.ord - 1)::int
    FROM unnest(p_carousel) WITH ORDINALITY AS u(url, ord);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.replace_announcement_audience_assets(uuid, uuid[], text, text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.replace_announcement_audience_assets(uuid, uuid[], text, text[]) TO service_role;

-- Full atomic UPDATE: parent fields + audience + assets in ONE transaction (so an
-- edit can't change the title while leaving audience/assets half-applied). The
-- caller (server action) has already verified creator/super; service-role only.
CREATE OR REPLACE FUNCTION public.rpc_update_announcement(
  p_id uuid, p_title text, p_body text, p_excerpt text, p_visibility text,
  p_expires_at timestamptz, p_store_ids uuid[], p_cover text, p_carousel text[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.announcements
    SET title = p_title, body = p_body, excerpt = p_excerpt, visibility = p_visibility,
        expires_at = p_expires_at, updated_at = now()
    WHERE id = p_id;
  PERFORM public.replace_announcement_audience_assets(p_id, p_store_ids, p_cover, p_carousel);
END $$;
REVOKE ALL ON FUNCTION public.rpc_update_announcement(uuid, text, text, text, text, timestamptz, uuid[], text, text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_update_announcement(uuid, text, text, text, text, timestamptz, uuid[], text, text[]) TO service_role;

INSERT INTO public.app_migrations (version, name)
VALUES ('064', 'announcement_assets')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- SELECT version FROM public.app_migrations WHERE version='064';
-- SELECT policyname FROM pg_policies WHERE tablename='announcement_assets';
