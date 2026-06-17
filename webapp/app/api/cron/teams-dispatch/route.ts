import { NextRequest, NextResponse } from 'next/server'
import { dispatchDueTeamsEvents } from '@/lib/teams/notifyTaskCreated'

// GET /api/cron/teams-dispatch — drains pending/failed Teams notification events
// (outbox) and sends them to the n8n webhook, with retry + backoff. Task
// creation only enqueues; this worker delivers. Schedule on Coolify every 1 min:
//   wget -qO- --header="Authorization: Bearer $CRON_SECRET" https://duocsi.circa.vn/api/cron/teams-dispatch
export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await dispatchDueTeamsEvents()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
