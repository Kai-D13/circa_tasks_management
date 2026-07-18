'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Share2, X } from 'lucide-react'
import {
  shareSchedule, updateScheduleCollaboratorPermission, removeScheduleCollaborator,
} from '@/app/actions/scheduleCollaborators'
import { Button } from '@/components/ui/button'
import { SearchableSelect } from '@/components/ui/searchable-select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'

export interface ScheduleCollaboratorRow {
  admin_id:   string
  permission: 'view' | 'editor'
  users: { full_name: string } | null
}

interface Props {
  scheduleId:    string
  collaborators: ScheduleCollaboratorRow[]
  adminOptions:  { value: string; label: string; description?: string }[]
}

const PERMISSION_LABEL: Record<string, string> = {
  view:   'Xem',
  editor: 'Biên tập',
}

export function ShareScheduleDialog({ scheduleId, collaborators, adminOptions }: Props) {
  const [open, setOpen]             = useState(false)
  const [adminId, setAdminId]       = useState('')
  const [permission, setPermission] = useState<'view' | 'editor'>('view')
  const [pending, startTransition]  = useTransition()

  const alreadyShared = new Set(collaborators.map((c) => c.admin_id))
  const availableAdmins = adminOptions.filter((o) => !alreadyShared.has(o.value))

  function handleShare() {
    if (!adminId) return
    startTransition(async () => {
      const result = await shareSchedule(scheduleId, adminId, permission)
      if ('error' in result) { toast.error(result.error); return }
      toast.success('Đã chia sẻ lịch định kỳ')
      setAdminId('')
      setPermission('view')
    })
  }

  function handleUpdatePermission(aid: string, perm: 'view' | 'editor') {
    startTransition(async () => {
      const result = await updateScheduleCollaboratorPermission(scheduleId, aid, perm)
      if ('error' in result) toast.error(result.error)
    })
  }

  function handleRemove(aid: string) {
    startTransition(async () => {
      const result = await removeScheduleCollaborator(scheduleId, aid)
      if ('error' in result) toast.error(result.error)
      else toast.success('Đã xoá quyền truy cập')
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="min-h-[44px] md:min-h-0" />}>
        <Share2 className="h-4 w-4 mr-1" /> Chia sẻ
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Chia sẻ lịch định kỳ</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Người được chia sẻ thấy lịch này và mọi task nó tạo ra (kể cả task đã tạo trước đó).
            Quyền Biên tập được tạm dừng/kích hoạt lịch.
          </p>

          {/* Add new collaborator */}
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Thêm người</p>
            <div className="flex gap-2">
              <SearchableSelect
                value={adminId}
                options={availableAdmins}
                onValueChange={setAdminId}
                placeholder="Chọn admin..."
                className="flex-1"
              />
              <div className="flex rounded-[4px] border overflow-hidden shrink-0">
                {(['view', 'editor'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPermission(p)}
                    className={
                      permission === p
                        ? 'bg-primary text-white text-xs px-2.5 py-1 font-medium'
                        : 'text-xs px-2.5 py-1 text-muted-foreground hover:bg-muted'
                    }
                  >
                    {PERMISSION_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
            <Button
              size="sm"
              onClick={handleShare}
              disabled={pending || !adminId}
              className="w-full"
            >
              {pending ? 'Đang chia sẻ...' : 'Chia sẻ'}
            </Button>
          </div>

          {/* Current collaborators */}
          {collaborators.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Đang chia sẻ ({collaborators.length})
              </p>
              {collaborators.map((c) => (
                <div key={c.admin_id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                  <span className="flex-1 text-sm truncate">
                    {c.users?.full_name ?? c.admin_id}
                  </span>
                  <div className="flex rounded-[4px] border overflow-hidden shrink-0">
                    {(['view', 'editor'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        disabled={pending}
                        onClick={() => c.permission !== p && handleUpdatePermission(c.admin_id, p)}
                        className={
                          c.permission === p
                            ? 'bg-primary text-white text-xs px-2 py-0.5 font-medium'
                            : 'text-xs px-2 py-0.5 text-muted-foreground hover:bg-muted disabled:opacity-50'
                        }
                      >
                        {PERMISSION_LABEL[p]}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => handleRemove(c.admin_id)}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                    aria-label="Xoá quyền"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {collaborators.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-2">
              Chưa chia sẻ với ai
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
