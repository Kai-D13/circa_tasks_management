-- ============================================================================
-- 082_fs_item_actions.sql
-- FS module — Batch A. Policy/super can REMOVE an item from a session (product
-- sold out → no stock to photograph) and EDIT it; both are audited.
--
-- Soft-remove (never hard-delete) preserves audit + export/history integrity.
-- A removed item (removed_at IS NOT NULL) is hidden from the staff queue, the
-- progress/close math, and the default export — the app adds `removed_at IS NULL`
-- at every count/list/export site; here we only fix rpc_fs_close_session so a
-- removed 'pending' item can't block completion.
--
-- Edit scope (stakeholder): product_name anytime; product_id ONLY when the item
-- is 'pending' and has no photos (else the GCS filename / export would drift).
--
-- Additive + idempotent. Records app_migrations '082'.
-- ============================================================================

BEGIN;

-- ── 1. Soft-remove columns ───────────────────────────────────────────────────
ALTER TABLE public.fs_session_items
  ADD COLUMN IF NOT EXISTS removed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by     uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS removed_reason text;
-- Hot path: "active (non-removed) items of a session".
CREATE INDEX IF NOT EXISTS idx_fsi_session_active
  ON public.fs_session_items (session_id) WHERE removed_at IS NULL;

-- ── 2. Audit event types: + item_removed / item_edited ───────────────────────
ALTER TABLE public.fs_item_events DROP CONSTRAINT IF EXISTS fs_item_events_event_type_check;
ALTER TABLE public.fs_item_events ADD CONSTRAINT fs_item_events_event_type_check CHECK (event_type IN (
  'session_created','session_claimed','session_released','session_completed','session_cancelled',
  'item_submitted','item_resubmit_requested','box_resubmit_requested','box_reuploaded',
  'gcs_delete_failed','item_removed','item_edited'
));

-- ── 3. Remove an item (soft) ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_fs_remove_item(
  p_session_id uuid, p_item_id uuid, p_reason text, p_actor uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.fs_session_items i
    SET removed_at = now(), removed_by = p_actor, removed_reason = p_reason
    FROM public.fs_sessions s
    WHERE i.id = p_item_id AND i.session_id = p_session_id AND i.session_id = s.id
      AND i.removed_at IS NULL AND s.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không xoá được sản phẩm (không tồn tại / đã xoá / phiên không đang xử lý)';
  END IF;
  INSERT INTO public.fs_item_events (session_id, item_id, event_type, note, actor)
    VALUES (p_session_id, p_item_id, 'item_removed', p_reason, p_actor);
END;
$$;

-- ── 4. Edit an item ──────────────────────────────────────────────────────────
-- product_name always; product_id only when pending + no photos + unique in the
-- session. A requested product_id change that isn't allowed → RAISE (never a
-- silent no-op that would confuse the admin).
CREATE OR REPLACE FUNCTION public.rpc_fs_update_item(
  p_item_id uuid, p_product_name text, p_product_id text, p_actor uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_session uuid; v_status text; v_cur_pid text; v_has_photo boolean; v_removed timestamptz;
BEGIN
  SELECT session_id, status, product_id, removed_at INTO v_session, v_status, v_cur_pid, v_removed
    FROM public.fs_session_items WHERE id = p_item_id;
  IF v_session IS NULL THEN RAISE EXCEPTION 'Sản phẩm không tồn tại'; END IF;
  IF v_removed IS NOT NULL THEN RAISE EXCEPTION 'Sản phẩm đã bị xoá khỏi phiên'; END IF;
  IF p_product_name IS NULL OR btrim(p_product_name) = '' THEN RAISE EXCEPTION 'Tên sản phẩm không được trống'; END IF;

  -- product_id change requested?
  IF p_product_id IS NOT NULL AND p_product_id <> v_cur_pid THEN
    IF v_status <> 'pending' THEN
      RAISE EXCEPTION 'Chỉ sửa được mã sản phẩm khi chưa xử lý (pending)';
    END IF;
    SELECT EXISTS (SELECT 1 FROM public.fs_item_photos WHERE item_id = p_item_id) INTO v_has_photo;
    IF v_has_photo THEN RAISE EXCEPTION 'Không sửa mã khi sản phẩm đã có ảnh'; END IF;
    IF p_product_id !~ '^[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION 'Mã sản phẩm không hợp lệ'; END IF;
    IF EXISTS (SELECT 1 FROM public.fs_session_items
               WHERE session_id = v_session AND product_id = p_product_id AND id <> p_item_id) THEN
      RAISE EXCEPTION 'Mã sản phẩm đã tồn tại trong phiên';
    END IF;
    UPDATE public.fs_session_items SET product_id = p_product_id, product_name = btrim(p_product_name)
      WHERE id = p_item_id;
  ELSE
    UPDATE public.fs_session_items SET product_name = btrim(p_product_name) WHERE id = p_item_id;
  END IF;

  INSERT INTO public.fs_item_events (session_id, item_id, event_type, note, actor)
    VALUES (v_session, p_item_id, 'item_edited', btrim(p_product_name), p_actor);
END;
$$;

-- ── 5. Close-session must ignore removed items ───────────────────────────────
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
  -- Only ACTIVE (non-removed) items must all be done.
  IF p_status = 'completed'
     AND EXISTS (SELECT 1 FROM public.fs_session_items
                 WHERE session_id = p_session_id AND removed_at IS NULL AND status <> 'done') THEN
    RAISE EXCEPTION 'Chỉ chốt phiên khi tất cả sản phẩm đã hoàn thành';
  END IF;
  UPDATE public.fs_sessions SET status = p_status, closed_at = now() WHERE id = p_session_id AND status = 'active';
  INSERT INTO public.fs_item_events (session_id, event_type, note, actor)
    VALUES (p_session_id,
            CASE WHEN p_status = 'completed' THEN 'session_completed' ELSE 'session_cancelled' END,
            p_note, p_actor);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_fs_remove_item(uuid, uuid, text, uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_update_item(uuid, text, text, uuid)         TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_close_session(uuid, text, uuid, text)       TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('082', 'fs_item_actions',
        'FS Batch A: fs_session_items soft-remove (removed_at/by/reason) + item_removed/item_edited events; rpc_fs_remove_item, rpc_fs_update_item (name anytime, product_id only pending+photoless+unique); rpc_fs_close_session ignores removed items. App adds removed_at IS NULL at all count/list/export sites.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT column_name FROM information_schema.columns WHERE table_name='fs_session_items' AND column_name LIKE 'removed%';
-- SELECT proname FROM pg_proc WHERE proname IN ('rpc_fs_remove_item','rpc_fs_update_item') ORDER BY 1;
-- SELECT version FROM public.app_migrations WHERE version='082';
