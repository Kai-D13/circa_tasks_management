
-- ── 7. Seal run contract — 13 bước DB tự tính lại (thiết kế r2 §5.2) ──────
-- Gọi từ rpc_cms_sales_run_seal_step (thân 122 + rẽ nhánh). Cùng khung 122: khoá run, thứ tự bước, "already" khi gọi lại, kiểm
-- khoá / active / cấu hình / mapping / STALE đầu MỖI bước. Dữ liệu staging đóng băng từ seal_begin. Mã fail:
--   · error SEAL_* — worker / staging lệch dữ liệu DB tự tính (lỗi kỹ thuật);
--   · held SEAL_N1_* / SEAL_N2_* / SEAL_N9_REJECTED — nguồn cần người xử lý (tập HOLD cùng lib/cms/calc/classify.ts + net.ts).
-- Mọi so sánh có thể NULL dùng IS [NOT] DISTINCT FROM (một vế NULL trong OR của WHERE sẽ bỏ lọt dòng lệch).
CREATE FUNCTION public.cms__seal_contract_step(p_run_id uuid, p_step integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s'
  SET enable_nestloop = off AS $$
DECLARE
  v_run   public.cms_sync_runs%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_exp   jsonb;
  v_from  timestamptz;
  v_to    timestamptz;
  v_sum   numeric;
  v_bad   boolean;
  v_code  text;
  v_net   boolean;
  v_unit  boolean;
  v_asof  timestamptz;
  v_dig   text;
BEGIN
  IF p_step IS NULL OR p_step < 1 OR p_step > 13 THEN RAISE EXCEPTION 'CMS_SEAL_BAD_STEP' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' OR v_run.calc_contract_version IS NULL THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.seal_expect IS NULL THEN RAISE EXCEPTION 'CMS_SEAL_STEP_ORDER' USING ERRCODE = 'P0001'; END IF;
  IF v_run.sealed_at IS NOT NULL THEN
    RETURN CASE WHEN p_step = 13 THEN jsonb_build_object('sealed', true, 'step', 13, 'already', true, 'amount_vnd', v_run.amount_vnd::text)
                ELSE jsonb_build_object('sealed', false, 'ok', true, 'step', p_step, 'already', true) END;
  END IF;
  IF v_run.seal_step >= p_step THEN RETURN jsonb_build_object('sealed', false, 'ok', true, 'step', p_step, 'already', true); END IF;
  IF v_run.seal_step <> p_step - 1 THEN RAISE EXCEPTION 'CMS_SEAL_STEP_ORDER' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'STALE'); END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  IF v_prog.status = 'locked' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_LOCKED'); END IF;
  IF v_prog.status <> 'active' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_NOT_ACTIVE'); END IF;
  IF v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;
  v_exp  := v_run.seal_expect;
  v_from := (v_prog.start_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  v_to   := ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  v_net  := v_run.returns_policy = 'net_returns_v1';
  v_unit := v_run.quantity_basis = 'cms_unit';

  IF p_step = 1 THEN
    -- S1 thứ tự (r2 §5.4, parity lib/cms/calc/order.ts). Dòng bán: khoá 122 bước 1 nguyên văn. Phiếu trả: byte return_event_id.
    -- Sự kiện: µs → SALE trước RETURN → ID (SALE nhánh số / text như dòng bán; RETURN byte). Seq liên tục 0…n−1 ở cả ba bảng.
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT completed_at, order_line_id AS c_id, regexp_replace(order_line_id, '^0+(?=[0-9])', '') AS c_t,
               lag(completed_at) OVER (ORDER BY seq) AS p_at, lag(order_line_id) OVER (ORDER BY seq) AS p_id,
               lag(regexp_replace(order_line_id, '^0+(?=[0-9])', '')) OVER (ORDER BY seq) AS p_t
          FROM public.cms_sales_lines WHERE run_id = p_run_id) x
       WHERE x.p_at > x.completed_at
          OR (x.p_at = x.completed_at AND x.p_id !~ '^[0-9]+$' AND x.c_id ~ '^[0-9]+$')
          OR (x.p_at = x.completed_at AND x.p_id ~ '^[0-9]+$' AND x.c_id ~ '^[0-9]+$'
              AND NOT (length(x.p_t) < length(x.c_t)
                       OR (length(x.p_t) = length(x.c_t) AND x.p_t COLLATE "C" < x.c_t COLLATE "C")
                       OR (x.p_t = x.c_t AND x.p_id COLLATE "C" < x.c_id COLLATE "C")))
          OR (x.p_at = x.completed_at AND x.p_id !~ '^[0-9]+$' AND x.c_id !~ '^[0-9]+$'
              AND NOT (x.p_id COLLATE "C" < x.c_id COLLATE "C")))
      OR COALESCE((SELECT max(seq) FROM public.cms_sales_lines WHERE run_id = p_run_id), -1)
         <> (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id) - 1
      OR EXISTS (
        SELECT 1 FROM (
          SELECT return_event_id AS c_id, lag(return_event_id) OVER (ORDER BY seq) AS p_id
            FROM public.cms_return_lines WHERE run_id = p_run_id) x
         WHERE x.p_id IS NOT NULL AND NOT (x.p_id COLLATE "C" < x.c_id COLLATE "C"))
      OR COALESCE((SELECT max(seq) FROM public.cms_return_lines WHERE run_id = p_run_id), -1)
         <> (SELECT count(*) FROM public.cms_return_lines WHERE run_id = p_run_id) - 1
      OR EXISTS (
        SELECT 1 FROM (
          SELECT e.event_at AS c_at, e.kind AS c_k, COALESCE(e.return_event_id, e.order_line_id) AS c_id,
                 regexp_replace(COALESCE(e.return_event_id, e.order_line_id), '^0+(?=[0-9])', '') AS c_t,
                 lag(e.event_at) OVER w AS p_at, lag(e.kind) OVER w AS p_k, lag(COALESCE(e.return_event_id, e.order_line_id)) OVER w AS p_id,
                 lag(regexp_replace(COALESCE(e.return_event_id, e.order_line_id), '^0+(?=[0-9])', '')) OVER w AS p_t
            FROM public.cms_result_events e WHERE e.run_id = p_run_id WINDOW w AS (ORDER BY e.seq)) x
         WHERE x.p_at > x.c_at
            OR (x.p_at = x.c_at AND x.p_k = 'RETURN' AND x.c_k = 'SALE')
            OR (x.p_at = x.c_at AND x.p_k = 'RETURN' AND x.c_k = 'RETURN' AND NOT (x.p_id COLLATE "C" < x.c_id COLLATE "C"))
            OR (x.p_at = x.c_at AND x.p_k = 'SALE' AND x.c_k = 'SALE'
                AND ((x.p_id !~ '^[0-9]+$' AND x.c_id ~ '^[0-9]+$')
                     OR (x.p_id ~ '^[0-9]+$' AND x.c_id ~ '^[0-9]+$'
                         AND NOT (length(x.p_t) < length(x.c_t)
                                  OR (length(x.p_t) = length(x.c_t) AND x.p_t COLLATE "C" < x.c_t COLLATE "C")
                                  OR (x.p_t = x.c_t AND x.p_id COLLATE "C" < x.c_id COLLATE "C")))
                     OR (x.p_id !~ '^[0-9]+$' AND x.c_id !~ '^[0-9]+$' AND NOT (x.p_id COLLATE "C" < x.c_id COLLATE "C")))))
      OR COALESCE((SELECT max(seq) FROM public.cms_result_events WHERE run_id = p_run_id), -1)
         <> (SELECT count(*) FROM public.cms_result_events WHERE run_id = p_run_id) - 1
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_ORDER'); END IF;
  ELSIF p_step = 2 THEN
    -- S2 kỳ / SP / phạm vi (điều kiện = 122 bước 2). count(*) > 0 thay EXISTS: EXISTS tối ưu khởi động nhanh (planner ước gần mọi dòng
    -- vi phạm) ⇒ chọn Merge Join quét index cms_sales_lines_product_fk_idx của MỌI run rồi lọc run_id (bench 14/11: 4,4 s / 1 triệu dòng
    -- bảng); đếm ⇒ tối ưu tổng chi phí. Run hợp lệ không có dòng vi phạm ⇒ hai dạng cùng đọc hết run.
    SELECT count(*) > 0
      FROM public.cms_sales_lines sl
      JOIN public.cms_program_products pp ON pp.id = sl.program_product_id
      LEFT JOIN public.cms_program_stores ps ON ps.program_id = v_run.program_id AND ps.store_id = sl.store_id
     WHERE sl.run_id = p_run_id
       AND (sl.product_id <> pp.product_id OR sl.completed_at < v_from OR sl.completed_at >= v_to
            OR (sl.disposition = 'INCLUDED' AND ps.store_id IS NULL)
            OR (sl.disposition = 'OUT_OF_SCOPE' AND ps.store_id IS NOT NULL))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_SCOPE'); END IF;
    -- Lớp nguồn ↔ lớp bán: tập ứng viên (OFFLINE + COMPLETED, trong kỳ, SP chương trình) KHÔNG âm của lớp nguồn = đúng tập dòng bán,
    -- mọi trường chung + thô / cờ bằng nhau. Không bỏ sót ứng viên; ứng viên âm ⇒ N1.
    WITH sc AS (
      SELECT s.* FROM public.cms_sales_source_lines s
       WHERE s.run_id = p_run_id AND s.order_type = 'OFFLINE' AND s.order_status = 'COMPLETED'
         AND s.completed_at >= v_from AND s.completed_at < v_to AND s.base_quantity >= 0 AND s.gmv_amount >= 0
         AND EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = v_run.program_id AND pp.product_id = s.product_id)
    ), sl AS (
      SELECT * FROM public.cms_sales_lines WHERE run_id = p_run_id
    )
    SELECT EXISTS (
      SELECT 1 FROM sc FULL JOIN sl ON sl.order_line_id = sc.order_line_id
       WHERE sc.order_line_id IS NULL OR sl.order_line_id IS NULL
          OR (sl.order_id, sl.order_code, sl.product_id, sl.seller_email, sl.pos_code, sl.completed_at, sl.source_updated_at,
              sl.quantity_raw, sl.uom_raw, sl.base_quantity, sl.gmv_amount, sl.quantity_src, sl.uom_src, sl.quantity_src_flag,
              sl.uom_src_flag)
             IS DISTINCT FROM
             (sc.order_id, sc.order_code, sc.product_id, sc.seller_email, sc.pos_code, sc.completed_at, sc.source_updated_at,
              sc.quantity_raw, sc.uom_raw, sc.base_quantity, sc.gmv_amount, sc.quantity_src, sc.uom_src, sc.quantity_src_flag,
              sc.uom_src_flag))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_SOURCE_LINK'); END IF;
  ELSIF p_step = 3 THEN
    -- S3 người bán (122 bước 3 nguyên văn).
    WITH ue AS (
      SELECT u.id, public.cms__norm_email(u.email) AS e, u.role, u.store_id, COALESCE(s.store_type = 'os' AND s.is_active, false) AS ok
        FROM public.users u LEFT JOIN public.stores s ON s.id = u.store_id
    ), cnt AS (SELECT e, count(*) AS n FROM ue WHERE e IS NOT NULL GROUP BY e),
    elig AS (SELECT ue.e FROM ue JOIN cnt ON cnt.e = ue.e AND cnt.n = 1 WHERE ue.role = 'staff' AND ue.ok)
    SELECT EXISTS (
      SELECT 1 FROM public.cms_sales_lines sl
        LEFT JOIN cnt ON cnt.e = sl.seller_email
        LEFT JOIN ue ON ue.id = sl.user_id
       WHERE sl.run_id = p_run_id AND sl.disposition <> 'UNASSIGNED'
         AND NOT COALESCE(cnt.n = 1 AND ue.e = sl.seller_email AND ue.role = 'staff' AND ue.ok AND ue.store_id = sl.store_id, false))
    OR EXISTS (
      SELECT 1 FROM public.cms_sales_lines sl
        LEFT JOIN elig ON elig.e = sl.seller_email
       WHERE sl.run_id = p_run_id AND sl.disposition = 'UNASSIGNED'
         AND ((sl.seller_email IS NULL) <> (sl.unassigned_reason = 'NO_EMAIL') OR elig.e IS NOT NULL))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_MAPPING'); END IF;
  ELSIF p_step = 4 THEN
    -- N1 (r2 §4.1 / §5.2). (a) thô ↔ sạch trên lớp nguồn, tính trên tập DISTINCT (hàm SECDEF từng dòng ≈ 6,8 s / 100k).
    SELECT EXISTS (SELECT 1 FROM (SELECT DISTINCT quantity_src, quantity_raw FROM public.cms_sales_source_lines
                                   WHERE run_id = p_run_id AND quantity_src IS NOT NULL) d
                    WHERE public.cms__src_clean(d.quantity_src) IS DISTINCT FROM d.quantity_raw)
        OR EXISTS (SELECT 1 FROM (SELECT DISTINCT uom_src, uom_raw FROM public.cms_sales_source_lines
                                   WHERE run_id = p_run_id AND uom_src IS NOT NULL) d
                    WHERE public.cms__src_clean(d.uom_src) IS DISTINCT FROM d.uom_raw)
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N1_SRC'); END IF;
    -- (b) dòng BÁN âm của ứng viên chương trình (cả hai mode, kể cả dòng không stage được vào lớp bán) ⇒ HOLD.
    IF EXISTS (SELECT 1 FROM public.cms_sales_source_lines s
                WHERE s.run_id = p_run_id AND (s.base_quantity < 0 OR s.gmv_amount < 0)
                  AND s.order_type = 'OFFLINE' AND s.order_status = 'COMPLETED' AND s.completed_at >= v_from AND s.completed_at < v_to
                  AND EXISTS (SELECT 1 FROM public.cms_program_products pp
                               WHERE pp.program_id = v_run.program_id AND pp.product_id = s.product_id)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'held', 'SEAL_N1_NEGATIVE_SALE');
    END IF;
    IF v_unit AND EXISTS (SELECT 1 FROM public.cms_program_products pp
                           WHERE pp.program_id = v_run.program_id
                             AND (public.cms__unit_key(pp.unit_cms) IS NULL OR pp.base_quantity_cms IS NULL OR pp.base_quantity_cms <= 0)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N1_CONFIG');
    END IF;
    -- (c) phân loại MỌI ứng viên đã stage (INCLUDED / UNASSIGNED / OUT_OF_SCOPE — D7) theo đúng thứ tự classifyCmsSale; khoá đơn vị /
    -- lượng tính trên tập DISTINCT rồi hash join. Cờ NUL / OVERSIZE ⇒ không hợp lệ (TS writer HOLD cùng mã).
    -- MATERIALIZED bắt buộc (bench PG15 14/11): CTE inline ⇒ hàm SECDEF bị gọi lại TRÊN TỪNG DÒNG sau join, nhiều lần / dòng trong CASE
    -- (20k dòng 2,3 s; 200k ≈ 23 s). Vật hoá ⇒ mỗi giá trị phân biệt gọi đúng một lần.
    WITH pk AS MATERIALIZED (
      SELECT pp.id, pp.base_quantity_cms AS k, CASE WHEN v_unit THEN public.cms__unit_key(pp.unit_cms) END AS ukey
        FROM public.cms_program_products pp WHERE pp.program_id = v_run.program_id
    ), du AS MATERIALIZED (
      SELECT d.src, public.cms__unit_key(d.src) AS ukey
        FROM (SELECT DISTINCT uom_src AS src FROM public.cms_sales_lines
               WHERE run_id = p_run_id AND uom_src IS NOT NULL AND v_unit) d
    ), dq AS MATERIALIZED (
      SELECT d.src, public.cms__qty_dec(d.src) AS q
        FROM (SELECT DISTINCT quantity_src AS src FROM public.cms_sales_lines
               WHERE run_id = p_run_id AND quantity_src IS NOT NULL AND v_unit) d
    ), c AS (
      SELECT sl.quantity_class, sl.eligible_base, sl.base_quantity AS b,
             CASE
               WHEN sl.base_quantity < 0 OR sl.gmv_amount < 0 THEN 'H:NEGATIVE_SALE'
               WHEN NOT v_unit THEN 'POS_BASE'
               WHEN sl.uom_src_flag IS NOT NULL THEN 'H:UNIT_INVALID'
               WHEN sl.uom_src IS NULL OR sl.uom_src = '' THEN 'H:UNIT_MISSING'
               WHEN du.ukey IS NULL THEN 'H:UNIT_INVALID'
               WHEN sl.quantity_src_flag IS NOT NULL THEN 'H:QTY_INVALID'
               WHEN sl.quantity_src IS NULL OR sl.quantity_src = '' THEN 'H:QTY_MISSING'
               WHEN dq.q IS NULL THEN 'H:QTY_INVALID'
               WHEN dq.q < 0 THEN 'H:NEGATIVE_SALE'
               WHEN du.ukey <> pk.ukey THEN
                 CASE WHEN dq.q = 0 AND (sl.base_quantity <> 0 OR sl.gmv_amount <> 0) THEN 'H:ZERO_QTY_WITH_VALUE' ELSE 'OTHER_UNIT' END
               WHEN dq.q = 0 THEN
                 CASE WHEN sl.base_quantity <> 0 OR sl.gmv_amount <> 0 THEN 'H:ZERO_QTY_WITH_VALUE' ELSE 'ZERO_QUANTITY' END
               WHEN sl.base_quantity <> dq.q * pk.k THEN 'H:BASE_QTY_MISMATCH'
               WHEN dq.q <> trunc(dq.q) THEN 'FRACTIONAL_QUANTITY'
               WHEN dq.q > 9223372036854775807 THEN 'H:QTY_RANGE'
               ELSE 'COUNTED' END AS cls
        FROM public.cms_sales_lines sl
        JOIN pk ON pk.id = sl.program_product_id
        LEFT JOIN du ON du.src = sl.uom_src
        LEFT JOIN dq ON dq.src = sl.quantity_src
       WHERE sl.run_id = p_run_id
    )
    SELECT min(substr(c.cls, 3)) FILTER (WHERE c.cls LIKE 'H:%'),
           COALESCE(bool_or(c.quantity_class IS DISTINCT FROM c.cls
                            OR c.eligible_base IS DISTINCT FROM (CASE WHEN c.cls IN ('POS_BASE', 'COUNTED') THEN c.b ELSE 0 END)), false)
      INTO v_code, v_bad FROM c;
    IF v_code IS NOT NULL THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'SEAL_N1_' || v_code); END IF;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N1_CLASS'); END IF;
  ELSIF p_step = 5 THEN
    -- N2 phiếu trả (r2 §5.2). Sales-only: không có dòng trả nào. Net: as_of trong cửa sổ run; tập HOLD cùng net.ts; disposition tự suy.
    IF NOT v_net THEN
      IF EXISTS (SELECT 1 FROM public.cms_return_lines WHERE run_id = p_run_id) THEN
        RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PART_FORBIDDEN');
      END IF;
    ELSE
      v_asof := (v_exp -> 'pin' ->> 'as_of')::timestamptz;
      -- Cửa sổ as_of: không ở tương lai (> mở run + 5 phút) và không cũ hơn 36 giờ trước mở run (db-reviewer 14/11 P1-1 — snapshot phát
      -- lại; 36 giờ = mặc định Dev, đủ cho snapshot BI materialize hằng ngày; PM đổi được).
      IF v_asof > v_run.started_at + interval '5 minutes' OR v_asof < v_run.started_at - interval '36 hours' THEN
        RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N2_AS_OF');
      END IF;
      WITH r AS (
        SELECT rl.return_event_id, rl.status_effect, rl.recorded_at, rl.original_order_line_id, rl.original_completed_at,
               rl.original_order_type, rl.original_order_status, rl.return_base_quantity, rl.return_gmv_amount, rl.disposition,
               src.order_line_id AS src_id, sl.disposition AS sale_disp,
               EXISTS (SELECT 1 FROM public.cms_program_products pp
                        WHERE pp.program_id = v_run.program_id AND pp.product_id = rl.product_id) AS in_prog,
               COALESCE(src.order_line_id IS NOT NULL AND (
                 (src.order_id, src.product_id, src.completed_at, src.order_type, src.order_status, src.seller_email, src.pos_code,
                  src.base_quantity, src.gmv_amount)
                 IS DISTINCT FROM
                 (rl.original_order_id, rl.product_id, rl.original_completed_at, rl.original_order_type, rl.original_order_status,
                  rl.original_seller_email, rl.original_pos_code, rl.original_base_quantity, rl.original_gmv_amount)
                 OR (v_unit AND (src.quantity_src, src.uom_src, src.quantity_src_flag, src.uom_src_flag)
                                IS DISTINCT FROM (rl.original_quantity_src, rl.original_uom_src, rl.original_quantity_src_flag,
                                                  rl.original_uom_src_flag))), false) AS ctx_bad
          FROM public.cms_return_lines rl
          LEFT JOIN public.cms_sales_source_lines src ON src.run_id = rl.run_id AND src.order_line_id = rl.original_order_line_id
          LEFT JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.original_order_line_id
         WHERE rl.run_id = p_run_id
      ), d AS (
        SELECT r.*,
               CASE WHEN r.status_effect = 'NOT_EFFECTIVE' THEN 'NOT_COMPLETED'
                    WHEN r.ctx_bad THEN NULL
                    WHEN NOT (r.original_order_type = 'OFFLINE' AND r.original_order_status = 'COMPLETED') THEN 'ORIGIN_NOT_ELIGIBLE'
                    WHEN r.original_completed_at < v_from OR r.original_completed_at >= v_to THEN 'ORIGIN_OUT_OF_WINDOW'
                    WHEN NOT r.in_prog THEN 'ORIGIN_NOT_IN_PROGRAM'
                    WHEN r.src_id IS NULL THEN NULL
                    WHEN r.sale_disp = 'UNASSIGNED' THEN 'ORIGIN_UNASSIGNED'
                    WHEN r.sale_disp = 'OUT_OF_SCOPE' THEN 'ORIGIN_OUT_OF_SCOPE'
                    WHEN r.sale_disp = 'INCLUDED' THEN 'APPLIED' END AS exp_disp
          FROM r
      ), acc AS (
        SELECT d.original_order_line_id AS id, sum(d.return_base_quantity) AS rb, sum(d.return_gmv_amount) AS rg
          FROM d WHERE d.exp_disp IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE') GROUP BY d.original_order_line_id
      ), h AS (
        SELECT 'AFTER_AS_OF' AS code FROM d WHERE d.status_effect = 'EFFECTIVE' AND d.recorded_at > v_asof
        UNION ALL SELECT 'BEFORE_SALE' FROM d WHERE d.status_effect = 'EFFECTIVE' AND d.recorded_at < d.original_completed_at
        UNION ALL SELECT 'CONTEXT_MISMATCH' FROM d WHERE d.status_effect = 'EFFECTIVE' AND d.ctx_bad
        UNION ALL SELECT 'ORIGIN_MISSING' FROM d
                   WHERE d.status_effect = 'EFFECTIVE' AND NOT d.ctx_bad AND d.src_id IS NULL
                     AND d.original_order_type = 'OFFLINE' AND d.original_order_status = 'COMPLETED'
                     AND d.original_completed_at >= v_from AND d.original_completed_at < v_to AND d.in_prog
        UNION ALL SELECT 'EXCEEDS_SALE_BASE' FROM acc JOIN public.cms_sales_lines sl ON sl.run_id = p_run_id AND sl.order_line_id = acc.id
                   WHERE acc.rb > sl.base_quantity
        UNION ALL SELECT 'EXCEEDS_SALE_GMV' FROM acc JOIN public.cms_sales_lines sl ON sl.run_id = p_run_id AND sl.order_line_id = acc.id
                   WHERE acc.rg > sl.gmv_amount
      )
      SELECT (SELECT min(h.code) FROM h), EXISTS (SELECT 1 FROM d WHERE d.disposition IS DISTINCT FROM d.exp_disp)
        INTO v_code, v_bad;
      IF v_code IS NOT NULL THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'SEAL_N2_' || v_code); END IF;
      IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N2_DISPOSITION'); END IF;
    END IF;
  ELSIF p_step = 6 THEN
    -- N3 sự kiện ↔ nguồn: mỗi dòng INCLUDED đúng một SALE, mỗi phiếu APPLIED đúng một RETURN; delta = nguồn + lớp lượng của dòng
    -- bán (gốc); mốc = completed_at / recorded_at; không sự kiện nào khác (khoá / FK / CHECK bảng ép phần còn lại).
    WITH s AS (SELECT * FROM public.cms_sales_lines WHERE run_id = p_run_id AND disposition = 'INCLUDED'),
         es AS (SELECT * FROM public.cms_result_events WHERE run_id = p_run_id AND kind = 'SALE'),
         r AS (SELECT rl.return_event_id, rl.sale_ref_line_id, rl.recorded_at, rl.return_base_quantity, rl.return_gmv_amount,
                      sl.user_id, sl.program_product_id, sl.quantity_class
                 FROM public.cms_return_lines rl
                 JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.sale_ref_line_id
                WHERE rl.run_id = p_run_id AND rl.disposition = 'APPLIED'),
         er AS (SELECT * FROM public.cms_result_events WHERE run_id = p_run_id AND kind = 'RETURN')
    SELECT EXISTS (
      SELECT 1 FROM s FULL JOIN es ON es.order_line_id = s.order_line_id
       WHERE s.order_line_id IS NULL OR es.order_line_id IS NULL
          OR (es.user_id, es.program_product_id, es.quantity_class, es.base_delta, es.eligible_delta, es.gmv_delta, es.event_at)
             IS DISTINCT FROM (s.user_id, s.program_product_id, s.quantity_class, s.base_quantity, s.eligible_base, s.gmv_amount,
                               s.completed_at))
    OR EXISTS (
      SELECT 1 FROM r FULL JOIN er ON er.return_event_id = r.return_event_id
       WHERE r.return_event_id IS NULL OR er.return_event_id IS NULL
          OR (er.order_line_id, er.user_id, er.program_product_id, er.quantity_class, er.base_delta, er.eligible_delta, er.gmv_delta,
              er.event_at)
             IS DISTINCT FROM (r.sale_ref_line_id, r.user_id, r.program_product_id, r.quantity_class, -r.return_base_quantity,
                               CASE WHEN r.quantity_class IN ('POS_BASE', 'COUNTED') THEN -r.return_base_quantity ELSE 0 END,
                               -r.return_gmv_amount, r.recorded_at))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_N3_EVENTS'); END IF;
  ELSIF p_step = 7 THEN
    -- N4 cấu hình trong kết quả = chương trình (SP, loại GMV, K, target; run contract không trần) và tổng nhóm = Σ sự kiện (bán /
    -- trả / đủ / GMV / tiền / số dòng / số phiếu, C_bán ở cms_unit), một store.
    IF EXISTS (SELECT 1 FROM public.cms_results r
                 JOIN public.cms_program_products pp ON pp.id = r.program_product_id
                WHERE r.run_id = p_run_id
                  AND ((r.product_id, r.gmv_basis, r.per_unit) IS DISTINCT FROM (pp.product_id, pp.gmv_basis, pp.base_quantity_cms)
                       OR r.target_gmv IS DISTINCT FROM (CASE pp.gmv_basis WHEN 'product' THEN pp.target_gmv
                                                                           WHEN 'catalog' THEN v_prog.catalog_target_gmv END)
                       OR r.cap_quantity IS NOT NULL OR r.net_v IS DISTINCT FROM 1)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_RESULT_CONFIG');
    END IF;
    IF EXISTS (SELECT 1 FROM public.cms_results r
                 LEFT JOIN (
                   SELECT e.user_id, e.program_product_id,
                          count(*) FILTER (WHERE e.kind = 'SALE') AS ns, count(*) FILTER (WHERE e.kind = 'RETURN') AS nr,
                          COALESCE(sum(e.base_delta) FILTER (WHERE e.kind = 'SALE'), 0) AS sb,
                          COALESCE(-sum(e.base_delta) FILTER (WHERE e.kind = 'RETURN'), 0) AS rb,
                          COALESCE(sum(e.eligible_delta) FILTER (WHERE e.kind = 'SALE'), 0) AS esb,
                          COALESCE(-sum(e.eligible_delta) FILTER (WHERE e.kind = 'RETURN'), 0) AS erb,
                          COALESCE(sum(e.gmv_delta) FILTER (WHERE e.kind = 'SALE'), 0) AS sg,
                          COALESCE(-sum(e.gmv_delta) FILTER (WHERE e.kind = 'RETURN'), 0) AS rg,
                          sum(e.amount_vnd::numeric) AS a,
                          COALESCE(sum(e.eligible_delta / pp.base_quantity_cms)
                                     FILTER (WHERE e.kind = 'SALE' AND e.quantity_class = 'COUNTED'), 0) AS cq,
                          min(sl.store_id::text) AS s1, max(sl.store_id::text) AS s2
                     FROM public.cms_result_events e
                     JOIN public.cms_sales_lines sl ON sl.run_id = e.run_id AND sl.order_line_id = e.order_line_id
                     JOIN public.cms_program_products pp ON pp.id = e.program_product_id
                    WHERE e.run_id = p_run_id GROUP BY e.user_id, e.program_product_id) x
                   ON x.user_id = r.user_id AND x.program_product_id = r.program_product_id
                WHERE r.run_id = p_run_id
                  AND (x.ns IS NULL OR x.ns = 0
                       OR (x.ns, x.nr, x.sb, x.rb, x.esb, x.erb, x.sg, x.rg, x.a, x.s1, x.s2)
                          IS DISTINCT FROM (r.line_count::bigint, r.return_count::bigint, r.sale_base, r.return_base, r.eligible_sale_base,
                                            r.eligible_return_base, r.sale_gmv, r.return_gmv, r.amount_vnd::numeric,
                                            r.store_id::text, r.store_id::text)
                       OR r.counted_sale_qty::numeric IS DISTINCT FROM (CASE WHEN v_unit THEN x.cq END))) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_RESULT_SUMS');
    END IF;
  ELSIF p_step = 8 THEN
    -- N5 Q = floor(B_đủ_ròng / K) (bất đẳng thức chính xác) và F(Q) lũy tiến (thang 125 mở bậc cuối); tiền nhóm = gate ? F(Q) : 0.
    -- F tính một lần cho mỗi cặp (SP, Q) phân biệt như 122 bước 7.
    WITH tc AS (
      SELECT t.program_product_id, t.tier_order,
             COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                      ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM public.cms_program_tiers t WHERE t.program_id = v_run.program_id
    ), q AS (
      SELECT DISTINCT r.program_product_id, r.cms_quantity AS q FROM public.cms_results r WHERE r.run_id = p_run_id
    ), fq AS (
      SELECT q.program_product_id, q.q,
             CASE WHEN q.q <= 0 OR x.tier_order IS NULL THEN 0
                  ELSE tc.cum_before + (LEAST(q.q::numeric, COALESCE(x.qty_to, q.q)::numeric) - x.qty_from + 1) * x.amount_per_unit END AS f
        FROM q
        LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                            WHERE t.program_product_id = q.program_product_id AND t.qty_from <= q.q
                            ORDER BY t.qty_from DESC LIMIT 1) x ON true
        LEFT JOIN tc ON tc.program_product_id = q.program_product_id AND tc.tier_order = x.tier_order
    )
    SELECT EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN fq ON fq.program_product_id = r.program_product_id AND fq.q = r.cms_quantity
       WHERE r.run_id = p_run_id
         AND (NOT COALESCE(r.cms_quantity::numeric * r.per_unit <= r.eligible_base
                           AND r.eligible_base < (r.cms_quantity::numeric + 1) * r.per_unit, false)
              OR fq.f IS NULL OR r.potential_amount::numeric IS DISTINCT FROM fq.f
              OR r.amount_vnd IS DISTINCT FROM (CASE WHEN r.gate_met THEN r.potential_amount ELSE 0 END)))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TIER_AMOUNT'); END IF;
  ELSIF p_step = 9 THEN
    -- N6 gate SP theo GMV RÒNG cộng dồn theo seq sự kiện; đạt = cuối kỳ ≥ target; "đạt từ" = lần chuyển chưa đạt → đạt CUỐI (net.ts
    -- trackGate). SP không gate: luôn đạt, không GMV gate / target / mốc.
    WITH l AS (
      SELECT e.user_id, e.program_product_id, e.seq, e.event_at, e.gmv_delta, r.target_gmv
        FROM public.cms_result_events e
        JOIN public.cms_results r ON r.run_id = e.run_id AND r.user_id = e.user_id AND r.program_product_id = e.program_product_id
       WHERE e.run_id = p_run_id AND r.gmv_basis = 'product'
    ), c AS (
      SELECT l.*, (sum(l.gmv_delta) OVER (PARTITION BY l.user_id, l.program_product_id ORDER BY l.seq)) >= l.target_gmv AS met FROM l
    ), x AS (
      SELECT c.*, COALESCE(lag(c.met) OVER (PARTITION BY c.user_id, c.program_product_id ORDER BY c.seq), false) AS prev_met FROM c
    ), g AS (
      SELECT user_id, program_product_id, sum(gmv_delta) AS gmv, (array_agg(met ORDER BY seq DESC))[1] AS final_met,
             max(event_at) FILTER (WHERE met AND NOT prev_met) AS last_cross
        FROM x GROUP BY user_id, program_product_id
    )
    SELECT EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN g ON g.user_id = r.user_id AND g.program_product_id = r.program_product_id
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'product'
         AND (g.user_id IS NULL OR r.gate_gmv IS DISTINCT FROM g.gmv OR r.gate_met IS DISTINCT FROM g.final_met
              OR r.gate_met_at IS DISTINCT FROM (CASE WHEN g.final_met THEN g.last_cross END)))
    OR EXISTS (
      SELECT 1 FROM public.cms_results r
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'none'
         AND NOT COALESCE(r.gate_met AND r.gate_gmv IS NULL AND r.target_gmv IS NULL AND r.gate_met_at IS NULL, false))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_GATE'); END IF;
  ELSIF p_step = 10 THEN
    -- N7 gate danh mục theo dược sĩ: GMV ròng mọi sự kiện của SP danh mục, theo seq; line_count = số sự kiện (bán + trả); kết quả SP
    -- danh mục mang đúng gate của dược sĩ.
    WITH l AS (
      SELECT e.user_id, e.seq, e.event_at, e.gmv_delta, r.store_id
        FROM public.cms_result_events e
        JOIN public.cms_results r ON r.run_id = e.run_id AND r.user_id = e.user_id AND r.program_product_id = e.program_product_id
       WHERE e.run_id = p_run_id AND r.gmv_basis = 'catalog'
    ), c AS (
      SELECT l.*, (sum(l.gmv_delta) OVER (PARTITION BY l.user_id ORDER BY l.seq)) >= v_prog.catalog_target_gmv AS met FROM l
    ), x AS (
      SELECT c.*, COALESCE(lag(c.met) OVER (PARTITION BY c.user_id ORDER BY c.seq), false) AS prev_met FROM c
    ), g AS (
      SELECT user_id, sum(gmv_delta) AS gmv, count(*) AS n, (array_agg(met ORDER BY seq DESC))[1] AS final_met,
             max(event_at) FILTER (WHERE met AND NOT prev_met) AS last_cross,
             min(store_id::text) AS s1, max(store_id::text) AS s2
        FROM x GROUP BY user_id
    )
    SELECT EXISTS (
      SELECT 1 FROM g FULL JOIN (SELECT * FROM public.cms_result_catalog WHERE run_id = p_run_id) k ON k.user_id = g.user_id
       WHERE g.user_id IS NULL OR k.user_id IS NULL
          OR (k.catalog_gmv, k.line_count::bigint, k.met, k.store_id::text, k.store_id::text)
             IS DISTINCT FROM (g.gmv, g.n, g.final_met, g.s1, g.s2)
          OR k.target_gmv IS DISTINCT FROM v_prog.catalog_target_gmv
          OR k.met_at IS DISTINCT FROM (CASE WHEN g.final_met THEN g.last_cross END))
    OR EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN public.cms_result_catalog k ON k.run_id = r.run_id AND k.user_id = r.user_id
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'catalog'
         AND (k.user_id IS NULL OR (r.gate_gmv, r.gate_met, r.gate_met_at) IS DISTINCT FROM (k.catalog_gmv, k.met, k.met_at)))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_CATALOG'); END IF;
  ELSIF p_step = 11 THEN
    -- N8 phân bổ từng sự kiện: B đủ trước = Σ delta trước theo seq trong nhóm (CHECK bảng ép sau = trước + delta, ≥ 0); Q trước /
    -- sau; tiền = gate ? F(Q_sau) − F(Q_trước) : 0; trạng thái đúng thứ tự net.ts.
    WITH l AS (
      SELECT e.*, r.per_unit, r.gate_met,
             COALESCE(sum(e.eligible_delta) OVER (PARTITION BY e.user_id, e.program_product_id ORDER BY e.seq
                                                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS exp_before
        FROM public.cms_result_events e
        JOIN public.cms_results r ON r.run_id = e.run_id AND r.user_id = e.user_id AND r.program_product_id = e.program_product_id
       WHERE e.run_id = p_run_id
    ), tc AS (
      SELECT t.program_product_id, t.tier_order,
             COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                      ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM public.cms_program_tiers t WHERE t.program_id = v_run.program_id
    ), q AS (
      SELECT program_product_id, qty_before AS q FROM l WHERE gate_met
      UNION
      SELECT program_product_id, qty_after FROM l WHERE gate_met
    ), fq AS (
      SELECT q.program_product_id, q.q,
             CASE WHEN q.q <= 0 OR x.tier_order IS NULL THEN 0
                  ELSE tc.cum_before + (LEAST(q.q::numeric, COALESCE(x.qty_to, q.q)::numeric) - x.qty_from + 1) * x.amount_per_unit END AS f
        FROM q
        LEFT JOIN LATERAL (SELECT t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit FROM public.cms_program_tiers t
                            WHERE t.program_product_id = q.program_product_id AND t.qty_from <= q.q
                            ORDER BY t.qty_from DESC LIMIT 1) x ON true
        LEFT JOIN tc ON tc.program_product_id = q.program_product_id AND tc.tier_order = x.tier_order
    ), f AS (
      SELECT l.*, fa.f AS f_after, fb.f AS f_before
        FROM l
        LEFT JOIN fq fa ON l.gate_met AND fa.program_product_id = l.program_product_id AND fa.q = l.qty_after
        LEFT JOIN fq fb ON l.gate_met AND fb.program_product_id = l.program_product_id AND fb.q = l.qty_before
    )
    SELECT EXISTS (
      SELECT 1 FROM f
       WHERE f.eligible_before IS DISTINCT FROM f.exp_before
          OR NOT COALESCE(f.qty_before::numeric * f.per_unit <= f.eligible_before
                          AND f.eligible_before < (f.qty_before::numeric + 1) * f.per_unit, false)
          OR NOT COALESCE(f.qty_after::numeric * f.per_unit <= f.eligible_after
                          AND f.eligible_after < (f.qty_after::numeric + 1) * f.per_unit, false)
          OR (f.gate_met AND (f.f_after IS NULL OR f.f_before IS NULL))
          OR f.amount_vnd::numeric IS DISTINCT FROM (CASE WHEN f.gate_met THEN f.f_after - f.f_before ELSE 0 END)
          OR f.status IS DISTINCT FROM (
               CASE WHEN f.kind = 'SALE' THEN
                      CASE WHEN f.quantity_class NOT IN ('POS_BASE', 'COUNTED') THEN 'NOT_COUNTED'
                           WHEN NOT f.gate_met THEN 'WAITING_GATE'
                           WHEN f.amount_vnd > 0 THEN 'RECORDED'
                           ELSE 'ACCUMULATING' END
                    WHEN NOT f.gate_met AND f.eligible_delta <> 0 THEN 'WAITING_GATE'
                    WHEN f.amount_vnd < 0 THEN 'RETURN_REDUCED'
                    ELSE 'RETURN_NO_CHANGE' END))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_LINE_ALLOC'); END IF;
  ELSIF p_step = 12 THEN
    -- N9 pin (@@SOURCE_PIN@@, r2 §4.3): contract mới không nhận dòng normalizer từ chối (PM r2 — fail-closed); phạm vi pin = kỳ + tập
    -- SP chương trình; digest @@SRC_DIGEST@@ DB tự tính trên lớp nguồn (và phiếu trả khi net) = pin. Mỗi dòng: token
    -- `<byte UTF-8>:<giá trị>` (NULL ⇒ `-`), số = đơn vị 10⁻⁹, thời điểm = µs UTC; sha256 từng dòng; digest = sha256 của
    -- version / loại / số dòng / hash dòng theo byte ID, nối bằng LF. Cùng hợp đồng TS (parity ở harness).
    IF (v_exp ->> 'rows_rejected')::bigint > 0 THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'SEAL_N9_REJECTED'); END IF;
    SELECT encode(sha256(convert_to('@@SRC_DIGEST@@' || E'\n' || 'products' || E'\n' || count(*)::text || E'\n'
                                    || COALESCE(string_agg(pp.product_id, E'\n' ORDER BY pp.product_id COLLATE "C"), ''), 'UTF8')), 'hex')
      INTO v_dig FROM public.cms_program_products pp WHERE pp.program_id = v_run.program_id;
    IF (v_exp -> 'pin' -> 'scope' ->> 'from')::date IS DISTINCT FROM v_prog.start_date
       OR (v_exp -> 'pin' -> 'scope' ->> 'to')::date IS DISTINCT FROM v_prog.end_date
       OR v_dig IS DISTINCT FROM v_exp -> 'pin' -> 'scope' ->> 'products_hash' THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PIN_SCOPE');
    END IF;
    SELECT encode(sha256(convert_to('@@SRC_DIGEST@@' || E'\n' || 'sales' || E'\n' || count(*)::text || E'\n'
                                    || COALESCE(string_agg(h.h, E'\n' ORDER BY h.id COLLATE "C"), ''), 'UTF8')), 'hex')
      INTO v_dig
      FROM (SELECT s.order_line_id AS id, encode(sha256(convert_to(
                     COALESCE(octet_length(s.order_line_id) || ':' || s.order_line_id, '-')
                  || COALESCE(octet_length(s.order_id) || ':' || s.order_id, '-')
                  || COALESCE(octet_length(s.order_code) || ':' || s.order_code, '-')
                  || COALESCE(octet_length(s.product_id) || ':' || s.product_id, '-')
                  || COALESCE(octet_length(s.seller_email) || ':' || s.seller_email, '-')
                  || COALESCE(octet_length(s.pos_code) || ':' || s.pos_code, '-')
                  || COALESCE(octet_length(s.order_type) || ':' || s.order_type, '-')
                  || COALESCE(octet_length(s.order_status) || ':' || s.order_status, '-')
                  || COALESCE(octet_length(n.c_at) || ':' || n.c_at, '-')
                  || COALESCE(octet_length(n.u_at) || ':' || n.u_at, '-')
                  || COALESCE(octet_length(s.quantity_src) || ':' || s.quantity_src, '-')
                  || COALESCE(octet_length(s.uom_src) || ':' || s.uom_src, '-')
                  || COALESCE(octet_length(s.quantity_src_flag) || ':' || s.quantity_src_flag, '-')
                  || COALESCE(octet_length(s.uom_src_flag) || ':' || s.uom_src_flag, '-')
                  || COALESCE(octet_length(n.b) || ':' || n.b, '-')
                  || COALESCE(octet_length(n.g) || ':' || n.g, '-'), 'UTF8')), 'hex') AS h
              FROM public.cms_sales_source_lines s
              CROSS JOIN LATERAL (SELECT trunc(extract(epoch FROM s.completed_at) * 1000000, 0)::text AS c_at,
                                         trunc(extract(epoch FROM s.source_updated_at) * 1000000, 0)::text AS u_at,
                                         trunc(s.base_quantity * 1000000000, 0)::text AS b,
                                         trunc(s.gmv_amount * 1000000000, 0)::text AS g) n
             WHERE s.run_id = p_run_id) h;
    IF v_dig IS DISTINCT FROM v_exp -> 'pin' -> 'sales' ->> 'staged_digest' THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PIN_DIGEST');
    END IF;
    IF v_net THEN
      SELECT encode(sha256(convert_to('@@SRC_DIGEST@@' || E'\n' || 'returns' || E'\n' || count(*)::text || E'\n'
                                      || COALESCE(string_agg(h.h, E'\n' ORDER BY h.id COLLATE "C"), ''), 'UTF8')), 'hex')
        INTO v_dig
        FROM (SELECT r.return_event_id AS id, encode(sha256(convert_to(
                       COALESCE(octet_length(r.return_event_id) || ':' || r.return_event_id, '-')
                    || COALESCE(octet_length(r.return_status) || ':' || r.return_status, '-')
                    || COALESCE(octet_length(r.return_document_id) || ':' || r.return_document_id, '-')
                    || COALESCE(octet_length(r.return_code) || ':' || r.return_code, '-')
                    || COALESCE(octet_length(n.rec) || ':' || n.rec, '-')
                    || COALESCE(octet_length(r.original_order_line_id) || ':' || r.original_order_line_id, '-')
                    || COALESCE(octet_length(r.original_order_id) || ':' || r.original_order_id, '-')
                    || COALESCE(octet_length(r.product_id) || ':' || r.product_id, '-')
                    || COALESCE(octet_length(n.rb) || ':' || n.rb, '-')
                    || COALESCE(octet_length(n.rg) || ':' || n.rg, '-')
                    || COALESCE(octet_length(n.oc) || ':' || n.oc, '-')
                    || COALESCE(octet_length(r.original_order_type) || ':' || r.original_order_type, '-')
                    || COALESCE(octet_length(r.original_order_status) || ':' || r.original_order_status, '-')
                    || COALESCE(octet_length(r.original_seller_email) || ':' || r.original_seller_email, '-')
                    || COALESCE(octet_length(r.original_pos_code) || ':' || r.original_pos_code, '-')
                    || COALESCE(octet_length(n.ob) || ':' || n.ob, '-')
                    || COALESCE(octet_length(n.og) || ':' || n.og, '-')
                    || COALESCE(octet_length(r.original_quantity_src) || ':' || r.original_quantity_src, '-')
                    || COALESCE(octet_length(r.original_uom_src) || ':' || r.original_uom_src, '-')
                    || COALESCE(octet_length(r.original_quantity_src_flag) || ':' || r.original_quantity_src_flag, '-')
                    || COALESCE(octet_length(r.original_uom_src_flag) || ':' || r.original_uom_src_flag, '-')
                    || COALESCE(octet_length(n.su) || ':' || n.su, '-'), 'UTF8')), 'hex') AS h
                FROM public.cms_return_lines r
                CROSS JOIN LATERAL (SELECT trunc(extract(epoch FROM r.recorded_at) * 1000000, 0)::text AS rec,
                                           trunc(r.return_base_quantity * 1000000000, 0)::text AS rb,
                                           trunc(r.return_gmv_amount * 1000000000, 0)::text AS rg,
                                           trunc(extract(epoch FROM r.original_completed_at) * 1000000, 0)::text AS oc,
                                           trunc(r.original_base_quantity * 1000000000, 0)::text AS ob,
                                           trunc(r.original_gmv_amount * 1000000000, 0)::text AS og,
                                           trunc(extract(epoch FROM r.source_updated_at) * 1000000, 0)::text AS su) n
               WHERE r.run_id = p_run_id) h;
      IF v_dig IS DISTINCT FROM v_exp -> 'pin' -> 'returns' ->> 'digest' THEN
        RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_PIN_DIGEST');
      END IF;
    END IF;
  ELSE
    -- N10 tổng tiền = khai báo, trong miền bigint; mọi khoá totals = dữ liệu (loại ngoài ứng viên đếm CHÍNH XÁC từ lớp nguồn); mốc
    -- nguồn ≥ mốc dòng nguồn. Rồi đóng seal: ghi pin / digest (đã kiểm ở N9) và cột trả của run net.
    SELECT COALESCE(sum(amount_vnd::numeric), 0) INTO v_sum FROM public.cms_results WHERE run_id = p_run_id;
    IF v_sum <> (v_exp ->> 'amount_vnd')::numeric OR v_sum > 9223372036854775807 THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TOTAL');
    END IF;
    WITH a AS (
      SELECT count(*) AS cand,
             count(*) FILTER (WHERE disposition = 'INCLUDED') AS inc,
             count(*) FILTER (WHERE disposition = 'UNASSIGNED') AS una,
             count(*) FILTER (WHERE disposition = 'OUT_OF_SCOPE') AS oos,
             COALESCE(sum(gmv_amount), 0) AS cgmv,
             COALESCE(sum(gmv_amount) FILTER (WHERE disposition = 'UNASSIGNED'), 0) AS ugmv,
             jsonb_build_object(
               'POS_BASE', count(*) FILTER (WHERE disposition = 'INCLUDED' AND quantity_class = 'POS_BASE'),
               'COUNTED', count(*) FILTER (WHERE disposition = 'INCLUDED' AND quantity_class = 'COUNTED'),
               'OTHER_UNIT', count(*) FILTER (WHERE disposition = 'INCLUDED' AND quantity_class = 'OTHER_UNIT'),
               'FRACTIONAL_QUANTITY', count(*) FILTER (WHERE disposition = 'INCLUDED' AND quantity_class = 'FRACTIONAL_QUANTITY'),
               'ZERO_QUANTITY', count(*) FILTER (WHERE disposition = 'INCLUDED' AND quantity_class = 'ZERO_QUANTITY')) AS cls
        FROM public.cms_sales_lines WHERE run_id = p_run_id
    ), s AS (
      SELECT count(*) AS n, max(s.source_updated_at) AS mx,
             count(*) FILTER (WHERE NOT (s.order_type = 'OFFLINE' AND s.order_status = 'COMPLETED')) AS ne,
             count(*) FILTER (WHERE s.order_type = 'OFFLINE' AND s.order_status = 'COMPLETED'
                                AND (s.completed_at < v_from OR s.completed_at >= v_to)) AS ow,
             count(*) FILTER (WHERE s.order_type = 'OFFLINE' AND s.order_status = 'COMPLETED'
                                AND s.completed_at >= v_from AND s.completed_at < v_to AND pp.id IS NULL) AS np
        FROM public.cms_sales_source_lines s
        LEFT JOIN public.cms_program_products pp ON pp.program_id = v_run.program_id AND pp.product_id = s.product_id
       WHERE s.run_id = p_run_id
    ), rt AS (
      SELECT count(*) AS n,
             count(*) FILTER (WHERE status_effect = 'NOT_EFFECTIVE') AS ne,
             count(*) FILTER (WHERE disposition = 'APPLIED') AS ap,
             COALESCE(sum(return_base_quantity) FILTER (WHERE disposition = 'APPLIED'), 0) AS rb,
             COALESCE(sum(return_gmv_amount) FILTER (WHERE disposition = 'APPLIED'), 0) AS rg
        FROM public.cms_return_lines WHERE run_id = p_run_id
    )
    SELECT EXISTS (
      SELECT 1 FROM a, s, rt
       WHERE (a.cand, a.inc, a.una, a.oos, a.cgmv, a.ugmv, s.n, rt.n, rt.ne, rt.ap, rt.rb, rt.rg)
             IS DISTINCT FROM ((v_exp -> 'totals' ->> 'candidates')::bigint, (v_exp -> 'totals' ->> 'included')::bigint,
                               (v_exp -> 'totals' ->> 'unassigned')::bigint, (v_exp -> 'totals' ->> 'out_of_scope')::bigint,
                               (v_exp -> 'totals' ->> 'candidate_gmv')::numeric, (v_exp -> 'totals' ->> 'unassigned_gmv')::numeric,
                               (v_exp -> 'totals' ->> 'lines_read')::bigint, (v_exp -> 'totals' ->> 'returns_read')::bigint,
                               (v_exp -> 'totals' ->> 'returns_not_effective')::bigint, (v_exp -> 'totals' ->> 'returns_applied')::bigint,
                               (v_exp -> 'totals' ->> 'return_base_applied')::numeric,
                               (v_exp -> 'totals' ->> 'return_gmv_applied')::numeric)
          OR a.cls IS DISTINCT FROM v_exp -> 'totals' -> 'class_counts'
          OR jsonb_strip_nulls(jsonb_build_object('ORDER_NOT_ELIGIBLE', NULLIF(s.ne, 0), 'OUT_OF_WINDOW', NULLIF(s.ow, 0),
                                                  'PRODUCT_NOT_IN_PROGRAM', NULLIF(s.np, 0), 'UNASSIGNED', NULLIF(a.una, 0),
                                                  'OUT_OF_SCOPE', NULLIF(a.oos, 0)))
             IS DISTINCT FROM v_exp -> 'totals' -> 'excluded_by_reason'
          OR COALESCE((SELECT jsonb_object_agg(g.unassigned_reason, g.n) FROM (
                         SELECT unassigned_reason, count(*) AS n FROM public.cms_sales_lines
                          WHERE run_id = p_run_id AND disposition = 'UNASSIGNED' GROUP BY unassigned_reason) g), '{}'::jsonb)
             IS DISTINCT FROM v_exp -> 'totals' -> 'unassigned_by_reason'
          OR COALESCE((SELECT jsonb_object_agg(g.disposition, g.n) FROM (
                         SELECT disposition, count(*) AS n FROM public.cms_return_lines
                          WHERE run_id = p_run_id AND disposition <> 'APPLIED' GROUP BY disposition) g), '{}'::jsonb)
             IS DISTINCT FROM v_exp -> 'totals' -> 'returns_excluded_by_reason'
          OR (s.mx IS NOT NULL AND (v_exp ->> 'source_max_updated_at') IS NULL)
          OR (s.mx IS NOT NULL AND (v_exp ->> 'source_max_updated_at')::timestamptz < s.mx))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TOTALS'); END IF;
    UPDATE public.cms_sync_runs SET
      seal_step = 13,
      sealed_at = now(),
      amount_vnd = v_sum::bigint,
      rows_read = (v_exp ->> 'rows_read')::integer,
      rows_rejected = (v_exp ->> 'rows_rejected')::integer,
      bytes_processed = NULLIF(v_exp ->> 'bytes_processed', '')::bigint,
      source_max_updated_at = NULLIF(v_exp ->> 'source_max_updated_at', '')::timestamptz,
      detail = detail || jsonb_build_object('totals', v_exp -> 'totals'),
      source_pin = v_exp -> 'pin',
      sales_src_digest = v_exp -> 'pin' -> 'sales' ->> 'staged_digest',
      returns_as_of = CASE WHEN v_net THEN (v_exp -> 'pin' ->> 'as_of')::timestamptz END,
      returns_digest = CASE WHEN v_net THEN v_exp -> 'pin' -> 'returns' ->> 'digest' END,
      returns_rows_read = CASE WHEN v_net THEN (v_exp -> 'pin' -> 'returns' ->> 'rows')::integer END
    WHERE id = p_run_id;
    RETURN jsonb_build_object('sealed', true, 'step', 13, 'amount_vnd', v_sum::text);
  END IF;
  UPDATE public.cms_sync_runs SET seal_step = p_step WHERE id = p_run_id;
  RETURN jsonb_build_object('sealed', false, 'ok', true, 'step', p_step);
END;
$$;
