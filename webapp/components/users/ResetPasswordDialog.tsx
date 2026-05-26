'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { resetUserPassword } from '@/app/actions/users'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog'
import { KeyRound } from 'lucide-react'

interface Props {
  userId:   string
  userName: string
}

export function ResetPasswordDialog({ userId, userName }: Props) {
  const [open, setOpen]           = useState(false)
  const [pending, startTransition] = useTransition()
  const [password, setPassword]   = useState('')
  const [confirm, setConfirm]     = useState('')
  const [clientError, setClientError] = useState<string | null>(null)

  function handleOpen(next: boolean) {
    if (next) {
      setPassword('')
      setConfirm('')
      setClientError(null)
    }
    setOpen(next)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setClientError(null)

    if (password.length < 8) {
      setClientError('Mật khẩu phải có ít nhất 8 ký tự')
      return
    }
    if (password !== confirm) {
      setClientError('Mật khẩu xác nhận không khớp')
      return
    }

    startTransition(async () => {
      const result = await resetUserPassword(userId, password)
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success('Đã đặt lại mật khẩu thành công')
        setOpen(false)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" className="h-7 px-2" />}>
        <KeyRound className="h-3.5 w-3.5" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Đặt lại mật khẩu: {userName}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="new_password">Mật khẩu mới *</Label>
            <Input
              id="new_password"
              type="password"
              required
              minLength={8}
              placeholder="Ít nhất 8 ký tự"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setClientError(null) }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="confirm_password">Xác nhận mật khẩu *</Label>
            <Input
              id="confirm_password"
              type="password"
              required
              placeholder="Nhập lại mật khẩu"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setClientError(null) }}
            />
          </div>
          {clientError && (
            <p className="text-sm text-destructive">{clientError}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Huỷ</Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Đang đặt lại...' : 'Xác nhận'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
