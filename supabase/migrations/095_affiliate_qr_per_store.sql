-- ============================================================================
-- 095_affiliate_qr_per_store.sql — P3-H: QR Affiliate theo store
-- ⚠ DRAFT — CHƯA CHẠY. Thứ tự bắt buộc (stakeholder 24/07):
--   (1) audit diff pass → (2) upload 25 PNG lên GCS + verify 25/25
--   (scripts/upload-affiliate-qr.mjs) → (3) MỚI chạy 095 (URL phải sống trước
--   khi seed vào DB).
--
-- Nội dung:
--   A. Preflight: đủ migration nền 090..094 đã chạy.
--   B. Cột QR trên affiliate_partner_mappings: qr_image_url, qr_destination_url,
--      qr_updated_at + 4 CHECK (r1 audit P2#4: destination đúng format
--      https://circa.vn/?ref=<code> · 3 field QR atomic cùng NULL/cùng đầy đủ ·
--      QR chỉ trên os + store_id NOT NULL · ảnh thuộc prefix GCS tin cậy
--      affiliate-qr/v1/) + partial unique: mỗi store os tối đa MỘT QR active.
--   C. Seed 8 partner code MỚI (os — manifest docs/affiliate-qr-manifest.md,
--      decode thật từ QR + đối chiếu stores DB, stakeholder duyệt 24/07):
--      không ON CONFLICT DO NOTHING âm thầm — mapping tồn tại nhưng KHÁC kỳ
--      vọng → RAISE; guard tổng insert phải là 0 (re-run) hoặc 8 (lần đầu).
--   D. Seed URL QR cho TOÀN BỘ 25 mapping os (GCS key
--      affiliate-qr/v1/<store_code>/<partner_code>.png).
--   E. RLS: policy SELECT store-scoped MỚI (Staff/Store Manager store mình;
--      SM qua is_sm_for_store; CHỈ partner_type='os' + is_active=true (r1
--      audit P1#2) → FS/external/inactive/store khác = 0 row). Policy super
--      hiện có giữ nguyên. Write vẫn CHỈ service role.
--
-- Idempotent: re-run toàn bộ = no-op (trừ qr_updated_at chỉ bump khi giá trị
-- đổi). ROLLBACK: DROP POLICY apm_select_store_qr; DROP INDEX
-- uq_apm_qr_one_per_store; ALTER TABLE DROP COLUMN 3 cột QR (+ constraint);
-- DELETE 8 mapping mới nếu muốn gỡ; DELETE app_migrations '095'.
-- ============================================================================

BEGIN;

-- ── A. Preflight nền ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM public.app_migrations
      WHERE version IN ('090','091','092','093','094')) <> 5 THEN
    RAISE EXCEPTION '095: thiếu migration nền — cần đủ 090..094 đã chạy (hiện có: %)',
      (SELECT string_agg(version, ',' ORDER BY version) FROM public.app_migrations
       WHERE version IN ('090','091','092','093','094'));
  END IF;
END $$;

-- ── B. Cột + constraint + index ──────────────────────────────────────────────
ALTER TABLE public.affiliate_partner_mappings
  ADD COLUMN IF NOT EXISTS qr_image_url       text,
  ADD COLUMN IF NOT EXISTS qr_destination_url text,
  ADD COLUMN IF NOT EXISTS qr_updated_at      timestamptz;

-- r1 (audit P2 #4) — 4 CHECK khóa trạng thái QR chống ghi SQL sai:
--   1. destination đúng format Circa Online của CHÍNH partner_code đó;
--   2. atomic: 3 field QR cùng NULL hoặc cùng đầy đủ (không nửa vời);
--   3. QR CHỈ trên mapping os + store_id NOT NULL (FS/external cấm);
--   4. ảnh phải thuộc prefix GCS tin cậy affiliate-qr/v1/.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('chk_apm_qr_destination',
       'qr_destination_url IS NULL OR qr_destination_url = ''https://circa.vn/?ref='' || partner_code'),
      ('chk_apm_qr_atomic',
       '(qr_image_url IS NULL AND qr_destination_url IS NULL AND qr_updated_at IS NULL) OR (qr_image_url IS NOT NULL AND qr_destination_url IS NOT NULL AND qr_updated_at IS NOT NULL)'),
      ('chk_apm_qr_os_only',
       'qr_image_url IS NULL OR (partner_type = ''os'' AND store_id IS NOT NULL)'),
      ('chk_apm_qr_image_prefix',
       'qr_image_url IS NULL OR qr_image_url LIKE ''https://storage.googleapis.com/duocsi-circa-vn/affiliate-qr/v1/%''')
    ) AS t(conname, expr)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = c.conname
        AND conrelid = 'public.affiliate_partner_mappings'::regclass
    ) THEN
      EXECUTE format('ALTER TABLE public.affiliate_partner_mappings ADD CONSTRAINT %I CHECK (%s)', c.conname, c.expr);
    END IF;
  END LOOP;
