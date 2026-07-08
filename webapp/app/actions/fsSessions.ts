'use server'

import { revalidatePath } from 'next/cache'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID } from '@/lib/fs/constants'
import { parseFsRows, type FsImportResult } from '@/lib/fs/import'
import { deleteObject, keyFromPublicUrl } from '@/lib/storage/gcs'

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

const NOTE_MAX = 500

// ── F3 review actions (Policy/super) ────────────────────────────────────────
// Bulk (or single) whole-item resubmit. note required (stakeholder).
export async function resubmitFsItems(sessionId: string, itemIds: string[], note: string) {
  const auth = await requireFsManager()
  if ('error' in auth) return { error: auth.error }
  const ids = [...new Set((itemIds ?? []).filter(Boolean))] // dedupe (RPC RAISEs on count mismatch)
  if (!sessionId || !ids.length) return { error: 'Chưa chọn sản phẩm' }
  const n = note?.trim()
  if (!n) return { error: 'Vui lòng nhập lý do làm lại' }
  const { data, error } = await supabaseAdmin.rpc('rpc_fs_resubmit_items', {
    p_session_id: sessionId, p_item_ids: ids, p_note: n.slice(0, NOTE_MAX), p_actor: auth.user.id,
  })
  if (error) return { error: 'Không gửi được yêu cầu làm lại: ' + error.message }
  revalidatePath(`/fs/products/${sessionId}`)
  return { success: true as const, count: (data as number) ?? 0 }
}

// Per-box resubmit (single item). note required.
export async function resubmitFsBox(sessionId: string, itemId: string, boxKey: number, note: string) {
  const auth = await requireFsManager()
  if ('error' in auth) return { error: auth.error }
  if (!itemId || !(boxKey >= 1 && boxKey <= 5)) return { error: 'Box ảnh không hợp lệ' }
  const n = note?.trim()
  if (!n) return { error: 'Vui lòng nhập lý do làm lại' }
  const { error } = await supabaseAdmin.rpc('rpc_fs_resubmit_box', {
    p_item_id: itemId, p_box_key: boxKey, p_note: n.slice(0, NOTE_MAX), p_actor: auth.user.id,
  })
  if (error) return { error: 'Không gửi được yêu cầu làm lại: ' + error.message }
  revalidatePath(`/fs/products/${sessionId}`)
  return { success: true as const }
}

// Close a session (complete) or cancel it. Active-only (enforced in the RPC).
export async function closeFsSession(sessionId: string, status: 'completed' | 'cancelled', note?: string) {
  const auth = await requireFsManager()
  if ('error' in auth) return { error: auth.error }
  if (status !== 'completed' && status !== 'cancelled') return { error: 'Trạng thái không hợp lệ' }
  const { error } = await supabaseAdmin.rpc('rpc_fs_close_session', {
    p_session_id: sessionId, p_status: status, p_actor: auth.user.id, p_note: note?.trim()?.slice(0, NOTE_MAX) ?? null,
  })
  if (error) return { error: (status === 'completed' ? 'Không đóng được phiên: ' : 'Không huỷ được phiên: ') + error.message }
  revalidatePath(`/fs/products/${sessionId}`)
  revalidatePath('/fs/products')
  return { success: true as const }
}

// ── Item actions (Policy/super, Batch A) ────────────────────────────────────
// Soft-remove an item (product sold out → no stock to shoot). Audit kept.
export async function removeFsItem(sessionId: string, itemId: string, reason: string) {
  const auth = await requireFsManager()
  if ('error' in auth) return { error: auth.error }
  const r = reason?.trim()
  if (!r) return { error: 'Vui lòng nhập lý do xoá' }
  const { error } = await supabaseAdmin.rpc('rpc_fs_remove_item', {
    p_session_id: sessionId, p_item_id: itemId, p_reason: r.slice(0, NOTE_MAX), p_actor: auth.user.id,
  })
  if (error) return { error: 'Không xoá được sản phẩm: ' + error.message }
  revalidatePath(`/fs/products/${sessionId}`)
  revalidatePath('/fs/products')
  return { success: true as const }
}

