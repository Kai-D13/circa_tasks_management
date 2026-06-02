'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Share2, X } from 'lucide-react'
import { shareTask, updateCollaboratorPermission, removeCollaborator } from '@/app/actions/collaborators'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SearchableSelect } from '@/components/ui/searchable-select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'

export interface CollaboratorRow {
  admin_id:   string
  permission: 'view' | 'editor'
  users: { full_name: string } | null
}

interface Props {
  taskId:        string
  collaborators: CollaboratorRow[]
  adminOptions:  { value: string; label: string; description?: string }[]
}

const PERMISSION_LABEL: Record<string, string> = {
  view:   'Xem',
  editor: 'Biên tập',
}

export function ShareTaskDialog({ taskId, collaborators, adminOptions }: Props) {
  const [open, setOpen]             = useState(false)
  const [adminId, setAdminId]       = useState('')
  const [permission, setPermission] = useState<'view' | 'editor'>('view')
  const [pending, startTransition]  = useTransition()

  // Filter out admins who are already collaborators
  const alreadyShared = new Set(collaborators.map((c) => c.admin_id))
  const availableAdmins = adminOptions.filter((o) => !alreadyShared.has(o.value))

  function handleShare() {
    if (!adminId) return
    startTransition(async () => {
      const result = await shareTask(taskId, adminId, permission)
      if ('error' in result) { toast.error(result.error); return }
      toast.success('Đã chia sẻ task')
      setAdminId('')
      setPermission('view')
    })
  }

  function handleUpdatePermission(aid: string, perm: 'view' | 'editor') {
    startTransition(async () => {
      const result = await updateCollaboratorPermission(taskId, aid, perm)
      if ('error' in result) toast.error(result.error)
    })
  }

  function handleRemove(aid: string) {
    startTransition(async () => {
      const result = await removeCollaborator(taskId, aid)
      if ('error' in result) toast.error(result.error)
      else toast.success('Đã xoá quyền truy cập')
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Share2 className="h-4 w-4 mr-1" /> Chia sẻ
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Chia sẻ task</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
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
              {/* Permission toggle */}
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
                  {/* Inline permission toggle */}
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
                  <Badge
                    variant="outline"
                    className="shrink-0 text-xs hidden"
                    aria-hidden
                  >
                    {PERMISSION_LABEL[c.permission]}
                  </Badge>
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
