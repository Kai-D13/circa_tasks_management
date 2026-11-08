#!/usr/bin/env node
// CMS 127 (CMS đơn giản S0 — PM spec r1 2026-11-08 §3): SINH supabase/migrations/127_cms_t11_flat_amounts.sql + rollback từ
// scripts/cms-127/{fwd,rb}.sql + scripts/cms-127/pin.json (ghim chương trình T11 / 17 SP / 51 bậc cũ / 17 mức mới) + md5 thân 6 hàm
// guard lấy từ ĐỊNH NGHĨA CUỐI trong file migration 120–126 (không bao giờ từ DB cần kiểm). Chỗ vá khối dùng split/join đúng một
// lần (không String.replace để không ăn `$$`). KHÔNG sửa tay file sinh ra; sửa template / pin rồi sinh lại.
//   node scripts/gen-cms-127.mjs            # ghi 2 file, in sha256
//   node scripts/gen-cms-127.mjs --check    # chỉ so: file trên đĩa ≠ bản sinh ⇒ thoát 1
// Harness (scripts/qa-cms-127.mjs) gọi buildCms127(pin) với bản ghim dựng từ DB thử — cùng template, khác dữ liệu ghim.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const TPL = path.join(HERE, 'cms-127')
export const CMS_127_FILE = path.join(MIG, '127_cms_t11_flat_amounts.sql')
export const CMS_127_ROLLBACK_FILE = path.join(MIG, 'rollback', '127_cms_t11_flat_amounts_rollback.sql')
export const CMS_127_PIN_FILE = path.join(TPL, 'pin.json')

/** Chương trình thật T11 + 17 mức VND / hộp — PM spec r1 §1 (workbook CMS_T11.xlsx sha 4faf2c4c…, cột "CMS proposal"). */
export const CMS_127_T11_ID = '942194ce-893f-4f62-a88a-bd9efa464bae'
export const CMS_127_RATES = Object.freeze({
  2004764: 58455, 2005071: 24115, 2014494: 31410, 156227: 24525, 2004846: 16965, 156600: 24750, 2004759: 29700, 208259: 33255,
  15831: 42800, 77655: 39650, 15827: 25000, 2013846: 25000, 88808: 30000, 88974: 30600, 88807: 18000, 220789: 18000, 10953: 25000,
})
export const CMS_127_WORKBOOK_SHA = '4faf2c4ccd7071420293bff8a1520f5e25983482864d45c43c8573f27c62d263'
/** Hàm guard chạy trên câu ghi của 127 (trigger chương trình / SP / bậc) — preflight ghim thân. */
export const CMS_127_GUARDS = Object.freeze([
  'cms__programs_result_guard', 'cms__programs_guard', 'cms__config_auth_guard', 'cms__config_lock_guard',
  'cms__programs_lock_guard', 'cms__tiers_last_open_guard',
])
const OLD_SHAPE = JSON.stringify([[1, 1, 9, 15000], [2, 10, 19, 20000], [3, 20, null, 25000]])
/** 15 trigger không nội bộ trên 4 bảng cấu hình sau 120–126 (O = origin, A = ALWAYS) — đã đối chiếu prod chỉ đọc 08/11
 *  (C:/circa-gate-logs/cms-simple-s0-20261108/trigger-modes-authoring.json). Thứ tự byte (COLLATE "C") theo bảng rồi tên. */
