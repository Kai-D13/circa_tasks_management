export type RecurringFrequency = 'daily' | 'weekly' | 'monthly'

// Find the first occurrence of a schedule at or after startDate
// that is also in the future (> afterMs, default = now).
// Times are in Vietnam (UTC+7, no DST).
export function computeNextRunAt(
  startDate: string,
  runTime: string,
  frequency: RecurringFrequency,
  weekdays: number[] | null,
  monthDay: number | null,
  afterMs: number = Date.now()
): string {
  const [h, m] = runTime.split(':').map(Number)
  const VN_OFFSET_MS = 7 * 3600_000

  function toUtcMs(y: number, mo: number, d: number): number {
    return Date.UTC(y, mo, d, h, m) - VN_OFFSET_MS
  }

  const [sy, sm, sd] = startDate.split('-').map(Number)

  if (frequency === 'daily') {
    let utcMs = toUtcMs(sy, sm - 1, sd)
    while (utcMs <= afterMs) utcMs += 86_400_000
    return new Date(utcMs).toISOString()
  }

  if (frequency === 'weekly') {
    const days = weekdays && weekdays.length > 0 ? [...weekdays].sort() : [1]
    let cursor = Date.UTC(sy, sm - 1, sd)

    for (let i = 0; i < 14; i++) {
      const d = new Date(cursor)
      if (days.includes(d.getUTCDay())) {
        const utcMs = toUtcMs(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
        if (utcMs > afterMs) return new Date(utcMs).toISOString()
      }
      cursor += 86_400_000
    }

    cursor = Date.UTC(sy, sm - 1, sd)
    for (let i = 0; i < 8; i++) {
      const d = new Date(cursor + i * 86_400_000)
      if (days.includes(d.getUTCDay())) {
        return new Date(toUtcMs(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
      }
    }
  }

  if (frequency === 'monthly') {
    const day = monthDay ?? 1
    let year = sy
    let month = sm - 1

    for (let i = 0; i < 25; i++) {
      const daysInMonth = new Date(year, month + 1, 0).getDate()
      if (day <= daysInMonth) {
        const anchor = Date.UTC(year, month, day)
        const startAnchor = Date.UTC(sy, sm - 1, sd)
        if (anchor >= startAnchor) {
          const utcMs = toUtcMs(year, month, day)
          if (utcMs > afterMs) return new Date(utcMs).toISOString()
        }
      }
      month++
      if (month > 11) {
        month = 0
        year++
      }
    }
  }

  return new Date(toUtcMs(sy, sm - 1, sd)).toISOString()
}
