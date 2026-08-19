'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { createResumableUploadSession, publicUrlForKey, isGcsEnabled } from '@/lib/storage/gcs'
import { safeStorageName } from '@/lib/storage'
import { isSuperAdminEmail } from '@/lib/authz'
import { FS_PHOTO_BOXES } from '@/lib/fs/constants'
import { canCreateTask } from '@/lib/tasks/smScope'

// Authorized upload-URL minting for direct-to-GCS uploads. THIS IS THE SECURITY
// BOUNDARY that replaces Supabase Storage RLS for GCS uploads — it must mirror
// the CURRENT storage.objects task_uploads_insert policy (migration 039):
//   tasks/<taskId>/...        → the task's direct assignee, OR ANY staff/
//                               store_manager of a store-level task. Not archived.
//   task-inputs/<uploadId>/...→ admin only.
//   prescriptions/<storeId>/..→ staff/store_manager of that store.
// Returns a resumable session URL the browser PUTs the file to, plus the final
// public URL to persist (same DB shape as the Supabase public URL).

const MAX_IMAGE = 5  * 1024 * 1024
const MAX_AUDIO = 15 * 1024 * 1024
const MAX_VIDEO = 50 * 1024 * 1024  // matches the Supabase bucket cap (no video regression)
const MAX_DOC   = 10 * 1024 * 1024

type UploadPurpose = 'task_result' | 'task_input' | 'prescription' | 'prescription_care' | 'announcement_asset' | 'fs_product'

export interface CreateUploadUrlInput {
  purpose:      UploadPurpose
  filename:     string
  contentType:  string
  size:         number
  taskId?:      string  // task_result
  outputType?:  string  // task_result: image | video | file
  uploadId?:    string  // task_input — the per-form upload id (e.g. 'import/<tmpId>' for Excel)
  storeId?:     string  // prescription
  submissionId?: string // prescription
  announcementId?: string // announcement_asset — real id (edit) or a client temp id (create)
  itemId?:      string  // fs_product — the fs_session_items id
  boxKey?:      number  // fs_product — 1..5
}

type Result = { error: string } | { sessionUrl: string; publicUrl: string; key: string }

