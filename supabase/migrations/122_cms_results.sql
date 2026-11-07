-- ============================================================================
-- 122_cms_results.sql  (r2.3 — DRAFT Dev sau PM audit 03/11 (GO kiến trúc draft) + db-reviewer r1 / r2 / r3 + security r1 / r2;
--                        CHƯA chạy prod)
-- r2.3 (PM 03/11 review P3a §3, delta riêng): trần lô rpc_cms_sales_run_cleanup 100.000 → 50.000 = CMS_CLEANUP_BATCH_ROWS của app —
--     lô 100.000 đo trên PG15 local khi máy tải vượt statement_timeout 8 s (11,1 s / 9,2 s cả khi không có trigger 123). Chỉ đổi
--     điều kiện đầu vào: 50.001 / 100.000 ⇒ CMS_SALES_BAD_INPUT trước khi ghi; mặc định 50.000 giữ nguyên.
-- r2.2: retention held / error tối đa 2 run gần nhất VÀ ≤ 24 h (PM §4); index tra bậc UNIQUE + preflight kiểm trùng (PM §5);
--     GET DIAGNOSTICS sát từng INSERT (R3-3). Ghi chú R3-4: kiểm cấu hình / mapping chạy ở ĐẦU mỗi bước seal (bỏ lần kiểm cuối
--     bước 10) — cửa sổ nhỏ trước khi đặt sealed_at an toàn vì publish kiểm lại dưới FOR UPDATE dòng chương trình + vân tay.
--     Giới hạn thiết kế: excluded_by_reason của 3 lý do không ứng viên chỉ đối chiếu TỔNG (dòng không ứng viên không lưu).
--     Tập giữ held / error của cleanup tính trong cùng câu lệnh chọn ứng viên (db-reviewer r2.2 P2-1); hậu kiểm index theo
--     cấu trúc pg_index (P2-2). VẬN HÀNH (P2-3): migration giữ ACCESS EXCLUSIVE trên cms_sync_runs / cms_programs và SHARE
--     trên cms_program_tiers (CREATE UNIQUE INDEX) tới COMMIT — chạy khi cờ CMS OFF, không có cron sync-cms-sales / import
--     121 đang chạy; dữ liệu bậc nhỏ ⇒ vài ms; lock_timeout hết ⇒ cả migration rollback sạch (không CONCURRENTLY trong
--     transaction).
-- r2.1: F(Q) ở seal bước 7 / 10 tính một lần cho mỗi cặp (SP, Q) qua index cms_program_tiers_product_from_idx; đầu mỗi bước
--     kiểm trạng thái / cấu hình / mapping (held đúng mã); gọi lại bước đã qua trả lại kết quả; jsonpath strict; bắt lỗi ép
--     kiểu ngày; totals whitelist + đối chiếu đủ; CHECK seal_pair; trần lô cleanup 100.000; purged_at đặt ở lô đầu + cleared_at;
--     cron bỏ qua chương trình thật khi cổng Q-206 đóng; ANALYZE (SKIP_LOCKED).
-- r2: seal tách seal_begin + seal_step 1…10 (mỗi RPC < statement_timeout 8 s của PostgREST, ANALYZE + enable_nestloop = off);
--     index FK tới cms_program_products; stage đọc jsonb_to_recordset; cổng Q-206 ở DB; cleanup theo lô + khoá chia sẻ;
--     đọc run hiện hành đã dọn ⇒ RUN_GONE; seal đối chiếu totals; lớp ký tự điều khiển tường minh; regex timestamp có miền.
-- Chạy SAU 121 (marker 121 = 'cms_import_activation'). So sánh số dạng CASE WHEN version ~ '^[0-9]+$' (luật 118a).
-- Batch CMS I1 / P2-b (planning/research/cms-consolidated-implementation-plan-2026-11-02.md §4; docs/cms/SPEC.md §3, §5–§7).
--
-- Mục đích: snapshot đầu vào + kết quả CMS theo phiên tính (run), công bố atomic bằng pointer
-- cms_programs.current_result_run_id; UI / export đọc qua RPC đã lọc quyền, ghim run_id. Engine TypeScript (lib/cms/engine)
-- là nơi DUY NHẤT tính tiền; SQL chỉ lưu và ĐỐI CHIẾU độc lập (seal) trước khi công bố — không ghi số do SQL tính.
--
-- Contract ghi (chỉ service_role; server kiểm cờ / quyền trước khi gọi):
--   rpc_cms_sales_snapshot(program)        → jsonb  cấu hình + users / stores để map + vân tay; CHỈ ĐỌC (dry-run)
--   rpc_cms_sales_run_open(program, detail)→ jsonb  khoá dòng chương trình; chỉ 'active' đã bắt đầu (ngày VN); 1 run
--                                                   running / chương trình (index 120 + khoá advisory); run treo > 30′
--                                                   ⇒ error STALE; chụp config_version / is_test / vân tay mapping;
--                                                   trả snapshot (cùng một câu lệnh ⇒ nhất quán) + run_id
--   rpc_cms_sales_run_stage(run, part, chunk_no, rows) → int  ghi một khối ≤ 5.000 dòng vào bảng part của run đang mở;
--                                                   cùng (part, chunk_no) gửi lại cùng digest ⇒ trả số cũ, KHÔNG nhân đôi;
--                                                   khác digest ⇒ CMS_STAGE_CHUNK_CONFLICT; run đã seal / treo ⇒ từ chối
--   rpc_cms_sales_run_seal_begin(run, expect) → jsonb  kiểm expect, cấu hình / mapping (đổi ⇒ held CONFIG_CHANGED /
--                                                   MAPPING_CHANGED), ANALYZE, đủ dòng / đủ khối; ĐÓNG BĂNG staging
--   rpc_cms_sales_run_seal_step(run, 1…10)  → jsonb  từng nhóm bất biến theo thứ tự: thứ tự dòng, kỳ / phạm vi, người bán,
--                                                   liên kết dòng, cấu hình, tổng nhóm, Q + F(Q), gate SP + "đạt từ", gate
--                                                   danh mục, phân bổ + trạng thái dòng + tổng tiền + totals; lệch ⇒ run
--                                                   error + mã SEAL_*; bước 10 đạt ⇒ sealed
--   rpc_cms_sales_run_publish(run)         → jsonb  transaction ngắn: khoá chương trình + run; cần sealed, chương trình
--                                                   'active' (locked ⇒ held PROGRAM_LOCKED), config_version / is_test /
--                                                   vân tay mapping không đổi, chương trình thật cần cổng Q-206 mở
--                                                   (cms__results_release_open, hiện false ⇒ held RESULTS_RELEASE_GATE) ⇒
--                                                   run 'ok' + đổi pointer MỘT lần; gọi lại ⇒ {already: true}
--   rpc_cms_sales_run_finish(run, status, detail) → void  đóng run held / error (bắt buộc mã), GIỮ pointer cũ
--   rpc_cms_sales_run_cleanup(program, max_rows) → jsonb dọn THEO LÔ dữ liệu run không còn đọc: giữ run hiện hành + run
--                                                   công bố liền trước; held / error giữ tối đa 2 run gần nhất VÀ ≤ 24 h;
--                                                   metadata run giữ (purged_at = bắt đầu dọn, cleared_at = dọn xong)
-- Contract đọc (authenticated, SECDEF; kiểm auth.uid() + cms_readable_program_ids() — marker QA kể cả super H9b — +
-- phạm vi HIỆN TẠI theo users / stores / sm_store_assignments; KHÔNG nhận user_id / store_id để tin):
--   rpc_cms_result_header(program)                          → run hiện hành, lần thử gần nhất (held / error), vai
--   rpc_cms_result_rows(program, run)                       → kết quả dược sĩ × SP + gate danh mục + tên staff trong phạm vi
--   rpc_cms_result_lines(program, run, pp, user, after, n)  → lịch sử dòng (D3 / XLSX), khoá thứ tự = seq của engine
--   rpc_cms_result_excluded(program, run, after, n)         → dòng chưa gán / ngoài phạm vi (CHỈ super, có email nguồn)
--   Phạm vi: super = mọi staff; staff = chính mình; QLCH (store_manager) = staff HIỆN thuộc store mình (OS active);
--   SM = staff HIỆN thuộc store OS active trong sm_store_assignments; admin thường / FS / ngoài phạm vi ⇒ CMS_RESULT_FORBIDDEN.
--   run_id truyền vào phải thuộc chương trình, đã công bố và chưa dọn — run staging / held / của chương trình khác ⇒
--   CMS_RESULT_RUN_GONE (không lộ sự tồn tại).
--
-- Bảng mới (RLS bật, KHÔNG policy, chỉ service_role): cms_sync_run_chunks, cms_sales_lines (CHỈ dòng ứng viên: INCLUDED /
-- UNASSIGNED / OUT_OF_SCOPE — dòng không ứng viên chỉ đếm theo lý do trong detail), cms_results, cms_result_catalog,
-- cms_result_lines. Không dữ liệu khách hàng; seller_email = email nguồn của dược sĩ (đã chuẩn hoá) để super đối soát.
-- Bảng cũ: cms_sync_runs (kind 'sales' + cột run tính), cms_programs.current_result_run_id (+ trigger bảo vệ pointer).
--
-- Không gọi cms__lock_catalog: 122 không đổi danh mục / ProductID (luật 121 áp cho đường ghi danh mục). Đồng bộ với ghi cấu
-- hình (121 khoá dòng chương trình FOR UPDATE + config_version + 1) bằng khoá dòng chương trình ở open / publish.
-- Đồ thị RLS: không policy mới; RPC đọc SECDEF (owner bypass RLS) gọi cms_readable_program_ids() ⇒ không vòng.
-- ACL: 8 rpc_cms_sales_* → service_role; 4 rpc_cms_result_* → authenticated; 11 helper cms__* (gồm 1 hàm trigger) không cấp
-- ai (chỉ owner gọi ⇒ chạy bằng CÙNG role owner với 120 / 121). Tổng 23 hàm.
-- Lưu ý vận hành: rpc_cms_sync_run_close (120) không lọc kind — service_role vẫn đóng được run sales sang held / error (bỏ
-- qua validate của finish); CHECK chặn đường lên 'ok' nên không hại pointer. Embed PostgREST giữa cms_programs ↔
-- cms_sync_runs giờ có 2 quan hệ ⇒ phải ghi rõ FK (!cms_sync_runs_program_id_fkey / !cms_programs_result_run_fk).
-- Tương thích: chỉ THÊM bảng / cột / hàm; app hiện hành (c0d3d3f, cờ CMS OFF) không đọc các đối tượng này. Ràng buộc mới
-- trên cms_sync_runs giữ hợp lệ mọi dòng 'products' sẵn có; rpc_cms_sync_run_close (120) KHÔNG đóng được run 'sales' thành
-- 'ok' (CHECK yêu cầu published_at).
-- KHÔNG chạy lại (preflight dừng nếu đã có 122). ROLLBACK: rollback/122_cms_results_rollback.sql (chỉ khi chưa có run sales
-- của chương trình thật).
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
BEGIN
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '121';
  IF v_name IS DISTINCT FROM 'cms_import_activation' THEN
    RAISE EXCEPTION '122: thiếu migration nền 121 cms_import_activation (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '122';
  IF FOUND THEN
    RAISE EXCEPTION '122: đã có marker 122 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 122) THEN
    RAISE EXCEPTION '122: DB đã có migration số > 122 — dừng';
  END IF;
  IF to_regclass('public.cms_sales_lines') IS NOT NULL OR to_regclass('public.cms_results') IS NOT NULL THEN
    RAISE EXCEPTION '122: đã có bảng kết quả CMS mà không có marker 122 — kiểm tra tay';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cms_programs'
              AND column_name = 'current_result_run_id') THEN
    RAISE EXCEPTION '122: cms_programs đã có current_result_run_id — kiểm tra tay';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cms_sync_runs'::regclass
                  AND conname = 'cms_sync_runs_kind_check'
                  AND pg_catalog.pg_get_constraintdef(oid) = 'CHECK ((kind = ''products''::text))') THEN
    RAISE EXCEPTION '122: ràng buộc cms_sync_runs_kind_check không đúng dạng 120';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind <> 'products' OR program_id IS NOT NULL) THEN
    RAISE EXCEPTION '122: cms_sync_runs có dòng ngoài kind products / program_id NULL';
  END IF;
  IF to_regprocedure('public.cms__vn_today()') IS NULL OR to_regprocedure('public.cms_readable_program_ids()') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL THEN
    RAISE EXCEPTION '122: thiếu hàm nền (cms__vn_today / cms_readable_program_ids / is_super_admin)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION '122: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = 'public.cms__lock_catalog()'::regprocedure
                  AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '122: role chạy (%) không phải owner các hàm 121 — chạy bằng cùng role owner', current_user;
  END IF;
  -- Index UNIQUE (program_product_id, qty_from) (PM 03/11 §5): bậc trùng mốc ⇒ dừng cả migration, KHÔNG tự xoá / gộp bậc.
  IF EXISTS (SELECT 1 FROM public.cms_program_tiers GROUP BY program_product_id, qty_from HAVING count(*) > 1) THEN
    RAISE EXCEPTION '122: cms_program_tiers có (program_product_id, qty_from) trùng — kiểm tay dữ liệu bậc trước khi chạy';
  END IF;
END $$;

