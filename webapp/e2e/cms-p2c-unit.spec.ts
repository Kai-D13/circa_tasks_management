import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { CmsQueryError, cmsQueryFailLine, cmsSafeSqlstate } from '../lib/cms/queryLog'
import {
  CMS_HISTORY_MAX_N, cmsA1Results, cmsCardMatches, cmsGateView, cmsHistoryHref, cmsHistoryMore, cmsLineView, cmsNearestGate,
  cmsParseCardFilter, cmsParseHistoryParams, cmsProductTierDistribution, cmsQtyText, cmsStaffCard, cmsStaffRows, cmsStaffSummary,
  cmsStoreSummary, cmsTierBreakdown, cmsTierPosition, cmsUnassignedSummary, cmsA1LoadOrder, cmsPinnedResults, type CmsPinDeps, type CmsResultsLoad,
  cmsHasSales, cmsProductSalesStats, cmsProductTotals,
} from '../lib/cms/resultUi'
import {
  CMS_FX_RESULT_SCENARIOS, CMS_FX_RUN, CMS_FX_USERS, cmsFxAdminResults, cmsFxLines, cmsFxStaffResults, cmsFxStoreResults,
} from '../lib/cms/fixturesResults'
import { CMS_FX_PRODUCTS } from '../lib/cms/fixtures'
import {
  buildCmsResultWorkbook, cmsDecCell, cmsIntCell, handleCmsResultExport, parseCmsExcludedPage, CMS_EXPORT_MAX_LINES,
  type CmsExportDeps, type CmsExportInput,
} from '../lib/cms/exportResults'
import { cmsWhatIf, type CmsResultRowDto } from '../lib/cms/resultView'

// CMS P2-c (I3) — phần thuần của UI kết quả + XLSX: log chỉ mã máy (PM 03/11 §3.2, sentinel email / giá trị), view-model
// (chia bậc khớp tiền snapshot hoặc ẩn, vị trí bậc, gate, tổng staff / QLCH, gợi ý gần đạt, A1 loại QA + lỗi ⇒ '—'), phân trang D3
// ghim run, fixture khớp tổng, workbook + handler export (thứ tự cổng, ghim run, đủ dòng, đối chiếu tổng, Q-206). Không DB.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const loaded = (l: CmsResultsLoad) => { if (l.kind !== 'loaded') throw new Error('not loaded'); return l }
const SENTINEL_EMAIL = 'nguyen.van.sentinel@circa.vn'
const SENTINEL_VALUE = '987654321012'

