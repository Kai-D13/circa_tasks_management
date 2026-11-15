import type { Page, Request } from '@playwright/test'
import { NAV_WATCHDOG_MS } from '../lib/nav/watchdog'

// ─────────────────────────────────────────────────────────────────────────────
// NAV-REPEAT-1 — oracle CHỨC NĂNG tách URL / nội dung / load (PM 15/11/2026, planning/reviews/
// 2026-11-15-cms-sales-final-consolidated-work-order-pm.md §8.1–§8.2). Dùng cho NAVR-01/03 phiên bản mới (cms-nav-repeat.spec).
//
// Vì sao tách: `expect(page).toHaveURL(predicate)` của Playwright = `frame.waitForURL` ⇒ URL đã khớp vẫn chờ sự kiện `load`
// (continuation final 15/11: URL CMS đổi ~+1,9 s nhưng `load` không tới trong 20 s ⇒ báo nhầm "không tới CMS"). Ở đây:
//   · URL / commit: đọc `page.url()` theo chu kỳ (không chờ load) trong budget URL (KPI → CMS 20 s; CMS → KPI NAV_WATCHDOG_MS + 10 s).
//   · nội dung app-ready: hàm `ready` do spec cấp (chữ ký nội dung + bất biến / quyền đã có, budget 30 s của spec) — URL đúng mà nội
//     dung lỗi / chưa có ⇒ đỏ; không thay bằng "chỉ đúng URL".
//   · load: chỉ GHI LẠI (mốc sự kiện `load` của trang sau chạm, hoặc null = chưa load) — không tự coi là lỗi nội dung, không tự coi
//     là đã hoàn tất.
// KPI → CMS (hợp đồng document NAVR-01/02, HARD): đúng MỘT document tới CMS bắt đầu ≤ docStartMax sau chạm, 0 RSC điều hướng tới CMS,
// không document thứ hai tới hết quietUntil (watchdog + 2 s), URL + nội dung đạt.
// CMS → KPI (PM §8.1: nhận rủi ro THỜI GIAN chiều về, không nhận lỗi chức năng): tới đúng KPI + nội dung trong budget; tối đa
// maxFallback (1) tải cứng về KPI và tải cứng đó không sớm hơn mốc watchdog − 200 ms (dự phòng của watchdog, không phải link
// document); 0 document tới CMS. Thời gian chỉ là KẾT QUẢ ĐO: < watchdog và 0 tải cứng ⇒ 'mềm < 6 s'; còn lại ⇒ 'EXCEPTION …'
// (không ném sớm để các vòng sau vẫn được kiểm; không đổi hằng / không gọi là "luôn mềm").
// Hàm không ném — trả problems (rỗng = đạt chức năng) để selftest offline dùng lại đúng hàm.
// ─────────────────────────────────────────────────────────────────────────────

export type NavKind = 'doc' | 'rsc' | 'prefetch'
export type NavTo = 'cms' | 'kpi'
export type NavEv = { t: number; kind: NavKind; to: NavTo }
/** Phần Page oracle dùng (selftest offline cấp trang giả cùng giao diện). */
export type NavPage = Pick<Page, 'on' | 'url'>

export const isCmsUrl = (u: URL) => u.pathname === '/targets' && u.searchParams.get('tab') === 'cms'
export const isKpiUrl = (u: URL) => u.pathname === '/targets' && !u.searchParams.has('tab')
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, Math.max(0, ms)))
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 160)
/** Chỉ pathname + tên tham số tab (không query khác) — dùng trong thông báo lỗi. */
function where(page: NavPage) {
  try { const u = new URL(page.url()); return `${u.pathname}${u.searchParams.has('tab') ? '?tab=' + u.searchParams.get('tab') : ''}` } catch { return '?' }
}

