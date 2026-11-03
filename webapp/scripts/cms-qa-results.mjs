#!/usr/bin/env node
// CMS — writer KẾT QUẢ QA bằng dữ liệu bán GIẢ trên DB production, CÓ GATE (PM 03/11 review I4/P3/runbook REL-P1-1; quyết
// định operator: QA prod dùng bán giả gắn tài khoản QA, đối soát nguồn thật offline). OPERATOR-ONLY, chỉ BÊN TRONG run QA
// đang mở của launcher scripts/cms-qa-run.mjs. Dùng CHUNG lõi lib/cms/salesSync.ts + RPC thật của 122 (deps
// lib/cms/server/salesSyncDeps.ts); CHỈ thay nguồn bằng runner giả (e2e/cmsFixtureRunner.ts — cấm ở NODE_ENV=production) và
// bọc mọi bước ghi bằng guard. Không BigQuery, không cron / app production, không fallback.
//
//   E2E_CMS_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/cms-qa-results.mjs publish --program=<uuid QA>
//       --staff=<uuid staff QA,…> --confirm-run=<runId đang mở> [--lines-per-staff=30] [--unassigned]
//   node scripts/cms-qa-results.mjs status
//   E2E_CMS_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/cms-qa-results.mjs reconcile --writer=<w-…> [--finish-orphan]
//
// publish: gate PROCESS / host / .env.local (cmsQaWriterGate — manifest PHẢI mở) → runId gõ lại + host + candidate (cây sạch,
//   HEAD / tree = manifest) + launcher còn sống (cổng + pid) + staff là tài khoản QA vai staff của run → GUARD DB (chương trình
//   is_test, active, thuộc run; marker mọi tài khoản QA còn ≥ 10 phút) → sổ writer (ghi độc quyền) → lõi với guard trước
//   open / stage / seal / publish / cleanup → cập nhật sổ (atomic). Mất điều kiện giữa chừng ⇒ CMS_QA_GUARD_LOST: lõi đóng run
//   error (finish — đường thu hồi lỗi tối thiểu), pointer giữ nguyên.
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
import { ROOT, die2, loadTooling, mergedEnv, parseArgs, pgMeta, pidAlive, portOpen, readEnvFileText, rethrowCliExit, runCli, supabaseHost } from './lib-cms-ops.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function main() {
  const a = parseArgs(process.argv.slice(2), {
    flags: ['--unassigned', '--finish-orphan'],
    values: ['--program', '--staff', '--lines-per-staff', '--confirm-run', '--writer'],
  })
  if (!['publish', 'status', 'reconcile'].includes(a.cmd) || a.bad.length) {
    console.log('dùng: node scripts/cms-qa-results.mjs <publish --program=<uuid> --staff=<uuid,…> --confirm-run=<runId> [--lines-per-staff=N] [--unassigned] | status | reconcile --writer=<w-…> [--finish-orphan]>')
    return 2
  }
  const { T, G, R } = await loadTooling()
  const envFileText = readEnvFileText()
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

  if (a.cmd === 'status') {
    const m = readManifest()
    if (!m) { console.log('không có run QA CMS đang mở'); return 0 }
    const dir = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${m.runId}.writers`)
    const files = listLedger(dir)
    console.log(`run ${m.runId} · ${files.length} writer`)
    for (const f of files) {
      const p = R.parseCmsQaWriterEntry(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (!p.ok) { console.log(`  ${f}: HỎNG (${p.reason})`); continue }
      const e = p.value
      console.log(`  ${e.writerId} · ${e.status}${e.status === 'running' ? (pidAlive(e.pid) ? ' (pid sống)' : ' (pid KHÔNG còn — cần reconcile)') : ''} · chương trình ${mask(e.programId)} · ${e.result ? `${e.result.status}${e.result.code ? ` ${e.result.code}` : ''} run ${e.result.runId ? mask(e.result.runId) : '—'}` : '—'}`)
    }
    return 0
  }

  // ── Gate chung (publish / reconcile): biến PROCESS, host, .env.local, manifest PHẢI mở ──
  const gate = G.cmsQaWriterGate({ env, envFileText, markerExists: fs.existsSync(MARKER) })
  if (!gate.ok) die2(gate.reason)
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

  if (a.cmd === 'reconcile') {
    const wid = a.values['--writer']
    if (!wid || !/^w-[0-9a-f]{12}$/.test(wid)) die2('cần --writer=<w-… từ `status`>')
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
      const done = { ...e, status: 'reconciled', finishedAt: new Date().toISOString(),
        reconcile: { at: new Date().toISOString(), runs: linked.map((r) => ({ id: r.id, status: r.status, errorCode: r.error_code })), finishedOrphan } }
      writeAtomic(file, done)
      console.log(`writer ${wid} ⇒ reconciled · ${linked.length} run sales liên kết (${linked.map((r) => `${mask(r.id)} ${r.status}`).join(', ') || '—'})`)
      return 0
    } catch (e) {
      rethrowCliExit(e)
      console.log(`LỖI: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      return 1
    }
  }

  // ── publish ──
  const programId = a.values['--program']
  if (!programId || !UUID_RE.test(programId)) die2('cần --program=<uuid chương trình QA>')
  const staff = R.parseCmsQaStaffIds(a.values['--staff'])
  if (!staff.ok) die2(staff.reason)
  const lines = R.parseCmsQaLinesPerStaff(a.values['--lines-per-staff'])
  if (!lines.ok) die2(lines.reason)
  let treeClean = false, gitHead = '', gitTree = ''
  try {
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
    treeClean = T.cmsQaTreeState(git(...T.CMS_QA_GIT_STATUS_ARGS)).clean
    gitHead = git('rev-parse', 'HEAD')
    gitTree = git('rev-parse', 'HEAD^{tree}')
  } catch (e) { rethrowCliExit(e); die2('không đọc được Git') }
  // Launcher sống = pid LAUNCHER (nơi chạy canh marker) + pid server con + cổng (security review 03/11 P1-1).
  const launcherAlive = async () => m.port !== null && m.serverPid !== null && !m.serverNotStopped
    && Number.isInteger(m.launcherPid) && pidAlive(m.launcherPid) && pidAlive(m.serverPid) && await portOpen(m.port)
  const local = R.cmsQaWriterLocalCheck({
    manifest: m, confirmRun: a.values['--confirm-run'], host: supabaseHost(env), treeClean, gitHead, gitTree,
    launcherAlive: await launcherAlive(), staffIds: staff.value,
  })
  if (!local.ok) { for (const r of local.reasons) console.log(`CHẶN: ${r}`); return 2 }

  // Đồng hồ đơn điệu (performance) theo thang epoch ms — dùng chung cho lõi (deps.now) và guard: ngân sách guard + ghi.
  const mono = () => performance.timeOrigin + performance.now()
  // GUARD (PM 03/11 QA-P1-1): đọc DB TRƯỚC (timeout theo ngân sách còn lại), rồi SAU mọi IO kiểm lại manifest + launcher;
  // marker trừ bảo thủ thời gian từ lúc bắt đầu đọc tới khi kiểm xong. Không còn await giữa lần kiểm cuối và bước ghi.
  let guardReasons = []
  const guard = async (step, budgetMs = 60_000) => {
    guardReasons = []
    const t0 = mono()
    const sig = () => AbortSignal.timeout(Math.max(1_000, Math.min(30_000, budgetMs - (mono() - t0))))
    const programRows = await pgMeta(env, T.pgMetaReadOnly(R.cmsQaWriterProgramSql(programId, m.startedAt, uids)), { signal: sig() })
    const statusRows = await pgMeta(env, T.pgMetaReadOnly(T.cmsQaStatusSql(uids)), { signal: sig() })
    const cur = readManifest()
    if (!cur || cur.status !== 'open' || cur.runId !== m.runId || cur.serverNotStopped) guardReasons.push('manifest run không còn mở / đã đổi')
    else if (!(await launcherAlive())) guardReasons.push('launcher / server QA không còn chạy')
    else {
      const aged = R.cmsQaAgeStatusRows(statusRows, mono() - t0)
      const c = R.cmsQaWriterDbCheck({ manifest: cur, programId, programRows, statusRows: aged, guardMinutes: T.CMS_QA_GUARD_MINUTES_MIN })
      if (!c.ok) guardReasons.push(...c.reasons)
    }
    if (guardReasons.length) throw new Error(`guard ${step}`)
  }
  try { await guard('preflight') } catch (e) {
    rethrowCliExit(e)
    for (const r of guardReasons.length ? guardReasons : [e instanceof Error ? e.message.split('\n')[0] : String(e)]) console.log(`CHẶN: ${r}`)
    return 1
  }

  const { core, stage, depsMod, fixture } = await loadCore()
  const real = depsMod.cmsSalesSyncDeps(process.env)
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
    r = await core.runCmsSalesSync(deps, programId, { dryRun: false, source: R.CMS_QA_WRITER_SOURCE, deadlineAt })
  } catch (e) {
    rethrowCliExit(e)
    r = { status: 'error', code: 'INTERNAL', runId: null, stagedRows: 0, rowsRead: null, candidates: null, included: null, unassigned: null }
  }
  const outcome = R.cmsQaWriterOutcome(r)
  entry = { ...entry, status: outcome, finishedAt: new Date().toISOString(), result: {
    status: r.status, code: r.code, runId: r.runId, stagedRows: r.stagedRows, rowsRead: r.rowsRead,
    candidates: r.candidates, included: r.included, unassigned: r.unassigned,
  } }
  let saved = true
  try { writeAtomic(ledgerFile, entry) } catch (e) { rethrowCliExit(e); saved = false }
  console.log(JSON.stringify({ status: r.status, code: r.code, runId: r.runId, rowsRead: r.rowsRead, candidates: r.candidates,
    included: r.included, unassigned: r.unassigned, stagedRows: r.stagedRows, ledger: saved ? outcome : 'NOT_SAVED',
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
