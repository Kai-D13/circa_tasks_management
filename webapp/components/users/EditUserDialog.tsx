'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { updateUserRole } from '@/app/actions/users'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog'
import { Store } from '@/types'
import { Pencil } from 'lucide-react'
import { useUserStore } from '@/store/userStore'
import { isSuperAdminEmail } from '@/lib/authz'

const ROLE_LABEL: Record<string, string> = {
  staff:         'Nhân viên',
  store_manager: 'Quản lý',
  admin:         'Admin',
}

interface Props {
  userId:        string
  userName:      string
  currentRole:   string
  currentStoreId: string | null
  stores:        Pick<Store, 'id' | 'name'>[]
}

export function EditUserDialog({ userId, userName, currentRole, currentStoreId, stores }: Props) {
  const [open, setOpen]       = useState(false)
  const [pending, startTransition] = useTransition()
  const [role, setRole]       = useState(currentRole)
  const [storeId, setStoreId] = useState(currentStoreId ?? '')
  // Only super admin may assign the admin role; keep the option if the target is already admin
  const showAdminOption = isSuperAdminEmail(useUserStore((s) => s.profile)?.email) || currentRole === 'admin'

  function handleOpen(next: boolean) {
    if (next) {
      setRole(currentRole)
      setStoreId(currentStoreId ?? '')
    }
    setOpen(next)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (role !== 'admin' && !storeId) {
      toast.error('Vui lòng chọn cửa hàng cho tài khoản này')
      return
    }

    const store = role !== 'admin' ? (storeId || null) : null
    startTransition(async () => {
      const result = await updateUserRole(userId, role, store)
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success('Đã cập nhật thông tin')
        setOpen(false)
      }
    })
  }

  const selectedStoreName = stores.find((s) => s.id === storeId)?.name

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" className="h-7 px-2" />}>
        <Pencil className="h-3.5 w-3.5" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Chỉnh sửa: {userName}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-1.5">
            <Label>Phân quyền</Label>
            <Select value={role} onValueChange={(v) => { if (v) { setRole(v); setStoreId('') } }}>
              <SelectTrigger>
                <SelectValue>{ROLE_LABEL[role] ?? role}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="staff">Nhân viên</SelectItem>
                <SelectItem value="store_manager">Quản lý</SelectItem>
                {showAdminOption && <SelectItem value="admin">Admin</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          {role !== 'admin' && (
            <div className="grid gap-1.5">
              <Label>Cửa hàng</Label>
              <Select value={storeId} onValueChange={(v) => { if (v) setStoreId(v) }}>
                <SelectTrigger>
                  <SelectValue>
                    {selectedStoreName ?? <span className="text-muted-foreground">Chọn cửa hàng</span>}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {stores.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Huỷ</Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Đang lưu...' : 'Lưu thay đổi'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
