// DATA PROOF cho Affiliate Customer Campaign (handoff 06/08; r1.3.2 07/08).
// READ-ONLY tuyệt đối: KHÔNG ghi Mongo, KHÔNG ghi Supabase.
//   cd webapp && node scripts/proof-affiliate-account-id.mjs     (cần VPN netbird)
//
// ⚠ IDENTITY (contract 09/08, mig 104): khách = normalizeVnPhone(order.
// customer_phone) — người MUA. KHÔNG dùng receiver_phone_number, KHÔNG dùng
// account_id (account/customer collection XUỐNG diagnostic chất lượng nguồn).
// Chứng minh coverage identity trên dữ liệu THẬT. r1.3.2 + r1.3.3 — GATE tách 3 tầng:
//   RUNTIME READINESS (mirror canary RPC 104: phone = đơn đủ điều kiện TRONG
//     range; completed_time = TOÀN LỊCH SỬ DELIVERED trên
//     scoped OS stores, KHÔNG lọc range/giá): runtime_missing_account_id = 0
//     · runtime_missing_completed_time = 0 — metric scoped có sạch mấy mà
//     tầng này fail thì activation/sync production vẫn fail-closed.
//   RELEASE DECISION (SCOPED: exact range + OS active + POS filter):
//     exact_range_provided · eligible_missing_customer_phone = 0
//   DIAGNOSTIC (chỉ CẢNH BÁO — KHÔNG đổi exit): cross-store trong/ngoài range
//     (stakeholder đã chốt rule earliest-order), phone thiếu NGOÀI range,
//     account_id, customer collection.
// Exit code = 0 CHỈ khi runtime + release ĐỀU pass (hoặc ≠0 khi lỗi kết nối).
// ⚠ P2#3: proof đọc MONGO NGUỒN — runtime đọc Supabase snapshot. Sau deploy
// + full sync PHẢI verify TRỰC TIẾP Supabase (SQL in ở cuối output) trước
// khi bật KPI_AFFILIATE_CUSTOMER_ENABLED; proof này là PREDICTOR, không thay
// được gate Supabase đó.
//
// Nguồn: Mongo order (AFFILIATE_MONGO_DB/COLLECTION — mặc định như cron) +
// Mongo customer (cùng URI — user xác nhận 06/08 reader đọc được
// circa-online_prd_consumer.customer) + Supabase affiliate_partner_mappings
// (SELECT qua service key — chỉ đọc). Cron production KHÔNG pull customer —
// collection này chỉ phục vụ preflight/audit (chốt handoff).
import fs from 'node:fs'
import { MongoClient } from 'mongodb'
import { createClient } from '@supabase/supabase-js'
// r1.3.1: lõi thuần tách ra module để Playwright test synthetic (8 case).
import {
  buildPointByCode, qualifyOrders, dedupWinners, crossStoreCases, normalizeVnPhone,
  scopePoints, classifyMissingIdentity, buildGateReport, runtimeReadiness,
} from './lib-customer-proof.mjs'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}
if (!env.MONGODB_AFFILIATE_URI) { console.error('Thiếu MONGODB_AFFILIATE_URI trong .env.local'); process.exit(1) }
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trong .env.local'); process.exit(1)
}

// ── r1.1 P2: EXACT-RANGE baseline (tùy chọn) — mirror ĐÚNG range campaign.
// Truyền qua PROCESS ENV (tham số từng lần chạy):
//   $env:QA_CUSTOMER_FROM='2026-08-01'; $env:QA_CUSTOMER_TO='2026-08-10'
// Ngày VN (YYYY-MM-DD, inclusive như start/end campaign) → nội bộ convert
// half-open [from 00:00 VN, ngày-sau-to 00:00 VN) — mirror vnDayRange + RPC.
// Validate FAIL-FAST trước khi kết nối bất kỳ nguồn nào.
const RANGE_FROM = process.env.QA_CUSTOMER_FROM ?? null
const RANGE_TO = process.env.QA_CUSTOMER_TO ?? null
const isCalDate = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x)
  && !Number.isNaN(Date.parse(x + 'T00:00:00Z'))
  && new Date(Date.parse(x + 'T00:00:00Z')).toISOString().slice(0, 10) === x