-- ── 1. cms_sync_runs: kind 'sales' + cột run tính ──────────────────────────
ALTER TABLE public.cms_sync_runs DROP CONSTRAINT cms_sync_runs_kind_check;
ALTER TABLE public.cms_sync_runs
  ADD CONSTRAINT cms_sync_runs_kind_check CHECK (kind IN ('products', 'sales')),
  ADD COLUMN config_version        integer     CHECK (config_version IS NULL OR config_version >= 1),
  ADD COLUMN is_test               boolean,
  ADD COLUMN mapping_fp            text        CHECK (mapping_fp IS NULL OR mapping_fp ~ '^[0-9a-f]{32}$'),
  ADD COLUMN sealed_at             timestamptz,
  ADD COLUMN published_at          timestamptz,
  -- purged_at = bắt đầu dọn (từ đây đọc ⇒ RUN_GONE); cleared_at = đã xoá hết dữ liệu của run.
  ADD COLUMN purged_at             timestamptz,
  ADD COLUMN cleared_at            timestamptz,
  ADD COLUMN source_max_updated_at timestamptz CHECK (source_max_updated_at IS NULL OR isfinite(source_max_updated_at)),
  ADD COLUMN amount_vnd            bigint      CHECK (amount_vnd IS NULL OR amount_vnd >= 0),
  -- Seal tách bước: expect đóng băng lúc seal_begin; seal_step = số bước đã qua (0…10).
  ADD COLUMN seal_expect           jsonb       CHECK (seal_expect IS NULL OR jsonb_typeof(seal_expect) = 'object'),
  ADD COLUMN seal_step             smallint    CHECK (seal_step IS NULL OR seal_step BETWEEN 0 AND 10),
  ADD CONSTRAINT cms_sync_runs_seal_pair CHECK ((seal_step IS NULL) = (seal_expect IS NULL)),
  -- Đích FK kép (run, chương trình) cho pointer và bảng snapshot.
  ADD CONSTRAINT cms_sync_runs_id_program UNIQUE (id, program_id),
  ADD CONSTRAINT cms_sync_runs_kind_shape CHECK (
    (kind = 'products' AND program_id IS NULL AND config_version IS NULL AND is_test IS NULL AND mapping_fp IS NULL
       AND sealed_at IS NULL AND published_at IS NULL AND purged_at IS NULL AND amount_vnd IS NULL
       AND source_max_updated_at IS NULL AND seal_expect IS NULL AND seal_step IS NULL AND cleared_at IS NULL)
    OR (kind = 'sales' AND program_id IS NOT NULL AND config_version IS NOT NULL AND is_test IS NOT NULL
       AND mapping_fp IS NOT NULL)),
  -- Run sales: 'ok' ⇔ đã công bố (cần đã seal + có tổng tiền); dọn dữ liệu chỉ khi đã kết thúc.
  ADD CONSTRAINT cms_sync_runs_sales_publish CHECK (kind <> 'sales' OR (
    ((status = 'ok') = (published_at IS NOT NULL))
    AND (published_at IS NULL OR (sealed_at IS NOT NULL AND amount_vnd IS NOT NULL))
    AND (sealed_at IS NULL OR (seal_expect IS NOT NULL AND seal_step = 10))
    AND (purged_at IS NULL OR status <> 'running')
    AND (cleared_at IS NULL OR purged_at IS NOT NULL)));
CREATE INDEX cms_sync_runs_program_idx ON public.cms_sync_runs (program_id, started_at DESC) WHERE program_id IS NOT NULL;

-- ── 2. cms_programs.current_result_run_id ──────────────────────────────────
ALTER TABLE public.cms_programs
  ADD COLUMN current_result_run_id uuid,
  ADD CONSTRAINT cms_programs_result_run_fk FOREIGN KEY (current_result_run_id, id)
    REFERENCES public.cms_sync_runs (id, program_id);

-- ── 3. Bảng snapshot / kết quả ─────────────────────────────────────────────
-- Sổ khối đã stage: (part, chunk_no) duy nhất ⇒ retry cùng khối không nhân đôi; seal kiểm đủ khối liên tục 0…n−1.
CREATE TABLE public.cms_sync_run_chunks (
  run_id     uuid        NOT NULL REFERENCES public.cms_sync_runs(id),
  part       text        NOT NULL CHECK (part IN ('sales_lines', 'results', 'catalog', 'result_lines')),
  chunk_no   integer     NOT NULL CHECK (chunk_no >= 0 AND chunk_no < 100000),
  row_count  integer     NOT NULL CHECK (row_count BETWEEN 1 AND 5000),
  digest     text        NOT NULL CHECK (digest ~ '^[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, part, chunk_no)
);

-- Đầu vào: dòng ỨNG VIÊN (OFFLINE + COMPLETED + trong kỳ + ProductID thuộc chương trình) của run; seq = thứ tự engine
-- (completed_at micro giây, rồi order_line_id) trên toàn bộ ứng viên — khoá phân trang D3 / XLSX.
CREATE TABLE public.cms_sales_lines (
  run_id             uuid        NOT NULL,
  program_id         uuid        NOT NULL,
  order_line_id      text        NOT NULL CHECK (char_length(order_line_id) BETWEEN 1 AND 100),
  seq                integer     NOT NULL CHECK (seq >= 0),
  order_id           text        NOT NULL CHECK (char_length(order_id) BETWEEN 1 AND 100),
  order_code         text        NOT NULL CHECK (char_length(order_code) BETWEEN 1 AND 100),
  product_id         text        NOT NULL CHECK (product_id ~ '^[1-9][0-9]{0,18}$'),
  program_product_id uuid        NOT NULL,
  seller_email       text        CHECK (seller_email IS NULL OR (char_length(seller_email) BETWEEN 1 AND 320
                                        AND seller_email = lower(seller_email))),
  user_id            uuid,
  store_id           uuid,
  pos_code           text        CHECK (pos_code IS NULL OR char_length(pos_code) BETWEEN 1 AND 50),
  completed_at       timestamptz NOT NULL CHECK (isfinite(completed_at)),
  source_updated_at  timestamptz NOT NULL CHECK (isfinite(source_updated_at)),
  quantity_raw       text        CHECK (quantity_raw IS NULL OR char_length(quantity_raw) BETWEEN 1 AND 50),
  uom_raw            text        CHECK (uom_raw IS NULL OR char_length(uom_raw) BETWEEN 1 AND 50),
  -- < 1e29 loại cả NaN / Infinity (NaN / Infinity lớn hơn mọi số trong so sánh numeric).
  base_quantity      numeric     NOT NULL CHECK (abs(base_quantity) < 1e29 AND scale(base_quantity) <= 9),
  gmv_amount         numeric     NOT NULL CHECK (abs(gmv_amount) < 1e20 AND scale(gmv_amount) <= 9),
  disposition        text        NOT NULL CHECK (disposition IN ('INCLUDED', 'UNASSIGNED', 'OUT_OF_SCOPE')),
  unassigned_reason  text        CHECK (unassigned_reason IS NULL OR unassigned_reason IN
                                        ('NO_EMAIL', 'NOT_FOUND', 'MULTIPLE', 'SHARED_ACCOUNT', 'NOT_STAFF', 'STORE_NOT_ELIGIBLE')),
  PRIMARY KEY (run_id, order_line_id),
  CONSTRAINT cms_sales_lines_seq UNIQUE (run_id, seq),
  CONSTRAINT cms_sales_lines_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_sales_lines_product_fk FOREIGN KEY (program_product_id, program_id)
    REFERENCES public.cms_program_products (id, program_id),
  CONSTRAINT cms_sales_lines_disposition CHECK (
    (disposition = 'UNASSIGNED' AND unassigned_reason IS NOT NULL AND user_id IS NULL AND store_id IS NULL)
    OR (disposition IN ('INCLUDED', 'OUT_OF_SCOPE') AND unassigned_reason IS NULL AND user_id IS NOT NULL
        AND store_id IS NOT NULL AND seller_email IS NOT NULL))
);
CREATE INDEX cms_sales_lines_excluded_idx ON public.cms_sales_lines (run_id, seq) WHERE disposition <> 'INCLUDED';
-- Index phía tham chiếu cho FK tới cms_program_products: không có ⇒ 121 replace (xoá SP nháp) quét toàn bảng cho mỗi SP
-- bị xoá (db-reviewer P1-2: 10,4 s ở 200k dòng). FK (run_id, program_id) → cms_sync_runs không cần: run không bao giờ bị xoá.
CREATE INDEX cms_sales_lines_product_fk_idx ON public.cms_sales_lines (program_product_id, program_id);

-- Kết quả dược sĩ × sản phẩm của run (engine computeCmsProgram().results).
CREATE TABLE public.cms_results (
  run_id             uuid        NOT NULL,
  program_id         uuid        NOT NULL,
  program_product_id uuid        NOT NULL,
  product_id         text        NOT NULL CHECK (product_id ~ '^[1-9][0-9]{0,18}$'),
  user_id            uuid        NOT NULL,
  store_id           uuid        NOT NULL,
  gmv_basis          text        NOT NULL CHECK (gmv_basis IN ('product', 'catalog', 'none')),
  base_quantity      numeric     NOT NULL CHECK (abs(base_quantity) < 1e35 AND scale(base_quantity) <= 9),
  per_unit           numeric     NOT NULL CHECK (per_unit > 0 AND per_unit < 1e29 AND scale(per_unit) <= 9),
  cms_quantity       bigint      NOT NULL CHECK (cms_quantity >= 0),
  rewarded_quantity  bigint      NOT NULL CHECK (rewarded_quantity >= 0),
  cap_quantity       bigint      CHECK (cap_quantity IS NULL OR cap_quantity >= 1),
  at_cap             boolean     NOT NULL,
  gmv_amount         numeric     NOT NULL CHECK (abs(gmv_amount) < 1e26 AND scale(gmv_amount) <= 9),
  gate_gmv           numeric     CHECK (gate_gmv IS NULL OR (abs(gate_gmv) < 1e26 AND scale(gate_gmv) <= 9)),
  target_gmv         bigint      CHECK (target_gmv IS NULL OR target_gmv > 0),
  gate_met           boolean     NOT NULL,
  gate_met_at        timestamptz CHECK (gate_met_at IS NULL OR isfinite(gate_met_at)),
  potential_amount   bigint      NOT NULL CHECK (potential_amount >= 0),
  amount_vnd         bigint      NOT NULL CHECK (amount_vnd >= 0),
  line_count         integer     NOT NULL CHECK (line_count >= 1),
  PRIMARY KEY (run_id, user_id, program_product_id),
  CONSTRAINT cms_results_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_results_product_fk FOREIGN KEY (program_product_id, program_id)
    REFERENCES public.cms_program_products (id, program_id),
  CONSTRAINT cms_results_amount CHECK (amount_vnd = CASE WHEN gate_met THEN potential_amount ELSE 0 END),
  -- Không target: gate đạt, KHÔNG có ngày đạt / GMV gate; có target: đạt ⇔ có "đạt từ" (lần chuyển gần nhất — Q-211).
  CONSTRAINT cms_results_gate CHECK (
    (gmv_basis = 'none' AND target_gmv IS NULL AND gate_gmv IS NULL AND gate_met AND gate_met_at IS NULL)
    OR (gmv_basis <> 'none' AND target_gmv IS NOT NULL AND gate_gmv IS NOT NULL AND gate_met = (gate_met_at IS NOT NULL))),
  CONSTRAINT cms_results_cap CHECK (
    rewarded_quantity = CASE WHEN cap_quantity IS NOT NULL AND cms_quantity > cap_quantity THEN cap_quantity ELSE cms_quantity END
    AND at_cap = (cap_quantity IS NOT NULL AND cms_quantity >= cap_quantity))
);
CREATE INDEX cms_results_product_idx ON public.cms_results (run_id, program_product_id);
CREATE INDEX cms_results_product_fk_idx ON public.cms_results (program_product_id, program_id);
-- Tra bậc chứa Q (seal bước 7 / 10: LIMIT 1 theo qty_from) — không quét mọi bậc mỗi lần (db-reviewer r2 P1-N1). UNIQUE (PM
-- 03/11 §5): DB ép mốc bậc không trùng trong một SP; KHÔNG thay kiểm bậc liên tục / không chồng của 121 / engine.
CREATE UNIQUE INDEX cms_program_tiers_product_from_idx ON public.cms_program_tiers (program_product_id, qty_from);

-- Gate danh mục theo dược sĩ (engine .catalog) — chỉ dược sĩ có dòng thuộc SP GMV_TOAN_DANH_MUC.
CREATE TABLE public.cms_result_catalog (
  run_id      uuid        NOT NULL,
  program_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  store_id    uuid        NOT NULL,
  catalog_gmv numeric     NOT NULL CHECK (abs(catalog_gmv) < 1e26 AND scale(catalog_gmv) <= 9),
  target_gmv  bigint      NOT NULL CHECK (target_gmv > 0),
  met         boolean     NOT NULL,
  met_at      timestamptz CHECK (met_at IS NULL OR isfinite(met_at)),
  line_count  integer     NOT NULL CHECK (line_count >= 1),
  PRIMARY KEY (run_id, user_id),
  CONSTRAINT cms_result_catalog_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_result_catalog_met CHECK (met = (met_at IS NOT NULL))
);

-- Phân bổ tiền từng dòng INCLUDED (engine .lines): Tiền dòng = A(B_sau) − A(B_trước). D3 / XLSX đọc trực tiếp.
CREATE TABLE public.cms_result_lines (
  run_id             uuid    NOT NULL,
  program_id         uuid    NOT NULL,
  order_line_id      text    NOT NULL,
  seq                integer NOT NULL CHECK (seq >= 0),
  user_id            uuid    NOT NULL,
  program_product_id uuid    NOT NULL,
  base_before        numeric NOT NULL CHECK (abs(base_before) < 1e35 AND scale(base_before) <= 9),
  base_after         numeric NOT NULL CHECK (abs(base_after) < 1e35 AND scale(base_after) <= 9),
  qty_before         bigint  NOT NULL CHECK (qty_before >= 0),
  qty_after          bigint  NOT NULL CHECK (qty_after >= 0),
  amount_vnd         bigint  NOT NULL,
  status             text    NOT NULL CHECK (status IN ('WAITING_GATE', 'ACCUMULATING', 'RECORDED', 'AT_CAP', 'ADJUSTMENT')),
  PRIMARY KEY (run_id, order_line_id),
  CONSTRAINT cms_result_lines_run_fk FOREIGN KEY (run_id, program_id) REFERENCES public.cms_sync_runs (id, program_id),
  CONSTRAINT cms_result_lines_sales_fk FOREIGN KEY (run_id, order_line_id)
    REFERENCES public.cms_sales_lines (run_id, order_line_id),
  CONSTRAINT cms_result_lines_result_fk FOREIGN KEY (run_id, user_id, program_product_id)
    REFERENCES public.cms_results (run_id, user_id, program_product_id),
  -- Tiền dòng âm chỉ ở dòng điều chỉnh (lượng / GMV âm — Q-206).
  CONSTRAINT cms_result_lines_amount CHECK (amount_vnd >= 0 OR status = 'ADJUSTMENT')
);
CREATE INDEX cms_result_lines_d3_idx ON public.cms_result_lines (run_id, user_id, program_product_id, seq);
CREATE UNIQUE INDEX cms_result_lines_seq_idx ON public.cms_result_lines (run_id, seq);

ALTER TABLE public.cms_sync_run_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_sales_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_results         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_result_catalog  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_result_lines    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cms_sync_run_chunks, public.cms_sales_lines, public.cms_results, public.cms_result_catalog,
  public.cms_result_lines FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cms_sync_run_chunks, public.cms_sales_lines, public.cms_results, public.cms_result_catalog,
  public.cms_result_lines TO service_role;

-- ── 4. Helper nội bộ (không cấp ai; chỉ RPC SECDEF cùng owner gọi) ─────────
-- Chuỗi JSON khớp regex (thiếu khoá / sai kiểu ⇒ false).
CREATE FUNCTION public.cms__str(p_e jsonb, p_k text, p_re text)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_typeof(p_e -> p_k) = 'string' AND (p_e ->> p_k) ~ p_re, false)
$$;

