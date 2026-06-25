'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { sanitizeRichText, richTextToPlain } from '@/lib/richtext/sanitize'
import { isSuperAdminEmail } from '@/lib/authz'

// Announcements / Bảng tin — read-only broadcasts with a view receipt (migrations
// 063/064). Admin creates/edits; Staff/Store read (no submission). Audience =
// all | stores. Optional cover + carousel images (URLs uploaded client-side).

const MAX_CAROUSEL = 5

interface AnnouncementInput {
  title: string
  body: string
  visibility: 'all' | 'stores'
  storeIds?: string[]
  expiresAt?: string | null   // 'YYYY-MM-DD'; null = no expiry
  coverUrl?: string | null
  carouselUrls?: string[]     // already-uploaded public URLs (≤ MAX_CAROUSEL)
}

function normExpiry(expiresAt?: string | null): string | null {
  return expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt) ? `${expiresAt}T23:59:59+07:00` : null
}

// Atomic replace of audience + assets via the SECURITY DEFINER RPC (one
// transaction → no partial write; DELETEs inside carry WHERE for pg_safeupdate).
async function saveAudienceAssets(announcementId: string, storeIds: string[], coverUrl: string | null, carouselUrls: string[]) {
  const { error } = await supabaseAdmin.rpc('replace_announcement_audience_assets', {
    p_announcement_id: announcementId,
    p_store_ids:       storeIds,
    p_cover:           coverUrl,
    p_carousel:        carouselUrls,
  })
  return error?.message ?? null
}

// Only accept image URLs we minted — strict origin + path. GCS public base or the
// Supabase public task-uploads path, both under announcement_assets/. Blocks an
// external URL like https://evil/announcement_assets/x.jpg (tracking/injection).
function isOwnAsset(u: string): boolean {
  const gcs  = process.env.GCS_PUBLIC_BASE_URL?.replace(/\/+$/, '')
  const supa = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '')
  if (gcs && u.startsWith(`${gcs}/announcement_assets/`)) return true
  if (supa && u.startsWith(`${supa}/storage/v1/object/public/task-uploads/announcement_assets/`)) return true
  return false
}

function clean(input: AnnouncementInput) {
  const title = input.title.trim()
  if (!title) return { error: 'Vui lòng nhập tiêu đề' }
  const body = sanitizeRichText(input.body)
  const rawCover = input.coverUrl?.trim() || null
  const coverUrl = rawCover && isOwnAsset(rawCover) ? rawCover : null
  const carouselUrls = (input.carouselUrls ?? [])
    .filter((u): u is string => typeof u === 'string' && !!u.trim() && isOwnAsset(u))
    .slice(0, MAX_CAROUSEL)
  // Need at least some content: body OR a cover/carousel image.
  if (!body && !coverUrl && carouselUrls.length === 0) return { error: 'Vui lòng nhập nội dung hoặc thêm ảnh' }
  const visibility = input.visibility === 'stores' ? 'stores' : 'all'
  const storeIds = visibility === 'stores'
    ? [...new Set((input.storeIds ?? []).filter((s): s is string => typeof s === 'string'))]
    : []
  if (visibility === 'stores' && storeIds.length === 0) return { error: 'Chọn ít nhất một cửa hàng (hoặc gửi cho tất cả)' }
  return { title, body, coverUrl, carouselUrls, visibility, storeIds, expires_at: normExpiry(input.expiresAt), excerpt: richTextToPlain(body).slice(0, 160) }
}

export async function createAnnouncement(input: AnnouncementInput) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Chỉ admin mới tạo được thông báo' }

  const c = clean(input)
  if ('error' in c) return c

  const { data: ann, error: annErr } = await supabase
    .from('announcements')
    .insert({ title: c.title, body: c.body, excerpt: c.excerpt, visibility: c.visibility, created_by: user.id, expires_at: c.expires_at })
    .select('id')
    .single()
  if (annErr || !ann) return { error: annErr?.message ?? 'Không tạo được thông báo' }

  const err = await saveAudienceAssets(ann.id, c.storeIds, c.coverUrl, c.carouselUrls)
  if (err) { await supabaseAdmin.from('announcements').delete().eq('id', ann.id); return { error: `Lỗi lưu cửa hàng/ảnh: ${err}` } }

  revalidatePath('/announcements')
  return { success: true, id: ann.id }
}

export async function updateAnnouncement(id: string, input: AnnouncementInput) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { error: 'Chỉ admin mới sửa được thông báo' }

  const c = clean(input)
  if ('error' in c) return c

  // The atomic RPC runs as service role (no auth.uid), so verify creator/super here.
  const { data: existing } = await supabase.from('announcements').select('created_by').eq('id', id).maybeSingle()
  if (!existing) return { error: 'Thông báo không tồn tại' }
  if (existing.created_by !== user.id && !isSuperAdminEmail(user.email)) return { error: 'Không có quyền sửa thông báo này' }

  // Parent fields + audience + assets in one transaction (migration 064).
  const { error: rpcErr } = await supabaseAdmin.rpc('rpc_update_announcement', {
    p_id: id, p_title: c.title, p_body: c.body, p_excerpt: c.excerpt, p_visibility: c.visibility,
    p_expires_at: c.expires_at, p_store_ids: c.storeIds, p_cover: c.coverUrl, p_carousel: c.carouselUrls,
  })
  if (rpcErr) return { error: rpcErr.message }

  revalidatePath('/announcements')
  revalidatePath(`/announcements/${id}`)
  return { success: true, id }
}

export async function markAnnouncementRead(announcementId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { error } = await supabase
    .from('announcement_reads')
    .upsert({ announcement_id: announcementId, user_id: user.id }, { onConflict: 'announcement_id,user_id', ignoreDuplicates: true })
  if (error) return { error: error.message }
  return { success: true }
}

export async function deleteAnnouncement(announcementId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  // RLS ann_delete gates super OR creator; .select() lets us detect a 0-row
  // (no-permission) delete instead of reporting a false success.
  const { data, error } = await supabase.from('announcements').delete().eq('id', announcementId).select('id')
  if (error) return { error: error.message }
  if (!data || data.length === 0) return { error: 'Không có quyền xóa thông báo này' }
  revalidatePath('/announcements')
  return { success: true }
}

// Staff unread badge (no realtime): visible announcements minus the user's reads.
export async function getUnreadAnnouncementCount(): Promise<number> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return 0
  // Cap to the last 60 days so the hot-path query stays light as the board grows
  // (old unread rarely matters for a "new" badge).
  const since = new Date(Date.now() - 60 * 86400_000).toISOString()
  const { data: anns } = await supabase.from('announcements').select('id').gte('published_at', since) // RLS-filtered
  if (!anns?.length) return 0
  const { data: reads } = await supabase.from('announcement_reads').select('announcement_id').eq('user_id', user.id)
  const read = new Set((reads ?? []).map((r) => r.announcement_id))
  return anns.filter((a) => !read.has(a.id)).length
}
