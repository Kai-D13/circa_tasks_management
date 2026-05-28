import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeNextRunAt } from '@/lib/recurring'
import { TaskCategory, TaskPriority, TaskStatus, TaskVisibility } from '@/types'

// POST /api/cron/generate-recurring-tasks
// Called by Vercel Cron (daily at 01:00 UTC = 08:00 ICT).
// Also callable manually: curl -H "Authorization: Bearer $CRON_SECRET" ...
export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now     = new Date()
  const today   = now.toISOString().slice(0, 10) // YYYY-MM-DD
  const results: { scheduleId: string; created: number; error?: string }[] = []
  let totalCreated = 0

  // Fetch all active schedules due to run
  const { data: schedules, error: schedError } = await supabaseAdmin
    .from('task_schedules')
    .select(`
      id, frequency, run_time, weekdays, month_day, start_date, end_date,
      deadline_offset_hours, is_active, next_run_at,
      task_templates ( id, title, config, created_by )
    `)
    .eq('is_active', true)
    .lte('next_run_at', now.toISOString())

  if (schedError) {
    return NextResponse.json({ error: schedError.message }, { status: 500 })
  }

  for (const sched of schedules ?? []) {
    const idempotencyKey = `${sched.id}_${today}`

    // Skip if already ran today (idempotency)
    const { data: existingRun } = await supabaseAdmin
      .from('task_generation_runs')
      .select('id')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle()

    if (existingRun) {
      results.push({ scheduleId: sched.id, created: 0 })
      continue
    }

    // Check end_date
    if (sched.end_date && sched.end_date < today) {
      await supabaseAdmin.from('task_schedules').update({ is_active: false }).eq('id', sched.id)
      results.push({ scheduleId: sched.id, created: 0 })
      continue
    }

    // Create run record
    const { data: run, error: runError } = await supabaseAdmin
      .from('task_generation_runs')
      .insert({
        schedule_id:     sched.id,
        scheduled_for:   today,
        status:          'running',
        idempotency_key: idempotencyKey,
      })
      .select('id')
      .single()

    if (runError || !run) {
      results.push({ scheduleId: sched.id, created: 0, error: runError?.message })
      continue
    }

    try {
      // Fetch store list for this schedule
      const { data: schedStores } = await supabaseAdmin
        .from('task_schedule_stores')
        .select('store_id')
        .eq('schedule_id', sched.id)

      const storeIds = (schedStores ?? []).map((s) => s.store_id)
      if (!storeIds.length) throw new Error('No stores configured for schedule')

      const template = sched.task_templates as unknown as {
        id: string; title: string
        config: {
          description?: string; category: TaskCategory; priority: TaskPriority
          visibility: TaskVisibility; required_outputs: string[]; input_data?: unknown
        }
        created_by: string | null
      } | null

      if (!template) throw new Error('Template not found')

      // Create a broadcast group for this run
      const { data: broadcast, error: bcError } = await supabaseAdmin
        .from('task_broadcasts')
        .insert({
          title:       template.title,
          created_by:  template.created_by,
          store_count: storeIds.length,
        })
        .select('id')
        .single()

      if (bcError || !broadcast) throw new Error(bcError?.message ?? 'Broadcast insert failed')

      // Compute deadline
      const deadlineMs = now.getTime() + (sched.deadline_offset_hours ?? 24) * 3600_000
      const deadline   = new Date(deadlineMs).toISOString()

      // Build task rows — skip stores that already have a task for this schedule+day
      const tasksToInsert = storeIds.map((storeId) => ({
        title:              template.title,
        description:        template.config.description ?? null,
        category:           template.config.category,
        priority:           template.config.priority,
        visibility:         template.config.visibility,
        status:             'todo' as TaskStatus,
        store_id:           storeId,
        assigned_to:        null,
        created_by:         template.created_by,
        broadcast_id:       broadcast.id,
        deadline,
        required_outputs:   template.config.required_outputs,
        input_data:         template.config.input_data ?? null,
        source_template_id: template.id,
        source_schedule_id: sched.id,
        scheduled_for:      today,
        assignment_mode:    'store',
      }))

      // Insert — unique index on (source_schedule_id, store_id, scheduled_for) prevents duplicates
      const { data: created, error: insertError } = await supabaseAdmin
        .from('tasks')
        .insert(tasksToInsert)
        .select('id, store_id, title')

      if (insertError) throw new Error(insertError.message)

      const createdCount = created?.length ?? 0

      // Notify store managers
      if (createdCount > 0) {
        const { data: managers } = await supabaseAdmin
          .from('users')
          .select('id, store_id')
          .eq('role', 'store_manager')
          .in('store_id', storeIds)

        if (managers?.length) {
          await supabaseAdmin.from('notifications').insert(
            managers.map((mgr) => {
              const task = (created ?? []).find((t) => t.store_id === mgr.store_id)
              return {
                user_id: mgr.id,
                type:    'task_assigned',
                task_id: task?.id ?? null,
                title:   'Task định kỳ mới',
                message: `Task mới: ${template.title}`,
              }
            })
          )
        }
      }

      // Log success
      await supabaseAdmin.from('task_logs').insert({
        task_id:  null,
        action:   'recurring_tasks_generated',
        user_id:  null,
        metadata: {
          schedule_id:  sched.id,
          broadcast_id: broadcast.id,
          title:        template.title,
          frequency:    sched.frequency,
          store_count:  createdCount,
          scheduled_for: today,
        },
      })

      // Advance next_run_at
      const nextRunAt = computeNextRunAt(
        today,
        sched.run_time,
        sched.frequency as 'daily' | 'weekly' | 'monthly',
        sched.weekdays as number[] | null,
        sched.month_day as number | null,
        now.getTime() // afterMs = now so we skip today
      )

      await supabaseAdmin.from('task_schedules').update({
        last_run_at: now.toISOString(),
        next_run_at: nextRunAt,
      }).eq('id', sched.id)

      // Update run record
      await supabaseAdmin.from('task_generation_runs').update({
        status:        'success',
        created_count: createdCount,
        finished_at:   new Date().toISOString(),
      }).eq('id', run.id)

      totalCreated += createdCount
      results.push({ scheduleId: sched.id, created: createdCount })

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      await supabaseAdmin.from('task_generation_runs').update({
        status:        'failed',
        error_message: msg,
        finished_at:   new Date().toISOString(),
      }).eq('id', run.id)

      await supabaseAdmin.from('task_logs').insert({
        task_id:  null,
        action:   'cron_run_failed',
        user_id:  null,
        metadata: { schedule_id: sched.id, error_message: msg, scheduled_for: today },
      })

      results.push({ scheduleId: sched.id, created: 0, error: msg })
    }
  }

  return NextResponse.json({
    ok:           true,
    ran_at:       now.toISOString(),
    total_created: totalCreated,
    results,
  })
}
