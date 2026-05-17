-- Notifications table for in-app alerts
CREATE TABLE IF NOT EXISTS public.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type       text NOT NULL,   -- 'task_assigned' | 'task_reassigned' | 'status_changed' | 'task_submitted'
  task_id    uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
  title      text NOT NULL,
  message    text NOT NULL,
  is_read    boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Users see only their own notifications
CREATE POLICY "notifications_select"
  ON public.notifications FOR SELECT
  USING (user_id = auth.uid());

-- Any authenticated user can insert notifications (server actions send on behalf of others)
CREATE POLICY "notifications_insert"
  ON public.notifications FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Users can mark their own notifications as read
CREATE POLICY "notifications_update"
  ON public.notifications FOR UPDATE
  USING (user_id = auth.uid());

-- Enable realtime so the bell updates live
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
