import { excelSerialToISO } from '@/lib/targets/parse'
import { DHC_PATTERN } from '@/lib/prescriptions/constants'

// Parser for the chronic-Rx order Sheet (Circa_prescription / order_data):
//   order_code · created_date · pos_code · pos_name · phone_number ·
//   customer_name · products
// Feeds /api/cron/pull-prescription-orders. Header-tolerant (canon), and the
// date parser is DAY-FIRST: this Sheet renders created_date as d/m/yyyy (VN).
// Do NOT reuse lib/referrals/parse.ts dateStr here — it resolves the ambiguous
// ≤12/≤12 case as MM/DD (BigQuery convention) and would read 5/6/2026 as May 6.

export const MAX_ORDER_ROWS = 20000

export interface OrderRow {
  order_code:    string
  created_date:  string | null   // ISO yyyy-mm-dd
  pos_code:      string | null
  pos_name:      string | null
  phone_number:  string | null   // raw trimmed text — keeps the leading 0
  customer_name: string | null
  products_raw:  string | null
}

// d/m/yyyy (VN, day-first) → ISO. Also accepts ISO passthrough and Excel/Sheets
// serial numbers. A month > 12 (i.e. a US M/D sheet snuck in) returns null —
// dropping is safer than misparsing on a customer-facing reminder date.
export function parseVnSlashDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return excelSerialToISO(v)
  const s = String(v).trim()
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) {
    const d = parseInt(slash[1], 10)
    const m = parseInt(slash[2], 10)
    const y = parseInt(slash[3], 10)
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    // Round-trip guard: reject impossible calendar dates (31/2, 30/2, 31/4…)
    // so a bad Sheet cell can't produce '2026-02-31' and a nonsense reminder.
    const dt = new Date(Date.UTC(y, m - 1, d))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
    return `${slash[3]}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  return null
}

const canon = (k: string) => k.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

export function parseOrderRows(rawRows: Record<string, unknown>[]):
  | { byCode: Map<string, OrderRow>; rowErrors: { row: number; error: string }[] }
  | { error: string } {
  if (rawRows.length > MAX_ORDER_ROWS) {
    return { error: `Sheet quá lớn (${rawRows.length} dòng, tối đa ${MAX_ORDER_ROWS})` }
  }
  if (rawRows.length === 0) return { byCode: new Map(), rowErrors: [] }

  // Header check on the first row (canon-tolerant).
  const first = rawRows[0]
  const headerMap = new Map<string, string>()
  for (const k of Object.keys(first)) headerMap.set(canon(k), k)
  for (const required of ['ordercode', 'createddate']) {
    if (!headerMap.has(required)) {
      return { error: `Sheet thiếu cột bắt buộc: ${required === 'ordercode' ? 'order_code' : 'created_date'}` }
    }
  }
  const col = (row: Record<string, unknown>, key: string) => {
    const real = headerMap.get(key)
    return real !== undefined ? row[real] : null
  }

  const byCode = new Map<string, OrderRow>()
  const rowErrors: { row: number; error: string }[] = []
  rawRows.forEach((row, i) => {
    const n = i + 2 // 1-based + header row
    const code = str(col(row, 'ordercode'))?.toUpperCase() ?? null
    if (!code) return // blank line — skip silently
    if (!DHC_PATTERN.test(code)) {
      rowErrors.push({ row: n, error: `order_code không hợp lệ: ${code}` })
      return
    }
    if (byCode.has(code)) {
      rowErrors.push({ row: n, error: `order_code trùng lặp: ${code} (giữ dòng đầu)` })
      return
    }
    const created = parseVnSlashDate(col(row, 'createddate'))
    if (created === null && col(row, 'createddate')) {
      rowErrors.push({ row: n, error: `created_date không đọc được: ${String(col(row, 'createddate'))}` })
    }
    byCode.set(code, {
      order_code:    code,
      created_date:  created,
      pos_code:      str(col(row, 'poscode')),
      pos_name:      str(col(row, 'posname')),
      phone_number:  str(col(row, 'phonenumber')),
      customer_name: str(col(row, 'customername')),
      products_raw:  str(col(row, 'products')),
    })
  })

  return { byCode, rowErrors }
}
