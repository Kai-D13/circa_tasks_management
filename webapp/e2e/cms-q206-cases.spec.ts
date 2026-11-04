import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { CMS_Q206_OPTIONS, cmsQ206Adapt, type CmsQ206EventRaw, type CmsQ206Option } from './cmsQ206Cases'
import { CMS_Q206_RETURNS_CONTRACT, cmsCanPublishResults } from '../lib/cms/releaseGate'
import { normalizeSalesRow, type CmsRawRow, type CmsSalesLine } from '../lib/cms/source/contract'
import { computeCmsProgram } from '../lib/cms/engine/compute'
import { buildSellerIndex, type CmsUserRef } from '../lib/cms/mapping'
import type { CmsEngineProgramInput } from '../lib/cms/engine/config'
import { parseUtcMicros } from '../lib/cms/time'

// CMS Q-206 (HOLD) — ca T1–T11 của checklist §3.5 + minh hoạ §3.4 chạy trên ENGINE THẬT với NGUYÊN MẪU adapter e2e/cmsQ206Cases.ts.
// Không có phương án mặc định: mỗi ca ghi số dưới từng tổ hợp B1 (người bán gốc / người xử lý trả) × D1 (kỳ ngày bán / ngày trả)
// để stakeholder chọn. Các quy tắc an toàn (phiên bản, không trừ hai lần, không âm, không trừ người khác, sau chốt tách riêng) là
// ĐỀ XUẤT KỸ THUẬT CỦA DEV; riêng (b) người bị trừ không quy được ⇒ held, (c) dòng gốc ngoài kỳ thiếu ngữ cảnh ⇒ held, (d) sự kiện
// lỗi ⇒ held cả lượt là quyết định kỹ thuật PM 04/11 (review I4 offline §4) — B1 / D1 / (e) vẫn là Q-206 stakeholder. Test chỉ
// kiểm cách chọn phương án + held; không mở cổng công bố tiền / chốt kỳ (test cuối khoá).

const B = (n: number | string) => BigInt(n)
const STORE = '00000000-0000-4000-8000-0000000000a1'
const UA = '00000000-0000-4000-8000-00000000000a'
const UB = '00000000-0000-4000-8000-00000000000b'
const users: CmsUserRef[] = [
  { id: UA, email: 'ds.a@example.test', role: 'staff', storeId: STORE },
  { id: UB, email: 'ds.b@example.test', role: 'staff', storeId: STORE },
  { id: '00000000-0000-4000-8000-00000000000c', email: 'qlch.x@example.test', role: 'store_manager', storeId: STORE },
]
const sellers = buildSellerIndex(users, [{ id: STORE, storeType: 'os', isActive: true }])
const PROG: CmsEngineProgramInput = {
  startDate: '2026-11-01', endDate: '2026-11-30', catalogTargetGmv: null, storeIds: [STORE],
  products: [
    { productId: '900001', gmvBasis: 'none', targetGmv: null, baseQuantityCms: '30', tiers: [{ from: 1, to: 9, amount: 10000 }, { from: 10, to: null, amount: 12000 }] },
    { productId: '900002', gmvBasis: 'product', targetGmv: 1000000, baseQuantityCms: '1', tiers: [{ from: 1, to: null, amount: 5000 }] },
  ],
}
const OPTS = Object.values(CMS_Q206_OPTIONS)
const O_ORIG_SALE: CmsQ206Option = { attribution: 'original_seller', period: 'sale_date' }
const O_HANDLER_RETURN: CmsQ206Option = { attribution: 'return_handler', period: 'return_date' }
const O_ORIG_RETURN: CmsQ206Option = { attribution: 'original_seller', period: 'return_date' }
const O_HANDLER_SALE: CmsQ206Option = { attribution: 'return_handler', period: 'sale_date' }

