// QA công cụ CMS P1-R1 / P1-R2 + VERIFY phase 122 (PM 03/11 §5) trên PGlite (Postgres 16 WASM) với nền giống prod của
// lib-care-pglite.mjs + migration 120 + 121 + 122 THẬT: chạy đúng chuỗi SQL mà scripts/cms-qa-access.mjs / cms-qa-run.mjs / cms-verify.mjs gửi tới pg-meta (bọc
// READ ONLY … ROLLBACK hoặc BEGIN … COMMIT), lấy result set như pg-meta (probe prod 02/11: kết quả CUỐI CÙNG CÓ ≥ 1 DÒNG,
// không có ⇒ []). Gồm ca âm cho từng lỗ db-reviewer / security-reviewer đã tái hiện. KHÔNG chạm DB thật.
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần, trong webapp/
//   node scripts/qa-cms-qa-tooling.mjs              # kỳ vọng: N đạt · 0 lỗi (mọi phần)
//   node scripts/qa-cms-qa-tooling.mjs --part=base  # §1–§12 (120 / 121 / 122) · --part=123 # §13–§17 (VERIFY phase 123 + V8 123)
// GIỚI HẠN: PGlite không có pg_safeupdate (DELETE có WHERE chỉ kiểm bằng đọc code + spec chuỗi SQL); harness lấy
// is_super_admin() từ migration < 114 (không phải 119a) — không ảnh hưởng công cụ.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL_120 = fs.readFileSync(path.join(MIG, '120_cms_foundation.sql'), 'utf8')
const SQL_121 = fs.readFileSync(path.join(MIG, '121_cms_import_activation.sql'), 'utf8')
const SQL_122 = fs.readFileSync(path.join(MIG, '122_cms_results.sql'), 'utf8')
const SQL_123 = fs.readFileSync(path.join(MIG, '123_cms_payouts.sql'), 'utf8')
const RB_123 = fs.readFileSync(path.join(MIG, 'rollback', '123_cms_payouts_rollback.sql'), 'utf8')
const PART = (process.argv.find((a) => a.startsWith('--part=')) ?? '--part=all').slice('--part='.length)
if (!['all', 'base', '123'].includes(PART)) { console.error('dùng: --part=all|base|123'); process.exit(2) }
const BASE = PART !== '123', P123 = PART !== 'base'
let PGlite
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch {
  console.error('FAIL: thiếu @electric-sql/pglite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  process.exit(2)
}
const jiti = createJiti(import.meta.url, { interopDefault: true })
const T = await jiti.import(path.join(HERE, '..', 'e2e', 'cmsQaTooling.ts'))

let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) } }
const section = (s) => console.log(`\n${s}`)
const { U, uid, storeId } = L
const UNKNOWN = uid(99999)
const sleep = (n) => new Promise((r) => setTimeout(r, n))

/** Như pg-meta: result set CUỐI CÙNG CÓ ≥ 1 DÒNG; không có ⇒ []. */
const lastRows = (results) => { for (let i = results.length - 1; i >= 0; i--) if (results[i].rows?.length) return results[i].rows; return [] }
function ctx(db) {
  const c = {
    db,
    ro: async (sql) => lastRows(await db.exec(T.pgMetaReadOnly(sql))),
    wr: async (sql) => lastRows(await db.exec(T.pgMetaWrite(sql))),
    lastErr: '',
    async raises(p, needle) {
      try { await p } catch (e) {
        c.lastErr = String(e?.message ?? e)
        await db.exec('ROLLBACK').catch(() => {})
        return needle ? c.lastErr.includes(needle) : true
      }
      c.lastErr = 'KHÔNG raise'
      return false
    },
    async postInput(phase, aclPre, { tolerant = false, requireProven } = {}) {
      const q = T.CMS_VERIFY_SQL
      // tolerant: DB chưa ở phase khai báo ⇒ truy vấn của phase sau lỗi (CLI rc 1); ở đây coi như THIẾU để kiểm bộ đánh giá.
      const tr = async (sql, fallback) => { try { return await c.ro(sql) } catch (e) { if (!tolerant) throw e; await db.exec('ROLLBACK').catch(() => {}); return fallback } }
      const input = {
        phase,
        whoami: (await c.ro(q.whoami))[0], markers: await c.ro(q.markers), maxNumeric: (await c.ro(q.maxNumeric))[0],
        functions: await c.ro(q.functions), policies: await c.ro(q.policies), triggers: await c.ro(q.triggers), tableShape: await c.ro(q.tableShape),
        tables: await c.ro(q.tables), roles: await c.ro(q.roles),
        oneRunningIndex: await c.ro(q.oneRunningIndex), aclPost: (await c.ro(T.cmsVerifyAclSql()))[0], aclPre,
      }
      if (phase !== '120') {
        input.inv121 = { overlap: await c.ro(q.inv121Overlap), tiers: await c.ro(q.inv121Tiers), catalog: await c.ro(q.inv121Catalog) }
        input.isolation = (await c.ro(q.isolation))[0]
      }
      if (Number(phase) >= 122) {
        input.p122 = {
          tiersUnique: await tr(q.tiersUnique, []), pointerFk: await tr(q.pointerFk, []),
          releaseGate: (await tr(q.releaseGate, [{}]))[0] ?? {}, inv122Pointer: await tr(q.inv122Pointer, [{ id: 'THIẾU' }]),
          fnDefs: await tr(q.fnDefs, []), columns: await tr(q.columns, []),
        }
      }
      if (phase === '123') {
        input.p123 = {
          owners: (await tr(q.owners, [{}]))[0] ?? {}, isolation123: (await tr(q.isolation123, [{}]))[0] ?? {}, triggerFns: await tr(q.triggerFns, []),
          lockPolicy: (await tr(q.lockPolicy, [{}]))[0] ?? {}, payoutAcl: await tr(q.payoutAcl, []),
          invPayout: (await tr(q.invPayout, [{}]))[0] ?? {}, invLocked: (await tr(q.invLocked, [{}]))[0] ?? {},
          invPayoutStaff: (await tr(q.invPayoutStaff, [{}]))[0] ?? {}, invRunFrozen: (await tr(q.invRunFrozen, [{}]))[0] ?? {},
          payoutReach: await tr(q.payoutReach, []), lockPreview: (await tr(q.lockPreview, [{}]))[0] ?? {},
        }
      }
      if (requireProven) input.requireProven = requireProven
      return input
    },
    async v8(user, role, expect) {
      const sql = expect?.phase === '123' ? T.cmsVerifyV8Sql123(user, role) : T.cmsVerifyV8Sql(user, role, expect?.phase)
      const [row] = lastRows(await db.exec(T.pgMetaReadOnlySnapshot(sql)))
      return { row, checks: T.evaluateCmsV8(row, user, role, expect) }
    },
  }
  return c
}
const failed = (checks) => checks.filter((x) => !x.ok).map((x) => `${x.id}: ${x.detail}`)
const failedIds = (checks) => checks.filter((x) => !x.ok).map((x) => x.id)

