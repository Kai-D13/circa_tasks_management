// CMS-UNIT — KIỂM ĐỘT BIẾN phía TS (PM spec 09/11 §7: test phải bắt công thức B / K cũ và metadata giả). Mỗi đột biến áp lên BẢN SAO
// webapp/lib/ trong thư mục tạm của hệ điều hành (KHÔNG sửa file thật — bài học đột biến trên file thật 09/10 / 18/10), nạp bằng jiti
// với alias '@' trỏ bản sao, rồi chạy cùng bộ kiểm với bản gốc:
//   C1 fuzz 300 kịch bản (e2e/cmsUnitScenario.ts — cùng corpus spec AC12) so ORACLE độc lập (e2e/cmsUnitOracle.ts): HOLD cùng lý do;
//      mỗi cặp Q / tiềm năng / tiền / gate / B / GMV; tổng
//   C2 trạng thái dòng: ADJUSTMENT ⇔ B < 0 ∨ GMV < 0 ∨ quantity_raw < 0 (luật viết lại độc lập) trên corpus + ca xác định của spec
//      (quantity_raw âm với B / GMV dương, mọi đơn vị)
//   C3 metadata (cùng ca spec "snapshot / metadata run / dấu writer"): dấu writer = cơ sở snapshot; snapshot chỉ đọc có cơ sở / chính
//      sách / phiên bản lạ hoặc cặp lệch ⇒ lỗi (không tự chọn pos_base); calc snapshot run_open lệch cơ sở / khoá đơn vị ⇒ lỗi
//   C4 (r1 PM 10/11) Q-225: ký tự vô hình ở khoá / marker nguồn (FEFF bị trim) / import ⇒ không hợp lệ (HOLD / loại nhóm), NBSP vẫn hợp lệ;
//      lượt ghi cms_unit khi capture lớp nguồn OFF ⇒ held UNIT_SOURCE_CAPTURE_REQUIRED trước khi stage
// Bản gốc phải ĐẠT mọi bộ; MỌI đột biến phải bị ít nhất một bộ GIẾT. Không chạm DB / mạng. Dọn thư mục tạm của chính lượt này.
//   node scripts/qa-cms-unit-mutation.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const orig = createJiti(import.meta.url, { interopDefault: true, alias: { '@': ROOT } })
const SC = await orig.import(path.join(ROOT, 'e2e', 'cmsUnitScenario.ts'))
const OR = await orig.import(path.join(ROOT, 'e2e', 'cmsUnitOracle.ts'))
const MAP = await orig.import(path.join(ROOT, 'lib', 'cms', 'mapping.ts'))
const CT = await orig.import(path.join(ROOT, 'lib', 'cms', 'source', 'contract.ts'))
const FX = await orig.import(path.join(ROOT, 'e2e', 'cmsFixtureRunner.ts'))
const SELLERS = MAP.buildSellerIndex(SC.USERS, SC.STORES)