END $$;

-- Mỗi store tối đa MỘT QR active — r1 (audit P1 #2): thêm partner_type='os'
-- vào predicate cho khớp phạm vi QR (external store_id NULL vốn không ảnh
-- hưởng vì qr_image_url NULL).
DROP INDEX IF EXISTS uq_apm_qr_one_per_store;
CREATE UNIQUE INDEX uq_apm_qr_one_per_store
  ON public.affiliate_partner_mappings (store_id)
  WHERE qr_image_url IS NOT NULL AND is_active AND partner_type = 'os';

-- ── C + D. Seed 8 mapping mới + URL QR cho 25 mapping os ────────────────────
DO $$
DECLARE
  r           record;
  v_store     uuid;
  v_type      text;
  v_active    boolean;
  v_ex_store  uuid;
  v_ex_type   text;
  v_ex_active boolean;
  v_img       text;
  v_dest      text;
  v_inserted  int := 0;
  -- Base GCS public (bucket public-read — URL này xuất hiện trong mọi ảnh đã
  -- serve cho browser, không phải secret).
  v_base      constant text := 'https://storage.googleapis.com/duocsi-circa-vn';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- (partner_code, store_code, display_name) — 25 QR = 25 OS active store,
      -- manifest decode 24/07 (docs/affiliate-qr-manifest.md).
      ('CIRCA-URBAN',     'POS0011', 'CIRCA URBAN'),
      ('CIRCA-MIZUKI',    'POS0013', 'CIRCA MIZUKI'),
      ('CIRCA-LUMINA',    'POS0012', 'CIRCA LUMINA'),
      ('CIRCA-SUNRISE',   'POS0014', 'CIRCA SUNRISE'),
      ('CIRCA-ELARA',     'POS0015', 'CIRCA ELANA'),
      ('CIRCA-MORA',      'POS0017', 'CIRCA MORA'),
      ('CIRCA-THONGNHAT', 'POS0016', 'CIRCA THỐNG NHẤT'),
      ('CIRCA-SIGNATURE', 'POS0018', 'CIRCA SIGNATURE'),
      ('CIRCA-BEVERLY',   'POS0058', 'CIRCA BEVERLY'),
      ('CIRCA-ASTORIA',   'POS0062', 'CIRCA ASTORIA'),
      ('CIRCA-TAMVIET',   'POS0059', 'CIRCA TAM VIET'),
      ('CIRCA-CITYLAND',  'POS0070', 'CIRCA CITYLAND'),
      ('CIRCA-TAMAN',     'POS0060', 'CIRCA TAM AN'),
      ('CIRCA-MIRA',      'POS0019', 'CIRCA MIRA'),
      ('CIRCA-MEDLY',     'POS0063', 'CIRCA MEDLY'),
      ('CIRCA-SYMPHONY',  'POS0065', 'CIRCA SYMPHONY'),
      ('CIRCA-FLORITA',   'POS0068', 'CIRCA FLORITA'),
      ('CIRCA-PHARMAONE', 'POS0066', 'CIRCA PHARMA ONE'),
      ('CIRCA-CENTRAL',   'POS0009', 'CIRCA CENTRAL'),
      ('CIRCA-ECOGREEN',  'POS0073', 'CIRCA ECO GREEN'),
      ('CIRCA-RAINBOW',   'POS0069', 'CIRCA RAINBOW'),
      ('CIRCA-CELADON',   'POS0067', 'CIRCA CELADON'),
      ('CIRCA-EHOME',     'POS0079', 'CIRCA EHOME'),
      ('CIRCA-NAMVIET',   'POS0077', 'CIRCA NAM VIET'),
      ('CIRCA-AKARI',     'POS0080', 'CIRCA AKARI')
    ) AS t(partner_code, store_code, display_name)
  LOOP
    -- Preflight store: tồn tại + os + active (pattern 090/094).
    SELECT id, store_type, is_active INTO v_store, v_type, v_active
    FROM public.stores WHERE code = r.store_code;
    IF v_store IS NULL THEN
      RAISE EXCEPTION '095: store % (partner %) không tồn tại', r.store_code, r.partner_code;
    END IF;
    IF v_type IS DISTINCT FROM 'os' OR v_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION '095: store % (partner %) phải là os + active (hiện: type=%, active=%)',
        r.store_code, r.partner_code, v_type, v_active;
    END IF;

    -- Mapping: thiếu → INSERT; tồn tại nhưng KHÁC kỳ vọng → RAISE (không sửa êm).
    SELECT store_id, partner_type, is_active INTO v_ex_store, v_ex_type, v_ex_active
    FROM public.affiliate_partner_mappings WHERE partner_code = r.partner_code;
    IF NOT FOUND THEN
      INSERT INTO public.affiliate_partner_mappings (partner_code, store_id, partner_type, display_name)
      VALUES (r.partner_code, v_store, 'os', r.display_name);
      v_inserted := v_inserted + 1;
    ELSIF v_ex_store IS DISTINCT FROM v_store OR v_ex_type IS DISTINCT FROM 'os'
          OR v_ex_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION '095: mapping % tồn tại nhưng KHÁC kỳ vọng (store=%, type=%, active=%) — kiểm tra tay, không tự sửa',
        r.partner_code, v_ex_store, v_ex_type, v_ex_active;
    END IF;

    -- Seed URL QR (idempotent — chỉ UPDATE khi giá trị đổi để qr_updated_at
    -- giữ đúng nghĩa "lần đổi QR gần nhất").
    v_img  := v_base || '/affiliate-qr/v1/' || r.store_code || '/' || r.partner_code || '.png';
    v_dest := 'https://circa.vn/?ref=' || r.partner_code;
    UPDATE public.affiliate_partner_mappings
    SET qr_image_url = v_img, qr_destination_url = v_dest, qr_updated_at = now()
    WHERE partner_code = r.partner_code
      AND (qr_image_url IS DISTINCT FROM v_img OR qr_destination_url IS DISTINCT FROM v_dest);
  END LOOP;

  -- Lần đầu phải insert ĐÚNG 8 (8 code mới); re-run = 0. Số khác → có mapping
  -- os "biến mất" ngoài dự kiến → dừng để điều tra.
  IF v_inserted NOT IN (0, 8) THEN
    RAISE EXCEPTION '095: insert % mapping (kỳ vọng 0 khi re-run hoặc 8 lần đầu) — trạng thái bảng lệch manifest, kiểm tra tay', v_inserted;
  END IF;

  -- Checksum sau seed: 34 = 25 os + 2 fs + 7 external; đủ 25 os có QR.
  IF (SELECT count(*) FROM public.affiliate_partner_mappings) <> 34
     OR (SELECT count(*) FROM public.affiliate_partner_mappings WHERE partner_type = 'os') <> 25
     OR (SELECT count(*) FROM public.affiliate_partner_mappings WHERE partner_type = 'fs') <> 2
     OR (SELECT count(*) FROM public.affiliate_partner_mappings WHERE partner_type = 'external') <> 7
     OR (SELECT count(*) FROM public.affiliate_partner_mappings
         WHERE partner_type = 'os' AND qr_image_url IS NOT NULL) <> 25 THEN
    RAISE EXCEPTION '095: checksum mapping sai (total=%, os=%, fs=%, external=%, os_có_qr=%) — kỳ vọng 34/25/2/7/25',
      (SELECT count(*) FROM public.affiliate_partner_mappings),
      (SELECT count(*) FROM public.affiliate_partner_mappings WHERE partner_type = 'os'),
      (SELECT count(*) FROM public.affiliate_partner_mappings WHERE partner_type = 'fs'),
      (SELECT count(*) FROM public.affiliate_partner_mappings WHERE partner_type = 'external'),
      (SELECT count(*) FROM public.affiliate_partner_mappings WHERE partner_type = 'os' AND qr_image_url IS NOT NULL);
  END IF;
