// CMS — lõi đồng bộ Product Master (SPEC §1.1, §9; IMPLEMENTATION_PLAN §3.2). Thuần: mọi IO qua deps tiêm vào,
// dùng CHUNG cho cron /api/cron/pull-cms-products và script operator scripts/cms-bootstrap-products.mjs
// (PM PR-0: một core, không thuật toán thứ hai). Nguyên tắc fail-closed:
//  · Chưa cấu hình view ⇒ config_missing, KHÔNG query.
//  · Pull ĐẦY ĐỦ, đọc đủ trang; lỗi nguồn / thiếu cột ⇒ error; vượt trần / thiếu trang ⇒ held.
//  · [PM duyệt 01/11 — review P1-a §2.1] dòng lỗi, trùng product_id, rỗng (khi cache đã có dữ liệu, hoặc rỗng
//    ngay lần đầu) ⇒ held, KHÔNG upsert cache (vẫn ghi log phiên). Không nới sang ghi riêng dòng hợp lệ.
//  · Đóng phiên thất bại KHÔNG bị nuốt ⇒ error CLOSE_FAILED + cause (review P1-a §3).
//  · Ghi theo khối ≤ CMS_PRODUCT_UPSERT_CHUNK qua RPC service_role (upsert, không xoá dòng cũ); mỗi khối atomic.
//  · Kết quả / log chỉ số đếm + mã — không tên SP, URL, message thô.

import { fetchCmsProducts, type CmsBqRunner } from './source/bigquery'
import type { CmsProductMasterRow } from './source/contract'
import { formatCmsDecimal } from './decimal'
import { findDuplicates } from './quality'
import { formatUtcMicros } from './time'

export const CMS_PRODUCT_UPSERT_CHUNK = 2000

/** Payload một dòng cho rpc_cms_product_master_upsert (khớp tên cột bảng cms_product_master). */
export interface CmsProductUpsertRow {
  product_id: string
  product_name: string
  image_url: string | null
  is_active: boolean
  source_updated_at: string
  reference_price: string | null
  price_unit: string | null
}

export type CmsSyncRunStatus = 'ok' | 'held' | 'error'

export interface CmsProductSyncDeps {
  /** View nguồn đã validate (lib/cms/config.ts); null = chưa cấu hình. */
  table: string | null
  runner: CmsBqRunner
  /** Số dòng đang có trong cms_product_master (phát hiện rỗng bất thường). */
  countCached(): Promise<number>
  /** rpc_cms_sync_run_open — throw Error('CMS_SYNC_BUSY') khi đang có phiên chạy. */
  openRun(detail: Record<string, string | number | boolean>): Promise<string>
  upsert(runId: string, rows: CmsProductUpsertRow[]): Promise<number>
  closeRun(runId: string, status: CmsSyncRunStatus, detail: Record<string, string | number | boolean | null>): Promise<void>
  now(): number
}

export type CmsProductSyncStatus = 'config_missing' | 'dry_run' | 'ok' | 'held' | 'error' | 'busy'

export interface CmsProductSyncResult {
  status: CmsProductSyncStatus
  /** Mã held / error (in hoa, không dữ liệu); null khi ok / dry_run sạch. */
  code: string | null
  runId: string | null
  rowsRead: number | null
  rowsValid: number | null
  rowsRejected: number | null
  rowsWritten: number
  inactive: number | null
  imageRejected: number | null
  bytesProcessed: number | null
  elapsedMs: number
  /**
   * Kết quả dự định trước bước đóng phiên khi ĐÓNG PHIÊN THẤT BẠI (PM audit P1-a §3): status = 'error',
   * code = 'CLOSE_FAILED' và cause giữ nguyên nguyên nhân / trạng thái gốc (ok · held · error + mã). null khi đóng
   * phiên thành công hoặc không mở phiên (dry-run). Phiên còn running sẽ bị lượt sau đóng STALE sau 30′.
   */
  cause: { status: 'ok' | 'held' | 'error'; code: string | null } | null
}

export function toCmsProductUpsertRow(r: CmsProductMasterRow): CmsProductUpsertRow {
  return {
    product_id: r.productId,
    product_name: r.productName,
    image_url: r.imageUrl,
    is_active: r.isActive,
    source_updated_at: formatUtcMicros(r.sourceUpdatedAtMicros),
    reference_price: r.referencePriceUnits === null ? null : formatCmsDecimal(r.referencePriceUnits),
    price_unit: r.priceUnit,
  }
}

