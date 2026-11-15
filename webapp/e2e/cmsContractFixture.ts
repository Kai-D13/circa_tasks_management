// CMS-CALC-RET-2 — provider FIXTURE cho run contract: CHỈ test / writer QA (nằm trong e2e/, không vào bundle app), dữ liệu GIẢ, chỉ
// chương trình is_test (worker chặn FIXTURE_REAL_PROGRAM; DB kiểm lại ở seal: provider fixture ⇒ run.is_test). Mô phỏng đúng ngữ nghĩa
// lọc của job BigQuery (source/contractSource.ts): bán theo kỳ + ProductID (so nguyên văn như CAST … IN UNNEST) + completed_at ≤ as_of;
// trả theo cmsContractReturnInScope (CÙNG luật WHERE của job, gồm RET2-SRC-01 giữ phiếu thiếu ngày bán gốc / ProductID); mọi giá trị
// dạng chuỗi. KHÔNG BAO GIỜ là fallback production: NODE_ENV=production ⇒ throw.

import { CMS_RETURN_COLUMNS } from '../lib/cms/calc/returns'
import { CMS_SALES_COLUMNS, type CmsRawRow } from '../lib/cms/source/contract'
import {
  cmsContractReturnInScope, type CmsContractScope, type CmsContractSourceFailure, type CmsContractSourceProvider, type CmsContractSourceReady,
} from '../lib/cms/source/contractSource'
import { parseUtcMicros } from '../lib/cms/time'

export interface CmsContractFixtureSource {
  sales?: CmsRawRow[]
  returns?: CmsRawRow[]
  snapshotId?: string
  /** Giả lập lỗi nguồn (trả nguyên mã). */
  fail?: CmsContractSourceFailure
  /** Giả lập provider hỏng: sửa kết quả READY trước khi trả (kiểm guard của worker). */
  tamper?: (r: CmsContractSourceReady) => CmsContractSourceReady
  /** Ghi lại phạm vi mỗi lần đọc (kiểm worker gửi đúng scope). */
  calls?: CmsContractScope[]
}

function assertNotProduction(): void {
  if (process.env.NODE_ENV === 'production') throw new Error('CMS: fixture provider bị cấm ở production (không fallback)')
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const pick = (r: CmsRawRow, cols: readonly string[]): CmsRawRow => Object.fromEntries(cols.map((c) => [c, str(r[c])]))

export function createCmsContractFixtureProvider(src: CmsContractFixtureSource): CmsContractSourceProvider {
  assertNotProduction()
  return {
    kind: 'fixture',
    async read(scope) {
      assertNotProduction()
      src.calls?.push(scope)
      if (src.fail) return src.fail
      const ids = new Set(scope.productIds)
      const inWin = (v: unknown) => {
        const at = parseUtcMicros(String(v ?? ''))
        return at !== null && at >= scope.fromMicros && at < scope.toMicrosExclusive ? at : null
      }
      const salesRaw = (src.sales ?? []).filter((r) => {
        const at = inWin(r.completed_at)
        return at !== null && at <= scope.asOfMicros && ids.has(String(r.product_id ?? ''))
      }).map((r) => pick(r, CMS_SALES_COLUMNS))
      const returnsRaw = scope.withReturns
        ? (src.returns ?? []).filter((r) => cmsContractReturnInScope(r, { ...scope, productIds: ids })).map((r) => pick(r, CMS_RETURN_COLUMNS))
        : null
      const ready: CmsContractSourceReady = {
        ok: true, provider: 'fixture', snapshotId: src.snapshotId ?? 'qa-fixture-snapshot', asOfMicros: scope.asOfMicros, salesRaw, returnsRaw,
        bytesProcessed: null,
      }
      return src.tamper ? src.tamper(ready) : ready
    },
  }
}
