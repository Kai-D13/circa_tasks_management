-- ============================================================================
-- 131_cms_program_revision.sql  (CANDIDATE r3 — F-A sửa chương trình CMS có version; Dev 17/11/2026; r3 theo audit cuối PM 17/11, chờ PM
-- audit lại; CHƯA commit, KHÔNG chạy prod)
-- SINH bằng webapp/scripts/gen-cms-131.mjs từ webapp/scripts/cms-131/131.template.sql (điền khối hậu kiểm md5 thân hàm). KHÔNG sửa tay
-- — `node scripts/gen-cms-131.mjs --check` phát hiện lệch.
-- Số 131 = số PM dành trong khối Hiện trạng sống STATE (17/11); predecessor THỰC 130 cms_calculation_modes_returns (127a là adhoc không
-- số — không vào phép so số). Nguồn: planning/research/cms-program-revision-import-spec-2026-11-17.md §1–§3 + review PM
-- planning/reviews/2026-11-17-cms-adhoc-reimport-and-next-pm.md (Q-235 đã chốt: super sửa SP / K / mức khi chưa chốt, giữ lịch sử,
-- xác nhận tác động, tính lại cả kỳ). KHÔNG sửa 120 / 121 / 125 / 130; hàm thay ghim md5 bản cuối 120–130.
--
-- Nội dung:
--   R1. cms_program_products.retired_at / retired_revision_id: SP bị bỏ mà ĐÃ có dữ liệu run (FK) ⇒ retire logic (không DELETE, không
--       CASCADE); SP chưa có dữ liệu run ⇒ xoá thường. RLS đọc SP ẩn dòng retire. Thêm lại SP đã retire = bật lại ĐÚNG dòng cũ (một bản).
--   R2. cms_program_revisions (preview → committed; snapshot cấu hình trước / sau; diff theo ProductID; impact + nguồn ghim; idempotency)
--       + cms_program_revision_results (lưu trữ BẤT BIẾN số đã hiển thị trước sửa: run / config thật, dược sĩ, SP, lượng / GMV / Q / tiền,
--       đơn vị / K / bậc của run) — ngoài purge, owner-only, đọc qua RPC super.
--   R3. Thay 4 hàm (ghim md5): cms__sales_snapshot / cms__conflicts / cms__program_scope_hash lọc SP retire; cms__result_run che run
--       tính theo cấu hình TRƯỚC một lần sửa đã ghi (không ghép K mới với Q / tiền cũ — app cũ lẫn mới; super đọc tường minh được).
--   R4. RPC mới, authenticated EXECUTE nhưng DB tự kiểm auth.uid() + is_super_admin() (không nhận p_actor). r3 (PM audit cuối 17/11
--       P1-01): preview BẮT BUỘC expected_run_id (UUID / JSON null; thiếu trường ⇒ BAD_INPUT) = run app đã dùng để dự toán, so dưới
--       FOR SHARE với pointer hiện hành (lệch ⇒ PREVIEW_STALE, không tạo revision); impact 'ok' phải tham chiếu đúng run đó:
--       rpc_cms_program_revision_preview / _commit, reader super rpc_cms_program_revisions / rpc_cms_program_revision /
--       rpc_cms_program_revision_archive; rpc_cms_program_revision_state (người đọc được chương trình — chỉ cờ "đang tính lại");
--       rpc_cms_revision_capabilities (service_role — app biết DB có 131).
--   R5. Trigger cms_revision_policy_guard trên cms_programs (ENABLE ALWAYS): chặn đổi returns_policy khi chương trình có SP retire
--       (seal contract N9 của 130 băm MỌI dòng SP kể cả retire ⇒ bật net sau khi bỏ SP sẽ SEAL_PIN_SCOPE vĩnh viễn — db-reviewer 17/11
--       P1-1). Tổ hợp "đã bỏ SP + trừ trả hàng" cần thiết kế riêng.
-- Không UPDATE dữ liệu sẵn có, không đổi config_version / pointer / run. Không DISABLE TRIGGER, không session_replication_role.
-- Cờ app CMS_PROGRAM_REVISION_ENABLED (mặc định OFF) KHÔNG được DB đọc: super gọi thẳng RPC vẫn phải qua đủ guard DB (quyền, trạng thái,
-- preview chưa hết hạn của chính mình, version / pointer / mapping, xác nhận). Cờ chỉ là rollout app.
--
-- Triển khai (runbook — chỉ khi PM cho): app flag-OFF bản biết 131 trước; READ COMMITTED; role owner bảng / hàm CMS; dán NGUYÊN FILE
-- (giữ LF; md5 thân hàm bỏ \r). ROLLBACK: rollback/131_cms_program_revision_rollback.sql — DỪNG nếu đã có revision committed / lưu trữ /
-- SP retire; gồm DELETE FROM app_migrations WHERE version = '131'. Rollback APP về bản không biết revision sau lần sửa đầu: KHÔNG an toàn
-- (runbook §R) — tắt cờ ghi, giữ app biết 131.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
-- Khoá TRƯỚC preflight, cùng chiều RPC (chương trình → cấu hình → run).
LOCK TABLE public.cms_programs, public.cms_program_products, public.cms_program_tiers, public.cms_sync_runs IN ACCESS EXCLUSIVE MODE;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
  v_acl  text;
  v_q    text;
  r      record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '131: cần READ COMMITTED';
  END IF;
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION '131: cần PostgreSQL ≥ 15, có %', current_setting('server_version');
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '130';
  IF v_name IS DISTINCT FROM 'cms_calculation_modes_returns' THEN
    RAISE EXCEPTION '131: thiếu migration nền 130 cms_calculation_modes_returns (name = %)', v_name;
  END IF;
  SELECT name INTO v_name FROM public.app_migrations WHERE version = '131';
  IF FOUND THEN
    RAISE EXCEPTION '131: đã có marker 131 (name = %) — không chạy lại / không chạy chồng', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 130) THEN
    RAISE EXCEPTION '131: DB đã có migration số > 130 — dừng';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r0 WHERE r0.rolname = current_user AND (r0.rolsuper OR r0.rolbypassrls)) THEN
    RAISE EXCEPTION '131: role chạy migration (%) không phải superuser / BYPASSRLS', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname LIKE 'cms\_%'
                AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rpc\_cms\_%' OR p.proname LIKE 'cms\_%')
                   AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '131: owner bảng / hàm CMS khác role chạy (%)', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE status = 'running') THEN
    RAISE EXCEPTION '131: còn run đang chạy (status running) — chờ kết thúc / STALE rồi chạy lại';
  END IF;
  IF to_regprocedure('public.is_super_admin()') IS NULL THEN
    RAISE EXCEPTION '131: thiếu public.is_super_admin()';
  END IF;
  -- Chưa có đối tượng 131 (không chạy chồng sau rollback dở).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.cms_program_products'::regclass AND attname IN ('retired_at', 'retired_revision_id') AND NOT attisdropped)
     OR to_regclass('public.cms_program_revisions') IS NOT NULL OR to_regclass('public.cms_program_revision_results') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (@@NEW_NAMES@@)) THEN
    RAISE EXCEPTION '131: đã có cột / bảng / hàm của 131 — DB không ở trạng thái nền 130';
  END IF;
  -- ACL nền của hàm sắp thay (OR REPLACE giữ ACL): cả 4 là owner-only.
  FOR r IN SELECT x.sig FROM (VALUES ('cms__sales_snapshot(uuid)'), ('cms__conflicts(uuid,boolean,date,date,text[])'),
                                     ('cms__program_scope_hash(uuid)'), ('cms__result_run(uuid,uuid)')) AS x(sig) LOOP
    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ',')
      INTO v_acl FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE p.oid = to_regprocedure('public.' || r.sig) AND a.grantee <> p.proowner;
    IF to_regprocedure('public.' || r.sig) IS NULL OR v_acl IS NOT NULL THEN
      RAISE EXCEPTION '131: ACL nền % khác chỉ owner (có %)', r.sig, COALESCE(v_acl, 'không có hàm');
    END IF;
  END LOOP;
  -- Policy đọc SP nền 120 (sẽ thêm điều kiện retire) phải đúng biểu thức gốc.
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_q FROM pg_catalog.pg_policy p
   WHERE p.polrelid = 'public.cms_program_products'::regclass AND p.polname = 'cms_program_products_select';
  IF v_q IS DISTINCT FROM '(program_id = ANY (( SELECT cms_readable_program_ids() AS cms_readable_program_ids)::uuid[]))'
     OR (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = 'public.cms_program_products'::regclass) <> 1 THEN
    RAISE EXCEPTION '131: policy cms_program_products_select khác nền 120 (%)', v_q;
  END IF;
END $$;
-- Thân 4 hàm sắp thay + guard / helper 131 dựa vào phải đúng nguyên văn bản cuối 120–130.
DO $$
BEGIN
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__sales_snapshot(uuid)')) IS DISTINCT FROM 'b8fc8150ff3d733f4a73b8a19dc22daa'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__conflicts(uuid,boolean,date,date,text[])')) IS DISTINCT FROM '216655ef1643470997c122c8b07452b6'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__program_scope_hash(uuid)')) IS DISTINCT FROM '8a4abd995e0a14fb55cb827a5c668a5e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__result_run(uuid,uuid)')) IS DISTINCT FROM '25bb3fdec9ac322765beaa0abdcd9686' THEN
    RAISE EXCEPTION '131 preflight: thân một trong 4 hàm sắp thay KHÁC bản cuối 120–130 đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
  IF (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__programs_result_guard()')) IS DISTINCT FROM '8784c4589f1d3875b50d015223fc7b93'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__config_auth_guard()')) IS DISTINCT FROM 'd960d7d4465da96de1fdca09ecee3abf'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__config_lock_guard()')) IS DISTINCT FROM 'bcd7ae0e4b4857b42b5904d6570625d0'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__tiers_last_open_guard()')) IS DISTINCT FROM 'd83088c260633f520dac35cfe8169475'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__products_basis_guard()')) IS DISTINCT FROM '23f9afeb1655bf939b7b53327d2a0d77'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__programs_basis_guard()')) IS DISTINCT FROM '534964b54b91f5b6d00c9c9916c38edb'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__programs_lock_guard()')) IS DISTINCT FROM '23201e6389865e668665951d611e46de'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__lock_catalog()')) IS DISTINCT FROM 'fecf90f6f288981191b6f7e693990839'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms__mapping_fp()')) IS DISTINCT FROM 'dccfda328687f8c40eb002235b831161'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.cms_readable_program_ids()')) IS DISTINCT FROM '8a1159cb1bedc275f5131b4c2184c19e'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_sales_run_open(uuid,jsonb)')) IS DISTINCT FROM 'c9bafba3b88949308c10b4f06732f106'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_import_commit(uuid,text,text,jsonb,uuid)')) IS DISTINCT FROM '65bd0b43e24fda590eec4cd764f959c2'
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.rpc_cms_program_activate(uuid,uuid)')) IS DISTINCT FROM '6ae92590bf7afc237c80cc3db15e5aad' THEN
    RAISE EXCEPTION '131 preflight: thân guard / helper nền (13 hàm ghim) KHÁC bản cuối 120–130 — dừng, đối chiếu tay';
  END IF;
