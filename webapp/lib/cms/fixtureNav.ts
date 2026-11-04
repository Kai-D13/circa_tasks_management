// CMS-UI-1 (PM 04/11 §6.7) — điều hướng riêng của CMS cho fixture. Route thật luôn dùng href thật (mode 'real' — mặc định ở mọi
// component). /ui-catalog/cms-v2 truyền mode 'fixture' (object thuần, truyền được sang client component): mọi link CMS trỏ về
// trang catalog tương ứng và GIỮ kịch bản (p2 / as) — click danh sách → chi tiết → SP / lịch sử → quay lại vẫn ở trong catalog.
// Không suy fixture từ is_test (QA trên prod vẫn dùng route thật). Endpoint tải file (/api/...) KHÔNG đổi ở đây — link tải bọc
// guard useFixtureActionBlocked (0 request trong fixture).

export type CmsNav = { mode: 'real' } | { mode: 'fixture'; keep: Record<string, string> }
export const CMS_NAV_REAL: CmsNav = { mode: 'real' }

/** Tham số kịch bản được giữ khi đi giữa các trang fixture. */
export const CMS_NAV_KEEP_KEYS = ['p2', 'as'] as const

export function cmsFixtureNav(sp: Record<string, string | string[] | undefined>, extra: Record<string, string> = {}): CmsNav {
  const keep: Record<string, string> = {}
  for (const k of CMS_NAV_KEEP_KEYS) { const v = sp[k]; if (typeof v === 'string' && /^[a-z0-9-]{1,20}$/.test(v)) keep[k] = v }
  return { mode: 'fixture', keep: { ...keep, ...extra } }
}

const CAT = '/ui-catalog/cms-v2'
const dec = (v: string) => { try { return decodeURIComponent(v) } catch { return v } }

/** Href thật ⇒ href theo mode. Đường không thuộc CMS (hoặc không có trang catalog) ⇒ giữ nguyên. */
export function cmsNavHref(nav: CmsNav | null | undefined, href: string): string {
  if (!nav || nav.mode === 'real') return href
  const u = new URL(href, 'http://x')
  const q = new URLSearchParams()
  const add = (k: string, v: string | null | undefined) => { if (v) q.set(k, v) }
  const p = u.pathname
  let path: string | null = null
  let m: RegExpExecArray | null
  if (p === '/targets/campaigns/cms') { path = `${CAT}/list`; add('status', u.searchParams.get('status')); add('q', u.searchParams.get('q')) }
  else if (p === '/targets/campaigns/cms/new') { path = `${CAT}/wizard`; add('fx', 'info') }
  else if ((m = /^\/targets\/campaigns\/cms\/([^/]+)\/(edit|import)$/.exec(p))) { path = `${CAT}/wizard`; add('fx', m[2] === 'edit' ? 'edit-active' : 'upload'); add('program', dec(m[1])) }
  else if ((m = /^\/targets\/campaigns\/cms\/([^/]+)$/.exec(p))) { path = `${CAT}/detail`; add('program', dec(m[1])); add('view', u.searchParams.get('view')); add('page', u.searchParams.get('page')) }
  else if (p === '/targets' && u.searchParams.get('tab') === 'cms') { path = `${CAT}/staff`; add('program', u.searchParams.get('program')); add('f', u.searchParams.get('f')) }
  else if ((m = /^\/targets\/cms\/products\/([^/]+)$/.exec(p))) { path = `${CAT}/product`; add('pp', dec(m[1])) }
  else if (p === '/targets/cms/history') { path = `${CAT}/history`; for (const [k, v] of u.searchParams) add(k, v) }
  else if (p === '/targets') return '/ui-catalog/kpi-v2/staff'
  else if (p === '/targets/campaigns') return '/ui-catalog/kpi-v2/campaigns'
  else if (p === '/targets/campaigns/affiliate') return '/ui-catalog/kpi-v2/affiliate'
  if (!path) return href
  for (const [k, v] of Object.entries(nav.keep)) if (!q.has(k)) q.set(k, v)
  const s = q.toString()
  return s ? `${path}?${s}` : path
}
