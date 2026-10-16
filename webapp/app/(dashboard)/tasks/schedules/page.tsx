import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SchedulesListView } from '@/components/tasks/SchedulesListView'

// WAVE A1 (UI design system): visual-only migration to components/ds/ —
// query, admin gate, ScheduleActions (pause/resume/delete) untouched.
// UI v2 P1.5: phần trình bày nằm ở SchedulesListView (dùng chung với fixture /ui-catalog/schedules-v2);
// page chỉ còn cổng admin + truy vấn + ánh xạ dòng.

export default async function SchedulesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/tasks')

  const { data: schedules, error: schedulesError } = await supabase
    .from('task_schedules')
    .select(`
      id, frequency, run_time, next_run_at, last_run_at, is_active, created_at, assignment_mode,
      task_templates ( title ),
      task_schedule_stores ( store_id )
    `)
    .order('created_at', { ascending: false })

  return (
    <SchedulesListView
      error={schedulesError}
      rows={(schedules ?? []).map((s) => {
        const template = s.task_templates as unknown as { title: string } | null
        return {
          id: s.id,
          title: template?.title ?? null,
          frequency: s.frequency,
          run_time: s.run_time,
          next_run_at: s.next_run_at,
          last_run_at: s.last_run_at,
          is_active: s.is_active,
          assignment_mode: s.assignment_mode,
          storeCount: (s.task_schedule_stores as { store_id: string }[] | null)?.length ?? 0,
        }
      })}
    />
  )
}
