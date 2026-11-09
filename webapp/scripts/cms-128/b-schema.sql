
-- ── 1. Cơ sở tính theo chương trình ─────────────────────────────────────────
-- Default hằng ⇒ PG ≥ 11 không viết lại bảng; mọi chương trình hiện có = pos_base (luật cũ, không đổi tiền / pointer).
ALTER TABLE public.cms_programs
  ADD COLUMN quantity_basis text NOT NULL DEFAULT 'pos_base'
    CONSTRAINT cms_programs_quantity_basis_check CHECK (quantity_basis IN ('pos_base', 'cms_unit'));

-- ── 2. Metadata tính của run (DB ghi lúc open, bất biến) ────────────────────
ALTER TABLE public.cms_sync_runs
  ADD COLUMN quantity_basis             text,
  ADD COLUMN calculation_policy_version text,
  ADD COLUMN calculation_snapshot       jsonb;
-- Run bán CŨ: dán nhãn theo chính sách đã biết (pos_base), KHÔNG bịa snapshot lịch sử (NULL + nhãn 'pos_base_legacy'). Trigger 123 trên
-- bảng run (owner / payout — preflight: 0 payout) chạy bình thường; trigger bất biến 128 tạo SAU câu này.
UPDATE public.cms_sync_runs SET quantity_basis = 'pos_base', calculation_policy_version = 'pos_base_legacy'
 WHERE kind = 'sales';
ALTER TABLE public.cms_sync_runs
  ADD CONSTRAINT cms_sync_runs_basis_shape CHECK (
    (kind = 'products' AND quantity_basis IS NULL AND calculation_policy_version IS NULL AND calculation_snapshot IS NULL)
    OR (kind = 'sales'
        AND ((quantity_basis = 'pos_base' AND calculation_policy_version IN ('pos_base_legacy', 'pos_base_v1'))
             OR (quantity_basis = 'cms_unit' AND calculation_policy_version = 'cms_unit_v1'))
        AND ((calculation_policy_version = 'pos_base_legacy') = (calculation_snapshot IS NULL))
        AND (calculation_snapshot IS NULL
             OR (jsonb_typeof(calculation_snapshot) = 'object'
                 AND calculation_snapshot ->> 'schema' = 'cms-calc-snapshot-v1'
                 AND calculation_snapshot ->> 'quantity_basis' = quantity_basis
                 AND calculation_snapshot ->> 'calculation_policy_version' = calculation_policy_version
                 AND jsonb_typeof(calculation_snapshot -> 'products') = 'array'
                 AND (calculation_snapshot ->> 'config_fp') ~ '^[0-9a-f]{32}$'))));

-- ── 3. Helper nội bộ (không cấp ai; chỉ RPC SECDEF cùng owner gọi) ─────────
-- Khoá so khớp đơn vị — hợp đồng CHUNG với lib/cms/unitKey.ts cmsUnitKey (@@UNIT_KEY_VERSION@@): ký tự điều khiển C0 / DEL / C1 ⇒ NULL
-- (không hợp lệ, không xoá); NFC; cắt khoảng trắng hai đầu theo TẬP TƯỜNG MINH (gồm NBSP); hoa → thường theo BẢNG TƯỜNG MINH bằng
-- translate (KHÔNG lower(): phụ thuộc locale DB — PGlite / cluster locale C chỉ hạ ASCII). Không bỏ dấu / alias / cắt độ dài.
CREATE FUNCTION public.cms__unit_key(p_unit text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_unit ~ '[\x01-\x1f\x7f-\x9f]' THEN NULL
              ELSE NULLIF(translate(btrim(normalize(p_unit, NFC), '@@UNIT_KEY_WS@@'),
                                    '@@UNIT_KEY_UP@@',
                                    '@@UNIT_KEY_LO@@'), '') END
$$;

-- Lượng gốc dạng thập phân chính xác — cùng hợp đồng cmsUnitQuantity / parseCmsDecimal (dấu chấm, ≤ 9 chữ số lẻ, ≤ 29 chữ số nguyên
-- sau bỏ số 0 đầu, có thể âm; không khoảng trắng / số mũ). Sai hình thức ⇒ NULL.
CREATE FUNCTION public.cms__qty_dec(p_raw text)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_raw ~ '^-?[0-9]+(\.[0-9]{1,9})?$'
               AND char_length(regexp_replace(substring(p_raw FROM '^-?([0-9]+)'), '^0+(?=[0-9])', '')) <= 29
              THEN p_raw::numeric END
$$;

-- Phiên bản chính sách tính của từng cơ sở (run mới). NULL ⇒ cơ sở lạ.
CREATE FUNCTION public.cms__basis_policy(p_basis text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE p_basis WHEN 'pos_base' THEN 'pos_base_v1' WHEN 'cms_unit' THEN 'cms_unit_v1' END
$$;

-- Snapshot cấu hình tính BẤT BIẾN của run (cms-calc-snapshot-v1) — DB tự dựng dưới khoá dòng chương trình của rpc_cms_sales_run_open,
-- không nhận từ caller. Không PII / mapping người dùng.
CREATE FUNCTION public.cms__calc_snapshot(p_program_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'schema', 'cms-calc-snapshot-v1',
    'quantity_basis', p.quantity_basis,
    'calculation_policy_version', public.cms__basis_policy(p.quantity_basis),
    'unit_key_version', '@@UNIT_KEY_VERSION@@',
    'quantity_policy', CASE p.quantity_basis WHEN 'cms_unit' THEN 'cms_unit_integer_exact_v1' ELSE 'pos_base_floor_div_k_v1' END,
    'gmv_policy', 'candidate_lines_all_units_v1',
    'config_version', p.config_version,
    'config_fp', public.cms__config_fp(p.id),
    'start_date', to_char(p.start_date, 'YYYY-MM-DD'),
    'end_date', to_char(p.end_date, 'YYYY-MM-DD'),
    'catalog_target_gmv', p.catalog_target_gmv::text,
    'products', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', pp.id, 'product_id', pp.product_id, 'unit_cms', pp.unit_cms, 'unit_key', public.cms__unit_key(pp.unit_cms),
        'base_quantity_cms', pp.base_quantity_cms::text, 'gmv_basis', pp.gmv_basis, 'target_gmv', pp.target_gmv::text,
        'tiers', COALESCE((SELECT jsonb_agg(jsonb_build_object('order', t.tier_order, 'from', t.qty_from, 'to', t.qty_to,
                                                               'amount', t.amount_per_unit::text) ORDER BY t.tier_order)
                             FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id), '[]'::jsonb))
        ORDER BY pp.product_id) FROM public.cms_program_products pp WHERE pp.program_id = p.id), '[]'::jsonb))
  FROM public.cms_programs p WHERE p.id = p_program_id
