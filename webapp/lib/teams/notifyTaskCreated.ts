// Server-only: imported solely by the 'use server' tasks action; uses the
// service-role client. Do not import from client components.
import { supabaseAdmin } from '@/lib/supabase/admin'

// MVP Microsoft Teams notification on task creation.
// Sends a payload to an n8n webhook which posts a Teams message (with mention).
// NEVER throws — task creation must succeed even if Teams fails.

interface NotifyTaskCreatedInput {
  taskId:     string
  storeId:    string | null
  taskTitle:  string
  taskType:   string            // e.g. 'Phát sinh'
  deadline?:  string | null
}

type EventStatus = 'sent' | 'failed' | 'skipped'

const TIMEOUT_MS = 9000

async function logEvent(params: {
  taskId:      string
  storeId:     string | null
  status:      EventStatus
  payload?:    unknown
  response?:   unknown
  errorMessage?: string
}) {
  try {
    await supabaseAdmin.from('teams_notification_events').insert({
      task_id:       params.taskId,
      store_id:      params.storeId,
      event_type:    'task_created',
      status:        params.status,
      n8n_payload:   params.payload  ?? null,
      n8n_response:  params.response ?? null,
      error_message: params.errorMessage ?? null,
      sent_at:       params.status === 'sent' ? new Date().toISOString() : null,
    })
  } catch {
    // Swallow — logging must never break task creation
  }
}

export async function notifyTaskCreated(input: NotifyTaskCreatedInput): Promise<void> {
  const { taskId, storeId, taskTitle, taskType, deadline } = input

  try {
    if (!storeId) {
      await logEvent({ taskId, storeId: null, status: 'skipped', errorMessage: 'Task không gắn cửa hàng' })
      return
    }

    const webhookUrl = process.env.N8N_TEAMS_TASK_WEBHOOK_URL
    if (!webhookUrl) {
      await logEvent({ taskId, storeId, status: 'skipped', errorMessage: 'N8N_TEAMS_TASK_WEBHOOK_URL chưa cấu hình' })
      return
    }

    // Lookup store + Teams chat config (service role — bypasses RLS)
    const [{ data: store }, { data: chat }] = await Promise.all([
      supabaseAdmin.from('stores').select('code, name').eq('id', storeId).single(),
      supabaseAdmin.from('store_teams_chats').select('*').eq('store_id', storeId).maybeSingle(),
    ])

    if (!chat || !chat.is_active) {
      await logEvent({ taskId, storeId, status: 'skipped', errorMessage: 'Store chưa cấu hình Teams hoặc đã tắt' })
      return
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
    const payload = {
      event_type:         'task_created',
      task_id:            taskId,
      task_title:         taskTitle,
      task_type:          taskType,
      store_id:           storeId,
      store_code:         store?.code ?? null,
      store_name:         store?.name ?? null,
      teams_user_id:      chat.teams_user_id,
      teams_display_name: chat.teams_display_name,
      tenant_id:          chat.tenant_id,
      chat_id:            chat.chat_id,
      deadline:           deadline ?? null,
      task_url:           appUrl ? `${appUrl}/tasks/${taskId}` : `/tasks/${taskId}`,
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const res = await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        signal:  controller.signal,
      })

      let body: unknown = null
      try { body = await res.json() } catch { /* non-JSON response */ }

      const okFlag = !!(body && typeof body === 'object' && (body as { ok?: boolean }).ok === true)
      if (res.ok && okFlag) {
        await logEvent({ taskId, storeId, status: 'sent', payload, response: body })
      } else {
        await logEvent({
          taskId, storeId, status: 'failed', payload, response: body,
          errorMessage: `n8n trả về không hợp lệ (HTTP ${res.status})`,
        })
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    await logEvent({
      taskId,
      storeId: input.storeId,
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : 'Lỗi không xác định khi gửi Teams',
    })
  }
}
