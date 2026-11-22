#!/usr/bin/env node
// CMS — writer KẾT QUẢ QA bằng dữ liệu bán GIẢ trên DB production, CÓ GATE (PM 03/11 review I4/P3/runbook REL-P1-1; quyết
// định operator: QA prod dùng bán giả gắn tài khoản QA, đối soát nguồn thật offline). OPERATOR-ONLY, chỉ BÊN TRONG run QA
// đang mở của launcher scripts/cms-qa-run.mjs. Dùng CHUNG lõi lib/cms/salesSync.ts + RPC thật của 122 (deps
// lib/cms/server/salesSyncDeps.ts); CHỈ thay nguồn bằng runner giả (e2e/cmsFixtureRunner.ts — cấm ở NODE_ENV=production) và
// bọc mọi bước ghi bằng guard. Không BigQuery, không cron / app production, không fallback.
//
//   E2E_CMS_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/cms-qa-results.mjs publish --program=<uuid QA>
//       --staff=<uuid staff QA,…> --confirm-run=<runId đang mở> [--lines-per-staff=30] [--unassigned]
//   (P4-A — nguồn BigQuery THẬT qua pipeline contract; cờ + view là biến PROCESS của lệnh)
//   E2E_CMS_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> CMS_CALC_MODES_ENABLED=true CMS_RETURNS_ENABLED=true CMS_BQ_SALES_TABLE=<view bán>
//       CMS_BQ_RETURNS_TABLE=<view trả> node scripts/cms-qa-results.mjs publish --source=bq --program=<uuid QA> --confirm-run=<runId>
//       --expect-cv=<N> --expect-basis=<pos_base|cms_unit> --expect-policy=<policy> [--dry-run]
//   node scripts/cms-qa-results.mjs status
//   E2E_CMS_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/cms-qa-results.mjs reconcile --writer=<w-…|l-…> [--finish-orphan]
//   E2E_CMS_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> CMS_PROGRAM_ENABLED=true CMS_EARNINGS_ENABLED=true CMS_LOCK_ENABLED=true
//       node scripts/cms-qa-results.mjs lock-preview --program=<uuid QA-C> --actor=<uuid super QA> --confirm-run=<runId>
//   (cùng biến) node scripts/cms-qa-results.mjs lock --program=<uuid QA-C> --actor=<uuid super QA> --confirm-run=<runId>
//       --expect-run=<run_id từ lock-preview> --policy-version=<N từ lock-preview> [--ack=<lý do 10…1.000 ký tự>]
//       [--expect-attestation=<id chứng nhận từ lock-preview — bắt buộc khi preview chốt bằng chứng nhận (124)>]
//
// lock-preview / lock (P3a, work order 03/11 §4.2 — chỉ chương trình QA đã hết kỳ trong run; VĨNH VIỄN theo H8): cùng gate
//   PROCESS / host / manifest / candidate / launcher / marker / ngân sách đơn điệu của publish; cờ PROGRAM + EARNINGS + LOCK
//   phải là biến PROCESS (LOCK trong .env.local ⇒ gate chặn); actor = tài khoản QA vai admin của run, super theo allowlist app
//   (canManageCms). Đi qua CHÍNH lõi action lib/cms/lockAction.ts (cờ → quyền → chương trình → đầu vào → RPC 123); bước RPC
//   chốt: guard (đọc DB rồi kiểm lại manifest + launcher) → ghi Ý ĐỊNH vào sổ l-….json (đồng bộ, độc quyền) → RPC → ghi kết
//   quả atomic. Còn thao tác chốt intent / unknown của cùng chương trình ⇒ chặn tới khi reconcile. Mất phản hồi ⇒ KẾT QUẢ
//   CHỐT KHÔNG RÕ (rc 1); lưu sổ sau RPC lỗi ⇒ SỔ CHỐT CHƯA ĐÓNG (rc 1). reconcile --writer=l-… đọc payout + phiên DB đang
//   chạy chốt (e2e/cmsQaResults.ts cmsQaLockReconcileCheck); không mở lại / xoá payout để chữa sổ.
//
// publish: gate PROCESS / host / .env.local (cmsQaWriterGate — manifest PHẢI mở) → runId gõ lại + host + candidate (cây sạch,
//   HEAD / tree = manifest) + launcher còn sống (cổng + pid) + staff là tài khoản QA vai staff của run → GUARD DB (chương trình
//   is_test, active, thuộc run; marker mọi tài khoản QA còn ≥ 10 phút) → sổ writer (ghi độc quyền) → lõi với guard trước
//   open / stage / seal / publish / cleanup → cập nhật sổ (atomic). Mất điều kiện giữa chừng ⇒ CMS_QA_GUARD_LOST: lõi đóng run
//   error (finish — đường thu hồi lỗi tối thiểu), pointer giữ nguyên.
// publish --source=bq (P4-A, PM 22/11 §3 A2): cùng gate / candidate / launcher / marker / sổ / tag của writer giả, nhưng KHÔNG thay nguồn —
//   deps thật (một job bán + trả ghim as_of) + calc_contract theo cờ PROCESS; nguồn run vẫn 'qa' (lõi chặn chương trình thật, close nhận
//   theo liên kết writer). Bắt buộc --expect-cv / --expect-basis / --expect-policy: guard so với DB trước MỖI bước ghi; hợp đồng run DB
//   ghim lúc open phải khớp, lệch ⇒ rc 1 (EXPECT_MISMATCH). --dry-run: snapshot chỉ đọc + nguồn + engine, KHÔNG mở run / sổ / pointer.
//   Không fallback fixture / legacy; không tự publish lại. Mặc định (--source vắng) vẫn là nguồn giả như cũ.
// reconcile: writer chết khi sổ còn running (pid không còn) ⇒ đọc run sales của chương trình trong cửa sổ; còn run running ⇒
//   cần --finish-orphan (đóng error QA_WRITER_ABORTED — chỉ chương trình is_test) ⇒ ghi sổ 'reconciled'. close của launcher
//   từ chối khi còn writer chạy / không rõ.
// In: chế độ, host, runId, số đếm, mã — không email, không giá trị dòng, không key. Thoát: 0 published / đạt · 1 bị chặn ở DB
//   / held / lỗi · 2 sai tham số / gate (trước mọi IO ghi).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT, die2, loadTooling, mergedEnv, parseArgs, pgMeta, pidAlive, readEnvFileText, rethrowCliExit, runCli, runLiveness, supabaseHost } from './lib-cms-ops.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function main() {
  const a = parseArgs(process.argv.slice(2), {
    flags: ['--unassigned', '--finish-orphan', '--dry-run'],
    values: ['--program', '--staff', '--lines-per-staff', '--confirm-run', '--writer', '--actor', '--expect-run', '--policy-version', '--ack', '--expect-attestation',
      '--source', '--expect-cv', '--expect-basis', '--expect-policy'],
  })
  const lockCmd = a.cmd === 'lock' || a.cmd === 'lock-preview'
  const lockOnly = ['--actor', '--expect-run', '--policy-version', '--ack', '--expect-attestation'].filter((k) => a.values[k] !== undefined)
  if (!['publish', 'status', 'reconcile', 'lock', 'lock-preview'].includes(a.cmd) || a.bad.length || (!lockCmd && lockOnly.length)) {
    console.log('dùng: node scripts/cms-qa-results.mjs <publish --program=<uuid> --staff=<uuid,…> --confirm-run=<runId> [--lines-per-staff=N] [--unassigned] | status | reconcile --writer=<w-…|l-…> [--finish-orphan] | lock-preview --program=<uuid> --actor=<uuid> --confirm-run=<runId> | lock --program=<uuid> --actor=<uuid> --confirm-run=<runId> --expect-run=<uuid> --policy-version=<N> [--ack=<lý do>]>')
    return 2
  }
  const { T, G, R } = await loadTooling()
  // P4-A: nguồn của publish — tham số nguồn bq chỉ đi với publish --source=bq; kiểm TRƯỚC mọi IO (rc 2).
  const bqOnly = ['--expect-cv', '--expect-basis', '--expect-policy'].filter((k) => a.values[k] !== undefined)
  if (a.cmd !== 'publish' && (a.values['--source'] !== undefined || bqOnly.length || a.flags.has('--dry-run'))) die2('--source / --expect-* / --dry-run chỉ dùng với publish')
  const srcKind = R.parseCmsQaWriterSource(a.values['--source'])
  if (!srcKind.ok) die2(srcKind.reason)
  const bq = a.cmd === 'publish' && srcKind.value === 'bq'
  if (a.cmd === 'publish' && !bq && (bqOnly.length || a.flags.has('--dry-run'))) die2('--expect-* / --dry-run chỉ dùng với --source=bq')
  const envFileText = readEnvFileText()
  let bqExpect = null
  // Security review P2-3: capture lớp nguồn (có email nhân viên) của lượt bq CHỈ bật bằng biến PROCESS — chốt giá trị ở đây, trước loadCore.
  let bqSourceCapture = false
  if (bq) {
    const ex = R.parseCmsQaBqExpect({ cv: a.values['--expect-cv'], basis: a.values['--expect-basis'], policy: a.values['--expect-policy'] })
    if (!ex.ok) die2(ex.reason)
    bqExpect = ex.value
    // Cờ + view của lượt phải là biến PROCESS của chính lệnh (kiểm trước khi chép .env.local vào process ở loadCore).
    const pe = R.cmsQaBqSourceEnvCheck(process.env, envFileText)
    if (!pe.ok) die2(pe.reason)
    bqSourceCapture = process.env.CMS_SOURCE_CAPTURE_ENABLED === 'true'
    if (a.values['--staff'] !== undefined || a.values['--lines-per-staff'] !== undefined || a.flags.has('--unassigned')) die2('--source=bq không nhận --staff / --lines-per-staff / --unassigned (không sinh dòng giả)')
  }
  const env = mergedEnv(envFileText)
  const MARKER = path.join(ROOT, G.CMS_QA_MARKER)
  const mask = T.maskCmsUuid
  const json = (o) => JSON.stringify(o, null, 2) + '\n'
  const writeAtomic = (file, obj) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, json(obj)); fs.renameSync(tmp, file) }
  const readManifest = () => {
    if (!fs.existsSync(MARKER)) return null
    const p = T.parseCmsQaManifest(fs.readFileSync(MARKER, 'utf8'))
    return p.ok ? p.value : null
  }
  const listLedger = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^w-[0-9a-f]{12}\.json$/.test(f)).sort() : [])
  const listLocks = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^l-[0-9a-f]{12}\.json$/.test(f)).sort() : [])

  if (a.cmd === 'status') {
    const m = readManifest()
    if (!m) { console.log('không có run QA CMS đang mở'); return 0 }
    const dir = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${m.runId}.writers`)
    const files = listLedger(dir)
    const lockFiles = listLocks(dir)
    console.log(`run ${m.runId} · ${files.length} writer · ${lockFiles.length} thao tác chốt`)
    for (const f of files) {
      const p = R.parseCmsQaWriterEntry(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (!p.ok) { console.log(`  ${f}: HỎNG (${p.reason})`); continue }
      const e = p.value
      console.log(`  ${e.writerId} · ${e.status}${e.status === 'running' ? (pidAlive(e.pid) ? ' (pid sống)' : ' (pid KHÔNG còn — cần reconcile)') : ''} · chương trình ${mask(e.programId)} · ${e.result ? `${e.result.status}${e.result.code ? ` ${e.result.code}` : ''} run ${e.result.runId ? mask(e.result.runId) : '—'}` : '—'}`)
    }
    for (const f of lockFiles) {
      const p = R.parseCmsQaLockEntry(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (!p.ok) { console.log(`  ${f}: HỎNG (${p.reason})`); continue }
      const e = p.value
      const claimed = R.cmsQaLockClaimedRun(e)
      console.log(`  ${e.operationId} · chốt ${e.status}${e.status === 'intent' ? (pidAlive(e.pid) ? ' (pid sống)' : ' (pid KHÔNG còn — cần reconcile)') : ''} · chương trình ${mask(e.programId)} · run kỳ vọng ${mask(e.expectedRunId)} · ${claimed ? `ĐÃ CHỐT run ${mask(claimed)}` : e.result?.code ?? (e.reconcile ? 'chưa chốt (reconcile)' : '—')}`)
    }
    return 0
  }
  if (lockCmd) {
    // Cờ chốt phải là biến PROCESS của chính lệnh — kiểm TRƯỚC mọi IO (rc 2).
    const fl = R.cmsQaLockFlagsOk(process.env)
    if (!fl.ok) die2(fl.reason)
  }

  // ── Gate chung (publish / reconcile): biến PROCESS, host, .env.local, manifest PHẢI mở ──
  const gate = G.cmsQaWriterGate({ env, envFileText, markerExists: fs.existsSync(MARKER) })
  if (!gate.ok) die2(gate.reason)
  const manifestText0 = fs.existsSync(MARKER) ? fs.readFileSync(MARKER, 'utf8') : null
  const manifestUnchanged = () => { try { return manifestText0 !== null && fs.readFileSync(MARKER, 'utf8') === manifestText0 } catch { return false } }
  const m = readManifest()
  if (!m || m.status !== 'open') die2(`${G.CMS_QA_MARKER} hỏng hoặc không ở trạng thái mở — không xoá tay; báo PM / operator`)
  if (gate.host !== m.host) die2(`host hiện tại (${gate.host}) khác host của run (${m.host})`)
  if (!env.SUPABASE_SERVICE_ROLE_KEY) die2('thiếu SUPABASE_SERVICE_ROLE_KEY')
  const ledgerDir = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${m.runId}.writers`)
  const uids = m.users.map((u) => u.id)

  // Nạp lõi + deps THẬT (RPC 122) qua jiti — process.env phải có URL / key trước khi import admin client.
  const loadCore = async () => {
    for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined && v !== undefined) process.env[k] = v
    delete process.env.SUPABASE_INTERNAL_URL
    const { createJiti } = await import('jiti')
    const jiti = createJiti(import.meta.url, { alias: { '@': ROOT, 'server-only': path.join(HERE, 'cms-server-only-stub.mjs') }, interopDefault: true })
    return {
      core: await jiti.import(path.join(ROOT, 'lib/cms/salesSync.ts')),
      stage: await jiti.import(path.join(ROOT, 'lib/cms/resultStage.ts')),
      depsMod: await jiti.import(path.join(ROOT, 'lib/cms/server/salesSyncDeps.ts')),
      fixture: await jiti.import(path.join(ROOT, 'e2e/cmsFixtureRunner.ts')),
    }
  }

  // Lõi action chốt (lib/cms/lockAction.ts) + allowlist super của app (lib/cms/access.ts) + client service_role của app.
  const loadLockCore = async () => {
    for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined && v !== undefined) process.env[k] = v
    delete process.env.SUPABASE_INTERNAL_URL
    const { createJiti } = await import('jiti')
    const jiti = createJiti(import.meta.url, { alias: { '@': ROOT, 'server-only': path.join(HERE, 'cms-server-only-stub.mjs') }, interopDefault: true })
    return {
      action: await jiti.import(path.join(ROOT, 'lib/cms/lockAction.ts')),
      payout: await jiti.import(path.join(ROOT, 'lib/cms/payoutView.ts')),
      access: await jiti.import(path.join(ROOT, 'lib/cms/access.ts')),
      admin: (await jiti.import(path.join(ROOT, 'lib/supabase/admin.ts'))).supabaseAdmin,
    }
  }

  if (a.cmd === 'reconcile' && /^l-[0-9a-f]{12}$/.test(a.values['--writer'] ?? '')) {
    // Thao tác CHỐT (P3a): đọc payout + phiên DB đang chạy chốt; không cần launcher sống, không ghi DB.
    const oid = a.values['--writer']
    if (a.flags.has('--finish-orphan')) die2('--finish-orphan chỉ dùng cho writer kết quả (w-…)')
    const file = path.join(ledgerDir, `${oid}.json`)
    if (!fs.existsSync(file)) die2(`không có sổ chốt ${oid} trong run ${m.runId}`)
    const p = R.parseCmsQaLockEntry(fs.readFileSync(file, 'utf8'))
    if (!p.ok) die2(`sổ chốt ${oid} hỏng (${p.reason}) — không sửa tay; báo PM / operator`)
    const e = p.value
    if (e.qaRunId !== m.runId) die2(`sổ chốt ${oid} thuộc run khác`)
    try {
      const has = await pgMeta(env, T.pgMetaReadOnly(R.CMS_QA_HAS_PAYOUTS_SQL))
      if (has[0]?.has_payouts !== true) { console.log('KHÔNG RECONCILE: DB chưa có cms_payouts (chưa chạy 123) — báo PM / operator'); return 1 }
      // Lượt 1 dò phiên ghi payout chưa commit, lượt 2 mới đọc payout (snapshot mới) — db-review P2-3.
      const probe = (await pgMeta(env, T.pgMetaReadOnly(R.CMS_QA_LOCK_PROBE_SQL)))[0]
      const rows = await pgMeta(env, T.pgMetaReadOnly(R.cmsQaLockStateSql(e.programId)))
      const c = R.cmsQaLockReconcileCheck(e, rows[0], { pidAlive: pidAlive(e.pid), nowMs: Date.now(), probe })
      if (!c.ok) { console.log(`${c.wait ? 'CHỜ' : 'KHÔNG RECONCILE'}: ${c.reason}`); return 1 }
      writeAtomic(file, { ...e, status: 'reconciled', finishedAt: e.finishedAt ?? new Date().toISOString(),
        reconcile: { at: new Date().toISOString(), locked: c.locked, payout: c.payout } })
      console.log(`thao tác chốt ${oid} ⇒ reconciled · ${c.locked ? `ĐÃ CHỐT run ${mask(c.payout.runId)} (lệnh mất phản hồi sau commit)` : 'CHƯA chốt (không có payout, không còn phiên chốt, đã qua thời gian lắng) — được chốt lại bằng lock-preview → lock'}`)
      return 0
    } catch (err) {
      rethrowCliExit(err)
      console.log(`LỖI: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      return 1
    }
  }

  if (a.cmd === 'reconcile') {
    const wid = a.values['--writer']
    if (!wid || !/^w-[0-9a-f]{12}$/.test(wid)) die2('cần --writer=<w-… | l-… từ `status`>')
    const file = path.join(ledgerDir, `${wid}.json`)
    if (!fs.existsSync(file)) die2(`không có sổ writer ${wid} trong run ${m.runId}`)
    const p = R.parseCmsQaWriterEntry(fs.readFileSync(file, 'utf8'))
    if (!p.ok) die2(`sổ writer ${wid} hỏng (${p.reason}) — không sửa tay; báo PM / operator`)
    const e = p.value
    if (e.qaRunId !== m.runId) die2(`sổ writer ${wid} thuộc run khác`)
    // Không cần launcher sống: thu hồi lỗi của writer đã chết. Chỉ run LIÊN KẾT đúng writer (qa_writer_id) — không tự nhận run
    // chỉ vì cùng chương trình / cùng source (PM 03/11 QA-P1-2).
    try {
      const prog = await pgMeta(env, T.pgMetaReadOnly(R.cmsQaWriterProgramSql(e.programId, m.startedAt, uids)))
      if (!prog[0] || prog[0].is_test !== true) { console.log(`ĐỎ: chương trình ${mask(e.programId)} không phải is_test — dừng, báo PM / operator`); return 1 }
      const rowsAll = await pgMeta(env, T.pgMetaReadOnly(R.cmsQaRunSalesRunsSql(m.startedAt)))
      const plan = R.cmsQaReconcileCheck(e, rowsAll, pidAlive(e.pid))
      if (!plan.ok) { console.log(`KHÔNG RECONCILE: ${plan.reason}`); return 1 }
      let finishedOrphan = null
      if (plan.orphan) {
        if (!a.flags.has('--finish-orphan')) {
          console.log(`run sales ${mask(plan.orphan)} (writer ${wid}) còn running — chạy lại với --finish-orphan để đóng error QA_WRITER_ABORTED (không công bố, giữ pointer)`)
          return 1
        }
        const { depsMod } = await loadCore()
        await depsMod.cmsSalesSyncDeps(process.env).finish(plan.orphan, 'error', { error_code: 'QA_WRITER_ABORTED' }, { timeoutMs: 30_000 })
        finishedOrphan = plan.orphan
        console.log(`đã đóng run ${mask(finishedOrphan)} error QA_WRITER_ABORTED`)
      }
      const linked = finishedOrphan
        ? (await pgMeta(env, T.pgMetaReadOnly(R.cmsQaRunSalesRunsSql(m.startedAt)))).filter((r) => r.qa_writer_id === wid)
        : plan.linked
      // P4-A r1 (PM 22/11 R2-b) — writer nguồn bq: "tìm thấy run" ≠ "run đúng hợp đồng". Đọc metadata ĐÃ GHIM của từng run liên kết đã
      // công bố và so với `expect` sổ ghi TRƯỚC khi gửi (không dùng cấu hình chương trình hiện tại). Không đọc được ⇒ KHÔNG reconcile.
      let contract
      if (e.source === 'bq') {
        const okRuns = linked.filter((r) => r.status === 'ok')
        const crow = okRuns.length ? await pgMeta(env, T.pgMetaReadOnly(R.cmsQaBqRunContractSql(okRuns.map((r) => r.id)))) : []
        contract = R.cmsQaBqRunsVerdicts(e, linked, crow)
      }
      const done = { ...e, status: 'reconciled', finishedAt: new Date().toISOString(),
        reconcile: { at: new Date().toISOString(), runs: linked.map((r) => ({ id: r.id, status: r.status, errorCode: r.error_code })), finishedOrphan,
          ...(contract ? { contract } : {}) } }
      writeAtomic(file, done)
      console.log(`writer ${wid} ⇒ reconciled · ${linked.length} run sales liên kết (${linked.map((r) => `${mask(r.id)} ${r.status}`).join(', ') || '—'})`)
      if (contract) {
        for (const v of contract) console.log(`  run ${mask(v.runId)} ${v.status} · hợp đồng run DB ${v.match ? 'KHỚP kỳ vọng của sổ' : `LỆCH: ${v.reasons.join('; ')}`}`)
        if (contract.some((v) => !v.match)) {
          console.log('ĐÃ COMMIT NHƯNG LỆCH HỢP ĐỒNG (EXPECT_MISMATCH): run đã công bố không đúng bộ --expect-* của sổ — KHÔNG coi là đạt; close sẽ ĐỎ tới khi có lượt bq khớp sau đó; báo PM / operator')
          return 1
        }
        if (!contract.length) console.log('  không có run nào đã công bố của writer này — KHÔNG có kết quả để nghiệm thu')
      }
      return 0
    } catch (e) {
      rethrowCliExit(e)
      console.log(`LỖI: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      return 1
    }
  }

  // ── P4-A: publish --source=bq — pipeline contract với nguồn THẬT, cùng guard / sổ / tag; không runner / table / dòng giả. ──
  async function publishBq({ core, real }) {
    // Cờ lấy từ process.env SAU loadCore vẫn là giá trị PROCESS đã kiểm (loadCore chỉ chép biến CHƯA có) — cmsQaBqSourceEnvCheck đã ép 'true'.
    const calcFlags = { modes: process.env.CMS_CALC_MODES_ENABLED === 'true', returns: process.env.CMS_RETURNS_ENABLED === 'true' }
    const sourceCapture = bqSourceCapture
    const view = (r) => ({ status: r.status, code: r.code, reasons: r.reasons, runId: r.runId, isTest: r.isTest, rowsRead: r.rowsRead, rowsRejected: r.rowsRejected,
      candidates: r.candidates, included: r.included, unassigned: r.unassigned, outOfScope: r.outOfScope, amountVnd: r.amountVnd, stagedRows: r.stagedRows,
      sourceRows: r.sourceRows ?? null, bytesProcessed: r.bytesProcessed, resultHash: r.resultHash, contract: r.contract ?? null })
    if (!real.table || !real.contractProvider) { console.log('CHẶN: thiếu view nguồn / provider contract (CMS_BQ_SALES_TABLE / CMS_BQ_RETURNS_TABLE)'); return 2 }
    if (a.flags.has('--dry-run')) {
      // KHÔNG sổ, KHÔNG open: lõi dryRun chỉ gọi loadSnapshot (đọc) + nguồn + engine. Bọc các bước ghi bằng hàm ném để chứng minh 0 ghi.
      const noWrite = (k) => async () => { throw new Error(`CMS_QA_DRY_RUN_WRITE_${k}`) }
      const dryDeps = { ...real, now: mono, openRun: noWrite('OPEN'), stage: noWrite('STAGE'), sealBegin: noWrite('SEAL'), sealStep: noWrite('SEAL'),
        publish: noWrite('PUBLISH'), finish: noWrite('FINISH'), cleanup: noWrite('CLEANUP') }
      console.log(`QA kết quả · DRY-RUN nguồn BigQuery THẬT · run ${m.runId} · đích ${m.host} · chương trình ${mask(programId)} · kỳ vọng cv ${bqExpect.cv} / ${bqExpect.basis} / ${bqExpect.policy}`)
      let r
      try { r = await core.runCmsSalesSync(dryDeps, programId, { dryRun: true, source: R.CMS_QA_WRITER_SOURCE, deadlineAt: mono() + R.CMS_QA_WRITER_BUDGET_MS, sourceCapture: false, calcFlags }) }
      catch (e) { rethrowCliExit(e); console.log('LỖI: dry-run lỗi ngoài dự kiến (không ghi gì)'); return 1 }
      const expectMatch = R.cmsQaBqContractMatch(r.contract ?? null, bqExpect)
      console.log(JSON.stringify({ ...view(r), dryRun: true, expectMatch }))
      if (!expectMatch) console.log('EXPECT_MISMATCH: hợp đồng lõi đọc được khác --expect-basis / --expect-policy hoặc không phải provider bq — không publish')
      return r.status === 'dry_run' && r.code === null && expectMatch ? 0 : 1
    }
    fs.mkdirSync(ledgerDir, { recursive: true })
    const writerId = `w-${crypto.randomBytes(6).toString('hex')}`
    const ledgerFile = path.join(ledgerDir, `${writerId}.json`)
    let entry = R.newCmsQaWriterEntry({ writerId, qaRunId: m.runId, pid: process.pid, programId, staff: [], lines: 0, now: new Date().toISOString(), source: 'bq', expect: bqExpect })
    try { fs.writeFileSync(ledgerFile, json(entry), { flag: 'wx' }) } catch { die2(`sổ writer ${writerId} đã tồn tại — chạy lại`) }
    console.log(`QA kết quả · nguồn BigQuery THẬT (contract) · run ${m.runId} · đích ${m.host} · chương trình ${mask(programId)} · kỳ vọng cv ${bqExpect.cv} / ${bqExpect.basis} / ${bqExpect.policy} · writer ${writerId}`)
    const deadlineAt = mono() + R.CMS_QA_WRITER_BUDGET_MS
    const clock = { now: mono, workUntil: deadlineAt - core.CMS_SALES_STOP_RESERVE_MS, minStartMs: core.CMS_RPC_START_MIN_MS }
    // deps THẬT nguyên vẹn (table / runner / contractProvider) — chỉ đổi đồng hồ ngân sách và bọc guard + tag + sổ như writer giả.
    const deps = R.cmsQaGuardedDeps({ ...real, now: mono }, guard, {
      clock, tag: { qaRunId: m.runId, writerId },
      onOpened: async (runId) => { entry = { ...entry, openedRunId: runId }; writeAtomic(ledgerFile, entry) },
    })
    let r
    try {
      r = await core.runCmsSalesSync(deps, programId, { dryRun: false, source: R.CMS_QA_WRITER_SOURCE, deadlineAt, sourceCapture, calcFlags })
    } catch (e) {
      rethrowCliExit(e)
      r = { status: 'error', code: 'INTERNAL', reasons: [], runId: null, isTest: null, stagedRows: 0, rowsRead: null, rowsRejected: null, candidates: null, included: null,
        unassigned: null, outOfScope: null, amountVnd: null, bytesProcessed: null, resultHash: null }
    }
    const outcome = R.cmsQaWriterOutcome(r)
    // Hợp đồng run DB ghim lúc open phải đúng kỳ vọng — chỉ xét khi lõi đã tới hợp đồng (published / held sau open).
    let expectMatch = r.runId === null ? null : R.cmsQaBqContractMatch(r.contract ?? null, bqExpect)
    // P4-A r1 (PM 22/11 R2-b): run ĐÃ CÔNG BỐ ⇒ thêm phép so metadata đã ghim của run TRONG DB (cv / cách tính / policy / phiên bản hợp
    // đồng + từ điển / provider của pin / tag) — CÙNG phép so reconcile và close dùng. Không đọc được ⇒ không báo khớp (fail-closed).
    let dbContract = null
    if (r.runId !== null && r.status === 'published' && outcome === 'done') {
      try {
        const crow = await pgMeta(env, T.pgMetaReadOnly(R.cmsQaBqRunContractSql([r.runId])), { signal: AbortSignal.timeout(30_000) })
        dbContract = R.cmsQaBqRunContractCheck(crow[0], entry, r.runId)
      } catch (e) { rethrowCliExit(e); dbContract = { runId: r.runId, status: '—', match: false, reasons: ['không đọc được metadata run trong DB'] } }
      if (!dbContract.match) { expectMatch = false; console.log(`hợp đồng run DB LỆCH kỳ vọng: ${dbContract.reasons.join('; ')}`) }
    } else if (expectMatch === true) {
      // Chưa xác nhận công bố (unknown / held / error): KHÔNG ghi "khớp" vào sổ — hợp đồng run chỉ được nhận sau khi đọc metadata run DB
      // (lượt thường ở nhánh trên, lượt mất phản hồi ở `reconcile`). Lệch (false) vẫn giữ để báo.
      expectMatch = null
    }
    entry = { ...entry, status: outcome, finishedAt: new Date().toISOString(),
      result: { status: r.status, code: r.code, runId: r.runId, stagedRows: r.stagedRows, rowsRead: r.rowsRead, candidates: r.candidates, included: r.included,
        unassigned: r.unassigned, sourceRows: r.sourceRows ?? null },
      net: { amountVnd: r.amountVnd ?? null, resultHash: r.resultHash ?? null, contract: r.contract ?? null, expectMatch, ...(dbContract ? { dbContract } : {}) } }
    let saved = true
    try { writeAtomic(ledgerFile, entry) } catch (e) { rethrowCliExit(e); saved = false }
    console.log(JSON.stringify({ ...view(r), expectMatch, writer: writerId, ledger: saved ? outcome : 'NOT_SAVED', guard: r.code === R.CMS_QA_GUARD_LOST ? guardReasons : undefined }))
    if (!saved) {
      console.log(`SỔ WRITER CHƯA ĐÓNG: không ghi được ${writerId} (vẫn running trên đĩa) — kết quả ${r.status}${r.code ? ` ${r.code}` : ''} có thể đã công bố; KHÔNG publish lại; close sẽ đòi \`reconcile --writer=${writerId}\``)
      return 1
    }
    if (outcome === 'unknown') {
      console.log(`KẾT QUẢ KHÔNG RÕ (${r.code}) — run có thể đã ghi / công bố; KHÔNG publish lại; chạy \`node scripts/cms-qa-results.mjs reconcile --writer=${writerId}\` trước close`)
      return 1
    }
    if (expectMatch === false) {
      console.log('EXPECT_MISMATCH: hợp đồng của run khác --expect-basis / --expect-policy hoặc không phải provider bq — KHÔNG coi là đạt; run đã nằm trong sổ, báo PM / operator')
      return 1
    }
    return r.status === 'published' && r.code === null ? 0 : 1
  }

  // ── publish / lock-preview / lock: tham số → Git → điều kiện cục bộ → guard DB (chung) ──
  const programId = a.values['--program']
  if (!programId || !UUID_RE.test(programId)) die2('cần --program=<uuid chương trình QA>')
  let staff = null, lines = null, la = null
  if (lockCmd) {
    if (a.values['--staff'] !== undefined || a.values['--lines-per-staff'] !== undefined || a.flags.has('--unassigned') || a.flags.has('--finish-orphan')) {
      die2(`${a.cmd} không nhận --staff / --lines-per-staff / --unassigned / --finish-orphan`)
    }
    la = R.parseCmsQaLockArgs({ actor: a.values['--actor'], expectRun: a.values['--expect-run'], policyVersion: a.values['--policy-version'], ack: a.values['--ack'],
      expectAttestation: a.values['--expect-attestation'] }, a.cmd === 'lock')
    if (!la.ok) die2(la.reason)
  } else if (bq) {
    staff = { ok: true, value: [] } // nguồn thật: không tài khoản staff QA, không dòng giả
  } else {
    staff = R.parseCmsQaStaffIds(a.values['--staff'])
    if (!staff.ok) die2(staff.reason)
    lines = R.parseCmsQaLinesPerStaff(a.values['--lines-per-staff'])
    if (!lines.ok) die2(lines.reason)
  }
  let treeClean = false, gitHead = '', gitTree = ''
  try {
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
    treeClean = T.cmsQaTreeState(git(...T.CMS_QA_GIT_STATUS_ARGS)).clean
    gitHead = git('rev-parse', 'HEAD')
    gitTree = git('rev-parse', 'HEAD^{tree}')
  } catch (e) { rethrowCliExit(e); die2('không đọc được Git') }
  // Launcher sống qua helper CHUNG (lib-cms-ops runLiveness → e2e/cmsQaTooling.ts cmsQaRunLiveness): localhost = pid launcher + pid server
  // con + cổng (security review 03/11 P1-1); headless (P4-A) = pid launcher + heartbeat của lượt còn mới. Tham số = manifest ĐANG đọc.
  const launcherAlive = async (cur = m) => (await runLiveness(T, cur)).alive
  const localIn = {
    manifest: m, confirmRun: a.values['--confirm-run'], host: supabaseHost(env), treeClean, gitHead, gitTree,
    launcherAlive: await launcherAlive(),
  }
  const local = lockCmd ? R.cmsQaLockLocalCheck({ ...localIn, actorId: la.value.actorId })
    : bq ? R.cmsQaBqLocalCheck(localIn) : R.cmsQaWriterLocalCheck({ ...localIn, staffIds: staff.value })
  if (!local.ok) { for (const r of local.reasons) console.log(`CHẶN: ${r}`); return 2 }

  // Đồng hồ đơn điệu (performance) theo thang epoch ms, số NGUYÊN — dùng chung cho lõi (deps.now) và guard: ngân sách guard + ghi.
  const mono = R.cmsQaMonoClock()
  // GUARD (PM 03/11 QA-P1-1): đọc DB TRƯỚC (timeout theo ngân sách còn lại), rồi SAU mọi IO kiểm lại manifest + launcher;
  // marker trừ bảo thủ thời gian từ lúc bắt đầu đọc tới khi kiểm xong. Không còn await giữa lần kiểm cuối và bước ghi.
  let guardReasons = []
  const guard = async (step, budgetMs = 60_000) => {
    guardReasons = []
    const t0 = mono()
    const sig = () => AbortSignal.timeout(R.cmsQaIoTimeoutMs(30_000, budgetMs - (mono() - t0), 1_000))
    const programRows = await pgMeta(env, T.pgMetaReadOnly(R.cmsQaWriterProgramSql(programId, m.startedAt, uids)), { signal: sig() })
    const statusRows = await pgMeta(env, T.pgMetaReadOnly(T.cmsQaStatusSql(uids)), { signal: sig() })
    // Nguồn bq: cấu hình chương trình phải còn đúng bộ operator đã gõ lại (cv / cách tính / policy) trước MỖI bước ghi.
    const profileRows = bq ? await pgMeta(env, T.pgMetaReadOnly(R.cmsQaWriterProfileSql(programId)), { signal: sig() }) : null
    const cur = readManifest()
    if (!cur || cur.status !== 'open' || cur.runId !== m.runId || cur.serverNotStopped || !manifestUnchanged()) guardReasons.push('manifest run không còn mở / đã đổi')
    else if (!(await launcherAlive(cur))) guardReasons.push('launcher / server QA không còn chạy (hoặc launcher headless không còn canh marker)')
    else {
      const aged = R.cmsQaAgeStatusRows(statusRows, mono() - t0)
      const c = R.cmsQaWriterDbCheck({ manifest: cur, programId, programRows, statusRows: aged, guardMinutes: T.CMS_QA_GUARD_MINUTES_MIN })
      if (!c.ok) guardReasons.push(...c.reasons)
      if (bq) guardReasons.push(...R.cmsQaBqProfileCheck(profileRows?.[0], bqExpect))
    }
    if (guardReasons.length) throw new Error(`guard ${step}`)
  }
  try { await guard('preflight') } catch (e) {
    rethrowCliExit(e)
    for (const r of guardReasons.length ? guardReasons : [e instanceof Error ? e.message.split('\n')[0] : String(e)]) console.log(`CHẶN: ${r}`)
    return 1
  }

  if (lockCmd) {
    const L = la.value
    // Cờ đã kiểm ở PROCESS env TRƯỚC khi chép .env.local vào process (loadLockCore) — giữ đúng kết quả đó.
    const lockFlagsOn = R.cmsQaLockFlagsOk(process.env).ok
    // Còn thao tác chốt chưa khép (intent / unknown) của cùng chương trình ⇒ chặn: chốt lại chỉ sau reconcile có bằng chứng.
    const parsedLocks = listLocks(ledgerDir).map((f) => R.parseCmsQaLockEntry(fs.readFileSync(path.join(ledgerDir, f), 'utf8')))
    if (parsedLocks.some((p) => !p.ok)) { console.log('CHẶN: có sổ chốt hỏng trong run — không sửa tay; báo PM / operator'); return 1 }
    const pending = R.cmsQaPendingLockOps(parsedLocks.map((p) => p.value), programId)
    if (pending.length) {
      for (const e of pending) console.log(`CHẶN: thao tác chốt ${e.operationId} của chương trình này còn ${e.status} — chạy \`node scripts/cms-qa-results.mjs reconcile --writer=${e.operationId}\` trước`)
      return 1
    }
    const lc = await loadLockCore()
    const deadlineAt = mono() + R.CMS_QA_LOCK_BUDGET_MS
    const ioSig = (want) => AbortSignal.timeout(R.cmsQaIoTimeoutMs(want, deadlineAt - mono(), 1_000))
    const operationId = `l-${crypto.randomBytes(6).toString('hex')}`
    const lockFile = path.join(ledgerDir, `${operationId}.json`)
    let entry = null // có ⇔ đã ghi Ý ĐỊNH (và RPC chốt đã / sắp được gửi)
    // Deps cho CHÍNH lõi action (lib/cms/lockAction.ts): actor = super QA của run (allowlist app), không phải session.
    const deps = {
      lockEnabled: () => lockFlagsOn,
      // Đường chốt QA DUY NHẤT có gate + sổ ý định ⇒ không áp chế độ chỉ đọc của server QA (CMS_QA_SERVER).
      qaReadonly: () => false,
      access: async () => {
        const rows = await pgMeta(env, T.pgMetaReadOnly(R.cmsQaActorSql(L.actorId)), { signal: ioSig(30_000) })
        const u = rows[0]
        return u && lc.access.canManageCms(u.role, u.email) ? { kind: 'ok', actorId: L.actorId, qa: true } : { kind: 'forbidden' }
      },
      program: async (id) => {
        const rows = await pgMeta(env, T.pgMetaReadOnly(R.cmsQaWriterProgramSql(id, m.startedAt, uids)), { signal: ioSig(30_000) })
        return rows[0] ? { isTest: rows[0].is_test === true } : null
      },
      rpc: async (fn, args) => {
        if (fn === 'rpc_cms_lock_preview') return await lc.admin.rpc(fn, args).abortSignal(ioSig(30_000))
        if (fn !== 'rpc_cms_program_lock' || a.cmd !== 'lock') return { data: null, error: { message: 'CMS_QA_BAD_STEP' } }
        if (deadlineAt - mono() < 5_000) return { data: null, error: { message: R.CMS_QA_GUARD_DEADLINE } }
        try { await guard('lock', deadlineAt - mono()) } catch { return { data: null, error: { message: R.CMS_QA_GUARD_LOST } } }
        const remain = deadlineAt - mono()
        if (remain < 5_000) return { data: null, error: { message: R.CMS_QA_GUARD_DEADLINE } }
        // Ý ĐỊNH vào sổ TRƯỚC RPC (đồng bộ, độc quyền) — không còn await giữa guard cuối, ghi sổ và gửi RPC.
        const intent = R.newCmsQaLockEntry({ operationId, qaRunId: m.runId, pid: process.pid, programId, actorId: L.actorId,
          expectedRunId: L.expectedRunId, policyVersion: L.policyVersion, ack: L.ack !== null, now: new Date().toISOString(),
          expectedAttestationId: L.expectedAttestationId })
        try { fs.writeFileSync(lockFile, json(intent), { flag: 'wx' }) } catch { return { data: null, error: { message: R.CMS_QA_LEDGER_FAILED } } }
        entry = intent
        return await lc.admin.rpc(fn, args).abortSignal(AbortSignal.timeout(R.cmsQaIoTimeoutMs(R.CMS_QA_LOCK_RPC_TIMEOUT_MS, remain, 1_000)))
      },
    }

    if (a.cmd === 'lock-preview') {
      const pv = await lc.action.runCmsLockPreview(deps, programId)
      if (!pv.ok) { console.log(`CHẶN: preview ${pv.code}`); return 1 }
      const p = pv.preview
      console.log(JSON.stringify({ program: mask(programId), status: p.status, isTest: p.isTest, endDate: p.endDate, runId: p.runId,
        amountVnd: p.amountVnd, staffRows: p.staffRows, staffPaid: p.staffPaid, candidateLines: p.candidateLines, unassignedLines: p.unassignedLines,
        unassignedOver: p.unassignedOver, needsAck: p.needsAck, policyVersion: p.policyVersion, sourceCompleteBasis: p.sourceCompleteBasis,
        sourceAttestation: p.sourceAttestation, blockers: p.blockers }))
      if (p.blockers.length) { console.log(`CHƯA CHỐT ĐƯỢC: ${p.blockers.join(', ')}`); return 1 }
      const expAtt = lc.payout.cmsLockExpectedAttestation(p)
      console.log(`SẴN SÀNG — chốt là VĨNH VIỄN (H8). Gõ lại: node scripts/cms-qa-results.mjs lock --program=${programId} --actor=${L.actorId} --confirm-run=${m.runId} --expect-run=${p.runId} --policy-version=${p.policyVersion}${typeof expAtt === 'string' ? ` --expect-attestation=${expAtt}` : ''}${p.needsAck ? ' --ack="<lý do 10…1.000 ký tự>"' : ''}`)
      return 0
    }

    fs.mkdirSync(ledgerDir, { recursive: true })
    console.log(`QA chốt · run ${m.runId} · đích ${m.host} · chương trình ${mask(programId)} · run kỳ vọng ${mask(L.expectedRunId)} · policy v${L.policyVersion}${L.expectedAttestationId ? ` · chứng nhận ${mask(L.expectedAttestationId)}` : ''} · thao tác ${operationId}`)
    const r = await lc.action.runCmsLock(deps, { programId, expectedRunId: L.expectedRunId, expectedPolicyVersion: L.policyVersion, ackReason: L.ack ?? undefined,
      expectedAttestationId: L.expectedAttestationId })
    if (!entry) {
      // Không có Ý ĐỊNH trong sổ ⇒ chưa gửi RPC chốt nào.
      console.log(`CHẶN (không gọi RPC chốt): ${r.ok ? 'INTERNAL' : r.code}${guardReasons.length ? ` — ${guardReasons.join('; ')}` : ''}`)
      if (!r.ok && r.code === R.CMS_QA_LEDGER_FAILED && fs.existsSync(lockFile)) console.log(`sổ ${operationId} có thể ghi dở — close sẽ ĐỎ; báo PM / operator, không xoá tay`)
      return 1
    }
    const outcome = R.cmsQaLockOutcome(r)
    entry = { ...entry, status: outcome, finishedAt: new Date().toISOString(), result: r.ok
      ? { ok: true, code: null, already: r.already, runId: r.runId, amountVnd: r.amountVnd }
      : { ok: false, code: r.code, already: false, runId: null, amountVnd: null } }
    let saved = true
    try { writeAtomic(lockFile, entry) } catch (e) { rethrowCliExit(e); saved = false }
    console.log(JSON.stringify({ status: r.ok ? 'locked' : outcome, code: r.ok ? null : r.code, already: r.ok ? r.already : undefined,
      runId: r.ok ? mask(r.runId) : undefined, amountVnd: r.ok ? r.amountVnd : undefined, operation: operationId, ledger: saved ? outcome : 'NOT_SAVED',
      guard: !r.ok && r.code === R.CMS_QA_GUARD_LOST ? guardReasons : undefined }))
    if (!saved) {
      console.log(`SỔ CHỐT CHƯA ĐÓNG: không ghi được kết quả ${operationId} (sổ còn ý định) — chương trình CÓ THỂ đã chốt; KHÔNG chốt lại; close sẽ đòi \`reconcile --writer=${operationId}\``)
      return 1
    }
    if (outcome === 'unknown') {
      console.log(`KẾT QUẢ CHỐT KHÔNG RÕ (${r.code}) — có thể đã chốt; KHÔNG chốt lại; chạy \`node scripts/cms-qa-results.mjs reconcile --writer=${operationId}\` trước close`)
      return 1
    }
    return r.ok ? 0 : 1
  }

  const { core, stage, depsMod, fixture } = await loadCore()
  const real = depsMod.cmsSalesSyncDeps(process.env)
  if (bq) return await publishBq({ core, real })
  // Nguồn giả: sinh từ snapshot CHỈ ĐỌC (email staff QA lấy từ snapshot, không in) — trước khi mở sổ / ghi.
  let rows
  try {
    const snap = stage.parseCmsSalesSnapshot(await real.loadSnapshot(programId, { timeoutMs: 30_000 }))
    const byId = new Map(snap.sellers.map((s) => [s.id, s]))
    const qaStaff = staff.value.map((id) => byId.get(id))
    if (qaStaff.some((s) => !s || s.role !== 'staff' || !s.email)) { console.log('CHẶN: tài khoản staff QA không có email / không còn vai staff trong snapshot'); return 1 }
    rows = R.cmsQaFakeSalesRows({
      qaRunId: m.runId, startDate: snap.startDate, endDate: snap.endDate, todayVn: snap.todayVn,
      products: snap.products.map((p) => ({ productId: p.productId, baseQuantityCms: p.baseQuantityCms })),
      staff: qaStaff.map((s) => ({ id: s.id, email: s.email })), linesPerStaff: lines.value, unassigned: a.flags.has('--unassigned'),
    })
  } catch (e) {
    rethrowCliExit(e)
    console.log(`CHẶN: không dựng được nguồn giả (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`)
    return 1
  }

  fs.mkdirSync(ledgerDir, { recursive: true })
  const writerId = `w-${crypto.randomBytes(6).toString('hex')}`
  const ledgerFile = path.join(ledgerDir, `${writerId}.json`)
  let entry = R.newCmsQaWriterEntry({ writerId, qaRunId: m.runId, pid: process.pid, programId, staff: staff.value, lines: rows.length, now: new Date().toISOString() })
  try { fs.writeFileSync(ledgerFile, json(entry), { flag: 'wx' }) } catch { die2(`sổ writer ${writerId} đã tồn tại — chạy lại`) }
  console.log(`QA kết quả · run ${m.runId} · đích ${m.host} · chương trình ${mask(programId)} · ${staff.value.length} staff QA · ${rows.length} dòng bán GIẢ · writer ${writerId}`)

  const deadlineAt = mono() + R.CMS_QA_WRITER_BUDGET_MS
  const clock = { now: mono, workUntil: deadlineAt - core.CMS_SALES_STOP_RESERVE_MS, minStartMs: core.CMS_RPC_START_MIN_MS }
  const deps = R.cmsQaGuardedDeps({ ...real, now: mono, table: R.CMS_QA_FAKE_TABLE, runner: fixture.createCmsFixtureRunner({ sales: rows }) }, guard, {
    clock, tag: { qaRunId: m.runId, writerId },
    // Ghi run_id vào sổ NGAY khi nhận (trước stage); lỗi ⇒ CMS_QA_LEDGER_FAILED, lõi dừng, run thu hồi bằng reconcile.
    onOpened: async (runId) => { entry = { ...entry, openedRunId: runId }; writeAtomic(ledgerFile, entry) },
  })
  let r
  try {
    // Capture lớp nguồn (124) theo cờ CMS_SOURCE_CAPTURE_ENABLED (lib/cms/flags.ts cmsSourceCaptureFromEnv) — lõi vẫn đòi
    // run_open trả source_schema = 1 (thiếu ⇒ đóng run SOURCE_SCHEMA_UNSUPPORTED; run_id đã vào sổ qua onOpened).
    r = await core.runCmsSalesSync(deps, programId, { dryRun: false, source: R.CMS_QA_WRITER_SOURCE, deadlineAt,
      sourceCapture: process.env.CMS_SOURCE_CAPTURE_ENABLED === 'true' })
  } catch (e) {
    rethrowCliExit(e)
    r = { status: 'error', code: 'INTERNAL', runId: null, stagedRows: 0, rowsRead: null, candidates: null, included: null, unassigned: null }
  }
  const outcome = R.cmsQaWriterOutcome(r)
  entry = { ...entry, status: outcome, finishedAt: new Date().toISOString(), result: {
    status: r.status, code: r.code, runId: r.runId, stagedRows: r.stagedRows, rowsRead: r.rowsRead,
    candidates: r.candidates, included: r.included, unassigned: r.unassigned, sourceRows: r.sourceRows ?? null,
  } }
  let saved = true
  try { writeAtomic(ledgerFile, entry) } catch (e) { rethrowCliExit(e); saved = false }
  console.log(JSON.stringify({ status: r.status, code: r.code, runId: r.runId, rowsRead: r.rowsRead, candidates: r.candidates,
    included: r.included, unassigned: r.unassigned, stagedRows: r.stagedRows, sourceRows: r.sourceRows ?? null, ledger: saved ? outcome : 'NOT_SAVED',
    guard: r.code === R.CMS_QA_GUARD_LOST ? guardReasons : undefined }))
  if (!saved) {
    // Ledger cuối không lưu được ⇒ KHÔNG báo thành công trọn lượt; publish CÓ THỂ đã thành công — không tự publish lại.
    console.log(`SỔ WRITER CHƯA ĐÓNG: không ghi được ${writerId} (vẫn running trên đĩa) — kết quả ${r.status}${r.code ? ` ${r.code}` : ''} có thể đã công bố; close sẽ đòi \`reconcile --writer=${writerId}\``)
    return 1
  }
  if (outcome === 'unknown') {
    console.log(`KẾT QUẢ KHÔNG RÕ (${r.code}) — run có thể đã ghi / công bố; chạy \`node scripts/cms-qa-results.mjs reconcile --writer=${writerId}\` trước close`)
    return 1
  }
  return r.status === 'published' && r.code === null ? 0 : 1
}

await runCli(main)
