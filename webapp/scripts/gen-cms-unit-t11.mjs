#!/usr/bin/env node
// CMS-UNIT UNIT-4 (PM spec 09/11 §5) — SINH datafix T11 (đổi cơ sở pos_base → cms_unit, config_version + 1, pointer NULL) + rollback bù từ
// scripts/cms-unit-t11/{fwd,rb}.sql + pin.json + md5 thân hàm guard lấy từ ĐỊNH NGHĨA CUỐI trong file migration 120–128 (không bao giờ
// từ DB cần kiểm). Datafix CHƯA được cấp số: số migration là THAM SỐ (`--version`), PM ghim khi chốt release tổng — repo không giữ file
// mang số dự đoán. Vá khối bằng split/join đúng một lần (không String.replace để không ăn `$$`).
//   node scripts/gen-cms-unit-t11.mjs --version=<N> --out=<thư mục> [--after=<N-1>] [--pin=<pin.json>] [--rehearsal]
//     ⇒ <out>/<N>_cms_unit_t11_basis.sql + <out>/rollback/<N>_cms_unit_t11_basis_rollback.sql, in sha256 + md5 guard
//   · bản ghim chưa chụp tại cửa sổ (window_pinned false / thiếu config_fp) ⇒ CHỈ sinh được với --rehearsal (file ghi rõ "DIỄN TẬP"),
//     và bản diễn tập KHÔNG được ghi vào supabase/migrations.
// Harness (scripts/qa-cms-unit-t11.mjs) gọi buildCmsUnitT11({ pin, version, after, rehearsal }) với bản ghim dựng từ DB thử.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const TPL = path.join(HERE, 'cms-unit-t11')
export const CMS_UNIT_T11_PIN_FILE = path.join(TPL, 'pin.json')
export const CMS_UNIT_T11_ID = '942194ce-893f-4f62-a88a-bd9efa464bae'
export const CMS_UNIT_T11_NAME = 'cms_unit_t11_basis'
/** md5 bảng 17 mức của T11 sau 127 ("ProductID:mức" theo ProductID, thứ tự byte) — CMS_127_PM_RATES_MD5. */
export const CMS_UNIT_T11_RATES_MD5 = '29a0464bd08e27fb95440415209c4b2a'
/** Hàm chạy trên câu ghi (trigger cms_programs) hoặc được preflight / hậu kiểm gọi — ghim thân (bản cuối 120–128). */
export const CMS_UNIT_T11_GUARDS = Object.freeze([
  'cms__programs_result_guard', 'cms__programs_guard', 'cms__config_auth_guard', 'cms__programs_lock_guard', 'cms__programs_basis_guard',
  'cms__config_fp', 'cms__unit_key', 'cms__calc_snapshot', 'cms__basis_policy',
])
const GUARD_SIG = { cms__config_fp: '(uuid)', cms__unit_key: '(text)', cms__calc_snapshot: '(uuid)', cms__basis_policy: '(text)' }
/** 16 trigger không nội bộ trên 4 bảng cấu hình sau 120–128 = 15 của 127 (đối chiếu prod chỉ đọc 08/11) + guard đổi cơ sở 128 (ALWAYS).
 *  Thứ tự byte (COLLATE "C") theo bảng rồi tên. Harness đối chiếu với DB 128 thật. HẰNG theo 128: migration 129…nền thêm / đổi trigger
 *  trên 4 bảng này ⇒ preflight dừng (0 delta) — phải sửa hằng + chạy lại harness trên đúng chuỗi candidate tổng trước khi sinh file. */
export const CMS_UNIT_T11_TRIGGERS = Object.freeze([
  'cms_program_products.cms_config_auth_guard=A:cms__config_auth_guard', 'cms_program_products.cms_config_lock_guard=A:cms__config_lock_guard',
  'cms_program_products.cms_frozen_truncate=A:cms__frozen_truncate_guard', 'cms_program_stores.cms_config_auth_guard=A:cms__config_auth_guard',
  'cms_program_stores.cms_config_lock_guard=A:cms__config_lock_guard', 'cms_program_stores.cms_frozen_truncate=A:cms__frozen_truncate_guard',
  'cms_program_tiers.cms_config_auth_guard=A:cms__config_auth_guard', 'cms_program_tiers.cms_config_lock_guard=A:cms__config_lock_guard',
  'cms_program_tiers.cms_frozen_truncate=A:cms__frozen_truncate_guard', 'cms_program_tiers.cms_tiers_last_open=A:cms__tiers_last_open_guard',
  'cms_programs.cms_config_auth_guard=A:cms__config_auth_guard', 'cms_programs.cms_frozen_truncate=A:cms__frozen_truncate_guard',
  'cms_programs.cms_programs_basis_guard=A:cms__programs_basis_guard', 'cms_programs.cms_programs_guard=O:cms__programs_guard',
  'cms_programs.cms_programs_lock_guard=A:cms__programs_lock_guard', 'cms_programs.cms_programs_result_guard=O:cms__programs_result_guard',
])

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const prosrc = (t) => t.slice(t.indexOf('AS $$') + 5, t.lastIndexOf('$$;')).split('\r').join('')
/** Định nghĩa CUỐI CÙNG của public.<name>(…) trong chuỗi 120 → nền `upTo` (CREATE [OR REPLACE] FUNCTION) — thân hiện hành ngay trước
 *  datafix. Quét theo nền thật (DB review P2-N1): migration 129…nền thay một hàm guard thì md5 ghim theo bản cuối, không theo 128. */
