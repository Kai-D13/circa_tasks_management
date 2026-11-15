import 'server-only'
import { cache } from 'react'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { parseCmsCapabilities, type CmsCapabilities } from '@/lib/cms/calc/capabilities'
import { parseCmsProgramBasisRow, type CmsProgramBasis } from '@/lib/cms/calc/basisUi'

// CMS-CALC-RET-2 P5 — năng lực DB cho app (rpc_cms_capabilities, migration 130) + đọc cách tính / chính sách của chương trình.
// Ba trạng thái, không đoán:
//   · 'pre130'      DB chưa có 130 (PostgREST PGRST202 / Postgres 42883) ⇒ chỉ đường 121–126; KHÔNG đọc cột 130 (chưa tồn tại).
//   · 'ok'          có kết quả ⇒ từng đường bật theo parseCmsCapabilities (fail-closed theo version / danh sách RPC).
//   · 'unavailable' lỗi khác (mạng / quyền / timeout) ⇒ mọi đường 130 coi như tắt; trang có lối hiển thị lỗi thay vì giả cũ.
// Dedupe theo request (React cache) + nhớ theo tiến trình 60 s cho kết quả xác định (ok / pre130) — không gọi service role ở MỌI request
// (db-reviewer 14/11 P2-7). 'unavailable' không nhớ. Sau khi chạy / rollback 130 app nhận năng lực mới trong ≤ 60 s; rollback luôn theo thứ
// tự app trước (runbook §1) nên app cũ không đọc cache này. Chỉ server.

export type CmsCapabilityState =
  | { kind: 'pre130' }
  | { kind: 'ok'; caps: CmsCapabilities }
  | { kind: 'unavailable' }

const MISSING_FN = new Set(['PGRST202', '42883'])
export const CMS_CAPS_TTL_MS = 60_000
let memo: { at: number; v: CmsCapabilityState } | null = null

async function probe(): Promise<CmsCapabilityState> {
  try {
    const { data, error } = await supabaseAdmin.rpc('rpc_cms_capabilities')
    if (error) return MISSING_FN.has(String(error.code ?? '')) ? { kind: 'pre130' } : { kind: 'unavailable' }
    return { kind: 'ok', caps: parseCmsCapabilities(data) }
  } catch {
    return { kind: 'unavailable' }
  }
}

export const getCmsCapabilityState = cache(async (): Promise<CmsCapabilityState> => {
  const now = Date.now()
  if (memo && now - memo.at < CMS_CAPS_TTL_MS) return memo.v
  const v = await probe()
  memo = v.kind === 'unavailable' ? null : { at: now, v }
  return v
})

/** Đường `program_modes` (cột basis / policy + save_v2) dùng được. */
export function cmsProgramModesPath(s: CmsCapabilityState): boolean {
  return s.kind === 'ok' && s.caps.paths.program_modes
}

/** DB có cột 130 (đọc được basis) — kể cả khi danh sách RPC lệch: cột có mặt khi đường program_modes ok. */
export function cmsHasBasisColumns(s: CmsCapabilityState): boolean {
  return cmsProgramModesPath(s)
}

/**
 * Cách tính + chính sách trả của các chương trình (service role — người gọi ĐÃ kiểm quyền đọc chương trình). Chỉ gọi khi
 * cmsHasBasisColumns. Dòng lạ ⇒ không có trong map (caller hiển thị "không xác định", không giả pos_base).
 */
export async function cmsLoadProgramBasis(ids: readonly string[]): Promise<{ ok: true; data: Map<string, CmsProgramBasis> } | { ok: false }> {
  const out = new Map<string, CmsProgramBasis>()
  const uniq = [...new Set(ids)]
  try {
    for (let i = 0; i < uniq.length; i += 200) {
      const { data, error } = await supabaseAdmin.from('cms_programs').select('id, quantity_basis, quantity_basis_source, returns_policy')
        .in('id', uniq.slice(i, i + 200))
      if (error) return { ok: false }
      for (const r of (data ?? []) as { id: string; quantity_basis: unknown; quantity_basis_source: unknown; returns_policy: unknown }[]) {
        const b = parseCmsProgramBasisRow(r)
        if (b) out.set(r.id, b)
      }
    }
    return { ok: true, data: out }
  } catch {
    return { ok: false }
  }
}
