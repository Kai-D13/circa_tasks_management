import { test, expect } from '@playwright/test'
import { isValidPartnerCode, resolveStores, type PartnerMappingRow } from '../lib/affiliate/normalize'
import { resolveMappingsWithAutoCreate, type EnsureFsDeps } from '../lib/affiliate/ensureFs'

// FS-expansion r1 (audit 06/08 P1#1 + P1#3) — khóa 2 contract trọng yếu nhất
// của Batch 2 mà suite cũ chưa bao phủ:
//   1. isValidPartnerCode: production CÓ mã space/Unicode ('NT THIÊN') — regex
//      ASCII cũ loại nhầm; contract mới chỉ chặn rỗng/chưa-trim/>64/control.
//   2. resolveMappingsWithAutoCreate (core DI của cron pull-affiliate-orders):
//      dry không ghi · real ensure→reload · mapping hiện hữu không đụng ·
//      ensure lỗi dừng trước upsert · idempotent run 2 · mã hỏng không sập run.
// Route thật chỉ còn wiring supabaseAdmin + deadline guard quanh core này.

test.describe('affiliate partner_code contract (FS-expansion r1) @desktop', () => {
  test('CHẤP NHẬN mã production thật: space + Unicode + ASCII thường', () => {
    expect(isValidPartnerCode('NT THIÊN')).toBe(true)      // mã THẬT bị regex cũ loại nhầm
    expect(isValidPartnerCode('NT-YEN-HUONG')).toBe(true)
    expect(isValidPartnerCode('CIRCA-TAMVIET')).toBe(true)
    expect(isValidPartnerCode('Nhà Thuốc 24h')).toBe(true)
    expect(isValidPartnerCode('a'.repeat(64))).toBe(true)  // đúng biên 64
  })

  test('TỪ CHỐI: rỗng/chưa trim/quá dài/control char/không phải string', () => {
    expect(isValidPartnerCode('')).toBe(false)
    expect(isValidPartnerCode('  ')).toBe(false)
    expect(isValidPartnerCode(' NT THIÊN')).toBe(false)   // chưa trim (đầu)
    expect(isValidPartnerCode('NT THIÊN ')).toBe(false)   // chưa trim (cuối)
    expect(isValidPartnerCode('a'.repeat(65))).toBe(false)
    expect(isValidPartnerCode('a\tb')).toBe(false)        // tab = control char
    expect(isValidPartnerCode('a\nb')).toBe(false)        // newline
    expect(isValidPartnerCode('a\u0000b')).toBe(false)
    expect(isValidPartnerCode('a\u007Fb')).toBe(false)    // DEL
    expect(isValidPartnerCode(null)).toBe(false)
    expect(isValidPartnerCode(undefined)).toBe(false)
    expect(isValidPartnerCode(123)).toBe(false)
  })
})

// ── Harness core DI: fake deps đếm call + ghi lại args ──────────────────────
const M = (code: string, type: string, storeId: string | null, active = true): PartnerMappingRow =>
  ({ partner_code: code, store_id: storeId, partner_type: type, is_active: active })

const BASE: PartnerMappingRow[] = [
  M('CIRCA-OS', 'os', 's1'),          // OS whitelist — không bao giờ được đụng
  M('CIRCA-FS', 'fs', 's2'),          // FS có store
  M('NT-YEN-HUONG', 'fs', null),      // FS partner (store NULL)
  M('CODE-INACT', 'fs', null, false), // inactive — ĐÃ tồn tại, không auto-bật
]

function harness(opts?: {
  reloaded?: PartnerMappingRow[]
  ensureImpl?: (codes: string[]) => Promise<string[]>
}) {
  const calls = { load: 0, ensure: [] as string[][] }
  const deps: EnsureFsDeps = {
    loadMappings: async () => {
      calls.load++
      return calls.load === 1 ? BASE : (opts?.reloaded ?? BASE)
    },
    ensureFsMappings: async (codes) => {
      calls.ensure.push([...codes])
      if (opts?.ensureImpl) return opts.ensureImpl(codes)
      return codes
    },
  }
  return { calls, deps }
}

const rows = (...codes: string[]) => codes.map((partner_code) => ({ partner_code }))

