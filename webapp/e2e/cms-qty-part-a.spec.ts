import { test, expect } from '@playwright/test'
import * as XLSX from 'xlsx'
import { parseCmsEngineProgram, CmsEngineConfigError } from '../lib/cms/engine/config'
import { computeCmsProgram, type CmsEngineOutput } from '../lib/cms/engine/compute'
import { normalizeSalesRow, type CmsRawRow, type CmsSalesLine } from '../lib/cms/source/contract'
import { assessSalesSnapshot } from '../lib/cms/quality'
import { CMS_Q206_RETURNS_CONTRACT, cmsAdjustmentBlocksRelease } from '../lib/cms/releaseGate'
import { buildCmsStagePayload, cmsSnapshotToEngineInput, parseCmsSalesSnapshot } from '../lib/cms/resultStage'
import { parseCmsResultLines, parseCmsResultRows, type CmsResultLineDto, type CmsResultRowDto } from '../lib/cms/resultView'
import { cmsFractionText, cmsQtyText } from '../lib/cms/resultUi'
import { cmsQtyExplainRow } from '../lib/cms/productPresentation'
import { cmsFlatEquation, cmsFlatEquationText } from '../lib/cms/flat'
import { buildCmsResultWorkbook } from '../lib/cms/exportResults'
import { cmsFxAdminResults } from '../lib/cms/fixturesResults'

// CMS-QTY-RET-1 phần A (PM 12/11 — planning/research/cms-quantity-returns-implementation-plan-2026-11-12.md §3, §10 A01–A04; Q-227).
// Luật: tính riêng dược sĩ × ProductID × chương trình; B = Σ base_quantity của dòng hợp lệ (base đã là lượng CẢ dòng — không nhân lại
// quantity_raw); Q = floor(B / K) SAU khi cộng; R = B − Q·K cộng tiếp trong kỳ; uom_raw / quantity_raw chỉ để đối soát (không lọc,
// không bắt nguyên). Spec đi xuyên tầng app: chuỗi nguồn thô → normalizeSalesRow → computeCmsProgram → buildCmsStagePayload (đúng các
// hàng app gửi DB stage) → DTO đọc (parseCmsResultRows / parseCmsResultLines) → helper UI (giải thích lượng, phần lẻ, phép nhân mức
// cố định) → XLSX. Oracle = bảng ví dụ PM (số viết tay) + phép cộng thập phân riêng của spec (không dùng lib/cms/decimal.ts).
// DB seal 122 kiểm lại B = Σ dòng (S8 SEAL_RESULT_SUMS) và Q·K ≤ B < (Q+1)·K (S9 SEAL_TIER_AMOUNT) — chứng minh ở cms-122-pglite.
// Dữ liệu giả hoàn toàn (email @example.test, UUID cố định). Không DB, không mạng, không server.

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROGRAM = UUID(1)
const S1 = UUID(8001)
const S2 = UUID(8002)
const USER_A = UUID(101)
const USER_B = UUID(102)
const EMAIL: Record<string, string> = { [USER_A]: 'ds.a@example.test', [USER_B]: 'ds.b@example.test' }

/** Sản phẩm chương trình: id = program_product_id, pid = ProductID, unit = unit_CMS (nhãn), k = base_quantity_CMS. */
interface Prod { id: string; pid: string; unit: string; k: string; tiers?: { from: number; to: number | null; amount: string }[]; target?: string | null }
const FLAT = (amount: string) => [{ from: 1, to: null, amount }]
/** Hộp 100 viên — mức minh hoạ 25.000₫/hộp (ví dụ PM §3 A3; không phải mức T11). */
const BOX = (o: Partial<Prod> = {}): Prod => ({ id: UUID(201), pid: '900101', unit: 'hộp', k: '100', tiers: FLAT('25000'), ...o })
const BOX2 = (o: Partial<Prod> = {}): Prod => ({ id: UUID(202), pid: '900102', unit: 'hộp', k: '100', tiers: FLAT('25000'), ...o })
/** unit_CMS = viên, K = 1. */
const PILL = (o: Partial<Prod> = {}): Prod => ({ id: UUID(203), pid: '900103', unit: 'viên', k: '1', tiers: FLAT('1000'), ...o })

interface Sale { user?: string; pid?: string; qty?: string | null; uom?: string | null; base: string; gmv?: string; at?: string }
let seqId = 5000