const ENGINE = 'lib/cms/engine/compute.ts', UNITKEY = 'lib/cms/unitKey.ts', STAGE = 'lib/cms/resultStage.ts'
const CONTRACT = 'lib/cms/source/contract.ts', UNITCHECK = 'lib/cms/import/unitCheck.ts', SYNC = 'lib/cms/salesSync.ts'
/** Đột biến: tệp + đoạn GỐC (phải khớp ĐÚNG một lần) → đoạn thay. */
const MUTANTS = [
  { id: 'M1-bk-formula', why: 'chương trình cms_unit tính bằng công thức cũ Q = floor(ΣB / K)', edits: [[ENGINE,
    "const unitBasis = program.quantityBasis === 'cms_unit'", 'const unitBasis = false']] },
  { id: 'M2-other-unit-counts-bk', why: 'dòng khác ĐV góp floor(B / K) vào C', edits: [[ENGINE,
    "const ci = u.kind === 'COUNTED' ? u.qty : ZERO", "const ci = u.kind === 'COUNTED' ? u.qty : cmsQuantityOf(line.baseQuantityUnits, product.perUnitUnits)"]] },
  { id: 'M3-other-unit-counts-raw', why: 'dòng khác ĐV góp quantity_raw (bỏ so ĐV)', edits: [[UNITKEY,
    "if (key !== unitKey) return { kind: 'OTHER_UNIT', negative }", "if (key !== unitKey && q.units % CMS_DEC_FACTOR !== BigInt(0)) return { kind: 'OTHER_UNIT', negative }"]] },
  { id: 'M4-no-clamp', why: 'Q nhóm không chặn dưới 0 (C âm)', edits: [[ENGINE,
    'const cmsQuantity = unitBasis ? (counted > ZERO ? counted : ZERO) :', 'const cmsQuantity = unitBasis ? counted :']] },
  { id: 'M5-adjust-ignores-raw', why: 'quantity_raw âm không vào cổng điều chỉnh', edits: [[ENGINE,
    ' || unit?.rawQuantityNegative === true', '']] },
  { id: 'M6-fraction-truncated', why: 'lượng lẻ đúng ĐV bị cắt thay vì HOLD (Q-223)', edits: [[UNITKEY,
    "if (q.units % CMS_DEC_FACTOR !== BigInt(0)) return { kind: 'INVALID', reason: 'QTY_FRACTION' }", '']] },
  { id: 'M7-no-nfc', why: 'khoá đơn vị bỏ chuẩn hoá NFC', edits: [[UNITKEY, "const cps = [...v.normalize('NFC')]", 'const cps = [...v]']] },
  { id: 'M8-gate-matched-only', why: 'GMV target chỉ từ dòng đúng ĐV (trái Q-224)', edits: [[ENGINE,
    'const t = trackGate(lines, product.targetVnd!)',
    "const t = trackGate(unitBasis ? lines.filter((l) => unitOf.get(l.orderLineId)?.kind === 'COUNTED') : lines, product.targetVnd!)"]] },
  { id: 'M9-hold-included-only', why: 'dòng hỏng chưa gán / ngoài phạm vi không HOLD', edits: [[ENGINE,
    "      if (u.kind === 'INVALID') {", "      if (u.kind === 'INVALID' && mapSeller(line.sellerEmail, input.sellers).ok) {"], [ENGINE,
    "      unitOf.set(line.orderLineId, u)", "      if (u.kind === 'INVALID') { exclude(line, 'UNASSIGNED', { unassignedReason: 'EMAIL_NOT_FOUND' }); totals.unassigned += 1; totals.unassignedGmvUnits += line.gmvUnits; totals.unassignedByReason.EMAIL_NOT_FOUND = (totals.unassignedByReason.EMAIL_NOT_FOUND ?? 0) + 1; continue }\n      unitOf.set(line.orderLineId, u)"]] },
  { id: 'M10-stamp-pos-base', why: 'writer luôn khai pos_base (metadata giả)', edits: [[STAGE,
    '        quantity_basis: snapshot.quantityBasis,\n', "        quantity_basis: 'pos_base',\n"]] },
  { id: 'M11-unknown-basis-legacy', why: 'cơ sở lạ ⇒ âm thầm pos_base', edits: [[STAGE,
    "  if (!isCmsQuantityBasis(b)) throw new CmsSnapshotError('quantity_basis')",
    "  if (!isCmsQuantityBasis(b)) return { basis: 'pos_base', policy: 'pos_base_legacy', legacy: true, unitKeyVersion: null }"]] },
  { id: 'M12-calc-unit-key-unchecked', why: 'khoá đơn vị calc snapshot (DB) không so với app', edits: [[STAGE,
    "    if (s.quantityBasis === 'cms_unit' && (uk === null || uk !== cmsUnitKey(p.unitCms))) {", '    if (false) {']] },
  { id: 'M13-policy-unchecked', why: 'chính sách không khớp cơ sở vẫn nhận', edits: [[STAGE,
    "  if (raw.calculation_policy_version !== CMS_BASIS_POLICY[b]) throw new CmsSnapshotError('calculation_policy_version')", '']] },
  // r1 (PM 10/11 §5): bỏ kiểm ký tự vô hình / kiểm SAU trim / marker nguồn chỉ điều khiển / import bỏ nhánh vô hình / bỏ capture bắt buộc.
  { id: 'M14-no-invisible-key', why: 'khoá đơn vị bỏ kiểm ký tự vô hình (U+200B ⇒ "khác ĐV" 0₫)', edits: [[UNITKEY,
    'if (CONTROL_RE.test(v) || INVISIBLE_RE.test(v)) return null', 'if (CONTROL_RE.test(v)) return null']] },
  { id: 'M15-invisible-after-trim', why: 'kiểm ký tự vô hình SAU trim (FEFF hai đầu lọt)', edits: [[UNITKEY,
    'if (CONTROL_RE.test(v) || INVISIBLE_RE.test(v)) return null', 'if (CONTROL_RE.test(v) || INVISIBLE_RE.test(v.trim())) return null']] },
  { id: 'M16-source-marker-control-only', why: 'marker thô nguồn chỉ ký tự điều khiển (FEFF bị adapter trim ⇒ dòng "Hộp" hợp lệ)', edits: [[CONTRACT,
    'return x.control || x.invisible }', 'return x.control }']] },
  { id: 'M17-import-invisible-ignored', why: 'import bỏ nhánh UNIT_CMS_INVISIBLE', edits: [[UNITCHECK, '} else if (invis) {', '} else if (false) {']] },
  { id: 'M18-capture-not-required', why: 'lượt ghi cms_unit chạy khi capture lớp nguồn OFF', edits: [[SYNC,
    "  if (snap.quantityBasis === 'cms_unit' && !opts.dryRun && !capture) return stop('held', CMS_UNIT_CODES.captureRequired)\n", '']] },
]

