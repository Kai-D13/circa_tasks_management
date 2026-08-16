'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { changeOwnPassword } from '@/app/actions/users'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { KeyRound } from 'lucide-react'

// 'sidebar' (default) = full-width text row used in the desktop Sidebar;
// 'mobile'  = icon-only trigger styled like the other MobileHeader action buttons;
// 'icon'    = 36px outline slot for the Sidebar r2 footer action row — same
//             geometry as NotificationBell/ThemeToggle/Đăng xuất, which is why
//             it cannot reuse 'mobile' (that one is white-on-orange, 40px).
// 'headless' = KHÔNG render trigger, mở sẵn ngay khi mount và gọi `onClose` khi
//             đóng — xem chú thích cùng tên ở EditProfileDialog (account sheet
//             của MobileHeader phải đóng trước rồi mới mount dialog này).
// `finalFocus` — M1.2 (audit P2): xem chú thích cùng tên ở EditProfileDialog.
export function ChangePasswordDialog({ variant = 'sidebar', onClose, finalFocus }: {
  variant?: 'sidebar' | 'mobile' | 'icon' | 'headless'
  onClose?: () => void
  finalFocus?: React.RefObject<HTMLElement | null>
}) {
  const [open, setOpen]           = useState(variant === 'headless')
  const [newPass, setNewPass]     = useState('')
  const [confirm, setConfirm]     = useState('')
  const [clientErr, setClientErr] = useState('')
  const [pending, startTransition] = useTransition()

  function handleOpen() {
    setOpen(true)
    setNewPass('')
    setConfirm('')
    setClientErr('')
  }

  function handleClose() {
    setOpen(false)
    onClose?.()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setClientErr('')
    if (newPass.length < 8) { setClientErr('Mật khẩu phải có ít nhất 8 ký tự'); return }
    if (newPass !== confirm) { setClientErr('Mật khẩu xác nhận không khớp'); return }
    startTransition(async () => {
      const result = await changeOwnPassword(newPass)
      if (result?.error) {
        setClientErr(result.error)
      } else {
        toast.success('Đã đổi mật khẩu thành công')
        handleClose()
      }
    })
  }

  return (
    <>
      {variant === 'headless' ? null : variant === 'mobile' ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label="Đổi mật khẩu"
          className="w-10 h-10 px-0 text-white/80 hover:bg-white/10 hover:text-white"
          onClick={handleOpen}
        >
          <KeyRound className="h-4 w-4" />
        </Button>
      ) : variant === 'icon' ? (
        <Button
          variant="outline"
          size="sm"
          aria-label="Đổi mật khẩu"
          className="h-[36px] w-[36px] px-0"
          onClick={handleOpen}
        >
          <KeyRound className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <button
          type="button"
          onClick={handleOpen}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-sidebar-accent rounded transition-colors"
        >
          <KeyRound className="h-4 w-4 shrink-0" />
          Đổi mật khẩu
        </button>
      )}

      {/* M1.1 (audit P2#3): primitive Dialog thay overlay tự dựng — xem chú
          thích cùng nội dung ở EditProfileDialog. Form giữ nguyên. */}
      <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose() }}>
        <DialogContent className="gap-3" finalFocus={finalFocus}>
          <DialogTitle>Đổi mật khẩu</DialogTitle>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Mật khẩu mới</label>
              <Input
                type="password"
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
                placeholder="Tối thiểu 8 ký tự"
                /* 16px trên mobile: chống iOS Safari tự zoom khi focus. */
                className="h-9 text-[16px] md:text-sm"
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Xác nhận mật khẩu</label>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Nhập lại mật khẩu"
                className="h-9 text-[16px] md:text-sm"
                autoComplete="new-password"
              />
            </div>
            {clientErr && (
              <p className="text-xs text-destructive">{clientErr}</p>
            )}
            <div className="flex gap-2 pt-1">
              <Button type="button" variant="outline" className="flex-1 h-9" onClick={handleClose}>
                Huỷ
              </Button>
              <Button type="submit" className="flex-1 h-9" disabled={pending}>
                {pending ? 'Đang lưu...' : 'Lưu mật khẩu'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