function rawRow(s: Sale): CmsRawRow {
  const id = String(seqId++)
  return {
    order_line_id: id, order_id: `o-${id}`, order_code: `DH${id}`, product_id: s.pid ?? '900101',
    seller_email: EMAIL[s.user ?? USER_A], pos_code: 'POS01', order_type: 'OFFLINE', order_status: 'COMPLETED',
    completed_at: s.at ?? `2026-11-10T03:00:00.${String(seqId).padStart(6, '0')}Z`,
    quantity_raw: s.qty === undefined ? s.base : s.qty, uom_raw: s.uom === undefined ? 'Viên' : s.uom,
    base_quantity: s.base, gmv_amount: s.gmv ?? '1000', source_updated_at: '2026-11-10T03:00:00.000000Z',
  }
}

function snapshot(products: Prod[], o: { start?: string; end?: string } = {}) {
  return parseCmsSalesSnapshot({
    program_id: PROGRAM, status: 'active', is_test: true, config_version: 1,
    start_date: o.start ?? '2026-11-01', end_date: o.end ?? '2026-11-30', catalog_target_gmv: null, today_vn: '2026-11-12',
    current_result_run_id: null, previous_rows_read: null, store_ids: [S1, S2],
    products: products.map((p) => ({
      id: p.id, product_id: p.pid, gmv_basis: p.target ? 'product' : 'none', target_gmv: p.target ?? null, base_quantity_cms: p.k,
      tiers: (p.tiers ?? FLAT('25000')).map((t, i) => ({ order: i + 1, from: t.from, to: t.to, amount: t.amount })),
    })),
    sellers: [
      { id: USER_A, email: EMAIL[USER_A], role: 'staff', store_id: S1 },
      { id: USER_B, email: EMAIL[USER_B], role: 'staff', store_id: S2 },
    ],
    stores: [{ id: S1, store_type: 'os', is_active: true }, { id: S2, store_type: 'os', is_active: true }],
    mapping_fp: '0123456789abcdef0123456789abcdef', run_id: null, source_schema: null,
  })
}

interface Piped {
  out: CmsEngineOutput
  lines: CmsSalesLine[]
  rows: CmsResultRowDto[]
  lineDtos: CmsResultLineDto[]
  runId: string
  /** Hàng kết quả của (người, ProductID). */
  row: (user: string, pid: string) => CmsResultRowDto | undefined
}

/** Nguồn thô → chuẩn hoá → engine → payload stage → DTO đọc (như RPC trả về các cột đã stage). */
function pipeline(products: Prod[], sales: Sale[], o: { start?: string; end?: string } = {}): Piped {
  const lines = sales.map((s) => {
    const n = normalizeSalesRow(rawRow(s))
    if (!n.ok) throw new Error(`fixture: ${JSON.stringify(n.issues)}`)
    return n.value
  })
  const snap = snapshot(products, o)
  const { program, sellers } = cmsSnapshotToEngineInput(snap)
  const out = computeCmsProgram({ program, lines, sellers })
  const payload = buildCmsStagePayload(snap, lines, out, { rowsRead: lines.length, rowsRejected: 0, bytesProcessed: null })
  const fx = cmsFxAdminResults('running')
  if (fx.kind !== 'loaded' || !fx.header.run) throw new Error('fixture header')
  const runId = fx.header.run.id // XLSX đòi rows.runId = header.run.id (RUN_MISMATCH) — header lấy từ fixture một nguồn
  const dto = parseCmsResultRows({
    run_id: runId,
    results: payload.parts.results.map((r) => ({ ...r, line_count: Number(r.line_count) })),
    catalog: [],
    users: [{ id: USER_A, full_name: 'Dược sĩ A', store_id: S1 }, { id: USER_B, full_name: 'Dược sĩ B', store_id: S2 }],
  })
  const sales2 = new Map(payload.parts.sales_lines.map((s) => [s.order_line_id as string, s]))
  const lineDtos = parseCmsResultLines({
    run_id: runId, next_after_seq: null,
    rows: payload.parts.result_lines.map((l) => {
      const s = sales2.get(l.order_line_id as string)!
      return {
        ...l, seq: Number(l.seq), order_code: s.order_code, product_id: s.product_id, store_id: s.store_id, pos_code: s.pos_code,
        completed_at: s.completed_at, quantity_raw: s.quantity_raw, uom_raw: s.uom_raw, base_quantity: s.base_quantity, gmv_amount: s.gmv_amount,
      }
    }),
  }).rows
  const pidOf = new Map(products.map((p) => [p.id, p.pid]))
  return {
    out, lines, rows: dto.results, lineDtos, runId,
    row: (user, pid) => dto.results.find((r) => r.userId === user && pidOf.get(r.programProductId) === pid),
  }
}

