#!/usr/bin/env node
// CMS 126 (sales-only — PM 06/11 đổi phạm vi: trả hàng phase sau): SINH supabase/migrations/126_cms_sales_only_results_release.sql +
// rollback từ scripts/cms-126/*.sql + thân 2 hàm 122 NGUYÊN VĂN (chỉ chèn / thay đúng các đoạn dưới). Mỗi chỗ vá phải khớp ĐÚNG MỘT lần
// (split/join — không String.replace để không ăn `$$`). KHÔNG sửa tay file sinh ra; sửa template / chỗ vá rồi sinh lại.
//   node scripts/gen-cms-126.mjs            # ghi 2 file, in sha256
//   node scripts/gen-cms-126.mjs --check    # chỉ so: file trên đĩa ≠ bản sinh ⇒ thoát 1 (test drift: scripts/qa-cms-126.mjs)
// Hàm thay (2, OR REPLACE giữ chữ ký / owner / ACL): 122 cms__results_release_open (false → true) · 122 rpc_cms_sales_run_publish
// (held RETURNS_NOT_SUPPORTED_THIS_PHASE cho chương trình thật có điều chỉnh đã seal / ứng viên âm + dấu results_basis). Không hàm mới.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
export const CMS_126_FILE = path.join(MIG, '126_cms_sales_only_results_release.sql')
export const CMS_126_ROLLBACK_FILE = path.join(MIG, 'rollback', '126_cms_sales_only_results_release_rollback.sql')

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

/** Mã held khi chương trình thật có dòng điều chỉnh (khớp CMS_RETURNS_NOT_SUPPORTED của lib/cms/releaseGate.ts). */
export const CMS_126_HELD_CODE = 'RETURNS_NOT_SUPPORTED_THIS_PHASE'

/** Nhánh chèn vào CASE của publish: SAU cổng RESULTS_RELEASE_GATE, trước END (thứ tự mã cũ giữ nguyên). */
export const CMS_126_PUBLISH_ADJ = `    -- 126 (PM 06/11 sales-only — trả hàng phase sau): chương trình thật có dòng điều chỉnh ĐÃ SEAL hoặc dòng ứng viên âm ⇒ KHÔNG công
    -- bố (không bỏ dòng âm để công bố riêng phần dương). Căn cứ chỉ là dữ liệu đã seal: totals.adjustment_lines (seal bước 10 đối
    -- chiếu = số dòng kết quả ADJUSTMENT; S12 ép ADJUSTMENT ⇔ dòng INCLUDED âm) + dòng không INCLUDED (chưa gán / ngoài phạm vi) âm
    -- đã stage (index cms_sales_lines_excluded_idx). totals thiếu / sai dạng ⇒ coi như có điều chỉnh (fail-closed; CASE giữ thứ tự,
    -- không ép kiểu chuỗi lạ).
    WHEN NOT v_run.is_test AND (
           CASE WHEN jsonb_typeof(v_run.seal_expect -> 'totals' -> 'adjustment_lines') = 'number'
                     AND (v_run.seal_expect -> 'totals' ->> 'adjustment_lines') ~ '^(0|[1-9][0-9]{0,8})$'
                THEN (v_run.seal_expect -> 'totals' ->> 'adjustment_lines')::bigint <> 0
                ELSE true END
        OR EXISTS (SELECT 1 FROM public.cms_sales_lines sl
                    WHERE sl.run_id = p_run_id AND sl.disposition <> 'INCLUDED' AND (sl.base_quantity < 0 OR sl.gmv_amount < 0)))
      THEN '${CMS_126_HELD_CODE}'
`
/** Câu công bố thay thế: đóng dấu căn cứ kết quả cho chương trình thật (DB quyết định, không nhận từ caller). */
export const CMS_126_PUBLISH_STAMP = `  -- 126: đóng dấu căn cứ kết quả do DB quyết định (không nhận từ caller) — chương trình thật = CMS tạm tính theo dòng bán, chưa xử
  -- lý trả hàng. Không đổi seal / vân tay dòng 14 trường; run QA giữ nguyên như 122.
  UPDATE public.cms_sync_runs SET status = 'ok', finished_at = now(), published_at = now(),
         detail = CASE WHEN v_run.is_test THEN detail
                       ELSE detail || jsonb_build_object('results_basis', 'sales_only_v1', 'results_gate', '126') END
   WHERE id = p_run_id;
`

