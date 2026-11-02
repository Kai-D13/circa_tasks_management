import 'server-only'
import { runBigQueryPaged } from '@/lib/bigquery/client'
import type { CmsBqRunner } from './bigquery'

// Runner THẬT cho adapter CMS: SA của app (BQ_SERVICE_ACCOUNT_KEY, scope
// bigquery.readonly), đọc đủ mọi trang qua bqQueryAll. Chỉ ĐỌC.
export const cmsBqRunner: CmsBqRunner = (sql, params, opts) =>
  runBigQueryPaged(sql, params, { maxRows: opts.maxRows, deadlineMs: opts.deadlineMs })