test.describe('CMS P2-c — log chỉ mã máy (PM 03/11 §3.2) @desktop', () => {
  test('lỗi có email / giá trị trong message ⇒ dòng log chỉ SQLSTATE đã whitelist; mã lạ ⇒ UNKNOWN; lỗi thường ⇒ UNKNOWN', () => {
    const pgErr = { message: `duplicate key (email)=(${SENTINEL_EMAIL}) amount=${SENTINEL_VALUE}`, code: '23505', details: SENTINEL_EMAIL }
    const line = cmsQueryFailLine('cms-catalog', new CmsQueryError(pgErr.code))
    expect(line).toBe('[cms-catalog] QUERY_FAILED sqlstate=23505')
    for (const l of [line, cmsQueryFailLine('x', new Error(pgErr.message)), cmsQueryFailLine('x', pgErr)]) {
      expect(l).not.toContain(SENTINEL_EMAIL)
      expect(l).not.toContain(SENTINEL_VALUE)
    }
    expect(cmsQueryFailLine('x', new Error(pgErr.message))).toBe('[x] QUERY_FAILED sqlstate=UNKNOWN')
    expect(new CmsQueryError(SENTINEL_EMAIL).sqlstate).toBe('UNKNOWN')
    expect(new CmsQueryError(SENTINEL_EMAIL).message).toBe('CMS_QUERY_FAILED')
    expect([cmsSafeSqlstate('PGRST116'), cmsSafeSqlstate('42501'), cmsSafeSqlstate('TOO_MANY_ROWS'), cmsSafeSqlstate('4250'), cmsSafeSqlstate(42501), cmsSafeSqlstate('x'.repeat(5))])
      .toEqual(['PGRST116', '42501', 'TOO_MANY_ROWS', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
  })

  test('catalog.ts / staffCatalog.ts / resultLoad.ts: không log hay ném message DB; lỗi vẫn trả QUERY_FAILED (không rỗng / 0)', () => {
    for (const f of ['lib/cms/server/catalog.ts', 'lib/cms/server/staffCatalog.ts', 'lib/cms/server/resultLoad.ts']) {
      const s = read(f)
      expect(s, f).not.toMatch(/\.message\b/)
      expect(s, f).not.toMatch(/throw new Error\(/)
      expect(s, f).toContain('cmsQueryFailLine(')
      for (const m of s.matchAll(/console\.(error|warn|log)\(([^\n]*)\)/g)) expect(m[2], `${f}: ${m[0]}`).toMatch(/^cmsQueryFailLine\(|^'\[[a-z-]+\] [A-Z_ ]+'/)
    }
    for (const f of ['lib/cms/server/catalog.ts', 'lib/cms/server/staffCatalog.ts']) expect(read(f), f).toContain("return { ok: false, error: 'QUERY_FAILED' }")
  })
})

test.describe('CMS P2-c — view-model resultUi @desktop', () => {
  const tiers3 = CMS_FX_PRODUCTS[0].tiers // 1–9: 15.000 · 10–19: 20.000 · 20+: 25.000

  test('chia bậc: Σ lát = F(Q) engine = tiền snapshot; lệch (cấu hình đổi) ⇒ null', () => {
    const b = cmsTierBreakdown(BigInt(14), tiers3, BigInt(235000))!
    expect(b.map((x) => [x.units, x.amountVnd])).toEqual([[BigInt(9), BigInt(135000)], [BigInt(5), BigInt(100000)], [BigInt(0), BigInt(0)]])
    expect(cmsTierBreakdown(BigInt(14), tiers3, BigInt(235001))).toBeNull()
    const capTiers = [{ order: 1, from: 1, to: 50, amount: '5000' }]
    expect(cmsTierBreakdown(BigInt(60), capTiers, BigInt(250000))!.map((x) => x.units)).toEqual([BigInt(50)])
    expect(cmsTierBreakdown(BigInt(0), tiers3, BigInt(0))!.every((x) => x.units === BigInt(0))).toBe(true)
  })

  test('vị trí bậc: chưa có ⇒ bậc 1 kế; giữa bậc; bậc cuối vô hạn = cao nhất; chạm trần', () => {
    expect(cmsTierPosition(BigInt(0), tiers3)).toEqual({ index: null, next: { index: 0, unitsToNext: BigInt(1) }, top: false, atCap: false })
    expect(cmsTierPosition(BigInt(14), tiers3)).toEqual({ index: 1, next: { index: 2, unitsToNext: BigInt(6) }, top: false, atCap: false })
    expect(cmsTierPosition(BigInt(25), tiers3)).toEqual({ index: 2, next: null, top: true, atCap: false })
    expect(cmsTierPosition(BigInt(60), [{ order: 1, from: 1, to: 50, amount: '5000' }])).toEqual({ index: 0, next: null, top: true, atCap: true })
  })

  test('staff D1: tổng = Σ tiền dòng kết quả; SP có CMS / đã bán; gate SP + danh mục; gợi ý gần đạt = SP thiếu ít nhất theo %', () => {
    const l = loaded(cmsFxStaffResults('running'))
    const s = cmsStaffSummary(l.rows.results, 4)
    expect([s.amountVnd, s.productsWithCms, s.productCount, s.productsSold, s.gmvVnd]).toEqual([BigInt(295000), 2, 4, 4, BigInt(17885000)])
    const r1 = l.rows.results.find((r) => r.programProductId === CMS_FX_PRODUCTS[0].id)!
    expect(cmsGateView(r1, l.rows.catalog)).toMatchObject({ basis: 'product', met: true, metAt: '2026-11-08T03:12:45.000000Z', shortVnd: BigInt(0), pct: 125 })
    const r2 = l.rows.results.find((r) => r.programProductId === CMS_FX_PRODUCTS[1].id)!
    expect(cmsGateView(r2, l.rows.catalog)).toMatchObject({ basis: 'catalog', met: false, metAt: null, shortVnd: BigInt(20000000), pct: 60 })
    const near = cmsNearestGate(l.rows.results)!
    expect([near.programProductId, near.shortVnd, near.potentialVnd, near.cmsQuantity]).toEqual([CMS_FX_PRODUCTS[3].id, BigInt(800000), BigInt(105000), BigInt(7)])
    const card = cmsStaffCard({ programProductId: CMS_FX_PRODUCTS[2].id, perUnit: '10', tiers: CMS_FX_PRODUCTS[2].tiers, row: l.rows.results[2], catalog: l.rows.catalog })
    expect([card.soldText, card.cmsQuantity, card.fraction, card.tone]).toEqual(['12,5', BigInt(12), '5 / 10 đơn vị cơ sở', 'earning'])
    const none = cmsStaffCard({ programProductId: 'x', perUnit: '30', tiers: tiers3, row: null, catalog: [] })
    expect([none.amountVnd, none.soldText, none.tone, cmsCardMatches(none, 'unmet'), cmsCardMatches(none, 'met')]).toEqual([BigInt(0), '0', 'none', true, false])
    expect([cmsParseCardFilter('met'), cmsParseCardFilter('x'), cmsParseCardFilter(undefined)]).toEqual(['met', 'all', 'all'])
  })

  test('QLCH: tổng nhà thuốc cộng tiền cá nhân (không áp lại bậc); theo dược sĩ sắp tiền giảm dần ổn định', () => {
    const l = loaded(cmsFxStoreResults('running'))
    const st = cmsStoreSummary(l.rows.results, 4)
    const sumRows = l.rows.results.reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0))
    expect(st.amountVnd).toBe(sumRows)
    expect(st.amountVnd).toBe(BigInt(295000 + 485000 + 250000))
    expect([st.staffWithCms, st.staffWithSales]).toEqual([2, 3])
    const rows = cmsStaffRows(l.rows.results, l.rows.users)
    expect(rows.map((x) => x.userId)).toEqual([CMS_FX_USERS.B, CMS_FX_USERS.A, CMS_FX_USERS.C])
    expect(rows.reduce((a, x) => a + x.amountVnd, BigInt(0))).toBe(sumRows)
  })

  test('A3 phân bố bậc cộng từng người; dòng chưa đạt gate không vào; A1: QA không vào thống kê, lỗi ⇒ null, chưa có số ⇒ đếm riêng', () => {
    const l = loaded(cmsFxAdminResults('running'))
    const p1 = l.rows.results.filter((r) => r.programProductId === CMS_FX_PRODUCTS[0].id)
    expect(cmsProductTierDistribution(p1, tiers3)).toEqual([BigInt(27), BigInt(25), BigInt(15)])
    const bad: CmsResultRowDto[] = p1.map((r, i) => (i === 0 ? { ...r, amountVnd: String(BigInt(r.amountVnd) + BigInt(1)) } : r))
    expect(cmsProductTierDistribution(bad, tiers3)).toBeNull()
    const progs = [
      { id: 'a', display: 'running', isTest: false, productCount: 4 }, { id: 'b', display: 'running', isTest: true, productCount: 2 },
      { id: 'c', display: 'waiting_close', isTest: false, productCount: 3 }, { id: 'd', display: 'running', isTest: false, productCount: 1 },
    ]
    const ok = cmsA1Results(progs, new Map<string, CmsResultsLoad>([['a', cmsFxAdminResults('running')], ['b', cmsFxAdminResults('top')], ['c', cmsFxAdminResults('none')], ['d', cmsFxStaffResults('running')]]))
    const aSum = l.rows.results.reduce((s, r) => s + BigInt(r.amountVnd), BigInt(0))
    expect(ok.stats.runningVnd).toBe(aSum + BigInt(295000))
    expect([ok.stats.waitingVnd, ok.stats.withoutSnapshot, ok.stats.pharmacists]).toEqual([null, 1, 3])
    expect(ok.cells.get('b')?.kind).toBe('ok')                     // QA có ô nhưng không vào tổng
    const err = cmsA1Results(progs, new Map<string, CmsResultsLoad>([['a', { kind: 'error' }], ['d', cmsFxStaffResults('running')]]))
    // Vượt trần một lượt xem (pm-auditor I3 P1-1): chương trình thật không được tải ⇒ mọi ô tổng null + notLoaded, không tổng thiếu.
    const cut = cmsA1Results(progs, new Map<string, CmsResultsLoad>([['a', cmsFxAdminResults('running')], ['b', cmsFxAdminResults('top')]]))
    expect([cut.stats.runningVnd, cut.stats.waitingVnd, cut.stats.pharmacists, cut.stats.notLoaded]).toEqual([null, null, null, 2])
    expect(cut.cells.get('a')?.kind).toBe('ok')
    expect(ok.stats.notLoaded).toBe(0)
    expect(cmsA1LoadOrder(progs, 3).map((p) => p.id)).toEqual(['a', 'c', 'd'])
    expect(cmsA1LoadOrder(progs, 10).map((p) => p.id)).toEqual(['a', 'c', 'd', 'b'])
    expect([err.stats.runningVnd, err.stats.pharmacists, err.cells.get('a')?.kind]).toEqual([null, null, 'error'])
  })

  test('nhóm Chưa gán: đọc phòng thủ totals (khoá lạ / âm / sai kiểu bị bỏ, thiếu ⇒ null)', () => {
    expect(cmsUnassignedSummary({ unassigned: 7, unassigned_gmv: '1350000.5', unassigned_by_reason: { NOT_FOUND: 4, SHARED_ACCOUNT: 2, NO_EMAIL: 1, HACK: 9, MULTIPLE: -1 } }))
      .toEqual({ count: 7, gmvVnd: BigInt(1350000), reasons: [{ reason: 'NOT_FOUND', label: 'Email không khớp tài khoản nào', count: 4 }, { reason: 'SHARED_ACCOUNT', label: 'Tài khoản dùng chung của cửa hàng', count: 2 }, { reason: 'NO_EMAIL', label: 'Nguồn không có email người bán', count: 1 }] })
    expect(cmsUnassignedSummary(null)).toBeNull()
    expect(cmsUnassignedSummary({ unassigned: '7' })).toBeNull()
  })

  test('dòng lịch sử: nhãn / ghi chú; ADJUSTMENT khi Q-206 chưa chốt ⇒ không nhãn "Điều chỉnh", tiền null (U18)', () => {
    const l = { status: 'RECORDED' as const, amountVnd: '30000', baseQuantity: '60', qtyBefore: '0', qtyAfter: '2' }
    expect(cmsLineView(l, '30', 'hộp', false)).toEqual({ label: 'Đã ghi nhận', tone: 'info', amountVnd: BigInt(30000), qtyText: '2', note: '+2 hộp tính CMS' })
    const adj = cmsLineView({ ...l, status: 'ADJUSTMENT', amountVnd: '-15000' }, '30', 'hộp', false)
    expect([adj.label, adj.amountVnd]).toEqual(['Chờ xác nhận', null])
    expect(cmsLineView({ ...l, status: 'ADJUSTMENT', amountVnd: '-15000' }, '30', 'hộp', true).label).toBe('Điều chỉnh')
    expect(cmsLineView({ ...l, status: 'WAITING_GATE', amountVnd: '0' }, '30', 'hộp', false).note).toBe('Chưa đạt target — CMS tính khi đạt')
    expect(cmsQtyText(BigInt('1500000000'), BigInt('1000000000'))).toBe('1,5')
  })

  test('D3: tham số URL chặt; "Xem thêm" tăng n trên cùng con trỏ, tới 200 ⇒ chuyển con trỏ; luôn giữ run; hết ⇒ null', () => {
    const P = '00000000-0000-4000-8000-000000000001', R = CMS_FX_RUN
    const HEX = 'abcdef12-3456-4789-8abc-def012345678'
    expect(cmsParseHistoryParams({ program: P, product: 'x', run: HEX.toUpperCase(), after: '-1', n: '30' })).toEqual({ programId: P, productId: null, run: null, after: null, n: 20 })
    expect(cmsParseHistoryParams({ run: HEX, after: '1e3', n: '220' })).toEqual({ programId: null, productId: null, run: HEX, after: null, n: 20 })
    expect(cmsParseHistoryParams({ program: P, run: R, after: '40', n: '200' })).toEqual({ programId: P, productId: null, run: R, after: 40, n: 200 })
    const base = { programId: P, productId: null, run: R, after: null, n: 20 }
    expect(cmsHistoryMore(base, 19)).toBe(`/targets/cms/history?program=${P}&run=${R}&n=40`)
    expect(cmsHistoryMore({ ...base, n: CMS_HISTORY_MAX_N }, 199)).toBe(`/targets/cms/history?program=${P}&run=${R}&after=199`)
    expect(cmsHistoryMore(base, null)).toBeNull()
    expect(cmsHistoryHref(P, null)).toBe(`/targets/cms/history?program=${P}`)
  })

  test('"Nếu bán thêm" (client) cùng hàm bậc engine: 14 → 20 hộp = +125.000₫ (5 × 20.000 + 1 × 25.000)', () => {
    expect(cmsWhatIf({ baseQuantity: '420', perUnit: '30', tiers: tiers3, extraUnits: 6 })).toEqual({ amountNowVnd: BigInt(235000), amountAfterVnd: BigInt(360000), deltaVnd: BigInt(125000) })
  })
})

test.describe('CMS P2-c — fixture khớp như snapshot @desktop', () => {
  test('mọi kịch bản: Σ tiền dòng = Σ tiền kết quả; số dòng = Σ line_count; seq tăng dần liên tục', () => {
    for (const s of CMS_FX_RESULT_SCENARIOS) for (const l of [cmsFxStaffResults(s), cmsFxStoreResults(s), cmsFxAdminResults(s), cmsFxAdminResults(s, 'sm')]) {
      if (l.kind !== 'loaded') continue
      const lines = cmsFxLines(l.rows.results)
      expect(lines.length, s).toBe(l.rows.results.reduce((a, r) => a + r.lineCount, 0))
      expect(lines.reduce((a, x) => a + BigInt(x.amountVnd), BigInt(0)), s).toBe(l.rows.results.reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0)))
      expect(lines.map((x) => x.seq)).toEqual(lines.map((_, i) => i))
      for (const r of l.rows.results) {
        const p = CMS_FX_PRODUCTS.find((x) => x.id === r.programProductId)!
        const exp = r.gateMet ? BigInt(r.amountVnd) : BigInt(r.potentialAmount)
        expect(cmsTierBreakdown(BigInt(r.cmsQuantity), p.tiers, exp), `${s} ${r.userId} ${r.productId}`).not.toBeNull()
      }
    }
  })
})

