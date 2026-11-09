import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  CmsRepoError, type CmsImportContextData, type CmsImportRepo, type CmsImportRunRow, type CmsProgramRow,
} from '@/lib/cms/import/handler'
import type { CmsProductMasterLite } from '@/lib/cms/import/validate'

// Repo import CMS bằng service role — CHỈ gọi sau khi lõi route đã kiểm cờ + super admin + namespace QA.
// Ghi qua RPC 121 (atomic, kiểm lại trong transaction); đọc tra cứu trực tiếp. Lỗi chỉ trả MÃ (RAISE CMS_* hoặc mã
// nội bộ), không message thô PostgREST. Danh sách ProductID chia khối (tránh URL quá dài khi lọc `in`).

const TIMEOUT_MS = 30_000
const ID_CHUNK = 200
const sig = () => AbortSignal.timeout(TIMEOUT_MS)
// 55P03 = lock_timeout của RPC 121 (phiên khác đang giữ khoá danh mục / dòng) ⇒ BUSY (thử lại).
const rpcCode = (error: { code?: string; message?: string }, fallback: string) =>
  error.code === '55P03' ? 'BUSY' : /CMS_[A-Z_]+/.exec(String(error.message ?? ''))?.[0] ?? fallback

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

// Đọc ĐỦ mọi trang (PM P1-b P2): không dựa vào trần số dòng của PostgREST (có thể nhỏ hơn PAGE) — dừng khi trang rỗng.
// Truy vấn phải có ORDER BY ổn định. Trần số trang để không lặp vô hạn; vượt ⇒ LOOKUP_FAILED (fail-closed).
const PAGE = 1000
const MAX_PAGES = 200
async function readAll<T>(query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; p < MAX_PAGES; p++) {
    const { data, error } = await query(out.length, out.length + PAGE - 1)
    if (error) throw new CmsRepoError('LOOKUP_FAILED')
    const rows = (data ?? []) as T[]
    if (rows.length === 0) return out
    out.push(...rows)
  }
  throw new CmsRepoError('LOOKUP_FAILED')
}

type ProgramDb = { id: string; status: CmsProgramRow['status']; start_date: string; end_date: string; is_test: boolean; config_version: number; catalog_target_gmv: string | null; quantity_basis?: string }
const PROGRAM_COLS = 'id, status, start_date, end_date, is_test, config_version, catalog_target_gmv::text'