test.describe('resolveMappingsWithAutoCreate — core cron auto-create @desktop', () => {
  test('DRY-RUN: tuyệt đối KHÔNG gọi ensure, không reload — chỉ báo would_create_fs; mã hỏng tách invalid', async () => {
    const { calls, deps } = harness()
    const r = await resolveMappingsWithAutoCreate(
      rows('CIRCA-OS', 'NT THIÊN', 'CODE-INACT', 'bad\u0001code'), true, deps)
    expect(calls.ensure).toHaveLength(0)      // dry không ghi gì
    expect(calls.load).toBe(1)
    expect(r.wouldCreateFs).toEqual(['NT THIÊN'])
    expect(r.invalidNewCodes).toEqual(['bad\u0001code'])
    expect(r.newFsCodes).toEqual([])
    expect(r.mappings).toEqual(BASE)
  })

  test('REAL: ensure nhận ĐÚNG các mã mới hợp lệ (không kèm mapping hiện hữu/OS/inactive), rồi ĐỌC LẠI mappings từ DB', async () => {
    const reloaded = [...BASE, M('NT THIÊN', 'fs', null)]
    const { calls, deps } = harness({ reloaded })
    const r = await resolveMappingsWithAutoCreate(
      rows('CIRCA-OS', 'CIRCA-FS', 'CODE-INACT', 'NT THIÊN', 'NT THIÊN'), false, deps)
    expect(calls.ensure).toEqual([['NT THIÊN']])  // distinct + chỉ mã CHƯA có mapping
    expect(calls.load).toBe(2)                    // reload sau ensure — không merge in-memory
    expect(r.mappings).toEqual(reloaded)          // resolve dùng bản ĐỌC LẠI
    expect(r.newFsCodes).toEqual(['NT THIÊN'])
    expect(r.wouldCreateFs).toEqual([])
  })

  test('REAL không có mã mới → ensure KHÔNG được gọi, load đúng 1 lần (idempotent run 2)', async () => {
    const { calls, deps } = harness()
    const r = await resolveMappingsWithAutoCreate(
      rows('CIRCA-OS', 'NT-YEN-HUONG', 'CODE-INACT'), false, deps)
    expect(calls.ensure).toHaveLength(0)
    expect(calls.load).toBe(1)
    expect(r.newFsCodes).toEqual([])
    expect(r.invalidNewCodes).toEqual([])
  })

  test('run 1 tạo mã mới → run 2 (mappings đã chứa mã) new_fs_codes RỖNG — chuỗi idempotent 2 run', async () => {
    const afterRun1 = [...BASE, M('NT THIÊN', 'fs', null)]
    const r1 = await resolveMappingsWithAutoCreate(
      rows('NT THIÊN'), false, harness({ reloaded: afterRun1 }).deps)
    expect(r1.newFsCodes).toEqual(['NT THIÊN'])
    // Run 2: loadMappings giờ trả afterRun1 ngay lần đầu
    const calls2 = { load: 0, ensure: [] as string[][] }
    const deps2: EnsureFsDeps = {
      loadMappings: async () => { calls2.load++; return afterRun1 },
      ensureFsMappings: async (codes) => { calls2.ensure.push(codes); return codes },
    }
    const r2 = await resolveMappingsWithAutoCreate(rows('NT THIÊN'), false, deps2)
    expect(calls2.ensure).toHaveLength(0)
    expect(r2.newFsCodes).toEqual([])
  })

  test('ensure LỖI → reject nguyên vẹn, KHÔNG reload (route: fail run, không upsert đơn nào)', async () => {
    const { calls, deps } = harness({
      ensureImpl: async () => { throw new Error('Tạo mapping FS cho mã mới: RPC down') },
    })
    await expect(resolveMappingsWithAutoCreate(rows('NT THIÊN'), false, deps))
      .rejects.toThrow('RPC down')
    expect(calls.load).toBe(1) // chết trước reload → route không bao giờ tới upsert
  })

  test('mã hỏng (control char/quá dài) KHÔNG gửi vào ensure — run vẫn chạy tiếp, mã tự rơi unmatched ở resolver', async () => {
    const reloaded = [...BASE, M('NT THIÊN', 'fs', null)]
    const { calls, deps } = harness({ reloaded })
    const long = 'x'.repeat(65)
    const r = await resolveMappingsWithAutoCreate(
      rows('NT THIÊN', 'bad\u0001code', long), false, deps)
    expect(calls.ensure).toEqual([['NT THIÊN']])
    expect(r.invalidNewCodes).toEqual(['bad\u0001code', long])
    // Compose với resolver thật: mã hỏng unmatched (fail-visible qua health),
    // mã mới đã ensure thành matched_fs.
    const { report } = resolveStores(
      rows('NT THIÊN', 'bad\u0001code', long).map((x) => ({
        ...x, order_id: 1, order_code: null, pos_order_code: null, account_id: null, raw_status: 'DELIVERED',
        status_norm: 'delivered', sale_order_status: null, total_price: 1000, total_item: null,
        first_product_name: null, customer_name: null, customer_phone: null,
        created_time: '2026-08-01T00:00:00.000Z', confirmed_time: null,
        completed_time: '2026-08-02T00:00:00.000Z', last_updated_time: null,
      })),
      r.mappings)
    expect(report.matched_fs).toBe(1)
    expect(report.unmatched_codes.sort()).toEqual(['bad\u0001code', long].sort())
  })

  test('TOÀN BỘ mã mới đều hỏng → ensure không được gọi, không reload', async () => {
    const { calls, deps } = harness()
    const r = await resolveMappingsWithAutoCreate(rows('a\tb'), false, deps)
    expect(calls.ensure).toHaveLength(0)
    expect(calls.load).toBe(1)
    expect(r.invalidNewCodes).toEqual(['a\tb'])
  })
})
