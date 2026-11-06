import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import * as XLSX from 'xlsx'
import { CMS_FX_PG, CMS_FX_PROGRAMS, CMS_FX_STORE_NAMES, CMS_FX_USERS, cmsFxDetailOf, cmsFxEligibleStaff, cmsFxLinesOf, cmsFxListItems, cmsFxProgram } from '../lib/cms/fixtureScenario'
import { CMS_FX_LIST, CMS_FX_PRODUCTS, cmsFxDetail } from '../lib/cms/fixtures'
import { CMS_FX_STAFF_ENDED, CMS_FX_STAFF_PROGRAMS, cmsFxStaffProducts } from '../lib/cms/fixturesStaff'
import { CMS_FX_RESULT_SCENARIOS, cmsFxAdminResults, cmsFxCorruptResults, cmsFxLines, cmsFxStaffResults, cmsFxStoreResults } from '../lib/cms/fixturesResults'
import { cmsFxLockPreview, cmsFxP3Program, cmsFxPayout } from '../lib/cms/fixturesPayout'
import { cmsA3ProductVM, cmsA3StaffRows, cmsProductDistribution, cmsQtyExplain, cmsQtyExplainRow, cmsQtyReasons, CMS_A3_STAFF_PREVIEW } from '../lib/cms/productPresentation'
import { cmsA1LoadOrder, cmsA1Results, cmsProductSalesStats, type CmsResultsLoad } from '../lib/cms/resultUi'
import { cmsProgressiveAmount } from '../lib/cms/engine/tiers'
import { parseCmsDecimal, CMS_DEC_FACTOR } from '../lib/cms/decimal'
import { cmsBuildListModel } from '../lib/cms/programList'
import { cmsDisplayStatus } from '../lib/cms/programStatus'
import { cmsFixtureNav, cmsNavHref, CMS_NAV_REAL } from '../lib/cms/fixtureNav'
import { cmsPrice } from '../lib/cms/display'
import { buildCmsResultWorkbook } from '../lib/cms/exportResults'
import type { CmsResultRowDto } from '../lib/cms/resultView'

// CMS-UI-1 (PM 04/11 §5 / §6 / §8 — phần đơn vị): fixture MỘT nguồn sinh bằng engine (nhất quán A1 / A3 / D1 / D2 / D3 / chốt), view-
// model giải thích lượng (đối soát BigInt, fail-closed), A1 đọc chương trình đã chốt trong ngân sách 30, điều hướng fixture giữ kịch
// bản. Không IO, không server.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const u = (v: string) => { const r = parseCmsDecimal(v, { allowNegative: true }); if (!r.ok) throw new Error(v); return r.units }
const loaded = (l: CmsResultsLoad) => { if (l.kind !== 'loaded') throw new Error(l.kind); return l }
const sum = (rows: readonly CmsResultRowDto[]) => rows.reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0))
const T = '2026-11-15'

