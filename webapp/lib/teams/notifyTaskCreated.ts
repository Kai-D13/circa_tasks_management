// Microsoft Teams task notifications — OUTBOX model.
//
// Task creation only ENQUEUES a row (status='pending') into
// teams_notification_events; the actual send to the n8n webhook happens in the
// dispatcher (called by GET /api/cron/teams-dispatch). This decouples Teams
// latency/failures from task creation (faster + lighter requests) and adds
// retry with backoff. Server-only (service-role client) — never import from a
// client component.
import { supabaseAdmin } from '@/lib/supabase/admin'

const TIMEOUT_MS   = 9000
const MAX_ATTEMPTS = 5
const LEASE_MS     = 5 * 60 * 1000 // hold a claimed row out of the next run

// ── Enqueue (called by task-creation actions) ───────────────────────────────
// Best-effort: never throws — task creation must succeed even if enqueue fails.
export async function enqueueTaskCreated(
  items: { taskId: string; storeId: string | null }[],
): Promise<void> {
  if (!items.length) return
  try {
    const rows = items.map((it) =>
      it.storeId
        ? { task_id: it.taskId, store_id: it.storeId, event_type: 'task_created', status: 'pending' as const }
        : { task_id: it.taskId, store_id: null, event_type: 'task_created', status: 'skipped' as const, error_message: 'Task không gắn cửa hàng' },
    )
    await supabaseAdmin.from('teams_notification_events').insert(rows)
  } catch {
    // swallow — enqueue must never break task creation
  }
}

// ── Send one event to n8n ───────────────────────────────────────────────────
interface DueRow { id: string; task_id: string; store_id: string | null; attempts: number }
type SendResult =
  | { status: 'sent';    payload: unknown; response: unknown }
  | { status: 'failed';  payload?: unknown; response?: unknown; error: string }
  | { status: 'skipped'; error: string }

async function sendOne(row: DueRow): Promise<SendResult> {
  const webhookUrl = process.env.N8N_TEAMS_TASK_WEBHOOK_URL
  if (!webhookUrl)   return { status: 'skipped', error: 'N8N_TEAMS_TASK_WEBHOOK_URL chưa cấu hình' }
  if (!row.store_id) return { status: 'skipped', error: 'Task không gắn cửa hàng' }

  const [{ data: task }, { data: store }, { data: chat }] = await Promise.all([
    supabaseAdmin.from('tasks').select('title, deadline').eq('id', row.task_id).maybeSingle(),
    supabaseAdmin.from('stores').select('code, name').eq('id', row.store_id).single(),
    supabaseAdmin.from('store_teams_chats').select('*').eq('store_id', row.store_id).maybeSingle(),
  ])
  if (!task)                 return { status: 'skipped', error: 'Task không tồn tại (đã xoá?)' }
  if (!chat || !chat.is_active) return { status: 'skipped', error: 'Store chưa cấu hình Teams hoặc đã tắt' }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const payload = {
    event_type:         'task_created',
    task_id:            row.task_id,
    task_title:         task.title,
    task_type:          'Phát sinh',
    store_id:           row.store_id,
    store_code:         store?.code ?? null,
    store_name:         store?.name ?? null,
    teams_user_id:      chat.teams_user_id,
    teams_display_name: chat.teams_display_name,
    tenant_id:          chat.tenant_id,
    chat_id:            chat.chat_id,
    deadline:           task.deadline ?? null,
    task_url:           appUrl ? `${appUrl}/tasks/${row.task_id}` : `/tasks/${row.task_id}`,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    })
    let body: unknown = null
    try { body = await res.json() } catch { /* non-JSON */ }
    const okFlag = !!(body && typeof body === 'object' && (body as { ok?: boolean }).ok === true)
    if (res.ok && okFlag) return { status: 'sent', payload, response: body }
    return { status: 'failed', payload, response: body, error: `n8n trả về không hợp lệ (HTTP ${res.status})` }
  } catch (err) {
    return { status: 'failed', payload, error: err instanceof Error ? err.message : 'Lỗi gửi Teams' }
  } finally {
    clearTimeout(timer)
  }
}

// ── Dispatcher (called by the cron) ─────────────────────────────────────────
// Drains due pending/failed events, sends to n8n, updates status + schedules
// retry with exponential backoff. A per-row lease (push next_attempt_at ahead
// before sending) prevents an overlapping run from double-sending.
export async function dispatchDueTeamsEvents(limit = 50): Promise<{
  processed: number; sent: number; failed: number; skipped: number
}> {
  const nowIso = new Date().toISOString()
  const { data: due } = await supabaseAdmin
    .from('teams_notification_events')
    .select('id, task_id, store_id, attempts')
    .in('status', ['pending', 'failed'])
    .lt('attempts', MAX_ATTEMPTS)
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(limit)

  let sent = 0, failed = 0, skipped = 0
  for (const row of (due ?? []) as DueRow[]) {
    // Claim: move next_attempt_at into the future, but only if still due. If the
    // conditional update affects 0 rows, another run already claimed it.
    const leaseIso = new Date(Date.now() + LEASE_MS).toISOString()
    const { data: claimed } = await supabaseAdmin
      .from('teams_notification_events')
      .update({ next_attempt_at: leaseIso })
      .eq('id', row.id)
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
      .select('id')
    if (!claimed || claimed.length === 0) continue

    const r = await sendOne(row)
    if (r.status === 'sent') {
      sent++
      await supabaseAdmin.from('teams_notification_events').update({
        status: 'sent', sent_at: new Date().toISOString(),
        n8n_payload: r.payload ?? null, n8n_response: r.response ?? null,
        error_message: null, next_attempt_at: null,
      }).eq('id', row.id)
    } else if (r.status === 'skipped') {
      skipped++
      await supabaseAdmin.from('teams_notification_events').update({
        status: 'skipped', error_message: r.error, next_attempt_at: null,
      }).eq('id', row.id)
    } else {
      failed++
      const attempts = row.attempts + 1
      const backoffMin = Math.min(2 ** attempts, 60) // 2,4,8,16,32 → cap 60'
      await supabaseAdmin.from('teams_notification_events').update({
        status: 'failed', attempts,
        n8n_payload: r.payload ?? null, n8n_response: r.response ?? null,
        error_message: r.error,
        // At MAX_ATTEMPTS the dispatcher's `attempts < MAX` filter stops retrying.
        next_attempt_at: new Date(Date.now() + backoffMin * 60_000).toISOString(),
      }).eq('id', row.id)
    }
  }
  return { processed: (due ?? []).length, sent, failed, skipped }
}
