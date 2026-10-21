import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { isCareOrderLinksSyncEnabled } from '@/lib/care/flags'
import { parseCloseRetryHeader } from '@/lib/care/orderLinks/run'
import { careOrderLinksLogLine, runCareOrderLinksSync } from '@/lib/care/server/orderLinksSync'

// GET /api/cron/care-order-links-close — LƯỢT CHỐT kỳ vừa kết thúc (E0 r3.4 §6, Q-187). Scheduled Task HẰNG NGÀY khoảng
// 00:40 VN (Q-191); DB tự quyết: tự chốt khi kỳ trước 'active' và now ∈ [P_end + 30', P_end + 24 h); ngoài ra ⇒ 200 skipped,
// 0 IO BigQuery. Thành công ⇒ kỳ 'closed' (trạng thái cuối). Mọi kết cục không thành công ⇒ DB ghi close_failed cùng
// transaction; KHÔNG tự chạy lại. Chạy lại có kiểm soát (Q-188/190): operator gọi thủ công kèm header
// `X-Care-Close-Retry: YYYY-MM` = đúng kỳ — DB chỉ nhận khi kỳ đó 'close_failed'. Bearer CRON_SECRET; cờ như lượt thường.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isCareOrderLinksSyncEnabled()) {
    return NextResponse.json({ error: 'Đồng bộ đơn sau import chưa bật (CARE_ENABLED + CARE_ORDER_LINKS_SYNC_ENABLED)' }, { status: 503 })
  }
  const retry = parseCloseRetryHeader(request.headers.get('x-care-close-retry'))
  if (retry === 'invalid') return NextResponse.json({ error: 'X-Care-Close-Retry phải dạng YYYY-MM' }, { status: 400 })
  const r = await runCareOrderLinksSync({ kind: 'close', mode: 'apply', retryPeriod: retry })
  console.warn(careOrderLinksLogLine('care-order-links-close', r) + ` retry=${retry ? 'yes' : 'no'}`)
  if (r.ok) {
    revalidatePath('/care')
    revalidatePath('/care/reports')
    revalidatePath('/care/orders')
  }
  // Lượt tự động ngoài khung ⇒ 200 skipped; lời gọi chạy lại (có header) không đủ điều kiện ⇒ 409.
  const status = r.ok ? 200 : r.status === 'skipped' ? (retry ? 409 : 200) : r.status === 'busy' ? 409 : 500
  return NextResponse.json(r, { status, headers: { 'Cache-Control': 'no-store' } })
}
