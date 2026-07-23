'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { createUser } from '@/app/actions/users'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SearchableSelect } from '@/components/ui/searchable-select'
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

interface Department { id: string; name: string; color: string }

export function CreateUserDialog({ stores, departments = [] }: {
  stores: Pick<Store, 'id' | 'name'>[]
  departments?: Department[]
}) {
  const profile  = useUserStore((s) => s.profile)
  const isSuper  = isSuperAdminEmail(profile?.email)
  const isSm     = profile?.role === 'sm'
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  // SM: staff only. Sub-admins: store_manager only. Super admin: any role.
  const [role, setRole]       = useState(isSm ? 'staff' : isSuper ? 'staff' : 'store_manager')
  const [storeId, setStoreId] = useState('')
  const [departmentId, setDepartmentId] = useState('')


  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    // SM profile may arrive from Zustand after initial render, so derive the
    // effective role at submit time rather than relying on initialised state.
    const effectiveRole = isSm ? 'staff' : role

    if (effectiveRole !== 'admin' && !storeId) {
      toast.error('Vui lòng chọn cửa hàng cho tài khoản này')
      return
    }

    const formData = new FormData(e.currentTarget)
    // Inject controlled values
    formData.set('role', effectiveRole)
    if (effectiveRole !== 'admin') formData.set('store_id', storeId)
    else formData.delete('store_id')
    if (departmentId) formData.set('department_id', departmentId)

    startTransition(async () => {
      const result = await createUser(formData)
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success('Tạo người dùng thành công')
        setOpen(false)
        setRole('staff')
        setStoreId('')
        setDepartmentId('')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" className="min-h-[44px] md:min-h-0" />}>
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
            {isSm ? (
              <p className="text-sm text-muted-foreground">Nhân viên (Staff)</p>
            ) : (
              <Select value={role} onValueChange={(v) => { if (v) { setRole(v); setStoreId('') } }}>
                <SelectTrigger>
                  <SelectValue>{ROLE_LABEL[role]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {isSuper && <SelectItem value="staff">Staff</SelectItem>}
                  <SelectItem value="store_manager">Store Manager</SelectItem>
                  {isSuper && <SelectItem value="admin">Admin</SelectItem>}
                </SelectContent>
              </Select>
            )}
          </div>
          {role !== 'admin' && (
            <div className="grid gap-1.5">
              <Label>Cửa hàng</Label>
              <SearchableSelect
                value={storeId}
                options={stores.map((s) => ({ value: s.id, label: s.name }))}
                onValueChange={(v) => { if (v) setStoreId(v) }}
                placeholder="Chọn cửa hàng"
              />
            </div>
          )}
          {/* Department label — super admin only (mirrors the server gate). */}
          {isSuper && !isSm && departments.length > 0 && (
            <div className="grid gap-1.5">
              <Label>Phòng ban (tùy chọn)</Label>
              <Select value={departmentId || '__none__'} onValueChange={(v) => { if (v) setDepartmentId(v === '__none__' ? '' : v) }}>
                <SelectTrigger>
                  <SelectValue>
                    {departmentId
                      ? (departments.find((d) => d.id === departmentId)?.name ?? '—')
                      : 'Không thuộc phòng ban'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Không thuộc phòng ban</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
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
