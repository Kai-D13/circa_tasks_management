import { test, expect } from '@playwright/test'
import {
  CMS_FX_CONTRACT_PROGRAMS, CMS_FX_PG_CONTRACT, CMS_FX_REPORT_ID, CMS_FX_REPORT_PROGRAM, cmsFxCloseReport, cmsFxCloseReports, cmsFxContract,
  cmsFxContractBasis, cmsFxContractLines, cmsFxContractResultsOf, cmsFxReturnConflicts, cmsFxRunIsContract,
} from '../lib/cms/fixturesContract'
import { CMS_FX_STORES, CMS_FX_USERS, cmsFxProgram } from '../lib/cms/fixtureScenario'
import { cmsFxLines, cmsFxStaffResults, cmsFxStoreResults, cmsFxAdminResults } from '../lib/cms/fixturesResults'
import { cmsFxStaffProducts } from '../lib/cms/fixturesStaff'
import { cmsNavHref, cmsFixtureNav } from '../lib/cms/fixtureNav'
import { CMS_SALES_ONLY_NOTE, cmsNetQtyText, cmsNetSummary, cmsResultScopeNote, type CmsResultsLoad } from '../lib/cms/resultUi'
import { CMS_LEGACY_RUN_CONTRACT, cmsResultState, type CmsResultRowDto } from '../lib/cms/resultView'
import { cmsRunBasisText } from '../lib/cms/resultUi'
import { CMS_QUANTITY_BASIS_LABEL } from '../lib/cms/calc/policy'
import { CMS_RETURN_STATUS_DICTIONARY_VERSION } from '../lib/cms/calc/returns'
import { CMS_UNIT_KEY_VERSION } from '../lib/cms/unitKey'
import { cmsQtyExplain } from '../lib/cms/productPresentation'
import { buildCmsCloseReportWorkbook } from '../lib/cms/exportCloseReport'
import { parseCmsDecimal } from '../lib/cms/decimal'

// CMS-CALC-RET-2 P5 (browser gate) — fixture run contract /ui-catalog/cms-v2 (lib/cms/fixturesContract): số do engine computeCmsNet tính
// trên dòng bán / phiếu trả giả, qua parser reader v2 thật. Spec khoá bất biến để ảnh / guide không trình bày số tự mâu thuẫn:
// Σ tiền sự kiện = tiền nhóm, Σ dòng bán + phiếu trả = số sự kiện, ví dụ Q-232, phạm vi người xem, báo cáo sau chốt khớp workbook.

const U = (v: string) => { const r = parseCmsDecimal(v, { allowNegative: true }); if (!r.ok) throw new Error(v); return r.units }
const loaded = (l: CmsResultsLoad | null) => {
  if (!l || l.kind !== 'loaded') throw new Error(`không phải loaded: ${l?.kind}`)
  return l
}
const PG13 = CMS_FX_PG_CONTRACT.PG13
const PG14 = CMS_FX_PG_CONTRACT.PG14
const PG15 = CMS_FX_PG_CONTRACT.PG15
const PG16 = CMS_FX_PG_CONTRACT.PG16
const vitamin = (programId: string) => cmsFxContract(programId)!.fx.products[0].id

