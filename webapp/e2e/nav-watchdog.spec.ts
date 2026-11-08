import { test, expect, type Browser, type Locator, type Page, type Request, type TestInfo } from '@playwright/test'
import { STAFF_STATE } from './authState'
import { must, sessionDb } from './dbFixtures'
import { NAV_WATCHDOG_MS, internalTarget, isAtTarget } from '../lib/nav/watchdog'

// ─────────────────────────────────────────────────────────────────────────────
// NAV-1 (PM 26/10/2026 — planning/reviews/2026-10-26-kpi-nav-pk1-audit-pm.md §1): watchdog thẻ chiến dịch staff /targets.
// Lỗi gốc (report 2026-10-26-kpi-nav-trace-pk1 §3): chạm thẻ → RSC về đủ nhưng React giữ transition treo vô hạn, URL không đổi —
// nhất là khi access token vừa hết hạn. Watchdog: link pending quá NAV_WATCHDOG_MS lúc trang hiển thị ⇒ tải cứng đích MỘT lần.
//
// "Treo" được dựng TẤT ĐỊNH bằng cách giữ request RSC tới chi tiết (page.route không trả) — điều hướng mềm pending mãi, đúng
// trạng thái người dùng thấy; request TÀI LIỆU (tải cứng) vẫn đi qua. Đếm tải cứng = số request document tới `?campaign=`.
// Ca "phiên hết hạn" chạy lỗi THẬT (không giữ RSC) nhiều lượt: lượt nào treo phải được watchdog gỡ.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const RUN_PROJECT = 'mobile-390'   // viewport do test đặt — chạy một project là đủ (cùng lý do campaign-detail-mobile)
const VIEWPORT = { width: 390, height: 844 }
const CARD = 'main [data-campaign-card-list] a[href*="campaign="]'
const TO_DETAIL = /[?&]campaign=/

const isRsc = (r: Request) => r.headers()['rsc'] === '1'
// Chỉ tài liệu /targets?…campaign= — proxy chuyển /login GIỮ query (`/login?campaign=…`), không được tính là tải cứng tới đích.
const isCampaignDoc = (r: Request) => r.resourceType() === 'document' && new URL(r.url()).pathname === '/targets' && TO_DETAIL.test(r.url())

/** Chiến dịch đang chạy của store staff QA theo RLS của chính phiên staff — chỉ dùng để quyết skip ca cần ≥ 2 thẻ. */
async function rlsActiveCampaigns(): Promise<number> {
  const sb = await sessionDb(STAFF.email!, STAFF.password!)
  const { data: { user } } = await sb.auth.getUser()
  const me = must(await sb.from('users').select('store_id').eq('id', user!.id).single(), 'users (tự đọc)') as { store_id: string | null }
  expect(me.store_id, 'tài khoản staff QA không gắn cửa hàng').toBeTruthy()
  const rows = must(await sb.from('kpi_campaign_store_targets').select('campaign:kpi_campaigns!inner(id)')
    .eq('store_id', me.store_id!).is('campaign.archived_at', null), 'kpi_campaign_store_targets (RLS staff)')
  return rows.length
}

async function landing(page: Page): Promise<Locator> {
  await page.goto('/targets')
  await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn').toHaveURL(/\/targets(\?|$)/)
  const cards = page.locator(CARD)
  await expect(cards.first(), '/targets không hiện thẻ chiến dịch').toBeAttached({ timeout: 20_000 })
  return cards
}
async function tap(card: Locator) {
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await card.click()
}
/** Ghi query của mọi lần tải cứng tới chi tiết (request document `?campaign=`). */
function hardLoads(page: Page): string[] {
  const out: string[] = []
  page.on('request', (r) => { if (isCampaignDoc(r)) out.push(new URL(r.url()).search) })
  return out
}
/** Giữ RSC tới chi tiết ⇒ điều hướng mềm treo vô hạn; tài liệu (tải cứng) đi qua. `delayMs` ⇒ chậm rồi mới cho qua. */
async function holdDetailRsc(page: Page, delayMs?: number) {
  await page.route(TO_DETAIL, async (route) => {
    if (!isRsc(route.request())) return route.continue()
    if (delayMs === undefined) return   // không trả ⇒ treo
    await new Promise((r) => setTimeout(r, delayMs))
    return route.continue().catch(() => {})
  })
}
async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}
const searchOf = (href: string) => new URL(href, 'http://x').search
const pathSearch = (href: string) => { const u = new URL(href, 'http://x'); return u.pathname + u.search }

// ── UI-NAV r2 (PM audit planning/reviews/2026-11-08-ui-nav-r1-pm.md §3 UINAV-P1-1): ORACLE THEO THỨ TỰ SỰ KIỆN ───────────────────
// r0 đo từ lúc chạm (sai: timer chỉ arm khi Link pending). r1 sửa mốc arm nhưng vẫn suy "đã quá hạn ⇒ callback đã chạy ⇒ 1 tải cứng"
// — SAI: setTimeout chỉ cho thời điểm SỚM NHẤT callback có thể chạy; main thread bận thì URL có thể commit (và cleanup huỷ timer)
// SAU hạn nhưng TRƯỚC callback ⇒ 0 tải cứng mới là đúng (phản ví dụ PM: arm 0,1 ms, commit + huỷ 6.030,1 ms, callback không chạy).
// r2: kỳ vọng suy từ THỨ TỰ thật của sự kiện trong trang — mỗi timer 6 s có id riêng (arm / clear / fire cùng id), mark `fire` ghi
// NGAY ĐẦU callback kèm URL + visibility tại lúc đó (đúng đầu vào của guard `isAtTarget` / visibility trong NavWatchdog). Một callback
// chỉ dẫn tới tải cứng khi nó THỰC SỰ chạy lúc URL chưa tới đích và tab đang hiện; callback chạy sau commit là no-op; timer bị huỷ
// không bao giờ chạy. Thứ tự = thứ tự phần tử trong dòng thời gian (JS trang đơn luồng, ghi tuần tự) — dấu thời gian bằng nhau
// không đảo thứ tự. Deadline (arm + 6 s) chỉ dùng để kiểm "callback không chạy SỚM", không để suy callback đã chạy. Số tài liệu
// quan sát được KHÔNG tham gia tính kỳ vọng. Chỉ ĐO: init script bọc window.setTimeout / clearTimeout / history của trang test —
// không sửa watchdog production. Lưu sessionStorage (sống qua tải cứng cùng origin); không ghi phiên / cookie / payload; URL chỉ
// path + query.
type Mark = { t: number; k: string; v?: string; id?: number; vis?: string }
type NetMark = { t: number; ev: string }
const TL_KEY = '__nav1_timeline'

