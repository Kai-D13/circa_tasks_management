'use client'

import { useState } from 'react'
import { AlertCircle, ChartLine, Eye, EyeOff, Heart, ListChecks, Lock, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isLoginCredentialError } from '@/lib/auth/loginCopy'
import { cn } from '@/lib/utils'

// UI v2 Login (artboard L1–L3 / M1–M3) — phần TRÌNH BÀY. LoginForm giữ nguyên luồng: useActionState(login) →
// cookie do server action đặt → hard navigation (window.location.assign). Component này chỉ dựng bố cục + trạng
// thái (mặc định / lỗi / đang đăng nhập) để route thật và fixture /login/ui-catalog dùng CHUNG một markup.
//   - Desktop (≥1024px): panel cam nhận diện bên trái + form (tối đa 380px) giữa nền v2 bên phải.
//   - Mobile: panel cam gọn ~250px ở đầu + sheet form bo góc trên đè 28px; trang cuộn dọc tự nhiên (không
//     overflow:hidden / chiều cao cố định) ⇒ màn thấp hoặc bàn phím mở vẫn tới được nút Đăng nhập.
//   - Lỗi: hiện NGUYÊN chữ server action trả về (role=alert); chỉ lỗi sai email/mật khẩu mới tô viền ô mật khẩu.
//   - Email giữ giá trị sau lỗi: ô KHÔNG controlled (giá trị điền trước khi hydrate / autofill không bị state ghi đè);
//     onSubmit ghi lại email vừa gửi làm defaultValue ⇒ khi React tự reset form sau action, ô email về đúng email đó;
//     mật khẩu (defaultValue rỗng) được xoá.

const POINTS = [
  { text: 'Nhận task và nộp kết quả ngay trên điện thoại', icon: ListChecks },
  { text: 'Theo dõi doanh số chiến dịch theo từng ngày', icon: ChartLine },
  { text: 'Chăm sóc khách hàng và bảng tin nội bộ', icon: Heart },
] as const

// Ô nhập: desktop 46px chữ 15px, mobile 50px chữ 16px (iOS không tự phóng); viền/focus cam 3px theo L3.
const FIELD = 'flex items-center gap-[10px] rounded-[12px] border border-input bg-card px-[14px] h-[50px] transition-shadow lg:h-[46px] lg:rounded-v2-control focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/30'
const INPUT = 'min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-v2-text-3 lg:text-[15px]'