const P = { real: uid(7001), test: uid(7002), draft: uid(7003), s2: uid(7004) }
async function prog(db, id, status, store, isTest, createdBy = U.super) {
  await db.query(
    `INSERT INTO public.cms_programs (id, name, status, start_date, end_date, scope, is_test, created_by, activated_at)
     VALUES ($1, $2, $3, '2026-11-01', '2026-11-30', 'stores', $4, $5, CASE WHEN $3 = 'draft' THEN NULL ELSE now() END)`,
    [id, `QA ${id.slice(-4)}`, status, isTest, createdBy])
  await db.query(`INSERT INTO public.cms_program_stores (program_id, store_id) VALUES ($1, $2)`, [id, store])
}
async function product(db, ppId, programId, productId) {
  await db.query(`INSERT INTO public.cms_program_products (id, program_id, product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms, advice_text, name_snapshot)
                  VALUES ($1, $2, $3, 'product', 1000, 'hộp', 1, 'Tư vấn mẫu', 'SP giả')`, [ppId, programId, productId])
  await db.query(`INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit) VALUES ($1, $2, 1, 1, NULL, 1000)`, [ppId, programId])
}
/** Nền + PRE120 + 120 + PRE121 + 121 + dữ liệu mẫu. Trả ctx và hai ảnh PRE. */
async function freshCms() {
  const db = await L.freshDb(PGlite)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  const c = ctx(db)
  const pre120 = (await c.ro(T.cmsVerifyAclSql()))[0]
  await sleep(15)
  await db.exec(SQL_120)
  await sleep(15)
  const pre121 = (await c.ro(T.cmsVerifyAclSql()))[0]
  await sleep(15)
  await db.exec(SQL_121)
  await prog(db, P.real, 'active', storeId(1), false)
  await prog(db, P.test, 'active', storeId(1), true)
  await prog(db, P.draft, 'draft', storeId(1), false)
  await prog(db, P.s2, 'active', storeId(2), false)
  await product(db, uid(7101), P.real, '900001')
  await product(db, uid(7102), P.test, '900002')
  await product(db, uid(7103), P.s2, '900003')
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at) VALUES ('900001', 'SP giả', true, now()), ('900002', 'SP giả 2', true, now())`)
  return { c, pre120, pre121 }
}

if (BASE) { // §1–§9 (thụt lề giữ nguyên để diff chỉ là phần bọc)
section('1. VERIFY POST 120 / 121 trên DB sạch (PRE mới đo ngay trước từng migration)')
{
  const db = await L.freshDb(PGlite)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  const c = ctx(db)
  const pre120 = (await c.ro(T.cmsVerifyAclSql()))[0]
  ok(pre120.n_all === pre120.n_old && pre120.n_all > 0 && pre120.db_now, 'PRE 120: chưa có hàm cms, có giờ DB')
  await sleep(15)
  await db.exec(SQL_120)
  const post120 = T.evaluateCmsVerify(await c.postInput('120', pre120))
  ok(failed(post120).length === 0 && post120.length >= 40, `POST 120: ${post120.length} mục đạt hết`, JSON.stringify(failed(post120)))
  await sleep(15)
  const pre121 = (await c.ro(T.cmsVerifyAclSql()))[0]
  ok(pre121.n_all - pre121.n_old === 7 && pre121.md5_old === pre120.md5_old, 'PRE 121: có đúng 7 hàm cms của 120; ACL hàm ngoài cms không đổi')
  await sleep(15)
  await db.exec(SQL_121)
  const post121 = T.evaluateCmsVerify(await c.postInput('121', pre121))
  ok(failed(post121).length === 0 && post121.length >= 80, `POST 121: ${post121.length} mục đạt hết`, JSON.stringify(failed(post121)))
  const preLate = (await c.ro(T.cmsVerifyAclSql()))[0]
  ok(failedIds(T.evaluateCmsVerify(await c.postInput('121', preLate))).includes('pre-order'), 'PRE chụp SAU khi chạy 121 ⇒ đỏ pre-order')
  ok(failedIds(T.evaluateCmsVerify(await c.postInput('121', pre120))).includes('pre-order'), 'PRE của 120 dùng cho 121 ⇒ đỏ pre-order')
}

const { c: M } = await freshCms()
const db = M.db

section('2. Marker QA: status / grant / revoke (đúng chuỗi script gửi)')
const st0 = await M.ro(T.cmsQaStatusSql([U.super, U.A, UNKNOWN]))
ok(st0.length === 3 && st0.map((r) => r.user_id).join() === [U.super, U.A, UNKNOWN].join(), 'status: đúng 3 dòng theo thứ tự yêu cầu')
ok(st0[0].user_exists && st0[0].role === 'admin' && !st0[0].active && st0[0].expires_at === null, 'status: super có tài khoản, chưa marker')
ok(st0[1].role === 'staff' && st0[1].store_type === 'os' && st0[1].store_active === true, 'status: staff OS đang hoạt động (không email / tên)')
ok(!st0[2].user_exists && st0[2].role === null, 'status: user_id không có tài khoản')
ok(!Object.keys(st0[0]).some((k) => /mail|name|phone/i.test(k)), 'status: không có cột email / tên / SĐT', Object.keys(st0[0]).join())
const g = await M.wr(T.cmsQaGrantSql([U.super, U.A], 2))
ok(g.length === 2 && g.every((r) => new Date(r.expires_at) - new Date(r.granted_at) === 2 * 3_600_000), 'grant 2 giờ: expires_at = granted_at (giờ DB) + 2 giờ')
ok((await L.one(db, `SELECT bool_and(granted_by = 'qa-script:operator') b FROM public.cms_qa_access`)).b, 'granted_by = qa-script:operator (không email)')
ok(await M.raises(db.exec(T.pgMetaWrite(T.cmsQaGrantSql([U.B, UNKNOWN], 2))), 'CMS_QA_UNKNOWN_USER'), 'grant có user_id không tồn tại ⇒ RAISE', M.lastErr)
ok(!(await M.ro(T.cmsQaStatusSql([U.B])))[0].expires_at, '… và KHÔNG cấp phần còn lại (transaction)')
ok(await M.raises(db.exec(T.pgMetaReadOnly(T.cmsQaGrantSql([U.B], 2))), 'read-only'), 'chuỗi ghi bọc READ ONLY ⇒ DB chặn', M.lastErr)
await M.wr(T.cmsQaGrantSql([U.C], 168))
ok((await M.ro(T.cmsQaStatusSql([U.C])))[0].remaining_s > 167 * 3600, 'grant 168 giờ (biên 7 ngày) được CHECK 120 chấp nhận')
let threw = false
try { T.cmsQaGrantSql([U.C], 169) } catch { threw = true }
ok(threw, 'builder chặn 169 giờ trước khi tới DB')
threw = false
try { T.cmsQaGrantSql([U.C, U.C], 2) } catch { threw = true }
ok(threw, 'builder chặn id trùng (không ra mã CMS_QA_UNKNOWN_USER gây hiểu nhầm)')
await M.wr(T.cmsQaGrantSql([U.A], 3))
const ext = (await M.ro(T.cmsQaStatusSql([U.A])))[0]
ok(new Date(ext.expires_at) - new Date(ext.granted_at) === 3 * 3_600_000, 'gia hạn: upsert, granted_at đóng lại theo giờ DB')
const del = await M.wr(T.cmsQaRevokeSql([U.C, U.B]))
ok(del.length === 1 && del[0].user_id === U.C, 'revoke [C, B]: xoá đúng 1 marker có thật (C)')
ok((await L.count(db, `SELECT count(*) FROM public.cms_qa_access`)) === 2, 'revoke không chạm marker ngoài danh sách (super, A còn)')
ok((await M.ro('SELECT 1 AS x WHERE false')).length === 0, 'harness: lô chỉ có câu rỗng ⇒ [] như pg-meta')

section('3. Preflight + canh marker theo giờ DB')
const st1 = await M.ro(T.cmsQaStatusSql([U.super, U.A]))
ok(T.cmsQaPreflight(st1, [U.super, U.A], 60).ok, 'super (2 giờ) + A (3 giờ) ≥ 60 phút ⇒ đạt')
const pf2 = T.cmsQaPreflight(st1, [U.super, U.A], 150)
ok(!pf2.ok && pf2.reasons.length === 1 && /tối thiểu 150/.test(pf2.reasons[0]), 'super còn ~120 phút < 150 ⇒ chặn (che id)', JSON.stringify(pf2))
ok(!T.cmsQaPreflight(await M.ro(T.cmsQaStatusSql([U.super, U.B])), [U.super, U.B], 60).ok, 'tài khoản không có marker ⇒ chặn')
ok(!T.cmsQaWatchdog(st1, [U.super, U.A], 10).stop, 'canh: marker còn > 10 phút ⇒ chạy tiếp')
const wd = T.cmsQaWatchdog(st1, [U.super, U.A], 150)
ok(wd.stop && /ngưỡng canh 150/.test(wd.reasons.join()), 'canh: marker còn < ngưỡng ⇒ dừng server')
ok(T.cmsQaWatchdog(await M.ro(T.cmsQaStatusSql([U.super, U.B])), [U.super, U.B], 10).stop, 'canh: tài khoản mất marker ⇒ dừng')

section('4. V8 — phiên authenticated mô phỏng, oracle theo vai khai báo')
const proven = (checks, id) => checks.find((x) => x.id === id)?.proven
let r = await M.v8(U.super, 'super', { qa: true, readable: 4 })
ok(failed(r.checks).length === 0 && r.row.test_programs === 1 && r.row.seen_master === 2 && r.row.iso === 'repeatable read',
  'super + marker: 4 chương trình (gồm QA, nháp), đủ Product Master, cùng một snapshot', JSON.stringify(failed(r.checks)))
ok(proven(r.checks, 'v8-table:programs') === false, 'super thấy hết ⇒ "CHƯA CHỨNG MINH CẮT" (không ghi ĐẠT oan)')
r = await M.v8(U.A, 'staff', { qa: true, readable: 2 })
ok(failed(r.checks).length === 0 && proven(r.checks, 'v8-table:programs') === true && proven(r.checks, 'v8-table:products') === true
  && proven(r.checks, 'v8-table:master') === true, 'staff A + marker: tập đúng 2 (active thật + QA store 1); RLS cắt chương trình / SP / Product Master được chứng minh', JSON.stringify(failed(r.checks)))
r = await M.v8(U.A, 'staff', { requireProven: ['programs', 'products'] })
ok(failed(r.checks).length === 0, '--require-proven=programs,products với staff A ⇒ đạt')
r = await M.v8(U.super, 'super', { requireProven: ['programs'] })
ok(failedIds(r.checks).includes('v8-require-proven:programs'), '--require-proven=programs với super thấy hết ⇒ đỏ (gate D3 được máy ép)')
r = await M.v8(U.B, 'staff', { qa: false, readable: 1 })
ok(failed(r.checks).length === 0 && r.row.test_programs === 0 && r.row.total_programs === 4, 'staff B KHÔNG marker: không thấy QA dù DB có', JSON.stringify(failed(r.checks)))
r = await M.v8(U.sm, 'sm', { qa: false })
ok(failed(r.checks).length === 0 && r.row.readable === 2 && r.row.draft_programs === 0, 'SM: active thật của store được giao (store 1 + 2), không nháp / QA', JSON.stringify(failed(r.checks)))
r = await M.v8(U.mkt, 'admin', { qa: false, readable: 0 })
ok(failed(r.checks).length === 0 && r.row.seen_master === 0, 'admin thường: 0 chương trình, 0 Product Master', JSON.stringify(failed(r.checks)))
r = await M.v8(U.mkt, 'super')
ok(failedIds(r.checks).includes('v8-super') && failedIds(r.checks).includes('v8-oracle-set'), 'khai báo sai vai (admin thường khai super) ⇒ đỏ v8-super + tập')
r = await M.v8(U.super, 'admin')
ok(failedIds(r.checks).includes('v8-super'), 'super khai là admin thường ⇒ đỏ v8-super (không xanh khi tổng = 0)')
r = await M.v8(U.A, 'qlch')
ok(failedIds(r.checks).includes('v8-user'), 'khai báo vai khác vai DB ⇒ đỏ v8-user')
r = await M.v8(UNKNOWN, 'staff')
ok(failedIds(r.checks).includes('v8-user'), 'A1: user_id không có tài khoản ⇒ đỏ (không còn ĐẠT 0 = 0)', JSON.stringify(failed(r.checks)))
await M.wr(T.cmsQaRevokeSql([U.super]))
r = await M.v8(U.super, 'super', { qa: false, readable: 3 })
ok(failed(r.checks).length === 0 && r.row.test_programs === 0, 'super sau khi thu marker: 3 chương trình thật, 0 QA (H9b)', JSON.stringify(failed(r.checks)))
ok((await L.one(db, `SELECT current_user::text u`)).u !== 'authenticated', 'sau V8 phiên DB trở lại vai cũ (SET LOCAL hết khi ROLLBACK)')

section('5. Marker hết hạn (giả lập — trigger 120 không cho lùi giờ qua UPDATE thường)')
await db.exec(`ALTER TABLE public.cms_qa_access DISABLE TRIGGER cms_qa_access_stamp;
  UPDATE public.cms_qa_access SET granted_at = now() - interval '3 hours', expires_at = now() - interval '1 minute' WHERE user_id = '${U.A}';
  ALTER TABLE public.cms_qa_access ENABLE TRIGGER cms_qa_access_stamp;`)
const stExp = (await M.ro(T.cmsQaStatusSql([U.A])))[0]
ok(stExp.expires_at !== null && stExp.active === false && stExp.remaining_s === 0, 'status: marker còn dòng nhưng hết hạn ⇒ active false')
ok(!T.cmsQaPreflight([stExp], [U.A], 1).ok && T.cmsQaWatchdog([stExp], [U.A], 1).stop, 'preflight chặn + canh dừng server')
r = await M.v8(U.A, 'staff', { qa: false, readable: 1 })
ok(failed(r.checks).length === 0 && r.row.test_programs === 0, 'V8: marker hết hạn ⇒ không thấy QA (giờ DB)', JSON.stringify(failed(r.checks)))

section('6. Đóng run: mốc theo đúng hành động; import trên chương trình thật; không đỏ oan')
await M.wr(T.cmsQaGrantSql([U.super], 2))
await sleep(15)
const [{ now: dbNow }] = await M.ro(`SELECT now() AS now`)
await sleep(15)
const manifest = T.newCmsQaManifest({
  runId: 'cms-qa-test', mode: 'manual-localhost', host: 'pglite.local', dbNow, gitHead: 'a'.repeat(40), gitTree: 'b'.repeat(40),
  buildId: 'B', port: 3120, users: [{ id: U.super, role: 'admin', markerExpiresAt: new Date(Date.now() + 7.2e6).toISOString(), remainingS: 7200 }],
})
const PR = { qa: uid(7201), realByQa: uid(7202), realOther: uid(7203) }
await prog(db, PR.qa, 'draft', storeId(1), true)
let rows = await M.ro(T.cmsQaRunProgramsSql(manifest.startedAt, [U.super]))
let st2 = await M.ro(T.cmsQaStatusSql([U.super]))
let cc = T.cmsQaCloseCheck(manifest, rows, st2, [])
ok(cc.ok && cc.warnings.length === 0 && cc.closed.programs.map((p) => p.id).join() === PR.qa && cc.closed.closeCheck.markerActiveAtClose.join() === U.super,
  'run sạch: ghi chương trình QA, marker còn hạn; chương trình trước run không lọt', JSON.stringify(rows))
// Đỏ oan cũ: chương trình thật do tài khoản QA tạo TRƯỚC run, người khác sửa TRONG run ⇒ chỉ cảnh báo.
await db.query(`UPDATE public.cms_programs SET updated_by = $1, updated_at = now() WHERE id = $2`, [U.mkt, P.real])
rows = await M.ro(T.cmsQaRunProgramsSql(manifest.startedAt, [U.super]))
cc = T.cmsQaCloseCheck(manifest, rows, st2, [])
ok(cc.ok && cc.closed.closeCheck.realProgramsChangedByOthers.join() === P.real, 'chương trình thật do QA tạo trước run, người khác sửa trong run ⇒ cảnh báo, KHÔNG đỏ')
// Lọt cũ: tài khoản QA chỉ preview import trên chương trình thật (không đổi cms_programs.updated_*).
await db.query(`INSERT INTO public.cms_import_runs (program_id, mode, file_name, file_sha256, file_bytes, config_version_at_preview, created_by)
                VALUES ($1, 'replace', 'qa.xlsx', repeat('c', 64), 100, 1, $2)`, [P.s2, U.super])
rows = await M.ro(T.cmsQaRunProgramsSql(manifest.startedAt, [U.super]))
cc = T.cmsQaCloseCheck(manifest, rows, st2, [])
ok(!cc.ok && cc.closed.closeCheck.realProgramsTouchedByQaUsers.join() === P.s2, 'tài khoản QA preview import trên chương trình THẬT ⇒ ĐỎ')
// Chương trình thật do tài khoản QA tạo trong run ⇒ đỏ; do người khác tạo ⇒ cảnh báo.
await db.query(`INSERT INTO public.cms_programs (id, name, status, start_date, end_date, scope, is_test, created_by) VALUES ($1, 'QA thật', 'draft', '2026-12-01', '2026-12-31', 'stores', false, $2), ($3, 'Khác', 'draft', '2026-12-01', '2026-12-31', 'stores', false, $4)`,
  [PR.realByQa, U.super, PR.realOther, U.mkt])
rows = await M.ro(T.cmsQaRunProgramsSql(manifest.startedAt, [U.super]))
cc = T.cmsQaCloseCheck(manifest, rows, st2, [])
ok(!cc.ok && cc.closed.closeCheck.realProgramsTouchedByQaUsers.sort().join() === [P.s2, PR.realByQa].sort().join()
  && cc.closed.closeCheck.realProgramsChangedByOthers.sort().join() === [P.real, PR.realOther].sort().join(),
'chương trình thật QA tạo trong run ⇒ đỏ; người khác tạo ⇒ cảnh báo soát tay', JSON.stringify(cc.closed.closeCheck))
// db-reviewer vòng 3 P2-B: manifest ghi nhầm id chương trình THẬT (không đổi trong run) ⇒ close đọc lại cờ ⇒ đỏ.
{
  const m2 = T.cmsQaManifestAddProgram(T.cmsQaManifestAddProgram(manifest, P.test), P.draft)
  const rec = await M.ro(T.cmsQaProgramFlagsSql(m2.programs.map((p) => p.id)))
  const c2 = T.cmsQaCloseCheck(m2, [], st2, rec)
  ok(!c2.ok && /THẬT \(is_test = false\)/.test(c2.reasons.join()) && c2.closed.programs.map((p) => p.id).join() === P.test,
    'manifest ghi nhầm chương trình THẬT là QA ⇒ đỏ; manifest đóng chỉ giữ id is_test thật', JSON.stringify(c2.reasons))
  const c3 = T.cmsQaCloseCheck(m2, [], st2, rec.filter((x) => x.id === P.test))
  ok(!c3.ok && /không còn trong DB/.test(c3.reasons.join()), 'id trong manifest không còn trong DB ⇒ đỏ')
}

section('7. Chứng minh is_test (và đã ghi vào run) trước thao tác QA tự động')
const flags = await M.ro(T.cmsQaProgramFlagsSql([P.test, P.real]))
const withRun = T.cmsQaManifestAddProgram(T.cmsQaManifestAddProgram(manifest, P.test), P.real)
ok(T.assertCmsQaProgramIds([P.test], flags, withRun).ok, 'id chương trình QA (is_test = true, đã ghi vào run) ⇒ cho thao tác')
const deny = T.assertCmsQaProgramIds([P.test, P.real], flags, withRun)
ok(!deny.ok && /is_test = false/.test(deny.reasons.join()), 'lẫn id chương trình thật (kể cả đã lỡ ghi vào run) ⇒ từ chối toàn bộ')
ok(!T.assertCmsQaProgramIds([P.test], flags, manifest).ok, 'id chưa ghi vào run (cmsQaManifestAddProgram ngay khi tạo) ⇒ từ chối')

section('8. V8 bắt lệch RLS (vòng 1: A1 / B1 / B2 / C1; vòng 2: tập lệch cùng số lượng) — mỗi ca một DB riêng')
const P_LOCKED = uid(7005)
const addLocked = async (db) => {
  await db.query(`INSERT INTO public.cms_programs (id, name, status, start_date, end_date, scope, is_test, created_by, activated_at, locked_at)
                  VALUES ($1, 'QA locked', 'locked', '2026-10-01', '2026-10-31', 'stores', false, $2, now(), now())`, [P_LOCKED, U.super])
  await db.query(`INSERT INTO public.cms_program_stores (program_id, store_id) VALUES ($1, $2)`, [P_LOCKED, storeId(1)])
}
{
  // probe2 vòng 2: helper lỗi kép — staff thấy active của nhà thuốc khác, mất locked của nhà thuốc mình; cùng số lượng.
  const { c: N } = await freshCms()
  await addLocked(N.db)
  let v = await N.v8(U.B, 'staff', { readable: 2 })
  ok(failed(v.checks).length === 0, 'đối chứng: staff B store 1 thấy đúng {active thật, locked} của store 1', JSON.stringify(failed(v.checks)))
  await N.db.exec(`CREATE OR REPLACE FUNCTION public.cms_readable_program_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}'::uuid[]) FROM public.cms_programs p WHERE p.status = 'active' AND NOT p.is_test $$`)
  v = await N.v8(U.B, 'staff', { readable: 2 })
  ok(v.row.readable === 2 && failedIds(v.checks).includes('v8-oracle-set'), 'helper lệch TẬP nhưng cùng số (2 = 2, kể cả --expect-readable=2) ⇒ đỏ v8-oracle-set', JSON.stringify(failed(v.checks)))
}
{
  const { c: N } = await freshCms()
  const polProducts = (await L.one(N.db, `SELECT policyname p FROM pg_policies WHERE tablename = 'cms_program_products'`)).p
  await N.db.exec(`ALTER POLICY ${polProducts} ON public.cms_program_products USING (program_id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]) OR true)`)
  const v = await N.v8(U.A, 'staff')
  ok(failedIds(v.checks).includes('v8-outside') && failedIds(v.checks).includes('v8-table:products'), 'C1: policy SP nới `… OR true` ⇒ staff thấy SP ngoài tập ⇒ đỏ', JSON.stringify(failed(v.checks)))
}
{
  const { c: N } = await freshCms()
  await N.wr(T.cmsQaGrantSql([U.super], 2))
  await N.db.exec(`ALTER TABLE public.cms_programs DISABLE ROW LEVEL SECURITY`)
  let v = await N.v8(U.super, 'super', { qa: true })
  ok(failedIds(v.checks).includes('v8-rls-active'), 'B2: tắt RLS cms_programs ⇒ đỏ ngay cả với super thấy hết')
  v = await N.v8(U.B, 'staff')
  ok(failedIds(v.checks).includes('v8-rls-active') && failedIds(v.checks).includes('v8-oracle-set'), 'B1: tắt RLS ⇒ staff thấy hết ⇒ đỏ', JSON.stringify(failed(v.checks)))
}

