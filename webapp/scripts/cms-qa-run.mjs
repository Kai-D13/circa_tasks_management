#!/usr/bin/env node
// CMS P1-R1 — launcher / preflight cho QA CMS ghi lên DB production qua server localhost (review PM runbook P1 02/11;
// r1 sau security / db review). QA tay cũng phải đi qua đây: cùng cmsWriteGate (e2e/writeQaGates.ts) với QA tự động;
// cờ CMS_PROGRAM_ENABLED chỉ bật trong process server do launcher dựng (không .env.local, không env production).
//
//   E2E_CMS_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/cms-qa-run.mjs start --users=<uuid,…> [--port=3120] [--min-ttl-minutes=60] [--guard-minutes=10] [--no-server]
//   node scripts/cms-qa-run.mjs status
//   E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/cms-qa-run.mjs close [--ack-warnings=<8 ký tự đầu id>,…]
//
// start: gate (opt-in process, host chính xác, không cờ trong .env.local, không manifest cũ) → cây Git sạch GỒM file chưa
//   track không bị ignore (HEAD / tree) → build standalone không cũ hơn HEAD (ghi BUILD_ID; chỉ là heuristic, bằng chứng
//   build đúng tree nộp riêng) → mọi tài khoản QA có marker còn ≥ N phút theo giờ DB → tạo manifest .qa-cms.json ĐỘC
//   QUYỀN (wx) → dựng server HOSTNAME=localhost với CMS_PROGRAM_ENABLED=true; cờ khác (vd. KPI_CAMPAIGN_ENABLED=true)
//   truyền bằng process env khi gọi, danh sách cờ *_ENABLED đang bật được in trước khi dựng.
//   CANH MARKER (createCmsQaWatchdog / startCmsQaWatchdogLoop): guard ≥ 10 phút (sàn); poll 60 s không chồng request;
//   HẠN DỪNG ĐỘC LẬP = lúc bắt đầu lần đọc tốt gần nhất + (min remaining − guard), tick 5 s không IO ⇒ dừng cả khi request
//   treo; mất marker / dưới ngưỡng / 3 lỗi đọc liên tiếp ⇒ dừng (marker hết hạn ⇒ chương trình tạo ra là THẬT).
//   --no-server KHÔNG có canh marker (chỉ cho spec tự động có preflight riêng).
// close: từ chối khi cổng server của run còn mở; đối chiếu DB — chương trình is_test trong run ghi vào manifest (để lại,
//   ẩn — H8); chương trình THẬT bị tài khoản QA chạm (theo mốc của chính hành động) ⇒ ĐỎ, giữ manifest mở; chương trình
//   thật đổi trong run không do QA ⇒ cảnh báo, CHẶN đóng tới khi operator soát tay và xác nhận đúng tập đó bằng
//   --ack-warnings (ghi vào manifest đóng). Đạt ⇒ lưu qa-artifacts/cms-qa/<runId>.json rồi mới gỡ .qa-cms.json.
// Không xoá manifest tay để bỏ qua close. sha256 manifest in ra ở start / close để nộp kèm bằng chứng.
// Thoát: 0 đạt · 1 preflight / đối chiếu DB không đạt / server QA dừng KHÔNG do operator (canh marker, tự chết, lỗi tiến
//   trình con) hoặc KHÔNG xác nhận được đã dừng (ghi serverNotStopped vào manifest ⇒ close chặn khi pid còn sống) · 2 sai
// tham số / gate (trước mọi IO tới DB). Kết thúc tự nhiên qua runCli (process.exitCode) — không process.exit (lỗi libuv
// Node 24 / Windows sau fetch, PM 02/11 B3); thân main() giữ thụt lề cũ để diff chỉ còn đường thoát.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { ROOT, die2, loadTooling, mergedEnv, parseArgs, pgMeta, readEnvFileText, rethrowCliExit, runCli, supabaseHost } from './lib-cms-ops.mjs'

