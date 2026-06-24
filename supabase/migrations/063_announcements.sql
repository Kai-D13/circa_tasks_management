-- ============================================================
-- Migration 063: Announcements / Bảng tin (read-only broadcasts)
-- ============================================================
-- Admin posts info/campaigns to Staff/Store accounts who DON'T submit anything —
-- the system only records a READ receipt (who clicked to view). No status / no
-- result / no Teams. Audience = 'all' or specific stores. Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.announcements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',          -- sanitized rich-text HTML
  excerpt      text,                               -- plain-text preview
  visibility   text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all','stores')),
  created_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz
);
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_announcements_published ON public.announcements (published_at DESC);

-- Audience when visibility='stores' (Staff + Store of those stores see it).
CREATE TABLE IF NOT EXISTS public.announcement_stores (
  announcement_id uuid NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  store_id        uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, store_id)
);
ALTER TABLE public.announcement_stores ENABLE ROW LEVEL SECURITY;

-- Read receipts (one per user per announcement).
CREATE TABLE IF NOT EXISTS public.announcement_reads (
  announcement_id uuid NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_announcement_reads_user ON public.announcement_reads (user_id);

-- ── RLS: announcements ──────────────────────────────────────────────────────
-- SELECT: super/admin see all (manage); others see 'all' OR a targeted store
-- (staff/store_manager by their store; sm by assigned stores). Helpers are
-- SECURITY DEFINER + announcement_stores SELECT is USING(true), so the EXISTS
-- subquery never recurses (see migration 048/049 lesson).
DROP POLICY IF EXISTS ann_select ON public.announcements;
CREATE POLICY ann_select ON public.announcements FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR (select public.get_user_role()) = 'admin'
    OR visibility = 'all'
    OR EXISTS (
      SELECT 1 FROM public.announcement_stores a
      WHERE a.announcement_id = announcements.id
        AND a.store_id = (select public.get_user_store_id())
    )
    OR (
      (select public.get_user_role()) = 'sm' AND EXISTS (
        SELECT 1 FROM public.announcement_stores a
        JOIN public.sm_store_assignments s ON s.store_id = a.store_id
        WHERE a.announcement_id = announcements.id
          AND s.sm_user_id = (select auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS ann_insert ON public.announcements;
CREATE POLICY ann_insert ON public.announcements FOR INSERT TO authenticated
  WITH CHECK ((select public.get_user_role()) = 'admin' AND created_by = (select auth.uid()));

DROP POLICY IF EXISTS ann_update ON public.announcements;
CREATE POLICY ann_update ON public.announcements FOR UPDATE TO authenticated
  USING ((select public.is_super_admin()) OR ((select public.get_user_role()) = 'admin' AND created_by = (select auth.uid())))
  WITH CHECK ((select public.is_super_admin()) OR ((select public.get_user_role()) = 'admin' AND created_by = (select auth.uid())));

DROP POLICY IF EXISTS ann_delete ON public.announcements;
CREATE POLICY ann_delete ON public.announcements FOR DELETE TO authenticated
  USING ((select public.is_super_admin()) OR ((select public.get_user_role()) = 'admin' AND created_by = (select auth.uid())));

-- ── RLS: announcement_stores (non-sensitive junction) ───────────────────────
-- SELECT true so the ann_select EXISTS resolves without recursion. Writes go
-- through the service role (server action) but keep a super-admin write policy.
DROP POLICY IF EXISTS anns_select ON public.announcement_stores;
CREATE POLICY anns_select ON public.announcement_stores FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS anns_write ON public.announcement_stores;
CREATE POLICY anns_write ON public.announcement_stores FOR ALL TO authenticated
  USING ((select public.is_super_admin()))
  WITH CHECK ((select public.is_super_admin()));

-- ── RLS: announcement_reads ─────────────────────────────────────────────────
-- A user records + sees their own reads; super/admin see all (read stats).
-- A user may only mark-read an announcement they can actually SEE. The EXISTS
-- subquery runs under the user's RLS on announcements (ann_select), so a guessed
-- UUID for a non-visible announcement is rejected — keeps read stats honest.
DROP POLICY IF EXISTS ar_insert ON public.announcement_reads;
CREATE POLICY ar_insert ON public.announcement_reads FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (select auth.uid())
    AND EXISTS (SELECT 1 FROM public.announcements a WHERE a.id = announcement_id)
  );

DROP POLICY IF EXISTS ar_select ON public.announcement_reads;
CREATE POLICY ar_select ON public.announcement_reads FOR SELECT TO authenticated
  USING (
    (select public.is_super_admin())
    OR (select public.get_user_role()) = 'admin'
    OR user_id = (select auth.uid())
  );

INSERT INTO public.app_migrations (version, name)
VALUES ('063', 'announcements')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Verify
-- ============================================================
-- SELECT version FROM public.app_migrations WHERE version='063';
-- SELECT policyname FROM pg_policies WHERE tablename IN ('announcements','announcement_stores','announcement_reads');
