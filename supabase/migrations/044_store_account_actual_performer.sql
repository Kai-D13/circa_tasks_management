-- ============================================================
-- Migration 044: Performer tracking for store-level task submit
-- ============================================================
-- Phát sinh + Cửa hàng nộp: Store Manager có thể submit thay Staff ca.
-- Tách biệt 2 khái niệm:
--   task_results.user_id       = tài khoản đang login + bấm submit
--   task_results.performed_by  = nhân viên thực tế thực hiện công việc
--   tasks.completed_by         = người thực hiện thật (để list/detail hiển thị)
--   tasks.completed_by_account = tài khoản submit (audit trail)
--
-- Rollback: DROP column performed_by từ task_results,
--           DROP column completed_by_account từ tasks,
--           DROP FUNCTION rpc_submit_task_result(uuid,jsonb,uuid),
--           restore rpc_submit_task_result(uuid,jsonb) từ migration 042.
-- ============================================================

BEGIN;

-- 1. Thêm cột performed_by vào task_results
ALTER TABLE public.task_results
  ADD COLUMN IF NOT EXISTS performed_by uuid REFERENCES public.users(id);

-- 2. Thêm cột completed_by_account vào tasks (tài khoản đã bấm submit)
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS completed_by_account uuid REFERENCES public.users(id);

-- 3. Backfill data cũ: performer = submitter (không có SM-on-behalf trước migration này)
UPDATE public.task_results
   SET performed_by = user_id
 WHERE performed_by IS NULL;

-- 4. Backfill tasks: submit account = performer (data cũ không có sự phân biệt)
UPDATE public.tasks
   SET completed_by_account = completed_by
 WHERE completed_by IS NOT NULL
   AND completed_by_account IS NULL;

-- 5. Enforce NOT NULL sau backfill: mọi result phải có performer
--    (RPC luôn set, direct insert đã lockdown bởi migration 041)
ALTER TABLE public.task_results
  ALTER COLUMN performed_by SET NOT NULL;

-- 6. Index
CREATE INDEX IF NOT EXISTS idx_task_results_performed_by
  ON public.task_results(performed_by);

-- 7. Drop signature cũ (2 params) để tránh ambiguity khi PostgREST route
DROP FUNCTION IF EXISTS public.rpc_submit_task_result(uuid, jsonb);

