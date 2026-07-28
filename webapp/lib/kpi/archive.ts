// Campaign Archive (contract cuối 28/07) — điều kiện lưu trữ/xóa THUẦN, dùng
// chung server action + UI (nút chỉ render khi hợp lệ; action re-check server
// side; RPC 098 là chốt chặn cuối trong DB — 3 lớp cùng một luật):
//   · draft        → XÓA VĨNH VIỄN (đường deleteCampaign hiện hành, cascade).
//   · active       → không archive — phải tạm dừng trước.
//   · paused/ended → SOFT ARCHIVE (biến mất khỏi UI, GIỮ toàn bộ dữ liệu con).
//   · đã archive   → không thao tác gì thêm (restore = SQL tay, xem 098).
export type ArchiveEligibility = { ok: true } | { ok: false; reason: string }

export function campaignArchivable(status: string, archivedAt: string | null): ArchiveEligibility {
  if (archivedAt !== null) return { ok: false, reason: 'Chiến dịch đã được lưu trữ trước đó' }
  if (status === 'active') return { ok: false, reason: 'Chiến dịch đang chạy — tạm dừng trước khi lưu trữ' }
  if (status !== 'paused' && status !== 'ended') {
    return { ok: false, reason: 'Chỉ lưu trữ chiến dịch tạm dừng hoặc đã kết thúc' }
  }
  return { ok: true }
}

export function campaignDeletable(status: string, archivedAt: string | null): ArchiveEligibility {
  // Fail-closed: archived không bao giờ deletable (dù trạng thái DB có bị sửa
  // tay thành draft) — hard-delete chỉ dành cho bản nháp chưa từng vận hành.
  if (archivedAt !== null) return { ok: false, reason: 'Chiến dịch đã lưu trữ — không xoá' }
  if (status !== 'draft') return { ok: false, reason: 'Chỉ xoá được chiến dịch nháp' }
  return { ok: true }
}
