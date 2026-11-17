#!/usr/bin/env node
// CMS 131 (F-A sửa chương trình có version — PM spec 17/11 planning/research/cms-program-revision-import-spec-2026-11-17.md §3): SINH
// supabase/migrations/131_cms_program_revision.sql + rollback từ scripts/cms-131/131.template.sql (điền ma trận ACL, danh sách hàm mới,
// khối hậu kiểm md5 thân hàm) + thân NGUYÊN VĂN 4 hàm thay lấy từ 121 / 122 / 124 / 130 cho rollback. Mỗi chỗ điền khớp ĐÚNG MỘT lần
// (split/join — không String.replace để không ăn `$$`). KHÔNG sửa tay file sinh ra.
//   node scripts/gen-cms-131.mjs            # ghi 2 file, in sha256
//   node scripts/gen-cms-131.mjs --check    # chỉ so: file trên đĩa ≠ bản sinh ⇒ thoát 1 (harness: scripts/qa-cms-131.mjs)
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
export const CMS_131_TEMPLATE = path.join(HERE, 'cms-131', '131.template.sql')
export const CMS_131_FILE = path.join(MIG, '131_cms_program_revision.sql')
export const CMS_131_ROLLBACK_FILE = path.join(MIG, 'rollback', '131_cms_program_revision_rollback.sql')

/** Hàm 131 tạo mới: chữ ký + quyền EXECUTE ngoài owner (null = chỉ owner). */
export const CMS_131_NEW = Object.freeze([
  { name: 'cms__revision_guard', sig: 'cms__revision_guard()', grant: null },
  { name: 'cms__revision_results_guard', sig: 'cms__revision_results_guard()', grant: null },
  { name: 'cms__revision_policy_guard', sig: 'cms__revision_policy_guard()', grant: null },
  { name: 'cms__revision_tiers', sig: 'cms__revision_tiers(uuid)', grant: null },
  { name: 'cms__revision_config', sig: 'cms__revision_config(uuid)', grant: null },
  { name: 'cms__revision_blocker', sig: 'cms__revision_blocker(uuid)', grant: null },
  { name: 'cms__revision_norm', sig: 'cms__revision_norm(jsonb,jsonb)', grant: null },
  { name: 'cms__revision_diff', sig: 'cms__revision_diff(uuid,jsonb)', grant: null },
  { name: 'rpc_cms_program_revision_preview', sig: 'rpc_cms_program_revision_preview(jsonb)', grant: 'authenticated:EXECUTE' },
  { name: 'rpc_cms_program_revision_commit', sig: 'rpc_cms_program_revision_commit(uuid,integer,text,uuid,text,jsonb)', grant: 'authenticated:EXECUTE' },
  { name: 'rpc_cms_program_revision_state', sig: 'rpc_cms_program_revision_state(uuid)', grant: 'authenticated:EXECUTE' },
  { name: 'rpc_cms_program_revisions', sig: 'rpc_cms_program_revisions(uuid)', grant: 'authenticated:EXECUTE' },
  { name: 'rpc_cms_program_revision', sig: 'rpc_cms_program_revision(uuid)', grant: 'authenticated:EXECUTE' },
  { name: 'rpc_cms_program_revision_archive', sig: 'rpc_cms_program_revision_archive(uuid,integer,integer)', grant: 'authenticated:EXECUTE' },
  { name: 'rpc_cms_revision_capabilities', sig: 'rpc_cms_revision_capabilities()', grant: 'service_role:EXECUTE' },
])
/** Hàm thay (OR REPLACE) — nguồn bản gốc cho rollback + md5 nền (preflight 131 ghim cùng giá trị). Đều chỉ owner. */
export const CMS_131_REPLACED = Object.freeze([
  { name: 'cms__sales_snapshot', sig: 'cms__sales_snapshot(uuid)', from: '130_cms_calculation_modes_returns.sql', base: 'b8fc8150ff3d733f4a73b8a19dc22daa' },
  { name: 'cms__conflicts', sig: 'cms__conflicts(uuid,boolean,date,date,text[])', from: '121_cms_import_activation.sql', base: '216655ef1643470997c122c8b07452b6' },
  { name: 'cms__program_scope_hash', sig: 'cms__program_scope_hash(uuid)', from: '124_cms_source_attestation.sql', base: '8a4abd995e0a14fb55cb827a5c668a5e' },
  { name: 'cms__result_run', sig: 'cms__result_run(uuid,uuid)', from: '122_cms_results.sql', base: '25bb3fdec9ac322765beaa0abdcd9686' },
])
export const CMS_131_ALL = Object.freeze([...CMS_131_NEW.map((x) => ({ ...x })), ...CMS_131_REPLACED.map((x) => ({ ...x, grant: null }))])
export const CMS_131_TABLES = Object.freeze(['cms_program_revisions', 'cms_program_revision_results'])
/** Số hàm CMS (cms_% / rpc_cms_%) sau 130 — 131 thêm đúng CMS_131_NEW.length. */
export const CMS_131_FN_BEFORE = 103

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

