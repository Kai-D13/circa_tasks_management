// Dựng DB PGlite cho QA CRM (dùng chung: scripts/qa-care-114.mjs, scripts/qa-care-115.mjs, e2e/care-*.spec.ts).
// Postgres 16 WASM + schema nền giống prod (đọc qua pg-meta 07/10/2026) + nguyên file migration 114, rồi 115
// (huỷ import, D1), rồi 116 (đơn N3 sau import, E). Mặc định nạp tới migration MỚI NHẤT; freshDb(PGlite, { through: '114' | '115' })
// hoặc env CARE_PGLITE_THROUGH=114|115 để dừng sớm hơn. Tự chứa (không import .ts) để chạy được từ Node lẫn Playwright.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const MIG_DIR = path.resolve(HERE, '..', '..', 'supabase', 'migrations')
export const MIGRATION = fs.readFileSync(path.join(MIG_DIR, '114_care_crm_foundation.sql'), 'utf8')
export const MIGRATION_115 = fs.readFileSync(path.join(MIG_DIR, '115_care_import_cancel.sql'), 'utf8')
export const ROLLBACK_115 = fs.readFileSync(path.join(MIG_DIR, 'rollback', '115_care_import_cancel_rollback.sql'), 'utf8')
export const MIGRATION_116 = fs.readFileSync(path.join(MIG_DIR, '116_care_order_links.sql'), 'utf8')
export const ROLLBACK_116_L1 = fs.readFileSync(path.join(MIG_DIR, 'rollback', '116_care_order_links_rollback_level1.sql'), 'utf8')
export const ROLLBACK_116_L2 = fs.readFileSync(path.join(MIG_DIR, 'rollback', '116_care_order_links_rollback_level2.sql'), 'utf8')
export const THROUGH_DEFAULT = ['114', '115'].includes(process.env.CARE_PGLITE_THROUGH) ? process.env.CARE_PGLITE_THROUGH : '116'