// ── Oracle độc lập: cộng thập phân bằng chuỗi → BigInt scale 9 (KHÔNG dùng lib/cms/decimal.ts) ────────────────────────────
const SCALE = BigInt('1000000000')
function oracleUnits(s: string): bigint {
  const m = /^([0-9]+)(?:\.([0-9]{1,9}))?$/.exec(s)
  if (!m) throw new Error(`oracle: ${s}`)
  return BigInt(m[1]) * SCALE + BigInt((m[2] ?? '').padEnd(9, '0'))
}
/** Q và R (đơn vị cơ sở, scale 9) theo định nghĩa Q-227 trên một nhóm. */
function oracleQR(bases: string[], k: string): { q: bigint; r: bigint } {
  const b = bases.reduce((a, x) => a + oracleUnits(x), BigInt(0))
  const kk = oracleUnits(k)
  const q = b / kk
  return { q, r: b - q * kk }
}

/** Kiểm một nhóm (người × SP) ở MỌI tầng: engine, DTO, UI, XLSX dòng; trả về hàng DTO. */
function expectGroup(p: Piped, user: string, prod: Prod, want: { q: number; amount: number; restBase: string; bases: string[] }) {
  const r = p.row(user, prod.pid)
  expect(r, `${prod.pid}/${user} có hàng kết quả`).toBeDefined()
  const o = oracleQR(want.bases, prod.k)
  expect(o.q, 'oracle Q khớp bảng PM').toBe(BigInt(want.q))
  expect(o.r, 'oracle R khớp bảng PM').toBe(oracleUnits(want.restBase))
  // DTO (= hàng app stage xuống DB): B / K / Q / tiền.
  expect(oracleUnits(r!.baseQuantity), 'B = Σ base_quantity').toBe(want.bases.reduce((a, x) => a + oracleUnits(x), BigInt(0)))
  expect(r!.perUnit).toBe(prod.k)
  expect(r!.cmsQuantity).toBe(String(want.q))
  expect(r!.rewardedQuantity).toBe(String(want.q))
  expect(r!.amountVnd).toBe(String(want.amount))
  // UI: phần giải thích lượng.
  const e = cmsQtyExplainRow(r!)
  expect(e, 'UI giải thích được lượng').not.toBeNull()
  expect(e!.fractionBase).toBe(o.r)
  expect(e!.rewarded).toBe(BigInt(want.q))
  const frac = cmsFractionText(r!)
  if (o.r === BigInt(0)) expect(frac).toBeNull()
  else expect(frac).toBe(`${want.restBase.replace('.', ',')} / ${prod.k.replace('.', ',')} đơn vị cơ sở`)
  // Dòng: tiền dòng cộng đúng tiền nhóm, lũy kế cơ sở cuối = B.
  const ls = p.lineDtos.filter((l) => l.userId === user && l.productId === prod.pid)
  expect(ls.length).toBe(want.bases.length)
  expect(ls.reduce((a, l) => a + BigInt(l.amountVnd), BigInt(0))).toBe(BigInt(want.amount))
  // Lượng cơ sở từng dòng đi nguyên từ nguồn (bases trong spec viết dạng chuẩn, không số 0 thừa).
  expect(ls.map((l) => l.baseQuantity).sort()).toEqual([...want.bases].sort())
  expect(ls.at(-1)!.baseAfter).toBe(r!.baseQuantity)
  return r!
}

