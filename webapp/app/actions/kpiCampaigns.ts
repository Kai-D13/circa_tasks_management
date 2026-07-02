'use server'

import { revalidatePath } from 'next/cache'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiCampaignEnabled, isKpiCampaignTestMode } from '@/lib/kpi/flags'
import { parseCampaignRows, type CampaignImportResult } from '@/lib/kpi/campaignImport'
import { syncCampaign } from '@/lib/kpi/actuals'

const MAX_FILE_BYTES = 5 * 1024 * 1024

// All campaign config is super-admin only + gated by KPI_CAMPAIGN_ENABLED (Phase 1
// safety — the flag must gate the ACTIONS too, not just routes/nav, so a stale
// client can't mutate when the feature is off in prod). RLS also enforces super.
async function requireSuper() {
  if (!isKpiCampaignEnabled()) return { error: 'Tính năng KPI Campaign chưa được bật' as const }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' as const }
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin' || !isSuperAdminEmail(user.email)) return { error: 'Chỉ super admin' as const }
  return { user, supabase }
}

export async function createCampaign(input: { name: string; start_date: string; end_date: string }) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const name = input.name?.trim()
  if (!name) return { error: 'Thiếu tên chiến dịch' }
  if (!input.start_date || !input.end_date) return { error: 'Thiếu thời gian áp dụng' }
  if (input.end_date < input.start_date) return { error: 'Ngày kết thúc phải sau ngày bắt đầu' }

  const { data, error } = await auth.supabase
    .from('kpi_campaigns')
    .insert({
      name,
      start_date: input.start_date,
      end_date: input.end_date,
      scope_type: 'store',
      status: 'draft',
      is_test: isKpiCampaignTestMode(),
      created_by: auth.user.id,
    })
    .select('id')
    .single()
  if (error) return { error: error.message }
  revalidatePath('/targets/campaigns')
  return { success: true, id: data.id as string }
}

export async function updateCampaign(
  id: string,
  input: { name?: string; start_date?: string; end_date?: string },
) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const { data: campaign } = await auth.supabase.from('kpi_campaigns').select('status').eq('id', id).single()
  if (!campaign) return { error: 'Không tìm thấy chiến dịch' }
  if (campaign.status === 'active') return { error: 'Chiến dịch đang chạy — tạm dừng trước khi sửa' }
  if (campaign.status === 'ended') return { error: 'Chiến dịch đã kết thúc' }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.name !== undefined) { const n = input.name.trim(); if (!n) return { error: 'Tên không hợp lệ' }; patch.name = n }
  if (input.start_date) patch.start_date = input.start_date
  if (input.end_date) patch.end_date = input.end_date

  const { error } = await auth.supabase.from('kpi_campaigns').update(patch).eq('id', id)
  if (error) return { error: error.message }
  revalidatePath('/targets/campaigns')
  revalidatePath(`/targets/campaigns/${id}`)
  return { success: true }
}

// ON/OFF (draft/paused → active, active → paused). v2: multiple campaigns MAY run
// simultaneously on the same store (stakeholder hybrid) — the old no-overlap guard
// is gone. Activation still requires imported targets (fail closed on read error).
export async function toggleCampaign(id: string) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const { data: c } = await auth.supabase
    .from('kpi_campaigns').select('status, start_date, end_date').eq('id', id).single()
  if (!c) return { error: 'Không tìm thấy chiến dịch' }

  if (c.status === 'active') {
    const { error } = await auth.supabase.from('kpi_campaigns')
      .update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', id)
    if (error) return { error: error.message }
    console.info(`[kpi-campaign] paused ${id} by ${auth.user.id}`)
  } else if (c.status === 'draft' || c.status === 'paused') {
    const { data: myTargets, error: tErr } = await auth.supabase
      .from('kpi_campaign_store_targets').select('store_id').eq('campaign_id', id).limit(1)
    if (tErr) return { error: `Không kiểm tra được target: ${tErr.message}` }
    if ((myTargets ?? []).length === 0) return { error: 'Chưa import target cho chiến dịch này' }

    const { error } = await auth.supabase.from('kpi_campaigns')
      .update({ status: 'active', updated_at: new Date().toISOString() }).eq('id', id)
    if (error) return { error: error.message }
    console.info(`[kpi-campaign] activated ${id} by ${auth.user.id}`)
  } else {
    return { error: 'Chiến dịch đã kết thúc' }
  }
  revalidatePath('/targets/campaigns')
  revalidatePath(`/targets/campaigns/${id}`)
  return { success: true }
}