// ── Export ──────────────────────────────────────────────────────────────────
const PRODUCTS = CMS_FX_PRODUCTS.map((p) => ({ id: p.id, productId: p.productId, nameSnapshot: p.nameSnapshot, unitCms: p.unitCms, baseQuantityCms: p.baseQuantityCms, gmvBasis: p.gmvBasis }))
const PROGRAM = { id: '00000000-0000-4000-8000-000000000001', name: '=HYPERLINK("http://x")', startDate: '2026-11-01', endDate: '2026-11-30', configVersion: 3 }
function input(o: Partial<CmsExportInput> = {}): CmsExportInput {
  const l = loaded(cmsFxAdminResults('running'))
  return { program: PROGRAM, header: l.header, rows: l.rows, lines: cmsFxLines(l.rows.results), excluded: [], products: PRODUCTS, storeNames: new Map(), exportedAt: new Date('2026-11-15T03:00:00Z'), scope: 'super', returnsApproved: false, ...o }
}
const sheets = (bytes: Uint8Array) => XLSX.read(bytes, { type: 'array' })

test.describe('CMS P2-c r1.1 — "người có bán" một định nghĩa (PM P1-I3-1) @desktop', () => {
  test('cùng run / SP: bán 0,5 (Q0) · đủ 1 (Q1) · thuần 0 ⇒ D3 / QLCH / A3 / theo dược sĩ / XLSX cùng 2 người có bán; Q-212 "lượt" vẫn Q ≥ 1', () => {
    const l = loaded(cmsFxAdminResults('running'))
    const p = CMS_FX_PRODUCTS[0] // K = 30 hộp, bậc 1–9: 15.000
    const base = l.rows.results.find((r) => r.programProductId === p.id)!
    const mk = (userId: string, b: string, q: string, amount: string): CmsResultRowDto => ({
      ...base, userId, baseQuantity: b, cmsQuantity: q, rewardedQuantity: q, potentialAmount: amount, amountVnd: amount,
      gmvAmount: b === '0' ? '0' : '500000', gateMet: true, gateMetAt: '2026-11-08T03:12:45.000000Z', atCap: false, lineCount: 1,
    })
    const X = mk(CMS_FX_USERS.A, '15', '0', '0'), Y = mk(CMS_FX_USERS.B, '30', '1', '15000'), Z = mk(CMS_FX_USERS.C, '0', '0', '0')
    const rows = [X, Y, Z]
    expect(rows.map(cmsHasSales)).toEqual([true, true, false])
    const st = cmsProductSalesStats(rows).get(p.id)!
    expect([st.staffWithSales, st.staffAchieved, st.cmsQuantity]).toEqual([2, 1, BigInt(1)])
    expect(cmsProductTotals(rows, new Map([[p.id, p.baseQuantityCms]])).get(p.id)!.staffWithSales).toBe(2) // D1 / D2 / D3 QLCH
    expect(cmsStoreSummary(rows, 1).staffWithSales).toBe(2)
    expect(cmsStaffRows(rows, l.rows.users).map((x) => [x.userId, x.productsSold])).toEqual(expect.arrayContaining([[CMS_FX_USERS.A, 1], [CMS_FX_USERS.B, 1], [CMS_FX_USERS.C, 0]]))
    // XLSX đọc lại bằng xlsx thật — cùng con số.
    const lines = cmsFxLines(rows)
    const b = buildCmsResultWorkbook({ ...input(), rows: { ...l.rows, results: rows, catalog: [] }, lines, excluded: [] })
    if (!b.ok) throw new Error(b.error)
    const prod = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheets(b.bytes).Sheets['Theo san pham'])
    const r0 = prod.find((r) => r.ProductID === p.productId)!
    expect([r0['Dược sĩ có bán'], r0['Dược sĩ đạt'], r0['SL tính CMS']]).toEqual([2, 1, 1])
    // A3 dùng CÙNG helper (không tự đếm lại theo ngưỡng khác); không còn ngưỡng "có bán" riêng trong component / export.
    const a3 = read('components/cms/admin/CmsProgramResults.tsx')
    expect(a3).toContain('cmsProductSalesStats(rows)')
    for (const f of ['components/cms/admin/CmsProgramResults.tsx', 'lib/cms/exportResults.ts']) expect(read(f), f).not.toMatch(/baseQuantity\) > BigInt\(0\)\) (a\.)?sold/)
    expect(a3).toContain('Lượt = dược sĩ × SP đã bán đủ ≥ 1 đơn vị CMS')
  })
})

