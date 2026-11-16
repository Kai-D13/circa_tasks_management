import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  cmsCommitGate, cmsImportPlan, cmsKAckKey, cmsKAckPayload, cmsKBulkApplyAllowed, cmsKBulkApplySource, cmsKBulkCheck, cmsKBulkConfirmSync,
  cmsKBulkFingerprint, cmsKCanRecheck, cmsKDirty, cmsKExcluded, cmsKNormSource, cmsKNotApplied, cmsKPending, cmsKSelected, cmsKSourceOk,
  type CmsKAckDraft,
} from '../lib/cms/kAckPlan'
import { cmsKAckable, type CmsPreviewKResult } from '../lib/cms/importView'
import { cmsBindKAcks, cmsParseKAckInput, type CmsKResult } from '../lib/cms/import/kCheck'
import { CMS_FX_K83_ID, CMS_FX_PREVIEW_K83, CMS_FX_PREVIEW_K83_ACKED, CMS_FX_PREVIEW_SIMPLE } from '../lib/cms/fixtures'

// UX-KACK-1 (PM 15/11 §4) — logic thuần phía client của bước xác nhận K: khoá ghi khi còn ý định chưa gửi (AC1), tóm tắt N / M / U
// (AC2 / AC3), chọn nhiều + nguồn chung chỉ trên dòng cmsKAckable (AC5), mỗi SP một k_ack đúng nguồn và khoá theo SP / đơn vị / K
// (AC6). Đối chiếu payload với parser + binder THẬT của server (cmsParseKAckInput / cmsBindKAcks) — không nới luật (AC7).

const row = (o: Partial<CmsPreviewKResult> & { productId: string; status: CmsPreviewKResult['status'] }): CmsPreviewKResult => ({
  unit: 'hộp', k: '10', proposedK: null, seen: [], note: '', ack: null, ok: o.status === 'MATCH', ...o,
})
const NE = row({ productId: '900001', status: 'NO_EVIDENCE' })
const UN = row({ productId: '900002', status: 'UNAVAILABLE' })
const MM = row({ productId: '900003', status: 'MISMATCH', k: '12' })
const SE = row({ productId: '900004', status: 'SOURCE_ERROR' })
const SC = row({ productId: '900005', status: 'SOURCE_CONFLICT' })
const PR = row({ productId: '900006', status: 'PROPOSED', k: null, proposedK: '10' })
const NK = row({ productId: '900007', status: 'NO_EVIDENCE', k: null })
const AK = row({ productId: '900008', status: 'NO_EVIDENCE', ack: { source: 'Quy cách NCC cũ', at: '2026-11-16T00:00:00.000Z' }, ok: true })
const MA = row({ productId: '900009', status: 'MATCH' })
const ROWS = [NE, UN, MM, SE, SC, PR, NK, AK, MA]
const d = (entries: [CmsPreviewKResult, boolean, string][]): CmsKAckDraft => Object.fromEntries(entries.map(([x, checked, source]) => [cmsKAckKey(x), { checked, source }]))
/** Kết quả server "trước xác nhận" từ dòng preview (cùng hình dạng phần cmsBindKAcks đọc). */
const before = (rows: readonly CmsPreviewKResult[]): CmsKResult[] => rows.map((x) => ({ ...x, ack: null, ok: x.status === 'MATCH' }) as unknown as CmsKResult)

