'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'
import { isReferralEnabled } from '@/lib/affiliate/flags'
import { parseReferralRows } from '@/lib/referrals/parse'

// Manual snapshot loader for the "Giới thiệu bạn bè" campaign — super admin uploads
// the JSON exported from BigQuery (array of row objects); we parse it and REPLACE
// all rows in staff_referrals. The same data also arrives automatically via the
// Google Sheet cron (app/api/cron/pull-referrals) using parseReferralRows. Staff
// read their own rows (RLS by normalized phone).

const MAX_FILE_BYTES = 5 * 1024 * 1024

export async function uploadReferralReport(formData: FormData) {
  // Program has ended — reject BEFORE reading the file (stakeholder audit P1:
  // every entry point checks the flag, not just the UI).
  if (!isReferralEnabled()) {
    return { error: 'Chương trình Giới thiệu bạn bè đã ngưng (REFERRAL_ENABLED=false)' }
  }
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
    const parsed = JSON.parse(await file.text())
    if (!Array.isArray(parsed)) {
      return { error: 'File JSON phải là một mảng các dòng dữ liệu' }
    }
    rawRows = parsed.filter((r) => r && typeof r === 'object') as Record<string, unknown>[]
  } catch {
    return { error: 'Không đọc được file — cần đúng file JSON export từ BigQuery' }
  }

  const parsedRows = parseReferralRows(rawRows)
  if ('error' in parsedRows) return { error: parsedRows.error }
  const rows = parsedRows.rows

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