-- 8. Tạo lại RPC với p_performed_by param (DEFAULT NULL giữ backward-compat)
CREATE OR REPLACE FUNCTION public.rpc_submit_task_result(
  p_task_id       uuid,
  p_output_data   jsonb,
  p_performed_by  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_role             text;
  v_store_id         uuid;
  v_task             record;
  v_is_direct        boolean;
  v_is_store         boolean;
  v_has_result       boolean;
  v_late             boolean;
  v_result_id        uuid;
  v_now              timestamptz := now();
  v_performed_by     uuid;
  v_performer_role   text;
  v_performer_store  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Chưa đăng nhập');
  END IF;

  SELECT role, store_id INTO v_role, v_store_id FROM public.users WHERE id = v_uid;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('error', 'Không tìm thấy hồ sơ người dùng');
  END IF;

  -- Row lock: concurrent submits serialize here
  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Task không tồn tại');
  END IF;

  IF v_task.assignment_mode = 'staff_all' THEN
    RETURN jsonb_build_object('error', 'Đây là task cha — vui lòng nộp kết quả trên task con của bạn.');
  END IF;

  v_is_direct := (v_task.assigned_to IS NOT DISTINCT FROM v_uid);
  v_is_store  := (v_task.assigned_to IS NULL
                  AND v_task.assignment_mode = 'store'
                  AND v_task.store_id IS NOT NULL
                  AND v_task.store_id = v_store_id
                  AND v_role IN ('staff', 'store_manager'));

  IF NOT v_is_direct AND NOT v_is_store THEN
    RETURN jsonb_build_object('error', 'Bạn không có quyền nộp kết quả cho task này');
  END IF;

  -- Xác định người thực hiện thật:
  -- store_manager submit task store-level → phải chọn staff thực hiện
  -- staff submit (mọi mode) hoặc SM submit task giao trực tiếp cho SM → performer = chính họ
  IF v_role = 'store_manager' AND v_is_store THEN
    IF p_performed_by IS NULL THEN
      RETURN jsonb_build_object('error', 'Vui lòng chọn nhân viên đã thực hiện ca này');
    END IF;

    SELECT role, store_id INTO v_performer_role, v_performer_store
      FROM public.users WHERE id = p_performed_by;

    IF v_performer_role IS NULL THEN
      RETURN jsonb_build_object('error', 'Không tìm thấy nhân viên được chọn');
    END IF;
    IF v_performer_role <> 'staff' THEN
      RETURN jsonb_build_object('error', 'Người thực hiện phải là nhân viên (staff)');
    END IF;
    IF v_performer_store <> v_store_id THEN
      RETURN jsonb_build_object('error', 'Nhân viên phải thuộc cùng cửa hàng với task');
    END IF;

    v_performed_by := p_performed_by;
  ELSE
    v_performed_by := v_uid;
  END IF;

  -- Dup check (bên trong lock): direct → per user; store-level → per task
  SELECT EXISTS (
    SELECT 1 FROM public.task_results tr
    WHERE tr.task_id = p_task_id
      AND (NOT v_is_direct OR tr.user_id = v_uid)
      AND (v_task.resubmit_requested_at IS NULL OR tr.submitted_at > v_task.resubmit_requested_at)
  ) INTO v_has_result;

  IF v_has_result THEN
    RETURN jsonb_build_object('error', 'Task này đã có kết quả nộp rồi');
  END IF;

  v_late := (v_task.status = 'overdue')
            OR (v_task.deadline IS NOT NULL AND v_task.deadline < v_now AND v_task.status <> 'done');

  INSERT INTO public.task_results (task_id, user_id, performed_by, output_data)
  VALUES (p_task_id, v_uid, v_performed_by, p_output_data)
  RETURNING id INTO v_result_id;

  UPDATE public.tasks
     SET status                = 'done',
         completed_by          = v_performed_by,
         completed_by_account  = v_uid,
         completed_at          = v_now,
         overdue_at            = CASE WHEN v_late THEN COALESCE(v_task.overdue_at, v_now) ELSE v_task.overdue_at END
   WHERE id = p_task_id;

  INSERT INTO public.task_status_events (task_id, from_status, to_status, actor_id, source)
  VALUES (p_task_id, v_task.status, 'done', v_uid,
          CASE WHEN v_role = 'store_manager' THEN 'store_manager' ELSE 'staff' END);

  INSERT INTO public.task_logs (task_id, action, user_id, metadata)
  VALUES (p_task_id, 'submitted', v_uid,
          jsonb_build_object(
            'output_types',             (SELECT COALESCE(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(p_output_data) AS k),
            'submitted_after_deadline', v_late,
            'performed_by',             v_performed_by,
            'submitted_by_account',     v_uid
          ));

  UPDATE public.task_resubmit_requests
     SET status              = 'fulfilled',
         fulfilled_result_id = v_result_id,
         fulfilled_at        = v_now
   WHERE id = (
     SELECT id FROM public.task_resubmit_requests
     WHERE task_id = p_task_id AND status = 'open'
     ORDER BY requested_at DESC
     LIMIT 1
   );

  RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'submitted_late', v_late);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_submit_task_result(uuid, jsonb, uuid) TO authenticated;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('044', 'store_account_actual_performer',
        'task_results.performed_by + tasks.completed_by_account; SM submitting store-level task must pick a staff performer; RPC validates role+store')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Reload PostgREST schema cache: bắt buộc sau khi đổi FK và function signature,
-- nếu không PostgREST sẽ không nhận embed relation mới và RPC 3-params mới.
NOTIFY pgrst, 'reload schema';

-- -- Verification -------------------------------------------------------------
-- 1) Columns exist:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name IN ('task_results','tasks')
--   AND column_name IN ('performed_by','completed_by_account');
--
-- 2) RPC has new signature:
-- SELECT pg_get_function_identity_arguments(oid)
-- FROM pg_proc WHERE proname = 'rpc_submit_task_result';
-- expect: p_task_id uuid, p_output_data jsonb, p_performed_by uuid
--
-- 3) Old 2-param signature gone:
-- SELECT COUNT(*) FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE p.proname = 'rpc_submit_task_result' AND n.nspname = 'public';
-- expect: 1 (only the new 3-param version)
