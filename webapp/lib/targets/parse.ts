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

// Accepts 'YYYY-MM-DD', 'MM/DD/YYYY' (BI's US format) or an Excel serial.
export function parseWeek(v: unknown): string | null {
  if (typeof v === 'number') return excelSerialToISO(v)
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
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
  if (typeof posName !== 'string' || !posName.trim())
    return { error: 'Thiếu pos_name' }

  const week = parseWeek(pick('week', 'Week'))
  if (!week) return { error: `${posName}: week không hợp lệ` }

  const target = toNumber(pick('target', 'Target'))
  if (target === null || target <= 0) return { error: `${posName}: target không hợp lệ` }

  const actual = toNumber(pick('actual', 'Actual')) ?? 0

  let runRate = toNumber(pick('run_rate', 'RunRate', 'Run Rate'))
  if (runRate !== null && opts.runRateIsFraction) runRate = runRate * 100
  if (runRate !== null) runRate = Math.round(runRate * 100) / 100

  const status = pick('status', 'Status')

  return {
    pos_name:          posName.trim(),
    week_start:        week,
    target,
    min_weekly_target: toNumber(pick('min_weekly_target', 'Min Weekly Target (90% Target)', 'Min Weekly Target')),
    actual,
    run_rate:          runRate,
    status:            typeof status === 'string' ? status.trim() : null,
    remaining_target:  toNumber(pick('remaining_target', 'Remaining Target')),
  }
}
