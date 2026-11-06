#!/usr/bin/env node
// CMS P1-R2 — gói VERIFY CHỈ ĐỌC cho migration 120 / 121 (review PM runbook P1 02/11; r1 sau db-reviewer / security);
// phase 122 (PM 03/11 §5): bộ kỳ vọng / vân tay sau 122 riêng, phase DB ≠ phase khai báo ⇒ mục phase-match đỏ (không xanh giả).
// phase 123 (P3a chốt kỳ): bộ riêng — 18 hàm / 46 trigger ALWAYS / 2 bảng payout / TRUNCATE thu hồi / V0 owner / V4 policy /
// V5–V6 bất biến payout (tổng + từng dược sĩ + run còn như lúc seal; chưa có payout ⇒ CHƯA) / V7 isolation / quyền cột gián
// tiếp + view phụ thuộc bảng payout / V8 migration (mọi chương trình thật bị chặn chốt); PRE 123 = acl-snapshot ngay trước 123
// (đúng 37 hàm cms). `--require-proven=v5,lock-preview` ép mục đó phải ĐÃ chứng minh (CHƯA ⇒ rc 1).
// Mỗi lệnh = MỘT transaction `BEGIN; SET TRANSACTION READ ONLY; …; ROLLBACK;` qua pg-meta với câu lệnh CỐ ĐỊNH ở
// e2e/cmsQaTooling.ts (không nhận SQL tự do, không nới ops-ro). V8 mô phỏng phiên authenticated (SET LOCAL ROLE + claim
// không ký — không đọc secret), so với oracle tính độc lập theo VAI KHAI BÁO; không thay smoke đăng nhập thật (D3 / E3).
//
//   node scripts/cms-verify.mjs acl-snapshot --expect-host=<host> --out=<pre.json>      # PRE: chụp NGAY TRƯỚC migration
//   node scripts/cms-verify.mjs post --phase=120|121|122|123|124|125 --pre=<pre.json> --expect-host=<host> [--require-proven=v5,lock-preview (chỉ 123)] [--out=<file.json>]
//   node scripts/cms-verify.mjs v8 --user=<uuid> --role=super|admin|sm|staff|qlch [--phase=120|121|122|123|124|125] --expect-host=<host> [--expect-qa=true|false] [--expect-readable=N] [--require-proven=programs,products,…,results] [--out=…]
//   node scripts/cms-verify.mjs print-sql --what=acl|v8 [--user=<uuid> --role=… --phase=121|122|123|124|125]   # khối cố định cho Studio (V8: REPEATABLE READ)
//   … post --phase=123|122 --profile=after-rollback-124 --pre=<PRE của phase nền, chụp TRƯỚC khi áp phase đó>   # sau rollback 124:
//     rollback 124 cố ý giữ ràng buộc part cms_sync_run_chunks có 'source_lines' ⇒ profile chỉ nhận đúng phần dư đó, marker 124 phải
//     vắng, mọi mục khác theo phase nền. Không dùng được trên DB còn 124 / phase khác (PM 2026-11-05 INV-P1-1).
// V8 --phase bỏ trống chỉ hợp lệ khi DB ở 120 / 121; DB đã chạy 122 / 123 mà không khai đúng --phase=122 / --phase=123 ⇒ mục v8-phase đỏ.
// V8 --phase=123 (P3a): như 122 + rpc_cms_payout theo phạm vi hiện tại (Q-208 / Q-217) và SM thấy chương trình 'locked'.
//
// --out nên trỏ ra NGOÀI repo (vd. C:/circa-gate-logs/…). Không có email / tên / SĐT. Dòng in màn hình che UUID (8 ký tự);
// file --out giữ input THÔ để soát lại — gồm UUID chương trình / run / user ĐẦY ĐỦ (V8: uid ghi 'khớp' / 'LỆCH', user che).
// Dòng in: ĐẠT · LỆCH (gate đỏ) · CHƯA (điều kiện đúng nhưng dữ liệu chưa đủ để chứng minh — vd. RLS cắt bớt).
// Thoát: 0 không mục LỆCH · 1 có mục lệch / lỗi DB · 2 sai tham số (trước mọi IO). Kết thúc tự nhiên qua runCli
// (process.exitCode) — không process.exit (lỗi libuv Node 24 / Windows sau fetch, PM 02/11 B3).
import fs from 'node:fs'
import { die2, loadTooling, mergedEnv, parseArgs, pgMeta, readEnvFileText, rethrowCliExit, runCli, supabaseHost } from './lib-cms-ops.mjs'