test.describe('CMS-QTY-RET-1 A01 — bảng ví dụ PM (K = 100 viên/hộp, 25.000₫/hộp) @desktop', () => {
  const CASES: { name: string; bases: string[]; q: number; amount: number; rest: string }[] = [
    { name: '5 viên', bases: ['5'], q: 0, amount: 0, rest: '5' },
    { name: '5 + 95 viên ở hai đơn', bases: ['5', '95'], q: 1, amount: 25000, rest: '0' },
    { name: '99 viên', bases: ['99'], q: 0, amount: 0, rest: '99' },
    { name: '199 viên', bases: ['199'], q: 1, amount: 25000, rest: '99' },
    { name: '200 viên', bases: ['200'], q: 2, amount: 50000, rest: '0' },
    { name: '7 đơn lẻ 30 + 30 + 30 + 9 + 1 + 50 + 49 viên', bases: ['30', '30', '30', '9', '1', '50', '49'], q: 1, amount: 25000, rest: '99' },
  ]
  for (const c of CASES) {
    test(`${c.name} ⇒ Q ${c.q}, ${c.amount}₫, dư ${c.rest} đơn vị cơ sở`, () => {
      const p = pipeline([BOX()], c.bases.map((b) => ({ base: b })))
      expectGroup(p, USER_A, BOX(), { q: c.q, amount: c.amount, restBase: c.rest, bases: c.bases })
      expect(p.out.totals.amountVnd).toBe(BigInt(c.amount))
    })
  }

  test('0,5 hộp + 0,5 hộp (base 50 + 50) ⇒ 1 hộp, 25.000₫ — quantity_raw lẻ không phải lý do loại / HOLD', () => {
    const sales = [{ qty: '0.5', uom: 'Hộp', base: '50' }, { qty: '0.5', uom: 'Hộp', base: '50' }]
    const p = pipeline([BOX()], sales)
    expectGroup(p, USER_A, BOX(), { q: 1, amount: 25000, restBase: '0', bases: ['50', '50'] })
    expect(p.out.excluded).toEqual([])
    // Lượng / đơn vị gốc giữ nguyên để đối soát (XLSX "SL gốc" / "ĐVT gốc").
    expect(p.lineDtos.map((l) => [l.quantityRaw, l.uomRaw])).toEqual([['0.5', 'Hộp'], ['0.5', 'Hộp']])
  })

  test('hai người mỗi người 50 viên ⇒ mỗi người Q 0, tổng 0₫ (không gộp giữa dược sĩ)', () => {
    const p = pipeline([BOX()], [{ user: USER_A, base: '50' }, { user: USER_B, base: '50' }])
    expectGroup(p, USER_A, BOX(), { q: 0, amount: 0, restBase: '50', bases: ['50'] })
    expectGroup(p, USER_B, BOX(), { q: 0, amount: 0, restBase: '50', bases: ['50'] })
    expect(p.out.totals.amountVnd).toBe(BigInt(0))
  })

  test('một người, hai sản phẩm mỗi SP 50 viên ⇒ mỗi SP Q 0 (không gộp giữa ProductID)', () => {
    const p = pipeline([BOX(), BOX2()], [{ pid: '900101', base: '50' }, { pid: '900102', base: '50' }])
    expectGroup(p, USER_A, BOX(), { q: 0, amount: 0, restBase: '50', bases: ['50'] })
    expectGroup(p, USER_A, BOX2(), { q: 0, amount: 0, restBase: '50', bases: ['50'] })
    expect(p.out.totals.amountVnd).toBe(BigInt(0))
  })

  test('kỳ: 50 viên ngày 31/10 VN + 50 viên trong kỳ 11 ⇒ chương trình T11 chỉ có 50 (dư không chuyển kỳ, không cộng kỳ trước)', () => {
    const before = { base: '50', at: '2026-10-31T16:59:59.999999Z' } // 31/10 23:59:59 VN
    const inside = { base: '50', at: '2026-10-31T17:00:00.000000Z' } // 01/11 00:00 VN
    const after = { base: '50', at: '2026-11-30T17:00:00.000000Z' } // 01/12 00:00 VN
    const p = pipeline([BOX()], [before, inside, after])
    expectGroup(p, USER_A, BOX(), { q: 0, amount: 0, restBase: '50', bases: ['50'] })
    expect(p.out.excluded.map((x) => x.reason)).toEqual(['OUT_OF_WINDOW', 'OUT_OF_WINDOW'])
    // Chương trình kỳ 10 chạy riêng: cùng người / SP, dòng kỳ 10 không gặp dòng kỳ 11.
    const oct = pipeline([BOX()], [{ ...before }, { ...inside }], { start: '2026-10-01', end: '2026-10-31' })
    expectGroup(oct, USER_A, BOX(), { q: 0, amount: 0, restBase: '50', bases: ['50'] })
  })

  test('unit_CMS = viên, K = 1: 5 viên = 5 đơn vị thưởng; K khác 1 cùng kỳ không ảnh hưởng nhau', () => {
    const p = pipeline([BOX(), PILL()], [{ pid: '900103', base: '5' }, { pid: '900101', base: '5' }])
    expectGroup(p, USER_A, PILL(), { q: 5, amount: 5000, restBase: '0', bases: ['5'] })
    expectGroup(p, USER_A, BOX(), { q: 0, amount: 0, restBase: '5', bases: ['5'] })
  })
})