/** Thân (prosrc) mọi hàm trong một đoạn SQL: { name → { body, replace } } (lấy định nghĩa CUỐI cùng tên). */
export function cmsFunctionBodies(sql) {
  const out = new Map()
  const re = /CREATE (OR REPLACE )?FUNCTION public\.([a-z_0-9]+)\(([^)]*)\)[\s\S]*?\bAS (\$[a-z]*\$)/g
  let m
  while ((m = re.exec(sql)) !== null) {
    const tag = m[4], start = m.index + m[0].length
    const end = sql.indexOf(tag, start)
    if (end < 0) throw new Error(`thiếu thẻ đóng ${tag} của ${m[2]}`)
    out.set(m[2], { body: sql.slice(start, end), replace: !!m[1], block: sql.slice(m.index, end + tag.length) + ';' })
    re.lastIndex = end + tag.length
  }
  return out
}

/** Thay đúng MỘT lần (split/join). */
function once(s, needle, value) {
  const parts = s.split(needle)
  if (parts.length !== 2) throw new Error(`placeholder ${needle} xuất hiện ${parts.length - 1} lần (cần 1)`)
  return parts.join(value)
}
function all(s, needle, value, n) {
  const parts = s.split(needle)
  if (parts.length - 1 !== n) throw new Error(`placeholder ${needle} xuất hiện ${parts.length - 1} lần (cần ${n})`)
  return parts.join(value)
}

const aclValues = () => CMS_131_ALL.map((x, i) => `('${x.sig}', ${x.grant ? `'${x.grant}'` : 'NULL'}${i === 0 ? '::text' : ''})`).join(', ')

