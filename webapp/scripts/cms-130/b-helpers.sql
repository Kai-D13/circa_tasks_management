
-- ── 1. Helper hợp đồng (chỉ owner; RPC SECDEF cùng owner gọi) ─────────────
-- Làm sạch chuỗi thô q / u — ĐÚNG text() của lớp nguồn (lib/cms/source/contract.ts; lib/cms/calc/fp.ts cmsSrcClean): ký tự điều khiển
-- C0 / DEL / C1 → space, rồi cắt hai đầu theo TẬP ĐO được của String.prototype.trim sau bước thay (U+180E / 200B / 2060 KHÔNG cắt),
-- rỗng ⇒ NULL. Không NFC, không đổi hoa / thường. Tập cắt sinh từ hằng generator (parity TS ↔ PGlite ↔ PG15 ở harness).
CREATE FUNCTION public.cms__src_clean(p text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = public AS $$
  SELECT NULLIF(btrim(regexp_replace(p, '[\x01-\x1f\x7f-\x9f]', ' ', 'g'), '@@SRC_TRIM@@'), '')
$$;

-- Khoá so khớp đơn vị — hợp đồng CHUNG với lib/cms/unitKey.ts cmsUnitKey (@@UNIT_KEY_VERSION@@): ký tự điều khiển C0 / DEL / C1 hoặc
-- ký tự định dạng / vô hình của tập tường minh CMS_UNIT_INVISIBLE ở BẤT KỲ vị trí nào ⇒ NULL (kiểm trên chuỗi THÔ trước NFC / cắt);
-- NFC; cắt khoảng trắng hai đầu theo tập tường minh CMS_UNIT_WS; hoa → thường theo bảng tường minh bằng translate (không lower():
-- phụ thuộc locale). Không bỏ dấu / alias / cắt độ dài. Lớp ký tự / bảng sinh từ hằng TS.
CREATE FUNCTION public.cms__unit_key(p_unit text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_unit ~ '[\x01-\x1f\x7f-\x9f]' OR p_unit ~ '@@UNIT_KEY_INVIS@@' THEN NULL
              ELSE NULLIF(translate(btrim(normalize(p_unit, NFC), '@@UNIT_KEY_WS@@'), '@@UNIT_KEY_UP@@', '@@UNIT_KEY_LO@@'), '') END
$$;

-- Lượng gốc dạng thập phân chính xác — cùng hợp đồng cmsUnitQuantity / parseCmsDecimal (dấu chấm, ≤ 9 chữ số lẻ, ≤ 29 chữ số nguyên
-- sau bỏ số 0 đầu, có thể âm; không khoảng trắng / số mũ / dấu +). Sai hình thức ⇒ NULL.
CREATE FUNCTION public.cms__qty_dec(p_raw text)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_raw ~ '^-?[0-9]+(\.[0-9]{1,9})?$'
               AND char_length(regexp_replace(substring(p_raw FROM '^-?([0-9]+)'), '^0+(?=[0-9])', '')) <= 29
              THEN p_raw::numeric END
$$;

-- Từ điển trạng thái phiếu trả (@@STATUS_VERSION@@ — PM D13): so khớp BYTE trên chuỗi thô; ngoài từ điển ⇒ NULL (lạ ⇒ HOLD).
CREATE FUNCTION public.cms__return_status_effect(p_status text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE @@STATUS_CASE@@ END
$$;

-- Vân tay tài chính của phiếu trả (@@FP_VERSION@@ — PM D14 / RET2-DB-01): sha256 hex của tuple chuẩn, mỗi trường
-- `<độ dài byte UTF-8>:<giá trị>` nối liền; số → chuỗi số nguyên đơn vị 10⁻⁹ (trunc scale 0, không `.0`); thời điểm → µs UTC.
-- Không email / user / store. Version lạ hoặc thiếu trường ⇒ NULL (CHECK baseline ép version + NOT NULL). Cùng hợp đồng
-- lib/cms/calc/fp.ts cmsReturnFinancialFp (vector độc lập sha256sum — parity ở harness).
CREATE FUNCTION public.cms__return_fp(p_version text, p_program_id uuid, p_return_event_id text, p_return_document_id text,
                                      p_original_order_line_id text, p_original_order_id text, p_product_id text,
                                      p_base numeric, p_refund numeric, p_recorded_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_version = '@@FP_VERSION@@' AND p_program_id IS NOT NULL AND p_return_event_id IS NOT NULL
                   AND p_return_document_id IS NOT NULL AND p_original_order_line_id IS NOT NULL AND p_original_order_id IS NOT NULL
                   AND p_product_id IS NOT NULL AND p_base IS NOT NULL AND p_refund IS NOT NULL AND p_recorded_at IS NOT NULL
                   AND isfinite(p_recorded_at)
              THEN encode(sha256(convert_to(string_agg(octet_length(f) || ':' || f, '' ORDER BY i), 'UTF8')), 'hex') END
    FROM unnest(ARRAY[p_version, p_program_id::text, p_return_event_id, p_return_document_id, p_original_order_line_id,
                      p_original_order_id, p_product_id, trunc(p_base * 1000000000, 0)::text, trunc(p_refund * 1000000000, 0)::text,
                      trunc(extract(epoch FROM p_recorded_at) * 1000000, 0)::text]) WITH ORDINALITY AS t(f, i)
$$;