END $$;

-- ── R2. Bảng revision + lưu trữ (trước R1 vì FK retired_revision_id) ─────────
CREATE TABLE public.cms_program_revisions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id          uuid        NOT NULL REFERENCES public.cms_programs(id),
  status              text        NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'committed')),
  -- Super đã preview (auth.uid() lúc preview); commit chỉ được bởi ĐÚNG người này.
  actor_id            uuid        NOT NULL,
  program_status      text        NOT NULL CHECK (program_status IN ('draft', 'active')),
  from_config_version integer     NOT NULL CHECK (from_config_version >= 1),
  to_config_version   integer,
  -- Pointer kết quả lúc preview (NULL = chưa có run công bố) — commit đòi không đổi.
  expected_run_id     uuid,
  mapping_fp          text        NOT NULL CHECK (mapping_fp ~ '^[0-9a-f]{32}$'),
  file_sha256         text        NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  -- Danh mục mong muốn đã chuẩn hoá (DB kiểm + chuẩn hoá) và digest sha256 của nó.
  payload             jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest      text        NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  diff                jsonb       NOT NULL CHECK (jsonb_typeof(diff) = 'object'),
  before_snapshot     jsonb       NOT NULL CHECK (jsonb_typeof(before_snapshot) = 'object'),
  after_snapshot      jsonb       CHECK (after_snapshot IS NULL OR jsonb_typeof(after_snapshot) = 'object'),
  -- Dự toán tác động (app tính engine trước / sau trên CÙNG một tập nguồn + mapping ghim) và danh tính nguồn đó.
  impact              jsonb       NOT NULL CHECK (jsonb_typeof(impact) = 'object' AND pg_column_size(impact) <= 262144),
  source_identity     jsonb       NOT NULL CHECK (jsonb_typeof(source_identity) = 'object' AND pg_column_size(source_identity) <= 4096),
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  committed_at        timestamptz,
  committed_by        uuid,
  idempotency_key     uuid,
  reason              text        CHECK (reason IS NULL OR (char_length(btrim(reason)) BETWEEN 10 AND 1000 AND reason !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]')),
  ack                 jsonb       CHECK (ack IS NULL OR jsonb_typeof(ack) = 'object'),
  -- Lưu trữ số hiển thị trước sửa: 'none' (không có pointer), 'copied' (chép ở lần này), 'reused' (run đã được lần sửa trước chép).
  archive_mode        text        CHECK (archive_mode IS NULL OR archive_mode IN ('none', 'copied', 'reused')),
  archive_run_id      uuid        REFERENCES public.cms_sync_runs(id),
  archive_run_config_version integer,
  archive_rows        integer     CHECK (archive_rows IS NULL OR archive_rows >= 0),
  archive_amount_vnd  bigint      CHECK (archive_amount_vnd IS NULL OR archive_amount_vnd >= 0),
  CONSTRAINT cms_program_revisions_commit CHECK (
    (status = 'committed') = (committed_at IS NOT NULL)
    AND (status = 'committed') = (to_config_version IS NOT NULL)
    AND (status = 'committed') = (committed_by IS NOT NULL)
    AND (status = 'committed') = (idempotency_key IS NOT NULL)
    AND (status = 'committed') = (reason IS NOT NULL)
    AND (status = 'committed') = (ack IS NOT NULL)
    AND (status = 'committed') = (after_snapshot IS NOT NULL)
    AND (status = 'committed') = (archive_mode IS NOT NULL)),
  CONSTRAINT cms_program_revisions_cv CHECK (to_config_version IS NULL OR to_config_version = from_config_version + 1),
  CONSTRAINT cms_program_revisions_actor CHECK (committed_by IS NULL OR committed_by = actor_id),
  CONSTRAINT cms_program_revisions_archive CHECK (
    (archive_mode IS NULL AND archive_run_id IS NULL AND archive_rows IS NULL AND archive_amount_vnd IS NULL AND archive_run_config_version IS NULL)
    OR (archive_mode = 'none' AND archive_run_id IS NULL AND archive_rows IS NULL AND archive_amount_vnd IS NULL AND archive_run_config_version IS NULL)
    OR (archive_mode IN ('copied', 'reused') AND archive_run_id IS NOT NULL AND archive_rows IS NOT NULL AND archive_amount_vnd IS NOT NULL
        AND archive_run_config_version IS NOT NULL))
);
-- Một revision committed cho mỗi bước version; idempotency theo chương trình.
CREATE UNIQUE INDEX cms_program_revisions_to_cv ON public.cms_program_revisions (program_id, to_config_version) WHERE status = 'committed';
CREATE UNIQUE INDEX cms_program_revisions_idem ON public.cms_program_revisions (program_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX cms_program_revisions_program_idx ON public.cms_program_revisions (program_id, created_at DESC);
CREATE INDEX cms_program_revisions_from_cv ON public.cms_program_revisions (program_id, from_config_version) WHERE status = 'committed';
-- Một run chỉ được CHÉP lưu trữ một lần (lần sửa sau dùng lại).
CREATE UNIQUE INDEX cms_program_revisions_archive_run ON public.cms_program_revisions (archive_run_id) WHERE archive_mode = 'copied';

CREATE TABLE public.cms_program_revision_results (
  revision_id        uuid    NOT NULL REFERENCES public.cms_program_revisions(id),
  program_id         uuid    NOT NULL REFERENCES public.cms_programs(id),
  run_id             uuid    NOT NULL REFERENCES public.cms_sync_runs(id),
  run_config_version integer NOT NULL CHECK (run_config_version >= 1),
  user_id            uuid    NOT NULL,
  store_id           uuid    NOT NULL,
  -- Không FK tới cms_program_products: SP có thể bị xoá (chưa từng có dữ liệu run) — lưu trữ tự đủ để đọc.
  program_product_id uuid    NOT NULL,
  product_id         text    NOT NULL CHECK (product_id ~ '^[1-9][0-9]{0,18}$'),
  gmv_basis          text    NOT NULL CHECK (gmv_basis IN ('product', 'catalog', 'none')),
  target_gmv         bigint,
  -- K THỰC của run (cms_results.per_unit) — luôn có.
  per_unit           numeric NOT NULL CHECK (per_unit > 0),
  -- Đơn vị + thang bậc của cấu hình run: 'exact' (run cùng version với cấu hình lúc sửa và K cấu hình = K run) / 'unknown' (run khác
  -- version — vd đã nạp thêm / datafix sau run — hoặc K lệch ⇒ NULL, không gán cấu hình hiện hành cho run khác version: spec §3, PM
  -- audit 17/11 P1-2). 'unchanged_since_run' giữ trong CHECK cho tương thích đọc, 131 r2 KHÔNG sinh.
  config_basis       text    NOT NULL CHECK (config_basis IN ('exact', 'unchanged_since_run', 'unknown')),
  unit_cms           text,
  tiers              jsonb,
  base_quantity      numeric NOT NULL,
  cms_quantity       bigint  NOT NULL CHECK (cms_quantity >= 0),
  rewarded_quantity  bigint  NOT NULL CHECK (rewarded_quantity >= 0),
  gmv_amount         numeric NOT NULL,
  gate_met           boolean NOT NULL,
  potential_amount   bigint  NOT NULL CHECK (potential_amount >= 0),
  amount_vnd         bigint  NOT NULL CHECK (amount_vnd >= 0),
  line_count         integer NOT NULL CHECK (line_count >= 1),
  PRIMARY KEY (revision_id, user_id, program_product_id),
  CONSTRAINT cms_program_revision_results_cfg CHECK ((config_basis = 'unknown') = (unit_cms IS NULL) AND (config_basis = 'unknown') = (tiers IS NULL))
);
CREATE INDEX cms_program_revision_results_run_idx ON public.cms_program_revision_results (run_id);

ALTER TABLE public.cms_program_revisions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_program_revision_results ENABLE ROW LEVEL SECURITY;
-- Không policy; không vai trò client nào truy cập trực tiếp (đọc / ghi chỉ qua RPC SECDEF cùng owner).
REVOKE ALL ON public.cms_program_revisions, public.cms_program_revision_results FROM PUBLIC, anon, authenticated, service_role;

-- Bất biến: revision chỉ INSERT ở 'previewed'; một lần chuyển previewed → committed giữ nguyên mọi cột của preview; không xoá.
CREATE FUNCTION public.cms__revision_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'previewed' OR NEW.committed_at IS NOT NULL THEN
      RAISE EXCEPTION 'CMS_REVISION_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR OLD.status = 'committed' OR NEW.status <> 'committed'
     OR (NEW.id, NEW.program_id, NEW.actor_id, NEW.program_status, NEW.from_config_version, NEW.expected_run_id, NEW.mapping_fp,
         NEW.file_sha256, NEW.payload, NEW.payload_digest, NEW.diff, NEW.before_snapshot, NEW.impact, NEW.source_identity,
         NEW.expires_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.program_id, OLD.actor_id, OLD.program_status, OLD.from_config_version, OLD.expected_run_id, OLD.mapping_fp,
         OLD.file_sha256, OLD.payload, OLD.payload_digest, OLD.diff, OLD.before_snapshot, OLD.impact, OLD.source_identity,
         OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'CMS_REVISION_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE FUNCTION public.cms__revision_results_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  RAISE EXCEPTION 'CMS_REVISION_ARCHIVE_IMMUTABLE' USING ERRCODE = '42501';
END;
$fn$;
CREATE TRIGGER cms_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cms_program_revisions
  FOR EACH ROW EXECUTE FUNCTION public.cms__revision_guard();
CREATE TRIGGER cms_revision_truncate BEFORE TRUNCATE ON public.cms_program_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__revision_results_guard();
CREATE TRIGGER cms_revision_results_immutable BEFORE UPDATE OR DELETE ON public.cms_program_revision_results
  FOR EACH ROW EXECUTE FUNCTION public.cms__revision_results_guard();
CREATE TRIGGER cms_revision_results_truncate BEFORE TRUNCATE ON public.cms_program_revision_results
  FOR EACH STATEMENT EXECUTE FUNCTION public.cms__revision_results_guard();
ALTER TABLE public.cms_program_revisions ENABLE ALWAYS TRIGGER cms_revision_guard;
ALTER TABLE public.cms_program_revisions ENABLE ALWAYS TRIGGER cms_revision_truncate;
ALTER TABLE public.cms_program_revision_results ENABLE ALWAYS TRIGGER cms_revision_results_immutable;
ALTER TABLE public.cms_program_revision_results ENABLE ALWAYS TRIGGER cms_revision_results_truncate;

-- ── R1. SP retire + RLS đọc chỉ danh mục hiệu lực ────────────────────────────
ALTER TABLE public.cms_program_products
  ADD COLUMN retired_at          timestamptz,
  ADD COLUMN retired_revision_id uuid REFERENCES public.cms_program_revisions(id),
  ADD CONSTRAINT cms_program_products_retired CHECK ((retired_at IS NULL) = (retired_revision_id IS NULL));
-- Policy cùng bảng (không tham chiếu bảng RLS khác — luật §4.1): thêm điều kiện cột của chính dòng.
ALTER POLICY cms_program_products_select ON public.cms_program_products
  USING (retired_at IS NULL AND program_id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]));

