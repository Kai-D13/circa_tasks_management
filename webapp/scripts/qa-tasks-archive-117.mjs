// QA PGlite cho migration 117 (T1-B — lưu trữ / khôi phục hàng loạt task trong MỘT transaction, kiểm quyền từng task ở DB).
// Chạy local, KHÔNG chạm DB thật:   cd webapp && node scripts/qa-tasks-archive-117.mjs
// Nền: lib-care-pglite.freshDb (roles Supabase giả + default privileges, users/stores/SM, is_super_admin nguyên văn 113, 114–116
// nguyên văn ⇒ có marker 116) + bảng public.tasks rút gọn (cột liên quan, trigger updated_at, policy tasks_update_admin nguyên văn
// 038), rồi NGUYÊN file 117. Phần race 2 connection / lock_timeout / bench chạy trên PostgreSQL thật:
// planning/research/dev-tools/t1-117/realpg-race-117.mjs.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import * as L from './lib-care-pglite.mjs'

const MIG_117 = fs.readFileSync(path.join(L.MIG_DIR, '117_tasks_archive_rpc.sql'), 'utf8').replace(/\r\n/g, '\n')
const POLICY_038 = (() => {
  const sql = fs.readFileSync(path.join(L.MIG_DIR, '038_rls_initplan.sql'), 'utf8').replace(/\r\n/g, '\n')
  const i = sql.indexOf('CREATE POLICY tasks_update_admin ON public.tasks')
  return sql.slice(i, sql.indexOf(';', i) + 1)
})()
export const TASKS_DDL = `
  CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'todo',
    store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE,
    created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    parent_task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
    archived_at timestamptz,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );
  CREATE INDEX idx_tasks_parent_task_id ON public.tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tasks_select_qa ON public.tasks FOR SELECT TO authenticated USING (true);
  ${POLICY_038}
`

// ── Fixture task ─────────────────────────────────────────────────────────────
// P1/P2: hai nhóm staff_all (mkt tạo, store 1 / store 2), mỗi nhóm 1 cha + 260 con ⇒ 2 × 261 UUID.
// P3: cha store 1 có MỘT con ở store 3 (ngoài phạm vi SM). P4: cha mkt có con do ops tạo (chỉ để kiểm admin xét cả con).
export const T = {
  P1: L.uid(50001), P2: L.uid(50002), P3: L.uid(50003), S3: L.uid(50004), OPS: L.uid(50005), NUL: L.uid(50006),
  SUP: L.uid(50007), ARCH: L.uid(50008), C3X: L.uid(50009), P4: L.uid(50010), C4: L.uid(50011), BIG: L.uid(50012), BIG2: L.uid(50013),
  NOBY: L.uid(50014),
}
const ABSENT = L.uid(59999)
export async function seedTasks(db) {
  const ins = (id, store, by, parent = null, archived = null) =>
    db.query(`INSERT INTO public.tasks (id, title, store_id, created_by, parent_task_id, archived_at) VALUES ($1,'QA',$2,$3,$4,$5)`, [id, store, by, parent, archived])
  const kids = (parent, store, by, n) => db.query(
    `INSERT INTO public.tasks (title, store_id, created_by, parent_task_id) SELECT 'QA con', $1, $2, $3 FROM generate_series(1, $4::int)`,
    [store, by, parent, n])
  await ins(T.P1, L.storeId(1), L.U.mkt); await kids(T.P1, L.storeId(1), L.U.mkt, 260)
  await ins(T.P2, L.storeId(2), L.U.mkt); await kids(T.P2, L.storeId(2), L.U.mkt, 260)
  await ins(T.P3, L.storeId(1), L.U.mkt); await ins(T.C3X, L.storeId(3), L.U.mkt, T.P3)
  await ins(T.S3, L.storeId(3), L.U.mkt)
  await ins(T.OPS, L.storeId(1), L.U.ops)
  await ins(T.NUL, null, L.U.mkt)
  await ins(T.SUP, L.storeId(5), L.U.super)
  await ins(T.ARCH, L.storeId(1), L.U.mkt, null, '2026-10-01T00:00:00Z')
  await ins(T.P4, L.storeId(1), L.U.mkt); await ins(T.C4, L.storeId(1), L.U.ops, T.P4)
  await ins(T.NOBY, L.storeId(1), null)                                                          // created_by NULL (người tạo đã xoá)
  await ins(T.BIG, L.storeId(4), L.U.super); await kids(T.BIG, L.storeId(4), L.U.super, 5000)    // 5.001 đích ⇒ vượt trần
  await ins(T.BIG2, L.storeId(4), L.U.super); await kids(T.BIG2, L.storeId(4), L.U.super, 4999)  // 5.000 đích ⇒ đúng trần
}