section('9. POST bắt lệch — mỗi ca khẳng định mục CHƯA đỏ trước khi gây lệch (không cộng dồn) — DB riêng')
{
  const { c: N, pre121 } = await freshCms()
  const evalIds = async () => failedIds(T.evaluateCmsVerify(await N.postInput('121', pre121)))
  ok((await evalIds()).length === 0, 'đối chứng: DB riêng sau dữ liệu mẫu POST 121 đạt hết')
  const sig = async (name) => (await L.one(N.db, `SELECT oid::regprocedure::text s FROM pg_proc WHERE proname = $1`, [name])).s.replace(/^public\./, '')
  const pol = async (t) => (await L.one(N.db, `SELECT policyname p FROM pg_policies WHERE tablename = $1`, [t])).p
  await N.db.exec(`CREATE ROLE cms_acl_probe NOLOGIN`)
  // Thiết lập isolation ở role KHÔNG liên quan ⇒ không đỏ oan (vòng 2 §2).
  await N.db.exec(`ALTER ROLE cms_acl_probe SET default_transaction_isolation = 'serializable'`)
  ok(!(await evalIds()).includes('isolation'), 'isolation đè ở role không liên quan RPC ⇒ không đỏ oan')
  const cases = [
    ['ACL120', `GRANT EXECUTE ON FUNCTION public.rpc_cms_sync_run_open(text, jsonb) TO cms_acl_probe`, 'acl-preexisting-functions'],
    ['D1', `GRANT TRIGGER, REFERENCES ON public.cms_qa_access TO authenticated`, 'table:cms_qa_access'],
    ['J1', `GRANT SELECT (id) ON public.cms_sync_runs TO authenticated`, 'table:cms_sync_runs'],
    ['K1', `REVOKE INSERT ON public.cms_programs FROM service_role`, 'table:cms_programs'],
    ['F1', `GRANT EXECUTE ON FUNCTION public.${await sig('rpc_cms_program_save')} TO cms_acl_probe`, 'fn-acl:rpc_cms_program_save'],
    ['E1', `ALTER FUNCTION public.${await sig('cms__conflicts')} SECURITY INVOKER`, 'fn-secdef:cms__conflicts'],
    ['G1a', `ALTER FUNCTION public.${await sig('rpc_cms_import_commit')} RESET lock_timeout`, 'fn-config:rpc_cms_import_commit'],
    ['G1b', `ALTER FUNCTION public.cms_has_qa_access() SET search_path = pg_temp, public`, 'fn-config:cms_has_qa_access'],
    ['L1', `ALTER FUNCTION public.cms_readable_program_ids() OWNER TO cms_acl_probe`, 'fn-owner:cms_readable_program_ids'],
    ['C2a', `ALTER POLICY ${await pol('cms_program_tiers')} ON public.cms_program_tiers USING (program_id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]) OR true)`, 'policy-qual:cms_program_tiers'],
    ['C2b', `ALTER POLICY ${await pol('cms_import_runs')} ON public.cms_import_runs USING ((SELECT public.is_super_admin()) OR program_id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]))`, 'policy-qual:cms_import_runs'],
    ['TRG', `ALTER TABLE public.cms_qa_access DISABLE TRIGGER cms_qa_access_stamp`, 'triggers'],
    ['V5', `ALTER ROLE authenticated BYPASSRLS`, 'roles'],
    ['V7', `ALTER ROLE service_role SET default_transaction_isolation = 'serializable'`, 'isolation'],
    ['OLD', `GRANT EXECUTE ON FUNCTION public.is_super_admin() TO cms_acl_probe`, 'acl-old-functions'],
    ['EXTRA', `CREATE FUNCTION public.cms_extra_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`, 'fn-set'],
    // db-reviewer vòng 3 P2-A: chạy nhầm bản migration cũ / sửa tay — thân hàm, kiểu trigger, ràng buộc, index.
    ['FP-trg', `DROP TRIGGER cms_programs_guard ON public.cms_programs;
      CREATE TRIGGER cms_programs_guard BEFORE INSERT ON public.cms_programs FOR EACH ROW EXECUTE FUNCTION public.cms__programs_guard()`, 'triggers'],
    ['FP-stamp', `CREATE OR REPLACE FUNCTION public.cms__qa_access_stamp() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$ BEGIN RETURN NEW; END; $$`,
      'fn-src:cms__qa_access_stamp'],
    ['FP-helper', `CREATE OR REPLACE FUNCTION public.cms_readable_program_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}'::uuid[]) FROM public.cms_programs p WHERE NOT p.is_test $$`, 'fn-src:cms_readable_program_ids'],
    ['FP-check', `ALTER TABLE public.cms_qa_access DROP CONSTRAINT cms_qa_access_ttl`, 'table-shape:cms_qa_access'],
    ['FP-index', `DROP INDEX public.cms_sync_runs_kind_idx`, 'table-shape:cms_sync_runs'],
  ]
  // TRG tắt trigger ⇒ khôi phục ngay sau khi khẳng định, để FP-trg (đổi kiểu trigger) kiểm được độc lập.
  const restore = { TRG: `ALTER TABLE public.cms_qa_access ENABLE TRIGGER cms_qa_access_stamp` }
  for (const [id, sql, want] of cases) {
    const before = await evalIds()
    await N.db.exec(sql)
    const after = await evalIds()
    ok(!before.includes(want) && after.includes(want), `${id}: ${sql.slice(0, 70)}… ⇒ đỏ ${want} (trước đó chưa đỏ)`, JSON.stringify({ before, after }))
    if (restore[id]) await N.db.exec(restore[id])
  }
}
} // BASE §1–§9

