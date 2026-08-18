import { test, expect } from '@playwright/test'
import { parseCampaignRows } from '../lib/kpi/campaignImport'
import { campaignImportGuide } from '../lib/kpi/campaignImportGuide'

// Mig 103 — unit gate ĐẦU TIÊN cho parser import campaign (trước nay chưa có
// test). Hai mục tiêu: (1) KHÓA REGRESSION file GMV — cùng input phải ra cùng
// output y hệt trước 103 (kể cả rule ranh giới tiền); (2) contract customer:
// kpi_target integer bắt buộc + BỎ GROUP_BOUNDARIES + store_kpi_group vẫn
// bắt buộc (nhãn thuần — chốt stakeholder 06/08).

const BY_CODE = new Map([
  ['POS0001', 'store-a'],
  ['POS0002', 'store-b'],
  ['POS0018', 'store-signature'],   // mig 106: fixture Finance SIGNATURE
])
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pos_code: 'POS0001', kpi_target: 450_000_000, store_kpi_group: 'Nhỏ hơn 500 triệu',
  tier_1_threshold_pct: 90, tier_1_commission_amount: 1_000_000,
  tier_2_threshold_pct: 100, tier_2_commission_amount: 2_000_000,
  note: null,
  ...over,
})
const CUSTOMER = { metricType: 'affiliate_customer_count' }

test.describe('kpi campaign import parser @desktop', () => {
  test('GMV REGRESSION: file hợp lệ → output y hệt (không truyền opts = hành vi cũ)', () => {
    const r = parseCampaignRows([row(), row({ pos_code: 'POS0002', kpi_target: 250_000_000 })], BY_CODE)
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.invalid).toEqual([])
    expect(r.unmatched).toEqual([])
    expect(r.valid).toEqual([
      {
        store_id: 'store-a', pos_code: 'POS0001', kpi_target: 450_000_000,
        store_kpi_group: 'Nhỏ hơn 500 triệu', import_row: 2, note: null,
        tiers: [
          { tier_order: 1, threshold_pct: 90, commission_amount: 1_000_000 },
          { tier_order: 2, threshold_pct: 100, commission_amount: 2_000_000 },
        ],
      },
      {
        store_id: 'store-b', pos_code: 'POS0002', kpi_target: 250_000_000,
        store_kpi_group: 'Nhỏ hơn 500 triệu', import_row: 3, note: null,
        tiers: [
          { tier_order: 1, threshold_pct: 90, commission_amount: 1_000_000 },
          { tier_order: 2, threshold_pct: 100, commission_amount: 2_000_000 },
        ],
      },
    ])
  })

  test('GMV REGRESSION: boundary 200tr/1 tỷ vẫn BỊ CHẶN; truyền metricType gmv tường minh cũng vậy', () => {
    for (const opts of [undefined, { metricType: 'gmv' }]) {
      const r = parseCampaignRows(
        [row({ kpi_target: 200_000_000 }), row({ pos_code: 'POS0002', kpi_target: 1_000_000_000 })],
        BY_CODE, opts)
      expect('error' in r).toBe(false)
      if ('error' in r) return
      expect(r.valid).toEqual([])
      expect(r.invalid).toHaveLength(2)
      expect(r.invalid[0].error).toContain('ranh giới nhóm KPI')
    }
  })

  test('GMV REGRESSION: kpi_target thập phân HỢP LỆ (hành vi cũ giữ nguyên)', () => {
    const r = parseCampaignRows([row({ kpi_target: 450_000_000.5 })], BY_CODE)
    if ('error' in r) return
    expect(r.valid).toHaveLength(1)
    expect(r.valid[0].kpi_target).toBe(450_000_000.5)
  })

  test('GMV REGRESSION: lỗi file/dòng — thiếu header, pos trùng, không match, tier sai, threshold không tăng', () => {
    expect(parseCampaignRows([], BY_CODE)).toEqual({ error: 'File không có dòng dữ liệu nào' })
    expect(parseCampaignRows([{ kpi_target: 1 }], BY_CODE)).toEqual({ error: 'Thiếu cột pos_code' })
    expect(parseCampaignRows([{ pos_code: 'POS0001', store_kpi_group: 'x' }], BY_CODE))
      .toEqual({ error: 'Thiếu cột kpi_target' })
    expect(parseCampaignRows([{ pos_code: 'POS0001', kpi_target: 1 }], BY_CODE))
      .toEqual({ error: 'Thiếu cột store_kpi_group (phân loại Store theo KPI)' })

    const r = parseCampaignRows([
      row(), row(),                                     // POS0001 trùng
      row({ pos_code: 'POS0099' }),                     // không match
      row({ pos_code: 'POS0002', tier_2_threshold_pct: 90 }), // không tăng dần
    ], BY_CODE)
    if ('error' in r) return
    expect(r.valid).toHaveLength(1)
    expect(r.unmatched).toEqual(['POS0099'])
    expect(r.invalid.map((x) => x.error)).toEqual([
      'pos_code trùng trong file',
      'pos_code không có trong hệ thống',
      'Threshold các bậc phải tăng dần',
    ])
  })

  // ── Mig 103: customer — kpi_target = SỐ KHÁCH nguyên ──────────────────────
  test('CUSTOMER: kpi_target integer hợp lệ; thập phân → lỗi rõ đơn vị khách', () => {
    const ok = parseCampaignRows([row({ kpi_target: 100 })], BY_CODE, CUSTOMER)
    if ('error' in ok) return
    expect(ok.valid).toHaveLength(1)
    expect(ok.valid[0].kpi_target).toBe(100)

    const bad = parseCampaignRows([row({ kpi_target: 12.5 })], BY_CODE, CUSTOMER)
    if ('error' in bad) return
    expect(bad.valid).toEqual([])
    expect(bad.invalid[0].error).toContain('số nguyên dương (số khách)')
  })

  test('CUSTOMER: BỎ rule ranh giới tiền — 200.000.000 khách (giá trị biên GMV) là số nguyên hợp lệ', () => {
    const r = parseCampaignRows([row({ kpi_target: 200_000_000 })], BY_CODE, CUSTOMER)
    if ('error' in r) return
    expect(r.valid).toHaveLength(1)
    expect(r.invalid).toEqual([])
  })

  test('CUSTOMER: tier %/commission tiền giữ nguyên luật', () => {
    const badTier = parseCampaignRows(
      [row({ kpi_target: 100, tier_1_commission_amount: -1 })], BY_CODE, CUSTOMER)
    if ('error' in badTier) return
    expect(badTier.invalid[0].error).toContain('≥ 0')
  })
})