export function LoginScreen({ action, error, busy, initialEmail = '' }: {
  /** Server action của form (LoginForm). Fixture không truyền ⇒ form không gửi đi đâu. */
  action?: (formData: FormData) => void
  error: string | null
  busy: boolean
  initialEmail?: string
}) {
  const [submittedEmail, setSubmittedEmail] = useState(initialEmail)
  const [showPw, setShowPw] = useState(false)
  const credentialError = isLoginCredentialError(error)

  return (
    <div data-ui-v2="page" data-login className="flex min-h-dvh flex-col bg-background text-foreground lg:flex-row">
      {/* ── Panel nhận diện (trang trí + giới thiệu; không chứa thao tác) ── */}
      <aside
        aria-label="Circa Tasks"
        className="relative flex h-[calc(250px+env(safe-area-inset-top))] shrink-0 flex-col gap-[22px] overflow-hidden bg-[var(--login-brand)] px-[24px] pt-[calc(40px+env(safe-area-inset-top))] text-[var(--login-ink)] lg:h-auto lg:min-h-dvh lg:flex-[1_1_520px] lg:justify-between lg:gap-[40px] lg:px-[56px] lg:py-[48px]"
      >
        <span aria-hidden="true" className="absolute -right-[60px] -top-[40px] size-[200px] rotate-[14deg] rounded-[48px] bg-[var(--login-brand-deep)] lg:-bottom-[80px] lg:-right-[80px] lg:top-auto lg:size-[360px] lg:rotate-[12deg] lg:rounded-[72px]" />
        <span aria-hidden="true" className="absolute bottom-[210px] right-[140px] hidden size-[120px] rotate-[12deg] rounded-[28px] bg-[var(--login-brand-soft)] lg:block" />
        <div className="relative flex items-center gap-[10px] lg:gap-[12px]">
          <span aria-hidden="true" className="inline-flex size-[40px] items-center justify-center rounded-[11px] bg-[var(--login-ink)] text-[20px] font-extrabold text-[var(--login-brand)] lg:size-[44px] lg:rounded-[12px] lg:text-[22px]">C</span>
          <span className="text-[18px] font-extrabold lg:text-[20px] lg:tracking-[-0.01em]">Circa Tasks</span>
        </div>
        <div className="relative flex max-w-[460px] flex-col gap-[28px]">
          <p className="max-w-[280px] text-[24px] font-extrabold leading-[1.25] tracking-[-0.01em] lg:max-w-none lg:text-[40px] lg:leading-[1.15] lg:tracking-[-0.02em]">
            Mọi việc ở nhà thuốc, gọn trong một nơi.
          </p>
          <ul aria-label="Giới thiệu Circa Tasks" className="hidden flex-col gap-[14px] lg:flex">
            {POINTS.map(({ text, icon: Icon }) => (
              <li key={text} className="flex items-center gap-[12px] text-[15px] font-medium">
                <span aria-hidden="true" className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--login-ink)]/12">
                  <Icon className="size-[18px]" strokeWidth={1.9} />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative hidden text-[13px] font-medium lg:block">Hệ thống nội bộ Circa · chỉ dành cho tài khoản được cấp</p>
      </aside>

      {/* ── Form: sheet bo góc trên đè panel 28px (mobile); cột giữa nền v2 (desktop) ── */}
      <div className="relative z-10 -mt-[28px] flex flex-1 flex-col rounded-t-[24px] bg-background px-[24px] pt-[28px] pb-[calc(24px+env(safe-area-inset-bottom))] lg:mt-0 lg:flex-[1_1_480px] lg:items-center lg:justify-center lg:rounded-none lg:py-[48px]">
        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col gap-[20px] lg:flex-none lg:gap-[28px]">
          <div className="flex flex-col gap-[6px] lg:gap-[8px]">
            <h1 className="text-[24px] font-bold lg:text-[28px] lg:tracking-[-0.01em]">Đăng nhập</h1>
            <p className="text-[14px] leading-[1.55] text-muted-foreground">Dùng tài khoản Circa Tasks được cấp cho bạn.</p>
          </div>

          <form
            action={action}
            aria-busy={busy}
            onSubmit={(e) => {
              // Fixture (không action): không gửi đi đâu. Route thật: nhớ email để giữ lại sau khi form bị reset.
              if (!action) { e.preventDefault(); return }
              setSubmittedEmail(String(new FormData(e.currentTarget).get('email') ?? ''))
            }}
            className="flex flex-col gap-[16px] lg:gap-[18px]"
          >
            <div className="flex flex-col gap-[8px]">
              <label htmlFor="email" className="text-[14px] font-semibold lg:text-[13px]">Email</label>
              <div className={FIELD}>
                <Mail aria-hidden="true" className="hidden size-[16px] shrink-0 text-muted-foreground lg:block" />
                <input
                  id="email" name="email" type="email" required autoComplete="email"
                  placeholder="ten@circa.vn"
                  defaultValue={submittedEmail}
                  className={INPUT}
                />
              </div>
            </div>
            <div className="flex flex-col gap-[8px]">
              <label htmlFor="password" className="text-[14px] font-semibold lg:text-[13px]">Mật khẩu</label>
              <div data-login-password className={cn(FIELD, 'pr-[4px] lg:pr-[6px]', credentialError && 'border-status-danger')}>
                <Lock aria-hidden="true" className="hidden size-[16px] shrink-0 text-muted-foreground lg:block" />
                <input
                  id="password" name="password" type={showPw ? 'text' : 'password'} required autoComplete="current-password"
                  placeholder="Nhập mật khẩu"
                  aria-invalid={credentialError || undefined}
                  className={INPUT}
                />
                {/* Nút mắt: type=button (không gửi form, không xoá giá trị), bàn phím kích hoạt được; 44px mobile. */}
                <button
                  type="button"
                  aria-label={showPw ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  aria-pressed={showPw}
                  aria-controls="password"
                  onClick={() => setShowPw((v) => !v)}
                  className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-[10px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30 lg:size-[36px] lg:rounded-[8px]"
                >
                  {showPw ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
                </button>
              </div>
            </div>

            {error && (
              <div role="alert" className="flex items-start gap-[10px] rounded-[12px] border border-status-danger/30 bg-status-danger-bg px-[14px] py-[12px] text-[14px] text-status-danger lg:rounded-v2-control">
                <AlertCircle aria-hidden="true" className="mt-px size-[16px] shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Bận suốt lúc chờ server lẫn lúc chuyển trang (pending || redirecting) — không cho gửi hai lần. */}
            <Button
              type="submit"
              disabled={busy}
              data-busy={busy || undefined}
              className="mt-[4px] h-[52px] gap-[10px] rounded-[12px] text-[16px] font-bold disabled:opacity-100 data-[busy]:bg-[var(--login-action-busy)] lg:mt-0 lg:h-[48px] lg:rounded-v2-control lg:text-[15px]"
            >
              {busy && <span aria-hidden="true" className="size-[16px] animate-spin rounded-full border-2 border-current border-r-transparent" />}
              {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
            </Button>
          </form>

          <p className="text-center text-[13px] leading-[1.55] text-muted-foreground lg:text-left">
            Quên mật khẩu? Liên hệ Admin hoặc Quản lý vùng để được cấp lại.
          </p>
          <p className="mt-auto text-center text-[12px] text-v2-text-3 lg:mt-0 lg:text-left">© {new Date().getFullYear()} Circa</p>
        </div>
      </div>
    </div>
  )
}