export async function db117({ apply = true } = {}) {
  const db = await L.freshDb(PGlite, { through: '116' })
  await db.exec(TASKS_DDL)
  await seedTasks(db)
  if (apply) await db.exec(MIG_117)
  return db
}

export async function call(db, actor, ids, action, role = 'authenticated') {
  return L.as(db, actor, async () => {
    try {
      const r = await db.query(`SELECT public.rpc_set_tasks_archived($1::uuid[], $2) AS r`, [ids, action])
      return { ok: true, r: r.rows[0].r }
    } catch (e) { return { ok: false, msg: String(e.message), code: e.code } }
  }, role)
}
export const snap = async (db) => (await db.query(
  `SELECT md5(string_agg(id::text || ':' || coalesce(archived_at::text, '-'), ',' ORDER BY id)) AS h,
          count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS n FROM public.tasks`)).rows[0]
const closureArchived = async (db, parents) => (await db.query(
  `SELECT count(*)::int AS total, count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived
     FROM public.tasks WHERE id = ANY ($1::uuid[]) OR parent_task_id = ANY ($1::uuid[])`, [parents])).rows[0]
const CATALOG_SQL = `
  SELECT md5(coalesce(string_agg(x, E'\\n' ORDER BY x), '')) AS h, count(*)::int AS n FROM (
    SELECT 'col:' || table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, '') || ':' || is_nullable AS x
      FROM information_schema.columns WHERE table_schema = 'public'
    UNION ALL SELECT 'pol:' || tablename || '.' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '')
      FROM pg_policies WHERE schemaname = 'public'
    UNION ALL SELECT 'tgrant:' || table_name || ':' || grantee || ':' || privilege_type
      FROM information_schema.role_table_grants WHERE table_schema = 'public'
    UNION ALL SELECT 'fn:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '') || ':' || p.prosecdef::text
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'rpc_set_tasks_archived'
    UNION ALL SELECT 'idx:' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL SELECT 'trg:' || tgrelid::regclass::text || ':' || tgname || ':' || tgenabled::text FROM pg_trigger WHERE NOT tgisinternal
    UNION ALL SELECT 'rls:' || relname || ':' || relrowsecurity::text || ':' || relforcerowsecurity::text
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
  ) s`
const replaceOnce = (s, a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`khớp ${n} lần: ${a.slice(0, 70)}`); return s.split(a).join(b) }
// Thay đúng MỘT chỗ khớp regex (phần thay không chứa `$` ⇒ không dính quy tắc thay thế của String.replace).
const replaceRe = (s, re, b) => { const m = s.match(new RegExp(re.source, 'g')) ?? []; if (m.length !== 1) throw new Error(`regex khớp ${m.length} lần: ${re}`); return s.replace(re, () => b) }
const FN_117 = (() => {
  const i = MIG_117.indexOf('CREATE OR REPLACE FUNCTION public.rpc_set_tasks_archived(')
  return MIG_117.slice(i, MIG_117.indexOf('$$;', MIG_117.indexOf('AS $$', i) + 5) + 3)
})()

