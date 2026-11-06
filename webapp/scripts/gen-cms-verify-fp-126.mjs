// CMS phase126 VERIFY — SINH vân tay kỳ vọng sau 126 từ file migration 120 → 121 → 122 → 123 → 124 → 125 → 126 THẬT trên PGlite sạch
// (không bao giờ từ DB cần kiểm). Cùng công thức CMS_VERIFY_SQL (functions / fnDefs / tableShape / columns / triggers) mà cms-verify gửi.
// 126 (sales-only) chỉ CREATE OR REPLACE 2 hàm 122 (cms__results_release_open false → true; rpc_cms_sales_run_publish held
// RETURNS_NOT_SUPPORTED_THIS_PHASE + dấu results_basis) ⇒ in: hàm mới (kỳ vọng 0) + thân MỚI của hàm có trước bị thay (CMS_FN_SRC_126);
// md5 định nghĩa / ACL / config hàm đổi (kỳ vọng KHÔNG đổi); hình dạng / cột bảng / trigger cms_* (kỳ vọng KHÔNG đổi so với 125 —
// đối chiếu cả ảnh trước / sau lẫn hằng CMS_TABLE_SHAPE_125 / CMS_COL_125 / CMS_FN_DEF_125 / CMS_TRIGGERS_125); cổng + policy. Kết quả
// chép vào e2e/cmsQaTooling.ts (CMS_FN_SRC_126). Không chạm DB thật.
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/gen-cms-verify-fp-126.mjs
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
for (const f of ['120_cms_foundation.sql', '121_cms_import_activation.sql', '122_cms_results.sql', '123_cms_payouts.sql', '124_cms_source_attestation.sql',
  '125_cms_uncapped_last_tier.sql']) await db.exec(sql(f))
const ro = async (q) => lastRows(await db.exec(T.pgMetaReadOnly(q)))
const q = T.CMS_VERIFY_SQL
const snap = async () => ({
  fns: new Map((await ro(q.functions)).map((f) => [f.name, f])),
  defs: new Map((await ro(q.fnDefs)).map((d) => [d.name, d.def_md5])),
  shapes: new Map((await ro(q.tableShape)).map((s) => [s.t, s])),
  cols: new Map((await ro(q.columns)).map((c) => [c.t, c.col_md5])),
  trg: (await ro(q.triggers)).map((t) => `${T.normalizeCmsQual(t.def)}|${t.enabled}`).sort(),
  gate: (await ro(q.lockPolicy))[0],
})
const before = await snap()
await db.exec(sql('126_cms_sales_only_results_release.sql'))
const after = await snap()

const added = [...after.fns.keys()].filter((n) => !before.fns.has(n)).sort()
const removed = [...before.fns.keys()].filter((n) => !after.fns.has(n)).sort()
console.log(`// tổng hàm cms: trước 126 ${before.fns.size} · sau 126 ${after.fns.size} · mới ${added.length}${added.length ? ` (${added.join(', ')})` : ''} · mất ${removed.length}${removed.length ? ` (${removed.join(', ')})` : ''}`)
console.log('// hàm có trước 126 mà thân / định nghĩa / ACL / config ĐỔI (CMS_FN_SRC_126 = các dòng "ĐỔI thân"; src = md5 prosrc bỏ \\r):')
let nSrc = 0, nOther = 0
for (const [n, f] of before.fns) {
  const g = after.fns.get(n)
  if (!g) continue
  if (g.src_md5 !== f.src_md5) { nSrc++; console.log(`  ĐỔI thân ${n}: ${f.src_md5} → '${g.src_md5}'`) }
  if (after.defs.get(n) !== before.defs.get(n)) { nOther++; console.log(`  ĐỔI định nghĩa ${n}: ${before.defs.get(n)} → '${after.defs.get(n)}'`) }
  if (g.acl_extra !== f.acl_extra || g.secdef !== f.secdef || g.acl_default !== f.acl_default || g.sig !== f.sig) { nOther++; console.log(`  ĐỔI ACL / secdef / chữ ký ${n}: ${f.acl_extra} → ${g.acl_extra} · ${f.sig} → ${g.sig}`) }
  if (g.n_config !== f.n_config || g.has_path !== f.has_path || g.has_lock !== f.has_lock || g.has_lock3 !== f.has_lock3 || g.has_lock2 !== f.has_lock2 || g.has_nestloop !== f.has_nestloop) {
    nOther++; console.log(`  ĐỔI config ${n}: lock5s ${g.has_lock} lock3s ${g.has_lock3} lock2s ${g.has_lock2} nestloop ${g.has_nestloop} n ${g.n_config}`)
  }
}
console.log(`// → ${nSrc} hàm đổi thân · ${nOther} thay đổi định nghĩa / ACL / config (kỳ vọng 0)`)
for (const n of added) console.log(`  MỚI ${n}: src '${after.fns.get(n).src_md5}' def '${after.defs.get(n)}' acl ${after.fns.get(n).acl_extra ?? '∅'}`)