// is_super_admin(): trích nguyên văn từ migration MỚI NHẤT định nghĩa nó (113).
export function latestSuperAdminFn() {
  const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f < '114').sort().reverse()
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/\r\n/g, '\n')
    const i = sql.indexOf('CREATE OR REPLACE FUNCTION public.is_super_admin()')
    if (i < 0) continue
    const j = sql.indexOf('$$;', sql.indexOf('AS $$', i) + 5)
    return { file: f, sql: sql.slice(i, j + 3) }
  }
  throw new Error('không tìm thấy is_super_admin()')
}
export const SUPER_FN = latestSuperAdminFn()
export const SUPER_EMAIL = /'([^']+@[^']+)'/.exec(SUPER_FN.sql)[1]

// ── IDs fixture ──────────────────────────────────────────────────────────────
export const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const MKT_DEPT = '80cb84b5-da69-46e3-b0e5-1de3d31b93c3'
export const OPS_DEPT = uid(9001)
// QAOS01…25, mỗi store 2 email staff — CÙNG mẫu với e2e/careImportFixture.ts defaultFixtureStores (QA 114 kiểm khớp).
export const STORES = Array.from({ length: 25 }, (_, i) => { const s = String(i + 1).padStart(2, '0'); return { code: `QAOS${s}`, assigneeEmails: [`qa.care.s${s}a@example.invalid`, `qa.care.s${s}b@example.invalid`] } })
export const storeId = (i) => uid(100 + i)      // i = 1…25
export const S_INACTIVE = uid(126), S_FS = uid(127)
export const staffId = (i, ab) => uid(1000 + i * 2 + (ab === 'a' ? 0 : 1))
export const U = {
  super: uid(1), mkt: uid(2), ops: uid(3), sm: uid(4), sm2: uid(5), qlch1: uid(6), qlchFs: uid(7),
  staffFs: uid(8), staffInactive: uid(9),
  A: staffId(1, 'a'), B: staffId(1, 'b'), C: staffId(2, 'a'), D: staffId(2, 'b'),
}

export async function freshDb(PGlite, { through = THROUGH_DEFAULT } = {}) {
  if (!['114', '115', '116'].includes(through)) throw new Error(`freshDb: through phải là '114', '115' hoặc '116'`)
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
    $$;
    GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    -- Default ACL giống Supabase (đọc prod 07/10): bảng ALL, function EXECUTE cho anon/authenticated.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    -- Supabase còn cấp default privileges cho role quản trị postgres (KHÁC owner supabase_admin của bảng/hàm care_*) — giả lập
    -- bằng dashboard_qa để hậu kiểm owner-only (aclexplode) của 115/116 được kiểm thật (db-reviewer E1 P0).
    DO $$ BEGIN CREATE ROLE dashboard_qa NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO dashboard_qa;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO dashboard_qa;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO dashboard_qa;

    CREATE TABLE public.app_migrations (version text PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, checksum text, notes text);
    INSERT INTO public.app_migrations (version, name) VALUES ('113', 'super_admin_add_nikhilesh');
    CREATE TABLE public.departments (id uuid PRIMARY KEY, name text NOT NULL, color text NOT NULL DEFAULT 'slate', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.stores (id uuid PRIMARY KEY, name text NOT NULL, code text NOT NULL UNIQUE, address text, created_at timestamptz DEFAULT now(), region text, is_active boolean NOT NULL DEFAULT true, store_type text NOT NULL DEFAULT 'os');
    CREATE TABLE public.users (id uuid PRIMARY KEY, email text NOT NULL, full_name text NOT NULL, role text NOT NULL CHECK (role IN ('admin','store_manager','staff','sm')), store_id uuid REFERENCES public.stores(id), created_at timestamptz DEFAULT now(), department_id uuid REFERENCES public.departments(id), phone_number text);
    CREATE TABLE public.sm_store_assignments (sm_user_id uuid NOT NULL, store_id uuid NOT NULL, assigned_at timestamptz NOT NULL DEFAULT now(), assigned_by uuid, PRIMARY KEY (sm_user_id, store_id));
    ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
    CREATE POLICY users_select ON public.users FOR SELECT TO authenticated USING (true);

    CREATE FUNCTION public.get_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT role FROM public.users WHERE id = auth.uid() $$;
    CREATE FUNCTION public.get_user_store_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT store_id FROM public.users WHERE id = auth.uid() $$;
    CREATE FUNCTION public.get_user_department_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
      SELECT department_id FROM public.users WHERE id = auth.uid() $$;
    CREATE FUNCTION public.is_sm_for_store(p_store_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
      SELECT EXISTS (SELECT 1 FROM public.sm_store_assignments WHERE sm_user_id = auth.uid() AND store_id = p_store_id); $$;
  `)
  await db.exec(SUPER_FN.sql)

  // Fixture nền: 25 store OS + 1 OS ngừng + 1 FS; 2 staff/store; các vai trò.
  await db.query(`INSERT INTO public.departments (id, name) VALUES ($1, 'Marketing'), ($2, 'OPS')`, [MKT_DEPT, OPS_DEPT])
  for (let i = 1; i <= 25; i++) {
    await db.query(`INSERT INTO public.stores (id, name, code) VALUES ($1, $2, $3)`, [storeId(i), `QA store ${i}`, STORES[i - 1].code])
    for (const ab of ['a', 'b']) {
      await db.query(`INSERT INTO public.users (id, email, full_name, role, store_id) VALUES ($1, $2, $3, 'staff', $4)`,
        [staffId(i, ab), STORES[i - 1].assigneeEmails[ab === 'a' ? 0 : 1].toUpperCase(), `QA staff ${i}${ab}`, storeId(i)])
    }
  }
  await db.query(`INSERT INTO public.stores (id, name, code, is_active, store_type) VALUES ($1, 'QA ngừng', 'QAOS26', false, 'os'), ($2, 'QA FS', 'QAFS01', true, 'fs')`, [S_INACTIVE, S_FS])
  const users = [
    [U.super, SUPER_EMAIL, 'admin', null, null], [U.mkt, 'qa.mkt@example.invalid', 'admin', null, MKT_DEPT],
    [U.ops, 'qa.ops@example.invalid', 'admin', null, OPS_DEPT], [U.sm, 'qa.sm@example.invalid', 'sm', null, null],
    [U.sm2, 'qa.sm2@example.invalid', 'sm', null, null], [U.qlch1, 'qa.qlch1@example.invalid', 'store_manager', storeId(1), null],
    [U.qlchFs, 'qa.qlchfs@example.invalid', 'store_manager', S_FS, null], [U.staffFs, 'qa.stafffs@example.invalid', 'staff', S_FS, null],
    [U.staffInactive, 'qa.staffoff@example.invalid', 'staff', S_INACTIVE, null],
  ]
  for (const [id, email, role, store, dept] of users) {
    await db.query(`INSERT INTO public.users (id, email, full_name, role, store_id, department_id) VALUES ($1,$2,$3,$4,$5,$6)`, [id, email, 'QA ' + role, role, store, dept])
  }
  await db.query(`INSERT INTO public.sm_store_assignments (sm_user_id, store_id) VALUES ($1,$2), ($1,$3), ($4,$2), ($1,$5)`, [U.sm, storeId(1), storeId(2), U.sm2, S_FS])

  await db.exec(MIGRATION)
  if (through !== '114') await db.exec(MIGRATION_115)
  if (through === '116') await db.exec(MIGRATION_116)
  return db
}

// ── 116: một lượt thường 0 đơn (owner) — mọi task kỳ hiện tại có coverage = snapshot, last_success_at = snapshot ──
// Dùng cho bộ QA của 114/115 khi chạy trên 116: gate huỷ D1 116 đòi đơn N3 đã được đối chiếu sau import (Q-175).
export const SYNC_ORDERS_116_SQL = `DO $$
DECLARE o jsonb; s jsonb; v_run bigint; n int; ids text[]; i int; c int := 0;
BEGIN
  o := public.care__order_links_begin_open_at('regular', 'apply', NULL, 5000, NULL);
  IF o ->> 'status' <> 'ok' THEN RAISE EXCEPTION 'sync QA 116: %', o; END IF;
  v_run := (o ->> 'run_id')::bigint;
  s := public.care_order_links_begin_select(v_run, 100000, NULL);
  FOR n IN 1..(s ->> 'jobs')::int LOOP
    PERFORM public.care_order_links_job_done(v_run, n, 0, 0, public.care__order_links_params_sha(v_run, n));
  END LOOP;
  FOR n IN 1..(s ->> 'jobs')::int LOOP
    ids := ARRAY(SELECT external_id FROM public.care_order_run_tasks WHERE run_id = v_run AND job_no = n ORDER BY external_id COLLATE "C");
    i := 1;
    WHILE i <= cardinality(ids) LOOP
      c := c + 1;
      PERFORM public.care_order_links_apply_chunk(v_run, n, c, ids[i:i + 1999], '[]'::jsonb);
      i := i + 2000;
    END LOOP;
  END LOOP;
  IF public.care_order_links_complete(v_run) ->> 'status' <> 'complete' THEN RAISE EXCEPTION 'sync QA 116: chưa complete'; END IF;
END $$`
export async function syncOrders116(db) {
  if ((await db.query(`SELECT to_regclass('public.care_order_runs') IS NOT NULL AS e`)).rows[0].e) await db.exec(SYNC_ORDERS_116_SQL)
}

// ── Helper chạy dưới vai trò ─────────────────────────────────────────────────
export async function setUid(db, id) { await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [id ?? '']) }
export async function as(db, id, fn, role = 'authenticated') {
  await setUid(db, id)
  await db.exec(`SET ROLE ${role}`)
  try { return await fn() } finally { await db.exec('RESET ROLE'); await setUid(db, null) }
}
export async function raises(p, needle) {
  try { await p; return 'KHÔNG raise' } catch (e) { return String(e.message).includes(needle) ? true : 'raise khác: ' + e.message }
}
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

export async function stage(db, rows, { period, actor = U.mkt, isTest = false, rowCount } = {}) {
  const r = await db.query(
    `INSERT INTO public.care_import_batches (period_month, file_name, file_sha256, row_count, created_by, is_test)
     VALUES ($1, 'qa.xlsx', $2, $3, $4, $5) RETURNING id`,
    [period, sha(JSON.stringify(rows)), rowCount ?? rows.length, actor, isTest])
  const id = r.rows[0].id
  for (let i = 0; i < rows.length; i++) {
    await db.query(`INSERT INTO public.care_import_staging (batch_id, row_no, payload) VALUES ($1, $2, $3)`, [id, i + 2, JSON.stringify(rows[i])])
  }
  return id
}
export async function finalize(db, batchId, actor, today) {
  await setUid(db, null)
  const r = await db.query(`SELECT public.care__import_finalize_at($1, $2, $3) AS r`, [batchId, actor, today])
  return r.rows[0].r
}
export async function record(db, today, staff, taskId, outcome, note = 'QA gọi', next = null, proof = null) {
  await setUid(db, staff)
  try {
    const r = await db.query(`SELECT public.care__record_interaction_at($1,$2,$3,$4,$5,$6) AS r`, [today, taskId, outcome, note, next, proof === null ? null : JSON.stringify(proof)])
    return r.rows[0].r
  } finally { await setUid(db, null) }
}
export async function transfer(db, today, actor, ids, to, note = 'QA chuyển') {
  await setUid(db, actor)
  try {
    const r = await db.query(`SELECT public.care__transfer_tasks_at($1,$2::uuid[],$3,$4) AS r`, [today, ids, to, note])
    return r.rows[0].r
  } finally { await setUid(db, null) }
}
export const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0]
export const count = async (db, sql, params = []) => Number(Object.values((await db.query(sql, params)).rows[0])[0])
export const taskOf = (db, ext, period) => one(db, `SELECT t.* FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = $1 AND t.period_month = $2`, [ext, period])
export const row = (ext, store, email, pid, extra = {}) => ({
  customer_external_id: ext, customer_name: `KH ${ext}`, customer_phone: '0390000999', target_store_code: store,
  assignee_email: email, reason_type: 'chronic', reason_text: `QA ${pid}`, product_id: pid, product_name: `SP ${pid}`,
  product_url: `https://cdn-gcs.thuocsi.vn/qa-fixture/${pid}.png`, ...extra,
})
export const EA = STORES[0].assigneeEmails[0], EB = STORES[0].assigneeEmails[1], EC = STORES[1].assigneeEmails[0], ED = STORES[1].assigneeEmails[1]
