#!/usr/bin/env node
// CMS P1-R1 — cấp / thu marker QA (public.cms_qa_access) cho tài khoản QA (review PM runbook P1 02/11). OPERATOR-ONLY khi
// ghi; mặc định DRY-RUN (chỉ đọc trạng thái + in kế hoạch). Không migration / endpoint runtime; SQL cố định ở
// e2e/cmsQaTooling.ts (chỉ chèn UUID đã kiểm + số giờ nguyên). Không nhận / in email, tên, key.
//
//   node scripts/cms-qa-access.mjs status --users=<uuid,…>
//   node scripts/cms-qa-access.mjs grant  --users=<uuid,…> --ttl-hours=<1…168>                                   # DRY-RUN
//   node scripts/cms-qa-access.mjs grant  --users=<uuid,…> --ttl-hours=<1…168> --confirm --expect-host=<host>    # GHI
//   node scripts/cms-qa-access.mjs revoke --users=<uuid,…>                                                       # DRY-RUN
//   node scripts/cms-qa-access.mjs revoke --users=<uuid,…> --confirm --expect-host=<host>                        # GHI
//
// Hạn marker tính bằng giờ DB (expires_at = now() + H giờ; trigger 120 ép granted_at = now()); tối đa 7 ngày (CHECK 120).
// Cấp: mọi user_id phải là tài khoản có thật, thiếu một ⇒ không cấp ai (transaction). Thu: DELETE … WHERE user_id = ANY(list).
// Env (process env > webapp/.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Thoát: 0 đạt · 1 lỗi DB / tài khoản không hợp lệ / hậu kiểm lệch · 2 sai tham số / thiếu cấu hình (trước mọi IO).
// Kết thúc tự nhiên qua runCli (process.exitCode); mọi nhánh dừng bằng return / die2 (ném) — không chạy tiếp tới ghi.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, die2, loadTooling, mergedEnv, parseArgs, pgMeta, readEnvFileText, rethrowCliExit, runCli, supabaseHost } from './lib-cms-ops.mjs'

