import type { Page, Request, Response, Route } from '@playwright/test'

// ─────────────────────────────────────────────────────────────────────────────
// NAV2-04 kpi2cms (route thật) — phản hồi RSC điều hướng ĐIỀU KHIỂN: cấp payload thật delayMs sau lúc chặn (PM 14/11/2026
// SALES-CONT-01, planning/reviews/2026-11-14-cms-sales-cont-r3-result-next-pm.md §3.3; sửa guard ghi theo
// planning/reviews/2026-11-14-cms-sales-r3o-package-pm.md SALES-R3O-02).
//
// Vì sao không dùng holdRsc(delayMs) của cms-nav2.spec: holdRsc gọi route.fetch() TRONG cửa sổ đo rồi chờ thêm
// max(0, delayMs − thời_gian_fetch) ⇒ delayMs chỉ là SÀN; nguồn thật chậm hơn delayMs (continuation r3: fetch 5.766 ms) thì phản hồi
// trễ theo nguồn và ca đo gộp độ trễ thật với kiểm huỷ timer sau phản hồi 3 s.
//
//   0. GUARD GHI — đứng ĐẦU cả hai handler (trang kiểm + trang chuẩn bị). Page route được gọi TRƯỚC route mức context (trapWrites) và
//      route.continue() / fetch() đi thẳng ra mạng ⇒ request ghi tới URL đích phải bị chặn NGAY ở đây: mọi method khác GET / HEAD /
//      OPTIONS, mọi request có header next-action, mọi GET /api/export ⇒ abort('blockedbyclient') TRƯỚC khi ra mạng + ghi problems()
//      (trang kiểm) / làm prepare() lỗi (trang chuẩn bị) ⇒ test đỏ. Chỉ request đọc mới tới continue / fetch / fulfill. Request ghi tới
//      URL khác do trapWrites (context) chặn như cũ.
//   1. prepare() — TRƯỚC cửa sổ đo, trên một TRANG RIÊNG cùng context (cùng cookie phiên ⇒ cùng vai; cùng viewport / server / build):
//      mở trang nguồn → [warm: chờ ≥ 1 prefetch đích có phản hồi VÀ mọi request prefetch đích đã bắt đầu tại lúc kiểm đều đã có
//      phản hồi (header — không khẳng định body / cache prefetch đã xong)] → chạm link ⇒ request điều hướng RSC THẬT tới server
//      (route.fetch, KHÔNG theo chuyển hướng). Lưu status / header / body + khoá định tuyến (method, pathname, query trừ _rsc, header
//      rsc + next-*). Trang riêng có Router Cache riêng ⇒ không làm ấm trang kiểm (cold vẫn cold). Prefetch trên trang chuẩn bị xử lý
//      ĐÚNG như trang kiểm (cold: giữ, không trả; warm: cho qua) ⇒ request điều hướng cùng dạng (header next-router-state-tree của
//      Next 16 khác nhau giữa cold / warm). Chỉ lấy request điều hướng đầy đủ — KHÔNG dùng payload prefetch.
//      Kiểm: 200 · text/x-component · body ≠ rỗng · không Location / NEXT_REDIRECT · build trong payload ("b") = build tài liệu trang
//      chuẩn bị · 0 request ghi tới đích. Lỗi ⇒ ném 'CHUẨN BỊ RSC LỖI (<mode>): …' — test đỏ, không skip, không số 0 giả. Payload chỉ
//      giữ trong bộ nhớ.
//   2. Trang kiểm: test chờ build tài liệu trang kiểm đọc xong TRƯỚC t0 (buildReady). Request điều hướng RSC tới đích bị chặn; khoá định
//      tuyến + build phải trùng bản đã chuẩn bị ⇒ cấp payload khi đủ delayMs tính từ lúc chặn (không fetch trong cửa sổ đo). Thời điểm
//      thực tế at / fulfilledAt được ghi lại (describe / served) — không tuyên bố tuyệt đối; độ trễ lịch / fulfill cộng thêm vài ms.
//      Chưa chuẩn bị / lệch ⇒ ghi problems() + abort — không bao giờ cấp payload sai. Prefetch: cold — giữ, không bao giờ trả (như
//      holdRsc 'cold'); warm — cho qua. Request ĐỌC tài liệu (tải cứng) / không phải RSC đi thẳng (route.continue).
// ─────────────────────────────────────────────────────────────────────────────