test.describe('CMS-QTY-RET-1 A02 — lượng lẻ / khác đơn vị bán, không nhân base lần hai @desktop', () => {
  test('bán theo viên, vỉ, hộp lẫn nhau: chỉ cộng base_quantity đã quy đổi; tên đơn vị bán khác unit_CMS vẫn được tính', () => {
    const sales = [
      { qty: '30', uom: 'Viên', base: '30' },
      { qty: '7', uom: 'Vỉ', base: '70' }, // 1 vỉ = 10 viên
      { qty: '1', uom: 'Hộp', base: '100' },
      { qty: '0.25', uom: 'Hộp', base: '25' },
    ]
    const p = pipeline([BOX()], sales)
    expectGroup(p, USER_A, BOX(), { q: 2, amount: 50000, restBase: '25', bases: ['30', '70', '100', '25'] })
    expect(new Set(p.lineDtos.map((l) => l.uomRaw))).toEqual(new Set(['Viên', 'Vỉ', 'Hộp']))
  })

  test('base_quantity là lượng CẢ dòng: 2 hộp (base 200) ⇒ Q 2, không phải 4 (không nhân quantity_raw)', () => {
    const p = pipeline([BOX()], [{ qty: '2', uom: 'Hộp', base: '200' }, { qty: '3', uom: 'Vỉ', base: '30' }])
    expectGroup(p, USER_A, BOX(), { q: 2, amount: 50000, restBase: '30', bases: ['200', '30'] })
    expect(p.lines.map((l) => l.baseQuantityUnits)).toEqual([oracleUnits('200'), oracleUnits('30')])
  })

  test('quantity_raw / uom_raw trống vẫn tính theo base hợp lệ (hai trường chỉ để đối soát, không bắt buộc)', () => {
    const p = pipeline([BOX()], [{ qty: null, uom: null, base: '60' }, { qty: null, uom: 'Hộp', base: '40' }])
    expectGroup(p, USER_A, BOX(), { q: 1, amount: 25000, restBase: '0', bases: ['60', '40'] })
  })

  test('lượng cơ sở thập phân hợp lệ (9 chữ số) cộng dồn chính xác: 33,333333333 × 3 + 0,000000001 = 100 ⇒ Q 1', () => {
    const bases = ['33.333333333', '33.333333333', '33.333333333', '0.000000001']
    const p = pipeline([BOX()], bases.map((b) => ({ qty: '1', uom: 'Gói', base: b })))
    expectGroup(p, USER_A, BOX(), { q: 1, amount: 25000, restBase: '0', bases })
  })
})