export const CMS_127_TRIGGERS = Object.freeze([
  'cms_program_products.cms_config_auth_guard=A:cms__config_auth_guard', 'cms_program_products.cms_config_lock_guard=A:cms__config_lock_guard',
  'cms_program_products.cms_frozen_truncate=A:cms__frozen_truncate_guard', 'cms_program_stores.cms_config_auth_guard=A:cms__config_auth_guard',
  'cms_program_stores.cms_config_lock_guard=A:cms__config_lock_guard', 'cms_program_stores.cms_frozen_truncate=A:cms__frozen_truncate_guard',
  'cms_program_tiers.cms_config_auth_guard=A:cms__config_auth_guard', 'cms_program_tiers.cms_config_lock_guard=A:cms__config_lock_guard',
  'cms_program_tiers.cms_frozen_truncate=A:cms__frozen_truncate_guard', 'cms_program_tiers.cms_tiers_last_open=A:cms__tiers_last_open_guard',
  'cms_programs.cms_config_auth_guard=A:cms__config_auth_guard', 'cms_programs.cms_frozen_truncate=A:cms__frozen_truncate_guard',
  'cms_programs.cms_programs_guard=O:cms__programs_guard', 'cms_programs.cms_programs_lock_guard=A:cms__programs_lock_guard',
  'cms_programs.cms_programs_result_guard=O:cms__programs_result_guard',
])

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
/** prosrc = chuỗi giữa `AS $$` và `$$;` cuối, BỎ \r (cùng công thức VERIFY md5(replace(prosrc, E'\r', ''))). */
const prosrc = (t) => t.slice(t.indexOf('AS $$') + 5, t.lastIndexOf('$$;')).split('\r').join('')
/** Định nghĩa CUỐI CÙNG của public.<name>() trong chuỗi 120–126 (CREATE [OR REPLACE] FUNCTION) — thân hiện hành sau 126. */
function lastDefinition(name) {
  const files = fs.readdirSync(MIG).filter((f) => /^12[0-6]_.*\.sql$/.test(f)).sort()
  let found = null
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8')
    const re = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`, 'g')
    let m
    while ((m = re.exec(sql))) {
      const j = sql.indexOf('$$;', sql.indexOf('AS $$', m.index) + 5)
      found = { file: f, text: sql.slice(m.index, j + 3) }
    }
  }
  if (!found) throw new Error(`không thấy định nghĩa ${name} trong 120–126`)
  return found
}
function patch(text, from, to, label) {
  const n = text.split(from).length - 1
  if (n !== 1) throw new Error(`vá "${label}": khớp ${n} lần (cần đúng 1)`)
  return text.split(from).join(to)
}
const fill = (text, map) => Object.entries(map).reduce((t, [k, v]) => {
  if (!t.includes(k)) throw new Error(`template thiếu ${k}`)
  return t.split(k).join(String(v))
}, text)
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).split("'").join("''")}'`)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX32 = /^[0-9a-f]{32}$/
/** md5 "ProductID:mức" theo ProductID (thứ tự byte — SQL dùng COLLATE "C"). */
export const cmsRatesMd5 = (products) =>
  md5(products.map((p) => [p.product_id, p.new_amount]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id, a]) => `${id}:${a}`).join(','))

export function loadCms127Pin() { return JSON.parse(fs.readFileSync(CMS_127_PIN_FILE, 'utf8')) }

