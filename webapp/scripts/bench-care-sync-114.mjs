// BENCH B5b.2 (SPEC §B5b: "Đo RPC thực với statement_timeout 8 giây trước rollout") — PGlite, KHÔNG phải số
// prod. Nạp nhanh N khách × 1 task kỳ 10 × 1 lượt terminal (superuser, generate_series), rồi đo:
//   · care_order_sync_candidates(20000) với N khoảng (một jsonb),
//   · care_order_sync_apply với M đơn (upsert + care_recompute_attribution + queue + trạng thái).
// PGlite là Postgres WASM một luồng ⇒ thường CHẬM hơn prod; con số chỉ để phát hiện thuật toán bùng nổ.
// Ngân sách: mỗi RPC < 8 s (= statement_timeout/lock_timeout của authenticator trên prod, lệnh PM Lô 4) ⇒ vượt
// thì exit 1. PGlite KHÔNG thi hành statement_timeout nên phải tự so thời gian; số thật đo trên prod ở B6.
//   cd webapp && node scripts/bench-care-sync-114.mjs [N=20000] [M=20000]
import { PGlite } from '@electric-sql/pglite'
import * as L from './lib-care-pglite.mjs'

const N = Number(process.argv[2] ?? 20000)
const M = Number(process.argv[3] ?? 20000)
const BUDGET_MS = 8_000
const over = []
const db = await L.freshDb(PGlite, { through: '114' }) // bench 114: INSERT batch committed trực tiếp (115 có rào commit)
const t = async (label, fn, budget = false) => {
  const t0 = performance.now(); const r = await fn(); const ms = performance.now() - t0
  console.log(`${label}: ${ms.toFixed(0)} ms${budget ? (ms < BUDGET_MS ? ' (< 8 s ✅)' : ' (≥ 8 s ❌)') : ''}`)
  if (budget && ms >= BUDGET_MS) over.push(label)
  return r
}

await t(`nạp ${N} khách/task/lượt terminal`, async () => {
  const batch = (await db.query(`INSERT INTO public.care_import_batches (period_month, kind, status, file_name, file_sha256, row_count, created_by, finished_at)
    VALUES ('2026-10-01', 'initial', 'committed', 'bench.xlsx', repeat('a', 64), $1, $2, now()) RETURNING id`, [N, L.U.mkt])).rows[0].id
  await db.query(`INSERT INTO public.care_customers (external_id) SELECT 'BENCH-' || g FROM generate_series(1, $1) g`, [N])
  await db.query(`INSERT INTO public.care_tasks (customer_id, period_month, due_date, batch_id, store_id, assignee_id, customer_name, phone_norm, phone_raw)
    SELECT c.id, '2026-10-01', '2026-10-31', $1, $2, $3, 'KH bench', '0390000999', '0390000999' FROM public.care_customers c WHERE c.external_id LIKE 'BENCH-%'`,
    [batch, L.storeId(1), L.U.A])
  await db.query(`INSERT INTO public.care_interactions (task_id, customer_id, actor_id, assignee_id, store_id, period_month, outcome, is_terminal, note, created_at)
    SELECT t.id, t.customer_id, t.assignee_id, t.assignee_id, t.store_id, t.period_month, 'INTERESTED', true, 'bench',
           timestamptz '2026-10-02 00:00:00+00' + (row_number() OVER (ORDER BY t.id)) * interval '1 second'
    FROM public.care_tasks t`)
  await db.query(`ANALYZE`)
})
const svc = (sql, params) => L.as(db, null, async () => (await db.query(sql, params)).rows[0].r, 'service_role')
const cand = await t(`care_order_sync_candidates(20000) — ${N} khoảng`, () => svc(`SELECT public.care_order_sync_candidates(20000) r`, []), true)
console.log(`  windows=${cand.windows} customers=${cand.customers} items=${cand.items.length} jsonb≈${(JSON.stringify(cand).length / 1024 / 1024).toFixed(2)} MB`)
const orders = Array.from({ length: M }, (_, i) => ({ customer_external_id: `BENCH-${i + 1}`, order_key: `DHC-BENCH-${i + 1}`, ordered_at: '2026-10-08T00:00:00.000000Z' }))
const ap = await t(`care_order_sync_apply — ${M} đơn`, () => svc(`SELECT public.care_order_sync_apply($1::jsonb, $2::timestamptz) r`, [JSON.stringify(orders), cand.snapshot_at]), true)
console.log(`  ${JSON.stringify(ap)}`)
await t(`care_order_sync_apply lặp (idempotent) — ${M} đơn`, () => svc(`SELECT public.care_order_sync_apply($1::jsonb, $2::timestamptz) r`, [JSON.stringify(orders), cand.snapshot_at]), true)
const cand2 = await t(`care_order_sync_candidates sau apply`, () => svc(`SELECT public.care_order_sync_candidates(20000) r`, []), true)
console.log(`  windows=${cand2.windows} (kỳ vọng ${N - M})`)
await db.close()
if (over.length) { console.log(`VƯỢT ngân sách 8 s: ${over.join('; ')}`); process.exit(1) }
console.log('mọi RPC < 8 s (PGlite)')