END $$;

-- ── E. RLS: đọc QR store-scoped ─────────────────────────────────────────────
-- Additive với apm_select_super (permissive OR). CHỈ hàng os + đúng store:
--   · staff / store_manager: store của mình (FS staff: store họ là fs → mapping
--     os không bao giờ khớp → 0 row; hàng fs bị loại ngay từ partner_type).
--   · sm: store được phân công (is_sm_for_store — SECDEF mig 045, không
--     cross-table trong policy).
--   · external (store_id NULL) không bao giờ khớp.
-- Write policy KHÔNG thêm — mọi ghi QR/mapping vẫn qua service role/SQL.
-- r1 (audit P1 #2): + is_active = true — mapping bị vô hiệu hóa (kể cả còn
-- URL QR) KHÔNG hiển thị cho staff/store_manager/sm.
DROP POLICY IF EXISTS apm_select_store_qr ON public.affiliate_partner_mappings;
CREATE POLICY apm_select_store_qr ON public.affiliate_partner_mappings
  FOR SELECT TO authenticated
  USING (
    partner_type = 'os'
    AND is_active = true
    AND store_id IS NOT NULL
    AND (
      ((SELECT public.get_user_role()) IN ('staff','store_manager')
        AND store_id = (SELECT public.get_user_store_id()))
      OR ((SELECT public.get_user_role()) = 'sm' AND public.is_sm_for_store(store_id))
    )
  );

