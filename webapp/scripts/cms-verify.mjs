#!/usr/bin/env node
// CMS P1-R2 — gói VERIFY CHỈ ĐỌC cho migration 120 / 121 (review PM runbook P1 02/11; r1 sau db-reviewer / security).
// Mỗi lệnh = MỘT transaction `BEGIN; SET TRANSACTION READ ONLY; …; ROLLBACK;` qua pg-meta với câu lệnh CỐ ĐỊNH ở
// e2e/cmsQaTooling.ts (không nhận SQL tự do, không nới ops-ro). V8 mô phỏng phiên authenticated (SET LOCAL ROLE + claim
// không ký — không đọc secret), so với oracle tính độc lập theo VAI KHAI BÁO; không thay smoke đăng nhập thật (D3 / E3).
//
//   node scripts/cms-verify.mjs acl-snapshot --expect-host=<host> --out=<pre.json>      # PRE: chụp NGAY TRƯỚC migration
//   node scripts/cms-verify.mjs post --phase=120|121 --pre=<pre.json> --expect-host=<host> [--out=<file.json>]
//   node scripts/cms-verify.mjs v8 --user=<uuid> --role=super|admin|sm|staff|qlch --expect-host=<host> [--expect-qa=true|false] [--expect-readable=N] [--require-proven=programs,products,…] [--out=…]
//   node scripts/cms-verify.mjs print-sql --what=acl|v8 [--user=<uuid> --role=…]          # khối cố định cho Studio (V8: REPEATABLE READ)
//
// --out nên trỏ ra NGOÀI repo (vd. C:/circa-gate-logs/…). Kết quả chỉ có tên hàm / bảng / cờ / số đếm / id che.
// Dòng in: ĐẠT · LỆCH (gate đỏ) · CHƯA (điều kiện đúng nhưng dữ liệu chưa đủ để chứng minh — vd. RLS cắt bớt).
// Thoát: 0 không mục LỆCH · 1 có mục lệch / lỗi DB · 2 sai tham số (trước mọi IO).
import fs from 'node:fs'
import { die2, loadTooling, mergedEnv, parseArgs, pgMeta, readEnvFileText, supabaseHost } from './lib-cms-ops.mjs'

const a = parseArgs(process.argv.slice(2), {
  values: ['--expect-host', '--out', '--phase', '--pre', '--user', '--role', '--expect-qa', '--expect-readable', '--require-proven', '--what'],
})
if (!['acl-snapshot', 'post', 'v8', 'print-sql'].includes(a.cmd) || a.bad.length) {
  console.log('dùng: node scripts/cms-verify.mjs <acl-snapshot | post --phase=120|121 --pre=FILE | v8 --user=UUID --role=… | print-sql --what=acl|v8> --expect-host=<host>')
  process.exit(2)
}
const { T } = await loadTooling()

if (a.cmd === 'print-sql') {
  if (a.values['--what'] === 'acl') console.log(T.pgMetaReadOnly(T.cmsVerifyAclSql()))
  else if (a.values['--what'] === 'v8') {
    if (!T.isCmsUuid(a.values['--user'])) die2('--user phải là UUID')
    if (!T.CMS_V8_ROLES.includes(a.values['--role'])) die2(`--role bắt buộc: ${T.CMS_V8_ROLES.join('|')}`)
    console.log(T.pgMetaReadOnlySnapshot(T.cmsVerifyV8Sql(a.values['--user'], a.values['--role'])))
  } else die2('--what=acl|v8')
  process.exit(0)
}