test.describe('UX-KACK-1 · nháp ý định + khoá ghi @desktop', () => {
  test('khoá nháp = ProductID + đơn vị + K (bộ dữ liệu khác ⇒ khoá khác, không tái dùng — AC6)', () => {
    expect(cmsKAckKey(NE)).not.toBe(cmsKAckKey({ ...NE, unit: 'vỉ' }))
    expect(cmsKAckKey(NE)).not.toBe(cmsKAckKey({ ...NE, k: '20' }))
    expect(cmsKAckKey(NE)).not.toBe(cmsKAckKey({ ...NE, productId: '900099' }))
    // Nháp của K cũ không thành ý định cho dòng cùng SP nhưng K mới
    const old = d([[NE, true, 'Quy cách NCC']])
    const fresh = { ...NE, k: '20' }
    expect(cmsKPending([fresh], old)).toEqual({ ready: [], incomplete: [] })
    expect(cmsKAckPayload([fresh], old)).toEqual([])
  })

  test('nguồn: chuẩn hoá giống server; < 3 ký tự / chỉ khoảng trắng / ký tự điều khiển ⇒ chưa đủ', () => {
    expect(cmsKNormSource('  Quy\tcách\n\nNCC  ')).toBe('Quy cách NCC')
    expect(cmsKSourceOk('ab')).toBe(false)
    expect(cmsKSourceOk('   \t  ')).toBe(false)
    expect(cmsKSourceOk('\u0001\u0002\u0003')).toBe(false)
    expect(cmsKSourceOk('abc')).toBe(true)
    expect(cmsKSourceOk('x'.repeat(201))).toBe(false)
    // Client nhận ⇔ parser server nhận (cùng trần / chuẩn hoá)
    for (const s of ['ab', 'abc', '  a b  ', 'Quy\u0007cách', 'x'.repeat(200), 'x'.repeat(201)]) {
      const server = cmsParseKAckInput(JSON.stringify([{ product_id: '900001', unit: 'hộp', k: '10', source: s }]))
      expect(cmsKSourceOk(s), `nguồn ${JSON.stringify(s.slice(0, 12))}`).toBe(server !== null)
    }
  })

  test('AC1: tick ⇒ còn ý định (khoá ghi); bỏ tick ⇒ hết; tick dòng không xác nhận được (nháp giả) không tính', () => {
    expect(cmsKDirty(ROWS, {})).toBe(false)
    expect(cmsKDirty(ROWS, d([[NE, true, '']]))).toBe(true)
    expect(cmsKDirty(ROWS, d([[NE, true, 'Quy cách NCC']]))).toBe(true)
    expect(cmsKDirty(ROWS, d([[NE, false, 'Quy cách NCC']]))).toBe(false)
    // Nháp ép cho LỆCH / NGUỒN LỖI / ĐỀ XUẤT / thiếu K / đã xác nhận — không phải ý định hợp lệ
    expect(cmsKDirty(ROWS, d([[MM, true, 'abc'], [SE, true, 'abc'], [SC, true, 'abc'], [PR, true, 'abc'], [NK, true, 'abc'], [AK, true, 'abc'], [MA, true, 'abc']]))).toBe(false)
    const p = cmsKPending(ROWS, d([[NE, true, 'Quy cách NCC'], [UN, true, 'ab']]))
    expect(p.ready.map((x) => x.productId)).toEqual(['900001'])
    expect(p.incomplete.map((x) => x.productId)).toEqual(['900002'])
  })

  test('kiểm tra lại: ý định thiếu nguồn CHẶN gửi (không gửi im lặng một phần); nguồn bán không đọc được ⇒ được thử lại khi 0 ý định', () => {
    expect(cmsKCanRecheck(ROWS, {}, true)).toBe(false)
    expect(cmsKCanRecheck(ROWS, d([[NE, true, 'Quy cách NCC']]), true)).toBe(true)
    expect(cmsKCanRecheck(ROWS, d([[NE, true, 'Quy cách NCC'], [UN, true, '']]), true)).toBe(false)
    expect(cmsKCanRecheck(ROWS, {}, false)).toBe(true)
    expect(cmsKCanRecheck(ROWS, d([[UN, true, 'x']]), false)).toBe(false)
  })

  test('cổng nút ghi: 0 ghi ⇒ ẩn; bận / còn ý định ⇒ khoá; ghi một phần ⇒ phải xác nhận số SP bị bỏ; đủ ⇒ mở', () => {
    const g = (o: Partial<Parameters<typeof cmsCommitGate>[0]>) => cmsCommitGate({ write: 5, skip: 0, dirty: false, busy: false, partialConfirmed: false, ...o })
    expect(g({ write: 0 })).toBe('NOTHING')
    expect(g({ busy: true })).toBe('BUSY')
    expect(g({ dirty: true })).toBe('DIRTY')
    expect(g({ dirty: true, skip: 3, partialConfirmed: true })).toBe('DIRTY')
    expect(g({ skip: 3 })).toBe('PARTIAL_UNCONFIRMED')
    expect(g({ skip: 3, partialConfirmed: true })).toBe('NONE')
    expect(g({})).toBe('NONE')
  })
})

