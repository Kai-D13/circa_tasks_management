-- ============================================================================
-- 081_fs_staff_only_claim.sql
-- FS module — F5. Two changes:
--  1) rpc_fs_claim_session is now STAFF-only (role='staff' of the FS store). The
--     stakeholder provisions FS staff accounts directly; store_manager is not an
--     operator of this module. (uploads + page gates tighten in the app layer.)
--  2) rpc_fs_release_claim_self — a staff who claimed a list can hand it back so
--     it doesn't stay stuck if they step away (race-safe: only the holder releases).
--
-- SECDEF/service_role; logs fs_item_events. Idempotent. Records '081'.
-- ============================================================================

BEGIN;

-- 1) Claim: staff of the FS store only (was staff OR store_manager in 079).
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
    WHERE u.id = p_user_id AND u.store_id = v_store AND u.role = 'staff'
  ) THEN
    RAISE EXCEPTION 'Chỉ nhân viên (staff) của cửa hàng FS mới được xử lý';
  END IF;

  IF v_claimed IS NOT NULL AND v_claimed <> p_user_id THEN
    RAISE EXCEPTION 'Phiên đang được xử lý bởi người khác';
  END IF;

  IF v_claimed IS NULL THEN
    UPDATE public.fs_sessions SET claimed_by = p_user_id, claimed_at = now()
      WHERE id = p_session_id AND claimed_by IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Phiên vừa được người khác nhận'; END IF;
    INSERT INTO public.fs_item_events (session_id, event_type, actor)
      VALUES (p_session_id, 'session_claimed', p_user_id);
  END IF;
END;
$$;

-- 2) Staff self-release (hand over). Only the current holder can release — the
-- race-safe WHERE claimed_by=p_user_id means a stale client can't release someone
-- else's claim.
CREATE OR REPLACE FUNCTION public.rpc_fs_release_claim_self(p_session_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.fs_sessions SET claimed_by = NULL, claimed_at = NULL
    WHERE id = p_session_id AND status = 'active' AND claimed_by = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bạn không phải người đang xử lý phiên này'; END IF;
  INSERT INTO public.fs_item_events (session_id, event_type, note, actor)
    VALUES (p_session_id, 'session_released', 'staff_self_release', p_user_id);
END;
$$;

-- 3) Admin/Policy force-release now stamps a note so the audit distinguishes it
-- from a staff self-release (signature unchanged).
CREATE OR REPLACE FUNCTION public.rpc_fs_release_claim(p_session_id uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.fs_sessions SET claimed_by = NULL, claimed_at = NULL
    WHERE id = p_session_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiên không ở trạng thái đang xử lý'; END IF;
  INSERT INTO public.fs_item_events (session_id, event_type, note, actor)
    VALUES (p_session_id, 'session_released', 'released_by_manager', p_actor);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_fs_claim_session(uuid, uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_release_claim(uuid, uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fs_release_claim_self(uuid, uuid)  TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('081', 'fs_staff_only_claim',
        'FS F5: rpc_fs_claim_session STAFF-only (was staff+store_manager); rpc_fs_release_claim_self (holder hands over, race-safe). SECDEF service_role, log fs_item_events.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT proname FROM pg_proc WHERE proname IN ('rpc_fs_claim_session','rpc_fs_release_claim_self') ORDER BY 1;
-- SELECT version FROM public.app_migrations WHERE version='081';