let rangeMs = null
if (RANGE_FROM !== null || RANGE_TO !== null) {
  if (RANGE_FROM === null || RANGE_TO === null) {
    console.error('QA_CUSTOMER_FROM/QA_CUSTOMER_TO phải đi CẶP (YYYY-MM-DD, ngày VN — như start/end campaign)')
    process.exit(1)
  }
  if (!isCalDate(RANGE_FROM) || !isCalDate(RANGE_TO)) {
    console.error('QA_CUSTOMER_FROM/QA_CUSTOMER_TO sai định dạng/ngày lịch không tồn tại (YYYY-MM-DD): ' + RANGE_FROM + ' / ' + RANGE_TO)
    process.exit(1)
  }
  if (RANGE_FROM > RANGE_TO) {
    console.error('QA_CUSTOMER_FROM (' + RANGE_FROM + ') phải <= QA_CUSTOMER_TO (' + RANGE_TO + ')')
    process.exit(1)
  }
  const DAY = 86400_000
  rangeMs = {
    from: Date.parse(RANGE_FROM + 'T00:00:00+07:00'),
    to: Date.parse(RANGE_TO + 'T00:00:00+07:00') + DAY,
  }
}

// r1.3.1 #8: đối soát campaign SUBSET — CSV mã POS (OS active). Không truyền
// → toàn bộ OS active. Membership check sau khi load mappings.
const POS_FILTER_RAW = process.env.QA_CUSTOMER_POS_CODES ?? null
let posFilter = null
if (POS_FILTER_RAW !== null) {
  const codes = POS_FILTER_RAW.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  if (codes.length === 0) {
    console.error('QA_CUSTOMER_POS_CODES rỗng/sai định dạng (CSV mã POS, vd POS0059,POS0009)')
    process.exit(1)
  }
  posFilter = new Set(codes)
}

const ORDER_DB = env.AFFILIATE_MONGO_DB || 'circa-online_prd_order'
const ORDER_COLL = env.AFFILIATE_MONGO_COLLECTION || 'order'
const CUSTOMER_DB = env.AFFILIATE_MONGO_CUSTOMER_DB || 'circa-online_prd_consumer'
const CUSTOMER_COLL = env.AFFILIATE_MONGO_CUSTOMER_COLLECTION || 'customer'

// Mirror contract cron (lib/affiliate/mongo.ts): promoteLongs:false — int64 về
// dạng Long object; convert tường minh qua toSafeInt (copy cục bộ vì .mjs
// không import TS được), vượt safe-int → null (không im lặng mất chính xác).
const toSafeInt = (v) => {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null
  if (typeof v === 'object' && v !== null && typeof v.toNumber === 'function') {
    const n = v.toNumber()
    return Number.isFinite(n) && Number.isSafeInteger(n) ? n : null
  }
  return null
}
const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'object' && v !== null && typeof v.toNumber === 'function') {
    const n = v.toNumber()
    return Number.isFinite(n) ? n : null
  }
  return null
}
// Che PII trong mọi output (mirror mask của RPC 104): 0905***560.
const mask = (phone) => (typeof phone === 'string' && phone.length === 10
  ? `${phone.slice(0, 4)}***${phone.slice(7)}` : '***')
const bsonType = (v) => {
  if (v === undefined) return 'missing'
  if (v === null) return 'null'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'object' && v._bsontype) return v._bsontype
  return typeof v
}

let exitCode = 0
const client = new MongoClient(env.MONGODB_AFFILIATE_URI, {
  maxPoolSize: 2, serverSelectionTimeoutMS: 15_000, connectTimeoutMS: 15_000,
  socketTimeoutMS: 120_000, promoteLongs: false,
})
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

