// CMS phase125 VERIFY — SINH vân tay kỳ vọng sau 125 từ file migration 120 → 121 → 122 → 123 → 124 → 125 THẬT trên PGlite sạch (không
// bao giờ từ DB cần kiểm). Cùng công thức CMS_VERIFY_SQL (functions / fnDefs / tableShape / columns / triggers) mà cms-verify gửi.
// In: hàm mới (cms__tiers_last_open_guard) + thân MỚI của 2 RPC 121 thay (rpc_cms_import_commit, rpc_cms_program_activate); md5
// định nghĩa hàm đổi / mới; hình dạng / cột bảng đổi (cms_program_tiers có thêm ràng buộc constraint trigger); danh sách trigger cms_*
// sau 125 (đối chiếu CMS_TRIGGERS_125). Kết quả chép vào e2e/cmsQaTooling.ts (CMS_FN_MATRIX phase '125', CMS_FN_SRC_125,
// CMS_FN_DEF_125, CMS_TABLE_SHAPE_125, CMS_COL_125) và kiểm lại độc lập trên PostgreSQL 15 thật (scripts/qa-cms-125.mjs --pg15).
// Không chạm DB thật.
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/gen-cms-verify-fp-125.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const sql = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const { PGlite } = await import('@electric-sql/pglite')
const jiti = createJiti(import.meta.url, { interopDefault: true })
const T = await jiti.import(path.join(HERE, '..', 'e2e', 'cmsQaTooling.ts'))
const lastRows = (results) => { for (let i = results.length - 1; i >= 0; i--) if (results[i].rows?.length) return results[i].rows; return [] }

const db = await L.freshDb(PGlite)
await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
for (const f of ['120_cms_foundation.sql', '121_cms_import_activation.sql', '122_cms_results.sql', '123_cms_payouts.sql', '124_cms_source_attestation.sql']) await db.exec(sql(f))
const ro = async (q) => lastRows(await db.exec(T.pgMetaReadOnly(q)))
const q = T.CMS_VERIFY_SQL
const snap = async () => ({
  fns: new Map((await ro(q.functions)).map((f) => [f.name, f])),
  defs: new Map((await ro(q.fnDefs)).map((d) => [d.name, d.def_md5])),
  shapes: new Map((await ro(q.tableShape)).map((s) => [s.t, s])),
  cols: new Map((await ro(q.columns)).map((c) => [c.t, c.col_md5])),
})
const before = await snap()
await db.exec(sql('125_cms_uncapped_last_tier.sql'))
const after = await snap()

const added = [...after.fns.keys()].filter((n) => !before.fns.has(n)).sort()
console.log(`// tổng hàm cms: trước 125 ${before.fns.size} · sau 125 ${after.fns.size} · mới ${added.length}`)
console.log('// CMS_FN_MATRIX phase 125 (src = md5 prosrc bỏ \\r):')
for (const n of added) {
  const f = after.fns.get(n)
  console.log(`  ${n}: src '${f.src_md5}'  secdef=${f.secdef} acl=${f.acl_extra ?? '∅'} n_config=${f.n_config} lock5s=${f.has_lock} lock3s=${f.has_lock3} lock2s=${f.has_lock2} nestloop=${f.has_nestloop}`)
}
console.log('// hàm có trước 125 mà thân / định nghĩa / config ĐỔI (CMS_FN_SRC_125 / CMS_FN_DEF_125 / cấu hình):')
for (const [n, f] of before.fns) {
  const g = after.fns.get(n)
  if (!g) { console.log(`  MẤT ${n}`); continue }
  if (g.src_md5 !== f.src_md5) console.log(`  ĐỔI thân ${n}: ${f.src_md5} → '${g.src_md5}'`)
  if (after.defs.get(n) !== before.defs.get(n)) console.log(`  ĐỔI định nghĩa ${n}: ${before.defs.get(n)} → '${after.defs.get(n)}'`)
  if (g.acl_extra !== f.acl_extra || g.secdef !== f.secdef) console.log(`  ĐỔI ACL / secdef ${n}: ${f.acl_extra} → ${g.acl_extra}`)
  if (g.n_config !== f.n_config || g.has_lock !== f.has_lock || g.has_lock3 !== f.has_lock3 || g.has_lock2 !== f.has_lock2) console.log(`  ĐỔI config ${n}: lock5s ${g.has_lock} lock3s ${g.has_lock3} lock2s ${g.has_lock2} n ${g.n_config}`)
}
console.log('// CMS_FN_DEF_125 (hàm mới):')
for (const n of added) console.log(`  ${n}: '${after.defs.get(n)}',`)
console.log('// CMS_TABLE_SHAPE_125 (bảng mới hoặc đổi so với trước 125):')
for (const [t, s] of after.shapes) {
  const b = before.shapes.get(t)
  if (!b || b.con_md5 !== s.con_md5 || b.idx_md5 !== s.idx_md5) console.log(`  ${t}: { con: '${s.con_md5}', idx: '${s.idx_md5}' },${b ? '  // ĐỔI' : ''}`)
}
console.log('// CMS_COL_125 (bảng mới hoặc đổi):')
for (const [t, c] of after.cols) if (before.cols.get(t) !== c) console.log(`  ${t}: '${c}',${before.cols.has(t) ? '  // ĐỔI' : ''}`)
const trg = (await ro(q.triggers)).map((t) => `${T.normalizeCmsQual(t.def)}|${t.enabled}`).sort()
console.log(`// tổng trigger cms_*: ${trg.length} (ALWAYS ${trg.filter((t) => t.endsWith('|A')).length})`)
if (Array.isArray(T.CMS_TRIGGERS_125)) {
  const want = [...T.CMS_TRIGGERS_125].sort()
  const same = JSON.stringify(want) === JSON.stringify(trg)
  console.log(`// CMS_TRIGGERS_125 trong cmsQaTooling.ts ${same ? 'KHỚP' : 'LỆCH'} danh sách sinh từ migration`)
  if (!same) {
    for (const t of want) if (!trg.includes(t)) console.log(`  chỉ trong hằng: ${t}`)
    for (const t of trg) if (!want.includes(t)) console.log(`  chỉ trong DB sạch: ${t}`)
  }
} else for (const t of trg.filter((x) => /cms_tiers_last_open/.test(x))) console.log(`  MỚI ${t}`)
await db.close()