async function installTimeline(page: Page) {
  await page.addInitScript(({ ms, key }) => {
    const w = window as unknown as { setTimeout: (...a: unknown[]) => number; clearTimeout: (id?: number) => void }
    const add = (k: string, v?: string, extra?: { id?: number; vis?: string }) => {
      try {
        const a = JSON.parse(sessionStorage.getItem(key) || '[]') as unknown[]
        a.push({ t: performance.timeOrigin + performance.now(), k, v, ...extra })
        sessionStorage.setItem(key, JSON.stringify(a))
      } catch { /* sessionStorage bị chặn ⇒ bỏ đo, không làm hỏng trang */ }
    }
    const here = () => location.pathname + location.search
    add('doc', here())
    const st = w.setTimeout.bind(window), ct = w.clearTimeout.bind(window), live = new Set<number>()
    w.setTimeout = (fn: unknown, t?: unknown, ...rest: unknown[]) => {
      if (t !== ms) return st(fn, t, ...rest)
      const id: number = st((...x: unknown[]) => {
        live.delete(id)
        add('fire', here(), { id, vis: document.visibilityState })   // TRƯỚC callback thật ⇒ đúng trạng thái guard sẽ đọc
        if (typeof fn === 'function') (fn as (...y: unknown[]) => void)(...x)
      }, t, ...rest)
      live.add(id); add('arm', undefined, { id }); return id
    }
    w.clearTimeout = (id?: number) => { if (id !== undefined && live.has(id)) { live.delete(id); add('clear', undefined, { id }) } return ct(id) }
    const h = history as unknown as Record<'pushState' | 'replaceState', (...a: unknown[]) => void>
    for (const m of ['pushState', 'replaceState'] as const) {
      const orig = h[m].bind(history)
      h[m] = (...a: unknown[]) => { orig(...a); add(m === 'pushState' ? 'push' : 'replace', here()) }
    }
    document.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (a) { const u = new URL(a.href); add('click', u.pathname + u.search) }
    }, true)
    new MutationObserver((recs) => {
      for (const r of recs) if (r.attributeName === 'data-nav-pending') add((r.target as Element).hasAttribute('data-nav-pending') ? 'pending+' : 'pending-')
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-nav-pending'] })
  }, { ms: NAV_WATCHDOG_MS, key: TL_KEY })
}
const resetTimeline = (page: Page) => page.evaluate((k) => sessionStorage.removeItem(k), TL_KEY)
const readTimeline = (page: Page): Promise<Mark[]> => page.evaluate((k) => JSON.parse(sessionStorage.getItem(k) || '[]') as Mark[], TL_KEY).catch(() => [])

/** Mốc mạng phía Playwright (≈ cùng đồng hồ hệ thống): RSC tới chi tiết và tài liệu tải cứng — chỉ loại + path/query. */
function netTrace(page: Page): NetMark[] {
  const out: NetMark[] = []
  const tag = (r: Request) => (isRsc(r) ? `rsc-${r.headers()['next-router-prefetch'] ? 'prefetch' : 'nav'}` : 'doc') + ' ' + pathSearch(r.url())
  const want = (r: Request) => (isRsc(r) && TO_DETAIL.test(r.url())) || r.resourceType() === 'document'
  page.on('request', (r) => { if (want(r)) out.push({ t: Date.now(), ev: `${tag(r)} gửi` }) })
  page.on('requestfinished', (r) => { if (want(r)) out.push({ t: Date.now(), ev: `${tag(r)} xong` }) })
  page.on('requestfailed', (r) => { if (want(r)) out.push({ t: Date.now(), ev: `${tag(r)} lỗi` }) })
  return out
}

type TimerFate = 'live' | 'cleared' | 'fired'
interface TimerRec { id: number; arm: number; due: number; fate: TimerFate; at: number | null; outcome?: 'hard' | 'noop-at-target' | 'noop-hidden' | 'noop-already' }
interface Verdict {
  click: number | null
  /** commit mềm đầu tiên tới đích (pushState / replaceState) trong tài liệu đang hiển thị lúc chạm */
  soft: number | null
  /** các timer 6 s arm SAU lần chạm vào đích (trước lần chạm link khác) — theo thứ tự arm */
  timers: TimerRec[]
  /** timer quyết định: timer có callback dẫn tới tải cứng, nếu không thì timer arm sau cùng */
  lastArm: number | null; due: number | null
  /** callback HIỆU LỰC (chạy khi URL chưa tới đích + tab hiện) — nguồn duy nhất của tải cứng */
  fire: number | null
  /** mọi callback đã chạy của các timer trên (kể cả no-op) */
  fires: { t: number; at: string | undefined; vis: string | undefined; outcome: string }[]
  clear: number | null
  /** timer còn sống (chưa huỷ, chưa chạy) ở cuối quan sát mà KHÔNG có tài liệu mới ⇒ cửa sổ quan sát chưa đủ */
  inconclusive: boolean
  newDoc: Mark | null
  expectHard: 0 | 1
  rule: string
}
/** ORACLE THUẦN (có test bảng + probe trình duyệt riêng): kỳ vọng số tải cứng tới `target` (path + query) sau MỘT lần chạm, suy từ
 *  THỨ TỰ sự kiện: callback của timer thuộc lần chạm này có thực sự chạy lúc URL chưa tới đích + tab hiện hay không. Không suy
 *  callback đã chạy từ việc đã qua deadline; không dùng số tài liệu quan sát được. */
