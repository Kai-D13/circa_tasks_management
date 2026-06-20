'use server'

import { revalidatePath } from 'next/cache'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'

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
  const s = str(v)
  if (!s) return null
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/) // BigQuery exports ISO dates
  return m ? m[1] : null
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
  if (!headerKeys.has('phone_number')) {
    return { error: 'Thiếu cột phone_number — kiểm tra lại file xuất từ BigQuery' }
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
        uploaded_by:          user.id,
      }
    })
    .filter((r) => r.phone_number) // a staff phone is required to map the row

  if (rows.length === 0) return { error: 'Không có dòng nào có phone_number hợp lệ' }

  try {
    // Replace-all snapshot (campaign tool; super admin re-uploads if interrupted).
    const { error: delErr } = await supabaseAdmin.from('staff_referrals').delete().not('id', 'is', null)
    if (delErr) return { error: `Xóa dữ liệu cũ lỗi: ${delErr.message}` }
    for (let i = 0; i < rows.length; i += 500) {
      const { error: insErr } = await supabaseAdmin.from('staff_referrals').insert(rows.slice(i, i + 500))
      if (insErr) return { error: `Ghi dữ liệu lỗi: ${insErr.message}` }
    }
    revalidatePath('/gioi-thieu')
    revalidatePath('/targets')
    const staffCount = new Set(rows.map((r) => r.phone_number)).size
    return { success: true, inserted: rows.length, staffCount }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
