
-- ── 3. Run contract: cột run + ràng buộc thay (thiết kế r2 §5.1 / r2.1 §14.3) ──
-- Run contract ⇔ chương trình cms_unit HOẶC net_returns_v1 lúc open (ghim từ chương trình, không từ caller). Run legacy
-- (pos_base + sales_only_v1, gồm T11) giữ mọi cột mới NULL và đường 122–126 nguyên hành vi.
ALTER TABLE public.cms_sync_runs
  ADD COLUMN quantity_basis            text,
  ADD COLUMN quantity_policy_version   text,
  ADD COLUMN returns_policy            text,
  ADD COLUMN calc_contract_version     text,
  ADD COLUMN unit_key_version          text,
  ADD COLUMN status_dictionary_version text,
  ADD COLUMN source_pin                jsonb       CHECK (source_pin IS NULL OR jsonb_typeof(source_pin) = 'object'),
  ADD COLUMN sales_src_digest          text        CHECK (sales_src_digest IS NULL OR sales_src_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN returns_as_of             timestamptz CHECK (returns_as_of IS NULL OR isfinite(returns_as_of)),
  ADD COLUMN returns_digest            text        CHECK (returns_digest IS NULL OR returns_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN returns_rows_read         integer     CHECK (returns_rows_read IS NULL OR returns_rows_read >= 0),
  ADD COLUMN ledger_verdict            text        CHECK (ledger_verdict IS NULL OR ledger_verdict IN ('CLEAN', 'MISMATCH', 'OPEN_CONFLICT_MATCH')),
  ADD COLUMN ledger_set_hash           text        CHECK (ledger_set_hash IS NULL OR ledger_set_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN ledger_checked_at         timestamptz,
  ADD COLUMN ledger_eval_seq           bigint      CHECK (ledger_eval_seq IS NULL OR ledger_eval_seq >= 1);
-- Mọi vế CHECK dưới đây là boolean KHÔNG NULL (r2.1 §14.3): so sánh có thể NULL bọc IS [NOT] DISTINCT FROM.
ALTER TABLE public.cms_sync_runs
  ADD CONSTRAINT cms_sync_runs_contract_shape CHECK (
    (quantity_basis IS NULL AND quantity_policy_version IS NULL AND returns_policy IS NULL AND calc_contract_version IS NULL
       AND unit_key_version IS NULL AND status_dictionary_version IS NULL)
    OR (kind = 'sales' AND quantity_basis IS NOT NULL AND quantity_policy_version IS NOT NULL AND returns_policy IS NOT NULL
        AND calc_contract_version IS NOT NULL AND unit_key_version IS NOT NULL AND status_dictionary_version IS NOT NULL
        AND ((quantity_basis = 'pos_base' AND quantity_policy_version = '@@QPV_POS@@')
             OR (quantity_basis = 'cms_unit' AND quantity_policy_version = '@@QPV_UNIT@@'))
        AND returns_policy IN ('sales_only_v1', 'net_returns_v1')
        AND (quantity_basis = 'cms_unit' OR returns_policy = 'net_returns_v1')
        AND calc_contract_version = '@@CALC_CONTRACT@@' AND unit_key_version = '@@UNIT_KEY_VERSION@@'
        AND status_dictionary_version = '@@STATUS_VERSION@@')),
  -- Cột trả CHỈ ở run net đã seal (run sales-only không có "0 phiếu trả" giả).
  ADD CONSTRAINT cms_sync_runs_returns_shape CHECK (
    (returns_policy IS DISTINCT FROM 'net_returns_v1' AND returns_as_of IS NULL AND returns_digest IS NULL AND returns_rows_read IS NULL)
    OR (returns_policy IS NOT DISTINCT FROM 'net_returns_v1'
        AND (sealed_at IS NULL) = (returns_as_of IS NULL) AND (sealed_at IS NULL) = (returns_digest IS NULL)
        AND (sealed_at IS NULL) = (returns_rows_read IS NULL))),
  ADD CONSTRAINT cms_sync_runs_contract_sealed CHECK (
    (calc_contract_version IS NULL AND source_pin IS NULL AND sales_src_digest IS NULL)
    OR (calc_contract_version IS NOT NULL AND (sealed_at IS NULL) = (source_pin IS NULL) AND (sealed_at IS NULL) = (sales_src_digest IS NULL))),
  ADD CONSTRAINT cms_sync_runs_ledger_shape CHECK (
    (ledger_verdict IS NULL) = (ledger_set_hash IS NULL) AND (ledger_verdict IS NULL) = (ledger_checked_at IS NULL)
    AND (ledger_verdict IS NULL OR calc_contract_version IS NOT NULL)
    AND (ledger_eval_seq IS NULL OR (ledger_verdict IS NOT NULL AND returns_policy IS NOT DISTINCT FROM 'net_returns_v1'))),
  -- r2 P1-3 / r2.1 §14.3: run contract công bố ⇒ ledger sạch (verdict NULL không được lọt).
  ADD CONSTRAINT cms_sync_runs_contract_ok CHECK (
    calc_contract_version IS NULL OR status IS DISTINCT FROM 'ok'
    OR (ledger_verdict IS NOT DISTINCT FROM 'CLEAN' AND ledger_set_hash IS NOT NULL AND ledger_checked_at IS NOT NULL
        AND (returns_policy IS DISTINCT FROM 'net_returns_v1' OR ledger_eval_seq IS NOT NULL)));
-- Thay 2 ràng buộc 122: bước seal 0…13 (13 chỉ ở run contract); đã seal ⇒ đủ bước theo loại run.
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_seal_step_check;
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_seal_step_check CHECK (
  seal_step IS NULL OR (seal_step BETWEEN 0 AND 13 AND (calc_contract_version IS NOT NULL OR seal_step <= 10)));
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_sales_publish;
ALTER TABLE public.cms_sync_runs ADD CONSTRAINT cms_sync_runs_sales_publish CHECK (kind <> 'sales' OR (
  ((status = 'ok') = (published_at IS NOT NULL))
  AND (published_at IS NULL OR (sealed_at IS NOT NULL AND amount_vnd IS NOT NULL))
  AND (sealed_at IS NULL OR (seal_expect IS NOT NULL
                             AND seal_step IS NOT DISTINCT FROM (CASE WHEN calc_contract_version IS NULL THEN 10 ELSE 13 END)))
  AND (purged_at IS NULL OR status <> 'running')
  AND (cleared_at IS NULL OR purged_at IS NOT NULL)));
-- Thay part check 124: thêm 2 part của run contract (loại trừ chéo theo loại run kiểm ở stage / seal_begin).
ALTER TABLE public.cms_sync_run_chunks DROP CONSTRAINT cms_sync_run_chunks_part_check;
ALTER TABLE public.cms_sync_run_chunks ADD CONSTRAINT cms_sync_run_chunks_part_check
  CHECK (part IN ('sales_lines', 'results', 'catalog', 'result_lines', 'source_lines', 'return_lines', 'result_events'));

-- ── 4. Lớp bán: chuỗi THÔ q / u ở cả hai lớp + lớp lượng (thiết kế r2 §4.1 / §5.3) ──
-- src_v = 1 ⇔ dòng của run contract (capture thô trước làm sạch). Có cờ NUL / OVERSIZE ⇒ thô + sạch NULL; không thô, không cờ ⇒ sạch
-- NULL. Sạch = cms__src_clean(thô) do seal N1 đối chiếu trên tập DISTINCT (không gọi hàm theo dòng ở CHECK).
ALTER TABLE public.cms_sales_source_lines
  ADD COLUMN src_v              smallint CHECK (src_v IS NULL OR src_v = 1),
  ADD COLUMN quantity_src       text     CHECK (quantity_src IS NULL OR char_length(quantity_src) <= @@SRC_MAX@@),
  ADD COLUMN uom_src            text     CHECK (uom_src IS NULL OR char_length(uom_src) <= @@SRC_MAX@@),
  ADD COLUMN quantity_src_flag  text     CHECK (quantity_src_flag IS NULL OR quantity_src_flag IN ('NUL', 'OVERSIZE')),
  ADD COLUMN uom_src_flag       text     CHECK (uom_src_flag IS NULL OR uom_src_flag IN ('NUL', 'OVERSIZE')),
  ADD CONSTRAINT cms_sales_source_lines_src CHECK (
    (src_v IS NULL AND quantity_src IS NULL AND uom_src IS NULL AND quantity_src_flag IS NULL AND uom_src_flag IS NULL)
    OR (src_v IS NOT DISTINCT FROM 1
        AND (quantity_src_flag IS NULL OR (quantity_src IS NULL AND quantity_raw IS NULL))
        AND (uom_src_flag IS NULL OR (uom_src IS NULL AND uom_raw IS NULL))
        AND (quantity_src IS NOT NULL OR quantity_src_flag IS NOT NULL OR quantity_raw IS NULL)
        AND (uom_src IS NOT NULL OR uom_src_flag IS NOT NULL OR uom_raw IS NULL)));
ALTER TABLE public.cms_sales_lines
  ADD COLUMN src_v              smallint CHECK (src_v IS NULL OR src_v = 1),
  ADD COLUMN quantity_src       text     CHECK (quantity_src IS NULL OR char_length(quantity_src) <= @@SRC_MAX@@),
  ADD COLUMN uom_src            text     CHECK (uom_src IS NULL OR char_length(uom_src) <= @@SRC_MAX@@),
  ADD COLUMN quantity_src_flag  text     CHECK (quantity_src_flag IS NULL OR quantity_src_flag IN ('NUL', 'OVERSIZE')),
  ADD COLUMN uom_src_flag       text     CHECK (uom_src_flag IS NULL OR uom_src_flag IN ('NUL', 'OVERSIZE')),
  ADD COLUMN quantity_class     text     CHECK (quantity_class IS NULL
                                                OR quantity_class IN ('POS_BASE', 'COUNTED', 'OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY')),
  ADD COLUMN eligible_base      numeric  CHECK (eligible_base IS NULL OR (eligible_base >= 0 AND scale(eligible_base) <= 9)),
  ADD CONSTRAINT cms_sales_lines_src CHECK (
    (src_v IS NULL AND quantity_src IS NULL AND uom_src IS NULL AND quantity_src_flag IS NULL AND uom_src_flag IS NULL
       AND quantity_class IS NULL AND eligible_base IS NULL)
    OR (src_v IS NOT DISTINCT FROM 1
        AND (quantity_src_flag IS NULL OR (quantity_src IS NULL AND quantity_raw IS NULL))
        AND (uom_src_flag IS NULL OR (uom_src IS NULL AND uom_raw IS NULL))
        AND (quantity_src IS NOT NULL OR quantity_src_flag IS NOT NULL OR quantity_raw IS NULL)
        AND (uom_src IS NOT NULL OR uom_src_flag IS NOT NULL OR uom_raw IS NULL)
        -- Dòng bán của run contract không âm (âm ⇒ HOLD trước stage) và lớp lượng nhất quán với B đủ điều kiện.
        AND base_quantity >= 0 AND gmv_amount >= 0
        AND quantity_class IS NOT NULL AND eligible_base IS NOT NULL
        AND ((quantity_class IN ('POS_BASE', 'COUNTED') AND eligible_base = base_quantity)
             OR (quantity_class IN ('OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY') AND eligible_base = 0))));

-- Nhóm kết quả: cột ròng (run contract). base_quantity = B thật ròng; gmv_amount = GMV ròng; eligible_base = B đủ ròng (Q tính trên đây).
ALTER TABLE public.cms_results
  ADD COLUMN net_v                smallint CHECK (net_v IS NULL OR net_v = 1),
  ADD COLUMN sale_base            numeric,
  ADD COLUMN return_base          numeric,
  ADD COLUMN eligible_sale_base   numeric,
  ADD COLUMN eligible_return_base numeric,
  ADD COLUMN eligible_base        numeric,
  ADD COLUMN counted_sale_qty     bigint,
  ADD COLUMN sale_gmv             numeric,
  ADD COLUMN return_gmv           numeric,
  ADD COLUMN return_count         integer,
  ADD CONSTRAINT cms_results_net CHECK (
    (net_v IS NULL AND sale_base IS NULL AND return_base IS NULL AND eligible_sale_base IS NULL AND eligible_return_base IS NULL
       AND eligible_base IS NULL AND counted_sale_qty IS NULL AND sale_gmv IS NULL AND return_gmv IS NULL AND return_count IS NULL)
    OR (net_v IS NOT DISTINCT FROM 1
        AND sale_base IS NOT NULL AND return_base IS NOT NULL AND eligible_sale_base IS NOT NULL AND eligible_return_base IS NOT NULL
        AND eligible_base IS NOT NULL AND sale_gmv IS NOT NULL AND return_gmv IS NOT NULL AND return_count IS NOT NULL
        AND sale_base >= 0 AND return_base >= 0 AND eligible_sale_base >= 0 AND eligible_return_base >= 0 AND eligible_base >= 0
        AND sale_gmv >= 0 AND return_gmv >= 0 AND return_count >= 0 AND (counted_sale_qty IS NULL OR counted_sale_qty >= 0)
        AND eligible_sale_base <= sale_base AND eligible_return_base <= return_base
        AND base_quantity = sale_base - return_base AND gmv_amount = sale_gmv - return_gmv
        AND eligible_base = eligible_sale_base - eligible_return_base
        AND scale(sale_base) <= 9 AND scale(return_base) <= 9 AND scale(eligible_base) <= 9 AND scale(sale_gmv) <= 9
        AND scale(return_gmv) <= 9
        -- Thang 125 luôn mở bậc cuối ⇒ không trần; run contract không dùng trường trần cũ.
        AND cap_quantity IS NULL AND NOT at_cap AND rewarded_quantity = cms_quantity));

-- ── 5. Bảng run contract (dọn theo run, guard 123 / 124) ───────────────────
-- Phiếu trả của snapshot: MỌI dòng provider trả (đã chuẩn hoá) + disposition DB tự suy lại ở seal N2. Chưa hiệu lực ⇒ chỉ id +
-- trạng thái. Hiệu lực ⇒ đủ trường tài chính / lineage / ngữ cảnh dòng gốc.
CREATE TABLE public.cms_return_lines (
  run_id                     uuid        NOT NULL,
  program_id                 uuid        NOT NULL,
  return_event_id            text        NOT NULL CHECK (return_event_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  seq                        integer     NOT NULL CHECK (seq >= 0),
  return_status              text        NOT NULL CHECK (char_length(return_status) BETWEEN 1 AND 30),
  status_effect              text        NOT NULL CHECK (status_effect IN ('EFFECTIVE', 'NOT_EFFECTIVE')),
  return_document_id         text        CHECK (return_document_id IS NULL OR return_document_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  return_code                text        CHECK (return_code IS NULL OR return_code ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  recorded_at                timestamptz CHECK (recorded_at IS NULL OR isfinite(recorded_at)),
  original_order_line_id     text        CHECK (original_order_line_id IS NULL OR original_order_line_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  original_order_id          text        CHECK (original_order_id IS NULL OR original_order_id ~ '^[^\x01-\x1f\x7f-\x9f]{1,100}$'),
  product_id                 text        CHECK (product_id IS NULL OR product_id ~ '^[1-9][0-9]{0,18}$'),
  return_base_quantity       numeric     CHECK (return_base_quantity IS NULL
                                                OR (return_base_quantity > 0 AND scale(return_base_quantity) = 0 AND return_base_quantity < 1e29)),
  return_gmv_amount          numeric     CHECK (return_gmv_amount IS NULL
                                                OR (return_gmv_amount >= 0 AND scale(return_gmv_amount) <= 9 AND return_gmv_amount < 1e20)),
  original_completed_at      timestamptz CHECK (original_completed_at IS NULL OR isfinite(original_completed_at)),
  original_order_type        text        CHECK (original_order_type IS NULL OR char_length(original_order_type) BETWEEN 1 AND 30),
  original_order_status      text        CHECK (original_order_status IS NULL OR char_length(original_order_status) BETWEEN 1 AND 30),
  original_seller_email      text        CHECK (original_seller_email IS NULL OR (char_length(original_seller_email) BETWEEN 1 AND 320
                                                AND original_seller_email = lower(original_seller_email))),
  original_pos_code          text        CHECK (original_pos_code IS NULL OR char_length(original_pos_code) BETWEEN 1 AND 50),
  original_base_quantity     numeric     CHECK (original_base_quantity IS NULL OR (abs(original_base_quantity) < 1e29 AND scale(original_base_quantity) <= 9)),
  original_gmv_amount        numeric     CHECK (original_gmv_amount IS NULL OR (abs(original_gmv_amount) < 1e20 AND scale(original_gmv_amount) <= 9)),
  original_quantity_src      text        CHECK (original_quantity_src IS NULL OR char_length(original_quantity_src) <= @@SRC_MAX@@),
  original_uom_src           text        CHECK (original_uom_src IS NULL OR char_length(original_uom_src) <= @@SRC_MAX@@),
  original_quantity_src_flag text        CHECK (original_quantity_src_flag IS NULL OR original_quantity_src_flag IN ('NUL', 'OVERSIZE')),
  original_uom_src_flag      text        CHECK (original_uom_src_flag IS NULL OR original_uom_src_flag IN ('NUL', 'OVERSIZE')),
  source_updated_at          timestamptz CHECK (source_updated_at IS NULL OR isfinite(source_updated_at)),
  disposition                text        NOT NULL CHECK (disposition IN ('APPLIED', 'NOT_COMPLETED', 'ORIGIN_NOT_ELIGIBLE',
                                           'ORIGIN_OUT_OF_WINDOW', 'ORIGIN_NOT_IN_PROGRAM', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE')),
  sale_ref_line_id           text,
  PRIMARY KEY (run_id, return_event_id),
  CONSTRAINT cms_return_lines_seq UNIQUE (run_id, seq),
  CONSTRAINT cms_return_lines_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_return_lines_sale_fk FOREIGN KEY (run_id, sale_ref_line_id) REFERENCES public.cms_sales_lines (run_id, order_line_id),
  CONSTRAINT cms_return_lines_effect CHECK (status_effect IS NOT DISTINCT FROM public.cms__return_status_effect(return_status)),
  CONSTRAINT cms_return_lines_shape CHECK (
    (status_effect = 'NOT_EFFECTIVE' AND disposition = 'NOT_COMPLETED' AND sale_ref_line_id IS NULL
       AND return_document_id IS NULL AND return_code IS NULL AND recorded_at IS NULL AND original_order_line_id IS NULL
       AND original_order_id IS NULL AND product_id IS NULL AND return_base_quantity IS NULL AND return_gmv_amount IS NULL
       AND original_completed_at IS NULL AND original_order_type IS NULL AND original_order_status IS NULL
       AND original_seller_email IS NULL AND original_pos_code IS NULL AND original_base_quantity IS NULL
       AND original_gmv_amount IS NULL AND original_quantity_src IS NULL AND original_uom_src IS NULL
       AND original_quantity_src_flag IS NULL AND original_uom_src_flag IS NULL AND source_updated_at IS NULL)
    OR (status_effect = 'EFFECTIVE' AND disposition <> 'NOT_COMPLETED'
        AND return_document_id IS NOT NULL AND recorded_at IS NOT NULL AND original_order_line_id IS NOT NULL
        AND original_order_id IS NOT NULL AND product_id IS NOT NULL AND return_base_quantity IS NOT NULL
        AND return_gmv_amount IS NOT NULL AND original_completed_at IS NOT NULL AND original_order_type IS NOT NULL
        AND original_order_status IS NOT NULL AND original_base_quantity IS NOT NULL AND original_gmv_amount IS NOT NULL
        -- source_updated_at của phiếu COMPLETED được NULL (returns.ts: nguồn có thể không có mốc cập nhật — r2 §4.2 không bắt buộc).
        AND (original_quantity_src_flag IS NULL OR original_quantity_src IS NULL)
        AND (original_uom_src_flag IS NULL OR original_uom_src IS NULL)
        AND (sale_ref_line_id IS NOT NULL) = (disposition IN ('APPLIED', 'ORIGIN_UNASSIGNED', 'ORIGIN_OUT_OF_SCOPE'))
        AND (sale_ref_line_id IS NULL OR sale_ref_line_id = original_order_line_id))));
CREATE INDEX cms_return_lines_sale_idx ON public.cms_return_lines (run_id, sale_ref_line_id) WHERE sale_ref_line_id IS NOT NULL;
CREATE INDEX cms_return_lines_origin_idx ON public.cms_return_lines (run_id, original_order_line_id) WHERE original_order_line_id IS NOT NULL;

-- Sự kiện tính (SALE / RETURN) theo nhóm — thay cms_result_lines cho run contract. Khoá namespaced `SALE:<dòng>` / `RETURN:<phiếu>`.
CREATE TABLE public.cms_result_events (
  run_id             uuid        NOT NULL,
  program_id         uuid        NOT NULL,
  event_key          text        NOT NULL,
  seq                integer     NOT NULL CHECK (seq >= 0),
  kind               text        NOT NULL CHECK (kind IN ('SALE', 'RETURN')),
  event_at           timestamptz NOT NULL CHECK (isfinite(event_at)),
  order_line_id      text        NOT NULL,
  return_event_id    text,
  user_id            uuid        NOT NULL,
  program_product_id uuid        NOT NULL,
  quantity_class     text        NOT NULL CHECK (quantity_class IN ('POS_BASE', 'COUNTED', 'OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY')),
  base_delta         numeric     NOT NULL CHECK (abs(base_delta) < 1e29 AND scale(base_delta) <= 9),
  eligible_delta     numeric     NOT NULL CHECK (abs(eligible_delta) < 1e29 AND scale(eligible_delta) <= 9),
  gmv_delta          numeric     NOT NULL CHECK (abs(gmv_delta) < 1e20 AND scale(gmv_delta) <= 9),
  eligible_before    numeric     NOT NULL CHECK (eligible_before >= 0 AND scale(eligible_before) <= 9),
  eligible_after     numeric     NOT NULL CHECK (eligible_after >= 0 AND scale(eligible_after) <= 9),
  qty_before         bigint      NOT NULL CHECK (qty_before >= 0),
  qty_after          bigint      NOT NULL CHECK (qty_after >= 0),
  amount_vnd         bigint      NOT NULL,
  status             text        NOT NULL CHECK (status IN ('WAITING_GATE', 'ACCUMULATING', 'RECORDED', 'NOT_COUNTED',
                                                           'RETURN_REDUCED', 'RETURN_NO_CHANGE')),
  PRIMARY KEY (run_id, event_key),
  CONSTRAINT cms_result_events_seq UNIQUE (run_id, seq),
  CONSTRAINT cms_result_events_key CHECK (event_key = kind || ':' || COALESCE(return_event_id, order_line_id)),
  CONSTRAINT cms_result_events_kind CHECK ((kind = 'RETURN') = (return_event_id IS NOT NULL)),
  CONSTRAINT cms_result_events_sign CHECK (
    (kind = 'SALE' AND base_delta >= 0 AND eligible_delta >= 0 AND gmv_delta >= 0 AND amount_vnd >= 0
       AND status IN ('WAITING_GATE', 'ACCUMULATING', 'RECORDED', 'NOT_COUNTED'))
    OR (kind = 'RETURN' AND base_delta < 0 AND eligible_delta <= 0 AND gmv_delta <= 0 AND amount_vnd <= 0
        AND status IN ('WAITING_GATE', 'RETURN_REDUCED', 'RETURN_NO_CHANGE'))),
  CONSTRAINT cms_result_events_chain CHECK (eligible_after = eligible_before + eligible_delta AND qty_after >= 0),
  CONSTRAINT cms_result_events_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_result_events_sale_fk FOREIGN KEY (run_id, order_line_id) REFERENCES public.cms_sales_lines (run_id, order_line_id),
  CONSTRAINT cms_result_events_return_fk FOREIGN KEY (run_id, return_event_id) REFERENCES public.cms_return_lines (run_id, return_event_id),
  CONSTRAINT cms_result_events_result_fk FOREIGN KEY (run_id, user_id, program_product_id)
    REFERENCES public.cms_results (run_id, user_id, program_product_id)
);
-- Index phía FK (cleanup xoá cms_sales_lines / cms_return_lines / cms_results không quét toàn bảng) + keyset reader theo nhóm.
CREATE INDEX cms_result_events_sale_idx ON public.cms_result_events (run_id, order_line_id);
CREATE INDEX cms_result_events_return_idx ON public.cms_result_events (run_id, return_event_id) WHERE return_event_id IS NOT NULL;
CREATE INDEX cms_result_events_group_idx ON public.cms_result_events (run_id, user_id, program_product_id, seq);
-- Reader events_v2 cho người xem một dược sĩ: keyset theo seq trong phạm vi user (db-reviewer 14/11 P2-6).
CREATE INDEX cms_result_events_user_idx ON public.cms_result_events (run_id, user_id, seq);
-- excluded_v2 kind quantity: chỉ dòng INCLUDED bị loại theo lớp lượng — index từng phần, không quét cả run (db-reviewer 14/11 P2-6).
CREATE INDEX cms_sales_lines_qty_excluded_idx ON public.cms_sales_lines (run_id, seq)
  WHERE disposition = 'INCLUDED' AND quantity_class IN ('OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY');

ALTER TABLE public.cms_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_result_events ENABLE ROW LEVEL SECURITY;
-- Guard 123 / 124 như mọi bảng dữ liệu run: chỉ owner / RPC ghi; đóng băng khi run có payout; TRUNCATE khi có payout ⇒ từ chối.
CREATE TRIGGER cms_frozen_ins AFTER INSERT ON public.cms_return_lines REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_ins();
CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON public.cms_return_lines REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_upd();
CREATE TRIGGER cms_frozen_del AFTER DELETE ON public.cms_return_lines REFERENCING OLD TABLE AS cms_old
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_del();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_return_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_frozen_truncate BEFORE TRUNCATE ON public.cms_return_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_truncate_guard();
CREATE TRIGGER cms_frozen_ins AFTER INSERT ON public.cms_result_events REFERENCING NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_ins();
CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON public.cms_result_events REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_upd();
CREATE TRIGGER cms_frozen_del AFTER DELETE ON public.cms_result_events REFERENCING OLD TABLE AS cms_old
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_del();
CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_result_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__run_auth_guard();
CREATE TRIGGER cms_frozen_truncate BEFORE TRUNCATE ON public.cms_result_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_truncate_guard();
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND c.relname IN ('cms_return_lines', 'cms_result_events')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER %I', r.relname, r.tgname);
  END LOOP;
  -- Đủ 5 trigger ENABLE ALWAYS mỗi bảng (db-reviewer 14/11 P2-10).
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.cms_return_lines'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'A') <> 5
     OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.cms_result_events'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'A') <> 5 THEN
    RAISE EXCEPTION '130: trigger cms_return_lines / cms_result_events phải đủ 5 + 5 và ENABLE ALWAYS';
  END IF;
END $$;
