// UI v2 Phase 3 · Bảng tin (A2) — helper THUẦN cho thống kê đã xem của trang chi tiết (chỉ admin). Nhận đúng dữ liệu
// trang chi tiết đang tải (người nhận staff + store_manager theo đối tượng tin; announcement_reads) — không truy vấn,
// không đổi tập mẫu số (PM spec §3.4). Chỉ thêm SẮP XẾP và LỌC trên mảng đã có (Q-139/Q-140).

export const UNASSIGNED_STORE = 'Chưa gán cửa hàng'

/** id của panel thống kê (đích link "N người chưa xem ↓"). Để ở module THƯỜNG — hằng export từ file 'use client' khi
 *  import vào server component chỉ là client reference (đã gặp: href thành "#function(){throw …}"). */
export const READ_STATS_ANCHOR = 'da-xem'

export interface ReadMember {
  id: string
  full_name: string
  store_id: string | null
  /** Tên hiển thị; người không gán / không đọc được cửa hàng = UNASSIGNED_STORE (như mã hiện hành). */
  store: string
}

export interface StoreReadGroup {
  store: string
  unassigned: boolean
  members: { id: string; full_name: string; readAt: string | null }[]
  read: number
  total: number
}

/** Nhóm người nhận theo cửa hàng (khoá = tên hiển thị, như mã hiện hành), người trong nhóm theo tên `vi`.
 *  Xếp nhóm: tỷ lệ đã xem TĂNG dần (cửa hàng ít người đọc lên đầu), bằng nhau thì theo tên `vi`;
 *  "Chưa gán cửa hàng" luôn ở CUỐI (Q-139). total/read = đúng tổng của mã hiện hành (đếm trên tập người nhận). */
export function buildStoreReadGroups(members: ReadMember[], readMap: Map<string, string>) {
  const byStore = new Map<string, StoreReadGroup['members']>()
  let read = 0
  for (const m of members) {
    const readAt = readMap.get(m.id) ?? null
    if (readAt) read++
    const arr = byStore.get(m.store) ?? []
    arr.push({ id: m.id, full_name: m.full_name, readAt })
    byStore.set(m.store, arr)
  }
  const groups: StoreReadGroup[] = [...byStore.entries()].map(([store, ms]) => ({
    store,
    unassigned: store === UNASSIGNED_STORE,
    members: ms.sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi')),
    read: ms.filter((x) => x.readAt).length,
    total: ms.length,
  }))
  groups.sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1
    const d = a.read / a.total - b.read / b.total
    return d !== 0 ? d : a.store.localeCompare(b.store, 'vi')
  })
  return { groups, total: members.length, read }
}

/** Lọc "Chưa xem" (Q-140): chỉ cửa hàng còn người chưa xem, trong đó chỉ người chưa xem; giữ thứ tự. Số đếm của
 *  nhóm (read/total) giữ nguyên để thanh tiến độ không đổi nghĩa. */
export function onlyUnread(groups: StoreReadGroup[]): StoreReadGroup[] {
  return groups
    .map((g) => ({ ...g, members: g.members.filter((m) => !m.readAt) }))
    .filter((g) => g.members.length > 0)
}
