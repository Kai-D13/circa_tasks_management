// CMS phase122 VERIFY — SINH vân tay kỳ vọng sau 122 từ file migration 120 → 121 → 122 THẬT trên PGlite sạch (không bao giờ
// từ DB cần kiểm — PM 03/11 §5 "không ghim lại fingerprint từ chính DB cần kiểm"). In md5 thân hàm (prosrc bỏ \r) của 23 hàm 122
// và md5 ràng buộc / index của 13 bảng cms_* — cùng công thức CMS_VERIFY_SQL.functions / tableShape. Kết quả chép vào
// e2e/cmsQaTooling.ts (CMS_FN_MATRIX phase '122', CMS_TABLE_SHAPE_122) và được kiểm lại độc lập trên PostgreSQL 15 thật
// (planning/research/dev-tools/cms/qatool-realpg-verify.mjs). Không chạm DB thật.
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/gen-cms-verify-fp-122.mjs
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
const fns = await ro(T.CMS_VERIFY_SQL.functions)
const shapes = await ro(T.CMS_VERIFY_SQL.tableShape)
const new122 = new Set(T.CMS_PHASE_FUNCTIONS['122'] ?? [])
console.log('// functions (phase 122):')
for (const f of fns) if (new122.size === 0 || new122.has(f.name)) console.log(`  ${f.name}: ${f.src_md5}  secdef=${f.secdef} acl=${f.acl_extra ?? '∅'} config=${f.n_config}`)
console.log('// table shapes (after 122):')
for (const s of shapes) console.log(`  ${s.t}: { con: '${s.con_md5}', idx: '${s.idx_md5}' },`)
console.log(`// tổng hàm cms: ${fns.length}`)
// r1.1 (db-reviewer P2-1): định nghĩa hàm ngoài thân + cột từng bảng — dán vào CMS_FN_DEF_122 / CMS_COL_122.
console.log('// CMS_FN_DEF_122:')
for (const d of await ro(T.CMS_VERIFY_SQL.fnDefs)) console.log(`  ${d.name}: '${d.def_md5}',`)
console.log('// CMS_COL_122:')
for (const c of await ro(T.CMS_VERIFY_SQL.columns)) console.log(`  ${c.t}: '${c.col_md5}',`)
