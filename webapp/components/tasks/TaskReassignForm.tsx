'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { reassignTask } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { SearchableSelect } from '@/components/ui/searchable-select'
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

  const assigneeOptions = [
    { value: '', label: 'Chưa phân công' },
    ...storeUsers.map((u) => ({ value: u.id, label: u.full_name, description: ROLE_LABEL[u.role] ?? u.role })),
  ]

  function handleSave() {
    startTransition(async () => {
      const result = await reassignTask(taskId, assignedTo || null)
      if (result?.error) toast.error(result.error)
      else toast.success('Đã cập nhật phân công')
    })
  }

  return (
    <div className="flex items-center gap-2">
      <SearchableSelect
        value={assignedTo}
        options={assigneeOptions}
        onValueChange={(v) => setAssignedTo(v ?? '')}
        placeholder="Chưa phân công"
        triggerClassName="w-52"
      />
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