-- Như cms__str nhưng thiếu khoá / JSON null cũng hợp lệ.
CREATE FUNCTION public.cms__str_or_null(p_e jsonb, p_k text, p_re text)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_e -> p_k IS NULL OR jsonb_typeof(p_e -> p_k) = 'null' THEN true
              ELSE COALESCE(jsonb_typeof(p_e -> p_k) = 'string' AND (p_e ->> p_k) ~ p_re, false) END
$$;

-- Timestamp ⇒ chuỗi ISO UTC 6 chữ số micro giây (khớp formatUtcMicros của app).
CREATE FUNCTION public.cms__ts(p_t timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_char(p_t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- Email chuẩn hoá giống normalizeCmsEmail (lib/cms/source/contract.ts): ký tự điều khiển C0 / DEL / C1 (U+0001–001F,
-- U+007F–009F — lớp tường minh, không phụ thuộc ctype DB) ⇒ khoảng trắng, cắt khoảng trắng hai đầu (gồm khoảng trắng Unicode
-- mà String.prototype.trim cắt), chữ thường; rỗng ⇒ NULL.
CREATE FUNCTION public.cms__norm_email(p_email text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NULLIF(lower(btrim(regexp_replace(p_email, '[\x01-\x1f\x7f-\x9f]', ' ', 'g'),
    ' ' || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
        || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288)
        || chr(65279))), '')
$$;

-- Vân tay dữ liệu dùng để map người bán / phạm vi (users + stores). Đổi giữa open và publish ⇒ run lỗi thời.
CREATE FUNCTION public.cms__mapping_fp()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT md5(
    COALESCE((SELECT string_agg(u.id::text || chr(31) || COALESCE(u.email, '') || chr(31) || COALESCE(u.role, '') || chr(31)
                                || COALESCE(u.store_id::text, ''), chr(30) ORDER BY u.id) FROM public.users u), '')
    || chr(29) ||
    COALESCE((SELECT string_agg(s.id::text || chr(31) || COALESCE(s.store_type, '') || chr(31) || COALESCE(s.is_active::text, ''),
                                chr(30) ORDER BY s.id) FROM public.stores s), ''))
$$;

-- Snapshot cấu hình + dữ liệu map của MỘT chương trình — một câu lệnh ⇒ một snapshot nhất quán.
CREATE FUNCTION public.cms__sales_snapshot(p_program_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'program_id', p.id,
    'status', p.status,
    'is_test', p.is_test,
    'config_version', p.config_version,
    'start_date', to_char(p.start_date, 'YYYY-MM-DD'),
    'end_date', to_char(p.end_date, 'YYYY-MM-DD'),
    'catalog_target_gmv', p.catalog_target_gmv::text,
    'today_vn', to_char(public.cms__vn_today(), 'YYYY-MM-DD'),
    'current_result_run_id', p.current_result_run_id,
    'previous_rows_read', (SELECT r.rows_read FROM public.cms_sync_runs r WHERE r.id = p.current_result_run_id),
    'store_ids', COALESCE((SELECT jsonb_agg(ps.store_id ORDER BY ps.store_id) FROM public.cms_program_stores ps
                            WHERE ps.program_id = p.id), '[]'::jsonb),
    'products', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', pp.id, 'product_id', pp.product_id, 'gmv_basis', pp.gmv_basis, 'target_gmv', pp.target_gmv::text,
        'base_quantity_cms', pp.base_quantity_cms::text,
        'tiers', COALESCE((SELECT jsonb_agg(jsonb_build_object('order', t.tier_order, 'from', t.qty_from, 'to', t.qty_to,
                                                               'amount', t.amount_per_unit::text) ORDER BY t.tier_order)
                             FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id), '[]'::jsonb))
        ORDER BY pp.product_id) FROM public.cms_program_products pp WHERE pp.program_id = p.id), '[]'::jsonb),
    'sellers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'role', u.role, 'store_id', u.store_id)
                                          ORDER BY u.id) FROM public.users u), '[]'::jsonb),
    'stores', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'store_type', s.store_type, 'is_active', s.is_active)
                                         ORDER BY s.id) FROM public.stores s), '[]'::jsonb),
    'mapping_fp', public.cms__mapping_fp())
  FROM public.cms_programs p WHERE p.id = p_program_id
$$;

-- Seal thất bại: đóng run (error / held) với mã cố định, giữ pointer; trả kết quả cho app.
CREATE FUNCTION public.cms__seal_fail(p_run_id uuid, p_status text, p_code text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.cms_sync_runs SET status = p_status, finished_at = now(), error_code = p_code
   WHERE id = p_run_id AND kind = 'sales' AND status = 'running';
  RETURN jsonb_build_object('sealed', false, 'status', p_status, 'code', p_code);
END;
$$;

-- Cổng công bố kết quả TIỀN THẬT ở DB (Q-206 HOLD; security review P1-2 / db-reviewer P2-7): false ⇒ publish chương trình
-- không phải QA bị held RESULTS_RELEASE_GATE dù app có lỗi / gọi thẳng RPC. Mở cổng = migration riêng (CREATE OR REPLACE
-- hàm này + gate ACL) sau khi Q-206 được chốt và PM audit adapter trả hàng — không có tham số / env nào bật ở runtime.
CREATE FUNCTION public.cms__results_release_open()
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT false
$$;

-- Staff mà người gọi được xem kết quả: NULL = mọi staff (super); '{}' = không ai. Phạm vi HIỆN TẠI (Q-208).
CREATE FUNCTION public.cms__visible_result_users()
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT u.id, u.role, u.store_id, public.is_super_admin() AS su
      FROM public.users u WHERE u.id = auth.uid()
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM me) THEN '{}'::uuid[]
    WHEN (SELECT su FROM me) THEN NULL
    WHEN (SELECT role FROM me) = 'staff' THEN ARRAY[(SELECT id FROM me)]
    WHEN (SELECT role FROM me) = 'store_manager' THEN COALESCE((
      SELECT array_agg(u.id ORDER BY u.id) FROM public.users u
        JOIN me ON u.store_id = me.store_id
        JOIN public.stores s ON s.id = u.store_id
       WHERE u.role = 'staff' AND s.store_type = 'os' AND s.is_active), '{}'::uuid[])
    WHEN (SELECT role FROM me) = 'sm' THEN COALESCE((
      SELECT array_agg(DISTINCT u.id) FROM public.users u
        JOIN public.stores s ON s.id = u.store_id
        JOIN public.sm_store_assignments a ON a.store_id = u.store_id
        JOIN me ON a.sm_user_id = me.id
       WHERE u.role = 'staff' AND s.store_type = 'os' AND s.is_active), '{}'::uuid[])
    ELSE '{}'::uuid[]
  END
$$;

-- Run để đọc: chương trình phải đọc được (cms_readable_program_ids — gồm marker QA); p_run NULL ⇒ run hiện hành (NULL =
-- chưa có snapshot); mọi run trả về (kể cả run hiện hành) phải là run sales đã công bố, CHƯA DỌN, của chương trình này —
-- run hiện hành bị dọn (race hiếm) ⇒ RUN_GONE, không trả mảng rỗng như số 0 giả (db-reviewer P2-1).
CREATE FUNCTION public.cms__result_run(p_program_id uuid, p_run_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cur uuid;
  v_run uuid;
BEGIN
  IF auth.uid() IS NULL OR p_program_id IS NULL OR NOT (p_program_id = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT current_result_run_id INTO v_cur FROM public.cms_programs WHERE id = p_program_id;
  v_run := COALESCE(p_run_id, v_cur);
  IF v_run IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM public.cms_sync_runs r
   WHERE r.id = v_run AND r.program_id = p_program_id AND r.kind = 'sales' AND r.status = 'ok' AND r.purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CMS_RESULT_RUN_GONE' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_run;
END;
$$;

-- Trigger bảo vệ pointer: chỉ trỏ run sales 'ok' (đã công bố, chưa dọn) của CHÍNH chương trình, cùng config_version /
-- is_test hiện hành; chỉ đổi khi chương trình 'active'; chương trình đã chốt không đổi pointer; INSERT không mang pointer.
CREATE FUNCTION public.cms__programs_result_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_result_run_id IS NOT NULL THEN
      RAISE EXCEPTION 'CMS_RESULT_POINTER_INVALID' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.current_result_run_id IS NOT DISTINCT FROM OLD.current_result_run_id THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'active' OR NEW.current_result_run_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.cms_sync_runs r
                     WHERE r.id = NEW.current_result_run_id AND r.program_id = NEW.id AND r.kind = 'sales'
                       AND r.status = 'ok' AND r.published_at IS NOT NULL AND r.purged_at IS NULL
                       AND r.config_version = NEW.config_version AND r.is_test = NEW.is_test) THEN
    RAISE EXCEPTION 'CMS_RESULT_POINTER_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cms_programs_result_guard BEFORE INSERT OR UPDATE ON public.cms_programs
  FOR EACH ROW EXECUTE FUNCTION public.cms__programs_result_guard();

-- ── 5. RPC ghi (chỉ service_role) ──────────────────────────────────────────
CREATE FUNCTION public.rpc_cms_sales_snapshot(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_snap jsonb;
BEGIN
  IF p_program_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  v_snap := public.cms__sales_snapshot(p_program_id);
  IF v_snap IS NULL THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  RETURN v_snap;
END;
$$;

CREATE FUNCTION public.rpc_cms_sales_run_open(p_program_id uuid, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
  v_snap jsonb;
  v_id   uuid;
BEGIN
  IF p_program_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' OR pg_column_size(p_detail) > 4096 THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
  -- Khoá dòng chương trình: chặn ghi cấu hình (121 khoá FOR UPDATE) trong lúc chụp snapshot ⇒ config_version khớp dữ liệu.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_prog.status = 'locked' THEN RAISE EXCEPTION 'CMS_PROGRAM_LOCKED' USING ERRCODE = 'P0001'; END IF;
  IF v_prog.status <> 'active' THEN RAISE EXCEPTION 'CMS_SALES_PROGRAM_NOT_ACTIVE' USING ERRCODE = 'P0001'; END IF;
  -- Chỉ tính khi đã bắt đầu: trước ngày bắt đầu danh mục còn nạp lại (replace xoá SP) — không giữ tham chiếu snapshot.
  IF public.cms__vn_today() < v_prog.start_date THEN
    RAISE EXCEPTION 'CMS_SALES_NOT_STARTED' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cms_sales_run:' || p_program_id::text, 0));
  UPDATE public.cms_sync_runs SET status = 'error', finished_at = now(), error_code = 'STALE'
   WHERE kind = 'sales' AND program_id = p_program_id AND status = 'running' AND started_at < now() - interval '30 minutes';
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id AND status = 'running') THEN
    RAISE EXCEPTION 'CMS_SYNC_BUSY' USING ERRCODE = 'P0001';
  END IF;
  v_snap := public.cms__sales_snapshot(p_program_id);
  INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, detail)
  VALUES ('sales', p_program_id, v_prog.config_version, v_prog.is_test, v_snap ->> 'mapping_fp', p_detail)
  RETURNING id INTO v_id;
  RETURN v_snap || jsonb_build_object('run_id', v_id);
END;
$$;

CREATE FUNCTION public.rpc_cms_sales_run_stage(p_run_id uuid, p_part text, p_chunk_no integer, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run    public.cms_sync_runs%ROWTYPE;
  v_n      integer;
  v_count  integer;
  v_digest text;
  v_prev   record;
  c_uuid CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_dec  CONSTANT text := '^-?[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_udec CONSTANT text := '^[0-9]{1,35}(\.[0-9]{1,9})?$';
  c_int  CONSTANT text := '^(0|[1-9][0-9]{0,18})$';
  c_sint CONSTANT text := '^-?(0|[1-9][0-9]{0,18})$';
  c_seq  CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
  -- Miền tháng / ngày / giờ trong regex ⇒ ngày sai dạng thô (2026-13-45) ra mã CMS_*, không lỗi ép kiểu 22008.
  c_ts   CONSTANT text := '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$';
  c_pid  CONSTANT text := '^[1-9][0-9]{0,18}$';
  -- Ký tự điều khiển C0 / DEL / C1 bằng lớp tường minh (không phụ thuộc ctype DB; khớp CONTROL_RE của app — db-reviewer P2-3).
  c_txt  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,100}$';
  c_t50  CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]{1,50}$';
  c_mail CONSTANT text := '^[^\x01-\x1f\x7f-\x9f]+$';  -- regex PG lặp tối đa 255; độ dài ≤ 320 + chữ thường do CHECK / kiểm dưới