test.describe('CMS-QTY-RET-1 A03 — K thiếu / sai, precision, sát ngưỡng, không float @desktop', () => {
  test('K trống / 0 / âm / quá 9 chữ số lẻ / chữ ⇒ BAD_BASE_QUANTITY (không mặc định K = 1, không cắt)', () => {
    for (const k of ['', '0', '0.000000000', '-100', '100.0000000001', '1e2', 'một trăm']) {
      let code: string | null = null
      try {
        parseCmsEngineProgram({ startDate: '2026-11-01', endDate: '2026-11-30', catalogTargetGmv: null, storeIds: [S1],
          products: [{ productId: '900101', gmvBasis: 'none', targetGmv: null, baseQuantityCms: k, tiers: FLAT('25000') }] })
      } catch (e) { code = e instanceof CmsEngineConfigError ? e.code : `other:${String(e)}` }
      expect(code, `K = "${k}"`).toBe('BAD_BASE_QUANTITY')
    }
  })

  test('base_quantity quá 9 chữ số lẻ / dạng số mũ ⇒ dòng lỗi nguồn (BAD_NUMBER), không làm tròn thành lượng hợp lệ', () => {
    for (const [base, err] of [['99.9999999999', 'SCALE'], ['1e2', 'FORMAT'], ['1,5', 'FORMAT']] as const) {
      const n = normalizeSalesRow(rawRow({ base }))
      expect(n.ok, base).toBe(false)
      if (!n.ok) {
        expect(n.issues).toContainEqual({ kind: 'BAD_NUMBER', field: 'base_quantity', error: err })
        // Một dòng lỗi quy đổi ⇒ cả lượt held (giữ snapshot công bố trước), không bỏ dòng rồi công bố số thấp hơn.
        const v = assessSalesSnapshot({ rowsRead: 2, totalRowsReported: 2, pagesComplete: true, rowIssues: [n.issues], lineIds: ['1', '2'],
          candidates: 1, unassigned: 0, previousPublishedRows: 2 })
        expect([v.status, v.reasons]).toEqual(['held', ['UNCONVERTED_UNITS']])
      }
    }
  })

  test('99,999999999 viên / K 100 ⇒ Q 0 (không làm tròn lên); hiển thị "0,99" không phải "1"', () => {
    const p = pipeline([BOX()], [{ base: '99.999999999' }])
    const r = expectGroup(p, USER_A, BOX(), { q: 0, amount: 0, restBase: '99.999999999', bases: ['99.999999999'] })
    expect(cmsQtyText(oracleUnits(r.baseQuantity), oracleUnits(r.perUnit))).toBe('0,99')
  })

  test('cộng 0,7 + 0,1 với K 0,8 ⇒ Q 1 (float cho 0,7999… ⇒ 0)', () => {
    const p = pipeline([BOX({ k: '0.8' })], [{ base: '0.7' }, { base: '0.1' }])
    expectGroup(p, USER_A, BOX({ k: '0.8' }), { q: 1, amount: 25000, restBase: '0', bases: ['0.7', '0.1'] })
  })

  test('dòng âm (chưa có hợp đồng trả — Q-227 §2) không dùng bảng cộng dồn để tự bù trừ: engine đánh dấu ADJUSTMENT, chương trình thật bị chặn công bố', () => {
    const p = pipeline([BOX()], [{ base: '200' }, { base: '-5', qty: '-5', gmv: '-1000' }])
    expect(p.out.totals.adjustmentLines).toBe(1)
    expect(p.lineDtos.filter((l) => l.status === 'ADJUSTMENT').map((l) => l.baseQuantity)).toEqual(['-5'])
    // Cổng sales-only (SO-2): chương trình thật + hợp đồng trả HOLD ⇒ held RETURNS_NOT_SUPPORTED_THIS_PHASE (luồng đầy đủ: cms-sales-sync AC05).
    expect(CMS_Q206_RETURNS_CONTRACT).toBe('HOLD')
    expect(cmsAdjustmentBlocksRelease(false)).toBe(true)
  })

  test('B = 99.999.999,999999999 với K 1 ⇒ Q 99.999.999 (float đẩy thành 100.000.000)', () => {
    const p = pipeline([PILL()], [{ pid: '900103', base: '99999999.999999999' }])
    const r = p.row(USER_A, '900103')!
    expect(r.cmsQuantity).toBe('99999999')
    expect(r.amountVnd).toBe('99999999000')
    expect(cmsQtyExplainRow(r)!.fractionBase).toBe(oracleUnits('0.999999999'))
  })
})