export async function runCmsProductSync(
  deps: CmsProductSyncDeps,
  opts: { dryRun: boolean; source: 'cron' | 'bootstrap'; chunkSize?: number },
): Promise<CmsProductSyncResult> {
  const t0 = deps.now()
  const base: CmsProductSyncResult = {
    status: 'error', code: null, runId: null, rowsRead: null, rowsValid: null, rowsRejected: null,
    rowsWritten: 0, inactive: null, imageRejected: null, bytesProcessed: null, elapsedMs: 0, cause: null,
  }
  const done = (o: Partial<CmsProductSyncResult>): CmsProductSyncResult => ({ ...base, ...o, elapsedMs: deps.now() - t0 })
  if (!deps.table) return done({ status: 'config_missing', code: 'CONFIG_MISSING' })

  let runId: string | null = null
  if (!opts.dryRun) {
    try {
      runId = await deps.openRun({ source: opts.source })
    } catch (e) {
      const busy = String((e as Error)?.message ?? '').includes('CMS_SYNC_BUSY')
      return done({ status: busy ? 'busy' : 'error', code: busy ? 'CMS_SYNC_BUSY' : 'OPEN_FAILED' })
    }
  }
  // Đóng phiên rồi trả kết quả. KHÔNG nuốt lỗi đóng phiên (PM audit P1-a §3): đóng thất bại ⇒ status 'error',
  // code 'CLOSE_FAILED', cause = kết quả dự định; giữ runId + rowsWritten đã xác nhận; không tuyên bố rollback.
  const finish = async (
    status: CmsSyncRunStatus,
    code: string | null,
    detail: Record<string, string | number | boolean | null>,
    o: Partial<CmsProductSyncResult>,
  ): Promise<CmsProductSyncResult> => {
    if (runId !== null) {
      try {
        await deps.closeRun(runId, status, detail)
      } catch {
        return done({ ...o, status: 'error', code: 'CLOSE_FAILED', runId, cause: { status, code } })
      }
    }
    return done({ ...o, status, code, runId })
  }

  const fetched = await fetchCmsProducts(deps.runner, deps.table)
  if (!fetched.ok) {
    const held = fetched.reason === 'OVER_CAP' || fetched.reason === 'INCOMPLETE_PAGES'
    const code = `SOURCE_${fetched.reason}`
    if (opts.dryRun) return done({ status: 'dry_run', code })
    return finish(held ? 'held' : 'error', code, { error_code: code }, {})
  }

  const counts = {
    rowsRead: fetched.rowsRead,
    rowsValid: fetched.rows.length,
    rowsRejected: fetched.rowIssues.length,
    inactive: fetched.rows.filter((r) => !r.isActive).length,
    imageRejected: fetched.rows.filter((r) => r.imageRejected).length,
    bytesProcessed: fetched.bytesProcessed,
  }
  const closeDetail = (code: string | null) => ({
    rows_read: counts.rowsRead, rows_rejected: counts.rowsRejected, bytes_processed: counts.bytesProcessed,
    error_code: code, inactive: counts.inactive, image_rejected: counts.imageRejected, source: opts.source,
  })

  let heldCode: string | null = null
  if (counts.rowsRejected > 0) heldCode = 'ROW_ISSUES'
  else if (findDuplicates(fetched.rows.map((r) => r.productId)).length > 0) heldCode = 'DUPLICATE_PRODUCT'
  else if (counts.rowsRead === 0) {
    let cached = 0
    try { cached = await deps.countCached() } catch { cached = -1 }
    heldCode = cached === 0 ? 'EMPTY_SOURCE' : 'EMPTY_AFTER_DATA'
  }

  if (opts.dryRun) return done({ status: 'dry_run', code: heldCode, ...counts })
  if (heldCode) return finish('held', heldCode, closeDetail(heldCode), counts)

  const rows = fetched.rows.map(toCmsProductUpsertRow)
  const size = Math.max(1, Math.min(opts.chunkSize ?? CMS_PRODUCT_UPSERT_CHUNK, 5000))
  let written = 0
  try {
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size)
      const n = await deps.upsert(runId!, chunk)
      if (n !== chunk.length) throw new Error('COUNT_MISMATCH')
      written += n
    }
  } catch {
    // Các khối trước đã upsert vẫn còn (cache metadata, PM chấp nhận — không atomic toàn lượt): báo error + rowsWritten.
    return finish('error', 'UPSERT_FAILED', closeDetail('UPSERT_FAILED'), { ...counts, rowsWritten: written })
  }
  return finish('ok', null, closeDetail(null), { ...counts, rowsWritten: written })
}

/** Mã thoát script bootstrap: 0 chỉ khi ok / dry-run sạch; held · busy · lỗi · CLOSE_FAILED ⇒ 1; thiếu cấu hình ⇒ 2. */
export function cmsBootstrapExitCode(r: Pick<CmsProductSyncResult, 'status' | 'code'>): number {
  if (r.status === 'config_missing') return 2
  return (r.status === 'ok' || r.status === 'dry_run') && r.code === null ? 0 : 1
}

/** HTTP cho cron: ok/dry_run 200 · held 207 (giữ bản cũ) · busy 409 · thiếu cấu hình 503 · lỗi 500. */
export function cmsProductSyncHttpStatus(s: CmsProductSyncStatus): number {
  switch (s) {
    case 'ok': case 'dry_run': return 200
    case 'held': return 207
    case 'busy': return 409
    case 'config_missing': return 503
    default: return 500
  }
}