-- ── R5. Chặn đổi returns_policy khi chương trình có SP retire (db-reviewer 17/11 P1-1) ─────────────
-- Seal contract (N9, 130) băm MỌI dòng cms_program_products của chương trình (kể cả retire) còn worker chỉ gửi SP hiệu lực ⇒ chương
-- trình pos_base đã bỏ SP có dữ liệu rồi chuyển net_returns_v1 sẽ dừng SEAL_PIN_SCOPE mãi. 131 không hỗ trợ tổ hợp này ⇒ chặn MỌI
-- đường đổi returns_policy (RPC 130 lẫn UPDATE trực tiếp của owner — ENABLE ALWAYS) khi còn SP retire. Không đụng hàm 130.
CREATE FUNCTION public.cms__revision_policy_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.returns_policy IS DISTINCT FROM OLD.returns_policy
     AND EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = NEW.id AND pp.retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_RETURNS_POLICY_RETIRED_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER cms_revision_policy_guard BEFORE UPDATE ON public.cms_programs
  FOR EACH ROW EXECUTE FUNCTION public.cms__revision_policy_guard();
ALTER TABLE public.cms_programs ENABLE ALWAYS TRIGGER cms_revision_policy_guard;

-- ── R3. Hàm thay (thân gốc + đúng một thay đổi mỗi hàm) ─────────────────────
-- 131: danh mục cho worker = SP HIỆU LỰC (retired_at IS NULL).
CREATE OR REPLACE FUNCTION public.cms__sales_snapshot(p_program_id uuid)
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
        'base_quantity_cms', pp.base_quantity_cms::text, 'unit_cms', pp.unit_cms,
        'tiers', COALESCE((SELECT jsonb_agg(jsonb_build_object('order', t.tier_order, 'from', t.qty_from, 'to', t.qty_to,
                                                               'amount', t.amount_per_unit::text) ORDER BY t.tier_order)
                             FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id), '[]'::jsonb))
        ORDER BY pp.product_id) FROM public.cms_program_products pp WHERE pp.program_id = p.id AND pp.retired_at IS NULL), '[]'::jsonb),
    'sellers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'role', u.role, 'store_id', u.store_id)
                                          ORDER BY u.id) FROM public.users u), '[]'::jsonb),
    'stores', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'store_type', s.store_type, 'is_active', s.is_active)
                                         ORDER BY s.id) FROM public.stores s), '[]'::jsonb),
    'mapping_fp', public.cms__mapping_fp(),
    -- 130: chế độ của CHƯƠNG TRÌNH (run ghim riêng ở open); app cũ bỏ qua khoá lạ.
    'quantity_basis', p.quantity_basis, 'returns_policy', p.returns_policy)
  FROM public.cms_programs p WHERE p.id = p_program_id
$$;

-- 131: SP đã retire của chương trình khác không chặn trùng (không còn được tính ở đó).
CREATE OR REPLACE FUNCTION public.cms__conflicts(p_program_id uuid, p_is_test boolean, p_start date, p_end date, p_ids text[])
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT pp.product_id ORDER BY pp.product_id), '{}'::text[])
    FROM public.cms_program_products pp
    JOIN public.cms_programs o ON o.id = pp.program_id
   WHERE o.id <> p_program_id
     AND o.status IN ('active', 'locked')
     AND o.is_test = p_is_test
     AND o.start_date <= p_end AND o.end_date >= p_start
     AND pp.product_id = ANY (COALESCE(p_ids, '{}'::text[]))
     AND pp.retired_at IS NULL
$$;

-- 131: phạm vi chứng nhận nguồn = SP hiệu lực (cùng tập worker đọc).
CREATE OR REPLACE FUNCTION public.cms__program_scope_hash(p_program_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(sha256(convert_to(
           '[' || public.cms__fp_j('cms-rows-fp-v1') || ',' || public.cms__fp_j('scope') || ','
           || public.cms__fp_j(to_char(p.start_date, 'YYYY-MM-DD')) || ',' || public.cms__fp_j(to_char(p.end_date, 'YYYY-MM-DD')) || ',['
           || COALESCE((SELECT string_agg(public.cms__fp_j(x.product_id), ',' ORDER BY convert_to(x.product_id, 'UTF8'))
                          FROM (SELECT DISTINCT pp.product_id FROM public.cms_program_products pp WHERE pp.program_id = p.id AND pp.retired_at IS NULL) x), '')
           || ']]', 'UTF8')), 'hex')
    FROM public.cms_programs p WHERE p.id = p_program_id
$$;

-- 131: run tính theo cấu hình TRƯỚC một lần sửa đã ghi (from_config_version ≥ version của run) không còn là "kết quả hiện hành":
-- đọc mặc định (p_run_id NULL) ⇒ NULL (UI "chờ tính lại sau thay đổi cấu hình", không 0₫ giả, không ghép K mới với Q / tiền cũ);
-- đọc tường minh run đó ⇒ chỉ super (xem bản trước sửa có mốc), vai khác CMS_RESULT_RUN_GONE (trang cũ tải lại).
CREATE OR REPLACE FUNCTION public.cms__result_run(p_program_id uuid, p_run_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cur uuid;
  v_run uuid;
  v_cv  integer;
BEGIN
  IF auth.uid() IS NULL OR p_program_id IS NULL OR NOT (p_program_id = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT current_result_run_id INTO v_cur FROM public.cms_programs WHERE id = p_program_id;
  v_run := COALESCE(p_run_id, v_cur);
  IF v_run IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT r.config_version INTO v_cv FROM public.cms_sync_runs r
   WHERE r.id = v_run AND r.program_id = p_program_id AND r.kind = 'sales' AND r.status = 'ok' AND r.purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CMS_RESULT_RUN_GONE' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_program_revisions v
              WHERE v.program_id = p_program_id AND v.status = 'committed' AND v.from_config_version >= v_cv) THEN
    IF p_run_id IS NULL THEN
      RETURN NULL;
    END IF;
    IF NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'CMS_RESULT_RUN_GONE' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN v_run;
END;
$$;

-- ── R4. Helper nội bộ (owner-only) ──────────────────────────────────────────
-- Thang bậc chuẩn hoá của một SP (cùng dạng payload chuẩn hoá: order / from / to số nguyên, amount chuỗi).
CREATE FUNCTION public.cms__revision_tiers(p_pp uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('order', t.tier_order, 'from', t.qty_from, 'to', t.qty_to,
                                               'amount', t.amount_per_unit::text) ORDER BY t.tier_order), '[]'::jsonb)
    FROM public.cms_program_tiers t WHERE t.program_product_id = p_pp
$fn$;

-- Cấu hình HIỆU LỰC chuẩn hoá (snapshot trước / sau của revision; so lúc commit để phát hiện ghi ngoài luồng). K = trim_scale.
CREATE FUNCTION public.cms__revision_config(p_program_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT jsonb_build_object(
    'config_version', p.config_version, 'status', p.status, 'catalog_target_gmv', p.catalog_target_gmv::text,
    'quantity_basis', p.quantity_basis, 'returns_policy', p.returns_policy,
    'start_date', to_char(p.start_date, 'YYYY-MM-DD'), 'end_date', to_char(p.end_date, 'YYYY-MM-DD'), 'scope', p.scope,
    'products', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'product_id', pp.product_id, 'gmv_basis', pp.gmv_basis, 'target_gmv', pp.target_gmv::text, 'unit_cms', pp.unit_cms,
        'base_quantity_cms', trim_scale(pp.base_quantity_cms)::text, 'advice_text', pp.advice_text, 'name_snapshot', pp.name_snapshot,
        'tiers', public.cms__revision_tiers(pp.id)) ORDER BY pp.product_id COLLATE "C")
      FROM public.cms_program_products pp WHERE pp.program_id = p.id AND pp.retired_at IS NULL), '[]'::jsonb))
  FROM public.cms_programs p WHERE p.id = p_program_id
$fn$;

-- Rào chắn trạng thái (spec §1): NULL = được sửa. Không đọc run đang chạy (commit kiểm BUSY riêng dưới khoá).
CREATE FUNCTION public.cms__revision_blocker(p_program_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_prog public.cms_programs%ROWTYPE;
BEGIN
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  IF NOT FOUND THEN RETURN 'CMS_PROGRAM_NOT_FOUND'; END IF;
  IF v_prog.status = 'locked' THEN RETURN 'CMS_PROGRAM_LOCKED'; END IF;
  IF v_prog.status NOT IN ('draft', 'active') THEN RETURN 'CMS_REVISION_STATUS'; END IF;
  IF v_prog.returns_policy IS DISTINCT FROM 'sales_only_v1' THEN RETURN 'CMS_REVISION_NET_UNSUPPORTED'; END IF;
  IF v_prog.quantity_basis_source = 'pending' OR (v_prog.status = 'active' AND v_prog.quantity_basis IS NULL) THEN
    RETURN 'CMS_REVISION_BASIS_PENDING';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_payouts x WHERE x.program_id = p_program_id) THEN RETURN 'CMS_REVISION_PAYOUT_EXISTS'; END IF;
  IF EXISTS (SELECT 1 FROM public.cms_source_attestations x WHERE x.program_id = p_program_id) THEN RETURN 'CMS_REVISION_ATTESTED'; END IF;
  IF EXISTS (SELECT 1 FROM public.cms_return_ledger_evals x WHERE x.program_id = p_program_id)
     OR EXISTS (SELECT 1 FROM public.cms_return_baselines x WHERE x.program_id = p_program_id)
     OR EXISTS (SELECT 1 FROM public.cms_return_close_reports x WHERE x.program_id = p_program_id) THEN
    RETURN 'CMS_REVISION_LEDGER_EXISTS';
  END IF;
  RETURN NULL;
END;
$fn$;

