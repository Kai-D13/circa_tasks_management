-- ============================================================================
-- 078_fs_review_rpcs.sql
-- FS module — F3 (Kết quả / review). Set-based, atomic, audited actions for
-- Policy/super review of a session. All SECURITY DEFINER (service_role), each
-- writes fs_item_events so the action history survives (photos keep only the
-- last version). pg_safeupdate-safe (every UPDATE has WHERE). Records '078'.
--
--  rpc_fs_resubmit_items — bulk (or single) WHOLE-item resubmit: mark each item
--    'redo' + shared note, mark ALL their photos 'redo', one event per item.
--    ONE set-based UPDATE (no per-row round trips).
--  rpc_fs_resubmit_box   — single box redo (+ item back to 'redo' so it re-enters
--    the staff queue) + note on that box + event.
--  rpc_fs_close_session  — complete/cancel an ACTIVE session (+ event). The
--    076 store-guard trigger only fires on store_id change, so this is unaffected.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_fs_resubmit_items(
  p_session_id uuid, p_item_ids uuid[], p_note text, p_actor uuid
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_n int;
BEGIN
  IF p_item_ids IS NULL OR array_length(p_item_ids, 1) IS NULL THEN RETURN 0; END IF;

  UPDATE public.fs_session_items
    SET status = 'redo', resubmit_note = p_note
    WHERE session_id = p_session_id AND id = ANY(p_item_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Whole-item resubmit → every box of those items needs redo.
  UPDATE public.fs_item_photos
    SET status = 'redo'
    WHERE item_id = ANY(p_item_ids);

  INSERT INTO public.fs_item_events (session_id, item_id, event_type, note, actor)
    SELECT p_session_id, unnest(p_item_ids), 'item_resubmit_requested', p_note, p_actor;

  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_fs_resubmit_box(
  p_item_id uuid, p_box_key int, p_note text, p_actor uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_session uuid;
BEGIN
  SELECT session_id INTO v_session FROM public.fs_session_items WHERE id = p_item_id;
  IF v_session IS NULL THEN RAISE EXCEPTION 'Sản phẩm không tồn tại'; END IF;

  -- Mark the box redo if a photo exists (0 rows before F4 upload = harmless).
  UPDATE public.fs_item_photos
    SET status = 'redo', resubmit_note = p_note
    WHERE item_id = p_item_id AND box_key = p_box_key;

  -- The item re-enters the staff redo queue.
  UPDATE public.fs_session_items
    SET status = 'redo', resubmit_note = p_note
    WHERE id = p_item_id;

  INSERT INTO public.fs_item_events (session_id, item_id, box_key, event_type, note, actor)
    VALUES (v_session, p_item_id, p_box_key, 'box_resubmit_requested', p_note, p_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_fs_close_session(
  p_session_id uuid, p_status text, p_actor uuid, p_note text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Trạng thái đóng phiên không hợp lệ';
  END IF;

  UPDATE public.fs_sessions
    SET status = p_status, closed_at = now()
    WHERE id = p_session_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;

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
        'FS F3: rpc_fs_resubmit_items (bulk whole-item, set-based), rpc_fs_resubmit_box (per-box), rpc_fs_close_session (complete/cancel). SECDEF service_role, each logs fs_item_events.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT proname FROM pg_proc WHERE proname LIKE 'rpc_fs_%' ORDER BY 1;
-- SELECT version FROM public.app_migrations WHERE version='078';
