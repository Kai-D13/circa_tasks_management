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
  if (!DHC_PATTERN.test(trimmedCode))
    return { error: 'Mã đơn hàng phải có dạng DHC theo sau bởi các chữ số (VD: DHC00878115)' }

  // Note is required (stakeholder 2026-06-13) — active ingredient / prescription type.
  const trimmedNotes = notes?.trim() ?? ''
  if (!trimmedNotes) return { error: 'Vui lòng nhập ghi chú toa thuốc' }

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