test.describe('CMS P2-c — XLSX kết quả @desktop', () => {
  test('workbook: đủ sheet, run_id, tổng lệch 0đ, số dòng đủ; chuỗi là text (không công thức); SM không có sheet Chưa gán', () => {
    const b = buildCmsResultWorkbook(input())
    if (!b.ok) throw new Error(b.error)
    const wb = sheets(b.bytes)
    expect(wb.SheetNames).toEqual(['Thong tin', 'Theo san pham', 'Theo duoc si', 'Chi tiet dong', 'Chua gan'])
    const info = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Thong tin'], { header: 1 })
    expect(info.find((r) => r[0] === 'run_id (phiên kết quả)')?.[1]).toBe(CMS_FX_RUN)
    expect(info.find((r) => r[0] === 'Chương trình')?.[1]).toBe(PROGRAM.name)
    expect(wb.Sheets['Thong tin'].B2.t).toBe('s')
    expect(wb.Sheets['Thong tin'].B2.f).toBeUndefined()
    const lines = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Chi tiet dong'])
    expect(lines.length).toBe(b.lineCount)
    expect(lines.reduce((s, r) => s + BigInt(String(r['CMS dòng (VND)'])), BigInt(0))).toBe(b.amountVnd)
    const prod = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Theo san pham'])
    expect(prod.at(-1)?.['CMS tạm tính (VND)']).toBe(Number(b.amountVnd))
    const sm = buildCmsResultWorkbook(input({ scope: 'sm', excluded: null }))
    if (!sm.ok) throw new Error(sm.error)
    expect(sheets(sm.bytes).SheetNames).not.toContain('Chua gan')
  })

  test('kiểm toàn vẹn trước khi trả file: thiếu dòng / lệch tổng / khác run / dòng điều chỉnh khi Q-206 HOLD ⇒ không file', () => {
    const i = input()
    expect(buildCmsResultWorkbook({ ...i, lines: i.lines.slice(1) })).toEqual({ ok: false, error: 'COUNT_MISMATCH' })
    expect(buildCmsResultWorkbook({ ...i, lines: i.lines.map((l, k) => (k === 0 ? { ...l, amountVnd: String(BigInt(l.amountVnd) + BigInt(1)) } : l)) })).toEqual({ ok: false, error: 'TOTAL_MISMATCH' })
    expect(buildCmsResultWorkbook({ ...i, rows: { ...i.rows, runId: '00000000-0000-4000-8000-000000000999' } })).toEqual({ ok: false, error: 'RUN_MISMATCH' })
    const adj = i.lines.map((l, k) => (k === 0 ? { ...l, status: 'ADJUSTMENT' as const } : l))
    expect(buildCmsResultWorkbook({ ...i, lines: adj })).toEqual({ ok: false, error: 'RETURNS_HOLD' })
    expect(buildCmsResultWorkbook({ ...i, lines: adj, returnsApproved: true }).ok).toBe(true)
  })

  test('ô số: nguyên an toàn ⇒ số; vượt 2^53 / thập phân ⇒ text đủ chữ số', () => {
    expect([cmsIntCell('9007199254740991'), cmsIntCell('9007199254740993'), cmsIntCell(BigInt(-5)), cmsDecCell('1234.500000000'), cmsDecCell('12.000'), cmsDecCell(null)])
      .toEqual([9007199254740991, '9007199254740993', -5, '1234.5', 12, null])
  })

  test('parse trang Chưa gán: sai dạng ⇒ lỗi (không rỗng giả)', () => {
    const ok = parseCmsExcludedPage({ run_id: CMS_FX_RUN, next_after_seq: null, rows: [{ seq: 3, order_line_id: 'OL', order_code: 'HD', product_id: '900001', program_product_id: null, disposition: 'UNASSIGNED', unassigned_reason: 'NOT_FOUND', seller_email: 'a@b.c', user_id: null, store_id: null, pos_code: null, completed_at: '2026-11-02T02:00:00.000000Z', base_quantity: '30', gmv_amount: '100000' }] })
    expect(ok.rows[0].sellerEmail).toBe('a@b.c')
    expect(() => parseCmsExcludedPage({ run_id: CMS_FX_RUN, rows: [{ seq: 'x' }] })).toThrow()
    expect(() => parseCmsExcludedPage({ run_id: 'x', rows: [] })).toThrow()
  })
})

