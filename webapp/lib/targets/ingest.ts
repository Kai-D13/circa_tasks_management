import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { normalizeStoreName, type TargetRow } from './parse'
import { POS_CODE_BY_NAME } from './posMap'

// Matches normalized pos_name → stores.name and upserts one row per
// (store, week). Service-role writes — store_weekly_targets has no write
// RLS by design (migration 051). Callers handle auth (super admin action /
// ingest secret).
export async function upsertTargetRows(
  rows: TargetRow[],
  source: 'upload' | 'api',
  uploadedBy: string | null,
): Promise<{ upserted: number; unmatched: string[]; duplicates: number }> {
  const { data: stores, error } = await supabaseAdmin.from('stores').select('id, name, code')
  if (error) throw new Error(error.message)

  const byName = new Map((stores ?? []).map((s) => [normalizeStoreName(s.name), s.id]))
  const byCode = new Map(
    (stores ?? [])
      .filter((s) => s.code)
      .map((s) => [String(s.code).trim().toUpperCase(), s.id]),
  )
  const unmatched: string[] = []
  // Keyed store|week so a feed carrying the same store twice for one week
  // can never trip Postgres' "ON CONFLICT DO UPDATE cannot affect row a
  // second time" — last occurrence wins, duplicates are reported.
  const byUpsertKey = new Map<string, Record<string, unknown>>()
  let duplicates = 0

  for (const r of rows) {
    const key = normalizeStoreName(r.pos_name)
    // Name match first; fall back to the stakeholder's pos_name → POS code
    // map so a renamed store still resolves through stores.code.
    const storeId = byName.get(key) ?? byCode.get(POS_CODE_BY_NAME[key] ?? '')
    if (!storeId) { unmatched.push(r.pos_name); continue }
    const upsertKey = `${storeId}|${r.week_start}`
    if (byUpsertKey.has(upsertKey)) duplicates++
    byUpsertKey.set(upsertKey, {
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

  const payload = [...byUpsertKey.values()]
  if (payload.length) {
    const { error: upErr } = await supabaseAdmin
      .from('store_weekly_targets')
      .upsert(payload, { onConflict: 'store_id,week_start' })
    if (upErr) throw new Error(upErr.message)
  }

  return { upserted: payload.length, unmatched, duplicates }
}
