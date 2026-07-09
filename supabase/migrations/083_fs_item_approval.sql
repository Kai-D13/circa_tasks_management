-- ============================================================================
-- 083_fs_item_approval.sql
-- FS module — Batch E. Adds an Admin-Policy REVIEW layer ("Đã duyệt") on top of
-- the staff processing status, so one admin's approval means others needn't re-check.
--
-- Model (stakeholder-confirmed): keep status = pending|done|redo (staff progress);
-- add approved_at/approved_by (admin review). An item is "approved" when
-- status='done' AND approved_at IS NOT NULL. Flow: staff → done; admin tick "Đã
-- duyệt"; resubmit un-approves (→ redo); an approved item is LOCKED (staff can't
-- self-edit); "Chốt phiên" requires every active item done AND approved.
--
-- 076-082 already applied → CREATE OR REPLACE the four touched RPCs faithfully
-- (reproduced from 078/080/082) with the approval additions. Idempotent. '083'.
-- ============================================================================

BEGIN;

-- 1) Columns + audit event -----------------------------------------------------
ALTER TABLE public.fs_session_items
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.users(id);

ALTER TABLE public.fs_item_events DROP CONSTRAINT IF EXISTS fs_item_events_event_type_check;
ALTER TABLE public.fs_item_events ADD CONSTRAINT fs_item_events_event_type_check CHECK (event_type IN (
  'session_created','session_claimed','session_released','session_completed','session_cancelled',
  'item_submitted','item_resubmit_requested','box_resubmit_requested','box_reuploaded',
  'gcs_delete_failed','item_removed','item_edited','item_approved'
));