// ── r1 (audit P1#2): guide/template import theo LOẠI chiến dịch ─────────────
test.describe('kpi campaign import guide (mig 103 r1) @desktop', () => {
  test('GMV guide BYTE-INVARIANT: sample CSV + header + boundary warning y hệt production cũ (Power Query/ops)', () => {
    for (const g of [campaignImportGuide(), campaignImportGuide('gmv'), campaignImportGuide('bogus')]) {
      expect(g.sampleCsv).toBe([
        'pos_code,kpi_target,store_kpi_group,tier_1_threshold_pct,tier_1_commission_amount,tier_2_threshold_pct,tier_2_commission_amount,tier_3_threshold_pct,tier_3_commission_amount,pos_name,note',
        'POS0059,450000000,Nhỏ hơn 500 triệu,90,15000000,100,20800000,105,26300000,CIRCA TAM VIET,Demo',
        'POS0009,250000000,Nhỏ hơn 300 triệu,90,10600000,100,14700000,105,18500000,CIRCA CENTRAL,Demo',
      ].join(String.fromCharCode(10)))
      expect(g.sampleFileName).toBe('mau-chien-dich-kpi.csv')
      expect(g.boundaryWarning).toContain('200/300/500/800 triệu')
      expect(g.targetHeaderLabel).toBe('KPI target')
      expect(g.formatTarget(450000000)).toBe('450.000.000') // preview cũ KHÔNG có ₫
      expect(g.commitToast(25)).toContain('Đồng bộ doanh số')
    }
  })

  test('CUSTOMER guide: KHÔNG chứa target tiền — sample là SỐ KHÁCH; không boundary warning; đơn vị khách', () => {
    const g = campaignImportGuide('affiliate_customer_count')
    expect(g.sampleCsv).not.toContain('450000000')
    expect(g.sampleCsv).not.toContain('250000000')
    expect(g.sampleCsv).toContain('POS0059,100,')
    expect(g.sampleCsv).toContain('POS0009,50,')
    expect(g.boundaryWarning).toBeNull()
    expect(g.targetHeaderLabel).toBe('KPI target (khách)')
    expect(g.formatTarget(100)).toBe('100 khách')
    expect(g.sampleFileName).toBe('mau-chien-dich-so-khach.csv')
    expect(g.commitToast(25)).toContain('Đồng bộ số khách')
    // Cột target ghi rõ SỐ NGUYÊN đơn vị khách; commission vẫn VNĐ
    const target = g.columns.find((c) => c.col === 'kpi_target')!
    expect(target.meaning).toContain('SỐ NGUYÊN')
    expect(target.example).toBe('100')
    expect(g.columns.find((c) => c.col === 'tier_1_commission_amount')!.meaning).toContain('VNĐ')
  })

  // ── Mig 106 (contract 12/08): file CHỈ có order_target + aov_target ───────
  const AOV = { metricType: 'offline_order_aov' }
  const aovRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    pos_code: 'POS0018', order_target: 1046, aov_target: 194_046,
    store_kpi_group: 'Nhóm A',
    tier_1_threshold_pct: 100, tier_1_commission_amount: 20_800_000,
    pos_name: 'CIRCA SIGNATURE', note: null,
    ...over,
  })

  test('AOV: file hợp lệ (fixture Finance SIGNATURE) → 2 mục tiêu + kpi_target ÉP = 100', () => {
    const r = parseCampaignRows([aovRow()], BY_CODE, AOV)
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.invalid).toEqual([])
    expect(r.valid).toEqual([{
      store_id: 'store-signature', pos_code: 'POS0018',
      kpi_target: 100,                       // hệ thống chuẩn hóa, không lấy từ file
      store_kpi_group: 'Nhóm A', import_row: 2, note: null,
      tiers: [{ tier_order: 1, threshold_pct: 100, commission_amount: 20_800_000 }],
      order_target: 1046, aov_target: 194_046,
    }])
  })

  test('AOV: từ chối TEMPLATE CŨ (order_floor/aov_floor) với thông báo rõ', () => {
    for (const col of ['order_floor', 'aov_floor']) {
      const r = parseCampaignRows([aovRow({ [col]: 888 })], BY_CODE, AOV)
      expect('error' in r, col).toBe(true)
      if ('error' in r) {
        expect(r.error).toContain('template CŨ')
        expect(r.error).toContain(col)
      }
    }
  })

  test('AOV: thiếu order_target hoặc aov_target → lỗi FILE (không phải lỗi dòng)', () => {
    for (const col of ['order_target', 'aov_target']) {
      const { [col]: _drop, ...rest } = aovRow()
      const r = parseCampaignRows([rest], BY_CODE, AOV)
      expect('error' in r, `thiếu ${col} phải là lỗi file`).toBe(true)
      if ('error' in r) expect(r.error).toContain(col)
    }
  })

  test('AOV: file mang kpi_target hoặc net_revenue → CHẶN NGAY (nhầm cấu hình)', () => {
    const withTarget = parseCampaignRows([aovRow({ kpi_target: 500_000_000 })], BY_CODE, AOV)
    expect('error' in withTarget).toBe(true)
    if ('error' in withTarget) expect(withTarget.error).toContain('kpi_target')
    const withNet = parseCampaignRows([aovRow({ net_revenue: 203_039_424 })], BY_CODE, AOV)
    expect('error' in withNet).toBe(true)
    if ('error' in withNet) expect(withNet.error).toContain('net_revenue')
  })

  test('AOV: validate từng dòng — dương và nguyên', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ order_target: 0 }, 'order_target phải > 0'],
      [{ aov_target: -1 }, 'aov_target phải > 0'],
      [{ order_target: 1046.5 }, 'order_target phải là số nguyên (số đơn)'],
      [{ aov_target: 194_046.5 }, 'aov_target phải là số nguyên (VNĐ)'],
    ]
    for (const [patch, msg] of cases) {
      const r = parseCampaignRows([aovRow(patch)], BY_CODE, AOV)
      expect('error' in r).toBe(false)
      if ('error' in r) return
      expect(r.valid).toEqual([])
      expect(r.invalid[0]?.error, JSON.stringify(patch)).toBe(msg)
    }
  })

  test('AOV policy tier: ĐÚNG 1 bậc mốc 100 — nhiều bậc / mốc khác đều bị từ chối', () => {
    const twoTiers = parseCampaignRows([aovRow({
      tier_2_threshold_pct: 105, tier_2_commission_amount: 26_300_000,
    })], BY_CODE, AOV)
    if ('error' in twoTiers) throw new Error('phải là lỗi DÒNG, không phải lỗi file')
    expect(twoTiers.valid).toEqual([])
    expect(twoTiers.invalid[0].error).toContain('ĐÚNG 1 bậc')

    const wrongPct = parseCampaignRows([aovRow({ tier_1_threshold_pct: 90 })], BY_CODE, AOV)
    if ('error' in wrongPct) throw new Error('phải là lỗi DÒNG')
    expect(wrongPct.invalid[0].error).toContain('100%')
  })

  test('AOV: KHÔNG áp rule ranh giới tiền của GMV (giá trị AOV lớn không bị chặn oan)', () => {
    const r = parseCampaignRows([aovRow({ aov_target: 200_000_000 })], BY_CODE, AOV)
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.invalid).toEqual([])
    expect(r.valid.length).toBe(1)
  })

  test('AOV: store_kpi_group TÙY CHỌN (107); pos_code lạ vẫn vào unmatched', () => {
    const noGroup = parseCampaignRows([aovRow({ store_kpi_group: '' })], BY_CODE, AOV)
    if ('error' in noGroup) throw new Error('không được là lỗi file')
    expect(noGroup.invalid).toEqual([])
    expect(noGroup.valid[0].store_kpi_group).toBeNull()

    const unknown = parseCampaignRows([aovRow({ pos_code: 'POS9999' })], BY_CODE, AOV)
    if ('error' in unknown) throw new Error('không được là lỗi file')
    expect(unknown.unmatched).toEqual(['POS9999'])
  })

  test('AOV: file GMV/khách KHÔNG được sinh 2 cột mục tiêu (reverse guard trước RPC)', () => {
    const gmv = parseCampaignRows([row()], BY_CODE)
    if ('error' in gmv) throw new Error('file GMV hợp lệ')
    for (const k of ['order_target', 'aov_target']) expect(k in gmv.valid[0]).toBe(false)
    const cust = parseCampaignRows([row({ kpi_target: 120 })], BY_CODE, CUSTOMER)
    if ('error' in cust) throw new Error('file khách hợp lệ')
    expect('order_target' in cust.valid[0]).toBe(false)
  })

  test('GUIDE Chất lượng bán hàng: 2 mục tiêu, KHÔNG kpi_target/net/floor; sample tự parse được', () => {
    const g = campaignImportGuide('offline_order_aov')
    const cols = g.columns.map((c) => c.col)
    expect(cols).toContain('order_target')
    expect(cols).toContain('aov_target')
    for (const dead of ['kpi_target', 'net_revenue', 'order_floor', 'aov_floor']) {
      expect(cols).not.toContain(dead)
    }
    expect(g.sampleFileName).toBe('mau-chien-dich-chat-luong-ban-hang.csv')
    // Sample phải PARSE ĐƯỢC bằng chính parser (guide và parser không lệch nhau).
    const [header, ...lines] = g.sampleCsv.split('\n')
    const keys = header.split(',')
    const rows = lines.map((ln) => Object.fromEntries(ln.split(',').map((v, i) => [keys[i], v])))
    const parsed = parseCampaignRows(rows, new Map([
      ['POS0018', 'store-a'], ['POS0013', 'store-b'], ['POS0065', 'store-c'],
    ]), AOV)
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.invalid).toEqual([])
    expect(parsed.valid.map((v) => v.order_target)).toEqual([1046, 1187, 586])
    expect(parsed.valid.map((v) => v.aov_target)).toEqual([194_046, 126_644, 226_762])
    expect(parsed.valid.every((v) => v.kpi_target === 100)).toBe(true)
    expect(parsed.valid.every((v) => v.tiers.length === 1 && v.tiers[0].threshold_pct === 100)).toBe(true)
    expect(g.commitToast(3)).toContain('Đồng bộ chất lượng bán hàng')
  })

  test('r1.1 P1#4: tier_2 TRỐNG nhưng tier_3 có dữ liệu → REJECT (không lọt policy 1 bậc)', () => {
    const sneaky = parseCampaignRows([aovRow({
      tier_3_threshold_pct: 120, tier_3_commission_amount: 30_000_000,
    })], BY_CODE, AOV)
    if ('error' in sneaky) throw new Error('phải là lỗi DÒNG, không phải lỗi file')
    expect(sneaky.valid).toEqual([])
    expect(sneaky.invalid[0].error).toContain('còn dữ liệu bậc sau')

    // chỉ có commission ở bậc sau (thiếu threshold) cũng phải bị bắt
    const onlyCm = parseCampaignRows([aovRow({ tier_4_commission_amount: 1 })], BY_CODE, AOV)
    if ('error' in onlyCm) throw new Error('phải là lỗi DÒNG')
    expect(onlyCm.valid).toEqual([])

    // campaign GMV giữ NGUYÊN hành vi cũ (dừng ở ô trống đầu tiên)
    const gmv = parseCampaignRows([row({
      tier_3_threshold_pct: undefined, tier_5_threshold_pct: 120, tier_5_commission_amount: 1,
    })], BY_CODE)
    if ('error' in gmv) throw new Error('file GMV hợp lệ')
    expect(gmv.valid).toHaveLength(1)
    expect(gmv.valid[0].tiers).toHaveLength(2)
  })
})

