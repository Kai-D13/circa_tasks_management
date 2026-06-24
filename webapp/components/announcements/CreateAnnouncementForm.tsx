'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { RichTextEditor } from '@/components/tasks/RichTextEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createAnnouncement } from '@/app/actions/announcements'
import { cn } from '@/lib/utils'

export function CreateAnnouncementForm({ stores }: { stores: { id: string; name: string }[] }) {
  const router = useRouter()
  const [title, setTitle]           = useState('')
  const [body, setBody]             = useState('')
  const [visibility, setVisibility] = useState<'all' | 'stores'>('all')
  const [storeIds, setStoreIds]     = useState<Set<string>>(new Set())
  const [pending, start]            = useTransition()

  function toggleStore(id: string) {
    setStoreIds((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  function submit() {
    if (!title.trim()) { toast.error('Vui lòng nhập tiêu đề'); return }
    if (visibility === 'stores' && storeIds.size === 0) { toast.error('Chọn ít nhất một cửa hàng'); return }
    start(async () => {
      const r = await createAnnouncement({ title, body, visibility, storeIds: [...storeIds] })
      if ('error' in r) { toast.error(r.error); return }
      toast.success('Đã tạo thông báo')
      router.push('/announcements')
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">Tiêu đề</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tiêu đề thông báo" className="mt-1" />
      </div>

      <div>
        <label className="text-sm font-medium">Nội dung</label>
        <div className="mt-1 rounded-md border">
          <RichTextEditor value={body} onChange={setBody} />
        </div>
      </div>

      <div>
        <label className="text-sm font-medium">Gửi cho</label>
        <div className="mt-1 flex rounded-[4px] border overflow-hidden w-fit">
          {([['all', 'Tất cả'], ['stores', 'Chọn cửa hàng']] as const).map(([v, l]) => (
            <button
              key={v}
              type="button"
              onClick={() => setVisibility(v)}
              className={cn('px-3 py-1.5 text-sm font-medium', visibility === v ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted')}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {visibility === 'stores' && (
        <div className="rounded border max-h-56 overflow-y-auto divide-y">
          {stores.map((s) => (
            <label key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50">
              <input
                type="checkbox"
                checked={storeIds.has(s.id)}
                onChange={() => toggleStore(s.id)}
                className="accent-primary h-4 w-4 shrink-0"
              />
              {s.name}
            </label>
          ))}
          {stores.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Chưa có cửa hàng.</p>}
        </div>
      )}

      <Button onClick={submit} disabled={pending}>
        {pending ? 'Đang tạo...' : 'Tạo thông báo'}
      </Button>
    </div>
  )
}
