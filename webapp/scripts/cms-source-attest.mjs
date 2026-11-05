#!/usr/bin/env node
// CMS 124 (COMP-INT §5.B) — CHỨNG NHẬN ĐỐI SOÁT NGUỒN bằng phiên authenticated SUPER. OPERATOR-ONLY. Lõi thuần: e2e/cmsSourceAttest.ts.
//
//   CMS_SUPER_ACCESS_TOKEN=<access token phiên super — biến PROCESS, KHÔNG đặt trong .env.local, KHÔNG trên dòng lệnh>
//   node scripts/cms-source-attest.mjs export-run --program=<uuid> --run=<uuid> --out=<file.csv NGOÀI Git> --expect-host=<host>
//       (--ledger-dir=<dir> | --confirm-run=<runId QA>)
//   node scripts/cms-source-attest.mjs attest --program=<uuid> --run=<uuid> --reference=<csv> --app=<csv> --evidence-meta=<json>
//       --ack="<lý do 10…1.000 ký tự>" (--ledger-dir=<dir NGOÀI Git> | --confirm-run=<runId QA>)
//       [--write --idem=<uuid operator cấp> --expect-host=<host Supabase đích>]
//   node scripts/cms-source-attest.mjs revoke --program=<uuid> --attestation=<uuid> --reason="<10…1.000 ký tự>" (--ledger-dir | --confirm-run)
//       [--write --idem=<uuid> --expect-host=<host>]
//   node scripts/cms-source-attest.mjs status (--ledger-dir | --confirm-run)
//   node scripts/cms-source-attest.mjs reconcile --op=<a-…> (--ledger-dir | --confirm-run)
//
// · export-run: đọc ĐỦ trang rpc_cms_run_source_export (run ghim, keyset theo byte, đếm = total trang đầu) ⇒ ghi <out>.partial rồi đổi
//   tên khi đủ; lỗi giữa chừng ⇒ xoá .partial của chính lượt này, không có file mang nhãn hoàn chỉnh. In sha256 + số dòng + phần `app`
//   của evidence-meta (<out>.app-side.json). Đây là SNAPSHOT, không phải chứng nhận. CSV CÓ EMAIL nhân viên ⇒ mỗi lần xuất ghi sổ x-….json
//   (uid phiên, chương trình, run, số dòng, sha256 — không email) TRƯỚC trang đầu và cập nhật khi xong / lỗi (security review P1-1);
//   cần --expect-host; không ghi đè file có sẵn (link độc quyền, không rename); xoá file sau khi đối soát.
// · attest: TÍNH LẠI compare-source trên ĐÚNG hai file (hash byte từ cùng buffer) + metadata; chỉ MATCH decision10 toàn kỳ / toàn SP
//   mới dựng payload. Mặc định DRY-RUN (in payload tóm tắt, không gọi DB ghi). --write: cần --idem do operator cấp (KHÔNG tự sinh) +
//   --expect-host đúng; ghi Ý ĐỊNH vào sổ (a-….json, độc quyền) TRƯỚC request; mất phản hồi ⇒ KHÔNG RÕ (rc 1) — reconcile đọc DB theo
//   đúng khoá idem; gọi lại chỉ bằng CÙNG --idem + cùng file (DB trả already).
// · revoke (r4 — PM COMPINT-P1-1): TRƯỚC khi chọn guard / dry-run / ý định / RPC, chứng nhận phải thuộc ĐÚNG --program: đọc chương trình /
//   run thật của chứng nhận (pg-meta chỉ đọc) rồi, sau guard preflight, lịch sử chứng nhận của --program bằng PHIÊN super
//   (rpc_cms_source_attestations — kiểm super + marker QA). Lệch ⇒ rc 2, 0 RPC ghi. Sổ revoke ghi cả run của chứng nhận.
// · Run QA (--confirm-run): chỉ chương trình is_test thuộc run, trong run đang mở (gate PROCESS / host / candidate / launcher / marker
//   như writer QA), actor (claim sub của token) phải là tài khoản QA vai admin của run; sổ nằm trong qa-artifacts/cms-qa/<run>.writers/
//   ⇒ close của launcher đối chiếu. Ngoài run QA (--ledger-dir): CẤM chương trình is_test.
//   Guard hai pha (r4 — PM COMPINT-P1-2, lõi cmsAttestQaGuard): preflight, TRƯỚC MỖI trang export và ngay trước ghi ý định / RPC ghi:
//   ngân sách đặt trước guard; đọc DB rồi thăm cổng; bước cuối ĐỒNG BỘ đọc lại manifest / Git / pid và trừ thời gian chờ khỏi marker;
//   không còn await giữa bước cuối và ghi ý định / gửi request; timeout request tính lại từ phần ngân sách còn lại.
// In: chế độ, host, id che, số đếm, hash — không email, không token, không lỗi thô (r4 — PM COMPINT-P1-3: lỗi ngoài dự kiến tới
// entrypoint chỉ in mã CMS_ATTEST_INTERNAL, rc 1; đã ghi ý định ⇒ sổ giữ nguyên, nhắc reconcile). Thoát: 0 đạt · 1 DB từ chối / không
// rõ / không MATCH / guard không đọc được DB hoặc hết ngân sách · 2 sai tham số / gate / guard chặn (trước mọi IO ghi).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CliExit, ROOT, die2, loadTooling, mergedEnv, parseArgs, pgMeta, pidAlive, portOpen, readEnvFileText, rethrowCliExit, runCli, supabaseHost } from './lib-cms-ops.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INTERNAL = 'CMS_ATTEST_INTERNAL' // = A.CMS_ATTEST_INTERNAL (lõi có thể chưa nạp khi lỗi xảy ra)
const json = (o) => JSON.stringify(o, null, 2) + '\n'
const writeAtomic = (file, obj) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, json(obj)); fs.renameSync(tmp, file) }
/** operationId khi đã ghi Ý ĐỊNH (request ghi có thể đã gửi) — entrypoint nhắc reconcile nếu lỗi ngoài dự kiến sau đó. */
let pendingIntent = null

