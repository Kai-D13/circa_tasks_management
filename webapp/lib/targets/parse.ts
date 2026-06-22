// Shared normalizer for the BI feed "Current Week Achievement by POS".
// Two sources, one shape:
//   * XLSX export (sheet "Export"): display headers ("Min Weekly Target (90%
//     Target)", "RunRate" as a 0-1 fraction, "Week" as an Excel serial date)
//   * JSON ingest (/api/targets/ingest): snake_case keys, run_rate already in
//     percent, week as an ISO/US date string
// Business fields (run_rate / remaining_target / status) are BI-owned values
// and are stored as-is — remaining_target is vs the 90% MIN target, so
// recomputing anything here would silently change business meaning.

export interface TargetRow {
  pos_name:          string
  // Exact-match key when the source provides it (BigQuery feed) — preferred
  // over name matching.
  pos_code:          string | null
  week_start:        string // ISO date (Monday)
  target:            number
  min_weekly_target: number | null
  actual:            number
  run_rate:          number | null // percent
  status:            string | null
  remaining_target:  number | null
}

// Diacritic/case/whitespace-insensitive key for matching pos_name against
// stores.name (the file mixes "CIRCA THỐNG NHẤT" with undiacritized names).
export function normalizeStoreName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

// Excel serial date (days since 1899-12-30, the 1900 system) → ISO date.
export function excelSerialToISO(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000) // 25569 = 1970-01-01
  return new Date(ms).toISOString().slice(0, 10)
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,\s]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

// Accepts 'YYYY-MM-DD' (with optional time part — Power Automate's DAX output
// is '2026-06-08T00:00:00'), 'MM/DD/YYYY' (BI's US format) or an Excel serial.
export function parseWeek(v: unknown): string | null {
  if (typeof v === 'number') return excelSerialToISO(v)
  if (typeof v !== 'string') return null
  const s = v.trim()
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})([T ]|$)/)
  if (iso) return iso[1]
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
  return null
}

// Maps one raw record (either source) to a TargetRow; returns an error string
// for rows that cannot be salvaged. `runRateIsFraction` — XLSX stores 0.7499,
// JSON pushes 74.99.
export function normalizeRow(
  raw: Record<string, unknown>,
  opts: { runRateIsFraction: boolean },
): TargetRow | { error: string } {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (raw[k] !== undefined && raw[k] !== null) return raw[k]
    return null
  }

  const posName = pick('pos_name', 'POS Name', 'pos')
  const posCodeRaw = pick('pos_code', 'POS Code')
  const posCode = typeof posCodeRaw === 'string' && posCodeRaw.trim()
    ? posCodeRaw.trim().toUpperCase()
    : null
  const label = (typeof posName === 'string' && posName.trim()) ? posName.trim() : posCode
  if (!label) return { error: 'Thiếu pos_name/pos_code' }

  const week = parseWeek(pick('week', 'Week', 'monday_of_week'))
  if (!week) return { error: `${label}: week không hợp lệ` }

  const target = toNumber(pick('target', 'Target'))
  if (target === null || target <= 0) return { error: `${label}: target không hợp lệ` }

  const actual = toNumber(pick('actual', 'Actual', 'gmv')) ?? 0

  let runRate = toNumber(pick('run_rate', 'RunRate', 'Run Rate', 'kpi_pct'))
  if (runRate !== null && opts.runRateIsFraction) runRate = runRate * 100
  // Scale sanity check: we hold actual+target, so we can tell whether the
  // sender used a fraction (0.7499) or a percent (74.99) regardless of the
  // hint — pick whichever scale lands closer to actual/target. Protects the
  // automated paths, where the measure's format is the source owner's choice.
  if (runRate !== null && target > 0) {
    const expected = (actual / target) * 100
    if (Math.abs(runRate * 100 - expected) < Math.abs(runRate - expected)) runRate = runRate * 100
  }
  if (runRate !== null) runRate = Math.round(runRate * 100) / 100

  const minWeekly = toNumber(pick('min_weekly_target', 'Min Weekly Target (90% Target)', 'Min Weekly Target', 'weekly_target'))
  // A weekly target of 0 (or absent) means "not set yet" in the feed — NOT a
  // goal of zero. Deriving status/remaining against 0 would falsely report
  // "Achieved" for any non-negative actual (BigQuery weekly_target is currently
  // 0 for all stores). Treat <= 0 as "no weekly target".
  const hasMinWeekly = minWeekly !== null && minWeekly > 0

  // status / remaining are vs the MIN target (BI semantics). Sources that
  // don't carry them (BigQuery feed) get them derived the same way.
  const statusRaw = pick('status', 'Status')
  const status = typeof statusRaw === 'string'
    ? statusRaw.trim()
    : hasMinWeekly ? (actual >= (minWeekly as number) ? 'Achieved' : 'Not Achieved') : null
  const remaining = toNumber(pick('remaining_target', 'Remaining Target'))
    ?? (hasMinWeekly ? Math.max((minWeekly as number) - actual, 0) : null)

  return {
    pos_name:          label,
    pos_code:          posCode,
    week_start:        week,
    target,
    min_weekly_target: minWeekly,
    actual,
    run_rate:          runRate,
    status,
    remaining_target:  remaining,
  }
}
