// Inventory module — single-sourced constants used by server pages, the cron,
// the Sidebar gate, and app-layer permission checks. The Cycle Count department
// id is also hardcoded in migration 068's RLS (keep the two in sync).
export const CYCLE_COUNT_DEPT_ID = 'cac38f89-a5d4-4402-99ec-24915a446545'

// tasks.source_type value for TRF tasks (excluded from /tasks, /dashboard,
// /api/export/tasks; surfaced only under /inventory/trf).
export const INVENTORY_TRF_SOURCE_TYPE = 'inventory_trf'
