-- Allow staff to update status of tasks assigned to them
-- (needed for todo → in_progress transition)
CREATE POLICY "tasks_update_staff" ON public.tasks FOR UPDATE TO authenticated
  USING (get_user_role() = 'staff' AND assigned_to = auth.uid())
  WITH CHECK (get_user_role() = 'staff' AND assigned_to = auth.uid());
