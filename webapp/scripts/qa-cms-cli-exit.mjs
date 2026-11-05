// QA mã thoát CLI CMS (PM `planning/reviews/2026-11-02-cms-b3-and-cli-exit-pm.md` §5) — chạy CHÍNH các script operator
// (cms-verify / cms-qa-access / cms-qa-run) thành TIẾN TRÌNH CON, fetch thật tới một shim pg-meta trên 127.0.0.1 dựng trên
// PGlite (nền giống prod của lib-care-pglite.mjs + migration 120 / 121 THẬT). Shim trả như pg-meta prod (probe 02/11):
// result set CUỐI CÙNG CÓ ≥ 1 DÒNG, không có ⇒ []; timestamptz dạng text Postgres; lỗi SQL ⇒ HTTP 400 {code,message}.
// Mỗi ca khẳng định: đúng mã 0 / 1 / 2, tự kết thúc (không bị giết vì treo), không `Assertion failed` / `UV_HANDLE_CLOSING`
// (lỗi libuv Node 24 / Windows khi process.exit() ngay sau fetch — tái hiện 02/11 trên prod), JSON --out đầy đủ; ca mã 2
// không gửi request nào tới shim. KHÔNG chạm DB thật: URL + key là của shim; --expect-host là host shim.
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần, trong webapp/
//   node scripts/qa-cms-cli-exit.mjs                 # kỳ vọng: N đạt · 0 lỗi
//   QA_HARNESS_GIT=real node scripts/qa-cms-cli-exit.mjs   # §6 writer gọi Git THẬT (không preload Git) — cây phải sạch
//   (bản sao byte-giống trong webapp/qa-artifacts/ cũng chạy được: mọi đường dẫn theo ROOT = thư mục cha của file)
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const L = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
const MIG = path.join(ROOT, '..', 'supabase', 'migrations')
const SQL_120 = fs.readFileSync(path.join(MIG, '120_cms_foundation.sql'), 'utf8')
const SQL_121 = fs.readFileSync(path.join(MIG, '121_cms_import_activation.sql'), 'utf8')
const SQL_122 = fs.readFileSync(path.join(MIG, '122_cms_results.sql'), 'utf8')
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
  // §6: trễ pg-meta (mô phỏng guard chờ DB) + lỗi RPC "đã commit nhưng mất phản hồi" theo tên hàm.
  let pgDelayMs = 0
  const rpcFaults = [] // { fn, n }
  const rpcFaultsBefore = [] // { fn, n } — §7 mất phản hồi TRƯỚC khi hàm chạy
  const rpcByFn = {}
  let rpcCalls = 0
  let chain = Promise.resolve()
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      chain = chain.then(async () => {
        requests++
        // Shim PostgREST tối thiểu cho writer kết quả QA (§6): POST /rest/v1/rpc/<rpc_cms_*> — chạy đúng hàm 122 THẬT trên PGlite
        // bằng tham số đặt tên; lỗi DB ⇒ 400 {code, message} như PostgREST; lỗi giả ⇒ hàm ĐÃ chạy / commit rồi cắt kết nối.
        if (req.method === 'POST' && req.url.startsWith('/rest/v1/rpc/') && req.headers.apikey === KEY) {
          rpcCalls++
          const fn = req.url.slice('/rest/v1/rpc/'.length).split('?')[0]
          let args
          try { args = body ? JSON.parse(body) : {} } catch { args = null }
          if (!/^rpc_cms_[a-z_]+$/.test(fn) || !args || !Object.keys(args).every((k) => /^p_[a-z_]+$/.test(k))) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"no rpc"}'); return }
          rpcByFn[fn] = (rpcByFn[fn] ?? 0) + 1
          // §7: mất phản hồi TRƯỚC khi hàm chạy (request tới gateway rồi đứt — DB chưa nhận) ⇒ cắt kết nối, không chạy hàm.
          const faultBefore = rpcFaultsBefore.find((f) => f.fn === fn && f.n > 0)
          if (faultBefore) { faultBefore.n--; req.socket.destroy(); return }
          const keys = Object.keys(args)
          const params = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))
          const parts = keys.map((k, i) => (args[k] !== null && typeof args[k] === 'object' ? `${k} => $${i + 1}::jsonb` : `${k} => $${i + 1}`))
          try {
            const q = await db.query(`SELECT public.${fn}(${parts.join(', ')}) AS r`, params)
            const fault = rpcFaults.find((f) => f.fn === fn && f.n > 0)
            if (fault) { fault.n--; req.socket.destroy(); return }
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(toJson(q.rows[0]?.r ?? null))
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: e?.code ?? 'XX', message: String(e?.message ?? e).slice(0, 200) }))
          }
          return
        }
        if (req.method !== 'POST' || req.url !== '/pg/query' || req.headers.apikey !== KEY) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"message":"no"}'); return }
        if (pgDelayMs) await new Promise((r) => setTimeout(r, pgDelayMs))
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
  const run = (script, args, extra = {}, nodeArgs = []) => new Promise((resolve) => {
    const r0 = requests, t0 = Date.now()
    const ch = spawn(process.execPath, [...nodeArgs, path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, env: childEnv(extra) })
    let out = '', killed = false
    ch.stdout.on('data', (d) => { out += d }); ch.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => { killed = true; ch.kill('SIGKILL') }, 60_000)
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
  exp(r, 0, 'v8 super (bảng rỗng ⇒ CHƯA, không LỆCH) — đúng ca rc 127 trên prod B3', jv8?.kind === 'cms-verify-v8' && jv8.checks.length === 19 && jv8.checks.every((c) => c.ok)
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

  section('2b. cms-verify — phase 122 (PM 03/11 §5): PRE đúng 14 hàm, phase sai không xanh, V8 --phase')
  r = await run('cms-verify.mjs', ['post', '--phase=122', `--pre=${pre121}`, `--expect-host=${HOST}`])
  exp(r, 2, 'post 122 với PRE của 121 (7 hàm cms) ⇒ sai tham số trước IO', r.reqs === 0 && /không phải ảnh ngay trước 122/.test(r.out))
  await sleep(20)
  const pre122 = path.join(tmp, 'pre122.json')
  r = await run('cms-verify.mjs', ['acl-snapshot', `--expect-host=${HOST}`, `--out=${pre122}`])
  const p122 = readJson(pre122)
  exp(r, 0, 'acl-snapshot trước 122 (14 hàm cms của 120 + 121)', p122 && p122.acl.n_all - p122.acl.n_old === 14 && Number.isInteger(p122.acl.n_ex122))
  r = await run('cms-verify.mjs', ['post', '--phase=122', `--pre=${pre122}`, `--expect-host=${HOST}`])
  exp(r, 1, 'post 122 khi DB CHƯA chạy 122 ⇒ LỖI DB (không xanh giả)', /LỖI DB/.test(r.out))
  await sleep(20)
  await db.exec(SQL_122)
  const post122 = path.join(tmp, 'post122.json')
  r = await run('cms-verify.mjs', ['post', '--phase=122', `--pre=${pre122}`, `--expect-host=${HOST}`, `--out=${post122}`])
  const j122 = readJson(post122)
  exp(r, 0, 'post 122 (DB đúng): mọi mục ĐẠT', j122?.phase === '122' && j122.checks.length >= 200 && j122.checks.every((c) => c.ok)
    && ['phase-match', 'release-gate-closed', 'index-tiers-unique', 'pointer-fk'].every((id) => j122.checks.some((c) => c.id === id && c.ok)))
  r = await run('cms-verify.mjs', ['post', '--phase=121', `--pre=${pre121}`, `--expect-host=${HOST}`])
  exp(r, 1, 'checker 121 trên DB 122 ⇒ LỆCH phase-match (lời rõ), không thành bằng chứng', /LỆCH\s+phase-match — PHASE KHÔNG PHÙ HỢP/.test(r.out))
  r = await run('cms-verify.mjs', ['v8', `--user=${SUPER}`, '--role=super', `--expect-host=${HOST}`])
  exp(r, 1, 'V8 không khai --phase trên DB 122 ⇒ LỆCH v8-phase', /LỆCH\s+v8-phase/.test(r.out))
  r = await run('cms-verify.mjs', ['v8', `--user=${SUPER}`, '--role=super', '--phase=122', `--expect-host=${HOST}`])
  exp(r, 0, 'V8 --phase=122 (bảng rỗng ⇒ CHƯA, không LỆCH)', /ĐẠT: \d+ \/ \d+/.test(r.out) && /v8-table:results/.test(r.out))
  r = await run('cms-verify.mjs', ['v8', `--user=${SUPER}`, '--role=super', '--phase=122', '--require-proven=results', `--expect-host=${HOST}`])
  exp(r, 1, 'V8 --require-proven=results trên bảng rỗng ⇒ LỆCH (không xanh khi 0 = 0)', /LỆCH\s+v8-require-proven:results/.test(r.out))
  for (const [args, why] of [
    [['v8', `--user=${SUPER}`, '--role=super', '--phase=125', `--expect-host=${HOST}`], 'V8 --phase lạ'],
    [['v8', `--user=${SUPER}`, '--role=super', '--require-proven=results', `--expect-host=${HOST}`], 'V8 --require-proven=results khi không khai --phase=122'],
    [['post', '--phase=125', `--pre=${pre122}`, `--expect-host=${HOST}`], 'post --phase lạ'],
  ]) {
    r = await run('cms-verify.mjs', args)
    exp(r, 2, `${why} ⇒ sai tham số trước IO`, r.reqs === 0)
  }

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
  // P3a (security review P1-1): cờ LOCK ở shell chỉ tới server QA khi opt-in --with-lock (§4.4) — các ca sai chặn trước IO.
  const WS = { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: HOST }
  r = await run('cms-qa-run.mjs', ['start', `--users=${U.A}`], { ...WS, CMS_EARNINGS_ENABLED: 'true', CMS_LOCK_ENABLED: 'true' })
  exp(r, 2, 'start khi shell có CMS_LOCK_ENABLED=true mà không --with-lock (trước IO)', r.reqs === 0 && /start --with-lock/.test(r.out))
  r = await run('cms-qa-run.mjs', ['start', `--users=${U.A}`, '--with-lock'], WS)
  exp(r, 2, 'start --with-lock thiếu EARNINGS + LOCK ở process (trước IO)', r.reqs === 0 && /--with-lock cần CMS_EARNINGS_ENABLED=true/.test(r.out))
  r = await run('cms-qa-run.mjs', ['start', `--users=${U.A}`, '--with-lock', '--no-server'], { ...WS, CMS_EARNINGS_ENABLED: 'true', CMS_LOCK_ENABLED: 'true' })
  exp(r, 2, 'start --with-lock --no-server (trước IO)', r.reqs === 0 && /--no-server/.test(r.out))
  r = await run('cms-qa-run.mjs', ['status', '--with-lock'])
  exp(r, 2, '--with-lock ngoài start', r.reqs === 0 && /chỉ dùng với start/.test(r.out))
  ok(T.cmsQaServerExitCode('operator') === 0 && T.cmsQaServerExitCode('watchdog') === 1 && T.cmsQaServerExitCode(null) === 1,
    'mã launcher khi server dừng: operator 0 · canh marker 1 · server tự thoát 1')
  ok(!fs.existsSync(markerFile), `không để lại ${G.CMS_QA_MARKER}`)

  section('5. Nguồn: không còn process.exit trong script operator; mọi catch-all chuyển tiếp CliExit')
  for (const f of ['lib-cms-ops.mjs', 'cms-verify.mjs', 'cms-qa-access.mjs', 'cms-qa-run.mjs', 'cms-qa-results.mjs']) {
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

  // PM r2 §5.2: QA_HARNESS_GIT=real ⇒ writer gọi Git THẬT (preload chỉ còn lỗi giả rename sổ, không đụng execFileSync); cây phải sạch.
  const REAL_GIT = process.env.QA_HARNESS_GIT === 'real'
  section(`6. QA kết quả có gate (PM 03/11 REL-P1-1 + delta r2): writer cms-qa-results.mjs — chặn trước IO, guard DB, shim PostgREST + lỗi giả, reconcile, close · Git ${REAL_GIT ? 'THẬT (không preload Git)' : 'giả qua preload'}`)
  const R = await jiti.import(path.join(ROOT, 'e2e', 'cmsQaResults.ts'))
  const { execFileSync } = await import('node:child_process')
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  const head = git('rev-parse', 'HEAD'), treeId = git('rev-parse', 'HEAD^{tree}')
  if (REAL_GIT) {
    const st = git('status', '--porcelain', '--untracked-files=all')
    if (st) {
      console.error(`FAIL: QA_HARNESS_GIT=real cần cây sạch — git status:\n${st}`)
      process.exitCode = 2
      await new Promise((res) => server.close(res)); await db.close()
      return
    }
    console.log(`  Git thật: HEAD ${head} · tree ${treeId} · cây sạch`)
  }
  const runId = 'cms-qa-20261103T101500-ab12'
  const writersDir = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${runId}.writers`)
  const archived = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${runId}.json`)
  for (const p of [writersDir, archived]) if (fs.existsSync(p)) { console.error(`FAIL: đã có ${p} — dọn trước khi chạy`); process.exitCode = 2; return }
  // Preload CHỈ trong tiến trình con writer của harness (không có trong code sản phẩm): mặc định giả Git "sạch" + HEAD / tree
  // = manifest (đi qua kiểm cục bộ trên cây chưa commit — cùng cách PM kiểm bản sao cô lập), tuỳ chọn giả status bẩn; lỗi
  // rename sổ. QA_HARNESS_GIT=real: chỉ còn lỗi rename sổ — writer đọc Git thật (cây bẩn = file untracked tạm, HEAD khác =
  // manifest ghi HEAD khác).
  const preload = path.join(tmp, 'qa-writer-preload.mjs')
  const gitFake = [
    'const orig = cp.execFileSync',
    "cp.execFileSync = function (cmd, args, opts) {",
    "  if (cmd === 'git' && Array.isArray(args)) {",
    "    if (args[0] === 'status') return process.env.QA_FAKE_STATUS || ''",
    "    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return process.env.QA_FAKE_HEAD + '\\n'",
    "    if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') return process.env.QA_FAKE_TREE + '\\n'",
    '  }',
    '  return orig.apply(this, arguments)',
    '}',
  ]
  fs.writeFileSync(preload, [
    "import cp from 'node:child_process'", "import fs from 'node:fs'", "import { syncBuiltinESMExports } from 'node:module'",
    ...(REAL_GIT ? [] : gitFake),
    'if (process.env.QA_FAULT_LEDGER_RENAME) {',
    '  const rn = fs.renameSync; let n = 0',
    "  fs.renameSync = function (a, b) { if (String(b).includes('.writers') && ++n === Number(process.env.QA_FAULT_LEDGER_RENAME)) { const e = new Error('EPERM giả'); e.code = 'EPERM'; throw e } return rn.apply(this, arguments) }",
    '}',
    // §7: ghi sổ Ý ĐỊNH chốt (l-….json, flag wx) lỗi ⇒ công cụ phải dừng TRƯỚC RPC.
    'if (process.env.QA_FAULT_LOCK_INTENT) {',
    '  const wf = fs.writeFileSync',
    "  fs.writeFileSync = function (f, d, o) { if (/[\\\\/]l-[0-9a-f]{12}\\.json$/.test(String(f)) && o && o.flag === 'wx') { const e = new Error('EPERM giả'); e.code = 'EPERM'; throw e } return wf.apply(this, arguments) }",
    '}',
    'syncBuiltinESMExports()',
  ].join('\n'))
  const PRE = ['--import', pathToFileURL(preload).href]
  if (REAL_GIT) ok(!/execFileSync\s*=/.test(fs.readFileSync(preload, 'utf8')), 'Git thật: preload KHÔNG thay execFileSync (chỉ lỗi giả rename sổ)')
  const W = { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: HOST }
  const WG = REAL_GIT ? { ...W } : { ...W, QA_FAKE_HEAD: head, QA_FAKE_TREE: treeId }
  const nRuns = async () => Number((await db.query(`SELECT count(*)::int n FROM public.cms_sync_runs WHERE kind = 'sales'`)).rows[0].n)
  const ledgers = () => (fs.existsSync(writersDir) ? fs.readdirSync(writersDir).filter((f) => /^w-[0-9a-f]{12}\.json$/.test(f)).sort() : [])
  const readLedger = (f) => R.parseCmsQaWriterEntry(fs.readFileSync(path.join(writersDir, f), 'utf8')).value
  const lastWriter = (r) => /writer (w-[0-9a-f]{12})/.exec(r.out)?.[1] ?? null
  let fakeLauncher = null
  const lport = await new Promise((res) => { const s = net.createServer(); s.listen(0, 'localhost', () => { const p = s.address().port; s.close(() => res(p)) }) })
  const launcherUp = () => new Promise((res) => { fakeLauncher = net.createServer((sk) => sk.destroy()); fakeLauncher.listen(lport, 'localhost', res) })
  const launcherDown = () => new Promise((res) => (fakeLauncher ? fakeLauncher.close(() => { fakeLauncher = null; res() }) : res()))
  await launcherUp()
  const dbNow = (await db.query(`SELECT to_char(now() AT TIME ZONE 'UTC' - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') t`)).rows[0].t
  const manifest = (o = {}) => ({
    ...T.newCmsQaManifest({ runId, mode: 'manual-localhost', host: HOST, dbNow, gitHead: head, gitTree: treeId, buildId: 'qa', port: lport,
      users: [{ id: U.A, role: 'staff', markerExpiresAt: dbNow, remainingS: 0 }, { id: SUPER, role: 'admin', markerExpiresAt: dbNow, remainingS: 0 }] }),
    serverPid: process.pid, launcherPid: process.pid, ...o,
  })
  const writeManifest = (o) => fs.writeFileSync(markerFile, JSON.stringify(manifest(o), null, 2))
  const P_QA = uid(5001), P_QA2 = uid(5002), P_REAL = uid(5003), PP1 = uid(5011)
  await db.exec(`INSERT INTO public.cms_programs (id, name, status, start_date, end_date, scope, is_test, created_by, created_at, updated_at, activated_at, activated_by) VALUES
    ('${P_QA}', 'QA kết quả', 'active', current_date - 2, current_date + 27, 'stores', true, '${U.A}', now(), now(), now(), '${U.A}'),
    ('${P_QA2}', 'QA khác run', 'active', current_date - 2, current_date + 27, 'stores', true, '${SUPER}', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', '${SUPER}'),
    ('${P_REAL}', 'Thật', 'active', current_date - 2, current_date + 27, 'stores', false, '${SUPER}', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', '${SUPER}');
    INSERT INTO public.cms_program_stores (program_id, store_id) VALUES ('${P_QA}', '${L.storeId(1)}');
    INSERT INTO public.cms_program_products (id, program_id, product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms, advice_text, name_snapshot)
      VALUES ('${PP1}', '${P_QA}', '900001', 'none', NULL, 'Hộp', 30, 'Tư vấn QA', 'SP QA');
    INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit) VALUES ('${PP1}', '${P_QA}', 1, 1, NULL, 10000)`)
  const pub = (extra = [], env = WG, node = PRE) => run('cms-qa-results.mjs', ['publish', `--program=${P_QA}`, `--staff=${U.A}`, `--confirm-run=${runId}`, ...extra], env, node)
  const noWrite = async (r) => r.reqs === 0 && ledgers().length === 0 && (await nRuns()) === 0

  // 6a — chặn TRƯỚC IO (0 request tới shim, không sổ, không run)
  r = await pub([], {}, [])
  exp(r, 2, 'publish thiếu opt-in E2E_CMS_WRITE_QA', await noWrite(r))
  r = await pub([], W, [])
  exp(r, 2, 'publish khi KHÔNG có run QA mở (cổng writer ngược cmsWriteGate)', (await noWrite(r)) && /không có run QA đang mở/.test(r.out))
  writeManifest()
  r = await run('cms-qa-results.mjs', ['publish', `--program=${P_QA}`, `--staff=${U.A}`], WG, PRE)
  exp(r, 2, 'publish thiếu --confirm-run', (await noWrite(r)) && /thiếu --confirm-run/.test(r.out))
  r = await run('cms-qa-results.mjs', ['publish', `--program=${P_QA}`, `--staff=${U.A}`, '--confirm-run=cms-qa-20261103T101500-ffff'], WG, PRE)
  exp(r, 2, 'publish --confirm-run khác run đang mở', (await noWrite(r)) && /khác run đang mở/.test(r.out))
  r = await run('cms-qa-results.mjs', ['publish', `--program=${P_QA}`, `--staff=${U.B}`, `--confirm-run=${runId}`], WG, PRE)
  exp(r, 2, 'publish staff không phải tài khoản QA của run', (await noWrite(r)) && /không phải tài khoản QA vai staff/.test(r.out))
  const dirtyProbe = path.join(ROOT, 'qa-harness-dirty-probe.txt')
  if (REAL_GIT) {
    fs.writeFileSync(dirtyProbe, 'tạm — harness QA_HARNESS_GIT=real\n', { flag: 'wx' })
    try { r = await pub() } finally { fs.rmSync(dirtyProbe, { force: true }) }
  } else r = await pub([], { ...WG, QA_FAKE_STATUS: ' M webapp/x.ts' })
  exp(r, 2, 'publish trên cây bẩn ⇒ chặn (candidate phải sạch)', (await noWrite(r)) && /cây Git không sạch/.test(r.out))
  if (REAL_GIT) { writeManifest({ gitHead: 'f'.repeat(40) }); r = await pub(); writeManifest() } else r = await pub([], { ...WG, QA_FAKE_HEAD: 'f'.repeat(40) })
  exp(r, 2, 'publish khi HEAD khác candidate của run', (await noWrite(r)) && /HEAD \/ tree hiện tại khác/.test(r.out))
  await launcherDown()
  r = await pub()
  exp(r, 2, 'publish khi launcher không còn (cổng đóng)', (await noWrite(r)) && /launcher \/ server QA của run không còn chạy/.test(r.out))
  await launcherUp()
  writeManifest({ serverNotStopped: { pid: 12345, at: dbNow } })
  r = await pub()
  exp(r, 2, 'publish khi launcher ghi server CHƯA DỪNG', (await noWrite(r)) && /CHƯA DỪNG/.test(r.out))
  const deadPid = await new Promise((res) => { const ch = spawn(process.execPath, ['-e', '0']); ch.on('close', () => res(ch.pid)) })
  writeManifest({ launcherPid: deadPid })
  r = await pub()
  exp(r, 2, 'publish khi pid launcher đã chết (server + cổng còn)', (await noWrite(r)) && /launcher \/ server QA của run không còn chạy/.test(r.out))
  writeManifest({ launcherPid: undefined })
  r = await pub()
  exp(r, 2, 'publish khi manifest không ghi launcherPid (launcher cũ)', (await noWrite(r)) && /không ghi launcherPid/.test(r.out))
  writeManifest()

  // 6b — guard DB (cây sạch giả qua preload): trước khi cấp marker
  const noLedgerNoRun = async () => ledgers().length === 0 && (await nRuns()) === 0
  r = await run('cms-qa-results.mjs', ['publish', `--program=${P_REAL}`, `--staff=${U.A}`, `--confirm-run=${runId}`], WG, PRE)
  exp(r, 1, 'guard DB: chương trình THẬT ⇒ chặn, không sổ / không run', (await noLedgerNoRun()) && /chương trình THẬT/.test(r.out))
  r = await run('cms-qa-results.mjs', ['publish', `--program=${P_QA2}`, `--staff=${U.A}`, `--confirm-run=${runId}`], WG, PRE)
  exp(r, 1, 'guard DB: chương trình QA KHÔNG thuộc run ⇒ chặn', (await noLedgerNoRun()) && /không thuộc run/.test(r.out))
  r = await pub()
  exp(r, 1, 'guard DB: tài khoản QA không có marker ⇒ chặn', (await noLedgerNoRun()) && /marker QA không còn hạn/.test(r.out))
  await db.exec(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ('${U.A}', 'qa-script:harness', now() + interval '2 hours'), ('${SUPER}', 'qa-script:harness', now() + interval '2 hours')`)

  // 6c — QA-P1-1: launcher dừng TRONG LÚC guard chờ đọc DB ⇒ guard kiểm lại SAU IO, không ghi
  pgDelayMs = 700
  const pending = pub()
  await sleep(300)
  await launcherDown()
  r = await pending
  pgDelayMs = 0
  exp(r, 1, 'launcher dừng giữa lúc guard đọc DB ⇒ chặn sau IO, không sổ / không run', (await noLedgerNoRun()) && /launcher \/ server QA không còn chạy/.test(r.out))
  await launcherUp()

  // 6d — publish ĐẠT qua shim PostgREST (RPC 122 thật trên PGlite)
  r = await pub(['--lines-per-staff=40'])
  const w1 = lastWriter(r)
  const e1 = w1 && readLedger(`${w1}.json`)
  const run1 = e1 && (await db.query(`SELECT status, detail ->> 'qa_writer_id' wid, detail ->> 'qa_run_id' qrid, detail ->> 'source' src FROM public.cms_sync_runs WHERE id = $1`, [e1.result?.runId])).rows[0]
  const ptr = (await db.query(`SELECT current_result_run_id::text p FROM public.cms_programs WHERE id = $1`, [P_QA])).rows[0].p
  exp(r, 0, 'publish ĐẠT: sổ done, openedRunId = runId; run ok gắn qa_writer_id / qa_run_id / source qa; pointer = run',
    e1?.status === 'done' && e1.openedRunId === e1.result?.runId && run1?.status === 'ok' && run1.wid === w1 && run1.qrid === runId && run1.src === 'qa' && ptr === e1.result?.runId)

  // 6e — hai writer cùng chương trình; reconcile writer đã đủ ⇒ từ chối
  r = await pub(['--lines-per-staff=20'])
  const w2 = lastWriter(r)
  exp(r, 0, 'writer thứ hai cùng chương trình ⇒ ĐẠT, run riêng', w2 && w2 !== w1 && readLedger(`${w2}.json`)?.status === 'done')
  r = await run('cms-qa-results.mjs', ['reconcile', `--writer=${w1}`], W)
  exp(r, 1, 'reconcile writer đã done + đủ run ⇒ từ chối (không cần)', /không cần reconcile/.test(r.out))

  // 6f — mất phản hồi openRun (đã commit) ⇒ unknown; close ĐỎ; reconcile cần --finish-orphan; thu hồi đúng run liên kết
  rpcFaults.push({ fn: 'rpc_cms_sales_run_open', n: 1 })
  r = await pub()
  const w3 = lastWriter(r)
  const e3 = w3 && readLedger(`${w3}.json`)
  const run3 = w3 && (await db.query(`SELECT id::text, status FROM public.cms_sync_runs WHERE detail ->> 'qa_writer_id' = $1`, [w3])).rows
  exp(r, 1, 'mất phản hồi openRun ⇒ KẾT QUẢ KHÔNG RÕ, sổ unknown (runId null), DB có run running gắn writer', /KẾT QUẢ KHÔNG RÕ/.test(r.out)
    && e3?.status === 'unknown' && e3.result?.runId === null && run3?.length === 1 && run3[0].status === 'running')
  await launcherDown()
  r = await run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: HOST })
  exp(r, 1, 'close khi có writer unknown + run running ⇒ ĐỎ', fs.existsSync(markerFile) && /KHÔNG RÕ/.test(r.out) && /còn running/.test(r.out))
  await launcherUp()
  r = await run('cms-qa-results.mjs', ['reconcile', `--writer=${w3}`], W)
  exp(r, 1, 'reconcile thiếu --finish-orphan ⇒ dừng, nêu run', /--finish-orphan/.test(r.out))
  r = await run('cms-qa-results.mjs', ['reconcile', `--writer=${w3}`, '--finish-orphan'], W)
  const run3b = run3?.[0] && (await db.query(`SELECT status, error_code FROM public.cms_sync_runs WHERE id = $1`, [run3[0].id])).rows[0]
  exp(r, 0, 'reconcile --finish-orphan ⇒ đóng ĐÚNG run liên kết (error QA_WRITER_ABORTED), sổ reconciled', run3b?.status === 'error' && run3b.error_code === 'QA_WRITER_ABORTED'
    && readLedger(`${w3}.json`)?.status === 'reconciled')

  // 6g — mất phản hồi publish: 1 lần ⇒ lõi gọi lại, ĐẠT; 2 lần ⇒ PUBLISH_UNKNOWN, run đã ok ⇒ reconcile không orphan
  rpcFaults.push({ fn: 'rpc_cms_sales_run_publish', n: 1 })
  r = await pub()
  exp(r, 0, 'mất phản hồi publish 1 lần ⇒ gọi lại idempotent ⇒ ĐẠT', readLedger(`${lastWriter(r)}.json`)?.status === 'done')
  rpcFaults.push({ fn: 'rpc_cms_sales_run_publish', n: 2 })
  r = await pub()
  const w5 = lastWriter(r)
  exp(r, 1, 'mất phản hồi publish 2 lần ⇒ PUBLISH_UNKNOWN, sổ unknown', /PUBLISH_UNKNOWN/.test(r.out) && readLedger(`${w5}.json`)?.status === 'unknown')
  r = await run('cms-qa-results.mjs', ['reconcile', `--writer=${w5}`], W)
  exp(r, 0, 'reconcile sau PUBLISH_UNKNOWN (run đã ok) ⇒ reconciled, không orphan', /reconciled/.test(r.out) && /ok/.test(r.out))

  // 6h — lưu sổ CUỐI lỗi EPERM sau publish ⇒ rc 1 (không báo thành công), sổ còn running ⇒ reconcile
  r = await pub([], { ...WG, QA_FAULT_LEDGER_RENAME: '2' })
  const w6 = lastWriter(r)
  exp(r, 1, 'sổ cuối EPERM sau publish ⇒ rc 1 "SỔ WRITER CHƯA ĐÓNG", sổ trên đĩa còn running + openedRunId', /SỔ WRITER CHƯA ĐÓNG/.test(r.out)
    && /"status":"published"/.test(r.out) && readLedger(`${w6}.json`)?.status === 'running' && !!readLedger(`${w6}.json`)?.openedRunId)
  r = await run('cms-qa-results.mjs', ['reconcile', `--writer=${w6}`], W)
  exp(r, 0, 'reconcile sau sổ EPERM ⇒ reconciled', readLedger(`${w6}.json`)?.status === 'reconciled')

  // 6i — lưu sổ NGAY SAU openRun lỗi ⇒ CMS_QA_LEDGER_FAILED, dừng trước stage, run running ⇒ finish-orphan
  r = await pub([], { ...WG, QA_FAULT_LEDGER_RENAME: '1' })
  const w7 = lastWriter(r)
  const st7 = w7 && (await db.query(`SELECT count(*)::int n FROM public.cms_sync_runs r JOIN public.cms_sync_run_chunks c ON c.run_id = r.id WHERE r.detail ->> 'qa_writer_id' = $1`, [w7])).rows[0].n
  exp(r, 1, 'sổ sau openRun EPERM ⇒ CMS_QA_LEDGER_FAILED, 0 khối stage, sổ unknown', /CMS_QA_LEDGER_FAILED/.test(r.out) && st7 === 0 && readLedger(`${w7}.json`)?.status === 'unknown')
  r = await run('cms-qa-results.mjs', ['reconcile', `--writer=${w7}`, '--finish-orphan'], W)
  exp(r, 0, 'reconcile --finish-orphan sau LEDGER_FAILED ⇒ reconciled', readLedger(`${w7}.json`)?.status === 'reconciled')

  // 6j — run lạ trong cửa sổ ⇒ close ĐỎ (chèn tay rồi xoá)
  await launcherDown()
  const insRun = (prog, isTest, status, code, detail) => db.exec(`INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, status, finished_at, error_code, detail)
    VALUES ('sales', '${prog}', 1, ${isTest}, md5('x'), '${status}', now(), '${code}', '${JSON.stringify(detail)}'::jsonb)`)
  const closeQa = () => run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: HOST })
  await insRun(P_REAL, false, 'held', 'RESULTS_RELEASE_GATE', { source: 'operator' })
  r = await closeQa()
  exp(r, 1, 'close: run sales chương trình THẬT trong cửa sổ khi Q-206 HOLD ⇒ ĐỎ', fs.existsSync(markerFile) && /Q-206 HOLD/.test(r.out))
  await db.exec(`DELETE FROM public.cms_sync_runs WHERE program_id = '${P_REAL}'`)
  await insRun(P_QA, true, 'held', 'X', { source: 'operator' })
  r = await closeQa()
  exp(r, 1, 'close: run QA do cms-sales-sync (source operator) trên chương trình có writer ⇒ ĐỎ', fs.existsSync(markerFile) && /không do writer của run này \(source operator\)/.test(r.out))
  await db.exec(`DELETE FROM public.cms_sync_runs WHERE program_id = '${P_QA}' AND detail ->> 'source' = 'operator'`)
  await insRun(P_QA, true, 'held', 'X', { source: 'qa', qa_run_id: runId, qa_writer_id: 'w-ffffffffffff' })
  r = await closeQa()
  exp(r, 1, 'close: run gắn writer không có sổ ⇒ ĐỎ (không tự nhận)', fs.existsSync(markerFile) && /không có sổ trong run/.test(r.out))
  await db.exec(`DELETE FROM public.cms_sync_runs WHERE detail ->> 'qa_writer_id' = 'w-ffffffffffff'`)

  // 6k — close ĐẠT: mọi run sales trong cửa sổ liên kết đúng writer có sổ
  r = await closeQa()
  const closedJ = readJson(archived)
  const nSales = await nRuns()
  exp(r, 0, `close ĐẠT: manifest đóng ghi ${nSales} run sales + 7 writer, mọi run có writerId`, !fs.existsSync(markerFile) && closedJ?.status === 'closed'
    && closedJ.salesRuns?.length === nSales && closedJ.salesRuns.every((x) => /^w-[0-9a-f]{12}$/.test(x.writerId ?? '')) && closedJ.writers?.length === 7)
  ok(rpcFaults.every((f) => f.n === 0), 'mọi lỗi giả đã được tiêu thụ đúng số lần')
  fs.rmSync(writersDir, { recursive: true, force: true })
  fs.rmSync(archived, { force: true })
  ok(!fs.existsSync(markerFile) && !fs.existsSync(writersDir), `không để lại ${G.CMS_QA_MARKER} / sổ writer`)
  if (REAL_GIT) ok(git('status', '--porcelain', '--untracked-files=all') === '' && git('rev-parse', 'HEAD') === head, 'Git thật: cây vẫn sạch, HEAD không đổi sau §6')

  section('7. QA chốt P3a (work order 03/11 §4.2): lock-preview / lock có gate + sổ ý định — chặn trước IO, guard / quyền, từ chối xác định, mất phản hồi TRƯỚC / SAU commit, lỗi sổ ý định / sổ cuối, reconcile + thời gian lắng, close đối chiếu payout, chốt ngoài sổ')
  const SQL_123 = fs.readFileSync(path.join(MIG, '123_cms_payouts.sql'), 'utf8')
  const has123 = async () => (await db.query(`SELECT to_regclass('public.cms_payouts') IS NOT NULL AS h`)).rows[0].h === true
  const pre123 = path.join(tmp, 'pre123.json')
  if (!(await has123())) {
    await sleep(20)
    r = await run('cms-verify.mjs', ['acl-snapshot', `--expect-host=${HOST}`, `--out=${pre123}`])
    const p123 = readJson(pre123)
    exp(r, 0, 'acl-snapshot trước 123 (37 hàm cms của 120 + 121 + 122)', p123 && p123.acl.n_all - p123.acl.n_old === 37 && Number.isInteger(p123.acl.n_ex123))
    await sleep(20)
    await db.exec(SQL_123)
  }
  ok(await has123(), '123 THẬT đã áp trên PGlite của shim (cms_payouts tồn tại)')
  {
    // SQL của `start --with-lock` (launcher) + lượt dò reconcile chạy THẬT trên schema 123: có policy, nhánh thật còn khoá.
    const hp = (await db.query(R.CMS_QA_HAS_LOCK_POLICY_SQL)).rows[0]?.has_policy
    const rr = (await db.query(R.CMS_QA_REAL_LOCK_READY_SQL)).rows[0]?.real_ready
    const pb = (await db.query(R.CMS_QA_LOCK_PROBE_SQL)).rows[0]
    ok(hp === true && rr === 'false' && R.cmsQaLauncherLockDbCheck(hp, rr).ok === true
      && pb && typeof pb.can_see_all === 'boolean' && Number.isInteger(pb.payout_writers) && pb.payout_writers === 0,
      `SQL --with-lock + lượt dò reconcile chạy trên schema 123 (has_policy ${hp}, real.ready ${rr}, dò ${JSON.stringify(pb)})`)
  }
  const runId2 ='cms-qa-20261103T111500-cd34', runId3 = 'cms-qa-20261103T121500-ef56'
  const writersDir2 = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${runId2}.writers`)
  const archived2 = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${runId2}.json`)
  const writersDir3 = path.join(ROOT, 'qa-artifacts', 'cms-qa', `${runId3}.writers`)
  for (const p of [writersDir2, archived2, writersDir3]) if (fs.existsSync(p)) { console.error(`FAIL: đã có ${p} — dọn trước khi chạy`); process.exitCode = 2; return }
  await db.exec(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ('${U.mkt}', 'qa-script:harness', now() + interval '2 hours')`)
  const dbNowAt = async () => (await db.query(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') t`)).rows[0].t
  const manifestFor = (rid, at, o = {}) => ({
    ...T.newCmsQaManifest({ runId: rid, mode: 'manual-localhost', host: HOST, dbNow: at, gitHead: head, gitTree: treeId, buildId: 'qa', port: lport,
      users: [{ id: U.A, role: 'staff', markerExpiresAt: at, remainingS: 0 }, { id: SUPER, role: 'admin', markerExpiresAt: at, remainingS: 0 },
        { id: U.mkt, role: 'admin', markerExpiresAt: at, remainingS: 0 }] }),
    serverPid: process.pid, launcherPid: process.pid, ...o,
  })
  // QA-C: chương trình QA ĐÃ HẾT KỲ (ProductID riêng 9001xx, kỳ đã qua) do super QA tạo trong run; P_ACT còn đang chạy.
  const QC1 = uid(5101), QC2 = uid(5102), QC3 = uid(5103), QC4 = uid(5104), QC5 = uid(5105), P_ACT = uid(5106)
  const mkProg = (id, n, ended) => `INSERT INTO public.cms_programs (id, name, status, start_date, end_date, scope, is_test, created_by, created_at, updated_at, activated_at, activated_by)
      VALUES ('${id}', 'QA-C ${n}', 'active', current_date - ${ended ? 20 : 2}, current_date ${ended ? '- 2' : '+ 27'}, 'stores', true, '${SUPER}', now(), now(), now(), '${SUPER}');
    INSERT INTO public.cms_program_stores (program_id, store_id) VALUES ('${id}', '${L.storeId(1)}');
    INSERT INTO public.cms_program_products (id, program_id, product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms, advice_text, name_snapshot)
      VALUES ('${uid(5200 + n)}', '${id}', '9001${String(n).padStart(2, '0')}', 'none', NULL, 'Hộp', 30, 'Tư vấn QA-C', 'SP QA-C ${n}');
    INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit) VALUES ('${uid(5200 + n)}', '${id}', 1, 1, NULL, 10000);`
  await sleep(20)
  const dbNow2 = await dbNowAt()
  await sleep(20)
  await db.exec([[QC1, 1, true], [QC2, 2, true], [QC3, 3, true], [QC4, 4, true], [P_ACT, 6, false]].map(([id, n, e]) => mkProg(id, n, e)).join('\n'))
  fs.writeFileSync(markerFile, JSON.stringify(manifestFor(runId2, dbNow2), null, 2))
  await launcherUp()
  const pub2 = (prog, extra = [], rid = runId2) => run('cms-qa-results.mjs', ['publish', `--program=${prog}`, `--staff=${U.A}`, `--confirm-run=${rid}`, '--lines-per-staff=60', ...extra], WG, PRE)
  for (const [p, extra] of [[QC1, []], [QC2, []], [QC3, []], [QC4, ['--unassigned']], [P_ACT, []]]) {
    r = await pub2(p, extra)
    exp(r, 0, `publish bán giả ${p === P_ACT ? 'chương trình QA đang chạy' : 'QA-C đã hết kỳ'} …${p.slice(-4)}${extra.length ? ' (+ 2 dòng Chưa gán)' : ''}`)
  }
  const WL = { ...WG, CMS_PROGRAM_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true', CMS_LOCK_ENABLED: 'true' }
  const lockPrev = (prog, actor = SUPER, extra = [], env = WL) => run('cms-qa-results.mjs', ['lock-preview', `--program=${prog}`, `--actor=${actor}`, `--confirm-run=${runId2}`, ...extra], env, PRE)
  const prevOf = (x) => { const l = x.out.split('\n').find((s) => s.startsWith('{"program"')); try { return l ? JSON.parse(l) : null } catch { return null } }
  const lockCli = (prog, runX, pv, extra = [], env = WL, actor = SUPER) => run('cms-qa-results.mjs', ['lock', `--program=${prog}`, `--actor=${actor}`, `--confirm-run=${runId2}`, `--expect-run=${runX}`, `--policy-version=${pv}`, ...extra], env, PRE)
  const lastOp = (x) => /thao tác (l-[0-9a-f]{12})/.exec(x.out)?.[1] ?? null
  const lockFiles = () => (fs.existsSync(writersDir2) ? fs.readdirSync(writersDir2).filter((f) => /^l-[0-9a-f]{12}\.json$/.test(f)).sort() : [])
  const readLock = (op) => { try { return op ? R.parseCmsQaLockEntry(fs.readFileSync(path.join(writersDir2, `${op}.json`), 'utf8')).value ?? null : null } catch { return null } }
  const progState = async (p) => (await db.query(`SELECT g.status, (SELECT count(*)::int FROM public.cms_payouts x WHERE x.program_id = g.id) AS n FROM public.cms_programs g WHERE g.id = $1`, [p])).rows[0]
  const lockRpcs = () => rpcByFn.rpc_cms_program_lock ?? 0
  const recon = (op) => run('cms-qa-results.mjs', ['reconcile', `--writer=${op}`], W)
  const closeRun = () => run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: HOST })
  const FAKE_RUN = uid(7777)
  let op

  // 7a — chặn TRƯỚC IO (0 request, không sổ chốt)
  const noLockWrite = (x) => x.reqs === 0 && lockFiles().length === 0
  r = await lockCli(QC1, FAKE_RUN, 1, [], WG)
  exp(r, 2, 'lock thiếu cờ PROGRAM / EARNINGS / LOCK ở PROCESS env', noLockWrite(r) && /CMS_LOCK_ENABLED=true là biến PROCESS/.test(r.out))
  r = await lockCli(QC1, FAKE_RUN, 1, [], { ...WL, CMS_LOCK_ENABLED: 'false' })
  exp(r, 2, 'lock khi CMS_LOCK_ENABLED ≠ true ở process (chỉ nêu cờ thiếu)', noLockWrite(r) && /cần CMS_LOCK_ENABLED=true là biến PROCESS/.test(r.out))
  r = await lockPrev(QC1, U.A)
  exp(r, 2, 'lock-preview actor là staff QA (không phải admin của run)', noLockWrite(r) && /không phải tài khoản QA vai admin/.test(r.out))
  r = await run('cms-qa-results.mjs', ['lock', `--program=${QC1}`, `--actor=${SUPER}`, `--confirm-run=${runId2}`, `--expect-run=${FAKE_RUN}`], WL, PRE)
  exp(r, 2, 'lock thiếu --policy-version', noLockWrite(r) && /--policy-version/.test(r.out))
  r = await lockPrev(QC1, SUPER, [`--expect-run=${FAKE_RUN}`])
  exp(r, 2, 'lock-preview kèm --expect-run', noLockWrite(r) && /lock-preview không nhận/.test(r.out))
  r = await lockCli(QC1, FAKE_RUN, 1, [`--staff=${U.A}`])
  exp(r, 2, 'lock kèm --staff', noLockWrite(r) && /không nhận --staff/.test(r.out))
  r = await lockCli(QC1, FAKE_RUN, 1, ['--ack=ngắn'])
  exp(r, 2, 'lock --ack ngắn hơn 10 ký tự', noLockWrite(r) && /--ack/.test(r.out))
  r = await run('cms-qa-results.mjs', ['publish', `--program=${QC1}`, `--staff=${U.A}`, `--confirm-run=${runId2}`, `--actor=${SUPER}`], WG, PRE)
  exp(r, 2, 'publish kèm tham số chốt --actor ⇒ sai tham số', r.reqs === 0)
  await launcherDown()
  r = await lockCli(QC1, FAKE_RUN, 1)
  exp(r, 2, 'lock khi launcher không còn chạy', noLockWrite(r) && /launcher \/ server QA của run không còn chạy/.test(r.out))
  await launcherUp()

  // 7b — guard / quyền: không sổ, không RPC chốt
  const rpc0 = lockRpcs()
  r = await lockPrev(P_REAL)
  exp(r, 1, 'lock-preview chương trình THẬT ⇒ guard chặn (không mượn tài khoản QA)', lockFiles().length === 0 && /chương trình THẬT/.test(r.out))
  r = await lockPrev(QC1, U.mkt)
  exp(r, 1, 'lock-preview bởi admin QA KHÔNG phải super ⇒ FORBIDDEN (allowlist app)', /CHẶN: preview FORBIDDEN/.test(r.out))
  r = await lockCli(QC1, FAKE_RUN, 1, [], WL, U.mkt)
  exp(r, 1, 'lock bởi admin không phải super ⇒ FORBIDDEN, không sổ, không RPC', lockFiles().length === 0 && lockRpcs() === rpc0 && /CHẶN \(không gọi RPC chốt\): FORBIDDEN/.test(r.out))
  r = await lockPrev(P_ACT)
  exp(r, 1, 'lock-preview chương trình QA CHƯA hết kỳ ⇒ CMS_LOCK_NOT_ENDED', /CHƯA CHỐT ĐƯỢC: .*CMS_LOCK_NOT_ENDED/.test(r.out))

  // 7c — từ chối XÁC ĐỊNH ở DB (RPC đã gọi, transaction rollback) ⇒ sổ rejected, chương trình vẫn active
  r = await lockPrev(QC1)
  const pv1 = prevOf(r) ?? {}
  exp(r, 0, 'lock-preview QA-C đã hết kỳ ⇒ SẴN SÀNG (run hiện hành, policy QA, 0 blocker)', pv1.blockers?.length === 0 && /^[0-9a-f-]{36}$/.test(pv1.runId ?? '') && pv1.isTest === true && /SẴN SÀNG/.test(r.out))
  r = await lockCli(QC1, FAKE_RUN, pv1.policyVersion)
  op = lastOp(r)
  exp(r, 1, 'lock với run kỳ vọng sai ⇒ CMS_LOCK_RUN_CHANGED, sổ rejected, chương trình active', readLock(op)?.status === 'rejected' && readLock(op)?.result?.code === 'CMS_LOCK_RUN_CHANGED' && (await progState(QC1)).status === 'active')
  r = await lockCli(QC1, pv1.runId, pv1.policyVersion + 1)
  op = lastOp(r)
  exp(r, 1, 'lock với policy version sai ⇒ CMS_LOCK_POLICY_CHANGED, sổ rejected', readLock(op)?.status === 'rejected' && readLock(op)?.result?.code === 'CMS_LOCK_POLICY_CHANGED' && (await progState(QC1)).status === 'active')
  r = await lockCli(P_ACT, FAKE_RUN, pv1.policyVersion)
  op = lastOp(r)
  exp(r, 1, 'lock chương trình CHƯA hết kỳ ⇒ CMS_LOCK_NOT_ENDED, sổ rejected', readLock(op)?.result?.code === 'CMS_LOCK_NOT_ENDED' && (await progState(P_ACT)).status === 'active')

  // 7d — mất phản hồi TRƯỚC commit (đứt trước khi DB chạy hàm) ⇒ KHÔNG RÕ; chặn chốt lại; reconcile phải chờ lắng
  rpcFaultsBefore.push({ fn: 'rpc_cms_program_lock', n: 1 })
  r = await lockCli(QC1, pv1.runId, pv1.policyVersion)
  const opBefore = lastOp(r)
  const tBefore = Date.now()
  exp(r, 1, 'mất phản hồi TRƯỚC commit ⇒ KẾT QUẢ CHỐT KHÔNG RÕ, sổ unknown, DB chưa chốt', /KẾT QUẢ CHỐT KHÔNG RÕ/.test(r.out) && readLock(opBefore)?.status === 'unknown' && (await progState(QC1)).n === 0)
  const nB = lockFiles().length, rpcB = lockRpcs()
  r = await lockCli(QC1, pv1.runId, pv1.policyVersion)
  exp(r, 1, 'chốt lại khi còn thao tác unknown ⇒ CHẶN (reconcile trước), không sổ mới, không RPC', lockFiles().length === nB && lockRpcs() === rpcB && new RegExp(`${opBefore} của chương trình này còn unknown`).test(r.out))
  r = await recon(opBefore)
  exp(r, 1, 'reconcile ngay ⇒ CHỜ (chưa đủ thời gian lắng), sổ giữ unknown', /CHỜ: chưa đủ thời gian lắng/.test(r.out) && readLock(opBefore)?.status === 'unknown')

  // 7e — mất phản hồi SAU commit ⇒ KHÔNG RÕ (không báo thành công); close ĐỎ; reconcile phát hiện đã chốt
  r = await lockPrev(QC2)
  const pv2 = prevOf(r) ?? {}
  rpcFaults.push({ fn: 'rpc_cms_program_lock', n: 1 })
  r = await lockCli(QC2, pv2.runId, pv2.policyVersion)
  const opAfter = lastOp(r)
  exp(r, 1, 'mất phản hồi SAU commit ⇒ KẾT QUẢ CHỐT KHÔNG RÕ, sổ unknown, DB ĐÃ chốt', /KẾT QUẢ CHỐT KHÔNG RÕ/.test(r.out) && readLock(opAfter)?.status === 'unknown' && (await progState(QC2)).status === 'locked')
  await launcherDown()
  r = await closeRun()
  exp(r, 1, 'close khi còn thao tác chốt unknown + payout chưa khớp sổ ⇒ ĐỎ, manifest giữ', fs.existsSync(markerFile) && new RegExp(`thao tác chốt ${opBefore} KẾT QUẢ KHÔNG RÕ`).test(r.out) && /chốt ngoài sổ .*mất phản hồi chưa reconcile/.test(r.out))
  await launcherUp()
  r = await recon(opAfter)
  exp(r, 0, 'reconcile ⇒ phát hiện ĐÃ CHỐT (payout đúng run + actor của sổ), sổ reconciled', /ĐÃ CHỐT run/.test(r.out) && readLock(opAfter)?.status === 'reconciled' && readLock(opAfter)?.reconcile?.locked === true)
  const nA = lockFiles().length, rpcA = lockRpcs()
  r = await lockCli(QC2, pv2.runId, pv2.policyVersion)
  exp(r, 1, 'chốt lại chương trình đã locked ⇒ guard chặn trước sổ / RPC', lockFiles().length === nA && lockRpcs() === rpcA && /đã chốt \(locked\)/.test(r.out))

  // 7f — lưu sổ CUỐI lỗi sau RPC ⇒ SỔ CHỐT CHƯA ĐÓNG (rc 1), sổ còn ý định ⇒ reconcile
  r = await lockPrev(QC3)
  const pv3 = prevOf(r) ?? {}
  r = await lockCli(QC3, pv3.runId, pv3.policyVersion, [], { ...WL, QA_FAULT_LEDGER_RENAME: '1' })
  const opSave = lastOp(r)
  exp(r, 1, 'sổ cuối EPERM sau RPC ⇒ SỔ CHỐT CHƯA ĐÓNG, sổ còn intent, DB đã chốt', /SỔ CHỐT CHƯA ĐÓNG/.test(r.out) && /"status":"locked"/.test(r.out) && readLock(opSave)?.status === 'intent' && (await progState(QC3)).status === 'locked')
  r = await run('cms-qa-results.mjs', ['status'], W)
  exp(r, 0, 'status liệt kê thao tác chốt (ý định, pid không còn ⇒ cần reconcile)', new RegExp(`${opSave} · chốt intent \\(pid KHÔNG còn`).test(r.out))
  r = await recon(opSave)
  exp(r, 0, 'reconcile sổ còn ý định ⇒ ĐÃ CHỐT, reconciled', readLock(opSave)?.status === 'reconciled' && readLock(opSave)?.reconcile?.locked === true)

  // 7g — ghi sổ Ý ĐỊNH lỗi ⇒ dừng TRƯỚC RPC; lý do Q-213 (giả định QA) bắt buộc khi còn dòng Chưa gán
  r = await lockPrev(QC4)
  const pv4 = prevOf(r) ?? {}
  exp(r, 0, 'lock-preview QA-C có 2 dòng Chưa gán dưới ngưỡng QA ⇒ SẴN SÀNG, cần lý do', pv4.needsAck === true && pv4.unassignedLines === 2 && /--ack=/.test(r.out))
  const nI = lockFiles().length, rpcI = lockRpcs()
  r = await lockCli(QC4, pv4.runId, pv4.policyVersion, ['--ack=Đã soát 2 dòng Chưa gán QA'], { ...WL, QA_FAULT_LOCK_INTENT: '1' })
  exp(r, 1, 'ghi sổ Ý ĐỊNH lỗi ⇒ CMS_QA_LEDGER_FAILED, không sổ, KHÔNG gọi RPC, chưa chốt', /CHẶN \(không gọi RPC chốt\): CMS_QA_LEDGER_FAILED/.test(r.out) && lockFiles().length === nI && lockRpcs() === rpcI && (await progState(QC4)).status === 'active')
  r = await lockCli(QC4, pv4.runId, pv4.policyVersion)
  op = lastOp(r)
  exp(r, 1, 'lock thiếu lý do khi còn dòng Chưa gán ⇒ CMS_LOCK_ACK_REQUIRED (sổ rejected)', readLock(op)?.result?.code === 'CMS_LOCK_ACK_REQUIRED' && (await progState(QC4)).status === 'active')
  r = await lockCli(QC4, pv4.runId, pv4.policyVersion, ['--ack=  Đã soát 2 dòng Chưa gán QA  '])
  op = lastOp(r)
  const ack4 = (await db.query(`SELECT ack_reason FROM public.cms_payouts WHERE program_id = $1`, [QC4])).rows[0]?.ack_reason
  exp(r, 0, 'lock có lý do ⇒ ĐÃ CHỐT; sổ done (ack = true, không chép lý do); DB lưu lý do đã chuẩn hoá', readLock(op)?.status === 'done' && readLock(op)?.ack === true
    && !JSON.stringify(readLock(op)).includes('Đã soát') && ack4 === 'Đã soát 2 dòng Chưa gán QA' && (await progState(QC4)).status === 'locked')

  // 7d (tiếp) — qua thời gian lắng, 0 phiên chốt ⇒ reconcile kết luận CHƯA chốt; chốt lại cùng run kỳ vọng ⇒ ĐẠT
  const waitMs = tBefore + R.CMS_QA_LOCK_SETTLE_MS + 1_500 - Date.now()
  if (waitMs > 0) await sleep(waitMs)
  r = await recon(opBefore)
  exp(r, 0, 'reconcile sau thời gian lắng ⇒ CHƯA chốt (không payout, 0 phiên chốt), sổ reconciled', /CHƯA chốt/.test(r.out) && readLock(opBefore)?.status === 'reconciled' && readLock(opBefore)?.reconcile?.locked === false)
  r = await lockCli(QC1, pv1.runId, pv1.policyVersion)
  op = lastOp(r)
  exp(r, 0, 'chốt lại sau reconcile (cùng run kỳ vọng) ⇒ ĐẠT, sổ done', readLock(op)?.status === 'done' && readLock(op)?.result?.runId === pv1.runId && (await progState(QC1)).status === 'locked')

  // 7h — close ĐẠT: mọi thao tác chốt đã khép, mọi payout QA-C trong cửa sổ khớp sổ
  await launcherDown()
  const nLocks = lockFiles().length
  r = await closeRun()
  const c2 = readJson(archived2)
  exp(r, 0, `close ĐẠT: ${nLocks} thao tác chốt khép, 4 payout QA-C trong cửa sổ đều khớp sổ, 5 writer`, !fs.existsSync(markerFile) && c2?.locks?.length === nLocks
    && c2.payouts?.length === 4 && c2.payouts.every((p) => p.isTest && /^l-[0-9a-f]{12}$/.test(p.operationId ?? '')) && c2.writers?.length === 5)
  ok(rpcFaults.every((f) => f.n === 0) && rpcFaultsBefore.every((f) => f.n === 0), '§7: mọi lỗi giả đã được tiêu thụ đúng số lần')

  // 7h' — VERIFY phase 123 bằng CLI thật trên DB đã có payout QA (V5 phải "đã chứng minh"); phase 122 trên DB 123 ⇒ LỆCH
  if (fs.existsSync(pre123)) {
    const post123 = path.join(tmp, 'post123.json')
    r = await run('cms-verify.mjs', ['post', '--phase=123', `--pre=${pre123}`, `--expect-host=${HOST}`, `--out=${post123}`])
    const j123 = readJson(post123)
    const v5 = j123?.checks?.find((c) => c.id === 'v5-payout-invariants')
    exp(r, 0, `post 123 sau 4 lần chốt QA (${j123?.checks?.length ?? 0} mục) — V5 bất biến payout ĐÃ chứng minh`, j123?.checks?.every((c) => c.ok) && v5?.ok === true && v5.proven !== false)
    r = await run('cms-verify.mjs', ['post', '--phase=122', `--pre=${pre122}`, `--expect-host=${HOST}`])
    exp(r, 1, 'post 122 trên DB đã 123 ⇒ LỆCH phase-match (không lấy xanh bằng phase cũ)', /LỆCH\s+phase-match — PHASE KHÔNG PHÙ HỢP: DB có marker CMS cao nhất 123/.test(r.out))
    r = await run('cms-verify.mjs', ['v8', `--user=${SUPER}`, '--role=super', '--phase=123', '--expect-qa=true', `--expect-host=${HOST}`])
    exp(r, 0, 'v8 --phase=123 super có marker (rpc_cms_payout theo phạm vi hiện tại)', /ĐẠT: \d+ \/ \d+/.test(r.out))
  } else ok(false, 'PRE 123 không có — §7 phải tự áp 123 (không chạy phase 123 trên DB áp từ trước)')

  // 7i — chốt NGOÀI sổ (mô phỏng bấm "Chốt kỳ" trên UI server QA / gọi RPC trực tiếp) ⇒ close ĐỎ
  await sleep(20)
  const dbNow3 = await dbNowAt()
  await sleep(20)
  await db.exec(mkProg(QC5, 5, true))
  fs.writeFileSync(markerFile, JSON.stringify(manifestFor(runId3, dbNow3), null, 2))
  await launcherUp()
  r = await pub2(QC5, [], runId3)
  exp(r, 0, 'run 3: publish bán giả QA-C 5')
  const pv5 = (await db.query(`SELECT public.rpc_cms_lock_preview($1) AS p`, [QC5])).rows[0].p
  await db.query(`SELECT public.rpc_cms_program_lock($1, $2, $3, $4, NULL)`, [QC5, pv5.run_id, pv5.policy_version, SUPER])
  await launcherDown()
  r = await closeRun()
  exp(r, 1, 'close: payout QA trong cửa sổ KHÔNG có thao tác trong sổ ⇒ ĐỎ (chốt ngoài sổ), manifest giữ', fs.existsSync(markerFile) && /chốt ngoài sổ/.test(r.out) && (await progState(QC5)).status === 'locked')
  // Dọn ĐÚNG đường dẫn harness tạo (run 3 cố ý không đóng được: QC5 locked vĩnh viễn trên PGlite tạm — H8).
  fs.rmSync(markerFile, { force: true })
  fs.rmSync(writersDir3, { recursive: true, force: true })
  fs.rmSync(writersDir2, { recursive: true, force: true })
  fs.rmSync(archived2, { force: true })
  ok(!fs.existsSync(markerFile) && !fs.existsSync(writersDir2) && !fs.existsSync(writersDir3) && !fs.existsSync(archived2), `§7: không để lại ${G.CMS_QA_MARKER} / sổ`)
  if (REAL_GIT) ok(git('status', '--porcelain', '--untracked-files=all') === '' && git('rev-parse', 'HEAD') === head, 'Git thật: cây vẫn sạch, HEAD không đổi sau §7')

  await new Promise((res) => server.close(res))
  await db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${pass} đạt · ${fail} lỗi`)
  process.exitCode = fail ? 1 : 0
}
