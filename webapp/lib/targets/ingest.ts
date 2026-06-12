import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { normalizeStoreName, type TargetRow } from './parse'

// Matches normalized pos_name → stores.name and upserts one row per
// (store, week). Service-role writes — store_weekly_targets has no write
// RLS by design (migration 051). Callers handle auth (super admin action /
// ingest secret).
export async function upsertTargetRows(
  rows: TargetRow[],
  source: 'upload' | 'api',
  uploadedBy: string | null,
): Promise<{ upserted: number; unmatched: string[] }> {
  const { data: stores, error } = await supabaseAdmin.from('stores').select('id, name')
  if (error) throw new Error(error.message)

  const byName = new Map((stores ?? []).map((s) => [normalizeStoreName(s.name), s.id]))
  const unmatched: string[] = []
  const payload: Record<string, unknown>[] = []

  for (const r of rows) {
    const storeId = byName.get(normalizeStoreName(r.pos_name))
    if (!storeId) { unmatched.push(r.pos_name); continue }
    payload.push({
      store_id:          storeId,
      week_start:        r.week_start,
      target:            r.target,
      min_weekly_target: r.min_weekly_target,
      actual:            r.actual,
      run_rate:          r.run_rate,
      status:            r.status,
      remaining_target:  r.remaining_target,
      refreshed_at:      new Date().toISOString(),
      source,
      uploaded_by:       uploadedBy,
    })
  }

  if (payload.length) {
    const { error: upErr } = await supabaseAdmin
      .from('store_weekly_targets')
      .upsert(payload, { onConflict: 'store_id,week_start' })
    if (upErr) throw new Error(upErr.message)
  }

  return { upserted: payload.length, unmatched }
}