// Edit an item: product_name anytime; product_id only when pending + photoless
// (enforced in the RPC). productId omitted/unchanged → name-only edit.
export async function updateFsItem(
  sessionId: string, itemId: string, input: { productName: string; productId?: string },
) {
  const auth = await requireFsManager()
  if ('error' in auth) return { error: auth.error }
  const name = input.productName?.trim()
  if (!name) return { error: 'Tên sản phẩm không được trống' }
  const { error } = await supabaseAdmin.rpc('rpc_fs_update_item', {
    p_item_id: itemId, p_product_name: name.slice(0, 300),
    p_product_id: input.productId?.trim() || null, p_actor: auth.user.id,
  })
  if (error) return { error: 'Không sửa được sản phẩm: ' + error.message }
  revalidatePath(`/fs/products/${sessionId}`)
  return { success: true as const }
}

// Item history for the "Lịch sử" drawer — the audit trail from fs_item_events.
export async function getFsItemEvents(itemId: string) {
  const auth = await requireFsManager()
  if ('error' in auth) return { error: auth.error }
  const { data, error } = await supabaseAdmin
    .from('fs_item_events')
    .select('id, event_type, box_key, note, actor, created_at')
    .eq('item_id', itemId).order('created_at', { ascending: false })
  if (error) return { error: error.message }
  const ids = [...new Set((data ?? []).map((e) => e.actor).filter(Boolean))] as string[]
  const { data: users } = ids.length
    ? await supabaseAdmin.from('users').select('id, full_name').in('id', ids)
    : { data: [] as { id: string; full_name: string }[] }
  const nameById = new Map((users ?? []).map((u) => [u.id, u.full_name]))
  return {
    success: true as const,
    events: (data ?? []).map((e) => ({
      id: e.id, event_type: e.event_type, box_key: e.box_key, note: e.note,
      created_at: e.created_at, actor_name: e.actor ? (nameById.get(e.actor) ?? null) : null,
    })),
  }
}

// Policy/super release a stuck claim (staff/store_manager cannot — stakeholder).
export async function releaseFsClaim(sessionId: string) {
  const auth = await requireFsManager()
  if ('error' in auth) return { error: auth.error }
  const { error } = await supabaseAdmin.rpc('rpc_fs_release_claim', { p_session_id: sessionId, p_actor: auth.user.id })
  if (error) return { error: 'Không gỡ được người xử lý: ' + error.message }
  revalidatePath(`/fs/products/${sessionId}`)
  revalidatePath(`/fs/products/${sessionId}/process`)
  return { success: true as const }
}

// ── F4 staff processing ─────────────────────────────────────────────────────
async function currentUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

// Claim a session (1 staff of the FS store owns an active session at a time).
export async function claimFsSession(sessionId: string) {
  const uid = await currentUserId()
  if (!uid) return { error: 'Chưa đăng nhập' }
  const { error } = await supabaseAdmin.rpc('rpc_fs_claim_session', { p_session_id: sessionId, p_user_id: uid })
  if (error) return { error: error.message }
  revalidatePath(`/fs/products/${sessionId}/process`)
  revalidatePath('/fs/products')
  return { success: true as const }
}

// Staff self-release (hand over) — clears the caller's own claim so the list
// doesn't stay stuck when they step away. Race-safe in the RPC (holder-only).
export async function releaseFsClaimSelf(sessionId: string) {
  const uid = await currentUserId()
  if (!uid) return { error: 'Chưa đăng nhập' }
  const { error } = await supabaseAdmin.rpc('rpc_fs_release_claim_self', { p_session_id: sessionId, p_user_id: uid })
  if (error) return { error: error.message }
  revalidatePath(`/fs/products/${sessionId}/process`)
  revalidatePath('/fs/products')
  return { success: true as const }
}

interface FsPhotoInput { box_key: number; storage_path: string; content_type?: string; size_bytes?: number }

// Submit one item: dims + box photos → 'done'. The claimer only (RPC-enforced).
// After the DB commit, replaced GCS objects are deleted (last-version-only);
// a delete failure is logged (gcs_delete_failed) and never fails the submit.
export async function submitFsItem(input: {
  sessionId: string; itemId: string
  length: number; width: number; height: number
  photos: FsPhotoInput[]
}) {
  const uid = await currentUserId()
  if (!uid) return { error: 'Chưa đăng nhập' }
  if (!input.itemId) return { error: 'Thiếu sản phẩm' }

  // Capture current photos BEFORE the upsert so we can delete replaced objects.
  const { data: oldPhotos } = await supabaseAdmin
    .from('fs_item_photos').select('box_key, storage_path').eq('item_id', input.itemId)
  const oldByBox = new Map((oldPhotos ?? []).map((p) => [p.box_key, p.storage_path]))

  const { error } = await supabaseAdmin.rpc('rpc_fs_submit_item', {
    p_item_id: input.itemId, p_user_id: uid,
    p_length: input.length, p_width: input.width, p_height: input.height,
    p_photos: input.photos ?? [],
  })
  if (error) return { error: error.message }

  for (const p of input.photos ?? []) {
    const old = oldByBox.get(p.box_key)
    if (old && old !== p.storage_path) {
      const key = keyFromPublicUrl(old)
      const ok = key ? await deleteObject(key).catch(() => false) : true
      if (!ok) {
        await supabaseAdmin.from('fs_item_events').insert({
          session_id: input.sessionId, item_id: input.itemId, box_key: p.box_key,
          event_type: 'gcs_delete_failed', note: old, actor: uid,
        })
      }
    }
  }

  revalidatePath(`/fs/products/${input.sessionId}/process`)
  revalidatePath(`/fs/products/${input.sessionId}`)
  return { success: true as const }
}

