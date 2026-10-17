// UI v2 Login — chữ lỗi "sai email/mật khẩu" do app/actions/auth.ts trả về (đổi từ 'Invalid login credentials').
// Dùng để màn đăng nhập tô viền ô mật khẩu CHỈ khi đúng lỗi credential; lỗi khác (mạng, server, khoá tài khoản…)
// chỉ hiện alert chung. Server action là 'use server' nên không export hằng được — e2e/login-copy.spec.ts khoá
// hai nơi phải trùng chữ.
export const LOGIN_CREDENTIAL_ERROR = 'Email hoặc mật khẩu không đúng.'

export function isLoginCredentialError(message: string | null | undefined): boolean {
  return message === LOGIN_CREDENTIAL_ERROR
}