// ── 107: store_kpi_group TÙY CHỌN ───────────────────────────────────────────
test.describe('campaign import — store_kpi_group tùy chọn (107) @desktop', () => {
  test('ô TRỐNG hợp lệ và cho ra null (không phải chuỗi rỗng)', () => {
    for (const blank of ['', '   ', '	 ']) {
      const r = parseCampaignRows([row({ store_kpi_group: blank })], BY_CODE)
      if ('error' in r) throw new Error('không được coi là lỗi file')
      expect(r.invalid, `blank=${JSON.stringify(blank)}`).toEqual([])
      expect(r.valid).toHaveLength(1)
      // null, KHÔNG phải '' — DB phân biệt hai thứ này và UI dựa vào null để
      // quyết định ẩn cột.
      expect(r.valid[0].store_kpi_group).toBeNull()
    }
  })

  test('thiếu HEADER vẫn là lỗi file (cột phải tồn tại trong template)', () => {
    expect(parseCampaignRows([{ pos_code: 'POS0001', kpi_target: 1 }], BY_CODE))
      .toEqual({ error: 'Thiếu cột store_kpi_group (phân loại Store theo KPI)' })
  })

  test('có giá trị → giữ nguyên, trim hai đầu', () => {
    const r = parseCampaignRows([row({ store_kpi_group: '  Nhóm A  ' })], BY_CODE)
    if ('error' in r) throw new Error('không được lỗi')
    expect(r.valid[0].store_kpi_group).toBe('Nhóm A')
  })

  test('cả 3 loại chiến dịch đều chấp nhận ô trống', () => {
    const cus = parseCampaignRows([row({ kpi_target: 100, store_kpi_group: '' })], BY_CODE, CUSTOMER)
    if ('error' in cus) throw new Error('customer: không được lỗi file')
    expect(cus.invalid).toEqual([])
    expect(cus.valid[0].store_kpi_group).toBeNull()
  })
})
