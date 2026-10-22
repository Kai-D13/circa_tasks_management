import { NextRequest, NextResponse } from 'next/server'
import { isCareOrderLinksTrialEnabled } from '@/lib/care/flags'
import { careOrderLinksLogLine, cleanupCareOrderLinksTrial, runCareOrderLinksSync } from '@/lib/care/server/orderLinksSync'

// GET /api/cron/care-order-links-trial — TRIAL của E (E0 r3.4 §12, TẠM — gỡ sau trial). `?kind=regular` (kỳ hiện tại) hoặc
// `?kind=close` (kỳ trước, chưa closed): đi đủ đường đọc BigQuery + kiểm DB nhưng KHÔNG ghi link / coverage / trạng thái;
// chỉ ghi metadata run ⇒ trả số tổng hợp + checksum. `?action=cleanup` ⇒ care_order_links_trial_cleanup (kiểm còn 0).
// Bearer CRON_SECRET; CARE_ENABLED + CARE_ORDER_LINKS_TRIAL_ENABLED (độc lập cờ sync — trial chạy TRƯỚC khi bật sync).

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isCareOrderLinksTrialEnabled()) {
    return NextResponse.json({ error: 'Trial đơn sau import chưa bật (CARE_ENABLED + CARE_ORDER_LINKS_TRIAL_ENABLED)' }, { status: 503 })
  }
  const q = request.nextUrl.searchParams
  if (q.get('action') === 'cleanup') {
    try {
      const c = await cleanupCareOrderLinksTrial()
      console.warn(`[care-order-links-trial] cleanup deleted=${c.deletedRuns} remaining=${c.remainingTrialRuns}`)
      return NextResponse.json({ ok: c.remainingTrialRuns === 0, ...c }, { status: c.remainingTrialRuns === 0 ? 200 : 500, headers: { 'Cache-Control': 'no-store' } })
    } catch {
      return NextResponse.json({ ok: false, code: 'DB_CLEANUP_FAILED' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
    }
  }
  const kind = q.get('kind')
  if (kind !== 'regular' && kind !== 'close') return NextResponse.json({ error: 'kind phải là regular hoặc close' }, { status: 400 })
  const r = await runCareOrderLinksSync({ kind, mode: 'trial' })
  console.warn(careOrderLinksLogLine('care-order-links-trial', r))
  return NextResponse.json(r, { status: r.ok ? 200 : r.status === 'busy' || r.status === 'skipped' ? 409 : 500, headers: { 'Cache-Control': 'no-store' } })
}