const lines = (rows) => rows.map((r) => { const x = CT.normalizeSalesRow(r); if (!x.ok) throw new Error('fixture lỗi'); return x.value })
const bigEq = (a, b) => a === b

/** Bộ kiểm trên một bản lib (gốc hoặc đột biến). Trả mỗi bộ: số ca lệch + ví dụ. */
async function checks(libRoot) {
  const j = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, fsCache: false, alias: { '@': libRoot } })
  const EN = await j.import(path.join(libRoot, 'lib', 'cms', 'engine', 'compute.ts'))
  const RS = await j.import(path.join(libRoot, 'lib', 'cms', 'resultStage.ts'))
  const out = { C1: { bad: 0, ex: [] }, C2: { bad: 0, ex: [] }, C3: { bad: 0, ex: [] }, C4: { bad: 0, ex: [] } }
  const miss = (k, s) => { out[k].bad++; if (out[k].ex.length < 3) out[k].ex.push(s) }
  let held = 0, compared = 0
  for (let seed = 1; seed <= 300; seed++) {
    const { rows, oprog, eprog } = SC.scenario(seed, seed % 5 === 0)
    const o = OR.cmsUnitOracle(oprog, rows, SC.O_SELLERS)
    let res = null, err = null
    try { res = EN.computeCmsProgram({ program: eprog, lines: lines(rows), sellers: SELLERS }) } catch (e) { err = e }
    if (o.hold) {
      held++
      if (err?.code !== 'UNIT_SOURCE_INVALID' || JSON.stringify(err.unitIssues) !== JSON.stringify(o.hold)) miss('C1', `seed ${seed}: oracle HOLD ${JSON.stringify(o.hold)} · engine ${err ? err.code ?? err.message : 'không HOLD'}`)
      continue
    }
    if (err) { miss('C1', `seed ${seed}: engine lỗi ${String(err.code ?? err.message).slice(0, 80)}`); continue }
    compared++
    const got = new Map(res.results.map((x) => [`${x.userId}|${x.productId}`, x]))
    if (got.size !== o.pairs.size) miss('C1', `seed ${seed}: số cặp ${got.size} ≠ ${o.pairs.size}`)
    for (const [k, v] of o.pairs) {
      const x = got.get(k)
      if (!x || !bigEq(x.cmsQuantity, v.q) || !bigEq(x.potentialAmountVnd, v.potential) || !bigEq(x.amountVnd, v.amount) || x.gate.met !== v.gateMet
        || !bigEq(x.baseQuantityUnits, v.b) || !bigEq(x.gmvUnits, v.gmv)) { miss('C1', `seed ${seed} ${k}: engine q ${x?.cmsQuantity} amt ${x?.amountVnd} · oracle q ${v.q} amt ${v.amount}`); break }
    }
    if (res.totals.amountVnd !== o.total) miss('C1', `seed ${seed}: tổng ${res.totals.amountVnd} ≠ ${o.total}`)
    const raw = new Map(rows.map((r) => [r.order_line_id, r]))
    for (const l of res.lines) {
      const r = raw.get(l.orderLineId)
      const q = OR.oracleDec9(typeof r.quantity_raw === 'string' ? r.quantity_raw.trim() : null)
      const want = l.baseQuantityUnits < 0n || l.gmvUnits < 0n || (q !== null && q < 0n)
      if ((l.status === 'ADJUSTMENT') !== want) { miss('C2', `seed ${seed} ${l.orderLineId}: ${l.status} (quantity_raw ${r.quantity_raw})`); break }
    }
  }
  if (held < 40 || compared < 200) miss('C1', `phủ: held ${held} · so ${compared}`)
  // C2 xác định (spec "điều chỉnh: quantity_raw âm (mọi đơn vị)"): lượng âm với B / GMV DƯƠNG, đúng và khác ĐV.
  {
    const rows = [SC.L({ quantity_raw: '3' }), SC.L({ uom_raw: 'viên', quantity_raw: '-2', base_quantity: '2', gmv_amount: '1000' }),
      SC.L({ quantity_raw: '-1', base_quantity: '5', gmv_amount: '1000' })]
    try {
      const r = EN.computeCmsProgram({ program: SC.prog([SC.P('900001')]), lines: lines(rows), sellers: SELLERS })
      const st = r.lines.map((l) => l.status).join()
      if (st !== 'RECORDED,ADJUSTMENT,ADJUSTMENT' || r.totals.adjustmentLines !== 2) miss('C2', `lượng âm B / GMV dương: ${st} · adjustment ${r.totals.adjustmentLines}`)
    } catch (e) { miss('C2', `ca xác định lỗi: ${e.message}`) }
  }
  // C3 metadata.
  const open = (s, c) => SC.openOf(s, c)
  try {
    const s = RS.parseCmsSalesSnapshot(open(SC.snap128()))
    const ei = RS.cmsSnapshotToEngineInput(s)
    const res = EN.computeCmsProgram({ program: ei.program, lines: [], sellers: ei.sellers })
    const pl = RS.buildCmsStagePayload(s, [], res, { rowsRead: 0, rowsRejected: 0, bytesProcessed: null })
    if (pl.expect.quantity_basis !== 'cms_unit' || pl.expect.calculation_policy_version !== 'cms_unit_v1') miss('C3', `dấu writer ${pl.expect.quantity_basis}/${pl.expect.calculation_policy_version}`)
    const sl = RS.parseCmsSalesSnapshot(open(SC.legacySnap(), null))
    const pll = RS.buildCmsStagePayload(sl, [], EN.computeCmsProgram({ program: RS.cmsSnapshotToEngineInput(sl).program, lines: [], sellers: ei.sellers }),
      { rowsRead: 0, rowsRejected: 0, bytesProcessed: null })
    if ('quantity_basis' in pll.expect || 'calculation_policy_version' in pll.expect) miss('C3', 'legacy mang dấu writer')
  } catch (e) { miss('C3', `snapshot hợp lệ bị từ chối: ${e.message}`) }
  const mustThrow = (label, raw) => { try { RS.parseCmsSalesSnapshot(raw); miss('C3', `${label} KHÔNG bị từ chối`) } catch { /* đúng */ } }
  // Snapshot CHỈ ĐỌC (không run_id, không calc) — lớp kiểm duy nhất là cơ sở / chính sách của chính snapshot.
  for (const [label, o] of [['cơ sở lạ', { quantity_basis: 'unit' }], ['cơ sở null', { quantity_basis: null }],
    ['chính sách lệch cơ sở', { calculation_policy_version: 'pos_base_v1' }], ['nhãn legacy của run', { quantity_basis: 'pos_base', calculation_policy_version: 'pos_base_legacy' }],
    ['phiên bản khoá đơn vị lạ', { unit_key_version: 'cms-unit-key-v1' }]]) mustThrow(`snapshot chỉ đọc: ${label}`, SC.snap128(o))
  const sx = SC.snap128({ quantity_basis: 'cms_unitX' })
  mustThrow('cơ sở lạ', open(sx, SC.calcOf(SC.snap128())))
  const sp = SC.snap128({ calculation_policy_version: 'pos_base_v1' })
  mustThrow('chính sách lệch cơ sở', open(sp, SC.calcOf(sp)))
  const s0 = SC.snap128()
  mustThrow('calc snapshot khoá đơn vị lệch app', open(s0, SC.calcOf(s0, {}, { unit_key: 'vỉ' })))
  // C4 (r1 — PM 10/11): Q-225 ký tự vô hình (khoá / marker nguồn / import) + lượt ghi cms_unit bắt buộc capture lớp nguồn.
  {
    const UKm = await j.import(path.join(libRoot, 'lib', 'cms', 'unitKey.ts'))
    const CTm = await j.import(path.join(libRoot, 'lib', 'cms', 'source', 'contract.ts'))
    const VA = await j.import(path.join(libRoot, 'lib', 'cms', 'import', 'validate.ts'))
    const UC = await j.import(path.join(libRoot, 'lib', 'cms', 'import', 'unitCheck.ts'))
    const SSm = await j.import(path.join(libRoot, 'lib', 'cms', 'salesSync.ts'))
    const ZW = '\u200b', BOM = '\ufeff', SHY = '\u00ad', NB = '\u00a0'
    for (const v of [`h${ZW}ộp`, `${BOM}hộp`, `hộp${BOM}`, `hộp${SHY}`, '\u2060', `${NB}hộp${BOM}`]) {
      if (UKm.cmsUnitKey(v) !== null) miss('C4', `cmsUnitKey(${JSON.stringify(v)}) = ${JSON.stringify(UKm.cmsUnitKey(v))} (cần null)`)
    }
    if (UKm.cmsUnitKey(`${NB}Hộp${NB}`) !== 'hộp') miss('C4', 'NBSP hai đầu không còn hợp lệ')
    // Nguồn: FEFF cuối bị adapter trim / U+200B giữa ⇒ marker thô ⇒ engine HOLD UNIT_INVALID (không thành dòng đúng ĐV / khác ĐV 0₫).
    for (const uom of [`Hộp${BOM}`, `H${ZW}ộp`, `${BOM}hộp`]) {
      const n = CTm.normalizeSalesRow(SC.L({ uom_raw: uom, quantity_raw: '2' }))
      let err = null
      try { if (n.ok) EN.computeCmsProgram({ program: SC.prog([SC.P('900001')]), lines: [n.value], sellers: SELLERS }) } catch (e) { err = e }
      if (!n.ok || err?.code !== 'UNIT_SOURCE_INVALID' || JSON.stringify(err.unitIssues) !== '{"UNIT_INVALID":1}') {
        miss('C4', `nguồn ${JSON.stringify(uom)}: engine ${err ? `${err.code} ${JSON.stringify(err.unitIssues)}` : 'KHÔNG HOLD'}`)
      }
    }
    {
      const n = CTm.normalizeSalesRow(SC.L({ quantity_raw: `${BOM}2` }))
      if (!n.ok || n.value.rawControl?.quantity !== true) miss('C4', 'lượng có FEFF đầu (bị trim) không gắn marker')
    }
    // Import: ô unit_CMS thô có ký tự vô hình (kể cả hai đầu bị trim) ⇒ loại nhóm UNIT_CMS_INVISIBLE.
    {
      const cell = (v) => (v === null ? { kind: 'empty' } : typeof v === 'number' ? { kind: 'number', value: v } : { kind: 'text', value: v })
      const irow = (excelRow, o = {}) => {
        const raw = { ProductID: '900001', KPI_Target_GMV_VND: null, Loai_CMS_GMV: null, Tu_SL_ban: 1, Den_SL_ban: null, CMS_VND_SP: 1000,
          Noi_dung_tu_van: 'Tư vấn giả', unit_CMS: 'hộp', base_quantity_CMS: 24, ...o }
        return { excelRow, cells: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, cell(v)])), raw }
      }
      const PMm = new Map(['900001', '900002', '900003'].map((id) => [id, { productName: `SP ${id}`, imageUrl: null, isActive: true, referencePrice: null }]))
      const vctx = { mode: 'replace', productMaster: PMm, existingProductIds: new Set(), conflictProductIds: new Set(), currentCatalogTarget: null }
      const rows = [irow(2, { unit_CMS: `${NB}hộp${NB}` }), irow(3, { ProductID: '900002', unit_CMS: `hộp${BOM}` }), irow(4, { ProductID: '900003', unit_CMS: `h${ZW}ộp` })]
      const x = UC.cmsApplyUnitBasisCheck(VA.validateCmsImport(rows, vctx), rows)
      const got = x.groupsRejected.map((g) => `${g.key}:${g.errors[0].code}`).join()
      if (got !== '900002:UNIT_CMS_INVISIBLE,900003:UNIT_CMS_INVISIBLE' || x.groupsOk.length !== 1) miss('C4', `import vô hình: ${got} · ok ${x.groupsOk.length}`)
    }
    // salesSync: cms_unit + cờ ON + capture OFF ⇒ held UNIT_SOURCE_CAPTURE_REQUIRED trước khi đọc nguồn / stage.
    {
      const calls = []
      const snap = SC.snap128()
      let t = 1_000_000
      const deps = {
        table: 'qa-project.dataset.cms_sales', runner: FX.createCmsFixtureRunner({ sales: [SC.L({ quantity_raw: '2' })] }),
        loadSnapshot: async () => { calls.push('loadSnapshot'); return snap },
        openRun: async () => { calls.push('openRun'); return SC.openOf(snap, SC.calcOf(snap)) },
        stage: async (_r, _p, _n, rows) => { calls.push('stage'); return rows.length },
        sealBegin: async () => { calls.push('sealBegin'); return { ok: true } },
        sealStep: async (_r, n) => { calls.push('sealStep'); return n === 10 ? { sealed: true } : { ok: true } },
        publish: async () => { calls.push('publish'); return { published: true } },
        finish: async () => { calls.push('finish') },
        cleanup: async () => ({ purged: 0, deleted: 0, more: false }),
        now: () => (t += 10),
      }
      let r = null
      try { r = await SSm.runCmsSalesSync(deps, SC.PROG, { dryRun: false, source: 'qa', unitBasisEnabled: true }) } catch (e) { r = { status: 'throw', code: String(e?.message ?? e).slice(0, 60) } }
      if (r.status !== 'held' || r.code !== 'UNIT_SOURCE_CAPTURE_REQUIRED' || calls.includes('stage') || calls.includes('publish')) {
        miss('C4', `capture OFF: ${r.status}/${r.code} · gọi ${calls.join(',')}`)
      }
    }
  }
  return { ...out, held, compared }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-unit-mut-'))
