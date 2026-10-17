import { notFound } from 'next/navigation'
import { LoginScreen } from '../LoginScreen'
import { LOGIN_CREDENTIAL_ERROR } from '@/lib/auth/loginCopy'

// Dev-only fixture màn Login v2 — render ĐÚNG LoginScreen của /login với trạng thái ép sẵn, KHÔNG gắn server
// action (form không gửi đi đâu). Công khai như /login (proxy cho qua mọi đường /login*) nhưng chỉ tồn tại khi
// UI_CATALOG=1 (Coolify không đặt ⇒ prod 404). Không có dữ liệu thật; email mẫu là giá trị giả.
// ?state= default · credential (sai email/mật khẩu) · other (lỗi khác do server trả) · pending
export const dynamic = 'force-dynamic'

const STATES = {
  default: { error: null, busy: false, email: '' },
  credential: { error: LOGIN_CREDENTIAL_ERROR, busy: false, email: 'duocsi.qa@example.invalid' },
  other: { error: 'Request rate limit reached', busy: false, email: 'duocsi.qa@example.invalid' },
  pending: { error: null, busy: true, email: 'duocsi.qa@example.invalid' },
} as const

export default async function LoginFixturePage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { state = 'default' } = await searchParams
  const s = STATES[state as keyof typeof STATES] ?? STATES.default
  return (
    <div data-testid="login-fixture" data-state={state in STATES ? state : 'default'}>
      <LoginScreen error={s.error} busy={s.busy} initialEmail={s.email} />
    </div>
  )
}
