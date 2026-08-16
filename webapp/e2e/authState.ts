import path from 'node:path'

// Đường dẫn storageState của phiên staff, do e2e/auth.setup.ts ghi ra.
//
// Nằm ở module RIÊNG (không phải .spec.ts, không phải .setup.ts) vì Playwright
// CẤM một test file import test file khác: "test file X should not import test
// file Y". Spec nào cần phiên đã đăng nhập thì import hằng số từ đây.
//
// e2e/.auth/ ĐÃ gitignore — file này chứa cookie phiên Supabase còn hiệu lực.
export const STAFF_STATE = path.join(__dirname, '.auth', 'staff.json')

// QLCH (store_manager) — nhánh render RIÊNG trên /targets (targets/page.tsx:616)
// nhưng DÙNG CHUNG CampaignCardList + AffiliateQrCard với Staff, nên phải có
// coverage riêng: sửa component là đụng cả hai vai trò.
export const MANAGER_STATE = path.join(__dirname, '.auth', 'manager.json')

// Super Admin — /targets/campaigns là màn CHỈ super (không phải admin thường),
// nên acceptance của nó không dùng lại được state nào ở trên.
export const SUPER_STATE = path.join(__dirname, '.auth', 'super.json')