export async function createUploadUrl(input: CreateUploadUrlInput): Promise<Result> {
  // When GCS is off, the client keeps its existing Supabase upload path.
  if (!isGcsEnabled()) return { error: 'GCS_DISABLED' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Chưa đăng nhập' }

  // Size/type guard (mirrors the client limits; server is the real gate).
  const ct = input.contentType || ''
  const size = Number(input.size) || 0
  const limit = ct.startsWith('image/') ? MAX_IMAGE
    : ct.startsWith('audio/') ? MAX_AUDIO
    : ct.startsWith('video/') ? MAX_VIDEO
    : MAX_DOC
  if (size <= 0) return { error: 'File rỗng' }
  if (size > limit) return { error: 'File vượt giới hạn dung lượng' }

  const safe  = safeStorageName(input.filename || 'file')
  const uniq  = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
  let key: string

  if (input.purpose === 'task_result') {
    if (!input.taskId) return { error: 'Thiếu taskId' }
    const outputType = ['image', 'video', 'file'].includes(input.outputType ?? '') ? input.outputType! : 'file'
    const { data: task } = await supabase
      .from('tasks')
      .select('assigned_to, store_id, assignment_mode, archived_at')
      .eq('id', input.taskId).maybeSingle()
    if (!task || task.archived_at) return { error: 'Task không hợp lệ' }
    const { data: me } = await supabase.from('users').select('role, store_id').eq('id', user.id).single()
    const isAssignee = task.assigned_to === user.id
    // Store-level task (assignment_mode='store', unassigned): ANY staff OR
    // store_manager of the task's store may submit/upload — migration 039 widened
    // this from store_manager-only. Mirror it exactly.
    const isStoreLevelSubmitter =
      task.assigned_to === null &&
      task.assignment_mode === 'store' &&
      !!task.store_id &&
      task.store_id === me?.store_id &&
      (me?.role === 'staff' || me?.role === 'store_manager')
    if (!isAssignee && !isStoreLevelSubmitter) return { error: 'Không có quyền upload cho task này' }
    key = `tasks/${input.taskId}/${outputType}/${uniq}_${safe}`

  } else if (input.purpose === 'task_input') {
    // Mig 108: SM cũng tạo được task phát sinh nên phải đính kèm được tệp
    // hướng dẫn. Không nới thêm gì khác — vẫn cùng validate tên/MIME/kích
    // thước/đường dẫn, và tệp chỉ có ý nghĩa khi được gắn vào một broadcast đã
    // qua validate phạm vi ở createBroadcastTask.
    const { data: me } = await supabase.from('users').select('role').eq('id', user.id).single()
    if (!canCreateTask(me?.role)) return { error: 'Bạn không có quyền tải tệp hướng dẫn' }
    // 'import/<tmpId>' là vùng file Excel của luồng chia task hàng loạt — luồng
    // đó vẫn admin-only. UI đã ẩn với SM, nhưng UI ẩn KHÔNG phải ràng buộc:
    // chặn ở đây, và storage policy (108) chặn thêm một lớp ở tầng DB.
    if (me?.role !== 'admin' && input.uploadId?.startsWith('import/')) {
      return { error: 'Chỉ admin được tải tệp import' }
    }
    // uploadId is a per-form uuid OR 'import/<tmpId>' (Excel) — reject anything
    // else (no traversal, no empty, no stray slashes).
    if (!input.uploadId || !/^(import\/)?[A-Za-z0-9_-]{1,100}$/.test(input.uploadId)) {
      return { error: 'uploadId không hợp lệ' }
    }
    key = `task-inputs/${input.uploadId}/${uniq}_${safe}`

  } else if (input.purpose === 'prescription') {
    if (!input.storeId) return { error: 'Thiếu store' }
    if (!input.submissionId || !/^[A-Za-z0-9_-]{1,100}$/.test(input.submissionId)) {
      return { error: 'submissionId không hợp lệ' }
    }
    // Only staff submit prescriptions (submitPrescription gates role='staff'), so
    // narrow the upload to staff too — avoids store_manager minting orphan objects.
    const { data: me } = await supabase.from('users').select('role, store_id').eq('id', user.id).single()
    const ok = me?.role === 'staff' && me?.store_id === input.storeId
    if (!ok) return { error: 'Không có quyền upload cho cửa hàng này' }
    key = `prescriptions/${input.storeId}/${input.submissionId}/${uniq}_${safe}`

  } else if (input.purpose === 'prescription_care') {
    // Chronic-care evidence photos. Match submitPrescriptionCare's rule (locked
    // 2026-07-04): a STAFF may upload only for a prescription they submitted; a
    // STORE MANAGER for any in their store. Verified against the submission row.
    if (!input.submissionId || !/^[A-Za-z0-9_-]{1,100}$/.test(input.submissionId)) {
      return { error: 'submissionId không hợp lệ' }
    }
    if (!ct.startsWith('image/')) return { error: 'Chỉ chấp nhận ảnh' }
    const { data: me } = await supabase.from('users').select('role, store_id').eq('id', user.id).single()
    // Read the submission via the service client so the check doesn't depend on
    // the caller's own read-RLS (which would already hide non-owned rows).
    const { data: sub } = await supabaseAdmin
      .from('prescription_submissions')
      .select('store_id, submitted_by')
      .eq('id', input.submissionId)
      .maybeSingle()
    if (!sub) return { error: 'Không tìm thấy toa thuốc' }
    const ok =
      (me?.role === 'store_manager' && me?.store_id === sub.store_id) ||
      (me?.role === 'staff' && sub.submitted_by === user.id)
    if (!ok) return { error: 'Không có quyền chăm sóc toa thuốc này' }
    key = `prescription-care/${input.submissionId}/${uniq}_${safe}`

  } else if (input.purpose === 'announcement_asset') {
    // Cover/carousel images for an announcement — admin only (mirrors ann_insert).
    // announcementId is the real id (edit) or a client temp uuid (create); the GCS
    // key is arbitrary, the DB row links the real announcement id.
    const { data: me } = await supabase.from('users').select('role').eq('id', user.id).single()
    if (me?.role !== 'admin') return { error: 'Chỉ admin được tải ảnh thông báo' }
    if (!input.announcementId || !/^[A-Za-z0-9_-]{1,100}$/.test(input.announcementId)) {
      return { error: 'announcementId không hợp lệ' }
    }
    if (!ct.startsWith('image/')) return { error: 'Chỉ chấp nhận ảnh' }
    // Editing an EXISTING announcement → only its creator or a super admin may
    // upload (mirrors ann_update). A create-time temp UUID isn't in the table yet
    // → any admin may upload. (UUID-shaped check avoids an invalid-uuid query.)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.announcementId)
    if (isUuid) {
      const { data: existing } = await supabase.from('announcements').select('created_by').eq('id', input.announcementId).maybeSingle()
      if (existing && existing.created_by !== user.id && !isSuperAdminEmail(user.email)) {
        return { error: 'Không có quyền sửa thông báo này' }
      }
    }
    key = `announcement_assets/${input.announcementId}/${uniq}_${safe}`

  } else if (input.purpose === 'fs_product') {
    // FS product photo. GCS-only (no Supabase fallback). Only the CLAIMER of an
    // ACTIVE session (a staff/store_manager of its FS store) may upload, for a
    // pending/redo item of that session. Box 1..5. The object is renamed to the
    // standardised <product_id>_<box-slug>_<uniq>.<ext> (no raw client filename).
    if (!ct.startsWith('image/')) return { error: 'Chỉ chấp nhận ảnh' }
    if (ct === 'image/svg+xml') return { error: 'Không hỗ trợ ảnh SVG' }
    if (!input.itemId || !/^[0-9a-f-]{36}$/i.test(input.itemId)) return { error: 'itemId không hợp lệ' }
    const box = FS_PHOTO_BOXES.find((b) => b.key === input.boxKey)
    if (!box) return { error: 'Box ảnh không hợp lệ' }
    const { data: item } = await supabaseAdmin
      .from('fs_session_items')
      .select('id, product_id, session_id, status, fs_sessions!inner(store_id, status, claimed_by)')
      .eq('id', input.itemId).is('removed_at', null).maybeSingle()
    const sess = item ? (Array.isArray(item.fs_sessions) ? item.fs_sessions[0] : item.fs_sessions) as { store_id: string; status: string; claimed_by: string | null } : null
    if (!item || !sess) return { error: 'Sản phẩm không tồn tại' }
    if (sess.status !== 'active') return { error: 'Phiên không ở trạng thái đang xử lý' }
    if (sess.claimed_by !== user.id) return { error: 'Bạn chưa nhận phiên này' }
    // pending/redo = processing; done = self-correction (r4). Any is uploadable by
    // the claimer while the session is active.
    if (!['pending', 'redo', 'done'].includes(item.status as string)) return { error: 'Trạng thái sản phẩm không hợp lệ' }
    const { data: me } = await supabase.from('users').select('role, store_id').eq('id', user.id).single()
    // FS module is staff-only (F5) — the claimer is a 'staff' of the FS store.
    const ok = me?.role === 'staff' && me?.store_id === sess.store_id
    if (!ok) return { error: 'Không có quyền upload cho phiên này' }
    const EXT: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
      'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
    }
    const ext = EXT[ct] ?? 'jpg'
    key = `fs-products/${item.session_id}/${input.itemId}/${item.product_id}_${box.slug}_${uniq}.${ext}`

  } else {
    return { error: 'purpose không hợp lệ' }
  }

  // Origin the browser will send on its cross-origin PUT (must match bucket CORS).
  const origin = (await headers()).get('origin') || process.env.NEXT_PUBLIC_APP_URL || 'https://duocsi.circa.vn'

  try {
    const sessionUrl = await createResumableUploadSession(key, ct, origin, size)
    return { sessionUrl, publicUrl: publicUrlForKey(key), key }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Không tạo được phiên upload' }
  }
}