/** Thư mục cha gần nhất có `.git` ⇒ đường dẫn nằm trong một cây Git. */
function gitTreeOf(p) {
  let d = path.resolve(p)
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}
function inputFile(flag, p) {
  if (!p) die2(`thiếu ${flag}=<file>`)
  let real
  try { real = fs.realpathSync(path.resolve(p)) } catch { die2(`${flag}: không đọc được file`) }
  if (!fs.statSync(real).isFile()) die2(`${flag}: không phải file`)
  if (gitTreeOf(real)) die2(`${flag}: file nằm trong một cây Git — dữ liệu đối soát phải lưu NGOÀI Git`)
  return real
}

async function main() {
  const a = parseArgs(process.argv.slice(2), {
    flags: ['--write'],
    values: ['--program', '--run', '--out', '--reference', '--app', '--evidence-meta', '--ack', '--attestation', '--reason', '--idem',
      '--expect-host', '--confirm-run', '--ledger-dir', '--op'],
  })
  const CMDS = ['export-run', 'attest', 'revoke', 'status', 'reconcile']
  if (!CMDS.includes(a.cmd) || a.bad.length) {
    console.log('dùng: node scripts/cms-source-attest.mjs <export-run | attest | revoke | status | reconcile> … (xem đầu file)')
    return 2
  }
  const { T, G, R, A } = await loadTooling()
  const { createJiti } = await import('jiti')
  const jiti = createJiti(import.meta.url, { interopDefault: true })
  const envFileText = readEnvFileText()
  // Token chỉ là biến PROCESS (không lưu file) — có trong .env.local ⇒ chặn, bảo xoá.
  if (envFileText && new RegExp(`^\\s*(?:export\\s+)?${A.CMS_ATTEST_TOKEN_ENV}=`, 'm').test(envFileText)) {
    die2(`KHÔNG đặt ${A.CMS_ATTEST_TOKEN_ENV} trong .env.local — xoá dòng đó; token chỉ là biến PROCESS của lệnh`)
  }
  const env = mergedEnv(envFileText)
  const host = supabaseHost(env)
  if (!host) die2('thiếu / sai NEXT_PUBLIC_SUPABASE_URL')
  if (!env.SUPABASE_SERVICE_ROLE_KEY) die2('thiếu SUPABASE_SERVICE_ROLE_KEY (đọc chỉ đọc qua pg-meta)')
  const mask = T.maskCmsUuid
  const ro = (q, opts) => pgMeta(env, T.pgMetaReadOnly(q), opts)

  // ── Chế độ: run QA (--confirm-run) hoặc vận hành (--ledger-dir) ──
  const qaRun = a.values['--confirm-run']
  const ledgerArg = a.values['--ledger-dir']
  if ((qaRun === undefined) === (ledgerArg === undefined)) die2('cần ĐÚNG MỘT trong --confirm-run=<runId QA> | --ledger-dir=<thư mục sổ NGOÀI Git>')
  const MARKER = path.join(ROOT, G.CMS_QA_MARKER)
  let m = null, markerText = null, ledgerDir
  if (qaRun !== undefined) {
    markerText = fs.existsSync(MARKER) ? fs.readFileSync(MARKER, 'utf8') : null
    const p = markerText !== null ? T.parseCmsQaManifest(markerText) : null
    if (!p || !p.ok || p.value.status !== 'open') die2(`không có run QA đang mở (${G.CMS_QA_MARKER})`)
    m = p.value
    if (qaRun !== m.runId) die2(`--confirm-run (${qaRun}) khác run đang mở (${m.runId})`)
    if (host !== m.host) die2(`host hiện tại (${host}) khác host của run (${m.host})`)
    ledgerDir = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${m.runId}.writers`)
  } else {
    ledgerDir = path.resolve(ledgerArg)
    if (!fs.existsSync(ledgerDir) || !fs.statSync(ledgerDir).isDirectory()) die2('--ledger-dir: thư mục chưa tồn tại')
    if (gitTreeOf(fs.realpathSync(ledgerDir))) die2('--ledger-dir: sổ nằm trong một cây Git — chọn thư mục NGOÀI Git')
  }
  const listOps = () => (fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter((f) => /^a-[0-9a-f]{12}\.json$/.test(f)).sort() : [])
  const readOp = (f) => A.parseCmsAttestOp(fs.readFileSync(path.join(ledgerDir, f), 'utf8'))

  if (a.cmd === 'status') {
    const files = listOps()
    console.log(`sổ chứng nhận · ${m ? `run QA ${m.runId}` : 'vận hành'} · ${files.length} thao tác`)
    for (const f of files) {
      const p = readOp(f)
      if (!p.ok) { console.log(`  ${f}: HỎNG (${p.reason})`); continue }
      const e = p.value
      console.log(`  ${e.operationId} · ${e.op} ${e.status}${e.status === 'intent' ? (pidAlive(e.pid) ? ' (pid sống)' : ' (pid KHÔNG còn — cần reconcile)') : ''} · chương trình ${mask(e.programId)} · ${e.result?.code ?? (A.cmsAttestOpLanded(e) ? `id ${mask(A.cmsAttestOpLanded(e))}` : '—')}`)
    }
    const xs = fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter((x) => /^x-[0-9a-f]{12}\.json$/.test(x)).sort() : []
    console.log(`sổ xuất · ${xs.length} lần xuất lớp nguồn (CSV có email nhân viên)`)
    for (const x of xs) {
      const p = A.parseCmsAttestExportRecord(fs.readFileSync(path.join(ledgerDir, x), 'utf8'))
      if (!p.ok) { console.log(`  ${x}: HỎNG (${p.reason})`); continue }
      const e = p.value
      console.log(`  ${e.exportId} · ${e.status} · chương trình ${mask(e.programId)} · run ${mask(e.runId)} · người ${mask(e.actorId)} · ${e.rows ?? '—'} dòng · ${e.startedAt}`)
    }
    return 0
  }

  if (a.cmd === 'reconcile') {
    const oid = a.values['--op']
    if (!oid || !A.CMS_ATTEST_OP_ID_RE.test(oid)) die2('cần --op=<a-… từ `status`>')
    const file = path.join(ledgerDir, `${oid}.json`)
    if (!fs.existsSync(file)) die2(`không có sổ ${oid}`)
    const p = A.parseCmsAttestOp(fs.readFileSync(file, 'utf8'))
    if (!p.ok) die2(`sổ ${oid} hỏng (${p.reason}) — không sửa tay; báo PM / operator`)
    const e = p.value
    if ((m?.runId ?? null) !== e.qaRunId) die2(`sổ ${oid} thuộc chế độ / run khác`)
    if (e.host !== host) die2(`sổ ${oid} ghi cho host ${e.host} ≠ host hiện tại ${host} — dùng thư mục sổ riêng cho từng môi trường`)
    try {
      if ((await ro(A.CMS_QA_HAS_ATTEST_SQL))[0]?.has_attest !== true) { console.log('KHÔNG RECONCILE: DB chưa có cms_source_attestations (chưa chạy 124)'); return 1 }
      const probe = (await ro(A.CMS_ATTEST_INFLIGHT_SQL))[0]
      const rows = await ro(A.cmsAttestReconcileSql(e))
      const c = A.cmsAttestReconcileCheck(e, rows, { nowMs: Date.now(), pidAlive: pidAlive(e.pid), probe })
      if (!c.ok) { console.log(`${c.wait ? 'CHỜ' : 'KHÔNG RECONCILE'}: ${c.reason}`); return 1 }
      writeAtomic(file, { ...e, status: 'reconciled', finishedAt: e.finishedAt ?? new Date().toISOString(),
        reconcile: { at: new Date().toISOString(), found: c.found, attestationId: c.attestationId } })
      console.log(`${oid} ⇒ reconciled · ${c.found ? `ĐÃ GHI (${e.op === 'attest' ? 'chứng nhận' : 'thu hồi'} ${mask(c.attestationId)}) — mất phản hồi sau commit` : `CHƯA GHI — gọi lại bằng CÙNG --idem=${e.idemKey} và cùng file`}`)
      return 0
    } catch (err) {
      rethrowCliExit(err)
      console.log('LỖI: không đọc được DB để reconcile')
      return 1
    }
  }

  // ── export-run / attest / revoke: tham số → token → chương trình (+ đích revoke) → chế độ → guard QA ──
  const programId = a.values['--program']
  if (!programId || !UUID_RE.test(programId)) die2('cần --program=<uuid>')
  const write = a.flags.has('--write')
  if (a.cmd === 'export-run' && write) die2('export-run chỉ đọc — không nhận --write')
  const claims = A.cmsAttestTokenClaims(process.env[A.CMS_ATTEST_TOKEN_ENV], Date.now())
  if (!claims.ok) die2(claims.reason)
  const actorId = claims.value.sub
  const token = process.env[A.CMS_ATTEST_TOKEN_ENV]
  let idem = null
  if (write) {
    idem = a.values['--idem']
    if (!idem || !UUID_RE.test(idem)) die2('--write cần --idem=<uuid> do operator cấp (giữ lại để gọi lại khi mất phản hồi — công cụ KHÔNG tự sinh khoá)')
    if (a.values['--expect-host'] !== host) die2(`--write cần --expect-host=${host} khớp đúng host Supabase đích (chống ghi nhầm DB)`)
  } else if (a.cmd === 'export-run') {
    if (a.values['--idem'] !== undefined) die2('export-run không nhận --idem')
    if (a.values['--expect-host'] !== host) die2(`export-run cần --expect-host=${host} (xuất email nhân viên — xác nhận đúng DB nguồn)`)
  } else if (a.values['--idem'] !== undefined || a.values['--expect-host'] !== undefined) die2('--idem / --expect-host chỉ dùng cùng --write')
  let attestationId = null, revokeReason = null
  if (a.cmd === 'revoke') {
    attestationId = a.values['--attestation']
    if (!attestationId || !UUID_RE.test(attestationId)) die2('cần --attestation=<uuid chứng nhận cần thu hồi>')
    const { cmsNormalizeAck } = await jiti.import(path.join(ROOT, 'lib', 'cms', 'payoutView.ts'))
    revokeReason = cmsNormalizeAck(a.values['--reason'])
    if (revokeReason === null) die2('--reason: 10…1.000 ký tự sau khi bỏ khoảng trắng hai đầu')
  }

  let prog
  try { prog = A.parseCmsAttestProgram((await ro(A.cmsAttestProgramSql(programId)))[0]) } catch (e) { rethrowCliExit(e); console.log('LỖI: không đọc được chương trình'); return 1 }
  if (!prog) die2(`không có chương trình ${mask(programId)}`)
  // revoke: đích THẬT của chứng nhận (chương trình / run bất biến) phải là --program — TRƯỚC khi chọn guard QA / vận hành.
  let target = null
  if (a.cmd === 'revoke') {
    let rows
    try { rows = await ro(A.cmsAttestTargetSql(attestationId)) } catch (e) { rethrowCliExit(e); console.log('LỖI: không đọc được chứng nhận cần thu hồi'); return 1 }
    const t = A.cmsAttestRevokeTargetCheck({ programId, attestationId, rows })
    if (!t.ok) die2(`${t.code}: ${t.reason}`)
    target = t.target
  }
  if (m && !prog.isTest) die2('run QA chỉ thao tác chương trình is_test — chương trình này là THẬT')
  if (!m && prog.isTest) die2('chương trình QA (is_test) chỉ thao tác BÊN TRONG run QA (--confirm-run)')

  // Guard run QA (r4 — PM COMPINT-P1-2): lõi cmsAttestQaGuard, deps THẬT. Mọi đồng hồ = đồng hồ đơn điệu ms nguyên.
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
    pidAlive,
    portOpen,
    read: (sql, timeoutMs) => ro(sql, { signal: AbortSignal.timeout(timeoutMs) }),
  }
  /** Pha IO của guard với ngân sách đặt TRƯỚC guard; trả `final()` đồng bộ — gọi ngay trước bước gửi. */
  const guardIo = (deadlineAt) => A.cmsAttestQaGuard(guardDeps, { manifestText: markerText, manifest: m, confirmRun: qaRun, host, actorId, programId, deadlineAt })
  const guardBlocked = (step, g) => {
    for (const r of g.reasons) console.log(`CHẶN (${step}): ${r}`)
    console.log(`${g.code} — không gửi request${a.cmd === 'export-run' ? ' xuất' : ' ghi'}`)
    return g.code === 'GUARD_BLOCKED' ? 2 : 1
  }
  if (m) {
    // mọi thao tác trên chương trình QA (kể cả dry-run / xuất) — gate PROCESS như writer QA, rồi guard hai pha.
    const gate = G.cmsQaWriterGate({ env, envFileText, markerExists: fs.existsSync(MARKER) })
    if (!gate.ok) die2(gate.reason)
    const g = (await guardIo(mono() + A.CMS_ATTEST_QA_BUDGET_MS)).final()
    if (!g.ok) return guardBlocked('preflight', g)
  }

  const base = String(env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/$/, '')
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!anon) die2('thiếu NEXT_PUBLIC_SUPABASE_ANON_KEY')
  /** RPC bằng PHIÊN super (authenticated). Không in token / body lỗi thô. fetch được gọi ĐỒNG BỘ ngay khi gọi hàm. */
  const rpc = async (fn, args, timeoutMs) => {
    let status = null, body = null, transportError = false
    try {
      const r = await fetch(`${base}/rest/v1/rpc/${fn}`, {
        method: 'POST', body: JSON.stringify(args), signal: AbortSignal.timeout(timeoutMs),
        headers: { apikey: anon, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      })
      status = r.status
      try { body = await r.json() } catch { body = null }
    } catch { transportError = true }
    return A.cmsAttestRpcOutcome({ transportError, status, body })
  }
  /** Timeout request sau guard = min(timeout chuẩn, phần ngân sách còn lại) — không tự mở hạn mới. */
  const sendTimeout = (deadlineAt) => (m ? R.cmsQaIoTimeoutMs(A.CMS_ATTEST_RPC_TIMEOUT_MS, deadlineAt - mono(), 1_000) : A.CMS_ATTEST_RPC_TIMEOUT_MS)

  // revoke: lịch sử chứng nhận của --program qua PHIÊN super (super + marker QA) phải có đúng id + run của đích.
  if (a.cmd === 'revoke') {
    const h = await rpc('rpc_cms_source_attestations', { p_program_id: programId }, A.CMS_ATTEST_RPC_TIMEOUT_MS)
    if (h.kind !== 'ok') { console.log(`LỖI: không đọc được lịch sử chứng nhận bằng phiên super (${h.code}) — không thu hồi`); return 1 }
    const c = A.cmsAttestRevokeHistoryCheck(target, h.data)
    if (!c.ok) die2(`${c.code}: ${c.reason}`)
  }

  if (a.cmd === 'export-run') {
    const runId = a.values['--run']
    if (!runId || !UUID_RE.test(runId)) die2('cần --run=<uuid run đã công bố>')
    const outArg = a.values['--out']
    if (!outArg) die2('cần --out=<file.csv NGOÀI Git>')
    const out = path.resolve(outArg)
    if (!fs.existsSync(path.dirname(out))) die2('--out: thư mục chưa tồn tại')
    if (gitTreeOf(fs.realpathSync(path.dirname(out)))) die2('--out: đầu ra nằm trong một cây Git — ghi ra thư mục ngoài Git')
    const partial = `${out}.partial`
    if (fs.existsSync(out) || fs.existsSync(partial) || fs.existsSync(`${out}.app-side.json`)) die2('--out: file đã tồn tại — không ghi đè, chọn tên mới')
    if (runId !== prog.currentRunId) console.log('LƯU Ý: run không phải run hiện hành — chứng nhận chỉ nhận run hiện hành')
    // Sổ xuất x-….json ghi TRƯỚC trang đầu (dấu vết cả khi lỗi giữa chừng) — security review P1-1.
    fs.mkdirSync(ledgerDir, { recursive: true })
    const exportId = `x-${crypto.randomBytes(6).toString('hex')}`
    const xFile = path.join(ledgerDir, `${exportId}.json`)
    let xRec = A.newCmsAttestExportRecord({ exportId, qaRunId: m?.runId ?? null, host, pid: process.pid, programId, runId, actorId, startedAt: new Date().toISOString() })
    try { fs.writeFileSync(xFile, json(xRec), { flag: 'wx' }) } catch (e) { rethrowCliExit(e); die2(`không ghi được sổ xuất ${exportId} — chưa đọc dữ liệu`) }
    const xFail = (code) => { try { writeAtomic(xFile, { ...xRec, status: 'failed', finishedAt: new Date().toISOString(), code }) } catch { /* sổ còn started */ } }
    let st = A.newCmsAttestExportState(programId, runId)
    for (let after = null; ;) {
      // Chương trình QA: guard hai pha TRƯỚC MỖI trang (PM COMPINT-P1-2) — bước cuối đồng bộ rồi gửi ngay.
      let timeoutMs = A.CMS_ATTEST_RPC_TIMEOUT_MS
      if (m) {
        const dl = mono() + A.CMS_ATTEST_QA_BUDGET_MS
        const io = await guardIo(dl)
        const g = io.final()
        if (!g.ok) { xFail(g.code); console.log(`LỖI XUẤT: guard trang ${st.pages + 1} — không có file`); return guardBlocked(`trang ${st.pages + 1}`, g) }
        timeoutMs = sendTimeout(dl)
      }
      const o = await rpc('rpc_cms_run_source_export', { p_program_id: programId, p_run_id: runId, p_after_line_id: after, p_limit: A.CMS_ATTEST_PAGE_LIMIT }, timeoutMs)
      if (o.kind !== 'ok') { xFail(o.code); console.log(`LỖI XUẤT: ${o.code} (trang ${st.pages + 1}) — không có file`); return 1 }
      const pg = A.cmsAttestExportPage(st, o.data, A.CMS_ATTEST_PAGE_LIMIT)
      if (!pg.ok) { xFail(pg.code); console.log(`LỖI XUẤT: ${pg.code} (trang ${st.pages + 1}) — không có file`); return 1 }
      st = pg.state
      if (pg.done) break
      after = st.lastId
    }
    const csv = A.cmsAttestExportCsv(st.rows)
    const exportedAt = new Date().toISOString().replace(/(\.\d{3})Z$/, '$1000Z')
    try {
      fs.writeFileSync(partial, csv, { flag: 'wx', mode: 0o600 })
      // linkSync ⇒ EEXIST nếu --out vừa xuất hiện trong lúc phân trang (rename trên Windows sẽ ĐÈ âm thầm — security review P2-1).
      fs.linkSync(partial, out)
      fs.rmSync(partial)
    } catch (e) {
      rethrowCliExit(e)
      try { if (fs.existsSync(partial)) fs.rmSync(partial) } catch { /* file của chính lượt này */ }
      xFail('WRITE_FAILED')
      console.log('LỖI: không ghi được file xuất (đã có file trùng tên hoặc lỗi đĩa) — không ghi đè')
      return 1
    }
    const sha = crypto.createHash('sha256').update(Buffer.from(csv, 'utf8')).digest('hex')
    fs.writeFileSync(`${out}.app-side.json`, json(A.cmsAttestAppSide({ runId, exportedAt, fileSha256: sha, program: prog })), { flag: 'wx', mode: 0o600 })
    xRec = { ...xRec, status: 'done', finishedAt: new Date().toISOString(), rows: st.rows.length, sha256: sha }
    let xSaved = true
    try { writeAtomic(xFile, xRec) } catch (e) { rethrowCliExit(e); xSaved = false }
    console.log(JSON.stringify({ export: 'ok', program: mask(programId), run: mask(runId), rows: st.rows.length, pages: st.pages, sha256: sha,
      out: path.basename(out), appSide: path.basename(`${out}.app-side.json`), ledger: xSaved ? exportId : 'NOT_SAVED' }))
    // security review P2-2: mode 0o600 không có tác dụng trên Windows.
    console.log('LƯU Ý: file CSV có email nhân viên — chỉ để ở thư mục riêng (không OneDrive / Downloads / thư mục đồng bộ), XOÁ sau khi đối soát xong')
    return xSaved ? 0 : 1
  }

  // ── attest / revoke ──
  // Khoá theo chương trình (lock-file độc quyền, pid) — hai tiến trình ghi cùng chương trình không cùng vượt kiểm sổ (security review P2-6).
  fs.mkdirSync(ledgerDir, { recursive: true })
  const lockFile = path.join(ledgerDir, `.lock-${programId}`)
  const takeLock = () => {
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); return true } catch { /* có khoá */ }
    const holder = Number(fs.readFileSync(lockFile, 'utf8').trim())
    if (pidAlive(holder)) return false
    fs.rmSync(lockFile, { force: true }) // khoá mồ côi (pid đã chết)
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); return true } catch { return false }
  }
  if (!takeLock()) die2('thao tác chứng nhận khác của chương trình này đang chạy — chờ xong')
  try {
  const opsAll = listOps().map((f) => ({ f, p: readOp(f) }))
  if (opsAll.some((x) => !x.p.ok)) { console.log('CHẶN: có sổ chứng nhận hỏng — không sửa tay; báo PM / operator'); return 1 }
  if (opsAll.some((x) => x.p.value.host !== host)) die2('thư mục sổ có thao tác của host khác — dùng thư mục sổ riêng cho từng môi trường')
  const pending = A.cmsAttestPendingOps(opsAll.map((x) => x.p.value), programId)

  let op, args, expect, payloadSha = null, runId = null
  if (a.cmd === 'attest') {
    runId = a.values['--run']
    if (!runId || !UUID_RE.test(runId)) die2('cần --run=<uuid run hiện hành đã xuất>')
    const I = await jiti.import(path.join(ROOT, 'e2e', 'cmsI4Offline.ts'))
    const C = await jiti.import(path.join(ROOT, 'e2e', 'cmsI4CompareSource.ts'))
    const readOnce = (flag) => {
      const buf = fs.readFileSync(inputFile(flag, a.values[flag]))
      const r = I.cmsI4ReadCsv(new Uint8Array(buf), I.CMS_SALES_COLUMNS)
      if (!r.ok) die2(`${flag}: ${r.reason}`)
      return { rows: r.rows, sha256: crypto.createHash('sha256').update(buf).digest('hex') }
    }
    const ref = readOnce('--reference')
    const app = readOnce('--app')
    let metaJson
    try { metaJson = JSON.parse(fs.readFileSync(inputFile('--evidence-meta', a.values['--evidence-meta']), 'utf8')) } catch (e) { rethrowCliExit(e); die2('--evidence-meta: JSON không hợp lệ') }
    const meta = C.cmsI4ParseEvidenceMeta(metaJson)
    if (!meta.ok) die2(`--evidence-meta: ${meta.reason}`)
    const compare = C.cmsI4CompareSource({ context: A.cmsAttestContext(prog), reference: { rows: ref.rows, fileSha256: ref.sha256 },
      app: { rows: app.rows, fileSha256: app.sha256 }, meta: meta.value })
    const built = A.cmsAttestBuildPayload({ program: prog, runId, compare, meta: meta.value, refSha: ref.sha256, appSha: app.sha256, ack: a.values['--ack'] })
    console.log(JSON.stringify({ verdict: compare.verdict, matched: compare.compare.matched, missing: compare.compare.missing, extra: compare.compare.extra,
      changed: compare.compare.changed, decisionFp: compare.app.decisionFp, program: mask(programId), run: mask(runId), fieldSet: 'decision10' }))
    if (!built.ok) { for (const r of built.reasons) console.log(`KHÔNG CHỨNG NHẬN: ${r}`); return 1 }
    payloadSha = built.payloadSha256
    if (!write) {
      console.log(`DRY-RUN đạt — payload ${payloadSha.slice(0, 16)}…; ghi bằng: (cùng tham số) --write --idem=<uuid mới, LƯU LẠI> --expect-host=${host}`)
      return 0
    }
    op = 'attest'
    args = { p_program_id: programId, p_run_id: runId, p_payload: built.payload, p_idem: idem }
    expect = { runId }
  } else {
    runId = target.runId
    if (!write) { console.log(`DRY-RUN: thu hồi ${mask(attestationId)} (run ${mask(runId)}) của ${mask(programId)}; ghi bằng: (cùng tham số) --write --idem=<uuid mới, LƯU LẠI> --expect-host=${host}`); return 0 }
    op = 'revoke'
    args = { p_attestation_id: attestationId, p_reason: revokeReason, p_idem: idem }
    expect = { attestationId }
  }

  // Cùng khoá đã có trong sổ ⇒ chỉ cho gọi lại đúng thao tác (cùng nội dung, chương trình, run, chứng nhận); thao tác chưa khép khác ⇒ chặn tới reconcile.
  const same = opsAll.map((x) => x.p.value).find((e) => e.idemKey === idem)
  if (same && (same.op !== op || same.programId !== programId || same.payloadSha256 !== payloadSha
      || (same.runId !== null && same.runId !== runId) || (op === 'revoke' && same.attestationId !== attestationId))) {
    die2(`--idem đã dùng cho thao tác KHÁC (${same.operationId}) — không dùng lại khoá cho nội dung khác`)
  }
  const blocking = pending.filter((e) => e.idemKey !== idem)
  if (blocking.length) {
    for (const e of blocking) console.log(`CHẶN: thao tác ${e.operationId} của chương trình này còn ${e.status} — chạy reconcile --op=${e.operationId} trước`)
    return 1
  }
  const operationId = `a-${crypto.randomBytes(6).toString('hex')}`
  const file = path.join(ledgerDir, `${operationId}.json`)
  let entry = A.newCmsAttestOp({ operationId, op, qaRunId: m?.runId ?? null, host, pid: process.pid, programId, runId,
    attestationId: op === 'revoke' ? attestationId : null, idemKey: idem, payloadSha256: payloadSha, actorId, startedAt: new Date().toISOString() })
  // Chương trình QA: ngân sách đặt TRƯỚC guard; guard IO → bước cuối ĐỒNG BỘ → ghi ý định (đồng bộ) → gửi RPC — không await xen giữa.
  let deadlineAt = null
  if (m) {
    deadlineAt = mono() + A.CMS_ATTEST_QA_BUDGET_MS
    const io = await guardIo(deadlineAt)
    const g = io.final()
    if (!g.ok) return guardBlocked('trước ghi', g)
  }
  try { fs.writeFileSync(file, json(entry), { flag: 'wx' }) } catch { die2(`không ghi được sổ ${operationId} — chưa gửi request`) }
  pendingIntent = operationId
  const sent = rpc(op === 'attest' ? 'rpc_cms_source_attest' : 'rpc_cms_source_attest_revoke', args, sendTimeout(deadlineAt))
  console.log(`${op === 'attest' ? 'CHỨNG NHẬN' : 'THU HỒI'} · ${m ? `run QA ${m.runId}` : 'vận hành'} · đích ${host} · chương trình ${mask(programId)} · thao tác ${operationId}`)
  const o = await sent
  const reply = o.kind === 'ok' ? A.cmsAttestCheckReply(op, o.data, expect) : { ok: false }
  const outcome = A.cmsAttestOpOutcome(o, reply.ok)
  entry = { ...entry, status: outcome, finishedAt: new Date().toISOString(),
    result: { code: o.kind === 'ok' ? (reply.ok ? null : 'REPLY_MISMATCH') : o.code, attestationId: reply.ok ? reply.id : null, already: reply.ok ? reply.already : false } }
  let saved = true
  try { writeAtomic(file, entry) } catch (e) { rethrowCliExit(e); saved = false }
  if (saved) pendingIntent = null
  console.log(JSON.stringify({ status: outcome, code: entry.result.code, id: reply.ok ? mask(reply.id) : null, already: reply.ok ? reply.already : undefined,
    operation: operationId, ledger: saved ? outcome : 'NOT_SAVED' }))
  if (!saved) { console.log(`SỔ CHƯA ĐÓNG: không ghi được kết quả ${operationId} (sổ còn ý định) — có thể đã ghi; chạy reconcile --op=${operationId}`); return 1 }
  if (outcome === 'unknown') { console.log(`KẾT QUẢ KHÔNG RÕ (${entry.result.code}) — có thể đã ghi; KHÔNG dùng khoá mới; chạy reconcile --op=${operationId} rồi (nếu chưa ghi) gọi lại cùng --idem`); return 1 }
  return outcome === 'done' ? 0 : 1
  } finally {
    try { if (Number(fs.readFileSync(lockFile, 'utf8').trim()) === process.pid) fs.rmSync(lockFile) } catch { /* đã gỡ */ }
  }
}

// ── Biên lỗi entrypoint (PM COMPINT-P1-3) ───────────────────────────────────
// runCli chung in dòng đầu message của lỗi lạ — lỗi đọc file / ghi sổ có thể mang đường dẫn / email / marker. Ở CLI này: CliExit (mã
// chủ đích) đi tiếp; MỌI lỗi khác (Error / chuỗi / object / reject không bắt) ⇒ chỉ in mã cố định, rc 1. Đã ghi ý định mà chưa đóng
// sổ ⇒ sổ GIỮ NGUYÊN (chưa rõ kết quả), nhắc reconcile — không xoá / không đổi thành "chưa ghi". Không sửa lib chung (lib-cms-ops).
// security review r4 P2-1: lỗi nền (reject / exception không bắt) trong lúc main() vẫn trả 0 ⇒ runCli sẽ ghi đè exitCode ⇒ giữ cờ
// và ép mã 1 khi main trả về; lỗi nền SAU khi runCli đã đặt mã ⇒ handler đặt lại 1.
let internalHit = false
const internal = () => {
  internalHit = true
  console.log(`LỖI: ${INTERNAL} — lỗi ngoài dự kiến (không in chi tiết)`)
  if (pendingIntent) console.log(`sổ ${pendingIntent} còn ý định — KẾT QUẢ KHÔNG RÕ, có thể đã ghi; KHÔNG dùng khoá mới; chạy reconcile --op=${pendingIntent}`)
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