async function main() {
  const a = parseArgs(process.argv.slice(2), { flags: ['--confirm', '--allow-admin'], values: ['--users', '--ttl-hours', '--expect-host'] })
  if (!['status', 'grant', 'revoke'].includes(a.cmd) || a.bad.length) {
    console.log('dùng: node scripts/cms-qa-access.mjs <status|grant|revoke> --users=<uuid,…> [--ttl-hours=N] [--allow-admin] [--confirm --expect-host=<host>]')
    return 2
  }
  const { T, G } = await loadTooling()
  const users = T.parseCmsQaUserIds(a.values['--users'])
  if (!users.ok) die2(users.reason)
  const ids = users.value
  let ttl = null
  if (a.cmd === 'grant') {
    const t = T.parseCmsQaTtlHours(a.values['--ttl-hours'])
    if (!t.ok) die2(t.reason)
    ttl = t.value
  } else if (a.values['--ttl-hours'] !== undefined) die2('--ttl-hours chỉ dùng với grant')
  const confirm = a.flags.has('--confirm')
  if (a.cmd === 'status' && confirm) die2('status không có chế độ ghi')
  if (a.cmd !== 'grant' && a.flags.has('--allow-admin')) die2('--allow-admin chỉ dùng với grant')

  // Thu marker giữa run QA đang mở ⇒ super QA tạo chương trình THẬT ngay (security review P1-2): đóng run trước.
  const markerFile = path.join(ROOT, G.CMS_QA_MARKER)
  if (a.cmd === 'revoke' && fs.existsSync(markerFile)) {
    const m = T.parseCmsQaManifest(fs.readFileSync(markerFile, 'utf8'))
    const inRun = m.ok && m.value.status === 'open' ? ids.filter((id) => m.value.users.some((u) => u.id === id)) : []
    if (!m.ok) die2(`${G.CMS_QA_MARKER} hỏng — không thu marker khi chưa rõ run; báo PM / operator`)
    if (inRun.length && confirm) die2(`${inRun.length} tài khoản đang trong run QA mở (${m.value.runId}) — dừng server, chạy \`cms-qa-run.mjs close\` rồi mới thu`)
    if (inRun.length) console.log(`CẢNH BÁO: ${inRun.length} tài khoản đang trong run QA mở — lệnh thu (--confirm) sẽ bị chặn tới khi đóng run`)
  }

  const env = mergedEnv(readEnvFileText())
  const host = supabaseHost(env)
  if (!host || !env.SUPABASE_SERVICE_ROLE_KEY) die2('thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  if (confirm && a.values['--expect-host'] !== host) die2(`--confirm cần --expect-host=${host} khớp đúng host Supabase đích (chống ghi nhầm DB)`)

  const mode = a.cmd === 'status' ? 'CHỈ ĐỌC' : confirm ? 'GHI (--confirm)' : 'DRY-RUN (không ghi)'
  console.log(`CMS marker QA · ${a.cmd} · ${mode} · đích ${host} · ${ids.length} tài khoản${ttl ? ` · hạn ${ttl} giờ (giờ DB)` : ''}`)

  const fmt = (r) => `  ${T.maskCmsUuid(r.user_id)}  ${r.user_exists ? `${r.role ?? '?'} / ${r.store_type ?? 'không nhà thuốc'}${r.store_active === false ? ' (ngừng)' : ''}` : 'KHÔNG CÓ TÀI KHOẢN'}  ·  marker ${r.active ? `còn ${Math.floor(r.remaining_s / 60)} phút (hết ${T.toIsoUtc(r.expires_at)})` : r.expires_at ? 'ĐÃ HẾT HẠN' : 'chưa có'}`
  const ms = (ts) => Date.parse(T.toIsoUtc(ts))
  const status = async () => pgMeta(env, T.pgMetaReadOnly(T.cmsQaStatusSql(ids)))

  try {
    const before = await status()
    console.log(`trạng thái hiện tại (giờ DB ${T.toIsoUtc(before[0].db_now)}):`)
    for (const r of before) console.log(fmt(r))
    const unknown = before.filter((r) => !r.user_exists)
    if (a.cmd === 'status') return 0

    if (a.cmd === 'grant') {
      if (unknown.length) { console.log(`DỪNG: ${unknown.length} user_id không có tài khoản — không cấp ai`); return 1 }
      // Marker cho tài khoản vai admin (super / admin thật hay QA đều là 'admin') ⇒ mọi chương trình họ tạo trong hạn thành
      // is_test, ẩn với mọi người (security review P2-5): bắt xác nhận tường minh.
      const admins = before.filter((r) => r.role === 'admin')
      if (admins.length && !a.flags.has('--allow-admin')) {
        console.log(`DỪNG: ${admins.length} tài khoản vai admin (${admins.map((r) => T.maskCmsUuid(r.user_id)).join(', ')}) — trong hạn marker, chương trình họ tạo sẽ là is_test (ẩn). Kiểm đúng tài khoản QA rồi thêm --allow-admin`)
        return 1
      }
      if (!confirm) {
        console.log(`kế hoạch: cấp / gia hạn marker ${ttl} giờ cho ${ids.length} tài khoản (granted_by = ${T.CMS_QA_GRANTED_BY}). Không ghi gì.`)
        console.log(`để ghi: thêm --confirm --expect-host=${host}`)
        return 0
      }
      const rows = await pgMeta(env, T.pgMetaWrite(T.cmsQaGrantSql(ids, ttl)))
      const okRows = rows.length === ids.length && rows.every((r) => ms(r.expires_at) - ms(r.granted_at) === ttl * 3_600_000)
      const after = await status()
      const allActive = after.every((r) => r.active)
      console.log(`đã ghi ${rows.length} dòng; hạn = granted_at + ${ttl} giờ: ${okRows ? 'ĐẠT' : 'LỆCH'}; hậu kiểm marker còn hạn: ${allActive ? 'ĐẠT' : 'LỆCH'}`)
      for (const r of after) console.log(fmt(r))
      return okRows && allActive ? 0 : 1
    }

    // revoke
    const withMarker = before.filter((r) => r.expires_at !== null)
    if (!confirm) {
      console.log(`kế hoạch: xoá marker của ${withMarker.length} / ${ids.length} tài khoản (WHERE user_id = ANY(list)). Không ghi gì.`)
      console.log(`để ghi: thêm --confirm --expect-host=${host}`)
      return 0
    }
    const del = await pgMeta(env, T.pgMetaWrite(T.cmsQaRevokeSql(ids)))
    const after = await status()
    const none = after.every((r) => r.expires_at === null)
    console.log(`đã xoá ${del.length} marker (kỳ vọng ${withMarker.length}); hậu kiểm không còn marker: ${none ? 'ĐẠT' : 'LỆCH'}`)
    for (const r of after) console.log(fmt(r))
    return none && del.length === withMarker.length ? 0 : 1
  } catch (e) {
    rethrowCliExit(e)
    console.log(`LỖI DB: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

await runCli(main)
