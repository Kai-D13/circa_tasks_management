-- ============================================================================
-- 079_fs_staff_processing.sql
-- FS module — F4 (staff wizard). Claim mutex + atomic item submit, DB-guarded.
-- All SECURITY DEFINER (service_role); each logs fs_item_events. The event-type
-- CHECK (mig 076) already allows session_claimed/session_released/item_submitted/
-- box_reuploaded. pg_safeupdate-safe. Records '079'.
--
--  rpc_fs_claim_session  — race-safe claim: one staff/store_manager of the FS
--    store owns an ACTIVE session at a time (conditional UPDATE WHERE claimed_by
--    IS NULL). Re-claim by the same user is a no-op OK.
--  rpc_fs_release_claim  — Policy/super release (authz in the action).
--  rpc_fs_submit_item    — the claimer submits an item: upsert its box photos,
--    require box 1+2 present, dims (mm, 0<x<=3000) required, item → 'done'.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_fs_claim_session(p_session_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_claimed uuid; v_status text; v_store uuid;
BEGIN
  SELECT claimed_by, status, store_id INTO v_claimed, v_status, v_store
    FROM public.fs_sessions WHERE id = p_session_id;
  IF v_store IS NULL THEN RAISE EXCEPTION 'Phiên không tồn tại'; END IF;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_user_id AND u.store_id = v_store AND u.role IN ('staff', 'store_manager')
  ) THEN
    RAISE EXCEPTION 'Bạn không thuộc cửa hàng của phiên này';
  END IF;

  IF v_claimed IS NOT NULL AND v_claimed <> p_user_id THEN
    RAISE EXCEPTION 'Phiên đang được xử lý bởi người khác';
  END IF;

  IF v_claimed IS NULL THEN
    -- Race-safe mutex: only the writer who flips NULL→user wins.
    UPDATE public.fs_sessions SET claimed_by = p_user_id, claimed_at = now()
      WHERE id = p_session_id AND claimed_by IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Phiên vừa được người khác nhận'; END IF;
    INSERT INTO public.fs_item_events (session_id, event_type, actor)
      VALUES (p_session_id, 'session_claimed', p_user_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_fs_release_claim(p_session_id uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.fs_sessions SET claimed_by = NULL, claimed_at = NULL
    WHERE id = p_session_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;
  INSERT INTO public.fs_item_events (session_id, event_type, actor)
    VALUES (p_session_id, 'session_released', p_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_fs_submit_item(
  p_item_id  uuid,
  p_user_id  uuid,
  p_length   int,
  p_width    int,
  p_height   int,
  p_photos   jsonb   -- [{"box_key":1,"storage_path":"https://...","content_type":"image/jpeg","size_bytes":123}]
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_session uuid; v_sess_status text; v_claimed uuid;
BEGIN
  SELECT i.session_id, s.status, s.claimed_by
    INTO v_session, v_sess_status, v_claimed
    FROM public.fs_session_items i JOIN public.fs_sessions s ON s.id = i.session_id
    WHERE i.id = p_item_id;
  IF v_session IS NULL THEN RAISE EXCEPTION 'Sản phẩm không tồn tại'; END IF;
  IF v_sess_status <> 'active' THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;
  IF v_claimed IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'Bạn chưa nhận phiên này'; END IF;

  IF p_length IS NULL OR p_width IS NULL OR p_height IS NULL
     OR p_length <= 0 OR p_width <= 0 OR p_height <= 0
     OR p_length > 3000 OR p_width > 3000 OR p_height > 3000 THEN
    RAISE EXCEPTION 'Kích thước không hợp lệ (mm, > 0 và ≤ 3000)';
  END IF;

  -- Upsert the provided box photos (last-version-only via UNIQUE(item_id,box_key)).
  -- An out-of-range box_key fails the table CHECK (1..5) → rollback.
  INSERT INTO public.fs_item_photos (item_id, box_key, storage_path, status, uploaded_by, content_type, size_bytes, updated_at)
  SELECT p_item_id, (e->>'box_key')::int, e->>'storage_path', 'ok', p_user_id,
         e->>'content_type', NULLIF(e->>'size_bytes','')::bigint, now()
  FROM jsonb_array_elements(COALESCE(p_photos, '[]'::jsonb)) e
  ON CONFLICT (item_id, box_key) DO UPDATE
    SET storage_path = EXCLUDED.storage_path, status = 'ok', uploaded_by = EXCLUDED.uploaded_by,
        content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes, resubmit_note = NULL, updated_at = now();

  -- Box 1 (mặt trước) + box 2 (mặt sau) are mandatory (after this upsert).
  IF (SELECT count(*) FROM public.fs_item_photos WHERE item_id = p_item_id AND box_key IN (1, 2)) < 2 THEN
    RAISE EXCEPTION 'Cần đủ ảnh Mặt trước và Mặt sau';
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

GRANT EXECUTE ON FUNCTION public.rpc_fs_claim_session(uuid, uuid)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_release_claim(uuid, uuid)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_submit_item(uuid, uuid, int, int, int, jsonb) TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('079', 'fs_staff_processing',
        'FS F4: rpc_fs_claim_session (race-safe mutex, store staff/mgr only), rpc_fs_release_claim (Policy/super), rpc_fs_submit_item (claimer only, upsert box photos, box 1+2 required, dims mm required, item→done). SECDEF service_role, log fs_item_events.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT proname FROM pg_proc WHERE proname IN ('rpc_fs_claim_session','rpc_fs_release_claim','rpc_fs_submit_item') ORDER BY 1;
-- SELECT version FROM public.app_migrations WHERE version='079';
