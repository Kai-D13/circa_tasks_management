'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { updateUserRole, getSmStores, setSmStores } from '@/app/actions/users'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SearchableSelect } from '@/components/ui/searchable-select'
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
  sm:            'SM (đa cửa hàng)',
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
  // SM scope: a set of store IDs (sm_store_assignments). Loaded on open.
  const [smStoreIds, setSmStoreIds] = useState<string[]>([])
  const [smLoading, setSmLoading]   = useState(false)
  const isSuper = isSuperAdminEmail(useUserStore((s) => s.profile)?.email)
  // Only super admin may assign admin/SM; keep the option if the target already has it
  const showAdminOption = isSuper || currentRole === 'admin'
  const showSmOption    = isSuper || currentRole === 'sm'

  // Load the SM's current store assignments whenever the dialog shows the SM form.
  useEffect(() => {
    if (open && role === 'sm') {
      setSmLoading(true)
      getSmStores(userId)
        .then((ids) => setSmStoreIds(ids))
        .finally(() => setSmLoading(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role, userId])

  function handleOpen(next: boolean) {
    if (next) {
      setRole(currentRole)
      setStoreId(currentStoreId ?? '')
      setSmStoreIds([])
    }
    setOpen(next)
  }

  function toggleSmStore(id: string) {
    setSmStoreIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (role === 'sm') {
      if (smStoreIds.length === 0) {
        toast.error('Chọn ít nhất 1 cửa hàng cho tài khoản SM')
        return
      }
      startTransition(async () => {
        const r1 = await updateUserRole(userId, 'sm', null)
        if (r1?.error) { toast.error(r1.error); return }
        const r2 = await setSmStores(userId, smStoreIds)
        if (r2?.error) { toast.error(r2.error); return }
        toast.success('Đã cập nhật SM và cửa hàng quản lý')
        setOpen(false)
      })
      return
    }

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
            <Select value={role} onValueChange={(v) => { if (v) { setRole(v); setStoreId(''); setSmStoreIds([]) } }}>
              <SelectTrigger>
                <SelectValue>{ROLE_LABEL[role] ?? role}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="staff">Nhân viên</SelectItem>
                <SelectItem value="store_manager">Quản lý</SelectItem>
                {showSmOption && <SelectItem value="sm">SM (đa cửa hàng)</SelectItem>}
                {showAdminOption && <SelectItem value="admin">Admin</SelectItem>}
              </SelectContent>
            </Select>
          </div>

          {/* SM: multi-store assignment */}
          {role === 'sm' ? (
            <div className="grid gap-1.5">
              <Label>Cửa hàng quản lý {smStoreIds.length > 0 && `(${smStoreIds.length})`}</Label>
              {smLoading ? (
                <p className="text-sm text-muted-foreground">Đang tải...</p>
              ) : (
                <div className="max-h-52 overflow-y-auto rounded-md border divide-y">
                  {stores.length === 0 && (
                    <p className="text-sm text-muted-foreground p-2">Chưa có cửa hàng nào</p>
                  )}
                  {stores.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={smStoreIds.includes(s.id)}
                        onChange={() => toggleSmStore(s.id)}
                      />
                      <span>{s.name}</span>
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">SM chỉ thấy/quản lý task, nhân viên của các cửa hàng được chọn.</p>
            </div>
          ) : role !== 'admin' ? (
            <div className="grid gap-1.5">
              <Label>Cửa hàng</Label>
              <SearchableSelect
                value={storeId}
                options={stores.map((s) => ({ value: s.id, label: s.name }))}
                onValueChange={(v) => { if (v) setStoreId(v) }}
                placeholder="Chọn cửa hàng"
              />
            </div>
          ) : null}

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
