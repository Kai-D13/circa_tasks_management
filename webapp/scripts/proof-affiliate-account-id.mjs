// PHASE 0 — DATA PROOF cho Affiliate Customer Campaign (handoff 06/08).
// READ-ONLY tuyệt đối: KHÔNG ghi Mongo, KHÔNG ghi Supabase. Chạy TRƯỚC khi
// audit/chạy migration 103:
//   cd webapp && node scripts/proof-affiliate-account-id.mjs     (cần VPN netbird)
//
// Chứng minh identity `order.account_id ↔ customer.account_id` trên dữ liệu
// THẬT + đo coverage. GATE (handoff — lệch 0 là DỪNG, trả stakeholder):
//   missing_account_id  = 0   (đơn DELIVERED thiếu/hỏng account_id)
//   missing_customer    = 0   (account có đơn DELIVERED nhưng không có trong customer)
//   cross_store_accounts = 0  (account xuất hiện dưới >1 điểm attribution)
// Exit code ≠ 0 khi bất kỳ gate nào fail (hoặc lỗi kết nối).
//
// Nguồn: Mongo order (AFFILIATE_MONGO_DB/COLLECTION — mặc định như cron) +
// Mongo customer (cùng URI — user xác nhận 06/08 reader đọc được
// circa-online_prd_consumer.customer) + Supabase affiliate_partner_mappings
// (SELECT qua service key — chỉ đọc). Cron production KHÔNG pull customer —
// collection này chỉ phục vụ preflight/audit (chốt handoff).
import fs from 'node:fs'
import { MongoClient } from 'mongodb'
import { createClient } from '@supabase/supabase-js'

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
      { projection: { _id: 0, order_id: 1, account_id: 1, affiliate_partner_code: 1, status: 1, total_price: 1, completed_time: 1 }, maxTimeMS: 60_000 },
    )
    .toArray()

  const delivered = orders.filter((o) => o.status === 'DELIVERED')

  // ── 2. Phân bố BSON type của account_id (tham khảo — chốt parser)
  const typeDist = {}
  for (const o of delivered) {
    const t = bsonType(o.account_id)
    typeDist[t] = (typeDist[t] ?? 0) + 1
  }

  // ── 3. Gate 1: DELIVERED thiếu/hỏng account_id
  const withAccount = []
  const missingAccount = []
  for (const o of delivered) {
    const acc = toSafeInt(o.account_id)
    if (acc !== null && acc > 0) withAccount.push({ ...o, acc })
    else missingAccount.push(o)
  }

  // ── 4. Gate 2: account có đơn DELIVERED nhưng KHÔNG tồn tại trong customer
  const distinctAccounts = [...new Set(withAccount.map((o) => o.acc))]
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
    .select('partner_code, store_id, stores(code, store_type)')
  if (mapErr) throw new Error(`Đọc mappings Supabase: ${mapErr.message}`)
  const pointByCode = new Map(mapRows.map((m) => [m.partner_code, {
    key: m.store_id ? `store:${m.store_id}` : `partner:${m.partner_code}`,
    label: m.store_id ? (m.stores?.code ?? m.store_id) : `partner:${m.partner_code}`,
    isStore: !!m.store_id,
    // r1.3: phân biệt OS/FS-store cho classification (quyết định mig 104).
    isOs: !!m.store_id && m.stores?.store_type === 'os',
  }]))

  const pointsByAccount = new Map()
  for (const o of withAccount) {
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
  const baselineExcluded = { non_positive: 0, no_completed_time: 0, non_store_point: 0 }
  const qualifying = []
  for (const o of withAccount) {
    const price = toNum(o.total_price)
    if (price === null || price <= 0) { baselineExcluded.non_positive++; continue }
    if (!(o.completed_time instanceof Date)) { baselineExcluded.no_completed_time++; continue }
    const point = pointByCode.get(o.affiliate_partner_code)
    if (!point || !point.isStore) { baselineExcluded.non_store_point++; continue }
    qualifying.push({
      acc: o.acc, orderId: toSafeInt(o.order_id) ?? Number.MAX_SAFE_INTEGER,
      t: o.completed_time.getTime(), label: point.label,
      partnerCode: o.affiliate_partner_code,
    })
  }
  const byMonthOrders = new Map()
  for (const q of qualifying) {
    const vnMonth = new Date(q.t + 7 * 3600_000).toISOString().slice(0, 7)
    if (!byMonthOrders.has(vnMonth)) byMonthOrders.set(vnMonth, [])
    byMonthOrders.get(vnMonth).push(q)
  }
  // Dedup dùng chung: 1 account = 1 khách tại điểm của đơn sớm nhất (tie-break order_id).
  const dedupWinners = (orders) => {
    const best = new Map()
    for (const o of orders) {
      const cur = best.get(o.acc)
      if (!cur || o.t < cur.t || (o.t === cur.t && o.orderId < cur.orderId)) best.set(o.acc, o)
    }
    return best
  }

  // ── 8. R1.3 DIAGNOSTIC (plan auditor 07/08 — dữ kiện quyết định mig 104) ──
  // 8a. PHÂN LOẠI missing_account_id. Precedence tường minh (bucket rời nhau):
  //   non_os_point (điểm FS-store/partner/unmapped — ngoài scope campaign OS)
  //   → disqualified_price_or_time (giá ≤0/thiếu completed_time — RPC vốn loại)
  //   → os_in_range_qualifying / os_out_of_range (theo exact range).
  // Bucket QUYẾT ĐỊNH 104 = os_in_range_qualifying: =0 → guard scope theo
  // range/OS/price; >0 → Circa Online backfill nguồn (không âm thầm bỏ khách).
  const missCls = {
    os_in_range_qualifying: [], os_out_of_range: [], os_range_unknown: [],
    non_os_point: [], disqualified_price_or_time: [],
  }
  for (const o of missingAccount) {
    const point = pointByCode.get(o.affiliate_partner_code)
    const price = toNum(o.total_price)
    const hasTime = o.completed_time instanceof Date
    const entry = {
      order_id: toSafeInt(o.order_id) ?? String(o.order_id),
      partner_code: o.affiliate_partner_code,
      point: point ? point.label : `unmapped:${o.affiliate_partner_code}`,
      completed_time: hasTime ? o.completed_time.toISOString() : null,
      total_price: price,
    }
    if (!point || !point.isOs) missCls.non_os_point.push(entry)
    else if (price === null || price <= 0 || !hasTime) missCls.disqualified_price_or_time.push(entry)
    else if (!rangeMs) missCls.os_range_unknown.push(entry)
    else if (o.completed_time.getTime() >= rangeMs.from && o.completed_time.getTime() < rangeMs.to) {
      missCls.os_in_range_qualifying.push(entry)
    } else missCls.os_out_of_range.push(entry)
  }

  // 8b. CROSS-STORE trong exact range — CHỈ đơn qualifying (price>0 + có
  // completed_time + điểm store), kèm winner theo earliest-order rule để
  // stakeholder thấy rule dedup xử lý từng ca thế nào.
  const crossInRange = []
  if (rangeMs) {
    const byAcc = new Map()
    for (const q of qualifying) {
      if (q.t < rangeMs.from || q.t >= rangeMs.to) continue
      if (!byAcc.has(q.acc)) byAcc.set(q.acc, [])
      byAcc.get(q.acc).push(q)
    }
    for (const [acc, os] of byAcc) {
      const labels = new Set(os.map((x) => x.label))
      if (labels.size > 1) {
        const winner = [...dedupWinners(os).values()][0]
        crossInRange.push({
          account: acc,
          orders: [...os].sort((a, b) => a.t - b.t || a.orderId - b.orderId)
            .map((x) => ({ order_id: x.orderId, partner_code: x.partnerCode, point: x.label, completed_time: new Date(x.t).toISOString() })),
          winner: { order_id: winner.orderId, point: winner.label },
        })
      }
    }
  }

  // 8c. EXACT-RANGE baseline (hoisted — dùng chung cho print + JSON summary).
  let exactBaseline = null
  if (rangeMs) {
    const inRange = qualifying.filter((q) => q.t >= rangeMs.from && q.t < rangeMs.to)
    const best = dedupWinners(inRange)
    const perStore = {}
    for (const w of best.values()) perStore[w.label] = (perStore[w.label] ?? 0) + 1
    exactBaseline = { total_customers: best.size, per_store: perStore }
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log('\n=== PHASE 0 — Affiliate Customer identity proof ===')
  console.log(`Nguồn: ${ORDER_DB}.${ORDER_COLL} + ${CUSTOMER_DB}.${CUSTOMER_COLL}\n`)
  console.table({
    total_affiliate_orders: orders.length,
    total_delivered: delivered.length,
    with_account_id: withAccount.length,
    missing_account_id: missingAccount.length,
    distinct_accounts: distinctAccounts.length,
    matched_customer: distinctAccounts.length - missingCustomer.length,
    missing_customer: missingCustomer.length,
    cross_store_accounts: crossStore.length,
    non_positive_orders: nonPositive.length,
  })
  console.log('BSON type của account_id (DELIVERED):', JSON.stringify(typeDist))
  console.log('\nMETRIC BASELINE (mirror RPC: delivered · price>0 · có completed_time · store-mapped):')
  console.log('  loại khỏi baseline (KHÔNG tính vào gate identity):', JSON.stringify(baselineExcluded))
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
  console.log('  DIAGNOSTIC theo tháng VN (dedup RIÊNG từng tháng — chỉ tham khảo xu hướng):')
  for (const [m, orders] of [...byMonthOrders.entries()].sort()) {
    const best = dedupWinners(orders)
    const perStore = new Map()
    for (const w of best.values()) perStore.set(w.label, (perStore.get(w.label) ?? 0) + 1)
    const detail = [...perStore.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' · ')
    console.log(`  ${m}: ${best.size} khách — ${detail}`)
  }

  if (missingAccount.length > 0) {
    console.log('\nSample DELIVERED thiếu account_id (≤10):',
      missingAccount.slice(0, 10).map((o) => toSafeInt(o.order_id) ?? String(o.order_id)).join(', '))
  }
  if (missingCustomer.length > 0) {
    console.log('Sample account KHÔNG có trong customer (≤10):', missingCustomer.slice(0, 10).join(', '))
  }
  if (crossStore.length > 0) {
    console.log('Sample cross-store (≤10):')
    for (const [acc, points] of crossStore.slice(0, 10)) console.log(`  account ${acc}: ${[...points].join(' · ')}`)
  }
  console.log('\n=== R1.3 DIAGNOSTIC — PHÂN LOẠI missing_account_id (quyết định mig 104) ===')
  console.log('  precedence: non_os_point → disqualified(giá/completed_time) → theo range')
  for (const [k, arr] of Object.entries(missCls)) {
    console.log(`  ${k}: ${arr.length}`)
    for (const e of arr.slice(0, 10)) {
      console.log(`    ${e.order_id} · ${e.partner_code} · ${e.point} · ${e.completed_time ?? 'KHÔNG completed_time'} · price=${e.total_price}`)
    }
  }

  console.log('\n=== R1.3 DIAGNOSTIC — CROSS-STORE ===')
  console.log(`  toàn lịch sử (mọi điểm, kể cả partner/unmapped): ${crossStore.length} account`)
  console.log('  trong exact range (chỉ đơn qualifying store-point): '
    + (rangeMs ? `${crossInRange.length} account` : 'KHÔNG XÁC ĐỊNH — thiếu QA_CUSTOMER_FROM/TO'))
  for (const c of crossInRange.slice(0, 10)) {
    console.log(`  account ${c.account} — WINNER: đơn ${c.winner.order_id} @ ${c.winner.point} (earliest-order rule)`)
    for (const o of c.orders) console.log(`    ${o.order_id} · ${o.partner_code} · ${o.point} · ${o.completed_time}`)
  }

  console.log('\n20 account mẫu đối soát tay (account_id · order_id · partner_code):')
  for (const o of withAccount.slice(0, 20)) {
    console.log(`  ${o.acc} · ${toSafeInt(o.order_id) ?? '?'} · ${o.affiliate_partner_code}`)
  }

  // r1.3: JSON summary — đối soát TỰ ĐỘNG (parser tìm marker '=== JSON SUMMARY ===').
  const summary = {
    generated_range: rangeMs ? { from: RANGE_FROM, to: RANGE_TO } : null,
    totals: {
      total_affiliate_orders: orders.length,
      total_delivered: delivered.length,
      with_account_id: withAccount.length,
      missing_account_id: missingAccount.length,
      distinct_accounts: distinctAccounts.length,
      missing_customer: missingCustomer.length,
      cross_store_accounts_all_history: crossStore.length,
      cross_store_accounts_in_range: rangeMs ? crossInRange.length : null,
      non_positive_orders: nonPositive.length,
    },
    gates: {
      missing_account_id: missingAccount.length === 0,
      missing_customer: missingCustomer.length === 0,
      cross_store_accounts: crossStore.length === 0,
    },
    missing_account_classification: Object.fromEntries(
      Object.entries(missCls).map(([k, arr]) => [k, { count: arr.length, sample: arr.slice(0, 10) }])),
    cross_store_in_range_samples: crossInRange.slice(0, 10),
    exact_range_baseline: exactBaseline,
    baseline_excluded: baselineExcluded,
  }
  console.log('\n=== JSON SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))

  const gates = [
    ['missing_account_id = 0', missingAccount.length === 0],
    ['missing_customer = 0', missingCustomer.length === 0],
    ['cross_store_accounts = 0', crossStore.length === 0],
  ]
  console.log('\n=== GATES ===')
  let failed = 0
  for (const [label, ok] of gates) {
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label)
    if (!ok) failed++
  }
  if (failed > 0) {
    console.log(`\n${failed} gate FAIL — DỪNG: chưa đủ điều kiện chạy migration 103, gửi output này cho stakeholder duyệt rule.`)
    // r1.2: KHÔNG process.exit trong try — exit bỏ qua finally, Mongo client
    // không close → libuv assertion crash lúc teardown (Windows) + exit code
    // sai. Set code, close sạch ở finally rồi mới exit.
    exitCode = 1
  } else {
    console.log('\nALL GATES PASS — đủ điều kiện tiến hành migration 103 (DRAFT chờ audit).')
  }
} finally {
  await client.close()
}
process.exit(exitCode)
