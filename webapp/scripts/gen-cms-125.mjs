#!/usr/bin/env node
// CMS 125 (CMS-UNCAPPED-1 — CMS-Q-220 bỏ trần): SINH supabase/migrations/125_cms_uncapped_last_tier.sql + rollback từ
// scripts/cms-125/*.sql + thân 2 RPC 121 NGUYÊN VĂN (chỉ chèn đúng các đoạn dưới). Mỗi chỗ vá phải khớp ĐÚNG MỘT lần (split/join —
// không String.replace để không ăn `$$`). KHÔNG sửa tay file sinh ra; sửa template / chỗ vá rồi sinh lại.
//   node scripts/gen-cms-125.mjs            # ghi 2 file, in sha256
//   node scripts/gen-cms-125.mjs --check    # chỉ so: file trên đĩa ≠ bản sinh ⇒ thoát 1 (test drift: scripts/qa-cms-125.mjs)
// Hàm thay (2, OR REPLACE giữ chữ ký + ACL): 121 rpc_cms_import_commit (bậc cuối phải "to": null) · 121 rpc_cms_program_activate
// (thang bậc hợp lệ + bậc cuối không giới hạn). Hàm mới (1): cms__tiers_last_open_guard (constraint trigger). Thân trigger pointer 122
// (cms__programs_result_guard) KHÔNG đổi — chỉ kiểm md5 trước khi tắt tạm.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
export const CMS_125_FILE = path.join(MIG, '125_cms_uncapped_last_tier.sql')
export const CMS_125_ROLLBACK_FILE = path.join(MIG, 'rollback', '125_cms_uncapped_last_tier_rollback.sql')

/** Thân `CREATE FUNCTION public.<name>(` … `$$;` của file migration. */
function fn(sql, name) {
  const i = sql.indexOf(`CREATE FUNCTION public.${name}(`)
  if (i < 0 || sql.indexOf(`CREATE FUNCTION public.${name}(`, i + 1) >= 0) throw new Error(`hàm ${name}: không thấy hoặc trùng`)
  const j = sql.indexOf('$$;', sql.indexOf('AS $$', i) + 5)
  return sql.slice(i, j + 3)
}
function patch(text, from, to, label) {
  const n = text.split(from).length - 1
  if (n !== 1) throw new Error(`vá "${label}": khớp ${n} lần (cần đúng 1)`)
  return text.split(from).join(to)
}
const orReplace = (t) => patch(t, 'CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.', 'OR REPLACE')
/** prosrc = chuỗi giữa `AS $$` và `$$;` cuối, BỎ \r (md5 khớp md5(replace(prosrc, E'\r', '')) của DB — cùng công thức VERIFY). */
export const cmsProsrc = (t) => t.slice(t.indexOf('AS $$') + 5, t.lastIndexOf('$$;')).split('\r').join('')
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')

/** Đoạn chèn vào rpc_cms_import_commit: SAU mọi kiểm payload / bậc / SP (kể cả PRODUCT_UNKNOWN), TRƯỚC khoá danh mục. */
export const CMS_125_IMPORT_CHECK = `
  -- 125 (CMS-Q-220 — bỏ trần, thay Q-210a): bậc CUỐI mỗi SP phải không giới hạn ("to": null). Chạy SAU mọi kiểm kiểu / range /
  -- liên tục / payload ở trên (payload hỏng vẫn CMS_IMPORT_BAD_TIERS / BAD_PAYLOAD), TRƯỚC khoá danh mục (thứ tự khoá 121 giữ nguyên).
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'products') x
              WHERE jsonb_typeof((x->'tiers')->(jsonb_array_length(x->'tiers') - 1)->'to') IS DISTINCT FROM 'null') THEN
    RAISE EXCEPTION 'CMS_IMPORT_TIER_LAST_FINITE' USING ERRCODE = '22023';
  END IF;
`
/** Đoạn chèn vào rpc_cms_program_activate: sau kiểm target danh mục, trước phạm vi nhà thuốc / khoá danh mục. */
export const CMS_125_ACTIVATE_CHECK = `  -- 125 (CMS-Q-220): mọi SP có thang bậc hợp lệ (bắt đầu 1, liên tục theo tier_order, chỉ bậc cuối mở) và bậc cuối KHÔNG giới hạn
  -- — cấu hình chưa chuyển đổi (cận cuối hữu hạn) không kích hoạt được, kể cả khi guard bị vượt bằng quyền owner.
  IF EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = v_prog.id
               AND NOT EXISTS (SELECT 1 FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id))
     OR EXISTS (SELECT 1 FROM (SELECT t.tier_order, t.qty_from, t.qty_to,
                                      lag(t.qty_to) OVER w AS prev_to, row_number() OVER w AS rn,
                                      count(*) OVER (PARTITION BY t.program_product_id) AS n
                                 FROM public.cms_program_tiers t WHERE t.program_id = v_prog.id
                               WINDOW w AS (PARTITION BY t.program_product_id ORDER BY t.tier_order)) x
                 WHERE x.tier_order <> x.rn OR (x.rn = 1 AND x.qty_from <> 1)
                    OR (x.rn > 1 AND (x.prev_to IS NULL OR x.qty_from::bigint <> x.prev_to::bigint + 1)) OR (x.qty_to IS NULL AND x.rn <> x.n)) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_TIERS_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cms_program_products pp
              WHERE pp.program_id = v_prog.id
                AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id
                      ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL) THEN
    RAISE EXCEPTION 'CMS_PROGRAM_TIER_LAST_FINITE' USING ERRCODE = 'P0001';
  END IF;
`

