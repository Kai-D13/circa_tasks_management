-- ============================================================
-- Migration 015: Task Feedback Threads
-- ============================================================
-- Store managers can raise questions/feedback on tasks.
-- Admin responds. Staff cannot see or use this feature.
-- ============================================================

CREATE TABLE public.task_feedback_threads (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid        NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  store_id   uuid        NOT NULL REFERENCES public.stores(id),
  created_by uuid        NOT NULL REFERENCES public.users(id),
  status     text        NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'answered', 'resolved')),
  title      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.task_feedback_messages (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid        NOT NULL REFERENCES public.task_feedback_threads(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.users(id),
  message    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.task_feedback_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_feedback_messages ENABLE ROW LEVEL SECURITY;

-- ── Threads ──────────────────────────────────────────────────
-- Admin: sees all
CREATE POLICY "tft_select_admin" ON public.task_feedback_threads
  FOR SELECT TO authenticated
  USING (get_user_role() = 'admin');

-- Store manager: sees threads for tasks in their store
CREATE POLICY "tft_select_manager" ON public.task_feedback_threads
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND store_id = get_user_store_id()
  );

-- Store manager: can open a thread on tasks in their store.
-- Also verify the referenced task itself belongs to their store (defense in depth).
CREATE POLICY "tft_insert_manager" ON public.task_feedback_threads
  FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = 'store_manager'
    AND store_id = get_user_store_id()
    AND created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.tasks t
      WHERE t.id = task_id
        AND t.store_id = get_user_store_id()
    )
  );

-- Admin: can update status (answered, resolved)
CREATE POLICY "tft_update_admin" ON public.task_feedback_threads
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'admin');

-- Store manager: can mark resolved threads in their store
CREATE POLICY "tft_update_manager" ON public.task_feedback_threads
  FOR UPDATE TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND store_id = get_user_store_id()
  );

-- ── Messages ─────────────────────────────────────────────────
-- Admin: sees all messages
CREATE POLICY "tfm_select_admin" ON public.task_feedback_messages
  FOR SELECT TO authenticated
  USING (get_user_role() = 'admin');

-- Store manager: sees messages on threads in their store
CREATE POLICY "tfm_select_manager" ON public.task_feedback_messages
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'store_manager'
    AND EXISTS (
      SELECT 1 FROM public.task_feedback_threads t
      WHERE t.id = thread_id
        AND t.store_id = get_user_store_id()
    )
  );

-- Admin: can post messages
CREATE POLICY "tfm_insert_admin" ON public.task_feedback_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = 'admin'
    AND user_id = auth.uid()
  );

-- Store manager: can post messages on threads in their store
CREATE POLICY "tfm_insert_manager" ON public.task_feedback_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = 'store_manager'
    AND user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.task_feedback_threads t
      WHERE t.id = thread_id
        AND t.store_id = get_user_store_id()
    )
  );
