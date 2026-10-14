// CRM-CSKH B6-qa / B6-qa-ui — gateway PGlite cùng giao diện gateway Supabase của scripts/care-qa-fixture.mjs
// (svc = superuser ~ service_role; as(vai) = SET ROLE authenticated + claim) và repo import trên PGlite cho
// handler thật (lib/care/import/handler.ts). Chỉ dùng trong test — không chạm DB thật.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Filter = [string, 'in' | 'eq' | 'lt', any]
export function where(filters: Filter[]) {
  const parts: string[] = [], params: any[] = []
  for (const [col, op, v] of filters) {
    params.push(v)
    parts.push(op === 'in' ? `${col}::text = ANY($${params.length}::text[])` : op === 'lt' ? `${col} < $${params.length}` : `${col} = $${params.length}`)
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

/** Gateway PGlite: `svc` = superuser (tương đương service_role, bỏ qua RLS); `as(vai)` = SET ROLE authenticated + claim. */
export function pgliteGateway(db: any, L: any, roles: Record<string, string | null>, opts: { failOn?: (op: string, name: string) => boolean; closed?: string[] } = {}) {
  const fail = (op: string, name: string) => { if (opts.failOn?.(op, name)) { const e: any = new Error('giả lập process chết'); e.code = 'SIMULATED'; throw e } }
  const SRF = new Set(['care_report'])
  const rpcSql = (fn: string, args: Record<string, any>) => {
    const keys = Object.keys(args)
    const vals = keys.map((k) => (k === 'p_proof' ? JSON.stringify(args[k]) : args[k]))
    const casts: Record<string, string> = { p_task_ids: '::uuid[]', p_store_ids: '::uuid[]', p_proof: '::jsonb' }
    const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${casts[k] ?? ''}`).join(', ')})`
    return { sql: SRF.has(fn) ? `SELECT * FROM ${call}` : `SELECT ${call} AS r`, vals }
  }
  const ops = (run: <T>(fn: () => Promise<T>) => Promise<T>) => ({
    async select(table: string, cols: string, filters: Filter[]) { const w = where(filters); return run(async () => (await db.query(`SELECT ${cols} FROM public.${table} ${w.sql}`, w.params)).rows) },
    async count(table: string, filters: Filter[]) { const w = where(filters); return run(async () => Number((await db.query(`SELECT count(*)::int n FROM public.${table} ${w.sql}`, w.params)).rows[0].n)) },
    async rpc(fn: string, args: Record<string, any>) {
      const q = rpcSql(fn, args)
      return run(async () => { const r = await db.query(q.sql, q.vals); const v = SRF.has(fn) ? r.rows : r.rows[0].r; return v instanceof Date ? v.toISOString().slice(0, 10) : v })
    },
  })
  const asSuper = <T>(fn: () => Promise<T>) => fn()
  return {
    svc: {
      ...ops(asSuper),
      async insert(table: string, rows: any[]) {
        fail('insert', table)
        const cols = Object.keys(rows[0])
        for (const r of rows) {
          await db.query(`INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
            cols.map((c) => (r[c] !== null && typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])))
        }
      },
      async del(table: string, filters: Filter[]) { fail('del', table); const w = where(filters); return (await db.query(`DELETE FROM public.${table} ${w.sql} RETURNING 1`, w.params)).rows.length },
      async rpc(fn: string, args: Record<string, any>) { fail('rpc', fn); return ops(asSuper).rpc(fn, args) },
    },
    async userByEmail(email: string) { return email ? (await db.query(`SELECT id, role, store_id, department_id FROM public.users WHERE lower(email) = lower($1)`, [email])).rows[0] ?? null : null },
    async smManagesStore(smId: string, storeId: string) { return (await db.query(`SELECT 1 FROM public.sm_store_assignments WHERE sm_user_id = $1 AND store_id = $2`, [smId, storeId])).rows.length > 0 },
    async as(role: string) {
      const uid = roles[role]
      if (!uid) return null
      return { ...ops(<T>(fn: () => Promise<T>) => L.as(db, uid, fn) as Promise<T>), userId: uid, close: async () => { opts.closed?.push(role) } }
    },
  }
}

/**
 * Repo import trên PGlite cho handler THẬT (cùng ngữ nghĩa lib/care/server/importRepo.ts: lookups như
 * e2e/care-import-parity.spec.ts, finalize = care__import_finalize_at với `today` cố định).
 * `failOn(op)` ⇒ ném ở bước đó (giả lập lỗi giữa chừng — handler tự dọn batch staged).
 */
export function pgliteImportRepo(db: any, L: any, today: string, opts: { failOn?: (op: string) => boolean; calls?: string[] } = {}): import('../lib/care/import/handler').CareImportRepo {
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as any[]
  const step = (op: string) => { opts.calls?.push(op); if (opts.failOn?.(op)) throw new Error(`giả lập lỗi ${op}`) }
  return {
    async loadLookups({ externalIds, period, isTest }) {
      step('loadLookups')
      const stores = await q(`SELECT id, code, name FROM public.stores WHERE store_type = 'os' AND is_active`)
      const staff = await q(`SELECT id, email, full_name, store_id FROM public.users WHERE role = 'staff' AND store_id = ANY($1::uuid[])`, [stores.map((s) => s.id)])
      const customers = await q(`SELECT id, external_id, is_test FROM public.care_customers WHERE external_id = ANY($1::text[])`, [externalIds])
      const cids = customers.map((c) => c.id)
      const refusals = await q(`SELECT customer_id, store_id FROM public.care_store_refusals WHERE customer_id = ANY($1::uuid[])`, [cids])
      const tasks = await q(`SELECT id, customer_id, status, store_id, assignee_id, customer_name, phone_norm, phone_raw, is_test, last_interaction_at
                             FROM public.care_tasks WHERE period_month = $1 AND customer_id = ANY($2::uuid[])`, [period, cids])
      const products = await q(`SELECT task_id, product_id, product_name, image_url, reason_type, reason_text FROM public.care_task_products
                                WHERE is_current AND task_id = ANY($1::uuid[])`, [tasks.map((t) => t.id)])
      const [{ n: cur }] = await q(`SELECT count(*)::int n FROM public.care_tasks WHERE period_month = $1 AND is_test = $2`, [period, isTest])
      const [{ n: prev }] = await q(`SELECT count(*)::int n FROM public.care_tasks WHERE status = 'open' AND period_month < $1`, [period])
      const byTask = new Map<string, any[]>()
      for (const p of products) byTask.set(p.task_id, [...(byTask.get(p.task_id) ?? []), {
        product_id: p.product_id, product_name: p.product_name, image_url: p.image_url, reason_type: p.reason_type, reason_text: p.reason_text,
      }])
      return {
        storesByCode: new Map(stores.map((s) => [s.code, { id: s.id, code: s.code, name: s.name }])),
        staff: staff.map((s) => ({ id: s.id, storeId: s.store_id, email: String(s.email).trim().toLowerCase(), fullName: s.full_name })),
        customers: new Map(customers.map((c) => [c.external_id, { id: c.id, isTest: c.is_test }])),
        refusals: new Set(refusals.map((r) => `${r.customer_id}|${r.store_id}`)),
        currentTasks: new Map(tasks.map((t) => [t.customer_id, {
          id: t.id, customerId: t.customer_id, status: t.status, storeId: t.store_id, assigneeId: t.assignee_id,
          customerName: t.customer_name, phoneNorm: t.phone_norm, phoneRaw: t.phone_raw, isTest: t.is_test,
          hasInteraction: t.last_interaction_at !== null, products: byTask.get(t.id) ?? [],
        }])),
        currentPeriodTaskCount: cur, openPreviousPeriodCount: prev,
      }
    },
    async createBatch({ period, fileName, sha256, rowCount, actorId, isTest, id }) {
      step('createBatch')
      const [r] = await q(`INSERT INTO public.care_import_batches (id, period_month, file_name, file_sha256, row_count, created_by, is_test)
                           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7) RETURNING id`, [id ?? null, period, fileName, sha256, rowCount, actorId, isTest])
      return r.id as string
    },
    async stageRows(batchId, rows) {
      step('stageRows')
      for (const r of rows) await q(`INSERT INTO public.care_import_staging (batch_id, row_no, payload) VALUES ($1, $2, $3)`, [batchId, r.row_no, JSON.stringify(r.payload)])
    },
    async finalize(batchId, actorId) { step('finalize'); return L.finalize(db, batchId, actorId, today) },
    async discardBatch(batchId) { step('discardBatch'); await q(`DELETE FROM public.care_import_batches WHERE id = $1 AND status = 'staged'`, [batchId]) },
    async purgeStaleStaging() { step('purgeStaleStaging') },
  }
}
