import { test, expect } from '@playwright/test'
import { campaignArchivable, campaignDeletable } from '../lib/kpi/archive'

// Campaign Archive unit gate (contract cuối 28/07) — khóa luật 3 lớp dùng
// chung (UI nút · server action · RPC 098 mirror):
//   draft → chỉ XÓA VĨNH VIỄN · active → không archive (phải pause trước) ·
//   paused/ended → SOFT ARCHIVE · đã archive → đóng băng mọi thao tác.

const ARCHIVED = '2026-07-28T10:00:00Z'

test.describe('kpi campaign archive contract @desktop', () => {
  test('archivable: CHỈ paused/ended chưa lưu trữ', () => {
    expect(campaignArchivable('paused', null)).toEqual({ ok: true })
    expect(campaignArchivable('ended', null)).toEqual({ ok: true })
  })

  test('active KHÔNG archive — phải tạm dừng trước (lý do nói rõ)', () => {
    const r = campaignArchivable('active', null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('tạm dừng trước')
  })

  test('draft KHÔNG archive (đi đường Xóa vĩnh viễn); status lạ cũng bị chặn (fail-closed)', () => {
    expect(campaignArchivable('draft', null).ok).toBe(false)
    expect(campaignArchivable('', null).ok).toBe(false)
    expect(campaignArchivable('unknown-status', null).ok).toBe(false)
  })

  test('đã archive → không archive lại được (mọi status)', () => {
    for (const status of ['draft', 'active', 'paused', 'ended']) {
      const r = campaignArchivable(status, ARCHIVED)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('đã được lưu trữ')
    }
  })

  test('deletable: CHỈ draft chưa archive — paused/ended/active không hard-delete (giữ dữ liệu KPI/commission/audit)', () => {
    expect(campaignDeletable('draft', null)).toEqual({ ok: true })
    expect(campaignDeletable('active', null).ok).toBe(false)
    expect(campaignDeletable('paused', null).ok).toBe(false)
    expect(campaignDeletable('ended', null).ok).toBe(false)
    // Fail-closed: archived không bao giờ deletable kể cả khi status bị sửa tay
    expect(campaignDeletable('draft', ARCHIVED).ok).toBe(false)
  })
})