// ── Phase 122 (PM 03/11 §5) ──────────────────────────────────────────────────
/** Thay chuỗi trong định nghĩa hàm — mẫu không khớp ⇒ ném (không để đột biến thành no-op âm thầm). */
const must = (def, from, to) => { if (!def.includes(from)) throw new Error(`đột biến: mẫu không khớp — ${from.slice(0, 60)}`); return def.split(from).join(to) }
/** Run sales ĐÃ CÔNG BỐ hợp lệ (đúng ràng buộc 122 + trigger pointer) với dòng kết quả cho các dược sĩ — dựng tay bằng superuser. */
async function publishRun(db, programId, ppId, productId, rows) {
  const p = await L.one(db, `SELECT config_version, is_test FROM public.cms_programs WHERE id = $1`, [programId])
  const run = (await L.one(db, `INSERT INTO public.cms_sync_runs (kind, status, program_id, config_version, is_test, mapping_fp, seal_expect, seal_step,
      sealed_at, published_at, amount_vnd, finished_at) VALUES ('sales', 'ok', $1, $2, $3, md5('fp'), '{}'::jsonb, 10, now(), now(), $4, now())
      RETURNING id::text AS id`, [programId, p.config_version, p.is_test, rows.length * 1000])).id
  let seq = 0
  for (const [user, store] of rows) {
    await db.query(`INSERT INTO public.cms_results (run_id, program_id, program_product_id, product_id, user_id, store_id, gmv_basis, base_quantity, per_unit,
        cms_quantity, rewarded_quantity, cap_quantity, at_cap, gmv_amount, gate_gmv, target_gmv, gate_met, gate_met_at, potential_amount, amount_vnd, line_count)
      VALUES ($1, $2, $3, $4, $5, $6, 'none', 1, 1, 1, 1, NULL, false, 1000, NULL, NULL, true, NULL, 1000, 1000, 2)`, [run, programId, ppId, productId, user, store])
    for (let k = 0; k < 2; k++) {
      const ol = `OL-${run.slice(0, 8)}-${seq}`
      await db.query(`INSERT INTO public.cms_sales_lines (run_id, program_id, order_line_id, seq, order_id, order_code, product_id, program_product_id,
          seller_email, user_id, store_id, completed_at, source_updated_at, base_quantity, gmv_amount, disposition)
        VALUES ($1, $2, $3, $4, $3, $3, $5, $6, 'qa@example.invalid', $7, $8, now(), now(), 0.5, 500, 'INCLUDED')`, [run, programId, ol, seq, productId, ppId, user, store])
      await db.query(`INSERT INTO public.cms_result_lines (run_id, program_id, order_line_id, seq, user_id, program_product_id, base_before, base_after,
          qty_before, qty_after, amount_vnd, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [run, programId, ol, seq, user, ppId, k * 0.5, (k + 1) * 0.5, 0, k, k * 1000, k === 0 ? 'ACCUMULATING' : 'RECORDED'])
      seq++
    }
  }
  if (rows.length) await db.query(`INSERT INTO public.cms_result_catalog (run_id, program_id, user_id, store_id, catalog_gmv, target_gmv, met, met_at, line_count)
      VALUES ($1, $2, $3, $4, 1000, 5000, false, NULL, 2)`, [run, programId, rows[0][0], rows[0][1]])
  await db.query(`UPDATE public.cms_programs SET current_result_run_id = $1 WHERE id = $2`, [run, programId])
  return run
}
/** Nền 120 → 121 → (PRE122) → 122 + dữ liệu mẫu (chương trình thật / QA / nhà thuốc 2) và kết quả đã công bố. */
async function fresh122({ results = true } = {}) {
  const { c, pre121 } = await freshCms()
  await sleep(15)
  const pre122 = (await c.ro(T.cmsVerifyAclSql()))[0]
  await sleep(15)
  await c.db.exec(SQL_122)
  if (results) {
    // Chương trình thật store 1: A, B (store 1) + C (store 2 — đã chuyển / bán chéo; QLCH store 1 không thấy, SM thấy).
    await publishRun(c.db, P.real, uid(7101), '900001', [[U.A, storeId(1)], [U.B, storeId(1)], [U.C, storeId(1)]])
    await publishRun(c.db, P.test, uid(7102), '900002', [[U.A, storeId(1)]])
    await publishRun(c.db, P.s2, uid(7103), '900003', [[U.D, storeId(2)]])
  }
  return { c, pre121, pre122 }
}

if (BASE) { // §10–§12
section('10. VERIFY POST 122 — bộ kỳ vọng riêng; phase sai / PRE sai thứ tự ⇒ đỏ rõ (không xanh giả)')
{
  const { c: N, pre121, pre122 } = await fresh122()
  ok(pre122.n_all - pre122.n_old === 14, 'PRE 122: đúng 14 hàm cms (120 + 121) trước 122')
  const post = T.evaluateCmsVerify(await N.postInput('122', pre122))
  ok(failed(post).length === 0 && post.length >= 200, `POST 122: ${post.length} mục đạt hết (37 hàm, 13 bảng, 3 trigger, UNIQUE, FK pointer, cổng Q-206)`, JSON.stringify(failed(post)))
  for (const id of ['phase-match', 'marker-122', 'index-tiers-unique', 'pointer-fk', 'release-gate-closed', 'inv122-pointer', 'fn-src:rpc_cms_result_rows', 'fn-config:rpc_cms_sales_run_seal_step', 'table:cms_results', 'table-shape:cms_programs']) {
    ok(post.some((x) => x.id === id && x.ok), `POST 122 có mục ${id} đạt`)
  }
  const as121 = T.evaluateCmsVerify(await N.postInput('121', pre121))
  ok(failedIds(as121).includes('phase-match') && /PHASE KHÔNG PHÙ HỢP: DB có marker CMS cao nhất 122/.test(as121.find((x) => x.id === 'phase-match').detail)
    && failedIds(as121).includes('fn-set') && failedIds(as121).includes('marker-122-absent'),
  'checker 121 trên DB đã 122 ⇒ đỏ phase-match (lời rõ) + fn-set + marker — không thành bằng chứng POST 122', JSON.stringify(failedIds(as121).slice(0, 8)))
  ok(failedIds(T.evaluateCmsVerify(await N.postInput('122', pre121))).includes('pre-order'), 'PRE của 121 dùng cho 122 ⇒ đỏ pre-order')
  const late = (await N.ro(T.cmsVerifyAclSql()))[0]
  ok(failedIds(T.evaluateCmsVerify(await N.postInput('122', late))).includes('pre-order'), 'PRE chụp SAU khi chạy 122 ⇒ đỏ pre-order')
  await N.db.close() // giải phóng bộ nhớ WASM (nhiều DB PGlite trong một tiến trình)
}
{
  // DB mới ở 121 mà khai --phase=122: truy vấn 122 không chạy được (CLI rc 1); bộ đánh giá vẫn đỏ phase-match / fn-set / bảng.
  const { c: N, pre121 } = await freshCms()
  const input = await N.postInput('122', pre121, { tolerant: true })
  const ids = failedIds(T.evaluateCmsVerify(input))
  ok(ids.includes('phase-match') && ids.includes('fn-set') && ids.includes('tables') && ids.includes('release-gate-closed') && ids.includes('index-tiers-unique'),
    'khai --phase=122 trên DB 121 ⇒ đỏ phase-match + thiếu hàm / bảng / UNIQUE / cổng', JSON.stringify(ids.slice(0, 10)))
  await N.db.close() // giải phóng bộ nhớ WASM (nhiều DB PGlite trong một tiến trình)
}

section('11. V8 phase 122 — gọi THẬT 4 RPC đọc dưới phiên authenticated; tập dòng kết quả = oracle phạm vi hiện tại')
{
  const { c: N } = await fresh122()
  await N.wr(T.cmsQaGrantSql([U.A], 2))
  let r = await N.v8(U.A, 'staff', { phase: '122', qa: true, readable: 2 })
  ok(failed(r.checks).length === 0 && r.row.rx_seen_n === 2 && r.row.rx_total_n === 4 && r.row.rpc_callable === T.CMS_V8_RPC_CALLABLE['122'],
    'staff A + marker: header 2 chương trình đọc được, dòng kết quả = của chính A (thật + QA), 4 RPC đọc gọi được', JSON.stringify(failed(r.checks)))
  ok(r.checks.find((x) => x.id === 'v8-table:results')?.proven === true, 'staff A: phạm vi dòng kết quả được CHỨNG MINH cắt (tổng 4 > thấy 2)')
  ok(r.row.rx_lseen_n === 4 && r.row.rx_ltotal_n === 8 && r.checks.find((x) => x.id === 'v8-table:result_lines')?.proven === true
    && r.checks.find((x) => x.id === 'v8-result-lines-user')?.proven === true && r.row.rx_role === 'authenticated',
  'staff A: rpc_cms_result_lines phân trang đủ 4 / 8 dòng đơn của chính A; p_user_id ngoài phạm vi bị chặn (đã chứng minh); khối RPC chạy bằng authenticated', JSON.stringify({ l: r.row.rx_lseen_n, t: r.row.rx_ltotal_n, role: r.row.rx_role }))
  ok(r.checks.find((x) => x.id === 'v8-result-excluded')?.proven === true && r.checks.find((x) => x.id === 'v8-result-rpc')?.proven === true,
    'staff A: excluded đã thực sự gọi (FORBIDDEN) và có chương trình ngoài tập ⇒ hai mục được CHỨNG MINH')
  r = await N.v8(U.qlch1, 'qlch', { phase: '122' })
  ok(failed(r.checks).length === 0 && r.row.rx_seen_n === 2, 'QLCH store 1: chỉ A, B (staff HIỆN thuộc store 1) — không C dù bán tại store 1', JSON.stringify(failed(r.checks)))
  r = await N.v8(U.sm, 'sm', { phase: '122' })
  ok(failed(r.checks).length === 0 && r.row.rx_seen_n === 4, 'SM store 1 + 2: A, B, C (chương trình thật) + D (store 2); QA không marker không đọc', JSON.stringify(failed(r.checks)))
  r = await N.v8(U.super, 'super', { phase: '122', qa: false })
  ok(failed(r.checks).length === 0 && r.row.rx_seen_n === 4 && r.checks.find((x) => x.id === 'v8-table:results')?.proven === false,
    'super không marker: 4 dòng thật, không QA; tổng = thấy ⇒ CHƯA chứng minh cắt (không ĐẠT oan)', JSON.stringify(failed(r.checks)))
  r = await N.v8(U.super, 'super', { phase: '122', requireProven: ['results'] })
  ok(failedIds(r.checks).includes('v8-require-proven:results'), '--require-proven=results với super thấy hết ⇒ đỏ')
  r = await N.v8(U.mkt, 'admin', { phase: '122', readable: 0 })
  ok(failed(r.checks).length === 0 && r.row.rx_seen_n === 0, 'admin thường: 0 chương trình, header mọi chương trình FORBIDDEN', JSON.stringify(failed(r.checks)))
  r = await N.v8(U.A, 'staff', { phase: '121' })
  ok(failedIds(r.checks).includes('v8-phase') && failedIds(r.checks).includes('v8-private') && /PHASE KHÔNG PHÙ HỢP: DB phase 122/.test(r.checks.find((x) => x.id === 'v8-phase').detail),
    'V8 khai phase 121 trên DB 122 ⇒ đỏ v8-phase (lời rõ) + v8-private (RPC 122 gọi được)', JSON.stringify(failedIds(r.checks)))
  r = await N.v8(U.A, 'staff', {})
  ok(failedIds(r.checks).includes('v8-phase') && /không khai --phase/.test(r.checks.find((x) => x.id === 'v8-phase').detail),
    'V8 KHÔNG khai --phase trên DB 122 ⇒ đỏ v8-phase (lệnh runbook P1 cũ không thành xanh giả sau 122)', JSON.stringify(failedIds(r.checks)))
  await N.db.close() // giải phóng bộ nhớ WASM (nhiều DB PGlite trong một tiến trình)
}
{
  const { c: N } = await fresh122({ results: false })
  const r = await N.v8(U.A, 'staff', { phase: '122', requireProven: ['results', 'programs'] })
  ok(failedIds(r.checks).includes('v8-require-proven:results') && !failedIds(r.checks).includes('v8-require-proven:programs') && r.row.rx_total_n === 0,
    '--require-proven=results trên bảng kết quả RỖNG ⇒ đỏ (không xanh khi 0 = 0)', JSON.stringify(failedIds(r.checks)))
  await N.db.close() // giải phóng bộ nhớ WASM (nhiều DB PGlite trong một tiến trình)
}

{
  const { c: N } = await freshCms()
  let r = await N.v8(U.A, 'staff', { phase: '121' })
  ok(failed(r.checks).length === 0 && r.row.db_phase === '121', 'V8 khai --phase=121 trên DB 121 ⇒ đạt (db_phase 121)', JSON.stringify(failed(r.checks)))
  r = await N.v8(U.A, 'staff', { phase: '120' })
  ok(failedIds(r.checks).includes('v8-phase'), 'V8 khai --phase=120 trên DB 121 ⇒ đỏ v8-phase')
  await N.db.close() // giải phóng bộ nhớ WASM (nhiều DB PGlite trong một tiến trình)
}

{
  // Phân trang thật: 600 dòng đơn thêm của A trong chương trình thật ⇒ rpc_cms_result_lines cần 2 trang (500 + …) — V8 phải gom đủ.
  const { c: N } = await fresh122()
  await N.db.exec(`WITH r AS (SELECT current_result_run_id AS run FROM public.cms_programs WHERE id = '${P.real}'),
    s AS (INSERT INTO public.cms_sales_lines (run_id, program_id, order_line_id, seq, order_id, order_code, product_id, program_product_id,
            seller_email, user_id, store_id, completed_at, source_updated_at, base_quantity, gmv_amount, disposition)
          SELECT r.run, '${P.real}', 'PG-' || g, 1000 + g, 'PG-' || g, 'PG-' || g, '900001', '${uid(7101)}', 'qa@example.invalid',
                 '${U.A}', '${storeId(1)}', now(), now(), 0.5, 500, 'INCLUDED' FROM r, generate_series(1, 600) g RETURNING run_id, order_line_id, seq)
    INSERT INTO public.cms_result_lines (run_id, program_id, order_line_id, seq, user_id, program_product_id, base_before, base_after, qty_before, qty_after, amount_vnd, status)
      SELECT run_id, '${P.real}', order_line_id, seq, '${U.A}', '${uid(7101)}', 0, 0.5, 0, 0, 0, 'ACCUMULATING' FROM s`)
  const r = await N.v8(U.A, 'staff', { phase: '122' })
  ok(failed(r.checks).length === 0 && r.row.rx_lseen_n === 602 && r.row.rx_lexp_n === 602, 'PAGING: 602 dòng đơn của A ở chương trình thật (không marker; 2 trang 500) gom đủ, tập = oracle', JSON.stringify({ seen: r.row.rx_lseen_n, exp: r.row.rx_lexp_n, f: failed(r.checks) }))
  await N.db.close()
}

section('12. Bắt lệch sau 122 (PM §5) — mỗi ca khẳng định mục CHƯA đỏ trước khi gây lệch; DB riêng mỗi nhóm')
{
  const { c: N, pre122 } = await fresh122()
  const evalIds = async () => failedIds(T.evaluateCmsVerify(await N.postInput('122', pre122)))
  ok((await evalIds()).length === 0, 'đối chứng: POST 122 đạt hết trước khi gây lệch')
  const sig = async (name) => (await L.one(N.db, `SELECT oid::regprocedure::text s FROM pg_proc WHERE proname = $1`, [name])).s.replace(/^public\./, '')
  const src = async (name) => (await L.one(N.db, `SELECT pg_get_functiondef(oid) d FROM pg_proc WHERE proname = $1`, [name])).d
  const hdr = must(await src('rpc_cms_result_header'), "'program_id', p_program_id,", "'program_id', p_program_id, 'probe', 1,")
  const cases = [
    ['ANON', `GRANT EXECUTE ON FUNCTION public.${await sig('rpc_cms_result_rows')} TO anon`, 'fn-exec:rpc_cms_result_rows'],
    ['AUTH-SALES', `GRANT EXECUTE ON FUNCTION public.${await sig('rpc_cms_sales_run_publish')} TO authenticated`, 'fn-acl:rpc_cms_sales_run_publish'],
    ['HELPER', `GRANT EXECUTE ON FUNCTION public.cms__visible_result_users() TO authenticated`, 'fn-acl:cms__visible_result_users'],
    ['NESTLOOP', `ALTER FUNCTION public.${await sig('rpc_cms_sales_run_seal_step')} RESET enable_nestloop`, 'fn-config:rpc_cms_sales_run_seal_step'],
    ['BODY', hdr, 'fn-src:rpc_cms_result_header'],
    ['GATE', `CREATE OR REPLACE FUNCTION public.cms__results_release_open() RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$ SELECT true $$`, 'release-gate-closed'],
    ['TBL', `GRANT SELECT ON public.cms_results TO authenticated`, 'table:cms_results'],
    ['COL', `GRANT SELECT (user_id) ON public.cms_sales_lines TO authenticated`, 'table:cms_sales_lines'],
    ['TRG', `ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard`, 'triggers'],
    ['UNIQ', `DROP INDEX public.cms_program_tiers_product_from_idx; CREATE INDEX cms_program_tiers_product_from_idx ON public.cms_program_tiers (program_product_id, qty_from)`, 'index-tiers-unique'],
    ['UNIQ-PART', `DROP INDEX public.cms_program_tiers_product_from_idx; CREATE UNIQUE INDEX cms_program_tiers_product_from_idx ON public.cms_program_tiers (program_product_id, qty_from) WHERE qty_from > 0`, 'index-tiers-unique'],
    ['UNIQ-ORDER', `DROP INDEX public.cms_program_tiers_product_from_idx; CREATE UNIQUE INDEX cms_program_tiers_product_from_idx ON public.cms_program_tiers (qty_from, program_product_id)`, 'index-tiers-unique'],
    ['FK', `ALTER TABLE public.cms_programs DROP CONSTRAINT cms_programs_result_run_fk`, 'pointer-fk'],
    ['POLICY', `CREATE POLICY cms_results_probe ON public.cms_results FOR SELECT TO authenticated USING (true)`, 'policies'],
    // db-reviewer P2-1: giữ nguyên thân nhưng đổi DEFAULT tham số; bỏ NOT NULL (CHECK vẫn qua với NULL).
    ['DEFAULT', must(await src('rpc_cms_sales_run_cleanup'), 'p_max_rows integer DEFAULT 50000', 'p_max_rows integer DEFAULT 5000000'), 'fn-def:rpc_cms_sales_run_cleanup'],
    ['NOTNULL', `ALTER TABLE public.cms_results ALTER COLUMN amount_vnd DROP NOT NULL`, 'table-cols:cms_results'],
  ]
  const restore = {
    TRG: `ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard`,
    UNIQ: `DROP INDEX public.cms_program_tiers_product_from_idx; CREATE UNIQUE INDEX cms_program_tiers_product_from_idx ON public.cms_program_tiers (program_product_id, qty_from)`,
    'UNIQ-PART': `DROP INDEX public.cms_program_tiers_product_from_idx; CREATE UNIQUE INDEX cms_program_tiers_product_from_idx ON public.cms_program_tiers (program_product_id, qty_from)`,
  }
  for (const [id, sql, want] of cases) {
    const before = await evalIds()
    await N.db.exec(sql)
    const after = await evalIds()
    ok(!before.includes(want) && after.includes(want), `${id}: ${sql.replace(/\s+/g, ' ').slice(0, 70)}… ⇒ đỏ ${want} (trước đó chưa đỏ)`, JSON.stringify({ before, after }))
    if (restore[id]) await N.db.exec(restore[id])
  }
  await N.db.close() // giải phóng bộ nhớ WASM (nhiều DB PGlite trong một tiến trình)
}
{
  // Pointer trỏ run đã dọn (sửa tay khi tắt trigger) ⇒ inv122-pointer đỏ.
  const { c: N, pre122 } = await fresh122()
  const before = failedIds(T.evaluateCmsVerify(await N.postInput('122', pre122)))
  await N.db.exec(`UPDATE public.cms_sync_runs SET purged_at = now() WHERE id = (SELECT current_result_run_id FROM public.cms_programs WHERE id = '${P.real}')`)
  const after = failedIds(T.evaluateCmsVerify(await N.postInput('122', pre122)))
  ok(!before.includes('inv122-pointer') && after.includes('inv122-pointer'), 'pointer trỏ run đã dọn ⇒ đỏ inv122-pointer (trước đó chưa đỏ)', JSON.stringify(after))
  await N.db.close() // giải phóng bộ nhớ WASM (nhiều DB PGlite trong một tiến trình)
}
{
  // Sai namespace / quyền đọc ở RPC 122 — V8 phải bắt dù POST vân tay cũng đỏ (hai lớp).
  let prev = null
  const mk = async () => { if (prev) await prev.db.close(); const { c: N } = await fresh122(); prev = N; return N }
  let N = await mk()
  let v = await N.v8(U.B, 'staff', { phase: '122' })
  ok(failed(v.checks).length === 0, 'đối chứng V8: staff B không marker đạt')
  await N.db.exec(must((await L.one(N.db, `SELECT pg_get_functiondef('public.cms__result_run(uuid, uuid)'::regprocedure) d`)).d,
    'IF auth.uid() IS NULL OR p_program_id IS NULL OR NOT (p_program_id = ANY (public.cms_readable_program_ids())) THEN', 'IF auth.uid() IS NULL OR p_program_id IS NULL THEN'))
  v = await N.v8(U.B, 'staff', { phase: '122' })
  ok(failedIds(v.checks).includes('v8-result-rpc'), 'NAMESPACE: bỏ kiểm chương trình đọc được ⇒ staff đọc header QA / nhà thuốc khác ⇒ đỏ v8-result-rpc', JSON.stringify(failed(v.checks)))
  N = await mk()
  await N.db.exec(`CREATE OR REPLACE FUNCTION public.cms__visible_result_users() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT NULL::uuid[] $$`)
  v = await N.v8(U.B, 'staff', { phase: '122' })
  ok(failedIds(v.checks).includes('v8-table:results') && !failedIds(v.checks).includes('v8-result-rpc'), 'SCOPE: staff thấy dòng của mọi người (cùng số chương trình) ⇒ đỏ v8-table:results', JSON.stringify(failed(v.checks)))
  N = await mk()
  // Tập LỆCH nhưng CÙNG SỐ: staff B nhận dòng của A (1 dòng) thay vì của mình (1 dòng) — chỉ đếm sẽ xanh oan.
  await N.db.exec(`CREATE OR REPLACE FUNCTION public.cms__visible_result_users() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT ARRAY['${U.A}'::uuid] $$`)
  v = await N.v8(U.B, 'staff', { phase: '122' })
  ok(v.row.rx_seen_n === v.row.rx_exp_n && v.row.rx_same_set === false && failedIds(v.checks).includes('v8-table:results'),
    'SCOPE-SWAP: tập dòng khác nhưng cùng số đếm ⇒ vẫn đỏ v8-table:results (so TẬP, không chỉ đếm)', JSON.stringify({ seen: v.row.rx_seen_n, exp: v.row.rx_exp_n, f: failedIds(v.checks) }))
  N = await mk()
  // Chặn nhầm: RPC từ chối cả chương trình người xem đọc được.
  await N.db.exec(must((await L.one(N.db, `SELECT pg_get_functiondef('public.cms__result_run(uuid, uuid)'::regprocedure) d`)).d,
    'IF auth.uid() IS NULL OR p_program_id IS NULL OR NOT (p_program_id = ANY (public.cms_readable_program_ids())) THEN', 'IF true THEN'))
  v = await N.v8(U.B, 'staff', { phase: '122' })
  ok(failedIds(v.checks).includes('v8-result-rpc') && v.row.rx_deny === 1 && v.row.rx_leak === 0, 'DENY: RPC chặn chương trình người xem đọc được ⇒ đỏ v8-result-rpc (đếm chặn sai)', JSON.stringify({ deny: v.row.rx_deny, f: failedIds(v.checks) }))
  N = await mk()
  await N.db.exec(must((await L.one(N.db, `SELECT pg_get_functiondef('public.rpc_cms_result_excluded(uuid, uuid, integer, integer)'::regprocedure) d`)).d,
    "IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'CMS_RESULT_FORBIDDEN' USING ERRCODE = '42501'; END IF;", ''))
  v = await N.v8(U.B, 'staff', { phase: '122' })
  ok(failedIds(v.checks).includes('v8-result-excluded'), 'EXCLUDED: bỏ kiểm super ⇒ staff đọc email nguồn ⇒ đỏ v8-result-excluded', JSON.stringify(failed(v.checks)))
  N = await mk()
  // db-reviewer P1: rpc_cms_result_lines bỏ lọc người xem ⇒ staff thấy dòng đơn của người khác.
  await N.db.exec(must((await L.one(N.db, `SELECT pg_get_functiondef('public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)'::regprocedure) d`)).d,
    'AND (v_users IS NULL OR rl.user_id = ANY (v_users))', ''))
  v = await N.v8(U.B, 'staff', { phase: '122' })
  ok(failedIds(v.checks).includes('v8-table:result_lines') && !failedIds(v.checks).includes('v8-table:results'), 'LINES-SCOPE: lines bỏ lọc người xem ⇒ đỏ v8-table:result_lines', JSON.stringify(failed(v.checks)))
  N = await mk()
  await N.db.exec(must((await L.one(N.db, `SELECT pg_get_functiondef('public.rpc_cms_result_lines(uuid, uuid, uuid, uuid, integer, integer)'::regprocedure) d`)).d,
    'IF p_user_id IS NOT NULL AND v_users IS NOT NULL AND NOT (p_user_id = ANY (v_users)) THEN', 'IF false THEN'))
  v = await N.v8(U.B, 'staff', { phase: '122' })
  ok(failedIds(v.checks).includes('v8-result-lines-user'), 'LINES-USER: bỏ kiểm p_user_id ngoài phạm vi ⇒ đỏ v8-result-lines-user', JSON.stringify(failed(v.checks)))
  N = await mk()
  // db-reviewer P2-3: mảng users của rows không lọc phạm vi (tên người ngoài phạm vi) — tập results vẫn đúng.
  await N.db.exec(must((await L.one(N.db, `SELECT pg_get_functiondef('public.rpc_cms_result_rows(uuid, uuid)'::regprocedure) d`)).d,
    `FROM public.users u WHERE u.id IN (SELECT r.user_id FROM public.cms_results r
                                          WHERE r.run_id = v_run AND (v_users IS NULL OR r.user_id = ANY (v_users)))`,
    `FROM public.users u WHERE u.id IN (SELECT r.user_id FROM public.cms_results r
                                          WHERE r.run_id = v_run)`))
  v = await N.v8(U.B, 'staff', { phase: '122' })
  ok(failedIds(v.checks).includes('v8-result-shape') && !failedIds(v.checks).includes('v8-table:results'), 'USERS: mảng users không lọc phạm vi ⇒ đỏ v8-result-shape', JSON.stringify(failed(v.checks)))
  N = await mk()
  await N.db.exec(`GRANT SELECT ON public.cms_sales_lines TO authenticated`)
  v = await N.v8(U.B, 'staff', { phase: '122' })
  ok(failedIds(v.checks).includes('v8-private'), 'PRIVATE: authenticated đọc được cms_sales_lines ⇒ đỏ v8-private', JSON.stringify(failed(v.checks)))
  await prev.db.close()
}
} // BASE §10–§12

// ── Phase 123 (P3a chốt kỳ — VERIFY V0–V8 của migration 123) ─────────────────
/**
 * Chốt TRỰC TIẾP bằng owner (ranh giới tin cậy của 123: guard chỉ-owner cho owner qua; đường thật rpc_cms_program_lock cần run
 * seal thật + hết kỳ — đã QA ở scripts/qa-cms-123.mjs). Ghi payout + payout_staff KHỚP run hiện hành (đúng bất biến V5) rồi
 * 'locked'. Chỉ để VERIFY có dữ liệu đọc; chương trình thật dùng cơ sở 'bi_watermark' (CHECK cms_payouts_qa_basis).
 */
async function lockDirect(db, programId) {
  // Run dựng tay ở §10 để seal_expect = '{}' — đặt như run qua seal_begin thật (khoá 122: sales_lines / results / catalog /
  // result_lines = số dòng thật) để mục v5-run-frozen đo được; đặt TRƯỚC payout (sau payout run bị đóng băng).
  await db.query(`UPDATE public.cms_sync_runs r SET seal_expect = jsonb_build_object(
      'sales_lines', (SELECT count(*) FROM public.cms_sales_lines l WHERE l.run_id = r.id), 'results', (SELECT count(*) FROM public.cms_results l WHERE l.run_id = r.id),
      'catalog', (SELECT count(*) FROM public.cms_result_catalog l WHERE l.run_id = r.id), 'result_lines', (SELECT count(*) FROM public.cms_result_lines l WHERE l.run_id = r.id))
    WHERE r.id = (SELECT current_result_run_id FROM public.cms_programs WHERE id = $1)`, [programId])
  await db.query(`INSERT INTO public.cms_payouts (program_id, run_id, config_version, config_fp, mapping_fp, is_test, amount_vnd, staff_rows, staff_paid,
      candidate_lines, candidate_gmv, unassigned_lines, unassigned_gmv, policy, policy_version, ack_reason, run_started_at,
      source_complete_basis, source_complete_through, locked_by)
    SELECT p.id, r.id, r.config_version, public.cms__config_fp(p.id), r.mapping_fp, r.is_test, r.amount_vnd,
           (SELECT count(DISTINCT x.user_id) FROM public.cms_results x WHERE x.run_id = r.id),
           (SELECT count(*) FROM (SELECT x.user_id FROM public.cms_results x WHERE x.run_id = r.id GROUP BY x.user_id HAVING sum(x.amount_vnd) > 0) y),
           (SELECT count(*) FROM public.cms_sales_lines l WHERE l.run_id = r.id AND l.disposition <> 'OUT_OF_SCOPE'),
           (SELECT coalesce(sum(l.gmv_amount), 0) FROM public.cms_sales_lines l WHERE l.run_id = r.id AND l.disposition <> 'OUT_OF_SCOPE' AND l.gmv_amount > 0),
           (SELECT count(*) FROM public.cms_sales_lines l WHERE l.run_id = r.id AND l.disposition = 'UNASSIGNED'),
           (SELECT coalesce(sum(l.gmv_amount), 0) FROM public.cms_sales_lines l WHERE l.run_id = r.id AND l.disposition = 'UNASSIGNED' AND l.gmv_amount > 0),
           public.cms__lock_policy() -> (CASE WHEN r.is_test THEN 'qa' ELSE 'real' END), 1, NULL, r.started_at,
           CASE WHEN r.is_test THEN 'qa_assumption' ELSE 'bi_watermark' END, CASE WHEN r.is_test THEN NULL ELSE DATE '2026-11-30' END, $2
      FROM public.cms_programs p JOIN public.cms_sync_runs r ON r.id = p.current_result_run_id WHERE p.id = $1`, [programId, U.super])
  await db.query(`INSERT INTO public.cms_payout_staff (program_id, user_id, store_id, email_snapshot, name_snapshot, store_name_snapshot, amount_vnd, products_with_cms)
    SELECT $1, a.user_id, a.store_id, u.email, u.full_name, s.name, a.amt::bigint, a.np
      FROM (SELECT x.user_id, (array_agg(DISTINCT x.store_id))[1] AS store_id, sum(x.amount_vnd) AS amt, count(*) FILTER (WHERE x.amount_vnd > 0)::int AS np
              FROM public.cms_results x WHERE x.run_id = (SELECT current_result_run_id FROM public.cms_programs WHERE id = $1) GROUP BY x.user_id) a
      LEFT JOIN public.users u ON u.id = a.user_id LEFT JOIN public.stores s ON s.id = a.store_id`, [programId])
  await db.query(`UPDATE public.cms_programs SET status = 'locked', locked_at = now(), locked_by = $2 WHERE id = $1`, [programId, U.super])
}
/** Nền 122 (kết quả đã công bố: thật A, B, C · QA A · nhà thuốc 2 D) → PRE123 → 123 → chốt trực tiếp các chương trình `lock`. */
async function fresh123({ lock = [P.test] } = {}) {
  const { c, pre121, pre122 } = await fresh122()
  await sleep(15)
  const pre123 = (await c.ro(T.cmsVerifyAclSql()))[0]
  await sleep(15)
  await c.db.exec(SQL_123)
  for (const id of lock) await lockDirect(c.db, id)
  return { c, pre121, pre122, pre123 }
}
const fnDef = async (db, name) => (await L.one(db, `SELECT pg_get_functiondef(oid) d FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [name])).d
const fnSig = async (db, name) => (await L.one(db, `SELECT oid::regprocedure::text s FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`, [name])).s.replace(/^public\./, '')

if (P123) {
section('13. VERIFY POST 123 — bộ kỳ vọng riêng (V0–V7); chưa có payout ⇒ V5 CHƯA; phase / PRE sai ⇒ đỏ rõ')
{
  const { c: N, pre121, pre122, pre123 } = await fresh123({ lock: [] })
  ok(pre123.n_all - pre123.n_old === 37 && Number.isInteger(pre123.n_ex123) && T.cmsFnCountBefore('123') === 37,
    'PRE 123: đúng 37 hàm cms (120 + 121 + 122) ngay trước 123; ảnh có n_ex123 / md5_ex123')
  let post = T.evaluateCmsVerify(await N.postInput('123', pre123))
  const v5 = () => post.find((x) => x.id === 'v5-payout-invariants')
  ok(failed(post).length === 0 && v5()?.proven === false && /CHƯA CHỨNG MINH/.test(v5()?.detail ?? ''),
    `POST 123 trước khi có payout: ${post.length} mục không lệch; V5 = CHƯA CHỨNG MINH (không xanh rỗng)`, JSON.stringify(failed(post)))
  ok(['v5-payout-staff', 'v5-run-frozen'].every((id) => post.find((x) => x.id === id)?.proven === false)
    && post.find((x) => x.id === 'lock-preview-blocked')?.proven === true && /3 chương trình thật · thiếu chặn [^0-9]*0/.test(post.find((x) => x.id === 'lock-preview-blocked')?.detail ?? ''),
  'trước payout: V5 từng dược sĩ / run đóng băng = CHƯA; V8 migration — 3 chương trình thật đều bị chặn chốt (đã chứng minh)', JSON.stringify(post.filter((x) => /v5-|lock-preview/.test(x.id))))
  const rq0 = T.evaluateCmsVerify(await N.postInput('123', pre123, { requireProven: ['v5'] }))
  ok(failedIds(rq0).join() === 'require-proven:v5', '--require-proven=v5 khi chưa có payout ⇒ CHỈ require-proven:v5 đỏ (CLI rc 1)', JSON.stringify(failedIds(rq0)))
  await lockDirect(N.db, P.test)
  post = T.evaluateCmsVerify(await N.postInput('123', pre123))
  ok(failed(post).length === 0 && post.length >= 400 && v5()?.proven === true && /1 payout \(QA 1\) · lệch 0/.test(v5()?.detail ?? ''),
    `POST 123 sau chốt QA: ${post.length} mục đạt hết (55 hàm, 15 bảng, 49 trigger, V0 / V3 / V4 / V5 / V6 / V7), V5 đã chứng minh`, JSON.stringify(failed(post)))
  for (const id of ['phase-match', 'marker-123', 'max-numeric', 'pre-order', 'fn-set', 'v0-owner', 'v7-isolation-123', 'isolation', 'triggers', 'trigger-fns',
    'v4-lock-policy', 'release-gate-closed', 'v3-payout-acl', 'v3-truncate-revoked', 'v6-locked-without-payout', 'acl-preexisting-functions', 'acl-old-functions',
    'fn-src:cms_readable_program_ids', 'fn-config:rpc_cms_program_lock', 'fn-secdef:cms__run_auth_guard', 'fn-acl:rpc_cms_payout', 'fn-exec:rpc_cms_lock_preview',
    'fn-def:rpc_cms_program_lock', 'table:cms_payouts', 'table:cms_sales_lines', 'table:cms_qa_access', 'table-shape:cms_payouts', 'table-cols:cms_payout_staff',
    'v5-payout-staff', 'v5-run-frozen', 'v3-payout-colpriv', 'v3-payout-views', 'lock-preview-blocked']) {
    ok(post.some((x) => x.id === id && x.ok), `POST 123 có mục ${id} đạt`)
  }
  ok(['v5-payout-staff', 'v5-run-frozen', 'lock-preview-blocked'].every((id) => post.find((x) => x.id === id)?.proven === true), 'sau chốt QA: V5 từng dược sĩ / run đóng băng / V8 migration đã chứng minh')
  const rq1 = T.evaluateCmsVerify(await N.postInput('123', pre123, { requireProven: ['v5', 'lock-preview'] }))
  ok(failed(rq1).length === 0 && ['require-proven:v5', 'require-proven:lock-preview'].every((id) => rq1.some((x) => x.id === id && x.ok)),
    '--require-proven=v5,lock-preview sau chốt QA ⇒ đạt', JSON.stringify(failed(rq1)))
  const rqBad = T.evaluateCmsVerify(await N.postInput('123', pre123, { requireProven: ['results'] }))
  ok(failedIds(rqBad).join() === 'require-proven:results', 'khoá --require-proven không thuộc post 123 ⇒ đỏ (CLI chặn sớm rc 2)')
  ok(['fn-src:', 'fn-acl:', 'fn-exec:', 'fn-secdef:', 'fn-config:', 'fn-owner:', 'fn-def:'].every((p) => post.filter((x) => x.id.startsWith(p)).length === 55)
    && post.filter((x) => x.id.startsWith('table:')).length === 15, 'POST 123: mỗi loại kiểm hàm đủ 55 mục; 15 bảng cms_*')
  for (const [ph, pre] of [['122', pre122], ['121', pre121]]) {
    const as = T.evaluateCmsVerify(await N.postInput(ph, pre))
    ok(failedIds(as).includes('phase-match') && /PHASE KHÔNG PHÙ HỢP: DB có marker CMS cao nhất 123/.test(as.find((x) => x.id === 'phase-match').detail)
      && failedIds(as).includes('marker-123-absent') && failedIds(as).includes('max-numeric') && failedIds(as).includes('fn-set'),
    `checker ${ph} trên DB đã 123 ⇒ đỏ phase-match (lời rõ) + marker-123-absent + max-numeric + fn-set — không thành bằng chứng`, JSON.stringify(failedIds(as).slice(0, 10)))
  }
  ok(failedIds(T.evaluateCmsVerify(await N.postInput('123', pre122))).includes('pre-order'), 'PRE của 122 dùng cho 123 ⇒ đỏ pre-order (CLI chặn sớm hơn: 14 ≠ 37 hàm)')
  const late = (await N.ro(T.cmsVerifyAclSql()))[0]
  ok(failedIds(T.evaluateCmsVerify(await N.postInput('123', late))).includes('pre-order'), 'PRE chụp SAU khi chạy 123 ⇒ đỏ pre-order')
  await N.db.close()
}
{
  // DB ở 122 mà khai --phase=123: truy vấn 123 lỗi (CLI ⇒ LỖI DB, rc 1); bộ đánh giá với dữ liệu thiếu vẫn đỏ, không bao giờ xanh.
  const { c: N, pre122 } = await fresh122()
  let err = ''
  try { await N.ro(T.CMS_VERIFY_SQL.lockPolicy) } catch (e) { err = String(e?.message ?? e); await N.db.exec('ROLLBACK').catch(() => {}) }
  ok(/cms__lock_policy/.test(err), 'truy vấn V4 123 trên DB 122 ⇒ lỗi DB (cms__lock_policy chưa có) — CLI LỖI DB, rc 1', err)
  const ids = failedIds(T.evaluateCmsVerify(await N.postInput('123', pre122, { tolerant: true })))
  ok(['phase-match', 'marker-123', 'max-numeric', 'fn-set', 'tables', 'triggers', 'trigger-fns', 'v4-lock-policy', 'v3-payout-acl', 'v5-payout-invariants',
    'v5-payout-staff', 'v5-run-frozen', 'v3-payout-colpriv', 'v3-payout-views', 'lock-preview-blocked'].every((id) => ids.includes(id)),
    'khai --phase=123 trên DB 122 ⇒ đỏ phase-match + marker + thiếu hàm / bảng / trigger / policy / payout', JSON.stringify(ids.slice(0, 14)))
  const post122 = T.evaluateCmsVerify(await N.postInput('122', pre122))
  ok(failed(post122).length === 0 && post122.some((x) => x.id === 'marker-123-absent' && x.ok),
    `POST 122 trên DB 122 vẫn đạt hết (${post122.length} mục, thêm marker-123-absent) — kỳ vọng 122 không đổi`, JSON.stringify(failed(post122)))
  await N.db.close()
}

section('14. Bắt lệch sau 123 — mỗi ca khẳng định mục CHƯA đỏ trước khi gây lệch; ca dễ lan được khôi phục')
{
  const { c: N, pre123 } = await fresh123()
  const evalIds = async () => failedIds(T.evaluateCmsVerify(await N.postInput('123', pre123)))
  ok((await evalIds()).length === 0, 'đối chứng: POST 123 đạt hết (đã chốt QA) trước khi gây lệch')
  const sigLockEval = await fnSig(N.db, 'cms__lock_eval'), sigLock = await fnSig(N.db, 'rpc_cms_program_lock')
  const always = (t, g) => `ALTER TABLE public.${t} ENABLE ALWAYS TRIGGER ${g}`
  const cases = [
    ['ANON-HELPER', `GRANT EXECUTE ON FUNCTION public.${sigLockEval} TO anon`, 'fn-exec:cms__lock_eval'],
    ['AUTH-LOCK', `GRANT EXECUTE ON FUNCTION public.${sigLock} TO authenticated`, 'fn-acl:rpc_cms_program_lock'],
    ['TRG-DISABLE', `ALTER TABLE public.cms_results DISABLE TRIGGER cms_frozen_ins`, 'triggers'],
    ['TRG-ORIGIN', `ALTER TABLE public.cms_payouts ENABLE TRIGGER cms_payout_immutable`, 'triggers'],
    ['TRG-REPLICA', `ALTER TABLE public.cms_sync_runs ENABLE REPLICA TRIGGER cms_run_auth_guard`, 'triggers'],
    ['TRG-ROW', `DROP TRIGGER cms_frozen_upd ON public.cms_sales_lines;
      CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON public.cms_sales_lines FOR EACH ROW EXECUTE FUNCTION public.cms__frozen_data_upd();
      ALTER TABLE public.cms_sales_lines ENABLE ALWAYS TRIGGER cms_frozen_upd`, 'triggers'],
    ['BODY', must(await fnDef(N.db, 'rpc_cms_payout'), "'policy_version', v_pay.policy_version,", "'policy_version', v_pay.policy_version, 'probe', 1,"), 'fn-src:rpc_cms_payout'],
    ['POLICY', must(await fnDef(N.db, 'cms__lock_policy'), "'ready', false", "'ready', true"), 'v4-lock-policy'],
    ['TRUNCATE', `GRANT TRUNCATE ON public.cms_sales_lines TO service_role`, 'v3-truncate-revoked'],
    ['TRUNCATE-PUBLIC', `GRANT TRUNCATE ON public.cms_programs TO PUBLIC`, 'v3-truncate-revoked'],
    ['OWNER', `ALTER TABLE public.cms_result_catalog OWNER TO dashboard_qa`, 'v0-owner'],
    ['LOCK3', `ALTER FUNCTION public.${sigLock} SET lock_timeout = '5s'`, 'fn-config:rpc_cms_program_lock'],
    ['INVOKER', `ALTER FUNCTION public.cms__run_auth_guard() SECURITY DEFINER`, 'trigger-fns'],
    ['PAYOUT-TBL', `GRANT SELECT ON public.cms_payouts TO authenticated`, 'v3-payout-acl'],
    ['PAYOUT-COL', `GRANT SELECT (amount_vnd) ON public.cms_payout_staff TO authenticated`, 'v3-payout-acl'],
    ['PAYOUT-SVC', `GRANT INSERT ON public.cms_payout_staff TO service_role`, 'table:cms_payout_staff'],
    ['PAYOUT-RLS', `ALTER TABLE public.cms_payouts DISABLE ROW LEVEL SECURITY`, 'table:cms_payouts'],
    ['READABLE-120', must(await fnDef(N.db, 'cms_readable_program_ids'), "me.role = 'sm' AND p.status IN ('active', 'locked')", "me.role = 'sm' AND p.status = 'active'"),
      'fn-src:cms_readable_program_ids'],
    ['READABLE-ACL', `REVOKE EXECUTE ON FUNCTION public.cms_readable_program_ids() FROM authenticated`, 'acl-preexisting-functions'],
    ['ISO', `ALTER ROLE postgres SET default_transaction_isolation = 'repeatable read'`, 'v7-isolation-123'],
    // db-reviewer 123 P2: quyền cột GIÁN TIẾP qua vai trung gian (aclexplode trực tiếp không thấy) + view / matview đọc vòng.
    ['COL-INDIRECT', `CREATE ROLE cms_mid_probe NOLOGIN; GRANT SELECT (email_snapshot) ON public.cms_payout_staff TO cms_mid_probe;
      GRANT cms_mid_probe TO authenticated`, 'v3-payout-colpriv'],
    ['VIEW', `CREATE VIEW public.cms_probe_payout_v AS SELECT program_id, user_id, amount_vnd FROM public.cms_payout_staff`, 'v3-payout-views'],
    ['MATVIEW', `CREATE MATERIALIZED VIEW public.cms_probe_payout_mv AS SELECT program_id, amount_vnd FROM public.cms_payouts`, 'v3-payout-views'],
    // Mở đường chốt thật: cổng Q-206 mở + nhánh 'real' đủ khoá và ready ⇒ preview chương trình thật hết chặn ⇒ V8 migration đỏ.
    ['LOCK-OPEN', `CREATE OR REPLACE FUNCTION public.cms__results_release_open() RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$ SELECT true $$;
      CREATE OR REPLACE FUNCTION public.cms__lock_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT jsonb_build_object('version', 1,
          'real', jsonb_build_object('ready', true, 'unassigned_max_gmv_bp', 200, 'unassigned_max_lines', 20, 'wait_hours', 0, 'completeness', 'bi_watermark'),
          'qa', jsonb_build_object('label', 'QA_ONLY_ASSUMPTION', 'unassigned_max_gmv_bp', 200, 'unassigned_max_lines', 20, 'wait_hours', 0, 'completeness', 'qa_assumption')) $$`,
      'lock-preview-blocked'],
  ]
  const restore = {
    'TRG-DISABLE': always('cms_results', 'cms_frozen_ins'), 'TRG-ORIGIN': always('cms_payouts', 'cms_payout_immutable'),
    'TRG-REPLICA': always('cms_sync_runs', 'cms_run_auth_guard'),
    'TRG-ROW': `DROP TRIGGER cms_frozen_upd ON public.cms_sales_lines;
      CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON public.cms_sales_lines REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new FOR EACH STATEMENT EXECUTE FUNCTION public.cms__frozen_data_upd();
      ${always('cms_sales_lines', 'cms_frozen_upd')}`,
    TRUNCATE: `REVOKE TRUNCATE ON public.cms_sales_lines FROM service_role`,
    'PAYOUT-TBL': `REVOKE SELECT ON public.cms_payouts FROM authenticated`,
    // Khôi phục để COL-INDIRECT đo độc lập (has_any_column_privilege thấy cả quyền trực tiếp này).
    'PAYOUT-COL': `REVOKE SELECT (amount_vnd) ON public.cms_payout_staff FROM authenticated`,
    'PAYOUT-SVC': `REVOKE INSERT ON public.cms_payout_staff FROM service_role`,
    ISO: `ALTER ROLE postgres RESET default_transaction_isolation`,
    'COL-INDIRECT': `REVOKE cms_mid_probe FROM authenticated`,
    VIEW: `DROP VIEW public.cms_probe_payout_v`,
    MATVIEW: `DROP MATERIALIZED VIEW public.cms_probe_payout_mv`,
  }
  for (const [id, sql, want] of cases) {
    const before = await evalIds()
    await N.db.exec(sql)
    const after = await evalIds()
    ok(!before.includes(want) && after.includes(want), `${id}: ${sql.replace(/\s+/g, ' ').slice(0, 70)}… ⇒ đỏ ${want} (trước đó chưa đỏ)`, JSON.stringify({ before, after }))
    if (restore[id]) await N.db.exec(restore[id])
  }
  // Không đỏ oan: thiết lập isolation = read committed tường minh cho postgres ⇒ V7 123 vẫn đạt.
  await N.db.exec(`ALTER ROLE postgres SET default_transaction_isolation = 'read committed'`)
  ok(!(await evalIds()).includes('v7-isolation-123'), 'ISO-RC: postgres đặt tường minh read committed ⇒ V7 123 không đỏ oan')
  await N.db.exec(`ALTER ROLE postgres RESET default_transaction_isolation`)
  await N.db.close()
}

section('15. Bất biến V5 / V6 — owner / superuser sửa tay (tắt trigger rồi bật lại ALWAYS) ⇒ đỏ đúng mục; trigger vẫn đạt')
{
  const { c: N, pre123 } = await fresh123({ lock: [P.test, P.real] })
  const evalIds = async () => failedIds(T.evaluateCmsVerify(await N.postInput('123', pre123)))
  const post = T.evaluateCmsVerify(await N.postInput('123', pre123))
  ok(failed(post).length === 0 && /2 payout \(QA 1\) · lệch 0/.test(post.find((x) => x.id === 'v5-payout-invariants')?.detail ?? ''),
    'đối chứng: 2 payout (QA + thật, A / B / C) khớp bất biến V5', JSON.stringify(failed(post)))
  const tamper = (t, g, sql) => `ALTER TABLE public.${t} DISABLE TRIGGER ${g}; ${sql}; ALTER TABLE public.${t} ENABLE ALWAYS TRIGGER ${g}`
  const runOf = `(SELECT current_result_run_id FROM public.cms_programs WHERE id = '${P.real}')`
  const cases = [
    ['PAY-AMOUNT', tamper('cms_payouts', 'cms_payout_immutable', `UPDATE public.cms_payouts SET amount_vnd = amount_vnd + 1 WHERE program_id = '${P.test}'`),
      tamper('cms_payouts', 'cms_payout_immutable', `UPDATE public.cms_payouts SET amount_vnd = amount_vnd - 1 WHERE program_id = '${P.test}'`), 'v5-payout-invariants'],
    ['RESULTS', tamper('cms_results', 'cms_frozen_upd', `UPDATE public.cms_results SET amount_vnd = amount_vnd + 5, potential_amount = potential_amount + 5 WHERE run_id = ${runOf} AND user_id = '${U.A}'`),
      tamper('cms_results', 'cms_frozen_upd', `UPDATE public.cms_results SET amount_vnd = amount_vnd - 5, potential_amount = potential_amount - 5 WHERE run_id = ${runOf} AND user_id = '${U.A}'`), 'v5-payout-invariants'],
    ['CONFIG', tamper('cms_program_products', 'cms_config_lock_guard', `UPDATE public.cms_program_products SET target_gmv = 4321 WHERE program_id = '${P.real}'`),
      tamper('cms_program_products', 'cms_config_lock_guard', `UPDATE public.cms_program_products SET target_gmv = 1000 WHERE program_id = '${P.real}'`), 'v5-payout-invariants'],
    ['UNLOCK', tamper('cms_programs', 'cms_programs_lock_guard', `UPDATE public.cms_programs SET status = 'active', locked_at = NULL, locked_by = NULL WHERE id = '${P.test}'`),
      tamper('cms_programs', 'cms_programs_lock_guard', `UPDATE public.cms_programs SET status = 'locked', locked_at = now(), locked_by = '${U.super}' WHERE id = '${P.test}'`), 'v5-payout-invariants'],
    ['STAFF-SHIFT', tamper('cms_payout_staff', 'cms_payout_immutable', `UPDATE public.cms_payout_staff SET amount_vnd = amount_vnd + CASE WHEN user_id = '${U.A}' THEN 300 ELSE -300 END
        WHERE program_id = '${P.real}' AND user_id IN ('${U.A}', '${U.B}')`),
      tamper('cms_payout_staff', 'cms_payout_immutable', `UPDATE public.cms_payout_staff SET amount_vnd = amount_vnd - CASE WHEN user_id = '${U.A}' THEN 300 ELSE -300 END
        WHERE program_id = '${P.real}' AND user_id IN ('${U.A}', '${U.B}')`), 'v5-payout-staff', 'v5-payout-invariants'],
    ['STAFF-SWAP', tamper('cms_payout_staff', 'cms_payout_immutable', `UPDATE public.cms_payout_staff SET user_id = '${U.D}' WHERE program_id = '${P.real}' AND user_id = '${U.C}'`),
      tamper('cms_payout_staff', 'cms_payout_immutable', `UPDATE public.cms_payout_staff SET user_id = '${U.C}' WHERE program_id = '${P.real}' AND user_id = '${U.D}'`), 'v5-payout-staff', 'v5-payout-invariants'],
    ['RUN-LINE-AMOUNT', tamper('cms_result_lines', 'cms_frozen_upd', `UPDATE public.cms_result_lines SET amount_vnd = amount_vnd + 1 WHERE run_id = ${runOf} AND seq = 0`),
      tamper('cms_result_lines', 'cms_frozen_upd', `UPDATE public.cms_result_lines SET amount_vnd = amount_vnd - 1 WHERE run_id = ${runOf} AND seq = 0`), 'v5-run-frozen', 'v5-payout-invariants'],
    ['RUN-CATALOG', tamper('cms_result_catalog', 'cms_frozen_del', `DELETE FROM public.cms_result_catalog WHERE run_id = ${runOf}`), null, 'v5-run-frozen', 'v5-payout-invariants'],
    ['STAFF-ROW', tamper('cms_payout_staff', 'cms_payout_immutable', `DELETE FROM public.cms_payout_staff WHERE program_id = '${P.real}' AND user_id = '${U.C}'`), null, 'v5-payout-invariants'],
    ['V6', tamper('cms_programs', 'cms_programs_lock_guard', `UPDATE public.cms_programs SET status = 'locked', locked_at = now(), locked_by = '${U.super}' WHERE id = '${P.s2}'`), null,
      'v6-locked-without-payout'],
  ]
  for (const [id, sql, undo, want, notWant] of cases) {
    const before = await evalIds()
    await N.db.exec(sql)
    const after = await evalIds()
    ok(!before.includes(want) && after.includes(want) && !after.includes('triggers') && (!notWant || !after.includes(notWant)),
      `${id} ⇒ đỏ ${want} (trước đó chưa đỏ; trigger bật lại ALWAYS ⇒ mục triggers vẫn đạt${notWant ? `; ${notWant} KHÔNG bắt được — chỉ mục mới đỏ` : ''})`,
      JSON.stringify({ before, after }))
    if (undo) await N.db.exec(undo)
  }
  await N.db.close()
}

section('16. Rollback 123 ⇒ POST 122 khớp lại (TRUNCATE trả service_role, thân 120 của cms_readable_program_ids); chạy lại 123 ⇒ POST 123 đạt')
{
  const { c: N, pre122, pre123 } = await fresh123() // QA đã chốt
  ok(failedIds(T.evaluateCmsVerify(await N.postInput('122', pre122))).includes('phase-match'), 'trước rollback: checker 122 đỏ phase-match (DB 123)')
  await N.db.exec(RB_123)
  const post122 = T.evaluateCmsVerify(await N.postInput('122', pre122))
  ok(failed(post122).length === 0 && ['fn-src:cms_readable_program_ids', 'table:cms_sales_lines', 'table:cms_programs', 'triggers', 'fn-set', 'acl-preexisting-functions']
    .every((id) => post122.some((x) => x.id === id && x.ok)),
  `sau rollback 123: POST 122 (PRE 122 cũ) ${post122.length} mục đạt hết — service_role đủ 7 quyền gồm TRUNCATE, thân 120 cms_readable_program_ids, 3 trigger`, JSON.stringify(failed(post122)))
  ok((await L.one(N.db, `SELECT status FROM public.cms_programs WHERE id = $1`, [P.test])).status === 'locked', 'chương trình QA đã chốt GIỮ locked sau rollback (H8), payout QA mất cùng bảng')
  const ids = failedIds(T.evaluateCmsVerify(await N.postInput('123', pre123, { tolerant: true })))
  ok(ids.includes('phase-match') && ids.includes('fn-set') && ids.includes('marker-123'), 'sau rollback: checker 123 đỏ (phase-match / thiếu hàm / marker)', JSON.stringify(ids.slice(0, 8)))
  await sleep(15)
  const pre123b = (await N.ro(T.cmsVerifyAclSql()))[0]
  ok(pre123b.n_all === pre123.n_all && pre123b.md5_all === pre123.md5_all, 'ảnh ACL hàm sau rollback = PRE 123 (rollback không để lại grant / hàm lạ)')
  await sleep(15)
  await N.db.exec(SQL_123)
  const again = T.evaluateCmsVerify(await N.postInput('123', pre123b))
  const v6 = again.find((x) => x.id === 'v6-locked-without-payout'), v5b = again.find((x) => x.id === 'v5-payout-invariants')
  ok(failed(again).length === 0 && /QA 1/.test(v6?.detail ?? '') && v5b?.proven === false,
    'chạy lại 123 sau rollback: POST 123 đạt; V6 cho phép 1 chương trình QA locked không payout (dấu vết H8); V5 CHƯA (0 payout)', JSON.stringify(failed(again)))
  await N.db.close()
}

section('17. V8 phase 123 — gọi THẬT rpc_cms_payout dưới authenticated; tập dòng chi trả = oracle phạm vi hiện tại (Q-208 / Q-217)')
{
  // Chốt thật (A, B, C — C thuộc nhà thuốc 2 bán tại nhà thuốc 1) + QA (A); nhà thuốc 2 (D) chưa chốt.
  const { c: N } = await fresh123({ lock: [P.test, P.real] })
  const proven = (r, id) => r.checks.find((x) => x.id === id)?.proven
  let r = await N.v8(U.A, 'staff', { phase: '123', qa: false, readable: 1, requireProven: ['payout', 'results'] })
  ok(failed(r.checks).length === 0 && r.row.py_seen_n === 1 && r.row.py_total_n === 3 && r.row.py_calls === 1 && r.row.rpc_callable === T.CMS_V8_RPC_CALLABLE['123']
    && r.row.py_role === 'authenticated' && proven(r, 'v8-payout-rpc') === true && proven(r, 'v8-payout-fields') === true,
  'staff A (không marker): chương trình thật đã chốt đọc được; chỉ dòng của chính A (1 / 3), không email; 5 RPC gọi được; cắt được chứng minh', JSON.stringify(failed(r.checks)))
  r = await N.v8(U.qlch1, 'qlch', { phase: '123' })
  ok(failed(r.checks).length === 0 && r.row.py_seen_n === 2, 'QLCH nhà thuốc 1: A, B (staff HIỆN thuộc nhà thuốc) — không C; chỉ scope_total', JSON.stringify(failed(r.checks)))
  r = await N.v8(U.sm, 'sm', { phase: '123', readable: 2 })
  ok(failed(r.checks).length === 0 && r.row.py_seen_n === 3 && r.row.py_calls === 1,
    "SM nhà thuốc 1 + 2: thấy chương trình 'locked' (123) + active; dòng chi trả A, B, C", JSON.stringify(failed(r.checks)))
  r = await N.v8(U.super, 'super', { phase: '123', qa: false })
  ok(failed(r.checks).length === 0 && r.row.py_seen_n === 3 && proven(r, 'v8-table:payout') === false && proven(r, 'v8-payout-fields') === true,
    'super (không marker): mọi dòng + program_total + email; tổng = thấy ⇒ CHƯA chứng minh cắt', JSON.stringify(failed(r.checks)))
  r = await N.v8(U.mkt, 'admin', { phase: '123', readable: 0 })
  ok(failed(r.checks).length === 0 && r.row.py_calls === 0 && proven(r, 'v8-payout-fields') === false, 'admin thường: mọi chương trình FORBIDDEN; chưa đọc payout ⇒ CHƯA', JSON.stringify(failed(r.checks)))
  await N.wr(T.cmsQaGrantSql([U.A], 2))
  r = await N.v8(U.A, 'staff', { phase: '123', qa: true, readable: 2 })
  ok(failed(r.checks).length === 0 && r.row.py_seen_n === 2 && r.row.py_calls === 2, 'staff A + marker: thêm payout QA của chính A (2 dòng, 2 chương trình)', JSON.stringify(failed(r.checks)))
  r = await N.v8(U.A, 'staff', { phase: '122' })
  ok(failedIds(r.checks).includes('v8-phase') && failedIds(r.checks).includes('v8-private') && /PHASE KHÔNG PHÙ HỢP: DB phase 123/.test(r.checks.find((x) => x.id === 'v8-phase').detail),
    'V8 khai phase 122 trên DB 123 ⇒ đỏ v8-phase (lời rõ) + v8-private (rpc_cms_payout gọi được)', JSON.stringify(failedIds(r.checks)))
  // Lệch ở rpc_cms_payout / helper — mỗi ca khôi phục định nghĩa gốc ngay sau khi khẳng định (một DB).
  const orig = { payout: await fnDef(N.db, 'rpc_cms_payout'), readable: await fnDef(N.db, 'cms_readable_program_ids') }
  const muts = [
    ['EMAIL', 'payout', "|| CASE WHEN v_su THEN jsonb_build_object('email', s.email_snapshot) ELSE '{}'::jsonb END", "|| jsonb_build_object('email', s.email_snapshot)",
      U.qlch1, 'qlch', 'v8-payout-fields'],
    ['TOTAL', 'payout', "'program_total', CASE WHEN v_su THEN v_pay.amount_vnd::text END,", "'program_total', v_pay.amount_vnd::text,", U.qlch1, 'qlch', 'v8-payout-fields'],
    ['SCOPE', 'payout', 'AND (v_users IS NULL OR s.user_id = ANY (v_users))', '', U.qlch1, 'qlch', 'v8-table:payout'],
    ['FORBID', 'payout', ' OR NOT (p_program_id = ANY (public.cms_readable_program_ids()))', '', U.B, 'staff', 'v8-payout-rpc'],
    ['SM-120', 'readable', "me.role = 'sm' AND p.status IN ('active', 'locked')", "me.role = 'sm' AND p.status = 'active'", U.sm, 'sm', 'v8-oracle-set'],
    // Danh sách khoá CHO PHÉP theo vai khai báo: khoá lạ ở dòng (cả super), staff_paid lộ cho non-super.
    ['ROW-EXTRA', 'payout', "'products_with_cms', s.products_with_cms)", "'products_with_cms', s.products_with_cms, 'probe', 1)", U.qlch1, 'qlch', 'v8-payout-fields'],
    ['ROW-EXTRA-SUPER', 'payout', "'products_with_cms', s.products_with_cms)", "'products_with_cms', s.products_with_cms, 'probe', 1)", U.super, 'super', 'v8-payout-fields'],
    ['STAFF-PAID', 'payout', "'policy_version', v_pay.policy_version,", "'policy_version', v_pay.policy_version, 'staff_paid', v_pay.staff_paid,", U.qlch1, 'qlch', 'v8-payout-fields'],
  ]
  for (const [id, fn, from, to, user, role, want] of muts) {
    const before = failedIds((await N.v8(user, role, { phase: '123' })).checks)
    await N.db.exec(must(orig[fn], from, to))
    const after = failedIds((await N.v8(user, role, { phase: '123' })).checks)
    ok(!before.includes(want) && after.includes(want), `${id}: ${role} ⇒ đỏ ${want} (trước đó chưa đỏ)`, JSON.stringify({ before, after }))
    await N.db.exec(orig[fn])
  }
  // Quyền cột GIÁN TIẾP (vai trung gian cấp cho authenticated) ⇒ private_tables của V8 123 > 0.
  {
    const before = failedIds((await N.v8(U.qlch1, 'qlch', { phase: '123' })).checks)
    await N.db.exec(`CREATE ROLE cms_mid_v8 NOLOGIN; GRANT SELECT (email_snapshot) ON public.cms_payout_staff TO cms_mid_v8; GRANT cms_mid_v8 TO authenticated`)
    const v = await N.v8(U.qlch1, 'qlch', { phase: '123' })
    ok(!before.includes('v8-private') && failedIds(v.checks).includes('v8-private') && v.row.private_tables === 1,
      'COL-INDIRECT V8: authenticated có SELECT cột email_snapshot qua vai trung gian ⇒ đỏ v8-private (private_tables 1)', JSON.stringify({ before, after: failedIds(v.checks) }))
  }
  await N.db.close()
}
} // P123 §13–§17

console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exit(fail ? 1 : 0)