test.describe('CMS-QTY-RET-1 A04 — một mức / nhiều bậc / target; UI và XLSX cùng số @desktop', () => {
  test('một mức: CMS = Q × mức; UI hiện "Q hộp × mức = tiền" đúng snapshot', () => {
    const p = pipeline([BOX()], [{ base: '150' }, { base: '50' }, { base: '99' }])
    const r = expectGroup(p, USER_A, BOX(), { q: 2, amount: 50000, restBase: '99', bases: ['150', '50', '99'] })
    const eq = cmsFlatEquation({ gmvBasis: 'none', targetGmv: null, tiers: [{ order: 1, from: 1, to: null, amount: '25000' }] }, r)
    expect(eq).toEqual({ quantity: BigInt(2), rate: BigInt(25000), amountVnd: BigInt(50000) })
    expect(cmsFlatEquationText(eq!, 'hộp')).toMatch(/^2 hộp × 25\.000\s?₫ = 50\.000\s?₫$/)
  })

  test('nhiều bậc (thang test 1–9 @15k, 10–19 @20k, từ 20 @25k): F lũy tiến trên Q sau cộng dồn — Q 20 = 360.000₫, Q 19 = 335.000₫', () => {
    const TIERS = [{ from: 1, to: 9, amount: '15000' }, { from: 10, to: 19, amount: '20000' }, { from: 20, to: null, amount: '25000' }]
    const p20 = pipeline([BOX({ tiers: TIERS })], [{ base: '1999' }, { base: '1' }])
    expectGroup(p20, USER_A, BOX({ tiers: TIERS }), { q: 20, amount: 360000, restBase: '0', bases: ['1999', '1'] })
    const p19 = pipeline([BOX({ tiers: TIERS })], [{ base: '1999' }])
    expectGroup(p19, USER_A, BOX({ tiers: TIERS }), { q: 19, amount: 335000, restBase: '99', bases: ['1999'] })
  })

  test('target theo SP: GMV thiếu 1₫ ⇒ tiền 0 nhưng Q / phần dư giữ; GMV bằng target ⇒ đạt', () => {
    const unmet = pipeline([BOX({ target: '1000000' })], [{ base: '150', gmv: '600000' }, { base: '50', gmv: '399999' }])
    const r = unmet.row(USER_A, '900101')!
    expect([r.cmsQuantity, r.potentialAmount, r.amountVnd, r.gateMet]).toEqual(['2', '50000', '0', false])
    const met = pipeline([BOX({ target: '1000000' })], [{ base: '150', gmv: '600000' }, { base: '50', gmv: '400000' }])
    expectGroup(met, USER_A, BOX({ target: '1000000' }), { q: 2, amount: 50000, restBase: '0', bases: ['150', '50'] })
  })

  test('XLSX cùng run: "SL bán (đv CMS)" = B / K, "SL tính CMS" = Q, tiền = UI; "Chi tiet dong" giữ SL gốc / ĐVT gốc / SL cơ sở chưa nhân', () => {
    const sales = [{ qty: '1', uom: 'Hộp', base: '100' }, { qty: '9', uom: 'Vỉ', base: '90' }, { qty: '9', uom: 'Viên', base: '9' }, { user: USER_B, base: '50' }]
    const p = pipeline([BOX()], sales)
    const fx = cmsFxAdminResults('running')
    if (fx.kind !== 'loaded') throw new Error(fx.kind)
    const b = buildCmsResultWorkbook({
      program: { id: PROGRAM, name: 'QA phần A', startDate: '2026-11-01', endDate: '2026-11-30', configVersion: 1 },
      header: fx.header, rows: { runId: p.runId, results: p.rows, catalog: [], users: [{ id: USER_A, fullName: 'Dược sĩ A', storeId: S1 }, { id: USER_B, fullName: 'Dược sĩ B', storeId: S2 }] },
      lines: p.lineDtos, excluded: [], products: [{ id: BOX().id, productId: '900101', nameSnapshot: 'SP QA', unitCms: 'hộp', baseQuantityCms: '100', gmvBasis: 'none' }],
      storeNames: new Map([[S1, 'NT 1'], [S2, 'NT 2']]), exportedAt: new Date('2026-11-12T03:00:00Z'), scope: 'super', returnsApproved: false,
    })
    if (!b.ok) throw new Error(b.error)
    const wb = XLSX.read(b.bytes, { type: 'array' })
    const staff = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Theo duoc si'])
    const a = staff.find((x) => x.user_id === USER_A)!
    const bb = staff.find((x) => x.user_id === USER_B)!
    expect([a['SL bán (đv CMS)'], a['SL tính CMS'], a['CMS tạm tính (VND)']]).toEqual(['1,99', 1, 25000])
    expect([bb['SL bán (đv CMS)'], bb['SL tính CMS'], bb['CMS tạm tính (VND)']]).toEqual(['0,5', 0, 0])
    const prod = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Theo san pham']).find((x) => x.ProductID === '900101')!
    // Tổng SP = Σ Q cá nhân (1 + 0), KHÔNG floor lại trên tổng vùng (2,49 hộp ⇒ không thành 2).
    expect([prod['SL bán (đv CMS)'], prod['SL tính CMS'], prod['CMS tạm tính (VND)']]).toEqual(['2,49', 1, 25000])
    const det = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Chi tiet dong'])
    expect(det.map((x) => [x['SL gốc'], x['ĐVT gốc'], String(x['SL cơ sở'])])).toEqual([['1', 'Hộp', '100'], ['9', 'Vỉ', '90'], ['9', 'Viên', '9'], ['50', 'Viên', '50']])
    expect(b.amountVnd).toBe(BigInt(25000))
  })
})