function deps(o: Partial<CmsExportDeps> = {}, calls: string[] = []): CmsExportDeps {
  const l = loaded(cmsFxAdminResults('running'))
  const lines = cmsFxLines(l.rows.results)
  const track = <T,>(name: string, v: T) => { calls.push(name); return v }
  return {
    session: async () => track('session', { userId: CMS_FX_USERS.A, role: 'admin', email: 'super@circa.vn' }),
    flags: () => track('flags', { program: true, earnings: true }),
    access: () => track('access', { view: true, manage: true }),
    program: async () => track('program', { ok: true as const, data: { program: { ...PROGRAM, status: 'active' }, products: PRODUCTS } }),
    header: async () => track('header', { ok: true as const, data: l.header }),
    rows: async () => track('rows', { ok: true as const, data: l.rows }),
    lines: async (_p, _r, max) => track('lines', max === CMS_EXPORT_MAX_LINES ? { ok: true as const, data: lines } : { ok: false as const, error: 'BAD_INPUT' as const }),
    excluded: async (_p, _r, after) => track(`excluded:${after}`, after === null
      ? { ok: true as const, data: { runId: CMS_FX_RUN, rows: [], nextAfterSeq: 499 } }
      : { ok: true as const, data: { runId: CMS_FX_RUN, rows: [], nextAfterSeq: null } }),
    storeNames: async () => track('storeNames', new Map()),
    now: () => new Date('2026-11-15T03:00:00Z'),
    returnsApproved: false,
    ...o,
  }
}
const URL_OK = `http://localhost/api/export/cms?program=${PROGRAM.id}&run=${CMS_FX_RUN}`