test.describe('CMS-UI-1 — fixture một nguồn, sinh bằng engine @desktop', () => {
  test('số SP của chương trình = danh mục = ProductID khác nhau; A1 = A3 = D1 cùng chương trình; import khớp từng chương trình', () => {
    expect(CMS_FX_LIST).toEqual(cmsFxListItems())
    for (const p of CMS_FX_PROGRAMS) {
      const ids = p.products.map((x) => x.productId)
      expect(p.row.productCount, p.row.name).toBe(p.products.length)
      expect(new Set(ids).size, p.row.name).toBe(ids.length)
      expect(p.row.productIds).toEqual(ids)
      expect(p.products.every((x) => x.programId === p.row.id), p.row.name).toBe(true)
      const d = cmsFxDetailOf(p)
      expect(d.products).toBe(p.products)
      expect(d.program.configVersion).toBe(p.row.configVersion)
      expect(d.program.catalogTargetGmv).toBe(p.row.catalogTargetGmv)
      // Lần import: số SP hợp lệ của các lần ĐÃ GHI = số SP danh mục; mỗi dòng hợp lệ = một bậc (không gán 14 SP / 42 dòng cho mọi chương trình).
      const committed = p.runs.filter((r) => r.status === 'committed')
      expect(committed.reduce((a, r) => a + r.productsOk, 0), p.row.name).toBe(p.products.length)
      expect(committed.reduce((a, r) => a + r.rowsOk, 0), p.row.name).toBe(p.products.reduce((a, x) => a + x.tiers.length, 0))
      if (p.row.lastImport) expect(committed).toContainEqual(p.row.lastImport)
    }
    // D1 đọc CHÍNH danh mục của chương trình được chọn (không gán bộ SP của PG1 cho mọi program_id).
    for (const s of [...CMS_FX_STAFF_PROGRAMS, ...CMS_FX_STAFF_ENDED]) expect(cmsFxStaffProducts(s.id)).toBe(cmsFxProgram(s.id)!.products)
    expect(cmsFxDetail('running').products).toBe(CMS_FX_PRODUCTS)
    expect(cmsFxProgram(CMS_FX_PG.PG5)!.products.length).toBe(14)
    expect(cmsFxProgram(CMS_FX_PG.PG2)!.products.length).toBe(1)
    // Thống kê A1 đúng phạm vi: đang chạy loại QA, SP = hợp các danh mục đang chạy.
    const m = cmsBuildListModel(CMS_FX_LIST, { canManage: true, today: T, filter: 'all', q: '' })
    const running = CMS_FX_PROGRAMS.filter((p) => cmsDisplayStatus(p.row, T) === 'running' && !p.row.isTest)
    expect(m.stats).toEqual({ running: running.length, productsRunning: new Set(running.flatMap((p) => p.row.productIds)).size })
  })

  test('kết quả = engine: GMV nhóm danh mục = Σ GMV SP danh mục của CHÍNH người đó; gate / tiền khớp bậc; tổng SP = theo dược sĩ = XLSX cùng run', () => {
    for (const p of CMS_FX_PROGRAMS) {
      if (!p.run) continue
      const l = loaded(cmsFxAdminResults('running', 'super', p.row.id))
      const rows = l.rows.results
      const catalogPp = new Set(p.products.filter((x) => x.gmvBasis === 'catalog').map((x) => x.id))
      for (const c of l.rows.catalog) {
        const own = rows.filter((r) => r.userId === c.userId && catalogPp.has(r.programProductId)).reduce((a, r) => a + u(r.gmvAmount), BigInt(0))
        expect(u(c.catalogGmv), `${p.row.name} ${c.userId}`).toBe(own)
        expect(c.met, `${p.row.name} ${c.userId}`).toBe(u(c.catalogGmv) >= BigInt(c.targetGmv) * CMS_DEC_FACTOR)
      }
      for (const r of rows) {
        const pr = p.products.find((x) => x.id === r.programProductId)!
        const tiers = pr.tiers.map((t) => ({ from: BigInt(t.from), to: t.to === null ? null : BigInt(t.to), amountVnd: BigInt(t.amount) }))
        expect(BigInt(r.potentialAmount)).toBe(cmsProgressiveAmount(BigInt(r.cmsQuantity), tiers))
        expect(BigInt(r.amountVnd)).toBe(r.gateMet ? BigInt(r.potentialAmount) : BigInt(0))
        if (r.gmvBasis === 'product') expect(r.gateMet).toBe(u(r.gmvAmount) >= BigInt(r.targetGmv!) * CMS_DEC_FACTOR)
        if (r.gmvBasis === 'catalog') expect(r.gateMet).toBe(l.rows.catalog.find((c) => c.userId === r.userId)!.met)
        if (r.gmvBasis === 'none') expect(r.gateMet).toBe(true)
      }
      const total = sum(rows)
      const byProduct = [...cmsProductSalesStats(rows).values()].reduce((a, s) => a + s.amountVnd, BigInt(0))
      const byStaff = [...new Set(rows.map((r) => r.userId))].reduce((a, id) => a + sum(rows.filter((r) => r.userId === id)), BigInt(0))
      expect([byProduct, byStaff], p.row.name).toEqual([total, total])
      expect(total, p.row.name).toBe(p.out!.totals.amountVnd)
      // Dòng lịch sử của run: Σ tiền dòng = Σ tiền kết quả.
      expect(cmsFxLinesOf(p).reduce((a, x) => a + BigInt(x.amountVnd), BigInt(0)), p.row.name).toBe(total)
    }
    // XLSX của PG1 (cùng run): sheet Theo san pham cộng ra đúng tổng.
    const pg1 = cmsFxProgram(CMS_FX_PG.PG1)!
    const l = loaded(cmsFxAdminResults('running'))
    const b = buildCmsResultWorkbook({
      program: { id: pg1.row.id, name: pg1.row.name, startDate: pg1.row.startDate, endDate: pg1.row.endDate, configVersion: pg1.row.configVersion },
      header: l.header, rows: l.rows, lines: cmsFxLines(l.rows.results), excluded: [], products: pg1.products, storeNames: CMS_FX_STORE_NAMES,
      exportedAt: new Date('2026-11-15T03:00:00Z'), scope: 'super', returnsApproved: false,
    })
    if (!b.ok) throw new Error(b.error)
    const prod = XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.read(b.bytes, { type: 'array' }).Sheets['Theo san pham'])
    const cmsCol = Object.keys(prod[0]).find((k) => /^CMS/.test(k))!
    const lines = prod.filter((r) => r.ProductID !== 'Tổng')
    expect(lines.length).toBe(pg1.products.length)
    expect(lines.reduce((a, r) => a + BigInt(String(r[cmsCol])), BigInt(0))).toBe(sum(l.rows.results))
    expect(BigInt(String(prod.find((r) => r.ProductID === 'Tổng')![cmsCol]))).toBe(sum(l.rows.results))
  })

  test('mọi kịch bản / vai: phạm vi đúng (SM = nhà thuốc 01 + 02, QLCH = 01, staff = chính mình); kịch bản HỎNG có tên riêng', () => {
    const all = loaded(cmsFxAdminResults('running')).rows.results
    const sm = loaded(cmsFxAdminResults('running', 'sm')).rows
    expect(sm.results.length).toBeLessThan(all.length)
    expect(new Set(sm.users.map((x) => x.storeId))).toEqual(new Set(['00000000-0000-4000-8000-000000008001', '00000000-0000-4000-8000-000000008002']))
    expect(loaded(cmsFxStoreResults('running')).rows.users.every((x) => x.storeId === '00000000-0000-4000-8000-000000008001')).toBe(true)
    expect(loaded(cmsFxStaffResults('running')).rows.results.every((r) => r.userId === CMS_FX_USERS.A)).toBe(true)
    expect(loaded(cmsFxStaffResults('top')).rows.results.every((r) => r.userId === CMS_FX_USERS.B)).toBe(true)
    expect(loaded(cmsFxAdminResults('none')).header.run).toBeNull()
    expect(cmsFxAdminResults('error').kind).toBe('error')
    expect(CMS_FX_RESULT_SCENARIOS as string[]).not.toContain('corrupt')
    expect(cmsFxEligibleStaff('super', cmsFxProgram(CMS_FX_PG.PG7)!.storeIds).length).toBe(8) // phạm vi 2 nhà thuốc
    // Chốt kỳ / Số đã chốt đọc CHÍNH chương trình của kịch bản.
    expect(cmsFxLockPreview('ready')!.programId).toBe(CMS_FX_PG.PG8)
    expect(cmsFxLockPreview('pending')!.programId).toBe(CMS_FX_PG.PG4)
    expect(cmsFxPayout('locked')!.programId).toBe(cmsFxP3Program('locked'))
    expect(BigInt(cmsFxPayout('locked')!.scopeTotal)).toBe(sum(loaded(cmsFxAdminResults('running', 'super', CMS_FX_PG.PG9)).rows.results))
  })
})