export const supabaseCmsImportRepo: CmsImportRepo = {
  async getProgram(id) {
    // CMS-UNIT: đọc kèm quantity_basis (128). DB chưa có 128 ⇒ PostgREST báo cột không tồn tại (42703) ⇒ đọc lại không có cột, coi
    // pos_base (app mới chạy được trên schema cũ). Giá trị lạ ⇒ LOOKUP_FAILED (không tự chọn cơ sở).
    let { data, error } = await supabaseAdmin.from('cms_programs').select(`${PROGRAM_COLS}, quantity_basis`).eq('id', id).abortSignal(sig()).maybeSingle()
    if (error && (error as { code?: string }).code === '42703') {
      ({ data, error } = await supabaseAdmin.from('cms_programs').select(PROGRAM_COLS).eq('id', id).abortSignal(sig()).maybeSingle())
    }
    if (error) throw new CmsRepoError('LOOKUP_FAILED')
    const p = data as unknown as ProgramDb | null
    if (p && p.quantity_basis !== undefined && p.quantity_basis !== 'pos_base' && p.quantity_basis !== 'cms_unit') throw new CmsRepoError('LOOKUP_FAILED')
    return p ? {
      id: p.id, status: p.status, startDate: p.start_date, endDate: p.end_date, isTest: p.is_test,
      configVersion: p.config_version, catalogTargetGmv: p.catalog_target_gmv,
      quantityBasis: p.quantity_basis === 'cms_unit' ? 'cms_unit' : 'pos_base',
    } : null
  },

  /** CMS-UNIT: DB có capability 128 (cột cms_programs.quantity_basis) — probe chỉ đọc, 0 dòng. */
  async unitBasisCapable() {
    const { error } = await supabaseAdmin.from('cms_programs').select('quantity_basis').limit(0).abortSignal(sig())
    if (!error) return true
    if ((error as { code?: string }).code === '42703') return false
    throw new CmsRepoError('LOOKUP_FAILED')
  },

  async loadContext(program, productIds): Promise<CmsImportContextData> {
    const productMaster = new Map<string, CmsProductMasterLite>()
    for (const ids of chunks(productIds, ID_CHUNK)) {
      const { data, error } = await supabaseAdmin.from('cms_product_master')
        .select('product_id, product_name, image_url, is_active, reference_price::text').in('product_id', ids).abortSignal(sig())
      if (error) throw new CmsRepoError('LOOKUP_FAILED')
      for (const r of (data ?? []) as unknown as { product_id: string; product_name: string; image_url: string | null; is_active: boolean; reference_price: string | null }[]) {
        productMaster.set(r.product_id, { productName: r.product_name, imageUrl: r.image_url, isActive: r.is_active, referencePrice: r.reference_price })
      }
    }
    // Chỉ tra trong tập ProductID của file (không phụ thuộc trần số dòng PostgREST).
    const existingProductIds = new Set<string>()
    for (const ids of chunks(productIds, ID_CHUNK)) {
      const { data, error } = await supabaseAdmin.from('cms_program_products').select('product_id')
        .eq('program_id', program.id).in('product_id', ids).abortSignal(sig())
      if (error) throw new CmsRepoError('LOOKUP_FAILED')
      for (const r of data ?? []) existingProductIds.add((r as { product_id: string }).product_id)
    }
    // Chương trình khác đang active / locked, giao ngày, CÙNG namespace is_test (H9) — RPC kiểm lại sau khi khoá.
    // Đọc đủ mọi trang; tập id chương trình và ProductID đều chia khối (URL ngắn), kết quả join phân trang.
    const otherIds = (await readAll<{ id: string }>((from, to) => supabaseAdmin.from('cms_programs').select('id')
      .in('status', ['active', 'locked']).eq('is_test', program.isTest).neq('id', program.id)
      .lte('start_date', program.endDate).gte('end_date', program.startDate)
      .order('id').range(from, to).abortSignal(sig()))).map((r) => r.id)
    const conflictProductIds = new Set<string>()
    for (const progs of chunks(otherIds, ID_CHUNK)) {
      for (const ids of chunks(productIds, ID_CHUNK)) {
        const rows = await readAll<{ product_id: string }>((from, to) => supabaseAdmin.from('cms_program_products').select('product_id')
          .in('program_id', progs).in('product_id', ids).order('program_id').order('product_id').range(from, to).abortSignal(sig()))
        for (const r of rows) conflictProductIds.add(r.product_id)
      }
    }
    return { productMaster, existingProductIds, conflictProductIds }
  },

  async savePreview(i) {
    const { data, error } = await supabaseAdmin.rpc('rpc_cms_import_preview_save', { p: {
      program_id: i.programId, mode: i.mode, file_name: i.fileName, file_sha256: i.sha256, file_bytes: i.fileBytes,
      actor: i.actorId, stats: i.stats, result: i.result,
    } }).abortSignal(sig())
    if (error) throw new CmsRepoError(rpcCode(error, 'PREVIEW_FAILED'))
    if (typeof data !== 'string') throw new CmsRepoError('PREVIEW_FAILED')
    return data
  },

  async commit(i) {
    const { data, error } = await supabaseAdmin.rpc('rpc_cms_import_commit', {
      p_run_id: i.runId, p_sha256: i.sha256, p_digest: i.digest, p_payload: i.payload, p_actor: i.actorId,
    }).abortSignal(sig())
    if (error) throw new CmsRepoError(rpcCode(error, 'COMMIT_FAILED'))
    const r = (data ?? {}) as { already?: boolean; mode?: 'replace' | 'append'; products?: number }
    return { already: r.already === true, mode: r.mode, products: r.products }
  },

  async getRun(id): Promise<CmsImportRunRow | null> {
    const { data, error } = await supabaseAdmin.from('cms_import_runs')
      .select('id, program_id, mode, status, file_sha256, config_version_at_preview, result').eq('id', id).abortSignal(sig()).maybeSingle()
    if (error) throw new CmsRepoError('LOOKUP_FAILED')
    const r = data as { id: string; program_id: string; mode: 'replace' | 'append'; status: 'previewed' | 'committed'; file_sha256: string; config_version_at_preview: number; result: CmsImportRunRow['result'] } | null
    return r ? {
      id: r.id, programId: r.program_id, mode: r.mode, status: r.status, fileSha256: r.file_sha256,
      configVersionAtPreview: r.config_version_at_preview, result: r.result,
    } : null
  },
}