export type RscMode = 'cold' | 'warm'
export type RscPrepareSteps = {
  /** Mở trang nguồn trên trang chuẩn bị + chờ hydrate (dùng đúng hàm mở của test). */
  open: (p: Page) => Promise<unknown>
  /** Chạm link đích trên trang chuẩn bị. */
  click: (p: Page) => Promise<unknown>
  /** Hạn chờ request điều hướng + phản hồi thật sau chạm (mặc định 45 s). */
  navTimeoutMs?: number
  /** Hạn chờ prefetch ở warm (mặc định 15 s, như waitPrefetch). */
  prefetchTimeoutMs?: number
}
export type RscPrepInfo = { prepMs: number; fetchMs: number; bytes: number; buildId: string }
export type RscServed = { at: number; fulfilledAt: number | null; note: string }

type Prepared = { key: string; status: number; headers: Record<string, string>; body: Buffer; fetchMs: number; buildId: string }

const isRsc = (r: Request) => r.headers()['rsc'] === '1'
const isPrefetch = (r: Request) => r.headers()['next-router-prefetch'] === '1'
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, Math.max(0, ms)))
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 160)
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() >= end) return false
    await sleep(50)
  }
  return true
}

/**
 * Request GHI (hoặc xuất dữ liệu) ⇒ nhãn ngắn "METHOD /pathname[ · next-action]"; request ĐỌC ⇒ ''. Ghi = method khác GET / HEAD /
 * OPTIONS, hoặc có header next-action (server action), hoặc GET /api/export. Có / không _rsc, header rsc thật / giả đều không miễn.
 */