test.describe('CMS P2-c — handler export @desktop', () => {
  test('thành công: xlsx no-store; super đọc đủ trang Chưa gán theo con trỏ', async () => {
    const calls: string[] = []
    const res = await handleCmsResultExport(new Request(URL_OK), deps({}, calls))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml')
    expect(calls).toEqual(['session', 'flags', 'access', 'program', 'header', 'rows', 'lines', 'excluded:null', 'excluded:499', 'storeNames'])
    expect(sheets(new Uint8Array(await res.arrayBuffer())).SheetNames).toContain('Chi tiet dong')
  })

  test('cổng trước mọi đọc: chưa đăng nhập 401; cờ earnings OFF / không quyền 403; tham số sai 400 — không gọi DB', async () => {
    const cases: [Partial<CmsExportDeps>, string, number][] = [
      [{ session: async () => null }, URL_OK, 401],
      [{ flags: () => ({ program: true, earnings: false }) }, URL_OK, 403],
      [{ flags: () => ({ program: false, earnings: true }) }, URL_OK, 403],
      [{ access: () => ({ view: false, manage: false }) }, URL_OK, 403],
      [{}, `http://localhost/api/export/cms?program=${PROGRAM.id}`, 400],
      [{}, `http://localhost/api/export/cms?program=ABCDEF12-3456-4789-8ABC-DEF012345678&run=${CMS_FX_RUN}`, 400],
      [{}, `http://localhost/api/export/cms?program=${PROGRAM.id}&run=${CMS_FX_RUN}x`, 400],
    ]
    for (const [o, url, status] of cases) {
      const calls: string[] = []
      const res = await handleCmsResultExport(new Request(url), deps(o, calls))
      expect(res.status, url).toBe(status)
      expect(calls.filter((c) => !['session', 'flags', 'access'].includes(c)), url).toEqual([])
    }
  })

  test('run trên màn khác run hiện hành / đã dọn ⇒ 409; vượt trần ⇒ 413; ngoài phạm vi ⇒ 404; SM không đọc Chưa gán', async () => {
    const l = loaded(cmsFxAdminResults('running'))
    const other = { ...l.header, run: { ...l.header.run!, id: '00000000-0000-4000-8000-000000000998' } }
    expect((await handleCmsResultExport(new Request(URL_OK), deps({ header: async () => ({ ok: true, data: other }) }))).status).toBe(409)
    expect((await handleCmsResultExport(new Request(URL_OK), deps({ rows: async () => ({ ok: false, error: 'RUN_GONE' }) }))).status).toBe(409)
    expect((await handleCmsResultExport(new Request(URL_OK), deps({ lines: async () => ({ ok: false, error: 'TOO_LARGE' }) }))).status).toBe(413)
    expect((await handleCmsResultExport(new Request(URL_OK), deps({ program: async () => ({ ok: true, data: null }) }))).status).toBe(404)
    expect((await handleCmsResultExport(new Request(URL_OK), deps({ excluded: async () => ({ ok: true, data: { runId: '00000000-0000-4000-8000-000000000997', rows: [], nextAfterSeq: null } }) }))).status).toBe(409)
    const calls: string[] = []
    const sm = await handleCmsResultExport(new Request(URL_OK), deps({ access: () => ({ view: true, manage: false }) }, calls))
    expect(sm.status).toBe(200)
    expect(calls.some((c) => c.startsWith('excluded'))).toBe(false)
    expect(sheets(new Uint8Array(await sm.arrayBuffer())).SheetNames).not.toContain('Chua gan')
  })

  test('route thật: session client (không service role), cờ program + earnings, Q-206 theo hằng releaseGate', () => {
    const s = read('app/api/export/cms/route.ts')
    expect(s).not.toContain('supabaseAdmin')
    expect(s).toContain('handleCmsResultExport(request')
    expect(s).toContain("returnsApproved: CMS_Q206_RETURNS_CONTRACT === 'APPROVED'")
  })
})