-- 2) Approve an item (Policy/super) --------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_fs_approve_item(p_item_id uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_session uuid;
BEGIN
  UPDATE public.fs_session_items i
    SET approved_at = now(), approved_by = p_actor
    FROM public.fs_sessions s
    WHERE i.id = p_item_id AND i.session_id = s.id
      AND s.status = 'active' AND i.removed_at IS NULL
      AND i.status = 'done' AND i.approved_at IS NULL
    RETURNING i.session_id INTO v_session;
  IF v_session IS NULL THEN
    RAISE EXCEPTION 'Không duyệt được (sản phẩm chưa hoàn thành / đã duyệt / đã xoá / phiên không đang xử lý)';
  END IF;
  INSERT INTO public.fs_item_events (session_id, item_id, event_type, actor)
    VALUES (v_session, p_item_id, 'item_approved', p_actor);
END;
$$;

-- 3) Submit item — reproduce 080 + block an APPROVED (or removed) item ----------
CREATE OR REPLACE FUNCTION public.rpc_fs_submit_item(
  p_item_id uuid, p_user_id uuid, p_length int, p_width int, p_height int, p_photos jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_session uuid; v_sess_status text; v_claimed uuid; v_item_status text;
        v_approved timestamptz; v_removed timestamptz;
BEGIN
  SELECT i.session_id, s.status, s.claimed_by, i.status, i.approved_at, i.removed_at
    INTO v_session, v_sess_status, v_claimed, v_item_status, v_approved, v_removed
    FROM public.fs_session_items i JOIN public.fs_sessions s ON s.id = i.session_id
    WHERE i.id = p_item_id;
  IF v_session IS NULL THEN RAISE EXCEPTION 'Sản phẩm không tồn tại'; END IF;
  IF v_sess_status <> 'active' THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;
  IF v_claimed IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'Bạn chưa nhận phiên này'; END IF;
  IF v_removed IS NOT NULL THEN RAISE EXCEPTION 'Sản phẩm đã bị xoá khỏi phiên'; END IF;
  IF v_approved IS NOT NULL THEN RAISE EXCEPTION 'Sản phẩm đã được duyệt — cần admin yêu cầu làm lại mới sửa được'; END IF;
  IF v_item_status NOT IN ('pending', 'redo', 'done') THEN RAISE EXCEPTION 'Trạng thái sản phẩm không hợp lệ'; END IF;

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

-- 4) Resubmit (items + box) — reproduce 078 + CLEAR approval on send-back +
--    block a soft-removed item at the DB boundary (removed items keep status='done',
--    so without this guard a removed id passed in could be resurrected to 'redo').
CREATE OR REPLACE FUNCTION public.rpc_fs_resubmit_items(
  p_session_id uuid, p_item_ids uuid[], p_note text, p_actor uuid
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_req int := COALESCE(array_length(p_item_ids, 1), 0); v_n int; v_active boolean;
BEGIN
  IF v_req = 0 THEN RETURN 0; END IF;
  SELECT (status = 'active') INTO v_active FROM public.fs_sessions WHERE id = p_session_id;
  IF v_active IS NULL THEN RAISE EXCEPTION 'Phiên không tồn tại'; END IF;
  IF NOT v_active THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;

  UPDATE public.fs_session_items
    SET status = 'redo', resubmit_note = p_note, approved_at = NULL, approved_by = NULL
    WHERE session_id = p_session_id AND id = ANY(p_item_ids) AND status = 'done' AND removed_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_req THEN
    RAISE EXCEPTION 'Có % sản phẩm không hợp lệ để làm lại (không thuộc phiên / chưa hoàn thành / đã xoá / trùng)', v_req - v_n;
  END IF;

  UPDATE public.fs_item_photos SET status = 'redo' WHERE item_id = ANY(p_item_ids);
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
DECLARE v_session uuid; v_item_status text; v_sess_status text; v_removed timestamptz;
BEGIN
  IF p_box_key < 1 OR p_box_key > 5 THEN RAISE EXCEPTION 'Box ảnh không hợp lệ (1..5)'; END IF;
  SELECT i.session_id, i.status, s.status, i.removed_at INTO v_session, v_item_status, v_sess_status, v_removed
    FROM public.fs_session_items i JOIN public.fs_sessions s ON s.id = i.session_id WHERE i.id = p_item_id;
  IF v_session IS NULL THEN RAISE EXCEPTION 'Sản phẩm không tồn tại'; END IF;
  IF v_sess_status <> 'active' THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;
  IF v_removed IS NOT NULL THEN RAISE EXCEPTION 'Sản phẩm đã bị xoá khỏi phiên'; END IF;
  IF v_item_status <> 'done' THEN RAISE EXCEPTION 'Chỉ yêu cầu làm lại sản phẩm đã hoàn thành'; END IF;

  UPDATE public.fs_item_photos SET status = 'redo', resubmit_note = p_note
    WHERE item_id = p_item_id AND box_key = p_box_key;
  UPDATE public.fs_session_items SET status = 'redo', resubmit_note = p_note, approved_at = NULL, approved_by = NULL
    WHERE id = p_item_id;
  INSERT INTO public.fs_item_events (session_id, item_id, box_key, event_type, note, actor)
    VALUES (v_session, p_item_id, p_box_key, 'box_resubmit_requested', p_note, p_actor);
END;
$$;

-- 5) Close session — reproduce 082 + require every active item APPROVED ----------
CREATE OR REPLACE FUNCTION public.rpc_fs_close_session(
  p_session_id uuid, p_status text, p_actor uuid, p_note text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'Trạng thái đóng phiên không hợp lệ'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fs_sessions WHERE id = p_session_id AND status = 'active') THEN
    RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý';
  END IF;
  IF p_status = 'completed' THEN
    IF NOT EXISTS (SELECT 1 FROM public.fs_session_items WHERE session_id = p_session_id AND removed_at IS NULL) THEN
      RAISE EXCEPTION 'Phiên không còn sản phẩm nào để chốt';
    END IF;
    IF EXISTS (SELECT 1 FROM public.fs_session_items
               WHERE session_id = p_session_id AND removed_at IS NULL AND status <> 'done') THEN
      RAISE EXCEPTION 'Chỉ chốt phiên khi tất cả sản phẩm đã hoàn thành';
    END IF;
    IF EXISTS (SELECT 1 FROM public.fs_session_items
               WHERE session_id = p_session_id AND removed_at IS NULL AND approved_at IS NULL) THEN
      RAISE EXCEPTION 'Chỉ chốt phiên khi tất cả sản phẩm đã được duyệt';
    END IF;
  END IF;
  UPDATE public.fs_sessions SET status = p_status, closed_at = now() WHERE id = p_session_id AND status = 'active';
  INSERT INTO public.fs_item_events (session_id, event_type, note, actor)
    VALUES (p_session_id, CASE WHEN p_status = 'completed' THEN 'session_completed' ELSE 'session_cancelled' END, p_note, p_actor);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_fs_approve_item(uuid, uuid)                              TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_submit_item(uuid, uuid, int, int, int, jsonb)         TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_resubmit_items(uuid, uuid[], text, uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_resubmit_box(uuid, int, text, uuid)                   TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_close_session(uuid, text, uuid, text)                 TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('083', 'fs_item_approval',
        'FS Batch E (r1): fs_session_items.approved_at/by + item_approved event; rpc_fs_approve_item; submit_item blocks approved/removed; resubmit clears approval AND blocks removed items; close_session requires all active done+approved.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT column_name FROM information_schema.columns WHERE table_name='fs_session_items' AND column_name LIKE 'approved%';
-- SELECT proname FROM pg_proc WHERE proname='rpc_fs_approve_item';
-- SELECT version FROM public.app_migrations WHERE version='083';