// Delete a STAGED FS photo (uploaded to GCS but not yet saved to fs_item_photos)
// — the 'X' on a not-yet-submitted box, a replace, or a discard-on-close. Gated:
// the object must be under fs-products/, NOT referenced in the DB (protects saved
// photos), and the caller must be the active session's claimer.
export async function deleteFsStagedPhoto(url: string) {
  const uid = await currentUserId()
  if (!uid) return { error: 'Chưa đăng nhập' }
  const key = keyFromPublicUrl(url)
  if (!key || !key.startsWith('fs-products/')) return { error: 'Đường dẫn ảnh không hợp lệ' }

  // Never delete a saved photo through this path.
  const { data: ref } = await supabaseAdmin.from('fs_item_photos').select('id').eq('storage_path', url).maybeSingle()
  if (ref) return { error: 'Ảnh đã lưu — không thể xoá tạm' }

  // key = fs-products/<sessionId>/<itemId>/<file> → authorise via the session claim.
  const parts = key.split('/')
  const sessionId = parts[1]
  if (!/^[0-9a-f-]{36}$/i.test(sessionId ?? '')) return { error: 'Đường dẫn ảnh không hợp lệ' }
  const { data: sess } = await supabaseAdmin
    .from('fs_sessions').select('claimed_by, status').eq('id', sessionId).maybeSingle()
  if (!sess || sess.status !== 'active' || sess.claimed_by !== uid)
    return { error: 'Không có quyền xoá ảnh này' }

  const ok = await deleteObject(key).catch(() => false)
  if (!ok) return { error: 'Không xoá được ảnh trên lưu trữ' }
  return { success: true as const }
}

// Batch variant — one call when closing an item with several staged photos (fewer
// round trips than N single deletes). Same gating as deleteFsStagedPhoto: each url
// under fs-products/, NOT referenced in fs_item_photos, caller = the session claimer.
export async function deleteFsStagedPhotos(urls: string[]) {
  const uid = await currentUserId()
  if (!uid) return { error: 'Chưa đăng nhập' }
  const items = [...new Set((urls ?? []).filter(Boolean))]
    .map((url) => ({ url, key: keyFromPublicUrl(url) }))
    .filter((x): x is { url: string; key: string } => !!x.key && x.key.startsWith('fs-products/'))
  if (items.length === 0) return { success: true as const, deleted: 0, failed: [] as string[] }

  // Only delete objects NOT saved in the DB (protect committed photos).
  const { data: refs } = await supabaseAdmin
    .from('fs_item_photos').select('storage_path').in('storage_path', items.map((i) => i.url))
  const saved = new Set((refs ?? []).map((r) => r.storage_path))

  // Verify the caller claims each object's session (cache one check per session).
  const claimOk = new Map<string, boolean>()
  async function canDelete(key: string): Promise<boolean> {
    const sessionId = key.split('/')[1]
    if (!/^[0-9a-f-]{36}$/i.test(sessionId ?? '')) return false
    if (claimOk.has(sessionId)) return claimOk.get(sessionId)!
    const { data: sess } = await supabaseAdmin
      .from('fs_sessions').select('claimed_by, status').eq('id', sessionId).maybeSingle()
    const ok = !!sess && sess.status === 'active' && sess.claimed_by === uid
    claimOk.set(sessionId, ok)
    return ok
  }

  const failed: string[] = []
  let deleted = 0
  for (const it of items) {
    if (saved.has(it.url)) continue // saved photo → never delete here
    if (!(await canDelete(it.key))) { failed.push(it.url); continue }
    const ok = await deleteObject(it.key).catch(() => false)
    if (ok) deleted++
    else failed.push(it.url)
  }
  return { success: true as const, deleted, failed }
}
