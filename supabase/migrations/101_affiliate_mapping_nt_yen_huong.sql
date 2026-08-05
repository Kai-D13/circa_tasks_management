-- ============================================================================
-- 101_affiliate_mapping_nt_yen_huong.sql
-- Edge case 05/08: cron pull-affiliate-orders báo unmatched_codes
-- ['NT-YEN-HUONG'] → health gate FAIL-CLOSED ẩn toàn bộ màn Affiliate (đúng
-- thiết kế — mã mới không được attribution bừa). Hiện trạng verify 05/08:
-- đúng 1 đơn (DH024796, CANCELED, chưa DELIVERED) → CHƯA có GMV/thiệt hại số.
--
-- Phân loại chốt (stakeholder + Circa Online 05/08): NT-YEN-HUONG = ĐỐI TÁC
-- NGOÀI (external) — store_id NULL, không thuộc store Circa nào; prefix NT-*
-- cùng nhóm external trong manifest gốc (153/23). Hệ quả: cron hết unmatched
-- → health READY trở lại; đơn external KHÔNG vào campaign OS/overview
-- (overview chỉ hiện mapping os/fs có store_id — external chỉ super đối soát
-- qua SQL khi cần).
--
-- ⚠ STOP-CONDITION: nếu sau này Circa Online đính chính đây là CỬA HÀNG
-- Circa (OS/FS) → KHÔNG dùng migration này; cần POS code + preflight
-- store_type/is_active theo contract migration 094.
--
-- Idempotent: re-run = no-op khi mapping đã đúng (external/NULL/active);
-- mapping tồn tại với giá trị KHÁC → RAISE (không âm thầm ghi đè).
--
-- ROLLBACK:
--   DELETE FROM public.affiliate_partner_mappings
--     WHERE partner_code = 'NT-YEN-HUONG' AND partner_type = 'external';
--   DELETE FROM public.app_migrations WHERE version = '101';
--   (Cron run kế sẽ báo unmatched trở lại — trạng thái trước migration.)
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_store  uuid;
  v_type   text;
  v_active boolean;
BEGIN
  -- Preflight nền: bảng mapping phải từ 090.
  IF (SELECT count(*) FROM public.app_migrations WHERE version = '090') <> 1 THEN
    RAISE EXCEPTION '101: thiếu migration nền 090 (affiliate_partner_mappings)';
  END IF;

  SELECT store_id, partner_type, is_active
  INTO v_store, v_type, v_active
  FROM public.affiliate_partner_mappings
  WHERE partner_code = 'NT-YEN-HUONG';

  IF NOT FOUND THEN
    INSERT INTO public.affiliate_partner_mappings
      (partner_code, store_id, partner_type, display_name, is_active)
    VALUES
      ('NT-YEN-HUONG', NULL, 'external',
       'Đối tác ngoài: NT-YEN-HUONG', true);
  ELSIF v_store IS NULL AND v_type = 'external' AND v_active IS TRUE THEN
    NULL; -- đã đúng trạng thái mong muốn — no-op (idempotent)
  ELSE
    RAISE EXCEPTION
      '101: NT-YEN-HUONG đã tồn tại với mapping bất ngờ: store=%, type=%, active=% — kiểm tra tay, không ghi đè',
      v_store, v_type, v_active;
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('101', 'affiliate_mapping_nt_yen_huong',
        'Phân loại NT-YEN-HUONG = external (đối tác ngoài, store_id NULL) theo xác nhận Circa Online 05/08 — đóng unmatched_codes để health gate READY trở lại. 1 đơn hiện hữu (DH024796 CANCELED) chưa có GMV. Nếu đính chính là store Circa: rollback + mapping lại theo contract 094 với POS code.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy sau migration):
-- 1) Mapping đúng external/NULL/active:
--    SELECT m.partner_code, m.partner_type, m.store_id, s.code, s.store_type, m.is_active
--    FROM public.affiliate_partner_mappings m
--    LEFT JOIN public.stores s ON s.id = m.store_id
--    WHERE m.partner_code = 'NT-YEN-HUONG';
--    -- KỲ VỌNG: partner_type='external', store_id NULL, is_active=true
-- 2) SELECT version, name FROM public.app_migrations WHERE version = '101';  -- 1 row
-- 3) Execute Now cron pull-affiliate-orders → response phải có:
--    unmatched_codes=[] · inactive_codes=[] · unknown_statuses=[] · rejected=0
-- 4) Reload /targets/campaigns/affiliate → số liệu hiện trở lại (health READY).
-- 5) Execute Now sync-kpi-campaign-actuals → campaign hybrid cập nhật snapshot
--    Affiliate bình thường (không preserved).
-- ============================================================================
