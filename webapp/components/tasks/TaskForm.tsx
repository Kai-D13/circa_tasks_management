'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createTask, updateTask, createBroadcastTask } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, X } from 'lucide-react'
import { TaskInputAttachments } from '@/components/tasks/TaskInputAttachments'
import {
  Task, Store, UserProfile, RequiredOutput, UserRole,
  TaskPriority, TaskVisibility, TaskCategory, TaskAttachment,
} from '@/types'

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
  public:  'Tất cả (public)',
  store:   'Cả store',
  private: 'Chỉ người được giao',
}
const CATEGORY_LABEL: Record<TaskCategory, string> = {
  training: 'Training',
  recall:   'Thu hồi / Kiểm kê',
  display:  'Trưng bày',
  audit:    'Kiểm tra',
  other:    'Khác',
}
const CATEGORY_DEFAULTS: Record<TaskCategory, {
  outputs: RequiredOutput[]; priority: TaskPriority; visibility: TaskVisibility
}> = {
  training: { outputs: ['text'],          priority: 'normal', visibility: 'store' },
  recall:   { outputs: ['text', 'image'], priority: 'urgent', visibility: 'store' },
  display:  { outputs: ['image'],         priority: 'normal', visibility: 'store' },
  audit:    { outputs: ['image', 'text'], priority: 'urgent', visibility: 'store' },
  other:    { outputs: [],               priority: 'normal', visibility: 'store' },
}

