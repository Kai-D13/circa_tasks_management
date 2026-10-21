'use server'

import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isCareImportCancelEnabled } from '@/lib/care/flags'
import { getCareImportAccess } from '@/lib/care/server/importAccess'
import { careDataScope } from '@/lib/care/server/qaUi'
import { runCareCancel, runCareCancelPreview, type CareCancelDeps, type CareCancelPreview, type CareCancelResult } from '@/lib/care/importCancel'

// CRM-CSKH D1 — huỷ file import chưa có lượt (Q-149–163; SPEC §Sau go-live D; migration 115).
// Luồng (lib/care/importCancel.ts, test hành vi ở e2e/care-import-cancel-core.spec.ts): cờ CARE_IMPORT_CANCEL_ENABLED → input →
// quyền import từ SESSION thật (care_my_access, không QLCH) → phạm vi dữ liệu (production chỉ batch thật; QA local chỉ batch QA)
// → RPC bằng service role với p_actor = user đã xác thực. RPC 115 (chỉ GRANT service_role) kiểm LẠI quyền actor + mọi điều kiện
// dữ liệu sau khi khoá — action chỉ là lớp ngoài. Không log PII; lỗi không trả SQL thô.

const deps: CareCancelDeps = {
  enabled: isCareImportCancelEnabled,
  access: getCareImportAccess,
  loadBatch: async (id) => {
    const { data, error } = await supabaseAdmin.from('care_import_batches').select('id, is_test').eq('id', id).maybeSingle()
    return { data: data as { id: string; is_test: boolean } | null, error }
  },
  scope: careDataScope,
  rpc: async (fn, args) => {
    const { data, error } = await supabaseAdmin.rpc(fn, args)
    return { data, error }
  },
  revalidate: (p) => revalidatePath(p),
}

/** Xem trước tác động huỷ (chỉ đọc). commitSeq trả về là CHUỖI — gửi lại nguyên văn khi xác nhận. */
export async function previewCareImportCancel(input: { batchId: string }): Promise<CareCancelPreview> {
  return runCareCancelPreview(input, deps)
}

/** Huỷ MỘT batch. expectedCommitSeq bắt buộc, lấy từ preview vừa xác nhận; RPC so sau khoá, lệch ⇒ NOT_LATEST. */
export async function cancelCareImport(input: { batchId: string; expectedCommitSeq: string }): Promise<CareCancelResult> {
  return runCareCancel(input, deps)
}