export function buildCms131() {
  const tpl = fs.readFileSync(CMS_131_TEMPLATE, 'utf8')
  if (tpl.includes('\r')) throw new Error('template phải LF')
  const bodies = cmsFunctionBodies(tpl)
  const newNames = CMS_131_NEW.map((x) => x.name)
  for (const n of newNames) if (!bodies.get(n) || bodies.get(n).replace) throw new Error(`template thiếu CREATE FUNCTION ${n}`)
  for (const x of CMS_131_REPLACED) if (!bodies.get(x.name)?.replace) throw new Error(`template thiếu CREATE OR REPLACE ${x.name}`)
  if (bodies.size !== CMS_131_ALL.length) throw new Error(`template có ${bodies.size} hàm, cần ${CMS_131_ALL.length}`)
  const md5s = Object.fromEntries(CMS_131_ALL.map((x) => [x.name, md5(bodies.get(x.name).body)]))
  const post = ['DO $$', 'BEGIN', '  IF ' + CMS_131_ALL.map((x, i) =>
    `${i ? '     OR ' : ''}(SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.${x.sig}')) IS DISTINCT FROM '${md5s[x.name]}'`).join('\n') + ' THEN',
    `    RAISE EXCEPTION '131 hậu kiểm: thân ${CMS_131_NEW.length} hàm mới + ${CMS_131_REPLACED.length} hàm thay lệch bản sinh (md5)';`, '  END IF;', 'END $$;'].join('\n')
  let mig = tpl
  mig = once(mig, '@@NEW_NAMES@@', newNames.map((n) => `'${n}'`).join(', '))
  mig = all(mig, '@@ACL_VALUES@@', aclValues(), 2)
  mig = once(mig, '@@POSTCHECK_MD5@@', post)
  mig = once(mig, '@@N_NEW@@', String(CMS_131_NEW.length))
  mig = all(mig, '@@N_ALL@@', String(CMS_131_ALL.length), 3)
  mig = once(mig, '@@SIG_LIST@@', CMS_131_ALL.map((x) => `'${x.sig}'`).join(', '))
  if (/@@[A-Z_]+@@/.test(mig)) throw new Error('còn placeholder chưa điền')

  // Rollback: thân gốc 4 hàm thay lấy NGUYÊN VĂN từ migration đã chạy (md5 phải = nền ghim).
  const originals = CMS_131_REPLACED.map((x) => {
    const b = cmsFunctionBodies(fs.readFileSync(path.join(MIG, x.from), 'utf8')).get(x.name)
    if (!b) throw new Error(`không thấy ${x.name} trong ${x.from}`)
    if (md5(b.body.split('\r').join('')) !== x.base) throw new Error(`thân gốc ${x.name} (${x.from}) md5 ${md5(b.body)} ≠ nền ${x.base}`)
    return b.block.replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION')
  })
  const rb = [
    '-- ============================================================================',
    '-- rollback/131_cms_program_revision_rollback.sql  (CANDIDATE — sinh bằng webapp/scripts/gen-cms-131.mjs; KHÔNG sửa tay)',
    '-- Gỡ 131 về đúng nền 130. Thứ tự: tắt cờ CMS_PROGRAM_REVISION_ENABLED → app về bản không gọi RPC revision → file này. DỪNG (không xoá',
    '-- gì) nếu đã có revision COMMITTED / lưu trữ số trước sửa / SP retire: dữ liệu đó là lịch sử tài chính — sửa sai bằng revision bù, không',
    '-- gỡ. Preview chưa ghi (previewed) bị bỏ cùng bảng. Khôi phục NGUYÊN VĂN 4 hàm thay (121 / 122 / 124 / 130) + policy đọc SP nền 120.',
    "-- Gồm DELETE FROM app_migrations WHERE version = '131'. READ COMMITTED; đúng role owner; giữ LF.",
    '-- ============================================================================',
    '',
    'BEGIN;',
    "SET LOCAL lock_timeout = '5s';",
    'LOCK TABLE public.cms_programs, public.cms_program_products, public.cms_program_tiers, public.cms_sync_runs,',
    '           public.cms_program_revisions, public.cms_program_revision_results IN ACCESS EXCLUSIVE MODE;',
    '',
    'DO $$',
    'DECLARE',
    '  v_name text;',
    'BEGIN',
    "  IF current_setting('transaction_isolation') <> 'read committed' THEN",
    "    RAISE EXCEPTION 'rollback 131: cần READ COMMITTED';",
    '  END IF;',
    "  SELECT name INTO v_name FROM public.app_migrations WHERE version = '131';",
    "  IF v_name IS DISTINCT FROM 'cms_program_revision' THEN",
    "    RAISE EXCEPTION 'rollback 131: không có marker 131 cms_program_revision (name = %)', v_name;",
    '  END IF;',
    "  IF EXISTS (SELECT 1 FROM public.app_migrations WHERE (CASE WHEN version ~ '^[0-9]+$' THEN version::int END) > 131) THEN",
    "    RAISE EXCEPTION 'rollback 131: DB đã có migration số > 131 — gỡ bản sau trước';",
    '  END IF;',
    '  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r0 WHERE r0.rolname = current_user AND (r0.rolsuper OR r0.rolbypassrls)) THEN',
    "    RAISE EXCEPTION 'rollback 131: role chạy (%) không phải superuser / BYPASSRLS', current_user;",
    '  END IF;',
    "  IF EXISTS (SELECT 1 FROM public.cms_sync_runs WHERE status = 'running') THEN",
    "    RAISE EXCEPTION 'rollback 131: còn run đang chạy';",
    '  END IF;',
    "  IF EXISTS (SELECT 1 FROM public.cms_program_revisions WHERE status = 'committed')",
    '     OR EXISTS (SELECT 1 FROM public.cms_program_revision_results)',
    '     OR EXISTS (SELECT 1 FROM public.cms_program_products WHERE retired_at IS NOT NULL OR retired_revision_id IS NOT NULL) THEN',
    "    RAISE EXCEPTION 'rollback 131: đã có revision committed / lưu trữ / SP retire — DỪNG, xử lý tiến (revision bù), không gỡ';",
    '  END IF;',
    'END $$;',
    '',
    '-- Khôi phục NGUYÊN VĂN 4 hàm thay (thân gốc của migration đã chạy).',
    ...originals.flatMap((b) => [b, '']),
    'DROP TRIGGER cms_revision_policy_guard ON public.cms_programs;',
    'DROP FUNCTION public.cms__revision_policy_guard();',
    'DROP FUNCTION public.rpc_cms_revision_capabilities();',
    'DROP FUNCTION public.rpc_cms_program_revision_archive(uuid,integer,integer);',
    'DROP FUNCTION public.rpc_cms_program_revision(uuid);',
    'DROP FUNCTION public.rpc_cms_program_revisions(uuid);',
    'DROP FUNCTION public.rpc_cms_program_revision_state(uuid);',
    'DROP FUNCTION public.rpc_cms_program_revision_commit(uuid,integer,text,uuid,text,jsonb);',
    'DROP FUNCTION public.rpc_cms_program_revision_preview(jsonb);',
    'DROP FUNCTION public.cms__revision_diff(uuid,jsonb);',
    'DROP FUNCTION public.cms__revision_norm(jsonb,jsonb);',
    'DROP FUNCTION public.cms__revision_blocker(uuid);',
    'DROP FUNCTION public.cms__revision_config(uuid);',
    'DROP FUNCTION public.cms__revision_tiers(uuid);',
    'ALTER POLICY cms_program_products_select ON public.cms_program_products',
    '  USING (program_id = ANY ((SELECT public.cms_readable_program_ids())::uuid[]));',
    'ALTER TABLE public.cms_program_products DROP CONSTRAINT cms_program_products_retired;',
    'ALTER TABLE public.cms_program_products DROP COLUMN retired_revision_id, DROP COLUMN retired_at;',
    'DROP TABLE public.cms_program_revision_results;',
    'DROP TABLE public.cms_program_revisions;',
    'DROP FUNCTION public.cms__revision_results_guard();',
    'DROP FUNCTION public.cms__revision_guard();',
    '-- ACL 4 hàm khôi phục: chỉ owner (OR REPLACE giữ ACL — thu hồi lại cho chắc).',
    'REVOKE ALL ON FUNCTION ' + CMS_131_REPLACED.map((x) => `public.${x.sig}`).join(', ') + ' FROM PUBLIC, anon, authenticated, service_role;',
    '',
    'DO $$',
    'BEGIN',
    '  IF ' + CMS_131_REPLACED.map((x, i) =>
      `${i ? '     OR ' : ''}(SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.${x.sig}')) IS DISTINCT FROM '${x.base}'`).join('\n') + ' THEN',
    "    RAISE EXCEPTION 'rollback 131 hậu kiểm: thân 4 hàm khôi phục khác nền 120–130 (md5)';",
    '  END IF;',
    "  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (" + CMS_131_NEW.map((x) => `'${x.name}'`).join(', ') + '))',
    "     OR to_regclass('public.cms_program_revisions') IS NOT NULL OR to_regclass('public.cms_program_revision_results') IS NOT NULL",
    "     OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = 'public.cms_program_products'::regclass",
    "                  AND attname IN ('retired_at', 'retired_revision_id') AND NOT attisdropped) THEN",
    "    RAISE EXCEPTION 'rollback 131 hậu kiểm: còn đối tượng 131';",
    '  END IF;',
    "  IF (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_catalog.pg_policy p WHERE p.polrelid = 'public.cms_program_products'::regclass",
    "        AND p.polname = 'cms_program_products_select')",
    "     IS DISTINCT FROM '(program_id = ANY (( SELECT cms_readable_program_ids() AS cms_readable_program_ids)::uuid[]))' THEN",
    "    RAISE EXCEPTION 'rollback 131 hậu kiểm: policy đọc SP khác nền 120';",
    '  END IF;',
    "  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a",
    '              WHERE p.oid IN (' + CMS_131_REPLACED.map((x) => `to_regprocedure('public.${x.sig}')`).join(', ') + ') AND a.grantee <> p.proowner) THEN',
    "    RAISE EXCEPTION 'rollback 131 hậu kiểm: 4 hàm khôi phục có grant ngoài owner';",
    '  END IF;',
    'END $$;',
    '',
    "DELETE FROM public.app_migrations WHERE version = '131';",
    '',
    'COMMIT;',
    '',
  ].join('\n')
  return { migration: mig, rollback: rb, md5s, sha: { migration: sha256(mig), rollback: sha256(rb) } }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const { migration, rollback, sha } = buildCms131()
  if (process.argv.includes('--check')) {
    const a = fs.existsSync(CMS_131_FILE) ? fs.readFileSync(CMS_131_FILE, 'utf8') : null
    const b = fs.existsSync(CMS_131_ROLLBACK_FILE) ? fs.readFileSync(CMS_131_ROLLBACK_FILE, 'utf8') : null
    const okA = a === migration, okB = b === rollback
    console.log(`131 ${okA ? 'KHỚP' : 'LỆCH'} · rollback ${okB ? 'KHỚP' : 'LỆCH'}`)
    process.exit(okA && okB ? 0 : 1)
  }
  fs.writeFileSync(CMS_131_FILE, migration)
  fs.writeFileSync(CMS_131_ROLLBACK_FILE, rollback)
  console.log(`ghi 131 sha256 ${sha.migration}\nghi rollback sha256 ${sha.rollback}`)
}
