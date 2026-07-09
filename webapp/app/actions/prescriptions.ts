'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  PRESCRIPTION_MAX_IMAGES,
  PRESCRIPTION_MAX_SIZE,
  PRESCRIPTION_ALLOWED_TYPES,
  DHC_PATTERN,
  DHC_STRICT_PATTERN,
  DHC_FORMAT_HINT,
} from '@/lib/prescriptions/constants'
import type { PrescriptionImageInput, ProductRow } from '@/lib/prescriptions/types'
import { isSuperAdminEmail } from '@/lib/authz'

// ─── submitPrescription ───────────────────────────────────────────────────────
// Staff submits a new toa thuốc: DHC code + images.
export async function submitPrescription(
  submissionId: string,
  orderCode:    string,
  images:       PrescriptionImageInput[],
  notes?:       string,
  // Chronic prescription (2026-07-04): tick + days of supply. Optional — the
  // legacy call shape stays valid.
  options?:     { isChronic: boolean; daysSupply?: number },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user.id).single()
  if (profile?.role !== 'staff')
    return { error: 'Chỉ dược sĩ (staff) mới có thể nộp toa thuốc' }
  if (!profile.store_id)
    return { error: 'Tài khoản chưa được gán cửa hàng' }

  const trimmedCode = orderCode.trim().toUpperCase()
  if (!trimmedCode) return { error: 'Vui lòng nhập mã đơn hàng DHC' }
  // STRICT format for new submissions (legacy loose DHC_PATTERN stays for the
  // product-sync path only — existing rows predate this rule).
  if (!DHC_STRICT_PATTERN.test(trimmedCode))
    return { error: DHC_FORMAT_HINT }

  // Note is required (stakeholder 2026-06-13) — active ingredient / prescription type.
  const trimmedNotes = notes?.trim() ?? ''
  if (!trimmedNotes) return { error: 'Vui lòng nhập ghi chú toa thuốc' }

  // Chronic: days of supply must be a positive integer.
  const isChronic = options?.isChronic === true
  const daysSupply = isChronic ? Math.floor(Number(options?.daysSupply)) : null
  if (isChronic && (!Number.isFinite(daysSupply as number) || (daysSupply as number) <= 0))
    return { error: 'Cần nhập số ngày dùng thuốc (lớn hơn 0)' }

  // Validate images server-side — don't trust client metadata/path
  if (images.length < 1 || images.length > PRESCRIPTION_MAX_IMAGES)
    return { error: `Cần 1–${PRESCRIPTION_MAX_IMAGES} ảnh toa thuốc` }
  const prefix = `prescriptions/${profile.store_id}/${submissionId}/`
  // GCS uploads store a FULL public URL in path — accept it only when it points
  // at the exact bucket + store + submission prefix (never an arbitrary https://).
  const gcsBase = (process.env.GCS_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '')
  const gcsPrefix = gcsBase ? `${gcsBase}/${prefix}` : null
  for (const img of images) {
    if (!PRESCRIPTION_ALLOWED_TYPES.includes(img.type))
      return { error: `Định dạng ảnh không hợp lệ: ${img.name}` }
    if (img.size > PRESCRIPTION_MAX_SIZE)
      return { error: `Ảnh quá lớn (tối đa 5MB): ${img.name}` }
    const validKey = img.path.startsWith(prefix)              // legacy Supabase key
    const validGcs = !!gcsPrefix && img.path.startsWith(gcsPrefix) // GCS public URL
    if ((!validKey && !validGcs) || img.path.includes('..'))
      return { error: 'Đường dẫn ảnh không hợp lệ' }
  }

  // Global duplicate check (DHC is unique company-wide). Use admin client because
  // staff RLS only exposes their own rows, missing other stores' submissions.
  const { data: existing } = await supabaseAdmin
    .from('prescription_submissions')
    .select('id')
    .eq('order_code', trimmedCode)
    .maybeSingle()
  if (existing)
    return { error: `Đơn hàng ${trimmedCode} đã được nộp rồi` }

  // Insert submission (use admin client to bypass RLS on INSERT returning id)
  const { data: sub, error: subErr } = await supabaseAdmin
    .from('prescription_submissions')
    .insert({
      id:           submissionId,
      order_code:   trimmedCode,
      store_id:     profile.store_id,
      submitted_by: user.id,
      notes:        trimmedNotes,
      // Chronic care (mig 073) — order_sync_status defaults to 'pending' in DB;
      // the pull-prescription-orders cron fills the order/customer fields.
      is_chronic:   isChronic,
      days_supply:  isChronic ? daysSupply : null,
    })
    .select('id')
    .single()
  if (subErr) {
    // Unique violation on order_code (race with another submit)
    if ((subErr as { code?: string }).code === '23505')
      return { error: `Đơn hàng ${trimmedCode} đã được nộp rồi` }
    return { error: subErr.message }
  }

  // Insert image rows
  const imageRows = images.map((img) => ({
    submission_id: sub.id,
    storage_path:  img.path,
    name:          img.name,
    type:          img.type,
    size:          img.size,
  }))
  const { error: imgErr } = await supabaseAdmin
    .from('prescription_images')
    .insert(imageRows)
  if (imgErr) {
    // Rollback submission on image insert failure
    await supabaseAdmin.from('prescription_submissions').delete().eq('id', sub.id)
    return { error: `Lưu ảnh thất bại: ${imgErr.message}` }
  }

  revalidatePath('/prescriptions')
  redirect('/prescriptions')
}