BEGIN
  IF p_part IS NULL OR p_part NOT IN ('sales_lines', 'results', 'catalog', 'result_lines') THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_PART' USING ERRCODE = '22023';
  END IF;
  IF p_chunk_no IS NULL OR p_chunk_no < 0 OR p_chunk_no >= 100000 THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_CHUNK' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROWS' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n = 0 OR v_n > 5000 THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_CHUNK' USING ERRCODE = '22023';
  END IF;
  -- Khoá run: các khối của cùng run ghi tuần tự; seal / finish chờ khối đang ghi.
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  -- seal_begin đã đóng băng staging ⇒ không ghi thêm (bước seal đối chiếu đúng tập đã đếm).
  IF v_run.seal_expect IS NOT NULL OR v_run.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_STAGE_SEALED' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RAISE EXCEPTION 'CMS_SYNC_RUN_STALE' USING ERRCODE = 'P0001'; END IF;

  v_digest := md5(p_rows::text);
  SELECT row_count, digest INTO v_prev FROM public.cms_sync_run_chunks
   WHERE run_id = p_run_id AND part = p_part AND chunk_no = p_chunk_no;
  IF FOUND THEN
    IF v_prev.row_count = v_n AND v_prev.digest = v_digest THEN
      RETURN v_n;  -- retry khối đã ghi: không ghi lại
    END IF;
    RAISE EXCEPTION 'CMS_STAGE_CHUNK_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e WHERE jsonb_typeof(e) <> 'object') THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  -- Kiểm kiểu JSON một lượt (SQL/JSON path, chạy trong C): app gửi MỌI số dạng chuỗi ⇒ số / object / mảng ở bất kỳ trường
  -- nào ⇒ lỗi dòng; boolean chỉ được ở trường boolean của results / catalog. Sau đó đọc bằng jsonb_to_recordset và kiểm
  -- định dạng bằng regex trên cột (không gọi hàm theo từng trường — r1 chậm ~0,45 s / khối 1.000 dòng).
  -- strict: lax tự mở mảng ⇒ ["x"] / [] ở trường text lọt qua (db-reviewer r2 N3).
  IF jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "number" || @.type() == "object" || @.type() == "array")')
     OR (p_part IN ('sales_lines', 'result_lines') AND jsonb_path_exists(p_rows, 'strict $[*].* ? (@.type() == "boolean")'))
     -- Trường boolean phải là boolean JSON (chuỗi 'true' / 'abc' ⇒ lỗi dòng, không để lọt lỗi ép kiểu thô).
     OR (p_part = 'results' AND jsonb_path_exists(p_rows, '$[*] ? (@.at_cap.type() != "boolean" || @.gate_met.type() != "boolean")'))
     OR (p_part = 'catalog' AND jsonb_path_exists(p_rows, '$[*] ? (@.met.type() != "boolean")')) THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END IF;

  -- Khối bắt lỗi ép kiểu: ngày qua regex nhưng không tồn tại (30/02, năm 0000) ⇒ CMS_STAGE_BAD_ROW, không lỗi thô 22008
  -- (db-reviewer r2 N4). Trùng khoá / CHECK vẫn lộ mã gốc (kiểm thử dựa vào).
  BEGIN
  IF p_part = 'sales_lines' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, order_id text, order_code text, product_id text,
             program_product_id text, seller_email text, user_id text, store_id text, pos_code text, completed_at text,
             source_updated_at text, quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, disposition text,
             unassigned_reason text)
       WHERE NOT (COALESCE(x.order_line_id ~ c_txt AND x.seq ~ c_seq AND x.order_id ~ c_txt AND x.order_code ~ c_txt
                           AND x.product_id ~ c_pid AND x.program_product_id ~ c_uuid AND x.completed_at ~ c_ts
                           AND x.source_updated_at ~ c_ts AND x.base_quantity ~ c_dec AND x.gmv_amount ~ c_dec
                           AND x.disposition ~ '^(INCLUDED|UNASSIGNED|OUT_OF_SCOPE)$', false)
                  AND (x.seller_email IS NULL OR (x.seller_email ~ c_mail AND char_length(x.seller_email) <= 320
                                                  AND x.seller_email = lower(x.seller_email)))
                  AND (x.user_id IS NULL OR x.user_id ~ c_uuid)
                  AND (x.store_id IS NULL OR x.store_id ~ c_uuid) AND (x.pos_code IS NULL OR x.pos_code ~ c_t50)
                  AND (x.quantity_raw IS NULL OR x.quantity_raw ~ c_t50) AND (x.uom_raw IS NULL OR x.uom_raw ~ c_t50)
                  AND (x.unassigned_reason IS NULL
                       OR x.unassigned_reason ~ '^(NO_EMAIL|NOT_FOUND|MULTIPLE|SHARED_ACCOUNT|NOT_STAFF|STORE_NOT_ELIGIBLE)$'))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_sales_lines (run_id, program_id, order_line_id, seq, order_id, order_code, product_id,
      program_product_id, seller_email, user_id, store_id, pos_code, completed_at, source_updated_at, quantity_raw, uom_raw,
      base_quantity, gmv_amount, disposition, unassigned_reason)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.seq::integer, x.order_id, x.order_code, x.product_id,
           x.program_product_id::uuid, x.seller_email, x.user_id::uuid, x.store_id::uuid, x.pos_code, x.completed_at::timestamptz,
           x.source_updated_at::timestamptz, x.quantity_raw, x.uom_raw, x.base_quantity::numeric, x.gmv_amount::numeric,
           x.disposition, x.unassigned_reason
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, order_id text, order_code text, product_id text,
             program_product_id text, seller_email text, user_id text, store_id text, pos_code text, completed_at text,
             source_updated_at text, quantity_raw text, uom_raw text, base_quantity text, gmv_amount text, disposition text,
             unassigned_reason text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
  ELSIF p_part = 'results' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(program_product_id text, product_id text, user_id text, store_id text,
             gmv_basis text, base_quantity text, per_unit text, cms_quantity text, rewarded_quantity text, cap_quantity text,
             at_cap boolean, gmv_amount text, gate_gmv text, target_gmv text, gate_met boolean, gate_met_at text,
             potential_amount text, amount_vnd text, line_count text)
       WHERE NOT (COALESCE(x.program_product_id ~ c_uuid AND x.product_id ~ c_pid AND x.user_id ~ c_uuid AND x.store_id ~ c_uuid
                           AND x.gmv_basis ~ '^(product|catalog|none)$' AND x.base_quantity ~ c_dec AND x.per_unit ~ c_udec
                           AND x.cms_quantity ~ c_int AND x.rewarded_quantity ~ c_int AND x.at_cap IS NOT NULL
                           AND x.gmv_amount ~ c_dec AND x.gate_met IS NOT NULL AND x.potential_amount ~ c_int
                           AND x.amount_vnd ~ c_int AND x.line_count ~ c_seq, false)
                  AND (x.cap_quantity IS NULL OR x.cap_quantity ~ c_int) AND (x.gate_gmv IS NULL OR x.gate_gmv ~ c_dec)
                  AND (x.target_gmv IS NULL OR x.target_gmv ~ c_int) AND (x.gate_met_at IS NULL OR x.gate_met_at ~ c_ts))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    -- Miền bigint kiểm SAU khi đã chắc định dạng (ép kiểu an toàn); vượt ⇒ lỗi dòng, không để lọt lỗi ép kiểu thô.
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(cms_quantity text, rewarded_quantity text, cap_quantity text, target_gmv text,
             potential_amount text, amount_vnd text)
       WHERE x.cms_quantity::numeric > 9223372036854775807 OR x.rewarded_quantity::numeric > 9223372036854775807
          OR COALESCE(x.cap_quantity::numeric, 0) > 9223372036854775807 OR COALESCE(x.target_gmv::numeric, 0) > 9223372036854775807
          OR x.potential_amount::numeric > 9223372036854775807 OR x.amount_vnd::numeric > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_results (run_id, program_id, program_product_id, product_id, user_id, store_id, gmv_basis,
      base_quantity, per_unit, cms_quantity, rewarded_quantity, cap_quantity, at_cap, gmv_amount, gate_gmv, target_gmv, gate_met,
      gate_met_at, potential_amount, amount_vnd, line_count)
    SELECT p_run_id, v_run.program_id, x.program_product_id::uuid, x.product_id, x.user_id::uuid, x.store_id::uuid, x.gmv_basis,
           x.base_quantity::numeric, x.per_unit::numeric, x.cms_quantity::bigint, x.rewarded_quantity::bigint,
           x.cap_quantity::bigint, x.at_cap, x.gmv_amount::numeric, x.gate_gmv::numeric, x.target_gmv::bigint, x.gate_met,
           x.gate_met_at::timestamptz, x.potential_amount::bigint, x.amount_vnd::bigint, x.line_count::integer
      FROM jsonb_to_recordset(p_rows) AS x(program_product_id text, product_id text, user_id text, store_id text,
             gmv_basis text, base_quantity text, per_unit text, cms_quantity text, rewarded_quantity text, cap_quantity text,
             at_cap boolean, gmv_amount text, gate_gmv text, target_gmv text, gate_met boolean, gate_met_at text,
             potential_amount text, amount_vnd text, line_count text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
  ELSIF p_part = 'catalog' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(user_id text, store_id text, catalog_gmv text, target_gmv text, met boolean,
             met_at text, line_count text)
       WHERE NOT (COALESCE(x.user_id ~ c_uuid AND x.store_id ~ c_uuid AND x.catalog_gmv ~ c_dec AND x.target_gmv ~ c_int
                           AND x.met IS NOT NULL AND x.line_count ~ c_seq, false)
                  AND (x.met_at IS NULL OR x.met_at ~ c_ts))) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(target_gmv text) WHERE x.target_gmv::numeric > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_result_catalog (run_id, program_id, user_id, store_id, catalog_gmv, target_gmv, met, met_at, line_count)
    SELECT p_run_id, v_run.program_id, x.user_id::uuid, x.store_id::uuid, x.catalog_gmv::numeric, x.target_gmv::bigint, x.met,
           x.met_at::timestamptz, x.line_count::integer
      FROM jsonb_to_recordset(p_rows) AS x(user_id text, store_id text, catalog_gmv text, target_gmv text, met boolean,
             met_at text, line_count text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
  ELSE
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, user_id text, program_product_id text,
             base_before text, base_after text, qty_before text, qty_after text, amount_vnd text, status text)
       WHERE NOT COALESCE(x.order_line_id ~ c_txt AND x.seq ~ c_seq AND x.user_id ~ c_uuid AND x.program_product_id ~ c_uuid
                          AND x.base_before ~ c_dec AND x.base_after ~ c_dec AND x.qty_before ~ c_int AND x.qty_after ~ c_int
                          AND x.amount_vnd ~ c_sint
                          AND x.status ~ '^(WAITING_GATE|ACCUMULATING|RECORDED|AT_CAP|ADJUSTMENT)$', false)) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS x(qty_before text, qty_after text, amount_vnd text)
       WHERE x.qty_before::numeric > 9223372036854775807 OR x.qty_after::numeric > 9223372036854775807
          OR abs(x.amount_vnd::numeric) > 9223372036854775807) THEN
      RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.cms_result_lines (run_id, program_id, order_line_id, seq, user_id, program_product_id, base_before,
      base_after, qty_before, qty_after, amount_vnd, status)
    SELECT p_run_id, v_run.program_id, x.order_line_id, x.seq::integer, x.user_id::uuid, x.program_product_id::uuid,
           x.base_before::numeric, x.base_after::numeric, x.qty_before::bigint, x.qty_after::bigint, x.amount_vnd::bigint, x.status
      FROM jsonb_to_recordset(p_rows) AS x(order_line_id text, seq text, user_id text, program_product_id text,
             base_before text, base_after text, qty_before text, qty_after text, amount_vnd text, status text);
    GET DIAGNOSTICS v_count = ROW_COUNT;  -- ngay sau INSERT (một câu SQL chen giữa sẽ ghi đè ROW_COUNT — db-reviewer r3 R3-3)
  END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_STAGE_BAD_ROW' USING ERRCODE = '22023';
  END;
  IF v_count <> v_n THEN RAISE EXCEPTION 'CMS_STAGE_COUNT_MISMATCH' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.cms_sync_run_chunks (run_id, part, chunk_no, row_count, digest) VALUES (p_run_id, p_part, p_chunk_no, v_n, v_digest);
  UPDATE public.cms_sync_runs SET rows_written = rows_written + v_n WHERE id = p_run_id;
  RETURN v_n;
END;
$$;