test.describe('CMS P2-c — cổng route & cờ @desktop', () => {
  test('cờ earnings OFF ⇒ không gọi RPC kết quả; D3 404; route không service role', () => {
    const rl = read('lib/cms/server/resultLoad.ts')
    expect(rl).toContain('cmsPinnedResults({ enabled: isCmsEarningsEnabled(), header: cmsLoadResultHeader, rows: cmsLoadResultRows }, programId, o)')
    expect(rl).not.toContain('supabaseAdmin')
    const d3 = read('app/(dashboard)/targets/cms/history/page.tsx')
    const order = ["redirect('/login')", 'await redirectIfFsStaff(', 'if (!isCmsEarningsEnabled()) notFound()', "profile?.role === 'staff' || profile?.role === 'store_manager'", 'cmsLoadHistoryPrograms(']
    let last = -1
    for (const m of order) { const i = d3.indexOf(m); expect(i, m).toBeGreaterThan(last); last = i }
    for (const f of ['app/(dashboard)/targets/cms/history/page.tsx', 'app/(dashboard)/targets/cms/products/[programProductId]/page.tsx', 'components/cms/staff/CmsStaffCatalogPage.tsx', 'app/(dashboard)/targets/campaigns/cms/page.tsx', 'app/(dashboard)/targets/campaigns/cms/[id]/page.tsx']) {
      expect(read(f), f).not.toContain('supabaseAdmin')
    }
    // Staff D3 đọc dòng của CHÍNH mình (userId = user.id); QLCH null ⇒ RPC lọc staff hiện thuộc nhà thuốc.
    expect(d3).toContain('userId: manager ? null : user.id')
  })
})