// ─── syncPrescriptionProducts ─────────────────────────────────────────────────
// Admin uploads a JSON array of product rows (may cover multiple DHC codes).
// Matches each row to an existing pending_sync submission, then bulk-inserts products.
export async function syncPrescriptionProducts(products: ProductRow[]) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin')
    return { error: 'Chỉ admin mới có thể đồng bộ sản phẩm' }
  if (!isSuperAdminEmail(user.email))
    return { error: 'Không có quyền đồng bộ Toa thuốc' }

  if (!products.length) return { error: 'Danh sách sản phẩm không được rỗng' }

  // Validate required fields + DHC format
  for (let i = 0; i < products.length; i++) {
    const p = products[i]
    if (!p.order_code || !p.product_id || !p.sku_code || !p.lot_date)
      return { error: `Hàng ${i + 1}: thiếu order_code, product_id, sku_code hoặc lot_date` }
    const code = p.order_code.trim().toUpperCase()
    if (!DHC_PATTERN.test(code))
      return { error: `Hàng ${i + 1}: mã đơn hàng "${p.order_code}" không đúng định dạng DHC (phải là DHC theo sau bởi chữ số)` }
  }

  // Get all unique order_codes from input
  const inputCodes = [...new Set(products.map((p) => p.order_code.trim().toUpperCase()))]

  // Find matching pending_sync submissions
  const { data: submissions } = await supabase
    .from('prescription_submissions')
    .select('id, order_code, store_id')
    .in('order_code', inputCodes)
    .eq('status', 'pending_sync')

  const submissionMap = new Map(
    (submissions ?? []).map((s) => [s.order_code.toUpperCase(), s])
  )

  const matched: string[]   = []
  const unmatched: string[] = []
  inputCodes.forEach((code) => {
    if (submissionMap.has(code)) matched.push(code)
    else unmatched.push(code)
  })

  // Create sync batch record
  const { data: batch, error: batchErr } = await supabase
    .from('prescription_sync_batches')
    .insert({
      uploaded_by:     user.id,
      total_rows:      products.length,
      matched_count:   matched.length,
      unmatched_count: unmatched.length,
      error_count:     0,
    })
    .select('id')
    .single()
  if (batchErr) return { error: batchErr.message }

  if (matched.length === 0) {
    return {
      success: true,
      batchId: batch.id,
      matched_count: 0,
      unmatched_count: unmatched.length,
      unmatched_codes: unmatched,
    }
  }

  // Insert products for matched submissions
  const productRows = products
    .filter((p) => submissionMap.has(p.order_code.trim().toUpperCase()))
    .map((p) => ({
      submission_id:   submissionMap.get(p.order_code.trim().toUpperCase())!.id,
      order_code:      p.order_code.trim().toUpperCase(),
      product_id:      p.product_id,
      product_name:    p.product_name ?? null,
      sku_code:        p.sku_code,
      lot_date:        p.lot_date,
      pos_code:        p.pos_code ?? null,
      pos_name:        p.pos_name ?? null,
      created_at_vn:   p.created_at_vn ?? null,
      completed_at_vn: p.completed_at_vn ?? null,
      employee_name:   p.employee_name ?? null,
    }))

  const { error: prodErr } = await supabase
    .from('prescription_submission_products')
    .insert(productRows)
  if (prodErr) {
    await supabase.from('prescription_sync_batches')
      .update({ error_count: productRows.length }).eq('id', batch.id)
    return { error: `Lưu sản phẩm thất bại: ${prodErr.message}` }
  }

  // Update matched submissions to synced — TODO: wrap product+status in a
  // SECURITY DEFINER RPC for true atomicity. For MVP we check the error explicitly.
  const matchedIds = matched.map((code) => submissionMap.get(code)!.id)
  const { error: updErr } = await supabase
    .from('prescription_submissions')
    .update({
      status:        'synced',
      synced_at:     new Date().toISOString(),
      synced_by:     user.id,
      sync_batch_id: batch.id,
    })
    .in('id', matchedIds)
  if (updErr) {
    await supabase.from('prescription_sync_batches')
      .update({ error_count: matchedIds.length }).eq('id', batch.id)
    return { error: `Đã lưu sản phẩm nhưng cập nhật trạng thái thất bại: ${updErr.message}` }
  }

  revalidatePath('/prescriptions')
  return {
    success: true,
    batchId: batch.id,
    matched_count:   matched.length,
    unmatched_count: unmatched.length,
    unmatched_codes: unmatched,
  }
}