$$;

-- ── 4. Guard đổi cơ sở chương trình ─────────────────────────────────────────
-- Đổi quantity_basis chỉ khi: config_version + 1 trong CÙNG câu lệnh (run / preview / chứng nhận cũ hết hiệu lực), pointer NULL (không
-- để UI đọc số luật cũ như số luật mới), không run bán running; VÀ chương trình nháp, HOẶC chưa từng có run bán (sửa trước ngày bắt đầu
-- qua rpc_cms_program_save), HOẶC phiên datafix khai set_config('cms.basis_change_program', <id>, true). 'locked' đã bị guard 123 chặn.
CREATE FUNCTION public.cms__programs_basis_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.quantity_basis IS NOT DISTINCT FROM OLD.quantity_basis THEN
    RETURN NEW;
  END IF;
  IF NEW.config_version IS DISTINCT FROM OLD.config_version + 1 OR NEW.current_result_run_id IS NOT NULL
     OR OLD.status = 'locked' OR NEW.status = 'locked'
     OR EXISTS (SELECT 1 FROM public.cms_sync_runs r WHERE r.kind = 'sales' AND r.program_id = OLD.id AND r.status = 'running') THEN
    RAISE EXCEPTION 'CMS_PROGRAM_BASIS_CHANGE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF OLD.status = 'draft'
     OR NOT EXISTS (SELECT 1 FROM public.cms_sync_runs r WHERE r.kind = 'sales' AND r.program_id = OLD.id)
     OR current_setting('cms.basis_change_program', true) IS NOT DISTINCT FROM OLD.id::text THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CMS_PROGRAM_BASIS_CHANGE_INVALID' USING ERRCODE = '22023';
END;
$$;
CREATE TRIGGER cms_programs_basis_guard BEFORE UPDATE OF quantity_basis ON public.cms_programs
  FOR EACH ROW EXECUTE FUNCTION public.cms__programs_basis_guard();
ALTER TABLE public.cms_programs ENABLE ALWAYS TRIGGER cms_programs_basis_guard;

-- ── 5. Guard metadata run ────────────────────────────────────────────────────
-- INSERT run bán: phải có cơ sở + chính sách v1 + snapshot đúng cơ sở (nhãn legacy chỉ cho run trước 128). UPDATE: ba cột BẤT BIẾN
-- (caller không sửa được qua finish / stage / publish / owner ghi thẳng — muốn đổi phải tạo run mới).
CREATE FUNCTION public.cms__runs_basis_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'sales' AND (NEW.quantity_basis IS NULL OR NEW.calculation_snapshot IS NULL
                               OR NEW.calculation_policy_version IS DISTINCT FROM public.cms__basis_policy(NEW.quantity_basis)) THEN
      RAISE EXCEPTION 'CMS_RUN_BASIS_INVALID' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.quantity_basis IS DISTINCT FROM OLD.quantity_basis
     OR NEW.calculation_policy_version IS DISTINCT FROM OLD.calculation_policy_version
     OR NEW.calculation_snapshot IS DISTINCT FROM OLD.calculation_snapshot THEN
    RAISE EXCEPTION 'CMS_RUN_BASIS_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cms_sync_runs_basis_guard BEFORE INSERT OR UPDATE ON public.cms_sync_runs
  FOR EACH ROW EXECUTE FUNCTION public.cms__runs_basis_guard();
ALTER TABLE public.cms_sync_runs ENABLE ALWAYS TRIGGER cms_sync_runs_basis_guard;