export function rscWriteKind(r: Request): string {
  const m = r.method().toUpperCase()
  let path = '?'
  try { path = new URL(r.url()).pathname } catch { path = '?' }
  const action = r.headers()['next-action'] !== undefined
  const read = (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') && !action && !path.startsWith('/api/export')
  return read ? '' : `${m} ${path}${action ? ' · next-action' : ''}`
}
/** Chặn request ghi TRƯỚC khi ra mạng; trả nhãn nếu đã chặn, '' nếu là request đọc (handler được đi tiếp). */
async function blockWrite(route: Route): Promise<string> {
  const w = rscWriteKind(route.request())
  if (w) await route.abort('blockedbyclient').catch(() => {})
  return w
}

/** Khoá định tuyến của request RSC: method + pathname + query (trừ _rsc — băm của chính các header dưới) + header rsc / next-*. */
export function rscRoutingKey(r: Request): string {
  const u = new URL(r.url())
  const q = [...u.searchParams.entries()].filter(([k]) => k !== '_rsc').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`)
  const h = r.headers()
  const hk = Object.keys(h).filter((k) => k === 'rsc' || k.startsWith('next-')).sort().map((k) => `${k}=${h[k]}`)
  return [`${r.method()} ${u.pathname}?${q.join('&')}`, ...hk].join(' | ')
}
/** Phần khác giữa hai khoá — chỉ TÊN (URL / query hoặc tên header), không in giá trị. */
export function rscKeyDiff(a: string, b: string): string {
  const parts = (k: string) => { const [head, ...hs] = k.split(' | '); return { head, hs: new Map(hs.map((x) => [x.split('=')[0], x])) } }
  const A = parts(a), B = parts(b), out: string[] = []
  if (A.head !== B.head) out.push('URL/query')
  for (const n of new Set([...A.hs.keys(), ...B.hs.keys()])) if (A.hs.get(n) !== B.hs.get(n)) out.push(n)
  return out.join(', ') || '?'
}
export const buildInPayload = (body: Buffer) => /"b":"([\w-]+)"/.exec(body.toString('utf8'))?.[1] ?? ''
export const buildInHtml = (html: string) => /\\"b\\":\\"([\w-]+)\\"/.exec(html)?.[1] ?? ''

/** Build của tài liệu (HTML) mới nhất trong khung chính của trang — đọc từ dữ liệu flight nhúng (\"b\":\"…\"). */
function docBuild(p: Page) {
  const st = { build: '', err: '' }
  p.on('response', (r: Response) => {
    const q = r.request()
    let main = false
    try { main = q.resourceType() === 'document' && q.frame() === p.mainFrame() } catch { main = false }
    if (!main || r.status() !== 200) return
    r.text().then((t) => { const b = buildInHtml(t); if (b) { st.build = b; st.err = '' } else if (!st.build) st.err = 'không thấy build trong tài liệu' })
      .catch((e) => { if (!st.build) st.err = `đọc tài liệu lỗi: ${errMsg(e)}` })
  })
  return st
}
/**
 * Prefetch RSC tới đích trên trang: số request đã bắt đầu / đã có phản hồi (header). idle = có ≥ 1 phản hồi và mọi request prefetch đã
 * bắt đầu TẠI LÚC KIỂM đều đã có phản hồi — chỉ chứng minh đã có header, không khẳng định body / cache prefetch đã hoàn tất.
 */
function prefetchWatch(p: Page, isTarget: (u: URL) => boolean) {
  const st = { started: 0, responses: 0 }
  const mine = (r: Request) => { try { return isTarget(new URL(r.url())) && isRsc(r) && isPrefetch(r) } catch { return false } }
  p.on('request', (r: Request) => { if (mine(r)) st.started++ })
  p.on('response', (r: Response) => { if (mine(r.request())) st.responses++ })
  return { st, idle: () => st.responses > 0 && st.responses >= st.started }
}

/**
 * Đăng ký TRƯỚC khi mở trang nguồn. mode 'cold' | 'warm' như holdRsc; delayMs = mốc cấp phản hồi điều hướng tính từ lúc chặn.
 * Trình tự trong test: replayRscAfter → prepare() (trước cửa sổ đo) → mở trang nguồn → [warm: waitPrefetch] → buildReady → t0 → chạm.
 */
export async function replayRscAfter(page: Page, isTarget: (u: URL) => boolean, mode: RscMode, delayMs: number) {
  const state: { prepared: Prepared | null; info: RscPrepInfo | null } = { prepared: null, info: null }
  const served: RscServed[] = []
  const problems: string[] = []
  const pf = prefetchWatch(page, isTarget)
  const doc = docBuild(page)

  await page.route((u) => isTarget(u), async (route) => {
    const w = await blockWrite(route)
    if (w) { problems.push(`request ghi tới URL đích bị chặn trước mạng: ${w}`); return }
    const r = route.request()
    if (r.resourceType() === 'document' || !isRsc(r)) return route.continue()
    if (isPrefetch(r)) { if (mode === 'warm') return route.continue(); return }   // cold: không bao giờ trả
    const rec: RscServed = { at: Date.now(), fulfilledAt: null, note: '' }
    served.push(rec)
    const bad = async (m: string) => { rec.note = m; problems.push(m); await route.abort().catch(() => {}) }
    const P = state.prepared
    if (!P) return bad('request điều hướng tới trước khi có payload chuẩn bị')
    const k = rscRoutingKey(r)
    if (k !== P.key) return bad(`request điều hướng khác request đã chuẩn bị (${rscKeyDiff(P.key, k)})`)
    if (!doc.build) await until(() => !!doc.build, 2_000)   // dự phòng — test đã chờ buildReady trước t0
    if (doc.build !== P.buildId) return bad(doc.build ? 'build tài liệu trang kiểm khác build payload chuẩn bị' : `không đọc được build tài liệu trang kiểm${doc.err ? ' — ' + doc.err : ''}`)
    await sleep(delayMs - (Date.now() - rec.at))
    try {
      await route.fulfill({ status: P.status, headers: P.headers, body: P.body })
      rec.fulfilledAt = Date.now()
      rec.note = 'đã cấp'
    } catch (e) { rec.note = `không cấp được (trang đóng / điều hướng đi): ${errMsg(e)}` }
  })

  async function prepare(steps: RscPrepareSteps): Promise<RscPrepInfo> {
    const fail = (m: string): never => { throw new Error(`CHUẨN BỊ RSC LỖI (${mode}): ${m}`) }
    if (state.prepared) fail('đã chuẩn bị — mỗi test chỉ một lần')
    const navTimeout = steps.navTimeoutMs ?? 45_000
    const t0 = Date.now()
    const cap: { navs: number; got: Prepared | null; err: string; writes: string[] } = { navs: 0, got: null, err: '', writes: [] }
    const p = await page.context().newPage()
    const ppf = prefetchWatch(p, isTarget)
    const pdoc = docBuild(p)
    try {
      await p.route((u) => isTarget(u), async (route) => {
        const w = await blockWrite(route)
        if (w) { cap.writes.push(w); return }
        const r = route.request()
        if (r.resourceType() === 'document' || !isRsc(r)) return route.continue()
        if (isPrefetch(r)) { if (mode === 'warm') return route.continue(); return }   // cold: giữ như trang kiểm
        cap.navs++
        if (cap.navs > 1 || cap.got || cap.err) return route.abort().catch(() => {})
        const tf = Date.now()
        try {
          const res = await route.fetch({ maxRedirects: 0 })
          const body = await res.body()
          cap.got = { key: rscRoutingKey(r), status: res.status(), headers: res.headers(), body, fetchMs: Date.now() - tf, buildId: buildInPayload(body) }
          await route.fulfill({ status: cap.got.status, headers: cap.got.headers, body })
        } catch (e) {
          if (!cap.got) cap.err = `fetch nguồn thật lỗi: ${errMsg(e)}`
          await route.abort().catch(() => {})
        }
      })
      try { await steps.open(p) } catch (e) { fail(`mở trang nguồn: ${errMsg(e)}`) }
      if (mode === 'warm' && !(await until(() => ppf.idle(), steps.prefetchTimeoutMs ?? 15_000))) fail('trang chuẩn bị không nhận prefetch đích (warm vô nghĩa)')
      if (mode === 'cold' && ppf.st.responses > 0) fail('cold mà trang chuẩn bị đã nhận prefetch đích')
      try { await steps.click(p) } catch (e) { fail(`chạm link: ${errMsg(e)}`) }
      await until(() => !!cap.got || !!cap.err, navTimeout)
    } finally {
      await p.close().catch(() => {})
    }
    if (cap.writes.length) fail(`trang chuẩn bị phát request ghi tới URL đích (đã chặn trước mạng): ${cap.writes.join(', ')}`)
    if (cap.err) fail(cap.err)
    const g = cap.got
    if (!g) return fail(`không có request điều hướng RSC tới đích sau chạm (${navTimeout} ms)`)
    const loc = g.headers['location']
    if (g.status !== 200) fail(`status ${g.status}${loc ? ' — chuyển hướng (phiên / quyền?)' : ''}`)
    if (loc) fail('phản hồi có Location (chuyển hướng)')
    if (!(g.headers['content-type'] ?? '').includes('text/x-component')) fail(`content-type ${(g.headers['content-type'] ?? '∅').split(';')[0]} — không phải RSC`)
    if (g.body.length === 0) fail('body rỗng')
    if (g.body.includes('NEXT_REDIRECT')) fail('payload là chuyển hướng (NEXT_REDIRECT) — phiên / quyền?')
    if (!g.buildId) fail('không thấy build ("b") trong payload')
    if (!pdoc.build) fail(`không đọc được build tài liệu trang chuẩn bị${pdoc.err ? ' — ' + pdoc.err : ''}`)
    if (g.buildId !== pdoc.build) fail('build payload khác build tài liệu trang chuẩn bị')
    state.prepared = g
    state.info = { prepMs: Date.now() - t0, fetchMs: g.fetchMs, bytes: g.body.length, buildId: g.buildId }
    return state.info
  }

  const describe = (t0: number) => {
    const s = served.map((x) => `chặn +${x.at - t0} ms → ${x.fulfilledAt ? `cấp +${x.fulfilledAt - t0} ms (sau chặn ${x.fulfilledAt - x.at} ms)` : x.note}`).join('; ')
    return `rsc-chuẩn-bị[${mode} · đặt ${delayMs} ms · ${served.length} request điều hướng${s ? ': ' + s : ''}${problems.length ? ' · LỖI: ' + problems.join(' / ') : ''}]`
  }

  return {
    prepare,
    /** warm: ≥ 1 phản hồi prefetch tới đích và mọi request prefetch đích đã bắt đầu đều đã có phản hồi (header) — dùng với waitPrefetch. */
    prefetched: () => pf.idle(),
    /** Số phản hồi prefetch tới đích trang kiểm đã nhận (cold phải = 0). */
    prefetchResponses: () => pf.st.responses,
    /** Chờ đọc xong build tài liệu trang kiểm (gọi TRƯỚC t0 để không chờ trong cửa sổ đo). */
    buildReady: (ms = 10_000) => until(() => !!doc.build, ms),
    served: () => served.map((x) => ({ ...x })),
    problems: () => [...problems],
    info: () => state.info,
    describe,
  }
}