const row = (o: Partial<CmsResultRowDto>): CmsResultRowDto => ({
  userId: '00000000-0000-4000-8000-000000000001', storeId: '00000000-0000-4000-8000-000000008001', programProductId: 'pp', productId: '900001', gmvBasis: 'none',
  baseQuantity: '0', perUnit: '1', cmsQuantity: '0', rewardedQuantity: '0', capQuantity: null, atCap: false, gmvAmount: '0', gateGmv: null, targetGmv: null,
  gateMet: true, gateMetAt: null, potentialAmount: '0', amountVnd: '0', lineCount: 1, ...o,
})

test.describe('CMS-UI-1 — giải thích SL bán / SL được CMS (PM §5) @desktop', () => {
  test('một dòng: chưa đạt gate · vượt trần · phần lẻ · quy cách lẻ 0,5 · Q0 với B > 0; dữ liệu âm / bất nhất ⇒ null', () => {
    expect(cmsQtyExplainRow(row({ baseQuantity: '16', perUnit: '1', cmsQuantity: '16', rewardedQuantity: '16', gateMet: false })))
      .toMatchObject({ rewarded: BigInt(0), unmetGate: BigInt(16), overCap: BigInt(0), fractionBase: BigInt(0), unmetStaff: 1 })
    expect(cmsQtyExplainRow(row({ baseQuantity: '605', perUnit: '10', cmsQuantity: '60', rewardedQuantity: '50', capQuantity: '50', atCap: true })))
      .toMatchObject({ rewarded: BigInt(50), overCap: BigInt(10), fractionBase: u('5'), overCapStaff: 1, fractionStaff: 1 })
    expect(cmsQtyExplainRow(row({ baseQuantity: '3.5', perUnit: '0.5', cmsQuantity: '7', rewardedQuantity: '7', gateMet: false }))).toMatchObject({ unmetGate: BigInt(7), fractionBase: BigInt(0) })
    expect(cmsQtyExplainRow(row({ baseQuantity: '15', perUnit: '30', cmsQuantity: '0', rewardedQuantity: '0' }))).toMatchObject({ rewarded: BigInt(0), fractionBase: u('15'), fractionStaff: 1 })
    expect(cmsQtyExplainRow(row({ baseQuantity: '-3', perUnit: '1', cmsQuantity: '0', rewardedQuantity: '0' }))).toBeNull() // Q-206 HOLD: không suy trả hàng
    expect(cmsQtyExplainRow(row({ baseQuantity: '30', perUnit: '1', cmsQuantity: '29', rewardedQuantity: '29' }))).toBeNull()  // Q ≠ floor(B/K)
    expect(cmsQtyExplainRow(row({ baseQuantity: '30', perUnit: '1', cmsQuantity: '30', rewardedQuantity: '30', capQuantity: '20' }))).toBeNull() // rewarded ≠ min(Q, trần)
    expect(cmsQtyExplainRow(row({ baseQuantity: 'x' }))).toBeNull()
  })

  test('cộng nhiều người cùng K: ΣB = (được + chưa đạt + vượt trần)×K + Σ phần lẻ (không floor sau cộng); K khác ⇒ null', () => {
    const a = row({ baseQuantity: '0.6', perUnit: '1', cmsQuantity: '0', rewardedQuantity: '0' })
    const b = row({ userId: 'b', baseQuantity: '0.6', perUnit: '1', cmsQuantity: '0', rewardedQuantity: '0' })
    const e = cmsQtyExplain([a, b])!
    expect([e.rewarded, e.fractionBase]).toEqual([BigInt(0), u('1.2')]) // 1,2 đơn vị lẻ KHÔNG thành 1 đơn vị được tính
    expect(cmsQtyReasons(e, 'hộp', 'none')).toEqual(['1,2 hộp phần lẻ chưa đủ 1 hộp (2 dược sĩ)'])
    expect(cmsQtyExplain([a, row({ perUnit: '2', baseQuantity: '0', cmsQuantity: '0', rewardedQuantity: '0' })])).toBeNull()
    // Fixture PG1 — mọi SP: bất biến giữ; ví dụ SP1 199,5 = 159 + 40 chưa đạt + 0,5 lẻ; SP3 130,5 = 130 + 0,5 lẻ (CMS-Q-220: không
    // còn "vượt trần" — 10 vỉ trên mốc 50 cũ nay được CMS).
    const l = loaded(cmsFxAdminResults('running'))
    for (const p of CMS_FX_PRODUCTS) {
      const rows = l.rows.results.filter((r) => r.programProductId === p.id)
      const x = cmsQtyExplain(rows)!
      expect(x.baseUnits).toBe((x.rewarded + x.unmetGate + x.overCap) * x.perUnit + x.fractionBase)
      expect([x.overCap, x.overCapStaff, x.cap]).toEqual([BigInt(0), 0, null])
      expect(rows.every((r) => r.capQuantity === null && r.atCap === false && r.rewardedQuantity === r.cmsQuantity)).toBe(true)
    }
    const s1 = cmsQtyExplain(l.rows.results.filter((r) => r.programProductId === CMS_FX_PRODUCTS[0].id))!
    expect([s1.rewarded, s1.unmetGate, s1.overCap, s1.fractionBase]).toEqual([BigInt(159), BigInt(40), BigInt(0), u('15')])
    const s3 = cmsQtyExplain(l.rows.results.filter((r) => r.programProductId === CMS_FX_PRODUCTS[2].id))!
    expect([s3.rewarded, s3.unmetGate, s3.overCap, s3.fractionBase, s3.cap]).toEqual([BigInt(130), BigInt(0), BigInt(0), u('5'), null])
    expect(cmsQtyReasons(s3, 'vỉ', 'none')).toEqual(['0,5 vỉ phần lẻ chưa đủ 1 vỉ (1 dược sĩ)'])
    // Run LỊCH SỬ đã đóng băng trước CMS-Q-220 (cấu hình cũ có trần): reader vẫn giải thích đúng snapshot, không tô lại luật mới.
    const legacy = cmsQtyExplain([row({ baseQuantity: '605', perUnit: '10', cmsQuantity: '60', rewardedQuantity: '50', capQuantity: '50', atCap: true }),
      row({ userId: 'b', baseQuantity: '700', perUnit: '10', cmsQuantity: '70', rewardedQuantity: '50', capQuantity: '50', atCap: true, gateMet: false })])!
    expect([legacy.rewarded, legacy.unmetGate, legacy.overCap, legacy.fractionBase, legacy.cap]).toEqual([BigInt(50), BigInt(70), BigInt(10), u('5'), BigInt(50)])
    expect(cmsQtyReasons(legacy, 'vỉ', 'none')).toEqual(['70 vỉ chưa đạt target (1 dược sĩ)', '10 vỉ vượt trần 50 vỉ/dược sĩ (1 dược sĩ)', '0,5 vỉ phần lẻ chưa đủ 1 vỉ (1 dược sĩ)'])
  })

  test('thanh phân bố: Σ đoạn bậc = Σ được CMS; Σ đoạn × mức = Σ tiền; mẫu số là lượng (không phải số người); ≥ 4 bậc đọc đủ; lệch tiền ⇒ null', () => {
    const l = loaded(cmsFxAdminResults('running'))
    const p = CMS_FX_PRODUCTS[0]
    const rows = l.rows.results.filter((r) => r.programProductId === p.id)
    const d = cmsProductDistribution(rows, p.tiers, p.unitCms)!
    expect(d.legend).toBe('B1 63 · B2 67 · B3 29 · không tính 40,5')
    expect(d.segments.map((s) => s.pct)).toEqual([31.57, 33.58, 14.53, 20.3]) // 63×30/5985 … (40,5×30)/5985
    expect(d.aria).toContain('không tính CMS 40,5 hộp')
    // Thang 4 bậc (PG5): mọi bậc có trong chữ, kể cả bậc trùng màu.
    const p5 = cmsFxProgram(CMS_FX_PG.PG5)!
    const l5 = loaded(cmsFxAdminResults('running', 'super', p5.row.id))
    const four = p5.products.find((x) => x.tiers.length === 4)!
    const d4 = cmsProductDistribution(l5.rows.results.filter((r) => r.programProductId === four.id), four.tiers, four.unitCms)!
    expect(d4.segments.filter((s) => s.kind === 'tier').map((s) => s.order)).toEqual([1, 2, 3, 4])
    expect(d4.legend).toMatch(/^B1 \d+ · B2 \d+ · B3 \d+ · B4 \d+ · không tính /)
    // Kịch bản HỎNG: tiền lệch bậc ⇒ không vẽ / không giải thích, tiền vẫn là số snapshot.
    const c = loaded(cmsFxCorruptResults())
    const bad = c.rows.results.filter((r) => r.programProductId === p.id)
    expect(cmsProductDistribution(bad, p.tiers, p.unitCms)).toBeNull()
    const vm = cmsA3ProductVM(p, { catalogTargetGmv: '1500000', priceText: cmsPrice, results: { rows: bad, catalog: c.rows.catalog, users: c.rows.users, storeNames: CMS_FX_STORE_NAMES } })
    expect(vm.results!.dist).toBeNull()
    expect(vm.results!.amountText).toBe('3.011.000₫') // = Σ snapshot (không sửa số)
  })

  test('view-model A3: tổng không đổi (Σ dược sĩ = Σ SP = snapshot), footer tính MỌI người (> 10 vẫn đủ), tiền lớn đọc đủ, SP chưa có dòng không dựng 0 giả cho giải thích', () => {
    const l = loaded(cmsFxAdminResults('running'))
    const p = CMS_FX_PRODUCTS[0]
    const rows = l.rows.results.filter((r) => r.programProductId === p.id)
    const vm = cmsA3ProductVM(p, { catalogTargetGmv: '1500000', priceText: cmsPrice, results: { rows, catalog: l.rows.catalog, users: l.rows.users, storeNames: CMS_FX_STORE_NAMES } })
    const r = vm.results!
    expect(r.staff.length).toBe(11)
    expect(r.staff.length).toBeGreaterThan(CMS_A3_STAFF_PREVIEW)
    expect(r.totals).toEqual({ count: 11, soldText: '199,5', gmvText: '35.910.000₫', amountText: '3.010.000₫' })
    expect(r.staff.reduce((a, s) => a + BigInt(s.amountText.replace(/\D/g, '')), BigInt(0))).toBe(sum(rows))
    expect(r.countedText).toBe('159 tính CMS')
    expect(r.reasons).toEqual(['40 hộp chưa đạt target (4 dược sĩ)', '0,5 hộp phần lẻ chưa đủ 1 hộp (1 dược sĩ)'])
    expect(r.staff[0].status).toEqual({ tone: 'success', label: 'Bậc 3 · 25.000₫/hộp' })
    const c = r.staff.find((s) => s.name.startsWith('Dược sĩ mẫu C'))!
    expect([c.qtyNote, c.status.label, c.gate?.shortText]).toEqual(['chưa tính', 'Chưa đạt target', 'thiếu 750.000₫'])
    // Gate danh mục: chữ ghi GMV NHÓM (khác GMV SP) — PM §4.3.
    const p2 = CMS_FX_PRODUCTS[1]
    const st2 = cmsA3StaffRows(l.rows.results.filter((x) => x.programProductId === p2.id), { tiers: p2.tiers, unit: p2.unitCms, catalog: l.rows.catalog, users: l.rows.users, storeNames: CMS_FX_STORE_NAMES })
    expect(st2.every((s) => s.gate?.basis === 'catalog' && s.gate.text.startsWith('Nhóm DM '))).toBe(true)
    // CMS-Q-220: bán 60 vỉ (trên mốc 50 cũ) ⇒ tính đủ 60, trạng thái bậc (không "Đã đạt trần"), không ghi chú "tính 50".
    const p3 = CMS_FX_PRODUCTS[2]
    expect(p3.tiers.at(-1)!.to).toBeNull()
    const st3 = cmsA3StaffRows(l.rows.results.filter((x) => x.programProductId === p3.id), { tiers: p3.tiers, unit: p3.unitCms, catalog: l.rows.catalog, users: l.rows.users, storeNames: CMS_FX_STORE_NAMES })
    expect(st3.find((s) => s.soldText === '60')).toMatchObject({ qtyNote: null, status: { tone: 'success', label: 'Bậc 1 · 5.000₫/vỉ' }, amountText: '300.000₫' })
    expect(st3.some((s) => /trần/i.test(s.status.label) || /trần/i.test(s.qtyNote ?? ''))).toBe(false)
    // Run lịch sử có trần (cấu hình cũ, đã đóng băng): vẫn hiện đúng snapshot — "tính 50" / "Đã đạt trần 50 vỉ".
    const legacyTiers = [{ order: 1, from: 1, to: 50, amount: '5000' }]
    const lg = cmsA3StaffRows([row({ baseQuantity: '600', perUnit: '10', cmsQuantity: '60', rewardedQuantity: '50', capQuantity: '50', atCap: true, amountVnd: '250000', potentialAmount: '250000' })],
      { tiers: legacyTiers, unit: 'vỉ', catalog: [], users: [], storeNames: new Map() })
    expect(lg[0]).toMatchObject({ qtyNote: 'tính 50', status: { tone: 'info', label: 'Đã đạt trần 50 vỉ' }, amountText: '250.000₫' })
    // Tiền lớn: chuỗi đầy đủ (không rút gọn).
    const big = row({ gmvBasis: 'none', baseQuantity: '1000000000', perUnit: '1', cmsQuantity: '1000000000', rewardedQuantity: '1000000000', amountVnd: '123456789012', potentialAmount: '123456789012' })
    expect(cmsA3StaffRows([big], { tiers: [{ order: 1, from: 1, to: null, amount: '1' }], unit: 'hộp', catalog: [], users: [], storeNames: new Map() })[0].amountText).toBe('123.456.789.012₫')
    // SP không có dòng: không có giải thích / phân bố (không 0 giả), tổng 0 hợp lệ của run.
    const none = cmsA3ProductVM(p, { catalogTargetGmv: null, priceText: cmsPrice, results: { rows: [], catalog: [], users: [], storeNames: new Map() } })
    expect([none.results!.countedText, none.results!.dist, none.results!.reasons, none.results!.amountText]).toEqual([null, null, [], '0₫'])
    // Không có kết quả (P1 / cờ OFF): results null — UI không render cột kết quả.
    expect(cmsA3ProductVM(p, { catalogTargetGmv: null, priceText: cmsPrice, results: null }).results).toBeNull()
  })

  test('nguồn: không đổi engine / công thức tiền; bảng A3 là MỘT DOM, hàng mở rộng riêng toàn chiều ngang, container query (không viewport)', () => {
    const t = read('components/cms/admin/CmsA3ProductTable.tsx')
    expect(t).toContain('@container')
    expect(t).toMatch(/aria-colspan=\{results \? 8 : 5\}/)
    expect(t).toContain('aria-expanded={open}')
    expect(t).toContain('aria-controls={open ? expId : undefined}')
    expect(t).not.toMatch(/userId/) // không đưa user_id dược sĩ xuống client
    expect(t).not.toMatch(/new ResizeObserver|matchMedia\(|window\.innerWidth/)
    expect(t).not.toMatch(/cmsProgressiveAmount|computeCmsProgram/) // client chỉ trình bày
    const pp = read('lib/cms/productPresentation.ts')
    expect(pp).not.toMatch(/computeCmsProgram\(|^import[^\n]*engine\/compute/m)
    // Page-root A3 fluid (width policy): không cap max-w ở gốc.
    const d = read('components/cms/admin/CmsProgramDetailView.tsx')
    expect(d).toContain('data-layout-width="fluid"')
    expect(d).not.toMatch(/max-w-\[1320px\]|max-w-(5xl|6xl|7xl)/)
  })
})

test.describe('CMS-UI-1 — A1 đọc chương trình đã chốt trong ngân sách (PM §6.4) @desktop', () => {
  const progs = [
    { id: 'L1', display: 'locked', isTest: false, productCount: 2 }, { id: 'Q1', display: 'running', isTest: true, productCount: 1 },
    { id: 'R1', display: 'running', isTest: false, productCount: 4 }, { id: 'W1', display: 'waiting_close', isTest: false, productCount: 2 },
    { id: 'L2', display: 'locked', isTest: false, productCount: 3 }, { id: 'QL', display: 'locked', isTest: true, productCount: 1 },
  ]
  test('thứ tự tải: đang chạy / chờ chốt thật → đã chốt thật → QA; cắt đúng trần', () => {
    expect(cmsA1LoadOrder(progs, 30).map((p) => p.id)).toEqual(['R1', 'W1', 'L1', 'L2', 'Q1', 'QL'])
    expect(cmsA1LoadOrder(progs, 3).map((p) => p.id)).toEqual(['R1', 'W1', 'L1'])
    expect(cmsA1LoadOrder(progs, 2).map((p) => p.id)).toEqual(['R1', 'W1'])
    expect(cmsA1LoadOrder(progs, 0)).toEqual([])
  })
  test('ô đã chốt có tiền + nhãn đã chốt, KHÔNG vào hai ô tổng / dược sĩ; đã chốt chưa tải ⇒ không ô (UI —) và không làm tổng thành —', () => {
    const R = cmsFxAdminResults('running')
    const L = cmsFxAdminResults('running', 'super', CMS_FX_PG.PG5)
    const r = cmsA1Results(progs, new Map<string, CmsResultsLoad>([['R1', R], ['W1', cmsFxAdminResults('running', 'super', CMS_FX_PG.PG4)], ['L1', L]]))
    expect(r.cells.get('L1')).toMatchObject({ kind: 'ok', locked: true, amountVnd: sum(loaded(L).rows.results) })
    expect(r.cells.get('R1')).toMatchObject({ kind: 'ok', locked: false })
    expect(r.stats.runningVnd).toBe(sum(loaded(R).rows.results))
    expect(r.stats.waitingVnd).toBe(sum(loaded(cmsFxAdminResults('running', 'super', CMS_FX_PG.PG4)).rows.results))
    expect(r.cells.has('L2')).toBe(false)
    expect(r.stats.notLoaded).toBe(0) // đã chốt không tải được không cắt tổng đang chạy / chờ chốt
    const err = cmsA1Results(progs, new Map<string, CmsResultsLoad>([['R1', R], ['W1', { kind: 'error' }], ['L1', { kind: 'error' }]]))
    expect([err.cells.get('L1')?.kind, err.stats.runningVnd, err.stats.waitingVnd, err.stats.pharmacists]).toEqual(['error', sum(loaded(R).rows.results), null, null])
  })
  test('SM: ô đã chốt = Σ kết quả phạm vi SM do loader trả (RPC 122 lọc theo nhà thuốc được phân công) — không cộng thêm dòng ngoài phạm vi; QA đã chốt không vào tổng', () => {
    const sup = cmsFxAdminResults('running', 'super', CMS_FX_PG.PG5)
    const sm = cmsFxAdminResults('running', 'sm', CMS_FX_PG.PG5)
    const progs2 = [{ id: 'R', display: 'running', isTest: false, productCount: 4 }, { id: 'L', display: 'locked', isTest: false, productCount: 14 }, { id: 'QL', display: 'locked', isTest: true, productCount: 4 }]
    const r = cmsA1Results(progs2, new Map<string, CmsResultsLoad>([['R', cmsFxAdminResults('running', 'sm')], ['L', sm], ['QL', cmsFxAdminResults('running', 'sm', CMS_FX_PG.PG9)]]))
    expect(r.cells.get('L')).toMatchObject({ kind: 'ok', locked: true, amountVnd: sum(loaded(sm).rows.results) })
    expect(sum(loaded(sm).rows.results)).toBeLessThan(sum(loaded(sup).rows.results))
    expect(loaded(sm).rows.users.every((x) => ['00000000-0000-4000-8000-000000008001', '00000000-0000-4000-8000-000000008002'].includes(x.storeId!))).toBe(true)
    expect(r.stats.runningVnd).toBe(sum(loaded(cmsFxAdminResults('running', 'sm')).rows.results)) // đã chốt + QA không vào tổng
    expect(r.cells.get('QL')).toMatchObject({ kind: 'ok', locked: true })
    // Danh sách SM (fixture A1 fx=sm) không có QA; tải theo cùng thứ tự / trần.
    expect(cmsA1LoadOrder(progs2, 1).map((p) => p.id)).toEqual(['R'])
  })
  test('route A1: cờ OFF ⇒ không gọi RPC; trần 30; đã chốt trong tập tải; không RPC / service role mới', () => {
    const s = read('app/(dashboard)/targets/campaigns/cms/page.tsx')
    expect(s).toContain('const CMS_A1_MAX = 30')
    expect(s).toContain("if (res.ok && isCmsEarningsEnabled()) {")
    expect(s).toContain("p.display === 'running' || p.display === 'waiting_close' || p.display === 'locked'")
    expect(s).toContain('cmsA1LoadOrder(targets, CMS_A1_MAX)')
    expect(s).toContain('await cmsLoadResults(p.id, { started: true })')
    expect(s).not.toMatch(/supabaseAdmin|service_role|\.rpc\(/)
  })
})

test.describe('CMS-UI-1 — điều hướng fixture giữ kịch bản (PM §6.7) @desktop', () => {
  const nav = cmsFixtureNav({ p2: 'running', as: 'sm', junk: 'x"><' })
  test('mode real = href thật (route thật không đổi); fixture ⇒ trang catalog tương ứng, giữ p2 / as', () => {
    for (const h of ['/targets/campaigns/cms', '/targets/campaigns/cms/abc?view=staff', '/targets?tab=cms&program=x', '/api/export/cms?program=a&run=b']) {
      expect(cmsNavHref(CMS_NAV_REAL, h)).toBe(h)
      expect(cmsNavHref(undefined, h)).toBe(h)
    }
    expect(nav).toEqual({ mode: 'fixture', keep: { p2: 'running', as: 'sm' } })
    expect(cmsNavHref(nav, '/targets/campaigns/cms?status=locked&q=900001')).toBe('/ui-catalog/cms-v2/list?status=locked&q=900001&p2=running&as=sm')
    expect(cmsNavHref(nav, '/targets/campaigns/cms/P?view=staff&page=2')).toBe('/ui-catalog/cms-v2/detail?program=P&view=staff&page=2&p2=running&as=sm')
    expect(cmsNavHref(nav, '/targets/campaigns/cms/P/import')).toBe('/ui-catalog/cms-v2/wizard?fx=upload&program=P&p2=running&as=sm')
    expect(cmsNavHref(nav, '/targets/campaigns/cms/P/edit')).toBe('/ui-catalog/cms-v2/wizard?fx=edit-active&program=P&p2=running&as=sm')
    expect(cmsNavHref(nav, '/targets/campaigns/cms/new')).toBe('/ui-catalog/cms-v2/wizard?fx=info&p2=running&as=sm')
    expect(cmsNavHref(nav, '/targets?tab=cms&program=P&f=met')).toBe('/ui-catalog/cms-v2/staff?program=P&f=met&p2=running&as=sm')
    expect(cmsNavHref(nav, '/targets/cms/products/PP')).toBe('/ui-catalog/cms-v2/product?pp=PP&p2=running&as=sm')
    expect(cmsNavHref(nav, '/targets/cms/history?program=P&product=PP&n=40')).toBe('/ui-catalog/cms-v2/history?program=P&product=PP&n=40&p2=running&as=sm')
    expect(cmsNavHref(nav, '/targets')).toBe('/ui-catalog/kpi-v2/staff')
    expect(cmsNavHref(nav, '/targets/campaigns')).toBe('/ui-catalog/kpi-v2/campaigns')
    // Link tải file không đổi đích — chặn bằng guard trong boundary (CmsDownloadLink), không bắn endpoint thật.
    expect(cmsNavHref(nav, '/api/export/cms?program=a&run=b')).toBe('/api/export/cms?program=a&run=b')
    // r2 (PM P2): fixture KHÔNG render href endpoint thật (nút bị chặn); route thật giữ <a href> nguyên giá trị.
    const dl = read('components/cms/CmsDownloadLink.tsx')
    expect(dl).toContain('if (inFixture) {')
    expect(dl).toContain('<button type="button" onClick={() => { fixtureBlocked() }}')
    expect(dl).toContain('<a href={href} className={className} {...data}>')
    expect(read('components/kpi/KpiFixtureBoundary.tsx')).toContain('return useContext(FixtureBlockContext) !== null')
    for (const f of ['components/cms/admin/CmsErrorFileLink.tsx', 'components/cms/admin/CmsImportResult.tsx']) expect(read(f), f).toContain('<CmsDownloadLink')
    expect(read('components/cms/admin/CmsProgramDetailView.tsx')).toContain("const exportHref = run ? `/api/export/cms?program=${encodeURIComponent(p.id)}&run=${encodeURIComponent(run.id)}` : null")
    expect(read('components/cms/admin/CmsPayoutPanel.tsx')).toContain("const exportHref = `/api/export/cms/payout?program=${encodeURIComponent(programId)}&run=${encodeURIComponent(payout.runId)}`")
    for (const f of ['components/cms/admin/CmsProgramDetailView.tsx', 'components/cms/admin/CmsPayoutPanel.tsx']) expect(read(f), f).not.toMatch(/<a href=\{exportHref\}/)
  })
  test('mọi trang fixture CMS truyền nav; component CMS không tự suy fixture từ is_test', () => {
    for (const p of ['list', 'detail', 'staff', 'product', 'history']) expect(read(`app/(dashboard)/ui-catalog/cms-v2/${p}/page.tsx`), p).toMatch(/nav=\{nav\}/)
    for (const f of ['components/cms/admin/CmsProgramDetailView.tsx', 'components/cms/admin/CmsProgramListView.tsx', 'components/cms/staff/CmsStaffCatalogView.tsx', 'lib/cms/fixtureNav.ts'])
      expect(read(f), f).not.toMatch(/isTest[^\n]*ui-catalog|ui-catalog[^\n]*isTest/)
  })
})
