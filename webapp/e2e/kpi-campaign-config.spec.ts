import { test, expect } from '@playwright/test'
import { activationBlockReason, resolveMetricInput } from '../lib/kpi/campaignConfig'
import type { AffiliateSyncHealth } from '../lib/affiliate/health'

// P3-D unit gate — metric contract + activation gate (audit 23/07).

const READY: AffiliateSyncHealth = {
  ready: true, reason: null, runId: 'run-A',
  lastSuccessAt: '2026-07-23T09:00:00.000Z', ageMinutes: 30,
}

test.describe('kpi campaign metric contract @desktop', () => {
  test('create mặc định: không gửi gì → Offline-only (campaign cũ giữ hành vi)', () => {
    expect(resolveMetricInput(false, {})).toEqual({ ok: true, metric_offline: true, metric_affiliate: false })
    expect(resolveMetricInput(true, {})).toEqual({ ok: true, metric_offline: true, metric_affiliate: false })
  })

  test('FLAG TẮT + metric_affiliate=true → server TỪ CHỐI (kể cả client cố gửi)', () => {
    const r = resolveMetricInput(false, { metric_affiliate: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('KPI_AFFILIATE_ENABLED')
  })

  test('flag bật: tick affiliate hợp lệ (cả affiliate-only)', () => {
    expect(resolveMetricInput(true, { metric_affiliate: true })).toEqual({ ok: true, metric_offline: true, metric_affiliate: true })
    expect(resolveMetricInput(true, { metric_offline: false, metric_affiliate: true })).toEqual({ ok: true, metric_offline: false, metric_affiliate: true })
  })

  test('cả 2 tắt → lỗi ≥1 metric', () => {
    const r = resolveMetricInput(true, { metric_offline: false, metric_affiliate: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('ít nhất một chỉ số')
  })

  test('update merge với current: field không gửi giữ giá trị cũ', () => {
    const current = { metric_offline: true, metric_affiliate: true }
    // chỉ tắt offline → affiliate giữ true
    expect(resolveMetricInput(true, { metric_offline: false }, current))
      .toEqual({ ok: true, metric_offline: false, metric_affiliate: true })
    // tắt affiliate → còn offline
    expect(resolveMetricInput(true, { metric_affiliate: false }, current))
      .toEqual({ ok: true, metric_offline: true, metric_affiliate: false })
    // current affiliate=true + flag đã tắt + update đụng metric → chặn (fail-closed)
    const r = resolveMetricInput(false, { metric_offline: false }, current)
    expect(r.ok).toBe(false)
  })
})

test.describe('kpi campaign activation gate @desktop', () => {
  test('không target → chặn (mọi loại campaign)', () => {
    expect(activationBlockReason({ metricAffiliate: false, targetCount: 0, invalidStores: [], health: null }))
      .toContain('Chưa import target')
  })

  test('OFFLINE-ONLY: không phụ thuộc health/store-type → null (được kích hoạt)', () => {
    expect(activationBlockReason({ metricAffiliate: false, targetCount: 5, invalidStores: [], health: null }))
      .toBeNull()
  })

  test('affiliate: target không phải OS-active → lý do kèm danh sách', () => {
    const r = activationBlockReason({ metricAffiliate: true, targetCount: 5, invalidStores: ['POS0088 (fs)', 'POS0099 (ngưng)'], health: READY })
    expect(r).toContain('không phải OS store active')
    expect(r).toContain('POS0088')
  })

  test('affiliate: health không ready → lý do cụ thể; health null → chặn an toàn', () => {
    const r = activationBlockReason({
      metricAffiliate: true, targetCount: 5, invalidStores: [],
      health: { ...READY, ready: false, reason: 'snapshot stale 400 phút (> 180)' },
    })
    expect(r).toContain('chưa sẵn sàng')
    expect(r).toContain('stale')
    expect(activationBlockReason({ metricAffiliate: true, targetCount: 5, invalidStores: [], health: null }))
      .toContain('chưa kiểm tra được')
  })

  test('affiliate: đủ điều kiện (targets OS-active + health READY) → null', () => {
    expect(activationBlockReason({ metricAffiliate: true, targetCount: 5, invalidStores: [], health: READY }))
      .toBeNull()
  })
})