export function buildCms126() {
  const S122 = fs.readFileSync(path.join(MIG, '122_cms_results.sql'), 'utf8')
  const tpl = (f) => fs.readFileSync(path.join(HERE, 'cms-126', f), 'utf8')

  const GATE0 = fn(S122, 'cms__results_release_open')
  let gate = orReplace(GATE0)
  gate = patch(gate, 'AS $$\n  SELECT false\n$$;', 'AS $$\n  SELECT true\n$$;', 'gate true')

  const PUB0 = fn(S122, 'rpc_cms_sales_run_publish')
  let pub = orReplace(PUB0)
  pub = patch(pub, "    WHEN NOT v_run.is_test AND NOT public.cms__results_release_open() THEN 'RESULTS_RELEASE_GATE'\n",
    `    WHEN NOT v_run.is_test AND NOT public.cms__results_release_open() THEN 'RESULTS_RELEASE_GATE'\n${CMS_126_PUBLISH_ADJ}`, 'publish adj')
  pub = patch(pub, "  UPDATE public.cms_sync_runs SET status = 'ok', finished_at = now(), published_at = now() WHERE id = p_run_id;\n",
    CMS_126_PUBLISH_STAMP, 'publish stamp')

  const sec = (t) => `\n-- ── ${t} ${'─'.repeat(Math.max(4, 74 - t.length))}\n`
  const md5Block = (pairs, msg) => `DO $$
BEGIN
  IF ${pairs.map(([sig, t]) => `(SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.${sig}'::regprocedure) IS DISTINCT FROM '${md5(cmsProsrc(t))}'`).join('\n     OR ')} THEN
    RAISE EXCEPTION '${msg}';
  END IF;
END $$;`
  const SIG_GATE = 'cms__results_release_open()'
  const SIG_PUB = 'rpc_cms_sales_run_publish(uuid)'
  const PREFLIGHT_MD5 = md5Block([[SIG_GATE, GATE0], [SIG_PUB, PUB0]],
    '126 preflight: thân cms__results_release_open / rpc_cms_sales_run_publish KHÁC bản 122 đã duyệt (md5) — dừng, đối chiếu tay')
  const POST_MD5 = md5Block([[SIG_GATE, gate], [SIG_PUB, pub]], '126 hậu kiểm: thân 2 hàm thay lệch bản sinh (md5)')
  const RB_PRE_MD5 = md5Block([[SIG_GATE, gate], [SIG_PUB, pub]],
    'rollback 126 preflight: thân 2 hàm hiện tại KHÁC bản 126 đã sinh (md5) — có sửa tay? dừng, đối chiếu')
  const MD5_CHECK = md5Block([[SIG_GATE, GATE0], [SIG_PUB, PUB0]], 'rollback 126 hậu kiểm: thân 2 hàm 122 khôi phục lệch nguyên văn (md5)')

  const migration = [
    patch(tpl('a-head.sql'), '-- @@PREFLIGHT_MD5@@', PREFLIGHT_MD5, 'preflight md5'),
    sec('1. Hai hàm 122 thay (sinh từ thân nguyên văn 122 + vá gen-cms-126)'), gate, '\n\n', pub, '\n',
    patch(tpl('c-tail.sql'), '-- @@POST_MD5@@', POST_MD5, 'post md5'),
  ].join('')
  const rollback = [
    patch(tpl('rb-head.sql'), '-- @@PRE_MD5@@', RB_PRE_MD5, 'rollback pre md5'),
    sec('Khôi phục NGUYÊN VĂN 122'), orReplace(GATE0), '\n\n', orReplace(PUB0), '\n',
    patch(tpl('rb-tail.sql'), '-- @@MD5_CHECK@@', MD5_CHECK, 'rollback md5 check'),
  ].join('')
  const md5s = {
    gate122: md5(cmsProsrc(GATE0)), publish122: md5(cmsProsrc(PUB0)), gate126: md5(cmsProsrc(gate)), publish126: md5(cmsProsrc(pub)),
  }
  return { migration, rollback, originals: { gate: GATE0, publish: PUB0 }, replaced: { gate, publish: pub }, md5s }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const { migration, rollback, md5s } = buildCms126()
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex')
  if (process.argv.includes('--check')) {
    const same = (f, s) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === s
    const ok = same(CMS_126_FILE, migration) && same(CMS_126_ROLLBACK_FILE, rollback)
    console.log(ok ? 'gen-cms-126: file trên đĩa KHỚP bản sinh' : 'gen-cms-126: LỆCH bản sinh — chạy lại node scripts/gen-cms-126.mjs')
    process.exitCode = ok ? 0 : 1
  } else {
    fs.writeFileSync(CMS_126_FILE, migration)
    fs.writeFileSync(CMS_126_ROLLBACK_FILE, rollback)
    console.log(`126_cms_sales_only_results_release.sql ${migration.split('\n').length - 1} dòng sha256 ${h(migration)}`)
    console.log(`rollback/126_cms_sales_only_results_release_rollback.sql ${rollback.split('\n').length - 1} dòng sha256 ${h(rollback)}`)
    console.log(`md5 prosrc: ${JSON.stringify(md5s)}`)
  }
}