export function buildCms125() {
  const S121 = fs.readFileSync(path.join(MIG, '121_cms_import_activation.sql'), 'utf8')
  const S122 = fs.readFileSync(path.join(MIG, '122_cms_results.sql'), 'utf8')
  const tpl = (f) => fs.readFileSync(path.join(HERE, 'cms-125', f), 'utf8')

  const COMMIT0 = fn(S121, 'rpc_cms_import_commit')
  let commit = orReplace(COMMIT0)
  commit = patch(commit, '\n  -- Khoá danh mục rồi kiểm trùng với chương trình active / locked khác, giao ngày, cùng namespace (câu lệnh mới).\n',
    `${CMS_125_IMPORT_CHECK}\n  -- Khoá danh mục rồi kiểm trùng với chương trình active / locked khác, giao ngày, cùng namespace (câu lệnh mới).\n`, 'commit last-tier check')

  const ACT0 = fn(S121, 'rpc_cms_program_activate')
  let act = orReplace(ACT0)
  act = patch(act, "    RAISE EXCEPTION 'CMS_PROGRAM_CATALOG_TARGET_MISSING' USING ERRCODE = 'P0001';\n  END IF;\n",
    `    RAISE EXCEPTION 'CMS_PROGRAM_CATALOG_TARGET_MISSING' USING ERRCODE = 'P0001';\n  END IF;\n${CMS_125_ACTIVATE_CHECK}`, 'activate tier checks')

  // Thân hàm trigger pointer 122 (chỉ kiểm, không thay).
  const GUARD122 = fn(S122, 'cms__programs_result_guard')

  const sec = (t) => `\n-- ── ${t} ${'─'.repeat(Math.max(4, 74 - t.length))}\n`
  const md5Block = (pairs, msg) => `DO $$
BEGIN
  IF ${pairs.map(([sig, t]) => `(SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.${sig}'::regprocedure) IS DISTINCT FROM '${md5(cmsProsrc(t))}'`).join('\n     OR ')} THEN
    RAISE EXCEPTION '${msg}';
  END IF;
END $$;`
  const SIG_COMMIT = 'rpc_cms_import_commit(uuid, text, text, jsonb, uuid)'
  const SIG_ACT = 'rpc_cms_program_activate(uuid, uuid)'
  const PREFLIGHT_MD5 = md5Block([[SIG_COMMIT, COMMIT0], [SIG_ACT, ACT0], ['cms__programs_result_guard()', GUARD122]],
    '125 preflight: thân 2 RPC 121 / trigger pointer 122 KHÁC bản đã duyệt (md5) — dừng, đối chiếu tay')
  const POST_MD5 = md5Block([[SIG_COMMIT, commit], [SIG_ACT, act]], '125 hậu kiểm: thân 2 RPC thay lệch bản sinh (md5)')
  const MD5_CHECK = md5Block([[SIG_COMMIT, COMMIT0], [SIG_ACT, ACT0]], 'rollback 125 hậu kiểm: thân 2 RPC 121 khôi phục lệch nguyên văn (md5)')

  const migration = [
    patch(tpl('a-head.sql'), '-- @@PREFLIGHT_MD5@@', PREFLIGHT_MD5, 'preflight md5'),
    sec('1. RPC 121 thay (sinh từ thân nguyên văn 121 + vá gen-cms-125)'), commit, '\n\n', act, '\n',
    tpl('b-guard.sql'),
    patch(tpl('c-tail.sql'), '-- @@POST_MD5@@', POST_MD5, 'post md5'),
  ].join('')
  const rollback = [
    tpl('rb-head.sql'),
    sec('Khôi phục NGUYÊN VĂN 121'), orReplace(COMMIT0), '\n\n', orReplace(ACT0), '\n',
    patch(tpl('rb-tail.sql'), '-- @@MD5_CHECK@@', MD5_CHECK, 'rollback md5 check'),
  ].join('')
  const md5s = {
    commit121: md5(cmsProsrc(COMMIT0)), activate121: md5(cmsProsrc(ACT0)), guard122: md5(cmsProsrc(GUARD122)),
    commit125: md5(cmsProsrc(commit)), activate125: md5(cmsProsrc(act)),
  }
  return { migration, rollback, originals: { commit: COMMIT0, activate: ACT0 }, replaced: { commit, activate: act }, md5s }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const { migration, rollback, md5s } = buildCms125()
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex')
  if (process.argv.includes('--check')) {
    const same = (f, s) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === s
    const ok = same(CMS_125_FILE, migration) && same(CMS_125_ROLLBACK_FILE, rollback)
    console.log(ok ? 'gen-cms-125: file trên đĩa KHỚP bản sinh' : 'gen-cms-125: LỆCH bản sinh — chạy lại node scripts/gen-cms-125.mjs')
    process.exitCode = ok ? 0 : 1
  } else {
    fs.writeFileSync(CMS_125_FILE, migration)
    fs.writeFileSync(CMS_125_ROLLBACK_FILE, rollback)
    console.log(`125_cms_uncapped_last_tier.sql ${migration.split('\n').length - 1} dòng sha256 ${h(migration)}`)
    console.log(`rollback/125_cms_uncapped_last_tier_rollback.sql ${rollback.split('\n').length - 1} dòng sha256 ${h(rollback)}`)
    console.log(`md5 prosrc: ${JSON.stringify(md5s)}`)
  }
}