test.describe('UX-KACK-1 · payload k_acks đối chiếu parser / binder server @desktop', () => {
  test('mỗi SP một k_ack (giữ xác nhận đã gắn + ý định đủ nguồn), nguồn đã chuẩn hoá; server parse + bind đúng tập, không hơn', () => {
    const drafts = d([[NE, true, '  Quy cách   NCC 05/11 '], [UN, true, 'Tab Đơn vị POS'], [MM, true, 'ép'], [NK, true, 'thiếu K'], [MA, true, 'khớp']])
    const payload = cmsKAckPayload(ROWS, drafts)
    expect(payload).toEqual([
      { product_id: '900008', unit: 'hộp', k: '10', source: 'Quy cách NCC cũ' },
      { product_id: '900001', unit: 'hộp', k: '10', source: 'Quy cách NCC 05/11' },
      { product_id: '900002', unit: 'hộp', k: '10', source: 'Tab Đơn vị POS' },
    ])
    const parsed = cmsParseKAckInput(JSON.stringify(payload))
    expect(parsed).not.toBeNull()
    const bound = cmsBindKAcks(parsed!, before(ROWS), 'actor-x', '2026-11-16T03:00:00.000Z')
    expect(bound.map((a) => a.productId).sort()).toEqual(['900001', '900002', '900008'])
    expect(bound.every((a) => a.actor === 'actor-x' && a.at === '2026-11-16T03:00:00.000Z')).toBe(true)
    // Server vẫn tự chặn: payload ép LỆCH / thiếu K không được gắn (luật server giữ nguyên)
    const forced = cmsParseKAckInput(JSON.stringify([...payload, { product_id: '900003', unit: 'hộp', k: '12', source: 'ép xác nhận' }]))!
    expect(cmsBindKAcks(forced, before(ROWS), 'a', 't').map((a) => a.productId)).not.toContain('900003')
  })
})

