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

INSERT INTO public.app_migrations (version, name)
VALUES ('064', 'announcement_assets')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- SELECT version FROM public.app_migrations WHERE version='064';
-- SELECT policyname FROM pg_policies WHERE tablename='announcement_assets';
