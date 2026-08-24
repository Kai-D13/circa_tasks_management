import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { SUPER_ADMIN_EMAILS, isSuperAdmin, isSuperAdminEmail } from '../lib/authz'

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWLIST SUPER ADMIN NẰM Ở HAI NƠI — VÀ ĐÃ LỆCH HAI LẦN
//
// Super admin = role 'admin' + email trong allowlist. Allowlist tồn tại ở:
//   1. DB : public.is_super_admin()  (migration mới nhất định nghĩa nó)
//   2. App: lib/authz.ts SUPER_ADMIN_EMAILS
// Sửa một nơi mà quên nơi kia thì gate lệch: người dùng sửa được ở màn đi qua
// app-layer nhưng bị RLS chặn ở màn khác (hoặc ngược lại) — triệu chứng rất khó
// lần vì không có lỗi nào rõ ràng. Đã xảy ra ở 066, và 100 phải ghi hẳn cảnh
// báo vào header. Test này biến "phải nhớ" thành "không thể quên".
//
// Nguồn DB đọc từ migration MỚI NHẤT có CREATE OR REPLACE cho hàm — không
// hardcode số hiệu, vì lần thêm super admin sau sẽ tạo file mới.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations')

function latestIsSuperAdminSql(): { file: string; sql: string } {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()   // tên file bắt đầu bằng số có đệm 0 ⇒ sort chuỗi = sort thứ tự chạy
  let hit: { file: string; sql: string } | null = null
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').replace(/\r\n/g, '\n')
    // Chấp nhận cả dạng có/không có 'public.' — kiểu viết đã khác nhau giữa các
    // migration, và chính khác biệt kiểu viết từng làm tôi tìm nhầm bản mới nhất
    // của một policy khác trong batch này.
    if (/CREATE OR REPLACE FUNCTION\s+(public\.)?is_super_admin\s*\(/.test(sql)) hit = { file: f, sql }
  }
  if (!hit) throw new Error('không tìm thấy migration nào định nghĩa is_super_admin')
  return hit
}

function emailsInDbFunction(sql: string): string[] {
  const i = sql.search(/CREATE OR REPLACE FUNCTION\s+(public\.)?is_super_admin\s*\(/)
  const body = sql.slice(i, sql.indexOf('$$;', i))
  return [...body.matchAll(/'([^']+@[^']+)'/g)].map((m) => m[1].toLowerCase()).sort()
}

test.describe('super-admin allowlist đồng bộ DB ↔ App @desktop', () => {
  test('hai danh sách PHẢI trùng khớp tuyệt đối', () => {
    const { file, sql } = latestIsSuperAdminSql()
    const db = emailsInDbFunction(sql)
    const app = [...SUPER_ADMIN_EMAILS].map((e) => e.toLowerCase()).sort()

    expect(db.length, `${file}: không đọc được email nào trong hàm`).toBeGreaterThan(0)
    // toEqual chỉ ra ĐÚNG email nào thừa/thiếu ở phía nào.
    expect(app, `lệch allowlist giữa lib/authz.ts và ${file}`).toEqual(db)
  })

  test('hàm DB vẫn đòi role = admin (email trong allowlist là CHƯA đủ)', () => {
    const { file, sql } = latestIsSuperAdminSql()
    const i = sql.search(/CREATE OR REPLACE FUNCTION\s+(public\.)?is_super_admin\s*\(/)
    const body = sql.slice(i, sql.indexOf('$$;', i))
    expect(body, `${file}: mất điều kiện role='admin' ⇒ mọi tài khoản trong allowlist thành super bất kể vai trò`)
      .toContain("role = 'admin'")
  })

  test('app-layer cũng đòi role admin, không chỉ email', () => {
    const someone = SUPER_ADMIN_EMAILS[0]
    expect(isSuperAdminEmail(someone)).toBe(true)
    expect(isSuperAdmin(someone, 'admin')).toBe(true)
    // Email đúng nhưng vai trò khác ⇒ KHÔNG phải super.
    for (const role of ['staff', 'store_manager', 'sm', null, undefined]) {
      expect(isSuperAdmin(someone, role as string | null), `role=${role} không được là super`).toBe(false)
    }
    // Không phân biệt hoa thường (email đăng nhập có thể viết hoa).
    expect(isSuperAdminEmail(someone.toUpperCase())).toBe(true)
    expect(isSuperAdminEmail('nguoi.la@buymed.com')).toBe(false)
  })
})
