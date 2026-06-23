import { excelSerialToISO } from '@/lib/targets/parse'

// Shared parser for the "Giới thiệu bạn bè" referral feed. Two sources, one shape:
//   * Manual JSON upload (app/actions/referrals.ts) — array of row objects.
//   * Google Sheet pull (app/api/cron/pull-referrals) — rows from the Sheets API.
// Both produce Record<string, unknown>[]; this maps them to staff_referrals rows
// for replace_staff_referrals(). Header-tolerant + phone/bool/date normalization.

export const MAX_REFERRAL_ROWS = 5000

export interface ReferralRow {
  store_code:           string | null
  store_name:           string | null
  phone_number:         string | null
  full_name:            string | null
  status:               string | null
  referred_phone:       string | null
  referral_date:        string | null
  same_day_order:       boolean
  customer_id:          string | null
  is_exist_in_referral: boolean
}

// Mirror migration 059 normalize_phone: digits only, 84→0, ensure leading 0.
export function normPhone(p: unknown): string | null {
  if (p === null || p === undefined) return null
  let d = String(p).replace(/[^0-9]/g, '')
  if (!d) return null
  if (d.startsWith('84')) d = '0' + d.slice(2)
  else if (!d.startsWith('0')) d = '0' + d
  return d
}
export function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  const s = String(v ?? '').trim().toUpperCase()
  return s === 'TRUE' || s === '1' || s === 'YES'
}
export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
export function dateStr(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return excelSerialToISO(v) // Excel/Sheets serial date
  const s = String(v).trim()
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/) // ISO (BigQuery/Sheets export)
  if (iso) return iso[1]
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/) // MM/DD/YYYY
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
  return null
}

// Canonicalize headers (drop spaces/underscores/case) so 'phone_number',
// 'Phone Number', 'phonenumber' all match — robust to BI/Excel/Sheet styles.
const canon = (k: string) => k.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

// Parse + validate raw rows → staff_referrals rows. Returns an error string for
// empty/oversized input or a missing required column.
export function parseReferralRows(
  rawRows: Record<string, unknown>[],
): { rows: ReferralRow[] } | { error: string } {
  if (rawRows.length === 0) return { error: 'Không có dòng dữ liệu nào' }
  if (rawRows.length > MAX_REFERRAL_ROWS) return { error: `Quá nhiều dòng (>${MAX_REFERRAL_ROWS}) — sai nguồn dữ liệu?` }

  const headerKeys = new Set(Object.keys(rawRows[0]).map(canon))
  const required: [string, string][] = [
    ['phonenumber', 'phone_number'], ['referredphone', 'referred_phone'], ['status', 'status'],
    ['samedayorder', 'same_day_order'], ['referraldate', 'referral_date'],
  ]
  const missing = required.filter(([c]) => !headerKeys.has(c)).map(([, label]) => label)
  if (missing.length) {
    return { error: `Thiếu cột: ${missing.join(', ')} — kiểm tra lại nguồn dữ liệu` }
  }

  const rows: ReferralRow[] = rawRows
    .map((raw) => {
      const lo: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(raw)) lo[canon(k)] = v
      return {
        store_code:           str(lo['storecode']),
        store_name:           str(lo['storename']),
        phone_number:         normPhone(lo['phonenumber']),
        full_name:            str(lo['fullname']),
        status:               str(lo['status']),
        referred_phone:       str(lo['referredphone']),
        referral_date:        dateStr(lo['referraldate']),
        same_day_order:       asBool(lo['samedayorder']),
        customer_id:          str(lo['customerid']),
        is_exist_in_referral: asBool(lo['isexistinreferral']),
      }
    })
    .filter((r) => r.phone_number) // a staff phone is required to map the row

  if (rows.length === 0) return { error: 'Không có dòng nào có phone_number hợp lệ' }
  return { rows }
}
