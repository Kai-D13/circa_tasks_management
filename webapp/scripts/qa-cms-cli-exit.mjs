// QA mã thoát CLI CMS (PM `planning/reviews/2026-11-02-cms-b3-and-cli-exit-pm.md` §5) — chạy CHÍNH các script operator
// (cms-verify / cms-qa-access / cms-qa-run) thành TIẾN TRÌNH CON, fetch thật tới một shim pg-meta trên 127.0.0.1 dựng trên
// PGlite (nền giống prod của lib-care-pglite.mjs + migration 120 / 121 THẬT). Shim trả như pg-meta prod (probe 02/11):
// result set CUỐI CÙNG CÓ ≥ 1 DÒNG, không có ⇒ []; timestamptz dạng text Postgres; lỗi SQL ⇒ HTTP 400 {code,message}.
// Mỗi ca khẳng định: đúng mã 0 / 1 / 2, tự kết thúc (không bị giết vì treo), không `Assertion failed` / `UV_HANDLE_CLOSING`
// (lỗi libuv Node 24 / Windows khi process.exit() ngay sau fetch — tái hiện 02/11 trên prod), JSON --out đầy đủ; ca mã 2
// không gửi request nào tới shim. KHÔNG chạm DB thật: URL + key là của shim; --expect-host là host shim.
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần, trong webapp/
//   node scripts/qa-cms-cli-exit.mjs                 # kỳ vọng: N đạt · 0 lỗi
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MIG = path.join(ROOT, '..', 'supabase', 'migrations')
const SQL_120 = fs.readFileSync(path.join(MIG, '120_cms_foundation.sql'), 'utf8')
const SQL_121 = fs.readFileSync(path.join(MIG, '121_cms_import_activation.sql'), 'utf8')
let PGlite
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch {
  console.error('FAIL: thiếu @electric-sql/pglite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  process.exitCode = 2
}
if (PGlite) await main()

async function main() {
  const jiti = createJiti(import.meta.url, { interopDefault: true })
  const T = await jiti.import(path.join(ROOT, 'e2e', 'cmsQaTooling.ts'))
  const G = await jiti.import(path.join(ROOT, 'e2e', 'writeQaGates.ts'))
  let pass = 0, fail = 0
  const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) } }
  const section = (s) => console.log(`\n${s}`)
  const sleep = (n) => new Promise((r) => setTimeout(r, n))
  const { U, uid } = L
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-cli-exit-'))
  const markerFile = path.join(ROOT, G.CMS_QA_MARKER)
  if (fs.existsSync(markerFile)) { console.error(`FAIL: đang có ${G.CMS_QA_MARKER} thật — đóng run trước khi chạy QA này`); process.exitCode = 2; return }

  // ── DB + shim pg-meta ──
  const db = await L.freshDb(PGlite)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  const KEY = 'shim-only-key'
  const pgText = (d) => d.toISOString().replace('T', ' ').replace('Z', '+00') // như pg-meta: text timestamptz
  const toJson = (rows) => JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v))
  const lastRows = (results) => { for (let i = results.length - 1; i >= 0; i--) if (results[i].rows?.length) return results[i].rows; return [] }
  const fixDates = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? pgText(v) : v])))
  let requests = 0
  let failMode = null // null | 'http500' | 'notjson'
  let chain = Promise.resolve()
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      chain = chain.then(async () => {
        requests++
        if (req.method !== 'POST' || req.url !== '/pg/query' || req.headers.apikey !== KEY) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"message":"no"}'); return }
        if (failMode === 'http500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"code":"XX000","message":"giả lập lỗi"}'); return }
        if (failMode === 'notjson') { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>bad gateway</html>'); return }
        try {
          const { query } = JSON.parse(body)
          const rows = fixDates(lastRows(await db.exec(query)))
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(toJson(rows))
        } catch (e) {
          await db.exec('ROLLBACK').catch(() => {})
          res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: e?.code ?? 'XX', message: String(e?.message ?? e).slice(0, 200) }))
        }
      })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const HOST = `127.0.0.1:${server.address().port}`

  // ── chạy CLI thành tiến trình con ──
  const childEnv = (extra = {}) => {
    const env = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('E2E_CMS') && k !== 'E2E_EXPECTED_SUPABASE_HOST') env[k] = v
    return { ...env, NEXT_PUBLIC_SUPABASE_URL: `http://${HOST}`, SUPABASE_SERVICE_ROLE_KEY: KEY, ...extra }
  }
  const CRASH = /Assertion failed|UV_HANDLE_CLOSING/
  /** Chạy script, trả { code, signal, out, ms, killed, reqs }. Treo > 30 s ⇒ giết + killed=true (ca phải đỏ). */
  const run = (script, args, extra = {}) => new Promise((resolve) => {
    const r0 = requests, t0 = Date.now()
    const ch = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, env: childEnv(extra) })
    let out = '', killed = false
    ch.stdout.on('data', (d) => { out += d }); ch.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => { killed = true; ch.kill('SIGKILL') }, 30_000)
    ch.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, ms: Date.now() - t0, killed, reqs: requests - r0 }) })
  })
  const clean = (r) => !r.killed && !CRASH.test(r.out) && r.signal === null
  const exp = (r, code, label, more = true) => ok(clean(r) && r.code === code && more, `${label} ⇒ mã ${code} (${r.ms} ms, ${r.reqs} request)`, `mã ${r.code} tín hiệu ${r.signal} killed ${r.killed}\n${r.out.slice(-600)}`)
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
  const SUPER = U.super

  section('1. cms-verify — PRE / POST 120, V8, LỆCH, lỗi pg-meta, tham số sai (tiến trình con, fetch thật tới shim)')
  const pre120 = path.join(tmp, 'pre120.json')
  let r = await run('cms-verify.mjs', ['acl-snapshot', `--expect-host=${HOST}`, `--out=${pre120}`])
  const p120 = readJson(pre120)
  exp(r, 0, 'acl-snapshot trước 120', p120?.kind === 'cms-acl-snapshot' && p120.acl.n_all === p120.acl.n_old && p120.host === HOST)
  await sleep(20)
  await db.exec(SQL_120)
  const post120 = path.join(tmp, 'post120.json')
  r = await run('cms-verify.mjs', ['post', '--phase=120', `--pre=${pre120}`, `--expect-host=${HOST}`, `--out=${post120}`])
  const j120 = readJson(post120)
  exp(r, 0, 'post 120 (DB đúng)', j120?.kind === 'cms-verify-post' && j120.checks.length >= 70 && j120.checks.every((c) => c.ok) && /ĐẠT: \d+ \/ \d+/.test(r.out))
  const v8 = path.join(tmp, 'v8.json')
  r = await run('cms-verify.mjs', ['v8', `--user=${SUPER}`, '--role=super', '--expect-qa=false', '--expect-readable=0', `--expect-host=${HOST}`, `--out=${v8}`])
  const jv8 = readJson(v8)
  exp(r, 0, 'v8 super (bảng rỗng ⇒ CHƯA, không LỆCH) — đúng ca rc 127 trên prod B3', jv8?.kind === 'cms-verify-v8' && jv8.checks.length === 18 && jv8.checks.every((c) => c.ok)
    && jv8.checks.filter((c) => c.proven === false).length === 6 && /6 mục CHƯA CHỨNG MINH/.test(r.out))
  const v8p = path.join(tmp, 'v8-proven.json')
  r = await run('cms-verify.mjs', ['v8', `--user=${SUPER}`, '--role=super', '--require-proven=programs,products', `--expect-host=${HOST}`, `--out=${v8p}`])
  exp(r, 1, 'v8 --require-proven khi bảng còn CHƯA (gate D3 do máy ép)', readJson(v8p)?.checks.some((c) => !c.ok) && /KHÔNG ĐẠT/.test(r.out))
  // Gây LỆCH thật: cấp EXECUTE helper cho anon ⇒ post phải 1 và JSON ghi mục lệch; trả lại ⇒ 0.
  await db.exec(`GRANT EXECUTE ON FUNCTION public.cms_readable_program_ids() TO anon`)
  const postBad = path.join(tmp, 'post120-bad.json')
  r = await run('cms-verify.mjs', ['post', '--phase=120', `--pre=${pre120}`, `--expect-host=${HOST}`, `--out=${postBad}`])
  const jb = readJson(postBad)
  exp(r, 1, 'post 120 khi anon có EXECUTE helper (LỆCH)', jb?.checks.some((c) => !c.ok && /cms_readable_program_ids/.test(c.id)) && /KHÔNG ĐẠT/.test(r.out))
  await db.exec(`REVOKE EXECUTE ON FUNCTION public.cms_readable_program_ids() FROM anon`)
  r = await run('cms-verify.mjs', ['post', '--phase=120', `--pre=${pre120}`, `--expect-host=${HOST}`])
  exp(r, 0, 'post 120 sau khi thu lại quyền')
  failMode = 'http500'
  r = await run('cms-verify.mjs', ['acl-snapshot', `--expect-host=${HOST}`, `--out=${path.join(tmp, 'x.json')}`])
  exp(r, 1, 'pg-meta HTTP 500 ⇒ LỖI DB, dừng ngay (1 request, không ghi --out)', r.reqs === 1 && /LỖI DB: pg-meta HTTP 500/.test(r.out) && !fs.existsSync(path.join(tmp, 'x.json')))
  failMode = 'notjson'
  r = await run('cms-verify.mjs', ['v8', `--user=${SUPER}`, '--role=super', `--expect-host=${HOST}`])
  exp(r, 1, 'pg-meta trả HTML ⇒ LỖI DB', /không phải JSON/.test(r.out))
  failMode = null
  for (const [args, label] of [
    [['acl-snapshot', '--expect-host=khac.invalid'], 'sai --expect-host'],
    [['post', '--phase=121', `--pre=${pre120}`, `--expect-host=${HOST}`], 'PRE của 120 dùng cho 121'],
    [['post', '--phase=120', `--pre=${path.join(tmp, 'khong-co.json')}`, `--expect-host=${HOST}`], '--pre không tồn tại'],
    [['v8', '--user=abc', '--role=super', `--expect-host=${HOST}`], '--user không phải UUID'],
    [['v8', `--user=${SUPER}`, '--role=super', '--require-proven=nope', `--expect-host=${HOST}`], '--require-proven lạ'],
    [['xoa', `--expect-host=${HOST}`], 'lệnh lạ'],
  ]) {
    r = await run('cms-verify.mjs', args)
    exp(r, 2, `${label} (trước IO)`, r.reqs === 0)
  }
  // Out không ghi được (thư mục không tồn tại) ⇒ lỗi không phải CliExit ⇒ 1, không nuốt thành 0.
  r = await run('cms-verify.mjs', ['acl-snapshot', `--expect-host=${HOST}`, `--out=${path.join(tmp, 'khong', 'co', 'thu-muc.json')}`])
  exp(r, 1, '--out không ghi được (lỗi ngoài dự kiến)', /LỖI: /.test(r.out))

  section('2. cms-verify — PRE / POST 121')
  await sleep(20)
  const pre121 = path.join(tmp, 'pre121.json')
  r = await run('cms-verify.mjs', ['acl-snapshot', `--expect-host=${HOST}`, `--out=${pre121}`])
  const p121 = readJson(pre121)
  exp(r, 0, 'acl-snapshot trước 121 (7 hàm cms của 120)', p121 && p121.acl.n_all - p121.acl.n_old === 7 && p121.acl.md5_old === p120.acl.md5_old)
  await sleep(20)
  await db.exec(SQL_121)
  const post121 = path.join(tmp, 'post121.json')
  r = await run('cms-verify.mjs', ['post', '--phase=121', `--pre=${pre121}`, `--expect-host=${HOST}`, `--out=${post121}`])
  const j121 = readJson(post121)
  exp(r, 0, 'post 121 (DB đúng)', j121?.checks.length >= 80 && j121.checks.every((c) => c.ok))

  section('3. cms-qa-access — dry-run / guard / ghi / thu (ghi vào PGlite của shim)')
  const nMarker = async () => Number((await db.query(`SELECT count(*)::int n FROM public.cms_qa_access`)).rows[0].n)
  r = await run('cms-qa-access.mjs', ['status', `--users=${U.A}`])
  exp(r, 0, 'status')
  r = await run('cms-qa-access.mjs', ['grant', `--users=${U.A}`, '--ttl-hours=2'])
  exp(r, 0, 'grant DRY-RUN không ghi (1 lần đọc)', r.reqs === 1 && (await nMarker()) === 0 && /Không ghi gì/.test(r.out))
  r = await run('cms-qa-access.mjs', ['grant', `--users=${U.A}`, '--ttl-hours=2', '--confirm'])
  exp(r, 2, 'grant --confirm thiếu --expect-host (trước IO)', r.reqs === 0 && (await nMarker()) === 0)
  r = await run('cms-qa-access.mjs', ['grant', `--users=${U.A},${uid(99999)}`, '--ttl-hours=2', '--confirm', `--expect-host=${HOST}`])
  exp(r, 1, 'grant có user_id không tồn tại ⇒ DỪNG ngay sau 1 lần đọc (không gửi lệnh ghi), không cấp ai', r.reqs === 1 && (await nMarker()) === 0 && /không có tài khoản/.test(r.out))
  r = await run('cms-qa-access.mjs', ['grant', `--users=${SUPER}`, '--ttl-hours=2', '--confirm', `--expect-host=${HOST}`])
  exp(r, 1, 'grant vai admin thiếu --allow-admin ⇒ DỪNG ngay sau 1 lần đọc (không gửi lệnh ghi)', r.reqs === 1 && (await nMarker()) === 0 && /--allow-admin/.test(r.out))
  r = await run('cms-qa-access.mjs', ['grant', `--users=${U.A}`, '--ttl-hours=2', '--confirm', `--expect-host=${HOST}`])
  exp(r, 0, 'grant --confirm ghi 1 marker, hậu kiểm ĐẠT', (await nMarker()) === 1 && /hậu kiểm marker còn hạn: ĐẠT/.test(r.out))
  r = await run('cms-qa-access.mjs', ['revoke', `--users=${U.A}`])
  exp(r, 0, 'revoke DRY-RUN không xoá (1 lần đọc)', r.reqs === 1 && (await nMarker()) === 1)
  r = await run('cms-qa-access.mjs', ['revoke', `--users=${U.A}`, '--confirm', `--expect-host=${HOST}`])
  exp(r, 0, 'revoke --confirm xoá marker', (await nMarker()) === 0)
  failMode = 'http500'
  r = await run('cms-qa-access.mjs', ['status', `--users=${U.A}`])
  exp(r, 1, 'status khi pg-meta lỗi ⇒ LỖI DB', /LỖI DB/.test(r.out))
  failMode = null

  section('4. cms-qa-run — đường không dựng server (status / close / gate) + mã launcher')
  r = await run('cms-qa-run.mjs', ['status'])
  exp(r, 0, 'status không có run', /không có run/.test(r.out) && r.reqs === 0)
  r = await run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: HOST })
  exp(r, 2, 'close không có run (trước IO)', r.reqs === 0)
  r = await run('cms-qa-run.mjs', ['start', `--users=${U.A}`])
  exp(r, 2, 'start thiếu opt-in E2E_CMS_WRITE_QA (trước IO)', r.reqs === 0 && /E2E_CMS_WRITE_QA=YES/.test(r.out))
  r = await run('cms-qa-run.mjs', ['start', `--users=${U.A}`, '--guard-minutes=1'], { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: HOST })
  exp(r, 2, 'start guard dưới sàn 10 phút (trước IO)', r.reqs === 0)
  ok(T.cmsQaServerExitCode('operator') === 0 && T.cmsQaServerExitCode('watchdog') === 1 && T.cmsQaServerExitCode(null) === 1,
    'mã launcher khi server dừng: operator 0 · canh marker 1 · server tự thoát 1')
  ok(!fs.existsSync(markerFile), `không để lại ${G.CMS_QA_MARKER}`)

  section('5. Nguồn: không còn process.exit trong script operator; mọi catch-all chuyển tiếp CliExit')
  for (const f of ['lib-cms-ops.mjs', 'cms-verify.mjs', 'cms-qa-access.mjs', 'cms-qa-run.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
    ok(!/process\.exit\(/.test(src), `${f}: không gọi process.exit(`)
    if (f !== 'lib-cms-ops.mjs') {
      ok(/await runCli\(main\)\s*$/.test(src.trimEnd()), `${f}: entrypoint là await runCli(main)`)
      const catches = src.match(/catch \(e\) \{[^\n]*\n?[^\n]*/g) ?? []
      ok(catches.every((c) => /rethrowCliExit\(e\)/.test(c)), `${f}: ${catches.length} khối catch (e) đều rethrowCliExit trước khi đổi mã`, JSON.stringify(catches))
    }
    // catch trần (security review P2-3): thân try tương ứng không được gọi die2 / exitWith — `catch {}` sẽ nuốt CliExit.
    // Thân try không được vắt qua try / catch khác (tránh khớp từ `try {` của khối `catch (e)` tới `catch {}` phía sau).
    const bare = [...src.matchAll(/try \{((?:(?!try \{|\} catch)[\s\S])*?)\} catch \{/g)].map((m) => m[1])
    const bad = bare.filter((body) => /\b(die2|exitWith)\(/.test(body))
    ok(bad.length === 0, `${f}: ${bare.length} khối try … catch {} không có die2 / exitWith trong thân try`, JSON.stringify(bad))
  }

  await new Promise((res) => server.close(res))
  await db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${pass} đạt · ${fail} lỗi`)
  process.exitCode = fail ? 1 : 0
}