-- Seal tách bước (db-reviewer P1-1): mỗi RPC là MỘT câu lệnh PostgREST (statement_timeout 8 s của authenticator — không nới
-- được từ trong hàm) ⇒ seal_begin (kiểm expect, cấu hình / mapping, ANALYZE, đủ dòng / khối, ĐÓNG BĂNG staging) rồi
-- seal_step 1…10 tuần tự (mỗi bước một nhóm bất biến, enable_nestloop = off để không rơi vào kế hoạch O(n²) khi thống kê
-- cũ); bước 10 kiểm tổng + totals rồi đặt sealed_at. Lệch ⇒ run error / held + mã, pointer giữ nguyên.
CREATE FUNCTION public.rpc_cms_sales_run_seal_begin(p_run_id uuid, p_expect jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_run   public.cms_sync_runs%ROWTYPE;
  v_prog  public.cms_programs%ROWTYPE;
  v_part  text;
  v_n     bigint;
  c_cnt   CONSTANT text := '^(0|[1-9][0-9]{0,8})$';
BEGIN
  IF p_expect IS NULL OR jsonb_typeof(p_expect) <> 'object' OR pg_column_size(p_expect) > 65536
     OR NOT public.cms__str(p_expect, 'amount_vnd', '^(0|[1-9][0-9]{0,18})$')
     OR NOT public.cms__str_or_null(p_expect, 'source_max_updated_at', '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$')
     OR jsonb_typeof(p_expect -> 'chunks') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_expect -> 'totals') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['sales_lines', 'results', 'catalog', 'result_lines', 'rows_read', 'rows_rejected']) k
                 WHERE jsonb_typeof(p_expect -> k) IS DISTINCT FROM 'number' OR (p_expect ->> k) !~ c_cnt)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['sales_lines', 'results', 'catalog', 'result_lines']) k
                 WHERE jsonb_typeof(p_expect -> 'chunks' -> k) IS DISTINCT FROM 'number' OR (p_expect -> 'chunks' ->> k) !~ c_cnt)
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['lines_read', 'candidates', 'included', 'unassigned', 'out_of_scope', 'adjustment_lines']) k
                 WHERE jsonb_typeof(p_expect -> 'totals' -> k) IS DISTINCT FROM 'number' OR (p_expect -> 'totals' ->> k) !~ c_cnt)
     OR NOT public.cms__str(p_expect -> 'totals', 'candidate_gmv', '^-?[0-9]{1,35}(\.[0-9]{1,9})?$')
     OR NOT public.cms__str(p_expect -> 'totals', 'unassigned_gmv', '^-?[0-9]{1,35}(\.[0-9]{1,9})?$')
     OR NOT public.cms__str(p_expect -> 'totals', 'amount_vnd', '^(0|[1-9][0-9]{0,18})$')
     -- totals chỉ gồm khoá đã biết (hiển thị cho super — db-reviewer r2 N5); hai bảng lý do: khoá trong enum, giá trị số đếm.
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_expect -> 'totals') k
                 WHERE k NOT IN ('lines_read', 'candidates', 'included', 'unassigned', 'out_of_scope', 'adjustment_lines',
                                 'candidate_gmv', 'unassigned_gmv', 'amount_vnd', 'unassigned_by_reason', 'excluded_by_reason'))
     OR jsonb_typeof(p_expect -> 'totals' -> 'unassigned_by_reason') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_expect -> 'totals' -> 'excluded_by_reason') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(p_expect -> 'totals' -> 'unassigned_by_reason') e
                 WHERE e.key NOT IN ('NO_EMAIL', 'NOT_FOUND', 'MULTIPLE', 'SHARED_ACCOUNT', 'NOT_STAFF', 'STORE_NOT_ELIGIBLE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     OR EXISTS (SELECT 1 FROM jsonb_each(p_expect -> 'totals' -> 'excluded_by_reason') e
                 WHERE e.key NOT IN ('ORDER_NOT_ELIGIBLE', 'OUT_OF_WINDOW', 'PRODUCT_NOT_IN_PROGRAM', 'UNASSIGNED', 'OUT_OF_SCOPE')
                    OR jsonb_typeof(e.value) <> 'number' OR e.value::text !~ c_cnt)
     OR (p_expect ? 'bytes_processed' AND jsonb_typeof(p_expect -> 'bytes_processed') <> 'null'
         AND (p_expect ->> 'bytes_processed') !~ '^(0|[1-9][0-9]{0,17})$') THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END IF;
  -- Ngày qua regex nhưng không tồn tại (30/02, năm 0000) ⇒ mã CMS, không lỗi ép kiểu thô 22008 ở bước 10 (db-reviewer r2 N4).
  BEGIN
    PERFORM NULLIF(p_expect ->> 'source_max_updated_at', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'CMS_SEAL_BAD_EXPECT' USING ERRCODE = '22023';
  END;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.seal_expect IS NOT NULL OR v_run.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'CMS_SEAL_STARTED' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'STALE'); END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  IF v_prog.status = 'locked' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_LOCKED'); END IF;
  IF v_prog.status <> 'active' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_NOT_ACTIVE'); END IF;
  IF v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;
  -- Thống kê mới cho run vừa stage (run_id mới chưa có trong thống kê ⇒ planner ước 1 dòng ⇒ nested loop O(n²)).
  -- SKIP_LOCKED: autovacuum / seal khác đang giữ khoá ⇒ bỏ qua thay vì chờ lock_timeout (security review r2 P2-c); bước
  -- seal vẫn có enable_nestloop = off nên thống kê cũ không rơi vào O(n²).
  ANALYZE (SKIP_LOCKED) public.cms_sales_lines, public.cms_results, public.cms_result_catalog, public.cms_result_lines;
  -- S1 đủ dòng: số dòng từng bảng = khai báo của app.
  IF (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id) <> (p_expect ->> 'sales_lines')::bigint
     OR (SELECT count(*) FROM public.cms_results WHERE run_id = p_run_id) <> (p_expect ->> 'results')::bigint
     OR (SELECT count(*) FROM public.cms_result_catalog WHERE run_id = p_run_id) <> (p_expect ->> 'catalog')::bigint
     OR (SELECT count(*) FROM public.cms_result_lines WHERE run_id = p_run_id) <> (p_expect ->> 'result_lines')::bigint THEN
    RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_COUNT_MISMATCH');
  END IF;
  -- S2 đủ khối: mỗi part có đúng n khối 0…n−1, tổng row_count = số dòng.
  FOREACH v_part IN ARRAY ARRAY['sales_lines', 'results', 'catalog', 'result_lines'] LOOP
    v_n := (p_expect -> 'chunks' ->> v_part)::bigint;
    IF (SELECT count(*) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part) <> v_n
       OR COALESCE((SELECT max(chunk_no) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part), -1) <> v_n - 1
       OR COALESCE((SELECT sum(row_count) FROM public.cms_sync_run_chunks WHERE run_id = p_run_id AND part = v_part), 0)
          <> (p_expect ->> v_part)::bigint THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_CHUNKS_MISMATCH');
    END IF;
  END LOOP;
  -- Đóng băng staging: từ đây stage bị từ chối; các bước dùng expect đã lưu (không nhận lại từ app).
  UPDATE public.cms_sync_runs SET seal_expect = p_expect, seal_step = 0 WHERE id = p_run_id;
  RETURN jsonb_build_object('ok', true, 'steps', 10);
END;
$$;