function lastDefinition(name, upTo) {
  const num = (f) => Number(f.slice(0, 3))
  const files = fs.readdirSync(MIG).filter((f) => /^\d{3}[a-z]?_.*\.sql$/.test(f) && num(f) >= 120 && num(f) <= upTo).sort()
  let found = null
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8')
    const re = new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`, 'gm')
    let m
    while ((m = re.exec(sql))) {
      const j = sql.indexOf('$$;', sql.indexOf('AS $$', m.index) + 5)
      found = { file: f, text: sql.slice(m.index, j + 3) }
    }
  }
  if (!found) throw new Error(`không thấy định nghĩa ${name} trong 120–${upTo}`)
  return found
}
function patch(text, from, to, label) {
  const n = text.split(from).length - 1
  if (n !== 1) throw new Error(`vá "${label}": khớp ${n} lần (cần đúng 1)`)
  return text.split(from).join(to)
}
const fill = (text, map) => Object.entries(map).reduce((t, [k, v]) => (t.includes(k) ? t.split(k).join(String(v)) : t), text)
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).split("'").join("''")}'`)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX32 = /^[0-9a-f]{32}$/
const DEC = /^[0-9]+(\.[0-9]{1,9})?$/
/** md5 "ProductID:mức" theo ProductID (thứ tự byte — SQL dùng COLLATE "C"). */
export const cmsUnitRatesMd5 = (products) =>
  md5(products.map((p) => [p.product_id, p.amount]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id, a]) => `${id}:${a}`).join(','))

export function loadCmsUnitT11Pin(file = CMS_UNIT_T11_PIN_FILE) { return JSON.parse(fs.readFileSync(file, 'utf8')) }

