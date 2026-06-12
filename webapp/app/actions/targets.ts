'use server'

import { revalidatePath } from 'next/cache'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { normalizeRow, type TargetRow } from '@/lib/targets/parse'
import { upsertTargetRows } from '@/lib/targets/ingest'

const MAX_FILE_BYTES = 5 * 1024 * 1024

// Fallback/manual loader for the BI export. The daily path is the automated
// /api/targets/ingest push — this exists so a broken pipeline never blocks
// the pharmacists' numbers for more than the minute it takes to upload.
export async function uploadWeeklyTargets(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin' || !isSuperAdminEmail(user.email))
    return { error: 'Chỉ super admin mới nạp được dữ liệu doanh số' }

  const file = formData.get('file')
  if (!(file instanceof File)) return { error: 'Chưa chọn file' }
  if (file.size > MAX_FILE_BYTES) return { error: 'File quá lớn (tối đa 5MB)' }

  let rawRows: Record<string, unknown>[]
  try {
    const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer' })
    const sheetName = wb.SheetNames.includes('Export') ? 'Export' : wb.SheetNames[0]
    if (!sheetName) return { error: 'File không có sheet nào' }
    rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
  } catch {
    return { error: 'Không đọc được file — cần đúng file XLSX export từ Power BI' }
  }
  if (rawRows.length === 0) return { error: 'File không có dòng dữ liệu nào' }
  if (rawRows.length > 1000) return { error: 'File quá nhiều dòng — sai file?' }

  const rows: TargetRow[] = []
  const rowErrors: string[] = []
  for (const raw of rawRows) {
    // Power BI table exports append a "Total" row and an "Applied filters:"
    // footer — skip those silently instead of alarming the uploader.
    const pn = raw['pos_name']
    const isExportArtifact = typeof pn === 'string'
      && (/^total$/i.test(pn.trim()) || pn.trimStart().startsWith('Applied filters'))
    // XLSX export carries RunRate as a 0-1 fraction.
    const r = normalizeRow(raw, { runRateIsFraction: true })
    if ('error' in r) { if (!isExportArtifact) rowErrors.push(r.error) }
    else rows.push(r)
  }
  if (rows.length === 0)
    return { error: `Không có dòng hợp lệ nào (${rowErrors[0] ?? 'sai định dạng cột'})` }

  try {
    const { upserted, unmatched } = await upsertTargetRows(rows, 'upload', user.id)
    revalidatePath('/targets')
    return { success: true, upserted, unmatched, rowErrors }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