// ─── Chronic care (migration 073) ────────────────────────────────────────────
// prescription_submissions UPDATE is super-only under RLS (ps_update_super), so
// these actions write through the service client and are themselves the
// security boundary — mirror the submitPrescription posture.

const DAY_MS = 86400_000
const addDaysISO = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

// Care permission (locked 2026-07-04, review r): a STAFF may care only for a
// prescription they submitted; a STORE MANAGER may care for any in their store.
// This mirrors the read RLS (staff = own submissions, manager = store) so the
// action can never grant more than the user can see.
export async function submitPrescriptionCare(
  submissionId: string,
  note:         string,
  images:       PrescriptionImageInput[],
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: me } = await supabase.from('users').select('role, store_id').eq('id', user.id).single()
  if (!me || (me.role !== 'staff' && me.role !== 'store_manager'))
    return { error: 'Chỉ dược sĩ hoặc quản lý cửa hàng được ghi nhận chăm sóc' }
  if (!me.store_id) return { error: 'Tài khoản chưa được gán cửa hàng' }

  const trimmedNote = note.trim()
  if (!trimmedNote) return { error: 'Vui lòng nhập ghi chú chăm sóc' }

  const { data: sub } = await supabaseAdmin
    .from('prescription_submissions')
    .select('id, store_id, submitted_by, is_chronic, care_status')
    .eq('id', submissionId)
    .maybeSingle()
  if (!sub) return { error: 'Không tìm thấy toa thuốc' }
  const canCare =
    (me.role === 'store_manager' && sub.store_id === me.store_id) ||
    (me.role === 'staff' && sub.submitted_by === user.id)
  if (!canCare) return { error: 'Bạn không có quyền chăm sóc toa thuốc này' }
  if (!sub.is_chronic) return { error: 'Toa này chưa có ngày dùng để theo dõi' }
  if (sub.care_status === 'done') return { error: 'Toa này đã được chăm sóc' }

  // Evidence photos — required; path-integrity guard mirrors submitPrescription
  // (GCS prescription-care/ URL, or the Supabase care_ fallback under the
  // submission's own prescriptions/ prefix).
  if (images.length < 1 || images.length > PRESCRIPTION_MAX_IMAGES)
    return { error: `Cần 1–${PRESCRIPTION_MAX_IMAGES} ảnh bằng chứng chăm sóc` }
  const gcsBase = (process.env.GCS_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '')
  const gcsPrefix = gcsBase ? `${gcsBase}/prescription-care/${submissionId}/` : null
  const fallbackPrefix = `prescriptions/${sub.store_id}/${submissionId}/care_`
  for (const img of images) {
    if (!PRESCRIPTION_ALLOWED_TYPES.includes(img.type))
      return { error: `Định dạng ảnh không hợp lệ: ${img.name}` }
    if (img.size > PRESCRIPTION_MAX_SIZE)
      return { error: `Ảnh quá lớn (tối đa 5MB): ${img.name}` }
    const ok = (!!gcsPrefix && img.path.startsWith(gcsPrefix)) || img.path.startsWith(fallbackPrefix)
    if (!ok || img.path.includes('..')) return { error: 'Đường dẫn ảnh không hợp lệ' }
  }

  // Flip the status FIRST as an atomic mutex — the conditional WHERE care_status
  // ='none' means two concurrent carers can't both proceed (Postgres serializes
  // the row update; the loser matches 0 rows). Only the winner writes a log.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('prescription_submissions')
    .update({ care_status: 'done', last_care_at: new Date().toISOString(), last_care_by: user.id })
    .eq('id', submissionId)
    .eq('care_status', 'none')
    .select('id')
  if (claimErr) return { error: `Cập nhật trạng thái thất bại: ${claimErr.message}` }
  if (!claimed || claimed.length === 0) return { error: 'Toa này đã được chăm sóc' }

  const { error: logErr } = await supabaseAdmin
    .from('prescription_care_logs')
    .insert({ submission_id: submissionId, care_by: user.id, care_note: trimmedNote, evidence_images: images })
  if (logErr) {
    // Release the mutex so a retry can succeed (uq_pcl_one_per_submission is the
    // hard backstop; if it ever fired, the status revert keeps state consistent).
    await supabaseAdmin.from('prescription_submissions')
      .update({ care_status: 'none', last_care_at: null, last_care_by: null })
      .eq('id', submissionId)
    return { error: `Lưu chăm sóc thất bại: ${logErr.message}` }
  }

  revalidatePath('/prescriptions')
  revalidatePath(`/prescriptions/${submissionId}`)
  return { success: true }
}