function watchdogVerdict(marks: Mark[], target: string, ms: number = NAV_WATCHDOG_MS): Verdict {
  const ci = marks.findIndex((m) => m.k === 'click' && m.v === target)
  const click = ci < 0 ? null : marks[ci].t
  const after = ci < 0 ? marks : marks.slice(ci)                          // theo CHỈ SỐ, không theo t (t bằng nhau giữ thứ tự)
  const docIdx = after.findIndex((m, i) => i > 0 && m.k === 'doc')
  const first = docIdx < 0 ? after : after.slice(0, docIdx)              // sự kiện của tài liệu đang hiển thị lúc chạm
  const newDoc = docIdx < 0 ? null : after[docIdx]
  let cur: string | undefined = target, soft: number | null = null, clear: number | null = null, effective: TimerRec | null = null
  const timers = new Map<number, TimerRec>()
  const fires: Verdict['fires'] = []
  for (const m of first) {
    if (m.k === 'click') cur = m.v
    else if ((m.k === 'push' || m.k === 'replace') && m.v === target && soft === null) soft = m.t
    else if (m.k === 'arm' && m.id !== undefined && cur === target) timers.set(m.id, { id: m.id, arm: m.t, due: m.t + ms, fate: 'live', at: null })
    else if (m.k === 'clear' && m.id !== undefined) {
      const r = timers.get(m.id)
      if (r && r.fate === 'live') { r.fate = 'cleared'; r.at = m.t; clear = m.t }
    } else if (m.k === 'fire' && m.id !== undefined) {
      const r = timers.get(m.id)
      if (!r || r.fate !== 'live') continue                                 // timer không thuộc lần chạm này
      r.fate = 'fired'; r.at = m.t
      // Đúng guard của useNavWatchdog: fired.current || tab ẩn || isAtTarget ⇒ return; còn lại location.assign(target).
      r.outcome = effective ? 'noop-already' : m.vis === 'hidden' ? 'noop-hidden' : m.v === target ? 'noop-at-target' : 'hard'
      if (r.outcome === 'hard') effective = r
      fires.push({ t: m.t, at: m.v, vis: m.vis, outcome: r.outcome })
    }
  }
  const list = [...timers.values()]
  const decisive = effective ?? (list.length ? list[list.length - 1] : null)
  const inconclusive = !effective && newDoc === null && list.some((r) => r.fate === 'live')
  const base = { click, soft, timers: list, lastArm: decisive?.arm ?? null, due: decisive?.due ?? null, fire: effective?.at ?? null, fires, clear, inconclusive, newDoc }
  if (effective) return { ...base, expectHard: 1, rule: 'callback CHẠY khi URL chưa tới đích (tab hiện) ⇒ đúng 1 tải cứng' }
  if (inconclusive) return { ...base, expectHard: 0, rule: 'CHƯA KẾT LUẬN: timer còn sống, callback chưa chạy, chưa có tài liệu mới' }
  if (soft !== null) return { ...base, expectHard: 0, rule: fires.length ? 'commit mềm trước callback ⇒ callback no-op ⇒ 0 tải cứng' : 'commit mềm, timer bị huỷ trước callback ⇒ 0 tải cứng' }
  if (!list.length) return { ...base, expectHard: 0, rule: 'không có timer của lần chạm này ⇒ 0 tải cứng do watchdog' }
  if (newDoc && list.some((x) => x.fate === 'live')) return { ...base, expectHard: 0, rule: 'tài liệu mới KHÔNG do callback watchdog (timer mất theo trang cũ) ⇒ 0 tải cứng do watchdog' }
  return { ...base, expectHard: 0, rule: 'timer bị huỷ / callback no-op, không commit ⇒ 0 tải cứng do watchdog' }
}
/** Oracle r0 (chỉ để chứng minh phản ví dụ trong test bảng): đo từ lúc chạm. */
const oracleR0 = (dtFromClick: number): 0 | 1 => (dtFromClick < NAV_WATCHDOG_MS ? 0 : 1)
/** Oracle r1 (chỉ để chứng minh phản ví dụ PM 08/11 r1): commit trước deadline của arm cuối ⇒ 0, còn lại ⇒ 1. */
function oracleR1(marks: Mark[], target: string, ms: number = NAV_WATCHDOG_MS): 0 | 1 {
  const soft = marks.find((m) => (m.k === 'push' || m.k === 'replace') && m.v === target)?.t ?? null
  const arms = marks.filter((m) => m.k === 'arm' && (soft === null || m.t <= soft))
  const due = arms.length ? arms[arms.length - 1].t + ms : null
  return soft !== null && (due === null || soft < due) ? 0 : 1
}

/** Chờ QUA HẾT cửa sổ timer (arm cuối + 6 s + slack, theo đồng hồ trang) trước khi chốt số tải cứng. */
async function waitPastDue(page: Page, slack = 1_500) {
  const marks = await readTimeline(page)
  const arms = marks.filter((m) => m.k === 'arm')
  const from = arms.length ? arms[arms.length - 1].t : (marks.find((m) => m.k === 'click')?.t ?? null)
  const now = await page.evaluate(() => performance.timeOrigin + performance.now())
  const until = (from ?? now) + NAV_WATCHDOG_MS + slack
  if (until > now) await page.waitForTimeout(until - now)
}

