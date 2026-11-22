// CMS P4-A (PM 22/11 §3 A3) — BÁO CÁO TRẢ HÀNG SAU CHỐT cho chương trình QA, bằng PHIÊN SUPER, có sổ. Lõi thuần: e2e/cmsQaReport.ts.
//
//   CMS_SUPER_ACCESS_TOKEN=<access token phiên super QA — biến PROCESS, KHÔNG trong .env.local, KHÔNG trên dòng lệnh>
//   E2E_CMS_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> CMS_CALC_MODES_ENABLED=true CMS_RETURNS_ENABLED=true
//   CMS_BQ_SALES_TABLE=<view bán> CMS_BQ_RETURNS_TABLE=<view trả>
//   node scripts/cms-qa-report.mjs report --program=<uuid QA đã chốt> --payout-run=<uuid run chốt> --confirm-run=<runId QA đang mở>
//       --reason="<10–500 ký tự>" [--profile=<net_returns_v1|full_line_qty_refund_v1>] [--write --idem=<uuid operator cấp> --expect-host=<host>]
//   node scripts/cms-qa-report.mjs status --confirm-run=<runId>
//   node scripts/cms-qa-report.mjs reconcile --op=<r-…> --confirm-run=<runId>
//
// KHÔNG có thuật toán thứ hai: gọi nguyên lõi app lib/cms/returnsAfterClose.ts runCmsManualCloseReport (ghim run chốt → profile đã ghim →
// MỘT snapshot nguồn bán + trả ghim as_of → payload) với deps thật lib/cms/server/returnsAfterCloseDeps.ts; chỉ thay ba chỗ ngoài Next:
//   · quyền: uid = claim `sub` của token phiên, vai + email đọc từ DB qua allowlist super của app (canManageCms) — không nhận UUID actor
//     trên dòng lệnh; DB vẫn tự kiểm auth.uid() + is_super_admin() + chương trình đọc được bởi phiên (marker QA);
//   · năng lực DB: rpc_cms_capabilities đọc trực tiếp (bản app dùng React cache);
//   · LƯU: request PostgREST mang token phiên tới rpc_cms_return_close_report_save_super (không service_role cho bước ghi).
// Mặc định DRY-RUN: chạy hết lõi tới bước lưu rồi dừng (0 ghi DB, 0 sổ) — in số phiếu + sha payload. --write: guard run QA hai pha (cùng
// lõi cmsAttestQaGuard: manifest không đổi byte, Git đúng candidate, launcher còn sống + còn canh, chương trình is_test đã chốt thuộc run,
// marker super còn hạn) → ghi Ý ĐỊNH vào sổ r-….json (độc quyền) → gửi. Mất phản hồi ⇒ KHÔNG RÕ (rc 1), KHÔNG gửi lại; reconcile đọc DB
// theo đúng (chương trình, khoá yêu cầu). Thao tác chưa khép của chương trình ⇒ chặn lệnh ghi mới. Gọi lại CÙNG --idem sau khi đã lập ⇒
// DB trả báo cáo đã có (already) — không tạo báo cáo thứ hai. Cờ / view là biến PROCESS của lệnh (không sửa .env.local / container / cron).
// Chỉ chương trình is_test trong run QA đang mở; không có chế độ vận hành cho chương trình thật (đường thật = cron / form super trên app).
// Mã thoát: 0 đạt · 1 bị chặn / từ chối / không rõ · 2 sai tham số / điều kiện.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CliExit, ROOT, die2, loadTooling, mergedEnv, parseArgs, pgMeta, pidAlive, portOpen, readEnvFileText, readHeartbeatText, rethrowCliExit, runCli, supabaseHost } from './lib-cms-ops.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INTERNAL = 'CMS_QA_REPORT_INTERNAL'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const json = (o) => JSON.stringify(o, null, 2) + '\n'
const writeAtomic = (file, obj) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, json(obj)); fs.renameSync(tmp, file) }
/** operationId khi đã ghi Ý ĐỊNH (request có thể đã gửi) — entrypoint nhắc reconcile nếu lỗi ngoài dự kiến sau đó. */
let pendingIntent = null

