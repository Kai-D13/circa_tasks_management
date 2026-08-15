'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { updateOwnProfile } from '@/app/actions/users'
import { useUserStore } from '@/store/userStore'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { UserCog } from 'lucide-react'

// Lets a user edit their own full_name + phone_number (stakeholder 2026-06-15).
// 'sidebar' (default) = full-width text row in the desktop Sidebar; 'mobile' =
// icon-only trigger styled like the other MobileHeader action buttons; 'icon' =
// 36px outline slot for the Sidebar r2 footer action row. Mirrors
// ChangePasswordDialog so the header controls stay consistent.
// 'headless' = KHÔNG render trigger, mở sẵn ngay khi mount và gọi `onClose` khi
// đóng. Dùng khi nút bấm nằm trong một lớp nổi khác (account sheet của
// MobileHeader): sheet phải đóng TRƯỚC rồi mới mount dialog này ở ngoài, nên
// trigger không thể sống cùng chỗ với nội dung dialog.
export function EditProfileDialog({ variant = 'sidebar', onClose }: { variant?: 'sidebar' | 'mobile' | 'icon' | 'headless'; onClose?: () => void }) {
  const profile    = useUserStore((s) => s.profile)
  const setProfile = useUserStore((s) => s.setProfile)
  const [open, setOpen]           = useState(variant === 'headless')
  // 'headless' mở ngay lúc mount nên không đi qua handleOpen — seed từ profile.
  const [fullName, setFullName]   = useState(profile?.full_name ?? '')
  const [phone, setPhone]         = useState(profile?.phone_number ?? '')
  const [clientErr, setClientErr] = useState('')
  const [pending, startTransition] = useTransition()

  function handleOpen() {
    setFullName(profile?.full_name ?? '')
    setPhone(profile?.phone_number ?? '')
    setClientErr('')
    setOpen(true)
  }

  function handleClose() {
    setOpen(false)
    onClose?.()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setClientErr('')
    if (!fullName.trim()) { setClientErr('Vui lòng nhập họ tên'); return }
    startTransition(async () => {
      const result = await updateOwnProfile({ full_name: fullName, phone_number: phone })
      if (result?.error) {
        setClientErr(result.error)
      } else {
        if (profile) {
          setProfile({ ...profile, full_name: result.full_name ?? fullName, phone_number: result.phone_number ?? null })
        }
        toast.success('Đã cập nhật thông tin')
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
          aria-label="Sửa thông tin"
          className="w-10 h-10 px-0 text-white/80 hover:bg-white/10 hover:text-white"
          onClick={handleOpen}
        >
          <UserCog className="h-4 w-4" />
        </Button>
      ) : variant === 'icon' ? (
        <Button
          variant="outline"
          size="sm"
          aria-label="Sửa thông tin"
          className="h-[36px] w-[36px] px-0"
          onClick={handleOpen}
        >
          <UserCog className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <button
          type="button"
          onClick={handleOpen}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-sidebar-accent rounded transition-colors"
        >
          <UserCog className="h-4 w-4 shrink-0" />
          Sửa thông tin
        </button>
      )}

      {/* M1.1 (audit P2#3): dùng primitive Dialog (base-ui) thay overlay tự dựng
          `fixed inset-0`. Được luôn focus trap · aria-modal · Escape · trả focus
          về trigger · portal ra body — bản cũ thiếu tất cả, và vì không portal
          nên khi mở TỪ TRONG account sheet nó bị bám vào containing block của
          sheet. Nội dung form giữ nguyên từng dòng. */}
      <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose() }}>
        <DialogContent className="gap-3">
          <DialogTitle>Sửa thông tin cá nhân</DialogTitle>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Họ tên</label>
              <Input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Họ và tên"
                /* 16px trên mobile: dưới ngưỡng đó iOS Safari tự zoom khi focus. */
                className="h-9 text-[16px] md:text-sm"
                autoComplete="name"
                maxLength={100}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Số điện thoại (tuỳ chọn)</label>
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="vd 0901234567"
                className="h-9 text-[16px] md:text-sm"
                autoComplete="tel"
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
                {pending ? 'Đang lưu...' : 'Lưu thông tin'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
