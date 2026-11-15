import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import * as XLSX from 'xlsx'
import { cmsCalcFlagsFromEnv, cmsReturnsPagesFromEnv } from '../lib/cms/flags'
import { cmsBqReturnsTable } from '../lib/cms/config'
import { buildCmsContractQuery } from '../lib/cms/source/contractSource'
import { handleCmsReturnsAfterClose } from '../lib/cms/returnsAfterClose'
import { runCmsConfirmRestored } from '../lib/cms/returnsConflictAction'
import { buildCmsResultWorkbook, type CmsExportInput } from '../lib/cms/exportResults'
import { CMS_FX_PG, cmsFxProgram } from '../lib/cms/fixtureScenario'
import { CMS_FX_PG_CONTRACT, cmsFxContract } from '../lib/cms/fixturesContract'
import { cmsFxAdminResults, cmsFxLines } from '../lib/cms/fixturesResults'
import { CMS_SALES_ONLY_NOTE, cmsQtyText } from '../lib/cms/resultUi'
import { parseCmsDecimal } from '../lib/cms/decimal'
import { CMS_RETURNS_POLICY_LABEL } from '../lib/cms/calc/basisUi'
import { parseUtcMicros } from '../lib/cms/time'

// CMS bán hàng — RC phát hành trước (PM 14/11 `planning/reviews/2026-11-14-cms-sales-first-release-pm.md` §2 / §3). Không mạng / DB.
//   (1) Ca bắt buộc §4: cờ mode BẬT, trả hàng TẮT, thiếu FQN trả ⇒ sales-only: không tham số / view trả trong job nguồn, trang + link + XLSX
//       trả hàng đóng, cron sau chốt DISABLED không dựng deps, xác nhận phục hồi từ chối trước mọi RPC. Đường worker DB = harness 130 W5
//       (cms_unit sales-only, modes ON / returns OFF ⇒ công bố, provider gọi không kèm phần trả) trên SQL ghim r4.1.
//   (2) PM P5-04 phần bán hàng: nhãn XLSX theo TRẠNG THÁI chương trình (chung legacy / contract); run contract đếm "sự kiện" tách bán / trả;
//       cột "Dòng trả hàng" (không gọi là số phiếu). Số / tổng không đổi.

