import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

// GET /api/cron/overdue
// Called by Coolify Scheduled Tasks every 5 min:
//   wget -qO- -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/overdue
//
// Marks tasks with deadline < now() and status in (todo, in_progress) as 'overdue'
// and notifies their creator.
export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date().toISOString()

  const { data: flipped, error } = await supabaseAdmin
    .from('tasks')
    // Stamp overdue_at as the persistent "đã từng quá hạn" marker. Rows here are
    // todo/in_progress (not yet overdue, or reset by extendDeadline which clears
    // overdue_at), so setting it now is safe and effectively first-time-only.
    .update({ status: 'overdue', overdue_at: now })
    .lt('deadline', now)
    .in('status', ['todo', 'in_progress'])
    // staff_all parents are overview-only and not submittable; never flip them to
    // overdue (they'd be stuck). Their per-staff children flip individually.
    .neq('assignment_mode', 'staff_all')
    .select('id, title, created_by, parent_task_id')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const count = flipped?.length ?? 0

  if (count > 0) {
    type Flipped = { id: string; title: string; created_by: string | null; parent_task_id: string | null }
    const rows = (flipped ?? []) as Flipped[]

    // Regular tasks (no parent): one notification each, pointing at the task itself.
    const regularNotifs = rows
      .filter((t) => !t.parent_task_id && t.created_by)
      .map((t) => ({
        user_id: t.created_by as string,
        type:    'task_overdue',
        task_id: t.id,
        title:   'Task quá hạn',
        message: `Task "${t.title}" đã quá hạn`,
      }))

    // staff_all children share their parent's deadline, so they all flip in the same
    // run. Aggregate each parent's overdue children into ONE notification that points
    // at the parent task — the admin opens the per-pharmacist overview from there.
    const childGroups = new Map<string, { created_by: string; title: string; count: number }>()
    for (const t of rows) {
      if (!t.parent_task_id || !t.created_by) continue
      const g = childGroups.get(t.parent_task_id)
      if (g) g.count++
      else childGroups.set(t.parent_task_id, { created_by: t.created_by, title: t.title, count: 1 })
    }
    const aggregateNotifs = [...childGroups.entries()].map(([parentId, g]) => ({
      user_id: g.created_by,
      type:    'task_overdue',
      task_id: parentId,
      title:   'Dược sĩ quá hạn',
      message: `Task "${g.title}" có ${g.count} dược sĩ quá hạn`,
    }))

    const notifications = [...regularNotifs, ...aggregateNotifs]
    if (notifications.length > 0) {
      await supabaseAdmin.from('notifications').insert(notifications)
    }

    await supabaseAdmin.from('task_logs').insert({
      task_id:  null,
      action:   'overdue_swept',
      user_id:  null,
      metadata: { count, ran_at: now },
    })

    // Structured status events — one row per flipped task.
    // from_status is null: the update returns post-flip rows (status='overdue');
    // the cron filter guarantees prior status was 'todo' or 'in_progress'.
    { const { error: seErr } = await supabaseAdmin.from('task_status_events').insert(
      (flipped ?? []).map((t) => ({
        task_id:     t.id,
        from_status: null as string | null,
        to_status:   'overdue',
        actor_id:    null as string | null,
        source:      'cron',
      }))
    ); if (seErr) console.error('[task_status_events] cron/overdue:', seErr.message) }
  }

  return NextResponse.json({
    ok:     true,
    ran_at: now,
    count,
  })
}