/** Kiểm dạng bản ghim (sai ⇒ throw — không sinh SQL từ dữ liệu hỏng). rehearsal = false ⇒ bắt buộc đã ghim tại cửa sổ (config_fp). */
export function validateCmsUnitT11Pin(pin, { rehearsal = false } = {}) {
  const g = pin?.program
  if (!g || !UUID.test(g.id) || !/^\d{4}-\d{2}-\d{2}$/.test(g.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(g.end_date)) throw new Error('pin.program sai dạng')
  if (g.status !== 'active' || g.is_test !== false || g.quantity_basis !== 'pos_base') throw new Error('pin.program phải là chương trình THẬT đang chạy, cơ sở pos_base')
  if (!['all', 'stores'].includes(g.scope) || !/^[a-z_]+$/.test(g.calc_mode ?? '') || !/^[a-z_]+$/.test(g.gate_scope ?? '')) throw new Error('pin.program scope / calc_mode / gate_scope sai')
  if (g.catalog_target_gmv !== null && !DEC.test(String(g.catalog_target_gmv))) throw new Error('pin.program catalog_target_gmv sai')
  if (!Number.isInteger(g.config_version) || g.config_version < 1 || !Number.isInteger(g.stores_n) || g.stores_n < 1 || !HEX32.test(g.stores_md5)) throw new Error('pin.program version / phạm vi sai')
  const pinned = pin.window_pinned === true && typeof g.config_fp === 'string' && HEX32.test(g.config_fp)
  if (!rehearsal && !pinned) throw new Error('bản ghim CHƯA chụp tại cửa sổ (window_pinned + config_fp) — chỉ sinh được bản diễn tập (--rehearsal)')
  if (g.config_fp !== null && g.config_fp !== undefined && !HEX32.test(g.config_fp)) throw new Error('pin.program.config_fp sai dạng')
  if (!Array.isArray(pin.products) || pin.products.length !== 17) throw new Error('pin.products phải đúng 17')
  const ids = new Set(); const pids = new Set()
  for (const p of pin.products) {
    if (!UUID.test(p.id) || !/^[1-9][0-9]{0,18}$/.test(p.product_id) || ids.has(p.id) || pids.has(p.product_id)) throw new Error(`pin SP sai / trùng: ${p.product_id}`)
    ids.add(p.id); pids.add(p.product_id)
    if (!['none', 'product', 'catalog'].includes(p.gmv_basis) || (p.target_gmv !== null && !DEC.test(String(p.target_gmv)))) throw new Error(`pin SP ${p.product_id} điều kiện sai`)
    if (!(typeof p.unit_cms === 'string' && p.unit_cms.trim()) || !DEC.test(p.base_quantity_cms)) throw new Error(`pin SP ${p.product_id} đơn vị / K sai`)
    if (![p.advice_md5, p.name_md5, p.image_md5].every((h) => HEX32.test(h))) throw new Error(`pin SP ${p.product_id} md5 sai`)
    if (p.import_run_id !== null && !UUID.test(p.import_run_id)) throw new Error(`pin SP ${p.product_id} import_run_id sai`)
    if (p.price_snapshot !== null && !DEC.test(String(p.price_snapshot))) throw new Error(`pin SP ${p.product_id} price_snapshot sai`)
    if (typeof p.added_after_start !== 'boolean') throw new Error(`pin SP ${p.product_id} added_after_start phải boolean`)
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) throw new Error(`pin SP ${p.product_id} mức sai`)
  }
  // T11 thật: đúng 17 mức PM của 127 (không đổi mức trong datafix đổi cơ sở).
  if (g.id === CMS_UNIT_T11_ID && cmsUnitRatesMd5(pin.products) !== CMS_UNIT_T11_RATES_MD5) throw new Error('pin T11: bảng 17 mức lệch md5 PM (127)')
  return { pin, pinned }
}