-- Kiểm + chuẩn hoá danh mục mong muốn (cùng hợp đồng payload rpc_cms_import_commit 121 / 125) ⇒
-- {catalog_target, products: [{product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms (trim_scale), advice_text, name_snapshot,
--   image_url_snapshot, price_snapshot, tiers: [{order, from, to, amount}]}] sắp theo ProductID}. Sai ⇒ RAISE (không ghi gì).
CREATE FUNCTION public.cms__revision_norm(p_products jsonb, p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  e         jsonb;
  t         jsonb;
  v_k       integer;
  v_prev_to integer;
  v_tiers   integer := 0;
  v_cat     text;
  v_has_cat boolean := false;
  v_out     jsonb[] := '{}';
  v_tn      jsonb;
BEGIN
  IF jsonb_typeof(p_products) IS DISTINCT FROM 'array' OR jsonb_array_length(p_products) NOT BETWEEN 1 AND 2000
     OR COALESCE(jsonb_typeof(p_catalog), 'null') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'CMS_REVISION_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_catalog) = 'string' THEN
    IF (p_catalog #>> '{}') !~ '^[1-9][0-9]{0,18}$' OR (p_catalog #>> '{}')::numeric > 9223372036854775807 THEN
      RAISE EXCEPTION 'CMS_REVISION_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    v_cat := p_catalog #>> '{}';
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_products) x LOOP
    IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'CMS_REVISION_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(e->'product_id') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'gmv_basis') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e->'unit_cms') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'advice_text') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e->'name_snapshot') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'base_quantity_cms') IS DISTINCT FROM 'string'
       OR COALESCE(jsonb_typeof(e->'target_gmv'), '-') NOT IN ('string', 'null')
       OR COALESCE(jsonb_typeof(e->'image_url_snapshot'), '-') NOT IN ('string', 'null')
       OR COALESCE(jsonb_typeof(e->'price_snapshot'), '-') NOT IN ('string', 'null')
       OR jsonb_typeof(e->'tiers') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'CMS_REVISION_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF (e->>'product_id') !~ '^[1-9][0-9]{0,18}$' OR (e->>'gmv_basis') NOT IN ('product', 'catalog', 'none')
       OR (e->>'base_quantity_cms') !~ '^[0-9]{1,29}(\.[0-9]{1,9})?$' OR (e->>'base_quantity_cms') !~ '[1-9]'
       OR (jsonb_typeof(e->'price_snapshot') = 'string' AND (e->>'price_snapshot') !~ '^[0-9]{1,15}(\.[0-9]{1,9})?$')
       OR ((e->>'gmv_basis') = 'product') IS DISTINCT FROM (jsonb_typeof(e->'target_gmv') = 'string')
       OR (jsonb_typeof(e->'target_gmv') = 'string' AND (e->>'target_gmv') !~ '^[1-9][0-9]{0,18}$')
       OR char_length(e->>'unit_cms') NOT BETWEEN 1 AND 50 OR (e->>'unit_cms') !~ '\S'
       OR char_length(e->>'advice_text') NOT BETWEEN 1 AND 4000 OR (e->>'advice_text') !~ '\S'
       OR char_length(e->>'name_snapshot') NOT BETWEEN 1 AND 500 OR (e->>'name_snapshot') !~ '\S'
       OR (jsonb_typeof(e->'image_url_snapshot') = 'string'
           AND ((e->>'image_url_snapshot') !~ '^https://' OR char_length(e->>'image_url_snapshot') > 2000))
       OR jsonb_array_length(e->'tiers') NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'CMS_REVISION_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(e->'target_gmv') = 'string' AND (e->>'target_gmv')::numeric > 9223372036854775807 THEN
      RAISE EXCEPTION 'CMS_REVISION_BAD_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF (e->>'gmv_basis') = 'catalog' THEN v_has_cat := true; END IF;
    v_tiers := v_tiers + jsonb_array_length(e->'tiers');
    v_prev_to := 0;
    v_tn := '[]'::jsonb;
    FOR t, v_k IN SELECT x, n::integer FROM jsonb_array_elements(e->'tiers') WITH ORDINALITY a(x, n) LOOP
      IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR jsonb_typeof(t->'order') IS DISTINCT FROM 'number'
         OR jsonb_typeof(t->'from') IS DISTINCT FROM 'number' OR COALESCE(jsonb_typeof(t->'to'), '-') NOT IN ('number', 'null')
         OR jsonb_typeof(t->'amount') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'CMS_REVISION_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      IF (t->>'order') !~ '^[1-9][0-9]{0,9}$' OR (t->>'from') !~ '^[1-9][0-9]{0,9}$'
         OR (jsonb_typeof(t->'to') = 'number' AND (t->>'to') !~ '^[1-9][0-9]{0,9}$')
         OR (t->>'amount') !~ '^[1-9][0-9]{0,18}$' THEN
        RAISE EXCEPTION 'CMS_REVISION_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      IF (t->>'order')::bigint <> v_k OR (t->>'from')::bigint <> v_prev_to::bigint + 1
         OR (t->>'amount')::numeric > 9223372036854775807
         OR (jsonb_typeof(t->'to') = 'null' AND v_k <> jsonb_array_length(e->'tiers'))
         OR (t->>'from')::bigint > 2147483647
         OR (jsonb_typeof(t->'to') = 'number' AND ((t->>'to')::bigint < (t->>'from')::bigint OR (t->>'to')::bigint > 2147483647)) THEN
        RAISE EXCEPTION 'CMS_REVISION_BAD_TIERS' USING ERRCODE = '22023';
      END IF;
      v_prev_to := CASE WHEN jsonb_typeof(t->'to') = 'number' THEN (t->>'to')::integer ELSE v_prev_to END;
      v_tn := v_tn || jsonb_build_array(jsonb_build_object('order', (t->>'order')::integer, 'from', (t->>'from')::integer,
                'to', CASE WHEN jsonb_typeof(t->'to') = 'number' THEN to_jsonb((t->>'to')::integer) ELSE 'null'::jsonb END,
                'amount', ((t->>'amount')::bigint)::text));
    END LOOP;
    -- 125 (CMS-Q-220): bậc cuối không giới hạn.
    IF jsonb_typeof((e->'tiers')->(jsonb_array_length(e->'tiers') - 1)->'to') IS DISTINCT FROM 'null' THEN
      RAISE EXCEPTION 'CMS_REVISION_TIER_LAST_FINITE' USING ERRCODE = '22023';
    END IF;
    v_out := array_append(v_out, jsonb_build_object(
      'product_id', e->>'product_id', 'gmv_basis', e->>'gmv_basis', 'target_gmv', e->>'target_gmv', 'unit_cms', e->>'unit_cms',
      'base_quantity_cms', trim_scale((e->>'base_quantity_cms')::numeric)::text, 'advice_text', e->>'advice_text',
      'name_snapshot', e->>'name_snapshot', 'image_url_snapshot', e->>'image_url_snapshot',
      'price_snapshot', CASE WHEN jsonb_typeof(e->'price_snapshot') = 'string' THEN e->>'price_snapshot' END, 'tiers', v_tn));
  END LOOP;
  IF v_tiers > 2000 THEN RAISE EXCEPTION 'CMS_REVISION_BAD_TIERS' USING ERRCODE = '22023'; END IF;
  IF v_has_cat AND v_cat IS NULL THEN RAISE EXCEPTION 'CMS_REVISION_BAD_PAYLOAD' USING ERRCODE = '22023'; END IF;
  IF (SELECT count(*) - count(DISTINCT x->>'product_id') FROM unnest(v_out) x) <> 0 THEN
    RAISE EXCEPTION 'CMS_REVISION_BAD_PAYLOAD' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('catalog_target', CASE WHEN v_has_cat THEN v_cat END,
    'products', (SELECT jsonb_agg(x ORDER BY x->>'product_id' COLLATE "C") FROM unnest(v_out) x));
END;
$fn$;

-- Diff theo ProductID giữa danh mục hiệu lực (+ SP đã retire) và danh mục mong muốn đã chuẩn hoá. RAISE khi file đổi thuộc tính ngoài
-- phạm vi batch (spec §1): đơn vị / loại GMV / target của SP có sẵn, thêm / bỏ SP danh mục, target danh mục; bỏ SP đã có dữ liệu run ở
-- chương trình tính theo đơn vị CMS (con dấu hợp đồng N9 tính trên mọi SP — chưa hỗ trợ retire, finding báo PM).
CREATE FUNCTION public.cms__revision_diff(p_program_id uuid, p_norm jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_prog  public.cms_programs%ROWTYPE;
  e       jsonb;
  pp      record;
  v_items jsonb[] := '{}';
  v_ids   text[];
  v_act   text;
  v_tb    jsonb;
  v_ref   boolean;
  n_add integer := 0; n_readd integer := 0; n_change integer := 0; n_keep integer := 0; n_remove integer := 0;
  v_removed text[] := '{}';
BEGIN
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = p_program_id;
  SELECT COALESCE(array_agg(x->>'product_id'), '{}') INTO v_ids FROM jsonb_array_elements(p_norm->'products') x;
  -- Target danh mục (không đổi trong batch này).
  IF (p_norm->>'catalog_target') IS NOT NULL AND (p_norm->>'catalog_target') IS DISTINCT FROM v_prog.catalog_target_gmv::text THEN
    RAISE EXCEPTION 'CMS_REVISION_CATALOG_UNSUPPORTED' USING ERRCODE = 'P0001';
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_norm->'products') x LOOP
    SELECT p.id, p.gmv_basis, p.target_gmv, p.unit_cms, p.base_quantity_cms, p.advice_text, p.retired_at INTO pp
      FROM public.cms_program_products p WHERE p.program_id = p_program_id AND p.product_id = e->>'product_id';
    IF NOT FOUND THEN
      IF (e->>'gmv_basis') = 'catalog' THEN RAISE EXCEPTION 'CMS_REVISION_CATALOG_UNSUPPORTED' USING ERRCODE = 'P0001'; END IF;
      n_add := n_add + 1;
      v_items := array_append(v_items, jsonb_build_object('product_id', e->>'product_id', 'action', 'add',
        'k_before', NULL, 'k_after', e->>'base_quantity_cms', 'tiers_before', NULL, 'tiers_after', e->'tiers', 'advice_changed', false,
        'unit_cms', e->>'unit_cms', 'name', e->>'name_snapshot'));
      CONTINUE;
    END IF;
    IF (e->>'gmv_basis') IS DISTINCT FROM pp.gmv_basis OR (e->>'target_gmv') IS DISTINCT FROM pp.target_gmv::text
       OR (e->>'unit_cms') IS DISTINCT FROM pp.unit_cms THEN
      RAISE EXCEPTION 'CMS_REVISION_FIELD_LOCKED' USING ERRCODE = 'P0001', DETAIL = e->>'product_id';
    END IF;
    v_tb := public.cms__revision_tiers(pp.id);
    IF pp.retired_at IS NOT NULL THEN
      v_act := 'readd'; n_readd := n_readd + 1;
    ELSIF (e->>'base_quantity_cms')::numeric = pp.base_quantity_cms AND (e->'tiers') = v_tb AND (e->>'advice_text') = pp.advice_text THEN
      v_act := 'keep'; n_keep := n_keep + 1;
    ELSE
      v_act := 'change'; n_change := n_change + 1;
    END IF;
    v_items := array_append(v_items, jsonb_build_object('product_id', e->>'product_id', 'action', v_act,
      'k_before', trim_scale(pp.base_quantity_cms)::text, 'k_after', e->>'base_quantity_cms', 'tiers_before', v_tb, 'tiers_after', e->'tiers',
      'advice_changed', (e->>'advice_text') IS DISTINCT FROM pp.advice_text, 'unit_cms', pp.unit_cms, 'name', e->>'name_snapshot'));
  END LOOP;
  FOR pp IN SELECT p.id, p.product_id, p.gmv_basis, p.unit_cms, p.base_quantity_cms, p.name_snapshot FROM public.cms_program_products p
             WHERE p.program_id = p_program_id AND p.retired_at IS NULL AND NOT (p.product_id = ANY (v_ids)) ORDER BY p.product_id COLLATE "C" LOOP
    IF pp.gmv_basis = 'catalog' THEN RAISE EXCEPTION 'CMS_REVISION_CATALOG_UNSUPPORTED' USING ERRCODE = 'P0001'; END IF;
    v_ref := EXISTS (SELECT 1 FROM public.cms_sales_lines s WHERE s.program_product_id = pp.id AND s.program_id = p_program_id)
          OR EXISTS (SELECT 1 FROM public.cms_results r WHERE r.program_product_id = pp.id AND r.program_id = p_program_id);
    IF v_ref AND v_prog.quantity_basis IS DISTINCT FROM 'pos_base' THEN
      RAISE EXCEPTION 'CMS_REVISION_REMOVE_UNSUPPORTED' USING ERRCODE = 'P0001', DETAIL = pp.product_id;
    END IF;
    n_remove := n_remove + 1;
    v_removed := v_removed || pp.product_id;
    v_items := array_append(v_items, jsonb_build_object('product_id', pp.product_id, 'action', 'remove',
      'k_before', trim_scale(pp.base_quantity_cms)::text, 'k_after', NULL, 'tiers_before', public.cms__revision_tiers(pp.id),
      'tiers_after', NULL, 'advice_changed', false, 'unit_cms', pp.unit_cms, 'name', pp.name_snapshot, 'referenced', v_ref));
  END LOOP;
  IF n_add + n_readd + n_change + n_remove = 0 THEN
    RAISE EXCEPTION 'CMS_REVISION_NO_CHANGE' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('add', n_add, 'readd', n_readd, 'change', n_change, 'keep', n_keep, 'remove', n_remove,
    'removed', to_jsonb(v_removed), 'products_after', jsonb_array_length(p_norm->'products'),
    'items', (SELECT jsonb_agg(x ORDER BY x->>'product_id' COLLATE "C") FROM unnest(v_items) x));
END;
$fn$;

-- ── R4. RPC ─────────────────────────────────────────────────────────────────
-- Preview: super (DB kiểm), chương trình đọc được (QA cần marker), đủ điều kiện; lưu danh mục chuẩn hoá + diff + impact app tính trên
-- nguồn ghim (mapping_fp phải = hiện tại, from_config_version = hiện tại). Hạn 15 phút, gắn người preview. Không đổi cấu hình.
CREATE FUNCTION public.rpc_cms_program_revision_preview(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_pid  uuid;
  v_prog public.cms_programs%ROWTYPE;
  v_code text;
  v_norm jsonb;
  v_diff jsonb;
  v_imp  jsonb;
  v_src  jsonb;
  v_dig  text;
  v_id   uuid;
  v_exp  timestamptz := now() + interval '15 minutes';
  v_new  text[];
  v_xrun uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'CMS_REVISION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- expected_run_id BẮT BUỘC có mặt (UUID hoặc JSON null = "chưa có run" — r3, PM P1-01): pointer app đã dùng để dự toán. Thiếu trường
  -- ≠ null; không lấy pointer DB mới để lấp.
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR pg_column_size(p) > 8388608
     OR NOT public.cms__str(p, 'program_id', '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR NOT public.cms__str(p, 'file_sha256', '^[0-9a-f]{64}$')
     OR jsonb_typeof(p->'impact') IS DISTINCT FROM 'object' OR jsonb_typeof(p->'source') IS DISTINCT FROM 'object'
     OR NOT (p ? 'expected_run_id')
     OR COALESCE(jsonb_typeof(p->'expected_run_id'), '') NOT IN ('string', 'null')
     OR (jsonb_typeof(p->'expected_run_id') = 'string'
         AND NOT public.cms__str(p, 'expected_run_id', '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'CMS_REVISION_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  v_xrun := CASE WHEN jsonb_typeof(p->'expected_run_id') = 'string' THEN (p->>'expected_run_id')::uuid END;
  v_pid := (p->>'program_id')::uuid;
  IF NOT (v_pid = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- FOR SHARE: publish / chốt / sửa (FOR UPDATE) chờ tới hết transaction preview ⇒ pointer so dưới đây không đổi trước INSERT.
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_pid FOR SHARE;
  v_code := public.cms__revision_blocker(v_pid);
  IF v_code IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE = v_code, ERRCODE = 'P0001'; END IF;
  v_imp := p->'impact';
  v_src := p->'source';
  IF pg_column_size(v_imp) > 262144 OR pg_column_size(v_src) > 4096 OR (v_imp->>'status') IS NULL OR (v_imp->>'status') NOT IN ('ok', 'error')
     OR NOT public.cms__str(v_src, 'mapping_fp', '^[0-9a-f]{32}$') THEN
    RAISE EXCEPTION 'CMS_REVISION_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  -- Impact phải được tính trên ĐÚNG version + mapping hiện hành (không dùng nguồn / cấu hình cũ).
  IF (v_imp->>'from_config_version') IS DISTINCT FROM v_prog.config_version::text THEN
    RAISE EXCEPTION 'CMS_REVISION_PREVIEW_STALE' USING ERRCODE = 'P0001';
  END IF;
  -- r3 (PM P1-01): run hiện hành lúc lưu preview phải ĐÚNG pointer app đã dùng (run đổi giữa đọc nguồn và RPC ⇒ dự toán + số tham chiếu
  -- thuộc run khác) ⇒ STALE, không tạo revision.
  IF v_prog.current_result_run_id IS DISTINCT FROM v_xrun THEN
    RAISE EXCEPTION 'CMS_REVISION_PREVIEW_STALE' USING ERRCODE = 'P0001';
  END IF;
  -- Dự toán 'ok' phải tham chiếu ĐÚNG run đã ghim (số "đang công bố" trong impact = pointer gửi kèm).
  -- Thiếu khoá ≠ JSON null (cùng luật expected_run_id — db-reviewer r3 P2-2).
  IF (v_imp->>'status') = 'ok' AND (jsonb_typeof(v_imp->'totals') IS DISTINCT FROM 'object' OR NOT (v_imp->'totals' ? 'published_run_id')
       OR (v_imp->'totals'->>'published_run_id') IS DISTINCT FROM v_xrun::text) THEN
    RAISE EXCEPTION 'CMS_REVISION_IMPACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF (v_src->>'mapping_fp') IS DISTINCT FROM public.cms__mapping_fp() THEN
    RAISE EXCEPTION 'CMS_REVISION_MAPPING_CHANGED' USING ERRCODE = 'P0001';
  END IF;
  v_norm := public.cms__revision_norm(p->'products', p->'catalog_target');
  v_diff := public.cms__revision_diff(v_pid, v_norm);
  SELECT COALESCE(array_agg(x->>'product_id'), '{}') INTO v_new FROM jsonb_array_elements(v_diff->'items') x WHERE x->>'action' = 'add';
  IF EXISTS (SELECT 1 FROM unnest(v_new) x WHERE NOT EXISTS (SELECT 1 FROM public.cms_product_master m WHERE m.product_id = x)) THEN
    RAISE EXCEPTION 'CMS_REVISION_PRODUCT_UNKNOWN' USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(public.cms__conflicts(v_pid, v_prog.is_test, v_prog.start_date, v_prog.end_date,
       ARRAY(SELECT x->>'product_id' FROM jsonb_array_elements(v_norm->'products') x))) > 0 THEN
    RAISE EXCEPTION 'CMS_REVISION_PRODUCT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  v_dig := encode(sha256(convert_to(v_norm::text, 'UTF8')), 'hex');
  INSERT INTO public.cms_program_revisions (program_id, actor_id, program_status, from_config_version, expected_run_id, mapping_fp,
      file_sha256, payload, payload_digest, diff, before_snapshot, impact, source_identity, expires_at)
  VALUES (v_pid, v_uid, v_prog.status, v_prog.config_version, v_xrun, v_src->>'mapping_fp',
      p->>'file_sha256', v_norm, v_dig, v_diff, public.cms__revision_config(v_pid), v_imp, v_src, v_exp)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('revision_id', v_id, 'program_id', v_pid, 'from_config_version', v_prog.config_version,
    'expected_run_id', v_xrun, 'payload_digest', v_dig, 'expires_at', public.cms__ts(v_exp),
    'impact_ok', (v_imp->>'status') = 'ok',
    'diff', v_diff);
END;
$fn$;

-- Commit: một transaction — kiểm lại mọi điều kiện dưới khoá (chương trình → run), lưu trữ số đang hiển thị, áp danh mục, version +1,
-- revision committed. Lỗi bất kỳ ⇒ không đổi gì. Cùng revision + cùng key + cùng digest ⇒ trả lại (already); khác key ⇒ từ chối.
CREATE FUNCTION public.rpc_cms_program_revision_commit(p_revision_id uuid, p_expected_config_version integer, p_payload_digest text,
                                                       p_idempotency_key uuid, p_reason text, p_ack jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET lock_timeout = '5s' AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_pid    uuid;
  v_prog   public.cms_programs%ROWTYPE;
  v_rev    public.cms_program_revisions%ROWTYPE;
  v_run    public.cms_sync_runs%ROWTYPE;
  v_code   text;
  e        jsonb;
  v_pp     public.cms_program_products%ROWTYPE;
  v_ppid   uuid;
  v_ids    text[];
  v_mode   text;
  v_arows  integer;
  v_aamt   bigint;
  v_acv    integer;
  v_arun   uuid;
  v_src    public.cms_program_revisions%ROWTYPE;
  v_after  jsonb;
  v_today  date := public.cms__vn_today();
  v_retired integer := 0;
  v_deleted integer := 0;
  v_first  text;
  v_nret   integer;
BEGIN
  IF v_uid IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'CMS_REVISION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_revision_id IS NULL OR p_expected_config_version IS NULL OR p_idempotency_key IS NULL
     OR p_payload_digest IS NULL OR p_payload_digest !~ '^[0-9a-f]{64}$' OR p_ack IS NULL OR jsonb_typeof(p_ack) <> 'object'
     OR pg_column_size(p_ack) > 65536 THEN
    RAISE EXCEPTION 'CMS_REVISION_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 10 AND 1000 OR p_reason ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RAISE EXCEPTION 'CMS_REVISION_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT program_id INTO v_pid FROM public.cms_program_revisions WHERE id = p_revision_id;
  IF NOT FOUND OR NOT (v_pid = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_REVISION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- Thứ tự khoá chuẩn: chương trình → revision → run (cùng chiều open / publish / chốt).
  SELECT * INTO v_prog FROM public.cms_programs WHERE id = v_pid FOR UPDATE;
  SELECT * INTO v_rev FROM public.cms_program_revisions WHERE id = p_revision_id FOR UPDATE;
  IF v_rev.actor_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'CMS_REVISION_NOT_OWNER' USING ERRCODE = '42501';
  END IF;
  IF v_rev.status = 'committed' THEN
    IF v_rev.idempotency_key = p_idempotency_key AND v_rev.payload_digest = p_payload_digest THEN
      RETURN jsonb_build_object('already', true, 'revision_id', v_rev.id, 'program_id', v_pid,
        'from_config_version', v_rev.from_config_version, 'to_config_version', v_rev.to_config_version,
        'archive_mode', v_rev.archive_mode, 'archive_rows', v_rev.archive_rows);
    END IF;
    RAISE EXCEPTION 'CMS_REVISION_IDEMPOTENCY_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_program_revisions WHERE program_id = v_pid AND idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'CMS_REVISION_IDEMPOTENCY_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_rev.expires_at <= now() THEN
    RAISE EXCEPTION 'CMS_REVISION_PREVIEW_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  -- Rào trạng thái (chốt / chi trả / chứng nhận / sổ / net) TRƯỚC so stale: chương trình vừa bị chốt dưới khoá ⇒ báo đúng LOCKED…
  -- (hành động được), không phải "dữ liệu đã đổi" (PG15 §11 r2 — sửa × chốt).
  v_code := public.cms__revision_blocker(v_pid);
  IF v_code IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE = v_code, ERRCODE = 'P0001'; END IF;
  IF p_payload_digest IS DISTINCT FROM v_rev.payload_digest OR p_expected_config_version IS DISTINCT FROM v_rev.from_config_version
     OR v_prog.config_version IS DISTINCT FROM v_rev.from_config_version
     OR v_prog.current_result_run_id IS DISTINCT FROM v_rev.expected_run_id
     OR v_prog.status IS DISTINCT FROM v_rev.program_status
     OR public.cms__mapping_fp() IS DISTINCT FROM v_rev.mapping_fp
     OR public.cms__revision_config(v_pid) IS DISTINCT FROM v_rev.before_snapshot THEN
    RAISE EXCEPTION 'CMS_REVISION_PREVIEW_STALE' USING ERRCODE = 'P0001';
  END IF;
  IF (v_rev.impact->>'status') IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'CMS_REVISION_IMPACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  -- Xác nhận: áp lại cả kỳ + có thể giảm (tick tường minh) + đúng danh sách SP bị bỏ của diff này.
  IF (p_ack->'whole_period') IS DISTINCT FROM 'true'::jsonb OR (p_ack->'may_decrease') IS DISTINCT FROM 'true'::jsonb
     OR jsonb_typeof(p_ack->'removed') IS DISTINCT FROM 'array'
     OR (SELECT COALESCE(jsonb_agg(x ORDER BY x #>> '{}' COLLATE "C"), '[]'::jsonb) FROM jsonb_array_elements(p_ack->'removed') x)
        IS DISTINCT FROM (v_rev.diff->'removed') THEN
    RAISE EXCEPTION 'CMS_REVISION_ACK_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  -- Run: không có run đang chạy (khoá advisory cùng khoá open ⇒ open sau chờ commit); khoá run đang hiển thị (lưu trữ ổn định).
  PERFORM pg_advisory_xact_lock(hashtextextended('cms_sales_run:' || v_pid::text, 0));
  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE kind = 'sales' AND program_id = v_pid AND status = 'running') THEN
    RAISE EXCEPTION 'CMS_SYNC_BUSY' USING ERRCODE = 'P0001';
  END IF;
  -- Danh mục: khoá trùng toàn cục rồi kiểm SP mong muốn không thuộc chương trình active / locked khác giao ngày (cùng namespace).
  SELECT COALESCE(array_agg(x->>'product_id'), '{}') INTO v_ids FROM jsonb_array_elements(v_rev.payload->'products') x;
  PERFORM public.cms__lock_catalog();
  IF cardinality(public.cms__conflicts(v_pid, v_prog.is_test, v_prog.start_date, v_prog.end_date, v_ids)) > 0 THEN
    RAISE EXCEPTION 'CMS_REVISION_PRODUCT_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) x
              WHERE NOT EXISTS (SELECT 1 FROM public.cms_program_products p WHERE p.program_id = v_pid AND p.product_id = x)
                AND NOT EXISTS (SELECT 1 FROM public.cms_product_master m WHERE m.product_id = x)) THEN
    RAISE EXCEPTION 'CMS_REVISION_PRODUCT_UNKNOWN' USING ERRCODE = 'P0001';
  END IF;

  -- 1. Lưu trữ số đang hiển thị (trước sửa) — chép một lần cho mỗi run; lần sửa sau trên cùng run dùng lại.
  IF v_prog.current_result_run_id IS NULL THEN
    v_mode := 'none';
  ELSE
    SELECT * INTO v_run FROM public.cms_sync_runs WHERE id = v_prog.current_result_run_id FOR SHARE;
    SELECT * INTO v_src FROM public.cms_program_revisions
     WHERE program_id = v_pid AND status = 'committed' AND archive_mode = 'copied' AND archive_run_id = v_run.id;
    IF FOUND THEN
      v_mode := 'reused'; v_arun := v_src.archive_run_id; v_acv := v_src.archive_run_config_version;
      v_arows := v_src.archive_rows; v_aamt := v_src.archive_amount_vnd;
    ELSE
      IF v_run.status <> 'ok' OR v_run.purged_at IS NOT NULL OR v_run.published_at IS NULL THEN
        RAISE EXCEPTION 'CMS_REVISION_ARCHIVE_GONE' USING ERRCODE = 'P0001';
      END IF;
      -- Run trước một lần sửa đã ghi mà chưa có lưu trữ ⇒ lịch sử hổng — dừng (không tự suy).
      IF EXISTS (SELECT 1 FROM public.cms_program_revisions WHERE program_id = v_pid AND status = 'committed'
                   AND from_config_version >= v_run.config_version) THEN
        RAISE EXCEPTION 'CMS_REVISION_HISTORY_GAP' USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO public.cms_program_revision_results (revision_id, program_id, run_id, run_config_version, user_id, store_id,
          program_product_id, product_id, gmv_basis, target_gmv, per_unit, config_basis, unit_cms, tiers, base_quantity, cms_quantity,
          rewarded_quantity, gmv_amount, gate_met, potential_amount, amount_vnd, line_count)
      SELECT v_rev.id, v_pid, r.run_id, v_run.config_version, r.user_id, r.store_id, r.program_product_id, r.product_id, r.gmv_basis,
             r.target_gmv, r.per_unit,
             CASE WHEN pp.id IS NOT NULL AND pp.base_quantity_cms = r.per_unit AND v_run.config_version = v_prog.config_version
                  THEN 'exact' ELSE 'unknown' END,
             CASE WHEN pp.id IS NOT NULL AND pp.base_quantity_cms = r.per_unit AND v_run.config_version = v_prog.config_version
                  THEN pp.unit_cms END,
             CASE WHEN pp.id IS NOT NULL AND pp.base_quantity_cms = r.per_unit AND v_run.config_version = v_prog.config_version
                  THEN public.cms__revision_tiers(pp.id) END,
             r.base_quantity, r.cms_quantity, r.rewarded_quantity, r.gmv_amount, r.gate_met, r.potential_amount, r.amount_vnd, r.line_count
        FROM public.cms_results r
        LEFT JOIN public.cms_program_products pp ON pp.id = r.program_product_id
       WHERE r.run_id = v_run.id;
      GET DIAGNOSTICS v_arows = ROW_COUNT;
      SELECT COALESCE(sum(amount_vnd), 0) INTO v_aamt FROM public.cms_program_revision_results WHERE revision_id = v_rev.id;
      IF v_aamt IS DISTINCT FROM COALESCE(v_run.amount_vnd, 0) THEN
        RAISE EXCEPTION 'CMS_REVISION_ARCHIVE_MISMATCH' USING ERRCODE = 'P0001';
      END IF;
      v_mode := 'copied'; v_arun := v_run.id; v_acv := v_run.config_version;
    END IF;
  END IF;

  -- 2. Áp danh mục: giữ identity SP có sẵn (UPDATE), thêm mới (INSERT), bật lại SP đã retire (cùng dòng — không bản thứ hai).
  FOR e IN SELECT x FROM jsonb_array_elements(v_rev.payload->'products') x LOOP
    SELECT * INTO v_pp FROM public.cms_program_products WHERE program_id = v_pid AND product_id = e->>'product_id' FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.cms_program_products (program_id, product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms,
          advice_text, name_snapshot, image_url_snapshot, price_snapshot, import_run_id, added_after_start)
      VALUES (v_pid, e->>'product_id', e->>'gmv_basis', NULLIF(e->>'target_gmv', '')::bigint, e->>'unit_cms',
          (e->>'base_quantity_cms')::numeric, e->>'advice_text', e->>'name_snapshot', NULLIF(e->>'image_url_snapshot', ''),
          NULLIF(e->>'price_snapshot', '')::numeric, NULL, v_prog.status = 'active' AND v_today >= v_prog.start_date)
      RETURNING id INTO v_ppid;
      INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
      SELECT v_ppid, v_pid, (x->>'order')::integer, (x->>'from')::integer, NULLIF(x->>'to', '')::integer, (x->>'amount')::bigint
        FROM jsonb_array_elements(e->'tiers') x;
      CONTINUE;
    END IF;
    IF (e->>'gmv_basis') IS DISTINCT FROM v_pp.gmv_basis OR (e->>'target_gmv') IS DISTINCT FROM v_pp.target_gmv::text
       OR (e->>'unit_cms') IS DISTINCT FROM v_pp.unit_cms THEN
      RAISE EXCEPTION 'CMS_REVISION_FIELD_LOCKED' USING ERRCODE = 'P0001', DETAIL = e->>'product_id';
    END IF;
    IF v_pp.retired_at IS NOT NULL OR v_pp.base_quantity_cms IS DISTINCT FROM (e->>'base_quantity_cms')::numeric
       OR v_pp.advice_text IS DISTINCT FROM (e->>'advice_text') THEN
      UPDATE public.cms_program_products
         SET retired_at = NULL, retired_revision_id = NULL, base_quantity_cms = (e->>'base_quantity_cms')::numeric, advice_text = e->>'advice_text'
       WHERE id = v_pp.id;
    END IF;
    IF public.cms__revision_tiers(v_pp.id) IS DISTINCT FROM (e->'tiers') THEN
      DELETE FROM public.cms_program_tiers WHERE program_product_id = v_pp.id;
      INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
      SELECT v_pp.id, v_pid, (x->>'order')::integer, (x->>'from')::integer, NULLIF(x->>'to', '')::integer, (x->>'amount')::bigint
        FROM jsonb_array_elements(e->'tiers') x;
    END IF;
  END LOOP;
  -- 3. Bỏ SP: chưa có dữ liệu run ⇒ xoá (bậc rồi SP — không CASCADE); FK của dữ liệu run chặn ⇒ retire logic (chỉ pos_base).
  -- 3a. r3 (PM P1-04 + db-reviewer r3 P2-1): SP bỏ ĐÃ có dữ liệu run ở cms_sales_lines / cms_results — đúng HAI FK dữ liệu trỏ vào
  --     cms_program_products (120–130: ngoài cms_program_tiers chỉ có cms_sales_lines_product_fk / cms_results_product_fk) và đúng tiêu chí
  --     'referenced' của diff preview ⇒ retire THEO TẬP một câu (thay subtransaction + bắt foreign_key_violation từng dòng: bỏ 1.999 SP
  --     giữ khoá chương trình nhiều giây ⇒ cron open / publish 5 s và chốt 2 s hết lock_timeout). Khác pos_base ⇒ REMOVE_UNSUPPORTED với
  --     ProductID đầu tiên (thứ tự C, như vòng cũ).
  SELECT min(pp.product_id COLLATE "C") INTO v_first FROM public.cms_program_products pp
   WHERE pp.program_id = v_pid AND pp.retired_at IS NULL AND NOT (pp.product_id = ANY (v_ids))
     AND (EXISTS (SELECT 1 FROM public.cms_sales_lines s WHERE s.program_product_id = pp.id AND s.program_id = v_pid)
          OR EXISTS (SELECT 1 FROM public.cms_results r WHERE r.program_product_id = pp.id AND r.program_id = v_pid));
  IF v_first IS NOT NULL AND v_prog.quantity_basis IS DISTINCT FROM 'pos_base' THEN
    RAISE EXCEPTION 'CMS_REVISION_REMOVE_UNSUPPORTED' USING ERRCODE = 'P0001', DETAIL = v_first;
  END IF;
  IF v_first IS NOT NULL THEN
    UPDATE public.cms_program_products pp SET retired_at = now(), retired_revision_id = v_rev.id
     WHERE pp.program_id = v_pid AND pp.retired_at IS NULL AND NOT (pp.product_id = ANY (v_ids))
       AND (EXISTS (SELECT 1 FROM public.cms_sales_lines s WHERE s.program_product_id = pp.id AND s.program_id = v_pid)
            OR EXISTS (SELECT 1 FROM public.cms_results r WHERE r.program_product_id = pp.id AND r.program_id = v_pid));
    GET DIAGNOSTICS v_nret = ROW_COUNT;
    v_retired := v_retired + v_nret;
  END IF;
  -- 3b. Phần còn lại (không có dữ liệu run) ⇒ xoá từng dòng như cũ; FK khác về sau (nếu có) vẫn bị bắt ⇒ retire — lưới an toàn.
  FOR v_pp IN SELECT * FROM public.cms_program_products
               WHERE program_id = v_pid AND retired_at IS NULL AND NOT (product_id = ANY (v_ids)) ORDER BY product_id COLLATE "C" FOR UPDATE LOOP
    BEGIN
      DELETE FROM public.cms_program_tiers WHERE program_product_id = v_pp.id;
      DELETE FROM public.cms_program_products WHERE id = v_pp.id;
      v_deleted := v_deleted + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      IF v_prog.quantity_basis IS DISTINCT FROM 'pos_base' THEN
        RAISE EXCEPTION 'CMS_REVISION_REMOVE_UNSUPPORTED' USING ERRCODE = 'P0001', DETAIL = v_pp.product_id;
      END IF;
      UPDATE public.cms_program_products SET retired_at = now(), retired_revision_id = v_rev.id WHERE id = v_pp.id;
      v_retired := v_retired + 1;
    END;
  END LOOP;
  -- 4. Version +1 (pointer giữ nguyên: run mới cùng version mới mới thay được — guard 122; run trước sửa bị che ở reader).
  UPDATE public.cms_programs SET config_version = config_version + 1, updated_by = v_uid, updated_at = now() WHERE id = v_pid;
  -- 5. Hậu kiểm: danh mục hiệu lực = payload (ProductID / loại / target / đơn vị / K / tư vấn / bậc), version đúng +1, pointer không đổi.
  v_after := public.cms__revision_config(v_pid);
  IF (v_after->>'config_version')::integer IS DISTINCT FROM v_rev.from_config_version + 1
     OR (SELECT current_result_run_id FROM public.cms_programs WHERE id = v_pid) IS DISTINCT FROM v_rev.expected_run_id
     OR (SELECT jsonb_agg(x - 'name_snapshot' ORDER BY x->>'product_id' COLLATE "C") FROM jsonb_array_elements(v_after->'products') x)
        IS DISTINCT FROM
        (SELECT jsonb_agg(x - 'name_snapshot' - 'image_url_snapshot' - 'price_snapshot' ORDER BY x->>'product_id' COLLATE "C")
           FROM jsonb_array_elements(v_rev.payload->'products') x) THEN
    RAISE EXCEPTION 'CMS_REVISION_ASSERT' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.cms_program_revisions
     SET status = 'committed', to_config_version = v_rev.from_config_version + 1, committed_at = now(), committed_by = v_uid,
         idempotency_key = p_idempotency_key, reason = btrim(p_reason),
         ack = jsonb_build_object('whole_period', true, 'may_decrease', true, 'removed', v_rev.diff->'removed',
                                  'retired', v_retired, 'deleted', v_deleted),
         after_snapshot = v_after, archive_mode = v_mode, archive_run_id = v_arun, archive_run_config_version = v_acv,
         archive_rows = v_arows, archive_amount_vnd = v_aamt
   WHERE id = v_rev.id;
  RETURN jsonb_build_object('already', false, 'revision_id', v_rev.id, 'program_id', v_pid,
    'from_config_version', v_rev.from_config_version, 'to_config_version', v_rev.from_config_version + 1,
    'archive_mode', v_mode, 'archive_rows', v_arows, 'retired', v_retired, 'deleted', v_deleted);
END;
$fn$;

-- Trạng thái cho mọi người đọc được chương trình: đã từng sửa? run đang công bố có bị che vì tính trước lần sửa gần nhất? (không lộ người /
-- lý do / tiền).
CREATE FUNCTION public.rpc_cms_program_revision_state(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_cur uuid;
  v_cv  integer;
  v_last timestamptz;
BEGIN
  IF auth.uid() IS NULL OR p_program_id IS NULL OR NOT (p_program_id = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT max(committed_at) INTO v_last FROM public.cms_program_revisions WHERE program_id = p_program_id AND status = 'committed';
  SELECT current_result_run_id INTO v_cur FROM public.cms_programs WHERE id = p_program_id;
  IF v_cur IS NOT NULL THEN SELECT config_version INTO v_cv FROM public.cms_sync_runs WHERE id = v_cur; END IF;
  RETURN jsonb_build_object('revised', v_last IS NOT NULL, 'last_revised_at', public.cms__ts(v_last),
    'masked', v_cur IS NOT NULL AND EXISTS (SELECT 1 FROM public.cms_program_revisions v WHERE v.program_id = p_program_id
                                              AND v.status = 'committed' AND v.from_config_version >= v_cv));
END;
$fn$;

-- Lịch sử sửa (super): tối đa 100 revision committed mới nhất — không payload / snapshot (xem rpc_cms_program_revision).
CREATE FUNCTION public.rpc_cms_program_revisions(p_program_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_REVISION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF p_program_id IS NULL OR NOT (p_program_id = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', v.id, 'from_config_version', v.from_config_version, 'to_config_version', v.to_config_version,
      'committed_at', public.cms__ts(v.committed_at), 'committed_by', v.committed_by,
      'committed_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = v.committed_by),
      'reason', v.reason, 'file_sha256', v.file_sha256,
      'counts', jsonb_build_object('add', v.diff->'add', 'readd', v.diff->'readd', 'change', v.diff->'change', 'keep', v.diff->'keep',
                                   'remove', v.diff->'remove', 'products_after', v.diff->'products_after'),
      'impact', v.impact -> 'totals', 'archive', jsonb_build_object('mode', v.archive_mode, 'run_id', v.archive_run_id,
        'run_config_version', v.archive_run_config_version, 'rows', v.archive_rows, 'amount_vnd', v.archive_amount_vnd::text))
      ORDER BY v.to_config_version DESC)
    FROM (SELECT * FROM public.cms_program_revisions WHERE program_id = p_program_id AND status = 'committed'
           ORDER BY to_config_version DESC LIMIT 100) v), '[]'::jsonb);
END;
$fn$;

-- Chi tiết một revision committed (super): diff đầy đủ, snapshot trước / sau, impact, nguồn ghim, xác nhận.
CREATE FUNCTION public.rpc_cms_program_revision(p_revision_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v public.cms_program_revisions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_REVISION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v FROM public.cms_program_revisions WHERE id = p_revision_id AND status = 'committed';
  IF NOT FOUND OR NOT (v.program_id = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_REVISION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object('id', v.id, 'program_id', v.program_id, 'from_config_version', v.from_config_version,
    'to_config_version', v.to_config_version, 'committed_at', public.cms__ts(v.committed_at), 'committed_by', v.committed_by,
    'committed_by_name', (SELECT u.full_name FROM public.users u WHERE u.id = v.committed_by), 'reason', v.reason,
    'file_sha256', v.file_sha256, 'payload_digest', v.payload_digest, 'diff', v.diff, 'before', v.before_snapshot,
    'after', v.after_snapshot, 'impact', v.impact, 'source', v.source_identity, 'ack', v.ack, 'expected_run_id', v.expected_run_id,
    'archive', jsonb_build_object('mode', v.archive_mode, 'run_id', v.archive_run_id, 'run_config_version', v.archive_run_config_version,
                                  'rows', v.archive_rows, 'amount_vnd', v.archive_amount_vnd::text));
END;
$fn$;

-- Số hiển thị trước sửa của một revision (super, phân trang ≤ 1000). 'reused' ⇒ đọc bản chép của revision đầu tiên trên cùng run.
CREATE FUNCTION public.rpc_cms_program_revision_archive(p_revision_id uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v    public.cms_program_revisions%ROWTYPE;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_REVISION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF p_offset IS NULL OR p_offset < 0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'CMS_REVISION_BAD_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v FROM public.cms_program_revisions WHERE id = p_revision_id AND status = 'committed';
  IF NOT FOUND OR NOT (v.program_id = ANY (public.cms_readable_program_ids())) THEN
    RAISE EXCEPTION 'CMS_REVISION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_id := CASE v.archive_mode WHEN 'copied' THEN v.id
            WHEN 'reused' THEN (SELECT s.id FROM public.cms_program_revisions s WHERE s.archive_mode = 'copied' AND s.archive_run_id = v.archive_run_id) END;
  RETURN jsonb_build_object('revision_id', v.id, 'mode', v.archive_mode, 'run_id', v.archive_run_id,
    'run_config_version', v.archive_run_config_version, 'total', COALESCE(v.archive_rows, 0), 'amount_vnd', v.archive_amount_vnd::text,
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'user_id', a.user_id, 'full_name', (SELECT u.full_name FROM public.users u WHERE u.id = a.user_id), 'store_id', a.store_id,
        'program_product_id', a.program_product_id, 'product_id', a.product_id, 'gmv_basis', a.gmv_basis, 'target_gmv', a.target_gmv::text,
        'per_unit', a.per_unit::text, 'config_basis', a.config_basis, 'unit_cms', a.unit_cms, 'tiers', a.tiers,
        'base_quantity', a.base_quantity::text, 'cms_quantity', a.cms_quantity::text, 'rewarded_quantity', a.rewarded_quantity::text,
        'gmv_amount', a.gmv_amount::text, 'gate_met', a.gate_met, 'potential_amount', a.potential_amount::text,
        'amount_vnd', a.amount_vnd::text, 'line_count', a.line_count) ORDER BY a.user_id, a.product_id COLLATE "C")
      FROM (SELECT * FROM public.cms_program_revision_results WHERE revision_id = v_id
             ORDER BY user_id, product_id COLLATE "C" OFFSET p_offset LIMIT p_limit) a), '[]'::jsonb));
END;
$fn$;

-- Năng lực 131 cho app (service_role): version hợp đồng + RPC + EXECUTE đúng vai trò (suy từ catalog; app tắt tính năng nếu lệch).
CREATE FUNCTION public.rpc_cms_revision_capabilities()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  WITH r(fn, sig) AS (VALUES
    ('rpc_cms_program_revision_preview', 'public.rpc_cms_program_revision_preview(jsonb)'),
    ('rpc_cms_program_revision_commit', 'public.rpc_cms_program_revision_commit(uuid,integer,text,uuid,text,jsonb)'),
    ('rpc_cms_program_revision_state', 'public.rpc_cms_program_revision_state(uuid)'),
    ('rpc_cms_program_revisions', 'public.rpc_cms_program_revisions(uuid)'),
    ('rpc_cms_program_revision', 'public.rpc_cms_program_revision(uuid)'),
    ('rpc_cms_program_revision_archive', 'public.rpc_cms_program_revision_archive(uuid,integer,integer)'))
  SELECT jsonb_build_object('version', 'cms-revision-v1',
    'rpcs', (SELECT jsonb_agg(fn ORDER BY fn) FROM r),
    'ok', (SELECT bool_and(to_regprocedure(sig) IS NOT NULL AND has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE')
                           AND NOT has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE')) FROM r)
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = 'public.cms_program_products'::regclass
                        AND attname = 'retired_at' AND NOT attisdropped))
$fn$;

-- ── ACL: thu hồi đích danh rồi cấp đúng ma trận (gate ACL — áp cả 4 hàm OR REPLACE) ──
REVOKE ALL ON FUNCTION
  public.cms__revision_guard(),
  public.cms__revision_results_guard(),
  public.cms__revision_policy_guard(),
  public.cms__revision_tiers(uuid),
  public.cms__revision_config(uuid),
  public.cms__revision_blocker(uuid),
  public.cms__revision_norm(jsonb,jsonb),
  public.cms__revision_diff(uuid,jsonb),
  public.rpc_cms_program_revision_preview(jsonb),
  public.rpc_cms_program_revision_commit(uuid,integer,text,uuid,text,jsonb),
  public.rpc_cms_program_revision_state(uuid),
  public.rpc_cms_program_revisions(uuid),
  public.rpc_cms_program_revision(uuid),
  public.rpc_cms_program_revision_archive(uuid,integer,integer),
  public.rpc_cms_revision_capabilities(),
  public.cms__sales_snapshot(uuid),
  public.cms__conflicts(uuid,boolean,date,date,text[]),
  public.cms__program_scope_hash(uuid),
  public.cms__result_run(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_revision_preview(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_revision_commit(uuid,integer,text,uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_revision_state(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_revisions(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_revision(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_program_revision_archive(uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cms_revision_capabilities() TO service_role;
-- Thu hồi mọi grant khác owner do default privileges cấp (bài học SEC-1), trừ đúng ma trận; bảng mới tương tự.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, a.grantee
      FROM (VALUES @@ACL_VALUES@@) AS m(sig, want)
      JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure('public.' || m.sig)
     CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE a.grantee <> p.proowner
       AND NOT (a.grantee <> 0 AND pg_catalog.pg_get_userbyid(a.grantee) || ':' || a.privilege_type = ANY (string_to_array(COALESCE(m.want, ''), ',')))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', r.fn, CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) END);
  END LOOP;
  FOR r IN
    SELECT c.oid::regclass AS t, a.grantee
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid IN ('public.cms_program_revisions'::regclass, 'public.cms_program_revision_results'::regclass) AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM %s', r.t, CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) END);
  END LOOP;
END $$;

-- ── Hậu kiểm trong transaction (lệch ⇒ RAISE ⇒ rollback cả migration) ─────
DO $$
DECLARE
  v_bad text;
BEGIN
  -- ACL đúng ma trận: anon không gọi được hàm nào; authenticated đúng 6 RPC; service_role đúng capabilities; mọi hàm SECDEF + search_path.
  SELECT string_agg(m.sig, ' ') INTO v_bad
    FROM (VALUES @@ACL_VALUES@@) AS m(sig, want)
   WHERE to_regprocedure('public.' || m.sig) IS NULL
      OR has_function_privilege('anon', to_regprocedure('public.' || m.sig), 'EXECUTE')
      OR has_function_privilege('authenticated', to_regprocedure('public.' || m.sig), 'EXECUTE') IS DISTINCT FROM (COALESCE(m.want, '') LIKE '%authenticated:EXECUTE%')
      OR has_function_privilege('service_role', to_regprocedure('public.' || m.sig), 'EXECUTE') IS DISTINCT FROM (COALESCE(m.want, '') LIKE '%service_role:EXECUTE%')
      OR NOT (SELECT p.prosecdef AND 'search_path=public' = ANY (p.proconfig) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.' || m.sig))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                  WHERE p.oid = to_regprocedure('public.' || m.sig) AND a.grantee <> p.proowner
                    AND NOT (a.grantee <> 0 AND pg_catalog.pg_get_userbyid(a.grantee) || ':' || a.privilege_type = ANY (string_to_array(COALESCE(m.want, ''), ','))));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION '131 hậu kiểm ACL lệch: %', v_bad; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.oid IN ('public.cms_program_revisions'::regclass, 'public.cms_program_revision_results'::regclass) AND a.grantee <> c.relowner)
     OR NOT (SELECT bool_and(c.relrowsecurity) FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.cms_program_revisions'::regclass, 'public.cms_program_revision_results'::regclass)) THEN
    RAISE EXCEPTION '131 hậu kiểm: bảng mới có grant ngoài owner / thiếu RLS';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled = 'A'
        AND t.tgrelid IN ('public.cms_program_revisions'::regclass, 'public.cms_program_revision_results'::regclass)) <> 4 THEN
    RAISE EXCEPTION '131 hậu kiểm: thiếu trigger bất biến ENABLE ALWAYS (cần 4)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_revision_policy_guard'
                  AND NOT t.tgisinternal AND t.tgenabled = 'A' AND t.tgfoid = 'public.cms__revision_policy_guard()'::regprocedure) THEN
    RAISE EXCEPTION '131 hậu kiểm: thiếu trigger chặn đổi returns_policy khi có SP retire (ENABLE ALWAYS)';
  END IF;
  IF (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_catalog.pg_policy p
       WHERE p.polrelid = 'public.cms_program_products'::regclass AND p.polname = 'cms_program_products_select')
     IS DISTINCT FROM '((retired_at IS NULL) AND (program_id = ANY (( SELECT cms_readable_program_ids() AS cms_readable_program_ids)::uuid[])))' THEN
    RAISE EXCEPTION '131 hậu kiểm: policy cms_program_products_select khác bản 131';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_program_products WHERE retired_at IS NOT NULL) THEN
    RAISE EXCEPTION '131 hậu kiểm: có SP retire ngay sau migrate';
  END IF;
END $$;
@@POSTCHECK_MD5@@

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('131', 'cms_program_revision', jsonb_build_object(
  'candidate', 'CMS-PROGRAM-REVISION F-A r3', 'new_functions', @@N_NEW@@, 'replaced_functions', 4,
  'tables', jsonb_build_array('cms_program_revisions', 'cms_program_revision_results'))::text);

COMMIT;

-- ── VERIFY (sau COMMIT, CHỈ ĐỌC — operator chạy từng khối, bọc BEGIN READ ONLY; … COMMIT;) ──────────────────────────────────────
-- V0 (chạy TRƯỚC migration, lưu kết quả; chạy lại SAU — phải TRÙNG HỆT): chụp version / pointer / trạng thái mọi chương trình.
--   SELECT count(*) n, md5(string_agg(id::text || ':' || config_version || ':' || COALESCE(current_result_run_id::text, '-') || ':' || status, ','
--          ORDER BY id)) h FROM public.cms_programs;
-- V1 marker — 2 dòng: 130 cms_calculation_modes_returns · 131 cms_program_revision.
--   SELECT version, name FROM public.app_migrations WHERE version IN ('130', '131') ORDER BY 1;
-- V2 ACL — n = @@N_ALL@@ · anon_x = 0 · auth_x = 6 · svc_x = 1 · secdef = @@N_ALL@@ · sp = @@N_ALL@@.
--   SELECT count(*) n, count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')) anon_x,
--          count(*) FILTER (WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE')) auth_x,
--          count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE')) svc_x,
--          count(*) FILTER (WHERE p.prosecdef) secdef, count(*) FILTER (WHERE 'search_path=public' = ANY (p.proconfig)) sp
--     FROM pg_proc p WHERE p.oid IN (SELECT to_regprocedure('public.' || s) FROM unnest(ARRAY[@@SIG_LIST@@]) s);
-- V3 bảng mới — 2 dòng: rls = true · pol = 0 · a = u = s = false.
--   SELECT c.relname, c.relrowsecurity rls, (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) pol,
--          has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') a, has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') u,
--          has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') s
--     FROM pg_class c WHERE c.oid IN ('public.cms_program_revisions'::regclass, 'public.cms_program_revision_results'::regclass) ORDER BY 1;
-- V4 trạng thái dữ liệu — revisions = 0 · archive = 0 · retired = 0; config_version / pointer mọi chương trình KHÔNG đổi (so ảnh chụp trước).
--   SELECT (SELECT count(*) FROM public.cms_program_revisions) revisions, (SELECT count(*) FROM public.cms_program_revision_results) archive,
--          (SELECT count(*) FROM public.cms_program_products WHERE retired_at IS NOT NULL) retired;
-- V5 năng lực — version cms-revision-v1 · ok = true.
--   SELECT public.rpc_cms_revision_capabilities();
-- V6 policy + trigger — policy đọc SP có (retired_at IS NULL); 5 dòng trigger, tgenabled = 'A' cả 5 (4 bất biến + cms_revision_policy_guard).
--   SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid = 'public.cms_program_products'::regclass;
--   SELECT c.relname, t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--    WHERE NOT t.tgisinternal AND (c.relname IN ('cms_program_revisions', 'cms_program_revision_results') OR t.tgname = 'cms_revision_policy_guard')
--    ORDER BY 1, 2;
-- V8 số chương trình đang bị che (run hiện hành tính trước một lần sửa đã ghi) — ngay sau migrate 0; về sau dùng theo dõi "đang tính lại".
--   SELECT count(*) FROM public.cms_programs p JOIN public.cms_sync_runs r ON r.id = p.current_result_run_id
--    WHERE EXISTS (SELECT 1 FROM public.cms_program_revisions v WHERE v.program_id = p.id AND v.status = 'committed'
--                    AND v.from_config_version >= r.config_version);
