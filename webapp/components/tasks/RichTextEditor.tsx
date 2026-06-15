'use client'

import { useEffect, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle, FontSize } from '@tiptap/extension-text-style'
import { Bold, Underline as UnderlineIcon, Highlighter, AlignLeft, AlignCenter, AlignRight } from 'lucide-react'
import { cn } from '@/lib/utils'

// WYSIWYG editor for the task description ("như Outlook"): bold, font size,
// highlight, underline, alignment. Controlled — emits sanitized-on-save HTML.
// StarterKit v3 already ships Underline + Link; we add Highlight/TextAlign/
// TextStyle/FontSize. immediatelyRender:false avoids the Next SSR hydration
// mismatch.

const FONT_SIZES = [
  { label: 'Nhỏ', value: '13px' },
  { label: 'Vừa', value: '' },      // default (clears fontSize)
  { label: 'Lớn', value: '18px' },
  { label: 'Rất lớn', value: '24px' },
]

interface Props {
  value: string
  onChange: (html: string) => void
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Pasting from Excel / Microsoft 365 yields HTML <table> markup. StarterKit has
// no table extension, so Tiptap would drop or mangle it. Convert tables to plain
// paragraphs (cells joined, one row per line) BEFORE Tiptap parses — result is
// clean text matching the sanitize allowlist.
function transformPastedHTML(html: string): string {
  if (typeof window === 'undefined' || !/<table/i.test(html)) return html
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('table').forEach((table) => {
      const rows: string[] = []
      table.querySelectorAll('tr').forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent ?? '').trim())
        const line = cells.filter(Boolean).join('  ')
        if (line) rows.push(line)
      })
      const repl = doc.createElement('div')
      repl.innerHTML = rows.map((r) => `<p>${escapeHtml(r)}</p>`).join('')
      table.replaceWith(repl)
    })
    return doc.body.innerHTML
  } catch {
    return html
  }
}

export function RichTextEditor({ value, onChange }: Props) {
  // Local state for the font-size <select> — binding it to editor.getAttributes
  // made it snap back to "Vừa" on a collapsed cursor (getAttributes returns '').
  const [fontSize, setFontSize] = useState<string>('')

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Highlight,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      FontSize,
    ],
    content: value || '',
    editorProps: {
      transformPastedHTML,
      attributes: {
        class: cn(
          'min-h-[180px] max-h-[400px] overflow-y-auto px-3 py-2 text-sm focus:outline-none',
          '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
          '[&_mark]:bg-yellow-200 [&_mark]:rounded-sm [&_mark]:px-0.5',
          '[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold',
        ),
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    // Keep the size dropdown in sync with the caret/selection — but NEVER let a
    // collapsed caret (which reports fontSize '') clobber the size the user just
    // picked. Only adopt the editor's value when it actually reports a size, or
    // when a real (non-collapsed) range is selected. This was the snap-back bug.
    onSelectionUpdate: ({ editor }) => {
      const fs = editor.getAttributes('textStyle').fontSize ?? ''
      if (fs || !editor.state.selection.empty) setFontSize(fs)
    },
  })

  // External value changes (draft restore / edit load) → sync editor once.
  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value || '', { emitUpdate: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor])

  if (!editor) {
    return <div className="min-h-[180px] rounded-md border bg-background" />
  }

  const Btn = ({ active, onClick, title, children }: {
    active?: boolean; onClick: () => void; title: string; children: React.ReactNode
  }) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        'h-8 w-8 inline-flex items-center justify-center rounded transition-colors',
        active ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  )

  return (
    <div className="rounded-md border bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 flex-wrap border-b px-1.5 py-1">
        <Btn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="In đậm">
          <Bold className="h-4 w-4" />
        </Btn>
        <Btn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Gạch chân">
          <UnderlineIcon className="h-4 w-4" />
        </Btn>
        <Btn active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()} title="Highlight">
          <Highlighter className="h-4 w-4" />
        </Btn>

        <span className="mx-1 h-5 w-px bg-border" />

        <select
          value={fontSize}
          onChange={(e) => {
            const v = e.target.value
            setFontSize(v)
            // On a COLLAPSED caret, setFontSize only sets a "stored mark", which
            // the editor's refocus transaction then clears — so the size never
            // applied and the dropdown snapped back (the recurring bug). Select
            // the current block so the change is real and visible. A genuine
            // text range is used as-is.
            const chain = editor.chain().focus()
            if (editor.state.selection.empty) {
              const { $from } = editor.state.selection
              const from = $from.start()
              const to = $from.end()
              if (to > from) chain.setTextSelection({ from, to })
            }
            if (v) chain.setFontSize(v).run()
            else chain.unsetFontSize().run()
          }}
          title="Cỡ chữ"
          aria-label="Cỡ chữ"
          className="h-8 rounded border-0 bg-transparent px-1 text-xs text-muted-foreground hover:bg-muted focus:outline-none"
        >
          {FONT_SIZES.map((s) => (
            <option key={s.label} value={s.value}>{s.label}</option>
          ))}
        </select>

        <span className="mx-1 h-5 w-px bg-border" />

        <Btn active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} title="Căn trái">
          <AlignLeft className="h-4 w-4" />
        </Btn>
        <Btn active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} title="Căn giữa">
          <AlignCenter className="h-4 w-4" />
        </Btn>
        <Btn active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} title="Căn phải">
          <AlignRight className="h-4 w-4" />
        </Btn>
      </div>

      <EditorContent editor={editor} />
    </div>
  )
}
