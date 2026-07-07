-- ============================================================================
-- 077_fs_create_session_rpc.sql
-- FS module — F2 (Tạo phiên). Atomic session creation.
--
-- rpc_create_fs_session: in ONE transaction insert the session + all its items +
-- the import-run audit row + a session_created event. If any step fails (e.g. the
-- ensure_fs_session_store_is_fs trigger rejects a non-FS store, or a duplicate
-- product violates UNIQUE(session_id, product_id)), the whole thing rolls back —
-- no partial session. Mirrors the proven rpc_replace_campaign_targets posture.
--
-- Items are pre-validated + de-duplicated in the app parser (lib/fs/import.ts);
-- this RPC trusts the caller (service-role only) and re-derives counts from the
-- payload. Additive + idempotent (CREATE OR REPLACE). Records app_migrations '077'.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_create_fs_session(
  p_store_id   uuid,
  p_name       text,
  p_created_by uuid,
  p_items      jsonb,   -- [{"product_id":"2005946","product_name":"..."}]
  p_file_name  text,
  p_sheet_name text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id uuid;
  v_total      int := COALESCE(jsonb_array_length(p_items), 0);
  v_inserted   int;
BEGIN
  IF v_total = 0 THEN
    RAISE EXCEPTION 'Phiên phải có ít nhất 1 sản phẩm';
  END IF;

  -- BEFORE trigger ensure_fs_session_store_is_fs validates store_type='fs'+active.
  INSERT INTO public.fs_sessions (name, store_id, created_by, status)
  VALUES (p_name, p_store_id, p_created_by, 'active')
  RETURNING id INTO v_session_id;

  INSERT INTO public.fs_session_items (session_id, product_id, product_name)
  SELECT v_session_id, (elem->>'product_id')::text, (elem->>'product_name')::text
  FROM jsonb_array_elements(p_items) elem;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  INSERT INTO public.fs_import_runs
    (session_id, store_id, file_name, sheet_name, row_count, success_count, error_count, uploaded_by)
  VALUES
    (v_session_id, p_store_id, p_file_name, p_sheet_name, v_total, v_inserted, v_total - v_inserted, p_created_by);

  INSERT INTO public.fs_item_events (session_id, event_type, note, actor)
  VALUES (v_session_id, 'session_created',
          COALESCE(p_sheet_name, '') || ' · ' || v_inserted || ' sản phẩm', p_created_by);

  RETURN v_session_id;
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.rpc_create_fs_session(uuid, text, uuid, jsonb, text, text) TO service_role;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('077', 'fs_create_session_rpc',
        'FS F2: rpc_create_fs_session (SECDEF, service_role) — atomic session + items + import_run + session_created event; rolls back on FS-store trigger reject or duplicate product.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify:
-- SELECT proname, prosecdef FROM pg_proc WHERE proname='rpc_create_fs_session';
-- SELECT version FROM public.app_migrations WHERE version='077';
