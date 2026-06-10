'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { updateStaffAllInstruction } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog'
import { TaskInputAttachments } from '@/components/tasks/TaskInputAttachments'
import { TaskAttachment, TaskCategory, TaskPriority } from '@/types'
import { Pencil, X, Plus, Info } from 'lucide-react'

const CATEGORY_OPTIONS: { value: TaskCategory; label: string }[] = [
  { value: 'training', label: 'Training' },
  { value: 'recall',   label: 'Thu hồi / Kiểm kê' },
  { value: 'display',  label: 'Trưng bày' },
  { value: 'audit',    label: 'Kiểm tra' },
  { value: 'other',    label: 'Khác' },
]
const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'urgent', label: 'Khẩn cấp' },
  { value: 'normal', label: 'Bình thường' },
]
const CATEGORY_LABEL = Object.fromEntries(CATEGORY_OPTIONS.map((o) => [o.value, o.label]))
const PRIORITY_LABEL = Object.fromEntries(PRIORITY_OPTIONS.map((o) => [o.value, o.label]))

interface Props {
  taskId:      string
  isBroadcast: boolean
  defaults: {
    title:       string
    description: string | null
    category:    TaskCategory
    priority:    TaskPriority
    attachments: TaskAttachment[]
    links:       { label: string; url: string }[]
  }
}

export function EditStaffAllInstructionDialog({ taskId, isBroadcast, defaults }: Props) {
  const router = useRouter()
  const [open, setOpen]       = useState(false)
  const [pending, startTransition] = useTransition()

  const [title, setTitle]             = useState(defaults.title)
  const [description, setDescription] = useState(defaults.description ?? '')
  const [category, setCategory]       = useState<TaskCategory>(defaults.category)
  const [priority, setPriority]       = useState<TaskPriority>(defaults.priority)
  const [attachments, setAttachments] = useState<TaskAttachment[]>(defaults.attachments ?? [])
  const [links, setLinks]             = useState<{ label: string; url: string }[]>(defaults.links ?? [])
  // Stable upload prefix for this dialog instance.
  const uploadId = useRef(`staffall-${taskId}`).current

  function reset() {
    setTitle(defaults.title)
    setDescription(defaults.description ?? '')
    setCategory(defaults.category)
    setPriority(defaults.priority)
    setAttachments(defaults.attachments ?? [])
    setLinks(defaults.links ?? [])
  }

  function handleOpen(next: boolean) {
    if (next) reset()
    setOpen(next)
  }

  function addLink() { setLinks((prev) => [...prev, { label: '', url: '' }]) }
  function updateLink(i: number, field: 'label' | 'url', val: string) {
    setLinks((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: val } : l)))
  }
  function removeLink(i: number) { setLinks((prev) => prev.filter((_, idx) => idx !== i)) }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) { toast.error('Vui lòng nhập tiêu đề'); return }
    startTransition(async () => {
      const r = await updateStaffAllInstruction(taskId, {
        title:       title.trim(),
        description: description.trim() || null,
        category,
        priority,
        attachments,
        links: links.filter((l) => l.url.trim()),
      })
      if (r?.error) { toast.error(r.error); return }
      toast.success(`Đã cập nhật hướng dẫn cho ${(r as { count?: number }).count ?? ''} task`.trim())
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Pencil className="h-4 w-4 mr-1" /> Chỉnh sửa hướng dẫn
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Chỉnh sửa hướng dẫn (toàn bộ dược sĩ)</DialogTitle>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Thay đổi áp dụng cho <strong>toàn bộ dược sĩ</strong> của task này
            {isBroadcast ? ' (mọi cửa hàng)' : ''}, kể cả task đã hoàn thành. Không thay đổi
            trạng thái, deadline hay loại kết quả yêu cầu.
          </span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-1.5">
            <Label>Tiêu đề</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tiêu đề task" />
          </div>

          <div className="grid gap-1.5">
            <Label>Mô tả / hướng dẫn</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Nội dung hướng dẫn cho dược sĩ..."
              className="min-h-[100px]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Phân loại</Label>
              <Select value={category} onValueChange={(v) => { if (v) setCategory(v as TaskCategory) }}>
                <SelectTrigger>
                  <SelectValue>{CATEGORY_LABEL[category]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Ưu tiên</Label>
              <Select value={priority} onValueChange={(v) => { if (v) setPriority(v as TaskPriority) }}>
                <SelectTrigger>
                  <SelectValue>{PRIORITY_LABEL[priority]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>File đính kèm (ảnh, PDF, Excel, audio...)</Label>
            <TaskInputAttachments uploadId={uploadId} value={attachments} onChange={setAttachments} />
          </div>

          <div className="grid gap-1.5">
            <Label>Link tham khảo</Label>
            {links.map((link, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.5fr_auto] gap-2">
                <Input placeholder="Nhãn" value={link.label} onChange={(e) => updateLink(i, 'label', e.target.value)} className="h-8 text-sm" />
                <Input placeholder="https://..." type="url" value={link.url} onChange={(e) => updateLink(i, 'url', e.target.value)} className="h-8 text-sm" />
                <button type="button" aria-label="Xoá link" onClick={() => removeLink(i)} className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-destructive">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" onClick={addLink} className="h-7 text-xs gap-1 px-2 w-fit">
              <Plus className="h-3 w-3" /> Thêm link
            </Button>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Huỷ</Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Đang lưu...' : 'Áp dụng cho toàn bộ'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