let rc = 0
try {
  const base = path.join(TMP, 'm0')
  fs.cpSync(path.join(ROOT, 'lib'), path.join(base, 'lib'), { recursive: true })
  const r0 = await checks(base)
  const pass0 = r0.C1.bad === 0 && r0.C2.bad === 0 && r0.C3.bad === 0 && r0.C4.bad === 0
  console.log(`${pass0 ? '✓' : '✗'} bản gốc (bản sao lib/): C1 ${r0.C1.bad} lệch (held ${r0.held} · so ${r0.compared}) · C2 ${r0.C2.bad} · C3 ${r0.C3.bad} · C4 ${r0.C4.bad}${pass0 ? '' : ` — ${[...r0.C1.ex, ...r0.C2.ex, ...r0.C3.ex, ...r0.C4.ex].join(' | ')}`}`)
  if (!pass0) rc = 1
  for (const m of MUTANTS) {
    const dir = path.join(TMP, m.id)
    fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true })
    for (const [rel, from, to] of m.edits) {
      const f = path.join(dir, rel)
      const s = fs.readFileSync(f, 'utf8')
      const n = s.split(from).length - 1
      if (n !== 1) throw new Error(`${m.id}: đoạn gốc khớp ${n} lần trong ${rel} — cập nhật đột biến theo mã hiện tại`)
      fs.writeFileSync(f, s.split(from).join(to))
    }
    let r
    try { r = await checks(dir) } catch (e) { r = { crash: String(e?.message ?? e).slice(0, 120) } }
    const killedBy = r.crash ? ['nạp lỗi'] : ['C1', 'C2', 'C3', 'C4'].filter((k) => r[k].bad > 0)
    const killed = killedBy.length > 0
    if (!killed) rc = 1
    console.log(`${killed ? '✓' : '✗'} ${m.id} (${m.why}) ⇒ ${killed ? `BỊ GIẾT bởi ${killedBy.join(' + ')}` : 'SỐNG SÓT'}${r.crash ? ` — ${r.crash}` : killed ? ` — ví dụ: ${(r[killedBy[0]].ex[0] ?? '').slice(0, 150)}` : ''}`)
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}
console.log(`\nĐột biến CMS-UNIT: ${rc === 0 ? `bản gốc đạt, ${MUTANTS.length}/${MUTANTS.length} đột biến bị giết` : 'CÓ LỖI (xem ✗)'}`)
process.exitCode = rc