/** Đọc dòng thời gian + tính kỳ vọng + ĐÍNH KÈM chẩn đoán — gọi TRƯỚC mọi assert thời gian. */
async function diagnose(page: Page, testInfo: TestInfo, label: string, target: string, loads: string[], net: NetMark[], extra: unknown = null) {
  const marks = await readTimeline(page)
  const v = watchdogVerdict(marks, target)
  const rel = (t: number | null | undefined) => (t == null || v.click === null ? null : Math.round(t - v.click))
  const timeline = marks.map((m) => `${rel(m.t)}:${m.k}${m.id !== undefined ? `#${m.id}` : ''}${m.v ? ` ${m.v}` : ''}${m.vis && m.vis !== 'visible' ? ` (${m.vis})` : ''}`)
  const summary = {
    label, target, url: pathSearch(page.url()), hardLoads: loads, rule: v.rule, expectHard: v.expectHard, inconclusive: v.inconclusive,
    msFromClick: { arm: rel(v.lastArm), due: rel(v.due), soft: rel(v.soft), fire: rel(v.fire), clear: rel(v.clear), newDoc: rel(v.newDoc?.t) },
    timers: v.timers.map((r) => ({ id: r.id, arm: rel(r.arm), due: rel(r.due), fate: r.fate, at: rel(r.at), outcome: r.outcome ?? null })),
    fires: v.fires.map((f) => ({ ...f, t: rel(f.t) })),
    timeline, net: net.map((n) => `${rel(n.t)}≈ ${n.ev}`), extra,
  }
  await testInfo.attach(`nav1-${label}`, { body: JSON.stringify(summary, null, 1), contentType: 'application/json' })
  return { v, summary, text: `[${label}] ${v.rule} · tải cứng ${loads.length} · ${timeline.join(' ')}` }
}

/** Lỗi ở BẤT KỲ bước chờ / assert nào ⇒ vẫn đính kèm chẩn đoán dòng thời gian (nhãn `<label>-fail`) rồi ném lại nguyên lỗi. */
async function withTimeline<T>(page: Page, testInfo: TestInfo, label: string, target: string, loads: string[], net: NetMark[], body: () => Promise<T>, extra: () => unknown = () => null): Promise<T> {
  try {
    return await body()
  } catch (e) {
    await diagnose(page, testInfo, `${label}-fail`, target, loads, net, extra()).catch(() => {})
    throw e
  }
}

/** Ca "mạng chậm 3 s" TẤT ĐỊNH, tách khỏi độ trễ server (máy Dev đọc DB prod qua mạng: 1–12 s tuỳ lúc — spec cũ "chờ 3 s RỒI
 *  mới gửi" cộng thêm đúng khoảng đó). Fixture RSC thật: lượt 1 ("capture") để request RSC điều hướng tới chi tiết đi thẳng server và
 *  GIỮ LẠI phản hồi thật (status + body + header, bỏ set-cookie); lượt 2 ("serve", sau khi tải lại /targets cho router sạch) trả
 *  ĐÚNG phản hồi đó cho trình duyệt đúng `ms` sau lúc trình duyệt gửi — không chạm server. Cùng build, cùng cây router (cùng xuất
 *  phát từ /targets tải mới) ⇒ payload hợp lệ. Thẻ chiến dịch prefetch={false} ⇒ không có prefetch chen vào. */
async function rscFixtureAt(page: Page, ms: number) {
  type Saved = { status: number; headers: Record<string, string>; body: Buffer }
  const keyOf = (u: string) => { const x = new URL(u); x.searchParams.delete('_rsc'); return x.pathname + x.search }
  const cache = new Map<string, Saved>()
  const captured: { key: string; fetchMs: number; status: number | null }[] = []
  const served: { key: string; hit: boolean; servedAtMs: number }[] = []
  let mode: 'capture' | 'serve' = 'capture'
  await page.route(TO_DETAIL, async (route) => {
    const req = route.request()
    if (!isRsc(req) || req.headers()['next-router-prefetch']) return route.continue()
    const key = keyOf(req.url())
    const t0 = Date.now()
    if (mode === 'capture') {
      const resp = await route.fetch().catch(() => null)
      captured.push({ key, fetchMs: Date.now() - t0, status: resp ? resp.status() : null })
      if (resp && resp.ok()) {
        const headers = { ...resp.headers() }
        delete headers['set-cookie']
        cache.set(key, { status: resp.status(), headers, body: await resp.body() })
      }
      // Trình duyệt có thể đã huỷ request (watchdog tải cứng khi server > 6 s) — không sao, đã giữ phản hồi.
      if (resp) await route.fulfill({ response: resp }).catch(() => {})
      else await route.abort().catch(() => {})
      return
    }
    const hit = cache.get(key)
    if (!hit) { served.push({ key, hit: false, servedAtMs: 0 }); return route.continue() }
    const wait = ms - (Date.now() - t0)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    served.push({ key, hit: true, servedAtMs: Date.now() - t0 })
    await route.fulfill({ status: hit.status, headers: hit.headers, body: hit.body }).catch(() => {})
  })
  return { cache, captured, served, serve: () => { mode = 'serve' }, keyOf }
}

test.describe('NAV-1 watchdog thẻ chiến dịch @mobile', () => {
  test.use({ storageState: STAFF_STATE, viewport: VIEWPORT })
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(120_000)
  })

  test('hàm thuần: chỉ href nội bộ cùng origin; đích = path + query', async () => {
    const o = 'http://localhost:3130'
    expect(internalTarget('/targets?campaign=1', o)?.pathname).toBe('/targets')
    for (const bad of ['https://zalo.me/123', '//evil.example/x', 'tel:0900000000', 'sms:0900000000', 'targets?x=1', 'javascript:alert(1)',
      '/.//evil.example', '/\\evil.example', '/\t/evil.example']) {
      expect(internalTarget(bad, o), bad).toBeNull()
    }
    const t = internalTarget('/targets?campaign=1', o)!
    expect(isAtTarget(t, { pathname: '/targets', search: '?campaign=1' })).toBe(true)
    expect(isAtTarget(t, { pathname: '/targets', search: '' })).toBe(false)
    expect(NAV_WATCHDOG_MS).toBe(6000)
  })

  test('oracle (hàm thuần): theo THỨ TỰ commit / huỷ / callback, không suy callback từ deadline — phản ví dụ PM r0 + r1', () => {
    const T = '/targets?campaign=fx-1', L = '/targets', B = '/targets?campaign=fx-2'
    const T0 = 1_700_000_000_000
    // Dựng dòng thời gian theo ĐÚNG thứ tự viết (chỉ số mảng = thứ tự thật); t chỉ là dấu thời gian.
    const ev = {
      click: (t: number, v = T): Mark => ({ t: T0 + t, k: 'click', v }),
      arm: (t: number, id: number): Mark => ({ t: T0 + t, k: 'arm', id }),
      clear: (t: number, id: number): Mark => ({ t: T0 + t, k: 'clear', id }),
      fire: (t: number, id: number, at: string, vis = 'visible'): Mark => ({ t: T0 + t, k: 'fire', v: at, id, vis }),
      push: (t: number, v = T): Mark => ({ t: T0 + t, k: 'push', v }),
      replace: (t: number, v = T): Mark => ({ t: T0 + t, k: 'replace', v }),
      doc: (t: number, v = T): Mark => ({ t: T0 + t, k: 'doc', v }),
      pend: (t: number, on: boolean): Mark => ({ t: T0 + t, k: on ? 'pending+' : 'pending-' }),
    }
    const ms3 = (x: number | null) => (x === null ? null : Math.round((x - T0) * 1000) / 1000)   // tránh sai số dấu phẩy động của t lớn
    const r = (v: Verdict) => ({ expectHard: v.expectHard, inconclusive: v.inconclusive, fire: ms3(v.fire), due: ms3(v.due) })
    const cases: { name: string; marks: Mark[]; target?: string; want: ReturnType<typeof r>; r0?: 0 | 1; r1?: 0 | 1 }[] = [
      { name: 'PM r0: arm 84, commit 6.030 (trước hạn 6.084), huỷ 6.033 ⇒ 0 (oracle r0 đòi 1)',
        marks: [ev.click(0), ev.pend(9, true), ev.arm(84, 1), ev.push(6030), ev.pend(6031, false), ev.clear(6033, 1)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 6084 }, r0: 1, r1: 0 },
      { name: 'PM r1: arm 0,1, main thread bận, commit + huỷ 6.030,1 (SAU hạn, TRƯỚC callback) ⇒ 0 (oracle r1 đòi 1)',
        marks: [ev.click(0), ev.arm(0.1, 7), ev.push(6030.1), ev.clear(6030.1, 7)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 6000.1 }, r1: 1 },
      { name: 'commit sau hạn, callback chạy SAU commit ⇒ no-op ⇒ 0 (oracle r1 đòi 1)',
        marks: [ev.click(0), ev.arm(84, 1), ev.push(6090), ev.fire(6100, 1, T)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 6084 }, r1: 1 },
      { name: 'callback chạy khi còn pending (URL chưa tới đích) ⇒ tải cứng ⇒ 1',
        marks: [ev.click(0), ev.arm(84, 1), ev.fire(6084, 1, L), ev.doc(6101)],
        want: { expectHard: 1, inconclusive: false, fire: 6084, due: 6084 } },
      { name: 'callback chạy rồi commit mềm muộn hơn ⇒ tải cứng đã kích hoạt ⇒ 1',
        marks: [ev.click(0), ev.arm(84, 1), ev.fire(6084, 1, L), ev.push(6090)],
        want: { expectHard: 1, inconclusive: false, fire: 6084, due: 6084 } },
      { name: 'dấu thời gian BẰNG NHAU: callback ghi trước commit ⇒ 1',
        marks: [ev.click(0), ev.arm(0, 1), ev.fire(6000, 1, L), ev.push(6000)],
        want: { expectHard: 1, inconclusive: false, fire: 6000, due: 6000 } },
      { name: 'dấu thời gian BẰNG NHAU: commit ghi trước callback ⇒ no-op ⇒ 0',
        marks: [ev.click(0), ev.arm(0, 1), ev.push(6000), ev.fire(6000, 1, T)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 6000 } },
      { name: 'mạng 3 s: commit 3.300, huỷ 3.305 ⇒ 0',
        marks: [ev.click(0), ev.arm(60, 1), ev.push(3300), ev.clear(3305, 1)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 6060 }, r0: 0, r1: 0 },
      { name: 'commit TRƯỚC arm (điều hướng nhanh), huỷ ngay ⇒ 0',
        marks: [ev.click(0), ev.push(40), ev.arm(60, 1), ev.clear(70, 1)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 6060 } },
      { name: 'commit TRƯỚC arm, timer không huỷ, callback chạy tại đích ⇒ no-op ⇒ 0',
        marks: [ev.click(0), ev.push(40), ev.arm(60, 1), ev.fire(6060, 1, T)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 6060 } },
      { name: 'tab ẩn (huỷ) rồi hiện (arm lại): callback của lần arm lại ⇒ 1, hạn từ lần arm lại',
        marks: [ev.click(0), ev.arm(50, 1), ev.clear(1000, 1), ev.arm(8000, 2), ev.fire(14000, 2, L), ev.doc(14010)],
        want: { expectHard: 1, inconclusive: false, fire: 14000, due: 14000 } },
      { name: 'tab ẩn rồi hiện, commit 13.000 trước callback lần arm lại ⇒ 0',
        marks: [ev.click(0), ev.arm(50, 1), ev.clear(1000, 1), ev.arm(8000, 2), ev.push(13000), ev.clear(13001, 2)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 14000 } },
      { name: 'callback chạy lúc tab đang ẩn ⇒ guard no-op ⇒ 0',
        marks: [ev.click(0), ev.arm(50, 1), ev.fire(6050, 1, L, 'hidden')],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 6050 } },
      { name: 'điều hướng bị huỷ (chạm A rồi B): timer A huỷ ⇒ A: 0',
        marks: [ev.click(0), ev.arm(50, 1), ev.click(2000, B), ev.clear(2001, 1), ev.arm(2010, 2), ev.fire(8010, 2, L), ev.doc(8020, B)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 6050 } },
      { name: 'điều hướng bị huỷ (chạm A rồi B): timer B chạy ⇒ B: 1',
        marks: [ev.click(0), ev.arm(50, 1), ev.click(2000, B), ev.clear(2001, 1), ev.arm(2010, 2), ev.fire(8010, 2, L), ev.doc(8020, B)], target: B,
        want: { expectHard: 1, inconclusive: false, fire: 8010, due: 8010 } },
      { name: 'timer 6 s KHÁC arm trước lần chạm không được tính',
        marks: [ev.arm(-500, 9), ev.click(0), ev.push(300), ev.fire(5500, 9, T)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: null } },
      { name: 'replaceState về URL KHÁC đích không phải commit; callback ⇒ 1',
        marks: [ev.click(0), ev.arm(84, 1), ev.replace(200, L), ev.fire(6084, 1, L)],
        want: { expectHard: 1, inconclusive: false, fire: 6084, due: 6084 } },
      { name: 'quan sát dừng khi timer còn sống, chưa callback ⇒ CHƯA KẾT LUẬN',
        marks: [ev.click(0), ev.arm(84, 1)],
        want: { expectHard: 0, inconclusive: true, fire: null, due: 6084 } },
      { name: 'tài liệu mới KHÔNG do callback (không có fire) ⇒ watchdog 0 ⇒ tải cứng quan sát được sẽ làm test đỏ',
        marks: [ev.click(0), ev.arm(84, 1), ev.doc(3000), ev.replace(3100)],
        want: { expectHard: 0, inconclusive: false, fire: null, due: 6084 } },
    ]
    for (const c of cases) {
      const v = watchdogVerdict(c.marks, c.target ?? T)
      expect(r(v), c.name).toEqual(c.want)
      if (c.r0 !== undefined) expect(oracleR0((c.marks.find((m) => m.k === 'push')?.t ?? T0) - T0), `oracle r0 · ${c.name}`).toBe(c.r0)
      if (c.r1 !== undefined) expect(oracleR1(c.marks, c.target ?? T), `oracle r1 · ${c.name}`).toBe(c.r1)
    }
    // Giữ nguyên chi tiết ca PM r1 (bằng chứng ui-nav-pm-r1-20261108): không callback nào chạy; timer kết thúc bằng huỷ.
    const pm = watchdogVerdict(cases[1].marks, T)
    expect(pm.fires).toEqual([])
    expect(pm.timers.map((x) => x.fate)).toEqual(['cleared'])
  })

  test('điều hướng mềm bình thường: oracle dòng thời gian — commit trước hạn ⇒ 0 tải cứng; chậm / treo thật ⇒ đúng 1 do timer', async ({ page }, testInfo) => {
    await installTimeline(page)
    const net = netTrace(page)
    const loads = hardLoads(page)
    const cards = await landing(page)
    const target = pathSearch((await cards.first().getAttribute('href'))!)
    await resetTimeline(page)
    await tap(cards.first())
    await withTimeline(page, testInfo, 'normal', target, loads, net, async () => {
      await expect(page).toHaveURL(TO_DETAIL, { timeout: NAV_WATCHDOG_MS + 15_000 })
      await waitPastDue(page)
    })
    const d = await diagnose(page, testInfo, 'normal', target, loads, net)
    // Server chậm quá hạn hoặc lỗi treo thật (~2 % phiên mới) vẫn có thể rơi đúng lượt này — khi đó callback timer THỰC SỰ chạy lúc URL
    // chưa tới đích ⇒ oracle đòi đúng 1 tải cứng; commit sau hạn nhưng trước callback (hoặc callback no-op tại đích) ⇒ 0 — đúng thiết kế.
    expect(d.v.inconclusive, `cửa sổ quan sát chưa đủ · ${d.text}`).toBe(false)
    expect(loads.length, d.text).toBe(d.v.expectHard)
    if (d.v.expectHard === 1) {
      expect(d.v.fire! - d.v.lastArm!, `callback chạy SỚM hơn ${NAV_WATCHDOG_MS} ms sau arm · ${d.text}`).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 5)
      expect(d.v.newDoc?.t ?? 0, `tài liệu mới phải bắt đầu sau callback · ${d.text}`).toBeGreaterThanOrEqual(d.v.fire!)
    }
    testInfo.annotations.push({ type: 'nav-1 normal', description: d.v.rule })
  })

  test('mạng chậm 3 s (fixture RSC thật trả đúng 3 s) ⇒ commit mềm dưới ngưỡng, huỷ timer, 0 tải cứng tới hết cửa sổ timer', async ({ page }, testInfo) => {
    await installTimeline(page)
    const rig = await rscFixtureAt(page, 3_000)
    const net = netTrace(page)
    const loads = hardLoads(page)
    let cards = await landing(page)
    const target = pathSearch((await cards.first().getAttribute('href'))!)
    // Lượt 1 (capture): lấy phản hồi RSC thật của đúng đích — không assert thời gian (server có thể chậm, watchdog có thể tải cứng).
    await tap(cards.first())
    await expect.poll(() => rig.cache.has(target), { message: `không giữ được phản hồi RSC thật của ${target} · ${JSON.stringify(rig.captured)}`, timeout: 45_000 }).toBe(true)
    // Lượt 2 (serve): router sạch (tải lại /targets), đếm lại từ đầu.
    rig.serve()
    cards = await landing(page)
    loads.length = 0
    net.length = 0
    await resetTimeline(page)
    await tap(cards.first())
    const extra = () => ({ captured: rig.captured, served: rig.served })
    await withTimeline(page, testInfo, '3s', target, loads, net, async () => {
      await expect(cards.first().locator('[data-nav-pending]'), 'không hiện trạng thái chờ khi pending').toBeAttached({ timeout: 2_000 })
      await expect(page).toHaveURL(TO_DETAIL, { timeout: NAV_WATCHDOG_MS + 15_000 })
      await waitPastDue(page)
    }, extra)
    const d = await diagnose(page, testInfo, '3s', target, loads, net, extra())
    // Tiền điều kiện fixture (tất định, không phụ thuộc server): đúng một request RSC điều hướng, phục vụ từ bản đã giữ, đúng ~3 s.
    expect(rig.served.length, `tiền điều kiện: đúng 1 request RSC điều hướng ở lượt 2 · ${d.text}`).toBe(1)
    expect(rig.served[0].hit, `tiền điều kiện: phải phục vụ từ phản hồi đã giữ · ${d.text}`).toBe(true)
    expect(rig.served[0].servedAtMs, `phản hồi phải tới sau ≈ 3 s · ${d.text}`).toBeGreaterThanOrEqual(3_000)
    expect(rig.served[0].servedAtMs, `phản hồi phải tới sau ≈ 3 s · ${d.text}`).toBeLessThan(3_500)
    expect(d.v.soft, `điều hướng mềm phải commit tới đích · ${d.text}`).not.toBeNull()
    expect(d.v.soft! - d.v.click!, `commit mềm phải dưới ngưỡng ${NAV_WATCHDOG_MS} ms tính từ lúc chạm · ${d.text}`).toBeLessThan(NAV_WATCHDOG_MS)
    expect(d.v.expectHard, d.text).toBe(0)
    expect(d.v.inconclusive, `cửa sổ quan sát chưa đủ · ${d.text}`).toBe(false)
    expect(d.v.timers.length, `timer phải được arm khi pending · ${d.text}`).toBeGreaterThan(0)
    expect(d.v.timers.map((x) => x.fate), `mọi timer của lần chạm phải bị HUỶ (không chạy) sau commit · ${d.text}`).toEqual(d.v.timers.map(() => 'cleared'))
    expect(d.v.fires, `callback timer không được chạy · ${d.text}`).toEqual([])
    expect(loads, `không được tải cứng · ${d.text}`).toEqual([])
    testInfo.annotations.push({ type: 'nav-1 3s', description: `commit mềm ${Math.round(d.v.soft! - d.v.click!)} ms sau chạm · hạn ${Math.round(d.v.due! - d.v.click!)} ms · lượt capture server ${rig.captured.map((c) => c.fetchMs).join('/')} ms` })
  })

  test('RSC treo ⇒ sau 6 s tải cứng đúng MỘT lần tới đích; quay lại về danh sách', async ({ page }, testInfo) => {
    await installTimeline(page)
    await holdDetailRsc(page)
    const net = netTrace(page)
    const loads = hardLoads(page)
    const cards = await landing(page)
    const href = (await cards.first().getAttribute('href'))!
    const target = pathSearch(href)
    await resetTimeline(page)
    const t0 = Date.now()
    await tap(cards.first())
    await withTimeline(page, testInfo, 'held', target, loads, net, async () => {
      await expect(cards.first().locator('[data-nav-pending]'), 'không hiện trạng thái chờ khi pending').toBeAttached({ timeout: 2_000 })
      await page.waitForTimeout(NAV_WATCHDOG_MS - 1_000)
      expect(loads, 'tải cứng sớm hơn mốc watchdog').toEqual([])
      await expect(page).toHaveURL(TO_DETAIL, { timeout: 15_000 })
      expect(Date.now() - t0).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 200)
      await expect(page.getByRole('link', { name: /Danh sách chiến dịch/ }).first(), 'tải cứng không tới trang chi tiết').toBeVisible({ timeout: 20_000 })
      await page.waitForTimeout(2_000)
    })
    const d = await diagnose(page, testInfo, 'held', target, loads, net)
    expect(d.v.soft, `RSC treo thì không được commit mềm · ${d.text}`).toBeNull()
    expect(d.v.expectHard, d.text).toBe(1)
    expect(d.v.fire, `callback timer phải chạy lúc URL chưa tới đích · ${d.text}`).not.toBeNull()
    expect(d.v.fires.filter((x) => x.outcome === 'hard'), `đúng MỘT callback hiệu lực · ${d.text}`).toHaveLength(1)
    expect(d.v.fire! - d.v.lastArm!, `callback chạy SỚM hơn ${NAV_WATCHDOG_MS} ms sau arm · ${d.text}`).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 5)
    expect(d.v.newDoc?.t ?? 0, `tài liệu mới phải bắt đầu sau khi callback chạy · ${d.text}`).toBeGreaterThanOrEqual(d.v.fire!)
    expect(loads, `phải đúng một tải cứng, đúng đích · ${d.text}`).toEqual([searchOf(href)])
    await page.goBack()
    await expect(page).toHaveURL(/\/targets$/, { timeout: 15_000 })
    await expect(page.locator(CARD).first()).toBeAttached({ timeout: 20_000 })
  })

  test('chạm thẻ A rồi thẻ B khi cả hai treo ⇒ chỉ B được tải cứng', async ({ page }) => {
    const n = await rlsActiveCampaigns()
    test.skip(n < 2, `store staff QA có ${n} chiến dịch đang chạy (RLS) — ca cần ≥ 2 thẻ`)
    await holdDetailRsc(page)
    const loads = hardLoads(page)
    const cards = await landing(page)
    await expect(cards, `RLS thấy ${n} chiến dịch mà trang không đủ thẻ`).toHaveCount(n, { timeout: 20_000 })
    const hrefB = (await cards.nth(1).getAttribute('href'))!
    await tap(cards.nth(0))
    await page.waitForTimeout(2_000)
    const tB = Date.now()
    await tap(cards.nth(1))
    await expect(page).toHaveURL(new RegExp(searchOf(hrefB).replace(/[?]/g, '\\?')), { timeout: NAV_WATCHDOG_MS + 15_000 })
    expect(Date.now() - tB).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 200)
    await page.waitForTimeout(2_000)
    expect(loads, 'chỉ link chạm sau cùng được tải cứng').toEqual([searchOf(hrefB)])
  })

  test('tab ẩn ⇒ huỷ đếm; hiện lại ⇒ đếm lại đủ 6 s rồi mới tải cứng', async ({ page }, testInfo) => {
    await installTimeline(page)
    await holdDetailRsc(page)
    const net = netTrace(page)
    const loads = hardLoads(page)
    const cards = await landing(page)
    const target = pathSearch((await cards.first().getAttribute('href'))!)
    await resetTimeline(page)
    await tap(cards.first())
    await withTimeline(page, testInfo, 'hidden', target, loads, net, async () => {
      await page.waitForTimeout(1_000)
      await setVisibility(page, 'hidden')
      await page.waitForTimeout(NAV_WATCHDOG_MS + 1_000)
      expect(loads, 'tab ẩn mà vẫn tải cứng').toEqual([])
      const tV = Date.now()
      await setVisibility(page, 'visible')
      await expect(page).toHaveURL(TO_DETAIL, { timeout: NAV_WATCHDOG_MS + 15_000 })
      expect(Date.now() - tV).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 200)
    })
    const d = await diagnose(page, testInfo, 'hidden', target, loads, net)
    expect(d.v.expectHard, d.text).toBe(1)
    expect(d.v.timers.length, `hiện lại phải arm timer MỚI · ${d.text}`).toBeGreaterThanOrEqual(2)
    expect(d.v.timers[0].fate, `ẩn tab phải HUỶ timer đầu · ${d.text}`).toBe('cleared')
    expect(d.v.lastArm, `callback hiệu lực phải thuộc lần arm lại · ${d.text}`).not.toBe(d.v.timers[0].arm)
    expect(d.v.fire! - d.v.lastArm!, `callback chạy SỚM hơn ${NAV_WATCHDOG_MS} ms sau lần arm lại · ${d.text}`).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 5)
    expect(loads.length, d.text).toBe(d.v.expectHard)
  })

  test('phiên bị thu hồi lúc đang treo ⇒ tải cứng một lần, dừng ở /login, không lặp', async ({ page }, testInfo) => {
    await installTimeline(page)
    await holdDetailRsc(page)
    const net = netTrace(page)
    const loads = hardLoads(page)
    const cards = await landing(page)
    const target = pathSearch((await cards.first().getAttribute('href'))!)
    await resetTimeline(page)
    await tap(cards.first())
    await withTimeline(page, testInfo, 'revoked', target, loads, net, async () => {
      await page.waitForTimeout(1_000)
      await page.context().clearCookies()
      await expect(page).toHaveURL(/\/login/, { timeout: NAV_WATCHDOG_MS + 15_000 })
      await page.waitForTimeout(4_000)
    })
    const d = await diagnose(page, testInfo, 'revoked', target, loads, net)
    expect(d.v.expectHard, d.text).toBe(1)
    expect(loads.length, `tải cứng phải đúng một lần · ${d.text}`).toBe(1)
    await expect(page).toHaveURL(/\/login/)
  })
})

