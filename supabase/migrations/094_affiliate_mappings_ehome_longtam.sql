-- ============================================================================
-- 094_affiliate_mappings_ehome_longtam.sql
-- ⚠ DRAFT — CHƯA CHẠY cho tới khi stakeholder audit pass. Data-only migration
--   (không đổi schema/function), idempotent, có conflict guard.
--
-- Bối cảnh (audit 23/07 — P1 #2): 2 partner code mới xuất hiện 23/07 được
-- INSERT tạm qua service role sau khi user duyệt; migration này VERSION HÓA
-- để môi trường mới/restore DB tái tạo được đúng trạng thái (DB và source
-- cùng một nguồn sự thật).
--
-- Phân loại (bằng chứng + rule audit):
--   • CIRCA-EHOME  → os POS0079 "CIRCA EHOME" (verify DB os + active).
--   • CIRCA-LONG TAM → fs POS1089 "FS Long Tâm" — SỬA từ 'external' (phân
--     loại tạm 23/07 do tra cứu tên không dấu trượt "Long Tâm"). Bằng chứng
--     Mongo (đọc tối thiểu theo chỉ định audit, KHÔNG lưu system_note): cả 3
--     đơn có PHARMACY_ROUTING storeName "FC Circa – NT Long Tâm – Hà Nội"
--     (partnerID 42, storeID 75 nhất quán) → rule audit: map fs → POS1089.
--     Cả 3 đơn hiện CANCELED → chưa có GMV nào bị phân loại sai.
--   FS mapping (như HOABINH2): chỉ super thấy, KHÔNG vào campaign OS
--   (validation targets OS-active + rpc_activate đã chặn ở 092/093).
--
-- Conflict guard: chỉ sửa mapping external hiện hữu khi ĐÚNG trạng thái dự
-- kiến (external + store_id NULL + active); mọi trạng thái bất ngờ → RAISE,
-- không tự sửa. Re-run khi đã đúng → no-op (idempotent).
-- ROLLBACK: UPDATE CIRCA-LONG TAM về external/store_id NULL; DELETE 2 mapping
-- nếu muốn gỡ hẳn; DELETE app_migrations '094'.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_ehome_store  uuid; v_ehome_type text; v_ehome_active boolean;
  v_lt_store     uuid; v_lt_type    text; v_lt_active    boolean;
  v_ex_store     uuid; v_ex_type    text; v_ex_active    boolean;
BEGIN
  -- ── Preflight stores ──
  SELECT id, store_type, is_active INTO v_ehome_store, v_ehome_type, v_ehome_active
  FROM public.stores WHERE code = 'POS0079';
  IF v_ehome_store IS NULL THEN
    RAISE EXCEPTION '094: store POS0079 (CIRCA EHOME) không tồn tại';
  END IF;
  IF v_ehome_type IS DISTINCT FROM 'os' OR v_ehome_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION '094: POS0079 phải là os + active (hiện: type=%, active=%)', v_ehome_type, v_ehome_active;
  END IF;

  SELECT id, store_type, is_active INTO v_lt_store, v_lt_type, v_lt_active
  FROM public.stores WHERE code = 'POS1089';
  IF v_lt_store IS NULL THEN
    RAISE EXCEPTION '094: store POS1089 (FS Long Tâm) không tồn tại';
  END IF;
  IF v_lt_type IS DISTINCT FROM 'fs' OR v_lt_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION '094: POS1089 phải là fs + active (hiện: type=%, active=%)', v_lt_type, v_lt_active;
  END IF;

  -- ── CIRCA-EHOME → os POS0079 ──
  SELECT store_id, partner_type, is_active INTO v_ex_store, v_ex_type, v_ex_active
  FROM public.affiliate_partner_mappings WHERE partner_code = 'CIRCA-EHOME';
  IF NOT FOUND THEN
    INSERT INTO public.affiliate_partner_mappings (partner_code, store_id, partner_type, display_name)
    VALUES ('CIRCA-EHOME', v_ehome_store, 'os', 'CIRCA EHOME');
  ELSIF v_ex_store IS DISTINCT FROM v_ehome_store OR v_ex_type IS DISTINCT FROM 'os'
        OR v_ex_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION '094: mapping CIRCA-EHOME tồn tại nhưng KHÁC kỳ vọng (store=%, type=%, active=%) — kiểm tra tay, không tự sửa',
      v_ex_store, v_ex_type, v_ex_active;
  END IF; -- đã đúng → no-op

  -- ── CIRCA-LONG TAM → fs POS1089 (sửa từ external tạm nếu đúng trạng thái) ──
  SELECT store_id, partner_type, is_active INTO v_ex_store, v_ex_type, v_ex_active
  FROM public.affiliate_partner_mappings WHERE partner_code = 'CIRCA-LONG TAM';
  IF NOT FOUND THEN
    INSERT INTO public.affiliate_partner_mappings (partner_code, store_id, partner_type, display_name)
    VALUES ('CIRCA-LONG TAM', v_lt_store, 'fs', 'FS Long Tâm');
  ELSIF v_ex_type = 'external' AND v_ex_store IS NULL AND v_ex_active IS TRUE THEN
    -- trạng thái tạm 23/07 (service role insert trước khi phát hiện POS1089)
    UPDATE public.affiliate_partner_mappings
    SET store_id = v_lt_store, partner_type = 'fs', display_name = 'FS Long Tâm'
    WHERE partner_code = 'CIRCA-LONG TAM';
  ELSIF v_ex_store IS NOT DISTINCT FROM v_lt_store AND v_ex_type = 'fs'
        AND v_ex_active IS TRUE THEN
    NULL; -- đã đúng (re-run) → idempotent
  ELSE
    RAISE EXCEPTION '094: mapping CIRCA-LONG TAM ở trạng thái BẤT NGỜ (store=%, type=%, active=%) — kiểm tra tay, không tự sửa',
      v_ex_store, v_ex_type, v_ex_active;
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('094', 'affiliate_mappings_ehome_longtam',
        'Version hóa 2 mapping 23/07: CIRCA-EHOME→POS0079 (os); CIRCA-LONG TAM→POS1089 (fs "FS Long Tâm" — sửa từ external tạm; bằng chứng system_note PHARMACY_ROUTING "FC Circa – NT Long Tâm – Hà Nội" partnerID 42/storeID 75, cả 3 đơn CANCELED nên chưa lệch GMV). Preflight store code/type/active; conflict guard: chỉ sửa external→fs khi đúng trạng thái dự kiến, bất ngờ → RAISE; re-run no-op.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau 094):
-- 1) SELECT m.partner_code, m.partner_type, s.code, s.store_type, m.is_active
--    FROM public.affiliate_partner_mappings m LEFT JOIN public.stores s ON s.id = m.store_id
--    WHERE m.partner_code IN ('CIRCA-EHOME','CIRCA-LONG TAM') ORDER BY 1;
--    -- 2 row: CIRCA-EHOME | os | POS0079 | os | true
--    --        CIRCA-LONG TAM | fs | POS1089 | fs | true
-- 2) SELECT partner_type, count(*) FROM public.affiliate_partner_mappings GROUP BY 1 ORDER BY 1;
--    -- external=7, fs=2, os=17 (tổng 26)
-- 3) SELECT version FROM public.app_migrations WHERE version='094';  -- 1 row
-- 4) Re-sync affiliate (localhost, VPN) → unmatched=[], rejected=0, canary=0,
--    health READY; đơn LONG TAM (CANCELED) resolve store POS1089 nhưng KHÔNG
--    vào KPI (status + fs đều bị lọc).
-- ============================================================================
