// CMS phase123 VERIFY — SINH vân tay kỳ vọng sau 123 từ file migration 120 → 121 → 122 → 123 THẬT trên PGlite sạch (không bao
// giờ từ DB cần kiểm — PM 03/11 §5). Cùng công thức CMS_VERIFY_SQL (functions / fnDefs / tableShape / columns / triggers) mà
// cms-verify gửi. In: md5 thân 18 hàm 123 (tập "hàm mới" = hiệu tập hàm cms trước / sau 123 trên CHÍNH DB sạch này) + thân mới của
// cms_readable_program_ids; md5 định nghĩa hàm; hình dạng / cột của bảng mới hoặc đổi; danh sách trigger cms_* sau 123 (để đối
// chiếu CMS_TRIGGERS_123). Hàm / bảng có trước 123 mà vân tay ĐỔI ⇒ in "ĐỔI" (đúng ra chỉ cms_readable_program_ids đổi thân).
// Kết quả chép vào e2e/cmsQaTooling.ts (CMS_FN_MATRIX phase '123', CMS_FN_SRC_123, CMS_FN_DEF_123, CMS_TABLE_SHAPE_123,
// CMS_COL_123) và được kiểm lại độc lập trên PostgreSQL 15 thật (planning/research/dev-tools/cms/qatool-realpg-verify-123.mjs).
// Không chạm DB thật.
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/gen-cms-verify-fp-123.mjs
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
for (const f of ['120_cms_foundation.sql', '121_cms_import_activation.sql', '122_cms_results.sql']) await db.exec(sql(f))
const ro = async (q) => lastRows(await db.exec(T.pgMetaReadOnly(q)))
const q = T.CMS_VERIFY_SQL
const snap = async () => ({
  fns: new Map((await ro(q.functions)).map((f) => [f.name, f])),
  defs: new Map((await ro(q.fnDefs)).map((d) => [d.name, d.def_md5])),
  shapes: new Map((await ro(q.tableShape)).map((s) => [s.t, s])),
  cols: new Map((await ro(q.columns)).map((c) => [c.t, c.col_md5])),
})
const before = await snap()
await db.exec(sql('123_cms_payouts.sql'))
const after = await snap()

const added = [...after.fns.keys()].filter((n) => !before.fns.has(n)).sort()
console.log(`// tổng hàm cms: trước 123 ${before.fns.size} · sau 123 ${after.fns.size} · mới ${added.length}`)
console.log('// CMS_FN_MATRIX phase 123 (src = md5 prosrc bỏ \\r):')
for (const n of added) {
  const f = after.fns.get(n)
  console.log(`  ${n}: src '${f.src_md5}'  secdef=${f.secdef} acl=${f.acl_extra ?? '∅'} n_config=${f.n_config} lock5s=${f.has_lock} lock3s=${f.has_lock3 ?? '?'} nestloop=${f.has_nestloop}`)
}
console.log('// hàm có trước 123 mà thân / định nghĩa ĐỔI:')
for (const [n, f] of before.fns) {
  const g = after.fns.get(n)
  if (!g) console.log(`  MẤT ${n}`)
  else if (g.src_md5 !== f.src_md5) console.log(`  ĐỔI thân ${n}: ${f.src_md5} → '${g.src_md5}'`)
  if (g && after.defs.get(n) !== before.defs.get(n)) console.log(`  ĐỔI định nghĩa ${n}: ${before.defs.get(n)} → ${after.defs.get(n)}`)
  if (g && (g.acl_extra !== f.acl_extra || g.secdef !== f.secdef)) console.log(`  ĐỔI ACL / secdef ${n}`)
}
console.log('// CMS_FN_DEF_123 (chỉ hàm mới):')
for (const n of added) console.log(`  ${n}: '${after.defs.get(n)}',`)
console.log('// CMS_TABLE_SHAPE_123 (bảng mới hoặc đổi so với trước 123):')
for (const [t, s] of after.shapes) {
  const b = before.shapes.get(t)
  if (!b || b.con_md5 !== s.con_md5 || b.idx_md5 !== s.idx_md5) console.log(`  ${t}: { con: '${s.con_md5}', idx: '${s.idx_md5}' },${b ? '  // ĐỔI' : ''}`)
}
console.log('// CMS_COL_123 (bảng mới hoặc đổi):')
for (const [t, c] of after.cols) if (before.cols.get(t) !== c) console.log(`  ${t}: '${c}',${before.cols.has(t) ? '  // ĐỔI' : ''}`)
console.log('// trigger cms_* sau 123 (đối chiếu CMS_TRIGGERS_123 — định nghĩa chuẩn hoá | tgenabled):')
const trg = (await ro(q.triggers)).map((t) => `${T.normalizeCmsQual(t.def)}|${t.enabled}`).sort()
for (const t of trg) console.log(`  ${t}`)
console.log(`// tổng trigger cms_*: ${trg.length} (ALWAYS ${trg.filter((t) => t.endsWith('|A')).length})`)
if (Array.isArray(T.CMS_TRIGGERS_123)) {
  const want = [...T.CMS_TRIGGERS_123].sort()
  const same = JSON.stringify(want) === JSON.stringify(trg)
  console.log(`// CMS_TRIGGERS_123 trong cmsQaTooling.ts ${same ? 'KHỚP' : 'LỆCH'} danh sách sinh từ migration`)
  if (!same) {
    for (const t of want) if (!trg.includes(t)) console.log(`  chỉ trong hằng: ${t}`)
    for (const t of trg) if (!want.includes(t)) console.log(`  chỉ trong DB sạch: ${t}`)
  }
}
await db.close()
