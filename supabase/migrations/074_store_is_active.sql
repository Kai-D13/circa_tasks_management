-- ============================================================================
-- 074_store_is_active.sql
-- Soft-deactivate a store (e.g. CIRCA BELVITA) so NEW tasks stop targeting it,
-- while its history stays intact. Additive + idempotent (mirrors the ad-hoc
-- ALTER already run on prod). The app filters is_active = true on every
-- task-creation surface (create/edit form store lists, Excel import, the
-- recurring-tasks cron, the Inventory-TRF cron) so no new work lands on an
-- inactive store; existing/archived rows are untouched.
--
-- Deactivating a store is done by data (UPDATE stores SET is_active=false ...);
-- reactivating is the reverse. No RLS change (stores select stays open).
-- ============================================================================

BEGIN;

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('074', 'store_is_active',
        'stores.is_active (default true). Deactivate a store to stop new tasks/TRF/recurring/import targeting it; history unaffected. App filters is_active=true on all task-creation surfaces.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='stores' AND column_name='is_active';
-- SELECT id, code, name, is_active FROM public.stores WHERE NOT is_active;
