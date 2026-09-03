-- ============================================================================
-- 111_kpi_campaign_sm_read_ended.sql
-- Chạy SAU 110. Chỉ NỚI QUYỀN ĐỌC cho SM — không cấp quyền ghi nào.
--
-- Stakeholder: SM cần tra cứu chiến dịch ĐÃ KẾT THÚC của vùng mình để đối soát
-- thưởng. Trước đây can_read_kpi_campaign chỉ cho đọc status = 'active'.
--
-- ⚠ ĐIỂM DỄ LÀM SAI: trong 075, `c.status = 'active'` nằm NGOÀI khối OR của các
-- vai trò, tức áp cho TẤT CẢ. Nếu chỉ "thêm nhánh sm" mà không đụng dòng đó thì
-- SM vẫn không đọc được 'ended'; còn nếu nới dòng đó ở mức ngoài thì STAFF và
-- QLCH cũng đọc được 'ended' — vi phạm contract "hai vai trò này không đổi một
-- bit". Vì vậy điều kiện status được CHUYỂN VÀO TỪNG NHÁNH.
--
-- Thay đổi so với 075 (body trích tự động nguyên văn, script tự khẳng định):
--   · staff/store_manager : c.status = 'active'                 (y như cũ)
--   · sm                  : c.status IN ('active','ended')
--                           AND c.archived_at IS NULL           (mới)
--   · c.is_test = false giữ ở mức ngoài ⇒ SM không bao giờ thấy campaign TEST.
--
-- KHÔNG đụng 4 policy của 075 (kct/kca/kcda/kctier) — chúng gọi hàm này nên tự
-- hưởng thay đổi. KHÔNG cấp INSERT/UPDATE/DELETE. KHÔNG đổi schema.
-- Backward-compatible với app đang chạy: app cũ chặn SM ở tầng route nên hành
-- vi không đổi cho tới khi deploy code.
--
-- ROLLBACK: CREATE OR REPLACE hàm này NGUYÊN VĂN từ migration 075
--   + DELETE FROM public.app_migrations WHERE version = '111';
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '075') THEN
    RAISE EXCEPTION '111: thiếu migration nền 075 (SM campaign access)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.can_read_kpi_campaign(p_campaign_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.kpi_campaigns c
    JOIN public.kpi_campaign_store_targets t ON t.campaign_id = c.id
    WHERE c.id = p_campaign_id
      AND c.is_test = false
      AND (
        -- Staff/QLCH: GIỮ NGUYÊN 'active'-only. 111 KHÔNG nới gì cho hai vai
        -- trò này — họ là người thực thi, không tra cứu lịch sử.
        ( (select public.get_user_role()) IN ('staff', 'store_manager')
          AND c.status = 'active'
          AND t.store_id = (select public.get_user_store_id()) )
        OR
        -- SM: thêm 'ended' để tra cứu lịch sử chiến dịch của vùng mình.
        -- archived_at IS NULL nêu TƯỜNG MINH: campaign đã lưu trữ là đóng băng,
        -- không được quay lại qua đường đọc mới này.
        ( (select public.get_user_role()) = 'sm'
          AND c.status IN ('active', 'ended')
          AND c.archived_at IS NULL
          AND public.is_sm_for_store(t.store_id) )
      )
  )
$$;

GRANT EXECUTE ON FUNCTION public.can_read_kpi_campaign(uuid) TO authenticated;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('111', 'kpi_campaign_sm_read_ended',
        'SM doc duoc campaign ended (ngoai active) trong pham vi cua hang duoc phan cong.'
        || ' Dieu kien status CHUYEN VAO TUNG NHANH vai tro: staff/store_manager van'
        || ' active-only (khong doi mot bit), sm = active + ended + archived_at IS NULL.'
        || ' is_test = false giu o muc ngoai. Khong dung 4 policy cua 075, khong cap'
        || ' quyen ghi, khong doi schema.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ── VERIFY (chạy sau COMMIT) ────────────────────────────────────────────────
-- 1) Hàm còn SECURITY DEFINER + search_path:
--    SELECT proname, prosecdef, proconfig FROM pg_proc
--    WHERE proname = 'can_read_kpi_campaign';        -- prosecdef = true
--
-- 2) Hai nhánh status TÁCH RIÊNG (đây là điểm dễ sai nhất):
--    SELECT prosrc LIKE '%IN (''active'', ''ended'')%'  AS sm_co_ended,
--           prosrc LIKE '%archived_at IS NULL%'          AS sm_chan_archived,
--           prosrc LIKE '%is_test = false%'              AS van_chan_test,
--           prosrc LIKE '%is_sm_for_store%'              AS van_chan_pham_vi
--    FROM pg_proc WHERE proname = 'can_read_kpi_campaign';
--    Kỳ vọng: true, true, true, true.
--
-- 3) Staff/QLCH KHÔNG bị nới: đếm số lần c.status xuất hiện = 2
--    (một cho nhánh staff, một cho nhánh sm):
--    SELECT (length(prosrc) - length(replace(prosrc, 'c.status', ''))) / length('c.status') AS so_lan
--    FROM pg_proc WHERE proname = 'can_read_kpi_campaign';   -- = 2
--
-- 4) Marker: SELECT version, name FROM public.app_migrations WHERE version='111';