CREATE FUNCTION public.rpc_cms_sales_run_seal_step(p_run_id uuid, p_step integer)
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
BEGIN
  IF p_step IS NULL OR p_step < 1 OR p_step > 10 THEN RAISE EXCEPTION 'CMS_SEAL_BAD_STEP' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.kind <> 'sales' OR v_run.status <> 'running' THEN
    RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.seal_expect IS NULL THEN RAISE EXCEPTION 'CMS_SEAL_STEP_ORDER' USING ERRCODE = 'P0001'; END IF;
  -- Gọi lại bước đã qua (mất phản hồi) ⇒ trả lại kết quả, không đổi gì (db-reviewer r2 N8).
  IF v_run.sealed_at IS NOT NULL THEN
    RETURN CASE WHEN p_step = 10 THEN jsonb_build_object('sealed', true, 'step', 10, 'already', true, 'amount_vnd', v_run.amount_vnd::text)
                ELSE jsonb_build_object('sealed', false, 'ok', true, 'step', p_step, 'already', true) END;
  END IF;
  IF v_run.seal_step >= p_step THEN RETURN jsonb_build_object('sealed', false, 'ok', true, 'step', p_step, 'already', true); END IF;
  IF v_run.seal_step <> p_step - 1 THEN RAISE EXCEPTION 'CMS_SEAL_STEP_ORDER' USING ERRCODE = 'P0001'; END IF;
  IF v_run.started_at < now() - interval '30 minutes' THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'STALE'); END IF;
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_run.program_id;
  -- Đầu MỖI bước: trạng thái / cấu hình / mapping đổi từ lúc open ⇒ held đúng mã (không để bước kiểm dữ liệu báo error
  -- SEAL_* gây hiểu nhầm — db-reviewer r2 N2). Publish vẫn kiểm lại dưới khoá chương trình.
  IF v_prog.status = 'locked' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_LOCKED'); END IF;
  IF v_prog.status <> 'active' THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'PROGRAM_NOT_ACTIVE'); END IF;
  IF v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN
    RETURN public.cms__seal_fail(p_run_id, 'held', 'CONFIG_CHANGED');
  END IF;
  IF public.cms__mapping_fp() <> v_run.mapping_fp THEN RETURN public.cms__seal_fail(p_run_id, 'held', 'MAPPING_CHANGED'); END IF;
  v_exp  := v_run.seal_expect;
  v_from := (v_prog.start_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');
  v_to   := ((v_prog.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh');

  IF p_step = 1 THEN
    -- S3 thứ tự (compareCmsLines): seq liên tục 0…n−1; completed_at không giảm theo seq; cùng thời điểm: ID toàn chữ số trước
    -- ID khác; hai ID số tăng theo giá trị (độ dài sau bỏ số 0 đầu, rồi chữ số, hoà ⇒ chuỗi gốc); hai ID không phải số tăng
    -- theo code point (COLLATE "C" — chỉ khác thứ tự code unit JS với ký tự ngoài BMP).
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
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_ORDER'); END IF;
  ELSIF p_step = 2 THEN
    -- S4 kỳ / sản phẩm / phạm vi: trong kỳ ngày VN, ProductID khớp SP chương trình, INCLUDED ⇔ store trong phạm vi.
    SELECT EXISTS (
      SELECT 1 FROM public.cms_sales_lines sl
        JOIN public.cms_program_products pp ON pp.id = sl.program_product_id
        LEFT JOIN public.cms_program_stores ps ON ps.program_id = v_run.program_id AND ps.store_id = sl.store_id
       WHERE sl.run_id = p_run_id
         AND (sl.product_id <> pp.product_id OR sl.completed_at < v_from OR sl.completed_at >= v_to
              OR (sl.disposition = 'INCLUDED' AND ps.store_id IS NULL)
              OR (sl.disposition = 'OUT_OF_SCOPE' AND ps.store_id IS NOT NULL)))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_SCOPE'); END IF;
  ELSIF p_step = 3 THEN
    -- S5 người bán (Q-207): INCLUDED / OUT_OF_SCOPE ⇒ email khớp ĐÚNG MỘT tài khoản, là staff, store OS active = store dòng;
    -- UNASSIGNED ⇒ không có đúng một staff OS active khớp email (không bỏ sót người hưởng); NO_EMAIL ⇔ không email.
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
    -- S6 liên kết dòng: mỗi dòng kết quả ↔ đúng một dòng INCLUDED cùng seq / user / SP; đủ mọi dòng INCLUDED.
    IF EXISTS (SELECT 1 FROM public.cms_result_lines rl
                 JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
                WHERE rl.run_id = p_run_id AND (sl.disposition <> 'INCLUDED' OR sl.seq <> rl.seq OR sl.user_id <> rl.user_id
                                                OR sl.program_product_id <> rl.program_product_id))
       OR (SELECT count(*) FROM public.cms_sales_lines WHERE run_id = p_run_id AND disposition = 'INCLUDED')
          <> (SELECT count(*) FROM public.cms_result_lines WHERE run_id = p_run_id) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_LINE_LINK');
    END IF;
  ELSIF p_step = 5 THEN
    -- S7 cấu hình trong kết quả = cấu hình chương trình (SP, loại GMV, K, target, trần = to của bậc cuối).
    IF EXISTS (SELECT 1 FROM public.cms_results r
                 JOIN public.cms_program_products pp ON pp.id = r.program_product_id
                 LEFT JOIN LATERAL (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                                     ORDER BY t.tier_order DESC LIMIT 1) lt ON true
                WHERE r.run_id = p_run_id
                  AND (r.product_id <> pp.product_id OR r.gmv_basis <> pp.gmv_basis OR r.per_unit <> pp.base_quantity_cms
                       OR r.target_gmv IS DISTINCT FROM (CASE pp.gmv_basis WHEN 'product' THEN pp.target_gmv
                                                                           WHEN 'catalog' THEN v_prog.catalog_target_gmv END)
                       OR r.cap_quantity IS DISTINCT FROM lt.qty_to::bigint)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_RESULT_CONFIG');
    END IF;
  ELSIF p_step = 6 THEN
    -- S8 tổng theo nhóm dược sĩ × SP = cộng các dòng (số dòng, lượng cơ sở, GMV, tiền) và cùng store.
    IF EXISTS (SELECT 1 FROM public.cms_results r
                 LEFT JOIN (SELECT rl.user_id, rl.program_product_id, count(*) AS n, sum(sl.base_quantity) AS b,
                                   sum(sl.gmv_amount) AS g, sum(rl.amount_vnd::numeric) AS a,
                                   min(sl.store_id::text) AS s1, max(sl.store_id::text) AS s2
                              FROM public.cms_result_lines rl
                              JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
                             WHERE rl.run_id = p_run_id GROUP BY rl.user_id, rl.program_product_id) x
                   ON x.user_id = r.user_id AND x.program_product_id = r.program_product_id
                WHERE r.run_id = p_run_id
                  AND (x.n IS NULL OR x.n <> r.line_count OR x.b <> r.base_quantity OR x.g <> r.gmv_amount
                       OR x.a <> r.amount_vnd OR x.s1 <> r.store_id::text OR x.s2 <> r.store_id::text)) THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_RESULT_SUMS');
    END IF;
  ELSIF p_step = 7 THEN
    -- S9 Q = floor(max(0, B) / K) (bất đẳng thức chính xác) và F(Q) theo bậc lũy tiến. F tính MỘT lần cho mỗi cặp (SP, Q)
    -- phân biệt: tra bậc chứa Q bằng index (program_product_id, qty_from) LIMIT 1 + tiền tích luỹ các bậc trước (hash join) —
    -- O(cặp · log bậc), không O(dòng × bậc) (db-reviewer r2 P1-N1).
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
         AND (NOT (r.cms_quantity::numeric * r.per_unit <= GREATEST(r.base_quantity, 0)
                   AND GREATEST(r.base_quantity, 0) < (r.cms_quantity::numeric + 1) * r.per_unit)
              OR fq.f IS NULL OR r.potential_amount::numeric <> fq.f))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TIER_AMOUNT'); END IF;
  ELSIF p_step = 8 THEN
    -- S10 gate SP: GMV gate = tổng GMV nhóm; đạt = cuối kỳ ≥ target; "đạt từ" = lần chuyển chưa đạt → đạt gần nhất (Q-211).
    WITH l AS (
      SELECT rl.user_id, rl.program_product_id, rl.seq, sl.completed_at, sl.gmv_amount, r.target_gmv
        FROM public.cms_result_lines rl
        JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
        JOIN public.cms_results r ON r.run_id = rl.run_id AND r.user_id = rl.user_id AND r.program_product_id = rl.program_product_id
       WHERE rl.run_id = p_run_id AND r.gmv_basis = 'product'
    ), c AS (
      SELECT l.*, (sum(l.gmv_amount) OVER (PARTITION BY l.user_id, l.program_product_id ORDER BY l.seq)) >= l.target_gmv AS met FROM l
    ), x AS (
      SELECT c.*, COALESCE(lag(c.met) OVER (PARTITION BY c.user_id, c.program_product_id ORDER BY c.seq), false) AS prev_met FROM c
    ), g AS (
      SELECT user_id, program_product_id, sum(gmv_amount) AS gmv, (array_agg(met ORDER BY seq DESC))[1] AS final_met,
             max(completed_at) FILTER (WHERE met AND NOT prev_met) AS last_cross
        FROM x GROUP BY user_id, program_product_id
    )
    SELECT EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN g ON g.user_id = r.user_id AND g.program_product_id = r.program_product_id
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'product'
         AND (g.user_id IS NULL OR r.gate_gmv IS DISTINCT FROM g.gmv OR r.gate_met IS DISTINCT FROM g.final_met
              OR r.gate_met_at IS DISTINCT FROM (CASE WHEN g.final_met THEN g.last_cross END)))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_GATE'); END IF;
  ELSIF p_step = 9 THEN
    -- S11 gate danh mục theo dược sĩ (cộng GMV mọi SP GMV_TOAN_DANH_MUC theo thứ tự engine); một dòng catalog ⇔ dược sĩ có
    -- dòng danh mục; kết quả SP danh mục mang đúng gate của dược sĩ.
    WITH l AS (
      SELECT rl.user_id, rl.seq, sl.completed_at, sl.gmv_amount, sl.store_id
        FROM public.cms_result_lines rl
        JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
        JOIN public.cms_results r ON r.run_id = rl.run_id AND r.user_id = rl.user_id AND r.program_product_id = rl.program_product_id
       WHERE rl.run_id = p_run_id AND r.gmv_basis = 'catalog'
    ), c AS (
      SELECT l.*, (sum(l.gmv_amount) OVER (PARTITION BY l.user_id ORDER BY l.seq)) >= v_prog.catalog_target_gmv AS met FROM l
    ), x AS (
      SELECT c.*, COALESCE(lag(c.met) OVER (PARTITION BY c.user_id ORDER BY c.seq), false) AS prev_met FROM c
    ), g AS (
      SELECT user_id, sum(gmv_amount) AS gmv, count(*) AS n, (array_agg(met ORDER BY seq DESC))[1] AS final_met,
             max(completed_at) FILTER (WHERE met AND NOT prev_met) AS last_cross,
             min(store_id::text) AS s1, max(store_id::text) AS s2
        FROM x GROUP BY user_id
    )
    SELECT EXISTS (
      SELECT 1 FROM g FULL JOIN (SELECT * FROM public.cms_result_catalog WHERE run_id = p_run_id) k ON k.user_id = g.user_id
       WHERE g.user_id IS NULL OR k.user_id IS NULL OR k.catalog_gmv <> g.gmv OR k.line_count <> g.n
          OR k.target_gmv IS DISTINCT FROM v_prog.catalog_target_gmv OR k.met <> g.final_met
          OR k.met_at IS DISTINCT FROM (CASE WHEN g.final_met THEN g.last_cross END)
          OR k.store_id::text <> g.s1 OR k.store_id::text <> g.s2)
    OR EXISTS (
      SELECT 1 FROM public.cms_results r
        LEFT JOIN public.cms_result_catalog k ON k.run_id = r.run_id AND k.user_id = r.user_id
       WHERE r.run_id = p_run_id AND r.gmv_basis = 'catalog'
         AND (k.user_id IS NULL OR r.gate_gmv <> k.catalog_gmv OR r.gate_met <> k.met
              OR r.gate_met_at IS DISTINCT FROM k.met_at))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_CATALOG'); END IF;
  ELSE
    -- S12 phân bổ từng dòng: B trước / sau cộng dồn theo seq; Q trước / sau; tiền = gate ? A(B_sau) − A(B_trước) : 0;
    -- trạng thái dòng đúng thứ tự ưu tiên của engine.
    WITH l AS (
      SELECT rl.*, sl.base_quantity, sl.gmv_amount, r.per_unit, r.gate_met, r.cap_quantity,
             COALESCE(sum(sl.base_quantity) OVER (PARTITION BY rl.user_id, rl.program_product_id ORDER BY rl.seq
                                                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS exp_before
        FROM public.cms_result_lines rl
        JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
        JOIN public.cms_results r ON r.run_id = rl.run_id AND r.user_id = rl.user_id AND r.program_product_id = rl.program_product_id
       WHERE rl.run_id = p_run_id
    ), tc AS (
      SELECT t.program_product_id, t.tier_order,
             COALESCE(sum((t.qty_to - t.qty_from + 1)::numeric * t.amount_per_unit) OVER (PARTITION BY t.program_product_id
                      ORDER BY t.tier_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM public.cms_program_tiers t WHERE t.program_id = v_run.program_id
    ), q AS (
      -- F chỉ cần ở dòng gate đạt; mỗi cặp (SP, Q) phân biệt tính một lần (db-reviewer r2 P1-N1).
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
       WHERE f.base_before <> f.exp_before OR f.base_after <> f.exp_before + f.base_quantity
          OR NOT (f.qty_before::numeric * f.per_unit <= GREATEST(f.base_before, 0)
                  AND GREATEST(f.base_before, 0) < (f.qty_before::numeric + 1) * f.per_unit)
          OR NOT (f.qty_after::numeric * f.per_unit <= GREATEST(f.base_after, 0)
                  AND GREATEST(f.base_after, 0) < (f.qty_after::numeric + 1) * f.per_unit)
          OR (f.gate_met AND (f.f_after IS NULL OR f.f_before IS NULL))
          OR f.amount_vnd::numeric <> (CASE WHEN f.gate_met THEN f.f_after - f.f_before ELSE 0 END)
          OR f.status <> (CASE WHEN f.base_quantity < 0 OR f.gmv_amount < 0 THEN 'ADJUSTMENT'
                               WHEN NOT f.gate_met THEN 'WAITING_GATE'
                               WHEN f.amount_vnd > 0 THEN 'RECORDED'
                               WHEN f.cap_quantity IS NOT NULL AND f.qty_before >= f.cap_quantity THEN 'AT_CAP'
                               ELSE 'ACCUMULATING' END))
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_LINE_ALLOC'); END IF;
    -- S13 tổng tiền = khai báo, trong miền bigint.
    SELECT COALESCE(sum(amount_vnd::numeric), 0) INTO v_sum FROM public.cms_results WHERE run_id = p_run_id;
    IF v_sum <> (v_exp ->> 'amount_vnd')::numeric OR v_sum > 9223372036854775807 THEN
      RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TOTAL');
    END IF;
    -- S14 số đếm / tổng hiển thị cho super (totals) = dữ liệu đã stage; rows_read ≥ số ứng viên; mốc nguồn ≥ mốc dòng
    -- (db-reviewer P2-2: không ghi nguyên số app báo mà không đối chiếu).
    SELECT EXISTS (
      SELECT 1 FROM (
        SELECT count(*) AS cand,
               count(*) FILTER (WHERE disposition = 'INCLUDED') AS inc,
               count(*) FILTER (WHERE disposition = 'UNASSIGNED') AS una,
               count(*) FILTER (WHERE disposition = 'OUT_OF_SCOPE') AS oos,
               COALESCE(sum(gmv_amount), 0) AS cgmv,
               COALESCE(sum(gmv_amount) FILTER (WHERE disposition = 'UNASSIGNED'), 0) AS ugmv,
               max(source_updated_at) AS mx
          FROM public.cms_sales_lines WHERE run_id = p_run_id) a
       WHERE a.cand <> (v_exp -> 'totals' ->> 'candidates')::bigint OR a.inc <> (v_exp -> 'totals' ->> 'included')::bigint
          OR a.una <> (v_exp -> 'totals' ->> 'unassigned')::bigint OR a.oos <> (v_exp -> 'totals' ->> 'out_of_scope')::bigint
          OR a.cgmv <> (v_exp -> 'totals' ->> 'candidate_gmv')::numeric OR a.ugmv <> (v_exp -> 'totals' ->> 'unassigned_gmv')::numeric
          OR (v_exp ->> 'rows_read')::bigint < a.cand
          OR (a.mx IS NOT NULL AND (v_exp ->> 'source_max_updated_at') IS NULL)
          OR (a.mx IS NOT NULL AND (v_exp ->> 'source_max_updated_at')::timestamptz < a.mx)
          -- Mọi khoá totals còn lại cũng phải khớp dữ liệu (db-reviewer r2 N5): dòng hợp lệ = đọc − lỗi; dòng không ứng viên
          -- = hợp lệ − ứng viên; chưa gán / ngoài phạm vi theo lý do; tổng tiền; số dòng điều chỉnh.
          OR (v_exp -> 'totals' ->> 'lines_read')::bigint <> (v_exp ->> 'rows_read')::bigint - (v_exp ->> 'rows_rejected')::bigint
          OR (v_exp -> 'totals' ->> 'amount_vnd')::numeric <> v_sum
          OR (v_exp -> 'totals' ->> 'adjustment_lines')::bigint
             <> (SELECT count(*) FROM public.cms_result_lines WHERE run_id = p_run_id AND status = 'ADJUSTMENT')
          OR COALESCE((SELECT jsonb_object_agg(g.unassigned_reason, g.n) FROM (
                         SELECT unassigned_reason, count(*) AS n FROM public.cms_sales_lines
                          WHERE run_id = p_run_id AND disposition = 'UNASSIGNED' GROUP BY unassigned_reason) g), '{}'::jsonb)
             <> (v_exp -> 'totals' -> 'unassigned_by_reason')
          OR COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'UNASSIGNED')::bigint, 0) <> a.una
          OR COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'OUT_OF_SCOPE')::bigint, 0) <> a.oos
          OR COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'ORDER_NOT_ELIGIBLE')::bigint, 0)
             + COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'OUT_OF_WINDOW')::bigint, 0)
             + COALESCE((v_exp -> 'totals' -> 'excluded_by_reason' ->> 'PRODUCT_NOT_IN_PROGRAM')::bigint, 0)
             <> (v_exp -> 'totals' ->> 'lines_read')::bigint - a.cand)
    INTO v_bad;
    IF v_bad THEN RETURN public.cms__seal_fail(p_run_id, 'error', 'SEAL_TOTALS'); END IF;
    UPDATE public.cms_sync_runs SET
      seal_step = 10,
      sealed_at = now(),
      amount_vnd = v_sum::bigint,
      rows_read = (v_exp ->> 'rows_read')::integer,
      rows_rejected = (v_exp ->> 'rows_rejected')::integer,
      bytes_processed = NULLIF(v_exp ->> 'bytes_processed', '')::bigint,
      source_max_updated_at = NULLIF(v_exp ->> 'source_max_updated_at', '')::timestamptz,
      detail = detail || jsonb_build_object('totals', v_exp -> 'totals')
    WHERE id = p_run_id;
    RETURN jsonb_build_object('sealed', true, 'step', 10, 'amount_vnd', v_sum::text);
  END IF;
  UPDATE public.cms_sync_runs SET seal_step = p_step WHERE id = p_run_id;
  RETURN jsonb_build_object('sealed', false, 'ok', true, 'step', p_step);
END;
$$;