test.describe('UX-KACK-1 · chọn nhiều dòng + nguồn chung (AC5) @desktop', () => {
  test('chọn tất cả: chỉ dòng ĐANG HIỂN THỊ và thoả cmsKAckable; không tự điền nguồn; bỏ chọn giữ nguồn', () => {
    const visible = [NE, MM, SE, PR, NK, AK, MA] // UN không hiển thị
    const sel = cmsKBulkCheck(visible, {}, true)
    expect(Object.keys(sel)).toEqual([cmsKAckKey(NE)])
    expect(sel[cmsKAckKey(NE)]).toEqual({ checked: true, source: '' })
    expect(cmsKSelected(ROWS, sel).map((x) => x.productId)).toEqual(['900001'])
    const typed = { ...sel, [cmsKAckKey(NE)]: { checked: true, source: 'Quy cách NCC' } }
    const none = cmsKBulkCheck(visible, typed, false)
    expect(none[cmsKAckKey(NE)]).toEqual({ checked: false, source: 'Quy cách NCC' })
  })

  test('áp nguồn chung: chỉ dòng đã chọn + cmsKAckable trong tập hiển thị; nguồn không hợp lệ ⇒ không áp; ghi đè nguồn dòng đó', () => {
    const drafts = d([[NE, true, 'riêng'], [UN, false, ''], [MM, true, 'ép']])
    expect(cmsKBulkApplySource(ROWS, drafts, 'ab')).toBe(drafts)
    const out = cmsKBulkApplySource(ROWS, drafts, '  Quy cách   NCC chung ')
    expect(out[cmsKAckKey(NE)]).toEqual({ checked: true, source: 'Quy cách NCC chung' })
    expect(out[cmsKAckKey(UN)]).toEqual({ checked: false, source: '' })
    expect(out[cmsKAckKey(MM)]).toEqual({ checked: true, source: 'ép' })
    // Dòng đã chọn nhưng KHÔNG hiển thị ⇒ không bị áp
    const hidden = cmsKBulkApplySource([UN], drafts, 'Quy cách NCC chung')
    expect(hidden[cmsKAckKey(NE)]).toEqual({ checked: true, source: 'riêng' })
  })

  test('dòng không chọn được nêu theo lý do', () => {
    const ex = Object.fromEntries(cmsKExcluded(ROWS).map((e) => [e.status, e.n]))
    expect(ex).toEqual({ MISMATCH: 1, SOURCE_ERROR: 1, SOURCE_CONFLICT: 1, PROPOSED: 1, NO_K: 1, ACKED: 1, MATCH: 1 })
  })

  test('83 SP: chọn tất cả 20 dòng xác nhận được ⇒ áp nguồn chung ⇒ 2 giữ + 20 mới, 22 ProductID khác nhau; server gắn đủ 22, không gắn dòng nào khác', () => {
    const rows = CMS_FX_PREVIEW_K83.kCheck!.products
    expect(rows).toHaveLength(83)
    expect(rows.filter(cmsKAckable)).toHaveLength(20) // 18 chỉ lỗi K + 2 kèm lỗi tư vấn
    const all = cmsKBulkCheck(rows, {}, true)
    expect(cmsKSelected(rows, all)).toHaveLength(20)
    expect(cmsKDirty(rows, all)).toBe(true)
    expect(cmsKCanRecheck(rows, all, true)).toBe(false) // chưa có nguồn ⇒ chặn gửi
    const applied = cmsKBulkApplySource(rows, all, 'Quy cách NCC (nguồn chung)')
    expect(cmsKCanRecheck(rows, applied, true)).toBe(true)
    const payload = cmsKAckPayload(rows, applied)
    expect(payload).toHaveLength(22)
    expect(new Set(payload.map((p) => p.product_id)).size).toBe(22)
    const parsed = cmsParseKAckInput(JSON.stringify(payload))!
    const bound = cmsBindKAcks(parsed, before(rows), 'a', 't')
    expect(bound).toHaveLength(22)
    const allowed = new Set(rows.filter((x) => x.status === 'NO_EVIDENCE' || x.status === 'UNAVAILABLE').map((x) => x.productId))
    expect(bound.every((b) => allowed.has(b.productId))).toBe(true)
  })
})

// KACK-BULK-01 (PM 16/11 §4, P1): xác nhận nguồn chung gắn với TẬP ProductID / đơn vị / K đã chọn + nguồn chuẩn hoá, không với số lượng.
// `panel` mô phỏng đúng vòng render của CmsKCheckPanel: mỗi lần nháp / nguồn đổi ⇒ render ⇒ cmsKBulkConfirmSync (huỷ hẳn khi khác);
// tick ⇒ lưu dấu vân tay hiện tại; nút / handler "Áp nguồn" = cmsKBulkApplyAllowed (cùng hàm component dùng — kiểm tĩnh ở cuối file).
function panel(rows: readonly CmsPreviewKResult[]) {
  let drafts: CmsKAckDraft = {}, source = '', confirmedFp: string | null = null
  const render = () => {
    const selected = cmsKSelected(rows, drafts)
    const fp = cmsKBulkFingerprint(selected, source)
    confirmedFp = cmsKBulkConfirmSync(confirmedFp, fp)
    return { selected, fp, confirmed: confirmedFp !== null, allowed: cmsKBulkApplyAllowed({ selected, source, confirmedFp, busy: false }) }
  }
  const pick = (x: CmsPreviewKResult, checked: boolean) => { drafts = { ...drafts, [cmsKAckKey(x)]: { ...(drafts[cmsKAckKey(x)] ?? { source: '' }), checked } }; return render() }
  return {
    render,
    pick,
    source: (s: string) => { source = s; confirmedFp = null; return render() }, // onChange ô nguồn chung cũng huỷ ngay
    tick: () => { confirmedFp = render().fp; return render() },
    all: (checked: boolean) => { drafts = cmsKBulkCheck(rows, drafts, checked); return render() },
    apply: () => { const r = render(); if (!r.allowed) return false; drafts = cmsKBulkApplySource(rows, drafts, source); confirmedFp = null; return true },
    drafts: () => drafts,
  }
}
const A1 = row({ productId: '900101', status: 'NO_EVIDENCE' })
const A2 = row({ productId: '900102', status: 'NO_EVIDENCE' })
const B1 = row({ productId: '900103', status: 'UNAVAILABLE' })
const BULK_ROWS = [A1, A2, B1, MM, SE]

