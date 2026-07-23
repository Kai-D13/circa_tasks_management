import { test, expect } from '@playwright/test'
import { AFFILIATE_QR_FILTER, qrCardVisible, qrCardState, urlStateActive, qrCardKey } from '../lib/affiliate/qrDisplay'
import { decideUpload } from '../scripts/qr-upload-decision.mjs'

// P3-H r1 unit gate (audit 24/07) — khóa contract hiển thị QR + quyết định
// upload immutable. Page /targets + AffiliateQrCard + upload script chỉ tiêu
// thụ các hàm này.

const VIS = (over: Partial<Parameters<typeof qrCardVisible>[0]> = {}) => ({
  flagEnabled: true, eligibleRole: true, storeResolved: true, inCampaignDetail: false, ...over,
})

test.describe('affiliate qr display + upload contract @desktop', () => {
  test('FLAG OFF → không query/render (mọi tổ hợp khác giữ nguyên)', () => {
    expect(qrCardVisible(VIS({ flagEnabled: false }))).toBe(false)
  })

  test('DETAIL ?campaign= → không render; LANDING (kể cả không campaign) → render', () => {
    expect(qrCardVisible(VIS({ inCampaignDetail: true }))).toBe(false)
    // Landing không phụ thuộc campaign active — chỉ cần flag + role + store.
    expect(qrCardVisible(VIS())).toBe(true)
  })

  test('role không hợp lệ / chưa resolve store → không render', () => {
    expect(qrCardVisible(VIS({ eligibleRole: false }))).toBe(false)
    expect(qrCardVisible(VIS({ storeResolved: false }))).toBe(false)
  })

  test('FILTER mapping bắt buộc os + is_active=true (inactive không trả QR — audit P1#2)', () => {
    // toEqual khóa CẢ 2 điều kiện — thiếu is_active là fail ngay tại đây.
    expect(AFFILIATE_QR_FILTER).toEqual({ partner_type: 'os', is_active: true })
  })

  test('trạng thái card: query ERROR ≠ MISSING ≠ có QR (audit P2#3)', () => {
    expect(qrCardState(true, null)).toBe('error')
    expect(qrCardState(true, { qr_image_url: 'https://x/qr.png' })).toBe('error') // lỗi thắng
    expect(qrCardState(false, null)).toBe('missing')
    expect(qrCardState(false, { qr_image_url: null })).toBe('missing')
    expect(qrCardState(false, { qr_image_url: 'https://x/qr.png' })).toBe('qr')
  })

  test('r1.1: ảnh store A lỗi → SM đổi store B → state lỗi/modal KHÔNG dính, QR B render', () => {
    const qrA = 'https://storage.googleapis.com/duocsi-circa-vn/affiliate-qr/v1/POS0009/CIRCA-CENTRAL.png'
    const qrB = 'https://storage.googleapis.com/duocsi-circa-vn/affiliate-qr/v1/POS0059/CIRCA-TAMVIET.png'
    expect(urlStateActive(qrA, qrA)).toBe(true)   // đang ở A: trạng thái lỗi/modal hiện
    expect(urlStateActive(qrA, qrB)).toBe(false)  // đổi sang B: tự reset → QR B render
    expect(urlStateActive(null, qrB)).toBe(false) // chưa đánh dấu gì
    expect(urlStateActive(qrA, null)).toBe(false) // store B chưa có QR → cũng không dính
  })

  test('r1.2: qrCardKey — vòng A→B→A: MỖI lần đổi store/ảnh key ĐỔI → remount instance mới (lỗi/modal cũ không sống lại)', () => {
    const qrA = 'https://storage.googleapis.com/duocsi-circa-vn/affiliate-qr/v1/POS0009/CIRCA-CENTRAL.png'
    const qrB = 'https://storage.googleapis.com/duocsi-circa-vn/affiliate-qr/v1/POS0059/CIRCA-TAMVIET.png'
    const kA = qrCardKey('store-a', qrA)
    const kB = qrCardKey('store-b', qrB)
    expect(kA).not.toBe(kB)                        // A→B: key đổi → remount
    // B→A: key đổi so với instance B đang mount → remount instance A MỚI.
    // (React discard state khi key đổi và KHÔNG cache state qua unmount —
    // ảnh A được browser retry, modal không tự mở lại.)
    expect(qrCardKey('store-a', qrA)).not.toBe(kB)
    expect(qrCardKey('store-a', qrA)).toBe(kA)     // key ổn định khi không đổi gì
    expect(qrCardKey('store-a', null)).not.toBe(kA)  // cùng store, ảnh đổi/mất → remount
    expect(qrCardKey(null, null)).toBe('none|none')  // store chưa resolve vẫn có key hợp lệ
  })

  test('upload immutable (audit P1#1): chưa có → UPLOAD_NEW; re-run SHA khớp → SKIP_OK; SHA khác → FAIL', () => {
    expect(decideUpload({ exists: false })).toBe('UPLOAD_NEW')
    expect(decideUpload({ exists: true, remoteSha: 'abc', localSha: 'abc' })).toBe('SKIP_OK')
    expect(decideUpload({ exists: true, remoteSha: 'abc', localSha: 'def' })).toBe('FAIL_DIFFERENT')
    // Không đọc được SHA remote (object tồn tại nhưng fetch lỗi) → fail-closed,
    // KHÔNG ghi đè.
    expect(decideUpload({ exists: true, localSha: 'abc' })).toBe('FAIL_DIFFERENT')
  })
})
