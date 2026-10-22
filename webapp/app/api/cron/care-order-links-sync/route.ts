import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { isCareOrderLinksSyncEnabled } from '@/lib/care/flags'
import { careOrderLinksLogLine, runCareOrderLinksSync } from '@/lib/care/server/orderLinksSync'

// GET /api/cron/care-order-links-sync — LƯỢT THƯỜNG "đơn xác thực sau import" (E0 r3.4 §4.2): mọi task kỳ VN hiện tại,
// cửa sổ (mốc import, snapshot]. Bearer CRON_SECRET; CARE_ENABLED + CARE_ORDER_LINKS_SYNC_ENABLED (mặc định OFF ⇒ 503,
// không IO). Lượt khác đang chạy ⇒ 409 RUN_IN_PROGRESS (không ghi gì). Lỗi ⇒ 500 + mã; DB giữ dữ liệu đã áp (mốc riêng).
// Response / log: số đếm + mã — không ID khách, DHC, thời điểm đơn, lỗi thô. Coolify Scheduled Task riêng, lệch 10 phút
// sau care-orders-sync (Q-99) — chỉ tạo sau trial + PM GO.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isCareOrderLinksSyncEnabled()) {
    return NextResponse.json({ error: 'Đồng bộ đơn sau import chưa bật (CARE_ENABLED + CARE_ORDER_LINKS_SYNC_ENABLED)' }, { status: 503 })
  }
  const r = await runCareOrderLinksSync({ kind: 'regular', mode: 'apply' })
  console.warn(careOrderLinksLogLine('care-order-links-sync', r))
  if (r.ok) {
    revalidatePath('/care')
    revalidatePath('/care/reports')
    revalidatePath('/care/orders')
    revalidatePath('/care/my')
  }
  return NextResponse.json(r, { status: r.ok ? 200 : r.status === 'busy' ? 409 : 500, headers: { 'Cache-Control': 'no-store' } })
}