test.describe('CMS-CALC-RET-2 P5 fixture run contract @desktop', () => {
  test('bốn chương trình dựng được; PG13 có NOT_COUNTED, RETURN_REDUCED, RETURN_NO_CHANGE; PG14 / PG16 không có RETURN', () => {
    expect(CMS_FX_CONTRACT_PROGRAMS).toHaveLength(4)
    // Loại run theo luật DB (130): PG13–15 contract (fx.out null), PG16 legacy (fx.out = engine legacy).
    expect([PG13, PG14, PG15, PG16].map((id) => cmsFxContract(id)!.runKind)).toEqual(['contract', 'contract', 'contract', 'legacy'])
    expect([PG13, PG14, PG15].every((id) => cmsFxContract(id)!.fx.out === null)).toBe(true)
    expect(cmsFxContract(PG16)!.fx.out).not.toBeNull()
    const st = (id: string) => new Set(cmsFxContract(id)!.out.history.map((h) => h.status))
    for (const s of ['NOT_COUNTED', 'RETURN_REDUCED', 'RETURN_NO_CHANGE', 'RECORDED']) expect(st(PG13).has(s as never), s).toBe(true)
    expect([...st(PG14)].some((s) => s.startsWith('RETURN'))).toBe(false)
    expect(st(PG14).has('NOT_COUNTED')).toBe(true)
    expect(st(PG15).has('NOT_COUNTED')).toBe(false)
    // PG16 (chương trình mới chọn "Tính lẻ", run LEGACY): đầu ra computeCmsNet chỉ để đối chứng — cộng dồn mọi dòng, không phiếu trả,
    // không dòng "Không tính lượng".
    expect([...st(PG16)].some((s) => s.startsWith('RETURN') || s === 'NOT_COUNTED')).toBe(false)
    expect(cmsFxContract(PG16)!.returns).toHaveLength(0)
    const classes = new Set(cmsFxContract(PG13)!.out.history.filter((h) => h.status === 'NOT_COUNTED').map((h) => h.quantityClass))
    expect([...classes].sort()).toEqual(['FRACTIONAL_QUANTITY', 'OTHER_UNIT'])
  })

  test('Q-232: vitamin K100 — bán 2 hộp + 5 viên + 1,5 hộp, trả 5 viên ⇒ B đủ 195, Q = 1, không tính lượng 155 viên', () => {
    const l = loaded(cmsFxStaffResults('running', PG13))
    const r = l.rows.results.find((x) => x.programProductId === vitamin(PG13))!
    expect(r.userId).toBe(CMS_FX_USERS.A)
    expect(r.eligibleBase).toBe('195')
    expect(r.cmsQuantity).toBe('1')
    expect(r.baseQuantity).toBe('350')
    expect(r.net?.returnBase).toBe('5')
    expect(r.net?.returnCount).toBe(1)
    const e = cmsQtyExplain([r])!
    expect(e).not.toBeNull()
    expect(e.notCountedBase).toBe(U('155'))
    expect(cmsNetQtyText(cmsNetSummary([r]), r.perUnit, 'hộp')).toContain('đã trả')
    // Cộng dồn (PG15) cùng dòng bán / phiếu trả: mọi dòng vào lượng ⇒ B đủ = B thật = 350 ⇒ 3 hộp.
    const p = loaded(cmsFxStaffResults('running', PG15)).rows.results.find((x) => x.programProductId === vitamin(PG15))!
    expect([p.eligibleBase, p.baseQuantity, p.cmsQuantity]).toEqual(['350', '350', '3'])
  })

  test('bất biến: Σ tiền sự kiện = tiền nhóm; Σ dòng bán + phiếu trả = số sự kiện; seq tăng', () => {
    for (const id of [PG13, PG14, PG15]) {
      const l = loaded(cmsFxAdminResults('running', 'super', id))
      expect(l.header.run?.contract.legacy).toBe(false)
      const lines = cmsFxLines(l.rows.results)
      expect(lines.length).toBe(l.rows.results.reduce((a, r) => a + r.lineCount + (r.net?.returnCount ?? 0), 0))
      for (const r of l.rows.results) {
        const mine = lines.filter((x) => x.userId === r.userId && x.programProductId === r.programProductId)
        expect(mine.reduce((a, x) => a + BigInt(x.amountVnd), BigInt(0)), `${id} ${r.userId} ${r.productId}`).toBe(BigInt(r.amountVnd))
        expect(mine.filter((x) => x.kind === 'RETURN').every((x) => x.posCode === null && x.quantityRaw === null && x.uomRaw === null)).toBe(true)
      }
      expect(lines.map((x) => x.seq)).toEqual([...lines.map((x) => x.seq)].sort((a, b) => a - b))
      expect(BigInt(l.header.run!.amountVnd!)).toBe(l.rows.results.reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0)))
    }
  })

  // PM audit RC r2 SALES-RC-02: chương trình MỚI chọn "Tính lẻ" (pos_base + sales_only) ⇒ DB vẫn tạo run LEGACY (cms__open v_ct, CHECK
  // contract_shape); cms_unit + sales_only ⇒ run contract policy sales-only (có cột ròng, chưa trừ trả). Tiền / Q của PG16 = engine legacy
  // (đường đang chạy T11) và phải TRÙNG computeCmsNet pos_base + sales_only trên cùng dữ liệu (không lệch số khi đổi đường).
  test('SALES-RC-02: pos_base + sales-only (admin chọn) ⇒ run legacy, không cột ròng; cms_unit + sales-only ⇒ contract sales-only; tiền / Q PG16 trùng engine mới', () => {
    expect(cmsFxRunIsContract('pos_base', 'sales_only_v1')).toBe(false)
    expect(cmsFxRunIsContract('cms_unit', 'sales_only_v1')).toBe(true)
    expect(cmsFxRunIsContract('pos_base', 'net_returns_v1')).toBe(true)
    // PG16: metadata chương trình = admin chọn pos_base; hợp đồng RUN = legacy (header + rows), không cột ròng, dòng = POS_BASE.
    expect(cmsFxContractBasis(PG16)).toEqual({ basis: 'pos_base', source: 'admin', returnsPolicy: 'sales_only_v1' })
    for (const v of ['super', 'sm'] as const) {
      const l = loaded(cmsFxAdminResults('running', v, PG16))
      expect(l.header.run!.contract, v).toEqual(CMS_LEGACY_RUN_CONTRACT)
      expect(l.rows.contract, v).toEqual(CMS_LEGACY_RUN_CONTRACT)
      expect(l.rows.results.length, v).toBeGreaterThan(0)
      expect(l.rows.results.every((r) => r.net === null && r.eligibleBase === r.baseQuantity), v).toBe(true)
      const lines = cmsFxLines(l.rows.results)
      expect(lines.length, v).toBe(l.rows.results.reduce((a, r) => a + r.lineCount, 0))
      expect(lines.every((x) => x.kind === 'SALE' && x.quantityClass === 'POS_BASE' && x.returnCode === null), v).toBe(true)
      for (const r of l.rows.results) {
        const mine = lines.filter((x) => x.userId === r.userId && x.programProductId === r.programProductId)
        expect(mine.reduce((a, x) => a + BigInt(x.amountVnd), BigInt(0)), `${v} ${r.userId} ${r.productId}`).toBe(BigInt(r.amountVnd))
      }
    }
    // Cờ mode bật (basisUi) ⇒ dòng "Cách tính" của run legacy = Tính lẻ — cộng dồn; tắt ⇒ không dòng.
    expect(cmsRunBasisText(CMS_LEGACY_RUN_CONTRACT, true)).toContain(CMS_QUANTITY_BASIS_LABEL.pos_base)
    expect(cmsRunBasisText(CMS_LEGACY_RUN_CONTRACT, false)).toBeNull()
    // Đối chứng số: engine legacy (DTO PG16) ≡ computeCmsNet pos_base + sales_only trên CÙNG dòng bán — từng dược sĩ × SP và tổng.
    const c16 = cmsFxContract(PG16)!
    const legacy = c16.fx.out!
    const key = (u: string, p: string) => `${u}|${p}`
    const net = new Map(c16.out.results.map((r) => [key(r.userId, r.productId), r]))
    expect(legacy.results.length).toBe(c16.out.results.length)
    for (const r of legacy.results) {
      const n = net.get(key(r.userId, r.productId))!
      expect(n, key(r.userId, r.productId)).toBeTruthy()
      expect([r.amountVnd, r.cmsQuantity, r.baseQuantityUnits, r.gmvUnits], key(r.userId, r.productId)).toEqual([n.amountVnd, n.cmsQuantity, n.netBaseUnits, n.netGmvUnits])
    }
    expect(legacy.totals.amountVnd).toBe(c16.out.totals.amountVnd)
    // PG14: hợp đồng run contract đúng hình dạng cms__run_contract (đủ 3 version, as_of null), cột ròng có nhưng 0 trả.
    const h14 = loaded(cmsFxAdminResults('running', 'super', PG14))
    expect(h14.header.run!.contract).toMatchObject({ legacy: false, quantityBasis: 'cms_unit', returnsPolicy: 'sales_only_v1', returnsAsOf: null,
      unitKeyVersion: CMS_UNIT_KEY_VERSION, statusDictionaryVersion: CMS_RETURN_STATUS_DICTIONARY_VERSION })
    expect(h14.rows.results.every((r) => r.net !== null && r.net.returnCount === 0 && r.net.returnBase === '0')).toBe(true)
    expect(cmsResultScopeNote(h14.header.run!.contract)).toBe(CMS_SALES_ONLY_NOTE)
    for (const id of [PG13, PG15]) {
      expect(loaded(cmsFxAdminResults('running', 'super', id)).header.run!.contract, id).toMatchObject({ unitKeyVersion: CMS_UNIT_KEY_VERSION, statusDictionaryVersion: CMS_RETURN_STATUS_DICTIONARY_VERSION })
    }
  })

  test('câu phạm vi theo run: net ⇒ "đã trừ phiếu trả hàng hoàn tất"; sales-only ⇒ nguyên văn T11', () => {
    const h13 = loaded(cmsFxStaffResults('running', PG13)).header
    const h14 = loaded(cmsFxStaffResults('running', PG14)).header
    expect(cmsResultScopeNote(h13.run!.contract)).toContain('đã trừ phiếu trả hàng hoàn tất')
    expect(cmsResultScopeNote(h14.run!.contract)).toBe(CMS_SALES_ONLY_NOTE)
    expect(h13.run!.contract.returnsAsOf).not.toBeNull()
    expect(h14.run!.contract.returnsAsOf).toBeNull()
  })

  test('phạm vi người xem: staff chỉ mình; QLCH nhà thuốc 01; super thấy tổng + sổ trả; vai khác không có tiền run', () => {
    const staff = loaded(cmsFxStaffResults('running', PG13))
    expect(new Set(staff.rows.results.map((r) => r.userId))).toEqual(new Set([CMS_FX_USERS.A]))
    expect(staff.header.run!.amountVnd).toBeNull()
    expect(staff.header.run!.ledger ?? null).toBeNull()
    const qlch = loaded(cmsFxStoreResults('running', PG13))
    expect(new Set(qlch.rows.results.map((r) => r.storeId))).toEqual(new Set([CMS_FX_STORES.S1]))
    const su = loaded(cmsFxAdminResults('running', 'super', PG13))
    expect(new Set(su.rows.results.map((r) => r.userId))).toEqual(new Set([CMS_FX_USERS.A, CMS_FX_USERS.B, CMS_FX_USERS.D]))
    expect(su.header.run!.ledger?.verdict).toBe('CLEAN')
    expect(su.header.run!.returnsRowsRead).toBe(3)
    // D1 / D3 dùng cùng danh mục của chương trình.
    expect(cmsFxStaffProducts(PG13).map((p) => p.productId)).toEqual(['900201', '900202', '900203'])
  })

  test('FINAL-QA7-01: fixture ledger đúng hình dạng DB 130 — super run contract sales-only CLEAN + eval_seq null; net có số; vai khác / legacy không có khối', () => {
    // PG14 = cms_unit + sales-only (run contract): super nhận ledger CLEAN, eval_seq null (không lần kiểm sổ), set_hash 64 hex.
    const su14 = loaded(cmsFxAdminResults('running', 'super', PG14))
    expect(su14.header.run!.contract).toMatchObject({ legacy: false, quantityBasis: 'cms_unit', returnsPolicy: 'sales_only_v1' })
    expect(su14.header.run!.ledger).toMatchObject({ verdict: 'CLEAN', evalSeq: null })
    expect(su14.header.run!.ledger!.setHash).toMatch(/^[0-9a-f]{64}$/)
    expect(su14.header.run!.returnsRowsRead).toBeNull()
    // Tiền super = Σ dòng kết quả cùng run (không đổi bởi khối ledger).
    expect(BigInt(su14.header.run!.amountVnd!)).toBe(su14.rows.results.reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0)))
    // Net (PG13 / PG15) giữ lần kiểm sổ có số.
    for (const id of [PG13, PG15]) expect(loaded(cmsFxAdminResults('running', 'super', id)).header.run!.ledger, id).toMatchObject({ verdict: 'CLEAN', evalSeq: 3 })
    // Vai không super: không có khối riêng của super ở mọi chương trình contract.
    for (const id of [PG13, PG14, PG15]) {
      expect(loaded(cmsFxAdminResults('running', 'sm', id)).header.run!.ledger ?? null, `sm ${id}`).toBeNull()
      expect(loaded(cmsFxStaffResults('running', id)).header.run!.ledger ?? null, `staff ${id}`).toBeNull()
      expect(loaded(cmsFxStoreResults('running', id)).header.run!.ledger ?? null, `qlch ${id}`).toBeNull()
    }
    // PG16 (pos_base + sales-only ⇒ run LEGACY): không khối ledger kể cả super.
    expect(loaded(cmsFxAdminResults('running', 'super', PG16)).header.run!.ledger ?? null).toBeNull()
    // held / config vẫn dựng được (parser thật) với ledger null tường minh.
    for (const s of ['held', 'config'] as const) expect(loaded(cmsFxContractResultsOf(PG14, s, { kind: 'super' })).header.run!.ledger?.evalSeq, s).toBeNull()
  })

  test('held: giữ số cũ (held_old) với mã sổ trả lệch ở chương trình net; none / reset / error như fixture legacy', () => {
    const h = loaded(cmsFxContractResultsOf(PG13, 'held', { kind: 'super' }))
    expect(cmsResultState(h.header)).toBe('held_old')
    expect(h.header.lastAttempt?.errorCode).toBe('CMS_RETURN_LEDGER_CONFLICT')
    expect(h.rows.results.length).toBeGreaterThan(0)
    expect(cmsResultState(loaded(cmsFxContractResultsOf(PG14, 'held', { kind: 'super' })).header)).toBe('held_old')
    expect(cmsResultState(loaded(cmsFxContractResultsOf(PG13, 'reset', { kind: 'super' })).header)).toBe('config_reset')
    expect(cmsResultState(loaded(cmsFxContractResultsOf(PG13, 'none', { kind: 'super' })).header)).toBe('none')
    expect(cmsFxContractResultsOf(PG13, 'error', { kind: 'super' })).toEqual({ kind: 'error' })
    expect(cmsFxContractResultsOf(cmsFxProgram(CMS_FX_REPORT_PROGRAM)!.row.id, 'running', { kind: 'super' })).toBeNull()
    expect(cmsFxContractLines([] as CmsResultRowDto[])).toBeNull()
  })

  test('sổ trả: proof khớp open_set_hash; conflict không proof; clean / restored không mở; chương trình sales-only ⇒ null', () => {
    const proof = cmsFxReturnConflicts(PG13, 'proof')!
    expect(proof.proof).toEqual({ evalSeq: 5, openSetHash: proof.openSetHash })
    expect(proof.open).toHaveLength(1)
    expect(proof.open[0].observations.map((o) => o.verdict)).toEqual(['MISSING', 'MATCH'])
    const conflict = cmsFxReturnConflicts(PG13, 'conflict')!
    expect(conflict.proof).toBeNull()
    expect(conflict.latestEval?.verdict).toBe('MISMATCH')
    expect(cmsFxReturnConflicts(PG13, 'clean')!.open).toHaveLength(0)
    expect(cmsFxReturnConflicts(PG13, 'restored')!.restorations).toHaveLength(1)
    expect(cmsFxReturnConflicts(PG14, 'proof')).toBeNull()
    expect(cmsFxReturnConflicts(PG13, 'error')).toBeNull()
  })

  test('báo cáo sau chốt (PG9): đã chốt = run đóng băng; Σ dòng = tổng; workbook nhận; 3 phiếu áp dụng; chênh lệch ≤ 0', () => {
    const pg9 = cmsFxProgram(CMS_FX_REPORT_PROGRAM)!
    const list = cmsFxCloseReports(CMS_FX_REPORT_PROGRAM)!
    expect(list).toHaveLength(1)
    const page = cmsFxCloseReport(CMS_FX_REPORT_PROGRAM, CMS_FX_REPORT_ID)!
    expect(BigInt(page.report.frozenAmount)).toBe(pg9.out!.totals.amountVnd)
    expect(page.report.returnEvents).toBe(3)
    expect(BigInt(page.report.deltaAmount)).toBe(BigInt(page.report.recomputedAmount) - BigInt(page.report.frozenAmount))
    expect(BigInt(page.report.deltaAmount) <= BigInt(0)).toBe(true)
    expect(page.lines.some((l) => BigInt(l.delta) < BigInt(0))).toBe(true)
    const wb = buildCmsCloseReportWorkbook({
      program: { id: pg9.row.id, name: pg9.row.name, startDate: pg9.row.startDate, endDate: pg9.row.endDate }, page,
      products: pg9.products.map((p) => ({ id: p.id, nameSnapshot: p.nameSnapshot, unitCms: p.unitCms })), exportedAt: new Date('2026-11-15T03:00:00Z'),
    })
    expect(wb.ok).toBe(true)
    expect(cmsFxCloseReports(PG13)).toBeNull()
    expect(cmsFxCloseReport(CMS_FX_REPORT_PROGRAM, PG13)).toBeNull()
  })

  test('điều hướng fixture: /returns và /returns/<id> ở lại catalog, giữ rs', () => {
    const nav = cmsFixtureNav({ rs: 'proof', p2: 'running' })
    expect(cmsNavHref(nav, `/targets/campaigns/cms/${PG13}/returns`)).toBe(`/ui-catalog/cms-v2/returns?program=${PG13}&p2=running&rs=proof`)
    expect(cmsNavHref(nav, `/targets/campaigns/cms/${PG13}/returns/${CMS_FX_REPORT_ID}`)).toBe(`/ui-catalog/cms-v2/returns?program=${PG13}&report=${CMS_FX_REPORT_ID}&p2=running&rs=proof`)
    expect(cmsNavHref({ mode: 'real' }, `/targets/campaigns/cms/${PG13}/returns`)).toBe(`/targets/campaigns/cms/${PG13}/returns`)
  })
})
