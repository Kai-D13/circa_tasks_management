-- ============================================================================
-- 080_fs_self_edit_done.sql
-- FS module — F4 r4. Let the CLAIMER self-correct a 'done' item without waiting
-- for an admin resubmit (stakeholder request 2026-07-08). This intentionally
-- REVERSES the r1 rule that made 'done' read-only for staff: the staff who
-- notices they shot the wrong product can re-open the item, fix photos/dims, and
-- re-submit → 'done'. Still claimer-only, active-session-only, box 1+2 required,
-- dims required, and no 'redo' box may be left un-reshot.
--
-- Only rpc_fs_submit_item changes (CREATE OR REPLACE). Idempotent. Records '080'.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_fs_submit_item(
  p_item_id  uuid,
  p_user_id  uuid,
  p_length   int,
  p_width    int,
  p_height   int,
  p_photos   jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_session uuid; v_sess_status text; v_claimed uuid; v_item_status text;
BEGIN
  SELECT i.session_id, s.status, s.claimed_by, i.status
    INTO v_session, v_sess_status, v_claimed, v_item_status
    FROM public.fs_session_items i JOIN public.fs_sessions s ON s.id = i.session_id
    WHERE i.id = p_item_id;
  IF v_session IS NULL THEN RAISE EXCEPTION 'Sản phẩm không tồn tại'; END IF;
  IF v_sess_status <> 'active' THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;
  IF v_claimed IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'Bạn chưa nhận phiên này'; END IF;
  -- pending/redo = normal processing; done = staff self-correction (r4). All are
  -- claimer-editable while the session is active.
  IF v_item_status NOT IN ('pending', 'redo', 'done') THEN
    RAISE EXCEPTION 'Trạng thái sản phẩm không hợp lệ';
  END IF;

  IF p_length IS NULL OR p_width IS NULL OR p_height IS NULL
     OR p_length <= 0 OR p_width <= 0 OR p_height <= 0
     OR p_length > 3000 OR p_width > 3000 OR p_height > 3000 THEN
    RAISE EXCEPTION 'Kích thước không hợp lệ (mm, > 0 và ≤ 3000)';
  END IF;

  INSERT INTO public.fs_item_photos (item_id, box_key, storage_path, status, uploaded_by, content_type, size_bytes, updated_at)
  SELECT p_item_id, (e->>'box_key')::int, e->>'storage_path', 'ok', p_user_id,
         e->>'content_type', NULLIF(e->>'size_bytes','')::bigint, now()
  FROM jsonb_array_elements(COALESCE(p_photos, '[]'::jsonb)) e
  ON CONFLICT (item_id, box_key) DO UPDATE
    SET storage_path = EXCLUDED.storage_path, status = 'ok', uploaded_by = EXCLUDED.uploaded_by,
        content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes, resubmit_note = NULL, updated_at = now();

  IF (SELECT count(*) FROM public.fs_item_photos WHERE item_id = p_item_id AND box_key IN (1, 2)) < 2 THEN
    RAISE EXCEPTION 'Cần đủ ảnh Mặt trước và Mặt sau';
  END IF;

  IF EXISTS (SELECT 1 FROM public.fs_item_photos WHERE item_id = p_item_id AND status = 'redo') THEN
    RAISE EXCEPTION 'Còn box ảnh bị yêu cầu chụp lại — vui lòng tải lại ảnh cho các box đó';
  END IF;

  UPDATE public.fs_session_items
    SET status = 'done', dim_length_mm = p_length, dim_width_mm = p_width, dim_height_mm = p_height,
        processed_by = p_user_id, processed_at = now(), resubmit_note = NULL
    WHERE id = p_item_id;

  INSERT INTO public.fs_item_events (session_id, item_id, event_type, actor)
    VALUES (v_session, p_item_id, 'item_submitted', p_user_id);
  INSERT INTO public.fs_item_events (session_id, item_id, box_key, event_type, actor)
    SELECT v_session, p_item_id, (e->>'box_key')::int, 'box_reuploaded', p_user_id
    FROM jsonb_array_elements(COALESCE(p_photos, '[]'::jsonb)) e;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_fs_submit_item(uuid, uuid, int, int, int, jsonb) TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('080', 'fs_self_edit_done',
        'FS F4 r4: rpc_fs_submit_item now accepts a done item (claimer self-correction) — reverses r1 done-read-only. Still claimer/active-only, box 1+2 + dims required, no redo box left.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT prosrc LIKE '%pending%redo%done%' FROM pg_proc WHERE proname='rpc_fs_submit_item';
-- SELECT version FROM public.app_migrations WHERE version='080';