/** Kiểm dạng bản ghim (sai ⇒ throw — không sinh SQL từ dữ liệu hỏng). Bản ghim thật phải đúng 17 mức PM. */
export function validateCms127Pin(pin) {
  const g = pin.program
  if (!g || !UUID.test(g.id) || !/^\d{4}-\d{2}-\d{2}$/.test(g.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(g.end_date)) throw new Error('pin.program sai dạng')
  if (!Number.isInteger(g.config_version) || g.config_version < 1 || !Number.isInteger(g.stores_n) || !HEX32.test(g.stores_md5)) throw new Error('pin.program version / stores sai')
  if (!Array.isArray(pin.products) || pin.products.length !== 17) throw new Error('pin.products phải đúng 17')
  const ids = new Set(); const pids = new Set()
  for (const p of pin.products) {
    if (!UUID.test(p.id) || !/^[1-9][0-9]{0,18}$/.test(p.product_id) || ids.has(p.id) || pids.has(p.product_id)) throw new Error(`pin SP sai / trùng: ${p.product_id}`)
    ids.add(p.id); pids.add(p.product_id)
    if (p.gmv_basis !== 'none' || p.target_gmv !== null) throw new Error(`pin SP ${p.product_id} có target`)
    if (!(typeof p.unit_cms === 'string' && p.unit_cms.trim()) || !/^[0-9]+(\.[0-9]{1,9})?$/.test(p.base_quantity_cms)) throw new Error(`pin SP ${p.product_id} đơn vị / K sai`)
    if (![p.advice_md5, p.name_md5, p.image_md5].every((h) => HEX32.test(h))) throw new Error(`pin SP ${p.product_id} md5 sai`)
    if (p.import_run_id !== null && !UUID.test(p.import_run_id)) throw new Error(`pin SP ${p.product_id} import_run_id sai`)
    if (p.price_snapshot !== null && !/^[0-9]+(\.[0-9]{1,9})?$/.test(String(p.price_snapshot))) throw new Error(`pin SP ${p.product_id} price_snapshot sai`)
    if (typeof p.added_after_start !== 'boolean') throw new Error(`pin SP ${p.product_id} added_after_start phải boolean`)
    if (JSON.stringify(p.old_tiers) !== OLD_SHAPE) throw new Error(`pin SP ${p.product_id} bậc cũ không đúng 1–9 @15.000 · 10–19 @20.000 · từ 20 @25.000`)
    if (!Number.isSafeInteger(p.new_amount) || p.new_amount <= 0) throw new Error(`pin SP ${p.product_id} mức mới sai`)
  }
  if (g.id === CMS_127_T11_ID) {
    const want = Object.keys(CMS_127_RATES).sort().join(',')
    if ([...pids].sort().join(',') !== want) throw new Error('pin T11: tập 17 ProductID khác bảng PM')
    for (const p of pin.products) if (CMS_127_RATES[p.product_id] !== p.new_amount) throw new Error(`pin T11: mức ${p.product_id} ≠ bảng PM`)
  }
  return pin
}

export function buildCms127(pin = loadCms127Pin()) {
  validateCms127Pin(pin)
  const g = pin.program
  const products = [...pin.products].sort((a, b) => (a.product_id < b.product_id ? -1 : 1))
  const pinRows = products.map((p) => `  (${lit(p.id)}, ${lit(p.product_id)}, ${lit(p.unit_cms)}, ${p.base_quantity_cms}, ${lit(p.advice_md5)}, ${lit(p.name_md5)}, `
    + `${lit(p.image_md5)}, ${p.price_snapshot === null ? 'NULL' : p.price_snapshot}, ${p.import_run_id === null ? 'NULL' : lit(p.import_run_id)}, `
    + `${p.added_after_start}, ${p.new_amount})`).join(',\n')
  const oldRows = products.flatMap((p) => p.old_tiers.map(([o, f, t, a]) => `  (${lit(p.id)}, ${o}, ${f}, ${t === null ? 'NULL' : t}, ${a})`)).join(',\n')
  const guards = CMS_127_GUARDS.map((n) => { const d = lastDefinition(n); return { name: n, file: d.file, md5: md5(prosrc(d.text)) } })
  const md5Block = (who) => `DO $$
BEGIN
  IF current_setting('cms127.stage', true) IS DISTINCT FROM 'p1' THEN
    RAISE EXCEPTION '${who}: bước trước chưa đạt (giai đoạn %, cần p1)', current_setting('cms127.stage', true);
  END IF;
  IF ${guards.map((x) => `(SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.${x.name}()'::regprocedure) IS DISTINCT FROM '${x.md5}'`).join('\n     OR ')} THEN
    RAISE EXCEPTION '${who}: thân hàm guard (${CMS_127_GUARDS.length}) KHÁC bản đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
  PERFORM set_config('cms127.stage', 'p2', true);
END $$;`
  const ratesMd5 = cmsRatesMd5(products)
  const map = {
    '@@PID@@': g.id, '@@START@@': g.start_date, '@@END@@': g.end_date, '@@CV@@': g.config_version, '@@CV_AFTER@@': g.config_version + 1,
    '@@STORES_N@@': g.stores_n, '@@STORES_MD5@@': g.stores_md5, '@@RATES_MD5@@': ratesMd5, '@@WB_SHA@@': pin.source?.sha256 ?? CMS_127_WORKBOOK_SHA,
    '@@TRIGGERS@@': CMS_127_TRIGGERS.join(' | '),
  }
  const fillBoth = (t) => {
    let x = patch(t, '@@PIN_ROWS@@', pinRows, 'pin rows')
    x = patch(x, '@@OLD_TIER_ROWS@@', oldRows, 'old tier rows')
    return x
  }
  const fwdT = fs.readFileSync(path.join(TPL, 'fwd.sql'), 'utf8')
  const rbT = fs.readFileSync(path.join(TPL, 'rb.sql'), 'utf8')
  const migration = fill(patch(fillBoth(fwdT), '-- @@PREFLIGHT_MD5@@', md5Block('127 preflight'), 'preflight md5'),
    Object.fromEntries(Object.entries(map).filter(([k]) => fwdT.includes(k))))
  const rollback = fill(patch(fillBoth(rbT), '-- @@PREFLIGHT_MD5@@', md5Block('rollback 127 preflight'), 'rollback md5'),
    Object.fromEntries(Object.entries(map).filter(([k]) => rbT.includes(k))))
  if (/@@[A-Z_]+@@/.test(migration) || /@@[A-Z_]+@@/.test(rollback)) throw new Error('còn placeholder chưa điền')
  if (migration.includes('\r') || rollback.includes('\r')) throw new Error('file sinh có CR')
  return { migration, rollback, guards, ratesMd5, pin }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const { migration, rollback, guards, ratesMd5 } = buildCms127()
  if (process.argv.includes('--check')) {
    const same = (f, s) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === s
    const ok = same(CMS_127_FILE, migration) && same(CMS_127_ROLLBACK_FILE, rollback)
    console.log(ok ? 'gen-cms-127: file trên đĩa KHỚP bản sinh' : 'gen-cms-127: LỆCH bản sinh — chạy lại node scripts/gen-cms-127.mjs')
    process.exitCode = ok ? 0 : 1
  } else {
    fs.writeFileSync(CMS_127_FILE, migration)
    fs.writeFileSync(CMS_127_ROLLBACK_FILE, rollback)
    console.log(`127_cms_t11_flat_amounts.sql ${migration.split('\n').length - 1} dòng sha256 ${sha256(migration)}`)
    console.log(`rollback/127_cms_t11_flat_amounts_rollback.sql ${rollback.split('\n').length - 1} dòng sha256 ${sha256(rollback)}`)
    console.log(`rates md5 ${ratesMd5} · guards ${guards.map((x) => `${x.name}@${x.file.slice(0, 3)}=${x.md5.slice(0, 8)}`).join(' ')}`)
  }
}
