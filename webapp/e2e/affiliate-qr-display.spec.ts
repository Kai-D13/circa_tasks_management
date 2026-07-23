import { test, expect } from '@playwright/test'
import { AFFILIATE_QR_FILTER, qrCardVisible, qrCardState } from '../lib/affiliate/qrDisplay'
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

  test('upload immutable (audit P1#1): chưa có → UPLOAD_NEW; re-run SHA khớp → SKIP_OK; SHA khác → FAIL', () => {
    expect(decideUpload({ exists: false })).toBe('UPLOAD_NEW')
    expect(decideUpload({ exists: true, remoteSha: 'abc', localSha: 'abc' })).toBe('SKIP_OK')
    expect(decideUpload({ exists: true, remoteSha: 'abc', localSha: 'def' })).toBe('FAIL_DIFFERENT')
    // Không đọc được SHA remote (object tồn tại nhưng fetch lỗi) → fail-closed,
    // KHÔNG ghi đè.
    expect(decideUpload({ exists: true, localSha: 'abc' })).toBe('FAIL_DIFFERENT')
  })
})