const env = mergedEnv(readEnvFileText())
const host = supabaseHost(env)
if (!host || !env.SUPABASE_SERVICE_ROLE_KEY) die2('thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
if (a.values['--expect-host'] !== host) die2(`cần --expect-host=${host} khớp đúng host Supabase đích`)

const isMd5 = (s) => /^[0-9a-f]{32}$/.test(String(s))
let phase = null, pre = null, user = null, role = null
const expect = {}
if (a.cmd === 'post') {
  phase = a.values['--phase']
  if (phase !== '120' && phase !== '121') die2('--phase=120|121')
  try {
    pre = JSON.parse(fs.readFileSync(String(a.values['--pre']), 'utf8'))
  } catch { die2('--pre phải là file JSON từ `acl-snapshot` chụp NGAY TRƯỚC migration') }
  const acl = pre?.acl
  if (pre?.kind !== 'cms-acl-snapshot' || pre?.host !== host || !acl || !['n_all', 'n_old'].every((k) => Number.isInteger(acl[k]))
    || !['md5_all', 'md5_old'].every((k) => isMd5(acl[k])) || !acl.db_now) {
    die2('--pre sai định dạng hoặc chụp ở host khác')
  }
  // PRE phải đúng phase: trước 120 chưa có hàm cms nào; trước 121 có đúng 7 hàm của 120.
  const cmsBefore = acl.n_all - acl.n_old
  if ((phase === '120' && cmsBefore !== 0) || (phase === '121' && cmsBefore !== 7)) {
    die2(`--pre không phải ảnh ngay trước ${phase} (đang có ${cmsBefore} hàm cms)`)
  }
}
if (a.cmd === 'v8') {
  user = a.values['--user']
  role = a.values['--role']
  if (!T.isCmsUuid(user)) die2('--user phải là UUID')
  if (!T.CMS_V8_ROLES.includes(role)) die2(`--role bắt buộc: ${T.CMS_V8_ROLES.join('|')} (super = admin trong allowlist)`)
  if (a.values['--expect-qa'] !== undefined) {
    if (!['true', 'false'].includes(a.values['--expect-qa'])) die2('--expect-qa=true|false')
    expect.qa = a.values['--expect-qa'] === 'true'
  }
  if (a.values['--expect-readable'] !== undefined) {
    if (!/^[0-9]{1,6}$/.test(a.values['--expect-readable'])) die2('--expect-readable phải là số nguyên ≥ 0')
    expect.readable = Number(a.values['--expect-readable'])
  }
  if (a.values['--require-proven'] !== undefined) {
    const list = a.values['--require-proven'].split(',').map((s) => s.trim()).filter(Boolean)
    if (!list.length || list.some((k) => !T.CMS_V8_TABLE_KEYS.includes(k))) die2(`--require-proven=<${T.CMS_V8_TABLE_KEYS.join('|')}>,…`)
    expect.requireProven = list
  }
}

const ro = (sql) => pgMeta(env, T.pgMetaReadOnly(sql))
const at = new Date().toISOString()
let result
try {
  if (a.cmd === 'acl-snapshot') {
    const [acl] = await ro(T.cmsVerifyAclSql())
    const [who] = await ro(T.CMS_VERIFY_SQL.whoami)
    result = { kind: 'cms-acl-snapshot', at, host, who, acl: { ...acl, db_now: T.toIsoUtc(acl.db_now) } }
    console.log(`ảnh ACL hàm public · ${host} · giờ DB ${T.toIsoUtc(acl.db_now)}: tổng ${acl.n_all} / ${acl.md5_all} · ngoài cms ${acl.n_old} / ${acl.md5_old}`)
  } else if (a.cmd === 'post') {
    const q = T.CMS_VERIFY_SQL
    const input = {
      phase,
      whoami: (await ro(q.whoami))[0],
      markers: await ro(q.markers),
      maxNumeric: (await ro(q.maxNumeric))[0],
      functions: await ro(q.functions),
      policies: await ro(q.policies),
      triggers: await ro(q.triggers),
      tableShape: await ro(q.tableShape),
      tables: await ro(q.tables),
      roles: await ro(q.roles),
      oneRunningIndex: await ro(q.oneRunningIndex),
      aclPost: (await ro(T.cmsVerifyAclSql()))[0],
      aclPre: pre.acl,
    }
    if (phase === '121') {
      input.inv121 = { overlap: await ro(q.inv121Overlap), tiers: await ro(q.inv121Tiers), catalog: await ro(q.inv121Catalog) }
      input.isolation = (await ro(q.isolation))[0]
    }
    const checks = T.evaluateCmsVerify(input)
    result = { kind: 'cms-verify-post', at, host, phase, preAt: pre.acl.db_now, input, checks }
  } else {
    // V8 trong snapshot REPEATABLE READ: oracle (DO) và phiên authenticated (SELECT) đọc cùng dữ liệu.
    const [row] = await pgMeta(env, T.pgMetaReadOnlySnapshot(T.cmsVerifyV8Sql(user, role)))
    const checks = T.evaluateCmsV8(row, user, role, expect)
    result = { kind: 'cms-verify-v8', at, host, user: T.maskCmsUuid(user), role, expect, row: { ...row, uid: row.uid === user ? 'khớp' : 'LỆCH' }, checks }
    console.log(`V8 · ${T.maskCmsUuid(user)} · ${role} · tổng ${row.total_programs} chương trình · thấy ${row.seen_programs} (QA ${row.test_programs}, nháp ${row.draft_programs}) · marker ${row.qa}`)
  }
} catch (e) {
  console.log(`LỖI DB: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
for (const c of result.checks ?? []) console.log(`${!c.ok ? 'LỆCH' : c.proven === false ? 'CHƯA' : 'ĐẠT '}  ${c.id} — ${c.detail}`)
if (a.values['--out']) {
  fs.writeFileSync(a.values['--out'], JSON.stringify(result, null, 2) + '\n')
  console.log(`đã lưu ${a.values['--out']}`)
}
if (result.checks) {
  const bad = result.checks.filter((c) => !c.ok).length
  const unproven = result.checks.filter((c) => c.ok && c.proven === false).length
  console.log(bad ? `KHÔNG ĐẠT: ${bad} mục lệch` : `ĐẠT: ${result.checks.length - unproven} / ${result.checks.length}${unproven ? ` · ${unproven} mục CHƯA CHỨNG MINH` : ''}`)
  process.exit(bad ? 1 : 0)
}
process.exit(0)