async function main() {
const a = parseArgs(process.argv.slice(2), { flags: ['--no-server'], values: ['--users', '--port', '--min-ttl-minutes', '--guard-minutes', '--ack-warnings'] })
if (!['start', 'status', 'close'].includes(a.cmd) || a.bad.length) {
  console.log('dùng: node scripts/cms-qa-run.mjs <start --users=<uuid,…> [--port=N] [--min-ttl-minutes=N] [--guard-minutes=N] [--no-server] | status | close [--ack-warnings=<8 ký tự id>,…]>')
  return 2
}
if (a.values['--ack-warnings'] !== undefined && a.cmd !== 'close') die2('--ack-warnings chỉ dùng với close')
const { T, G } = await loadTooling()
const MARKER = path.join(ROOT, G.CMS_QA_MARKER)
const envFileText = readEnvFileText()
const env = mergedEnv(envFileText)
const mask = T.maskCmsUuid
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const json = (o) => JSON.stringify(o, null, 2) + '\n'

function readManifest() {
  if (!fs.existsSync(MARKER)) return null
  const p = T.parseCmsQaManifest(fs.readFileSync(MARKER, 'utf8'))
  if (!p.ok) die2(`${G.CMS_QA_MARKER} hỏng (${p.reason}) — không xoá tay; báo PM / operator`)
  return p.value
}
function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, json(obj))
  fs.renameSync(tmp, file)
}
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
/** pid còn tồn tại? (signal 0 chỉ kiểm, không gửi gì.) Chỉ ESRCH mới là "không có tiến trình"; lỗi khác (EPERM …) ⇒ coi là sống. */
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { rethrowCliExit(e); return e?.code !== 'ESRCH' }
}
/** Cổng localhost còn nhận kết nối (server QA còn chạy)? */
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: 'localhost', port })
  const done = (v) => { s.destroy(); resolve(v) }
  s.setTimeout(1500, () => done(false))
  s.once('connect', () => done(true))
  s.once('error', () => done(false))
})

if (a.cmd === 'status') {
  const m = readManifest()
  if (!m) { console.log('không có run QA CMS đang mở'); return 0 }
  console.log(`run ${m.runId} · ${m.status} · ${m.mode} · đích ${m.host} · bắt đầu ${m.startedAt} (giờ DB) · HEAD ${m.gitHead.slice(0, 7)} · build ${m.buildId ?? '—'} · cổng ${m.port ?? '—'}`)
  for (const u of m.users) console.log(`  QA ${mask(u.id)} ${u.role ?? '?'} · marker hết ${u.markerExpiresAt}`)
  console.log(`sha256 manifest ${sha(fs.readFileSync(MARKER))}`)
  return 0
}

