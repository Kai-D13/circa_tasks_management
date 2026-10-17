import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'

// PM 17/10 (P1 — catalog KPI bất khả ghi). Dùng chung cho spec fixture K-1..K-4.
//
// trapWrites: đăng ký TRƯỚC khi mở trang. Mọi request không phải GET/HEAD/OPTIONS (server action = POST + header
// next-action; ghi REST = POST/PATCH/DELETE) và mọi GET /api/export bị GHI NHẬN rồi ABORT ngay trong trình duyệt ⇒ guard
// có hỏng thì test đỏ nhưng không request nào tới máy chủ (không ghi DB prod khi thử). Ngoại lệ duy nhất: làm mới phiên
// Supabase Auth (/auth/v1/token) — không phải dữ liệu app, chặn sẽ làm rơi phiên giữa test.
export type TrappedRequest = { method: string; path: string; action: boolean }

export async function trapWrites(page: Page): Promise<TrappedRequest[]> {
  const seen: TrappedRequest[] = []
  await page.context().route('**/*', async (route) => {
    const req = route.request()
    const m = req.method()
    const u = new URL(req.url())
    const read = m === 'GET' || m === 'HEAD' || m === 'OPTIONS'
    if ((read && !u.pathname.startsWith('/api/export')) || u.pathname.startsWith('/auth/v1/token')) return route.continue()
    seen.push({ method: m, path: u.pathname, action: Boolean(req.headers()['next-action']) })
    await route.abort('blockedbyclient')
  })
  return seen
}

// Bộ đếm lần chặn của KpiFixtureBoundary (thẻ ẩn). Không có boundary ⇒ thẻ không tồn tại.
export const blockedCounter = (page: Page) => page.locator('main [data-kpi-fixture-blocked]')

export async function expectBlocked(page: Page, n: number, what: string) {
  await expect(blockedCounter(page), `${what}: guard fixture không chặn`).toHaveAttribute('data-kpi-fixture-blocked', String(n), { timeout: 5_000 })
}

// Chữ toast lấy từ CHÍNH nguồn boundary (không chép tay).
export function fixtureBlockedToast(): string {
  const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'kpi', 'KpiFixtureBoundary.tsx'), 'utf8')
  const m = src.match(/export const KPI_FIXTURE_BLOCKED_TOAST = '([^']+)'/)
  if (!m) throw new Error('KPI_FIXTURE_BLOCKED_TOAST không có trong KpiFixtureBoundary.tsx')
  return m[1]
}

// Nguồn: trong `file`, MỌI lời gọi `<action>(` / `fetch(` của danh sách `calls` (có hay không `await`, trừ dòng import)
// phải có `if (fixtureBlocked()) … return` đứng TRƯỚC trong cùng hàm (dò ngược tới dòng mở `function`), và file gọi
// useFixtureActionBlocked() đúng 1 lần. Trả số chỗ gọi (caller khoá con số ⇒ regex lệch là đỏ). Heuristic theo dòng —
// bằng chứng chính vẫn là các ca hành vi (bộ đếm + 0 request).
export function expectGuardedCalls(file: string, calls: string[]): number {
  const rel = path.join(__dirname, '..', file)
  const lines = fs.readFileSync(rel, 'utf8').replace(/\r\n/g, '\n').split('\n')
  expect(lines.filter((l) => l.includes('useFixtureActionBlocked()')).length, `${file}: phải gọi useFixtureActionBlocked() đúng 1 lần`).toBe(1)
  const callRx = calls.map((c) => new RegExp(`\\b${c}\\(`))
  const guardRx = /if \(fixtureBlocked\(\)\)\s*(\{[^}]*)?return\b/
  let sites = 0
  lines.forEach((l, i) => {
    if (/^\s*import\s/.test(l) || !callRx.some((r) => r.test(l))) return
    sites++
    let ok = false
    for (let j = i; j >= 0; j--) {
      if (guardRx.test(lines[j])) { ok = true; break }
      if (/^\s*(async\s+)?function\s/.test(lines[j]) && j !== i) break
    }
    expect(ok, `${file}:${i + 1} gọi action/export mà không qua fixtureBlocked(): ${l.trim()}`).toBe(true)
  })
  return sites
}

// Nguồn: route thật KHÔNG bọc boundary (chỉ trang /ui-catalog được import KpiFixtureBoundary).
export function expectBoundaryOnlyInCatalog(pages: string[]) {
  for (const p of pages) {
    const src = fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
    expect(src.includes('KpiFixtureBoundary'), `${p}: route thật không được bọc KpiFixtureBoundary`).toBe(false)
  }
}

export function expectCatalogWrapped(page: string) {
  const src = fs.readFileSync(path.join(__dirname, '..', page), 'utf8')
  expect(src, `${page}: thiếu import KpiFixtureBoundary`).toContain(`import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'`)
  const opens = src.split('<KpiFixtureBoundary>').length - 1
  expect(opens, `${page}: phải bọc <KpiFixtureBoundary> quanh return chính`).toBeGreaterThanOrEqual(1)
  expect(src.split('</KpiFixtureBoundary>').length - 1, `${page}: thẻ boundary không đóng đủ`).toBe(opens)
}
