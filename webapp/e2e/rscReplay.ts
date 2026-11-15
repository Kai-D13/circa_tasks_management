import type { Page, Request, Response, Route } from '@playwright/test'

// ─────────────────────────────────────────────────────────────────────────────
// NAV2-04 (route thật) — phản hồi RSC điều hướng ĐIỀU KHIỂN: cấp CHUỖI payload thật, một mốc delayMs cho CẢ lần điều hướng (PM 14/11/2026
// SALES-CONT-01, planning/reviews/2026-11-14-cms-sales-cont-r3-result-next-pm.md §3.3; guard ghi theo
// planning/reviews/2026-11-14-cms-sales-r3o-package-pm.md SALES-R3O-02; chuỗi request theo
// planning/reviews/2026-11-15-cms-sales-final-consolidated-work-order-pm.md §7.3). Từ NAV-REPEAT-1 (15/11) dùng cho chiều cms2kpi —
// kpi2cms là document navigation, không còn RSC điều hướng.
//
// Vì sao không dùng holdRsc(delayMs) của cms-nav2.spec: holdRsc gọi route.fetch() TRONG cửa sổ đo rồi chờ thêm
// max(0, delayMs − thời_gian_fetch) ⇒ delayMs chỉ là SÀN; nguồn thật chậm hơn delayMs (continuation r3: fetch 5.766 ms) thì phản hồi
// trễ theo nguồn và ca đo gộp độ trễ thật với kiểm huỷ timer sau phản hồi 3 s.
//
// Vì sao CHUỖI (gate final lượt 1, 15/11): một lần chạm có thể phát nhiều request điều hướng RSC nối tiếp (request sau mang
// next-router-state-tree khác). Bản trước chỉ chuẩn bị request đầu ⇒ request sau bị coi là lệch ⇒ đỏ do harness. Bản này chuẩn bị TOÀN
// BỘ chuỗi trước cửa sổ đo; số request do bằng chứng chuẩn bị quyết định (không giả định cố định).
//
//   0. GUARD GHI — đứng ĐẦU cả hai handler (trang kiểm + trang chuẩn bị). Page route được gọi TRƯỚC route mức context (trapWrites) và
//      route.continue() / fetch() đi thẳng ra mạng ⇒ request ghi tới URL đích phải bị chặn NGAY ở đây: mọi method khác GET / HEAD /
//      OPTIONS, mọi request có header next-action, mọi GET /api/export ⇒ abort('blockedbyclient') TRƯỚC khi ra mạng + ghi problems()
//      (trang kiểm) / làm prepare() lỗi (trang chuẩn bị) ⇒ test đỏ. Chỉ request đọc mới tới continue / fetch / fulfill. Request ghi tới
//      URL khác do trapWrites (context) chặn như cũ.
//   1. prepare() — TRƯỚC cửa sổ đo, trên một TRANG RIÊNG cùng context (cùng cookie phiên ⇒ cùng vai; cùng viewport / server / build):
//      mở trang nguồn → [warm: chờ ≥ 1 prefetch đích có phản hồi VÀ mọi request prefetch đích đã bắt đầu tại lúc kiểm đều đã có
//      phản hồi (header — không khẳng định body / cache prefetch đã xong)] → chạm link ⇒ MỖI request điều hướng RSC tới đích đi server
//      THẬT (route.fetch, KHÔNG theo chuyển hướng) rồi fulfill ngay, theo đúng thứ tự chặn. Chuỗi chỉ chốt khi: mọi request đã có phản
//      hồi, nội dung đích đã hiện (steps.ready), URL ở đích, 0 tải cứng đích sau chạm và LẶNG quietMs không có request điều hướng mới.
//      Tối đa RSC_CHAIN_MAX request — vượt ⇒ lỗi. Mỗi phần tử lưu status / header / body + khoá định tuyến (method, pathname, query trừ
//      _rsc, header rsc + next-*, gồm next-router-state-tree). Trang riêng có Router Cache riêng ⇒ không làm ấm trang kiểm. Prefetch
//      trên trang chuẩn bị xử lý ĐÚNG như trang kiểm (cold: giữ, không trả; warm: cho qua). KHÔNG dùng payload prefetch.
//      Kiểm TỪNG phần tử: 200 · text/x-component · body ≠ rỗng · không Location / NEXT_REDIRECT · build trong payload ("b") = build tài
//      liệu trang chuẩn bị · 0 request ghi tới đích. Lỗi ⇒ ném 'CHUẨN BỊ RSC LỖI (<mode>): …' — test đỏ, không skip, không số 0 giả.
//      Payload chỉ giữ trong bộ nhớ.
//      PM 15/11 §8.3 — chuẩn bị KHÔNG phải phép thử SLA 6 s: trên trang chuẩn bị, spec khởi động điều hướng bằng routerNavigate()
//      (router client của Next, đúng href đọc từ link) — KHÔNG qua <Link> nên KHÔNG gắn NavWatchdog của link ⇒ nguồn thật chậm
//      (vd. 7,9–8 s ở continuation final) vẫn chuẩn bị được trong hạn hữu hạn navTimeoutMs (45 s; route.fetch cùng hạn). Watchdog của
//      TRANG KIỂM / app không đổi: trang kiểm vẫn CHẠM link thật; mỗi request điều hướng ở trang kiểm phải trùng khoá phần tử chuỗi
//      (khác cách khởi động ⇒ lệch khoá ⇒ đỏ, không cấp payload). Thời gian chuẩn bị nằm NGOÀI cửa sổ đo (không cộng vào hạn 3 s).
//   2. Trang kiểm: test chờ build tài liệu trang kiểm đọc xong TRƯỚC t0 (buildReady). Request điều hướng RSC thứ i tới đích bị chặn; khoá
//      định tuyến phải trùng phần tử i của chuỗi (đúng thứ tự) + build tài liệu trùng payload ⇒ cấp payload i tại max(lúc chặn, HẠN CHUNG)
//      với HẠN CHUNG = lúc chặn request điều hướng ĐẦU + delayMs (một mốc cho cả lần điều hướng — không cộng delayMs cho từng request;
//      request tới sau hạn được cấp ngay). Không fetch trong cửa sổ đo. Request thứ i ≥ độ dài chuỗi / khoá lệch / chưa chuẩn bị ⇒ ghi
//      problems() + abort — không bao giờ cấp payload sai. complete() = đã chặn ĐÚNG số request của chuỗi, mỗi request đã cấp, 0 problems
//      (bắt thiếu response). Thời điểm thực tế at / fulfilledAt + hạn chung được ghi lại (describe / served). Prefetch: cold — giữ, không
//      bao giờ trả; warm — cho qua. Request ĐỌC tài liệu (tải cứng) / không phải RSC đi thẳng (route.continue).
// ─────────────────────────────────────────────────────────────────────────────

