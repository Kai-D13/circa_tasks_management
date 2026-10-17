import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { LOGIN_CREDENTIAL_ERROR, isLoginCredentialError } from '../lib/auth/loginCopy'

// UI v2 Login unit gate: màn đăng nhập chỉ tô viền ô mật khẩu khi lỗi ĐÚNG là "sai email/mật khẩu". Chữ đó do
// app/actions/auth.ts ('use server' — không export hằng được) trả về ⇒ khoá hai nơi phải trùng nhau.

test.describe('login copy contract @desktop', () => {
  test('chữ lỗi credential trùng với server action auth.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'actions', 'auth.ts'), 'utf8')
    expect(src, 'auth.ts không còn trả đúng chữ lỗi credential mà màn đăng nhập dựa vào').toContain(`'${LOGIN_CREDENTIAL_ERROR}'`)
  })

  test('isLoginCredentialError: chỉ đúng chữ credential; lỗi khác / rỗng ⇒ false', () => {
    expect(isLoginCredentialError(LOGIN_CREDENTIAL_ERROR)).toBe(true)
    for (const m of ['Request rate limit reached', 'Email not confirmed', 'fetch failed', '', null, undefined]) {
      expect(isLoginCredentialError(m), String(m)).toBe(false)
    }
  })
})