// "Đồng bộ ngay" — manual actual-GMV sync for one campaign (super admin; QA
// doesn't wait for the 2h cron). Same lib as the cron.
export async function syncCampaignActuals(id: string) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const { data: c } = await auth.supabase
    .from('kpi_campaigns').select('id, start_date, end_date').eq('id', id).single()
  if (!c) return { error: 'Không tìm thấy chiến dịch' }
  const r = await syncCampaign(c)
  if ('error' in r) return { error: r.error }
  revalidatePath(`/targets/campaigns/${id}`)
  revalidatePath('/targets')
  return { success: true, upserted: r.upserted, unmatched: r.unmatched }
}

export async function deleteCampaign(id: string) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const { data: c } = await auth.supabase.from('kpi_campaigns').select('status').eq('id', id).single()
  if (!c) return { error: 'Không tìm thấy chiến dịch' }
  if (c.status !== 'draft') return { error: 'Chỉ xoá được chiến dịch nháp' }
  const { error } = await auth.supabase.from('kpi_campaigns').delete().eq('id', id)
  if (error) return { error: error.message }
  revalidatePath('/targets/campaigns')
  return { success: true }
}

// Parse a file's rows + resolve stores (no write). Reused by preview + commit.
async function parseFile(formData: FormData): Promise<CampaignImportResult | { error: string }> {
  const file = formData.get('file')
  if (!(file instanceof File)) return { error: 'Chưa chọn file' }
  if (file.size > MAX_FILE_BYTES) return { error: 'File quá lớn (tối đa 5MB)' }
  let rawRows: Record<string, unknown>[]
  try {
    const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer' })
    const sheetName = wb.SheetNames[0]
    if (!sheetName) return { error: 'File không có sheet nào' }
    rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
  } catch {
    return { error: 'Không đọc được file — cần đúng định dạng XLSX hoặc CSV' }
  }
  if (rawRows.length > 2000) return { error: 'File quá nhiều dòng — sai file?' }
  const { data: stores, error: storesErr } = await supabaseAdmin.from('stores').select('id, code')
  if (storesErr) return { error: `Không đọc được danh sách cửa hàng: ${storesErr.message}` }
  const byCode = new Map((stores ?? []).filter((s) => s.code).map((s) => [String(s.code).trim().toUpperCase(), s.id]))
  return parseCampaignRows(rawRows, byCode)
}

// Preview only — no DB write.
export async function previewCampaignImport(formData: FormData) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const res = await parseFile(formData)
  if ('error' in res) return { error: res.error }
  return {
    success: true,
    validCount: res.valid.length,
    invalid: res.invalid,
    unmatched: res.unmatched,
    preview: res.valid.slice(0, 50),
  }
}

// Commit — re-parses the file server-side (never trusts client rows). No partial
// write: if ANY row is invalid, nothing is written. Only when campaign draft/paused.
export async function commitCampaignImport(campaignId: string, formData: FormData) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const { data: c } = await auth.supabase.from('kpi_campaigns').select('status').eq('id', campaignId).single()
  if (!c) return { error: 'Không tìm thấy chiến dịch' }
  if (c.status === 'active') return { error: 'Chiến dịch đang chạy — tạm dừng trước khi nạp lại file' }
  if (c.status === 'ended') return { error: 'Chiến dịch đã kết thúc' }

  const res = await parseFile(formData)
  if ('error' in res) return { error: res.error }
  if (res.invalid.length > 0) {
    return { error: `File còn ${res.invalid.length} dòng lỗi — sửa hết rồi nạp lại (không ghi từng phần)`, invalid: res.invalid }
  }
  if (res.valid.length === 0) return { error: 'Không có dòng hợp lệ nào' }

  // Atomic: targets + tiers + import_run audit in ONE transaction inside the RPC
  // (with DB-side status/data guards). Any failure → full rollback, no partial.
  const fileName = (formData.get('file') as File | null)?.name ?? null
  const { data: count, error } = await supabaseAdmin.rpc('rpc_replace_campaign_targets', {
    p_campaign_id: campaignId,
    p_rows: res.valid,
    p_file_name: fileName,
    p_uploaded_by: auth.user.id,
  })
  if (error) return { error: `Ghi dữ liệu lỗi: ${error.message}` }

  revalidatePath('/targets/campaigns')
  revalidatePath(`/targets/campaigns/${campaignId}`)
  return { success: true, upserted: (count as number | null) ?? res.valid.length }
}