// ── Chạy ─────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('qa-tasks-archive-117.mjs')) {
  let pass = 0, fail = 0
  const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')) } }
  const section = (t) => console.log('\n' + t)
  const S = JSON.stringify
  const accepted = async (db, label, actor, ids, action, target, changed) => {
    const r = await call(db, actor, ids, action)
    ok(r.ok && r.r.target_count === target && r.r.changed_count === changed, label, r.ok ? S(r.r) : `${r.code} ${r.msg}`)
    return r
  }
  const rejected = async (db, label, actor, ids, action, needle, sqlstate) => {
    const before = await snap(db)
    const r = await call(db, actor, ids, action)
    const after = await snap(db)
    ok(!r.ok && r.msg.includes(needle) && (!sqlstate || r.code === sqlstate) && before.h === after.h, label,
      r.ok ? 'KHÔNG lỗi: ' + S(r.r) : `${r.code} ${r.msg}; dữ liệu đổi=${before.h !== after.h}`)
  }
  const execFails = async (db, sql, needle) => {
    try { await db.exec(sql); return 'KHÔNG lỗi' } catch (e) {
      await db.exec('ROLLBACK').catch(() => {})
      return String(e.message).includes(needle) ? true : 'lỗi khác: ' + e.message
    }
  }
  const fnExists = async (db) => (await db.query(`SELECT to_regprocedure('public.rpc_set_tasks_archived(uuid[], text)') IS NOT NULL AS x`)).rows[0].x
  const marker = async (db) => (await db.query(`SELECT count(*)::int AS n FROM public.app_migrations WHERE version = '117'`)).rows[0].n
  const t0 = Date.now()

  section('A. Migration 117: preflight, áp, quyền, chạy lại, không đổi đối tượng cũ')
  {
    const db = await L.freshDb(PGlite, { through: '115' })
    await db.exec(TASKS_DDL)
    const r = await execFails(db, MIG_117, '117: thiếu migration nền 116')
    ok(r === true && !(await fnExists(db)) && (await marker(db)) === 0, 'A1 thiếu marker 116 ⇒ RAISE, không tạo hàm / marker', String(r))
    await db.close()
  }
  const db = await db117({ apply: false })
  {
    await db.exec('SET ROLE dashboard_qa')
    const r = await execFails(db, MIG_117, 'không phải superuser / BYPASSRLS')
    await db.exec('RESET ROLE')
    ok(r === true && !(await fnExists(db)), 'A2 role chạy migration không superuser / BYPASSRLS ⇒ RAISE, không tạo hàm', String(r))
  }
  {
    // BYPASSRLS nhưng chỉ SELECT (has_table_privilege với danh sách quyền là OR — preflight phải kiểm từng quyền).
    await db.exec(`CREATE ROLE mig_sel NOLOGIN BYPASSRLS; GRANT SELECT ON ALL TABLES IN SCHEMA public TO mig_sel`)
    await db.exec('SET ROLE mig_sel')
    const r = await execFails(db, MIG_117, 'thiếu quyền SELECT/UPDATE')
    await db.exec('RESET ROLE')
    ok(r === true && !(await fnExists(db)), 'A2b role BYPASSRLS chỉ có SELECT (thiếu UPDATE tasks / sm_store_assignments) ⇒ RAISE', String(r))
    await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('118', 'qa_tuong_lai')`)
    const r2 = await execFails(db, MIG_117, '117: DB đã có migration > 117')
    await db.query(`DELETE FROM public.app_migrations WHERE version = '118'`)
    ok(r2 === true && !(await fnExists(db)), 'A2c DB đã có migration > 117 ⇒ RAISE', String(r2))
  }
  const catBefore = (await db.query(CATALOG_SQL)).rows[0]
  const dataBefore = await snap(db)
  const migBefore = (await db.query(`SELECT string_agg(version, ',' ORDER BY version) AS v FROM public.app_migrations`)).rows[0].v
  await db.exec(MIG_117)
  const catAfter = (await db.query(CATALOG_SQL)).rows[0]
  const migAfter = (await db.query(`SELECT string_agg(version, ',' ORDER BY version) AS v FROM public.app_migrations WHERE version <> '117'`)).rows[0].v
  ok(catBefore.h === catAfter.h && catBefore.n === catAfter.n && catBefore.n > 100, `A3 catalog public (cột, policy, grant bảng, hàm khác, index, trigger, RLS — ${catBefore.n} mục) KHÔNG đổi sau 117`, `${catBefore.n} → ${catAfter.n}`)
  ok(dataBefore.h === (await snap(db)).h && migBefore === migAfter && (await marker(db)) === 1, 'A4 dữ liệu tasks không đổi; app_migrations chỉ thêm 117')
  const fn = (await db.query(`SELECT p.prosecdef, p.proconfig, p.proowner::regrole::text AS owner FROM pg_proc p WHERE p.oid = 'public.rpc_set_tasks_archived(uuid[], text)'::regprocedure`)).rows[0]
  ok(fn.prosecdef && fn.proconfig.includes('search_path=public') && fn.proconfig.includes('lock_timeout=4s'), 'A5 SECURITY DEFINER + search_path=public + lock_timeout=4s', S(fn))
  const privs = async () => (await db.query(`
    SELECT has_function_privilege('authenticated', f, 'EXECUTE') AS auth, has_function_privilege('anon', f, 'EXECUTE') AS anon,
           has_function_privilege('service_role', f, 'EXECUTE') AS svc, has_function_privilege('dashboard_qa', f, 'EXECUTE') AS dash,
           (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END, ',' ORDER BY 1)
              FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x WHERE p.oid = f AND x.grantee <> p.proowner) AS acl
      FROM (SELECT 'public.rpc_set_tasks_archived(uuid[], text)'::regprocedure::oid AS f) s`)).rows[0]
  const p1 = await privs()
  ok(p1.auth && !p1.anon && !p1.svc && !p1.dash && p1.acl === 'authenticated', 'A6 EXECUTE chỉ authenticated (anon / service_role / role quản trị nhận default privileges / PUBLIC đều bị thu)', S(p1))
  await db.exec(MIG_117)
  ok((await marker(db)) === 1 && S(await privs()) === S(p1), 'A7 chạy lại 117 ⇒ idempotent (1 marker, quyền giữ nguyên)')
  for (const role of ['anon', 'service_role']) {
    const r = await call(db, L.U.super, [T.SUP], 'archive', role)
    ok(!r.ok && r.code === '42501' && /permission denied/.test(r.msg), `A8 gọi bằng ${role} ⇒ permission denied (không vào thân hàm)`, r.ok ? S(r.r) : r.msg)
  }
  // Đường ghi của app de2d750 (không dùng RPC) vẫn chạy trên DB 117: admin UPDATE qua RLS; nhánh SM qua service_role.
  {
    await L.as(db, L.U.ops, () => db.query(`UPDATE public.tasks SET archived_at = now() WHERE id = ANY ($1::uuid[])`, [[T.OPS, T.P1]]))
    const own = (await db.query(`SELECT id, archived_at IS NOT NULL AS a FROM public.tasks WHERE id = ANY ($1::uuid[]) ORDER BY id`, [[T.OPS, T.P1]])).rows
    await L.as(db, null, () => db.query(`UPDATE public.tasks SET archived_at = NULL WHERE id = $1`, [T.OPS]), 'service_role')
    const back = (await db.query(`SELECT archived_at FROM public.tasks WHERE id = $1`, [T.OPS])).rows[0].archived_at
    ok(own.find((x) => x.id === T.OPS).a && !own.find((x) => x.id === T.P1).a && back === null,
      'A9 app cũ trên DB 117: admin ghi qua RLS (chỉ task mình tạo) + ghi service_role vẫn như trước', S(own))
  }

  section('B. Quyền từng vai — mọi lần từ chối: archived_at toàn bảng trước/sau giống hệt')
  await accepted(db, 'B1 super lưu trữ 2 nhóm staff_all (2 × 261) ⇒ target 522, changed 522', L.U.super, [T.P1, T.P2], 'archive', 522, 522)
  const c1 = await closureArchived(db, [T.P1, T.P2])
  const h1 = await snap(db)
  ok(c1.total === 522 && c1.archived === 522, 'B1b đủ 522 dòng (cha + con) đã lưu trữ', S(c1))
  await accepted(db, 'B2 gọi lặp ⇒ target 522, changed 0 (idempotent)', L.U.super, [T.P1, T.P2], 'archive', 522, 0)
  ok((await snap(db)).h === h1.h, 'B2b gọi lặp KHÔNG ghi lại mốc archived_at cũ')
  await accepted(db, 'B3 super khôi phục ⇒ changed 522', L.U.super, [T.P2, T.P1], 'restore', 522, 522)
  ok((await closureArchived(db, [T.P1, T.P2])).archived === 0, 'B3b 522 dòng về archived_at NULL')
  await accepted(db, 'B4 admin (mkt) lưu trữ 2 nhóm mình tạo ⇒ 522', L.U.mkt, [T.P1, T.P2], 'archive', 522, 522)
  await accepted(db, 'B4b admin (mkt) khôi phục ⇒ 522', L.U.mkt, [T.P1, T.P2], 'restore', 522, 522)
  await rejected(db, 'B5 admin trộn task mình + task người khác ⇒ OUT_OF_SCOPE cả lô', L.U.mkt, [T.P1, T.OPS], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE', '42501')
  await rejected(db, 'B6 admin (ops) lưu trữ nhóm của mkt ⇒ OUT_OF_SCOPE', L.U.ops, [T.P1], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE', '42501')
  await rejected(db, 'B7 admin (mkt) task của super ⇒ OUT_OF_SCOPE', L.U.mkt, [T.SUP], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE')
  await rejected(db, 'B8 admin cha mình tạo nhưng có con do người khác tạo ⇒ OUT_OF_SCOPE', L.U.mkt, [T.P4], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE')
  await accepted(db, 'B9 admin (ops) task mình ⇒ 1', L.U.ops, [T.OPS], 'archive', 1, 1)
  await accepted(db, 'B10 super mọi task (ops + super + cha có con ngoài store) ⇒ 4 đích, 3 đổi', L.U.super, [T.OPS, T.SUP, T.P3], 'archive', 4, 3)
  await accepted(db, 'B10b super khôi phục lại ⇒ 4', L.U.super, [T.OPS, T.SUP, T.P3], 'restore', 4, 4)
  await accepted(db, 'B11 SM lưu trữ 2 nhóm ở store 1 + 2 được giao ⇒ 522', L.U.sm, [T.P1, T.P2], 'archive', 522, 522)
  await accepted(db, 'B11b SM khôi phục ⇒ 522', L.U.sm, [T.P1, T.P2], 'restore', 522, 522)
  await rejected(db, 'B12 SM: cha trong store được giao nhưng MỘT con ở store ngoài phạm vi ⇒ OUT_OF_SCOPE, cha không đổi', L.U.sm, [T.P3], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE', '42501')
  await rejected(db, 'B13 SM: nhóm hợp lệ + task store ngoài phạm vi ⇒ OUT_OF_SCOPE cả lô', L.U.sm, [T.P1, T.S3], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE')
  await rejected(db, 'B14 SM: task không gắn store ⇒ OUT_OF_SCOPE', L.U.sm, [T.NUL], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE')
  await rejected(db, 'B15 SM khác (chỉ store 1) với nhóm store 2 ⇒ OUT_OF_SCOPE', L.U.sm2, [T.P2], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE')
  await accepted(db, 'B16 SM: task store được giao do admin khác tạo ⇒ được (phạm vi SM theo store, như app cũ)', L.U.sm, [T.OPS], 'archive', 1, 1)
  await accepted(db, 'B16b SM khôi phục task đã lưu trữ (kể cả từ trước) ⇒ 2 đích, 2 đổi', L.U.sm, [T.OPS, T.ARCH], 'restore', 2, 2)
  await accepted(db, 'B16c SM lưu trữ lại task cũ ⇒ 1', L.U.sm, [T.ARCH], 'archive', 1, 1)
  await rejected(db, 'B17 QLCH ⇒ FORBIDDEN', L.U.qlch1, [T.P1], 'archive', 'TASKS_ARCHIVE_FORBIDDEN', '42501')
  await rejected(db, 'B18 dược sĩ ⇒ FORBIDDEN', L.U.A, [T.P1], 'restore', 'TASKS_ARCHIVE_FORBIDDEN', '42501')
  await rejected(db, 'B19 uid không có trong users ⇒ FORBIDDEN', ABSENT, [T.P1], 'archive', 'TASKS_ARCHIVE_FORBIDDEN')
  await rejected(db, 'B20 không có auth.uid() ⇒ UNAUTHENTICATED', null, [T.P1], 'archive', 'TASKS_ARCHIVE_UNAUTHENTICATED', '42501')
  {
    const child = (await db.query(`SELECT id FROM public.tasks WHERE parent_task_id = $1 ORDER BY id LIMIT 1`, [T.P1])).rows[0].id
    await accepted(db, 'B21 SM chọn trực tiếp một task con (store được giao) ⇒ 1', L.U.sm, [child], 'archive', 1, 1)
    await accepted(db, 'B21b khôi phục', L.U.sm, [child], 'restore', 1, 1)
    await accepted(db, 'B23 chọn cả cha lẫn con của nó ⇒ không đếm trùng: 261', L.U.mkt, [T.P1, child], 'archive', 261, 261)
    await accepted(db, 'B23b khôi phục', L.U.mkt, [child, T.P1], 'restore', 261, 261)
  }
  await rejected(db, 'B22 admin: task created_by NULL ⇒ OUT_OF_SCOPE', L.U.mkt, [T.NOBY], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE')
  await accepted(db, 'B22b super: task created_by NULL ⇒ được', L.U.super, [T.NOBY], 'archive', 1, 1)
  await accepted(db, 'B22c khôi phục', L.U.super, [T.NOBY], 'restore', 1, 1)
  await rejected(db, 'B24 dược sĩ gửi 6.000 UUID ⇒ FORBIDDEN (kiểm vai trước khi xử lý đầu vào)', L.U.A, Array.from({ length: 6000 }, () => crypto.randomUUID()), 'archive', 'TASKS_ARCHIVE_FORBIDDEN')
  await rejected(db, 'B25 SM / task người khác có 5.000 con ⇒ OUT_OF_SCOPE, không phải TOO_MANY (không lộ số con)', L.U.sm, [T.BIG], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE')
  await rejected(db, 'B25b admin / task người khác có 5.000 con ⇒ OUT_OF_SCOPE', L.U.mkt, [T.BIG], 'archive', 'TASKS_ARCHIVE_OUT_OF_SCOPE')

  section('C. Hợp đồng đầu vào')
  await rejected(db, 'C1 mảng rỗng ⇒ EMPTY', L.U.super, [], 'archive', 'TASKS_ARCHIVE_EMPTY', '22023')
  await rejected(db, 'C2 mảng NULL ⇒ EMPTY', L.U.super, null, 'archive', 'TASKS_ARCHIVE_EMPTY')
  await rejected(db, 'C3 phần tử NULL ⇒ BAD_INPUT', L.U.super, [T.P1, null], 'archive', 'TASKS_ARCHIVE_BAD_INPUT')
  await rejected(db, 'C4 action lạ ⇒ BAD_ACTION', L.U.super, [T.P1], 'delete', 'TASKS_ARCHIVE_BAD_ACTION', '22023')
  await rejected(db, 'C5 action NULL ⇒ BAD_ACTION', L.U.super, [T.P1], null, 'TASKS_ARCHIVE_BAD_ACTION')
  await rejected(db, 'C6 một ID không tồn tại trong lô ⇒ NOT_FOUND cả lô', L.U.super, [T.P1, ABSENT], 'archive', 'TASKS_ARCHIVE_NOT_FOUND', 'P0001')
  await rejected(db, 'C6b ID không tồn tại (SM) ⇒ NOT_FOUND, không lộ ID nào', L.U.sm, [T.P1, ABSENT], 'archive', 'TASKS_ARCHIVE_NOT_FOUND')
  const rand = (n) => Array.from({ length: n }, () => crypto.randomUUID())
  await rejected(db, 'C7 1.001 ID khác nhau ⇒ TOO_MANY', L.U.super, rand(1001), 'archive', 'TASKS_ARCHIVE_TOO_MANY', 'P0001')
  await rejected(db, 'C7c 5.001 phần tử thô (trùng) ⇒ TOO_MANY trước khi loại trùng', L.U.super, Array(5001).fill(T.SUP), 'archive', 'TASKS_ARCHIVE_TOO_MANY')
  {
    const before = await snap(db)
    const r = await L.as(db, L.U.super, async () => {
      try { await db.query(`SELECT public.rpc_set_tasks_archived(ARRAY[[$1::uuid], [$2::uuid]], 'archive')`, [T.SUP, T.OPS]); return 'KHÔNG lỗi' }
      catch (e) { return String(e.message).includes('TASKS_ARCHIVE_BAD_INPUT') ? true : e.message }
    })
    ok(r === true && (await snap(db)).h === before.h, 'C7d mảng 2 chiều ⇒ BAD_INPUT, không ghi', String(r))
  }
  await rejected(db, 'C7b đúng 1.000 ID (999 giả + 1 thật) qua trần ⇒ tới bước tồn tại: NOT_FOUND', L.U.super, [...rand(999), T.P1], 'archive', 'TASKS_ARCHIVE_NOT_FOUND')
  await accepted(db, 'C8 1.500 bản trùng của một ID ⇒ loại trùng, 1 đích', L.U.super, Array(1500).fill(T.SUP), 'archive', 1, 1)
  await accepted(db, 'C8b khôi phục', L.U.super, [T.SUP], 'restore', 1, 1)
  await rejected(db, 'C9 tập đích 5.001 (1 cha + 5.000 con) ⇒ TOO_MANY trước khi khoá', L.U.super, [T.BIG], 'archive', 'TASKS_ARCHIVE_TOO_MANY')
  await accepted(db, 'C9b tập đích đúng 5.000 ⇒ được', L.U.super, [T.BIG2], 'archive', 5000, 5000)
  await accepted(db, 'C9c khôi phục 5.000', L.U.super, [T.BIG2], 'restore', 5000, 5000)
  {
    const before = await snap(db)
    const r = await L.as(db, L.U.super, async () => {
      try { await db.query(`SELECT public.rpc_set_tasks_archived(ARRAY['khong-phai-uuid']::uuid[], 'archive')`); return 'KHÔNG lỗi' } catch (e) { return e.code }
    })
    ok(r === '22P02' && (await snap(db)).h === before.h, 'C10 chuỗi không phải UUID ⇒ lỗi kiểu 22P02, không ghi', String(r))
  }

  section('D. Lỗi giữa chừng ⇒ rollback toàn bộ (không ghi một phần)')
  {
    const last = (await db.query(`SELECT max(id::text)::uuid AS id FROM public.tasks WHERE id = ANY ($1::uuid[]) OR parent_task_id = ANY ($1::uuid[])`, [[T.P1, T.P2]])).rows[0].id
    await db.query(`CREATE FUNCTION public.qa_fail_row() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
      IF NEW.id = '${last}'::uuid THEN RAISE EXCEPTION 'QA_UPDATE_FAIL'; END IF; RETURN NEW; END $f$`)
    await db.exec(`CREATE TRIGGER qa_fail_row AFTER UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.qa_fail_row()`)
    for (const [actor, label] of [[L.U.super, 'super'], [L.U.mkt, 'admin'], [L.U.sm, 'SM']]) {
      await rejected(db, `D1 ${label}: UPDATE lỗi ở dòng cuối (sau khi đã ghi ~521 dòng) ⇒ 0 dòng đổi`, actor, [T.P1, T.P2], 'archive', 'QA_UPDATE_FAIL')
    }
    await db.exec(`DROP TRIGGER qa_fail_row ON public.tasks; DROP FUNCTION public.qa_fail_row()`)
  }
  {
    await db.exec(`ALTER TABLE public.sm_store_assignments RENAME TO sm_store_assignments_qa_off`)
    await rejected(db, 'D2 SM: đọc phân công cửa hàng lỗi ⇒ lỗi, không ghi (không fail-open)', L.U.sm, [T.P1], 'archive', 'sm_store_assignments')
    await db.exec(`ALTER TABLE public.sm_store_assignments_qa_off RENAME TO sm_store_assignments`)
    await db.exec(`ALTER TABLE public.users RENAME TO users_qa_off`)
    await rejected(db, 'D3 đọc role / users lỗi ⇒ lỗi, không ghi', L.U.mkt, [T.P1], 'archive', 'users')
    await db.exec(`ALTER TABLE public.users_qa_off RENAME TO users`)
    await accepted(db, 'D4 sau khi phục hồi bảng: SM chạy lại được (lỗi trước không để lại trạng thái)', L.U.sm, [T.P1], 'archive', 261, 261)
    await accepted(db, 'D4b khôi phục', L.U.sm, [T.P1], 'restore', 261, 261)
  }
  {
    // BEFORE UPDATE trả NULL cho một dòng ⇒ UPDATE bỏ qua dòng đó ⇒ số dòng đổi lệch số đích ⇒ COUNT_MISMATCH, rollback.
    const one = (await db.query(`SELECT id FROM public.tasks WHERE parent_task_id = $1 ORDER BY id OFFSET 5 LIMIT 1`, [T.P2])).rows[0].id
    await db.query(`CREATE FUNCTION public.qa_skip_row() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
      IF NEW.id = '${one}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $f$`)
    await db.exec(`CREATE TRIGGER qa_skip_row BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.qa_skip_row()`)
    await rejected(db, 'D5 UPDATE ghi thiếu một dòng ⇒ COUNT_MISMATCH, 0 dòng đổi', L.U.super, [T.P2], 'archive', 'TASKS_ARCHIVE_COUNT_MISMATCH', 'P0001')
    await db.exec(`DROP TRIGGER qa_skip_row ON public.tasks; DROP FUNCTION public.qa_skip_row()`)
  }

  section('E. Đối chứng đột biến (chỉ trong DB thử): test âm phải bắt được bản RPC sai')
  {
    const mutants = [
      ['M1 SM chỉ kiểm ID đã chọn, bỏ con', replaceRe(FN_117, /ANY \(v_target\)(?=\s+AND NOT \(t\.store_id)/, 'ANY (v_ids)'),
        () => call(db, L.U.sm, [T.P3], 'archive')],
      ['M2 admin chỉ kiểm ID đã chọn, bỏ con', replaceOnce(FN_117, 'WHERE t.id = ANY (v_target) AND t.created_by IS DISTINCT FROM v_uid)', 'WHERE t.id = ANY (v_ids) AND t.created_by IS DISTINCT FROM v_uid)'),
        () => call(db, L.U.mkt, [T.P4], 'archive')],
      ['M3 bỏ kiểm ID tồn tại', replaceOnce(FN_117, 'IF (SELECT count(*) FROM public.tasks t WHERE t.id = ANY (v_ids)) <> cardinality(v_ids) THEN', 'IF false THEN'),
        () => call(db, L.U.super, [T.SUP, ABSENT], 'archive')],
    ]
    for (const [name, sql, run] of mutants) {
      const before = await snap(db)
      await db.exec(sql)
      const r = await run()
      ok(r.ok, `${name} ⇒ bản đột biến ghi được (test âm tương ứng sẽ đỏ)`, r.ok ? '' : r.msg)
      await db.exec(FN_117)
      await L.as(db, null, () => db.query(`UPDATE public.tasks SET archived_at = NULL WHERE archived_at IS NOT NULL AND id <> $1`, [T.ARCH]), 'service_role')
      ok((await snap(db)).h === before.h, `${name} — dọn: dữ liệu về như trước`)
    }
    const p2 = await privs()
    ok(S(p2) === S(p1), 'E4 sau khi nạp lại thân gốc: quyền thực thi không đổi', S(p2))
  }

  await db.close()
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'CÓ LỖI'} ${pass}/${fail} — ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  process.exit(fail === 0 ? 0 : 1)
}