async function main() {
  const a = parseArgs(process.argv.slice(2), {
    values: ['--expect-host', '--out', '--phase', '--pre', '--user', '--role', '--expect-qa', '--expect-readable', '--require-proven', '--what', '--profile'],
  })
  if (!['acl-snapshot', 'post', 'v8', 'print-sql'].includes(a.cmd) || a.bad.length) {
    console.log('dùng: node scripts/cms-verify.mjs <acl-snapshot | post --phase=120|121|122|123|124|125 --pre=FILE [--require-proven=v5,lock-preview] [--profile=after-rollback-124 (chỉ --phase=123|122)] | v8 --user=UUID --role=… [--phase=121|122|123|124|125] | print-sql --what=acl|v8> --expect-host=<host>')
    return 2
  }
  const { T } = await loadTooling()
  // --profile (PM 2026-11-05 INV-P1-1): CHỈ cho `post`, CHỈ phase nền khai trong T.CMS_VERIFY_PROFILE_PHASES — sai ⇒ 2 trước mọi IO.
  const profile = a.values['--profile']
  if (profile !== undefined) {
    if (a.cmd !== 'post') die2('--profile chỉ dùng với `post`')
    if (!T.cmsVerifyProfileValid(profile, String(a.values['--phase']))) {
      die2(`--profile=${T.CMS_VERIFY_PROFILES.map((p) => `${p} (chỉ --phase=${T.CMS_VERIFY_PROFILE_PHASES[p].join('|')})`).join(' · ')}`)
    }
  }
  // V8: --phase tuỳ chọn (bỏ trống = trước 122, giữ lệnh runbook P1); DB đã 122 ⇒ phải khai --phase=122, DB đã 123 ⇒ --phase=123 (mục v8-phase).
  const v8Phase = () => {
    const p = a.values['--phase']
    if (p !== undefined && !T.CMS_V8_PHASES.includes(p)) die2('--phase=120|121|122|123|124|125 cho v8')
    return p
  }

  if (a.cmd === 'print-sql') {
    if (a.values['--what'] === 'acl') console.log(T.pgMetaReadOnly(T.cmsVerifyAclSql()))
    else if (a.values['--what'] === 'v8') {
      if (!T.isCmsUuid(a.values['--user'])) die2('--user phải là UUID')
      if (!T.CMS_V8_ROLES.includes(a.values['--role'])) die2(`--role bắt buộc: ${T.CMS_V8_ROLES.join('|')}`)
      const ph = v8Phase()
      // SQL Studio không có bộ đánh giá: thiếu --phase ⇒ SQL KHÔNG kiểm RPC 122 (db-reviewer P2-7) — cảnh báo ở stderr (stdout chỉ SQL).
      if (ph === undefined) console.error('CẢNH BÁO: không khai --phase — SQL này chỉ hợp lệ trước 122 và KHÔNG kiểm RPC đọc kết quả / chi trả; DB 122 dùng --phase=122, DB 123 dùng --phase=123.')
      console.log(T.pgMetaReadOnlySnapshot(T.cmsVerifyV8Sql(a.values['--user'], a.values['--role'], ph)))
    } else die2('--what=acl|v8')
    return 0
  }

  const env = mergedEnv(readEnvFileText())
  const host = supabaseHost(env)
  if (!host || !env.SUPABASE_SERVICE_ROLE_KEY) die2('thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  if (a.values['--expect-host'] !== host) die2(`cần --expect-host=${host} khớp đúng host Supabase đích`)

  const isMd5 = (s) => /^[0-9a-f]{32}$/.test(String(s))
  let phase = null, pre = null, user = null, role = null
  const expect = {}
  if (a.cmd === 'v8') expect.phase = v8Phase()
  if (a.cmd === 'post') {
    phase = a.values['--phase']
    if (!T.CMS_VERIFY_PHASES.includes(phase)) die2(`--phase=${T.CMS_VERIFY_PHASES.join('|')}`)
    try {
      pre = JSON.parse(fs.readFileSync(String(a.values['--pre']), 'utf8'))
    } catch { die2('--pre phải là file JSON từ `acl-snapshot` chụp NGAY TRƯỚC migration') }
    const acl = pre?.acl
    if (pre?.kind !== 'cms-acl-snapshot' || pre?.host !== host || !acl || !['n_all', 'n_old'].every((k) => Number.isInteger(acl[k]))
      || !['md5_all', 'md5_old'].every((k) => isMd5(acl[k])) || !acl.db_now) {
      die2('--pre sai định dạng hoặc chụp ở host khác')
    }
    // PRE phải đúng phase: trước 120 chưa có hàm cms nào; trước 121 có đúng 7 (120); trước 122 có đúng 14 (120 + 121);
    // trước 123 có đúng 37 (120 + 121 + 122).
    const cmsBefore = acl.n_all - acl.n_old
    if (cmsBefore !== T.cmsFnCountBefore(phase)) {
      die2(`--pre không phải ảnh ngay trước ${phase} (đang có ${cmsBefore} hàm cms)`)
    }
    // --require-proven cho post (cùng cơ chế V8): mục của khoá CHƯA chứng minh ⇒ LỆCH (rc 1). Khoá theo phase.
    if (a.values['--require-proven'] !== undefined) {
      const list = a.values['--require-proven'].split(',').map((s) => s.trim()).filter(Boolean)
      const keys = T.cmsPostProvenKeys(phase)
      if (!list.length || list.some((k) => !keys.includes(k))) die2(`--require-proven cho post --phase=${phase}: <${keys.join('|') || '(không có khoá)'}>,…`)
      expect.requireProven = list
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
      const keys = T.cmsV8ProvenKeys(expect.phase)
      if (!list.length || list.some((k) => !keys.includes(k))) die2(`--require-proven=<${keys.join('|')}>,… (theo --phase)`)
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
      if (phase !== '120') {
        input.inv121 = { overlap: await ro(q.inv121Overlap), tiers: await ro(q.inv121Tiers), catalog: await ro(q.inv121Catalog) }
        input.isolation = (await ro(q.isolation))[0]
      }
      if (Number(phase) >= 122) {
        // Hàm 122 chỉ tồn tại sau 122 — DB chưa ở 122 ⇒ lỗi DB (rc 1) + phase-match đỏ trên lượt chạy đúng phase.
        input.p122 = {
          tiersUnique: await ro(q.tiersUnique), pointerFk: await ro(q.pointerFk),
          releaseGate: (await ro(q.releaseGate))[0], inv122Pointer: await ro(q.inv122Pointer),
          fnDefs: await ro(q.fnDefs), columns: await ro(q.columns),
        }
      }
      if (Number(phase) >= 123) {
        // cms__lock_policy / cms__config_fp / cms_payouts chỉ có sau 123 — DB chưa ở 123 ⇒ LỖI DB (rc 1), không bao giờ xanh.
        input.p123 = {
          owners: (await ro(q.owners))[0], isolation123: (await ro(q.isolation123))[0], triggerFns: await ro(q.triggerFns),
          lockPolicy: (await ro(q.lockPolicy))[0], payoutAcl: await ro(q.payoutAcl),
          invPayout: (await ro(q.invPayout))[0], invLocked: (await ro(q.invLocked))[0],
          invPayoutStaff: (await ro(q.invPayoutStaff))[0], invRunFrozen: (await ro(q.invRunFrozen))[0],
          payoutReach: await ro(q.payoutReach), lockPreview: (await ro(q.lockPreview))[0],
        }
      }
      if (Number(phase) >= 124) input.p124 = { invAttest: (await ro(q.invAttest))[0] }
      // 125 (CMS-Q-220): cấu hình chưa chốt không còn bậc cuối hữu hạn + run hiện hành không mang trần (không áp run lịch sử đã chốt).
      if (Number(phase) >= 125) input.p125 = { invLastTier: await ro(q.inv125LastTier), invCurrentCap: await ro(q.inv125CurrentCap), current: (await ro(q.inv125Current))[0] }
      if (expect.requireProven) input.requireProven = expect.requireProven
      if (profile !== undefined) {
        input.profile = profile
        console.log(`PROFILE ${profile}: VERIFY phase NỀN ${phase} sau rollback 124 — chỉ nhận phần dư có chủ đích, mọi mục khác theo phase ${phase}`)
      }
      const checks = T.evaluateCmsVerify(input)
      result = { kind: 'cms-verify-post', at, host, phase, profile: profile ?? null, preAt: pre.acl.db_now, input, checks }
    } else {
      // V8 trong snapshot REPEATABLE READ: oracle (DO) và phiên authenticated (SELECT) đọc cùng dữ liệu.
      const [row] = await pgMeta(env, T.pgMetaReadOnlySnapshot(T.cmsVerifyV8Sql(user, role, expect.phase)))
      const checks = T.evaluateCmsV8(row, user, role, expect)
      result = { kind: 'cms-verify-v8', at, host, user: T.maskCmsUuid(user), role, expect, row: { ...row, uid: row.uid === user ? 'khớp' : 'LỆCH' }, checks }
      console.log(`V8 · phase ${expect.phase ?? '(trước 122)'} · ${T.maskCmsUuid(user)} · ${role} · tổng ${row.total_programs} chương trình · thấy ${row.seen_programs} (QA ${row.test_programs}, nháp ${row.draft_programs}) · marker ${row.qa}`)
    }
  } catch (e) {
    rethrowCliExit(e)
    console.log(`LỖI DB: ${e instanceof Error ? e.message : String(e)}`)
    return 1
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
    return bad ? 1 : 0
  }
  return 0
}

await runCli(main)