test.describe('KACK-BULK-01 · xác nhận nguồn chung gắn với tập + nguồn @desktop', () => {
  test('thêm SP sau khi xác nhận ⇒ mất xác nhận, Áp khoá; tick lại ⇒ Áp mở cho đúng tập mới', () => {
    const p = panel(BULK_ROWS)
    p.source('Quy cách NCC nhóm A')
    p.pick(A1, true)
    expect(p.tick().allowed).toBe(true)
    const r = p.pick(A2, true)
    expect(r.confirmed).toBe(false)
    expect(r.allowed).toBe(false)
    expect(p.apply()).toBe(false)
    expect(p.drafts()[cmsKAckKey(A1)].source).toBe('')
    expect(p.tick().allowed).toBe(true)
    expect(p.apply()).toBe(true)
    expect([A1, A2].map((x) => p.drafts()[cmsKAckKey(x)].source)).toEqual(['Quy cách NCC nhóm A', 'Quy cách NCC nhóm A'])
    expect(p.render().confirmed).toBe(false) // áp xong ⇒ xác nhận dùng một lần
  })

  test('đổi sang SP khác, GIỮ NGUYÊN số lượng ⇒ mất xác nhận (so danh tính, không so count)', () => {
    const p = panel(BULK_ROWS)
    p.source('Quy cách NCC nhóm A')
    p.pick(A1, true); p.pick(A2, true)
    expect(p.tick().allowed).toBe(true)
    p.pick(A1, false)
    const r = p.pick(B1, true)
    expect(r.selected.map((x) => x.productId)).toEqual(['900102', '900103'])
    expect(r.confirmed).toBe(false)
    expect(r.allowed).toBe(false)
    expect(p.apply()).toBe(false)
    // Tầng phòng thủ thứ hai: hàm cấp quyền tự so lại dấu vân tay, không tin xác nhận được trao vào (nút + handler cùng gọi hàm này
    // trong cùng một lần render — không phải cơ chế bắt state cũ thật; cơ chế chính là cmsKBulkConfirmSync mỗi render)
    const fpA = cmsKBulkFingerprint([A1, A2], 'Quy cách NCC nhóm A')
    expect(cmsKBulkApplyAllowed({ selected: [A2, B1], source: 'Quy cách NCC nhóm A', confirmedFp: fpA, busy: false })).toBe(false)
    expect(cmsKBulkApplyAllowed({ selected: [A2, A1], source: 'Quy cách NCC nhóm A', confirmedFp: fpA, busy: false })).toBe(true) // thứ tự không quan trọng
    expect(cmsKBulkApplyAllowed({ selected: [A1, A2], source: 'Quy cách NCC nhóm A', confirmedFp: fpA, busy: true })).toBe(false)
  })

  test('bỏ hết rồi chọn lại ĐÚNG tập cũ / về lại nguồn cũ ⇒ KHÔNG phục hồi xác nhận ngầm', () => {
    const p = panel(BULK_ROWS)
    p.source('Quy cách NCC nhóm A')
    p.pick(A1, true); p.pick(A2, true)
    expect(p.tick().allowed).toBe(true)
    expect(p.all(false).confirmed).toBe(false)
    const back = p.all(true)
    expect(back.selected.map((x) => x.productId)).toEqual(['900101', '900102', '900103'])
    p.pick(B1, false)
    const same = p.render()
    expect(same.fp).toBe(cmsKBulkFingerprint([A1, A2], 'Quy cách NCC nhóm A'))
    expect(same.confirmed).toBe(false)
    expect(same.allowed).toBe(false)
    // Đổi nguồn rồi gõ lại đúng nguồn cũ ⇒ vẫn phải tick lại
    expect(p.tick().allowed).toBe(true)
    p.source('Quy cách NCC nhóm B')
    expect(p.source('Quy cách NCC nhóm A').allowed).toBe(false)
    // Sync thuần: đã huỷ (null) thì gặp lại dấu vân tay cũ vẫn null
    const fp = cmsKBulkFingerprint([A1], 'abc')
    expect(cmsKBulkConfirmSync(fp, cmsKBulkFingerprint([], 'abc'))).toBeNull()
    expect(cmsKBulkConfirmSync(null, fp)).toBeNull()
    expect(cmsKBulkConfirmSync(fp, fp)).toBe(fp)
  })

  test('đổi K / đơn vị của cùng ProductID hoặc đổi nguồn (sau chuẩn hoá) ⇒ dấu vân tay khác', () => {
    const base = cmsKBulkFingerprint([A1], 'Quy cách NCC')
    expect(cmsKBulkFingerprint([{ ...A1, k: '12' }], 'Quy cách NCC')).not.toBe(base)
    expect(cmsKBulkFingerprint([{ ...A1, unit: 'vỉ' }], 'Quy cách NCC')).not.toBe(base)
    expect(cmsKBulkFingerprint([A1], 'Quy cách NCC khác')).not.toBe(base)
    expect(cmsKBulkFingerprint([A1, A2], 'Quy cách NCC')).not.toBe(base)
    expect(cmsKBulkFingerprint([], 'Quy cách NCC')).not.toBe(base)
    // Chỉ khác khoảng trắng / ký tự điều khiển ⇒ cùng nguồn đã chuẩn hoá (server lưu đúng chuỗi chuẩn hoá); ô nguồn vẫn huỷ khi gõ
    expect(cmsKBulkFingerprint([A1], '  Quy   cách\tNCC ')).toBe(base)
    expect(cmsKBulkApplyAllowed({ selected: [{ ...A1, k: '12' }], source: 'Quy cách NCC', confirmedFp: base, busy: false })).toBe(false)
    expect(cmsKBulkApplyAllowed({ selected: [A1], source: 'ab', confirmedFp: cmsKBulkFingerprint([A1], 'ab'), busy: false })).toBe(false) // nguồn < 3
    expect(cmsKBulkApplyAllowed({ selected: [], source: 'Quy cách NCC', confirmedFp: cmsKBulkFingerprint([], 'Quy cách NCC'), busy: false })).toBe(false)
    expect(cmsKBulkApplyAllowed({ selected: [A1], source: 'Quy cách NCC', confirmedFp: null, busy: false })).toBe(false)
  })

  test('chọn tất cả vẫn lọc LỆCH / NGUỒN LỖI: dấu vân tay chỉ gồm dòng xác nhận được; áp không đụng LỆCH / NGUỒN LỖI', () => {
    const p = panel(BULK_ROWS)
    p.source('Quy cách NCC nhóm A')
    const r = p.all(true)
    expect(r.selected.map((x) => x.productId)).toEqual(['900101', '900102', '900103'])
    expect(r.fp).toBe(cmsKBulkFingerprint([A1, A2, B1], 'Quy cách NCC nhóm A'))
    expect(p.tick().allowed).toBe(true)
    expect(p.apply()).toBe(true)
    expect(p.drafts()[cmsKAckKey(MM)]).toBeUndefined()
    expect(p.drafts()[cmsKAckKey(SE)]).toBeUndefined()
  })
})