export function buildCmsUnitT11({ pin = loadCmsUnitT11Pin(), version, after, rehearsal = false } = {}) {
  const v = Number(version)
  if (!Number.isInteger(v) || v < 129 || v > 9999) throw new Error('--version phải là số nguyên ≥ 129 (PM ghim khi chốt release tổng)')
  const pred = after === undefined || after === null ? v - 1 : Number(after)
  if (!Number.isInteger(pred) || pred < 128 || pred >= v) throw new Error('--after phải là số nguyên trong [128, version)')
  const { pinned } = validateCmsUnitT11Pin(pin, { rehearsal })
  const g = pin.program
  const products = [...pin.products].sort((a, b) => (a.product_id < b.product_id ? -1 : 1))
  const pinRows = products.map((p) => `  (${lit(p.id)}, ${lit(p.product_id)}, ${lit(p.gmv_basis)}, ${p.target_gmv === null ? 'NULL' : p.target_gmv}, ${lit(p.unit_cms)}, `
    + `${p.base_quantity_cms}, ${lit(p.advice_md5)}, ${lit(p.name_md5)}, ${lit(p.image_md5)}, ${p.price_snapshot === null ? 'NULL' : p.price_snapshot}, `
    + `${p.import_run_id === null ? 'NULL' : lit(p.import_run_id)}, ${p.added_after_start}, ${p.amount})`).join(',\n')
  const guards = CMS_UNIT_T11_GUARDS.map((n) => { const d = lastDefinition(n, pred); return { name: n, sig: GUARD_SIG[n] ?? '()', file: d.file, md5: md5(prosrc(d.text)) } })
  const md5Block = (who) => `DO $$
BEGIN
  IF current_setting('cmsunit.stage', true) IS DISTINCT FROM 'p1' THEN
    RAISE EXCEPTION '${who}: bước trước chưa đạt (giai đoạn %, cần p1)', current_setting('cmsunit.stage', true);
  END IF;
  IF ${guards.map((x) => `(SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_catalog.pg_proc WHERE oid = 'public.${x.name}${x.sig}'::regprocedure) IS DISTINCT FROM '${x.md5}'`).join('\n     OR ')} THEN
    RAISE EXCEPTION '${who}: thân hàm guard / 128 (${guards.length}) KHÁC bản đã duyệt (md5) — dừng, đối chiếu tay';
  END IF;
  PERFORM set_config('cmsunit.stage', 'p2', true);
END $$;`
  const ratesMd5 = cmsUnitRatesMd5(products)
  // Phiên bản khoá đơn vị = giá trị cms__calc_snapshot của NỀN ghi vào snapshot run (r1: v2 — ký tự vô hình ⇒ không hợp lệ); không ghi cứng.
  const ukvAll = [...lastDefinition('cms__calc_snapshot', pred).text.matchAll(/'unit_key_version', '([a-z0-9-]+)'/g)].map((m) => m[1])
  if (ukvAll.length !== 1) throw new Error(`cms__calc_snapshot nền ${pred}: cần đúng 1 unit_key_version (có ${ukvAll.length})`)
  const note = pinned && !rehearsal ? '' : '\n-- *** BẢN DIỄN TẬP (rehearsal) — bản ghim chưa chụp tại cửa sổ; KHÔNG dùng cho prod. ***'
  const map = {
    '@@REHEARSAL_NOTE@@': note, '@@VERSION@@': v, '@@PRED@@': pred, '@@PID@@': g.id, '@@START@@': g.start_date, '@@END@@': g.end_date,
    '@@SCOPE@@': g.scope, '@@CALC_MODE@@': g.calc_mode, '@@GATE_SCOPE@@': g.gate_scope, '@@CATALOG@@': g.catalog_target_gmv === null ? 'NULL' : String(g.catalog_target_gmv),
    '@@CV@@': g.config_version, '@@CV_AFTER@@': g.config_version + 1, '@@CV_ROLLBACK@@': g.config_version + 2,
    '@@STORES_N@@': g.stores_n, '@@STORES_MD5@@': g.stores_md5, '@@RATES_MD5@@': ratesMd5, '@@CONFIG_FP@@': g.config_fp ?? '(chưa ghim)',
    '@@TRIGGERS@@': CMS_UNIT_T11_TRIGGERS.join(' | '), '@@UNIT_KEY_VERSION@@': ukvAll[0],
  }
  const build = (tplName, who) => {
    const t = fs.readFileSync(path.join(TPL, tplName), 'utf8')
    let x = patch(t, '@@PIN_ROWS@@', pinRows, `${tplName} pin rows`)
    x = patch(x, '-- @@PREFLIGHT_MD5@@', md5Block(who), `${tplName} preflight md5`)
    x = fill(x, map)
    if (/@@[A-Z_]+@@/.test(x)) throw new Error(`${tplName}: còn placeholder chưa điền`)
    if (x.includes('\r')) throw new Error(`${tplName}: file sinh có CR`)
    return x
  }
  const migration = build('fwd.sql', `${v} preflight`)
  const rollback = build('rb.sql', `rollback ${v} preflight`)
  return { migration, rollback, guards, ratesMd5, unitKeyVersion: ukvAll[0], pinned: pinned && !rehearsal, version: v, after: pred,
    fileName: `${v}_${CMS_UNIT_T11_NAME}.sql`, rollbackName: `${v}_${CMS_UNIT_T11_NAME}_rollback.sql` }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const arg = (k) => process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
  const rehearsal = process.argv.includes('--rehearsal')
  const out = arg('out')
  if (!arg('version') || !out) { console.error('dùng: --version=<N> --out=<thư mục> [--after=<N-1>] [--pin=<pin.json>] [--rehearsal]'); process.exit(2) }
  const r = buildCmsUnitT11({ pin: loadCmsUnitT11Pin(arg('pin') ? path.resolve(arg('pin')) : CMS_UNIT_T11_PIN_FILE), version: arg('version'), after: arg('after'), rehearsal })
  const outAbs = path.resolve(out)
  if (!r.pinned && path.relative(path.resolve(MIG), outAbs).split(path.sep)[0] !== '..') {
    console.error('từ chối: bản diễn tập / chưa ghim tại cửa sổ KHÔNG được ghi vào supabase/migrations'); process.exit(2)
  }
  fs.mkdirSync(path.join(outAbs, 'rollback'), { recursive: true })
  fs.writeFileSync(path.join(outAbs, r.fileName), r.migration)
  fs.writeFileSync(path.join(outAbs, 'rollback', r.rollbackName), r.rollback)
  console.log(`${r.fileName} ${r.migration.split('\n').length - 1} dòng sha256 ${sha256(r.migration)}${r.pinned ? '' : ' (DIỄN TẬP)'}`)
  console.log(`rollback/${r.rollbackName} ${r.rollback.split('\n').length - 1} dòng sha256 ${sha256(r.rollback)}`)
  console.log(`nền ${r.after} · rates md5 ${r.ratesMd5} · guards ${r.guards.map((x) => `${x.name}@${x.file.slice(0, 3)}=${x.md5.slice(0, 8)}`).join(' ')}`)
}
