'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createResumableUploadSession, publicUrlForKey, isGcsEnabled } from '@/lib/storage/gcs'
import { safeStorageName } from '@/lib/storage'

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

type UploadPurpose = 'task_result' | 'task_input' | 'prescription'

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
    const { data: me } = await supabase.from('users').select('role').eq('id', user.id).single()
    if (me?.role !== 'admin') return { error: 'Chỉ admin được tải tệp hướng dẫn' }
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
    const { data: me } = await supabase.from('users').select('role, store_id').eq('id', user.id).single()
    const ok = (me?.role === 'staff' || me?.role === 'store_manager') && me?.store_id === input.storeId
    if (!ok) return { error: 'Không có quyền upload cho cửa hàng này' }
    key = `prescriptions/${input.storeId}/${input.submissionId}/${uniq}_${safe}`

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
