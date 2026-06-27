import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { normalizeStoreName } from './parse'
import { POS_CODE_BY_NAME } from './posMap'

// KPI v2 ingest. The BigQuery side (KPI_AGGREGATE_QUERY) already aggregates the
// three current periods per store, so each raw row is ONE (store, grain) record
// — no grouping here. We coerce the (string) BQ values, apply the business rule,
// match pos_code → store, and upsert store_kpi_targets (migration 067).
// Service-role writes — the table has no write RLS by design. Caller (cron)
// handles auth.
//
// BigQuery REST returns every value as a string (numbers in scientific notation,
// dates as 'YYYY-MM-DD'); coerce accordingly.

type Grain = 'day' | 'week' | 'month'

const GRAINS: Grain[] = ['day', 'week', 'month']

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v.trim()) // Number() parses "1.5396715E7" correctly
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function dateStr(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export interface KpiAggregateResult {
  upserted: number
  periods: Record<Grain, number>
  unmatched: string[]
  rowErrors: string[]
}

export async function aggregateAndUpsertKpi(
  rawRows: Record<string, unknown>[],
): Promise<KpiAggregateResult> {
  const { data: stores, error } = await supabaseAdmin.from('stores').select('id, name, code')
  if (error) throw new Error(error.message)

  // Same 3-tier matching as lib/targets/ingest.ts (store_weekly_targets path):
  // exact pos_code → stores.code, then normalized pos_name → stores.name, then
  // the stakeholder pos_name → POS code fallback map.
  const byName = new Map((stores ?? []).map((s) => [normalizeStoreName(s.name), s.id]))
  const byCode = new Map(
    (stores ?? [])
      .filter((s) => s.code)
      .map((s) => [String(s.code).trim().toUpperCase(), s.id]),
  )

  const unmatched = new Set<string>()
  const rowErrors: string[] = []
  // Keyed store|grain|period_start so a duplicate (or two pos_codes mapping to
  // one store) can never trip Postgres' "ON CONFLICT cannot affect row twice".
  const byUpsertKey = new Map<string, Record<string, unknown>>()
  const refreshedAt = new Date().toISOString()

  for (const raw of rawRows) {
    const periodType = str(raw.period_type) as Grain | null
    if (!periodType || !GRAINS.includes(periodType)) {
      rowErrors.push(`period_type không hợp lệ: ${String(raw.period_type)}`)
      continue
    }
    const periodStart = dateStr(raw.period_start)
    if (!periodStart) {
      rowErrors.push(`${periodType}: period_start không hợp lệ`)
      continue
    }
    const periodEnd = dateStr(raw.period_end) ?? periodStart

    const posName = str(raw.pos_name)
    const posCode = str(raw.pos_code)?.toUpperCase() ?? null
    const label = posName ?? posCode
    if (!label) {
      rowErrors.push(`${periodType} ${periodStart}: thiếu pos_name/pos_code`)
      continue
    }

    const key = posName ? normalizeStoreName(posName) : ''
    const storeId = (posCode ? byCode.get(posCode) : undefined)
      ?? byName.get(key)
      ?? byCode.get(POS_CODE_BY_NAME[key] ?? '')
    if (!storeId) {
      unmatched.add(posCode ? `${label} (${posCode})` : label)
      continue
    }

    const actual = num(raw.actual)
    const target = num(raw.target)
    const hasGoal = target > 0
    const runRate = hasGoal ? Math.round((actual / target) * 100 * 100) / 100 : null
    const remaining = hasGoal ? Math.max(target - actual, 0) : null
    const status = !hasGoal ? null : actual >= target ? 'Achieved' : 'Not Achieved'

    byUpsertKey.set(`${storeId}|${periodType}|${periodStart}`, {
      store_id:         storeId,
      period_type:      periodType,
      period_start:     periodStart,
      period_end:       periodEnd,
      actual,
      target,
      run_rate:         runRate,
      status,
      remaining_target: remaining,
      raw_row_count:    Math.round(num(raw.raw_row_count)),
      refreshed_at:     refreshedAt,
      source:           'api',
    })
  }

  const payload = [...byUpsertKey.values()]
  const periods: Record<Grain, number> = { day: 0, week: 0, month: 0 }
  for (const p of payload) periods[p.period_type as Grain]++

  if (payload.length) {
    const { error: upErr } = await supabaseAdmin
      .from('store_kpi_targets')
      .upsert(payload, { onConflict: 'store_id,period_type,period_start' })
    if (upErr) throw new Error(upErr.message)
  }

  return { upserted: payload.length, periods, unmatched: [...unmatched], rowErrors }
}
