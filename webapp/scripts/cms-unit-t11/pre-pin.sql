-- PRE CHỈ ĐỌC — bản ghim datafix T11 CMS-UNIT tại cửa sổ (spec PM 09/11 §5 / §8 bước 4–5). Một câu SELECT, không ghi, không PII.
-- Chạy SAU khi task CMS sales đã tạm dừng (running_runs phải = 0). Kết quả cột `pin` lưu NGUYÊN VĂN thành
-- webapp/scripts/cms-unit-t11/pin.json rồi sinh file: node scripts/gen-cms-unit-t11.mjs --version=<số PM ghim> --out=<thư mục>.
-- Harness scripts/qa-cms-unit-t11.mjs dựng bản ghim bằng CHÍNH câu này (thay UUID) — câu PRE được diễn tập cùng datafix.
SELECT jsonb_build_object(
  'version', 1,
  'window_pinned', true,
  'note', 'PRE chỉ đọc tại cửa sổ — scripts/cms-unit-t11/pre-pin.sql',
  'captured_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'program', (SELECT jsonb_build_object(
      'id', p.id, 'status', p.status, 'is_test', p.is_test,
      'start_date', to_char(p.start_date, 'YYYY-MM-DD'), 'end_date', to_char(p.end_date, 'YYYY-MM-DD'),
      'scope', p.scope, 'calc_mode', p.calc_mode, 'gate_scope', p.gate_scope, 'catalog_target_gmv', p.catalog_target_gmv::text,
      'config_version', p.config_version, 'quantity_basis', p.quantity_basis,
      'stores_n', (SELECT count(*) FROM public.cms_program_stores s WHERE s.program_id = p.id),
      'stores_md5', (SELECT md5(string_agg(s.store_id::text, ',' ORDER BY s.store_id::text COLLATE "C")) FROM public.cms_program_stores s WHERE s.program_id = p.id),
      'config_fp', public.cms__config_fp(p.id),
      -- Thông tin đối chiếu (generator bỏ qua): pointer hiện hành + run đang chạy (phải 0).
      'current_result_run_id', p.current_result_run_id,
      'running_runs', (SELECT count(*) FROM public.cms_sync_runs r WHERE r.kind = 'sales' AND r.status = 'running'))
    FROM public.cms_programs p WHERE p.id = '942194ce-893f-4f62-a88a-bd9efa464bae'),
  'products', (SELECT jsonb_agg(jsonb_build_object(
      'id', pp.id, 'product_id', pp.product_id, 'gmv_basis', pp.gmv_basis, 'target_gmv', pp.target_gmv::text, 'unit_cms', pp.unit_cms,
      'base_quantity_cms', pp.base_quantity_cms::text, 'advice_md5', md5(pp.advice_text), 'name_md5', md5(pp.name_snapshot),
      'image_md5', md5(COALESCE(pp.image_url_snapshot, '')), 'price_snapshot', pp.price_snapshot::text, 'import_run_id', pp.import_run_id,
      'added_after_start', pp.added_after_start, 'amount', t.amount_per_unit) ORDER BY pp.product_id)
    FROM public.cms_program_products pp JOIN public.cms_program_tiers t ON t.program_product_id = pp.id
    WHERE pp.program_id = '942194ce-893f-4f62-a88a-bd9efa464bae')
) AS pin;
