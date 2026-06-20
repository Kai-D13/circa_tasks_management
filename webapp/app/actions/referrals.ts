'use server'

import { revalidatePath } from 'next/cache'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'
import { excelSerialToISO } from '@/lib/targets/parse'

// Manual snapshot loader for the "Giới thiệu bạn bè" campaign. Super admin uploads
// the xlsx exported from BigQuery; we parse it and REPLACE all rows in
// staff_referrals. Staff then read their own rows (RLS by normalized phone).
// Campaign-scoped — reusable next round by uploading a fresh export.

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_ROWS       = 5000

// Mirror migration 059 normalize_phone: digits only, 84→0, ensure leading 0.
function normPhone(p: unknown): string | null {
  if (p === null || p === undefined) return null
  let d = String(p).replace(/[^0-9]/g, '')
  if (!d) return null
  if (d.startsWith('84')) d = '0' + d.slice(2)
  else if (!d.startsWith('0')) d = '0' + d
  return d
}
function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  const s = String(v ?? '').trim().toUpperCase()
  return s === 'TRUE' || s === '1' || s === 'YES'
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
function dateStr(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return excelSerialToISO(v) // Excel serial date
  const s = String(v).trim()
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/) // ISO (BigQuery export)
  if (iso) return iso[1]
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/) // MM/DD/YYYY
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
  return null
}

export async function uploadReferralReport(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin' || !isSuperAdminEmail(user.email))
    return { error: 'Chỉ super admin mới nạp được dữ liệu giới thiệu' }

  const file = formData.get('file')
  if (!(file instanceof File)) return { error: 'Chưa chọn file' }
  if (file.size > MAX_FILE_BYTES) return { error: 'File quá lớn (tối đa 5MB)' }

  let rawRows: Record<string, unknown>[]
  try {
    const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer' })
    const sheetName = wb.SheetNames[0]
    if (!sheetName) return { error: 'File không có sheet nào' }
    rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
  } catch {
    return { error: 'Không đọc được file — cần đúng file .xlsx export từ BigQuery' }
  }
  if (rawRows.length === 0) return { error: 'File không có dòng dữ liệu nào' }
  if (rawRows.length > MAX_ROWS) return { error: `File quá nhiều dòng (>${MAX_ROWS}) — sai file?` }

  const headerKeys = new Set(Object.keys(rawRows[0]).map((k) => k.trim().toLowerCase()))
  const required = ['phone_number', 'referred_phone', 'status', 'same_day_order', 'referral_date']
  const missing = required.filter((h) => !headerKeys.has(h))
  if (missing.length) {
    return { error: `File thiếu cột: ${missing.join(', ')} — kiểm tra lại file xuất từ BigQuery` }
  }

  const rows = rawRows
    .map((raw) => {
      const lo: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(raw)) lo[k.trim().toLowerCase()] = v
      return {
        store_code:           str(lo['store_code']),
        store_name:           str(lo['store_name']),
        phone_number:         normPhone(lo['phone_number']),
        full_name:            str(lo['full_name']),
        status:               str(lo['status']),
        referred_phone:       str(lo['referred_phone']),
        referral_date:        dateStr(lo['referral_date']),
        same_day_order:       asBool(lo['same_day_order']),
        customer_id:          str(lo['customer_id']),
        is_exist_in_referral: asBool(lo['is_exist_in_referral']),
      }
    })
    .filter((r) => r.phone_number) // a staff phone is required to map the row

  if (rows.length === 0) return { error: 'Không có dòng nào có phone_number hợp lệ' }

  try {
    // Atomic replace via RPC (delete-all + insert in one transaction) so a failed
    // upload never leaves the report empty/partial.
    const { data: inserted, error: rpcErr } = await supabaseAdmin.rpc('replace_staff_referrals', {
      p_rows: rows,
      p_uploaded_by: user.id,
    })
    if (rpcErr) return { error: `Ghi dữ liệu lỗi: ${rpcErr.message}` }
    revalidatePath('/gioi-thieu')
    revalidatePath('/targets')
    const staffCount = new Set(rows.map((r) => r.phone_number)).size
    return { success: true, inserted: (inserted as number | null) ?? rows.length, staffCount }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
