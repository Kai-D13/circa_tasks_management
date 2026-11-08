import { test, expect } from '@playwright/test'
import { cmsFlatEquation, cmsFlatEquationText, cmsFlatRate, cmsIsFlatProduct, cmsIsSimpleProgram, type CmsFlatInput } from '../lib/cms/flat'
import { CMS_FX_PG, CMS_FX_PG_SIMPLE, CMS_FX_PROGRAMS, CMS_FX_SIMPLE_PROGRAMS, cmsFxListItems, cmsFxProgram, cmsFxProgramOfProduct } from '../lib/cms/fixtureScenario'
import { CMS_FX_RESULT_SCENARIOS, cmsFxAdminResults, cmsFxStaffResults, cmsFxStoreResults } from '../lib/cms/fixturesResults'
import { cmsNoRunText, cmsResultState, CMS_CONFIG_RESET_TEXT } from '../lib/cms/resultView'
import { parseCmsDecimal } from '../lib/cms/decimal'

// CMS đơn giản S3 (PM spec r1 08/11 §6) — predicate mức cố định chặt, phép nhân giải thích chỉ khi khớp snapshot, fixture đơn giản
// do engine tính (không gõ tay tiền), kịch bản config_reset. Hàm thuần — không server.

const flatP = (o: Partial<CmsFlatInput> = {}): CmsFlatInput => ({ gmvBasis: 'none', targetGmv: null, tiers: [{ order: 1, from: 1, to: null, amount: '25000' }], ...o })
const units = (v: string) => { const r = parseCmsDecimal(v); if (!r.ok) throw new Error(v); return r.units }

test.describe('CMS đơn giản — predicate mức cố định @desktop', () => {
  test('flat CHỈ khi 1 bậc {1, từ 1, không giới hạn}, gmvBasis none, không target, mức nguyên dương', () => {
    expect(cmsFlatRate(flatP())).toBe('25000')
    const notFlat: [string, CmsFlatInput][] = [
      ['target SP', flatP({ gmvBasis: 'product', targetGmv: '1000000' })],
      ['danh mục', flatP({ gmvBasis: 'catalog' })],
      ['none nhưng có target (dữ liệu bất nhất)', flatP({ targetGmv: '1' })],
      ['bậc cuối hữu hạn (lịch sử trước Q-220)', flatP({ tiers: [{ order: 1, from: 1, to: 50, amount: '25000' }] })],
      ['không bắt đầu từ 1', flatP({ tiers: [{ order: 1, from: 2, to: null, amount: '25000' }] })],
      ['order khác 1', flatP({ tiers: [{ order: 2, from: 1, to: null, amount: '25000' }] })],
      ['2 bậc', flatP({ tiers: [{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: null, amount: '20000' }] })],
      ['0 bậc', flatP({ tiers: [] })],
      ['mức 0', flatP({ tiers: [{ order: 1, from: 1, to: null, amount: '0' }] })],
      ['mức thập phân', flatP({ tiers: [{ order: 1, from: 1, to: null, amount: '25000.5' }] })],
      ['mức âm', flatP({ tiers: [{ order: 1, from: 1, to: null, amount: '-25000' }] })],
      ['mức có số 0 đầu', flatP({ tiers: [{ order: 1, from: 1, to: null, amount: '025000' }] })],
    ]
    for (const [why, p] of notFlat) expect(cmsIsFlatProduct(p), why).toBe(false)
  })

  test('chương trình đơn giản: ≥ 1 SP và mọi SP flat — rỗng KHÔNG vacuous true; trộn ⇒ false (nhánh theo SP)', () => {
    expect(cmsIsSimpleProgram([])).toBe(false)
    expect(cmsIsSimpleProgram([flatP()])).toBe(true)
    expect(cmsIsSimpleProgram([flatP(), flatP({ tiers: [{ order: 1, from: 1, to: null, amount: '18000' }] })])).toBe(true)
    expect(cmsIsSimpleProgram([flatP(), flatP({ gmvBasis: 'product', targetGmv: '1' })])).toBe(false)
    // Fixture: PG1 trộn (có 900003 flat cạnh SP target / danh mục / bậc) ⇒ không đơn giản; PG10–12 đơn giản; PG3 nháp 0 SP ⇒ false.
    expect(cmsIsSimpleProgram(cmsFxProgram(CMS_FX_PG.PG1)!.products)).toBe(false)
    expect(cmsFxProgram(CMS_FX_PG.PG1)!.products.filter(cmsIsFlatProduct).map((p) => p.productId)).toEqual(['900003'])
    expect(cmsIsSimpleProgram(cmsFxProgram(CMS_FX_PG.PG3)!.products)).toBe(false)
    for (const p of CMS_FX_SIMPLE_PROGRAMS) expect(cmsIsSimpleProgram(p.products), p.row.name).toBe(true)
  })
})