/** Dòng thời gian request /targets (KPI) và /targets?tab=cms (CMS) + sự kiện load, mốc ms từ `mark()` đầu tiên. */
export function navTimeline(page: NavPage) {
  let t0 = 0
  const ev: NavEv[] = []
  const loads: number[] = []
  page.on('request', (r: Request) => {
    if (!t0) return
    let u: URL
    try { u = new URL(r.url()) } catch { return }
    const to: NavTo | null = isCmsUrl(u) ? 'cms' : isKpiUrl(u) ? 'kpi' : null
    if (!to) return
    const h = r.headers()
    const kind: NavKind | null = r.resourceType() === 'document' ? 'doc' : h['rsc'] === '1' ? (h['next-router-prefetch'] === '1' ? 'prefetch' : 'rsc') : null
    if (kind) ev.push({ t: Date.now() - t0, kind, to })
  })
  page.on('load', () => { if (t0) loads.push(Date.now() - t0) })
  return {
    /** Đặt gốc thời gian (lần đầu) và trả mốc hiện tại theo gốc đó. */
    mark: () => { if (!t0) t0 = Date.now(); return Date.now() - t0 },
    between: (kind: NavKind, to: NavTo, from: number, until = Infinity) => ev.filter((e) => e.kind === kind && e.to === to && e.t >= from && e.t < until).map((e) => e.t - from),
    count: (kind: NavKind, to: NavTo) => ev.filter((e) => e.kind === kind && e.to === to).length,
    /** Mốc các sự kiện load SAU `from` (tính từ `from`). */
    loadsAfter: (from: number) => loads.filter((t) => t >= from).map((t) => t - from),
    text: () => [...ev.map((e) => ({ t: e.t, s: `${e.kind}>${e.to}` })), ...loads.map((t) => ({ t, s: 'load' }))].sort((a, b) => a.t - b.t).map((x) => `${x.t}:${x.s}`).join(' '),
  }
}
export type NavTimeline = ReturnType<typeof navTimeline>

/** Chờ URL khung chính thoả `pred` bằng cách đọc `page.url()` theo chu kỳ — KHÔNG chờ load. */
export async function waitUrl(page: NavPage, pred: (u: URL) => boolean, ms: number, stepMs = 50): Promise<boolean> {
  const end = Date.now() + ms
  for (;;) {
    let ok = false
    try { ok = pred(new URL(page.url())) } catch { ok = false }
    if (ok) return true
    if (Date.now() >= end) return false
    await sleep(stepMs)
  }
}

/** Kiểm nội dung: trả danh sách vi phạm (rỗng = app-ready đúng); ném = chưa sẵn sàng trong budget của spec. */
export type ReadyCheck = () => Promise<string[]>

export type KpiToCmsOpts = { urlBudgetMs?: number; docStartMax?: number; quietUntil?: number }
export type KpiToCmsResult = { docStart: number | null; docs: number; url: number; ready: number; load: number | null; problems: string[] }
/** Một lần chạm KPI → CMS theo hợp đồng document (NAVR-01 / 02) + nội dung (NAVR-03). */
export async function kpiToCmsSplit(page: NavPage, log: NavTimeline, click: () => Promise<unknown>, ready: ReadyCheck, o: KpiToCmsOpts = {}): Promise<KpiToCmsResult> {
  const urlBudget = o.urlBudgetMs ?? 20_000
  const docStartMax = o.docStartMax ?? 1_500
  const quietUntil = o.quietUntil ?? NAV_WATCHDOG_MS + 2_000
  const at = log.mark()
  const problems: string[] = []
  try { await click() } catch (e) { problems.push(`chạm link CMS lỗi: ${errMsg(e)}`) }
  const reached = await waitUrl(page, isCmsUrl, urlBudget)
  const url = reached ? log.mark() - at : -1
  if (!reached) problems.push(`không tới URL CMS trong ${urlBudget} ms (đang ở ${where(page)})`)
  let readyAt = -1
  if (reached) {
    try {
      const bad = await ready()
      if (bad.length) problems.push(...bad.map((b) => `nội dung CMS: ${b}`))
      else readyAt = log.mark() - at
    } catch (e) { problems.push(`nội dung CMS chưa sẵn sàng: ${errMsg(e)}`) }
  }
  await sleep(quietUntil - (log.mark() - at))
  const docs = log.between('doc', 'cms', at)
  const rsc = log.between('rsc', 'cms', at)
  if (docs.length === 0) problems.push(`không có request document tới CMS trong ${log.mark() - at} ms`)
  else if (docs[0] > docStartMax) problems.push(`document bắt đầu muộn +${docs[0]} ms (> ${docStartMax})`)
  if (docs.length > 1) problems.push(`document thứ hai tới CMS (${docs.join(', ')} ms)`)
  if (rsc.length) problems.push(`có RSC điều hướng tới CMS (${rsc.join(', ')} ms) — vẫn đi transition mềm`)
  const loads = log.loadsAfter(at)
  return { docStart: docs[0] ?? null, docs: docs.length, url, ready: readyAt, load: loads.length ? loads[0] : null, problems }
}

