import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { CARE_PERIOD_CHANGED, type CareFinalizeResult, type CareImportRepo } from '@/lib/care/import/handler'
import { fetchExact } from '@/lib/care/import/fetchExact'
import type { CareExistingTask, CareImportLookups } from '@/lib/care/import/preview'

// Repo service role cho import CRM (SPEC B2 §2). CHỈ được gọi từ handler SAU khi
// getCareImportAccess() trả 'ok' — handler đảm bảo thứ tự đó.
// Đọc bảng của migration 114; finalize SQL vẫn là lớp kiểm cuối (quyền, DNC,
// email duy nhất, revision) và quyết định kết quả ghi.
//
// · Danh sách id lớn chia khối ≤100 (bài học "URI too long" của Prescriptions).
// · Mọi truy vấn qua fetchExact (lib/care/import/fetchExact.ts): count exact bắt buộc,
//   thiếu/đổi/hụt dòng ⇒ ném lỗi ⇒ handler trả 503 LOOKUP_FAILED, không dựng preview.
// · "Task đã có lượt" = last_interaction_at IS NOT NULL: RPC ghi lượt (114) là
//   đường ghi duy nhất và luôn set cột này — tương đương EXISTS của finalize.

const ID_CHUNK = 100

function chunks<T>(list: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export const supabaseCareImportRepo: CareImportRepo = {
  async loadLookups({ externalIds, period, isTest }): Promise<CareImportLookups> {
    const stores = await fetchExact<{ id: string; code: string; name: string }>((f, t) =>
      supabaseAdmin.from('stores').select('id, code, name', { count: 'exact' })
        .eq('store_type', 'os').eq('is_active', true).order('id').range(f, t))
    const storeIds = stores.map((s) => s.id)

    const staff: { id: string; email: string; full_name: string; store_id: string }[] = []
    for (const ids of chunks(storeIds)) {
      staff.push(...await fetchExact<{ id: string; email: string; full_name: string; store_id: string }>((f, t) =>
        supabaseAdmin.from('users').select('id, email, full_name, store_id', { count: 'exact' })
          .eq('role', 'staff').in('store_id', ids).order('id').range(f, t)))
    }

    const customers: { id: string; external_id: string; is_test: boolean }[] = []
    for (const ids of chunks([...new Set(externalIds)])) {
      customers.push(...await fetchExact<{ id: string; external_id: string; is_test: boolean }>((f, t) =>
        supabaseAdmin.from('care_customers').select('id, external_id, is_test', { count: 'exact' })
          .in('external_id', ids).order('id').range(f, t)))
    }
    const customerIds = customers.map((c) => c.id)

    const refusals: { customer_id: string; store_id: string }[] = []
    const tasks: {
      id: string; customer_id: string; status: CareExistingTask['status']; store_id: string; assignee_id: string
      customer_name: string; phone_norm: string; phone_raw: string; is_test: boolean; last_interaction_at: string | null
    }[] = []
    for (const ids of chunks(customerIds)) {
      refusals.push(...await fetchExact<{ customer_id: string; store_id: string }>((f, t) =>
        supabaseAdmin.from('care_store_refusals').select('customer_id, store_id', { count: 'exact' })
          .in('customer_id', ids).order('customer_id').order('store_id').range(f, t)))
      tasks.push(...await fetchExact<(typeof tasks)[number]>((f, t) =>
        supabaseAdmin.from('care_tasks')
          .select('id, customer_id, status, store_id, assignee_id, customer_name, phone_norm, phone_raw, is_test, last_interaction_at', { count: 'exact' })
          .eq('period_month', period).in('customer_id', ids).order('id').range(f, t)))
    }

    const products: { task_id: string; product_id: string; product_name: string; image_url: string | null; reason_type: string; reason_text: string }[] = []
    for (const ids of chunks(tasks.map((t) => t.id))) {
      products.push(...await fetchExact<(typeof products)[number]>((f, t) =>
        supabaseAdmin.from('care_task_products')
          .select('id, task_id, product_id, product_name, image_url, reason_type, reason_text', { count: 'exact' })
          .eq('is_current', true).in('task_id', ids).order('id').range(f, t)))
    }

    const head = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
      const { count, error } = await q
      if (error || count === null) throw new Error('care_import_lookup_failed')
      return count
    }
    const currentPeriodTaskCount = await head(supabaseAdmin.from('care_tasks')
      .select('id', { count: 'exact', head: true }).eq('period_month', period).eq('is_test', isTest))
    // Không lọc is_test: khớp care__close_period_at (đóng MỌI task mở kỳ trước).
    const openPreviousPeriodCount = await head(supabaseAdmin.from('care_tasks')
      .select('id', { count: 'exact', head: true }).eq('status', 'open').lt('period_month', period))

    const productsByTask = new Map<string, CareExistingTask['products']>()
    for (const p of products) {
      const list = productsByTask.get(p.task_id) ?? []
      list.push({ product_id: p.product_id, product_name: p.product_name, image_url: p.image_url, reason_type: p.reason_type, reason_text: p.reason_text })
      productsByTask.set(p.task_id, list)
    }
    return {
      storesByCode: new Map(stores.map((s) => [s.code, { id: s.id, code: s.code, name: s.name }])),
      staff: staff.map((s) => ({ id: s.id, storeId: s.store_id, email: s.email.trim().toLowerCase(), fullName: s.full_name })),
      customers: new Map(customers.map((c) => [c.external_id, { id: c.id, isTest: c.is_test }])),
      refusals: new Set(refusals.map((r) => `${r.customer_id}|${r.store_id}`)),
      currentTasks: new Map(tasks.map((t) => [t.customer_id, {
        id: t.id, customerId: t.customer_id, status: t.status, storeId: t.store_id, assigneeId: t.assignee_id,
        customerName: t.customer_name, phoneNorm: t.phone_norm, phoneRaw: t.phone_raw, isTest: t.is_test,
        hasInteraction: t.last_interaction_at !== null, products: productsByTask.get(t.id) ?? [],
      }])),
      currentPeriodTaskCount,
      openPreviousPeriodCount,
    }
  },

  async createBatch({ period, fileName, sha256, rowCount, actorId, isTest }) {
    const { data, error } = await supabaseAdmin.from('care_import_batches')
      .insert({ period_month: period, file_name: fileName, file_sha256: sha256, row_count: rowCount, created_by: actorId, is_test: isTest })
      .select('id').single()
    if (error || !data) throw new Error('care_import_batch_failed')
    return data.id as string
  },

  async stageRows(batchId, rows) {
    const { error } = await supabaseAdmin.from('care_import_staging')
      .insert(rows.map((r) => ({ batch_id: batchId, row_no: r.row_no, payload: r.payload })))
    if (error) throw new Error('care_import_stage_failed')
  },

  async finalize(batchId, actorId) {
    const { data, error } = await supabaseAdmin.rpc('care_import_finalize', { p_batch_id: batchId, p_actor: actorId })
    // RAISE "kỳ của batch … khác tháng hiện tại" (qua nửa đêm cuối tháng giữa preview và commit)
    // ⇒ mã riêng để UI báo kiểm tra lại, không phải lỗi hệ thống. Không chuyển message DB ra ngoài.
    if (error && /khác tháng hiện tại/.test(error.message ?? '')) throw new Error(CARE_PERIOD_CHANGED)
    if (error || !data) throw new Error('care_import_finalize_failed')
    return data as CareFinalizeResult
  },

  async purgeStaleStaging() {
    await supabaseAdmin.rpc('care_purge_stale_staging')
  },

  async discardBatch(batchId) {
    // Chỉ batch còn 'staged' của chính request này; cascade xoá staging (PII).
    await supabaseAdmin.from('care_import_batches').delete().eq('id', batchId).eq('status', 'staged')
  },
}
