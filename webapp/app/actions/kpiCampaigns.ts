'use server'

import { revalidatePath } from 'next/cache'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiAffiliateEnabled, isKpiCampaignEnabled, isKpiCampaignTestMode } from '@/lib/kpi/flags'
import { resolveMetricInput, type MetricInput } from '@/lib/kpi/campaignConfig'
import { campaignArchivable, campaignDeletable } from '@/lib/kpi/archive'
import { evaluateActivation, type ActivationCampaign } from '@/lib/kpi/activation'
import { getAffiliateSyncHealth, supabaseAffiliateHealthDb } from '@/lib/affiliate/health'
import { sanitizeOpsText } from '@/lib/ops/sanitize'
import { parseCampaignRows, type CampaignImportResult } from '@/lib/kpi/campaignImport'
import { syncCampaign } from '@/lib/kpi/actuals'
import { safeManualSync } from '@/lib/kpi/syncBatch'

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

export async function createCampaign(input: { name: string; start_date: string; end_date: string } & MetricInput) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const name = input.name?.trim()
  if (!name) return { error: 'Thiếu tên chiến dịch' }
  if (!input.start_date || !input.end_date) return { error: 'Thiếu thời gian áp dụng' }
  if (input.end_date < input.start_date) return { error: 'Ngày kết thúc phải sau ngày bắt đầu' }
  // P3-D: metric contract THUẦN — flag tắt thì affiliate bị từ chối tại server,
  // không chỉ ẩn UI; mặc định (không gửi) = Offline-only như campaign cũ.
  const metrics = resolveMetricInput(isKpiAffiliateEnabled(), input)
  if (!metrics.ok) return { error: metrics.error }

  const { data, error } = await auth.supabase
    .from('kpi_campaigns')
    .insert({
      name,
      start_date: input.start_date,
      end_date: input.end_date,
      scope_type: 'store',
      metric_type: 'gmv',   // legacy label; nguồn thật = metric_offline/metric_affiliate
      order_type: 'all',    // online/offline reserved until BI provides a field
      metric_offline: metrics.metric_offline,
      metric_affiliate: metrics.metric_affiliate,
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
  input: { name?: string; start_date?: string; end_date?: string } & MetricInput,
) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const { data: campaign } = await auth.supabase
    .from('kpi_campaigns').select('status, archived_at, updated_at, metric_offline, metric_affiliate').eq('id', id).single()
  if (!campaign) return { error: 'Không tìm thấy chiến dịch' }
  if (campaign.archived_at !== null) return { error: 'Chiến dịch đã lưu trữ — không sửa được' }
  if (campaign.status === 'active') return { error: 'Chiến dịch đang chạy — tạm dừng trước khi sửa' }
  if (campaign.status === 'ended') return { error: 'Chiến dịch đã kết thúc' }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.name !== undefined) { const n = input.name.trim(); if (!n) return { error: 'Tên không hợp lệ' }; patch.name = n }
  if (input.start_date) patch.start_date = input.start_date
  if (input.end_date) patch.end_date = input.end_date
  // P3-D: sửa metric CHỈ khi draft/paused (đã gate ở trên); field không gửi giữ
  // giá trị hiện tại; flag tắt → affiliate bị từ chối server-side.
  if (input.metric_offline !== undefined || input.metric_affiliate !== undefined) {
    const metrics = resolveMetricInput(isKpiAffiliateEnabled(), input, {
      metric_offline: campaign.metric_offline === true,
      metric_affiliate: campaign.metric_affiliate === true,
    })
    if (!metrics.ok) return { error: metrics.error }
    patch.metric_offline = metrics.metric_offline
    patch.metric_affiliate = metrics.metric_affiliate
  }

  // P3-D r1 (audit P1 race): update CÓ ĐIỀU KIỆN — status vẫn draft/paused VÀ
  // updated_at vẫn là giá trị vừa đọc (kích hoạt/import song song sẽ đổi
  // updated_at qua RPC 093). 0 row = conflict, KHÔNG báo thành công.
  const { data: updated, error } = await auth.supabase.from('kpi_campaigns')
    .update(patch)
    .eq('id', id)
    .in('status', ['draft', 'paused'])
    .eq('updated_at', campaign.updated_at)
    .select('id')
  if (error) return { error: error.message }
  if ((updated ?? []).length === 0) {
    return { error: 'Chiến dịch vừa thay đổi (kích hoạt/import song song) — tải lại trang rồi thử lại' }
  }
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
    .from('kpi_campaigns').select('status, archived_at, start_date, end_date, metric_affiliate').eq('id', id).single()
  if (!c) return { error: 'Không tìm thấy chiến dịch' }
  // Archive (098): campaign đã lưu trữ đóng băng hoàn toàn — không pause/
  // activate (RPC 098 cũng chặn tầng DB; đây là lớp app cho message sạch).
  if (c.archived_at !== null) return { error: 'Chiến dịch đã lưu trữ — không thao tác được' }

  if (c.status === 'active') {
    // Race guard: chỉ pause khi VẪN đang active (audit P3-D2).
    // r1.2: pause CỐ TÌNH không kiểm tra KPI_AFFILIATE_ENABLED — campaign
    // affiliate đang active khi flag tắt vẫn phải pause được để xử lý sự cố.
    const { data: paused, error } = await auth.supabase.from('kpi_campaigns')
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'active').select('id')
    if (error) return { error: error.message }
    if ((paused ?? []).length === 0) return { error: 'Trạng thái chiến dịch vừa thay đổi — tải lại trang' }
    console.info(`[kpi-campaign] paused ${id} by ${auth.user.id}`)
  } else if (c.status === 'draft' || c.status === 'paused') {
    // P3-D r1 (audit P1 race): app EVALUATE (đọc toàn bộ target + OS-active +
    // health qua session client — super đọc được qua RLS; offline-only không
    // đụng health) → RPC 093 ACTIVATION ATOMIC trong DB (lock row + expected
    // updated_at + expected affiliate run id) — import/sửa xen giữa bị chặn.
    const ev = await evaluateActivation({
      loadCampaign: async (cid) => {
        const { data, error } = await auth.supabase
          .from('kpi_campaigns').select('id, status, updated_at, metric_affiliate')
          .eq('id', cid).maybeSingle()
        return { data: data as ActivationCampaign | null, error }
      },
      loadTargets: async (cid) => {
        const { data, error } = await auth.supabase
          .from('kpi_campaign_store_targets').select('store_id, pos_code').eq('campaign_id', cid)
        return { data, error }
      },
      loadStores: async (storeIds) => {
        const { data, error } = await auth.supabase
          .from('stores').select('id, code, store_type, is_active').in('id', storeIds)
        return { data, error }
      },
      getHealth: (storeIds) => getAffiliateSyncHealth(supabaseAffiliateHealthDb(auth.supabase), storeIds),
    }, id, isKpiAffiliateEnabled())
    if (!ev.ok) return { error: ev.error }

    const { error: actErr } = await supabaseAdmin.rpc('rpc_activate_kpi_campaign', {
      p_campaign_id: id,
      p_expected_updated_at: ev.expectedUpdatedAt,
      p_expected_run_id: ev.expectedRunId,
    })
    if (actErr) return { error: sanitizeOpsText(actErr.message) }
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
  // P3-B/C contract: cùng syncCampaign với cron; side-effect plan (revalidate
  // hay không, toast loại gì) quyết định bởi safeManualSync THUẦN (có test) —
  // exception cũng thành {error} có cấu trúc + sanitize, không throw ra UI.
  const plan = await safeManualSync(syncCampaign, id)
  if (plan.kind === 'failed') return { error: plan.error }
  if (plan.kind === 'preserved') {
    // Không phải lỗi: nguồn chưa sẵn sàng → số cũ giữ nguyên, KHÔNG revalidate.
    return { preserved: true as const, reason: plan.reason }
  }
  revalidatePath(`/targets/campaigns/${id}`)
  revalidatePath('/targets')
  return { success: true, upserted: plan.upserted, unmatched: plan.unmatched }
}

