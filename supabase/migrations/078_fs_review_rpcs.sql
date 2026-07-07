-- ============================================================================
-- 078_fs_review_rpcs.sql
-- FS module — F3 (Kết quả / review). Set-based, atomic, audited, DB-GUARDED
-- actions for Policy/super review. All SECURITY DEFINER (service_role); each
-- writes fs_item_events (photos keep only the last version — the ACTION history
-- lives here). pg_safeupdate-safe (every UPDATE has WHERE). Records '078'.
--
-- r1 (review): the DB — not the button — enforces the business rules, because
-- "chốt phiên" is the final action and RPCs must not trust the client:
--   * rpc_fs_close_session('completed') requires an ACTIVE session whose EVERY
--     item is 'done' (no pending, no redo). 'cancelled' only requires active.
--   * resubmit RPCs only touch items of THIS session that are 'done', in an
--     ACTIVE session; a mismatch between requested and updated → RAISE (rollback).
-- ============================================================================

BEGIN;

-- Bulk (or single) WHOLE-item resubmit. Only 'done' items of an ACTIVE session
-- are eligible; requested count must equal updated count or the whole call rolls
-- back (no silent partial, no event for a skipped item). note required upstream.
CREATE OR REPLACE FUNCTION public.rpc_fs_resubmit_items(
  p_session_id uuid, p_item_ids uuid[], p_note text, p_actor uuid
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_req    int := COALESCE(array_length(p_item_ids, 1), 0);
  v_n      int;
  v_active boolean;
BEGIN
  IF v_req = 0 THEN RETURN 0; END IF;

  SELECT (status = 'active') INTO v_active FROM public.fs_sessions WHERE id = p_session_id;
  IF v_active IS NULL THEN RAISE EXCEPTION 'Phiên không tồn tại'; END IF;
  IF NOT v_active THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;

  -- Only items of THIS session that are currently 'done'.
  UPDATE public.fs_session_items
    SET status = 'redo', resubmit_note = p_note
    WHERE session_id = p_session_id AND id = ANY(p_item_ids) AND status = 'done';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Caller must pass a de-duplicated list of valid, done items. Any shortfall
  -- (foreign item / not done / duplicate) fails the whole call.
  IF v_n <> v_req THEN
    RAISE EXCEPTION 'Có % sản phẩm không hợp lệ để làm lại (không thuộc phiên / chưa hoàn thành / trùng)', v_req - v_n;
  END IF;

  -- Whole-item resubmit → every box of those items needs redo.
  UPDATE public.fs_item_photos SET status = 'redo' WHERE item_id = ANY(p_item_ids);

  INSERT INTO public.fs_item_events (session_id, item_id, event_type, note, actor)
    SELECT p_session_id, unnest(p_item_ids), 'item_resubmit_requested', p_note, p_actor;

  RETURN v_n;
END;
$$;

-- Per-box resubmit (single item): box 1..5, item must be 'done' in an ACTIVE
-- session. The item goes back to 'redo' (re-enters the staff queue).
CREATE OR REPLACE FUNCTION public.rpc_fs_resubmit_box(
  p_item_id uuid, p_box_key int, p_note text, p_actor uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_session     uuid;
  v_item_status text;
  v_sess_status text;
BEGIN
  IF p_box_key < 1 OR p_box_key > 5 THEN RAISE EXCEPTION 'Box ảnh không hợp lệ (1..5)'; END IF;

  SELECT i.session_id, i.status, s.status
    INTO v_session, v_item_status, v_sess_status
    FROM public.fs_session_items i JOIN public.fs_sessions s ON s.id = i.session_id
    WHERE i.id = p_item_id;
  IF v_session IS NULL THEN RAISE EXCEPTION 'Sản phẩm không tồn tại'; END IF;
  IF v_sess_status <> 'active' THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;
  IF v_item_status <> 'done' THEN RAISE EXCEPTION 'Chỉ yêu cầu làm lại sản phẩm đã hoàn thành'; END IF;

  UPDATE public.fs_item_photos
    SET status = 'redo', resubmit_note = p_note
    WHERE item_id = p_item_id AND box_key = p_box_key;

  UPDATE public.fs_session_items
    SET status = 'redo', resubmit_note = p_note
    WHERE id = p_item_id;

  INSERT INTO public.fs_item_events (session_id, item_id, box_key, event_type, note, actor)
    VALUES (v_session, p_item_id, p_box_key, 'box_resubmit_requested', p_note, p_actor);
END;
$$;

-- Complete or cancel a session. 'completed' requires ACTIVE + every item 'done'
-- (nothing pending/redo) — this is the sign-off. 'cancelled' only needs ACTIVE.
CREATE OR REPLACE FUNCTION public.rpc_fs_close_session(
  p_session_id uuid, p_status text, p_actor uuid, p_note text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Trạng thái đóng phiên không hợp lệ';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.fs_sessions WHERE id = p_session_id AND status = 'active') THEN
    RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý';
  END IF;

  IF p_status = 'completed'
     AND EXISTS (SELECT 1 FROM public.fs_session_items WHERE session_id = p_session_id AND status <> 'done') THEN
    RAISE EXCEPTION 'Chỉ chốt phiên khi tất cả sản phẩm đã hoàn thành';
  END IF;

  UPDATE public.fs_sessions
    SET status = p_status, closed_at = now()
    WHERE id = p_session_id AND status = 'active';

  INSERT INTO public.fs_item_events (session_id, event_type, note, actor)
    VALUES (p_session_id,
            CASE WHEN p_status = 'completed' THEN 'session_completed' ELSE 'session_cancelled' END,
            p_note, p_actor);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_fs_resubmit_items(uuid, uuid[], text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_resubmit_box(uuid, int, text, uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_close_session(uuid, text, uuid, text)     TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('078', 'fs_review_rpcs',
        'FS F3 (r1): rpc_fs_resubmit_items/box + rpc_fs_close_session. DB-guarded: resubmit only done items of an active session (count-mismatch RAISE); completed requires active + all items done. SECDEF service_role, log fs_item_events.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT proname, prosecdef FROM pg_proc WHERE proname LIKE 'rpc_fs_%' ORDER BY 1;
-- SELECT version FROM public.app_migrations WHERE version='078';
