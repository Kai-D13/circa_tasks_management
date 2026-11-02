import { NextRequest, NextResponse } from 'next/server'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { handlePullCmsProducts } from '@/lib/cms/cronProducts'
import { cmsProductSyncDeps } from '@/lib/cms/server/productSyncDeps'

// GET /api/cron/pull-cms-products — đồng bộ Product Master CMS (docs/cms/SPEC.md §9). Bearer CRON_SECRET;
// CMS_PROGRAM_ENABLED tắt ⇒ 503, 0 query nguồn. Coolify Scheduled Task `30 22 * * *` (UTC = 05:30 VN) — chỉ tạo ở
// rollout P1 theo lệnh operator. Nạp lần đầu trước khi bật cờ: scripts/cms-bootstrap-products.mjs (operator, cùng core).
// Response / log: số đếm + mã, không tên sản phẩm / URL / lỗi thô.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const r = await handlePullCmsProducts({
    authorization: request.headers.get('authorization'),
    cronSecret: process.env.CRON_SECRET,
    programEnabled: isCmsProgramEnabled(),
    makeDeps: () => cmsProductSyncDeps(),
  })
  if (r.status !== 401) {
    const b = r.body as Record<string, unknown>
    console.warn(`[pull-cms-products] http=${r.status} status=${b.status ?? '-'} code=${b.code ?? '-'} read=${b.rowsRead ?? '-'}`
      + ` written=${b.rowsWritten ?? '-'} rejected=${b.rowsRejected ?? '-'} bytes=${b.bytesProcessed ?? '-'} ms=${b.elapsedMs ?? '-'}`)
  }
  return NextResponse.json(r.body, { status: r.status, headers: { 'Cache-Control': 'no-store' } })
}
