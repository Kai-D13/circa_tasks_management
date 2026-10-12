'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useUserStore } from '@/store/userStore'
import { ChangePasswordDialog } from '@/components/layout/ChangePasswordDialog'
import { EditProfileDialog } from '@/components/layout/EditProfileDialog'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { LogOut, UserCog, KeyRound } from 'lucide-react'

// Avatar + account sheet (mobile) — tách từ MobileHeader (B7-ui r2) để header riêng của 3 màn
// dược sĩ CSKH dùng CHUNG đúng một sheet: cùng tên "Tài khoản", cùng trả focus về avatar.
// `tone`: onPrimary = trên header cam (MobileHeader) · onSurface = trên header nền sáng (CSKH).

// Một hàng trong account sheet: vùng chạm 44px pixel-literal (rem bị co 6.25%
// vì root font 15px, `h-11` chỉ ra 41px thật).
const SHEET_ROW = 'flex items-center gap-3 w-full min-h-[44px] rounded-lg px-2 text-sm text-left transition-colors hover:bg-muted/50 active:bg-muted'

type AccountDialog = 'profile' | 'password'

export function AccountMenu({ tone = 'onPrimary' }: { tone?: 'onPrimary' | 'onSurface' }) {
  const supabase = useMemo(() => createClient(), [])
  const router   = useRouter()
  const profile  = useUserStore((s) => s.profile)
  const role     = profile?.role

  const [sheetOpen, setSheetOpen] = useState(false)
  const [child, setChild]         = useState<AccountDialog | null>(null)
  const pendingRef                = useRef<AccountDialog | null>(null)
  // M1.2 (audit P2): điểm trả focus của CẢ sheet lẫn hai dialog con. Nút avatar
  // không phải `Dialog.Trigger` (nó mở sheet bằng onClick thường), và trên
  // mobile một cú chạm không nhất thiết focus vào button — nên mặc định "trả
  // focus về trigger hoặc phần tử vừa focus" của base-ui dễ rơi về <body>.
  const avatarRef                 = useRef<HTMLButtonElement>(null)

  const initial = (profile?.full_name ?? '').trim().charAt(0).toUpperCase() || 'C'

  async function handleLogout() {
    // Đóng sheet trước khi điều hướng: để base-ui gỡ scroll-lock/focus-trap
    // bình thường thay vì bị unmount giữa chừng lúc đổi route.
    setSheetOpen(false)
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  // Dialog con (Sửa hồ sơ / Đổi mật khẩu) KHÔNG được lồng trong sheet: base-ui
  // Popup có `translate` nên nó thành containing block, `fixed inset-0` của hai
  // dialog kia sẽ bám vào sheet chứ không bám viewport (và sheet vẫn nằm đè bên
  // dưới). Cách chắc chắn chạy: bấm hàng ⇒ đóng sheet, đợi animation đóng xong
  // rồi mới mount dialog con Ở NGOÀI sheet.
  //   - `onOpenChangeComplete` là đường chính (base-ui gọi sau khi animation kết thúc).
  //   - setTimeout là lưới an toàn phòng khi callback không kích (không animation).
  // `flushChild` idempotent nhờ pendingRef nên hai đường gọi cũng chỉ mở một lần.
  function flushChild() {
    if (!pendingRef.current) return
    setChild(pendingRef.current)
    pendingRef.current = null
  }

  function requestChild(which: AccountDialog) {
    pendingRef.current = which
    setSheetOpen(false)
    window.setTimeout(flushChild, 300)
  }

  return (
    <>
      <button
        ref={avatarRef}
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label="Tài khoản"
        aria-haspopup="dialog"
        className={cn('flex h-[44px] w-[44px] items-center justify-center rounded-full shrink-0 transition-colors',
          tone === 'onPrimary' ? 'active:bg-white/10' : 'active:bg-muted')}
      >
        {tone === 'onPrimary' ? (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-xs font-bold text-white">
            {initial}
          </span>
        ) : (
          <span className="flex size-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
            {initial}
          </span>
        )}
      </button>

      {/* Account sheet — cùng idiom bottom-sheet với drawer "Thêm" của BottomNav. */}
      <Dialog
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onOpenChangeComplete={(open) => { if (!open) flushChild() }}
      >
        <DialogContent
          showCloseButton={false}
          finalFocus={avatarRef}
          className="top-auto bottom-0 left-0 right-0 max-w-full translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl pb-[calc(1rem_+_env(safe-area-inset-bottom))] md:hidden"
        >
          {/* Hàng tài khoản bên dưới đã là tiêu đề nhìn thấy được; title này chỉ
              để screen reader có tên cho dialog. */}
          <DialogTitle className="sr-only">Tài khoản</DialogTitle>

          <div className="flex items-center gap-3 border-b pb-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {initial}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{profile?.full_name ?? 'Tài khoản'}</p>
              <p className="truncate text-xs text-muted-foreground">{profile?.email}</p>
            </div>
          </div>

          <div className="flex flex-col gap-0.5">
            {/* Sửa hồ sơ: giữ nguyên điều kiện cũ — chỉ staff. */}
            {role === 'staff' && (
              <button type="button" className={SHEET_ROW} onClick={() => requestChild('profile')}>
                <UserCog className="h-4 w-4 shrink-0 text-muted-foreground" />
                Sửa hồ sơ
              </button>
            )}
            <button type="button" className={SHEET_ROW} onClick={() => requestChild('password')}>
              <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
              Đổi mật khẩu
            </button>
            <ThemeToggle variant="row" className={SHEET_ROW} />
            <button type="button" className={cn(SHEET_ROW, 'text-destructive')} onClick={handleLogout}>
              <LogOut className="h-4 w-4 shrink-0" />
              Đăng xuất
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* finalFocus: hai dialog này mount SAU khi sheet (và hàng bấm vào) đã
          unmount, nên phải chỉ đích danh avatar — xem chú thích ở avatarRef. */}
      {child === 'profile'  && <EditProfileDialog    variant="headless" finalFocus={avatarRef} onClose={() => setChild(null)} />}
      {child === 'password' && <ChangePasswordDialog variant="headless" finalFocus={avatarRef} onClose={() => setChild(null)} />}
    </>
  )
}