INSERT INTO public.app_migrations (version, name, notes)
VALUES ('095', 'affiliate_qr_per_store',
        'P3-H r1: 3 cột QR trên affiliate_partner_mappings + 4 CHECK (destination=https://circa.vn/?ref=<code>; 3 field QR atomic; QR chỉ os+store_id NOT NULL; ảnh thuộc prefix GCS affiliate-qr/v1/) + unique 1 QR active/store os + seed 8 mapping os mới (URBAN/MORA/THONGNHAT/SIGNATURE/ASTORIA/CITYLAND/TAMAN/RAINBOW — manifest decode 24/07, stakeholder duyệt) + seed URL QR cho đủ 25 os + policy apm_select_store_qr (staff/store_manager store mình, sm qua is_sm_for_store, CHỈ partner_type=os AND is_active=true). Checksum 34 = 25 os + 2 fs + 7 external. CHẠY SAU khi upload GCS verify 25/25.')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFY (chạy tay sau 095):
-- 1) Cột + constraint + index:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='affiliate_partner_mappings' AND column_name LIKE 'qr%'
--     ORDER BY 1;                                       -- 3 cột
--   SELECT conname FROM pg_constraint
--     WHERE conrelid='public.affiliate_partner_mappings'::regclass
--       AND conname LIKE 'chk_apm_qr%' ORDER BY 1;
--     -- 4 row: chk_apm_qr_atomic · chk_apm_qr_destination ·
--     --        chk_apm_qr_image_prefix · chk_apm_qr_os_only
--   SELECT indexdef FROM pg_indexes
--     WHERE tablename='affiliate_partner_mappings'
--       AND indexname='uq_apm_qr_one_per_store';
--     -- 1 row, predicate có: qr_image_url IS NOT NULL AND is_active
--     --                      AND partner_type = 'os'
-- 2) Seed:
--   SELECT partner_type, count(*), count(qr_image_url) AS with_qr
--     FROM public.affiliate_partner_mappings GROUP BY 1 ORDER BY 1;
--     -- external 7/0 · fs 2/0 · os 25/25
--   SELECT m.partner_code, s.code, m.qr_image_url
--     FROM public.affiliate_partner_mappings m JOIN public.stores s ON s.id=m.store_id
--     WHERE m.partner_type='os'
--       AND m.qr_image_url IS DISTINCT FROM
--           'https://storage.googleapis.com/duocsi-circa-vn/affiliate-qr/v1/'
--           || s.code || '/' || m.partner_code || '.png';  -- 0 rows
-- 3) Policy:
--   SELECT policyname FROM pg_policies
--     WHERE tablename='affiliate_partner_mappings' ORDER BY 1;
--     -- apm_select_store_qr + apm_select_super (đúng 2)
-- 4) app_migrations: SELECT version FROM public.app_migrations WHERE version='095';
--
-- QA RLS (PostgREST, token từng role — H4 gate #1):
--   GET /rest/v1/affiliate_partner_mappings?select=partner_code,qr_image_url
--   · Staff store os A     → ĐÚNG 1 row (partner của store A)
--   · Staff store os B     → không thấy row store A (đổi account = logout/incognito
--     — [[feedback_qa_stale_auth_cookie]])
--   · Mapping store A bị UPDATE is_active=false (service role, test xong nhớ
--     bật lại) → Staff store A 0 row (r1 P1#2 — inactive không trả QR)
--   · FS staff (POS1089)   → 0 row
--   · SM assigned store    → rows các store được phân công; store ngoài → không
--   · store_manager        → 1 row store mình
--   · admin thường (non-super, non-dept) → 0 row
--   · super admin          → 34 rows
-- ============================================================================