export type RscMode = 'cold' | 'warm'
export type RscPrepareSteps = {
  /** Mở trang nguồn trên trang chuẩn bị + chờ hydrate (dùng đúng hàm mở của test). */
  open: (p: Page) => Promise<unknown>
  /** Khởi động điều hướng tới đích trên trang chuẩn bị — từ §8.3 dùng routerNavigate() (không qua link có watchdog). */
  click: (p: Page) => Promise<unknown>
  /** Chờ nội dung đích hiện trên trang chuẩn bị (kết thúc lần điều hướng) — chuỗi chỉ chốt sau bước này + quãng lặng. */
  ready: (p: Page) => Promise<unknown>
  /** Hạn chờ chuỗi request điều hướng + phản hồi thật + lặng sau chạm (mặc định 45 s). */
  navTimeoutMs?: number
  /** Hạn chờ prefetch ở warm (mặc định 15 s, như waitPrefetch). */
  prefetchTimeoutMs?: number
  /** Quãng lặng chốt chuỗi: không có request điều hướng mới trong khoảng này sau khi nội dung đích hiện (mặc định 1.500 ms). */
  quietMs?: number
}
/** Trần số request điều hướng của MỘT lần chạm ở bước chuẩn bị — vượt ⇒ lỗi (vòng lặp / hành vi lạ, không phải chuỗi hợp lệ). */
export const RSC_CHAIN_MAX = 4
export type RscPrepInfo = { prepMs: number; fetchMs: number; bytes: number; buildId: string; chain: number; fetchMsEach: number[]; bytesEach: number[] }
export type RscServed = { idx: number; at: number; fulfilledAt: number | null; note: string }