test.describe('CMS đơn giản — phép nhân giải thích chỉ khi khớp snapshot @desktop', () => {
  const row = (o: Partial<{ cmsQuantity: string; rewardedQuantity: string; amountVnd: string; gateMet: boolean }> = {}) =>
    ({ cmsQuantity: '12', rewardedQuantity: '12', amountVnd: '300000', gateMet: true, ...o })
  test('khớp ⇒ Q × mức = tiền snapshot; chưa có dòng ⇒ 0 × mức = 0₫ hợp lệ', () => {
    const e = cmsFlatEquation(flatP(), row())!
    expect(e).toEqual({ quantity: BigInt(12), rate: BigInt(25000), amountVnd: BigInt(300000) })
    expect(cmsFlatEquationText(e, 'hộp')).toBe('12 hộp × 25.000₫ = 300.000₫')
    expect(cmsFlatEquationText(cmsFlatEquation(flatP(), null)!, 'hộp')).toBe('0 hộp × 25.000₫ = 0₫')
    expect(cmsFlatEquationText(cmsFlatEquation(flatP(), row({ cmsQuantity: '1250', rewardedQuantity: '1250', amountVnd: '31250000' }))!, 'hộp')).toBe('1.250 hộp × 25.000₫ = 31.250.000₫')
  })
  test('lệch / không flat / dữ liệu sai dạng ⇒ null (UI chỉ hiện tiền snapshot, không phép nhân sai)', () => {
    expect(cmsFlatEquation(flatP(), row({ amountVnd: '301000' })), 'cấu hình đổi so với run').toBeNull()
    expect(cmsFlatEquation(flatP(), row({ rewardedQuantity: '10', amountVnd: '250000' })), 'run lịch sử có trần').toBeNull()
    expect(cmsFlatEquation(flatP(), row({ gateMet: false })), 'gate chưa mở').toBeNull()
    expect(cmsFlatEquation(flatP({ gmvBasis: 'product', targetGmv: '1' }), row()), 'không flat').toBeNull()
    expect(cmsFlatEquation(flatP(), row({ cmsQuantity: '1.5' }))).toBeNull()
    expect(cmsFlatEquation(flatP(), row({ cmsQuantity: '-1', rewardedQuantity: '-1', amountVnd: '-25000' }))).toBeNull()
    expect(cmsFlatEquation(flatP(), row({ amountVnd: 'x' }))).toBeNull()
  })
})