const sale = (id: string, o: Partial<CmsRawRow> = {}): CmsSalesLine => {
  const n = normalizeSalesRow({
    order_line_id: id, order_id: `O${id}`, order_code: `SO${id}`, product_id: '900001', seller_email: 'ds.a@example.test', pos_code: 'POS-T1',
    order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: '2026-11-04T03:00:00.000000Z', quantity_raw: '3', uom_raw: 'Hộp',
    base_quantity: '90', gmv_amount: '360000', source_updated_at: '2026-11-04T03:00:00.000000Z', ...o,
  })
  if (!n.ok) throw new Error(JSON.stringify(n.issues))
  return n.value
}
const ev = (id: string, o: Partial<CmsQ206EventRaw> = {}): CmsQ206EventRaw => ({
  return_event_id: id, event_version: '1', event_status: 'ACTIVE', original_order_line_id: '7100001', return_handler_email: 'ds.a@example.test',
  return_recorded_at: '2026-11-09T03:00:00.000000Z', return_base_quantity: '30', return_gmv_amount: '120000', ...o,
})
function run(sales: CmsSalesLine[], events: CmsQ206EventRaw[], opt: CmsQ206Option, lockAt: string | null = null) {
  const a = cmsQ206Adapt(sales, events, opt, lockAt === null ? null : parseUtcMicros(lockAt), sellers)
  const out = computeCmsProgram({ program: PROG, lines: a.lines, sellers })
  const res = (u: string, p = '900001') => out.results.find((r) => r.userId === u && r.productId === p)
  const amt = (u: string, p = '900001') => res(u, p)?.amountVnd ?? B(0)
  return { a, out, res, amt, total: out.totals.amountVnd }
}
const S1 = () => sale('7100001')
const S2 = () => sale('7100002', { product_id: '900002', seller_email: 'ds.b@example.test', completed_at: '2026-11-12T03:00:00.000000Z', quantity_raw: '8', uom_raw: 'Tuýp', base_quantity: '8', gmv_amount: '1200000' })
const S3 = () => sale('7100003', { seller_email: 'ds.b@example.test', completed_at: '2026-11-05T03:00:00.000000Z', quantity_raw: '2', base_quantity: '60', gmv_amount: '240000' })