const diffMap = (label, a, b, fmt = (x) => JSON.stringify(x)) => {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort()
  const d = keys.filter((k) => fmt(a.get(k)) !== fmt(b.get(k)))
  console.log(`// ${label}: ${d.length ? `ĐỔI ${d.join(', ')}` : 'KHÔNG đổi'} (${b.size} bảng)`)
  for (const k of d) console.log(`  ${k}: ${fmt(a.get(k))} → ${fmt(b.get(k))}`)
}
diffMap('hình dạng bảng (con / idx) trước → sau 126', before.shapes, after.shapes, (s) => (s ? `${s.con_md5}/${s.idx_md5}` : 'THIẾU'))
diffMap('cột bảng trước → sau 126', before.cols, after.cols, (c) => c ?? 'THIẾU')
const sameTrg = JSON.stringify(before.trg) === JSON.stringify(after.trg)
console.log(`// trigger cms_* trước → sau 126: ${sameTrg ? 'KHÔNG đổi' : 'ĐỔI'} (${after.trg.length}, ALWAYS ${after.trg.filter((t) => t.endsWith('|A')).length})`)
if (!sameTrg) {
  for (const t of before.trg) if (!after.trg.includes(t)) console.log(`  MẤT ${t}`)
  for (const t of after.trg) if (!before.trg.includes(t)) console.log(`  MỚI ${t}`)
}

// Đối chiếu trạng thái SAU 126 với hằng 125 trong cmsQaTooling.ts (126 kế thừa): shape / cột / định nghĩa / trigger.
const cmpConst = (label, want, got) => {
  const keys = [...new Set([...Object.keys(want), ...got.keys()])].sort()
  const d = keys.filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got.get(k)))
  console.log(`// ${label} ${d.length ? `LỆCH: ${d.join(', ')}` : 'KHỚP'} trạng thái sau 126`)
}
cmpConst('CMS_TABLE_SHAPE_125', T.CMS_TABLE_SHAPE_125, new Map([...after.shapes].map(([t, s]) => [t, { con: s.con_md5, idx: s.idx_md5 }])))
cmpConst('CMS_COL_125', T.CMS_COL_125, after.cols)
cmpConst('CMS_FN_DEF_125', T.CMS_FN_DEF_125, after.defs)
const want125 = [...T.CMS_TRIGGERS_125].sort()
console.log(`// CMS_TRIGGERS_125 ${JSON.stringify(want125) === JSON.stringify(after.trg) ? 'KHỚP' : 'LỆCH'} danh sách trigger sau 126`)
if (T.CMS_FN_SRC_126 && typeof T.CMS_FN_SRC_126 === 'object') {
  const want = Object.entries(T.CMS_FN_SRC_126).sort()
  const got = [...before.fns].filter(([n, f]) => after.fns.get(n)?.src_md5 !== f.src_md5).map(([n]) => [n, after.fns.get(n).src_md5]).sort()
  console.log(`// CMS_FN_SRC_126 trong cmsQaTooling.ts ${JSON.stringify(want) === JSON.stringify(got) ? 'KHỚP' : 'LỆCH'} thân sinh từ migration`)
}
console.log(`// cổng / policy: trước 126 release_open ${before.gate.release_open} real.ready ${before.gate.real_ready} version ${before.gate.version}`
  + ` · sau 126 release_open ${after.gate.release_open} real.ready ${after.gate.real_ready} version ${after.gate.version}`)
const mk = (await db.query(`SELECT version, name FROM public.app_migrations WHERE version = '126'`)).rows[0]
console.log(`// marker: ${mk ? `${mk.version} ${mk.name}` : 'THIẾU'}`)
await db.close()
