// CMS — thời điểm UTC giữ đủ micro giây (SPEC §1.3) và ngày VN (UTC+7, không DST).
// Biểu diễn: bigint micro giây kể từ epoch. Không đi qua Date cho phần micro giây.
// Hàm thuần, không I/O.

const VN_OFFSET_MICROS = BigInt(7) * BigInt(3600) * BigInt(1000000)
const DAY_MICROS = BigInt(86400) * BigInt(1000000)

// ISO `2026-11-01T04:01:32.701749Z` (adapter FORMAT_TIMESTAMP %E6S) hoặc dạng
// export JSON BigQuery `2026-11-01 04:01:32.701749 UTC`. Phần lẻ 0–6 chữ số.
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z| UTC)$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function utcDayStartMs(y: number, m: number, d: number): number | null {
  const ms = Date.UTC(y, m - 1, d)
  const dt = new Date(ms)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return ms
}

/** Chuỗi timestamp UTC ⇒ micro giây epoch; sai định dạng / ngày giờ không tồn tại ⇒ null. */
export function parseUtcMicros(input: string): bigint | null {
  const m = TS_RE.exec(input.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, frac = ''] = m
  const dayMs = utcDayStartMs(Number(y), Number(mo), Number(d))
  if (dayMs === null) return null
  const hh = Number(h), mm = Number(mi), ss = Number(s)
  if (hh > 23 || mm > 59 || ss > 59) return null
  const secs = BigInt(dayMs / 1000) + BigInt(hh * 3600 + mm * 60 + ss)
  return secs * BigInt(1000000) + BigInt(frac.padEnd(6, '0'))
}

/** micro giây epoch ⇒ `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
export function formatUtcMicros(micros: bigint): string {
  const secs = micros >= BigInt(0) ? micros / BigInt(1000000) : (micros - BigInt(999999)) / BigInt(1000000)
  const frac = micros - secs * BigInt(1000000)
  const iso = new Date(Number(secs) * 1000).toISOString().slice(0, 19)
  return `${iso}.${frac.toString().padStart(6, '0')}Z`
}

/** `YYYY-MM-DD` hợp lệ (ngày có thật). */
export function isCmsIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value)
  return !!m && utcDayStartMs(Number(m[1]), Number(m[2]), Number(m[3])) !== null
}

/** Ngày VN của một thời điểm UTC. */
export function vnDateOfMicros(micros: bigint): string {
  return formatUtcMicros(micros + VN_OFFSET_MICROS).slice(0, 10)
}

/**
 * Cửa sổ kỳ chương trình (plan §2.5): [00:00 VN ngày bắt đầu, 00:00 VN ngày sau
 * ngày kết thúc) quy về micro giây UTC. Ngày sai / end < start ⇒ throw.
 */
export function vnProgramWindowMicros(startDate: string, endDate: string): { fromMicros: bigint; toMicrosExclusive: bigint } {
  if (!isCmsIsoDate(startDate) || !isCmsIsoDate(endDate)) throw new RangeError('CMS: ngày chương trình không hợp lệ')
  if (endDate < startDate) throw new RangeError('CMS: ngày kết thúc trước ngày bắt đầu')
  const start = parseUtcMicros(`${startDate}T00:00:00Z`)!
  const end = parseUtcMicros(`${endDate}T00:00:00Z`)!
  return { fromMicros: start - VN_OFFSET_MICROS, toMicrosExclusive: end + DAY_MICROS - VN_OFFSET_MICROS }
}

export function isWithinWindow(micros: bigint, w: { fromMicros: bigint; toMicrosExclusive: bigint }): boolean {
  return micros >= w.fromMicros && micros < w.toMicrosExclusive
}
