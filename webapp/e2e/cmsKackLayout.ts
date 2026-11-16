import type { Locator } from '@playwright/test'
import { CMS_FX_K_ACK_LONG_ID, CMS_FX_K_ACK_LONG_SOURCES } from '../lib/cms/fixtures'

// KACK-LAYOUT-01 (PM 16/11 run3 §3) — phép đo hình học DÙNG CHUNG cho spec fixture local (ui-v2-cms-kack.spec.ts) và spec remote sau
// deploy: dòng ĐÃ XÁC NHẬN TAY phải hiện đủ nhãn trạng thái + nguồn trong ô, không bị khung overflow-hidden cắt, không đè ProductID / nguồn.
// Đo hộp nhãn + TỪNG DÒNG CHỮ (Range.getClientRects) — không chỉ toContainText / scrollWidth trang (lỗi cũ: chữ có trong DOM, trang không
// tràn, nhưng nhãn nằm ngoài ô và bị bảng cắt / đè cột nguồn). Chỉ đọc DOM; không click, không ghi.

export type CmsKAckExpect = { pid: string; label: string; source: string }
export type CmsKAckGeo = { pid: string; problems: string[] }

export const CMS_K_ACK_LABEL = {
  NO_EVIDENCE: 'CHƯA CÓ BẰNG CHỨNG · ĐÃ XÁC NHẬN TAY',
  UNAVAILABLE: 'KHÔNG KIỂM ĐƯỢC · ĐÃ XÁC NHẬN TAY',
} as const

/** Kỳ vọng cho fixture result-k-ack-long(-unavailable): 3 dòng 9185xx, nguồn ngắn / dài / chuỗi liền. */
export const cmsKAckLongExpected = (label: string): CmsKAckExpect[] =>
  CMS_FX_K_ACK_LONG_SOURCES.map((source, i) => ({ pid: CMS_FX_K_ACK_LONG_ID(i), label, source }))

