'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { MessageSquare, ChevronDown, ChevronRight, CheckCheck } from 'lucide-react'
import { formatDateTime } from '@/lib/dateUtils'

const STATUS_LABEL: Record<string, string> = {
  open:     'Chờ phản hồi',
  answered: 'Đã trả lời',
  resolved: 'Đã đóng',
}
const STATUS_COLOR: Record<string, string> = {
  open:     'bg-amber-100 text-amber-700',
  answered: 'bg-blue-100 text-blue-700',
  resolved: 'bg-gray-100 text-gray-500',
}

export interface FeedbackMessage {
  id:         string
  user_id:    string
  message:    string
  created_at: string
  users:      { full_name: string } | null
}

export interface FeedbackThread {
  id:         string
  title:      string
  status:     string
  created_at: string
  created_by: string
  users:      { full_name: string } | null
  task_feedback_messages: FeedbackMessage[]
}

interface Props {
  taskId:      string
  threads:     FeedbackThread[]
  canCreate:   boolean   // store_manager only
  canReply:    boolean   // admin + store_manager
  createFn:    (taskId: string, title: string, message: string) => Promise<{ success?: boolean; error?: string; threadId?: string } | undefined>
  replyFn:     (threadId: string, message: string) => Promise<{ success?: boolean; error?: string } | undefined>
  resolveFn:   (threadId: string) => Promise<{ success?: boolean; error?: string } | undefined>
}

function ThreadCard({ thread, canReply, replyFn, resolveFn }: {
  thread: FeedbackThread
  canReply: boolean
  replyFn: Props['replyFn']
  resolveFn: Props['resolveFn']
}) {
  const router = useRouter()
  const [expanded, setExpanded]     = useState(thread.status !== 'resolved')
  const [reply, setReply]           = useState('')
  const [showReply, setShowReply]   = useState(false)
  const [pending, startTransition]  = useTransition()

  function handleReply() {
    startTransition(async () => {
      const result = await replyFn(thread.id, reply)
      if (result?.error) { toast.error(result.error); return }
      toast.success('Đã gửi phản hồi')
      setReply('')
      setShowReply(false)
      router.refresh()
    })
  }

  function handleResolve() {
    startTransition(async () => {
      const result = await resolveFn(thread.id)
      if (result?.error) { toast.error(result.error); return }
      toast.success('Đã đóng thread')
      router.refresh()
    })
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Thread header */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="font-medium text-sm truncate">{thread.title}</span>
          <Badge className={STATUS_COLOR[thread.status] ?? 'bg-gray-100 text-gray-500'}>
            {STATUS_LABEL[thread.status] ?? thread.status}
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground shrink-0 ml-2">
          {thread.users?.full_name ?? '—'} · {formatDateTime(thread.created_at)}
        </span>
      </button>

      {expanded && (
        <div className="px-4 py-3 space-y-3">
          {/* Messages */}
          {thread.task_feedback_messages.map((msg) => (
            <div key={msg.id} className="flex gap-3">
              <div className="flex-1 rounded-md bg-muted/40 px-3 py-2 text-sm">
                <span className="font-medium text-foreground">{msg.users?.full_name ?? '—'}</span>
                <span className="text-muted-foreground text-xs ml-2">{formatDateTime(msg.created_at)}</span>
                <p className="mt-1 whitespace-pre-wrap">{msg.message}</p>
              </div>
            </div>
          ))}

          {/* Reply form */}
          {canReply && thread.status !== 'resolved' && (
            <div className="space-y-2">
              {!showReply ? (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowReply(true)}>
                    Trả lời
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={handleResolve}
                    className="text-muted-foreground"
                  >
                    <CheckCheck className="h-4 w-4 mr-1" />
                    Đóng thread
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Textarea
                    placeholder="Nhập phản hồi..."
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    rows={2}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={!reply.trim() || pending} onClick={handleReply}>
                      {pending ? 'Đang gửi...' : 'Gửi'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setShowReply(false); setReply('') }}>
                      Huỷ
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function FeedbackSection({ taskId, threads, canCreate, canReply, createFn, replyFn, resolveFn }: Props) {
  const router = useRouter()
  const [showForm, setShowForm]    = useState(false)
  const [title, setTitle]          = useState('')
  const [message, setMessage]      = useState('')
  const [pending, startTransition] = useTransition()

  function handleCreate() {
    startTransition(async () => {
      const result = await createFn(taskId, title, message)
      if (result?.error) { toast.error(result.error); return }
      toast.success('Đã tạo phản hồi')
      setTitle('')
      setMessage('')
      setShowForm(false)
      router.refresh()
    })
  }

  const openCount = threads.filter((t) => t.status !== 'resolved').length

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Trao đổi với Admin
            {openCount > 0 && (
              <Badge className="bg-amber-100 text-amber-700">{openCount} đang mở</Badge>
            )}
          </CardTitle>
          {canCreate && !showForm && (
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
              Tạo phản hồi
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Create form */}
        {showForm && (
          <div className="space-y-2 border rounded-lg p-3 bg-muted/20">
            <p className="text-xs font-medium text-muted-foreground">Tiêu đề phản hồi</p>
            <input
              type="text"
              className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              placeholder="Tiêu đề ngắn gọn..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Tiêu đề phản hồi"
              autoFocus
            />
            <p className="text-xs font-medium text-muted-foreground">Nội dung</p>
            <Textarea
              placeholder="Mô tả vấn đề hoặc câu hỏi cho admin..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              aria-label="Nội dung phản hồi"
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={!title.trim() || !message.trim() || pending} onClick={handleCreate}>
                {pending ? 'Đang tạo...' : 'Tạo'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setShowForm(false); setTitle(''); setMessage('') }}>
                Huỷ
              </Button>
            </div>
          </div>
        )}

        {/* Thread list */}
        {threads.length === 0 && !showForm && (
          <p className="text-sm text-muted-foreground text-center py-2">Chưa có phản hồi nào</p>
        )}
        {threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            canReply={canReply}
            replyFn={replyFn}
            resolveFn={resolveFn}
          />
        ))}
      </CardContent>
    </Card>
  )
}
