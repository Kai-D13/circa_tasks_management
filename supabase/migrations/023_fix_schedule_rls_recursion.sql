-- ============================================================
-- Migration 023: Fix task_schedules / task_schedule_stores RLS recursion
-- ============================================================
-- Root cause: the admin sub-scope policies added in 021 query task_schedules
-- from within task_schedule_stores policies, while the 013 manager policy
-- queries task_schedule_stores from within task_schedules policies:
--
--   task_schedule_stores
--     → tss_select_admin (021): EXISTS on task_schedules
--         → ts_manager_select (013): EXISTS on task_schedule_stores
--             → tss_select_admin ... ∞
--
-- Fix: drop both manager SELECT policies. Store Manager / Staff are executor-
-- only since migration 022 and only need to see tasks in the tasks table
-- (which are already scoped by store). They have no reason to query schedule
-- configuration tables.
-- ============================================================

DROP POLICY IF EXISTS "ts_manager_select"  ON public.task_schedules;
DROP POLICY IF EXISTS "tss_manager_select" ON public.task_schedule_stores;