type Prepared = { key: string; status: number; headers: Record<string, string>; body: Buffer; fetchMs: number; buildId: string }
type Slot = { key: string; got: Prepared | null; err: string }

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

/**
 * §8.3 — điều hướng client bằng router App Router của Next (`window.next.router.push`, cùng dispatchNavigateAction mà <Link> dùng,
 * chỉ khác KHÔNG gắn trạng thái pending của link ⇒ NavWatchdog của link không đếm). Chỉ dùng cho TRANG CHUẨN BỊ; không có router ⇒ ném.
 */
export async function routerNavigate(p: Page, href: string): Promise<void> {
  const ok = await p.evaluate((h) => {
    const r = (window as unknown as { next?: { router?: { push?: (x: string) => void } } }).next?.router
    if (!r || typeof r.push !== 'function') return false
    r.push(h)
    return true
  }, href)
  if (!ok) throw new Error('không có router client (window.next.router.push) trên trang chuẩn bị')
}

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
 * Đăng ký TRƯỚC khi mở trang nguồn. mode 'cold' | 'warm' như holdRsc; delayMs = HẠN CHUNG tính từ lúc chặn request điều hướng đầu.
 * Trình tự trong test: replayRscAfter → prepare() (trước cửa sổ đo) → mở trang nguồn → [warm: waitPrefetch] → buildReady → t0 → chạm
 * → … → complete() sau khi qua mốc watchdog.
 */