CREATE FUNCTION public.rpc_cms_sales_run_publish(p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_pid  uuid;
  v_prog public.cms_programs%ROWTYPE;
  v_run  public.cms_sync_runs%ROWTYPE;
  v_code text;
  v_prev uuid;
BEGIN
  IF p_run_id IS NULL THEN RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT program_id INTO v_pid FROM public.cms_sync_runs WHERE id = p_run_id AND kind = 'sales';
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  -- Thứ tự khoá cố định chương trình → run (cùng thứ tự open / ghi cấu hình 121) ⇒ không deadlock.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = p_run_id FOR UPDATE;
  IF v_run.status = 'ok' THEN
    RETURN jsonb_build_object('published', true, 'already', true, 'run_id', p_run_id,
                              'current', v_prog.current_result_run_id IS NOT DISTINCT FROM p_run_id);
  END IF;
  IF v_run.status <> 'running' THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
  IF v_run.sealed_at IS NULL THEN RAISE EXCEPTION 'CMS_RESULT_NOT_SEALED' USING ERRCODE = 'P0001'; END IF;
  v_code := CASE
    WHEN v_run.started_at < now() - interval '30 minutes' THEN 'STALE'
    WHEN v_prog.status = 'locked' THEN 'PROGRAM_LOCKED'
    WHEN v_prog.status <> 'active' THEN 'PROGRAM_NOT_ACTIVE'
    WHEN v_prog.config_version <> v_run.config_version OR v_prog.is_test <> v_run.is_test THEN 'CONFIG_CHANGED'
    WHEN public.cms__mapping_fp() <> v_run.mapping_fp THEN 'MAPPING_CHANGED'
    -- Q-206: chương trình thật không được công bố tiền tới khi cổng DB được mở bằng migration riêng.
    WHEN NOT v_run.is_test AND NOT public.cms__results_release_open() THEN 'RESULTS_RELEASE_GATE'
  END;
  IF v_code IS NOT NULL THEN
    UPDATE public.cms_sync_runs SET status = CASE WHEN v_code = 'STALE' THEN 'error' ELSE 'held' END,
           finished_at = now(), error_code = v_code
     WHERE id = p_run_id;
    RETURN jsonb_build_object('published', false, 'code', v_code, 'run_id', p_run_id);
  END IF;
  v_prev := v_prog.current_result_run_id;
  UPDATE public.cms_sync_runs SET status = 'ok', finished_at = now(), published_at = now() WHERE id = p_run_id;
  UPDATE public.cms_programs SET current_result_run_id = p_run_id WHERE id = v_pid;
  RETURN jsonb_build_object('published', true, 'already', false, 'run_id', p_run_id, 'previous_run_id', v_prev);
END;
$$;

CREATE FUNCTION public.rpc_cms_sales_run_finish(p_run_id uuid, p_status text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_code text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('held', 'error') THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_STATUS' USING ERRCODE = '22023';
  END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' OR pg_column_size(p_detail) > 16384
     OR NOT public.cms__str(p_detail, 'error_code', '^[A-Z][A-Z0-9_]{0,63}$')
     OR NOT public.cms__str_or_null(p_detail, 'rows_read', '^(0|[1-9][0-9]{0,8})$')
     OR NOT public.cms__str_or_null(p_detail, 'rows_rejected', '^(0|[1-9][0-9]{0,8})$')
     OR NOT public.cms__str_or_null(p_detail, 'bytes_processed', '^(0|[1-9][0-9]{0,17})$') THEN
    RAISE EXCEPTION 'CMS_SYNC_BAD_DETAIL' USING ERRCODE = '22023';
  END IF;
  v_code := p_detail ->> 'error_code';
  UPDATE public.cms_sync_runs SET
    status          = p_status,
    finished_at     = now(),
    error_code      = v_code,
    rows_read       = COALESCE((p_detail ->> 'rows_read')::integer, rows_read),
    rows_rejected   = COALESCE((p_detail ->> 'rows_rejected')::integer, rows_rejected),
    bytes_processed = COALESCE((p_detail ->> 'bytes_processed')::bigint, bytes_processed),
    detail          = detail || (p_detail - 'error_code' - 'rows_read' - 'rows_rejected' - 'bytes_processed')
  WHERE id = p_run_id AND kind = 'sales' AND status = 'running';
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_SYNC_RUN_NOT_RUNNING' USING ERRCODE = 'P0001'; END IF;
END;
$$;

-- Dọn dữ liệu run không còn đọc, THEO LÔ (db-reviewer P2-5: một câu lệnh xoá ~800k dòng có thể vượt statement_timeout 8 s):
-- mỗi lần gọi xoá tối đa p_max_rows dòng của MỘT run đích theo thứ tự FK (dòng kết quả → catalog / kết quả → dòng nguồn →
-- khối). purged_at đặt NGAY ở lô đầu ⇒ đọc run đó trả RUN_GONE, không bao giờ đọc thấy dữ liệu cụt (security review r2
-- P2-a); cleared_at đặt khi hết dữ liệu; run đang dọn dở được ưu tiên ở lần gọi sau. RETENTION (PM 03/11 §4): giữ run công
-- bố hiện hành + liền trước; dữ liệu nặng run held / error giữ TỐI ĐA 2 run gần nhất mỗi chương trình (finished_at DESC, id
-- DESC) VÀ không quá 24 h — vượt một trong hai ⇒ dọn; run running không đụng; metadata mọi run giữ (purged_at / cleared_at).
-- Khoá chia sẻ dòng chương trình ⇒ tuần tự với publish (FOR UPDATE) — run vừa công bố không lọt vào tập dọn (db-reviewer P2-1).
CREATE FUNCTION public.rpc_cms_sales_run_cleanup(p_program_id uuid, p_max_rows integer DEFAULT 50000)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $$
DECLARE
  v_cur  uuid;
  v_prev uuid;
  v_id   uuid;
  v_left integer;
  v_n    integer;
  v_del  integer := 0;
  v_done boolean := false;
BEGIN
  -- Trần 50.000 dòng / lần = lô app (r2.3, PM 03/11: lô 100.000 vượt statement_timeout 8 s trên PG15 khi máy tải; lô 50.000 đo
  -- local 1,4–3,5 s tuỳ tải, kể cả ở tập lưu giữ tối đa — dưới 8 s, không phải SLA).
  IF p_program_id IS NULL OR p_max_rows IS NULL OR p_max_rows < 1 OR p_max_rows > 50000 THEN
    RAISE EXCEPTION 'CMS_SALES_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT current_result_run_id INTO v_cur FROM public.cms_programs WHERE id = p_program_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- Tập run ok không đổi khi giữ FOR SHARE (chỉ publish đổi, cần FOR UPDATE) ⇒ v_prev ổn định trong hàm.
  SELECT id INTO v_prev FROM public.cms_sync_runs
   WHERE program_id = p_program_id AND kind = 'sales' AND status = 'ok' AND id IS DISTINCT FROM v_cur
   ORDER BY published_at DESC, id DESC LIMIT 1;
  SELECT id INTO v_id FROM public.cms_sync_runs
   WHERE program_id = p_program_id AND kind = 'sales' AND purged_at IS NOT NULL AND cleared_at IS NULL
   ORDER BY purged_at, id LIMIT 1;
  IF v_id IS NULL THEN
    -- 2 run held / error gần nhất (tie-break xác định) tính TRONG CÙNG câu lệnh chọn ứng viên (một snapshot): run vừa chuyển
    -- running → held / error giữa hai câu lệnh không thể bị chọn dọn trong khi bị loại khỏi tập giữ (db-reviewer r2.2 P2-1).
    SELECT r.id INTO v_id FROM public.cms_sync_runs r
     WHERE r.program_id = p_program_id AND r.kind = 'sales' AND r.purged_at IS NULL AND r.status <> 'running'
       AND r.id IS DISTINCT FROM v_cur AND r.id IS DISTINCT FROM v_prev
       AND (r.status = 'ok' OR r.finished_at < now() - interval '24 hours'
            OR r.id NOT IN (SELECT k.id FROM public.cms_sync_runs k
                             WHERE k.program_id = p_program_id AND k.kind = 'sales' AND k.status IN ('held', 'error')
                             ORDER BY k.finished_at DESC, k.id DESC LIMIT 2))
     ORDER BY r.started_at, r.id LIMIT 1;
    IF v_id IS NOT NULL THEN
      UPDATE public.cms_sync_runs SET purged_at = now() WHERE id = v_id AND purged_at IS NULL AND status <> 'running';
      IF NOT FOUND THEN v_id := NULL; END IF;
    END IF;
  END IF;
  IF v_id IS NOT NULL THEN
    v_left := p_max_rows;
    DELETE FROM public.cms_result_lines WHERE ctid IN (SELECT ctid FROM public.cms_result_lines WHERE run_id = v_id LIMIT v_left);
    GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_result_catalog WHERE ctid IN (SELECT ctid FROM public.cms_result_catalog WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_results WHERE ctid IN (SELECT ctid FROM public.cms_results WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sales_lines WHERE ctid IN (SELECT ctid FROM public.cms_sales_lines WHERE run_id = v_id LIMIT v_left);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n; v_left := v_left - v_n;
    END IF;
    IF v_left > 0 AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id) THEN
      DELETE FROM public.cms_sync_run_chunks WHERE run_id = v_id;
      GET DIAGNOSTICS v_n = ROW_COUNT; v_del := v_del + v_n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cms_result_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_result_catalog WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_results WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sales_lines WHERE run_id = v_id)
       AND NOT EXISTS (SELECT 1 FROM public.cms_sync_run_chunks WHERE run_id = v_id) THEN
      UPDATE public.cms_sync_runs SET cleared_at = now() WHERE id = v_id;
      v_done := true;
    END IF;
  END IF;
  RETURN jsonb_build_object('purged', CASE WHEN v_done THEN 1 ELSE 0 END, 'deleted', v_del, 'more',
    EXISTS (SELECT 1 FROM public.cms_sync_runs
             WHERE program_id = p_program_id AND kind = 'sales' AND purged_at IS NOT NULL AND cleared_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.cms_sync_runs r
                WHERE r.program_id = p_program_id AND r.kind = 'sales' AND r.purged_at IS NULL AND r.status <> 'running'
                  AND r.id IS DISTINCT FROM v_cur AND r.id IS DISTINCT FROM v_prev
                  AND (r.status = 'ok' OR r.finished_at < now() - interval '24 hours'
                       OR r.id NOT IN (SELECT k.id FROM public.cms_sync_runs k
                                        WHERE k.program_id = p_program_id AND k.kind = 'sales' AND k.status IN ('held', 'error')
                                        ORDER BY k.finished_at DESC, k.id DESC LIMIT 2))));
END;
$$;

-- ── 6. RPC đọc (authenticated; SECDEF; phạm vi hiện tại) ───────────────────
CREATE FUNCTION public.rpc_cms_result_header(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_su   boolean := public.is_super_admin();
  v_cfg  integer;
  v_r    public.cms_sync_runs%ROWTYPE;
  v_last public.cms_sync_runs%ROWTYPE;
BEGIN
  v_run := public.cms__result_run(p_program_id, NULL);
  SELECT config_version INTO v_cfg FROM public.cms_programs WHERE id = p_program_id;
  SELECT * INTO v_last FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id
   ORDER BY started_at DESC LIMIT 1;
  IF v_run IS NOT NULL THEN SELECT * INTO v_r FROM public.cms_sync_runs WHERE id = v_run; END IF;
  RETURN jsonb_build_object(
    'program_id', p_program_id,
    'config_version', v_cfg,
    'viewer', CASE WHEN v_su THEN 'super' ELSE (SELECT u.role FROM public.users u WHERE u.id = auth.uid()) END,
    'run', CASE WHEN v_run IS NULL THEN NULL ELSE
      jsonb_build_object('id', v_r.id, 'config_version', v_r.config_version, 'published_at', public.cms__ts(v_r.published_at),
                         'source_max_updated_at', public.cms__ts(v_r.source_max_updated_at), 'started_at', public.cms__ts(v_r.started_at))
      || CASE WHEN v_su THEN jsonb_build_object('amount_vnd', v_r.amount_vnd::text, 'rows_read', v_r.rows_read,
                                                'totals', v_r.detail -> 'totals') ELSE '{}'::jsonb END END,
    'last_attempt', CASE WHEN v_last.id IS NULL THEN NULL ELSE
      jsonb_build_object('status', v_last.status, 'started_at', public.cms__ts(v_last.started_at),
                         'finished_at', public.cms__ts(v_last.finished_at), 'is_current', v_last.id IS NOT DISTINCT FROM v_run)
      || CASE WHEN v_su THEN jsonb_build_object('id', v_last.id, 'error_code', v_last.error_code) ELSE '{}'::jsonb END END,
    'recent_runs', CASE WHEN v_su THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'status', q.status, 'error_code', q.error_code,
                                          'started_at', public.cms__ts(q.started_at), 'finished_at', public.cms__ts(q.finished_at),
                                          'rows_read', q.rows_read, 'amount_vnd', q.amount_vnd::text,
                                          'config_version', q.config_version, 'purged', q.purged_at IS NOT NULL)
                       ORDER BY q.started_at DESC)
        FROM (SELECT * FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = p_program_id
               ORDER BY started_at DESC LIMIT 10) q), '[]'::jsonb) END);
END;
$$;

CREATE FUNCTION public.rpc_cms_result_rows(p_program_id uuid, p_run_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_n     bigint;
BEGIN
  v_run := public.cms__result_run(p_program_id, p_run_id);
  IF v_run IS NULL THEN
    RETURN jsonb_build_object('run_id', NULL, 'results', '[]'::jsonb, 'catalog', '[]'::jsonb, 'users', '[]'::jsonb);
  END IF;
  v_users := public.cms__visible_result_users();
  SELECT count(*) INTO v_n FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users));
  IF v_n > 50000 THEN RAISE EXCEPTION 'CMS_RESULT_TOO_LARGE' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object(
    'run_id', v_run,
    'results', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id, 'store_id', r.store_id, 'program_product_id', r.program_product_id, 'product_id', r.product_id,
        'gmv_basis', r.gmv_basis, 'base_quantity', r.base_quantity::text, 'per_unit', r.per_unit::text,
        'cms_quantity', r.cms_quantity::text, 'rewarded_quantity', r.rewarded_quantity::text,
        'cap_quantity', r.cap_quantity::text, 'at_cap', r.at_cap, 'gmv_amount', r.gmv_amount::text,
        'gate_gmv', r.gate_gmv::text, 'target_gmv', r.target_gmv::text, 'gate_met', r.gate_met,
        'gate_met_at', public.cms__ts(r.gate_met_at), 'potential_amount', r.potential_amount::text,
        'amount_vnd', r.amount_vnd::text, 'line_count', r.line_count) ORDER BY r.user_id, r.product_id)
      FROM public.cms_results r WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users))), '[]'::jsonb),
    'catalog', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', k.user_id, 'store_id', k.store_id, 'catalog_gmv', k.catalog_gmv::text, 'target_gmv', k.target_gmv::text,
        'met', k.met, 'met_at', public.cms__ts(k.met_at), 'line_count', k.line_count) ORDER BY k.user_id)
      FROM public.cms_result_catalog k WHERE k.run_id = v_run AND (v_users IS NULL OR k.user_id = ANY (v_users))), '[]'::jsonb),
    'users', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'full_name', u.full_name, 'store_id', u.store_id)
                                        ORDER BY u.id)
      FROM public.users u WHERE u.id IN (SELECT r.user_id FROM public.cms_results r
                                          WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users)))), '[]'::jsonb));
END;
$$;

CREATE FUNCTION public.rpc_cms_result_lines(p_program_id uuid, p_run_id uuid, p_program_product_id uuid DEFAULT NULL,
                                            p_user_id uuid DEFAULT NULL, p_after_seq integer DEFAULT NULL,
                                            p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run   uuid;
  v_users uuid[];
  v_rows  jsonb;
  v_next  integer;
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  v_users := public.cms__visible_result_users();
  IF p_user_id IS NOT NULL AND v_users IS NOT NULL AND NOT (p_user_id = ANY (v_users)) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
      'completed_at', public.cms__ts(q.completed_at), 'quantity_raw', q.quantity_raw, 'uom_raw', q.uom_raw,
      'base_quantity', q.base_quantity::text, 'gmv_amount', q.gmv_amount::text, 'base_before', q.base_before::text,
      'base_after', q.base_after::text, 'qty_before', q.qty_before::text, 'qty_after', q.qty_after::text,
      'amount_vnd', q.amount_vnd::text, 'status', q.status) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT rl.seq, rl.order_line_id, sl.order_code, sl.product_id, rl.program_product_id, rl.user_id, sl.store_id,
                 sl.pos_code, sl.completed_at, sl.quantity_raw, sl.uom_raw, sl.base_quantity, sl.gmv_amount, rl.base_before,
                 rl.base_after, rl.qty_before, rl.qty_after, rl.amount_vnd, rl.status
            FROM public.cms_result_lines rl
            JOIN public.cms_sales_lines sl ON sl.run_id = rl.run_id AND sl.order_line_id = rl.order_line_id
           WHERE rl.run_id = v_run
             AND (v_users IS NULL OR rl.user_id = ANY (v_users))
             AND (p_user_id IS NULL OR rl.user_id = p_user_id)
             AND (p_program_product_id IS NULL OR rl.program_product_id = p_program_product_id)
             AND rl.seq > COALESCE(p_after_seq, -1)
           ORDER BY rl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;