export async function deleteCampaign(id: string) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const { data: c } = await auth.supabase.from('kpi_campaigns').select('status, archived_at').eq('id', id).single()
  if (!c) return { error: 'Không tìm thấy chiến dịch' }
  const gate = campaignDeletable(c.status, c.archived_at)
  if (!gate.ok) return { error: gate.reason }
  // Race guard: xoá CÓ ĐIỀU KIỆN — vẫn phải là draft chưa archive tại thời
  // điểm xoá (kích hoạt song song → 0 row, không xoá nhầm campaign đã chạy).
  const { data: deleted, error } = await auth.supabase.from('kpi_campaigns')
    .delete().eq('id', id).eq('status', 'draft').is('archived_at', null).select('id')
  if (error) return { error: error.message }
  if ((deleted ?? []).length === 0) return { error: 'Trạng thái chiến dịch vừa thay đổi — tải lại trang' }
  revalidatePath('/targets/campaigns')
  return { success: true }
}

// Soft archive (contract 28/07): paused/ended biến mất khỏi UI, GIỮ toàn bộ
// target/actual/tier/commission/lịch sử import. Atomic trong RPC 098 (lock
// row + guard trạng thái tại thời điểm archive — chống race với toggle).
export async function archiveCampaign(id: string) {
  const auth = await requireSuper()
  if ('error' in auth) return { error: auth.error }
  const { data: c } = await auth.supabase.from('kpi_campaigns').select('status, archived_at').eq('id', id).single()
  if (!c) return { error: 'Không tìm thấy chiến dịch' }
  const gate = campaignArchivable(c.status, c.archived_at)
  if (!gate.ok) return { error: gate.reason }
  const { error } = await supabaseAdmin.rpc('rpc_archive_kpi_campaign', {
    p_campaign_id: id,
    p_actor: auth.user.id,
  })
  if (error) return { error: sanitizeOpsText(error.message) }
  console.info(`[kpi-campaign] archived ${id} by ${auth.user.id}`)
  revalidatePath('/targets/campaigns')
  revalidatePath(`/targets/campaigns/${id}`)
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
  // OS stores only — a campaign import must never match an FS (mig 076) POS code.
  const { data: stores, error: storesErr } = await supabaseAdmin.from('stores').select('id, code').eq('store_type', 'os')
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
  const { data: c } = await auth.supabase.from('kpi_campaigns').select('status, archived_at').eq('id', campaignId).single()
  if (!c) return { error: 'Không tìm thấy chiến dịch' }
  if (c.archived_at !== null) return { error: 'Chiến dịch đã lưu trữ — không nạp target' }
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
