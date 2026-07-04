-- ─────────────────────────────────────────────────────────────────────────────
-- GO-LIVE CLEANUP — KPI Campaign module
-- Run on the PRODUCTION Supabase (SQL Editor) as part of the final deploy, AFTER
-- migrations 070 → 071 → 072 are applied and BEFORE (or right after) flipping
-- KPI_CAMPAIGN_ENABLED=true. Run each statement separately — the SQL Editor only
-- prints the last statement's result.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Snapshot what exists first (safety — read before you delete).
--    Prod ran with the feature OFF, so this is usually empty; the DELETE below is
--    a safety net for any campaign created during a prod smoke-test.
SELECT id, name, status, is_test, start_date, end_date, created_at
FROM public.kpi_campaigns
ORDER BY created_at DESC;

-- 1) Remove QA / test campaigns. is_test has NO UI toggle, so a test campaign can
--    only be cleared here. WHERE clause is required (pg_safeupdate). FK ON DELETE
--    CASCADE removes the campaign's targets, tiers, actuals, daily actuals and
--    import runs in the same statement.
DELETE FROM public.kpi_campaigns WHERE is_test = true;

--    If instead you want to KEEP a specific campaign as a real one (make it
--    visible to Staff/SM), don't delete it — flip its flag:
-- UPDATE public.kpi_campaigns SET is_test = false WHERE id = '<campaign-uuid>';

-- 2) VERIFY — must return 0. Any row here is still hidden from Staff/SM.
SELECT count(*) AS test_campaigns_remaining
FROM public.kpi_campaigns
WHERE is_test = true;

-- 3) VERIFY migrations applied (expect rows 069, 070, 071, 072).
SELECT version FROM public.app_migrations
WHERE version IN ('069','070','071','072')
ORDER BY version;

-- 4) After go-live: confirm KPI_CAMPAIGN_TEST_MODE=false on Coolify so new
--    campaigns are born is_test=false (visible once active). No SQL — env only.
