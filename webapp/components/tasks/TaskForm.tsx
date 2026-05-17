'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createTask, updateTask } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Task, Store, UserProfile, RequiredOutput, UserRole, TaskPriority, TaskVisibility } from '@/types'

const OUTPUT_OPTIONS: { value: RequiredOutput; label: string }[] = [
  { value: 'text',  label: 'Ghi chú văn bản' },
  { value: 'image', label: 'Ảnh' },
  { value: 'video', label: 'Video' },
  { value: 'file',  label: 'File đính kèm' },
]

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Khẩn cấp',
  normal: 'Bình thường',
}
const VISIBILITY_LABEL: Record<TaskVisibility, string> = {
  public: 'Tất cả (public)',
  store:  'Cả store',
  private: 'Chỉ người được giao',
}

interface Props {
  stores: Pick<Store, 'id' | 'name'>[]
  users: Pick<UserProfile, 'id' | 'full_name' | 'email' | 'store_id' | 'role'>[]
  currentUserRole: UserRole
  currentUserStoreId: string | null
  task?: Task
}

export function TaskForm({ stores, users, currentUserRole, currentUserStoreId, task }: Props) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  // Fully controlled selects (fix: base-ui SelectValue won't auto-show text from portal items)
  const [storeId, setStoreId]       = useState(task?.store_id    ?? currentUserStoreId ?? '')
  const [assignedTo, setAssignedTo] = useState(task?.assigned_to ?? '')
  const [priority, setPriority]     = useState<TaskPriority>(task?.priority   ?? 'normal')
  const [visibility, setVisibility] = useState<TaskVisibility>(task?.visibility ?? 'private')
  const [outputs, setOutputs]       = useState<RequiredOutput[]>(task?.required_outputs ?? [])

  const visibleStores = currentUserRole === 'admin'
    ? stores
    : stores.filter((s) => s.id === currentUserStoreId)

  // Only show users belonging to the currently-selected store
  const storeUsers = storeId
    ? users.filter((u) => u.store_id === storeId)
    : users

  const selectedStoreName = visibleStores.find((s) => s.id === storeId)?.name
  const selectedUserName  = users.find((u) => u.id === assignedTo)?.full_name

  function handleStoreChange(v: string | null) {
    if (!v) return
    setStoreId(v)
    // Clear assignee if they don't belong to the new store
    const stillValid = users.find((u) => u.id === assignedTo && u.store_id === v)
    if (!stillValid) setAssignedTo('')
  }

  function handleAssigneeChange(v: string | null) {
    const val = v ?? ''
    setAssignedTo(val)
    // When assigning to a specific person, default visibility to private
    if (val) setVisibility('private')
    else     setVisibility('store')
  }

  function toggleOutput(val: RequiredOutput) {
    setOutputs((prev) =>
      prev.includes(val) ? prev.filter((o) => o !== val) : [...prev, val]
    )
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)

    // Inject controlled-select values (base-ui hidden inputs may lag)
    formData.set('store_id',    storeId)
    formData.set('assigned_to', assignedTo)
    formData.set('priority',    priority)
    formData.set('visibility',  visibility)
    formData.delete('required_outputs')
    outputs.forEach((o) => formData.append('required_outputs', o))

    startTransition(async () => {
      const result = task
        ? await updateTask(task.id, formData)
        : await createTask(formData)
      if (result?.error) toast.error(result.error)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Title */}
      <div className="grid gap-1.5">
        <Label htmlFor="title">Tiêu đề *</Label>
        <Input id="title" name="title" defaultValue={task?.title} required placeholder="Nhập tiêu đề task" />
      </div>

      {/* Description */}
      <div className="grid gap-1.5">
        <Label htmlFor="description">Mô tả</Label>
        <Textarea id="description" name="description" defaultValue={task?.description ?? ''} rows={4} placeholder="Nội dung chi tiết..." />
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Priority */}
        <div className="grid gap-1.5">
          <Label>Độ ưu tiên</Label>
          <Select value={priority} onValueChange={(v) => { if (v) setPriority(v as TaskPriority) }}>
            <SelectTrigger>
              <SelectValue>{PRIORITY_LABEL[priority]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">Bình thường</SelectItem>
              <SelectItem value="urgent">Khẩn cấp</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Visibility */}
        <div className="grid gap-1.5">
          <Label>Ai thấy task này?</Label>
          <Select value={visibility} onValueChange={(v) => { if (v) setVisibility(v as TaskVisibility) }}>
            <SelectTrigger>
              <SelectValue>{VISIBILITY_LABEL[visibility]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">Chỉ người được giao</SelectItem>
              <SelectItem value="store">Cả store (manager + staff)</SelectItem>
              <SelectItem value="public">Tất cả (public)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Store */}
        <div className="grid gap-1.5">
          <Label>Store</Label>
          <Select value={storeId} onValueChange={handleStoreChange}>
            <SelectTrigger>
              <SelectValue>
                {selectedStoreName ?? <span className="text-muted-foreground">Chọn store</span>}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {visibleStores.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Assign To */}
        <div className="grid gap-1.5">
          <Label>Giao cho</Label>
          <Select value={assignedTo} onValueChange={handleAssigneeChange}>
            <SelectTrigger>
              <SelectValue>
                {selectedUserName ?? <span className="text-muted-foreground">Chưa phân công</span>}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Chưa phân công</SelectItem>
              {storeUsers.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.full_name}
                  <span className="ml-1 text-xs text-muted-foreground">({u.role.replace('_', ' ')})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Start Date */}
        <div className="grid gap-1.5">
          <Label htmlFor="start_date">Ngày bắt đầu</Label>
          <Input
            id="start_date"
            name="start_date"
            type="datetime-local"
            defaultValue={task?.start_date ? new Date(task.start_date).toISOString().slice(0, 16) : ''}
          />
        </div>

        {/* Deadline */}
        <div className="grid gap-1.5">
          <Label htmlFor="deadline">Deadline</Label>
          <Input
            id="deadline"
            name="deadline"
            type="datetime-local"
            defaultValue={task?.deadline ? new Date(task.deadline).toISOString().slice(0, 16) : ''}
          />
        </div>
      </div>

      {/* Required Outputs */}
      <div className="grid gap-2">
        <Label>Output cần nộp</Label>
        <div className="flex flex-wrap gap-3">
          {OUTPUT_OPTIONS.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={outputs.includes(value)}
                onChange={() => toggleOutput(value)}
                className="accent-primary h-4 w-4"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Đang lưu...' : task ? 'Cập nhật' : 'Tạo Task'}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Huỷ
        </Button>
      </div>
    </form>
  )
}