export type CmsToKpiOpts = { urlBudgetMs?: number; watchdogMs?: number; quietUntil?: number; maxFallback?: number; earlyMarginMs?: number; settleAfterMs?: number }
export type CmsToKpiResult = { url: number; ready: number; load: number | null; fallbacks: number[]; timing: string; problems: string[] }
/** Một lần chạm CMS → KPI: chức năng HARD (đúng KPI + nội dung, ≤ maxFallback tải cứng do watchdog, 0 document CMS); thời gian = số đo. */
export async function cmsToKpiSplit(page: NavPage, log: NavTimeline, click: () => Promise<unknown>, ready: ReadyCheck, o: CmsToKpiOpts = {}): Promise<CmsToKpiResult> {
  const watchdog = o.watchdogMs ?? NAV_WATCHDOG_MS
  const urlBudget = o.urlBudgetMs ?? watchdog + 10_000
  const quietUntil = o.quietUntil ?? watchdog + 2_000
  const maxFallback = o.maxFallback ?? 1
  const early = o.earlyMarginMs ?? 200
  const settleAfter = o.settleAfterMs ?? 2_000
  const at = log.mark()
  const problems: string[] = []
  try { await click() } catch (e) { problems.push(`chạm link KPI lỗi: ${errMsg(e)}`) }
  const reached = await waitUrl(page, isKpiUrl, urlBudget)
  const url = reached ? log.mark() - at : -1
  if (!reached) problems.push(`không tới URL KPI trong ${urlBudget} ms (đang ở ${where(page)})`)
  let readyAt = -1
  if (reached) {
    try {
      const bad = await ready()
      if (bad.length) problems.push(...bad.map((b) => `nội dung KPI: ${b}`))
      else readyAt = log.mark() - at
    } catch (e) { problems.push(`nội dung KPI chưa sẵn sàng: ${errMsg(e)}`) }
  }
  // Quan sát tới hết max(watchdog + 2 s, lúc tới đích + 2 s): tải cứng thứ hai / vòng tải lại hiện ra trong khoảng này.
  await sleep(Math.max(quietUntil, (readyAt >= 0 ? readyAt : url) + settleAfter) - (log.mark() - at))
  const fallbacks = log.between('doc', 'kpi', at)
  if (fallbacks.length > maxFallback) problems.push(`tải cứng về KPI ${fallbacks.length} lần (${fallbacks.join(', ')} ms) > ${maxFallback} — vòng tải lại`)
  const tooEarly = fallbacks.filter((t) => t < watchdog - early)
  if (tooEarly.length) problems.push(`tải cứng về KPI sớm +${tooEarly.join(', ')} ms (trước mốc watchdog ${watchdog} ms) — không phải dự phòng watchdog`)
  const cmsDocs = log.between('doc', 'cms', at)
  if (cmsDocs.length) problems.push(`tải tài liệu CMS khi về KPI (${cmsDocs.join(', ')} ms)`)
  const timing = url < 0 ? 'không đo được (không tới KPI)'
    : url < watchdog && fallbacks.length === 0 ? `mềm < ${watchdog} ms (${url} ms)`
    : `EXCEPTION ${url} ms${fallbacks.length ? ` · ${fallbacks.length} tải cứng dự phòng +${fallbacks.join(', ')} ms` : ' · mềm nhưng ≥ mốc watchdog'}`
  const loads = log.loadsAfter(at)
  return { url, ready: readyAt, load: loads.length ? loads[0] : null, fallbacks, timing, problems }
}
