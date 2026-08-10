// Identity khách Affiliate = SỐ ĐIỆN THOẠI NGƯỜI MUA đã chuẩn hóa (contract
// stakeholder 09/08 — THAY account_id: 317/317 đơn có buyer phone hợp lệ, 233
// khách duy nhất, không có phone↔account đa trị; 14 đơn thiếu account_id hết
// là blocker, chỉ còn diagnostic chất lượng nguồn).
//
// NGUỒN DUY NHẤT: `order.customer_phone` (người MUA).
// ⛔ TUYỆT ĐỐI KHÔNG dùng `receiver_phone_number` (người NHẬN — đặt hộ sẽ gộp
//    nhầm 2 khách thành 1 / tách 1 khách thành 2). Projection Mongo không pull
//    field đó; test khóa contract này.
//
// Chuẩn hóa (mirror ngữ nghĩa normalize_phone() của migration 059 nhưng CHẶT
// hơn — 059 chỉ dùng để match staff, ở đây là identity tiền/thưởng):
//   1. bỏ mọi ký tự không phải số (khoảng trắng, chấm, gạch, ngoặc, '+')
//   2. tiền tố quốc tế: '00' + '84' → bỏ; '84' + 9 số → '0' + 9 số
//   3. 9 số không bắt đầu bằng 0 → thêm '0'
//   4. PHẢI khớp ^0[35789][0-9]{8}$ (đầu số di động VN 10 chữ số) — không
//      khớp → null (KHÔNG đoán, KHÔNG lưu rác).
// null = "không có identity hợp lệ": KHÔNG reject đơn (ingest vẫn lưu đủ như
// completed_time), fail-closed nằm ở RPC aggregate + canary cron.
const VN_MOBILE_RE = /^0[35789][0-9]{8}$/

export function normalizeVnPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let d = raw.replace(/[^0-9]/g, '')
  if (d === '') return null
  // '0084…' / '84…' → nội địa. Chỉ strip khi phần còn lại đúng 9 số (số di
  // động VN không có '0') — tránh cắt nhầm số nội địa mở đầu '84'.
  if (d.length === 13 && d.startsWith('0084')) d = d.slice(4)
  else if (d.length === 12 && d.startsWith('840')) d = d.slice(3)   // 84 + 0xxxxxxxxx
  else if (d.length === 11 && d.startsWith('84')) d = d.slice(2)
  if (d.length === 9 && !d.startsWith('0')) d = `0${d}`
  return VN_MOBILE_RE.test(d) ? d : null
}

// Dùng cho log/diagnostic: che phần giữa để PII không nằm nguyên trong log
// Coolify / response cron (mirror mask trong RPC 104). Giữ đủ đầu-cuối để vận
// hành tra được đơn.
export function maskVnPhone(phone: string): string {
  return phone.length === 10 ? `${phone.slice(0, 4)}***${phone.slice(7)}` : '***'
}