// Lỗi THẬT (không giữ RSC): MÔ PHỎNG metadata phiên hết hạn (sửa expires_at trong JSON cookie của phiên vừa đăng nhập — không đổi
// JWT có chữ ký, không phải access token hết exp / refresh token bị thu hồi thật) — điều kiện làm lỗi treo tăng mạnh. Mỗi lượt context
// mới + đăng nhập mới (không đụng storageState dùng chung). Lượt nào treo thì watchdog phải đưa tới chi tiết.
test.describe('NAV-1 phiên hết hạn — chạm một lần luôn tới chi tiết @mobile', () => {
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(300_000)
  })

  async function expiredContext(browser: Browser, baseURL: string) {
    const sb = await sessionDb(STAFF.email!, STAFF.password!)
    const { data: { session } } = await sb.auth.getSession()
    expect(session, 'không lấy được phiên staff QA').toBeTruthy()
    const value = 'base64-' + Buffer.from(JSON.stringify({ ...session, expires_at: Math.floor(Date.now() / 1000) - 60 })).toString('base64url')
    const name = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]}-auth-token`
    const MAX = 3180   // @supabase/ssr chia cookie dài thành <tên>.0, <tên>.1, …
    const cookies = value.length <= MAX ? [{ name, value, url: baseURL }]
      : Array.from({ length: Math.ceil(value.length / MAX) }, (_, i) => ({ name: `${name}.${i}`, value: value.slice(i * MAX, (i + 1) * MAX), url: baseURL }))
    const ctx = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, baseURL })
    await ctx.addCookies(cookies)
    return ctx
  }

  test('6 lượt phiên hết hạn: mỗi lượt chạm một lần đều tới chi tiết', async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL!
    const rounds: string[] = []
    for (let i = 0; i < 6; i++) {
      const ctx = await expiredContext(browser, baseURL)
      const page = await ctx.newPage()
      await installTimeline(page)
      const net = netTrace(page)
      const loads = hardLoads(page)
      const cards = await landing(page)
      const target = pathSearch((await cards.first().getAttribute('href'))!)
      await resetTimeline(page)
      await tap(cards.first())
      await withTimeline(page, testInfo, `expired-${i + 1}`, target, loads, net, async () => {
        await expect(page, `lượt ${i + 1}: chạm không tới chi tiết`).toHaveURL(TO_DETAIL, { timeout: NAV_WATCHDOG_MS + 15_000 })
        await expect(page.getByRole('link', { name: /Danh sách chiến dịch/ }).first()).toBeVisible({ timeout: 20_000 })
        await waitPastDue(page)
      })
      const d = await diagnose(page, testInfo, `expired-${i + 1}`, target, loads, net)
      expect(d.v.inconclusive, `lượt ${i + 1}: cửa sổ quan sát chưa đủ · ${d.text}`).toBe(false)
      expect(loads.length, `lượt ${i + 1}: ${d.text}`).toBe(d.v.expectHard)
      rounds.push(d.v.soft !== null ? `mềm ${Math.round(d.v.soft - d.v.click!)}ms` : `tải cứng (timer ${d.v.fire === null ? '—' : Math.round(d.v.fire - d.v.lastArm!)}ms sau arm)`)
      await ctx.close()
    }
    testInfo.annotations.push({ type: 'nav-1 lượt', description: rounds.join(' · ') })
  })
})

// UI-NAV r2 (PM r1 §3 điều kiện đóng): PROBE Chromium điều khiển task / microtask — KHÔNG app, KHÔNG mạng (trang tĩnh do page.route trả
// cho origin giả). Bản sao đúng callback của useNavWatchdog (guard `isAtTarget` lấy NGUYÊN mã production qua toString), chạm link với
// preventDefault (= điều hướng mềm pending), rồi chặn main thread qua deadline 6 s và quyết định thứ tự commit / huỷ / callback bằng
// chính event loop của trình duyệt. Oracle phải dự đoán đúng số tải cứng quan sát được ở MỌI thứ tự — kể cả phản ví dụ PM r1 mà oracle
// r1 (deadline) đoán sai. Không chứng minh lỗi treo React thật hay nguyên nhân các ca đỏ lịch sử.
test.describe('NAV-1 oracle — probe Chromium task / microtask (không app, không mạng) @mobile', () => {
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(60_000)
  })
  const ORIGIN = 'http://nav1-probe.test'
  const LIST = '/targets', TARGET = '/targets?campaign=probe'
  type Then = 'commit+clear' | 'commit' | 'microtask-commit' | 'none'

  async function probe(page: Page, then: Then, blockMs = NAV_WATCHDOG_MS + 30) {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><meta charset="utf-8"><title>nav1-probe</title><a id="go" href="${TARGET}">go</a>`,
    }))
    await installTimeline(page)
    const docs: string[] = []
    page.on('request', (r) => { if (r.resourceType() === 'document' && pathSearch(r.url()) === TARGET) docs.push(pathSearch(r.url())) })
    await page.goto(ORIGIN + LIST)
    await resetTimeline(page)
    await page.evaluate(({ ms, isAtSrc }) => {
      const isAt = (0, eval)(`(${isAtSrc})`) as (t: URL, l: Location) => boolean
      const w = window as unknown as { __timer?: number; __armAt?: number }
      let fired = false
      const a = document.getElementById('go') as HTMLAnchorElement
      a.addEventListener('click', (e) => {
        e.preventDefault()                                   // điều hướng mềm "pending": URL chưa đổi
        const target = new URL(a.getAttribute('href')!, location.origin)
        w.__timer = window.setTimeout(() => {               // = callback useNavWatchdog
          if (fired || document.visibilityState !== 'visible' || isAt(target, location)) return
          fired = true
          location.assign(target.href)
        }, ms)
        w.__armAt = performance.now()
      })
    }, { ms: NAV_WATCHDOG_MS, isAtSrc: isAtTarget.toString() })
    await page.click('#go')
    await page.evaluate(({ blockMs, then, target }) => {
      const w = window as unknown as { __timer?: number; __armAt?: number }
      const end = w.__armAt! + blockMs
      while (performance.now() < end) { /* main thread bận: callback đã tới hạn nhưng KHÔNG thể chạy */ }
      if (then === 'commit+clear') { history.pushState(null, '', target); window.clearTimeout(w.__timer) }   // commit + cleanup cùng task
      else if (then === 'commit') history.pushState(null, '', target)                                        // commit, không huỷ timer
      else if (then === 'microtask-commit') queueMicrotask(() => history.pushState(null, '', target))        // commit ở microtask, trước task timer
    }, { blockMs, then, target: TARGET })
    if (then === 'none') await page.waitForURL(ORIGIN + TARGET, { timeout: 10_000 })
    await page.waitForTimeout(1_500)
    const marks = await readTimeline(page)
    return { marks, docs, v: watchdogVerdict(marks, TARGET) }
  }
  const armOf = (marks: Mark[]) => marks.find((m) => m.k === 'arm')!.t
  const softOf = (marks: Mark[]) => marks.find((m) => m.k === 'push' && m.v === TARGET)?.t ?? null

  test('phản ví dụ PM r1: commit + huỷ SAU deadline, TRƯỚC callback ⇒ callback không chạy ⇒ 0 tải cứng (oracle r1 đoán 1)', async ({ page }, testInfo) => {
    const { marks, docs, v } = await probe(page, 'commit+clear')
    await testInfo.attach('probe-commit-clear', { body: JSON.stringify({ v, marks }, null, 1), contentType: 'application/json' })
    expect(softOf(marks)! - armOf(marks), 'tiền điều kiện: commit phải SAU deadline').toBeGreaterThanOrEqual(NAV_WATCHDOG_MS)
    expect(v.fires, 'callback không được chạy (timer đã huỷ)').toEqual([])
    expect(v.timers.map((x) => x.fate)).toEqual(['cleared'])
    expect(docs, 'trình duyệt thật: 0 tải cứng').toEqual([])
    expect(v.expectHard, v.rule).toBe(docs.length)
    expect(oracleR1(marks, TARGET), 'oracle r1 (deadline) đoán sai ở ca này').toBe(1)
  })

  test('commit SAU deadline, timer KHÔNG huỷ ⇒ callback chạy sau commit, guard no-op ⇒ 0 tải cứng', async ({ page }, testInfo) => {
    const { marks, docs, v } = await probe(page, 'commit')
    await testInfo.attach('probe-commit', { body: JSON.stringify({ v, marks }, null, 1), contentType: 'application/json' })
    expect(softOf(marks)! - armOf(marks)).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS)
    expect(v.fires.map((f) => f.outcome), 'callback chạy đúng một lần, tại đích').toEqual(['noop-at-target'])
    expect(v.fires[0].t, 'callback chạy SAU commit').toBeGreaterThanOrEqual(softOf(marks)!)
    expect(docs).toEqual([])
    expect(v.expectHard, v.rule).toBe(docs.length)
    expect(oracleR1(marks, TARGET), 'oracle r1 (deadline) đoán sai ở ca này').toBe(1)
  })

  test('commit ở MICROTASK ngay sau task chặn ⇒ chạy trước task timer quá hạn ⇒ callback no-op ⇒ 0 tải cứng', async ({ page }, testInfo) => {
    const { marks, docs, v } = await probe(page, 'microtask-commit')
    await testInfo.attach('probe-microtask', { body: JSON.stringify({ v, marks }, null, 1), contentType: 'application/json' })
    const iSoft = marks.findIndex((m) => m.k === 'push'), iFire = marks.findIndex((m) => m.k === 'fire')
    expect(iSoft, 'commit (microtask) ghi trước callback (task)').toBeLessThan(iFire)
    expect(v.fires.map((f) => f.outcome)).toEqual(['noop-at-target'])
    expect(docs).toEqual([])
    expect(v.expectHard, v.rule).toBe(docs.length)
  })

  test('không commit: callback quá hạn chạy khi URL chưa tới đích ⇒ đúng 1 tải cứng, không sớm hơn 6 s sau arm', async ({ page }, testInfo) => {
    const { marks, docs, v } = await probe(page, 'none')
    await testInfo.attach('probe-none', { body: JSON.stringify({ v, marks }, null, 1), contentType: 'application/json' })
    expect(v.fires.map((f) => f.outcome)).toEqual(['hard'])
    expect(v.fire! - v.lastArm!).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS)
    expect(v.newDoc?.t ?? 0, 'tài liệu mới sau callback').toBeGreaterThanOrEqual(v.fire!)
    expect(docs).toEqual([TARGET])
    expect(v.expectHard, v.rule).toBe(docs.length)
  })
})