test.describe('CMS Q-206 · minh hoạ §3.4 và ca T1–T11 (HOLD — không mặc định) @desktop', () => {
  test('§3.4: 70.000 → 10.000 dưới MỌI tổ hợp khi người trả = người bán và trả trong kỳ; trả 5 viên mất cả một hộp; trả làm tụt gate mất cả 40.000', () => {
    const events = [ev('E1'), ev('E2', { return_recorded_at: '2026-11-10T03:00:00.000000Z', return_base_quantity: '5', return_gmv_amount: '20000' }),
      ev('E3', { original_order_line_id: '7100002', return_handler_email: 'ds.b@example.test', return_recorded_at: '2026-11-20T03:00:00.000000Z', return_base_quantity: '2', return_gmv_amount: '300000' })]
    expect(run([S1(), S2()], [], O_ORIG_SALE).total).toBe(B(70000))
    for (const o of OPTS) {
      const r = run([S1(), S2()], events, o)
      expect(r.a.status, JSON.stringify(o)).toBe('ok')
      expect([r.amt(UA), r.amt(UB, '900002'), r.total], JSON.stringify(o)).toEqual([B(10000), B(0), B(10000)])
      expect(r.res(UA)).toMatchObject({ baseQuantityUnits: B(55) * B(1e9), cmsQuantity: B(1) })
      // T4: GMV 900.000 < 1.000.000 ⇒ gate không đạt, mất "Đạt từ"; tiềm năng 6 × 5.000 chỉ để hiển thị.
      expect(r.res(UB, '900002')!.gate).toMatchObject({ met: false, metAtMicros: null })
      expect(r.res(UB, '900002')!.potentialAmountVnd).toBe(B(30000))
      expect(r.out.lines.filter((l) => l.orderLineId.startsWith('R:')).map((l) => l.status)).toEqual(['ADJUSTMENT', 'ADJUSTMENT', 'ADJUSTMENT'])
    }
    const onlyE1 = run([S1(), S2()], [events[0]], O_ORIG_SALE)
    expect(onlyE1.amt(UA)).toBe(B(20000)) // T2: trả 1 hộp nguyên ⇒ Q 3 → 2
    const e2 = run([S1()], [events[1]], O_ORIG_SALE)
    expect(e2.amt(UA)).toBe(B(20000)) // T3: 90 − 5 = 85 ⇒ ⌊85 / 30⌋ = 2 (mất 1 hộp vì cộng dồn rồi ⌊ ⌋)
  })

  test('T1: A bán, B xử lý trả — người bán gốc ⇒ trừ A; người xử lý trả ⇒ trừ B (tổng như nhau, NGƯỜI chịu khác nhau — B1 quyết)', () => {
    const e = [ev('E1', { return_handler_email: 'ds.b@example.test' })]
    const matrix = OPTS.map((o) => { const r = run([S1(), S3()], e, o); return [o.attribution, o.period, r.amt(UA), r.amt(UB), r.total] })
    expect(matrix).toEqual([
      ['original_seller', 'sale_date', B(20000), B(20000), B(40000)],
      ['return_handler', 'return_date', B(30000), B(10000), B(40000)],
      ['original_seller', 'return_date', B(20000), B(20000), B(40000)],
      ['return_handler', 'sale_date', B(30000), B(10000), B(40000)],
    ])
  })

  test('T5 / T6: trả trong kỳ trừ ngay; trả SAU ngày kết thúc, TRƯỚC chốt — kỳ ngày bán ⇒ trừ kỳ gốc; kỳ ngày trả ⇒ ngoài kỳ, không trừ (D2 quyết)', () => {
    expect(run([S1()], [ev('E1')], O_HANDLER_RETURN).amt(UA)).toBe(B(20000))
    const late = [ev('E1', { return_recorded_at: '2026-12-03T03:00:00.000000Z' })]
    expect(OPTS.map((o) => [o.attribution, o.period, run([S1()], late, o, '2026-12-05T00:00:00.000000Z').amt(UA)])).toEqual([
      ['original_seller', 'sale_date', B(20000)],
      ['return_handler', 'return_date', B(30000)],
      ['original_seller', 'return_date', B(30000)],
      ['return_handler', 'sale_date', B(20000)],
    ])
    expect(run([S1()], late, O_ORIG_RETURN).out.excluded.map((x) => [x.orderLineId, x.reason])).toEqual([['R:E1', 'OUT_OF_WINDOW']])
  })

  test('T7: trả ghi nhận SAU mốc chốt ⇒ tách báo cáo riêng, số kỳ không đổi dưới mọi tổ hợp (CMS-Q7)', () => {
    for (const o of OPTS) {
      const r = run([S1()], [ev('E1', { return_recorded_at: '2026-12-10T03:00:00.000000Z' })], o, '2026-12-05T00:00:00.000000Z')
      expect([r.a.status, r.a.afterLock, r.a.lines.length, r.amt(UA)]).toEqual(['ok', ['E1'], 1, B(30000)])
    }
  })

  test('T8: phiên bản sau thay phiên bản trước; huỷ ⇒ không trừ; trùng phiên bản khác nội dung ⇒ held; bản lặp y hệt ⇒ một lần', () => {
    for (const o of OPTS) {
      const v2 = run([S1()], [ev('E1'), ev('E1', { event_version: '2', return_base_quantity: '15', return_gmv_amount: '60000' })], o)
      expect([v2.a.status, v2.a.superseded, v2.amt(UA)]).toEqual(['ok', 1, B(20000)]) // 90 − 15 = 75 ⇒ Q 2
      const out = run([S1()], [ev('E1', { event_version: '2', return_base_quantity: '15' }), ev('E1'), ev('E1', { event_version: '3', event_status: 'CANCELLED' })], o)
      expect([out.a.status, out.a.superseded, out.a.cancelled, out.amt(UA)]).toEqual(['ok', 2, 1, B(30000)])
      expect(run([S1()], [ev('E1'), ev('E1', { return_base_quantity: '15' })], o).a).toMatchObject({ status: 'held', reasons: ['VERSION_CONFLICT'] })
      expect(run([S1()], [ev('E1'), ev('E1')], o).amt(UA)).toBe(B(20000))
    }
  })

  test('T9 (E1): nguồn vừa sửa giảm dòng gốc VỪA sinh sự kiện ⇒ held khi có original_base_quantity; KHÔNG có trường đó thì trừ hai lần mà không phát hiện được', () => {
    const edited = sale('7100001', { base_quantity: '60', gmv_amount: '240000' })
    expect(run([edited], [], O_ORIG_SALE).amt(UA)).toBe(B(20000)) // chỉ một cơ chế (sửa dòng gốc) = đúng
    for (const o of OPTS) {
      expect(run([edited], [ev('E1', { original_base_quantity: '90' })], o).a).toMatchObject({ status: 'held', reasons: ['DOUBLE_MECHANISM'] })
      expect(run([sale('7100001', { order_status: 'RETURNED' })], [ev('E1')], o).a).toMatchObject({ status: 'held', reasons: ['DOUBLE_MECHANISM'] })
    }
    const silent = run([edited], [ev('E1')], O_ORIG_SALE)
    expect([silent.a.status, silent.amt(UA)]).toEqual(['ok', B(10000)]) // 60 − 30 = 30 ⇒ Q 1: SAI (đúng là 20.000) — chỉ contract E1 hoặc original_base_quantity chặn được
    expect(run([S1()], [ev('E1', { original_base_quantity: '90' })], O_ORIG_SALE).a.status).toBe('ok')
  })

  test('T9b (giới hạn — PM 04/11 §5): GMV gốc bị sửa giảm mà LƯỢNG giữ nguyên + sự kiện trả ⇒ original_base_quantity KHÔNG phát hiện; trừ kép GMV làm tụt gate', () => {
    // Đúng (một cơ chế — chỉ sự kiện): 8 − 1 = 7 tuýp, GMV 1.200.000 − 150.000 = 1.050.000 ≥ 1.000.000 ⇒ 7 × 5.000 = 35.000.
    const e = (o: Partial<CmsQ206EventRaw> = {}) => ev('E1', { original_order_line_id: '7100002', return_handler_email: 'ds.b@example.test', return_base_quantity: '1', return_gmv_amount: '150000', ...o })
    expect(run([S2()], [e()], O_ORIG_SALE).amt(UB, '900002')).toBe(B(35000))
    // Nguồn vi phạm E1: sửa GMV dòng gốc xuống 1.050.000 (lượng vẫn 8) VÀ sinh sự kiện ⇒ lượng gốc khai báo 8 khớp ⇒ không held;
    // GMV 1.050.000 − 150.000 = 900.000 < target ⇒ CMS 0 (sai). Chỉ cam kết E1 của BI chặn được — không phải original_base_quantity.
    const gmvEdited = sale('7100002', { product_id: '900002', seller_email: 'ds.b@example.test', completed_at: '2026-11-12T03:00:00.000000Z', quantity_raw: '8', uom_raw: 'Tuýp', base_quantity: '8', gmv_amount: '1050000' })
    const r = run([gmvEdited], [e({ original_base_quantity: '8' })], O_ORIG_SALE)
    expect([r.a.status, r.a.reasons, r.amt(UB, '900002'), r.res(UB, '900002')!.gate.met]).toEqual(['ok', [], B(0), false])
  })

  test('T10: trả nhiều lần tổng = lượng bán ⇒ Q về 0, không âm; trả vượt lượng bán ⇒ held', () => {
    for (const o of OPTS.filter((x) => x.attribution === 'original_seller')) {
      const all = run([S1()], [ev('E1', { return_base_quantity: '60', return_gmv_amount: '240000' }), ev('E2', { return_base_quantity: '30' })], o)
      expect([all.a.status, all.res(UA)!.baseQuantityUnits, all.res(UA)!.cmsQuantity, all.amt(UA)]).toEqual(['ok', B(0), B(0), B(0)])
    }
    for (const o of OPTS) {
      const over = run([S1()], [ev('E1', { return_base_quantity: '60' }), ev('E2', { return_base_quantity: '30.000000001' })], o)
      expect(over.a).toMatchObject({ status: 'held', reasons: ['OVER_RETURN'] })
    }
    // Người xử lý trả không bán gì: lượng âm của B dừng ở Q = 0, tiền 0 (không âm), A giữ nguyên.
    const h = run([S1()], [ev('E1', { return_handler_email: 'ds.b@example.test' })], O_HANDLER_SALE)
    expect([h.amt(UA), h.res(UB)!.cmsQuantity, h.amt(UB)]).toEqual([B(30000), B(0), B(0)])
  })

  test('T11: sự kiện không tìm được dòng bán gốc ⇒ held, không sinh dòng trừ nào (không trừ người khác)', () => {
    for (const o of OPTS) {
      const r = run([S1(), S3()], [ev('E9', { original_order_line_id: '7199999', return_handler_email: 'ds.b@example.test' })], o)
      expect([r.a.status, r.a.reasons, r.a.unmatched, r.a.lines.length, r.amt(UA), r.amt(UB)]).toEqual(['held', ['UNMATCHED_RETURN'], ['E9'], 2, B(30000), B(20000)])
    }
  })

  test('T11b — PM 04/11 (b) held: dòng bán đã tính cho A nhưng người bị trừ theo phương án không quy được (QLCH / không email) ⇒ held, không để tiền trả rơi vào "Chưa gán"; (e) vẫn là Q-206.B1', () => {
    for (const handler of ['qlch.x@example.test', null]) {
      for (const o of OPTS) {
        const r = run([S1()], [ev('E1', { return_handler_email: handler })], o)
        if (o.attribution === 'return_handler') expect(r.a, `${handler} ${JSON.stringify(o)}`).toMatchObject({ status: 'held', reasons: ['TARGET_UNASSIGNED'] })
        else expect([r.a.status, r.amt(UA)], `${handler} ${JSON.stringify(o)}`).toEqual(['ok', B(20000)])
      }
    }
    // Dòng bán gốc do QLCH (vốn "Chưa gán", không ai được tính): người bán gốc ⇒ trừ cũng "Chưa gán", nhất quán; người xử lý trả là
    // A ⇒ A bị trừ cho một dòng bán A chưa từng được tính (A 30.000 → 20.000). Hệ quả này cần stakeholder thấy khi chọn B1.
    const qSale = sale('7100005', { seller_email: 'qlch.x@example.test', base_quantity: '30', gmv_amount: '120000' })
    const e = [ev('E5', { original_order_line_id: '7100005', return_handler_email: 'ds.a@example.test' })]
    expect([run([S1(), qSale], e, O_ORIG_SALE).a.status, run([S1(), qSale], e, O_ORIG_SALE).amt(UA)]).toEqual(['ok', B(30000)])
    expect([run([S1(), qSale], e, O_HANDLER_SALE).a.status, run([S1(), qSale], e, O_HANDLER_SALE).amt(UA)]).toEqual(['ok', B(20000)])
  })

  test('T11c — PM 04/11 (c): trả của dòng bán KỲ TRƯỚC, nguồn chưa mang ngữ cảnh gốc ⇒ held UNMATCHED_RETURN dưới mọi tổ hợp', () => {
    // SQL app chỉ đọc cửa sổ kỳ + ProductID chương trình: dòng bán 25/10 không có trong snapshot kỳ 11. PM chọn hướng BI cung cấp đủ
    // ngữ cảnh gốc (người / ngày bán / SP / lượng / GMV gốc) qua nguồn logic trả, tránh app truy vấn từng dòng ngoài kỳ; BI xác nhận
    // khả thi (A1). Contract chưa có ⇒ nguyên mẫu không đọc được ⇒ held, không suy.
    for (const o of OPTS) {
      const r = run([S1()], [ev('E7', { original_order_line_id: '7100007' })], o)
      expect([r.a.status, r.a.reasons, r.amt(UA)]).toEqual(['held', ['UNMATCHED_RETURN'], B(30000)])
    }
  })

  test('chỉ sửa snapshot (không sự kiện): giảm dòng gốc = trừ người bán gốc ở kỳ gốc; đổi trạng thái khỏi COMPLETED = trả toàn bộ (E4)', () => {
    expect(run([sale('7100001', { base_quantity: '60', gmv_amount: '240000' })], [], O_ORIG_SALE).amt(UA)).toBe(B(20000))
    const gone = run([sale('7100001', { order_status: 'RETURNED' }), S3()], [], O_ORIG_SALE)
    expect([gone.res(UA), gone.out.excluded.map((x) => x.reason), gone.amt(UB)]).toEqual([undefined, ['ORDER_NOT_ELIGIBLE'], B(20000)])
  })

  test('sự kiện sai dạng / người bán khai báo khác dòng gốc ⇒ held (fail-closed, không đoán)', () => {
    for (const bad of [{ return_recorded_at: '2026-11-09' }, { return_base_quantity: '0' }, { return_base_quantity: '-5' }, { event_version: 'v1' }, { event_status: 'PENDING' }, { return_gmv_amount: '1e5' }]) {
      expect(run([S1()], [ev('E1', bad)], O_ORIG_SALE).a, JSON.stringify(bad)).toMatchObject({ status: 'held', reasons: ['BAD_EVENT'] })
    }
    expect(run([S1()], [ev('E1', { original_seller_email: ' DS.A@example.test ' })], O_ORIG_SALE).a.status).toBe('ok')
    expect(run([S1()], [ev('E1', { original_seller_email: 'ds.b@example.test' })], O_ORIG_SALE).a).toMatchObject({ status: 'held', reasons: ['SELLER_CONFLICT'] })
  })

  test('(d) PM 04/11: MỘT sự kiện lỗi giữa các sự kiện đúng ⇒ held CẢ lượt (không cô lập bỏ sự kiện lỗi rồi công bố phần còn lại)', () => {
    for (const o of OPTS) {
      const a = run([S1(), S3()], [ev('E1'), ev('E2', { original_order_line_id: '7100003', return_handler_email: 'ds.b@example.test', return_base_quantity: 'x' })], o).a
      expect([a.status, a.reasons], JSON.stringify(o)).toEqual(['held', ['BAD_EVENT']])
    }
  })

  test('nguyên mẫu không mở cổng: hợp đồng trả hàng vẫn HOLD, chương trình thật không công bố được sau khi chạy mọi phương án; file nguyên mẫu không chạm releaseGate', () => {
    for (const o of OPTS) run([S1()], [ev('E1')], o)
    expect(CMS_Q206_RETURNS_CONTRACT).toBe('HOLD')
    expect(cmsCanPublishResults(false)).toBe(false)
    expect(Object.keys(CMS_Q206_OPTIONS)).toHaveLength(4) // không có phương án "mặc định"
    expect(fs.readFileSync(path.join(__dirname, 'cmsQ206Cases.ts'), 'utf8')).not.toMatch(/releaseGate|CMS_Q206_RETURNS_CONTRACT|cmsCanPublishResults/)
  })
})