if (a.cmd === 'close') {
  const m = readManifest()
  if (!m) die2('không có run QA CMS đang mở')
  const host = supabaseHost(env)
  if (host !== m.host) die2(`host hiện tại (${host}) khác host của run (${m.host})`)
  if (env.E2E_EXPECTED_SUPABASE_HOST !== host) die2(`cần E2E_EXPECTED_SUPABASE_HOST=${host} (gõ lại host để xác nhận)`)
  if (!env.SUPABASE_SERVICE_ROLE_KEY) die2('thiếu SUPABASE_SERVICE_ROLE_KEY')
  // PM cli-exit §3: launcher không xác nhận được server đã chết ⇒ pid còn sống thì chặn close (kể cả khi cổng đã đóng).
  if (m.serverNotStopped) {
    const sp = m.serverNotStopped.pid
    if (sp === null || pidAlive(sp)) die2(`server QA ${sp === null ? '(không rõ pid)' : `pid ${sp}`} được launcher ghi CHƯA DỪNG lúc ${m.serverNotStopped.at}${sp === null ? '' : ' và pid vẫn còn sống'} — tắt tay (Windows: taskkill /F /PID ${sp ?? '<pid>'}), kiểm tasklist rồi mới close; pid đã bị tiến trình khác dùng lại ⇒ báo PM / operator, không sửa manifest tay`)
    console.log(`server QA pid ${sp} (launcher ghi CHƯA DỪNG lúc ${m.serverNotStopped.at}) nay không còn tiến trình — tiếp tục đối chiếu`)
  }
  if (m.port !== null && await portOpen(m.port)) die2(`cổng ${m.port} của server QA còn mở — dừng server (Ctrl+C ở cửa sổ launcher${m.serverPid ? `, pid ${m.serverPid}` : ''}) rồi mới đóng run`)
  const uids = m.users.map((u) => u.id)
  try {
    const programs = await pgMeta(env, T.pgMetaReadOnly(T.cmsQaRunProgramsSql(m.startedAt, uids)))
    const status = await pgMeta(env, T.pgMetaReadOnly(T.cmsQaStatusSql(uids)))
    const recorded = m.programs.length ? await pgMeta(env, T.pgMetaReadOnly(T.cmsQaProgramFlagsSql(m.programs.map((p) => p.id)))) : []
    const c = T.cmsQaCloseCheck(m, programs, status, recorded)
    console.log(`đối chiếu run ${m.runId}: ${c.closed.programs.length} chương trình is_test (để lại, ẩn với user không marker) · ${c.closed.closeCheck.realProgramsTouchedByQaUsers.length} chương trình thật bị tài khoản QA chạm · ${c.warnings.length} cảnh báo`)
    for (const p of c.closed.programs) console.log(`  QA ${mask(p.id)} ${p.status}`)
    for (const w of c.warnings) console.log(`CẢNH BÁO: ${w}`)
    if (!c.ok) {
      for (const r of c.reasons) console.log(`ĐỎ: ${r}`)
      console.log(`giữ ${G.CMS_QA_MARKER} mở — không đóng run (runbook D: dừng QA, báo PM / operator)`)
      return 1
    }
    const ack = T.cmsQaAckWarnings(c.closed.closeCheck.realProgramsChangedByOthers, a.values['--ack-warnings'])
    if (!ack.ok) {
      console.log(`CHẶN ĐÓNG: ${ack.reason}`)
      console.log(`giữ ${G.CMS_QA_MARKER} mở`)
      return 1
    }
    const closed = ack.acked.length ? { ...c.closed, closeCheck: { ...c.closed.closeCheck, acknowledgedWarnings: ack.acked } } : c.closed
    const out = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${m.runId}.json`)
    writeAtomic(out, closed)
    fs.rmSync(MARKER)
    const active = c.closed.closeCheck.markerActiveAtClose
    console.log(`ĐÃ ĐÓNG run · manifest ${path.relative(ROOT, out)} · sha256 ${sha(fs.readFileSync(out))}${active.length ? ` · ${active.length} marker còn hạn — thu bằng cms-qa-access.mjs revoke khi xong QA (bắt buộc trước khi super tạo chương trình thật)` : ''}`)
    return 0
  } catch (e) {
    rethrowCliExit(e)
    console.log(`LỖI DB: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

// ── start ──
const gate = G.cmsWriteGate({ env, envFileText, markerExists: fs.existsSync(MARKER) })
if (!gate.ok) die2(gate.reason)
const users = T.parseCmsQaUserIds(a.values['--users'])
if (!users.ok) die2(users.reason)
const minTtl = T.parseCmsQaMinutes(a.values['--min-ttl-minutes'], T.CMS_QA_MIN_TTL_MINUTES_DEFAULT)
if (!minTtl.ok) die2(minTtl.reason)
const guard = T.parseCmsQaGuardMinutes(a.values['--guard-minutes'])
if (!guard.ok) die2(guard.reason)
if (minTtl.value <= guard.value) die2('--min-ttl-minutes phải lớn hơn --guard-minutes')
const port = a.values['--port'] === undefined ? 3120 : Number(a.values['--port'])
if (!Number.isInteger(port) || port < 1024 || port > 65535) die2('--port phải là số nguyên 1024…65535')
if (!env.SUPABASE_SERVICE_ROLE_KEY) die2('thiếu SUPABASE_SERVICE_ROLE_KEY')
const server = !a.flags.has('--no-server')

let gitHead, gitTree
try {
  // Gồm cả file chưa track không bị ignore (PM P1-1): source lạ lọt vào build nhưng không thuộc tree của manifest ⇒ chặn.
  const tree = T.cmsQaTreeState(git(...T.CMS_QA_GIT_STATUS_ARGS))
  if (!tree.clean) die2(`cây Git không sạch (${tree.entries.length} mục, vd. ${tree.entries.slice(0, 3).join(' | ')}) — QA phải chạy trên candidate đã commit, không file chưa track`)
  gitHead = git('rev-parse', 'HEAD')
  gitTree = git('rev-parse', 'HEAD^{tree}')
} catch (e) { rethrowCliExit(e); die2(`không đọc được Git: ${e instanceof Error ? e.message.split('\n')[0] : e}`) }

const standalone = path.join(ROOT, '.next', 'standalone')
let buildId = null
if (server) {
  const buildIdFile = path.join(ROOT, '.next', 'BUILD_ID')
  if (!fs.existsSync(path.join(standalone, 'server.js')) || !fs.existsSync(buildIdFile)) die2('chưa có build standalone — chạy `npm run build` trên đúng HEAD')
  const headTime = Number(git('log', '-1', '--format=%ct')) * 1000
  if (fs.statSync(buildIdFile).mtimeMs < headTime) die2('build cũ hơn commit HEAD — chạy lại `npm run build`')
  buildId = fs.readFileSync(buildIdFile, 'utf8').trim()
  if (await portOpen(port)) die2(`cổng ${port} đang có tiến trình khác — chọn --port khác hoặc dừng tiến trình đó`)
}

const statusSql = T.pgMetaReadOnly(T.cmsQaStatusSql(users.value))
let pre, preRows, preStartedAt
try {
  preStartedAt = Date.now()
  preRows = await pgMeta(env, statusSql)
  pre = T.cmsQaPreflight(preRows, users.value, minTtl.value)
} catch (e) {
  rethrowCliExit(e)
  console.log(`LỖI DB: ${e instanceof Error ? e.message : String(e)}`)
  return 1
}
if (!pre.ok) {
  for (const r of pre.reasons) console.log(`CHẶN: ${r}`)
  console.log('cấp / gia hạn marker bằng scripts/cms-qa-access.mjs grant (operator) rồi chạy lại')
  return 1
}
const runId = `cms-qa-${pre.dbNow.replace(/[-:]/g, '').replace(/\..*$/, '')}-${crypto.randomBytes(2).toString('hex')}`
let manifest = T.newCmsQaManifest({
  runId, mode: 'manual-localhost', host: gate.host, dbNow: pre.dbNow, gitHead, gitTree, buildId, port: server ? port : null, users: pre.users,
})
try {
  fs.writeFileSync(MARKER, json(manifest), { flag: 'wx' }) // độc quyền: hai launcher song song ⇒ cái sau thất bại
} catch { die2(`${G.CMS_QA_MARKER} vừa được run khác tạo — không ghi đè`) }
console.log(`MỞ run ${runId} · đích ${gate.host} · HEAD ${gitHead.slice(0, 7)} · tree ${gitTree.slice(0, 7)} · build ${buildId ?? '—'} · manifest ${G.CMS_QA_MARKER} sha256 ${sha(fs.readFileSync(MARKER))}`)
for (const u of pre.users) console.log(`  QA ${mask(u.id)} ${u.role ?? '?'} · marker còn ${Math.floor(u.remainingS / 60)} phút`)
console.log('QA chỉ thao tác chương trình is_test; kết thúc: dừng server rồi `node scripts/cms-qa-run.mjs close`')
if (!server) {
  console.log('CẢNH BÁO: --no-server KHÔNG có canh marker — chỉ dùng cho spec tự động có preflight riêng; QA tay / smoke prod dùng launcher có server')
  return 0
}

// Server standalone: chép static / public như gate (planning/research/dev-tools/cms/gate-full-app.sh), cờ CMS chỉ ở process này.
// PM P2-B: trước khi xoá, mọi đích phải là thư mục thật nằm TRONG build của đúng worktree (không symlink / junction).
const rootReal = fs.realpathSync(ROOT)
for (const p of [path.join(ROOT, '.next'), standalone, path.join(standalone, '.next'), path.join(standalone, '.next', 'static'), path.join(standalone, 'public')]) {
  if (!fs.existsSync(p)) continue
  if (fs.lstatSync(p).isSymbolicLink()) die2(`${path.relative(ROOT, p)} là symlink / junction — không xoá / chép; kiểm build của worktree`)
  const real = fs.realpathSync(p)
  if (!real.startsWith(rootReal + path.sep)) die2(`${path.relative(ROOT, p)} trỏ ra ngoài worktree (${real}) — không xoá / chép`)
}
fs.rmSync(path.join(standalone, '.next', 'static'), { recursive: true, force: true })
fs.rmSync(path.join(standalone, 'public'), { recursive: true, force: true })
fs.cpSync(path.join(ROOT, '.next', 'static'), path.join(standalone, '.next', 'static'), { recursive: true })
fs.cpSync(path.join(ROOT, 'public'), path.join(standalone, 'public'), { recursive: true })
const childEnv = { ...env, CMS_PROGRAM_ENABLED: 'true', PORT: String(port), HOSTNAME: 'localhost' }
for (const k of ['E2E_CMS_WRITE_QA', 'E2E_EXPECTED_SUPABASE_HOST']) delete childEnv[k]
const onFlags = Object.keys(childEnv).filter((k) => /_ENABLED$/.test(k) && childEnv[k] === 'true').sort()
console.log(`cờ *_ENABLED đang bật cho server QA (DB prod): ${onFlags.join(', ') || '(không)'} — module khác bật ở đây cũng ghi được prod; tắt bằng process env nếu không cần`)
const child = spawn(process.execPath, ['server.js'], { cwd: standalone, env: childEnv, stdio: 'inherit' })
// Vòng đời server (PM 02/11 B3 §5 + security review P1-1): T.runCmsQaServerLifecycle nghe 'exit' / 'error' của con ngay từ
// đầu; ghi manifest + dựng canh marker trong try — lỗi ⇒ GIẾT server QA ngay (không chạy thiếu canh) rồi ném lại (mã 1).
// Chạy bình thường: deadline độc lập từ lần đọc preflight + poll 60 s (không chồng request, huỷ được) + tick 5 s không IO
// (PM P1-2); mã thoát theo người khởi phát dừng — operator 0, canh marker / server tự thoát / lỗi tiến trình con 1.
// Chỉ 'exit' là bằng chứng server đã thoát; kill lỗi ⇒ SIGKILL, không xác nhận trong hạn ⇒ CHƯA DỪNG (PM cli-exit §3).
const watchdog = T.createCmsQaWatchdog({ userIds: users.value, guardMinutes: guard.value })
// Không xác nhận được server đã chết (PM cli-exit §3) ⇒ ghi cờ vào manifest để close chặn khi pid còn sống. Ghi qua file tạm
// lỗi (vd. rename EPERM — cùng lỗi làm setup hỏng) ⇒ ghi thẳng (ghi dở ⇒ manifest hỏng ⇒ close vẫn từ chối); vẫn lỗi ⇒ nói rõ
// close KHÔNG bị cờ chặn, chỉ còn kiểm cổng (security review r3 P2-1).
const markNotStopped = (pid) => {
  manifest = { ...manifest, serverNotStopped: { pid, at: new Date().toISOString() } }
  const short = (e) => String(e?.message ?? e).split('\n')[0]
  try {
    writeAtomic(MARKER, manifest)
    return
  } catch (e) {
    rethrowCliExit(e)
    console.log(`ghi cờ serverNotStopped qua file tạm lỗi (${short(e)}) — thử ghi thẳng ${G.CMS_QA_MARKER}`)
  }
  try {
    fs.writeFileSync(MARKER, json(manifest))
  } catch (e) {
    rethrowCliExit(e)
    console.log(`KHÔNG ghi được cờ serverNotStopped vào ${G.CMS_QA_MARKER}: ${short(e)} — close SẼ KHÔNG bị cờ chặn (chỉ còn kiểm cổng): operator tự xác nhận pid ${pid ?? '—'} đã tắt (tasklist /FI "PID eq ${pid ?? '<pid>'}") trước khi close`)
  }
}
let life
try {
life = await T.runCmsQaServerLifecycle({
  child, watchdog, preRows, preStartedAt,
  poll: (signal) => pgMeta(env, statusSql, { signal }),
  setup: () => {
    manifest = { ...manifest, serverPid: child.pid ?? null }
    writeAtomic(MARKER, manifest)
    console.log(`server QA: http://localhost:${port} (pid ${child.pid}) — Ctrl+C để dừng; canh marker mỗi ${T.CMS_QA_POLL_MS / 1000} s (ngưỡng ${guard.value} phút)`)
  },
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h),
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h),
  onSignal: (sig, fn) => process.on(sig, fn), offSignal: (sig, fn) => process.off(sig, fn),
  log: (line) => console.log(line),
})
} catch (e) {
  rethrowCliExit(e)
  if (e instanceof T.CmsQaServerNotStoppedError) markNotStopped(e.pid)
  throw e
}
if (!life.stopped) {
  markNotStopped(life.pid)
  console.log(`SERVER QA CHƯA DỪNG (pid ${life.pid ?? '—'}; ${life.childError ? `lỗi ${life.childError}` : 'SIGKILL không được xác nhận'}) ⇒ thoát 1. DỪNG MỌI THAO TÁC QA; tắt tay: taskkill /F /PID ${life.pid ?? '<pid>'} rồi kiểm tasklist. Run ${runId} VẪN MỞ — close bị chặn khi pid còn sống`)
  return 1
}
const why = life.childError ? `LỖI tiến trình server: ${life.childError}` : life.stopKind === 'operator' ? 'operator dừng' : life.stopKind === 'watchdog' ? 'canh marker dừng' : life.stopKind === 'error' ? 'lỗi tiến trình con' : 'server TỰ THOÁT (bất thường)'
console.log(`server dừng (${why}; mã ${life.code ?? '—'}${life.signal ? `, tín hiệu ${life.signal}` : ''}) ⇒ thoát ${life.rc}. Run ${runId} VẪN MỞ — đóng bằng: E2E_EXPECTED_SUPABASE_HOST=${gate.host} node scripts/cms-qa-run.mjs close`)
return life.rc
}

await runCli(main)