test.describe('UX-KACK-1 · tóm tắt trước khi ghi (AC2 / AC3) @desktop', () => {
  test('83 SP: N = 83 · M = 50 · U = 33 (18 chỉ thiếu bằng chứng K · 10 K lệch / nguồn lỗi · 5 lỗi file); 2 SP xác nhận được nhưng còn lỗi khác', () => {
    const p = cmsImportPlan(CMS_FX_PREVIEW_K83)
    expect({ total: p.total, write: p.write, skip: p.skip, kAck: p.skipKAck, kBlocked: p.skipKBlocked, file: p.skipFile })
      .toEqual({ total: 83, write: 50, skip: 33, kAck: 18, kBlocked: 10, file: 5 })
    expect([...p.ackableWithOtherErrors].sort()).toEqual([CMS_FX_K83_ID(81), CMS_FX_K83_ID(82)])
  })

  test('sau kiểm tra lại (mô phỏng): 17 / 18 gắn được ⇒ M = 67; SP đổi sang LỆCH báo "không áp"; SP có xác nhận nhưng còn lỗi tư vấn vẫn bị loại', () => {
    const rows = CMS_FX_PREVIEW_K83.kCheck!.products
    const sent = cmsKAckPayload(rows, cmsKBulkApplySource(rows, cmsKBulkCheck(rows, {}, true), 'Quy cách NCC (nguồn chung)'))
    const p = cmsImportPlan(CMS_FX_PREVIEW_K83_ACKED)
    expect({ write: p.write, skip: p.skip, kAck: p.skipKAck, kBlocked: p.skipKBlocked, file: p.skipFile }).toEqual({ write: 67, skip: 16, kAck: 0, kBlocked: 11, file: 5 })
    expect(cmsKNotApplied(sent, CMS_FX_PREVIEW_K83_ACKED)).toEqual([CMS_FX_K83_ID(67)])
    const acked = CMS_FX_PREVIEW_K83_ACKED.kCheck!.products.filter((x) => x.ack)
    expect(acked).toHaveLength(21) // 2 cũ + 17 + 2 còn lỗi tư vấn
    expect(CMS_FX_PREVIEW_K83_ACKED.groupsOk.map((g) => g.productId)).not.toContain(CMS_FX_K83_ID(81))
  })

  test('một ProductID có nhiều dòng K (một đơn vị LỆCH, một CHƯA CÓ BẰNG CHỨNG) ⇒ không tính "chỉ thiếu bằng chứng K"', () => {
    const ne = row({ productId: '900100', status: 'NO_EVIDENCE', unit: 'hộp' })
    const mm = row({ productId: '900100', status: 'MISMATCH', unit: 'vỉ', k: '12' })
    const g = { key: '900100', excelRows: [2], errors: [{ excelRow: 2, column: 'base_quantity_CMS', code: 'K_NO_EVIDENCE', message: 'x', fix: 'y' }] }
    for (const products of [[mm, ne], [ne, mm]]) {
      const p = cmsImportPlan({ groupsOk: [], groupsRejected: [g], kCheck: { asOf: null, available: true, reason: null, products } })
      expect({ kAck: p.skipKAck, kBlocked: p.skipKBlocked }).toEqual({ kAck: 0, kBlocked: 1 })
    }
    const only = cmsImportPlan({ groupsOk: [], groupsRejected: [g], kCheck: { asOf: null, available: true, reason: null, products: [ne] } })
    expect(only.skipKAck).toBe(1)
  })

  test('fixture 6 SP cũ: 1 chỉ thiếu bằng chứng K · 3 K không xác nhận được / thiếu K', () => {
    const p = cmsImportPlan(CMS_FX_PREVIEW_SIMPLE)
    expect({ write: p.write, skip: p.skip, kAck: p.skipKAck, kBlocked: p.skipKBlocked, file: p.skipFile }).toEqual({ write: 2, skip: 4, kAck: 1, kBlocked: 2, file: 1 })
  })
})

