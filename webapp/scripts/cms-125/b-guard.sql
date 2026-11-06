
-- ── 2. Guard DB: bậc cuối không giới hạn ở cuối transaction ────────────────
-- Constraint trigger DEFERRABLE INITIALLY DEFERRED (chạy lúc COMMIT, mỗi dòng bậc đổi): import nhiều dòng / replace (xoá rồi chèn
-- lại) không bị chặn giữa chừng, nhưng transaction kết thúc không thể để lại bậc cuối hữu hạn. SECURITY DEFINER (owner bảng) ⇒ đọc
-- đúng bậc dù COMMIT chạy dưới role nào (service_role / authenticator) — RLS bảng không áp owner. Không cấp EXECUTE cho ai (trigger
-- không cần). Chỉ ĐỌC bậc cuối qua PK (program_product_id, tier_order) ⇒ không khoá, không quét chương trình.
CREATE FUNCTION public.cms__tiers_last_open_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[] := '{}'::uuid[];
  v_id  uuid;
  v_to  integer;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_ids := v_ids || OLD.program_product_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_ids := v_ids || NEW.program_product_id;
  END IF;
  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT t.qty_to INTO v_to FROM public.cms_program_tiers t WHERE t.program_product_id = v_id ORDER BY t.tier_order DESC LIMIT 1;
    IF FOUND THEN
      IF v_to IS NOT NULL THEN
        RAISE EXCEPTION 'CMS_TIER_LAST_FINITE' USING ERRCODE = '23514';
      END IF;
    -- Không còn bậc: chỉ bỏ qua khi SP cũng đã bị xoá (replace xoá bậc rồi xoá SP — không kiểm nhầm id cũ). SP còn dòng mà 0 bậc ⇒
    -- không có bậc cuối không giới hạn ⇒ chặn (db-reviewer 125 P2-4).
    ELSIF EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.id = v_id) THEN
      RAISE EXCEPTION 'CMS_TIER_LAST_FINITE' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER cms_tiers_last_open AFTER INSERT OR UPDATE OR DELETE ON public.cms_program_tiers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.cms__tiers_last_open_guard();
-- Như 123 (db-reviewer P1-2): ENABLE ALWAYS — vẫn chạy khi session_replication_role = replica.
ALTER TABLE public.cms_program_tiers ENABLE ALWAYS TRIGGER cms_tiers_last_open;