// Super admin corrects a mistaken chronic tick / wrong days_supply. Refill and
// reminder dates recompute from the already-synced order date (or stay null
// until the next order sync fills them).
export async function updateChronicSettings(
  submissionId: string,
  input: { isChronic: boolean; daysSupply?: number },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: me } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (me?.role !== 'admin' || !isSuperAdminEmail(user.email))
    return { error: 'Chỉ super admin được chỉnh thông tin toa mạn tính' }

  const { data: sub } = await supabaseAdmin
    .from('prescription_submissions')
    .select('id, order_created_at')
    .eq('id', submissionId)
    .maybeSingle()
  if (!sub) return { error: 'Không tìm thấy toa thuốc' }

  let patch: Record<string, unknown>
  if (input.isChronic) {
    const days = Math.floor(Number(input.daysSupply))
    if (!Number.isFinite(days) || days <= 0) return { error: 'Số ngày dùng thuốc phải lớn hơn 0' }
    patch = { is_chronic: true, days_supply: days, expected_refill_date: null, reminder_date: null }
    if (sub.order_created_at) {
      const expected = addDaysISO(sub.order_created_at as string, days)
      patch.expected_refill_date = expected
      patch.reminder_date = addDaysISO(expected, -2)
    }
  } else {
    patch = { is_chronic: false, days_supply: null, expected_refill_date: null, reminder_date: null }
  }

  const { error } = await supabaseAdmin
    .from('prescription_submissions')
    .update(patch)
    .eq('id', submissionId)
  if (error) return { error: error.message }

  revalidatePath('/prescriptions')
  revalidatePath(`/prescriptions/${submissionId}`)
  return { success: true }
}

// Staff/super correct a wrong DHC so the next order-sync cron can match it.
// Allowed while the order isn't synced yet (pending/error) and the prescription
// hasn't been cared for. Resets the order-sync fields so the cron re-syncs clean.
export async function updatePrescriptionOrderCode(submissionId: string, newOrderCode: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }
  const { data: me } = await supabase.from('users').select('role').eq('id', user.id).single()

  const code = newOrderCode.trim().toUpperCase()
  if (!DHC_STRICT_PATTERN.test(code)) return { error: DHC_FORMAT_HINT }

  const { data: sub } = await supabaseAdmin
    .from('prescription_submissions')
    .select('id, submitted_by, order_sync_status, care_status')
    .eq('id', submissionId)
    .maybeSingle()
  if (!sub) return { error: 'Không tìm thấy toa thuốc' }

  const isSuper = me?.role === 'admin' && isSuperAdminEmail(user.email)
  const isOwnerStaff = me?.role === 'staff' && sub.submitted_by === user.id
  if (!isSuper && !isOwnerStaff) return { error: 'Bạn không có quyền sửa mã đơn của toa này' }
  if (!['pending', 'error'].includes(sub.order_sync_status))
    return { error: 'Chỉ sửa được mã khi đơn chưa đồng bộ hoặc đang lỗi' }
  if (sub.care_status === 'done') return { error: 'Toa đã chăm sóc — không thể sửa mã đơn' }

  // order_code is globally UNIQUE — reject a code already used by another toa.
  const { data: dup } = await supabaseAdmin
    .from('prescription_submissions').select('id').eq('order_code', code).maybeSingle()
  if (dup && dup.id !== submissionId) return { error: `Mã đơn ${code} đã tồn tại ở toa khác` }

  // Reset order fields so the next cron re-syncs from scratch against the new DHC.
  const { error } = await supabaseAdmin
    .from('prescription_submissions')
    .update({
      order_code: code,
      order_sync_status: 'pending',
      order_sync_error: null,
      order_created_at: null,
      customer_name: null,
      customer_phone: null,
      pos_code: null,
      pos_name: null,
      order_products_raw: null,
      expected_refill_date: null,
      reminder_date: null,
    })
    .eq('id', submissionId)
  if (error) {
    if ((error as { code?: string }).code === '23505') return { error: `Mã đơn ${code} đã tồn tại ở toa khác` }
    return { error: error.message }
  }

  revalidatePath('/prescriptions')
  revalidatePath(`/prescriptions/${submissionId}`)
  return { success: true }
}