test.describe('UX-KACK-1 · kiểm tĩnh phạm vi (AC7) @desktop', () => {
  test('không đổi luật server: cmsKAckable / binder / parser không bị sửa trong delta; component không tự gọi API ngoài 2 route import', () => {
    const root = path.join(__dirname, '..')
    const view = fs.readFileSync(path.join(root, 'lib/cms/importView.ts'), 'utf8')
    expect(view).toContain("(x.status === 'NO_EVIDENCE' || x.status === 'UNAVAILABLE') && x.k !== null && x.ack === null")
    const flow = fs.readFileSync(path.join(root, 'components/cms/admin/CmsImportFlow.tsx'), 'utf8')
    const urls = [...flow.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]).sort()
    expect(urls).toEqual(['/api/cms/import/commit', '/api/cms/import/preview'])
    // AC6: mọi đường bỏ kết quả preview (Hủy / Upload khác / đổi loại file / preview mới) đều xoá nháp + xác nhận ghi một phần
    for (const fn of ['function reset(', 'function pickFormat(', 'function acceptPreview(']) {
      const body = flow.slice(flow.indexOf(fn), flow.indexOf('\n  }\n', flow.indexOf(fn)))
      expect(body, fn).toContain('setDrafts({})')
      expect(body, fn).toContain('setPartialConfirmed(false)')
    }
    // Mô phỏng kiểm tra lại của fixture chỉ chạy SAU khi boundary chặn (route thật không vào nhánh này, không request)
    const sim = flow.slice(flow.indexOf('if (fixtureBlocked()) {'), flow.indexOf("if (!file) { if (withAcks)"))
    expect(sim).toContain('fixture?.recheck')
    expect(sim).toMatch(/\n\s+return\n\s+}\s*$/)
    expect(flow.indexOf('fixture?.recheck')).toBeGreaterThan(flow.indexOf('if (fixtureBlocked()) {'))
    const panel = fs.readFileSync(path.join(root, 'components/cms/admin/CmsKCheckPanel.tsx'), 'utf8')
    expect(panel).not.toMatch(/fetch\(|from '@\/app\/actions/)
    expect(panel).not.toMatch(/localStorage|sessionStorage/) // không nhớ nguồn cũ giữa các lần
    // KACK-BULK-01: component dùng ĐÚNG các hàm đã kiểm ở trên — xác nhận lưu dấu vân tay (không boolean), đồng bộ mỗi render,
    // nút + handler cùng gọi cmsKBulkApplyAllowed, tick lưu dấu vân tay hiện tại, gõ nguồn huỷ.
    expect(panel).not.toMatch(/setBulkConfirm\(|useState\(false\)/)
    expect(panel).toContain('const bulkFp = cmsKBulkFingerprint(selected, bulkSource)')
    expect(panel).toContain('const confirmedFp = cmsKBulkConfirmSync(bulkConfirmedFp, bulkFp)')
    expect(panel).toContain('if (confirmedFp !== bulkConfirmedFp) setBulkConfirmedFp(confirmedFp)')
    expect(panel).toContain('const bulkOk = cmsKBulkApplyAllowed({ selected, source: bulkSource, confirmedFp, busy })')
    const apply = panel.slice(panel.indexOf('function applyBulk('), panel.indexOf('\n  }\n', panel.indexOf('function applyBulk(')))
    expect(apply).toContain('if (!cmsKBulkApplyAllowed({ selected, source: bulkSource, confirmedFp, busy })) return')
    expect(apply).toContain('setBulkConfirmedFp(null)')
    expect(panel).toMatch(/disabled=\{!bulkOk\} data-cms-k-bulk-apply/)
    expect(panel).toContain('onChange={(e) => setBulkConfirmedFp(e.target.checked ? bulkFp : null)}')
    expect(panel).toContain('onChange={(e) => { setBulkSource(e.target.value); setBulkConfirmedFp(null) }}')
  })
})