type Scope = 'single' | 'multi' | 'all'

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

  const [category, setCategory]   = useState<TaskCategory>(task?.category ?? 'other')
  const [storeId, setStoreId]     = useState(task?.store_id    ?? currentUserStoreId ?? '')
  const [assignedTo, setAssignedTo] = useState(task?.assigned_to ?? '')
  const [priority, setPriority]   = useState<TaskPriority>(task?.priority   ?? 'normal')
  const [visibility, setVisibility] = useState<TaskVisibility>(task?.visibility ?? 'private')
  const [outputs, setOutputs]     = useState<RequiredOutput[]>(task?.required_outputs ?? [])

  // Broadcast scope (admin + new task only)
  const [scope, setScope]               = useState<Scope>('single')
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([])

  // Input attachments + links
  const uploadIdRef = useRef(
    (task?.id) ?? crypto.randomUUID()
  )
  const existingInputData = task?.input_data as Record<string, unknown> | null
  const [attachments, setAttachments] = useState<TaskAttachment[]>(
    (existingInputData?.attachments as TaskAttachment[]) ?? []
  )
  const [links, setLinks] = useState<{ label: string; url: string }[]>(
    (existingInputData?.links as { label: string; url: string }[]) ?? []
  )

  function addLink() {
    setLinks((prev) => [...prev, { label: '', url: '' }])
  }
  function updateLink(i: number, field: 'label' | 'url', val: string) {
    setLinks((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: val } : l))
  }
  function removeLink(i: number) {
    setLinks((prev) => prev.filter((_, idx) => idx !== i))
  }

  const isAdmin       = currentUserRole === 'admin'
  const isBroadcast   = isAdmin && !task && scope !== 'single'

  const visibleStores = isAdmin ? stores : stores.filter((s) => s.id === currentUserStoreId)
  const storeUsers    = storeId ? users.filter((u) => u.store_id === storeId) : users

  const selectedStoreName = visibleStores.find((s) => s.id === storeId)?.name
  const selectedUserName  = users.find((u) => u.id === assignedTo)?.full_name

  const broadcastCount = scope === 'all'
    ? visibleStores.length
    : selectedStoreIds.length

  function handleCategoryChange(v: string | null) {
    if (!v) return
    const cat = v as TaskCategory
    setCategory(cat)
    if (!task) {
      const d = CATEGORY_DEFAULTS[cat]
      setOutputs(d.outputs)
      setPriority(d.priority)
      setVisibility(d.visibility)
    }
  }

  function handleScopeChange(v: string | null) {
    if (!v) return
    setScope(v as Scope)
    setSelectedStoreIds([])
  }

  function toggleStoreSelection(id: string) {
    setSelectedStoreIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    )
  }

  function handleStoreChange(v: string | null) {
    if (!v) return
    setStoreId(v)
    const stillValid = users.find((u) => u.id === assignedTo && u.store_id === v)
    if (!stillValid) setAssignedTo('')
  }

  function handleAssigneeChange(v: string | null) {
    const val = v ?? ''
    setAssignedTo(val)
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

    formData.set('category',   category)
    formData.set('priority',   priority)
    formData.set('visibility', visibility)
    formData.delete('required_outputs')
    outputs.forEach((o) => formData.append('required_outputs', o))

    // Broadcast path — admin + new task + multi/all scope
    if (isBroadcast) {
      const storeIds = scope === 'all' ? visibleStores.map((s) => s.id) : selectedStoreIds
      if (!storeIds.length) {
        toast.error('Vui lòng chọn ít nhất một cửa hàng')
        return
      }
      startTransition(async () => {
        const result = await createBroadcastTask({
          title:           formData.get('title') as string,
          description:     (formData.get('description') as string) || '',
          category,
          priority,
          visibility,
          storeIds,
          startDate:       (formData.get('start_date') as string) || null,
          deadline:        (formData.get('deadline') as string) || null,
          requiredOutputs: outputs,
          attachments,
          links: links.filter((l) => l.url.trim()),
        })
        if (result?.error) toast.error(result.error)
      })
      return
    }

    // Single-store path
    formData.set('store_id',    storeId)
    formData.set('assigned_to', assignedTo)
    formData.set('input_attachments', JSON.stringify(attachments))
    formData.set('input_links',       JSON.stringify(links.filter((l) => l.url.trim())))

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
        {/* Category */}
        <div className="grid gap-1.5">
          <Label>Loại task</Label>
          <Select value={category} onValueChange={handleCategoryChange}>
            <SelectTrigger>
              <SelectValue>{CATEGORY_LABEL[category]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CATEGORY_LABEL) as TaskCategory[]).map((c) => (
                <SelectItem key={c} value={c}>{CATEGORY_LABEL[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Scope selector — admin + new task only */}
        {isAdmin && !task && (
          <div className="grid gap-1.5">
            <Label>Phạm vi giao task</Label>
            <Select value={scope} onValueChange={handleScopeChange}>
              <SelectTrigger>
                <SelectValue>
                  {scope === 'single' ? 'Một cửa hàng' : scope === 'multi' ? 'Nhiều cửa hàng' : 'Tất cả cửa hàng'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single">Một cửa hàng</SelectItem>
                <SelectItem value="multi">Nhiều cửa hàng</SelectItem>
                <SelectItem value="all">Tất cả cửa hàng ({visibleStores.length})</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
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

      {/* Store section — changes based on scope */}
      {isBroadcast ? (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <Label>Cửa hàng nhận task</Label>
            {broadcastCount > 0 && (
              <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">
                Sẽ tạo {broadcastCount} task cho {broadcastCount} cửa hàng
              </span>
            )}
          </div>
          {scope === 'all' ? (
            <div className="rounded-md border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
              Tất cả {visibleStores.length} cửa hàng sẽ nhận task này
            </div>
          ) : (
            <div className="rounded-md border max-h-48 overflow-y-auto divide-y">
              {visibleStores.map((s) => (
                <label key={s.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedStoreIds.includes(s.id)}
                    onChange={() => toggleStoreSelection(s.id)}
                    className="accent-primary h-4 w-4 shrink-0"
                  />
                  {s.name}
                </label>
              ))}
            </div>
          )}
        </div>
      ) : (
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
      )}

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

      {/* Input attachments — images / PDFs attached to the task itself */}
      <div className="grid gap-1.5">
        <Label>Tài liệu đính kèm cho task</Label>
        <p className="text-xs text-muted-foreground">
          Ảnh hướng dẫn, file Excel, PDF... staff sẽ thấy khi xem task.
        </p>
        <TaskInputAttachments
          uploadId={uploadIdRef.current}
          value={attachments}
          onChange={setAttachments}
        />
      </div>

      {/* Links */}
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label>Đường dẫn (Links)</Label>
          <Button type="button" variant="ghost" size="sm" onClick={addLink} className="h-7 text-xs gap-1 px-2">
            <Plus className="h-3 w-3" /> Thêm link
          </Button>
        </div>
        {links.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Link đăng ký, link meeting, link tài liệu...
          </p>
        )}
        {links.map((link, i) => (
          <div key={i} className="grid grid-cols-[1fr_1.5fr_auto] gap-2">
            <Input
              placeholder="Nhãn (vd: Link đăng ký)"
              value={link.label}
              onChange={(e) => updateLink(i, 'label', e.target.value)}
            />
            <Input
              placeholder="https://..."
              type="url"
              value={link.url}
              onChange={(e) => updateLink(i, 'url', e.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => removeLink(i)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={pending}>
          {pending
            ? 'Đang lưu...'
            : isBroadcast
              ? `Tạo ${broadcastCount > 0 ? broadcastCount : ''} Task${broadcastCount > 1 ? 's' : ''}`
              : task ? 'Cập nhật' : 'Tạo Task'}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Huỷ
        </Button>
      </div>
    </form>
  )
}