test.describe('CMS đơn giản — fixture một nguồn (engine) @desktop', () => {
  test('PG10–12 ngoài danh sách A1 (giữ 9 chương trình); tra theo id / program_product được', () => {
    expect(cmsFxListItems().length).toBe(9)
    expect(CMS_FX_PROGRAMS.length).toBe(9)
    expect(Object.keys(CMS_FX_PG_SIMPLE)).toEqual(['PG10', 'PG11', 'PG12'])
    for (const p of CMS_FX_SIMPLE_PROGRAMS) {
      expect(cmsFxProgram(p.row.id)).toBe(p)
      for (const x of p.products) expect(cmsFxProgramOfProduct(x.id)).toBe(p)
    }
    const ids = [...CMS_FX_PROGRAMS, ...CMS_FX_SIMPLE_PROGRAMS].flatMap((p) => [p.row.id, ...p.products.map((x) => x.id), ...(p.run ? [p.run.id] : []), ...p.runs.map((r) => r.id)])
    expect(new Set(ids).size, 'id fixture không trùng giữa chương trình cũ và đơn giản').toBe(ids.length)
  })

  test('mỗi dòng kết quả PG10 / PG12: tiền engine = floor(ΣB / K) × mức, khớp phép nhân giải thích; có phần lẻ, 0, số lớn', () => {
    for (const id of [CMS_FX_PG_SIMPLE.PG10, CMS_FX_PG_SIMPLE.PG12]) {
      const p = cmsFxProgram(id)!
      const l = cmsFxAdminResults('running', 'super', id)
      if (l.kind !== 'loaded') throw new Error('fx')
      expect(l.rows.results.length).toBeGreaterThan(0)
      for (const r of l.rows.results) {
        const pp = p.products.find((x) => x.id === r.programProductId)!
        const q = units(r.baseQuantity) / units(pp.baseQuantityCms)
        expect(BigInt(r.cmsQuantity), r.productId).toBe(q)
        expect(BigInt(r.amountVnd), r.productId).toBe(q * BigInt(cmsFlatRate(pp)!))
        expect(cmsFlatEquation(pp, r)?.amountVnd).toBe(BigInt(r.amountVnd))
      }
    }
    const a = cmsFxStaffResults('running', CMS_FX_PG_SIMPLE.PG10)
    if (a.kind !== 'loaded') throw new Error('fx')
    const pg10 = cmsFxProgram(CMS_FX_PG_SIMPLE.PG10)!
    const byPid = new Map(a.rows.results.map((r) => [r.productId, r]))
    expect(byPid.get('900103')?.baseQuantity, 'phần lẻ: 2,5 hộp × K 10').toBe('25')
    expect(byPid.get('900103')?.amountVnd).toBe('63000')
    expect(byPid.get('900106')?.amountVnd, 'số lớn: 1.250 hộp').toBe('53500000')
    expect(byPid.has('900105'), 'SP chưa bán: không có dòng (0 hợp lệ khi run đã công bố)').toBe(false)
    expect(pg10.products.find((x) => x.productId === '900104')!.priceSnapshot, 'SP thiếu giá tham khảo').toBeNull()
    // QLCH / SM / super đọc cùng run, mỗi dòng vẫn là phép nhân của chính dược sĩ đó.
    for (const l of [cmsFxStoreResults('running', CMS_FX_PG_SIMPLE.PG10), cmsFxAdminResults('running', 'sm', CMS_FX_PG_SIMPLE.PG10)]) {
      if (l.kind !== 'loaded') throw new Error('fx')
      for (const r of l.rows.results) expect(cmsFlatEquation(pg10.products.find((x) => x.id === r.programProductId)!, r)).not.toBeNull()
    }
  })

  test('PG11 sắp diễn ra ⇒ upcoming; kịch bản reset ⇒ config_reset "Chưa có số liệu sau thay đổi cấu hình", không dòng / không 0₫ giả', () => {
    expect(cmsFxStaffResults('running', CMS_FX_PG_SIMPLE.PG11).kind).toBe('upcoming')
    expect(CMS_FX_RESULT_SCENARIOS).toContain('reset')
    for (const l of [cmsFxStaffResults('reset', CMS_FX_PG_SIMPLE.PG10), cmsFxStoreResults('reset', CMS_FX_PG_SIMPLE.PG10), cmsFxAdminResults('reset', 'super', CMS_FX_PG_SIMPLE.PG10), cmsFxStaffResults('reset')]) {
      if (l.kind !== 'loaded') throw new Error('fx')
      expect(l.header.run).toBeNull()
      expect(cmsResultState(l.header)).toBe('config_reset')
      expect(cmsNoRunText(l.header)).toBe(CMS_CONFIG_RESET_TEXT)
      expect(l.rows.results).toEqual([])
    }
  })
})
