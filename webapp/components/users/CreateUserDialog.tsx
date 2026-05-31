'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { createUser } from '@/app/actions/users'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog'
import { Store } from '@/types'
import { UserPlus } from 'lucide-react'
import { useUserStore } from '@/store/userStore'
import { isSuperAdminEmail } from '@/lib/authz'

const ROLE_LABEL: Record<string, string> = {
  staff:         'Staff',
  store_manager: 'Store Manager',
  admin:         'Admin',
}

export function CreateUserDialog({ stores }: { stores: Pick<Store, 'id' | 'name'>[] }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [role, setRole]       = useState('staff')
  const [storeId, setStoreId] = useState('')
  const canCreateAdmin = isSuperAdminEmail(useUserStore((s) => s.profile)?.email)

  const selectedStoreName = stores.find((s) => s.id === storeId)?.name

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    if (role !== 'admin' && !storeId) {
      toast.error('Vui lòng chọn cửa hàng cho tài khoản này')
      return
    }

    const formData = new FormData(e.currentTarget)
    // Inject controlled values
    formData.set('role', role)
    if (role !== 'admin') formData.set('store_id', storeId)
    else formData.delete('store_id')

    startTransition(async () => {
      const result = await createUser(formData)
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success('Tạo người dùng thành công')
        setOpen(false)
        setRole('staff')
        setStoreId('')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <UserPlus className="h-4 w-4 mr-1" />
        Thêm người dùng
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tạo người dùng mới</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="full_name">Họ và tên *</Label>
            <Input id="full_name" name="full_name" required placeholder="Nguyễn Văn A" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="email">Email *</Label>
            <Input id="email" name="email" type="email" required placeholder="user@example.com" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">Mật khẩu tạm *</Label>
            <Input id="password" name="password" type="password" required minLength={8} placeholder="Ít nhất 8 ký tự" />
          </div>
          <div className="grid gap-1.5">
            <Label>Phân quyền *</Label>
            <Select value={role} onValueChange={(v) => { if (v) { setRole(v); setStoreId('') } }}>
              <SelectTrigger>
                <SelectValue>{ROLE_LABEL[role]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="staff">Staff</SelectItem>
                <SelectItem value="store_manager">Store Manager</SelectItem>
                {canCreateAdmin && <SelectItem value="admin">Admin</SelectItem>}
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
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Huỷ
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Đang tạo...' : 'Tạo người dùng'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
