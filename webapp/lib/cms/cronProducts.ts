// CMS — handler thuần cho GET /api/cron/pull-cms-products (SPEC §9). Thứ tự kiểm (fail-closed, không IO trước khi đạt):
//   1) Bearer CRON_SECRET (so sánh hằng thời gian)  ⇒ 401
//   2) CMS_PROGRAM_ENABLED tắt                       ⇒ 503, KHÔNG dựng deps, KHÔNG query nguồn (PM PR-0)
//   3) chưa cấu hình CMS_BQ_PRODUCTS_TABLE           ⇒ 503, không query
//   4) chạy lõi runCmsProductSync (không dry-run)    ⇒ 200 / 207 held / 409 busy / 500 (lỗi bất ngờ ⇒ 500 INTERNAL, không message thô)
// Body chỉ có số đếm + mã. Route chỉ nối deps thật (lib/cms/server/productSyncDeps.ts).

import { timingSafeEqual } from 'node:crypto'
import { cmsProductSyncHttpStatus, runCmsProductSync, type CmsProductSyncDeps } from './productSync'

export function cronBearerMatches(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || !authorization || !authorization.startsWith('Bearer ')) return false
  const got = Buffer.from(authorization.slice('Bearer '.length), 'utf8')
  const want = Buffer.from(secret, 'utf8')
  return got.length === want.length && timingSafeEqual(got, want)
}

export async function handlePullCmsProducts(input: {
  authorization: string | null
  cronSecret: string | undefined
  programEnabled: boolean
  makeDeps: () => CmsProductSyncDeps
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!cronBearerMatches(input.authorization, input.cronSecret)) {
    return { status: 401, body: { error: 'Unauthorized' } }
  }
  if (!input.programEnabled) {
    return { status: 503, body: { error: 'CMS chưa bật (CMS_PROGRAM_ENABLED)', code: 'FLAG_OFF' } }
  }
  let deps: CmsProductSyncDeps
  try { deps = input.makeDeps() } catch { return { status: 503, body: { error: 'Cấu hình nguồn CMS không hợp lệ', code: 'CONFIG_INVALID' } } }
  if (!deps.table) {
    return { status: 503, body: { error: 'Chưa cấu hình CMS_BQ_PRODUCTS_TABLE', code: 'CONFIG_MISSING' } }
  }
  try {
    const r = await runCmsProductSync(deps, { dryRun: false, source: 'cron' })
    return { status: cmsProductSyncHttpStatus(r.status), body: { ...r } }
  } catch {
    // Lỗi ngoài dự kiến: chỉ trả mã, không message thô; phiên đang mở (nếu có) sẽ bị đóng STALE ở lượt sau.
    return { status: 500, body: { error: 'Lỗi đồng bộ Product Master', code: 'INTERNAL' } }
  }
}