const ROOT = path.resolve(__dirname, '..')
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const ON = { CMS_PROGRAM_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true' }

test.describe('CMS bán hàng RC — modes ON / returns OFF / thiếu FQN trả @desktop', () => {
  test('cờ: trang / link / XLSX trả hàng chỉ mở khi CMS_RETURNS_ENABLED (cùng program + earnings); mode bật một mình KHÔNG mở', () => {
    const salesRc = { ...ON, CMS_CALC_MODES_ENABLED: 'true' }
    expect(cmsCalcFlagsFromEnv(salesRc)).toEqual({ modes: true, returns: false })
    expect(cmsReturnsPagesFromEnv(salesRc)).toBe(false)
    expect(cmsReturnsPagesFromEnv({})).toBe(false)
    expect(cmsReturnsPagesFromEnv({ ...ON })).toBe(false)
    expect(cmsReturnsPagesFromEnv({ ...salesRc, CMS_RETURNS_ENABLED: 'TRUE' })).toBe(false)
    expect(cmsReturnsPagesFromEnv({ CMS_PROGRAM_ENABLED: 'true', CMS_RETURNS_ENABLED: 'true' })).toBe(false)
    expect(cmsReturnsPagesFromEnv({ ...ON, CMS_RETURNS_ENABLED: 'true' })).toBe(true)
    // Mọi lối vào trả hàng của route thật dùng chung cổng này (2 trang + link A3 + XLSX báo cáo sau chốt).
    expect(src('lib/cms/server/returnsLoad.ts')).toContain('export const cmsReturnsPageEnabled = () => cmsReturnsPagesFromEnv(process.env)')
    expect(src('app/(dashboard)/targets/campaigns/cms/[id]/page.tsx')).toContain('const caps = canManage && cmsReturnsPageEnabled() ? await getCmsCapabilityState() : null')
    expect(src('app/api/export/cms/close-report/route.ts')).toContain('if (!cmsReturnsPageEnabled() || !canManageCms(profile?.role, user.email))')
    for (const p of ['app/(dashboard)/targets/campaigns/cms/[id]/returns/page.tsx', 'app/(dashboard)/targets/campaigns/cms/[id]/returns/[reportId]/page.tsx']) {
      expect(src(p), p).toContain('if (!cmsReturnsPageEnabled() || !canManageCms(profile?.role, user.email)) notFound()')
    }
    // Mặc định khai báo: trả hàng OFF, view trả trống.
    const ex = src('.env.example')
    expect(ex).toMatch(/^CMS_RETURNS_ENABLED=false$/m)
    expect(ex).toMatch(/^CMS_BQ_RETURNS_TABLE=$/m)
  })

  test('nguồn: FQN trả trống ⇒ null; job sales-only chỉ đọc view bán (không UNION, không tham số trả)', () => {
    const env = { ...ON, CMS_CALC_MODES_ENABLED: 'true', CMS_BQ_RETURNS_TABLE: '' }
    expect(cmsBqReturnsTable(env)).toBeNull()
    expect(cmsBqReturnsTable({ ...ON })).toBeNull()
    const q = buildCmsContractQuery({
      salesTable: 'qa-proj.qa_ds.cms_order_view', returnsTable: cmsBqReturnsTable(env), fromMicros: parseUtcMicros('2026-12-01T00:00:00.000000Z')!,
      toMicrosExclusive: parseUtcMicros('2027-01-01T00:00:00.000000Z')!, productIds: ['900201'], asOfMicros: parseUtcMicros('2026-12-05T00:00:00.000000Z')!,
    })
    // Một nhánh 'S' duy nhất, đọc đúng một view (cột trả chỉ là NULL giữ bố cục chung của job), không nhánh 'R', không tham số trả.
    expect(q.sql).not.toContain('UNION ALL')
    expect(q.sql).not.toContain("'R' AS src_kind")
    expect(q.sql.match(/FROM `[^`]+`/g)).toEqual(['FROM `qa-proj.qa_ds.cms_order_view`'])
    expect(q.params.map((p) => p.name).filter((n) => /return|not_effective/.test(n))).toEqual([])
    // Worker: chương trình sales_only ⇒ withReturns = false (contractSync — chính sách run, không theo cờ).
    expect(src('lib/cms/contractSync.ts')).toContain("const net = snap.returnsPolicy === 'net_returns_v1'")
    expect(src('lib/cms/contractSync.ts')).toContain('asOfMicros: asOf, withReturns: net, deadlineMs: budget.sourceMs(),')
  })

  test('cron sau chốt: returns OFF ⇒ 200 DISABLED, không dựng deps; xác nhận phục hồi ⇒ RETURNS_DISABLED trước mọi quyền / RPC', async () => {
    let built = 0
    const r = await handleCmsReturnsAfterClose({
      authorization: 'Bearer s3', cronSecret: 's3', returnsEnabled: cmsCalcFlagsFromEnv({ ...ON, CMS_CALC_MODES_ENABLED: 'true' }).returns,
      makeDeps: () => { built++; throw new Error('không được gọi') },
    })
    expect(r).toEqual({ status: 200, body: { status: 'DISABLED', code: 'RETURNS_DISABLED' } })
    expect(built).toBe(0)
    const touched: string[] = []
    const no = (k: string) => () => { touched.push(k); throw new Error(k) }
    const c = await runCmsConfirmRestored({
      enabled: () => false, qaReadonly: no('qa'), access: no('access') as never, program: no('program') as never, rpc: no('rpc') as never,
    }, { programId: '00000000-0000-4000-8000-000000000014' })
    expect(c).toEqual({ ok: false, code: 'RETURNS_DISABLED' })
    expect(touched).toEqual([])
  })
})

// ── XLSX (PM P5-04 phần bán hàng) ────────────────────────────────────────────
const wbOf = (b: ReturnType<typeof buildCmsResultWorkbook>) => { if (!b.ok) throw new Error(b.error); return XLSX.read(b.bytes, { type: 'array' }) }
const aoa = (wb: XLSX.WorkBook, s: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[s], { header: 1 })
const info = (wb: XLSX.WorkBook) => new Map(aoa(wb, 'Thong tin').map((r) => [String(r[0]), r[1]]))
const head = (wb: XLSX.WorkBook, s: string) => (aoa(wb, s)[0] as string[])
// Đọc đủ độ rộng vùng sheet (ô trống = null) để so độ dài dòng với header.
const aoaFull = (wb: XLSX.WorkBook, s: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[s], { header: 1, defval: null })
const objs = (wb: XLSX.WorkBook, s: string) => XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[s])
const U = (v: string) => { const r = parseCmsDecimal(v); if (!r.ok) throw new Error(v); return r.units }

function inputOf(id: string, status: string): CmsExportInput {
  const l = cmsFxAdminResults('running', 'super', id)
  if (l.kind !== 'loaded') throw new Error('fx')
  const fx = cmsFxProgram(id) ?? cmsFxContract(id)!.fx
  return {
    program: { id, name: fx.row.name, startDate: fx.row.startDate, endDate: fx.row.endDate, configVersion: fx.row.configVersion, status },
    header: l.header, rows: l.rows, lines: cmsFxLines(l.rows.results), excluded: [], excludedQty: null,
    products: fx.products.map((p) => ({ id: p.id, productId: p.productId, nameSnapshot: p.nameSnapshot, unitCms: p.unitCms, baseQuantityCms: p.baseQuantityCms, gmvBasis: p.gmvBasis })),
    storeNames: new Map(), exportedAt: new Date('2026-11-15T03:00:00Z'), scope: 'super', returnsApproved: false,
  }
}

test.describe('CMS bán hàng RC — XLSX nhãn theo trạng thái + đếm sự kiện @desktop', () => {
  test('legacy (T11): đang chạy ⇒ "Tạm tính"; đã chốt ⇒ "Số đã chốt" ở Ghi chú, tổng và cột tiền — cùng số, cùng nhãn đếm cũ', () => {
    const act = buildCmsResultWorkbook(inputOf(CMS_FX_PG.PG1, 'active'))
    const lock = buildCmsResultWorkbook(inputOf(CMS_FX_PG.PG1, 'locked'))
    const a = wbOf(act), k = wbOf(lock)
    const ia = info(a), ik = info(k)
    expect(String(ia.get('Ghi chú'))).toMatch(/^Tạm tính — chưa chốt kỳ\./)
    expect(ia.has('Tổng CMS tạm tính (VND)')).toBe(true)
    expect(head(a, 'Theo san pham')).toContain('CMS tạm tính (VND)')
    expect(String(ik.get('Ghi chú'))).toMatch(/^Số đã chốt — phiên đóng băng\./)
    expect(ik.get('Phạm vi số liệu')).toBe('Số đã chốt theo dữ liệu bán của phiên đóng băng; chưa bao gồm xử lý trả hàng.')
    expect(ia.get('Phạm vi số liệu')).toBe(CMS_SALES_ONLY_NOTE)
    expect(ik.has('Tổng CMS đã chốt (VND)')).toBe(true)
    expect(ik.get('Tổng CMS đã chốt (VND)')).toBe(ia.get('Tổng CMS tạm tính (VND)'))
    for (const s of ['Theo san pham', 'Theo duoc si']) {
      expect(head(k, s), s).toContain('CMS đã chốt (VND)')
      expect(head(k, s), s).not.toContain('CMS tạm tính (VND)')
    }
    expect(JSON.stringify(aoa(k, 'Thong tin'))).not.toMatch(/tạm tính/i)
    // Legacy giữ nhãn đếm cũ (snapshot cũ), không thêm dòng hợp đồng.
    expect(ia.get('Số dòng đơn được tính')).toBe(inputOf(CMS_FX_PG.PG1, 'active').lines.length)
    expect(ia.has('Loại số liệu')).toBe(false)
    expect(act.ok && lock.ok && act.amountVnd === lock.amountVnd && act.lineCount === lock.lineCount).toBe(true)
  })

  // PM RC r2 SALES-RC-03: bố cục theo returnsPolicy GHIM của run. Sales-only (DB: chỉ cms_unit) ⇒ "SL bán / GMV", không cột / dòng trả,
  // giữ K + lượng đủ điều kiện + lớp lượng; Thông tin đếm dòng BÁN ghi nhận (gồm dòng không tính lượng). Số / tổng / line_count không đổi.
  test('SALES-RC-03 PG14 (cms_unit + sales-only, run contract): header / độ dài dòng / tổng / cột điều kiện; không cột trả, không "ròng"', () => {
    const P_HEAD = ['ProductID', 'Tên sản phẩm', 'Loại điều kiện', 'Đơn vị CMS', 'SL bán (đv CMS)', 'SL tính CMS', 'GMV (VND)', 'Dược sĩ có bán', 'Dược sĩ đạt']
    const S_HEAD = ['Dược sĩ', 'user_id', 'Nhà thuốc hiện tại', 'Nhà thuốc lúc bán', 'ProductID', 'Tên sản phẩm', 'SL bán (đv CMS)', 'SL tính CMS', 'GMV (VND)',
      'Target (VND)', 'Đạt target', 'Đạt từ (VN)', 'CMS khi đạt (VND)']
    const L_HEAD = ['seq', 'Mã đơn', 'order_line_id', 'ProductID', 'Tên sản phẩm', 'Dược sĩ', 'Nhà thuốc lúc bán', 'POS', 'Hoàn tất (VN)', 'SL gốc', 'ĐVT gốc',
      'SL cơ sở', 'GMV (VND)', 'Lũy kế cơ sở đủ ĐK trước', 'Lũy kế cơ sở đủ ĐK sau', 'SL CMS trước', 'SL CMS sau', 'Trạng thái', 'CMS dòng (VND)', 'Lớp lượng', 'SL cơ sở đủ ĐK']
    for (const status of ['active', 'locked'] as const) {
      const i = inputOf(CMS_FX_PG_CONTRACT.PG14, status)
      const c = i.header.run!.contract
      expect(c.legacy || c.returnsPolicy !== 'sales_only_v1' || c.quantityBasis !== 'cms_unit', status).toBe(false)
      const b = buildCmsResultWorkbook(i)
      const wb = wbOf(b)
      const amt = status === 'locked' ? 'CMS đã chốt (VND)' : 'CMS tạm tính (VND)'
      // Header chính xác + mọi dòng đúng độ rộng header (không cột thừa / thiếu).
      expect(head(wb, 'Theo san pham'), status).toEqual([...P_HEAD, amt, 'K (cơ sở / 1 đv CMS)', 'SL đủ điều kiện (đv CMS)'])
      expect(head(wb, 'Theo duoc si'), status).toEqual([...S_HEAD, amt, 'Số dòng bán', 'SL đủ điều kiện (đv CMS)'])
      expect(head(wb, 'Chi tiet dong'), status).toEqual(L_HEAD)
      for (const sh of ['Theo san pham', 'Theo duoc si', 'Chi tiet dong']) {
        const full = aoaFull(wb, sh)
        expect(full[0].every((h) => h !== null), `${status} ${sh} header không ô trống`).toBe(true)
        expect(full.every((r) => r.length === full[0].length), `${status} ${sh}`).toBe(true)
        expect(JSON.stringify(full[0]), `${status} ${sh}`).not.toMatch(/ròng|gộp|trả/i)
      }
      // Cột điều kiện: K = cơ sở / 1 đv CMS của SP; lượng đủ điều kiện = Σ eligibleBase / K; có SP có dòng không tính lượng ⇒ đủ ĐK < SL bán.
      const prodRows = objs(wb, 'Theo san pham').filter((r) => r.ProductID !== 'Tổng')
      expect(prodRows.length, status).toBe(i.products.length)
      let lowerSeen = false
      for (const p of i.products) {
        const r = prodRows.find((x) => x.ProductID === p.productId)!
        const pr = i.rows.results.filter((x) => x.programProductId === p.id)
        const k = U(p.baseQuantityCms)
        expect(r['K (cơ sở / 1 đv CMS)'], p.productId).toBe(Number(p.baseQuantityCms))
        expect(r['SL đủ điều kiện (đv CMS)'], p.productId).toBe(cmsQtyText(pr.reduce((a, x) => a + U(x.eligibleBase), BigInt(0)), k))
        expect(r['SL tính CMS'] ?? 0, p.productId).toBe(Number(pr.reduce((a, x) => a + BigInt(x.cmsQuantity), BigInt(0))))
        if (pr.some((x) => U(x.eligibleBase) < U(x.baseQuantity))) lowerSeen = true
      }
      expect(lowerSeen, `${status} fixture PG14 phải có dòng không tính lượng`).toBe(true)
      // Tổng tiền / số dòng không đổi: tổng sheet = Thông tin = Σ kết quả = Σ dòng; line_count = Σ dòng bán.
      const sumRows = i.rows.results.reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0))
      const total = aoaFull(wb, 'Theo san pham').find((r) => r[0] === 'Tổng')!
      expect(total[9], status).toBe(Number(sumRows))
      expect(info(wb).get(`Tổng ${amt}`), status).toBe(Number(sumRows))
      expect(b.ok && b.amountVnd === sumRows && b.lineCount === i.lines.length, status).toBe(true)
      expect(i.lines.length, status).toBe(i.rows.results.reduce((a, r) => a + r.lineCount, 0))
      expect(objs(wb, 'Theo duoc si').reduce((a, r) => a + Number(r['Số dòng bán']), 0), status).toBe(i.lines.length)
      // Thông tin: 1 dòng đếm dòng bán ghi nhận (gồm NOT_COUNTED), không "bán + trả", không hàng trả = 0, định nghĩa không "ròng".
      const m = info(wb)
      expect(i.lines.some((l) => l.status === 'NOT_COUNTED'), status).toBe(true)
      expect(m.get('Số dòng bán ghi nhận (gồm dòng không tính lượng)'), status).toBe(i.lines.length)
      for (const gone of ['Số sự kiện ghi nhận (dòng bán + dòng trả, gồm dòng không tính lượng)', 'Trong đó dòng bán', 'Trong đó dòng trả hàng', 'Số dòng đơn được tính', 'Dữ liệu trả đến (VN)']) {
        expect(m.has(gone), `${status} ${gone}`).toBe(false)
      }
      expect(String(m.get('Định nghĩa lượng')), status).toMatch(/^SL tính CMS = floor\(lượng cơ sở ĐỦ ĐIỀU KIỆN \/ K\)\./)
      expect(JSON.stringify(aoa(wb, 'Thong tin')), status).not.toMatch(/ròng|bán \+ trả/)
      expect(m.get('Chính sách trả hàng (ghim theo phiên)'), status).toBe(CMS_RETURNS_POLICY_LABEL.sales_only_v1)
      expect(m.get('Phạm vi số liệu'), status).toBe(status === 'locked' ? 'Số đã chốt theo dữ liệu bán của phiên đóng băng; chưa bao gồm xử lý trả hàng.' : CMS_SALES_ONLY_NOTE)
      expect(m.get('Loại số liệu'), status).toBe(status === 'locked' ? 'Số đã chốt — phiên đóng băng' : 'Tạm tính — chưa chốt kỳ')
      expect(String(m.get('Ghi chú')), status).toMatch(status === 'locked' ? /^Số đã chốt — phiên đóng băng\./ : /^Tạm tính — chưa chốt kỳ\./)
      // Chi tiết: mỗi dòng là dòng BÁN; dòng không tính lượng có lớp lượng + đủ ĐK 0.
      const lines = objs(wb, 'Chi tiet dong')
      expect(lines.length, status).toBe(i.lines.length)
      const nc = lines.filter((x) => x['Trạng thái'] === 'Không tính lượng')
      expect(nc.length, status).toBe(i.lines.filter((l) => l.status === 'NOT_COUNTED').length)
      expect(nc.every((x) => x['SL cơ sở đủ ĐK'] === 0 && typeof x['Lớp lượng'] === 'string' && x['Lớp lượng'] !== ''), status).toBe(true)
    }
    // Dữ liệu lệch hợp đồng: run sales-only có sự kiện trả ⇒ không xuất file (dù số dòng khớp).
    const i = inputOf(CMS_FX_PG_CONTRACT.PG14, 'active')
    const bad = i.lines.map((l, n) => (n === 0 ? { ...l, kind: 'RETURN' as const } : l))
    expect(buildCmsResultWorkbook({ ...i, lines: bad })).toEqual({ ok: false, error: 'COUNT_MISMATCH' })
  })

  test('SALES-RC-03 PG16 (admin chọn Tính lẻ ⇒ run LEGACY): file bố cục legacy — không cột hợp đồng / trả; tiền = engine đang chạy', () => {
    const id = CMS_FX_PG_CONTRACT.PG16
    for (const status of ['active', 'locked'] as const) {
      const i = inputOf(id, status)
      expect(i.header.run!.contract.legacy, status).toBe(true)
      expect(i.rows.results.every((r) => r.net === null), status).toBe(true)
      const b = buildCmsResultWorkbook(i)
      const wb = wbOf(b)
      const m = info(wb)
      expect(m.get('Phạm vi số liệu'), status).toBe(status === 'locked' ? 'Số đã chốt theo dữ liệu bán của phiên đóng băng; chưa bao gồm xử lý trả hàng.' : CMS_SALES_ONLY_NOTE)
      for (const gone of ['Cách tính lượng (ghim theo phiên)', 'Chính sách trả hàng (ghim theo phiên)', 'Loại số liệu', 'Định nghĩa lượng', 'Hợp đồng tính', 'Số dòng bán ghi nhận (gồm dòng không tính lượng)']) {
        expect(m.has(gone), `${status} ${gone}`).toBe(false)
      }
      expect(m.get('Số dòng đơn được tính'), status).toBe(i.lines.length)
      expect(head(wb, 'Theo san pham'), status).toHaveLength(10)
      expect(head(wb, 'Theo duoc si').at(-1), status).toBe('Số dòng')
      expect(head(wb, 'Chi tiet dong'), status).toHaveLength(19)
      expect(head(wb, 'Chi tiet dong'), status).toContain('Lũy kế cơ sở trước')
      for (const sh of ['Theo san pham', 'Theo duoc si', 'Chi tiet dong']) {
        expect(JSON.stringify(head(wb, sh)), `${status} ${sh}`).not.toMatch(/ròng|gộp|trả|đủ điều kiện|Lớp lượng/i)
        const full = aoaFull(wb, sh)
        expect(full.every((r) => r.length === full[0].length && full[0].every((h) => h !== null)), `${status} ${sh}`).toBe(true)
      }
      // Tiền / số dòng = engine legacy (đường T11) ≡ computeCmsNet pos_base + sales_only cùng dữ liệu.
      const c16 = cmsFxContract(id)!
      expect(b.ok && b.amountVnd, status).toBe(c16.fx.out!.totals.amountVnd)
      expect(b.ok && b.amountVnd, status).toBe(c16.out.totals.amountVnd)
      expect(b.ok && b.lineCount, status).toBe(c16.fx.out!.lines.length)
    }
  })

  test('SALES-RC-03 đối chứng PG13 (net_returns_v1): giữ cột ròng / gộp / trả / Dòng trả hàng + 3 dòng đếm sự kiện', () => {
    const i = inputOf(CMS_FX_PG_CONTRACT.PG13, 'active')
    const wb = wbOf(buildCmsResultWorkbook(i))
    expect(head(wb, 'Theo san pham').slice(4, 7)).toEqual(['SL bán ròng (đv CMS)', 'SL tính CMS', 'GMV ròng (VND)'])
    expect(head(wb, 'Theo san pham').slice(10)).toEqual(['K (cơ sở / 1 đv CMS)', 'SL đủ điều kiện (đv CMS)', 'SL bán gộp (đv CMS)', 'SL trả (đv CMS)', 'GMV bán gộp (VND)', 'GMV trả (VND)', 'Dòng trả hàng'])
    expect(head(wb, 'Theo duoc si').slice(-5)).toEqual(['SL đủ điều kiện (đv CMS)', 'SL bán gộp (đv CMS)', 'SL trả (đv CMS)', 'GMV trả (VND)', 'Dòng trả hàng'])
    expect(head(wb, 'Chi tiet dong').slice(-4)).toEqual(['Loại', 'Lớp lượng', 'Mã phiếu trả', 'Thay đổi cơ sở đủ ĐK'])
    for (const sh of ['Theo san pham', 'Theo duoc si', 'Chi tiet dong']) {
      const full = aoaFull(wb, sh)
      expect(full.every((r) => r.length === full[0].length && full[0].every((h) => h !== null)), sh).toBe(true)
    }
    const m = info(wb)
    const ret = i.lines.filter((l) => l.kind === 'RETURN').length
    expect(m.get('Số sự kiện ghi nhận (dòng bán + dòng trả, gồm dòng không tính lượng)')).toBe(i.lines.length)
    expect(m.get('Trong đó dòng trả hàng')).toBe(ret)
    expect(m.has('Số dòng bán ghi nhận (gồm dòng không tính lượng)')).toBe(false)
    expect(String(m.get('Định nghĩa lượng'))).toContain('ĐỦ ĐIỀU KIỆN ròng')
    expect(objs(wb, 'Theo duoc si').reduce((a, r) => a + Number(r['Dòng trả hàng']), 0)).toBe(ret)
  })

  test('contract net (PG13, đợt trả sau): đã chốt mới nhắc báo cáo sau chốt; dòng trả = số sự kiện trả (3), không phải số chứng từ', () => {
    const i = inputOf(CMS_FX_PG_CONTRACT.PG13, 'locked')
    const m = info(wbOf(buildCmsResultWorkbook(i)))
    expect(String(m.get('Loại số liệu'))).toBe('Số đã chốt — phiên đóng băng (phiếu trả sau chốt xem ở báo cáo sau chốt, không sửa số này)')
    expect(String(m.get('Phạm vi số liệu'))).toMatch(/^Số đã chốt theo dữ liệu bán đã trừ phiếu trả hàng hoàn tất \(dữ liệu trả đến /)
    const ret = i.lines.filter((l) => l.kind === 'RETURN').length
    expect(ret).toBe(3)
    expect(m.get('Trong đó dòng trả hàng')).toBe(ret)
    expect(m.get('Trong đó dòng bán')).toBe(i.lines.length - ret)
  })
})
