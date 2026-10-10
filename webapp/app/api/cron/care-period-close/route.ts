import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { isCareEnabled, isCareSyncEnabled } from '@/lib/care/flags'
import { closeCarePeriod } from '@/lib/care/server/periodClose'

// GET /api/cron/care-period-close — đánh dấu trễ hẹn rồi đóng kỳ CRM (SPEC §B5c, plan §2.8). Bearer
// CRON_SECRET; CARE_ENABLED VÀ CARE_SYNC_ENABLED phải bật (mặc định OFF ⇒ 503, không IO). Lần lượt
// care_stamp_overdue() ⇒ care_close_period() (luôn gọi cả hai); bước nào lỗi ⇒ 500 kèm trạng thái từng bước
// (lượt sau hoàn tất phần còn thiếu — hai RPC idempotent). Response/log: số đếm + mã, không ID task hay lỗi
// DB thô. Coolify Scheduled Task `5 0 * * *` (giờ VN — scheduler đã xác nhận) — chỉ tạo ở B6 sau PM GO.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isCareEnabled() || !isCareSyncEnabled()) {
    return NextResponse.json({ error: 'Đóng kỳ CRM chưa bật (CARE_ENABLED + CARE_SYNC_ENABLED)' }, { status: 503 })
  }
  const r = await closeCarePeriod()
  console.warn(`[care-period-close] ok=${r.ok} code=${r.code ?? '-'} stamp=${r.stampOverdue.status}:${r.stampOverdue.rows ?? '-'}`
    + ` close=${r.closePeriod.status}:${r.closePeriod.rows ?? '-'} ms=${r.elapsedMs}`)
  if (r.stampOverdue.status === 'ok' || r.closePeriod.status === 'ok') {
    revalidatePath('/care')
    revalidatePath('/care/tasks')
    revalidatePath('/care/my')
    revalidatePath('/care/reports')
  }
  return NextResponse.json(r, { status: r.ok ? 200 : 500, headers: { 'Cache-Control': 'no-store' } })
}
