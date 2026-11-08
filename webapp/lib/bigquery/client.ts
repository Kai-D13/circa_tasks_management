import 'server-only'
import { getAccessToken, loadServiceAccount } from '@/lib/google/auth'
import { BigQueryError, bqDryRunBytes, bqQueryAll, type BqParam, type BqQueryOptions, type BqQueryResult, type BqTransport } from './query'

// Wrapper thật của lib/bigquery/query.ts: xác thực bằng service account đang
// dùng cho cron KPI (BQ_SERVICE_ACCOUNT_KEY, scope readonly). Chỉ ĐỌC.
// B0: chưa có caller (B5 cron care-orders-sync sẽ dùng); không đụng cron KPI.

const BQ_SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly'

function realTransport(): { transport: BqTransport; projectId: string } {
  const sa = loadServiceAccount('BQ_SERVICE_ACCOUNT_KEY')
  if (!sa) throw new BigQueryError('config', 'BQ_SERVICE_ACCOUNT_KEY thiếu hoặc không hợp lệ')
  return {
    projectId: sa.project_id,
    transport: {
      fetch,
      getToken: () => getAccessToken(sa, BQ_SCOPE),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  }
}

export async function runBigQueryPaged(
  sql: string,
  params: BqParam[] = [],
  opts: Omit<BqQueryOptions, 'projectId' | 'sql' | 'params'> = {},
): Promise<BqQueryResult> {
  const { transport, projectId } = realTransport()
  return bqQueryAll(transport, { ...opts, projectId, sql, params })
}

/** Dry-run: số byte ước tính (không chạy truy vấn). */
export async function runBigQueryDryRun(sql: string, params: BqParam[] = [], opts: { deadlineMs?: number } = {}): Promise<number> {
  const { transport, projectId } = realTransport()
  return bqDryRunBytes(transport, { projectId, sql, params, deadlineMs: opts.deadlineMs })
}

export { BigQueryError }
export type { BqParam, BqQueryResult, BqRow } from './query'