async function main() {
  const a = parseArgs(process.argv.slice(2), {
    flags: ['--write'],
    values: ['--program', '--payout-run', '--profile', '--reason', '--idem', '--expect-host', '--confirm-run', '--op'],
  })
  if (!['report', 'status', 'reconcile'].includes(a.cmd) || a.bad.length) {
    console.log('dùng: node scripts/cms-qa-report.mjs <report --program=<uuid> --payout-run=<uuid> --confirm-run=<runId> --reason="…" [--profile=…] [--write --idem=<uuid> --expect-host=<host>] | status --confirm-run=<runId> | reconcile --op=<r-…> --confirm-run=<runId>>')
    return 2
  }
  const { T, G, R, A, P } = await loadTooling()
  const envFileText = readEnvFileText()
  if (envFileText && new RegExp(`^\\s*(?:export\\s+)?${A.CMS_ATTEST_TOKEN_ENV}=`, 'm').test(envFileText)) {
    die2(`KHÔNG đặt ${A.CMS_ATTEST_TOKEN_ENV} trong .env.local — xoá dòng đó; token chỉ là biến PROCESS của lệnh`)
  }
  // Cờ + view của lượt: biến PROCESS (kiểm TRƯỚC khi chép .env.local vào process) — cùng luật writer nguồn bq.
  if (a.cmd === 'report') {
    const pe = R.cmsQaBqSourceEnvCheck(process.env, envFileText)
    if (!pe.ok) die2(pe.reason.replace('--source=bq', 'report'))
  }
  const env = mergedEnv(envFileText)
  const host = supabaseHost(env)
  if (!host) die2('thiếu / sai NEXT_PUBLIC_SUPABASE_URL')
  if (!env.SUPABASE_SERVICE_ROLE_KEY) die2('thiếu SUPABASE_SERVICE_ROLE_KEY (đọc chỉ đọc qua pg-meta)')
  const mask = T.maskCmsUuid
  const ro = (q, opts) => pgMeta(env, T.pgMetaReadOnly(q), opts)

  // ── Run QA đang mở (bắt buộc — không có chế độ vận hành) ──
  const qaRun = a.values['--confirm-run']
  const MARKER = path.join(ROOT, G.CMS_QA_MARKER)
  const markerText = fs.existsSync(MARKER) ? fs.readFileSync(MARKER, 'utf8') : null
  const mp = markerText !== null ? T.parseCmsQaManifest(markerText) : null
  if (!mp || !mp.ok || mp.value.status !== 'open') die2(`không có run QA đang mở (${G.CMS_QA_MARKER})`)
  const m = mp.value
  if (!qaRun) die2(`thiếu --confirm-run=<runId> (run đang mở: ${m.runId})`)
  if (qaRun !== m.runId) die2(`--confirm-run (${qaRun}) khác run đang mở (${m.runId})`)
  if (host !== m.host) die2(`host hiện tại (${host}) khác host của run (${m.host})`)
  const ledgerDir = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${m.runId}.writers`)
  const listOps = () => (fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter((f) => /^r-[0-9a-f]{12}\.json$/.test(f)).sort() : [])
  const readOp = (f) => P.parseCmsQaReportOp(fs.readFileSync(path.join(ledgerDir, f), 'utf8'))

  if (a.cmd === 'status') {
    const files = listOps()
    console.log(`sổ báo cáo sau chốt · run QA ${m.runId} · ${files.length} thao tác`)
    for (const f of files) {
      const p = readOp(f)
      if (!p.ok) { console.log(`  ${f}: HỎNG (${p.reason})`); continue }
      const e = p.value
      const landed = P.cmsQaReportLanded(e)
      console.log(`  ${e.operationId} · ${e.status}${e.status === 'intent' ? (pidAlive(e.pid) ? ' (pid sống)' : ' (pid KHÔNG còn — cần reconcile)') : ''} · chương trình ${mask(e.programId)} · run chốt ${mask(e.payoutRunId)} · ${e.payload.returns} phiếu · ${e.result?.code ?? (landed ? `báo cáo ${mask(landed)}${e.result?.saved === 'already' ? ' (đã có)' : ''}` : '—')} · ${e.startedAt}`)
    }
    return 0
  }

  if (a.cmd === 'reconcile') {
    const oid = a.values['--op']
    if (!oid || !P.CMS_QA_REPORT_OP_ID_RE.test(oid)) die2('cần --op=<r-… từ `status`>')
    const file = path.join(ledgerDir, `${oid}.json`)
    if (!fs.existsSync(file)) die2(`không có sổ ${oid}`)
    const p = P.parseCmsQaReportOp(fs.readFileSync(file, 'utf8'))
    if (!p.ok) die2(`sổ ${oid} hỏng (${p.reason}) — không sửa tay; báo PM / operator`)
    const e = p.value
    if (e.qaRunId !== m.runId) die2(`sổ ${oid} thuộc run khác`)
    if (e.host !== host) die2(`sổ ${oid} ghi cho host ${e.host} ≠ host hiện tại ${host}`)
    try {
      if ((await ro(P.CMS_QA_HAS_REPORTS_SQL))[0]?.has_reports !== true) { console.log('KHÔNG RECONCILE: DB chưa có bảng báo cáo sau chốt / cột khoá yêu cầu (trước 132)'); return 1 }
      const probe = (await ro(P.CMS_QA_REPORT_INFLIGHT_SQL))[0]
      const rows = await ro(P.cmsQaReportReconcileSql(e))
      const c = P.cmsQaReportReconcileCheck(e, rows, { nowMs: Date.now(), pidAlive: pidAlive(e.pid), probe })
      if (!c.ok) { console.log(`${c.wait ? 'CHỜ' : 'KHÔNG RECONCILE'}: ${c.reason}`); return 1 }
      writeAtomic(file, { ...e, status: 'reconciled', finishedAt: e.finishedAt ?? new Date().toISOString(), reconcile: { at: new Date().toISOString(), found: c.found, reportId: c.reportId } })
      console.log(`${oid} ⇒ reconciled · ${c.found ? `ĐÃ LẬP (báo cáo ${mask(c.reportId)}) — mất phản hồi sau commit` : `CHƯA LẬP — gọi lại bằng CÙNG --idem=${e.idemKey} và cùng tham số`}`)
      return 0
    } catch (err) {
      rethrowCliExit(err)
      console.log('LỖI: không đọc được DB để reconcile')
      return 1
    }
  }

  // ── report: tham số → token → gate → guard preflight ──
  const programId = a.values['--program']
  if (!programId || !UUID_RE.test(programId)) die2('cần --program=<uuid chương trình QA đã chốt>')
  const payoutRunId = a.values['--payout-run']
  if (!payoutRunId || !UUID_RE.test(payoutRunId)) die2('cần --payout-run=<uuid run chốt> (ghim — DB đổi run chốt ⇒ dừng)')
  const profile = a.values['--profile'] ?? null
  if (profile !== null && !P.CMS_QA_REPORT_PROFILES.includes(profile)) die2(`--profile chỉ nhận ${P.CMS_QA_REPORT_PROFILES.join(' | ')}`)
  const reason = a.values['--reason']
  if (typeof reason !== 'string' || !reason.trim()) die2('cần --reason="<10–500 ký tự>"')
  const write = a.flags.has('--write')
  let idem
  if (write) {
    idem = a.values['--idem']
    if (!idem || !UUID_RE.test(idem)) die2('--write cần --idem=<uuid> do operator cấp (giữ lại để gọi lại khi mất phản hồi — công cụ KHÔNG tự sinh khoá)')
    if (a.values['--expect-host'] !== host) die2(`--write cần --expect-host=${host} khớp đúng host Supabase đích (chống ghi nhầm DB)`)
  } else {
    if (a.values['--idem'] !== undefined || a.values['--expect-host'] !== undefined) die2('--idem / --expect-host chỉ dùng cùng --write')
    idem = crypto.randomUUID() // dry-run: khoá tạm cho lõi kiểm đầu vào — không bao giờ tới DB
  }
  const claims = A.cmsAttestTokenClaims(process.env[A.CMS_ATTEST_TOKEN_ENV], Date.now())
  if (!claims.ok) die2(claims.reason)
  const actorId = claims.value.sub
  const token = process.env[A.CMS_ATTEST_TOKEN_ENV]
  const gate = G.cmsQaWriterGate({ env, envFileText, markerExists: true })
  if (!gate.ok) die2(gate.reason)

  const mono = R.cmsQaMonoClock()
  const gitEnv = { ...process.env }
  delete gitEnv[A.CMS_ATTEST_TOKEN_ENV] // tiến trình con không kế thừa token
  const guardDeps = {
    now: mono,
    manifestText: () => { try { return fs.existsSync(MARKER) ? fs.readFileSync(MARKER, 'utf8') : null } catch { return null } },
    parseManifest: (text) => { const p = T.parseCmsQaManifest(text); return p.ok ? p.value : null },
    git: () => {
      try {
        const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: gitEnv }).trim()
        return { treeClean: T.cmsQaTreeState(git(...T.CMS_QA_GIT_STATUS_ARGS)).clean, gitHead: git('rev-parse', 'HEAD'), gitTree: git('rev-parse', 'HEAD^{tree}') }
      } catch { return null }
    },
    pidAlive, portOpen, heartbeatText: readHeartbeatText, wallNow: () => Date.now(),
    read: (sql, timeoutMs) => ro(sql, { signal: AbortSignal.timeout(timeoutMs) }),
  }
  // Cùng lõi guard của CLI chứng nhận; chỉ khác: chương trình phải ĐÃ CHỐT (locked).
  const guardIo = (deadlineAt) => A.cmsAttestQaGuard(guardDeps, { manifestText: markerText, manifest: m, confirmRun: qaRun, host, actorId, programId, deadlineAt, statuses: ['locked'] })
  const guardBlocked = (step, g) => {
    for (const r of g.reasons) console.log(`CHẶN (${step}): ${r}`)
    console.log(`${g.code} — không gửi request ghi`)
    return g.code === 'GUARD_BLOCKED' ? 2 : 1
  }
  {
    const g = (await guardIo(mono() + A.CMS_ATTEST_QA_BUDGET_MS)).final()
    if (!g.ok) return guardBlocked('preflight', g)
  }

  // ── Sổ: khoá theo chương trình + thao tác chưa khép + dùng lại khoá ──
  fs.mkdirSync(ledgerDir, { recursive: true })
  const lockFile = path.join(ledgerDir, `.lock-report-${programId}`)
  const takeLock = () => {
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); return true } catch { /* có khoá */ }
    const holder = Number(fs.readFileSync(lockFile, 'utf8').trim())
    if (pidAlive(holder)) return false
    fs.rmSync(lockFile, { force: true }) // khoá mồ côi (pid đã chết)
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); return true } catch { return false }
  }
  if (!takeLock()) die2('thao tác báo cáo khác của chương trình này đang chạy — chờ xong')
  try {
    const parsed = listOps().map((f) => readOp(f))
    if (parsed.some((p) => !p.ok)) { console.log('CHẶN: có sổ báo cáo hỏng trong run — không sửa tay; báo PM / operator'); return 1 }
    const ops = parsed.map((p) => p.value)
    const pending = P.cmsQaReportPendingOps(ops, programId)
    if (pending.length) {
      for (const e of pending) console.log(`CHẶN: thao tác ${e.operationId} của chương trình này còn ${e.status} — chạy \`node scripts/cms-qa-report.mjs reconcile --op=${e.operationId} --confirm-run=${m.runId}\` trước`)
      return 1
    }
    if (write) {
      const reuse = P.cmsQaReportIdemReuse(ops, { idemKey: idem, programId, payoutRunId, actorId })
      if (reuse) die2(reuse)
    }

    // ── Lõi app + deps thật (jiti, ngoài Next) ──
    for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined && v !== undefined) process.env[k] = v
    delete process.env.SUPABASE_INTERNAL_URL
    const { createJiti } = await import('jiti')
    const jiti = createJiti(import.meta.url, { alias: { '@': ROOT, 'server-only': path.join(HERE, 'cms-server-only-stub.mjs') }, interopDefault: true })
    const core = await jiti.import(path.join(ROOT, 'lib/cms/returnsAfterClose.ts'))
    const depsMod = await jiti.import(path.join(ROOT, 'lib/cms/server/returnsAfterCloseDeps.ts'))
    const access = await jiti.import(path.join(ROOT, 'lib/cms/access.ts'))
    const capsMod = await jiti.import(path.join(ROOT, 'lib/cms/calc/capabilities.ts'))
    const admin = (await jiti.import(path.join(ROOT, 'lib/supabase/admin.ts'))).supabaseAdmin
    const real = depsMod.cmsReturnsAfterCloseDeps(process.env)
    if (!real.provider) { console.log('CHẶN: thiếu view nguồn (CMS_BQ_SALES_TABLE / CMS_BQ_RETURNS_TABLE)'); return 2 }

    const base = String(env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/$/, '')
    const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!anon) die2('thiếu NEXT_PUBLIC_SUPABASE_ANON_KEY')
    const operationId = `r-${crypto.randomBytes(6).toString('hex')}`
    const file = path.join(ledgerDir, `${operationId}.json`)
    let entry = null   // có ⇔ đã ghi Ý ĐỊNH (request lưu đã / sắp gửi)
    let sent = null    // kết cục request (A.cmsAttestRpcOutcome)
    let seen = null    // { sha256, returns, asOfMicros } của payload lõi dựng
    let guardCode = null

    const job = {
      ...real,
      capsOk: async (prof, manual) => {
        try {
          const { data, error } = await admin.rpc('rpc_cms_capabilities').abortSignal(AbortSignal.timeout(30_000))
          if (error) return false
          const caps = capsMod.parseCmsCapabilities(data)
          return caps.paths.close_report && (prof !== 'full_line_qty_refund_v1' || caps.paths.full_line) && (!manual || caps.paths.manual_report)
        } catch { return false }
      },
      // LƯU: chỉ đường thủ công (phiên super). Mọi nhánh khác ⇒ không gửi gì.
      save: async (pid, runId, payload, manual) => {
        if (!manual || pid !== programId || runId !== payoutRunId || manual.request !== idem) return { ok: false, code: P.CMS_QA_REPORT_GUARD }
        const body = JSON.stringify(payload)
        const pin = payload && typeof payload.pin === 'object' && payload.pin !== null ? payload.pin : {}
        const dg = pin.returns && typeof pin.returns === 'object' ? pin.returns.digest : null
        seen = { sha256: P.cmsQaReportSha(body), returns: Array.isArray(payload?.returns) ? payload.returns.length : 0,
          asOf: typeof pin.as_of === 'string' && pin.as_of.length <= 40 ? pin.as_of : null, returnsDigest: typeof dg === 'string' && /^[0-9a-f]{64}$/.test(dg) ? dg : null }
        if (!write) return { ok: false, code: P.CMS_QA_REPORT_DRY_RUN }
        // Ngân sách đặt TRƯỚC guard; guard IO → bước cuối ĐỒNG BỘ → ghi ý định (đồng bộ, độc quyền) → gửi — không await xen giữa.
        const deadlineAt = mono() + A.CMS_ATTEST_QA_BUDGET_MS
        const g = (await guardIo(deadlineAt)).final()
        if (!g.ok) { guardCode = g; return { ok: false, code: P.CMS_QA_REPORT_GUARD } }
        let intent
        try {
          intent = P.newCmsQaReportOp({ operationId, qaRunId: m.runId, host, pid: process.pid, programId, payoutRunId, profile, idemKey: idem,
            reasonSha256: P.cmsQaReportSha(manual.reason), actorId, payload: seen, startedAt: new Date().toISOString() })
          fs.writeFileSync(file, json(intent), { flag: 'wx' })
        } catch { return { ok: false, code: P.CMS_QA_REPORT_LEDGER } }
        entry = intent
        pendingIntent = operationId
        const timeoutMs = R.cmsQaIoTimeoutMs(A.CMS_ATTEST_RPC_TIMEOUT_MS, deadlineAt - mono(), 1_000)
        let status = null, rbody = null, transportError = false
        try {
          const r = await fetch(`${base}/rest/v1/rpc/rpc_cms_return_close_report_save_super`, {
            method: 'POST', signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({ p_program_id: programId, p_payout_run_id: payoutRunId, p_payload: payload, p_reason: manual.reason, p_request: idem }),
            headers: { apikey: anon, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          })
          status = r.status
          try { rbody = await r.json() } catch { rbody = null }
        } catch { transportError = true }
        sent = A.cmsAttestRpcOutcome({ transportError, status, body: rbody })
        return sent.kind === 'ok' ? { ok: true, data: sent.data } : { ok: false, code: sent.code }
      },
    }
    const deps = {
      enabled: () => true, // CMS_RETURNS_ENABLED=true đã kiểm ở PROCESS env
      qaReadonly: () => false, // đường báo cáo QA DUY NHẤT có gate + sổ ý định
      access: async () => {
        const rows = await ro(R.cmsQaActorSql(actorId), { signal: AbortSignal.timeout(30_000) })
        const u = rows[0]
        return u && access.canManageCms(u.role, u.email) ? { kind: 'ok', actorId, qa: true } : { kind: 'forbidden' }
      },
      manualProgram: (id) => real.manualProgram(id),
      job: () => job,
    }

    console.log(`QA báo cáo sau chốt · ${write ? 'GHI' : 'DRY-RUN'} · run ${m.runId} · đích ${host} · chương trình ${mask(programId)} · run chốt ${mask(payoutRunId)} · người ${mask(actorId)}${write ? ` · thao tác ${operationId}` : ''}`)
    const r = await core.runCmsManualCloseReport(deps, { programId, payoutRunId, profile, reason, idem })

    if (!entry) {
      // Không có Ý ĐỊNH trong sổ ⇒ CHƯA gửi request lưu nào.
      if (!write && !r.ok && r.code === P.CMS_QA_REPORT_DRY_RUN && seen) {
        console.log(JSON.stringify({ dryRun: true, returns: seen.returns, asOf: seen.asOf, returnsDigest: seen.returnsDigest, payloadSha256: seen.sha256 }))
        console.log(`DRY-RUN đạt (0 ghi) — ghi bằng: (cùng tham số) --write --idem=<uuid mới, LƯU LẠI> --expect-host=${host}`)
        return 0
      }
      if (guardCode) return guardBlocked('trước ghi', guardCode)
      console.log(`CHẶN (không gửi request lưu): ${r.ok ? 'INTERNAL' : r.code}`)
      if (!r.ok && r.code === P.CMS_QA_REPORT_LEDGER && fs.existsSync(file)) console.log(`sổ ${operationId} có thể ghi dở — close sẽ ĐỎ; báo PM / operator, không xoá tay`)
      return 1
    }
    // Đã ghi ý định ⇒ khép sổ theo kết cục REQUEST (không theo mã lõi): thiếu kết cục = không rõ.
    const oc = sent ? P.cmsQaReportOutcome(sent) : { status: 'unknown', result: { code: 'NO_OUTCOME', saved: null, reportId: null } }
    entry = { ...entry, status: oc.status, finishedAt: new Date().toISOString(), result: oc.result }
    let saved = true
    try { writeAtomic(file, entry) } catch (e) { rethrowCliExit(e); saved = false }
    if (saved) pendingIntent = null
    // Đọc lại báo cáo (CHỈ ĐỌC) để in số đối chiếu: tiền đóng băng / tính lại / chênh, mốc + digest nguồn trả. Lỗi đọc không đổi kết cục.
    let row = null
    if (oc.status === 'done') {
      try {
        row = (await ro(`SELECT r.frozen_amount::text AS frozen, r.recomputed_amount::text AS recomputed, r.delta_amount::text AS delta, r.returns_digest AS digest,
          r.returns_as_of::text AS as_of, r.created_via FROM public.cms_return_close_reports r WHERE r.id = '${oc.result.reportId}'::uuid AND r.program_id = '${programId}'::uuid`,
        { signal: AbortSignal.timeout(30_000) }))[0] ?? null
      } catch (e) { rethrowCliExit(e); row = null }
    }
    console.log(JSON.stringify({ status: oc.status, code: oc.result.code, saved: oc.result.saved, report: oc.result.reportId ? mask(oc.result.reportId) : null,
      returns: seen?.returns ?? null, payloadSha256: seen?.sha256 ?? null, frozenVnd: row?.frozen ?? null, recomputedVnd: row?.recomputed ?? null, deltaVnd: row?.delta ?? null,
      returnsDigest: row?.digest ?? null, returnsAsOf: row?.as_of ?? null, operation: operationId, ledger: saved ? oc.status : 'NOT_SAVED' }))
    if (!saved) { console.log(`SỔ CHƯA ĐÓNG: không ghi được kết quả ${operationId} (sổ còn ý định) — có thể đã lập; KHÔNG gửi lại; chạy reconcile --op=${operationId} --confirm-run=${m.runId}`); return 1 }
    if (oc.status === 'unknown') { console.log(`KẾT QUẢ KHÔNG RÕ (${oc.result.code}) — có thể đã lập; KHÔNG dùng khoá mới, KHÔNG gửi lại; chạy reconcile --op=${operationId} --confirm-run=${m.runId} rồi (nếu chưa lập) gọi lại cùng --idem`); return 1 }
    if (oc.status === 'rejected') { console.log(`DB / lõi TỪ CHỐI (${oc.result.code}) — không lập báo cáo`); return 1 }
    return 0
  } finally {
    try { if (Number(fs.readFileSync(lockFile, 'utf8').trim()) === process.pid) fs.rmSync(lockFile) } catch { /* đã gỡ */ }
  }
}

// ── Biên lỗi entrypoint (cùng luật CLI chứng nhận): lỗi lạ ⇒ chỉ in mã cố định, rc 1; đã ghi ý định ⇒ sổ giữ nguyên, nhắc reconcile. ──
let internalHit = false
const internal = () => {
  internalHit = true
  console.log(`LỖI: ${INTERNAL} — lỗi ngoài dự kiến (không in chi tiết)`)
  if (pendingIntent) console.log(`sổ ${pendingIntent} còn ý định — KẾT QUẢ KHÔNG RÕ, có thể đã lập; KHÔNG dùng khoá mới; chạy reconcile --op=${pendingIntent}`)
}
process.on('unhandledRejection', () => { internal(); process.exitCode = 1 })
process.on('uncaughtException', () => { internal(); process.exitCode = 1 })
async function guardedMain() {
  let code
  try {
    code = await main()
  } catch (e) {
    if (e instanceof CliExit) { if (internalHit) return 1; throw e }
    internal()
    return 1
  }
  return internalHit ? 1 : code
}

await runCli(guardedMain)