CREATE FUNCTION public.rpc_cms_result_excluded(p_program_id uuid, p_run_id uuid, p_after_seq integer DEFAULT NULL,
                                               p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run  uuid;
  v_rows jsonb;
  v_next integer;
BEGIN
  IF p_run_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_after_seq IS NOT NULL AND p_after_seq < 0) THEN
    RAISE EXCEPTION 'CMS_RESULT_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- Định danh nguồn lỗi (email người bán) chỉ cho super admin — kiểm TRƯỚC khi tra run để non-super không phân biệt được
  -- RUN_GONE / FORBIDDEN (không dò được run tồn tại — security review P2).
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  v_run := public.cms__result_run(p_program_id, p_run_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'order_line_id', q.order_line_id, 'order_code', q.order_code, 'product_id', q.product_id,
      'program_product_id', q.program_product_id, 'disposition', q.disposition, 'unassigned_reason', q.unassigned_reason,
      'seller_email', q.seller_email, 'user_id', q.user_id, 'store_id', q.store_id, 'pos_code', q.pos_code,
      'completed_at', public.cms__ts(q.completed_at), 'base_quantity', q.base_quantity::text,
      'gmv_amount', q.gmv_amount::text) ORDER BY q.seq), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.cms_sales_lines sl
           WHERE sl.run_id = v_run AND sl.disposition <> 'INCLUDED' AND sl.seq > COALESCE(p_after_seq, -1)
           ORDER BY sl.seq LIMIT p_limit + 1) q;
  IF jsonb_array_length(v_rows) > p_limit THEN
    v_rows := v_rows - p_limit;
    v_next := (v_rows -> (p_limit - 1) ->> 'seq')::integer;
  END IF;
  RETURN jsonb_build_object('run_id', v_run, 'rows', v_rows, 'next_after_seq', v_next);
END;
$$;

-- ── 7. ACL hàm: thu hồi đích danh rồi cấp đúng ma trận ─────────────────────
REVOKE ALL ON FUNCTION
  public.cms__str(jsonb, text, text), public.cms__str_or_null(jsonb, text, text), public.cms__ts(timestamptz),
  public.cms__norm_email(text), public.cms__mapping_fp(), public.cms__sales_snapshot(uuid),
  public.cms__seal_fail(uuid, text, text), public.cms__visible_result_users(), public.cms__result_run(uuid, uuid),
  public.cms__programs_result_guard(), public.cms__results_release_open(),
  public.rpc_cms_sales_snapshot(uuid), public.rpc_cms_sales_run_open(uuid, jsonb),
  public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb), public.rpc_cms_sales_run_seal_begin(uuid, jsonb),
  public.rpc_cms_sales_run_seal_step(uuid, integer),
  public.rpc_cms_sales_run_publish(uuid), public.rpc_cms_sales_run_finish(uuid, text, jsonb),
  public.rpc_cms_sales_run_cleanup(uuid, integer),
  public.rpc_cms_result_header(uuid), public.rpc_cms_result_rows(uuid, uuid),
  public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer), public.rpc_cms_result_excluded(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.rpc_cms_sales_snapshot(uuid), public.rpc_cms_sales_run_open(uuid, jsonb),
  public.rpc_cms_sales_run_stage(uuid, text, integer, jsonb), public.rpc_cms_sales_run_seal_begin(uuid, jsonb),
  public.rpc_cms_sales_run_seal_step(uuid, integer),
  public.rpc_cms_sales_run_publish(uuid), public.rpc_cms_sales_run_finish(uuid, text, jsonb),
  public.rpc_cms_sales_run_cleanup(uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.rpc_cms_result_header(uuid), public.rpc_cms_result_rows(uuid, uuid),
  public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer), public.rpc_cms_result_excluded(uuid, uuid, integer, integer)
  TO authenticated;
-- Thu hồi mọi grant khác owner do default privileges cấp (vd. postgres) — bài học SEC-1 / 090→091 / 117 / 120.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, x.grantee
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('cms__str', 'cms__str_or_null', 'cms__ts', 'cms__norm_email', 'cms__mapping_fp', 'cms__sales_snapshot',
                         'cms__seal_fail', 'cms__visible_result_users', 'cms__result_run', 'cms__programs_result_guard',
                         'cms__results_release_open',
                         'rpc_cms_sales_snapshot', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_seal_begin',
                         'rpc_cms_sales_run_seal_step',
                         'rpc_cms_sales_run_publish', 'rpc_cms_sales_run_finish', 'rpc_cms_sales_run_cleanup',
                         'rpc_cms_result_header', 'rpc_cms_result_rows', 'rpc_cms_result_lines', 'rpc_cms_result_excluded')
       AND x.grantee <> p.proowner
       AND NOT (p.proname LIKE 'rpc\_cms\_sales\_%' AND x.grantee = 'service_role'::regrole::oid)
       AND NOT (p.proname LIKE 'rpc\_cms\_result\_%' AND x.grantee = 'authenticated'::regrole::oid)
     GROUP BY p.oid, x.grantee
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.fn);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;

-- ── 8. Hậu kiểm trong transaction ──────────────────────────────────────────
DO $$
DECLARE
  v_new  text[] := ARRAY['cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines'];
  v_fns  text[] := ARRAY['cms__str', 'cms__str_or_null', 'cms__ts', 'cms__norm_email', 'cms__mapping_fp', 'cms__sales_snapshot',
                         'cms__seal_fail', 'cms__visible_result_users', 'cms__result_run', 'cms__programs_result_guard',
                         'cms__results_release_open',
                         'rpc_cms_sales_snapshot', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_seal_begin',
                         'rpc_cms_sales_run_seal_step',
                         'rpc_cms_sales_run_publish', 'rpc_cms_sales_run_finish', 'rpc_cms_sales_run_cleanup',
                         'rpc_cms_result_header', 'rpc_cms_result_rows', 'rpc_cms_result_lines', 'rpc_cms_result_excluded'];
  v_t    text;
  v_priv text;
  v_exp  text;
  r      record;
BEGIN
  FOREACH v_t IN ARRAY v_new LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = ('public.' || v_t)::regclass AND c.relrowsecurity) THEN
      RAISE EXCEPTION '122 hậu kiểm: % chưa bật RLS', v_t;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('anon', 'public.' || v_t, v_priv) OR has_table_privilege('authenticated', 'public.' || v_t, v_priv) THEN
        RAISE EXCEPTION '122 hậu kiểm: anon / authenticated có % trên %', v_priv, v_t;
      END IF;
      IF NOT has_table_privilege('service_role', 'public.' || v_t, v_priv) THEN
        RAISE EXCEPTION '122 hậu kiểm: service_role thiếu % trên %', v_priv, v_t;
      END IF;
    END LOOP;
  END LOOP;
  -- Bảng cũ: cms_sync_runs vẫn không cấp authenticated; cms_programs vẫn chỉ SELECT.
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('authenticated', 'public.cms_sync_runs', v_priv) OR has_table_privilege('anon', 'public.cms_sync_runs', v_priv)
       OR has_table_privilege('anon', 'public.cms_programs', v_priv)
       OR (v_priv <> 'SELECT' AND has_table_privilege('authenticated', 'public.cms_programs', v_priv)) THEN
      RAISE EXCEPTION '122 hậu kiểm: quyền bảng cũ bị đổi (%)', v_priv;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'cms\_%') <> 6
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (v_new)) THEN
    RAISE EXCEPTION '122 hậu kiểm: policy CMS phải giữ đúng 6 (không policy cho bảng kết quả)';
  END IF;
  IF to_regclass('public.cms_sync_runs_one_running') IS NULL OR to_regclass('public.cms_result_lines_d3_idx') IS NULL
     OR to_regclass('public.cms_sales_lines_product_fk_idx') IS NULL OR to_regclass('public.cms_results_product_fk_idx') IS NULL
     OR to_regclass('public.cms_program_tiers_product_from_idx') IS NULL THEN
    RAISE EXCEPTION '122 hậu kiểm: thiếu index';
  END IF;
  -- Cấu trúc (db-reviewer r2.2 P2-2 — LIKE riêng lọt partial / INCLUDE): đúng bảng, UNIQUE / valid / ready, không vị từ,
  -- không biểu thức, đúng 2 cột khoá theo thứ tự (program_product_id, qty_from), ASC mặc định.
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = 'public.cms_program_tiers_product_from_idx'::regclass
                  AND i.indrelid = 'public.cms_program_tiers'::regclass
                  AND i.indisunique AND i.indisvalid AND i.indisready
                  AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnatts = 2 AND i.indnkeyatts = 2
                  AND i.indkey[0] = (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.cms_program_tiers'::regclass AND a.attname = 'program_product_id')
                  AND i.indkey[1] = (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.cms_program_tiers'::regclass AND a.attname = 'qty_from')
                  AND i.indoption[0] = 0 AND i.indoption[1] = 0
                  AND pg_get_indexdef(i.indexrelid) LIKE '%UNIQUE INDEX%(program_product_id, qty_from)') THEN
    RAISE EXCEPTION '122 hậu kiểm: cms_program_tiers_product_from_idx phải UNIQUE, hợp lệ, đúng cột';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cms_programs'::regclass AND tgname = 'cms_programs_result_guard'
                  AND NOT tgisinternal) THEN
    RAISE EXCEPTION '122 hậu kiểm: thiếu trigger cms_programs_result_guard';
  END IF;
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl IS NULL AS acl_default,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ':'
                              || x.privilege_type, ',')
              FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_fns)
  LOOP
    IF NOT ('search_path=public' = ANY (r.proconfig)) THEN
      RAISE EXCEPTION '122 hậu kiểm: % phải SET search_path = public', r.proname;
    END IF;
    IF r.proname <> 'cms__programs_result_guard' AND NOT r.prosecdef THEN
      RAISE EXCEPTION '122 hậu kiểm: % phải SECURITY DEFINER', r.proname;
    END IF;
    IF r.proname LIKE 'rpc\_cms\_sales\_%' AND r.proname <> 'rpc_cms_sales_snapshot' AND NOT ('lock_timeout=5s' = ANY (r.proconfig)) THEN
      RAISE EXCEPTION '122 hậu kiểm: % thiếu lock_timeout=5s', r.proname;
    END IF;
    IF r.proname = 'rpc_cms_sales_run_seal_step' AND NOT ('enable_nestloop=off' = ANY (r.proconfig)) THEN
      RAISE EXCEPTION '122 hậu kiểm: rpc_cms_sales_run_seal_step thiếu enable_nestloop=off';
    END IF;
    v_exp := CASE WHEN r.proname LIKE 'rpc\_cms\_sales\_%' THEN 'service_role:EXECUTE'
                  WHEN r.proname LIKE 'rpc\_cms\_result\_%' THEN 'authenticated:EXECUTE' END;
    IF r.acl_default OR r.acl IS DISTINCT FROM v_exp THEN
      RAISE EXCEPTION '122 hậu kiểm: ACL % = % (mặc định = %) sai ma trận', r.proname, r.acl, r.acl_default;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles ro ON ro.oid = p.proowner
                    WHERE p.oid = r.oid AND (ro.rolsuper OR ro.rolbypassrls)) THEN
      RAISE EXCEPTION '122 hậu kiểm: owner của % phải superuser / BYPASSRLS', r.proname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_fns)) <> 23 THEN
    RAISE EXCEPTION '122 hậu kiểm: số hàm 122 khác 23 (overload lạ?)';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND (p.proname LIKE 'cms\_%' OR p.proname LIKE 'rpc\_cms\_%')) <> 37 THEN
    RAISE EXCEPTION '122 hậu kiểm: tổng hàm CMS khác 37 (120: 7 · 121: 7 · 122: 23)';
  END IF;
END $$;

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('122', 'cms_results', 'CMS P2-b: snapshot đầu vào / kết quả theo run, stage-seal-publish atomic qua pointer, RPC đọc theo phạm vi hiện tại');

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — Dev qua wrapper; sub-agent không gọi prod) ──
-- V1 marker:  SELECT version, name FROM public.app_migrations WHERE version IN ('121','122') ORDER BY 1;   -- 122 | cms_results
-- V2 hàm:     cùng truy vấn V2 của 121 với 23 hàm 122 (proname LIKE 'cms\_\_%' OR LIKE 'rpc\_cms\_sales\_%' OR LIKE
--             'rpc\_cms\_result\_%' — kèm 3 helper 121 cms__vn_today / cms__lock_catalog / cms__conflicts ⇒ 26 dòng): 8
--             rpc_cms_sales_* svc_x t, anon / auth f; 4 rpc_cms_result_* auth_x t, anon / svc f; cms__* mọi cột f, proacl
--             chỉ owner; mọi hàm SECDEF trừ cms__programs_result_guard; proconfig có search_path=public; rpc_cms_sales_* (trừ
--             snapshot) có lock_timeout=5s; rpc_cms_sales_run_seal_step có enable_nestloop=off.
-- V2b cổng:   SELECT public.cms__results_release_open();   -- false (Q-206 HOLD)
-- V2c index:  SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('cms_sales_lines_product_fk_idx',
--             'cms_results_product_fk_idx', 'cms_program_tiers_product_from_idx', 'cms_result_lines_d3_idx',
--             'cms_result_lines_seq_idx', 'cms_sales_lines_excluded_idx', 'cms_sync_runs_program_idx');   -- 7 dòng
-- V2d timeout: SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('authenticator','service_role','authenticated');
--             (căn cứ ngân sách RPC < 8 s); số bậc tối đa / SP của chương trình hiện có (đầu vào ước lượng seal bước 7 / 10).
-- V3 bảng:    SELECT c.relname, c.relrowsecurity, c.relacl::text FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
--               AND c.relname IN ('cms_sync_run_chunks','cms_sales_lines','cms_results','cms_result_catalog','cms_result_lines');
--             kỳ vọng RLS t; không 'anon=' / 'authenticated='; service_role=arwdDxt (postgres theo default privileges như 120).
-- V4 policy:  6 dòng như sau 120 (không thêm).
-- V5 ảnh ACL hàm ngoài CMS = ảnh PRE chụp NGAY TRƯỚC 122 (n_fn / md5 như V6 của 120).
-- V6 cms_sync_runs: SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.cms_sync_runs'::regclass
--             ORDER BY 1;   kỳ vọng thêm cms_sync_runs_id_program / _kind_shape / _sales_publish / _seal_pair; kind_check gồm
--             'sales'.
-- V7 hành vi (READ ONLY, vai authenticated của super không marker): rpc_cms_result_header(<chương trình thật>) ⇒ run null;
--             rpc_cms_result_rows ⇒ results []; chương trình is_test ⇒ CMS_RESULT_FORBIDDEN.