test.describe('CMS P2-c — ghim run ở loader (pm-auditor I3 P1-2) @desktop', () => {
  const H = loaded(cmsFxStaffResults('running'))
  const NEW_RUN = '00000000-0000-4000-8000-000000009501'
  const headerFor = (run: string) => ({ ...H.header, run: { ...H.header.run!, id: run } })
  function pin(seq: { header: Array<{ ok: true; data: typeof H.header } | { ok: false; error: string }>; rows: Array<(run: string) => { ok: true; data: typeof H.rows } | { ok: false; error: string }> }, enabled = true) {
    const calls: string[] = []
    let hi = 0, ri = 0
    const d: CmsPinDeps = {
      enabled,
      header: async () => { calls.push('header'); return seq.header[hi++] },
      rows: async (_p, run) => { calls.push(`rows:${run}`); return seq.rows[ri++](run) },
    }
    return { d, calls }
  }
  const rowsOf = (run: string) => ({ ok: true as const, data: { ...H.rows, runId: run } })

  test('cờ OFF / chưa bắt đầu ⇒ 0 lần gọi', async () => {
    const a = pin({ header: [], rows: [] }, false)
    expect(await cmsPinnedResults(a.d, 'p', { started: true })).toEqual({ kind: 'off' })
    const b = pin({ header: [], rows: [] })
    expect(await cmsPinnedResults(b.d, 'p', { started: false })).toEqual({ kind: 'upcoming' })
    expect([...a.calls, ...b.calls]).toEqual([])
  })

  test('rows đọc ĐÚNG run của header; chưa có run ⇒ không gọi rows', async () => {
    const a = pin({ header: [{ ok: true, data: H.header }], rows: [rowsOf] })
    const r = await cmsPinnedResults(a.d, 'p', { started: true })
    expect(r.kind === 'loaded' && r.rows.runId).toBe(CMS_FX_RUN)
    expect(a.calls).toEqual(['header', `rows:${CMS_FX_RUN}`])
    const b = pin({ header: [{ ok: true, data: { ...H.header, run: null } }], rows: [] })
    expect((await cmsPinnedResults(b.d, 'p', { started: true })).kind).toBe('loaded')
    expect(b.calls).toEqual(['header'])
  })

  test('run được thay giữa hai lần gọi (RUN_GONE) ⇒ đọc lại header một lần, ghim run mới; GONE hai lần ⇒ gone (không trộn phiên)', async () => {
    const a = pin({ header: [{ ok: true, data: H.header }, { ok: true, data: headerFor(NEW_RUN) }], rows: [() => ({ ok: false, error: 'RUN_GONE' }), rowsOf] })
    const r = await cmsPinnedResults(a.d, 'p', { started: true })
    expect(r.kind === 'loaded' && [r.header.run?.id, r.rows.runId]).toEqual([NEW_RUN, NEW_RUN])
    expect(a.calls).toEqual(['header', `rows:${CMS_FX_RUN}`, 'header', `rows:${NEW_RUN}`])
    const b = pin({ header: [{ ok: true, data: H.header }, { ok: true, data: headerFor(NEW_RUN) }], rows: [() => ({ ok: false, error: 'RUN_GONE' }), () => ({ ok: false, error: 'RUN_GONE' })] })
    expect(await cmsPinnedResults(b.d, 'p', { started: true })).toEqual({ kind: 'gone' })
    expect(b.calls.length).toBe(4)
  })

  test('rows trả run khác run đã ghim ⇒ error (không nhận); header lỗi ⇒ error / gone theo mã; rows lỗi khác ⇒ error, không đọc lại', async () => {
    const a = pin({ header: [{ ok: true, data: H.header }], rows: [() => rowsOf(NEW_RUN)] })
    expect(await cmsPinnedResults(a.d, 'p', { started: true })).toEqual({ kind: 'error' })
    for (const [e, k] of [['QUERY_FAILED', 'error'], ['FORBIDDEN', 'error'], ['RUN_GONE', 'gone']] as const) {
      const b = pin({ header: [{ ok: false, error: e }], rows: [] })
      expect(await cmsPinnedResults(b.d, 'p', { started: true })).toEqual({ kind: k })
    }
    const c = pin({ header: [{ ok: true, data: H.header }], rows: [() => ({ ok: false, error: 'QUERY_FAILED' })] })
    expect(await cmsPinnedResults(c.d, 'p', { started: true })).toEqual({ kind: 'error' })
    expect(c.calls).toEqual(['header', `rows:${CMS_FX_RUN}`])
  })
})

test.describe('CMS P2-c — XLSX an toàn ô / vết kiểm toán (security I3 P2) @desktop', () => {
  test('chuỗi bắt đầu bằng = + - @ (tên SP do super nhập, email nguồn) ⇒ ô text, không công thức', () => {
    const risky = ['=1+1', '+SUM(A1:A2)', '-2+3', '@cmd', '=HYPERLINK("http://x","y")']
    const i = input({ products: PRODUCTS.map((p, k) => ({ ...p, nameSnapshot: risky[k % risky.length] })), program: { ...PROGRAM, name: risky[4] } })
    const b = buildCmsResultWorkbook(i)
    if (!b.ok) throw new Error(b.error)
    const wb = sheets(b.bytes)
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name]
      for (const [addr, cell] of Object.entries(ws)) {
        if (addr.startsWith('!')) continue
        const c = cell as XLSX.CellObject
        expect(c.f, `${name}!${addr}`).toBeUndefined()
        if (typeof c.v === 'string' && /^[=+\-@]/.test(c.v)) expect(c.t, `${name}!${addr}`).toBe('s')
      }
    }
    expect(XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Theo san pham'])[0]['Tên sản phẩm']).toBe('=1+1')
  })

  test('xuất thành công ghi MỘT dòng log kiểm toán: chỉ id / số đếm, không email / tên / tiền', async () => {
    const logs: string[] = []
    const orig = console.info
    console.info = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
    try {
      const res = await handleCmsResultExport(new Request(URL_OK), deps())
      expect(res.status).toBe(200)
    } finally {
      console.info = orig
    }
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(new RegExp(`^\\[cms-export\\] OK user=${CMS_FX_USERS.A} program=${PROGRAM.id} run=${CMS_FX_RUN} scope=super lines=\\d+ excluded=0$`))
    expect(logs[0]).not.toMatch(/@|₫|Dược sĩ/)
  })
})
