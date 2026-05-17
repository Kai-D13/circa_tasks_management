'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { reassignTask } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { UserProfile } from '@/types'

interface Props {
  taskId: string
  currentAssignedTo: string | null
  storeUsers: Pick<UserProfile, 'id' | 'full_name' | 'role'>[]
}

const ROLE_LABEL: Record<string, string> = {
  staff:         'staff',
  store_manager: 'manager',
  admin:         'admin',
}

export function TaskReassignForm({ taskId, currentAssignedTo, storeUsers }: Props) {
  const [pending, startTransition] = useTransition()
  const [assignedTo, setAssignedTo] = useState(currentAssignedTo ?? '')

  const selectedName = storeUsers.find((u) => u.id === assignedTo)?.full_name

  function handleSave() {
    startTransition(async () => {
      const result = await reassignTask(taskId, assignedTo || null)
      if (result?.error) toast.error(result.error)
      else toast.success('Đã cập nhật phân công')
    })
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={assignedTo} onValueChange={(v) => setAssignedTo(v ?? '')}>
        <SelectTrigger className="w-52">
          <SelectValue>
            {selectedName ?? <span className="text-muted-foreground">Chưa phân công</span>}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">Chưa phân công</SelectItem>
          {storeUsers.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.full_name}
              <span className="ml-1 text-xs text-muted-foreground">({ROLE_LABEL[u.role] ?? u.role})</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        onClick={handleSave}
        disabled={pending || assignedTo === (currentAssignedTo ?? '')}
      >
        {pending ? 'Đang lưu...' : 'Lưu'}
      </Button>
    </div>
  )
}