export async function replayRscAfter(page: Page, isTarget: (u: URL) => boolean, mode: RscMode, delayMs: number) {
  const state: { chain: Prepared[] | null; info: RscPrepInfo | null } = { chain: null, info: null }
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
    const rec: RscServed = { idx: served.length, at: Date.now(), fulfilledAt: null, note: '' }
    served.push(rec)
    const n = `#${rec.idx + 1}`
    const bad = async (m: string) => { rec.note = m; problems.push(m); await route.abort().catch(() => {}) }
    const C = state.chain
    if (!C) return bad(`request điều hướng ${n} tới trước khi có chuỗi chuẩn bị`)
    if (rec.idx >= C.length) return bad(`request điều hướng ${n} ngoài chuỗi đã chuẩn bị (${C.length} request)`)
    const P = C[rec.idx]
    const k = rscRoutingKey(r)
    if (k !== P.key) return bad(`request điều hướng ${n} khác request ${n} đã chuẩn bị (${rscKeyDiff(P.key, k)})`)
    if (!doc.build) await until(() => !!doc.build, 2_000)   // dự phòng — test đã chờ buildReady trước t0
    if (doc.build !== P.buildId) return bad(doc.build ? `build tài liệu trang kiểm khác build payload chuẩn bị ${n}` : `không đọc được build tài liệu trang kiểm${doc.err ? ' — ' + doc.err : ''}`)
    await sleep(served[0].at + delayMs - Date.now())   // HẠN CHUNG của cả lần điều hướng
    try {
      await route.fulfill({ status: P.status, headers: P.headers, body: P.body })
      rec.fulfilledAt = Date.now()
      rec.note = 'đã cấp'
    } catch (e) { rec.note = `không cấp được (trang đóng / điều hướng đi): ${errMsg(e)}` }
  })

  async function prepare(steps: RscPrepareSteps): Promise<RscPrepInfo> {
    const fail = (m: string): never => { throw new Error(`CHUẨN BỊ RSC LỖI (${mode}): ${m}`) }
    if (state.chain) fail('đã chuẩn bị — mỗi test chỉ một lần')
    const navTimeout = steps.navTimeoutMs ?? 45_000
    const quiet = steps.quietMs ?? 1_500
    const t0 = Date.now()
    const cap: { clicked: boolean; chain: Slot[]; lastAt: number; docs: number; writes: string[] } = { clicked: false, chain: [], lastAt: 0, docs: 0, writes: [] }
    const settled = () => cap.chain.length > 0 && cap.chain.every((s) => !!s.got || !!s.err)
    const slotErr = () => cap.chain.some((s) => !!s.err)
    const p = await page.context().newPage()
    const ppf = prefetchWatch(p, isTarget)
    const pdoc = docBuild(p)
    let waitErr = ''
    try {
      await p.route((u) => isTarget(u), async (route) => {
        const w = await blockWrite(route)
        if (w) { cap.writes.push(w); return }
        const r = route.request()
        if (r.resourceType() === 'document') { if (cap.clicked) cap.docs++; return route.continue() }
        if (!isRsc(r)) return route.continue()
        if (isPrefetch(r)) { if (mode === 'warm') return route.continue(); return }   // cold: giữ như trang kiểm
        const i = cap.chain.length
        const slot: Slot = { key: rscRoutingKey(r), got: null, err: '' }
        cap.chain.push(slot)
        cap.lastAt = Date.now()
        if (!cap.clicked) { slot.err = `request điều hướng #${i + 1} trước khi chạm`; return route.abort().catch(() => {}) }
        if (i >= RSC_CHAIN_MAX) { slot.err = `chuỗi vượt ${RSC_CHAIN_MAX} request điều hướng`; return route.abort().catch(() => {}) }
        const tf = Date.now()
        try {
          const res = await route.fetch({ maxRedirects: 0, timeout: navTimeout })
          const body = await res.body()
          slot.got = { key: slot.key, status: res.status(), headers: res.headers(), body, fetchMs: Date.now() - tf, buildId: buildInPayload(body) }
          await route.fulfill({ status: slot.got.status, headers: slot.got.headers, body })
        } catch (e) {
          if (!slot.got) slot.err = `fetch nguồn thật lỗi (#${i + 1}): ${errMsg(e)}`
          await route.abort().catch(() => {})
        } finally { cap.lastAt = Date.now() }
      })
      try { await steps.open(p) } catch (e) { fail(`mở trang nguồn: ${errMsg(e)}`) }
      if (mode === 'warm' && !(await until(() => ppf.idle(), steps.prefetchTimeoutMs ?? 15_000))) fail('trang chuẩn bị không nhận prefetch đích (warm vô nghĩa)')
      if (mode === 'cold' && ppf.st.responses > 0) fail('cold mà trang chuẩn bị đã nhận prefetch đích')
      cap.clicked = true
      try { await steps.click(p) } catch (e) { fail(`chạm link: ${errMsg(e)}`) }
      const end = Date.now() + navTimeout
      if (!(await until(settled, navTimeout))) waitErr = cap.chain.length ? 'request điều hướng chưa có phản hồi' : `không có request điều hướng RSC tới đích sau chạm (${navTimeout} ms)`
      if (!waitErr && !slotErr()) {
        try { await steps.ready(p) } catch (e) { waitErr = `nội dung đích không hiện trên trang chuẩn bị: ${errMsg(e)}` }
      }
      if (!waitErr && !slotErr() && !(await until(() => slotErr() || (settled() && Date.now() - cap.lastAt >= quiet), Math.max(0, end - Date.now()))))
        waitErr = `chuỗi request điều hướng không lặng ${quiet} ms trong ${navTimeout} ms`
      if (!waitErr && !slotErr()) {
        let ok = false
        try { ok = isTarget(new URL(p.url())) } catch { ok = false }
        if (!ok) waitErr = 'trang chuẩn bị không ở URL đích sau chuỗi'
      }
    } finally {
      await p.close().catch(() => {})
    }
    if (cap.writes.length) fail(`trang chuẩn bị phát request ghi tới URL đích (đã chặn trước mạng): ${cap.writes.join(', ')}`)
    const e1 = cap.chain.find((s) => s.err)
    if (e1) fail(e1.err)
    if (waitErr) fail(waitErr)
    if (cap.docs) fail(`trang chuẩn bị tải cứng đích ${cap.docs} lần sau chạm — không phải điều hướng mềm`)
    if (!pdoc.build) fail(`không đọc được build tài liệu trang chuẩn bị${pdoc.err ? ' — ' + pdoc.err : ''}`)
    const chain = cap.chain.map((s, i) => {
      const g = s.got as Prepared
      const n = `#${i + 1}/${cap.chain.length}`
      const loc = g.headers['location']
      if (g.status !== 200) fail(`${n} status ${g.status}${loc ? ' — chuyển hướng (phiên / quyền?)' : ''}`)
      if (loc) fail(`${n} phản hồi có Location (chuyển hướng)`)
      if (!(g.headers['content-type'] ?? '').includes('text/x-component')) fail(`${n} content-type ${(g.headers['content-type'] ?? '∅').split(';')[0]} — không phải RSC`)
      if (g.body.length === 0) fail(`${n} body rỗng`)
      if (g.body.includes('NEXT_REDIRECT')) fail(`${n} payload là chuyển hướng (NEXT_REDIRECT) — phiên / quyền?`)
      if (!g.buildId) fail(`${n} không thấy build ("b") trong payload`)
      if (g.buildId !== pdoc.build) fail(`${n} build payload khác build tài liệu trang chuẩn bị`)
      return g
    })
    state.chain = chain
    state.info = {
      prepMs: Date.now() - t0, fetchMs: chain.reduce((a, g) => a + g.fetchMs, 0), bytes: chain.reduce((a, g) => a + g.body.length, 0), buildId: chain[0].buildId,
      chain: chain.length, fetchMsEach: chain.map((g) => g.fetchMs), bytesEach: chain.map((g) => g.body.length),
    }
    return state.info
  }

  const chainLength = () => state.chain?.length ?? 0
  const describe = (t0: number) => {
    const s = served.map((x) => `#${x.idx + 1} chặn +${x.at - t0} ms → ${x.fulfilledAt ? `cấp +${x.fulfilledAt - t0} ms (sau chặn ${x.fulfilledAt - x.at} ms)` : x.note}`).join('; ')
    const dl = served.length ? ` · hạn chung +${served[0].at + delayMs - t0} ms` : ''
    return `rsc-chuẩn-bị[${mode} · đặt ${delayMs} ms cho cả lần điều hướng · chuỗi ${chainLength()} · ${served.length} request điều hướng${dl}${s ? ': ' + s : ''}${problems.length ? ' · LỖI: ' + problems.join(' / ') : ''}]`
  }

  return {
    prepare,
    /** warm: ≥ 1 phản hồi prefetch tới đích và mọi request prefetch đích đã bắt đầu đều đã có phản hồi (header) — dùng với waitPrefetch. */
    prefetched: () => pf.idle(),
    /** Số phản hồi prefetch tới đích trang kiểm đã nhận (cold phải = 0). */
    prefetchResponses: () => pf.st.responses,
    /** Chờ đọc xong build tài liệu trang kiểm (gọi TRƯỚC t0 để không chờ trong cửa sổ đo). */
    buildReady: (ms = 10_000) => until(() => !!doc.build, ms),
    /** Số request điều hướng của chuỗi đã chuẩn bị (0 = chưa chuẩn bị). */
    chainLength,
    /** Đã chặn ĐÚNG số request của chuỗi, mỗi request đã nhận payload chuẩn bị, 0 problems — gọi sau khi qua mốc watchdog. */
    complete: () => chainLength() > 0 && served.length === chainLength() && served.every((x) => x.fulfilledAt !== null) && problems.length === 0,
    served: () => served.map((x) => ({ ...x })),
    problems: () => [...problems],
    info: () => state.info,
    describe,
  }
}
