import 'server-only'
import { isCmsImportV2Enabled, isCmsProgramEnabled } from '@/lib/cms/flags'
import type { CmsImportDeps } from '@/lib/cms/import/handler'
import { fetchCmsKEvidence } from '@/lib/cms/import/kSource'
import { cmsBqSalesTable } from '@/lib/cms/config'
import { runBigQueryDryRun, runBigQueryPaged } from '@/lib/bigquery/client'
import { getCmsAdminAccess } from './access'
import { supabaseCmsImportRepo } from './importRepo'

// Nối dependency thật cho route import CMS (cờ, session super admin + marker QA, repo service role).
export function cmsImportDeps(): CmsImportDeps {
  return {
    enabled: isCmsProgramEnabled(),
    v2: isCmsImportV2Enabled(),
    // S2 kiểm K: view dòng đơn ĐÃ cấu hình cho đồng bộ bán (không nhận từ client), dry-run + trần byte + hạn trong kSource.
    kProbe: (productIds) => fetchCmsKEvidence({
      dryRun: (sql, params, deadlineMs) => runBigQueryDryRun(sql, params, { deadlineMs }),
      run: (sql, params, o) => runBigQueryPaged(sql, params, { maxRows: o.maxRows, deadlineMs: o.deadlineMs, maximumBytesBilled: o.maximumBytesBilled }),
      now: () => Date.now(),
    }, { table: cmsBqSalesTable(process.env), productIds }),
    getAccess: getCmsAdminAccess,
    repo: supabaseCmsImportRepo,
    now: () => new Date(),
  }
}