/** Hình học từng dòng đã xác nhận tay trong bảng `[data-cms-kcheck-table]`: trả vi phạm theo dòng (rỗng = đạt). */
export async function cmsKAckRowGeometry(table: Locator, expected: CmsKAckExpect[]): Promise<CmsKAckGeo[]> {
  return table.evaluate((tbl, exp) => {
    const T = 1 // dung sai làm tròn subpixel
    type R = { l: number; t: number; r: number; b: number }
    const rect = (e: Element): R => { const x = e.getBoundingClientRect(); return { l: x.left, t: x.top, r: x.right, b: x.bottom } }
    const inside = (a: R, o: R) => a.l >= o.l - T && a.r <= o.r + T && a.t >= o.t - T && a.b <= o.b + T
    const area = (a: R, b: R) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t))
    const fmt = (a: R) => `[${Math.round(a.l)},${Math.round(a.t)} → ${Math.round(a.r)},${Math.round(a.b)}]`
    // Từng dòng chữ thật (mỗi line box của mỗi text node) — bắt chữ tràn / bị cắt mà hộp phần tử vẫn "đúng".
    const lines = (e: Element): R[] => {
      const out: R[] = []
      const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!(n.textContent ?? '').trim()) continue
        const rg = document.createRange()
        rg.selectNodeContents(n)
        for (const x of rg.getClientRects()) if (x.width > 0 && x.height > 0) out.push({ l: x.left, t: x.top, r: x.right, b: x.bottom })
      }
      return out
    }
    // Mọi tổ tiên cắt nội dung (overflow ≠ visible) từ phần tử tới hết bảng.
    const clippers = (e: Element): Element[] => {
      const out: Element[] = []
      for (let p = e.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p)
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') out.push(p)
        if (p === tbl) break
      }
      return out
    }
    const vis = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
    return exp.map(({ pid, label, source }) => {
      const problems: string[] = []
      const row = tbl.querySelector(`[data-cms-k-row="${pid}"]`)
      if (!row) return { pid, problems: ['không thấy dòng'] }
      if (row.getAttribute('data-cms-k-ack') !== 'yes') problems.push('dòng không mang data-cms-k-ack=yes')
      const wraps = [...row.querySelectorAll('[data-cms-k-badge]')].filter(vis)
      if (wraps.length !== 1) return { pid, problems: [...problems, `số nhãn trạng thái đang hiện = ${wraps.length} (phải 1)`] }
      const badge = wraps[0].firstElementChild!
      const cell = badge.closest('[role="cell"]')!
      const pidEl = row.querySelector('[data-cms-k-pid]')!
      const info = row.querySelector('[data-cms-k-ack-info]')
      if (!info || !vis(info)) return { pid, problems: [...problems, 'không thấy dòng nguồn xác nhận'] }
      // 1. Nội dung đủ, giữ "ĐÃ XÁC NHẬN TAY", không biến thành KHỚP; nhãn không tự cắt chữ.
      if (norm(badge.textContent ?? '') !== label) problems.push(`nhãn "${norm(badge.textContent ?? '')}" ≠ "${label}"`)
      if (!norm(info.textContent ?? '').startsWith(`Nguồn: ${source} · `)) problems.push('dòng nguồn không đủ chữ')
      const st = getComputedStyle(badge)
      if (st.textOverflow === 'ellipsis' || st.overflowX === 'hidden' || st.overflowX === 'clip') problems.push(`nhãn tự cắt chữ (overflow ${st.overflowX}, text-overflow ${st.textOverflow})`)
      // 2. Nhãn + từng dòng chữ (nhãn / nguồn / ProductID) nằm trong ô của nó, trong dòng, trong mọi khung cắt tới hết bảng.
      const bR = rect(badge), cR = rect(cell), rowR = rect(row)
      if (!inside(bR, cR)) problems.push(`nhãn ${fmt(bR)} ra ngoài ô ${fmt(cR)}`)
      if (!inside(bR, rowR)) problems.push(`nhãn ${fmt(bR)} ra ngoài dòng ${fmt(rowR)}`)
      const bL = lines(badge), iL = lines(info), pL = lines(pidEl)
      if (bL.length === 0) problems.push('nhãn không có dòng chữ hiển thị')
      for (const l of bL) if (!inside(l, bR)) problems.push(`chữ nhãn ${fmt(l)} tràn khỏi nhãn ${fmt(bR)}`)
      for (const [name, el, ls] of [['nhãn', badge, bL], ['nguồn', info, iL], ['ProductID', pidEl, pL]] as const) {
        const own = rect(el.closest('[role="cell"]')!)
        for (const l of ls) if (!inside(l, own)) problems.push(`chữ ${name} ${fmt(l)} ra ngoài ô ${fmt(own)}`)
        for (const c of clippers(el)) {
          const k = rect(c)
          for (const l of ls) if (!inside(l, k)) problems.push(`chữ ${name} ${fmt(l)} bị khung ${c.hasAttribute('data-cms-kcheck-table') ? 'bảng' : c.tagName.toLowerCase()} cắt ${fmt(k)}`)
        }
      }
      // 3. Không chồng: nhãn ↔ nguồn ↔ ProductID (hộp nhãn với từng dòng chữ; ProductID với nguồn).
      for (const l of [...iL, ...pL]) if (area(bR, l) > T) problems.push(`nhãn ${fmt(bR)} đè chữ ${fmt(l)}`)
      for (const a of pL) for (const b of iL) if (area(a, b) > T) problems.push(`ProductID ${fmt(a)} đè nguồn ${fmt(b)}`)
      // 4. Các ô đang hiện của dòng nằm trong dòng và không giao nhau (bắt ô tràn sang cột bên cạnh dù chữ vẫn "trong ô" của nó).
      const cells = [...row.querySelectorAll(':scope > [role="cell"]')].filter(vis).map((c, i) => ({ i, r: rect(c) }))
      for (const c of cells) if (!inside(c.r, rowR)) problems.push(`ô #${c.i + 1} ${fmt(c.r)} ra ngoài dòng ${fmt(rowR)}`)
      for (let x = 0; x < cells.length; x++) for (let y = x + 1; y < cells.length; y++) {
        if (area(cells[x].r, cells[y].r) > T) problems.push(`ô #${cells[x].i + 1} ${fmt(cells[x].r)} giao ô #${cells[y].i + 1} ${fmt(cells[y].r)}`)
      }
      return { pid, problems: [...new Set(problems)].slice(0, 8) }
    })
  }, expected)
}
