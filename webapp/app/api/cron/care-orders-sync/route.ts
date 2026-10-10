import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { isCareEnabled, isCareSyncEnabled } from '@/lib/care/flags'
import { syncCareOrders } from '@/lib/care/server/orderSync'

// GET /api/cron/care-orders-sync — đồng bộ đơn N3 (SPEC §B5b.2). Bearer CRON_SECRET; CARE_ENABLED VÀ
// CARE_SYNC_ENABLED phải bật (mặc định OFF ⇒ 503, không IO). Một lượt: ứng viên ⇒ preflight VIEW ⇒ đọc đủ
// mọi lô ⇒ apply MỘT transaction; lỗi ⇒ chỉ ghi MÃ, giữ dữ liệu cũ. Response/log: số đếm + mã, không ID khách,
// DHC, timestamp đơn hay lỗi thô. Coolify Scheduled Task `30 9,15,19 * * *` (giờ VN — scheduler đã xác nhận,
// Q-99) — chỉ tạo ở B6 sau gate Q-100 (adapter trừ 7 giờ B5b.3 + 2 DHC khớp UTC raw) và PM duyệt.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isCareEnabled() || !isCareSyncEnabled()) {
    return NextResponse.json({ error: 'Đồng bộ đơn CRM chưa bật (CARE_ENABLED + CARE_SYNC_ENABLED)' }, { status: 503 })
  }
  const r = await syncCareOrders()
  console.warn(`[care-orders-sync] ok=${r.ok} code=${r.code ?? '-'} windows=${r.windows ?? '-'} customers=${r.customers ?? '-'}`
    + ` orders=${r.orders} written=${r.ordersWritten} jobs=${r.jobs} bytes=${r.bytesProcessed ?? '-'} ms=${r.elapsedMs}`)
  if (r.ok) {
    revalidatePath('/care')
    revalidatePath('/care/reports')
  }
  return NextResponse.json(r, { status: r.ok ? 200 : 500, headers: { 'Cache-Control': 'no-store' } })
}
