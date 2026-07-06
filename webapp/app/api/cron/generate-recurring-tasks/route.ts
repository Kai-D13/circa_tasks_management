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
      deadline_offset_hours, is_active, next_run_at, assignment_mode,
      task_templates ( id, title, config, created_by )
    `)
    .eq('is_active', true)
    .lte('next_run_at', now.toISOString())

  if (schedError) {
    return NextResponse.json({ error: schedError.message }, { status: 500 })
  }

  for (const sched of schedules ?? []) {
    const idempotencyKey = `${sched.id}_${today}`

    // Skip only if a run already SUCCEEDED today. A failed or interrupted
    // ('running') run is allowed to retry — we reuse its row below rather than
    // letting the idempotency record block the schedule for the rest of the day.
    const { data: existingRun } = await supabaseAdmin
      .from('task_generation_runs')
      .select('id, status')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle()

    if (existingRun?.status === 'success') {
      results.push({ scheduleId: sched.id, created: 0 })
      continue
    }

    // Check end_date
    if (sched.end_date && sched.end_date < today) {
      await supabaseAdmin.from('task_schedules').update({ is_active: false }).eq('id', sched.id)
      results.push({ scheduleId: sched.id, created: 0 })
      continue
    }

    // Create the run record, or reuse a prior failed/interrupted one so the
    // retry runs under the same (unique) idempotency key without conflicting.
    const { data: run, error: runError } = existingRun
      ? await supabaseAdmin
          .from('task_generation_runs')
          .update({ status: 'running', error_message: null, created_count: 0, finished_at: null })
          .eq('id', existingRun.id)
          .select('id')
          .single()
      : await supabaseAdmin
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
      const { data: schedStores, error: schedStoresErr } = await supabaseAdmin
        .from('task_schedule_stores')
        .select('store_id')
        .eq('schedule_id', sched.id)
      if (schedStoresErr) throw new Error(`Store list query failed: ${schedStoresErr.message}`)

      const configuredStoreIds = (schedStores ?? []).map((s) => s.store_id)
      if (!configuredStoreIds.length) throw new Error('No stores configured for schedule')

      // Drop deactivated stores (mig 074) — a schedule may still list a store
      // that was later set inactive; stop generating tasks for it. All target
      // stores inactive → nothing to create (run succeeds with 0), not an error.
      const { data: activeStores, error: activeErr } = await supabaseAdmin
        .from('stores').select('id').in('id', configuredStoreIds).eq('is_active', true)
      if (activeErr) throw new Error(`Active-store query failed: ${activeErr.message}`)
      const activeSet = new Set((activeStores ?? []).map((s) => s.id))
      const storeIds = configuredStoreIds.filter((id) => activeSet.has(id))

      const template = sched.task_templates as unknown as {
        id: string; title: string
        config: {
          description?: string; category: TaskCategory; priority: TaskPriority
          visibility: TaskVisibility; required_outputs: string[]; input_data?: unknown
        }
        created_by: string | null
      } | null

      if (!template) throw new Error('Template not found')

      // Retry-safe: an interrupted prior run may have already created tasks for
      // some stores today. Skip those so this run neither duplicates (the partial
      // unique index would reject the batch) nor false-fails on a conflict.
      const { data: existingTasks, error: existingErr } = await supabaseAdmin
        .from('tasks')
        .select('store_id')
        .eq('source_schedule_id', sched.id)
        .eq('scheduled_for', today)
      // Throw on error: an empty alreadyCreated from a failed query would make a
      // retry re-create rows (caught by the unique index, but better to fail loud).
      if (existingErr) throw new Error(`Existing-tasks query failed: ${existingErr.message}`)

      const alreadyCreated  = new Set((existingTasks ?? []).map((t) => t.store_id))
      const pendingStoreIds = storeIds.filter((id) => !alreadyCreated.has(id))

      let createdCount = 0
      let broadcastId: string | null = null
      let skippedEmptyStores: string[] = []
      let staffChildCount = 0   // staff_all: total children across stores (ops signal)

      if (pendingStoreIds.length) {
        // Deadline — shared by both modes.
        const deadlineMs = now.getTime() + (sched.deadline_offset_hours ?? 24) * 3600_000
        const deadline   = new Date(deadlineMs).toISOString()

        if (sched.assignment_mode === 'staff_all') {
          // ── staff_all: 1 parent + 1 child per pharmacist, per store ──────────
          // Dynamic — every CURRENT role='staff' of each store at run time
          // (new hires included, leavers excluded). Mirrors createStaffRequiredTask.
          // MUST throw on error: a failed query would otherwise look like "every
          // store has 0 staff" → skip all + mark success + advance next_run_at = a
          // silently missed run.
          const { data: staffRows, error: staffErr } = await supabaseAdmin
            .from('users').select('id, store_id')
            .eq('role', 'staff').in('store_id', pendingStoreIds)
          if (staffErr) throw new Error(`Staff query failed: ${staffErr.message}`)

          const staffByStore = new Map<string, string[]>()
          for (const s of staffRows ?? []) {
            const arr = staffByStore.get(s.store_id) ?? []
            arr.push(s.id)
            staffByStore.set(s.store_id, arr)
          }
          const storesWithStaff = pendingStoreIds.filter((id) => (staffByStore.get(id)?.length ?? 0) > 0)
          // Stores with no pharmacist: skip (don't fail the run, don't create an
          // empty parent) — recorded in the run log.
          skippedEmptyStores = pendingStoreIds.filter((id) => !(staffByStore.get(id)?.length))

          if (storesWithStaff.length) {
            const { data: broadcast, error: bcError } = await supabaseAdmin
              .from('task_broadcasts')
              .insert({ title: template.title, created_by: template.created_by, store_count: storesWithStaff.length })
              .select('id')
              .single()
            if (bcError || !broadcast) throw new Error(bcError?.message ?? 'Broadcast insert failed')
            broadcastId = broadcast.id

            // Store managers (parent notifications), grouped by store.
            const { data: managers } = await supabaseAdmin
              .from('users').select('id, store_id')
              .eq('role', 'store_manager').in('store_id', storesWithStaff)
            const mgrByStore = new Map<string, string[]>()
            for (const m of managers ?? []) {
              const arr = mgrByStore.get(m.store_id) ?? []
              arr.push(m.id)
              mgrByStore.set(m.store_id, arr)
            }

            const notifications: { user_id: string; type: string; task_id: string; title: string; message: string }[] = []

            for (const storeId of storesWithStaff) {
              const staffIds = staffByStore.get(storeId)!
              // Parent — private + unassigned (overview only).
              const { data: parent, error: parentErr } = await supabaseAdmin.from('tasks').insert({
                title:              template.title,
                description:        template.config.description ?? null,
                category:           template.config.category,
                priority:           template.config.priority,
                visibility:         'private' as TaskVisibility,
                status:             'todo' as TaskStatus,
                store_id:           storeId,
                assigned_to:        null,
                assignment_mode:    'staff_all',
                created_by:         template.created_by,
                broadcast_id:       broadcast.id,
                deadline,
                required_outputs:   template.config.required_outputs,
                input_data:         template.config.input_data ?? null,
                source_template_id: template.id,
                source_schedule_id: sched.id,
                scheduled_for:      today,
              }).select('id').single()
              if (parentErr || !parent) throw new Error(parentErr?.message ?? 'Parent insert failed')

              // One child per pharmacist — private + assigned.
              const { data: children, error: childErr } = await supabaseAdmin.from('tasks').insert(
                staffIds.map((sid) => ({
                  title:              template.title,
                  description:        template.config.description ?? null,
                  category:           template.config.category,
                  priority:           template.config.priority,
                  visibility:         'private' as TaskVisibility,
                  status:             'todo' as TaskStatus,
                  store_id:           storeId,
                  assigned_to:        sid,
                  assignment_mode:    'user',
                  parent_task_id:     parent.id,
                  created_by:         template.created_by,
                  broadcast_id:       broadcast.id,
                  deadline,
                  required_outputs:   template.config.required_outputs,
                  input_data:         template.config.input_data ?? null,
                  source_template_id: template.id,
                  source_schedule_id: sched.id,
                  scheduled_for:      today,
                })),
              ).select('id, assigned_to')
              if (childErr || !children) {
                // Best-effort rollback so a childless parent never blocks the
                // per-store retry skip permanently.
                await supabaseAdmin.from('tasks').delete().eq('id', parent.id)
                throw new Error(childErr?.message ?? 'Children insert failed')
              }

              createdCount++  // count parents (one per store) — consistent with store mode
              staffChildCount += children.length
              for (const m of (mgrByStore.get(storeId) ?? [])) {
                notifications.push({
                  user_id: m, type: 'task_assigned', task_id: parent.id,
                  title:   'Task định kỳ mới (từng dược sĩ nộp)',
                  message: `Task mới: ${template.title} — ${staffIds.length} dược sĩ cần nộp`,
                })
              }
              for (const c of children) {
                notifications.push({
                  user_id: c.assigned_to as string, type: 'task_assigned', task_id: c.id,
                  title:   'Task định kỳ mới được giao',
                  message: `Bạn được giao task: ${template.title}`,
                })
              }
            }

            if (notifications.length) {
              await supabaseAdmin.from('notifications').insert(notifications)
            }
          }
        } else {
          // ── store mode (unchanged) ──────────────────────────────────────────
          const { data: broadcast, error: bcError } = await supabaseAdmin
            .from('task_broadcasts')
            .insert({
              title:       template.title,
              created_by:  template.created_by,
              store_count: pendingStoreIds.length,
            })
            .select('id')
            .single()

          if (bcError || !broadcast) throw new Error(bcError?.message ?? 'Broadcast insert failed')
          broadcastId = broadcast.id

          // Build task rows for the stores that still need one today
          const tasksToInsert = pendingStoreIds.map((storeId) => ({
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

          createdCount = created?.length ?? 0

          // Notify store managers of the newly created tasks
          if (createdCount > 0) {
            const { data: managers } = await supabaseAdmin
              .from('users')
              .select('id, store_id')
              .eq('role', 'store_manager')
              .in('store_id', pendingStoreIds)

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
        }
      }

      // Grant schedule collaborators access to today's tasks (migration 047).
      // Runs OUTSIDE the pendingStoreIds block and covers ALL of today's tasks
      // for this schedule, so a retry after a partial failure still grants the
      // missed rows. ignoreDuplicates keeps manual per-task permission changes.
      const { data: schedCollabs, error: scError } = await supabaseAdmin
        .from('task_schedule_collaborators')
        .select('admin_id, permission, invited_by')
        .eq('schedule_id', sched.id)
      if (scError) throw new Error(scError.message)

      if (schedCollabs?.length) {
        const { data: todaysTasks, error: ttError } = await supabaseAdmin
          .from('tasks')
          .select('id')
          .eq('source_schedule_id', sched.id)
          .eq('scheduled_for', today)
        if (ttError) throw new Error(ttError.message)

        const collabRows = (todaysTasks ?? []).flatMap((t) =>
          schedCollabs.map((c) => ({
            task_id:    t.id,
            admin_id:   c.admin_id,
            permission: c.permission,
            invited_by: c.invited_by ?? template.created_by,
          }))
        )
        if (collabRows.length) {
          const { error: tcError } = await supabaseAdmin
            .from('task_collaborators')
            .upsert(collabRows, { onConflict: 'task_id,admin_id', ignoreDuplicates: true })
          if (tcError) throw new Error(tcError.message)
        }
      }

      // Log success
      await supabaseAdmin.from('task_logs').insert({
        task_id:  null,
        action:   'recurring_tasks_generated',
        user_id:  null,
        metadata: {
          schedule_id:     sched.id,
          broadcast_id:    broadcastId,
          title:           template.title,
          frequency:       sched.frequency,
          assignment_mode: sched.assignment_mode,
          store_count:     createdCount,
          child_count:     staffChildCount,   // staff_all only; 0 for store mode
          skipped_empty_stores:    skippedEmptyStores.length,
          skipped_empty_store_ids: skippedEmptyStores,
          scheduled_for:   today,
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
