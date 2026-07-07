'use server'

import { revalidatePath } from 'next/cache'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID } from '@/lib/fs/constants'
import { parseFsRows, type FsImportResult } from '@/lib/fs/import'

const MAX_FILE_BYTES = 5 * 1024 * 1024

// FS module management = super admin OR an admin of dept Policy. Both create/
// review sessions; FS store staff/managers use the wizard (F4). RLS also gates
// reads; writes here go through supabaseAdmin (no write policy, service-role RPC).
async function requireFsManager() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' as const }
  const { data: profile } = await supabase
    .from('users').select('role, department_id').eq('id', user.id).single()
  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isPolicy = profile?.role === 'admin' && profile?.department_id === POLICY_DEPT_ID
  if (!isSuper && !isPolicy) return { error: 'Bạn không có quyền quản lý module FS' as const }
  return { user, supabase }
}

// Read the workbook once; return the rows of a chosen sheet (defaults to first)
// plus the full sheet-name list so the client can offer a sheet picker.
async function readWorkbook(formData: FormData, sheetName?: string):
  Promise<{ rows: Record<string, unknown>[]; sheetName: string; sheets: string[] } | { error: string }> {
  const file = formData.get('file')
  if (!(file instanceof File)) return { error: 'Chưa chọn file' }
  if (file.size > MAX_FILE_BYTES) return { error: 'File quá lớn (tối đa 5MB)' }
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer' })
  } catch {
    return { error: 'Không đọc được file — cần đúng định dạng XLSX hoặc CSV' }
  }
  if (wb.SheetNames.length === 0) return { error: 'File không có sheet nào' }
  const name = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0]
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null }) as Record<string, unknown>[]
  if (rows.length > 5000) return { error: 'Sheet quá nhiều dòng — kiểm tra lại file' }
  return { rows, sheetName: name, sheets: wb.SheetNames }
}

// Step 1 — list the sheets in the uploaded file (the sample file has one sheet
// per FS store). No parsing/validation yet.
export async function readFsSheets(formData: FormData) {
  const auth = await requireFsManager()
  if ('error' in auth) return { error: auth.error }
  const wb = await readWorkbook(formData)
  if ('error' in wb) return { error: wb.error }
  return { success: true as const, sheets: wb.sheets }
}

// Step 2 — parse + validate one chosen sheet. No DB write.
export async function previewFsImport(formData: FormData, sheetName: string) {
  const auth = await requireFsManager()
  if ('error' in auth) return { error: auth.error }
  const wb = await readWorkbook(formData, sheetName)
  if ('error' in wb) return { error: wb.error }
  const res = parseFsRows(wb.rows)
  if ('error' in res) return { error: res.error }
  const r = res as FsImportResult
  return {
    success: true as const,
    sheetName: wb.sheetName,
    validCount: r.valid.length,
    invalid: r.invalid,
    duplicates: r.duplicates,
    preview: r.valid.slice(0, 50),
  }
}

// Step 3 — create the session atomically. Re-parses server-side (never trusts a
// client row list). No partial write: any invalid row blocks the whole import.
export async function createFsSession(
  formData: FormData,
  input: { storeId: string; sheetName: string; sessionName: string },
) {
  const auth = await requireFsManager()
  if ('error' in auth) return { error: auth.error }

  const storeId = input.storeId
  if (!storeId) return { error: 'Vui lòng chọn cửa hàng FS' }

  // Friendly guard before the DB trigger fires (which would RAISE a raw message).
  const { data: store } = await supabaseAdmin
    .from('stores').select('id, name, store_type, is_active').eq('id', storeId).single()
  if (!store || store.store_type !== 'fs' || store.is_active === false)
    return { error: 'Cửa hàng FS không hợp lệ (không tồn tại / không phải FS / đã ngừng hoạt động)' }

  const wb = await readWorkbook(formData, input.sheetName)
  if ('error' in wb) return { error: wb.error }
  const res = parseFsRows(wb.rows)
  if ('error' in res) return { error: res.error }
  const r = res as FsImportResult
  if (r.valid.length === 0) return { error: 'Không có sản phẩm hợp lệ trong sheet' }
  if (r.invalid.length > 0)
    return { error: `Sheet còn ${r.invalid.length} dòng lỗi — sửa hết rồi tạo lại (không ghi từng phần)`, invalid: r.invalid }

  const file = formData.get('file')
  const fileName = file instanceof File ? file.name : null
  let sessionName = (input.sessionName?.trim() || wb.sheetName || store.name)
  if (sessionName.length > 120) sessionName = sessionName.slice(0, 120)

  const items = r.valid.map((v) => ({ product_id: v.product_id, product_name: v.product_name }))
  const { data: sessionId, error } = await supabaseAdmin.rpc('rpc_create_fs_session', {
    p_store_id:   storeId,
    p_name:       sessionName,
    p_created_by: auth.user.id,
    p_items:      items,
    p_file_name:  fileName,
    p_sheet_name: wb.sheetName,
  })
  if (error) return { error: 'Không tạo được phiên: ' + error.message }

  revalidatePath('/fs/products')
  return { success: true as const, sessionId: sessionId as string, created: items.length }
}
