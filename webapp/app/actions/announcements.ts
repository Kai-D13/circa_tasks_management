'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { sanitizeRichText, richTextToPlain } from '@/lib/richtext/sanitize'

// Announcements / Bảng tin — read-only broadcasts with a view receipt (migration
// 063). Admin creates; Staff/Store read (no submission). Audience = all | stores.

export async function createAnnouncement(input: {
  title: string
  body: string
  visibility: 'all' | 'stores'
  storeIds?: string[]
  expiresAt?: string | null   // 'YYYY-MM-DD'; null = no expiry
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Chỉ admin mới tạo được thông báo' }

  const title = input.title.trim()
  if (!title) return { error: 'Vui lòng nhập tiêu đề' }
  const body = sanitizeRichText(input.body)
  if (!body) return { error: 'Vui lòng nhập nội dung' }
  const excerpt = richTextToPlain(input.body).slice(0, 160)
  const visibility = input.visibility === 'stores' ? 'stores' : 'all'
  const storeIds = visibility === 'stores'
    ? [...new Set((input.storeIds ?? []).filter((s): s is string => typeof s === 'string'))]
    : []
  if (visibility === 'stores' && storeIds.length === 0)
    return { error: 'Chọn ít nhất một cửa hàng (hoặc gửi cho tất cả)' }

  // Expiry: keep the announcement active through the END of the chosen day (VN).
  let expires_at: string | null = null
  if (input.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt)) {
    expires_at = `${input.expiresAt}T23:59:59+07:00`
  }

  // Insert via the authed client so RLS (ann_insert) enforces admin + created_by.
  const { data: ann, error: annErr } = await supabase
    .from('announcements')
    .insert({ title, body, excerpt, visibility, created_by: user.id, expires_at })
    .select('id')
    .single()
  if (annErr || !ann) return { error: annErr?.message ?? 'Không tạo được thông báo' }

  // Audience rows via service role (announcement_stores writes are super-only in
  // RLS; the action is the trusted boundary). Roll back the parent on failure.
  if (storeIds.length) {
    const rows = storeIds.map((store_id) => ({ announcement_id: ann.id, store_id }))
    const { error: audErr } = await supabaseAdmin.from('announcement_stores').insert(rows)
    if (audErr) {
      await supabaseAdmin.from('announcements').delete().eq('id', ann.id)
      return { error: `Lỗi gán cửa hàng: ${audErr.message}` }
    }
  }

  revalidatePath('/announcements')
  return { success: true, id: ann.id }
}

export async function markAnnouncementRead(announcementId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  // Idempotent: one read row per (announcement, user).
  const { error } = await supabase
    .from('announcement_reads')
    .upsert(
      { announcement_id: announcementId, user_id: user.id },
      { onConflict: 'announcement_id,user_id', ignoreDuplicates: true },
    )
  if (error) return { error: error.message }
  return { success: true }
}

export async function deleteAnnouncement(announcementId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { error } = await supabase.from('announcements').delete().eq('id', announcementId)
  if (error) return { error: error.message }
  revalidatePath('/announcements')
  return { success: true }
}