try {
  await client.connect()

  // ── 1. Toàn bộ đơn affiliate (cùng filter marker với cron) — projection tối thiểu
  const orders = await client.db(ORDER_DB).collection(ORDER_COLL)
    .find(
      { affiliate_partner_code: { $exists: true, $nin: [null, ''] } },
      { projection: { _id: 0, order_id: 1, account_id: 1, customer_phone: 1, affiliate_partner_code: 1, status: 1, total_price: 1, completed_time: 1, last_updated_time: 1 }, maxTimeMS: 60_000 },
    )
    .toArray()

  const delivered = orders.filter((o) => o.status === 'DELIVERED')

  // ── 2. Phân bố BSON type của account_id (tham khảo — chốt parser)
  const typeDist = {}
  for (const o of delivered) {
    const t = bsonType(o.account_id)
    typeDist[t] = (typeDist[t] ?? 0) + 1
  }

  // ── 3. IDENTITY = buyer phone chuẩn hóa (mig 104). `acc` giữ TÊN BIẾN cho
  // lõi dùng chung (dedup/cross-store theo key) nhưng GIÁ TRỊ là phone string.
  const withIdentity = []
  const missingPhone = []
  for (const o of delivered) {
    const phone = normalizeVnPhone(typeof o.customer_phone === 'string' ? o.customer_phone : null)
    if (phone !== null) withIdentity.push({ ...o, acc: phone })
    else missingPhone.push(o)
  }
  // DIAGNOSTIC (không còn identity): đơn thiếu account_id.
  const missingAccount = delivered.filter((o) => {
    const a = toSafeInt(o.account_id)
    return a === null || a <= 0
  })

  // ── 4. DIAGNOSTIC: account có đơn DELIVERED nhưng KHÔNG có trong customer
  // (mig 104: chỉ theo dõi chất lượng nguồn — KHÔNG còn là gate release).
  const distinctAccounts = [...new Set(delivered
    .map((o) => toSafeInt(o.account_id))
    .filter((a) => a !== null && a > 0))]
  const foundAccounts = new Set()
  const CHUNK = 500
  for (let i = 0; i < distinctAccounts.length; i += CHUNK) {
    const chunk = distinctAccounts.slice(i, i + CHUNK)
    const rows = await client.db(CUSTOMER_DB).collection(CUSTOMER_COLL)
      .find({ account_id: { $in: chunk } }, { projection: { _id: 0, account_id: 1 }, maxTimeMS: 60_000 })
      .toArray()
    for (const r of rows) {
      const a = toSafeInt(r.account_id)
      if (a !== null) foundAccounts.add(a)
    }
  }
  const missingCustomer = distinctAccounts.filter((a) => !foundAccounts.has(a))

  // ── 5. Gate 3: account xuất hiện dưới >1 điểm attribution.
  // Attribution = partner_code → affiliate_partner_mappings → store_id (contract
  // KPI); mapping fs store NULL → điểm = 'partner:<code>' (khớp model overview).
  const { data: mapRows, error: mapErr } = await svc
    .from('affiliate_partner_mappings')
    .select('partner_code, store_id, is_active, stores(code, store_type, is_active)')
  if (mapErr) throw new Error(`Đọc mappings Supabase: ${mapErr.message}`)
  // r1.3.1 P1: eligibility qua LIB thuần — mapping active + store os + store
  // active (đúng tập activation/runtime cho phép); FS/inactive đếm riêng.
  const pointByCode = buildPointByCode(mapRows)
  const eligiblePoints = [...pointByCode.values()].filter((pt) => pt.isOsActive)
  const eligiblePos = new Set(eligiblePoints.map((pt) => pt.posCode))
  if (posFilter) {
    const unknown = [...posFilter].filter((c) => !eligiblePos.has(c))
    if (unknown.length > 0) {
      throw new Error('QA_CUSTOMER_POS_CODES có mã KHÔNG thuộc tập OS active: ' + unknown.join(', '))
    }
  }

  const pointsByAccount = new Map()
  for (const o of withIdentity) {
    const point = pointByCode.get(o.affiliate_partner_code)?.key ?? `unmapped:${o.affiliate_partner_code}`
    if (!pointsByAccount.has(o.acc)) pointsByAccount.set(o.acc, new Set())
    pointsByAccount.get(o.acc).add(point)
  }
  const crossStore = [...pointsByAccount.entries()].filter(([, points]) => points.size > 1)

  // ── 6. Tham khảo: đơn DELIVERED total_price ≤ 0 (bị loại khỏi count theo contract)
  const nonPositive = delivered.filter((o) => {
    const p = toNum(o.total_price)
    return p === null || p <= 0
  })

  // ── 7. METRIC BASELINE (r1 P2#4 — TÁCH khỏi identity coverage, CÙNG contract
  // với rpc_aggregate_affiliate_customers): delivered + account hợp lệ +
  // total_price > 0 + CÓ completed_time + điểm attribution là STORE (mapping
  // store_id — partner:/unmapped nằm ngoài p_store_ids của RPC). Dedup THEO
  // TỪNG THÁNG VN (mirror chạy RPC từng tháng): 1 account = 1 khách tại điểm
  // của đơn DELIVERED sớm nhất trong tháng, tie-break order_id — output theo
  // store/tháng để đối soát TRỰC TIẾP với RPC sau migration.
  // r1.3.1: normalize BSON 1 lần rồi qua LIB — 2 tập tách bạch: osActive
  // (baseline/cross/remediation — CHỈ OS active, tôn trọng posFilter) vs allStorePoints
  // (diagnostic — mọi điểm có store kể cả FS/inactive).
  const normRows = withIdentity.map((o) => ({
    acc: o.acc,
    rawAccountId: o.account_id,
    orderId: toSafeInt(o.order_id) ?? Number.MAX_SAFE_INTEGER,
    price: toNum(o.total_price),
    completedTimeMs: o.completed_time instanceof Date ? o.completed_time.getTime() : null,
    partnerCode: o.affiliate_partner_code,
  }))
  const { osActive: qualifyingOsActive, allStorePoints: qualifyingAllPoints, excluded: baselineExcluded } =
    qualifyOrders(normRows, pointByCode, posFilter)
  const byMonthOrders = new Map()
  for (const q of qualifyingAllPoints) {
    const vnMonth = new Date(q.t + 7 * 3600_000).toISOString().slice(0, 7)
    if (!byMonthOrders.has(vnMonth)) byMonthOrders.set(vnMonth, [])
    byMonthOrders.get(vnMonth).push(q)
  }

  // ── 8. DIAGNOSTIC + RELEASE SCOPE (r1.3.2: logic nằm trong LIB thuần) ──
  // 8a. PHÂN LOẠI missing_account_id qua classifyMissingAccount — bucket
  // os_outside_pos_filter (P1#1): OS active NGOÀI subset không được block
  // release scoped. Bucket quyết định = os_in_range_qualifying.
  const normMissing = missingPhone.map((o) => ({
    orderId: toSafeInt(o.order_id) ?? String(o.order_id),
    price: toNum(o.total_price),
    completedTimeMs: o.completed_time instanceof Date ? o.completed_time.getTime() : null,
    partnerCode: o.affiliate_partner_code,
  }))
  const missCls = classifyMissingIdentity(normMissing, pointByCode, rangeMs, posFilter)

  // 8b. CROSS-STORE trong exact range — CHỈ tập OS ACTIVE (r1.3.1 P1#1),
  // identity theo pointKey store:<uuid> (P2#3 — label/POS chỉ hiển thị),
  // kèm winner theo earliest-order rule (tie-break order_id nhỏ).
  const crossInRange = rangeMs
    ? crossStoreCases(qualifyingOsActive.filter((q) => q.t >= rangeMs.from && q.t < rangeMs.to))
        .map((c) => ({
          account: c.account,
          orders: c.orders.map((x) => ({
            order_id: x.orderId, partner_code: x.partnerCode, point: x.posCode,
            point_key: x.pointKey, completed_time: new Date(x.t).toISOString(),
          })),
          winner: { order_id: c.winner.orderId, point: c.winner.posCode, point_key: c.winner.pointKey },
        }))
    : []

  // 8c. EXACT-RANGE baseline (hoisted) — CHỈ qualifyingOsActive; per_store
  // key hiển thị = POS code, dedup/winner theo pointKey trong lib.
  let exactBaseline = null
  if (rangeMs) {
    const inRange = qualifyingOsActive.filter((q) => q.t >= rangeMs.from && q.t < rangeMs.to)
    const best = dedupWinners(inRange)
    const perStore = {}
    for (const w of best.values()) perStore[w.posCode] = (perStore[w.posCode] ?? 0) + 1
    exactBaseline = { total_customers: best.size, per_store: perStore }
  }

  // 8d. RELEASE SCOPE (r1.3.2): tập điểm trong scope (OS active → posFilter →
  // unique store_id — P2#3) + missing_customer SCOPED (account của đơn
  // qualifying TRONG range không tồn tại trong customer collection).
  const scopedPoints = scopePoints(pointByCode, posFilter)
  const inRangeOsOrders = rangeMs
    ? qualifyingOsActive.filter((q) => q.t >= rangeMs.from && q.t < rangeMs.to)
    : []
  // (diagnostic) account của đơn qualifying in-range không có trong customer.
  const eligibleMissingCustomerAccs = [...new Set(inRangeOsOrders
    .map((q) => toSafeInt(q.rawAccountId))
    .filter((a) => a !== null && a > 0))].filter((a) => !foundAccounts.has(a))

  // 8e. RUNTIME READINESS (r1.3.3 + 104 r1) — mirror canary RPC 104: TOÀN BỘ
  // đơn DELIVERED (Mongo full snapshot = source hiện hành) trên scoped OS
  // stores, KHÔNG lọc range/total_price. Đơn cũ ngoài tháng campaign thiếu
  // account_id/completed_time VẪN chặn activation/sync → phải là gate cứng.
  const runtimeRows = delivered.map((o) => {
    const a = toSafeInt(o.account_id)
    return {
      orderId: toSafeInt(o.order_id) ?? String(o.order_id),
      partnerCode: o.affiliate_partner_code,
      hasPhone: normalizeVnPhone(typeof o.customer_phone === 'string' ? o.customer_phone : null) !== null,
      hasAccount: a !== null && a > 0,
      hasCompleted: o.completed_time instanceof Date,
      completedTimeMs: o.completed_time instanceof Date ? o.completed_time.getTime() : null,
      price: toNum(o.total_price),
    }
  })
  const runtime = runtimeReadiness(runtimeRows, pointByCode, posFilter, rangeMs)

  const gateReport = buildGateReport({
    rangeProvided: !!rangeMs,
    eligibleMissingPhone: missCls.os_in_range_qualifying.length,
    eligibleCrossStore: crossInRange.length,
    runtimeMissingPhone: runtime.missingPhone.length,
    runtimeMissingCompleted: runtime.missingCompleted.length,
    runtimeMissingPhoneOutOfRange: runtime.missingPhoneOutOfRange.length,
    globalMissingPhone: missingPhone.length,
    globalMissingAccount: missingAccount.length,
    globalMissingCustomer: missingCustomer.length,
    globalCrossStore: crossStore.length,
  })

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log('\n=== PHASE 0 — Affiliate Customer identity proof ===')
  console.log(`Nguồn: ${ORDER_DB}.${ORDER_COLL} + ${CUSTOMER_DB}.${CUSTOMER_COLL}\n`)
  console.table({
    total_affiliate_orders: orders.length,
    total_delivered: delivered.length,
    with_customer_phone: withIdentity.length,
    missing_customer_phone: missingPhone.length,
    distinct_customers_phone: new Set(withIdentity.map((o) => o.acc)).size,
    missing_account_id_diagnostic: missingAccount.length,
    distinct_accounts_diagnostic: distinctAccounts.length,
    missing_customer_diagnostic: missingCustomer.length,
    cross_store_customers: crossStore.length,
    non_positive_orders: nonPositive.length,
  })
  console.log('BSON type của account_id (DELIVERED, diagnostic):', JSON.stringify(typeDist))
  console.log('\nMETRIC BASELINE (mirror RPC: delivered · price>0 · có completed_time · điểm OS ACTIVE'
    + (posFilter ? ` · SUBSET ${[...posFilter].sort().join(',')}` : '') + '):')
  console.log('  loại khỏi baseline (KHÔNG tính vào gate identity):', JSON.stringify(baselineExcluded))
  console.log(`  tập điểm trong scope: ${scopedPoints.length} OS store active (unique store)`
    + (posFilter ? ' — SUBSET theo QA_CUSTOMER_POS_CODES' : ''))
  if (rangeMs) {
    // r1.1 P2: EXACT RANGE — dedup trên TOÀN range như RPC nhận p_from/p_to.
    const detail = Object.entries(exactBaseline.per_store).sort()
      .map(([k, v]) => `${k}=${v}`).join(' · ') || '(không có khách)'
    console.log(`  EXACT RANGE ${RANGE_FROM} → ${RANGE_TO} (half-open VN [${RANGE_FROM} 00:00, ngày-sau-${RANGE_TO} 00:00)):`)
    console.log(`    ${exactBaseline.total_customers} khách — ${detail}`)
    console.log('    → đối soát TRỰC TIẾP với rpc_aggregate_affiliate_customers cùng range sau migration.')
  } else {
    console.log('  (không đặt QA_CUSTOMER_FROM/TO → bỏ qua exact-range; đặt cặp biến để đối soát đúng range campaign)')
  }
  console.log('  DIAGNOSTIC theo tháng VN (MỌI điểm store kể cả FS/inactive, dedup RIÊNG từng tháng — chỉ tham khảo):')
  for (const [m, orders] of [...byMonthOrders.entries()].sort()) {
    const best = dedupWinners(orders)
    const perStore = new Map()
    for (const w of best.values()) perStore.set(w.posCode, (perStore.get(w.posCode) ?? 0) + 1)
    const detail = [...perStore.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' · ')
    console.log(`  ${m}: ${best.size} khách — ${detail}`)
  }

  if (missingPhone.length > 0) {
    console.log('\nSample DELIVERED thiếu SĐT khách hợp lệ (≤10):',
      missingPhone.slice(0, 10).map((o) => toSafeInt(o.order_id) ?? String(o.order_id)).join(', '))
  }
  if (missingAccount.length > 0) {
    console.log('(diagnostic) Sample DELIVERED thiếu account_id (≤10):',
      missingAccount.slice(0, 10).map((o) => toSafeInt(o.order_id) ?? String(o.order_id)).join(', '))
  }
  if (missingCustomer.length > 0) {
    console.log('(diagnostic) Sample account KHÔNG có trong customer (≤10):', missingCustomer.slice(0, 10).join(', '))
  }
  if (crossStore.length > 0) {
    console.log('Sample cross-store toàn lịch sử (≤10, SĐT ĐÃ MASK):')
    for (const [phone, points] of crossStore.slice(0, 10)) {
      console.log(`  khách ${mask(phone)}: ${[...points].join(' · ')}`)
    }
  }
  console.log('\n=== DIAGNOSTIC — PHÂN LOẠI đơn thiếu SĐT khách (quyết định source remediation) ===')
  console.log('  precedence: non_os_point → os_inactive_point → os_outside_pos_filter → disqualified(giá/completed_time) → theo range')
  for (const [k, arr] of Object.entries(missCls)) {
    console.log(`  ${k}: ${arr.length}`)
    for (const e of arr.slice(0, 10)) {
      console.log(`    ${e.order_id} · ${e.partner_code} · ${e.point} · ${e.completed_time ?? 'KHÔNG completed_time'} · price=${e.total_price}`)
    }
  }

  console.log('\n=== R1.3 DIAGNOSTIC — CROSS-STORE ===')
  console.log(`  toàn lịch sử (khách theo SĐT, điểm theo pointKey — kể cả partner/unmapped): ${crossStore.length} account`)
  console.log('  trong exact range (CHỈ tập OS active, identity pointKey): '
    + (rangeMs ? `${crossInRange.length} account` : 'KHÔNG XÁC ĐỊNH — thiếu QA_CUSTOMER_FROM/TO'))
  for (const c of crossInRange.slice(0, 10)) {
    console.log(`  khách ${mask(String(c.account))} — WINNER: đơn ${c.winner.order_id} @ ${c.winner.point} [${c.winner.point_key}] (earliest-order rule, trong range + tập store target)`)
    for (const o of c.orders) console.log(`    ${o.order_id} · ${o.partner_code} · ${o.point} [${o.point_key}] · ${o.completed_time}`)
  }

  const sampleN = Math.min(20, withIdentity.length)
  console.log(`\nMẫu đối soát tay — in ${sampleN}/${withIdentity.length} đơn có identity (SĐT MASK · order_id · partner_code):`)
  for (const o of withIdentity.slice(0, sampleN)) {
    console.log(`  ${mask(o.acc)} · ${toSafeInt(o.order_id) ?? '?'} · ${o.affiliate_partner_code}`)
  }

  // r1.3: JSON summary — đối soát TỰ ĐỘNG (parser tìm marker '=== JSON SUMMARY ===').
  const summary = {
    // r1.3.5 (audit P2): timestamp evidence — số khách là dữ liệu SỐNG, hai
    // lần chạy có thể lệch; generated_at + mốc update mới nhất của nguồn cho
    // phép đối chiếu baseline nào là bản chốt.
    generated_at: new Date().toISOString(),
    max_order_updated_at: (() => {
      let max = null
      for (const o of orders) {
        if (o.last_updated_time instanceof Date && (max === null || o.last_updated_time.getTime() > max)) {
          max = o.last_updated_time.getTime()
        }
      }
      return max === null ? null : new Date(max).toISOString()
    })(),
    generated_range: rangeMs ? { from: RANGE_FROM, to: RANGE_TO } : null,
    // r1.3.1 #7: scope tường minh — baseline/cross/remediation CHỈ trên OS active.
    scope: posFilter ? 'os_active_subset' : 'os_active_only',
    pos_filter: posFilter ? [...posFilter].sort() : null,
    // r1.3.2 P2#3: metadata theo ĐÚNG scope (posFilter áp dụng, unique store).
    eligible_store_ids: scopedPoints.map((pt) => pt.storeId).sort(),
    eligible_pos_codes: scopedPoints.map((pt) => pt.posCode).sort(),
    excluded_fs_count: baselineExcluded.fs_or_non_os,
    excluded_inactive_count: baselineExcluded.os_inactive,
    totals: {
      total_affiliate_orders: orders.length,
      total_delivered: delivered.length,
      with_customer_phone: withIdentity.length,
      missing_customer_phone: missingPhone.length,
      distinct_customers_phone: new Set(withIdentity.map((o) => o.acc)).size,
      missing_account_id_diagnostic: missingAccount.length,
      distinct_accounts_diagnostic: distinctAccounts.length,
      missing_customer_diagnostic: missingCustomer.length,
      cross_store_customers_all_history: crossStore.length,
      cross_store_customers_in_range: rangeMs ? crossInRange.length : null,
      non_positive_orders: nonPositive.length,
    },
    // r1.3.3: 3 tầng gate — exit = runtime AND release; diagnostic chỉ cảnh báo.
    runtime_readiness_gates: {
      missing_customer_phone_in_range: runtime.missingPhone.length,
      missing_completed_time: runtime.missingCompleted.length,
      missing_customer_phone_sample: runtime.missingPhone.slice(0, 10),
      missing_completed_sample: runtime.missingCompleted.slice(0, 10),
      missing_customer_phone_out_of_range_diagnostic: runtime.missingPhoneOutOfRange.length,
      missing_account_id_diagnostic: runtime.missingAccountDiagnostic.length,
      pass: gateReport.runtime.every(([, ok]) => ok),
    },
    release_decision_gates: {
      exact_range_provided: !!rangeMs,
      eligible_missing_customer_phone: missCls.os_in_range_qualifying.length,
      eligible_cross_store_customers: crossInRange.length,
      eligible_missing_customer_diagnostic: eligibleMissingCustomerAccs.length,
      pass: gateReport.release.every(([, ok]) => ok),
    },
    overall_pass: gateReport.exitCode === 0,
    diagnostic_gates: {
      missing_customer_phone_all_history: missingPhone.length,
      missing_account_id: missingAccount.length,
      missing_customer: missingCustomer.length,
      cross_store_customers_all_history: crossStore.length,
    },
    missing_phone_classification: Object.fromEntries(
      Object.entries(missCls).map(([k, arr]) => [k, { count: arr.length, sample: arr.slice(0, 10) }])),
    cross_store_in_range_samples: crossInRange.slice(0, 10),
    exact_range_baseline: exactBaseline,
    baseline_excluded: baselineExcluded,
  }
  console.log('\n=== JSON SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))

  // r1.3.3: exit = runtime AND release; global = cảnh báo.
  console.log('\n=== RUNTIME READINESS GATES (mirror canary RPC 104 — phone: đơn đủ điều kiện TRONG range; completed_time: toàn lịch sử; scoped OS stores) ===')
  for (const [label, ok] of gateReport.runtime) {
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label)
  }
  for (const [name, arr] of [
    ['thiếu SĐT khách (TRONG range — BLOCKING)', runtime.missingPhone],
    ['thiếu completed_time (toàn lịch sử — BLOCKING)', runtime.missingCompleted],
    ['thiếu SĐT khách NGOÀI range (diagnostic)', runtime.missingPhoneOutOfRange],
    ['thiếu account_id (diagnostic — không còn là identity)', runtime.missingAccountDiagnostic],
  ]) {
    if (arr.length > 0) {
      console.log(`  sample ${name} (≤10):`)
      for (const e of arr.slice(0, 10)) console.log(`    ${e.order_id} · ${e.partner_code} · ${e.point}`)
    }
  }
  console.log('=== RELEASE DECISION GATES (scoped: exact range · OS active · POS filter) ===')
  for (const [label, ok] of gateReport.release) {
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label)
  }
  console.log('=== DIAGNOSTIC GATES (toàn lịch sử — CẢNH BÁO, không quyết exit code) ===')
  for (const [label, ok] of gateReport.diagnostic) {
    console.log((ok ? 'PASS' : 'WARN').padEnd(5), label)
  }
  const failedHard = [...gateReport.runtime, ...gateReport.release].filter(([, ok]) => !ok).length
  if (failedHard > 0) {
    console.log(`\n${failedHard} gate (runtime readiness / release) FAIL — DỪNG: chưa đủ điều kiện bước SOURCE REMEDIATION/BACKFILL nguồn trong scope đã chọn; gửi output (kèm JSON SUMMARY) cho stakeholder duyệt rule.`)
  } else {
    console.log('\nALL RUNTIME + RELEASE GATES PASS — đủ điều kiện bước source remediation/backfill nguồn trong scope đã chọn.')
    console.log('⚠ đây là proof trên MONGO NGUỒN. Sau deploy + full sync, verify TRỰC TIẾP Supabase trước khi bật flag:')
    const scopeIds = scopedPoints.map((pt) => "'" + pt.storeId + "'").join(', ')
    console.log('  [1] HARD GATE identity — đơn ĐỦ ĐIỀU KIỆN ĐẾM trong ĐÚNG kỳ campaign (kỳ vọng 0):')
    console.log('      SELECT count(*) AS missing_customer_phone_in_range')
    console.log('      FROM public.affiliate_orders o')
    console.log("      WHERE o.source_active AND o.status_norm = 'delivered'")
    console.log('        AND o.total_price > 0 AND o.completed_time IS NOT NULL')
    console.log('        AND o.customer_phone_norm IS NULL')
    console.log('        AND o.store_id IN (' + scopeIds + ')')
    if (rangeMs) {
      console.log("        AND o.completed_time >= '" + RANGE_FROM + " 00:00:00+07'")
      console.log("        AND o.completed_time <  ('" + RANGE_TO + " 00:00:00+07'::timestamptz + interval '1 day');")
    } else {
      console.log('        AND o.completed_time >= <campaign start 00:00+07>')
      console.log('        AND o.completed_time <  <campaign end + 1 ngày 00:00+07>;   -- half-open')
    }
    console.log('  [2] HARD GATE completed_time — TOÀN LỊCH SỬ trên target stores (kỳ vọng 0):')
    console.log('      SELECT count(*) AS missing_completed_time')
    console.log('      FROM public.affiliate_orders o')
    console.log("      WHERE o.source_active AND o.status_norm = 'delivered'")
    console.log('        AND o.completed_time IS NULL')
    console.log('        AND o.store_id IN (' + scopeIds + ');')
    console.log('  [3] DIAGNOSTIC — account_id (mig 104: KHÔNG còn là identity, KHÔNG kỳ vọng 0, KHÔNG chặn release):')
    console.log('      SELECT count(*) AS missing_account_id_diagnostic')
    console.log('      FROM public.affiliate_orders o')
    console.log("      WHERE o.source_active AND o.status_norm = 'delivered'")
    console.log('        AND o.account_id IS NULL')
    console.log('        AND o.store_id IN (' + scopeIds + ');')
    console.log('  -- scope: ' + scopedPoints.length + ' OS store active'
      + (posFilter ? ' (SUBSET QA_CUSTOMER_POS_CODES)' : '') + ' — CHỈ [1] và [2] phải = 0 rồi mới mở QA UI/flag.')
  }
  // r1.2: KHÔNG process.exit trong try — exit bỏ qua finally, Mongo client
  // không close → libuv assertion crash teardown (Windows). Set code, close
  // sạch ở finally rồi mới exit.
  exitCode = gateReport.exitCode
} finally {
  await client.close()
}
// r1.3.4: run thật 07-08/08 cho thấy process.exit() NGAY SAU client.close()
// vẫn abort 0xC0000409 (libuv assertion — race teardown uv_async của Mongo
// driver trên Windows) → PROOF_EXIT rác. Fix: set exitCode cho loop drain tự
// nhiên; fallback force-exit 3s (unref — timer không tự giữ loop).
process.exitCode = exitCode
setTimeout(() => process.exit(exitCode), 3000).unref()
